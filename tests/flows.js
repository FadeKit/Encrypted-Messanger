'use strict';
/**
 * AE Secure — client ⇄ server flow suite.
 *
 * Boots a throwaway server and drives it with the real browser crypto module
 * (public/js/crypto.js executed in a VM), so every wrap, unwrap and signature is
 * byte-for-byte what the client performs. Covers the surfaces that plain API
 * tests cannot reach: masked operator channels opened from one-time codes, the
 * encrypted drive folder tree, airdrops, audience-key stories, session control,
 * the request queue and the operator console endpoints.
 *
 *   node tests/flows.js [--verbose]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-verify-'));

let pass = 0; const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; if (VERBOSE) console.log('  ✓', name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log('  ✗', name, detail); }
}

// ---------------------------------------------------------------- AE in a VM
const shim = {
  crypto: webcrypto, TextEncoder, TextDecoder, console, setTimeout, clearTimeout,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
};
shim.window = shim; shim.self = shim; shim.globalThis = shim;
vm.createContext(shim);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/crypto.js'), 'utf8'), shim, { filename: 'crypto.js' });
const AE = shim.AE;

// ---------------------------------------------------------------- http client
function makeClient(label) {
  const state = { token: null, label };
  async function request(method, url, body, raw = false) {
    const headers = {};
    if (state.token) headers['X-AE-Token'] = state.token;
    let payload = body;
    if (body !== undefined && !raw) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const response = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers, body: payload });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* raw */ }
    return { status: response.status, data, response };
  }
  return {
    state,
    get: (u) => request('GET', u),
    post: (u, b) => request('POST', u, b === undefined ? {} : b),
    patch: (u, b) => request('PATCH', u, b || {}),
    del: (u) => request('DELETE', u),
    putRaw: (u, bytes) => request('PUT', u, Buffer.from(bytes), true),
    bytes: async (u) => {
      const response = await fetch(`http://127.0.0.1:${PORT}${u}`, { headers: state.token ? { 'X-AE-Token': state.token } : {} });
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

async function register(client, username, password) {
  const salt = (await client.post('/api/auth/salt', { username })).data;
  const vault = await AE.createVault(password, username);
  const codes = [];
  for (let index = 0; index < 5; index++) {
    const code = AE.generateRecoveryCode();
    codes.push({
      code, index,
      proof: await AE.recoveryProof(code, salt.authSalt),
      wrapped: await AE.recoveryWrap(code, username, index, vault.vaultPlain),
      label: `Backup code ${index + 1}`,
    });
  }
  const response = await client.post('/api/auth/register', {
    username, displayName: username, authKey: vault.authKey, authSalt: vault.authSalt,
    vaultSalt: vault.vaultSalt, iterations: vault.iterations, vault: vault.sealed,
    identityPublic: vault.identityPublic, recoveryCodes: codes, proofSalt: AE.b64encode(AE.randomBytes(16)),
    termsAccepted: true, device: 'verify-script',
  });
  if (response.data?.token) client.state.token = response.data.token;
  return { response, vault };
}

async function uploadEncrypted(client, kind, bytes, wrapFileKey, ref = {}, meta = {}) {
  const blob = new Blob([bytes]);
  const fileKeyRaw = await AE.generateAesRaw();
  const keyWrap = wrapFileKey ? await wrapFileKey(fileKeyRaw) : null;
  const init = (await client.post('/api/files/init', { kind, size: blob.size, keyWrap, meta, ref })).data;
  const { fileId, chunks } = init;
  for (let index = 0; index < chunks; index++) {
    const start = index * AE.CHUNK_PLAINTEXT;
    const slice = new Uint8Array(bytes.slice(start, Math.min(bytes.length, start + AE.CHUNK_PLAINTEXT)));
    const sealed = await AE.encryptChunkKey(fileKeyRaw, slice, `ae-chunk:${fileId}:${index}`);
    await client.putRaw(`/api/files/${fileId}/chunk/${index}`, sealed);
  }
  await client.post(`/api/files/${fileId}/complete`, {});
  return { fileId, fileKeyRaw, chunks, size: bytes.length };
}

async function download(client, fileId, chunks, fileKeyRaw) {
  const parts = [];
  for (let index = 0; index < chunks; index++) {
    const sealed = await client.bytes(`/api/files/${fileId}/chunk/${index}`);
    parts.push(await AE.decryptChunkKey(fileKeyRaw, sealed, `ae-chunk:${fileId}:${index}`));
  }
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), AE_DATA_DIR: DATA_DIR, HOST: '0.0.0.0' }),
    stdio: 'ignore',
  });
  const stop = () => { try { server.kill('SIGKILL'); } catch { /* ignore */ } };
  process.on('exit', stop);

  const deadline = Date.now() + 15000;
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) break; } catch { /* retry */ }
    if (Date.now() > deadline) { console.log('server did not start'); stop(); process.exit(1); }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`\nAE Secure — client flow suite on port ${PORT}\n`);

  const owner = makeClient('owner');
  const member = makeClient('member');

  // ---------------------------------------------------------------- accounts
  const ownerReg = await register(owner, 'operator', 'correct-horse-battery-staple');
  check('owner registers', ownerReg.response.status === 200 && ownerReg.response.data.user.role === 'owner', JSON.stringify(ownerReg.response.data).slice(0, 160));
  const memberReg = await register(member, 'member-one', 'another-long-passphrase-here');
  check('member registers', memberReg.response.status === 200 && memberReg.response.data.user.role === 'member');
  const ownerId = ownerReg.response.data.user.id;
  const memberId = memberReg.response.data.user.id;

  // ------------------------------------------------------------- directory
  const memberDirectory = (await member.get('/api/directory')).data;
  check('directory hides operator accounts from members', memberDirectory.users.every((u) => u.id !== ownerId), JSON.stringify(memberDirectory.users.map((u) => u.username)));
  check('directory keeps the member visible', memberDirectory.users.some((u) => u.id === memberId));
  const ownerDirectory = (await owner.get('/api/directory')).data;
  check('operator sees every account in the directory', ownerDirectory.users.some((u) => u.id === memberId));

  // ------------------------------------------- masked operator channel (A)
  // member generates a code, operator redeems it (user-to-admin direction)
  const userCode = (await member.post('/api/dm-codes', {})).data;
  check('member can generate a one-time code', /^[A-Z0-9-]{10,}$/.test(userCode.code || ''), JSON.stringify(userCode));
  const redeemed = (await owner.post('/api/dm-codes/redeem', { code: userCode.code })).data;
  check('operator redeems the member code', !!redeemed.conversationId, JSON.stringify(redeemed).slice(0, 160));
  check('operator sees the member normally in that channel', redeemed.peer && redeemed.peer.id === memberId);
  const convId = redeemed.conversationId;
  const channelRaw = await AE.generateAesRaw();
  const channelKeyB64 = AE.b64encode(channelRaw);
  const wrapFor = async (privatePkcs8, peerPublic, context) => {
    const shared = await AE.deriveSharedKey(privatePkcs8, peerPublic, `conv:${context}`);
    return JSON.stringify({ by: null, pub: ownerReg.vault.identityPublic, w: await AE.wrapKey(shared, channelRaw) });
  };
  const ownerSelfWrap = JSON.stringify({
    by: ownerId, pub: ownerReg.vault.identityPublic,
    w: await AE.wrapKey(await AE.deriveSharedKey(ownerReg.vault.identityPrivate, ownerReg.vault.identityPublic, `conv:${convId}`), channelRaw),
  });
  const memberWrap = JSON.stringify({
    by: ownerId, pub: ownerReg.vault.identityPublic,
    w: await AE.wrapKey(await AE.deriveSharedKey(ownerReg.vault.identityPrivate, memberReg.vault.identityPublic, `conv:${convId}`), channelRaw),
  });
  const keysResponse = await owner.post(`/api/conversations/${convId}/keys`, { keyWraps: { [ownerId]: ownerSelfWrap, [memberId]: memberWrap } });
  check('operator seals the channel', keysResponse.status === 200, JSON.stringify(keysResponse.data).slice(0, 120));
  const memberConversations = (await member.get('/api/conversations')).data.conversations;
  const maskedChannel = memberConversations.find((c) => c.id === convId);
  check('member sees the channel', !!maskedChannel);
  check('operator identity is masked to the member', maskedChannel && maskedChannel.anon === true && maskedChannel.members.some((m) => m.masked && m.displayName === 'Server Administration'));
  const maskedWrap = maskedChannel && maskedChannel.keyWrap ? JSON.parse(maskedChannel.keyWrap) : null;
  check('wrap hides the operator account id', maskedWrap && maskedWrap.by === undefined, JSON.stringify(maskedWrap).slice(0, 120));
  check('wrap still carries the public key needed to open it', maskedWrap && !!maskedWrap.pub);
  let unwrapped = null;
  if (maskedWrap) {
    const shared = await AE.deriveSharedKey(memberReg.vault.identityPrivate, maskedWrap.pub, `conv:${convId}`);
    unwrapped = await AE.unwrapKey(shared, maskedWrap.w);
  }
  check('member rebuilds the same channel key', !!unwrapped && AE.b64encode(unwrapped) === channelKeyB64, `got ${unwrapped ? AE.b64encode(unwrapped).slice(0, 12) : 'null'}`);

  // message round trip in the masked channel
  const messageKey = await AE.importAes(unwrapped);
  const payload = await AE.encryptJson(messageKey, { text: 'Hello from the operator console.', attachments: [] });
  const sentMessage = await member.post(`/api/conversations/${convId}/messages`, { payload, attachments: [], replyTo: null });
  check('member can post into the sealed channel', sentMessage.status === 200, JSON.stringify(sentMessage.data).slice(0, 140));
  const ownerMessages = (await owner.get(`/api/conversations/${convId}/messages`)).data.messages;
  const firstMessage = ownerMessages.find((m) => m.authorId === memberId);
  const decrypted = firstMessage ? await AE.decryptJson(messageKey, firstMessage.payload) : null;
  check('operator decrypts the message with the same key', decrypted && decrypted.text === 'Hello from the operator console.', JSON.stringify(decrypted));

  // ------------------------------- masked operator channel (B): admin→user code
  const adminCode = (await owner.post('/api/dm-codes', { userId: memberId })).data;
  check('operator issues a targeted code', !!adminCode.code, JSON.stringify(adminCode).slice(0, 140));
  const memberRedeemed = (await member.post('/api/dm-codes/redeem', { code: adminCode.code })).data;
  check('member redeems the targeted code', !!memberRedeemed.conversationId);
  check('masked peer still exposes a public key for sealing', memberRedeemed.peer?.masked === true && !!memberRedeemed.peer?.identityPublic, JSON.stringify(memberRedeemed.peer));
  const convB = memberRedeemed.conversationId;
  const rawB = await AE.generateAesRaw();
  const memberSelfWrapB = JSON.stringify({
    by: memberId, pub: memberReg.vault.identityPublic,
    w: await AE.wrapKey(await AE.deriveSharedKey(memberReg.vault.identityPrivate, memberReg.vault.identityPublic, `conv:${convB}`), rawB),
  });
  const aliasWrapB = JSON.stringify({
    by: memberId, pub: memberReg.vault.identityPublic,
    w: await AE.wrapKey(await AE.deriveSharedKey(memberReg.vault.identityPrivate, memberRedeemed.peer.identityPublic, `conv:${convB}`), rawB),
  });
  const aliasResponse = await member.post(`/api/conversations/${convB}/keys`, { keyWraps: { [memberId]: memberSelfWrapB, administration: aliasWrapB } });
  check('member seals the channel through the "administration" alias', aliasResponse.status === 200, JSON.stringify(aliasResponse.data).slice(0, 140));
  const ownerConversations = (await owner.get('/api/conversations')).data.conversations;
  const channelB = ownerConversations.find((c) => c.id === convB);
  check('operator sees the channel opened by the code', !!channelB);
  check('operator received a wrap through the alias', !!channelB?.keyWrap);
  let rawBOwner = null;
  if (channelB?.keyWrap) {
    const parsed = JSON.parse(channelB.keyWrap);
    const senderPublic = parsed.pub || (channelB.members.find((m) => m.id === parsed.by) || {}).identityPublic;
    const shared = await AE.deriveSharedKey(ownerReg.vault.identityPrivate, senderPublic, `conv:${convB}`);
    rawBOwner = await AE.unwrapKey(shared, parsed.w);
  }
  check('operator rebuilds the member channel key', !!rawBOwner && AE.b64encode(rawBOwner) === AE.b64encode(rawB), `got ${rawBOwner ? AE.b64encode(rawBOwner).slice(0, 12) : 'null'}`);

  // ------------------------------------------------------------ drive folders
  const masterKeyRaw = AE.b64decode(memberReg.vault.vaultPlain.masterKey);
  const masterKey = await AE.importAes(masterKeyRaw);
  const folderName = await AE.encryptJson(masterKey, { name: 'Projects' });
  const created = await member.post('/api/drive/folders', { parentId: null, payload: folderName });
  check('drive folder created', created.status === 200 && !!created.data.folder?.id, JSON.stringify(created.data).slice(0, 140));
  const folderId = created.data.folder?.id;
  const list = (await member.get('/api/drive/folders')).data.folders || [];
  check('drive folder listed', list.some((f) => f.id === folderId));
  const renamed = await member.patch(`/api/drive/folders/${folderId}`, { payload: folderName });
  check('drive folder renamed', renamed.status === 200);
  const child = await member.post('/api/drive/folders', { parentId: folderId, payload: folderName });
  const removed = await member.del(`/api/drive/folders/${folderId}`);
  check('drive folder deleted and children moved to root', removed.status === 200 && removed.data.movedToRoot === true, JSON.stringify(removed.data));
  const afterDelete = (await member.get('/api/drive/folders')).data.folders || [];
  check('child folder survived its parent', afterDelete.some((f) => f.id === child.data.folder.id && f.parentId === null));

  // ------------------------------------------------------------------ drive file
  const driveBytes = new Uint8Array(700 * 1024);
  for (let i = 0; i < driveBytes.length; i++) driveBytes[i] = (i * 7) % 251;
  const uploadedDrive = await uploadEncrypted(member, 'drive', driveBytes, async (raw) => AE.wrapKey(masterKey, raw), { folderId: null }, { ct: 'meta', iv: 'iv' });
  check('multi-chunk drive upload completes', uploadedDrive.chunks === 2, `chunks=${uploadedDrive.chunks}`);
  const meta = (await member.get('/api/files?kind=drive')).data;
  const driveFile = (meta.files || []).find((f) => f.id === uploadedDrive.fileId);
  check('drive file appears in the encrypted listing', !!driveFile, JSON.stringify(meta).slice(0, 200));
  check('drive usage is reported against the quota', meta.storage && meta.storage.drive.used >= driveBytes.length, JSON.stringify(meta.storage));
  const fileKeyRaw = await AE.unwrapKey(masterKey, driveFile.keyWrap);
  const roundTrip = await download(member, uploadedDrive.fileId, driveFile.chunks, fileKeyRaw);
  check('drive file decrypts byte-for-byte', sameBytes(roundTrip, driveBytes));

  // ------------------------------------------------------------------- airdrop
  await member.patch('/api/settings', { settings: { airdrop: true } });
  await member.post('/api/presence', { mode: 'online', manual: true });
  const recipients = (await owner.get('/api/airdrop/recipients')).data;
  check('airdrop recipient list exposes the online member', (recipients.online || []).some((u) => u.id === memberId), JSON.stringify(recipients).slice(0, 200));
  check('airdrop recipient list flags operators separately', Array.isArray(recipients.admins) && typeof recipients.onAir === 'number');
  const dropRaw = await AE.generateAesRaw();
  const dropKey = await AE.importAes(dropRaw);
  const dropWraps = {};
  for (const card of [...recipients.online, ...recipients.admins]) {
    const shared = await AE.deriveSharedKey(ownerReg.vault.identityPrivate, card.identityPublic, `airdrop:${ownerId}`);
    dropWraps[card.id] = await AE.wrapKey(shared, dropRaw);
  }
  const dropPayload = await AE.encryptJson(dropKey, { text: 'instance-wide hello' });
  const drop = await owner.post('/api/airdrop', { kind: 'text', payload: dropPayload, keyWraps: dropWraps, size: 0 });
  check('airdrop delivered to the online member', drop.data.delivered >= 1, JSON.stringify(drop.data));
  const inbox = (await member.get('/api/airdrop')).data.airdrops || (await member.get('/api/airdrop')).data.items || [];
  const received = inbox.find((d) => d.senderId === ownerId || d.sender?.id === ownerId);
  check('member sees the drop', !!received, JSON.stringify(inbox).slice(0, 200));
  let dropText = null;
  if (received) {
    const wrap = (received.keyWraps || {})[memberId] || received.keyWrap;
    const shared = await AE.deriveSharedKey(memberReg.vault.identityPrivate, received.sender.identityPublic, `airdrop:${received.senderId || received.sender.id}`);
    const memberDropKey = await AE.unwrapKey(shared, wrap);
    dropText = await AE.decryptJson(await AE.importAes(memberDropKey), received.payload);
  }
  check('member decrypts the drop', dropText && dropText.text === 'instance-wide hello', JSON.stringify(dropText));
  const acked = await member.post(`/api/airdrop/${received.id}/ack`, {});
  check('drop can be acknowledged', acked.status === 200);

  // -------------------------------------------------------------------- stories
  const audienceSeed = AE.randomB64(32);
  await owner.patch('/api/public-profile', { enabled: true, alias: 'The Operator', bio: 'Hosting AE Secure.', images: [], audienceKey: audienceSeed });
  const audienceAes = await AE.audienceKey(audienceSeed, `public:${ownerId}`);
  const storyBytes = new Uint8Array(1024).fill(9);
  const storyUpload = await uploadEncrypted(owner, 'story', storyBytes, async (raw) => AE.wrapKey(audienceAes, raw), {}, { type: 'image/png' });
  const storyPayload = await AE.encryptJson(audienceAes, { text: 'first story', attachments: [{ fileId: storyUpload.fileId }] });
  const story = await owner.post('/api/stories', { kind: 'image', fileId: storyUpload.fileId, payload: storyPayload, caption: 'first story' });
  check('story publishes', story.status === 200, JSON.stringify(story.data).slice(0, 140));
  const profile = (await member.get(`/api/public/profile/${ownerId}`)).data.profile;
  check('member sees the public alias', profile && profile.publicAlias === 'The Operator', JSON.stringify(profile).slice(0, 200));
  const memberAudience = await AE.audienceKey(profile.audienceKey, `public:${ownerId}`);
  const probe = await AE.encryptJson(memberAudience, { probe: 'key-match' });
  const probeBack = await AE.decryptJson(audienceAes, probe);
  check('member derives the published audience key', probeBack && probeBack.probe === 'key-match');
  const strip = (await member.get('/api/stories')).data.stories || [];
  const feedStory = strip.find((s) => s.userId === ownerId || s.author?.id === ownerId || s.authorId === ownerId);
  check('story appears in the story strip for other members', !!feedStory, JSON.stringify(strip).slice(0, 200));
  const feedText = feedStory ? await AE.decryptJson(memberAudience, feedStory.payload) : null;
  check('member decrypts the story from the strip', feedText && feedText.text === 'first story', JSON.stringify(feedText));
  const seen = feedStory ? await member.post(`/api/stories/${feedStory.id}/seen`, {}) : { status: 0 };
  check('story view can be recorded', seen.status === 200);
  const reacted = feedStory ? await member.post(`/api/stories/${feedStory.id}/reactions`, { emoji: '🔥' }) : { status: 0 };
  check('story reactions work', reacted.status === 200, JSON.stringify(reacted.data).slice(0, 120));
  const hidden = await owner.patch('/api/public-profile', { enabled: false });
  check('turning the public profile off hides the audience key', hidden.status === 200);
  const hiddenProfile = (await member.get(`/api/public/profile/${ownerId}`)).data.profile;
  check('hidden profile publishes no audience key', !hiddenProfile || !hiddenProfile.audienceKey, JSON.stringify(hiddenProfile || null).slice(0, 140));
  const hiddenStrip = (await member.get('/api/stories')).data.stories || [];
  check('hidden profile stories leave the strip', !hiddenStrip.some((s) => (s.userId || s.authorId) === ownerId), JSON.stringify(hiddenStrip).slice(0, 160));
  await owner.patch('/api/public-profile', { enabled: true, alias: 'The Operator', audienceKey: audienceSeed });

  // ------------------------------------------------------------------ sessions
  const secondLogin = await (async () => {
    const client = makeClient('member-second');
    const salt = (await client.post('/api/auth/salt', { username: 'member-one' })).data;
    const authKey = await AE.pbkdf2('ae-auth|member-one|another-long-passphrase-here', salt.authSalt, 210000);
    const response = await client.post('/api/auth/login', { username: 'member-one', authKey: AE.b64encode(authKey), device: 'tablet' });
    client.state.token = response.data.token;
    return { client, response };
  })();
  check('second sign-in succeeds', secondLogin.response.status === 200, JSON.stringify(secondLogin.response.data).slice(0, 140));
  const sessions = (await member.get('/api/sessions')).data.sessions;
  check('both sessions are listed', sessions.length >= 2, `count=${sessions.length}`);
  const other = sessions.find((s) => !s.current);
  const revoke = await member.post('/api/sessions/revoke', { id: other.id });
  check('session revoked by id', revoke.status === 200, JSON.stringify(revoke.data));
  const afterRevoke = (await member.get('/api/sessions')).data.sessions;
  check('revoked session is gone', !afterRevoke.some((s) => s.id === other.id));
  const deadSession = await secondLogin.client.get('/api/auth/me');
  check('revoked session can no longer call the API', deadSession.status === 401 || deadSession.status === 403, `status=${deadSession.status}`);

  // ------------------------------------------------------------------ requests
  const request = await member.post('/api/requests', { kind: 'drive', requestedBytes: 5 * 1024 * 1024 * 1024, requestedLabel: '5 GB', message: 'Need room for photos.' });
  check('member files a storage request', request.status === 200 && !!request.data.request?.id, JSON.stringify(request.data).slice(0, 160));
  const requestId = request.data.request.id;
  const adminRequests = (await owner.get('/api/admin/requests')).data.requests || [];
  check('operator queue shows the request', adminRequests.some((r) => r.id === requestId));
  const decision = await owner.post(`/api/admin/requests/${requestId}/decision`, { decision: 'approve', bytes: 5 * 1024 * 1024 * 1024, note: 'Approved for photos.' });
  check('operator approves with a value', decision.status === 200, JSON.stringify(decision.data).slice(0, 160));
  const me = (await member.get('/api/auth/me')).data.user;
  check('member limit updated to the approved value', me.limits.driveQuotaBytes === 5 * 1024 * 1024 * 1024, JSON.stringify(me.limits));
  const deniedRequest = await member.post('/api/requests', { kind: 'dm', requestedBytes: 50 * 1024 * 1024, requestedLabel: '50 MB', message: 'Please.' });
  const deniedId = deniedRequest.data.request.id;
  const denied = await owner.post(`/api/admin/requests/${deniedId}/decision`, { decision: 'deny', note: 'Keep it tight.' });
  check('operator can deny a request', denied.status === 200, JSON.stringify(denied.data).slice(0, 140));
  const meAfterDenial = (await member.get('/api/auth/me')).data.user;
  check('a denial leaves limits untouched', meAfterDenial.limits.dmUploadBytes === 15 * 1024 * 1024, JSON.stringify(meAfterDenial.limits));
  const purple = await member.post('/api/requests', { kind: 'purple', requestedLabel: 'purple status', message: 'Looks nice.' });
  await owner.post(`/api/admin/requests/${purple.data.request.id}/decision`, { decision: 'approve', note: 'Granted.' });
  const purpleMe = (await member.get('/api/auth/me')).data.user;
  check('purple status granted through the queue', purpleMe.purpleAllowed === true);

  // ------------------------------------------------------------- admin console
  const overview = (await owner.get('/api/admin/overview')).data;
  check('admin overview reports stats', !!(overview.stats || overview.counts), JSON.stringify(overview).slice(0, 160));
  const users = (await owner.get('/api/admin/users')).data.users || [];
  check('admin user list includes both accounts', users.length >= 2 && users.some((u) => u.id === memberId));
  check('admin user list carries avatars and limits', users.every((u) => 'avatarId' in u && 'limits' in u));
  const userPanel = (await owner.get(`/api/admin/users/${memberId}`)).data;
  check('admin user panel returns detail', !!(userPanel.user || userPanel.member), JSON.stringify(userPanel).slice(0, 160));
  const neural = (await owner.get('/api/admin/neural?window=60')).data;
  check('neural graph returns nodes and edges', Array.isArray(neural.nodes) && Array.isArray(neural.edges), JSON.stringify(neural).slice(0, 160));
  const convNode = (neural.nodes || []).find((n) => n.type === 'dm' || n.type === 'group');
  if (convNode) {
    const nodeType = convNode.type === 'dm' || convNode.type === 'group' ? 'conversation' : 'forum';
    const node = await owner.get(`/api/admin/neural/node/${nodeType}/${String(convNode.id).replace(/^(conv|forum):/, '')}`);
    check('neural node inspection works', node.status === 200, JSON.stringify(node.data).slice(0, 140));
  } else check('neural node inspection works', false, 'no conversation node');
  const adminFiles = (await owner.get('/api/admin/files')).data.files || [];
  check('admin sees every uploaded blob', adminFiles.length >= 2 && adminFiles.some((f) => f.kind === 'drive') && adminFiles.some((f) => f.kind === 'story'), `count=${adminFiles.length} kinds=${adminFiles.map((f) => f.kind).join(',')}`);
  const storySurface = adminFiles.filter((f) => f.kind === 'story');
  check('story storage tracked separately', storySurface.length >= 1);
  const adminStories = (await owner.get('/api/admin/stories')).data;
  check('admin story storage view returns data', !!adminStories);
  const karma = await owner.get('/api/admin/karma');
  check('admin karma view is available', karma.status === 200, JSON.stringify(karma.data).slice(0, 120));
  const audit = (await owner.get('/api/admin/audit')).data.audit || [];
  check('audit log records actions', audit.length > 3, `entries=${audit.length}`);
  const globalState = (await owner.get('/api/admin/overview')).data.global;
  check('global state is readable through the overview', !!globalState, JSON.stringify(globalState).slice(0, 140));
  const patchedGlobal = await owner.post('/api/admin/global', { notice: 'Be excellent.' });
  check('global notice is writable', patchedGlobal.status === 200, JSON.stringify(patchedGlobal.data).slice(0, 120));
  const memberAdminAttempt = await member.get('/api/admin/overview');
  check('members are refused the admin surface', memberAdminAttempt.status === 403 || memberAdminAttempt.status === 401);
  const verified = await owner.patch(`/api/admin/users/${memberId}`, { verified: true });
  check('operator can verify an account', verified.status === 200, JSON.stringify(verified.data).slice(0, 140));
  const memberMe = (await member.get('/api/auth/me')).data.user;
  check('verification applies to the member', memberMe.verified === true);

  // ------------------------------------------------------------- clicker/health
  const clickA = (await member.post('/api/click', {})).data;
  const clickB = (await member.post('/api/click', {})).data;
  check('click counter increments server-wide', clickB.total === clickA.total + 1, `${clickA.total} → ${clickB.total}`);
  check('click counter reports weekly totals and my contribution', typeof clickB.week === 'number' && clickB.mine >= 2, JSON.stringify(clickB));
  const health = (await member.get('/api/health')).data;
  check('health endpoint answers', health.ok === true && health.name === 'AE Secure');

  stop();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(' -', f); process.exit(1); }
  process.exit(0);
})().catch((error) => {
  console.log('harness error:', error);
  process.exit(1);
});

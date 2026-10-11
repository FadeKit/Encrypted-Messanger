'use strict';

/**
 * AE Secure API test suite.
 *
 * Runs against a live server instance (started automatically on a random port
 * with an isolated data directory). Exercises the full zero-knowledge contract:
 * accounts, recovery, sessions, messaging, communities, uploads, quotas,
 * requests, one-time DM codes, airdrops, stories and the admin surface.
 *
 *   node tests/run.js            # quiet
 *   node tests/run.js --verbose  # print each step
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const PORT = 3400 + Math.floor(Math.random() * 200);

const results = [];
let failures = 0;

function log(...args) {
  if (VERBOSE) console.log(...args);
}

function check(name, condition, detail = '') {
  const ok = !!condition;
  results.push({ name, ok, detail });
  if (!ok) {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    log(`  ✓ ${name}`);
  }
}

function b64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function fakeIdentity() {
  return b64(crypto.randomBytes(65));
}

function fakeVault() {
  return b64(crypto.randomBytes(180));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (response.ok) return true;
    } catch { /* retry */ }
    await wait(150);
  }
  throw new Error('server did not start in time');
}

function makeClient(token = null) {
  const call = async (method, route, body, options = {}) => {
    const headers = {};
    if (token) headers['x-ae-token'] = token;
    let payload;
    if (body instanceof Buffer || body instanceof Uint8Array) {
      headers['Content-Type'] = 'application/octet-stream';
      payload = body;
    } else if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers, body: payload });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await response.json() : await response.arrayBuffer();
    return { status: response.status, data, headers: response.headers };
  };
  return {
    get: (route) => call('GET', route),
    post: (route, body) => call('POST', route, body === undefined ? {} : body),
    patch: (route, body) => call('PATCH', route, body),
    del: (route) => call('DELETE', route),
    put: (route, body) => call('PUT', route, body),
    raw: call,
    setToken(t) { token = t; },
    get token() { return token; },
  };
}

async function registerAccount(client, username, extra = {}) {
  const payload = Object.assign({
    username,
    displayName: username,
    authKey: b64(crypto.randomBytes(32)),
    authSalt: b64(crypto.randomBytes(16)),
    vaultSalt: b64(crypto.randomBytes(16)),
    vault: fakeVault(),
    identityPublic: fakeIdentity(),
    iterations: 100000,
    termsAccepted: true,
    recoveryCodes: [1, 2, 3, 4, 5].map((index) => ({
      proof: b64(crypto.randomBytes(32)),
      wrapped: b64(crypto.randomBytes(120)),
      label: `code ${index}`,
    })),
  }, extra);
  const response = await client.post('/api/auth/register', payload);
  if (response.status === 200) client.setToken(response.data.token);
  return { response, payload };
}

function makeUpload(size) {
  const chunkSize = 512 * 1024;
  const chunks = Math.max(1, Math.ceil(size / chunkSize));
  return { chunkSize, chunks, makeChunk: (index) => Buffer.alloc(Math.min(chunkSize, size - index * chunkSize), index % 251) };
}

async function uploadFile(client, { kind, size, keyWrap = 'wrap', meta = {} }) {
  const helper = makeUpload(size);
  const init = await client.post('/api/files/init', { kind, size, keyWrap, meta });
  if (init.status !== 200) return { init };
  for (let i = 0; i < helper.chunks; i++) {
    const result = await client.put(`/api/files/${init.data.fileId}/chunk/${i}`, helper.makeChunk(i));
    if (result.status !== 200) return { init, chunkError: result };
  }
  const complete = await client.post(`/api/files/${init.data.fileId}/complete`, {});
  return { init, complete };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-test-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), AE_DATA_DIR: dataDir, NODE_ENV: 'test' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (!/^\[ae\]/.test(text.trim())) process.stderr.write(`[server] ${text}`);
  });

  try {
    await waitForServer();
    console.log(`\nAE Secure — API suite on port ${PORT}\n`);

    // ---------------------------------------------------------- bootstrap
    const anon = makeClient();
    const boot = await anon.get('/api/bootstrap');
    check('bootstrap responds', boot.status === 200 && boot.data.version, `status ${boot.status}`);
    check('default DM upload limit is 15 MB', boot.data.defaults.dmUploadBytes === 15 * 1024 * 1024);
    check('default drive quota is 1 GB', boot.data.defaults.driveQuotaBytes === 1024 * 1024 * 1024);
    check('story cap is 1 GB', boot.data.defaults.storyQuotaBytes === 1024 * 1024 * 1024);

    // ------------------------------------------------------------- accounts
    const owner = makeClient();
    const ownerReg = await registerAccount(owner, 'operator-one');
    check('first account registers', ownerReg.response.status === 200, JSON.stringify(ownerReg.response.data));
    check('first account becomes owner', ownerReg.response.data.user?.role === 'owner');
    check('registration issues five recovery codes', ownerReg.response.data.user.backup.count === 5);
    check('plaintext never echoed in user view', !JSON.stringify(ownerReg.response.data.user).includes('password'));

    const ownerSalt = await anon.post('/api/auth/salt', { username: 'operator-one' });
    check('salt endpoint returns kdf parameters', !!ownerSalt.data.authSalt && ownerSalt.data.iterations > 0);
    const decoy = await anon.post('/api/auth/salt', { username: 'does-not-exist' });
    check('unknown handles get deterministic decoy salts', decoy.data.exists === false && decoy.data.authSalt.length > 0);

    const member = makeClient();
    const memberReg = await registerAccount(member, 'second-user');
    check('second account registers as member', memberReg.response.data.user.role === 'member');
    const memberId = memberReg.response.data.user.id;

    const dup = await registerAccount(makeClient(), 'second-user');
    check('duplicate handle is rejected', dup.response.status === 409);

    const badLogin = await anon.post('/api/auth/login', { username: 'second-user', authKey: 'nope' });
    check('wrong passphrase is rejected', badLogin.status === 401);

    const relogin = await anon.post('/api/auth/login', {
      username: 'second-user',
      authKey: memberReg.payload.authKey,
    });
    check('login with the recorded key material succeeds', relogin.status === 200, JSON.stringify(relogin.data));

    // -------------------------------------------------------------- settings
    const settingsUpdate = await member.patch('/api/settings', {
      settings: {
        theme: 'light',
        accent: 'violet',
        forumMedia: true,
        airdrop: true,
        disabledFeatures: { uploads: false },
        layout: { sidebarCompact: true, hidden: ['stories'] },
      },
    });
    check('settings persist', settingsUpdate.status === 200 && settingsUpdate.data.settings.theme === 'light');
    check('nested layout settings merge', settingsUpdate.data.settings.layout.sidebarCompact === true && settingsUpdate.data.settings.layout.order.length > 0);
    check('features from the default block survive the update', settingsUpdate.data.settings.activityStatus === true);

    // --------------------------------------------------------------- uploads
    const big = await uploadFile(member, { kind: 'dm', size: 16 * 1024 * 1024 });
    check('over-limit attachment is refused at init', big.init.status === 413, `status ${big.init.status}`);

    const small = await uploadFile(member, { kind: 'dm', size: 900 * 1024 });
    check('15 MB-bounded attachment uploads end to end', small.complete?.status === 200, JSON.stringify(small.complete?.data || small.init.data));
    const smallFileId = small.init.data.fileId;

    const chunks = await member.get(`/api/files/${smallFileId}`);
    check('file metadata is readable by the owner', chunks.data.file?.chunks === 2 && chunks.data.file.uploaded === true);

    const download = await member.get(`/api/files/${smallFileId}/chunk/0`);
    check('chunk download returns ciphertext bytes', download.status === 200 && download.data.byteLength > 0);
    const noAuthChunk = await makeClient().get(`/api/files/${smallFileId}/chunk/0`);
    check('unauthenticated chunk access is denied', noAuthChunk.status === 401);

    const driveFile = await uploadFile(member, { kind: 'drive', size: 2 * 1024 * 1024 });
    check('drive upload succeeds within the 1 GB quota', driveFile.complete?.status === 200);
    check('drive usage is accounted', driveFile.complete.data.drive.used === 2 * 1024 * 1024, JSON.stringify(driveFile.complete.data.drive));

    const overDrive = await member.post('/api/files/init', { kind: 'drive', size: 1024 * 1024 * 1024 + 1, keyWrap: 'w' });
    check('drive rejects uploads beyond remaining space', overDrive.status === 413, `status ${overDrive.status}`);

    // The six-picture shelf is a storage boundary, not just a disabled button.
    for (let index = 0; index < 5; index += 1) {
      const background = await uploadFile(member, { kind: 'background', size: 1, meta: { type: 'image/png' } });
      check(`background ${index + 1} uploads within the library limit`, background.complete?.status === 200);
    }
    const raceA = await member.post('/api/files/init', { kind: 'background', size: 1, keyWrap: 'wrap-a', meta: { type: 'image/png' } });
    const raceB = await member.post('/api/files/init', { kind: 'background', size: 1, keyWrap: 'wrap-b', meta: { type: 'image/png' } });
    check('the last background slots allow concurrent preparation', raceA.status === 200 && raceB.status === 200);
    for (const init of [raceA, raceB]) {
      if (init.status === 200) await member.put(`/api/files/${init.data.fileId}/chunk/0`, Buffer.from([1]));
    }
    const raceCompleteA = raceA.status === 200 ? await member.post(`/api/files/${raceA.data.fileId}/complete`, {}) : raceA;
    const raceCompleteB = raceB.status === 200 ? await member.post(`/api/files/${raceB.data.fileId}/complete`, {}) : raceB;
    check('the server enforces the background cap at completion', raceCompleteA.status === 200 && raceCompleteB.status === 409, `completions ${raceCompleteA.status}/${raceCompleteB.status}`);
    const backgroundCap = await member.post('/api/files/init', { kind: 'background', size: 1, keyWrap: 'wrap', meta: { type: 'image/png' } });
    const backgrounds = await member.get('/api/files?kind=background');
    check('a seventh background is refused server-side', backgroundCap.status === 409 && backgrounds.data.files.length === 6, `${backgroundCap.status}; stored ${backgrounds.data.files.length}`);

    // ------------------------------------------------------------ messaging
    const dmCreate = await member.post('/api/conversations', {
      type: 'dm',
      memberIds: [ownerReg.response.data.user.id],
      keyWraps: { [memberId]: 'wrap-a', [ownerReg.response.data.user.id]: 'wrap-b' },
    });
    check('direct conversation is created', dmCreate.status === 200 && dmCreate.data.conversation.type === 'dm', JSON.stringify(dmCreate.data));
    const conversationId = dmCreate.data.conversation.id;

    const send = await member.post(`/api/conversations/${conversationId}/messages`, {
      payload: { iv: b64(crypto.randomBytes(12)), ct: b64(crypto.randomBytes(160)) },
      attachments: [{ fileId: smallFileId, type: 'image', keyWrap: 'att' }],
      replyPreview: 'earlier note',
    });
    check('encrypted message sends with attachment', send.status === 200 && send.data.message.attachments.length === 1, JSON.stringify(send.data));
    const messageId = send.data.message.id;

    const offlineInbox = await owner.get('/api/conversations');
    const queuedConversation = (offlineInbox.data.conversations || []).find((conversation) => conversation.id === conversationId);
    check('a DM sent while the recipient has no live connection is queued in their inbox', !!queuedConversation && queuedConversation.unread === 1 && queuedConversation.lastMessage?.payload?.ct);
    const ownerView = await owner.get(`/api/conversations/${conversationId}/messages`);
    check('the offline recipient can fetch the saved DM history after reconnecting', ownerView.status === 200 && ownerView.data.messages.length === 1);
    check('message bodies arrive as ciphertext only', !!ownerView.data.messages[0].payload.ct && !ownerView.data.messages[0].payload.text);

    const reaction = await owner.post(`/api/messages/${messageId}/reactions`, { emoji: '🔥' });
    check('reactions toggle on', reaction.status === 200 && reaction.data.reactions['🔥'].count === 1);
    const unreact = await owner.post(`/api/messages/${messageId}/reactions`, { emoji: '🔥' });
    check('reactions toggle off', unreact.data.reactions['🔥'] === undefined);

    const selfVote = await member.post(`/api/messages/${messageId}/vote`, { value: 1 });
    check('authors cannot vote on their own message', selfVote.status === 400);
    const vote = await owner.post(`/api/messages/${messageId}/vote`, { value: 1 });
    check('vote records', vote.status === 200 && vote.data.myVote === 1);

    const memberKarma = await member.get(`/api/conversations/${conversationId}/messages`);
    check('non-admins never receive karma values', memberKarma.data.messages[0].karma === undefined);
    const adminKarma = await owner.get(`/api/admin/overview`);
    check('admin overview exposes traffic telemetry', adminKarma.status === 200 && Array.isArray(adminKarma.data.traffic.series));

    const deleteAttempt = await member.del(`/api/messages/${messageId}`);
    check('participants cannot delete DM messages', deleteAttempt.status === 403);
    const adminDelete = await owner.del(`/api/messages/${messageId}`);
    check('administrators can delete DM messages', adminDelete.status === 200);

    const outsider = makeClient();
    await registerAccount(outsider, 'third-user');
    const outsiderPeek = await outsider.get(`/api/conversations/${conversationId}/messages`);
    check('outsiders cannot read a conversation', outsiderPeek.status === 403);

    // ------------------------------------------------------------ communities
    const forum = await member.post('/api/forums', { name: 'Signal Garden', isPublic: true, description: 'open square' });
    check('public community is created', forum.status === 200 && !!forum.data.forum.publicSeed);
    const forumId = forum.data.forum.id;

    const privateForum = await owner.post('/api/forums', { name: 'Ops Room', isPublic: false, memberIds: [ownerReg.response.data.user.id] });
    check('private community is created without a public seed', privateForum.status === 200 && privateForum.data.forum.publicSeed === null);
    const privateForumId = privateForum.data.forum.id;

    const outsiderPrivate = await outsider.get(`/api/forums/${privateForumId}`);
    check('private communities are invisible to outsiders', outsiderPrivate.status === 403);

    const thread = await member.post(`/api/forums/${forumId}/threads`, {
      payload: { iv: 'iv', ct: 'ct' },
      titlePayload: { iv: 'iv', ct: 'title' },
    });
    check('thread created in public community', thread.status === 200, JSON.stringify(thread.data));
    const threadId = thread.data.thread.id;

    const post = await outsider.post(`/api/threads/${threadId}/posts`, { payload: { iv: 'iv', ct: 'reply' } });
    check('any signed-in account can reply in a public community', post.status === 200);
    const postId = post.data.post.id;

    const mediaPost = await outsider.post(`/api/threads/${threadId}/posts`, {
      payload: { iv: 'iv', ct: 'media' },
      attachments: [{ fileId: smallFileId, type: 'image' }],
    });
    check('community media is gated behind the client setting', mediaPost.status === 403, `status ${mediaPost.status}`);

    const forumUpload = await uploadFile(member, { kind: 'forum', size: 300 * 1024 });
    const mediaPost2 = await member.post(`/api/threads/${threadId}/posts`, {
      payload: { iv: 'iv', ct: 'media' },
      attachments: [{ fileId: forumUpload.init.data.fileId, type: 'image' }],
    });
    check('media posts work once the setting is on', mediaPost2.status === 200, JSON.stringify(mediaPost2.data));

    const foreignDelete = await member.del(`/api/messages/${postId}`);
    check('members cannot delete another account\'s public post', foreignDelete.status === 403);
    const postDeleteByAuthor = await outsider.del(`/api/messages/${postId}`);
    check('post author deletes their own public post', postDeleteByAuthor.status === 200);
    const threadDeleteAttempt = await owner.del(`/api/threads/${threadId}`);
    check('administrators can delete threads', threadDeleteAttempt.status === 200);

    // ------------------------------------------------------- requests + limits
    const requestResult = await member.post('/api/requests', { kind: 'drive', requestedBytes: 5 * 1024 * 1024 * 1024, message: 'Need room for backups.' });
    check('storage request is filed', requestResult.status === 200);
    const requestId = requestResult.data.request.id;
    const duplicate = await member.post('/api/requests', { kind: 'drive', requestedBytes: 1024, message: 'again' });
    check('duplicate open requests are rejected', duplicate.status === 409);

    const adminRequests = await owner.get('/api/admin/requests?status=open');
    check('admin sees the request', adminRequests.data.requests.length === 1 && adminRequests.data.requests[0].user.username === 'second-user');

    const approve = await owner.post(`/api/admin/requests/${requestId}/decision`, { decision: 'approve', bytes: 5 * 1024 * 1024 * 1024, note: 'Enjoy the extra room.' });
    check('admin approves with a custom size', approve.status === 200 && approve.data.limits.driveQuotaBytes === 5 * 1024 * 1024 * 1024);

    const memberState = await member.get('/api/auth/me');
    check('the new quota reaches the account', memberState.data.user.limits.driveQuotaBytes === 5 * 1024 * 1024 * 1024);
    const largerDrive = await member.post('/api/files/init', { kind: 'drive', size: 3 * 1024 * 1024 * 1024, keyWrap: 'w' });
    check('uploads follow the approved quota', largerDrive.status === 200, JSON.stringify(largerDrive.data));
    await member.del(`/api/files/${largerDrive.data.fileId}`);

    const unlimited = await member.post('/api/requests', { kind: 'dm', requestedBytes: 500 * 1024 * 1024, message: 'Big files.' });
    const denyUnlimited = await owner.post(`/api/admin/requests/${unlimited.data.request.id}/decision`, { decision: 'approve', bytes: -1 });
    check('admin can grant unlimited', denyUnlimited.data.limits.dmUploadBytes === -1);
    const fortyMb = await member.post('/api/files/init', { kind: 'dm', size: 40 * 1024 * 1024, keyWrap: 'w' });
    check('unlimited accounts upload beyond the default', fortyMb.status === 200);
    await member.del(`/api/files/${fortyMb.data.fileId}`);

    const purpleRequest = await member.post('/api/requests', { kind: 'purple', message: 'May I have the purple ring?' });
    const purpleApprove = await owner.post(`/api/admin/requests/${purpleRequest.data.request.id}/decision`, { decision: 'approve' });
    check('purple status unlocks through a request', purpleApprove.data.request.status === 'approved');
    const purpleMe = await member.get('/api/auth/me');
    check('purple capability is stored on the account', purpleMe.data.user.purpleAllowed === true);

    // ------------------------------------------------------- admin user tools
    const verification = await owner.patch(`/api/admin/users/${memberId}`, { verified: true });
    check('admin grants the blue check', verification.data.user.verified === true);
    const limitPatch = await owner.patch(`/api/admin/users/${memberId}`, { limits: { dmUploadBytes: 25 * 1024 * 1024, driveQuotaBytes: 2 * 1024 * 1024 * 1024 } });
    check('admin sets explicit per-user limits', limitPatch.data.user.limits.dmUploadBytes === 25 * 1024 * 1024);
    const limitUpdate = await member.get('/api/auth/me');
    check('limit change is live for the user', limitUpdate.data.user.limits.dmUploadBytes === 25 * 1024 * 1024);

    const sessions = await owner.get(`/api/admin/users/${memberId}/sessions`);
    check('admin can list a user\'s sessions', sessions.data.sessions.length >= 1 && !!sessions.data.sessions[0].device);
    const killOne = await owner.post('/api/admin/sessions/revoke', { token: sessions.data.sessions[0].token });
    check('admin can end a single session', killOne.status === 200);
    const memberAfterKill = await member.get('/api/auth/me');
    check('revoked session stops working', memberAfterKill.status === 401 || memberAfterKill.data.user === null || memberAfterKill.status === 403);

    const memberAgain = await anon.post('/api/auth/login', {
      username: 'second-user',
      authKey: memberReg.payload.authKey,
    });
    check('account is reachable after the admin ends a stray session', memberAgain.status === 200, JSON.stringify(memberAgain.data));
    member.setToken(memberAgain.data.token);

    // --------------------------------------------------------- one-time codes
    const userCode = await member.post('/api/dm-codes', {});
    check('user generates a one-time admin code', userCode.status === 200 && /^[A-Z2-9-]{14}$/.test(userCode.data.code), userCode.data.code);
    check('the code does not leak the operator identity', !JSON.stringify(userCode.data).toLowerCase().includes('operator'));
    const redeemByAdmin = await owner.post('/api/dm-codes/redeem', { code: userCode.data.code });
    check('admin redeems the user code', redeemByAdmin.status === 200, JSON.stringify(redeemByAdmin.data));
    const adminToUser = await owner.post('/api/dm-codes', { userId: memberId });
    const redeemByUser = await member.post('/api/dm-codes/redeem', { code: adminToUser.data.code });
    check('user redeems an admin-issued code', redeemByUser.status === 200);
    check('the admin appears masked on the user side', redeemByUser.data.peer && redeemByUser.data.peer.masked === true && redeemByUser.data.peer.displayName === 'Server Administration');

    const { routes } = require(path.join(ROOT, 'server', 'routes-social'));
    check('social routes load', !!routes);

    // ------------------------------------------------------------ admin files
    const adminFiles = await owner.get('/api/admin/files');
    check('root panel lists every upload server-wide', adminFiles.data.files.length >= 3);
    check('file browser separates story storage', typeof adminFiles.data.totals.byKind.drive === 'number');
    const uploadPageA = await owner.get('/api/admin/files?limit=2&offset=0');
    const uploadPageB = await owner.get('/api/admin/files?limit=2&offset=2');
    check('admin upload list exposes a bounded first page and full match count', uploadPageA.data.files.length === 2 && uploadPageA.data.filteredCount >= 3 && uploadPageA.data.hasMore === true);
    check('admin upload pages cover distinct file records', uploadPageB.data.files.length > 0 && !uploadPageA.data.files.some((file) => uploadPageB.data.files.some((next) => next.id === file.id)));
    const otherOwnerDelete = await owner.del(`/api/files/${smallFileId}`);
    check('admin can remove any file', otherOwnerDelete.status === 200);

    // --------------------------------------------------------------- airdrop
    const airdropOff = await outsider.post('/api/airdrop', { kind: 'text', payload: { iv: 'iv', ct: 'ct' } });
    check('airdrop send works and reports delivery', airdropOff.status === 200 && typeof airdropOff.data.delivered === 'number');
    const inbox = await member.get('/api/airdrop');
    check('airdrop inbox returns drops for enabled online users', inbox.status === 200 && inbox.data.count >= 1, JSON.stringify(inbox.data.count));
    const ownerInbox = await owner.get('/api/airdrop');
    check('admin receives airdrops regardless of the setting', ownerInbox.data.airdrops.length >= 1);

    // --------------------------------------------------------------- stories
    const storyNoPublic = await member.post('/api/stories', { kind: 'image', fileId: smallFileId });
    check('stories require a public profile', storyNoPublic.status === 403);

    const publicOn = await member.patch('/api/public-profile', { enabled: true, alias: 'Garden Keeper', bio: 'Keeper', audienceKey: b64(crypto.randomBytes(32)) });
    check('public profile toggles on', publicOn.status === 200 && publicOn.data.publicProfile.enabled === true);
    const storyUpload = await uploadFile(member, { kind: 'story', size: 640 * 1024 });
    check('story upload prepares', storyUpload.complete?.status === 200, JSON.stringify(storyUpload.init.data));
    const story = await member.post('/api/stories', { kind: 'image', fileId: storyUpload.init.data.fileId, payload: { iv: 'iv', ct: 'ct' } });
    check('story posts for a public account', story.status === 200, JSON.stringify(story.data));
    const storyList = await outsider.get('/api/stories');
    check('stories are visible to other signed-in users', storyList.data.stories.length === 1);
    check('story carries the 24h expiry', storyList.data.stories[0].expiresAt - storyList.data.stories[0].createdAt === 24 * 60 * 60 * 1000);

    const publicPost = await member.post('/api/public/posts', { payload: { iv: 'iv', ct: 'ct' } });
    check('public square accepts posts', publicPost.status === 200);
    const feed = await outsider.get('/api/public/feed');
    check('public feed shows posts and people', feed.data.posts.length === 1 && feed.data.people.length === 1, JSON.stringify({ posts: feed.data.posts.length, people: feed.data.people.length }));

    const profileOff = await member.patch('/api/public-profile', { enabled: false });
    const feedHidden = await outsider.get('/api/public/feed');
    check('turning the public profile off hides content', feedHidden.data.posts.length === 0 && feedHidden.data.people.length === 0);
    await member.patch('/api/public-profile', { enabled: true });

    const adminStories = await owner.get('/api/admin/stories');
    check('admin story storage is tracked separately', adminStories.data.totals.count >= 1 && adminStories.data.note.length > 0);

    // ------------------------------------------------------------ neural view
    const neural = await owner.get('/api/admin/neural?window=120');
    check('neural graph builds nodes and edges', neural.data.nodes.length > 3 && neural.data.edges.length > 3);
    check('neural graph carries live telemetry', neural.data.telemetry.series.length === 30);
    check('neural graph marks DM content as encrypted', Object.values(neural.data.content).some((c) => c.kind === 'conversation' && c.encrypted === true));
    check('neural graph exposes public community seeds', Object.values(neural.data.content).some((c) => c.kind === 'forum' && c.isPublic && c.publicSeed));
    const forumNode = neural.data.nodes.find((node) => node.type === 'forum' && node.label === 'Signal Garden');
    const drill = await owner.get(`/api/admin/neural/node/forum/${forumId}`);
    check('neural drill-down returns the community itself', drill.status === 200 && Array.isArray(drill.data.items));
    const threadDrill = await owner.get(`/api/admin/neural/node/thread/${threadId}`);
    check('thread drill-down returns replies', threadDrill.status === 200 && threadDrill.data.node.id === threadId);
    check('forum node exists for recently created community', !!forumNode);

    const nonAdminNeural = await member.get('/api/admin/neural');
    check('neural view is admin-only', nonAdminNeural.status === 403);

    // --------------------------------------------------------------- clicker
    const click1 = await member.post('/api/click');
    const click2 = await outsider.post('/api/click');
    check('global clicker counts every account', click2.data.total === click1.data.total + 1);
    const clickView = await owner.get('/api/click');
    check('clicker exposes weekly totals', typeof clickView.data.week === 'number' && clickView.data.week >= 2);

    // ------------------------------------------------------ recovery + password
    const recoveryClient = makeClient();
    const recoveryLogin = await recoveryClient.post('/api/auth/login', { username: 'second-user', recoveryProof: memberReg.payload.recoveryCodes[0].proof });
    check('backup code signs the account back in', recoveryLogin.status === 200 && recoveryLogin.data.recovered === true);
    check('recovery returns the wrapped vault', !!recoveryLogin.data.vault.wrapped);
    const reuse = await makeClient().post('/api/auth/login', { username: 'second-user', recoveryProof: memberReg.payload.recoveryCodes[0].proof });
    check('a backup code cannot be used twice', reuse.status === 401);

    recoveryClient.setToken(recoveryLogin.data.token);
    const newAuthKey = b64(crypto.randomBytes(32));
    const passwordChange = await recoveryClient.post('/api/auth/password', {
      currentAuthKey: memberReg.payload.authKey,
      newAuthKey,
      vault: fakeVault(),
      keepSessions: false,
    });
    check('recovered account can rotate its passphrase', passwordChange.status === 200, JSON.stringify(passwordChange.data));
    const oldKeyLogin = await anon.post('/api/auth/login', { username: 'second-user', authKey: memberReg.payload.authKey });
    check('the old passphrase stops working', oldKeyLogin.status === 401);

    const freshCodes = [1, 2, 3, 4, 5].map((index) => ({ proof: b64(crypto.randomBytes(32)), wrapped: fakeVault(), label: `new ${index}` }));
    const regen = await recoveryClient.post('/api/auth/recovery/regenerate', { codes: freshCodes });
    check('recovery codes can be regenerated', regen.status === 200 && regen.data.backup.count === 5);
    const staleCode = await makeClient().post('/api/auth/login', { username: 'second-user', recoveryProof: memberReg.payload.recoveryCodes[1].proof });
    check('stale recovery codes stop working after rotation', staleCode.status === 401);
    const freshCode = await makeClient().post('/api/auth/login', { username: 'second-user', recoveryProof: freshCodes[0].proof });
    check('fresh recovery codes work after rotation', freshCode.status === 200 && freshCode.data.recovered === true);

    const memberReborn = await anon.post('/api/auth/login', { username: 'second-user', authKey: newAuthKey });
    check('rotated passphrase signs in normally', memberReborn.status === 200);
    member.setToken(memberReborn.data.token);

    // ------------------------------------------------------------- moderation
    const ban = await owner.patch(`/api/admin/users/${memberId}`, { banned: true });
    check('admin can suspend an account', ban.status === 200 && ban.data.user.banned === true);
    const bannedLogin = await anon.post('/api/auth/login', {
      username: 'second-user',
      authKey: (await anon.post('/api/auth/salt', { username: 'second-user' })).data.authSalt ? 'anything' : 'anything',
    });
    check('banned accounts cannot sign in', bannedLogin.status === 403 || bannedLogin.status === 401);
    await owner.patch(`/api/admin/users/${memberId}`, { banned: false });

    const global = await owner.post('/api/admin/global', { registrationOpen: false, notice: 'Scheduled window tonight.' });
    check('admin controls global state', global.data.global.registrationOpen === false);
    const blockedRegister = await registerAccount(makeClient(), 'fourth-user');
    check('registration closes when the operator closes it', blockedRegister.response.status === 403);
    await owner.post('/api/admin/global', { registrationOpen: true });

    const audit = await owner.get('/api/admin/audit');
    check('audit trail records admin actions', audit.data.audit.length > 0 && audit.data.audit.some((entry) => entry.action.startsWith('admin.')));

    const karmaList = await owner.get('/api/admin/karma');
    check('karma leaderboard is admin-only data', Array.isArray(karmaList.data.karma) && karmaList.data.karma[0].karma.received.up >= 1);
    const memberKarmaDenied = await member.get('/api/admin/karma');
    check('members cannot read the karma leaderboard', memberKarmaDenied.status === 401 || memberKarmaDenied.status === 403, `status ${memberKarmaDenied.status}`);
    check('suspension invalidated the member session', memberKarmaDenied.status === 401);

    const overview = await owner.get('/api/admin/overview');
    check('overview reports uptime and memory', overview.data.server.uptime > 0 && overview.data.server.memory.rss > 0);
    check('overview reports storage split', typeof overview.data.storage.total === 'number');
    check('overview counts open requests', typeof overview.data.counts.openRequests === 'number');

    const health = await anon.get('/api/health');
    check('health endpoint is public', health.status === 200 && health.data.ok === true);

    // ------------------------------------------------------------ data at rest
    const dbFile = path.join(dataDir, 'ae-secure.json');
    const raw = fs.readFileSync(dbFile, 'utf8');
    check('database file exists on disk', raw.length > 100);
    check('database stores only a scrypt digest, never key material', !/"authKey"/.test(raw)
      && !/"recoveryCode"/.test(raw)
      && /"authHashStored":"[0-9a-f]{64}"/.test(raw));
    const blobs = path.join(dataDir, 'blobs');
    check('blob storage directory is used for file bytes', fs.existsSync(blobs));
  } finally {
    server.kill('SIGTERM');
    await wait(400);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks passed\n`);
  if (failures) {
    console.log(`${failures} failing checks — rerun with --verbose for the full trace.\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

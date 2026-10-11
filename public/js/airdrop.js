/* ============================================================================
   AE Secure — airdrop: send an encrypted drop to everyone who is online
   ========================================================================== */

const AirdropClient = (() => {
  const { el, clear } = UI;
  const dropKeyCache = new Map();
  const mediaUrls = new Map();

  async function refresh() {
    const data = await API.get('/api/airdrop').catch(() => ({ airdrops: [], count: 0 }));
    State.set('airdrops', data.airdrops);
    State.set('airdropCount', data.count);
    updateBadge(data.count);
    const host = UI.$('#airdrop-list');
    if (host) paint(host);
    return data;
  }

  function updateBadge(count) {
    const button = UI.$('#tb-airdrop');
    if (!button) return;
    let badge = button.querySelector('.tb-badge');
    if (!count) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = el('span', { class: 'tb-badge' });
      button.append(badge);
    }
    badge.textContent = String(count);
  }

  function handle(payload) {
    refresh();
    Shell.blip(980, 70, 0.04, State.settings().airdropSound);
    const drop = payload.airdrop || {};
    UI.toast({
      level: 'info',
      icon: 'airdrop',
      title: 'Airdrop received while you were online',
      body: drop.kind === 'text' ? 'A text drop landed in your airdrop inbox.' : `A ${drop.kind || 'file'} drop (${UI.bytes(drop.size || 0)}) landed in your airdrop inbox.`,
      actions: [{ label: 'Open inbox', primary: true, onClick: () => Apps.open('airdrop') }],
    });
  }

  async function dropKey(senderId) {
    if (dropKeyCache.has(senderId)) return dropKeyCache.get(senderId);
    return null;
  }

  function render(body, api) {
    clear(body);
    const pane = el('div', { class: 'pane' });
    const list = el('div', { class: 'pane-scroll airdrop-panel', id: 'airdrop-list' });
    const enabled = State.settings().airdrop === true;
    const header = el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'body-strong', text: 'Airdrop' }),
        el('div', { class: 'tiny faint', text: enabled ? 'You are receiving drops while you are online.' : 'Turn airdrop on in Settings to receive drops.' }),
      ]),
      el('button', { class: 'btn sm', text: 'Send a drop', onClick: () => composer() }),
      el('button', { class: 'btn sm', text: 'Mark all seen', onClick: async () => { await API.post('/api/airdrop/ack-all', {}); refresh(); } }),
      el('button', { class: 'btn sm', text: 'Refresh', onClick: () => refresh() }),
    ]);
    pane.append(header, list);
    body.append(pane);
    api.setToolbar([]);
    if (!enabled) {
      list.append(el('div', { class: 'notice-strip', html: '<span>⇣</span><span>Airdrop is off. Enable it in Settings → Privacy.</span>' }));
    }
    refresh();
  }

  async function paint(host) {
    clear(host);
    const drops = State.get('airdrops');
    if (!drops.length) {
      host.append(UI.empty('airdrop', 'No drops yet', 'Drops arrive while airdrop is on and you are online.'));
      return;
    }
    for (const drop of drops) {
      const card = el('div', { class: `airdrop-item ${drop.seen ? '' : 'unseen'}` });
      const head = el('div', { class: 'row' }, [
        UI.avatar(drop.sender || {}, { size: 'sm', onClick: () => drop.sender && Profile.open(drop.sender.id) }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'row', style: { gap: '6px' } }, [
            el('span', { class: 'small body-strong', text: drop.sender ? (drop.sender.publicAlias || drop.sender.displayName) : 'Unknown sender' }),
            drop.sender?.verified ? UI.verifiedBadge(drop.sender) : null,
            drop.offlineDelivered ? el('span', { class: 'pill accent tiny', text: 'operator delivery' }) : null,
          ]),
          el('div', { class: 'tiny faint', text: `${UI.timeAgo(drop.createdAt)} · ${drop.kind} ${drop.size ? `· ${UI.bytes(drop.size)}` : ''}` }),
        ]),
        drop.seen ? null : el('span', { class: 'pill accent tiny', text: 'new' }),
      ]);
      card.append(head);
      const content = el('div', { class: 'small', text: 'Decrypting…' });
      card.append(content);
      (async () => {
        const wrapped = drop.keyWrap;
        if (!wrapped) { content.textContent = '▨ This drop was not sealed for your key.'; return; }
        if (!drop.sender?.identityPublic) { content.textContent = '▨ Sender key unavailable.'; return; }
        const shared = await AE.deriveSharedKey(State.vault.identityPrivate, drop.sender.identityPublic, `airdrop:${drop.senderId}`);
        const rawDropKey = await AE.unwrapKey(shared, wrapped);
        if (!rawDropKey) { content.textContent = '▨ Unable to unwrap this drop.'; return; }
        const key = await AE.importAes(rawDropKey);
        if (drop.payload) {
          const plain = await AE.decryptJson(key, drop.payload);
          content.textContent = (plain && plain.text) || '';
        }
        if (drop.fileId) {
          const info = await API.get(`/api/files/${drop.fileId}`).catch(() => null);
          if (!info?.file) return;
          const mime = info.file.meta?.type || 'application/octet-stream';
          const media = el('div', { class: 'message-attachments' });
          if (mime.startsWith('image/') && !mediaUrls.has(info.file.id)) {
            const blob = await API.downloadDecrypted(info.file.id, { chunks: info.file.chunks, fileKeyRaw: rawDropKey, mime });
            const url = URL.createObjectURL(blob);
            State.registerObjectUrl(url);
            mediaUrls.set(info.file.id, url);
            media.append(el('img', { src: url, alt: '', onClick: () => Viewer.open(url, 'airdrop image') }));
          } else if (mediaUrls.has(info.file.id)) {
            media.append(el('img', { src: mediaUrls.get(info.file.id), alt: '' }));
          }
          media.append(el('button', { class: 'btn sm', text: 'Save & decrypt', onClick: async () => {
            const blob = await API.downloadDecrypted(info.file.id, { chunks: info.file.chunks, fileKeyRaw: rawDropKey, mime });
            UI.download(blob, `airdrop-${info.file.id.slice(0, 8)}`);
          } }));
          card.append(media);
        }
      })();
      card.append(el('div', { class: 'row' }, [
        el('button', { class: 'btn sm subtle', text: drop.seen ? 'Seen' : 'Mark seen', disabled: drop.seen, onClick: async () => { await API.post(`/api/airdrop/${drop.id}/ack`, {}); refresh(); } }),
        el('div', { class: 'spacer' }),
        el('span', { class: 'tiny faint', text: `expires ${UI.timeAgo(drop.createdAt + 12 * 3600 * 1000).replace(' ago', '')}` }),
      ]));
      host.append(card);
    }
  }

  async function composer() {
    if (!State.settings().airdrop) {
      const enable = await UI.confirm({
        title: 'Turn airdrop on?',
        message: 'Airdrop both sends your drops and lets other members drop things to you while you are online.',
        confirmLabel: 'Turn on airdrop',
      });
      if (!enable) return;
      await State.saveSettings({ airdrop: true });
      Shell.applyTheme();
      refresh();
    }
    const recipients = await API.get('/api/airdrop/recipients');
    const text = el('textarea', { class: 'textarea', placeholder: 'Drop a message…', rows: 3 });
    const fileInput = el('input', { type: 'file', style: { display: 'none' } });
    const chips = el('div', { class: 'composer-attachments' });
    const pending = { file: null, fileId: null };
    const status = el('div', { class: 'hint', text: `${recipients.onAir} member(s) will receive this drop right now.` });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const limit = State.user.limits.dmUploadBytes;
      if (limit !== -1 && file.size > limit) { status.textContent = `Drop files are limited to ${UI.bytes(limit)} on your account.`; return; }
      pending.file = file;
      clear(chips);
      chips.append(el('span', { class: 'chip-file' }, [el('span', { text: '⌸' }), el('span', { class: 'truncate', text: file.name }), el('span', { class: 'tiny faint', text: UI.bytes(file.size) })]));
    });
    let ref;
    ref = UI.dialog({
      title: 'Send an airdrop',
      icon: 'airdrop',
      size: 'wide',
      subtitle: recipients.note,
      content: el('div', { class: 'stack-12' }, [
        el('div', { class: 'row wrap' }, [
          el('span', { class: 'pill', text: `● ${recipients.online.length} online` }),
          el('span', { class: 'pill', text: `⬢ ${recipients.admins.length} operator(s) offline-protected` }),
        ]),
        text, chips,
        el('button', { class: 'btn sm', text: 'Attach an encrypted file', onClick: () => fileInput.click() }),
        fileInput, status,
      ]),
      footer: [
        el('button', { class: 'btn', text: 'Cancel', onClick: () => ref.close() }),
        el('button', { class: 'btn primary', text: 'Drop it', onClick: async () => {
          const body = text.value.trim();
          if (!body && !pending.file) { status.textContent = 'Write something or attach a file.'; return; }
          status.textContent = 'Sealing the drop…';
          const audience = [...recipients.online, ...recipients.admins];
          if (!audience.length) { status.textContent = 'Nobody is online with airdrop enabled right now.'; return; }
          const dropKeyRaw = await AE.generateAesRaw();
          const dropKey = await AE.importAes(dropKeyRaw);
          const keyWraps = {};
          for (const member of audience) {
            const shared = await AE.deriveSharedKey(State.vault.identityPrivate, member.identityPublic, `airdrop:${State.user.id}`);
            keyWraps[member.id] = await AE.wrapKey(shared, dropKeyRaw);
          }
          let fileId = null;
          if (pending.file) {
            const uploaded = await API.uploadEncrypted({
              kind: 'airdrop', blob: pending.file, meta: { type: pending.file.type },
              wrapFileKey: (raw) => AE.wrapKey(dropKey, raw),
              onProgress: ({ percent }) => { status.textContent = `Encrypting upload… ${percent}%`; },
            });
            fileId = uploaded.fileId;
          }
          const payload = body ? await AE.encryptJson(dropKey, { text: body }) : null;
          const result = await API.post('/api/airdrop', { kind: fileId ? 'file' : 'text', payload, keyWraps, fileId, size: pending.file ? pending.file.size : 0 });
          ref.close();
          UI.toast({ level: 'success', title: 'Airdrop delivered', body: `${result.delivered} member(s) received it${result.adminDelivered ? ` plus ${result.adminDelivered} operator(s)` : ''}.` });
          refresh();
        } }),
      ],
    });
  }

  return { refresh, handle, render, composer };
})();

window.AirdropClient = AirdropClient;

Apps.register({
  id: 'airdrop', title: 'Airdrop', icon: 'airdrop', order: 40, featureFlag: 'airdrop',
  hiddenWhenOff: 'airdrop',
  description: 'Send an encrypted drop to every online member, instantly.',
  keywords: ['airdrop', 'drop', 'share', 'broadcast', 'online'],
  run: () => Windows.open({
    id: 'airdrop', title: 'Airdrop', icon: 'airdrop', geometry: { w: 720, h: 620 },
    render: (body, api) => AirdropClient.render(body, api),
  }),
});

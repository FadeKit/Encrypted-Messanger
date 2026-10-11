/* ============================================================================
   AE Secure — messages: direct chats, group chats, reactions, votes, files
   ========================================================================== */

const ConversationClient = (() => {
  let unsubscribeList = null;
  const { el, clear } = UI;
  const plainCache = new Map();
  const attachmentUrls = new Map();
  let listNode = null;
  let mainNode = null;
  let activeId = null;
  let typingTimer = null;
  const typingUsers = new Map();

  const QUICK_EMOJI = ['👍', '❤', '😂', '🔥', '🎉', '😮', '😢', '🙏', '👀', '💯'];

  function plaintextKey(message) {
    return `${message.id}:${message.payload ? String(message.payload.ct).slice(0, 24) : 'deleted'}:${message.editedAt || 0}`;
  }

  async function decryptMessage(conversation, message, context = 'conv') {
    if (!message.payload) return { text: '', attachments: [] };
    const cacheKey = plaintextKey(message);
    if (plainCache.has(cacheKey)) return plainCache.get(cacheKey);
    const key = conversation.key
      ? conversation.key
      : await State.channelKey(conversation, context);
    if (!key) return { text: 'Unable to derive the channel key for this message.', attachments: [], error: true };
    const payload = await AE.decryptJson(key, message.payload);
    const result = payload || { text: 'Decryption failed — the key may belong to an older channel.', attachments: [], error: true };
    plainCache.set(cacheKey, result);
    return result;
  }

  function withKey(conversation) {
    return Object.assign({}, conversation);
  }

  // ------------------------------------------------------------------ list
  async function refresh() {
    const data = await API.get('/api/conversations');
    const hydrated = [];
    for (const conversation of data.conversations) {
      const key = await State.channelKey(conversation, conversation.type === 'group' || conversation.type === 'dm' ? 'conv' : 'forum');
      hydrated.push(Object.assign(conversation, { key }));
    }
    State.set('conversations', hydrated);
    let unread = 0;
    const byConversation = {};
    for (const conversation of hydrated) {
      unread += conversation.unread || 0;
      byConversation[conversation.id] = conversation.unread || 0;
    }
    State.set('unread', { total: unread, byConversation });
    if (listNode) renderList();
    return hydrated;
  }

  function conversationById(id) {
    return State.get('conversations').find((conversation) => conversation.id === id);
  }

  function render(body, api) {
    clear(body);
    const split = el('div', { class: 'split' });
    const listPane = el('div', { class: 'split-list' });
    mainNode = el('div', { class: 'split-main' });
    UI.swipeBack(mainNode, () => {
      const split = mainNode.closest('.split');
      if (split && split.classList.contains('show-main')) split.classList.remove('show-main');
    });
    split.append(listPane, mainNode);
    body.append(split);
    listNode = listPane;
    renderList();
    renderMain();
    // One subscription per pane, not one per paint: a listener added inside
    // renderList() re-registered itself on every state change.
    if (unsubscribeList) unsubscribeList();
    unsubscribeList = State.subscribe('conversations', () => { if (listNode) renderList(); });
    api.setToolbar([
      el('button', { class: 'btn sm', text: 'New direct message', onClick: () => newDirectDialog() }),
      el('button', { class: 'btn sm', text: 'New group', onClick: () => newGroupDialog() }),
      el('div', { class: 'spacer' }),
    ]);
  }

  function renderList() {
    if (!listNode) return;
    clear(listNode);
    const search = el('input', { class: 'input', placeholder: 'Search conversations…' });
    const head = el('div', { class: 'pad-8 stack-6' }, [
      search,
      el('div', { class: 'row tiny faint' }, [
        el('span', { text: `${State.get('conversations').length} channels` }),
        el('div', { class: 'spacer' }),
        el('span', { text: `${State.get('unread').total} unread` }),
      ]),
    ]);
    const items = el('div', { class: 'stack-4', style: { padding: '0 8px 12px' } });
    const list = State.get('conversations');
    const paint = (filter = '') => {
      clear(items);
      const query = filter.trim().toLowerCase();
      const visible = list.filter((conversation) => !query || (conversation.title || '').toLowerCase().includes(query) || conversation.members.some((member) => (member.displayName || member.username).toLowerCase().includes(query)));
      if (!visible.length) {
        items.append(UI.empty('messages', filter ? 'No matches' : 'No conversations yet', filter ? 'Try a different name.' : 'Start a direct message or a group chat.',
          el('button', { class: 'btn sm primary', text: 'Start a chat', onClick: () => newDirectDialog() })));
        return;
      }
      for (const conversation of visible) items.append(conversationRow(conversation));
    };
    paint();
    search.addEventListener('input', () => paint(search.value));
    listNode.append(head, items, el('div', { class: 'spacer' }));
  }

  function conversationRow(conversation) {
    const peer = conversation.members.find((member) => member.id !== State.user.id) || conversation.members[0] || {};
    const row = el('div', { class: `list-item ${activeId === conversation.id ? 'on' : ''}`, onClick: () => openConversation(conversation.id) });
    const presenceKey = conversation.type === 'dm' ? (peer.status ? peer.status.key : null) : null;
    row.append(UI.avatar(Object.assign({}, peer, { id: conversation.type === 'group' ? conversation.id : peer.id }), {
      status: presenceKey,
      onClick: (event) => { event.stopPropagation(); if (peer.id) Profile.open(peer.id); },
    }));
    const meta = el('div', { class: 'meta' }, [
      el('div', { class: 'name' }, [
        el('span', { class: 'truncate', text: conversation.title || 'Conversation' }),
        conversation.anon ? el('span', { class: 'pill accent tiny', text: 'operator' }) : null,
        peer.verified ? UI.verifiedBadge(peer) : null,
      ]),
      el('div', { class: 'sub truncate', text: conversation.type === 'group' ? `${conversation.members.length + 1} members` : (peer.publicAlias ? `@${peer.username} · ${peer.publicAlias}` : `@${peer.username || 'unknown'}`) }),
      peer.statusMessage ? el('div', { class: 'tiny faint truncate', text: `${peer.statusMessage.emoji || '💬'} ${peer.statusMessage.text}` }) : null,
    ]);
    const tail = el('div', { class: 'tail' }, [
      el('span', { text: conversation.lastMessageAt ? UI.timeAgo(conversation.lastMessageAt) : '' }),
      conversation.unread ? el('span', { class: 'unread-dot', text: String(conversation.unread) }) : null,
    ]);
    row.append(meta, tail);
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      UI.contextMenu([
        { icon: 'profile', label: 'Open', onClick: () => openConversation(conversation.id) },
        { icon: 'check', label: 'Mark as read', onClick: () => API.post(`/api/conversations/${conversation.id}/read`, {}).then(() => refresh()) },
        conversation.type === 'group' && conversation.isOwner ? { icon: 'members', label: 'Manage members', onClick: () => manageGroup(conversation) } : null,
        { separator: true },
        { icon: 'console', label: 'Channel details', onClick: () => channelDetails(conversation) },
      ], { x: event.clientX, y: event.clientY });
    });
    return row;
  }

  async function openConversation(id) {
    activeId = id;
    State.set('activeConversationId', id);
    const split = mainNode && mainNode.closest('.split');
    if (split && window.matchMedia('(max-width: 760px)').matches) split.classList.add('show-main');
    renderList();
    await loadMessages(id);
    renderMain();
    API.post(`/api/conversations/${id}/read`, {}).catch(() => {});
    const conversations = State.get('conversations').map((conversation) => conversation.id === id ? Object.assign({}, conversation, { unread: 0 }) : conversation);
    State.set('conversations', conversations);
    repairOperatorEnvelope(conversationById(id));
  }

  /**
   * A channel that predates the operator envelope, or that the other side
   * opened, gets one the first time this device has the key in hand.  The
   * server keeps the first envelope it is given and ignores later ones.
   */
  async function repairOperatorEnvelope(conversation) {
    if (!conversation || conversation.operatorWrap) return;
    try {
      const raw = await State.channelKeyRaw('conv', conversation);
      if (!raw) return;
      const operatorWrap = await operatorEnvelopeFor('conv', conversation.id, raw);
      if (!operatorWrap) return;
      const result = await API.post(`/api/conversations/${conversation.id}/operator-wrap`, { operatorWrap }).catch(() => null);
      if (result && result.stored) {
        State.set('conversations', State.get('conversations').map((entry) => (
          entry.id === conversation.id ? Object.assign({}, entry, { operatorWrap }) : entry
        )));
      }
    } catch { /* a channel that cannot be repaired still works for its members */ }
  }

  async function loadMessages(id) {
    const data = await API.get(`/api/conversations/${id}/messages?limit=120`);
    const messages = data.messages || [];
    const map = State.get('messages');
    map.set(id, messages);
    State.emit('messages', { conversationId: id, messages });
    return messages;
  }

  function renderMain() {
    if (!mainNode) return;
    clear(mainNode);
    const conversation = activeId ? conversationById(activeId) : null;
    if (!conversation) {
      mainNode.append(UI.empty('messages', 'Pick a conversation'));
      return;
    }
    const peer = conversation.members.find((member) => member.id !== State.user.id) || conversation.members[0] || {};
    const header = el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn icon subtle split-back', text: '‹', title: 'Back to the conversation list', onClick: () => {
        const split = mainNode.closest('.split');
        if (split) split.classList.remove('show-main');
      } }),
      UI.avatar(Object.assign({}, peer, { id: conversation.type === 'group' ? conversation.id : peer.id }), { size: 'sm', status: conversation.type === 'dm' && peer.status ? peer.status.key : null }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'row', style: { gap: '6px' } }, [
          el('span', { class: 'body-strong', text: conversation.title || 'Conversation' }),
          peer.verified ? UI.verifiedBadge(peer) : null,
          conversation.anon ? el('span', { class: 'pill accent tiny', text: 'masked operator' }) : null,
        ]),
        el('div', { class: 'tiny faint truncate', text: conversation.type === 'group' ? `${conversation.members.length + 1} members · ${conversation.members.map((member) => member.displayName).slice(0, 4).join(', ')}` : (peer.status ? UI.statusLabel(peer.status.key) : 'Offline') }),
        // The 24-hour note sits beside the name, exactly where people look for it.
        peer.statusMessage ? StatusBubble.chip(peer, { compact: true }) : null,
      ]),
      conversation.type === 'group' && conversation.isOwner ? el('button', { class: 'btn sm', text: 'Members', onClick: () => manageGroup(conversation) }) : null,
      el('button', { class: 'btn icon subtle', text: 'ⓘ', title: 'Channel details', onClick: () => channelDetails(conversation) }),
      el('button', { class: 'btn icon subtle', html: UI.icon('refresh'), title: 'Reload messages', onClick: () => openConversation(conversation.id) }),
    ]);

    const list = el('div', { class: 'pane-scroll message-list', id: 'message-list' });
    const typing = el('div', { class: 'typing-indicator', id: 'typing-indicator' });
    const composer = buildComposer(conversation);

    mainNode.append(header, list, typing, composer);
    paintMessages(conversation);
    list.scrollTop = list.scrollHeight;
  }

  function paintMessages(conversation) {
    const list = UI.$('#message-list');
    if (!list) return;
    clear(list);
    const messages = (State.get('messages').get(conversation.id) || []);
    if (!messages.length) {
      list.append(UI.empty('messages', 'No messages yet', 'Say hello.'));
      return;
    }
    let lastAuthor = null;
    let lastStamp = 0;
    for (const message of messages) {
      const group = renderMessage(conversation, message, { compact: message.authorId === lastAuthor && message.createdAt - lastStamp < 4 * 60 * 1000 });
      list.append(group);
      lastAuthor = message.authorId;
      lastStamp = message.createdAt;
    }
  }

  function memberOf(conversation, userId) {
    if (!userId) return { displayName: 'Server Administration', username: 'administration', masked: true, verified: true };
    return conversation.members.find((member) => member.id === userId)
      || (conversation.anon && conversation.members[0])
      || { id: userId, displayName: 'Unknown member', username: 'unknown' };
  }

  function renderMessage(conversation, message, options = {}) {
    const author = message.authorId === State.user.id
      ? { id: State.user.id, displayName: State.user.displayName, username: State.user.username, verified: State.user.verified, avatarId: State.user.avatarId }
      : memberOf(conversation, message.authorId);
    const wrapper = el('div', { class: 'message-group', dataset: { message: message.id } });
    if (!options.compact) wrapper.append(UI.avatar(author, { onClick: () => author.id && Profile.open(author.id) }));
    else wrapper.append(el('div', { style: { width: '34px', flex: '0 0 auto' } }));

    const content = el('div', { class: 'message-content' });
    const head = el('div', { class: 'message-head' });
    if (!options.compact) {
      UI.append(head,
        el('span', { class: 'author', text: author.publicAlias || author.displayName }),
        author.masked ? el('span', { class: 'pill accent tiny', text: 'administration' }) : null,
        author.verified ? UI.verifiedBadge(author) : null,
        el('span', { class: 'time', text: UI.clockTime(message.createdAt, State.settings().timestamps) }),
      );
    } else {
      head.append(el('span', { class: 'time', text: UI.clockTime(message.createdAt, 'absolute') }));
    }
    if (message.editedAt) head.append(el('span', { class: 'tiny faint', text: '(edited)' }));
    content.append(head);

    if (message.replyTo) {
      const preview = message.replyPreview || 'message';
      content.append(el('div', { class: 'reply-context', html: `<span>↩</span><span class="truncate">${UI.esc(preview)}</span>` }));
    }

    const textNode = el('div', { class: 'message-text', text: 'Decrypting…' });
    content.append(textNode);
    const attachmentHost = el('div', { class: 'message-attachments' });
    content.append(attachmentHost);

    decryptMessage(conversation, message).then((plain) => {
      if (message.deleted) {
        textNode.textContent = 'This message was removed.';
        textNode.classList.add('deleted');
        return;
      }
      textNode.textContent = plain.text || '';
      if (plain.error) textNode.classList.add('faint');
      const attachments = plain.attachments || [];
      // pictures and clips in one message are one set: the viewer walks them
      const media = attachments.filter((entry) => /^(image|video)\//.test(entry.mime || ''));
      for (const attachment of attachments) {
        attachmentHost.append(attachmentNode(conversation, message, attachment, media));
      }
    });

    // reactions
    const reactionRow = el('div', { class: 'reaction-row' });
    const renderReactions = (reactions) => {
      clear(reactionRow);
      for (const [emoji, data] of Object.entries(reactions || {})) {
        reactionRow.append(el('button', {
          class: `react-chip ${data.mine ? 'mine' : ''}`,
          title: 'Toggle reaction',
          onClick: () => API.post(`/api/messages/${message.id}/reactions`, { emoji }).catch(() => {}),
        }, [el('span', { class: 'emoji', text: emoji }), el('span', { text: String(data.count) })]));
      }
      if (message.karma) {
        reactionRow.append(el('span', { class: 'karma-badge', text: `⬆ ${message.karma.up} ⬇ ${message.karma.down} · score ${message.karma.score}` }));
      }
    };
    renderReactions(message.reactions);
    content.append(reactionRow);

    const actions = el('div', { class: 'message-actions' }, [
      el('button', { class: 'btn sm subtle', html: UI.icon('react'), title: 'Add a reaction', onClick: (event) => reactionPicker(event, message) }),
      el('button', { class: 'btn sm subtle', text: '⋯', title: 'More actions', onClick: (event) => messageMenu(event, conversation, message, author) }),
    ]);
    wrapper.append(content, actions);
    return wrapper;
  }

  /**
   * One attachment, decrypted: the key is wrapped for the channel, so this is
   * the only place that has to know how a bubble and the viewer both get bytes.
   */
  async function loadAttachment(conversation, attachment) {
    const info = await API.get(`/api/files/${attachment.fileId}`);
    const file = info.file;
    const wrapped = attachment.keyWrap || file.keyWrap;
    const rawKey = await State.unwrapFileKey(conversation, wrapped, conversation.type === 'dm' || conversation.type === 'group' ? 'conv' : 'forum');
    if (!rawKey) throw new Error('the key for this attachment is not on this device');
    const mime = attachment.mime || file.meta?.type || 'application/octet-stream';
    const blob = await API.downloadDecrypted(file.id, { chunks: file.chunks, fileKeyRaw: rawKey, mime });
    const url = URL.createObjectURL(blob);
    State.registerObjectUrl(url);
    attachmentUrls.set(file.id, url);
    return { url, blob, mime, size: blob.size, name: attachment.name || `encrypted-${file.id.slice(0, 6)}` };
  }

  function attachmentNode(conversation, message, attachment, media = []) {
    const node = el('div', { class: 'attachment' });
    const placeholder = el('div', { class: 'locked', html: '<span>▨</span><span>Decrypting attachment…</span>' });
    node.append(placeholder);
    (async () => {
      const info = await API.get(`/api/files/${attachment.fileId}`).catch(() => null);
      if (!info || !info.file) { clear(node).append(el('div', { class: 'locked', text: 'Attachment unavailable' })); return; }
      const file = info.file;
      const wrapped = attachment.keyWrap || file.keyWrap;
      const rawKey = await State.unwrapFileKey(conversation, wrapped, conversation.type === 'dm' || conversation.type === 'group' ? 'conv' : 'forum');
      if (!rawKey) { clear(node).append(el('div', { class: 'locked', text: 'Missing key for this attachment' })); return; }
      const mime = attachment.mime || file.meta?.type || 'application/octet-stream';
      const name = attachment.name || `encrypted-${file.id.slice(0, 6)}`;
      const isImage = mime.startsWith('image/') && !attachment.type?.includes('file');
      const isVideo = mime.startsWith('video/');
      if (isImage || isVideo) {
        // Every picture and clip in this message becomes one set in the viewer:
        // a tap opens the one under the finger, and the arrows walk the rest.
        // Each item decrypts on demand, so nothing is downloaded twice.
        const set = media.some((entry) => entry.fileId === attachment.fileId) ? media : [attachment];
        const mine = Math.max(0, set.findIndex((entry) => entry.fileId === attachment.fileId));
        const items = set.map((entry, position) => ({
          url: attachmentUrls.get(entry.fileId) || '',
          name: entry.name || `attachment ${position + 1}`,
          mime: entry.mime || '',
          resolve: () => loadAttachment(conversation, entry),
        }));
        if (!items[mine].url) items[mine].url = attachmentUrls.get(file.id) || '';
        const openViewer = () => Viewer.open(items, { index: mine });
        const paint = (url) => {
          clear(node).append(isImage
            ? el('img', { class: 'attachment-media', src: url, alt: name, title: `${name} — open in the viewer`, onClick: () => openViewer() })
            : el('video', { class: 'attachment-media', src: url, controls: true, preload: 'metadata', playsinline: '', onClick: () => openViewer() }));
        };
        // already downloaded once in this session? paint it and skip the round trip
        if (attachmentUrls.has(file.id)) paint(attachmentUrls.get(file.id));
        else {
          const ready = await loadAttachment(conversation, attachment);
          if (!items[mine].url) items[mine].url = ready.url;
          paint(ready.url);
        }
      } else {
        clear(node).append(el('div', { class: 'file-row', title: 'Download and decrypt' }, [
          el('span', { text: fileIcon(mime) }),
          el('div', { class: 'grow' }, [
            el('div', { class: 'truncate', text: name }),
            el('div', { class: 'tiny faint', text: `${UI.bytes(file.size)} · encrypted` }),
          ]),
          el('button', { class: 'btn sm', html: UI.icon('image'), title: 'Open in the viewer', onClick: () => Viewer.open([
            Object.assign({ file, name, mime, note: '' }, attachmentUrls.has(file.id) ? { url: attachmentUrls.get(file.id) } : {}),
          ]) }),
          el('button', { class: 'btn sm primary', text: 'Save', onClick: async () => {
            const blob = await API.downloadDecrypted(file.id, { chunks: file.chunks, fileKeyRaw: rawKey, mime });
            UI.download(blob, name);
          } }),
        ]));
      }
    })();
    return node;
  }

  function fileIcon(mime = '') {
    if (mime.startsWith('image/')) return '▣';
    if (mime.startsWith('video/')) return '▤';
    if (mime.startsWith('audio/')) return '♪';
    if (mime.includes('pdf')) return '¶';
    if (mime.includes('zip') || mime.includes('compressed')) return '⌸';
    if (mime.includes('text') || mime.includes('json')) return '≡';
    return '⌸';
  }

  function reactionPicker(event, message) {
    const host = el('div', { class: 'stack-6 pad-8' });
    const grid = el('div', { class: 'row wrap', style: { gap: '4px' } });
    for (const emoji of QUICK_EMOJI) {
      grid.append(el('button', { class: 'btn icon', text: emoji, onClick: () => { API.post(`/api/messages/${message.id}/reactions`, { emoji }); ref.close(); } }));
    }
    const custom = el('input', { class: 'input', placeholder: 'Any emoji or short text', maxlength: '8' });
    const send = el('button', { class: 'btn sm primary', text: 'React', onClick: () => {
      if (!custom.value.trim()) return;
      API.post(`/api/messages/${message.id}/reactions`, { emoji: custom.value.trim() });
      ref.close();
    } });
    host.append(grid, el('div', { class: 'input-row' }, [custom, send]));
    const ref = UI.dialog({ title: 'Add a reaction', icon: 'react', size: 'narrow', content: host });
  }

  function messageMenu(event, conversation, message, author) {
    const settings = State.settings();
    const isPublicForum = false; // chat messages are never publicly deletable by members
    const canDelete = message.deleted ? false : (State.user.role === 'owner' || State.user.role === 'admin') || (isPublicForum && message.own);
    const items = [
      { label: 'Message actions' },
      { icon: 'reply', label: 'Reply', onClick: () => startReply(conversation, message) },
      { icon: 'react', label: 'Add reaction', onClick: () => reactionPicker(event, message) },
      { icon: 'upvote', label: 'Upvote', disabled: message.own, onClick: () => API.post(`/api/messages/${message.id}/vote`, { value: 1 }) },
      { icon: 'downvote', label: 'Downvote', disabled: message.own, onClick: () => API.post(`/api/messages/${message.id}/vote`, { value: -1 }) },
      { icon: 'close', label: 'Clear my vote', disabled: message.own, onClick: () => API.post(`/api/messages/${message.id}/vote`, { value: 0 }) },
      { separator: true },
      { icon: 'copy', label: 'Copy message text', onClick: async () => {
        const plain = await decryptMessage(conversation, message);
        UI.copy(plain.text || '', 'Message copied');
      } },
      message.own ? { icon: 'editor', label: 'Edit message', onClick: () => editMessage(conversation, message) } : null,
      State.user.role === 'owner' || State.user.role === 'admin'
        ? { icon: 'trash', label: 'Delete message (operator)', danger: true, onClick: () => deleteMessage(message) }
        : null,
    ].filter(Boolean);
    UI.contextMenu(items, { x: event.clientX - 200, y: event.clientY });
  }

  async function editMessage(conversation, message) {
    const plain = await decryptMessage(conversation, message);
    const updated = await UI.prompt({ title: 'Edit message', value: plain.text || '', multiline: true, confirmLabel: 'Save' });
    if (updated === null) return;
    const payload = await AE.encryptJson(conversation.key, Object.assign({}, plain, { text: updated }));
    await API.patch(`/api/messages/${message.id}`, { payload });
    await loadMessages(conversation.id);
    paintMessages(conversation);
  }

  async function deleteMessage(message) {
    const confirmed = await UI.confirm({
      title: 'Delete this message?',
      message: 'The ciphertext is removed for everyone. In chats only operators can delete messages.',
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    await API.del(`/api/messages/${message.id}`);
    const conversation = conversationById(message.convId);
    if (conversation) { await loadMessages(conversation.id); paintMessages(conversation); }
  }

  function startReply(conversation, message) {
    const composer = UI.$('#composer-input');
    if (!composer) return;
    composer.dataset.replyTo = message.id;
    const banner = UI.$('#composer-reply');
    if (banner) {
      clear(banner);
      banner.hidden = false;
      banner.append(
        el('span', { text: '↩' }),
        el('span', { class: 'grow truncate', text: 'Replying to a message' }),
        el('button', { class: 'btn icon sm subtle', text: '✕', onClick: () => { banner.hidden = true; delete composer.dataset.replyTo; } }),
      );
    }
    composer.focus();
  }

  // -------------------------------------------------------------- composer
  function buildComposer(conversation) {
    const settings = State.settings();
    const canUpload = State.featureEnabled('uploads');
    const input = el('textarea', { class: 'textarea', id: 'composer-input', placeholder: 'Write an encrypted message…', rows: 1 });
    const replyBanner = el('div', { class: 'reply-context', id: 'composer-reply', hidden: true });
    const pendingHost = el('div', { class: 'composer-attachments' });
    const progressHost = el('div', { class: 'stack-6' });
    const pending = [];

    const fileInput = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
    const attachButton = el('button', { class: 'btn icon', text: '⊕', title: canUpload ? 'Attach an encrypted file' : 'Uploads are disabled in your settings', disabled: !canUpload, onClick: () => fileInput.click() });
    const emojiButton = el('button', { class: 'btn icon', html: UI.icon('smile'), title: 'Insert emoji', onClick: () => {
      UI.contextMenu(QUICK_EMOJI.map((emoji) => ({ glyph: emoji, label: `Insert ${emoji}`, onClick: () => { input.value += emoji; input.focus(); } })), { x: window.innerWidth / 2 - 120, y: window.innerHeight - 320 });
    } });
    const sendButton = el('button', { class: 'btn primary', text: 'Send', onClick: () => send() });

    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      for (const file of files) await queueAttachment(file);
    });

    async function queueAttachment(file) {
      const limit = State.user.limits.dmUploadBytes;
      if (limit !== -1 && file.size > limit) {
        UI.toast({
          level: 'danger', title: 'Too large for your current allowance',
          body: `${file.name} is ${UI.bytes(file.size)} but your messaging limit is ${UI.bytes(limit)}.`,
          actions: [{ label: 'Request a bigger limit', primary: true, onClick: () => Settings.open('requests') }],
        });
        return;
      }
      const row = el('div', { class: 'upload-row' });
      const name = el('div', { class: 'name' }, [el('span', { text: fileIcon(file.type) }), el('span', { class: 'grow truncate', text: file.name }), el('span', { class: 'tiny faint', text: '0%' })]);
      const bar = el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill' })]);
      row.append(name, bar);
      progressHost.append(row);
      try {
        const result = await API.uploadEncrypted({
          kind: 'dm',
          blob: file,
          meta: { type: file.type },
          wrapFileKey: (raw) => State.wrapFileKeyWithChannel(conversation, raw),
          onProgress: ({ percent }) => {
            bar.firstChild.style.width = `${percent}%`;
            name.lastChild.textContent = `${percent}%`;
          },
        });
        const entry = { fileId: result.fileId, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, type: file.type.startsWith('image/') ? 'image' : 'file' };
        pending.push(entry);
        row.remove();
        renderPending();
      } catch (error) {
        row.remove();
        UI.toast({ level: 'danger', title: 'Upload failed', body: error.message });
      }
    }

    function renderPending() {
      clear(pendingHost);
      for (const entry of pending) {
        pendingHost.append(el('span', { class: 'chip-file' }, [
          el('span', { text: fileIcon(entry.mime) }),
          el('span', { class: 'truncate', style: { maxWidth: '180px' }, text: entry.name }),
          el('span', { class: 'tiny faint', text: 'encrypted' }),
          el('button', { class: 'btn icon sm subtle', text: '✕', onClick: () => { pending.splice(pending.indexOf(entry), 1); renderPending(); } }),
        ]));
      }
    }

    async function send() {
      const text = input.value.trim();
      if (!text && !pending.length) return;
      const payloadObject = { text, attachments: pending.slice() };
      const payload = await AE.encryptJson(conversation.key, payloadObject);
      const replyTo = input.dataset.replyTo || null;
      try {
        await API.post(`/api/conversations/${conversation.id}/messages`, {
          payload,
          attachments: pending.map((entry) => ({ fileId: entry.fileId, type: entry.type, mime: entry.mime, name: entry.name })),
          replyTo,
          replyPreview: replyTo ? 'replying' : null,
        });
        input.value = '';
        input.style.height = 'auto';
        delete input.dataset.replyTo;
        const banner = UI.$('#composer-reply');
        if (banner) banner.hidden = true;
        pending.length = 0;
        renderPending();
        await loadMessages(conversation.id);
        paintMessages(conversation);
        const list = UI.$('#message-list');
        if (list) list.scrollTop = list.scrollHeight;
        Shell.blip(880, 60, 0.03);
      } catch (error) {
        UI.toast({ level: 'danger', title: 'Message not sent', body: error.message });
      }
    }

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(160, input.scrollHeight)}px`;
      clearTimeout(typingTimer);
      API.post(`/api/conversations/${conversation.id}/typing`, { typing: true }).catch(() => {});
      typingTimer = setTimeout(() => API.post(`/api/conversations/${conversation.id}/typing`, { typing: false }).catch(() => {}), 2600);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && State.settings().enterToSend !== false) {
        event.preventDefault();
        send();
      }
    });

    input.addEventListener('paste', async (event) => {
      const items = [...(event.clipboardData?.items || [])];
      const fileItem = items.find((item) => item.kind === 'file');
      if (!fileItem) return;
      event.preventDefault();
      await queueAttachment(fileItem.getAsFile());
    });

    return el('div', { class: 'composer' }, [
      replyBanner,
      progressHost,
      pendingHost,
      el('div', { class: 'composer-row' }, [
        attachButton, fileInput,
        canUpload && State.featureEnabled('emojiPicker') !== false ? emojiButton : null,
        input,
        sendButton,
      ]),
      el('div', { class: 'row tiny faint' }, [
        el('span', { class: 'encryption-note', text: 'AES-GCM-256 sealed on this device · the server sees ciphertext only' }),
        el('div', { class: 'spacer' }),
        el('span', { text: State.settings().enterToSend !== false ? 'Enter sends · Shift+Enter adds a line' : 'Ctrl+Enter sends' }),
      ]),
    ]);
  }

  // ---------------------------------------------------------- interactions
  async function newDirectDialog() {
    const users = await fetchPeople();
    const selected = new Set();
    const search = el('input', { class: 'input', placeholder: 'Search handles or display names…' });
    const results = el('div', { class: 'stack-4', style: { maxHeight: '300px', overflowY: 'auto' } });
    const paint = () => {
      clear(results);
      const query = search.value.trim().toLowerCase();
      const list = users.filter((user) => user.id !== State.user.id)
        .filter((user) => !query || (user.displayName || '').toLowerCase().includes(query) || user.username.toLowerCase().includes(query));
      if (!list.length) { results.append(el('div', { class: 'caption pad-8', text: 'No accounts matched.' })); return; }
      for (const user of list.slice(0, 60)) {
        UI.append(results, el('div', { class: `list-item ${selected.has(user.id) ? 'on' : ''}`, onClick: () => {
          selected.clear();
          selected.add(user.id);
          paint();
        } }, [
          UI.avatar(user, { size: 'sm', status: State.get('presence')[user.id]?.key }),
          el('div', { class: 'meta' }, [
            el('div', { class: 'name' }, [el('span', { text: user.publicAlias || user.displayName }), user.verified ? UI.verifiedBadge(user) : null]),
            el('div', { class: 'sub', text: `@${user.username} · ${UI.statusLabel(State.get('presence')[user.id]?.key || 'offline')}` }),
          ]),
        ]));
      }
    };
    paint();
    search.addEventListener('input', paint);
    let ref;
    ref = UI.dialog({
      title: 'New direct message',
      icon: 'editor',
      subtitle: 'One-to-one channels are encrypted with a key only you two hold.',
      content: el('div', { class: 'stack-8' }, [search, results]),
      footer: [
        el('button', { class: 'btn', text: 'Cancel', onClick: () => ref.close() }),
        el('button', { class: 'btn primary', text: 'Start chatting', onClick: async () => {
          const peerId = [...selected][0];
          if (!peerId) return;
          try {
            const conversation = await openDirectChannel(peerId);
            ref.close();
            await refresh();
            await openConversation(conversation.id);
          } catch (error) {
            UI.toast({ level: 'danger', title: 'Could not start that channel', body: error.message });
          }
        } }),
      ],
    });
  }

  async function newGroupDialog() {
    const users = await fetchPeople();
    const title = el('input', { class: 'input', placeholder: 'Group name' });
    const selected = new Set();
    const search = el('input', { class: 'input', placeholder: 'Add members…' });
    const results = el('div', { class: 'stack-4', style: { maxHeight: '260px', overflowY: 'auto' } });
    const chips = el('div', { class: 'row wrap' });
    const paint = () => {
      clear(results);
      clear(chips);
      const query = search.value.trim().toLowerCase();
      const list = users.filter((user) => user.id !== State.user.id && !selected.has(user.id))
        .filter((user) => !query || (user.displayName || '').toLowerCase().includes(query) || user.username.toLowerCase().includes(query));
      for (const user of list.slice(0, 60)) {
        results.append(el('div', { class: 'list-item', onClick: () => { selected.add(user.id); paint(); } }, [
          UI.avatar(user, { size: 'sm' }),
          el('div', { class: 'meta' }, [el('div', { class: 'name', text: user.publicAlias || user.displayName }), el('div', { class: 'sub', text: `@${user.username}` })]),
        ]));
      }
      for (const id of selected) {
        const user = users.find((candidate) => candidate.id === id);
        chips.append(el('span', { class: 'chip-file' }, [el('span', { text: user.publicAlias || user.displayName }), el('button', { class: 'btn icon sm subtle', text: '✕', onClick: () => { selected.delete(id); paint(); } })]));
      }
    };
    paint();
    search.addEventListener('input', paint);
    let ref;
    ref = UI.dialog({
      title: 'New group chat',
      icon: 'members',
      subtitle: 'You own the group: add or remove members at any time.',
      content: el('div', { class: 'stack-8' }, [title, chips, search, results]),
      footer: [
        el('button', { class: 'btn', text: 'Cancel', onClick: () => ref.close() }),
        el('button', { class: 'btn primary', text: 'Create group', onClick: async () => {
          if (!selected.size) { UI.toast({ level: 'warning', title: 'Add at least one member' }); return; }
          const members = [...selected].map((id) => users.find((user) => user.id === id));
          const conversationId = freshConversationId();
          const rawKey = await AE.generateAesRaw();
          const wraps = {};
          wraps[State.user.id] = await State.wrapChannelKey('conv', conversationId, rawKey, State.vault.identityPublic);
          for (const member of members) wraps[member.id] = await State.wrapChannelKey('conv', conversationId, rawKey, member.identityPublic);
          const created = await API.post('/api/conversations', {
            id: conversationId, type: 'group', title: title.value.trim() || 'Group chat',
            memberIds: members.map((member) => member.id), keyWraps: wraps,
            operatorWrap: await operatorEnvelopeFor('conv', conversationId, rawKey),
          });
          ref.close();
          await refresh();
          await openConversation(created.conversation.id);
        } }),
      ],
    });
  }

  async function manageGroup(conversation) {
    const users = await fetchPeople();
    const content = el('div', { class: 'stack-8' });
    const refreshMembers = () => {
      clear(content);
      const current = conversationById(conversation.id) || conversation;
      for (const member of current.members) {
        content.append(el('div', { class: 'list-item' }, [
          UI.avatar(member, { size: 'sm' }),
          el('div', { class: 'meta' }, [el('div', { class: 'name', text: member.publicAlias || member.displayName }), el('div', { class: 'sub', text: `@${member.username}` })]),
          el('button', { class: 'btn sm danger', text: 'Remove', onClick: async () => {
            await API.del(`/api/conversations/${conversation.id}/members/${member.id}`);
            await refresh();
            refreshMembers();
          } }),
        ]));
      }
      const candidates = users.filter((user) => !current.members.some((member) => member.id === user.id) && user.id !== State.user.id);
      const search = el('input', { class: 'input', placeholder: 'Add someone…' });
      const results = el('div', { class: 'stack-4' });
      const paint = () => {
        clear(results);
        const query = search.value.trim().toLowerCase();
        for (const user of candidates.filter((u) => !query || u.username.includes(query) || (u.displayName || '').toLowerCase().includes(query)).slice(0, 12)) {
          results.append(el('div', { class: 'list-item', onClick: async () => {
            const rawKey = await State.channelKeyRaw('conv', current);
            if (!rawKey) { UI.toast({ level: 'warning', title: 'Channel key unavailable', body: 'Reopen the conversation and try again.' }); return; }
            const wraps = {};
            wraps[user.id] = await State.wrapChannelKey('conv', conversation.id, rawKey, user.identityPublic);
            await API.post(`/api/conversations/${conversation.id}/members`, { memberIds: [user.id], keyWraps: wraps });
            await refresh();
            refreshMembers();
          } }, [
            UI.avatar(user, { size: 'sm' }),
            el('div', { class: 'meta' }, [el('div', { class: 'name', text: user.displayName }), el('div', { class: 'sub', text: `@${user.username}` })]),
            el('span', { class: 'btn sm', text: 'Add' }),
          ]));
        }
      };
      paint();
      search.addEventListener('input', paint);
      content.append(el('div', { class: 'divider' }), el('div', { class: 'uppercase', text: 'Add members' }), search, results);
    };
    refreshMembers();
    UI.dialog({ title: `Manage ${conversation.title}`, icon: 'members', subtitle: 'Group membership is under your control as the owner.', content, size: 'wide' });
  }

  async function channelDetails(conversation) {
    let isAdmin = State.user.role === 'owner' || State.user.role === 'admin';
    UI.dialog({
      title: conversation.title || 'Channel',
      icon: 'console',
      subtitle: conversation.type === 'group' ? 'Group chat' : 'Direct message',
      content: el('div', { class: 'stack-8' }, [
        el('div', { class: 'notice-strip', html: '<span>▨</span><span>This channel uses AES-GCM-256 with a key wrapped for each member through ECDH P-256. The server stores ciphertext and wrapped keys only.</span>' }),
        el('div', { class: 'small muted', text: `Created ${UI.dateTime(conversation.createdAt)}` }),
        el('div', { class: 'small muted', text: `Last activity ${UI.timeAgo(conversation.lastMessageAt)}` }),
        el('div', { class: 'uppercase', text: 'Members' }),
        ...conversation.members.map((member) => el('div', { class: 'list-item' }, [
          UI.avatar(member, { size: 'sm' }),
          el('div', { class: 'meta' }, [el('div', { class: 'name', text: member.publicAlias || member.displayName }), el('div', { class: 'sub', text: `@${member.username}` })]),
          member.verified ? UI.verifiedBadge(member) : null,
        ])),
        isAdmin ? el('div', { class: 'notice-strip', html: '<span>⬢</span><span>As an administrator you can delete individual messages in this channel; deleting only removes ciphertext.</span>' }) : null,
      ]),
    });
  }

  async function fetchPeople() {
    const data = await API.get('/api/directory').catch(() => null);
    if (data && data.users) return data.users;
    return [];
  }

  function freshConversationId() {
    return `c_${AE.b64encode(AE.randomBytes(12)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}`;
  }

  /**
   * The same channel key, sealed once for the operator identity.  Written when
   * a channel is created and repaired the first time an older channel is opened
   * on a device that holds the key, so nothing has to be re-sent to be readable
   * by the account that runs this server.
   */
  async function operatorEnvelopeFor(context, conversationId, rawKey) {
    return State.sealForOperator(context, rawKey, `${context}:${conversationId}`);
  }

  /** Seals one channel key for both sides of a direct channel. */
  async function wrapForConversation(conversationId, peer, rawKey) {
    const wraps = {};
    wraps[State.user.id] = await State.wrapChannelKey('conv', conversationId, rawKey, State.vault.identityPublic);
    wraps[peer.id] = await State.wrapChannelKey('conv', conversationId, rawKey, peer.identityPublic);
    return wraps;
  }

  /**
   * Opens (or reuses) a direct channel and leaves this device able to read it.
   * The key is wrapped for the id the server actually stored: a fresh channel
   * keeps the id we wrapped for, and a channel that already existed keeps its
   * own key, which is already wrapped for both sides.
   */
  async function openDirectChannel(peerId) {
    const data = await API.get('/api/directory').catch(() => null);
    const peer = data && data.users ? data.users.find((user) => user.id === peerId) : null;
    if (!peer || !peer.identityPublic) throw new Error('Public identity key unavailable.');
    const wanted = freshConversationId();
    const rawKey = await AE.generateAesRaw();
    const created = await API.post('/api/conversations', {
      id: wanted, type: 'dm', memberIds: [peerId],
      keyWraps: await wrapForConversation(wanted, peer, rawKey),
      operatorWrap: await operatorEnvelopeFor('conv', wanted, rawKey),
    });
    const conversation = created.conversation;
    // An id the server could not take, or somebody else's channel: wrap the key
    // again under the id that was stored, or the channel would never open.
    if (conversation.id !== wanted && !conversation.keyWrap) {
      await API.post(`/api/conversations/${conversation.id}/keys`, {
        keyWraps: await wrapForConversation(conversation.id, peer, rawKey),
      });
    }
    return conversation;
  }

  // Realtime hooks
  function onIncomingMessage(payload) {
    const conversation = State.get('conversations').find((entry) => entry.id === payload.conversationId);
    if (!conversation) { refresh().catch(() => {}); return; }
    // A notice about a channel — a removal, the sender's own echo — carries no
    // message of its own; refreshing the channel is the whole job.
    if (!payload.message) { refresh().catch(() => {}); return; }
    const map = State.get('messages');
    const list = map.get(payload.conversationId) || [];
    if (!list.some((message) => message.id === payload.message.id)) list.push(payload.message);
    map.set(payload.conversationId, list);
    if (activeId === payload.conversationId) {
      paintMessages(conversation);
      const host = UI.$('#message-list');
      if (host) host.scrollTop = host.scrollHeight;
      API.post(`/api/conversations/${conversation.id}/read`, {}).catch(() => {});
    }
    refresh().catch(() => {});
  }

  function bumpUnread(id) {
    const conversations = State.get('conversations').map((conversation) => conversation.id === id
      ? Object.assign({}, conversation, { unread: (conversation.unread || 0) + 1 })
      : conversation);
    State.set('conversations', conversations);
  }

  API.on('message.updated', (payload) => {
    const map = State.get('messages');
    for (const [conversationId, list] of map.entries()) {
      const index = list.findIndex((message) => message.id === payload.messageId);
      if (index > -1) {
        list[index] = payload.message;
        map.set(conversationId, list);
        const conversation = conversationById(conversationId);
        if (conversation && activeId === conversationId) paintMessages(conversation);
      }
    }
  });

  API.on('typing', (payload) => {
    if (payload.conversationId !== activeId) return;
    const indicator = UI.$('#typing-indicator');
    if (!indicator) return;
    if (payload.typing) typingUsers.set(payload.userId, Date.now());
    else typingUsers.delete(payload.userId);
    const conversation = conversationById(activeId);
    const names = [...typingUsers.keys()].map((userId) => (memberOf(conversation, userId).displayName || '')).filter(Boolean);
    indicator.textContent = names.length ? `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…` : '';
  });

  API.on('read', () => { /* receipts are display-only */ });
  API.on('conversation.created', () => refresh().catch(() => {}));
  API.on('conversation.updated', () => refresh().catch(() => {}));
  API.on('conversation.keys', () => refresh().catch(() => {}));

  /** Opens a direct channel with another account from anywhere in the shell. */
  function startWith(peerId) {
    return Profile.startDirect(peerId);
  }

  return { refresh, render, open: openConversation, onIncomingMessage, bumpUnread, conversationById, decryptMessage, fileIcon, startWith, openDirectChannel };
})();

window.ConversationClient = ConversationClient;

/* ------------------------------------------------------------- profile -- */
const Profile = (() => {
  async function open(userId) {
    if (!userId) return;
    try {
      const data = await API.get(`/api/public/profile/${userId}`);
      const profile = data.profile;
      const isSelf = profile.id === State.user.id;
      const profileForBubbles = Object.assign({}, profile, { statusMessage: profile.statusMessage ? Object.assign({}, profile.statusMessage, { own: isSelf }) : null });
      const presence = State.get('presence')[profile.id];
      const content = el('div', { class: 'stack-12' }, [
        el('div', { class: 'row' }, [
          UI.avatar(profile, { size: 'xl', status: presence ? presence.key : 'offline' }),
          el('div', { class: 'stack-2' }, [
            el('div', { class: 'row' }, [
              el('span', { class: 'title-3', text: profile.publicAlias || profile.displayName }),
              profile.verified ? UI.verifiedBadge(profile, false) : null,
            ]),
            el('div', { class: 'caption', text: `@${profile.username}` }),
            el('div', { class: 'small muted', text: presence ? UI.statusLabel(presence.key) : 'Offline' }),
            el('div', { class: 'small muted', text: `${profile.fingerprint || ''}` }),
          ]),
        ]),
        profileForBubbles.statusMessage ? StatusBubble.chip(profileForBubbles, { compact: true }) : null,
        profile.bio ? el('div', { class: 'card', text: profile.bio }) : null,
        el('div', { class: 'grid-3' }, [
          stat('Posts', String(data.posts.length)),
          stat('Stories', String(data.stories.length)),
          stat('Joined', UI.dateTime(profile.createdAt).split(',')[0]),
        ]),
        !isSelf ? el('div', { class: 'row' }, [
          State.featureEnabled('dms') !== false ? el('button', { class: 'btn primary', text: 'Message', onClick: () => startDirect(profile.id) }) : null,
          el('button', { class: 'btn', text: 'Copy handle', onClick: () => UI.copy(profile.username, 'Handle copied') }),
        ]) : null,
      ]);
      UI.dialog({ title: 'Profile', icon: 'profile', size: 'wide', content });
    } catch (error) {
      UI.toast({ level: 'info', title: 'Private profile', body: error.message });
    }
  }

  // -------------------------------------------------------------- credits
  /**
   * Opens a private channel with the person credited on the sign-in screen.
   * The handle is looked up in the directory, an existing channel is reused if
   * there is one, and otherwise startDirect() seals a fresh channel key for
   * that account. Nothing about the account travels in clear.
   */
  async function messageDeveloper() {
    const handle = (typeof DEVELOPER !== 'undefined' && DEVELOPER.handle) || 'Fade_Kit';
    if (!State.user || !State.vault) {
      UI.toast({ level: 'info', title: 'Sign in first', body: `Unlock your vault, then this link opens a private channel with ${handle}.` });
      return null;
    }
    const wanted = handle.toLowerCase().replace(/[^a-z0-9]/g, '');
    let match = null;
    try {
      const data = await API.get(`/api/directory?q=${encodeURIComponent(handle)}`);
      const users = data.users || [];
      const clean = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      match = users.find((user) => clean(user.username) === wanted) || users.find((user) => clean(user.username).startsWith(wanted)) || null;
    } catch {
      UI.toast({ level: 'danger', title: 'Directory unavailable', body: 'Could not look that account up just now.' });
      return null;
    }
    if (!match) {
      UI.toast({ level: 'warning', title: `${handle} is not registered here`, body: 'No account with that handle exists on this server yet.' });
      return null;
    }
    if (match.id === State.user.id) {
      UI.toast({ level: 'info', title: 'That is your own account' });
      return null;
    }
    await ConversationClient.refresh().catch(() => {});
    const existing = State.get('conversations').find((conversation) => conversation.type === 'dm' && conversation.members.some((member) => member.id === match.id));
    if (existing) {
      Apps.open('messages');
      ConversationClient.open(existing.id);
      return existing.id;
    }
    await startDirect(match.id);
    return match.id;
  }

  async function startDirect(peerId) {
    let conversation;
    try {
      conversation = await ConversationClient.openDirectChannel(peerId);
    } catch (error) {
      UI.toast({ level: 'warning', title: 'Cannot open a channel', body: error.message });
      return null;
    }
    await ConversationClient.refresh();
    Apps.open('messages');
    ConversationClient.open(conversation.id);
    return conversation.id;
  }

  function stat(label, value) {
    return el('div', { class: 'stat-card' }, [el('div', { class: 'value', text: value }), el('div', { class: 'label', text: label })]);
  }

  return { open, startDirect, messageDeveloper };
})();

window.Profile = Profile;

Apps.register({
  id: 'messages', title: 'Messages', icon: 'messages', order: 10,
  description: 'Encrypted direct and group conversations with replies, reactions and attachments.',
  keywords: ['messages', 'chat', 'dm', 'direct', 'group', 'conversation', 'typing'],
  run: () => Windows.open({
    id: 'messages', title: 'Messages', icon: 'messages', geometry: { w: 1120, h: 720 },
    render: (body, api) => ConversationClient.render(body, api),
    toolbar: [],
  }),
});

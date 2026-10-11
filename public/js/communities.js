/* ============================================================================
   AE Secure — communities: public squares and private, member-managed forums
   ========================================================================== */

const CommunityClient = (() => {
  const { el, clear } = UI;
  const plainCache = new Map();
  const mediaUrls = new Map();
  let listNode = null;
  let mainNode = null;
  let activeForumId = null;
  let activeThreadId = null;

  const QUICK_EMOJI = ['👍', '❤', '😂', '🔥', '🎉', '🤔', '🙏', '👀'];

  async function forumKey(forum) {
    if (!forum) return null;
    const wrapped = await State.channelKey(forum, 'forum');
    if (wrapped) return wrapped;
    if (forum.isPublic && forum.publicSeed) return AE.audienceKey(forum.publicSeed, `forum:${forum.id}`);
    return null;
  }

  function cacheKey(message) {
    return `${message.id}:${message.payload ? String(message.payload.ct).slice(0, 20) : 'x'}:${message.editedAt || 0}`;
  }

  async function decryptPost(forum, post) {
    if (!post.payload) return { text: '', attachments: [] };
    const key = await forumKey(forum);
    if (!key) return { text: 'Community key unavailable.', attachments: [], error: true };
    const cacheId = cacheKey(post);
    if (plainCache.has(cacheId)) return plainCache.get(cacheId);
    const plain = await AE.decryptJson(key, post.payload) || { text: 'Unable to decrypt this post.', attachments: [], error: true };
    plainCache.set(cacheId, plain);
    return plain;
  }

  async function refresh() {
    const data = await API.get('/api/forums');
    State.set('forums', data.forums);
    if (listNode) renderList();
    return data.forums;
  }

  function render(body, api) {
    clear(body);
    const split = el('div', { class: 'split' });
    listNode = el('div', { class: 'split-list' });
    mainNode = el('div', { class: 'split-main' });
    split.append(listNode, mainNode);
    body.append(split);
    renderList();
    renderMain();
    api.setToolbar([
      el('button', { class: 'btn sm', text: 'New community', onClick: () => createDialog() }),
      el('button', { class: 'btn sm', text: 'Refresh', onClick: () => refresh().then(() => { renderList(); renderMain(); }) }),
      el('div', { class: 'spacer' }),
      el('span', { class: 'tiny faint', text: `Media in communities: ${State.settings().forumMedia ? 'on' : 'off'}` }),
      el('button', { class: 'btn sm subtle', text: 'Change', onClick: () => Settings.open('privacy') }),
    ]);
    State.subscribe('forums', () => { if (listNode) renderList(); });
  }

  function renderList() {
    if (!listNode) return;
    clear(listNode);
    const search = el('input', { class: 'input', placeholder: 'Search communities…' });
    const items = el('div', { class: 'stack-4', style: { padding: '0 8px 12px' } });
    const paint = () => {
      clear(items);
      const query = search.value.trim().toLowerCase();
      const forums = State.get('forums').filter((forum) => !query || forum.name.toLowerCase().includes(query));
      if (!forums.length) {
        items.append(UI.empty('▩', 'No communities yet', 'Create a public square or a private room for your circle.',
          el('button', { class: 'btn sm primary', text: 'Create a community', onClick: () => createDialog() })));
        return;
      }
      for (const forum of forums) {
        const row = el('div', { class: `list-item ${activeForumId === forum.id ? 'on' : ''}`, onClick: () => openForum(forum.id) });
        row.append(
          el('div', { class: 'avatar', style: { fontSize: '18px' }, text: forum.isPublic ? '◍' : '⌗' }),
          el('div', { class: 'meta' }, [
            el('div', { class: 'name' }, [
              el('span', { class: 'truncate', text: forum.name }),
              forum.isPublic ? el('span', { class: 'pill tiny', text: 'public' }) : el('span', { class: 'pill tiny accent', text: 'private' }),
            ]),
            el('div', { class: 'sub truncate', text: `${forum.memberCount} members · ${forum.stats.threads} threads` }),
          ]),
          el('div', { class: 'tail' }, [el('span', { text: UI.timeAgo(forum.lastActivityAt) })]),
        );
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          UI.contextMenu([
            { glyph: '▣', label: 'Open', onClick: () => openForum(forum.id) },
            { glyph: '⌗', label: 'Members & keys', onClick: () => membersDialog(forum) },
            forum.isOwner ? { glyph: '+', label: 'Add member', onClick: () => addMemberDialog(forum) } : null,
            forum.isMember || forum.isOwner ? { glyph: '◇', label: 'Re-wrap community key', onClick: () => rewrapDialog(forum) } : null,
          ].filter(Boolean), { x: event.clientX, y: event.clientY });
        });
        items.append(row);
      }
    };
    paint();
    search.addEventListener('input', paint);
    listNode.append(el('div', { class: 'pad-8' }, [search]), items, el('div', { class: 'spacer' }));
  }

  async function openForum(id) {
    activeForumId = id;
    activeThreadId = null;
    State.set('activeForumId', id);
    const split = mainNode?.closest('.split');
    if (split && window.matchMedia('(max-width: 720px)').matches) split.classList.add('show-main');
    renderList();
    await loadThreads(id);
    renderMain();
  }

  async function loadThreads(forumId) {
    const data = await API.get(`/api/forums/${forumId}`);
    State.set('threads', data.threads);
    const forums = State.get('forums').map((forum) => forum.id === forumId ? Object.assign({}, forum, data.forum) : forum);
    State.set('forums', forums);
    return data.threads;
  }

  function currentForum() {
    return State.get('forums').find((forum) => forum.id === activeForumId) || null;
  }

  function renderMain() {
    if (!mainNode) return;
    clear(mainNode);
    const forum = currentForum();
    if (!forum) {
      mainNode.append(UI.empty('◍', 'Pick a community', 'Public communities are readable by every member. Private rooms need an invited key.'));
      return;
    }
    if (activeThreadId) { renderThread(forum); return; }

    const header = el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn icon subtle mobile-hide', text: '‹', onClick: () => mainNode.closest('.split')?.classList.remove('show-main') }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'body-strong', text: forum.name }),
          forum.isPublic ? el('span', { class: 'pill tiny', text: 'public' }) : el('span', { class: 'pill tiny accent', text: 'private' }),
        ]),
        el('div', { class: 'tiny faint', text: `${forum.memberCount} members · created ${UI.dateTime(forum.createdAt)}` }),
      ]),
      el('button', { class: 'btn sm', text: 'Members', onClick: () => membersDialog(forum) }),
      el('button', { class: 'btn sm primary', text: 'New thread', onClick: () => newThreadDialog(forum) }),
    ]);

    const scroll = el('div', { class: 'pane-scroll stack-12' });
    if (forum.description) scroll.append(el('div', { class: 'caption', text: forum.description }));
    const threads = State.get('threads');
    if (!threads.length) {
      scroll.append(UI.empty('✎', 'No threads yet', 'Start the first discussion — posts are encrypted before upload.'));
    }
    for (const thread of threads) scroll.append(threadRow(forum, thread));
    mainNode.append(header, scroll);
  }

  function threadRow(forum, thread) {
    const row = el('div', { class: 'thread-row', onClick: () => { activeThreadId = thread.id; renderMain(); } });
    const author = el('div', { class: 'row', style: { gap: '8px' } });
    const titleNode = el('div', { class: 'body-strong', text: 'Decrypting title…' });
    const bodyNode = el('div', { class: 'post-body muted', text: '' });
    row.append(el('div', { class: 'grow stack-6' }, [
      author, titleNode, bodyNode,
      el('div', { class: 'thread-stats' }, [
        el('span', { text: `▤ ${thread.postCount} replies` }),
        el('span', { text: UI.timeAgo(thread.lastActivityAt) }),
        thread.deleted ? el('span', { class: 'pill danger tiny', text: 'removed' }) : null,
      ]),
    ]), el('button', { class: 'btn icon subtle', text: '⋯', onClick: (event) => { event.stopPropagation(); threadMenu(event, forum, thread); } }));

    (async () => {
      const key = await forumKey(forum);
      if (key) {
        const title = thread.title ? await AE.decryptJson(key, thread.title) : null;
        const body = await AE.decryptJson(key, thread.payload);
        titleNode.textContent = (title && title.text) || 'Untitled thread';
        bodyNode.textContent = (body && body.text) || '';
      } else {
        titleNode.textContent = '▨ Encrypted thread';
        bodyNode.textContent = 'Community key unavailable on this device.';
      }
      const authorUser = threadAuthor(forum, thread.authorId);
      author.append(UI.avatar(authorUser, { size: 'xs' }), el('span', { class: 'small', text: authorUser.publicAlias || authorUser.displayName }), authorUser.verified ? UI.verifiedBadge(authorUser) : null);
    })();
    return row;
  }

  function threadAuthor(forum, authorId) {
    if (authorId === State.user.id) return { id: State.user.id, displayName: State.user.displayName, username: State.user.username, verified: State.user.verified, avatarId: State.user.avatarId };
    return { id: authorId, displayName: 'Member', username: 'member' };
  }

  function threadMenu(event, forum, thread) {
    const isAdmin = State.user.role === 'owner' || State.user.role === 'admin';
    const canDelete = isAdmin || (forum.isPublic && thread.own);
    UI.contextMenu([
      { glyph: '▣', label: 'Open thread', onClick: () => { activeThreadId = thread.id; renderMain(); } },
      canDelete ? { glyph: '⌫', label: 'Delete thread', danger: true, onClick: async () => {
        const confirmed = await UI.confirm({
          title: 'Delete this thread?',
          message: forum.isPublic ? 'Public threads can be deleted by their author or an administrator.' : 'Only administrators can delete threads in private communities.',
          danger: true, confirmLabel: 'Delete',
        });
        if (!confirmed) return;
        await API.del(`/api/threads/${thread.id}`);
        await loadThreads(forum.id);
        renderMain();
      } } : null,
    ].filter(Boolean), { x: event.clientX - 180, y: event.clientY });
  }

  async function renderThread(forum) {
    clear(mainNode);
    const thread = State.get('threads').find((entry) => entry.id === activeThreadId);
    if (!thread) { activeThreadId = null; renderMain(); return; }
    const data = await API.get(`/api/threads/${thread.id}`);
    const key = await forumKey(forum);
    let titleText = 'Untitled';
    let bodyText = '';
    if (key) {
      const title = thread.title ? await AE.decryptJson(key, thread.title) : null;
      const body = await AE.decryptJson(key, thread.payload);
      titleText = (title && title.text) || 'Untitled thread';
      bodyText = (body && body.text) || '';
    }
    const header = el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn icon subtle', text: '‹', title: 'Back to threads', onClick: () => { activeThreadId = null; renderMain(); } }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'body-strong', text: titleText }),
        el('div', { class: 'tiny faint', text: `${forum.name} · ${data.posts.length} replies` }),
      ]),
      el('button', { class: 'btn sm', text: '', title: 'Reload', onClick: () => renderThread(forum) }),
    ]);

    const scroll = el('div', { class: 'pane-scroll stack-12' });
    scroll.append(el('div', { class: 'card stack-8' }, [
      el('div', { class: 'post-body', text: bodyText }),
      thread.attachments && thread.attachments.length ? attachmentStrip(forum, thread) : null,
      el('div', { class: 'row small muted' }, [
        el('span', { text: UI.dateTime(thread.createdAt) }),
        el('div', { class: 'spacer' }),
        el('span', { text: `▲ ${data.thread.karma?.up ?? 0} ▼ ${data.thread.karma?.down ?? 0}` }),
      ]),
    ]));
    for (const post of data.posts) scroll.append(renderPost(forum, thread, post, key));

    const composer = buildThreadComposer(forum, thread);
    const editing = State.featureEnabled('communityPosts') !== false;
    mainNode.append(header, scroll, editing ? composer : el('div', { class: 'composer caption', text: 'Posting in communities is switched off in your settings (Settings → General → Feature switches).' }));
    scroll.scrollTop = scroll.scrollHeight;
  }

  function attachmentStrip(forum, thread) {
    const strip = el('div', { class: 'message-attachments' });
    for (const attachment of thread.attachments) strip.append(communityAttachment(forum, attachment));
    return strip;
  }

  function communityAttachment(forum, attachment) {
    const node = el('div', { class: 'attachment' }, [el('div', { class: 'locked', html: '<span>▨</span><span>Decrypting…</span>' })]);
    (async () => {
      const info = await API.get(`/api/files/${attachment.fileId}`).catch(() => null);
      if (!info?.file) { clear(node).append(el('div', { class: 'locked', text: 'Unavailable' })); return; }
      const file = info.file;
      if (mediaUrls.has(file.id)) { clear(node).append(el('img', { src: mediaUrls.get(file.id), alt: '' })); return; }
      const key = await forumKey(forum);
      const raw = key ? await AE.unwrapKey(key, attachment.keyWrap || file.keyWrap) : null;
      if (!raw) { clear(node).append(el('div', { class: 'locked', text: 'Key unavailable' })); return; }
      const mime = attachment.mime || file.meta?.type || 'image/*';
      const blob = await API.downloadDecrypted(file.id, { chunks: file.chunks, fileKeyRaw: raw, mime });
      const url = URL.createObjectURL(blob);
      State.registerObjectUrl(url);
      mediaUrls.set(file.id, url);
      clear(node).append(el('img', { src: url, alt: '', onClick: () => Viewer.open(url, 'attachment', 'image') }));
    })();
    return node;
  }

  function renderPost(forum, thread, post, key) {
    const wrapper = el('div', { class: 'card stack-6' });
    const authorRow = el('div', { class: 'row', style: { gap: '8px' } });
    const bodyNode = el('div', { class: 'post-body', text: 'Decrypting…' });
    wrapper.append(authorRow, bodyNode);
    (async () => {
      const plain = await decryptPost(forum, post);
      bodyNode.textContent = plain.text || (post.deleted ? 'This post was removed.' : '');
      if (plain.error) bodyNode.classList.add('faint');
      if (plain.attachments && plain.attachments.length) {
        const strip = el('div', { class: 'message-attachments' });
        for (const attachment of plain.attachments) strip.append(communityAttachment(forum, attachment));
        wrapper.append(strip);
      }
    })();

    const author = post.own ? State.user : { id: post.authorId, displayName: 'Member', username: 'member' };
    authorRow.append(
      UI.avatar(author, { size: 'sm', onClick: () => post.authorId && Profile.open(post.authorId) }),
      el('span', { class: 'small body-strong', text: post.own ? State.user.displayName : 'Member' }),
      el('span', { class: 'tiny faint', text: UI.clockTime(post.createdAt, State.settings().timestamps) }),
      post.editedAt ? el('span', { class: 'tiny faint', text: '(edited)' }) : null,
      el('div', { class: 'spacer' }),
      post.karma ? el('span', { class: 'karma-badge', text: `⬆ ${post.karma.up} ⬇ ${post.karma.down}` }) : null,
      el('button', { class: 'btn icon sm subtle', text: '⋯', onClick: (event) => postMenu(event, forum, thread, post) }),
    );

    if (post.replyTo) wrapper.insertBefore(el('div', { class: 'reply-context', text: '↩ replying to an earlier post' }), bodyNode);

    const reactions = el('div', { class: 'reaction-row' });
    for (const [emoji, data] of Object.entries(post.reactions || {})) {
      reactions.append(el('button', {
        class: `react-chip ${data.mine ? 'mine' : ''}`,
        onClick: () => API.post(`/api/messages/${post.id}/reactions`, { emoji }).then(() => refreshThread(forum, thread)),
      }, [el('span', { class: 'emoji', text: emoji }), el('span', { text: String(data.count) })]));
    }
    reactions.append(el('button', { class: 'btn icon sm subtle', text: '', title: 'React', onClick: (event) => reactionPicker(event, post) }));
    wrapper.append(reactions);
    return wrapper;
  }

  function reactionPicker(event, post) {
    const host = el('div', { class: 'row wrap', style: { gap: '4px' } });
    for (const emoji of QUICK_EMOJI) {
      host.append(el('button', { class: 'btn icon', text: emoji, onClick: () => {
        API.post(`/api/messages/${post.id}/reactions`, { emoji });
        ref.close();
      } }));
    }
    const ref = UI.dialog({ title: 'React to this post', glyph: '⌾', size: 'narrow', content: host });
  }

  function postMenu(event, forum, thread, post) {
    const isAdmin = State.user.role === 'owner' || State.user.role === 'admin';
    const canDelete = isAdmin || (forum.isPublic && post.own);
    UI.contextMenu([
      { glyph: '↩', label: 'Reply', onClick: () => {
        const box = UI.$('#thread-composer');
        if (box) { box.dataset.replyTo = post.id; box.focus(); UI.toast({ title: 'Reply target set', duration: 1500 }); }
      } },
      { glyph: '⌾', label: 'Add reaction', onClick: () => reactionPicker(event, post) },
      { glyph: '▲', label: 'Upvote', disabled: post.own, onClick: () => API.post(`/api/messages/${post.id}/vote`, { value: 1 }) },
      { glyph: '▼', label: 'Downvote', disabled: post.own, onClick: () => API.post(`/api/messages/${post.id}/vote`, { value: -1 }) },
      { separator: true },
      { glyph: '⎘', label: 'Copy text', onClick: async () => {
        const plain = await decryptPost(forum, post);
        UI.copy(plain.text || '', 'Post copied');
      } },
      canDelete ? { glyph: '⌫', label: forum.isPublic && !isAdmin ? 'Delete my post' : 'Delete post (operator)', danger: true, onClick: async () => {
        const confirmed = await UI.confirm({
          title: 'Delete this post?',
          message: forum.isPublic ? 'In public communities authors may delete their own posts.' : 'Posts in private communities can only be removed by an administrator.',
          danger: true, confirmLabel: 'Delete',
        });
        if (!confirmed) return;
        await API.del(`/api/messages/${post.id}`);
        renderThread(forum);
      } } : null,
    ].filter(Boolean), { x: event.clientX - 200, y: event.clientY });
  }

  async function refreshThread(forum, thread) {
    await loadThreads(forum.id);
    if (activeThreadId === thread.id) renderThread(forum);
  }

  function buildThreadComposer(forum, thread) {
    const canUpload = State.featureEnabled('uploads') && State.settings().forumMedia;
    const input = el('textarea', { class: 'textarea', id: 'thread-composer', placeholder: 'Write an encrypted reply…', rows: 2 });
    const pending = [];
    const pendingHost = el('div', { class: 'composer-attachments' });
    const fileInput = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
    const attach = el('button', {
      class: 'btn icon', text: '', disabled: !canUpload,
      title: canUpload ? 'Attach media (encrypted)' : 'Enable “Media in communities” in Settings first',
      onClick: () => fileInput.click(),
    });
    fileInput.addEventListener('change', async () => {
      for (const file of [...fileInput.files]) {
        const limit = State.user.limits.dmUploadBytes;
        if (limit !== -1 && file.size > limit) {
          UI.toast({ level: 'danger', title: 'Too large', body: `${file.name} exceeds your ${UI.bytes(limit)} community allowance.` });
          continue;
        }
        const row = el('div', { class: 'upload-row' }, [el('div', { class: 'name' }, [el('span', { text: CommunityClient.iconFor(file.type) }), el('span', { class: 'grow truncate', text: file.name }), el('span', { class: 'tiny faint', text: '0%' })]), el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill' })])]);
        pendingHost.append(row);
        try {
          const result = await API.uploadEncrypted({
            kind: 'forum', blob: file, meta: { type: file.type },
            wrapFileKey: async (raw) => {
              const key = await forumKey(forum);
              if (!key) throw new Error('Community key unavailable.');
              return AE.wrapKey(key, raw);
            },
            onProgress: ({ percent }) => { row.querySelector('.bar-fill').style.width = `${percent}%`; row.querySelector('.tiny').textContent = `${percent}%`; },
          });
          pending.push({ fileId: result.fileId, name: file.name, mime: file.type, size: file.size, type: file.type.startsWith('image/') ? 'image' : 'file' });
          row.remove();
          paintPending();
        } catch (error) {
          row.remove();
          UI.toast({ level: 'danger', title: 'Upload failed', body: error.message });
        }
      }
      fileInput.value = '';
    });
    function paintPending() {
      clear(pendingHost);
      for (const entry of pending) {
        pendingHost.append(el('span', { class: 'chip-file' }, [el('span', { text: CommunityClient.iconFor(entry.mime) }), el('span', { class: 'truncate', style: { maxWidth: '160px' }, text: entry.name }), el('button', { class: 'btn icon sm subtle', text: '✕', onClick: () => { pending.splice(pending.indexOf(entry), 1); paintPending(); } })]));
      }
    }
    const send = el('button', { class: 'btn primary', text: 'Reply', onClick: async () => {
      const text = input.value.trim();
      if (!text && !pending.length) return;
      const key = await forumKey(forum);
      if (!key) { UI.toast({ level: 'danger', title: 'Community key unavailable' }); return; }
      const payload = await AE.encryptJson(key, { text, attachments: pending });
      await API.post(`/api/threads/${thread.id}/posts`, {
        payload,
        attachments: pending.map((entry) => ({ fileId: entry.fileId, type: entry.type, mime: entry.mime, name: entry.name })),
        replyTo: input.dataset.replyTo || null,
      });
      input.value = '';
      delete input.dataset.replyTo;
      pending.length = 0;
      paintPending();
      renderThread(forum);
    } });
    return el('div', { class: 'composer' }, [pendingHost, el('div', { class: 'composer-row' }, [attach, fileInput, input, send])]);
  }

  async function newThreadDialog(forum) {
    const title = el('input', { class: 'input', placeholder: 'Thread title' });
    const bodyInput = el('textarea', { class: 'textarea', placeholder: 'Write the opening post…' });
    const status = el('div', { class: 'hint' });
    let ref;
    ref = UI.dialog({
      title: `New thread in ${forum.name}`,
      glyph: '✎',
      content: el('div', { class: 'stack-12' }, [
        title, bodyInput, status,
        el('div', { class: 'notice-strip', html: '<span>▨</span><span>Titles and posts are encrypted on this device. Media requires “Media in communities” to be enabled in Settings.</span>' }),
      ]),
      footer: [
        el('button', { class: 'btn', text: 'Cancel', onClick: () => ref.close() }),
        el('button', { class: 'btn primary', text: 'Publish', onClick: async () => {
          if (!title.value.trim() && !bodyInput.value.trim()) { status.textContent = 'Add a title or a first post.'; return; }
          const key = await forumKey(forum);
          if (!key) { UI.toast({ level: 'danger', title: 'Community key unavailable' }); return; }
          const payload = await AE.encryptJson(key, { text: bodyInput.value.trim(), attachments: [] });
          const titlePayload = await AE.encryptJson(key, { text: title.value.trim() });
          await API.post(`/api/forums/${forum.id}/threads`, { payload, titlePayload });
          ref.close();
          await loadThreads(forum.id);
          renderMain();
        } }),
      ],
    });
  }

  async function createDialog() {
    const name = el('input', { class: 'input', placeholder: 'Community name' });
    const description = el('input', { class: 'input', placeholder: 'Short description (optional)' });
    const visibility = el('div', { class: 'segmented' }, [
      el('button', { class: 'on', text: 'Public', dataset: { value: 'public' } }),
      el('button', { text: 'Private', dataset: { value: 'private' } }),
    ]);
    let isPublic = true;
    [...visibility.children].forEach((button) => button.addEventListener('click', () => {
      [...visibility.children].forEach((other) => other.classList.remove('on'));
      button.classList.add('on');
      isPublic = button.dataset.value === 'public';
    }));
    let ref;
    ref = UI.dialog({
      title: 'Create a community',
      glyph: '✦',
      subtitle: 'Public squares are readable by every signed-in member; private rooms stay key-gated.',
      content: el('div', { class: 'stack-12' }, [
        name, description,
        el('div', { class: 'field' }, [el('label', { text: 'Visibility' }), visibility]),
        el('div', { class: 'notice-strip', html: '<span>◍</span><span>Public: anyone signed in can read and reply. Private: only members with a wrapped key can read.</span>' }),
      ]),
      footer: [
        el('button', { class: 'btn', text: 'Cancel', onClick: () => ref.close() }),
        el('button', { class: 'btn primary', text: 'Create', onClick: async () => {
          if (name.value.trim().length < 3) { UI.toast({ level: 'warning', title: 'Give the community a name' }); return; }
          const forumId = `f_${AE.b64encode(AE.randomBytes(12)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}`;
          let keyWraps = {};
          if (!isPublic) {
            const rawKey = await AE.generateAesRaw();
            keyWraps[State.user.id] = await State.wrapChannelKey('forum', forumId, rawKey, State.vault.identityPublic);
          }
          const created = await API.post('/api/forums', { id: forumId, name: name.value.trim(), description: description.value.trim(), isPublic, keyWraps });
          ref.close();
          await refresh();
          openForum(created.forum.id);
        } }),
      ],
    });
  }

  async function membersDialog(forum) {
    const data = await API.get(`/api/forums/${forum.id}`);
    const current = data.forum;
    const body = el('div', { class: 'stack-6' });
    for (const member of current.members) {
      body.append(el('div', { class: 'list-item' }, [
        UI.avatar(member, { size: 'sm' }),
        el('div', { class: 'meta' }, [el('div', { class: 'name', text: member.publicAlias || member.displayName }), el('div', { class: 'sub', text: `@${member.username}` })]),
        member.verified ? UI.verifiedBadge(member) : null,
      ]));
    }
    UI.dialog({
      title: `${current.name} — members`,
      glyph: '⌗',
      subtitle: `${current.memberCount} members${current.isOwner ? ' · you own this community' : ''}`,
      content: el('div', { class: 'stack-8' }, [
        body,
        current.isPublic ? el('div', { class: 'notice-strip', html: '<span>◍</span><span>Public community: no key wrapping needed, anyone signed in can read.</span>' }) : el('div', { class: 'notice-strip', html: '<span>🔑</span><span>Private community: keys are wrapped per member with ECDH.</span>' }),
        current.isOwner && !current.isPublic ? el('button', { class: 'btn sm primary', text: 'Add member', onClick: () => addMemberDialog(current) }) : null,
      ]),
    });
  }

  async function addMemberDialog(forum) {
    const directory = await API.get('/api/directory');
    const search = el('input', { class: 'input', placeholder: 'Search members…' });
    const results = el('div', { class: 'stack-4', style: { maxHeight: '300px', overflowY: 'auto' } });
    const paint = () => {
      clear(results);
      const query = search.value.trim().toLowerCase();
      for (const user of directory.users.filter((candidate) => !forum.members?.some((member) => member.id === candidate.id)).filter((candidate) => !query || candidate.username.includes(query) || (candidate.displayName || '').toLowerCase().includes(query)).slice(0, 40)) {
        results.append(el('div', { class: 'list-item', onClick: async () => {
          let keyWraps = {};
          if (!forum.isPublic) {
            const raw = await State.channelKeyRaw('forum', forum);
            if (!raw) { UI.toast({ level: 'warning', title: 'Community key unavailable' }); return; }
            keyWraps[user.id] = await State.wrapChannelKey('forum', forum.id, raw, user.identityPublic);
          }
          await API.post(`/api/forums/${forum.id}/members`, { memberIds: [user.id], keyWraps });
          UI.toast({ level: 'success', title: `${user.displayName} added` });
          await refresh();
          ref.close();
          membersDialog(await API.get(`/api/forums/${forum.id}`).then((data) => data.forum));
        } }, [
          UI.avatar(user, { size: 'sm' }),
          el('div', { class: 'meta' }, [el('div', { class: 'name', text: user.displayName }), el('div', { class: 'sub', text: `@${user.username}` })]),
          el('span', { class: 'btn sm', text: 'Add' }),
        ]));
      }
    };
    paint();
    search.addEventListener('input', paint);
    const ref = UI.dialog({ title: `Add members to ${forum.name}`, glyph: '+', content: el('div', { class: 'stack-8' }, [search, results]) });
  }

  async function rewrapDialog(forum) {
    const confirmed = await UI.confirm({
      title: 'Re-wrap the community key?',
      message: 'Useful when a member was added before the key existed, or when a key wrap is missing. Every member gets a fresh copy of the same key.',
      confirmLabel: 'Re-wrap now',
    });
    if (!confirmed) return;
    const raw = await State.channelKeyRaw('forum', forum);
    if (!raw) { UI.toast({ level: 'warning', title: 'The community key is not available on this device' }); return; }
    const wrappers = {};
    for (const member of forum.members || []) {
      if (member.id === State.user.id) continue;
      if (!member.identityPublic) continue;
      wrappers[member.id] = await State.wrapChannelKey('forum', forum.id, raw, member.identityPublic);
    }
    await API.post(`/api/forums/${forum.id}/members`, { keyWraps: wrappers });
    UI.toast({ level: 'success', title: 'Community keys refreshed', body: `${Object.keys(wrappers).length} members re-wrapped.` });
  }

  API.on('forum.changed', () => { refresh().catch(() => {}); });

  function iconFor(mime = '') {
    if (mime.startsWith('image/')) return '▣';
    if (mime.startsWith('video/')) return '▤';
    return '⌸';
  }

  return { refresh, render, open: openForum, forumKey, iconFor };
})();

window.CommunityClient = CommunityClient;

Apps.register({
  id: 'communities', title: 'Communities', glyph: '▩', order: 12,
  description: 'Public squares and private community forums with threads, posts and votes.',
  keywords: ['communities', 'community', 'forum', 'forums', 'thread', 'post', 'square', 'private'],
  run: () => Windows.open({
    id: 'communities', title: 'Communities', glyph: '▩', geometry: { w: 1120, h: 720 },
    render: (body, api) => CommunityClient.render(body, api),
    toolbar: [],
  }),
});

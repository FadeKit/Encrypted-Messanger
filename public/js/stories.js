/* ============================================================================
   AE Secure — public square: stories, ephemeral media and public profiles
   All public content is sealed with a per-account audience key so the server
   still stores ciphertext; the key is published only while the public profile
   switch is on.
   ========================================================================== */

const StoriesClient = (() => {
  const { el, clear } = UI;
  const publicUrls = new Map();
  let timer = null;

  function audienceKeyFor(user) {
    if (!user || !user.audienceKey) return null;
    return AE.audienceKey(user.audienceKey, `public:${user.id}`);
  }

  async function refresh() {
    const [stories, feed] = await Promise.all([
      API.get('/api/stories').catch(() => ({ stories: [] })),
      API.get('/api/public/feed').catch(() => ({ posts: [], people: [] })),
    ]);
    State.set('stories', stories.stories);
    State.set('publicFeed', { posts: feed.posts, people: feed.people });
    return { stories, feed };
  }

  function render(body, api) {
    clear(body);
    const pane = el('div', { class: 'pane' });
    const strip = el('div', { class: 'story-strip' });
    const scroll = el('div', { class: 'pane-scroll stack-16' });
    const header = el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'body-strong', text: 'Public square' }),
        el('div', { class: 'tiny faint', text: State.user.publicProfile.enabled ? `Posting as ${State.user.publicProfile.alias || State.user.displayName}` : 'Your public profile is off — turn it on in Settings → Public profile.' }),
      ]),
      State.user.publicProfile.enabled ? el('button', { class: 'btn sm', text: 'Edit profile', onClick: () => profileEditor() }) : el('button', { class: 'btn sm primary', text: '✨ Turn on public profile', onClick: () => profileEditor() }),
      el('button', { class: 'btn sm', text: 'Refresh', onClick: () => refresh().then(paint) }),
    ]);
    pane.append(header, strip, scroll);
    body.append(pane);
    api.setToolbar([]);
    paint();
    if (timer) clearInterval(timer);
    timer = setInterval(() => { if (Windows.get('stories')) refresh().then(paint).catch(() => {}); }, 120000);
  }

  async function paint() {
    const strip = UI.$('.story-strip');
    const scroll = UI.$('.pane-scroll.stack-16');
    if (!strip || !scroll) return;
    clear(strip);
    clear(scroll);
    const stories = State.get('stories');
    const feed = State.get('publicFeed');

    strip.append(el('div', { class: 'story-bubble', onClick: () => storyComposer() }, [
      el('div', { class: 'story-ring', style: { background: 'var(--line-strong)' } }, [el('div', { class: 'avatar lg', text: '+' })]),
      el('div', { class: 'tiny', text: 'Add story' }),
    ]));
    for (const story of stories) {
      if (story.author.id === State.user.id) continue;
      strip.append(el('div', { class: 'story-bubble', onClick: () => viewer(story.author.id) }, [
        el('div', { class: `story-ring ${story.seen ? 'seen' : ''}` }, [UI.avatar(story.author, { size: 'lg' })]),
        el('div', { class: 'tiny truncate', style: { maxWidth: '70px' }, text: story.author.publicAlias || story.author.displayName }),
      ]));
    }

    // public post composer
    if (State.user.publicProfile.enabled) {
      const input = el('textarea', { class: 'textarea', placeholder: 'Say something to the public square…', rows: 2 });
      const attach = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
      const pending = [];
      const pendingHost = el('div', { class: 'composer-attachments' });
      const mediaAllowed = State.settings().forumMedia;
      attach.addEventListener('change', async () => {
        for (const file of [...attach.files]) {
          const limit = State.user.limits.dmUploadBytes;
          if (limit !== -1 && file.size > limit) { UI.toast({ level: 'danger', title: 'Too large for your allowance' }); continue; }
          const key = await audienceKeyFor({ id: State.user.id, audienceKey: State.user.publicProfile.audienceKey });
          const result = await API.uploadEncrypted({ kind: 'public', blob: file, meta: { type: file.type }, wrapFileKey: (raw) => AE.wrapKey(key, raw) });
          pending.push({ fileId: result.fileId, name: file.name, mime: file.type, size: file.size, type: 'image' });
          clear(pendingHost);
          for (const entry of pending) pendingHost.append(el('span', { class: 'chip-file' }, [el('span', { text: '' }), el('span', { class: 'truncate', text: entry.name })]));
        }
        attach.value = '';
      });
      scroll.append(el('div', { class: 'card stack-8' }, [
        input, pendingHost,
        el('div', { class: 'row' }, [
          el('button', { class: 'btn sm', text: 'Attach image', disabled: !mediaAllowed, title: mediaAllowed ? 'Seal and attach an image' : 'Enable “Media in communities and public posts” in Settings', onClick: () => attach.click() }),
          attach,
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn sm primary', text: 'Post', onClick: async () => {
            if (!input.value.trim() && !pending.length) return;
            const key = await audienceKeyFor({ id: State.user.id, audienceKey: State.user.publicProfile.audienceKey });
            const payload = await AE.encryptJson(key, { text: input.value.trim(), attachments: pending });
            await API.post('/api/public/posts', { payload, attachments: pending.map((entry) => ({ fileId: entry.fileId, type: entry.type, mime: entry.mime, name: entry.name })) });
            input.value = '';
            pending.length = 0;
            clear(pendingHost);
            refresh().then(paint);
          } }),
        ]),
        el('div', { class: 'hint', text: mediaAllowed ? 'Public posts are sealed with your audience key — readable by signed-in members, not by the server.' : 'Text-only: turn on “Media in communities and public posts” in Settings to attach images.' }),
      ]));
    } else {
      scroll.append(el('div', { class: 'notice-strip', html: '<span>◍</span><span>Your public profile is off. Your alias, bio, photos, stories and public posts stay hidden from other members until you switch it back on.</span>' }));
    }

    // stories row (mine first)
    const mine = stories.filter((story) => story.author.id === State.user.id);
    if (mine.length) {
      scroll.append(el('div', { class: 'stack-6' }, [
        el('div', { class: 'uppercase', text: 'My stories' }),
        el('div', { class: 'row wrap' }, mine.map((story) => el('div', { class: 'drive-cell', style: { width: '150px' }, onClick: () => viewStory(mine, 0) }, [
          el('div', { class: 'thumb', text: story.kind === 'video' ? '▤' : '▣' }),
          el('div', { class: 'tiny', text: `expires ${UI.timeAgo(story.expiresAt).replace(' ago', '')}` }),
          el('div', { class: 'tiny faint', text: `${story.views} views` }),
        ]))),
      ]));
    }

    // public feed
    const postsHost = el('div', { class: 'stack-12' });
    scroll.append(el('div', { class: 'uppercase', text: `Public posts (${feed.posts.length})` }), postsHost);
    if (!feed.posts.length) postsHost.append(UI.empty('◍', 'The public square is quiet', 'Posts from public accounts appear here for everyone.'));
    for (const post of feed.posts) {
      const card = el('div', { class: 'card stack-8' });
      card.append(el('div', { class: 'row' }, [
        UI.avatar(post.author, { size: 'sm', onClick: () => Profile.open(post.author.id) }),
        el('div', {}, [
          el('div', { class: 'row', style: { gap: '6px' } }, [
            el('span', { class: 'small body-strong', text: post.author.publicAlias || post.author.displayName }),
            post.author.verified ? UI.verifiedBadge(post.author) : null,
          ]),
          el('div', { class: 'tiny faint', text: `@${post.author.username} · ${UI.timeAgo(post.createdAt)}` }),
        ]),
        el('div', { class: 'spacer' }),
        (post.own || State.user.role !== 'member') ? el('button', { class: 'btn icon sm subtle', text: '⋯', onClick: (event) => postMenu(event, post) }) : null,
      ]));
      const text = el('div', { class: 'post-body', text: 'Decrypting…' });
      card.append(text);
      const media = el('div', { class: 'message-attachments' });
      card.append(media);
      const reactions = el('div', { class: 'reaction-row' });
      for (const [emoji, data] of Object.entries(post.reactions || {})) {
        reactions.append(el('button', { class: `react-chip ${data.mine ? 'mine' : ''}`, onClick: () => API.post(`/api/public/posts/${post.id}/reactions`, { emoji }).then(() => refresh().then(paint)) }, [
          el('span', { class: 'emoji', text: emoji }), el('span', { text: String(data.count) }),
        ]));
      }
      reactions.append(el('button', { class: 'btn icon sm subtle', text: '', onClick: () => {
        const quick = ['👍', '❤', '🔥', '😂', '👏'];
        UI.contextMenu(quick.map((emoji) => ({ glyph: emoji, label: `React ${emoji}`, onClick: () => API.post(`/api/public/posts/${post.id}/reactions`, { emoji }).then(() => refresh().then(paint)) })), { x: window.innerWidth / 2, y: window.innerHeight / 2 });
      } }));
      card.append(reactions);
      (async () => {
        const key = await audienceKeyFor(post.author);
        if (!key) return;
        const plain = await AE.decryptJson(key, post.payload);
        text.textContent = (plain && plain.text) || '';
        for (const attachment of (plain && plain.attachments) || []) {
          const node = el('div', { class: 'attachment' }, [el('div', { class: 'locked', html: '<span>▨</span><span>Decrypting image…</span>' })]);
          media.append(node);
          const info = await API.get(`/api/files/${attachment.fileId}`).catch(() => null);
          if (!info?.file) continue;
          if (publicUrls.has(info.file.id)) { clear(node).append(el('img', { src: publicUrls.get(info.file.id), alt: '' })); continue; }
          const raw = await AE.unwrapKey(key, attachment.keyWrap || info.file.keyWrap);
          if (!raw) continue;
          const blob = await API.downloadDecrypted(info.file.id, { chunks: info.file.chunks, fileKeyRaw: raw, mime: attachment.mime || 'image/*' });
          const url = URL.createObjectURL(blob);
          State.registerPublicUrl?.(url);
          publicUrls.set(info.file.id, url);
          clear(node).append(el('img', { src: url, alt: '', onClick: () => Viewer.open(url, attachment.name || 'image') }));
        }
      })();
      postsHost.append(card);
    }

    function postMenu(event, post) {
      UI.contextMenu([
        { glyph: '⧉', label: 'Copy author handle', onClick: () => UI.copy(`@${post.author.username}`, 'Handle copied') },
        { glyph: '⌫', label: 'Delete post', danger: true, onClick: async () => {
          if (!await UI.confirm({ title: 'Delete this public post?', danger: true, confirmLabel: 'Delete' })) return;
          await API.del(`/api/public/posts/${post.id}`);
          refresh().then(paint);
        } },
      ], { x: event.clientX - 160, y: event.clientY });
    }
  }

  // -------------------------------------------------------------- composer
  async function storyComposer() {
    if (!State.user.publicProfile.enabled) {
      const enable = await UI.confirm({
        title: 'Stories need a public profile',
        message: 'Stories live on your public profile and expire after 24 hours. Turn the profile on now?',
        confirmLabel: 'Turn on and continue',
      });
      if (!enable) return;
      await profileEditor({ enable: true, then: () => storyComposer() });
      return;
    }
    const input = el('input', { type: 'file', accept: 'image/*,video/*' });
    const caption = el('input', { class: 'input', placeholder: 'Caption (optional)' });
    const status = el('div', { class: 'hint', text: 'Images or video up to 1 GB. Stories disappear after 24 hours.' });
    const bar = el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill' })]);
    let ref;
    ref = UI.dialog({
      title: 'Post a story',
      glyph: '◉',
      subtitle: 'Sealed with your public audience key, visible to signed-in members for 24 hours.',
      content: el('div', { class: 'stack-12' }, [input, caption, status, bar]),
      footer: [
        el('button', { class: 'btn', text: 'Cancel', onClick: () => ref.close() }),
        el('button', { class: 'btn primary', text: 'Publish story', onClick: async () => {
          const file = input.files[0];
          if (!file) { status.textContent = 'Pick an image or video first.'; return; }
          if (file.size > State.user.limits.storyQuotaBytes && State.user.limits.storyQuotaBytes !== -1) {
            status.textContent = `Story items are limited to ${UI.bytes(State.user.limits.storyQuotaBytes)} on your account. Request a bigger allowance in Settings.`;
            return;
          }
          status.textContent = 'Sealing and uploading…';
          try {
            const key = await audienceKeyFor({ id: State.user.id, audienceKey: State.user.publicProfile.audienceKey });
            const result = await API.uploadEncrypted({
              kind: 'story', blob: file, meta: { type: file.type },
              wrapFileKey: (raw) => AE.wrapKey(key, raw),
              onProgress: ({ percent }) => { bar.firstChild.style.width = `${percent}%`; status.textContent = `Encrypting and uploading… ${percent}%`; },
            });
            const payload = await AE.encryptJson(key, { text: caption.value.trim(), attachments: [{ fileId: result.fileId }] });
            await API.post('/api/stories', { kind: file.type.startsWith('video/') ? 'video' : 'image', fileId: result.fileId, payload, caption: caption.value.trim() });
            ref.close();
            UI.toast({ level: 'success', title: 'Story published', body: 'It expires in 24 hours.' });
            refresh().then(paint);
          } catch (error) {
            status.textContent = error.message;
          }
        } }),
      ],
    });
  }

  async function viewer(authorId) {
    const stories = State.get('stories').filter((story) => story.author.id === authorId);
    if (stories.length) viewStory(stories, 0);
  }

  function viewStory(stories, index) {
    if (index >= stories.length) return;
    const story = stories[index];
    const frame = el('div', { class: 'frame' });
    const overlay = el('div', { class: 'story-viewer' });
    const progress = el('div', { class: 'story-progress' }, stories.map((_, i) => el('i', { class: i < index ? 'done' : i === index ? 'active' : '' })));
    const header = el('div', { class: 'story-header' }, [
      UI.avatar(story.author, { size: 'sm' }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'small body-strong', text: story.author.publicAlias || story.author.displayName }),
        el('div', { class: 'tiny', text: UI.timeAgo(story.createdAt) }),
      ]),
      el('button', { class: 'btn icon subtle', text: '✕', onClick: () => overlay.remove() }),
    ]);
    const footer = el('div', { class: 'story-footer' });
    for (const emoji of ['❤', '🔥', '👏', '😮']) {
      footer.append(el('button', { class: 'react-chip', text: emoji, onClick: () => API.post(`/api/stories/${story.id}/reactions`, { emoji }) }));
    }
    footer.append(el('div', { class: 'spacer' }));
    footer.append(el('button', { class: 'btn sm', text: 'Next', onClick: () => { overlay.remove(); viewStory(stories, index + 1); } }));
    if (story.own) footer.append(el('button', { class: 'btn sm danger', text: 'Delete', onClick: async () => {
      if (!await UI.confirm({ title: 'Delete this story?', danger: true, confirmLabel: 'Delete' })) return;
      await API.del(`/api/stories/${story.id}`);
      overlay.remove();
      refresh().then(paint);
    } }));
    frame.append(progress, header, footer);
    const media = el('div', { class: 'stack-8', style: { position: 'absolute', inset: '88px 12px 74px', display: 'grid', placeItems: 'center' } });
    media.append(el('div', { class: 'caption', text: 'Decrypting story…' }));
    frame.append(media);
    overlay.append(frame);
    document.body.append(overlay);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });

    API.post(`/api/stories/${story.id}/seen`, {}).catch(() => {});
    (async () => {
      const key = await audienceKeyFor(story.author);
      const info = await API.get(`/api/files/${story.fileId}`).catch(() => null);
      if (!key || !info?.file) { clear(media).append(el('div', { class: 'caption', text: 'Story unavailable' })); return; }
      const raw = await AE.unwrapKey(key, info.file.keyWrap);
      if (!raw) { clear(media).append(el('div', { class: 'caption', text: 'Key unavailable' })); return; }
      const mime = info.file.meta?.type || (story.kind === 'video' ? 'video/mp4' : 'image/jpeg');
      const blob = await API.downloadDecrypted(info.file.id, { chunks: info.file.chunks, fileKeyRaw: raw, mime });
      const url = URL.createObjectURL(blob);
      State.registerObjectUrl(url);
      clear(media).append(story.kind === 'video'
        ? el('video', { src: url, controls: true, autoplay: !!State.settings().storyAutoplay, style: { width: '100%', height: '100%' } })
        : el('img', { src: url, alt: '' }));
    })();
  }

  // -------------------------------------------------------- profile editor
  async function profileEditor(options = {}) {
    const profile = State.user.publicProfile;
    const enabled = el('input', { type: 'checkbox' });
    enabled.checked = profile.enabled || !!options.enable;
    const alias = el('input', { class: 'input', placeholder: 'Public alias', value: profile.alias || '' });
    const bio = el('textarea', { class: 'textarea', placeholder: 'Public bio', value: profile.bio || '' });
    const photosHost = el('div', { class: 'profile-photos' });
    const gallery = [...(profile.images || [])];
    const status = el('div', { class: 'hint' });

    async function ensureAudienceKey() {
      if (profile.audienceKey) return profile.audienceKey;
      const seed = AE.b64encode(AE.randomBytes(32));
      profile.audienceKey = seed;
      return seed;
    }

    async function paintPhotos() {
      clear(photosHost);
      if (!gallery.length) { photosHost.append(el('div', { class: 'caption', text: 'No permanent profile photos yet.' })); return; }
      const seed = await ensureAudienceKey();
      const key = await AE.audienceKey(seed, `public:${State.user.id}`);
      for (const fileId of gallery) {
        const cell = el('div', { class: 'photo' }, [el('div', { class: 'caption', text: '' })]);
        const info = await API.get(`/api/files/${fileId}`).catch(() => null);
        if (info?.file) {
          const raw = await AE.unwrapKey(key, info.file.keyWrap);
          if (raw) {
            const blob = await API.downloadDecrypted(info.file.id, { chunks: info.file.chunks, fileKeyRaw: raw, mime: info.file.meta?.type || 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            clear(cell).append(el('img', { src: url, alt: '' }));
          }
        }
        cell.append(el('button', { class: 'btn icon sm danger remove', text: '✕', onClick: () => { gallery.splice(gallery.indexOf(fileId), 1); paintPhotos(); } }));
        photosHost.append(cell);
      }
    }
    paintPhotos();

    const upload = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    upload.addEventListener('change', async () => {
      const file = upload.files[0];
      upload.value = '';
      if (!file) return;
      if (gallery.length >= 8) { status.textContent = 'Up to 8 permanent photos.'; return; }
      const limit = State.user.limits.dmUploadBytes;
      if (limit !== -1 && file.size > limit) { status.textContent = `Photos are limited to ${UI.bytes(limit)} with your current allowance.`; return; }
      status.textContent = 'Sealing photo…';
      const seed = await ensureAudienceKey();
      const key = await AE.audienceKey(seed, `public:${State.user.id}`);
      const result = await API.uploadEncrypted({ kind: 'avatar', blob: file, meta: { type: file.type }, wrapFileKey: (raw) => AE.wrapKey(key, raw) });
      gallery.push(result.fileId);
      status.textContent = 'Photo added — save to publish.';
      paintPhotos();
    });

    let ref;
    ref = UI.dialog({
      title: 'Public profile',
      glyph: '◍',
      size: 'wide',
      subtitle: 'Off by default. While it is on, your alias, bio, photos, stories and public posts are visible to signed-in members.',
      content: el('div', { class: 'stack-12' }, [
        el('label', { class: 'row' }, [enabled, el('span', { text: 'Publish my public profile' })]),
        el('div', { class: 'grid-2' }, [
          el('div', { class: 'field' }, [el('label', { text: 'Public alias' }), alias, el('div', { class: 'hint', text: 'Shown before your coded handle in the public square.' })]),
          el('div', { class: 'field' }, [el('label', { text: 'Bio' }), bio]),
        ]),
        el('div', { class: 'field' }, [el('label', { text: 'Permanent photos (up to 8)' }), photosHost, el('button', { class: 'btn sm', text: 'Add photo', onClick: () => upload.click() }), upload]),
        status,
        el('div', { class: 'notice-strip', html: '<span>24h</span><span>Stories expire automatically. Photos stay until you remove them or switch the profile off.</span>' }),
      ]),
      footer: [
        el('button', { class: 'btn', text: 'Cancel', onClick: () => ref.close() }),
        el('button', { class: 'btn primary', text: 'Save public profile', onClick: async () => {
          const seed = enabled.checked ? await ensureAudienceKey() : profile.audienceKey;
          const result = await API.patch('/api/public-profile', {
            enabled: enabled.checked,
            alias: alias.value.trim(),
            bio: bio.value.trim(),
            images: gallery,
            audienceKey: seed,
          });
          State.user.publicProfile = result.publicProfile;
          State.emit('user', State.user);
          State.emit('settings', State.settings());
          ref.close();
          UI.toast({ level: 'success', title: enabled.checked ? 'Public profile is live' : 'Public profile hidden', body: enabled.checked ? 'Stories and posts are visible to members again.' : 'Your content is hidden until you switch it back on.' });
          if (options.then) options.then();
          refresh().then(paint);
        } }),
      ],
    });
  }

  return { refresh, render, profileEditor };
})();

window.StoriesClient = StoriesClient;

Apps.register({
  id: 'stories', title: 'Public', glyph: '◉', order: 30, featureFlag: 'stories',
  description: 'Stories that expire in 24 hours, public posts and profile publishing.',
  keywords: ['stories', 'public', 'profile', 'alias', 'bio', 'square', 'talk'],
  run: () => Windows.open({
    id: 'stories', title: 'Public square', glyph: '◉', geometry: { w: 900, h: 700 },
    render: (body, api) => StoriesClient.render(body, api),
  }),
});

Apps.register({
  id: 'profile', title: 'My profile', glyph: '◧', order: 46,
  description: 'Display name, avatar, bio and public profile controls.',
  keywords: ['profile', 'avatar', 'bio', 'display name'],
  run: () => Windows.open({
    id: 'profile', title: 'My profile', glyph: '◧', geometry: { w: 620, h: 620 },
    render: (body, api) => {
      const { el, clear } = UI;
      clear(body);
      const pane = el('div', { class: 'pane-scroll stack-12' });
      const avatarHost = el('div', { class: 'row' }, [UI.avatar(State.user, { size: 'xl', showStatus: true })]);
      const fileInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        if (!State.featureEnabled('avatar')) { UI.toast({ level: 'info', title: 'Profile pictures are switched off in your settings' }); return; }
        const result = await API.uploadEncrypted({ kind: 'avatar', blob: file, meta: { type: file.type }, wrapFileKey: (raw) => AE.wrapKey(State.masterKey(), raw) });
        const updated = await API.patch('/api/profile', { avatarId: result.fileId });
        State.set('user', updated.user);
        UI.toast({ level: 'success', title: 'Profile picture updated' });
        AppShellRefresh();
      });
      const display = el('input', { class: 'input', value: State.user.displayName || '' });
      const bio = el('textarea', { class: 'textarea', placeholder: 'About you (private unless your public profile is on)', value: State.user.bio || '' });
      pane.append(
        el('div', { class: 'card stack-12' }, [
          avatarHost,
          el('div', { class: 'row' }, [
            el('button', { class: 'btn sm', text: 'Change picture', onClick: () => fileInput.click() }),
            fileInput,
            el('button', { class: 'btn sm', text: 'Remove', onClick: async () => { await API.patch('/api/profile', { avatarId: null }); State.user.avatarId = null; AppShellRefresh(); } }),
          ]),
          el('div', { class: 'hint', text: 'Pictures are sealed with your master key; other members receive them through the server as ciphertext only.' }),
        ]),
        el('div', { class: 'field' }, [el('label', { text: 'Display name' }), display]),
        el('div', { class: 'field' }, [el('label', { text: 'Bio (private)' }), bio]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn primary', text: 'Save profile', onClick: async () => {
            const updated = await API.patch('/api/profile', { displayName: display.value.trim(), bio: bio.value.trim() });
            State.set('user', updated.user);
            UI.toast({ level: 'success', title: 'Profile saved' });
            AppShellRefresh();
          } }),
          el('button', { class: 'btn', text: 'Public profile settings', onClick: () => StoriesClient.profileEditor() }),
        ]),
        el('div', { class: 'card stack-6' }, [
          el('div', { class: 'uppercase', text: 'Identity' }),
          el('div', { class: 'small muted', text: `Handle @${State.user.username}` }),
          el('div', { class: 'small muted mono', text: `Key fingerprint ${AE.fingerprint(State.user.identityPublic)}` }),
          el('div', { class: 'small muted', text: `Role: ${State.user.role} · Joined ${UI.dateTime(State.user.createdAt)}` }),
        ]),
      );
      body.append(pane);
      api.setToolbar([]);
    },
  }),
});

function AppShellRefresh() {
  const user = State.user;
  State.emit('user', user);
  const start = UI.$('#start-menu');
  if (start) { start.remove(); Shell.buildStartMenu?.(); }
}

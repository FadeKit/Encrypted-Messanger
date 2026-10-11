/* ============================================================================
   AE Secure — administrator console
   Live neural network of platform activity, moderation, quotas and telemetry.
   ========================================================================== */

const AdminClient = (() => {
  const { el, clear } = UI;
  let section = 'overview';
  let hostNode = null;
  let refreshTimer = null;
  const graph = {
    canvas: null, ctx: null, nodes: [], edges: [], scale: 1, offsetX: 0, offsetY: 0,
    dragging: false, lastX: 0, lastY: 0, pulses: [], running: true, selected: null,
    data: null, hover: null, pin: null, lastEventAt: Date.now(),
  };

  // The graph is drawn in the interface's own ink: it reads the live theme
  // tokens instead of carrying a neon palette of its own, so a monochrome or
  // paper theme renders a monochrome or ink-on-paper graph. Kinds differ by
  // mark (square, diamond, ring) as much as by shade, which keeps them
  // distinguishable when the interface is greyscale.
  const KIND_STYLE = {
    user: { token: '--ink', mark: 'square', label: 'member' },
    dm: { token: '--ink', mark: 'round', label: 'direct channel' },
    group: { token: '--ink-muted', mark: 'ring', label: 'group chat' },
    forum: { token: '--ink-soft', mark: 'square', label: 'community' },
    story: { token: '--warning', mark: 'diamond', label: 'story' },
    airdrop: { token: '--info', mark: 'diamond', label: 'airdrop' },
  };
  const FALLBACK_STYLE = { token: '--ink-muted', mark: 'square', label: 'node' };
  const paletteCache = { key: '', value: null };

  function token(name, fallback) {
    try {
      const value = getComputedStyle(document.body).getPropertyValue(name).trim();
      return value || fallback;
    } catch { return fallback; }
  }

  /** Live palette: re-read whenever the theme, accent or contrast setting changes. */
  function palette() {
    const settings = State.settings ? State.settings() : {};
    const key = [document.body.dataset.theme, document.body.dataset.accent, document.body.dataset.contrast, settings.highContrast].join('|');
    if (paletteCache.key === key && paletteCache.value) return paletteCache.value;
    const value = {};
    for (const [kind, style] of Object.entries(KIND_STYLE)) value[kind] = token(style.token, '#b6b6b2');
    value.line = token('--line-strong', 'rgba(180,180,180,0.3)');
    value.lineHard = token('--line-hard', 'rgba(200,200,200,0.5)');
    value.faint = token('--ink-faint', '#808080');
    value.surface = token('--surface-solid', '#0f1010');
    value.accent = token('--accent', '#f1f1ee');
    value.hover = token('--fill-card-hover', 'rgba(200,200,200,0.1)');
    paletteCache.key = key;
    paletteCache.value = value;
    return value;
  }

  function render(body, api) {
    clear(body);
    api.setTitle('Admin Console', 'operator tools');
    const shell = el('div', { class: 'admin-shell' });
    const nav = el('div', { class: 'admin-nav' });
    hostNode = el('div', { class: 'admin-main' });
    shell.append(nav, hostNode);
    body.append(shell);

    const sections = [
      ['overview', '01', 'Overview'],
      ['neural', '02', 'Neural network'],
      ['users', '03', 'Users'],
      ['sessions', '04', 'Sessions'],
      ['requests', '05', 'Requests'],
      ['files', '06', 'All uploads'],
      ['messages', '07', 'Messages'],
      ['stories', '08', 'Story storage'],
      ['karma', '09', 'Karma'],
      ['audit', '10', 'Audit log'],
      ['global', '11', 'Global state'],
    ];
    for (const [id, glyph, label] of sections) {
      nav.append(el('button', { class: id === section ? 'on' : '', onClick: () => { section = id; render(body, api); } }, [
        el('span', { class: 'glyph', text: glyph }), el('span', { text: label }),
      ]));
    }
    if (refreshTimer) clearInterval(refreshTimer);
    paintSection();
    refreshTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!Windows.exists('admin')) { clearInterval(refreshTimer); return; }
      if (section === 'neural') pullGraph(true); else paintSection();
    }, 20000);
  }

  function paintSection() {
    if (!hostNode) return;
    clear(hostNode);
    const handlers = {
      overview: paintOverview,
      neural: paintNeural,
      users: paintUsers,
      sessions: paintSessions,
      requests: paintRequests,
      files: paintFiles,
      messages: paintMessages,
      stories: paintStories,
      karma: paintKarma,
      audit: paintAudit,
      global: paintGlobal,
    };
    (handlers[section] || paintOverview)();
  }

  // -------------------------------------------------------------- overview
  async function paintOverview() {
    hostNode.append(UI.skeletonList(6));
    const data = await API.get('/api/admin/overview');
    clear(hostNode);
    const scroll = el('div', { class: 'pane-scroll stack-16' });
    hostNode.append(scroll);

    scroll.append(el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title-2', text: 'Server overview' }),
        el('div', { class: 'caption', text: `${data.server.name} ${data.server.version} · Node ${data.server.node} · ${data.server.platform} ${data.server.arch}` }),
      ]),
      el('button', { class: 'btn sm', text: 'Refresh', onClick: () => paintSection() }),
    ]));

    scroll.append(el('div', { class: 'grid-4' }, [
      stat('Uptime', UI.duration(data.server.uptime), `${data.server.cpuCount} cores · load ${data.server.loadAverage[0].toFixed(2)}`),
      stat('Requests / min', String(data.traffic.requestsPerMinute), `${data.traffic.trend >= 0 ? '▲' : '▼'} ${Math.abs(data.traffic.trend)} vs last minute`),
      stat('Members', String(data.counts.users), `${data.traffic.onlineUsers} online now`),
      stat('Live sockets', String(data.traffic.liveSockets), `${data.traffic.neuralSubscribers} watching the graph`),
      stat('Ciphertext stored', UI.bytes(data.storage.total), `${data.counts.files} blobs`),
      stat('Messages', String(data.counts.messages), `${data.counts.conversations} channels`),
      stat('Communities', String(data.counts.forums), `${data.counts.threads} threads · ${data.counts.posts} posts`),
      stat('Stories', String(data.counts.stories), UI.bytes(data.storage.story)),
      stat('Memory (RSS)', UI.bytes(data.server.memory.rss), `heap ${UI.bytes(data.server.memory.heapUsed)}`),
      stat('System memory', `${UI.bytes(data.server.memory.systemFree)} free`, `of ${UI.bytes(data.server.memory.systemTotal)}`),
      stat('Click Me', String(data.clicker.total), `${data.clicker.week} this week`),
      stat('Open requests', String(data.counts.openRequests), `${data.counts.banned} suspended · ${data.counts.verified} verified`),
    ]));

    scroll.append(el('div', { class: 'card stack-8' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'uppercase', text: 'Traffic — last 60 minutes' }),
        el('div', { class: 'spacer' }),
        el('span', { class: 'pill tiny', text: `▲ ${UI.bytes(data.traffic.totals.bytesIn)} in` }),
        el('span', { class: 'pill tiny', text: `▼ ${UI.bytes(data.traffic.totals.bytesOut)} out` }),
        el('span', { class: 'pill tiny', text: `${data.traffic.totals.messages} messages` }),
        el('span', { class: 'pill tiny', text: `${data.traffic.totals.uploads} uploads` }),
      ]),
      UI.sparkline(data.traffic.series.map((point) => point.req)),
      el('div', { class: 'row tiny faint' }, [el('span', { text: 'requests / minute' })]),
    ]));

    const storage = data.storage;
    const rows = [
      ['Direct messages & groups', storage.dm],
      ['Communities', storage.forum],
      ['Cloud drive', storage.drive],
      ['Stories', storage.story],
      ['Airdrops', storage.airdrop],
      ['Avatars & profiles', (storage.avatar || 0) + (storage.publicProfile || 0)],
    ];
    scroll.append(el('div', { class: 'card stack-8' }, [
      el('div', { class: 'uppercase', text: 'Storage by surface' }),
      ...rows.map(([label, value]) => el('div', { class: 'row small' }, [
        el('span', { class: 'grow', text: label }),
        el('span', { class: 'mono', text: UI.bytes(value) }),
      ])),
      el('div', { class: 'divider' }),
      el('div', { class: 'row small' }, [el('span', { class: 'grow body-strong', text: 'Total' }), el('span', { class: 'mono', text: UI.bytes(storage.total) })]),
      el('div', { class: 'hint', text: 'Story storage is tracked separately from messaging, community and drive uploads.' }),
    ]));

    UI.append(scroll, el('div', { class: 'grid-2' }, [
      el('div', { class: 'card stack-8' }, [
        el('div', { class: 'uppercase', text: 'Most active members' }),
        ...data.topUsers.map((user) => el('div', { class: 'list-item', onClick: () => openUser(user.id) }, [
          UI.avatar(user, { size: 'sm' }),
          el('div', { class: 'meta' }, [
            el('div', { class: 'name' }, [el('span', { text: user.displayName }), user.verified ? UI.verifiedBadge(user) : null]),
            el('div', { class: 'sub', text: `last message ${UI.timeAgo(user.lastMessageAt)} · ${UI.bytes(user.storage)}` }),
          ]),
          el('span', { class: 'pill tiny', text: user.role }),
        ])),
      ]),
      el('div', { class: 'card stack-8' }, [
        el('div', { class: 'uppercase', text: 'Recent activity' }),
        ...data.recent.map((event) => el('div', { class: 'row small' }, [
          el('span', { class: 'grow truncate', text: `${event.handle} · ${event.type}` }),
          el('span', { class: 'tiny faint', text: UI.timeAgo(event.at) }),
        ])),
      ]),
    ]));
    hostNode.append(el('div', { class: 'pad-12 row tiny faint' }, [
      el('span', { text: `Data directory holds ${UI.bytes(data.server.dataDirBytes)} of ciphertext blobs.` }),
    ]));
  }

  function stat(label, value, sub) {
    return el('div', { class: 'stat-card' }, [
      el('div', { class: 'value', text: value }),
      el('div', { class: 'label', text: label }),
      sub ? el('div', { class: 'tiny faint', text: sub }) : null,
    ]);
  }

  // ---------------------------------------------------------------- users
  async function paintUsers(search = '', filter = '') {
    hostNode.append(UI.skeletonList(6));
    const data = await API.get(`/api/admin/users?q=${encodeURIComponent(search)}&filter=${encodeURIComponent(filter)}`);
    clear(hostNode);
    const searchInput = el('input', { class: 'input', placeholder: 'Search handle, display name or alias…', value: search });
    const filterSelect = el('select', { class: 'select' }, [
      ['', 'Everyone'], ['online', 'Online now'], ['pending', 'Has open request'], ['verified', 'Verified'], ['banned', 'Suspended'],
    ].map(([value, label]) => el('option', { value, text: label, selected: value === filter })));
    const header = el('div', { class: 'toolbar' }, [
      el('div', { class: 'search-box grow' }, [searchInput]),
      filterSelect,
      el('span', { class: 'pill', text: `${data.totals.count} accounts` }),
      el('span', { class: 'pill accent', text: `${data.totals.openRequests} open requests` }),
    ]);
    const table = el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, ['', 'Member', 'Role', 'Limits', 'Storage', 'Activity', 'Karma', 'Flags', ''].map((label) => el('th', { text: label })))]),
    ]);
    const tbody = el('tbody');
    for (const user of data.users) {
      UI.append(tbody, el('tr', {}, [
        el('td', {}, [UI.avatar(user, { size: 'sm', status: user.status.key })]),
        el('td', {}, [
          el('div', { class: 'row' }, [
            el('span', { class: 'body-strong', text: user.displayName }),
            user.verified ? UI.verifiedBadge(user) : null,
            user.purpleAllowed ? el('span', { title: 'Purple status granted', text: '' }) : null,
          ]),
          el('div', { class: 'tiny faint', text: `@${user.username}${user.publicProfile.enabled ? ` · ${user.publicProfile.alias || 'public'}` : ''}` }),
        ]),
        el('td', {}, [el('span', { class: `role-badge ${user.role}`, text: user.role })]),
        el('td', { class: 'mono tiny' }, [
          el('div', { text: `dm ${user.limits.dmUploadBytes === -1 ? '∞' : UI.bytes(user.limits.dmUploadBytes)}` }),
          el('div', { text: `drive ${user.limits.driveQuotaBytes === -1 ? '∞' : UI.bytes(user.limits.driveQuotaBytes)}` }),
        ]),
        el('td', { class: 'mono tiny' }, [
          el('div', { text: UI.bytes(user.storageBytes) }),
          el('div', { text: `${user.sessions} session(s)` }),
        ]),
        el('td', { class: 'tiny' }, [
          el('div', { text: `▤ ${UI.timeAgo(user.history.lastMessageAt)}` }),
          el('div', { text: `⬆ ${UI.timeAgo(user.history.lastUploadAt)}` }),
        ]),
        el('td', {}, [el('span', { class: 'karma-bar' }, [
          el('span', { class: 'up', text: `▲${user.karma.received.up}` }),
          el('span', { class: 'down', text: `▼${user.karma.received.down}` }),
        ])]),
        el('td', {}, [
          user.banned ? el('span', { class: 'pill danger tiny', text: 'suspended' }) : null,
          user.disabled ? el('span', { class: 'pill warn tiny', text: 'disabled' }) : null,
          user.publicProfile.enabled ? el('span', { class: 'pill tiny', text: 'public' }) : null,
        ]),
        el('td', {}, [
          el('button', { class: 'btn sm', text: 'Open', onClick: () => openUser(user.id) }),
          el('button', { class: 'btn sm subtle', text: '⋯', onClick: (event) => userMenu(event, user) }),
        ]),
      ]));
    }
    table.append(tbody);
    hostNode.append(header, el('div', { class: 'pane-scroll' }, [table]));
    const apply = UI.debounce(() => paintUsers(searchInput.value, filterSelect.value), 320);
    searchInput.addEventListener('input', apply);
    filterSelect.addEventListener('change', () => paintUsers(searchInput.value, filterSelect.value));
  }

  function userMenu(event, user) {
    UI.contextMenu([
      { icon: 'profile', label: 'Open profile panel', onClick: () => openUser(user.id) },
      { icon: 'messages', label: 'Chat with member', onClick: () => ConversationClient.startWith(user.id) },
      { icon: 'hash', label: 'Generate one-time DM code', onClick: () => generateCode(user) },
      { separator: true },
      { icon: 'admin', label: user.banned ? 'Lift suspension' : 'Suspend account', danger: !user.banned, onClick: async () => {
        await API.patch(`/api/admin/users/${user.id}`, { banned: !user.banned });
        UI.toast({ level: 'success', title: user.banned ? 'Suspension lifted' : 'Account suspended' });
        paintUsers();
      } },
      { icon: 'close', label: user.disabled ? 'Re-enable account' : 'Disable account', danger: !user.disabled, onClick: async () => {
        await API.patch(`/api/admin/users/${user.id}`, { disabled: !user.disabled });
        paintUsers();
      } },
    ], { x: event.clientX, y: event.clientY });
  }

  async function generateCode(user) {
    const result = await API.post('/api/dm-codes', { userId: user.id });
    UI.dialog({
      title: 'One-time chat code',
      icon: 'hash',
      subtitle: `Send this code to @${user.username} through any channel you trust.`,
      content: el('div', { class: 'stack-8' }, [
        el('div', { class: 'recovery-code', text: result.code, onClick: () => UI.copy(result.code, 'Code copied') }),
        el('div', { class: 'hint', text: `Single use · expires ${UI.dateTime(result.expiresAt)}` }),
        el('div', { class: 'notice-strip', html: '<span>◍</span><span>The member sees “Server Administration” until you choose to identify yourself inside the channel.</span>' }),
      ]),
      footer: [el('button', { class: 'btn primary', text: 'Copy code', onClick: () => UI.copy(result.code, 'Code copied') })],
    });
  }

  async function openUser(userId) {
    const data = await API.get(`/api/admin/users/${userId}`);
    const user = data.user;
    const detail = data.detail;
    const limitsDm = el('input', { class: 'input', value: user.limits.dmUploadBytes === -1 ? 'unlimited' : String(user.limits.dmUploadBytes) });
    const limitsDrive = el('input', { class: 'input', value: user.limits.driveQuotaBytes === -1 ? 'unlimited' : String(user.limits.driveQuotaBytes) });
    const limitsStory = el('input', { class: 'input', value: user.limits.storyQuotaBytes === -1 ? 'unlimited' : String(user.limits.storyQuotaBytes) });
    const note = el('div', { class: 'hint', text: 'Use bytes, or the word “unlimited”. Changes reach the member instantly.' });

    const sessionList = el('div', { class: 'stack-4' });
    const paintSessions = () => {
      clear(sessionList);
      for (const session of detail.sessions) {
        sessionList.append(el('div', { class: 'session-row' }, [
          el('span', { class: 'device-glyph', text: /phone|android|iphone|ipad/i.test(session.device) ? '▭' : /mac|windows|linux/i.test(session.device) ? '▢' : '◈' }),
          el('div', { class: 'grow' }, [
            el('div', { class: 'small body-strong', text: `${session.device} · ${session.platform}` }),
            el('div', { class: 'tiny faint', text: `${session.ip || 'ip hidden'} · started ${UI.dateTime(session.createdAt)} · last seen ${UI.timeAgo(session.lastSeenAt)}` }),
          ]),
          el('button', { class: 'btn sm danger', text: 'End session', onClick: async () => {
            await API.post('/api/admin/sessions/revoke', { token: session.token });
            UI.toast({ level: 'success', title: 'Session ended', body: `${session.device} was signed out.` });
            openUser(userId);
          } }),
        ]));
      }
      if (!detail.sessions.length) sessionList.append(el('div', { class: 'caption', text: 'No active sessions.' }));
    };
    paintSessions();

    const content = el('div', { class: 'stack-12' }, [
      el('div', { class: 'row' }, [
        UI.avatar(user, { size: 'xl', status: user.status.key }),
        el('div', { class: 'stack-2' }, [
          el('div', { class: 'row' }, [el('span', { class: 'title-3', text: user.displayName }), user.verified ? UI.verifiedBadge(user, false) : null]),
          el('div', { class: 'caption', text: `@${user.username} · joined ${UI.dateTime(user.createdAt)}` }),
          el('div', { class: 'tiny faint', text: `${UI.statusLabel(user.status.key)} · ${user.sessions} session(s) · ${UI.bytes(user.storageBytes)} stored` }),
          el('div', { class: 'tiny faint mono', text: `IPs: ${detail.ips.slice(0, 4).join(', ') || 'unknown'}` }),
        ]),
      ]),
      el('div', { class: 'row wrap' }, [
        el('span', { class: 'pill', text: `role ${user.role}` }),
        el('span', { class: 'pill', text: `▤ ${user.stats.messages}` }),
        el('span', { class: 'pill', text: `✎ ${user.stats.posts}` }),
        el('span', { class: 'pill', text: `▥ ${detail.files.length} files` }),
        el('span', { class: 'pill', text: `◉ ${detail.stories.length} stories` }),
        el('span', { class: 'pill', text: `⊞ ${user.clicks} clicks` }),
        el('span', { class: 'pill', text: `§ karma ${user.karma.score} (▲${user.karma.received.up}/▼${user.karma.received.down})` }),
      ]),
      el('div', { class: 'card stack-8' }, [
        el('div', { class: 'uppercase', text: 'Moderation' }),
        el('div', { class: 'row wrap' }, [
          toggle(`Blue check mark`, user.verified, async (value) => { await API.patch(`/api/admin/users/${user.id}`, { verified: value }); openUser(userId); }, 'Shows a verified badge beside this member’s name everywhere.'),
          toggle('Purple status', user.purpleAllowed, async (value) => { await API.patch(`/api/admin/users/${user.id}`, { purpleAllowed: value }); openUser(userId); }, 'Unlocks the purple availability ring for this member.'),
          toggle('Suspended', user.banned, async (value) => { await API.patch(`/api/admin/users/${user.id}`, { banned: value }); openUser(userId); }, 'Blocks sign-in and ends every session.'),
          toggle('Disabled', user.disabled, async (value) => { await API.patch(`/api/admin/users/${user.id}`, { disabled: value }); openUser(userId); }, 'Freezes the account without deleting anything.'),
        ]),
        el('div', { class: 'field' }, [el('label', { text: 'Role' }),
          el('div', { class: 'row' }, [
            el('select', { class: 'select', onChange: async (event) => { await API.patch(`/api/admin/users/${user.id}`, { role: event.target.value }); openUser(userId); } },
              ['member', 'mod', 'admin', 'owner'].map((role) => el('option', { value: role, text: role, selected: role === user.role }))),
            el('button', { class: 'btn sm', text: 'One-time DM code', onClick: () => generateCode(user) }),
          ]),
        ]),
      ]),
      el('div', { class: 'card stack-8' }, [
        el('div', { class: 'uppercase', text: 'Limits' }),
        el('div', { class: 'grid-3' }, [
          el('div', { class: 'field' }, [el('label', { text: 'DM upload (bytes)' }), limitsDm]),
          el('div', { class: 'field' }, [el('label', { text: 'Drive quota (bytes)' }), limitsDrive]),
          el('div', { class: 'field' }, [el('label', { text: 'Story item (bytes)' }), limitsStory]),
        ]),
        note,
        el('div', { class: 'row' }, [
          el('button', { class: 'btn primary', text: 'Apply limits', onClick: async () => {
            const parse = (value) => (/unlimited|inf|-1/i.test(value.trim()) ? -1 : Number(value.trim()));
            const result = await API.patch(`/api/admin/users/${user.id}`, {
              limits: { dmUploadBytes: parse(limitsDm.value), driveQuotaBytes: parse(limitsDrive.value), storyQuotaBytes: parse(limitsStory.value) },
            });
            UI.toast({ level: 'success', title: 'Limits updated', body: `dm ${UI.bytes(result.user.limits.dmUploadBytes)} · drive ${UI.bytes(result.user.limits.driveQuotaBytes)}` });
          } }),
          el('button', { class: 'btn', text: 'Reset drive usage', onClick: async () => { await API.patch(`/api/admin/users/${user.id}`, { resetDrive: true }); openUser(userId); } }),
          el('button', { class: 'btn danger', text: 'Delete account', onClick: async () => {
            if (!await UI.confirm({ title: `Delete @${user.username}?`, message: 'Every upload, story and message ciphertext owned by this account is removed.', danger: true, confirmLabel: 'Delete permanently' })) return;
            await API.del(`/api/admin/users/${user.id}`);
            UI.toast({ level: 'success', title: 'Account deleted' });
            paintSection();
          } }),
        ]),
      ]),
      el('div', { class: 'card stack-8' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'uppercase', text: 'Signed-in sessions' }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn sm danger', text: 'End all sessions', onClick: async () => {
            if (!await UI.confirm({ title: 'End every session?', message: 'The member is signed out everywhere and must sign in again.', danger: true, confirmLabel: 'End all' })) return;
            await API.post(`/api/admin/users/${user.id}/sessions/revoke-all`, {});
            UI.toast({ level: 'success', title: 'All sessions ended' });
            openUser(userId);
          } }),
        ]),
        sessionList,
      ]),
      el('div', { class: 'card stack-8' }, [
        el('div', { class: 'uppercase', text: 'Requests from this member' }),
        ...(detail.requests.length ? detail.requests.map((request) => el('div', { class: 'row small' }, [
          el('span', { class: 'pill tiny', text: request.kind }),
          el('span', { class: 'grow', text: request.message || '(no message)' }),
          el('span', { class: 'pill tiny', text: request.status }),
        ])) : [el('div', { class: 'caption', text: 'No requests filed.' })]),
      ]),
      el('div', { class: 'card stack-8' }, [
        el('div', { class: 'uppercase', text: `Uploads (${detail.files.length})` }),
        ...detail.files.slice(0, 12).map((file) => el('div', { class: 'row small' }, [
          el('span', { class: 'pill tiny', text: file.kind }),
          el('span', { class: 'grow mono tiny', text: file.id }),
          el('span', { class: 'mono tiny', text: UI.bytes(file.size) }),
          el('span', { class: 'tiny faint', text: UI.timeAgo(file.createdAt) }),
          el('button', { class: 'btn sm danger', text: '✕', title: 'Delete blob', onClick: async () => {
            await API.del(`/api/files/${file.id}`);
            UI.toast({ level: 'success', title: 'Blob deleted' });
            openUser(userId);
          } }),
        ])),
        el('div', { class: 'hint', text: 'Filenames and contents are end-to-end encrypted and not readable here.' }),
      ]),
    ]);
    UI.dialog({ title: `@${user.username}`, icon: 'profile', size: 'wide', content });
  }

  function toggle(label, value, onChange, description) {
    const input = el('input', { type: 'checkbox', checked: value });
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'row', style: { gap: '8px' } }, [
      el('span', { class: 'switch' }, [input, el('span', { class: 'track' }), el('span', { class: 'knob' })]),
      el('div', {}, [el('div', { class: 'small', text: label }), description ? el('div', { class: 'tiny faint', text: description }) : null]),
    ]);
  }

  // ------------------------------------------------------------- sessions
  async function paintSessions() {
    hostNode.append(UI.skeletonList(5));
    const users = await API.get('/api/admin/users?filter=');
    const rows = [];
    for (const user of users.users) {
      if (!user.sessions) continue;
      const detail = await API.get(`/api/admin/users/${user.id}/sessions`).catch(() => ({ sessions: [] }));
      for (const session of detail.sessions) rows.push({ user, session });
    }
    clear(hostNode);
    rows.sort((a, b) => b.session.lastSeenAt - a.session.lastSeenAt);
    const table = el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, ['Member', 'Device', 'IP', 'Started', 'Last seen', ''].map((label) => el('th', { text: label })))]),
      el('tbody', {}, rows.map(({ user, session }) => el('tr', {}, [
        el('td', {}, [el('div', { class: 'user-row' }, [UI.avatar(user, { size: 'xs' }), el('span', { text: user.displayName })])]),
        el('td', {}, [el('div', { text: session.device }), el('div', { class: 'tiny faint', text: session.platform })]),
        el('td', { class: 'mono tiny', text: session.ip || 'hidden' }),
        el('td', { class: 'tiny', text: UI.dateTime(session.createdAt) }),
        el('td', { class: 'tiny', text: UI.timeAgo(session.lastSeenAt) }),
        el('td', {}, [el('button', { class: 'btn sm danger', text: 'End', onClick: async () => {
          await API.post('/api/admin/sessions/revoke', { token: session.token });
          UI.toast({ level: 'success', title: 'Session ended', body: `${user.displayName} was signed out of ${session.device}.` });
          paintSections();
        } })]),
      ]))),
    ]);
    hostNode.append(el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'body-strong', text: 'Signed-in sessions' }),
        el('div', { class: 'tiny faint', text: 'End any session you do not recognise.' }),
      ]),
      el('span', { class: 'pill', text: `${rows.length} sessions` }),
      el('button', { class: 'btn sm', text: 'Refresh', onClick: () => paintSection() }),
    ]), el('div', { class: 'pane-scroll' }, [table]));
  }

  function paintSections() { paintSection(); }

  // ------------------------------------------------------------- requests
  async function paintRequests() {
    hostNode.append(UI.skeletonList(4));
    const data = await API.get('/api/admin/requests');
    clear(hostNode);
    const scroll = el('div', { class: 'pane-scroll stack-12' });
    hostNode.append(el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'body-strong', text: 'Storage & capability requests' }),
        el('div', { class: 'tiny faint', text: 'Approving sets the new capacity; denying leaves limits untouched.' }),
      ]),
      el('span', { class: 'pill accent', text: `${data.counts.open || 0} open` }),
      el('span', { class: 'pill', text: `${data.counts.approved || 0} approved` }),
      el('span', { class: 'pill', text: `${data.counts.denied || 0} denied` }),
      el('button', { class: 'btn sm', text: '', onClick: () => paintSection() }),
    ]), scroll);

    if (!data.requests.length) scroll.append(UI.empty('05', 'No requests', 'Members can ask for bigger uploads, drive space or the purple status.'));
    for (const request of data.requests) {
      const card = el('div', { class: 'card stack-8' });
      const user = request.user || { displayName: 'unknown' };
      const presetValues = {
        dm: [15, 25, 50, 100, 512, 1024].map((mb) => mb * 1024 * 1024),
        drive: [1, 2, 5, 10, 50, 100].map((gb) => gb * 1024 * 1024 * 1024),
        story: [1, 2, 5].map((gb) => gb * 1024 * 1024 * 1024),
      }[request.kind] || [];

      UI.append(card, el('div', { class: 'row' }, [
        UI.avatar(user, { size: 'sm', status: user.status?.key }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'body-strong', text: user.displayName || user.username }),
            user.verified ? UI.verifiedBadge(user) : null,
            el('span', { class: `pill tiny ${request.status === 'open' ? 'accent' : request.status === 'approved' ? 'success' : 'danger'}`, text: request.status }),
          ]),
          el('div', { class: 'tiny faint', text: `@${user.username} · ${request.kind} request · ${UI.timeAgo(request.createdAt)}` }),
        ]),
        el('button', { class: 'btn sm', text: 'Open account', onClick: () => openUser(request.user.id) }),
      ]));

      UI.append(card, el('div', { class: 'row wrap small' }, [
        el('span', { class: 'pill', text: `current dm ${user.limits?.dmUploadBytes === -1 ? '∞' : UI.bytes(user.limits?.dmUploadBytes || 0)}` }),
        el('span', { class: 'pill', text: `current drive ${user.limits?.driveQuotaBytes === -1 ? '∞' : UI.bytes(user.limits?.driveQuotaBytes || 0)}` }),
        request.requestedBytes ? el('span', { class: 'pill accent', text: `asked for ${UI.bytes(request.requestedBytes)}` }) : null,
      ]));

      if (request.message) card.append(el('div', { class: 'small muted', text: request.message }));

      if (request.status === 'open') {
        const amount = el('input', { class: 'input', placeholder: 'New size in bytes, or “unlimited”', value: request.requestedBytes ? String(request.requestedBytes) : '' });
        const noteInput = el('input', { class: 'input', placeholder: 'Message to the member (optional)' });
        const quick = el('div', { class: 'row wrap' });
        for (const value of presetValues) {
          quick.append(el('button', { class: 'btn sm subtle', text: UI.bytes(value), onClick: () => { amount.value = String(value); } }));
        }
        if (request.kind === 'dm' || request.kind === 'drive' || request.kind === 'story') {
          quick.append(el('button', { class: 'btn sm subtle', text: '∞ unlimited', onClick: () => { amount.value = 'unlimited'; } }));
        }
        UI.append(card, el('div', { class: 'stack-6' }, [
          request.kind === 'purple' ? el('div', { class: 'notice-strip', html: '<span>◉</span><span>Approving unlocks the purple availability ring for this member.</span>' }) : null,
          request.kind === 'verified' ? el('div', { class: 'notice-strip', html: '<span>✓</span><span>Approving adds the blue check mark to this member.</span>' }) : null,
          request.kind === 'dm' || request.kind === 'drive' || request.kind === 'story' ? el('div', { class: 'field' }, [el('label', { text: 'New limit' }), amount, quick]) : null,
          el('div', { class: 'field' }, [el('label', { text: 'Note' }), noteInput]),
          el('div', { class: 'row' }, [
            el('button', { class: 'btn primary', text: 'Accept request', onClick: () => decide(request, 'approve', amount.value, noteInput.value) }),
            el('button', { class: 'btn', text: 'Deny (leave as it was)', onClick: () => decide(request, 'deny', null, noteInput.value) }),
            el('div', { class: 'spacer' }),
            el('button', { class: 'btn subtle sm', text: 'Open a chat instead', onClick: () => generateCode(user) }),
          ]),
        ]));
      } else if (request.decision) {
        card.append(el('div', { class: 'notice-strip', html: `<span>≡</span><span>${UI.esc(request.decision.status)} ${request.decision.grantedBytes ? `· granted ${UI.bytes(request.decision.grantedBytes)}` : ''} ${request.decision.note ? `· “${UI.esc(request.decision.note)}”` : ''} · ${UI.timeAgo(request.decision.at)}</span>` }));
      }
      scroll.append(card);
    }
  }

  async function decide(request, decision, value, note) {
    const body = { decision, note: note || '' };
    if (decision === 'approve' && value !== null && value !== undefined && String(value).length) {
      const text = String(value).trim();
      body.bytes = /unlimited|∞|-1|inf/i.test(text) ? -1 : Number(text);
      if (!Number.isFinite(body.bytes)) body.bytes = null;
    }
    try {
      const result = await API.post(`/api/admin/requests/${request.id}/decision`, body);
      UI.toast({ level: 'success', title: decision === 'approve' ? 'Request approved' : 'Request denied', body: decision === 'approve' ? 'The member was notified instantly.' : 'The member keeps their current limits.' });
      if (result.request?.user?.id) paintSection();
    } catch (error) {
      UI.toast({ level: 'danger', title: 'Decision failed', body: error.message });
    }
  }

  // ---------------------------------------------------------------- files
  async function paintFiles(kind = '', query = '') {
    hostNode.append(UI.skeletonList(5));
    const data = await API.get(`/api/admin/files?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query)}`);
    clear(hostNode);
    const search = el('input', { class: 'input', placeholder: 'Filter by handle or file id…', value: query });
    const kindSelect = el('select', { class: 'select' }, ['', 'dm', 'forum', 'drive', 'story', 'airdrop', 'avatar', 'public'].map((value) => el('option', { value, text: value || 'All kinds', selected: value === kind })));
    hostNode.append(el('div', { class: 'toolbar' }, [
      el('div', { class: 'search-box grow' }, [search]),
      kindSelect,
      el('span', { class: 'pill', text: `${data.totals.count} blobs` }),
      el('span', { class: 'pill accent', text: UI.bytes(data.totals.bytes) }),
      el('button', { class: 'btn sm', text: '', onClick: () => paintSection() }),
    ]));

    hostNode.append(el('div', { class: 'row wrap pad-8' }, Object.entries(data.totals.byKind).map(([key, bytes]) => el('span', { class: 'pill tiny', text: `${key}: ${UI.bytes(bytes)}` }))));

    const table = el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, ['Owner', 'Kind', 'Blob id', 'Size', 'Uploaded', 'Linked to', ''].map((label) => el('th', { text: label })))]),
      el('tbody', {}, data.files.map((file) => el('tr', {}, [
        el('td', {}, [file.owner ? el('div', { class: 'user-row' }, [
          el('span', { class: 'member-plate', html: UI.icon('profile') }),
          el('div', {}, [
            el('div', { class: 'row' }, [el('span', { text: file.owner.label || 'Member' })]),
            el('div', { class: 'tiny faint', text: `${file.owner.role || 'member'} · identity withheld` }),
          ]),
        ]) : el('span', { text: 'unknown' })]),
        el('td', {}, [el('span', { class: 'pill tiny', text: file.kind })]),
        el('td', { class: 'mono tiny', text: file.id }),
        el('td', { class: 'mono tiny', text: UI.bytes(file.size) }),
        el('td', { class: 'tiny', text: UI.timeAgo(file.completedAt || file.createdAt) }),
        el('td', { class: 'tiny faint', text: file.ref.conversationId || file.ref.threadId || file.ref.storyId || file.audience || '—' }),
        el('td', {}, [el('button', { class: 'btn sm danger', text: 'Delete', onClick: async () => {
          if (!await UI.confirm({ title: 'Delete this blob?', message: 'The ciphertext is removed from the server; members keep their local copies of keys but not the data.', danger: true, confirmLabel: 'Delete' })) return;
          await API.del(`/api/files/${file.id}`);
          paintFiles(kind, query);
        } })]),
      ]))),
    ]);
    hostNode.append(el('div', { class: 'pane-scroll' }, [table]));
    hostNode.append(el('div', { class: 'pad-12 row tiny faint' }, [el('span', { text: data.note })]));
    const apply = UI.debounce(() => paintFiles(kindSelect.value, search.value), 320);
    search.addEventListener('input', apply);
    kindSelect.addEventListener('change', () => paintFiles(kindSelect.value, search.value));
  }

  /**
   * Every message on the server, with the author shown as a stable pseudonym.
   * Bodies stay sealed end to end, so what the operator gets is the shape of
   * the traffic — channel, size, reactions, attachments — and the power to act
   * on it without a directory of who said what.
   */
  async function paintMessages(query = '') {
    hostNode.append(UI.skeletonList(5));
    const data = await API.get(`/api/admin/messages?limit=200`);
    clear(hostNode);
    const search = el('input', { class: 'input', placeholder: 'Filter by channel or id…', value: query });
    const rows = query
      ? data.messages.filter((m) => `${m.channel} ${m.conversationId} ${m.author}`.toLowerCase().includes(query.toLowerCase()))
      : data.messages;

    hostNode.append(el('div', { class: 'toolbar' }, [
      el('div', { class: 'search-box grow' }, [search]),
      el('span', { class: 'pill', text: `${data.total} messages` }),
      el('span', { class: 'pill accent', text: `${rows.length} shown` }),
      el('button', { class: 'btn sm', text: 'Refresh', onClick: () => paintSection() }),
    ]));
    hostNode.append(el('div', { class: 'notice-strip pad-8' }, [
      el('span', { html: UI.icon('profile') }),
      el('span', { text: 'Authors are shown as pseudonyms. Message text is encrypted end to end and is not readable here.' }),
    ]));

    const table = el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, ['Author', 'Channel', 'When', 'Attachments', 'Reactions', 'State', ''].map((label) => el('th', { text: label })))]),
      el('tbody', {}, rows.map((message) => el('tr', {}, [
        el('td', {}, [el('span', { class: 'member-plate', html: UI.icon('profile') }), el('span', { text: message.author })]),
        el('td', {}, [el('span', { class: 'pill tiny', text: message.channel }), el('div', { class: 'mono tiny faint', text: String(message.conversationId || '').slice(0, 10) })]),
        el('td', { class: 'tiny', text: UI.timeAgo(message.createdAt) }),
        el('td', { class: 'mono tiny', text: String(message.attachments) }),
        el('td', { class: 'mono tiny', text: String(message.reactions) }),
        el('td', {}, [message.deleted ? el('span', { class: 'pill danger tiny', text: 'deleted' }) : el('span', { class: 'tiny faint', text: 'live' })]),
        el('td', {}, [el('button', { class: 'btn sm danger', text: 'Delete', onClick: async () => {
          if (!await UI.confirm({ title: 'Delete this message?', message: 'The ciphertext is removed from the server for everyone in that channel.', danger: true, confirmLabel: 'Delete' })) return;
          await API.del(`/api/admin/messages/${message.id}`);
          paintMessages(search.value);
        } })]),
      ]))),
    ]);
    hostNode.append(el('div', { class: 'pane-scroll' }, [table]));
    const apply = UI.debounce(() => paintMessages(search.value), 320);
    search.addEventListener('input', apply);
  }

  async function paintStories() {
    const data = await API.get('/api/admin/stories');
    clear(hostNode);
    const scroll = el('div', { class: 'pane-scroll stack-12' });
    hostNode.append(el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'body-strong', text: 'Story storage' }),
        el('div', { class: 'tiny faint', text: 'Stories are counted separately and expire after 24 hours.' }),
      ]),
      el('span', { class: 'pill', text: `${data.totals.active} live` }),
      el('span', { class: 'pill', text: `${data.totals.count} total` }),
      el('span', { class: 'pill accent', text: UI.bytes(data.totals.bytes) }),
    ]), scroll);
    const table = el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, ['Author', 'Kind', 'Size', 'Posted', 'Expires', 'Views', ''].map((label) => el('th', { text: label })))]),
      el('tbody', {}, data.stories.map((story) => el('tr', {}, [
        el('td', {}, [story.author ? el('div', { class: 'user-row' }, [UI.avatar(story.author, { size: 'xs' }), el('span', { text: story.author.label })]) : el('span', { text: 'unknown' })]),
        el('td', {}, [el('span', { class: 'pill tiny', text: story.kind })]),
        el('td', { class: 'mono tiny', text: UI.bytes(story.size) }),
        el('td', { class: 'tiny', text: UI.timeAgo(story.createdAt) }),
        el('td', { class: 'tiny', text: story.expired ? 'expired' : UI.timeAgo(story.expiresAt).replace(' ago', '') }),
        el('td', { class: 'tiny', text: String(story.views) }),
        el('td', {}, [el('button', { class: 'btn sm danger', text: 'Delete', onClick: async () => {
          await API.del(`/api/stories/${story.id}`);
          paintStories();
        } })]),
      ]))),
    ]);
    scroll.append(table, el('div', { class: 'hint pad-8', text: data.note }));
  }

  // ---------------------------------------------------------------- karma
  async function paintKarma() {
    const data = await API.get('/api/admin/karma');
    clear(hostNode);
    const table = el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, ['Member', 'Received ▲', 'Received ▼', 'Given ▲', 'Given ▼', 'Score'].map((label) => el('th', { text: label })))]),
      el('tbody', {}, data.karma.map((row) => el('tr', {}, [
        el('td', {}, [el('div', { class: 'user-row' }, [UI.avatar(row, { size: 'xs' }), el('div', {}, [el('div', { text: row.label }), el('div', { class: 'tiny faint', text: `@${row.handle}` })])])]),
        el('td', { class: 'mono', text: String(row.karma.received.up) }),
        el('td', { class: 'mono', text: String(row.karma.received.down) }),
        el('td', { class: 'mono', text: String(row.karma.given.up) }),
        el('td', { class: 'mono', text: String(row.karma.given.down) }),
        el('td', {}, [el('span', { class: `pill tiny ${row.karma.score >= 0 ? 'success' : 'danger'}`, text: String(row.karma.score) })]),
      ]))),
    ]);
    hostNode.append(el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'body-strong', text: 'Karma leaderboard' }),
        el('div', { class: 'tiny faint', text: 'Upvote and downvote totals are visible to administrators only.' }),
      ]),
      el('button', { class: 'btn sm', text: '', onClick: () => paintKarma() }),
    ]), el('div', { class: 'pane-scroll' }, [table]));
  }

  async function paintAudit() {
    const data = await API.get('/api/admin/audit');
    clear(hostNode);
    hostNode.append(el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'body-strong', text: 'Administrative audit log' }),
        el('div', { class: 'tiny faint', text: 'Every operator action is recorded with actor, target and timestamp.' }),
      ]),
      el('button', { class: 'btn sm', text: '', onClick: () => paintAudit() }),
    ]));
    const table = el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, ['When', 'Actor', 'Action', 'Detail'].map((label) => el('th', { text: label })))]),
      el('tbody', {}, data.audit.map((entry) => el('tr', {}, [
        el('td', { class: 'tiny', text: UI.dateTime(entry.at) }),
        el('td', { class: 'small', text: entry.actor ? `${entry.actor.label} (${entry.actor.role})` : 'system' }),
        el('td', {}, [el('span', { class: 'pill tiny', text: entry.action })]),
        el('td', { class: 'tiny faint mono', text: JSON.stringify(entry.detail).slice(0, 160) }),
      ]))),
    ]);
    hostNode.append(el('div', { class: 'pane-scroll' }, [table]));
  }

  // ---------------------------------------------------------- global state
  async function paintGlobal() {
    const data = await API.get('/api/admin/overview');
    const global = data.global;
    clear(hostNode);
    const registration = el('input', { type: 'checkbox', checked: global.registrationOpen });
    const maintenance = el('input', { type: 'checkbox', checked: global.maintenance });
    const notice = el('input', { class: 'input', value: global.notice || '' });
    const maxUpload = el('input', { class: 'input', value: String(global.maxUploadBytes) });
    const termsVersion = el('input', { class: 'input', value: global.termsVersion });

    hostNode.append(el('div', { class: 'pane-scroll stack-12' }, [
      el('div', { class: 'card stack-12' }, [
        el('div', { class: 'uppercase', text: 'Application state' }),
        el('label', { class: 'row' }, [el('span', { class: 'switch' }, [registration, el('span', { class: 'track' }), el('span', { class: 'knob' })]), el('div', {}, [
          el('div', { class: 'small body-strong', text: 'Open registration' }),
          el('div', { class: 'tiny faint', text: 'When closed, new accounts cannot be created at all.' }),
        ])]),
        el('label', { class: 'row' }, [el('span', { class: 'switch' }, [maintenance, el('span', { class: 'track' }), el('span', { class: 'knob' })]), el('div', {}, [
          el('div', { class: 'small body-strong', text: 'Maintenance mode' }),
          el('div', { class: 'tiny faint', text: 'Members see a maintenance notice; operators keep full access.' }),
        ])]),
        el('div', { class: 'field' }, [el('label', { text: 'Operator notice' }), notice, el('div', { class: 'hint', text: 'Shown as a toast after members sign in.' })]),
        el('div', { class: 'grid-2' }, [
          el('div', { class: 'field' }, [el('label', { text: 'Absolute upload ceiling (bytes)' }), maxUpload]),
          el('div', { class: 'field' }, [el('label', { text: 'Terms version' }), termsVersion, el('div', { class: 'hint', text: 'Bump this to re-present the agreement to every member.' })]),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn primary', text: 'Save global state', onClick: async () => {
            await API.post('/api/admin/global', {
              registrationOpen: registration.checked,
              maintenance: maintenance.checked,
              notice: notice.value,
              maxUploadBytes: Number(maxUpload.value) || global.maxUploadBytes,
              termsVersion: termsVersion.value,
            });
            UI.toast({ level: 'success', title: 'Global state saved' });
          } }),
          el('button', { class: 'btn', text: 'Preview agreement', onClick: () => Terms.show() }),
        ]),
      ]),
      el('div', { class: 'card stack-8' }, [
        el('div', { class: 'uppercase', text: 'Operator notes' }),
        el('div', { class: 'small muted', text: 'The server stores ciphertext, wrapped keys, account metadata (handles, avatars, limits, sessions) and traffic counters. Direct messages, private communities, drive files and story media can never be decrypted from the server side — the neural view shows structure and timing instead of content.' }),
        el('div', { class: 'small muted', text: 'Public community content is sealed with a community audience key, so it can be reviewed in the neural view for moderation.' }),
      ]),
    ]));
  }

  // ------------------------------------------------------- neural network
  async function paintNeural() {
    clear(hostNode);
    const stage = el('div', { class: 'neural-stage' });
    const canvas = el('canvas');
    stage.append(canvas);
    hostNode.append(stage);

    const overlay = el('div', { class: 'neural-overlay' }, [
      el('span', { class: 'pill', text: 'live activity graph' }),
      el('select', { class: 'select', style: { width: '150px' }, onChange: () => pullGraph(false) }, [
        el('option', { value: '30', text: 'last 30 minutes' }),
        el('option', { value: '60', text: 'last hour', selected: true }),
        el('option', { value: '180', text: 'last 3 hours' }),
        el('option', { value: '360', text: 'last 6 hours' }),
      ]),
      el('button', { class: 'btn sm', text: '⏯ Pause', onClick: (event) => {
        graph.running = !graph.running;
        event.target.textContent = graph.running ? '⏯ Pause' : '▶ Resume';
        if (graph.running) tick();
      } }),
      el('button', { class: 'btn sm', text: 'Fit', onClick: () => fit() }),
      el('button', { class: 'btn sm', text: '', title: 'Zoom in', onClick: () => zoomBy(1.25) }),
      el('button', { class: 'btn sm', text: '–', title: 'Zoom out', onClick: () => zoomBy(0.8) }),
      el('span', { class: 'pill tiny', id: 'neural-status', text: 'connecting…' }),
    ]);
    const legend = el('div', { class: 'neural-legend' }, Object.entries(KIND_STYLE).map(([kind, style]) => el('div', {}, [
      el('span', { class: 'dot', style: { background: `var(${style.token})` } }), el('span', { text: style.label }),
    ])).concat([
      el('div', { class: 'tiny faint', text: 'scroll to zoom · drag to pan · click a node to inspect' }),
      el('div', { class: 'tiny faint', id: 'neural-last-event', text: 'waiting for activity…' }),
    ]));
    stage.append(overlay, legend);

    graph.canvas = canvas;
    graph.ctx = canvas.getContext('2d');
    sizeCanvas();
    attachCanvasControls(stage, canvas);
    await pullGraph(false);
    tick();
  }

  function sizeCanvas() {
    const canvas = graph.canvas;
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(320, rect.width * dpr);
    canvas.height = Math.max(240, rect.height * dpr);
    graph.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    graph.width = rect.width;
    graph.height = rect.height;
  }

  async function pullGraph(silent) {
    const status = UI.$('#neural-status');
    if (status && !silent) status.textContent = 'loading…';
    const windowSelect = UI.$('.neural-overlay select');
    const minutes = windowSelect ? windowSelect.value : '60';
    try {
      const data = await API.get(`/api/admin/neural?window=${minutes}`);
      graph.data = data;
      mergeGraph(data);
      if (status) status.textContent = `${data.counts.users} members · ${data.counts.messages} messages · ${data.nodes.length} nodes`;
    } catch (error) {
      if (status) status.textContent = `graph unavailable (${error.message})`;
    }
  }

  function mergeGraph(data) {
    const positions = new Map(graph.nodes.map((node) => [node.id, node]));
    const width = graph.width || 800;
    const height = graph.height || 500;
    graph.nodes = data.nodes.map((node, index) => {
      const existing = positions.get(node.id);
      const angle = (index / Math.max(1, data.nodes.length)) * Math.PI * 2;
      const radius = node.type === 'user' ? Math.min(width, height) * 0.34 : Math.min(width, height) * 0.22;
      return Object.assign({}, node, {
        x: existing ? existing.x : width / 2 + Math.cos(angle) * radius + (Math.random() - 0.5) * 40,
        y: existing ? existing.y : height / 2 + Math.sin(angle) * radius + (Math.random() - 0.5) * 40,
        vx: existing ? existing.vx : 0,
        vy: existing ? existing.vy : 0,
        size: node.type === 'user' ? 8 + Math.min(10, (node.metrics?.messages || 0) / 12) : 12 + Math.min(18, (node.weight || 1) * 1.6),
        born: existing ? existing.born : Date.now(),
        pulse: existing ? existing.pulse : 0,
      });
    });
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    graph.edges = data.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
    const newest = data.events.length ? data.events[data.events.length - 1] : null;
    if (newest && newest.at > graph.lastEventAt) {
      graph.lastEventAt = newest.at;
      for (const event of data.events.slice(-6)) {
        const target = graph.nodes.find((node) => node.id === `user:${event.userId}`);
        if (target) graph.pulses.push({ x: target.x, y: target.y, r: 4, life: 1, color: palette()[target.type] || palette().accent });
      }
    }
  }

  function attachCanvasControls(stage, canvas) {
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      zoomAt(event.offsetX, event.offsetY, factor);
    }, { passive: false });
    canvas.addEventListener('pointerdown', (event) => {
      const point = toWorld(event.offsetX, event.offsetY);
      const hit = hitNode(point.x, point.y);
      if (hit) {
        graph.selected = hit.id;
        inspect(hit);
        return;
      }
      graph.dragging = true;
      graph.lastX = event.offsetX;
      graph.lastY = event.offsetY;
      stage.classList.add('dragging');
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (graph.dragging) {
        graph.offsetX += (event.offsetX - graph.lastX) / graph.scale;
        graph.offsetY += (event.offsetY - graph.lastY) / graph.scale;
        graph.lastX = event.offsetX;
        graph.lastY = event.offsetY;
      } else {
        const point = toWorld(event.offsetX, event.offsetY);
        const hit = hitNode(point.x, point.y);
        graph.hover = hit ? hit.id : null;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
      }
    });
    const stop = () => { graph.dragging = false; stage.classList.remove('dragging'); };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    window.addEventListener('resize', () => { sizeCanvas(); }, { passive: true });
  }

  function toWorld(x, y) {
    return { x: (x - graph.offsetX * graph.scale - (graph.width / 2)) / graph.scale + graph.width / 2, y: (y - graph.offsetY * graph.scale - (graph.height / 2)) / graph.scale + graph.height / 2 };
  }

  function zoomAt(x, y, factor) {
    const before = toWorld(x, y);
    graph.scale = Math.max(0.25, Math.min(4, graph.scale * factor));
    const after = toWorld(x, y);
    graph.offsetX += (after.x - before.x) * 0.9;
    graph.offsetY += (after.y - before.y) * 0.9;
  }

  function zoomBy(factor) {
    zoomAt((graph.width || 800) / 2, (graph.height || 500) / 2, factor);
  }

  function fit() {
    if (!graph.nodes.length) return;
    const xs = graph.nodes.map((node) => node.x);
    const ys = graph.nodes.map((node) => node.y);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = Math.min((graph.width - 80) / width, (graph.height - 80) / height, 1.6);
    graph.scale = Math.max(0.25, scale);
    graph.offsetX = ((minX + maxX) / 2 - graph.width / 2);
    graph.offsetY = ((minY + maxY) / 2 - graph.height / 2);
  }

  function hitNode(x, y) {
    let best = null;
    let bestDistance = Infinity;
    for (const node of graph.nodes) {
      const distance = Math.hypot(node.x - x, node.y - y);
      if (distance < node.size / 2 + 6 && distance < bestDistance) { best = node; bestDistance = distance; }
    }
    return best;
  }

  function step() {
    if (!graph.nodes.length) return;
    const centerX = (graph.width || 800) / 2;
    const centerY = (graph.height || 500) / 2;
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of graph.nodes) {
      node.vx = (node.vx || 0) * 0.86;
      node.vy = (node.vy || 0) * 0.86;
      node.vx += (centerX - node.x) * 0.0016;
      node.vy += (centerY - node.y) * 0.0016;
    }
    for (let i = 0; i < graph.nodes.length; i++) {
      for (let j = i + 1; j < graph.nodes.length; j++) {
        const a = graph.nodes[i];
        const b = graph.nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(12, Math.hypot(dx, dy));
        const force = 4200 / (distance * distance);
        const ux = dx / distance;
        const uy = dy / distance;
        a.vx -= ux * force; a.vy -= uy * force;
        b.vx += ux * force; b.vy += uy * force;
      }
    }
    for (const edge of graph.edges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const target = edge.type === 'member' ? 150 : 110;
      const force = (distance - target) * 0.0026;
      const ux = dx / distance;
      const uy = dy / distance;
      a.vx += ux * force; a.vy += uy * force;
      b.vx -= ux * force; b.vy -= uy * force;
    }
    for (const node of graph.nodes) {
      node.x += Math.max(-6, Math.min(6, node.vx));
      node.y += Math.max(-6, Math.min(6, node.vy));
      node.pulse = Math.max(0, (node.pulse || 0) * 0.94);
    }
    for (const pulse of graph.pulses) { pulse.r += 2.4; pulse.life -= 0.018; }
    graph.pulses = graph.pulses.filter((pulse) => pulse.life > 0);
  }

  function draw() {
    const ctx = graph.ctx;
    if (!ctx) return;
    const P = palette();
    const width = graph.width || 800;
    const height = graph.height || 500;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(graph.scale, graph.scale);
    ctx.translate(-width / 2 + graph.offsetX * 0 - graph.offsetX, -height / 2 - graph.offsetY);
    ctx.translate(graph.offsetX, graph.offsetY);
    ctx.translate(-(width / 2) * (1 - graph.scale) / graph.scale * 0, 0);

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const edge of graph.edges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b) continue;
      const age = Math.min(1, (Date.now() - (edge.lastActivityAt || 0)) / (30 * 60 * 1000));
      ctx.globalAlpha = 0.16 + (1 - age) * 0.5;
      ctx.strokeStyle = P.line;
      ctx.lineWidth = Math.max(0.4, (edge.weight || 1) * 0.9) / graph.scale;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // activity pulses: expanding square frames, no glow, no blur
    for (const pulse of graph.pulses) {
      ctx.globalAlpha = Math.max(0, pulse.life * 0.7);
      ctx.strokeStyle = pulse.color || P.accent;
      ctx.lineWidth = 1.4 / graph.scale;
      const half = pulse.r;
      ctx.strokeRect(pulse.x - half, pulse.y - half, half * 2, half * 2);
    }
    ctx.globalAlpha = 1;
    for (const node of graph.nodes) {
      const style = KIND_STYLE[node.type] || FALLBACK_STYLE;
      const color = P[node.type] || P.lineHard;
      const radius = node.size / 2 + (graph.hover === node.id ? 1.5 : 0);
      const selected = graph.selected === node.id;
      const shape = (x, y, r) => {
        ctx.beginPath();
        if (style.mark === 'round') ctx.arc(x, y, r, 0, Math.PI * 2);
        else if (style.mark === 'diamond') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
        else ctx.rect(x - r, y - r, r * 2, r * 2);
      };
      // flat plate: panel fill, 1px rule, no gradient
      shape(node.x, node.y, radius);
      ctx.fillStyle = P.surface;
      ctx.fill();
      ctx.lineWidth = (selected ? 2.4 : 1) / graph.scale;
      ctx.strokeStyle = selected ? P.accent : color;
      ctx.stroke();
      // a ring mark gets a second, smaller square inside it
      if (style.mark === 'ring') { shape(node.x, node.y, radius * 0.55); ctx.stroke(); }
      const recent = Date.now() - (node.lastActivityAt || 0) < 5 * 60 * 1000;
      if (recent) {
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = 1 / graph.scale;
        ctx.strokeStyle = P.accent;
        const frame = radius + 4;
        ctx.strokeRect(node.x - frame, node.y - frame, frame * 2, frame * 2);
        ctx.globalAlpha = 1;
      }
      if (graph.scale > 0.55 || selected || node.type === 'forum') {
        ctx.font = `${10 / Math.max(0.7, graph.scale)}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
        ctx.fillStyle = selected ? P.accent : P.faint;
        ctx.textAlign = 'center';
        ctx.fillText(String(node.label || '').slice(0, 22).toUpperCase(), node.x, node.y + radius + 14 / graph.scale);
      }
    }
    ctx.restore();
  }

  function tick() {
    if (!graph.running) return;
    step();
    draw();
    requestAnimationFrame(tick);
  }

  async function inspect(node) {
    const host = graph.canvas.parentElement;
    const existing = host.querySelector('.neural-inspector');
    if (existing) existing.remove();
    const panel = el('div', { class: 'neural-inspector' });
    host.append(panel);
    panel.append(el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'node-title', text: node.label }),
        el('div', { class: 'tiny faint', text: `${node.type}${node.sublabel ? ` · ${node.sublabel}` : ''}` }),
      ]),
      el('button', { class: 'btn icon sm subtle', text: '✕', onClick: () => panel.remove() }),
    ]));

    if (node.type === 'user') {
      panel.append(el('div', { class: 'stack-6 pad-8' }, [
        el('div', { class: 'row small' }, [el('span', { class: 'grow', text: 'Messages sent' }), el('span', { class: 'mono', text: String(node.metrics.messages) })]),
        el('div', { class: 'row small' }, [el('span', { class: 'grow', text: 'Files uploaded' }), el('span', { class: 'mono', text: String(node.metrics.files) })]),
        el('div', { class: 'row small' }, [el('span', { class: 'grow', text: 'Community posts' }), el('span', { class: 'mono', text: String(node.metrics.posts) })]),
        el('div', { class: 'row small' }, [el('span', { class: 'grow', text: 'Storage' }), el('span', { class: 'mono', text: UI.bytes(node.metrics.storageBytes) })]),
        el('div', { class: 'row small' }, [el('span', { class: 'grow', text: 'Karma' }), el('span', { class: 'mono', text: String(node.metrics.karma) })]),
        el('div', { class: 'row small' }, [el('span', { class: 'grow', text: 'Last message' }), el('span', { class: 'mono', text: UI.timeAgo(node.metrics.lastMessageAt) })]),
        el('div', { class: 'row small' }, [el('span', { class: 'grow', text: 'Last upload' }), el('span', { class: 'mono', text: UI.timeAgo(node.metrics.lastUploadAt) })]),
        el('div', { class: 'row small' }, [el('span', { class: 'grow', text: 'Last community post' }), el('span', { class: 'mono', text: UI.timeAgo(node.metrics.lastPostAt) })]),
      ]));
      const id = node.id.replace('user:', '');
      panel.append(el('div', { class: 'row pad-8' }, [
        el('button', { class: 'btn sm', text: 'Moderate', onClick: () => openUser(id) }),
        el('button', { class: 'btn sm', text: 'DM code', onClick: async () => {
          const result = await API.post('/api/dm-codes', { userId: id });
          UI.dialog({ title: 'One-time chat code', icon: 'hash', content: el('div', { class: 'stack-8' }, [
            el('div', { class: 'recovery-code', text: result.code, onClick: () => UI.copy(result.code, 'Code copied') }),
            el('div', { class: 'hint', text: 'Single use. The member sees “Server Administration”.' }),
          ]) });
        } }),
      ]));
      return;
    }

    const type = node.type === 'dm' || node.type === 'group' ? 'conversation' : 'forum';
    const id = node.id.replace(/^(conv|forum):/, '');
    const detail = await API.get(`/api/admin/neural/node/${type}/${id}`).catch((error) => ({ error: error.message }));

    if (node.type === 'dm' || node.type === 'group') {
      panel.append(el('div', { class: 'notice-strip', text: 'Channel content is end-to-end encrypted; structure and timing are shown instead of plaintext.' }));
      panel.append(el('div', { class: 'uppercase pad-8', text: 'Members' }));
      for (const member of (detail.node?.members || [])) {
        panel.append(el('div', { class: 'row small pad-8' }, [
          UI.avatar(member, { size: 'xs' }),
          el('div', { class: 'grow' }, [
            el('div', { text: `${member.label} ${member.verified ? '✓' : ''}` }),
            el('div', { class: 'tiny faint', text: `@${member.handle} · last message ${UI.timeAgo(member.lastMessageAt)}` }),
          ]),
        ]));
      }
      panel.append(el('div', { class: 'uppercase pad-8', text: 'Recent encrypted activity' }));
      for (const item of (detail.items || []).slice(0, 20)) {
        panel.append(el('div', { class: 'neural-event' }, [
          el('span', { text: '' }),
          el('div', { class: 'grow' }, [
            el('div', { class: 'small', text: `${item.author?.label || 'member'} · ${UI.timeAgo(item.at)}` }),
            el('div', { class: 'tiny faint', text: `${item.bytes} bytes of ciphertext${item.attachments.length ? ` · ${item.attachments.length} attachment(s)` : ''}` }),
          ]),
        ]));
      }
      return;
    }

    if (node.type === 'forum') {
      const seed = detail.node?.publicSeed;
      panel.append(el('div', { class: 'uppercase pad-8', text: 'Threads' }));
      if (!(detail.items || []).length) panel.append(el('div', { class: 'caption pad-8', text: 'No threads yet.' }));
      for (const thread of (detail.items || []).slice(0, 24)) {
        const row = el('div', { class: 'neural-event' });
        const title = el('div', { class: 'small body-strong', text: thread.deleted ? '(deleted thread)' : 'Decrypting…' });
        const body = el('div', { class: 'tiny faint', text: '' });
        row.append(el('span', { text: '' }), el('div', { class: 'grow' }, [title, body, el('div', { class: 'tiny faint', text: `${thread.postCount} replies · ${UI.timeAgo(thread.lastActivityAt)}` })]));
        row.addEventListener('click', () => openNodeThread(id, thread.id));
        panel.append(row);
        if (seed && thread.title) {
          AE.audienceKey(seed, `forum:${id}`).then(async (key) => {
            const plainTitle = await AE.decryptJson(key, thread.title);
            const plainBody = thread.body ? await AE.decryptJson(key, thread.body) : null;
            title.textContent = (plainTitle && plainTitle.text) || 'Untitled';
            body.textContent = ((plainBody && plainBody.text) || '').slice(0, 160);
          }).catch(() => { title.textContent = '▨ encrypted'; });
        } else if (thread.title) {
          title.textContent = '▨ private community thread';
        }
      }
      return;
    }
  }

  async function openNodeThread(forumId, threadId) {
    const detail = await API.get(`/api/admin/neural/node/thread/${threadId}`).catch(() => null);
    if (!detail) return;
    const node = detail.node;
    const content = el('div', { class: 'stack-8' });
    const titleNode = el('div', { class: 'body-strong', text: 'Decrypting…' });
    const bodyNode = el('div', { class: 'small', text: '' });
    content.append(titleNode, bodyNode);
    const replies = el('div', { class: 'stack-6' });
    content.append(el('div', { class: 'uppercase', text: `Replies (${detail.items.length})` }), replies);
    UI.dialog({ title: forumId, icon: 'console', size: 'wide', content });

    let key = null;
    if (node.publicSeed) key = await AE.audienceKey(node.publicSeed, `forum:${forumId}`);
    if (key) {
      const plainTitle = node.title ? await AE.decryptJson(key, node.title) : null;
      const plainBody = node.body ? await AE.decryptJson(key, node.body) : null;
      titleNode.textContent = (plainTitle && plainTitle.text) || '(untitled)';
      bodyNode.textContent = (plainBody && plainBody.text) || '';
    } else {
      titleNode.textContent = '▨ Private community thread';
      bodyNode.textContent = 'Content stays encrypted — only public community material is reviewable here.';
    }
    for (const item of detail.items) {
      const row = el('div', { class: 'card stack-6' });
      const head = el('div', { class: 'row' }, [
        UI.avatar(item.author || {}, { size: 'xs' }),
        el('div', {}, [
          el('div', { class: 'small', text: item.author?.label || 'member' }),
          el('div', { class: 'tiny faint', text: UI.dateTime(item.at) }),
        ]),
        el('div', { class: 'spacer' }),
        el('span', { class: 'pill tiny', text: `▲${item.karma?.up || 0} ▼${item.karma?.down || 0}` }),
        Object.keys(item.reactions || {}).length ? el('span', { class: 'pill tiny', text: `${Object.keys(item.reactions).length} reactions` }) : null,
      ]);
      const text = el('div', { class: 'small', text: '' });
      row.append(head, text);
      replies.append(row);
      if (key && item.payload) {
        const plain = await AE.decryptJson(key, item.payload).catch(() => null);
        text.textContent = (plain && plain.text) || '(no text)';
      } else if (item.payload) {
        text.textContent = '▨ encrypted reply';
        text.classList.add('faint');
      }
    }
  }

  // Live events feed for the graph
  API.on('neural', (payload) => {
    if (!graph.running || !graph.canvas) return;
    if (payload && payload.event) {
      const label = document.getElementById('neural-last-event');
      if (label) label.textContent = `${payload.event.type} · ${UI.timeAgo(payload.event.at)}`;
      const target = graph.nodes.find((node) => node.id === `user:${payload.event.userId}`);
      if (target) {
        target.pulse = 1;
        graph.pulses.push({ x: target.x, y: target.y, r: 6, life: 1, color: palette()[target.type] || palette().accent });
      }
    }
  });

  return { render, paintSection, openUser };
})();

window.AdminClient = AdminClient;

Apps.register({
  id: 'admin', title: 'Admin Console', icon: 'admin', order: 90, adminOnly: true,
  description: 'Server statistics, moderation, quotas, uploads and the live neural network.',
  keywords: ['admin', 'operator', 'neural', 'moderation', 'requests', 'storage', 'sessions'],
  run: () => Windows.open({
    id: 'admin', title: 'Admin Console', icon: 'admin', geometry: { w: 1180, h: 760 },
    render: (body, api) => AdminClient.render(body, api),
  }),
});

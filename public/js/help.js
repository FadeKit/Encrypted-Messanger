/* ============================================================================
   AE Secure — tutorial, guided tour and the searchable help centre
   ========================================================================== */

const Help = (() => {
  const { el, clear } = UI;

  const ARTICLES = [
    {
      title: 'Getting started',
      tags: ['start', 'first', 'setup', 'register', 'account', 'begin'],
      summary: 'Create an account, save your five backup codes, and learn how the vault unlocks.',
      body: 'Registration generates your identity key pair (ECDH P-256) entirely inside the browser. Your passphrase is stretched with PBKDF2-SHA256 at 210 000 iterations against two independent salts: one derives the authKey that proves who you are, the other derives the vaultKey that unwraps your master key. The server only ever receives the authKey hash. Save the five backup codes when they are shown — they are displayed exactly once.',
    },
    {
      title: 'How encryption works',
      tags: ['encryption', 'aes', 'gcm', 'aes-gcm-256', 'zero knowledge', 'e2ee', 'ciphertext'],
      summary: 'AES-GCM-256 everywhere, ECDH-wrapped channel keys, per-chunk IVs, and what the server can see.',
      body: 'Direct messages and group chats use a per-channel AES-GCM-256 key. That key is wrapped for each member with a key derived from ECDH P-256 plus HKDF-SHA256, so the server stores wrapped copies it cannot open. File attachments are sealed with their own random key and uploaded as 512 KiB encrypted chunks; every chunk carries a fresh 12-byte IV and its index is authenticated as additional data, which prevents reordering or swapping chunks. The server keeps ciphertext, wrapped keys, account metadata (handle, avatar, limits, sessions) and traffic counters.',
    },
    {
      title: 'Passphrase rules',
      tags: ['passphrase', 'password', 'strength', 'change passphrase'],
      summary: 'Twelve characters minimum, and it never leaves the device.',
      body: 'Your passphrase protects the vault key. There is no reset link and no recovery email: the only way back into an account is a one-time backup code. Use a long phrase you can remember; three or four unrelated words plus a number is stronger than a short complicated string. Changing the passphrase re-seals the vault; you can keep other sessions alive or sign them all out in the same step.',
    },
    {
      title: 'Backup codes',
      tags: ['backup', 'codes', 'recovery code', 'lost device', 'stolen', 'hacked', 'restore'],
      summary: 'Five single-use codes that restore ownership of an account.',
      body: 'Each code restores the account once and is then burned. Use them when a device is lost, when a passphrase is forgotten, or when someone else has taken over the account: sign in with a backup code, set a new passphrase, and every other device is signed out immediately. If the intruder changed the passphrase first, a backup code is still enough — it unwraps the vault independently of the passphrase. Generate a fresh set from Settings → Storage & requests → Backup codes whenever you want; the old set stops working instantly. Tell the operator if you believe an account was targeted so they can review the session list.',
    },
    {
      title: 'Sessions',
      tags: ['sessions', 'devices', 'sign out', 'log out', 'revoke', 'hacked'],
      summary: 'See every signed-in device and end any of them.',
      body: 'Settings → Account & security lists each session with device, platform, rough IP and last activity. “Sign out on all devices” ends everything including the current one. Administrators can also end a session for you from the member panel if you ask them to.',
    },
    {
      title: 'Availability status',
      tags: ['status', 'online', 'idle', 'invisible', 'do not disturb', 'dnd', 'purple status', 'activity'],
      summary: 'Online, Idle, Do Not Disturb, Invisible and the requestable purple ring.',
      body: 'By default presence is automatic: active means Online, three minutes of silence switches to Idle, and two more minutes of silence drops you to Offline. Manual overrides stick until you clear them: Idle keeps you looking idle while you are actually reading, Invisible appears offline the whole time, and Do Not Disturb still delivers notifications. Purple is an alternative online ring that an administrator must grant — request it in Settings → Storage & requests and it becomes selectable once approved. Turning off “Share activity status” hides your presence from everyone.',
    },
    {
      title: 'Airdrop delivery',
      tags: ['airdrop', 'drop', 'send', 'share', 'broadcast'],
      summary: 'Send encrypted drops to every online member at once.',
      body: 'Airdrop is off by default. When it is on, an airdrop mark (⇣) appears in the tray with a badge counting drops received while you were online, and you can send text, images or files to everyone who currently has airdrop on and is online. Each drop key is wrapped individually per recipient with ECDH, so recipients can open it but the server cannot. If nobody is online, the drop goes nowhere — except for operators, who always receive drops even offline.',
    },
    {
      title: 'Stories',
      tags: ['stories', 'story', '24 hours', 'expire', 'public'],
      summary: 'Ephemeral public media that expires 24 hours after posting.',
      body: 'Stories appear in the Public square and on your public profile for exactly 24 hours, then the server purges both the record and the ciphertext. Each item can be up to 1 GB. Story storage is tracked separately from messaging and drive uploads in the operator console.',
    },
    {
      title: 'Public profile',
      tags: ['public profile', 'alias', 'bio', 'public account', 'profile photos'],
      summary: 'An optional public identity with alias, bio and permanent photos.',
      body: 'Off by default. When enabled, your alias is shown before your coded handle in the public square, your bio and up to eight permanent photos appear on your profile, and you can post stories and public messages. Turning the switch off hides all of it from other members immediately — nothing is deleted, and switching back on restores everything. Public content is sealed with an audience key that is published only while your profile is on.',
    },
    {
      title: 'Communities and forums',
      tags: ['communities', 'forum', 'threads', 'public community', 'private community', 'posts'],
      summary: 'Public squares anyone can read, or private rooms gated by wrapped keys.',
      body: 'A public community is readable and writable by any signed-in member; its content is sealed with the community audience key so the server still stores ciphertext. A private community issues a wrapped key to each member, and membership is under the owner’s control. Media in communities is off by default and gated by your own client setting — turn on “Media in communities and public posts” to attach or view images.',
    },
    {
      title: 'Reactions, votes and karma',
      tags: ['reactions', 'emoji', 'votes', 'upvote', 'downvote', 'karma'],
      summary: 'Emoji reactions plus an up/down vote that only operators can total up.',
      body: 'Any message or post can carry reactions (the reaction button or the three-dot menu). Votes work like a community score: upvote, downvote, or clear your vote. You cannot vote on your own content. Karma totals are visible only to administrators, who see both the votes you received and the votes you cast.',
    },
    {
      title: 'Message actions menu',
      tags: ['three dots', 'menu', 'reply', 'edit', 'delete message', 'dots'],
      summary: 'Reply, react, vote, copy, edit — and who is allowed to delete.',
      body: 'The ⋯ menu on any message offers reply, reactions, votes, copy and edit (for your own messages). Deletion is deliberately restricted: in direct messages and group chats no member can delete a message, though operators can remove anything. In public communities the author may delete their own post or thread, and operators may delete anything anywhere. Nothing is ever hard-deleted from your own screen until you reload — the ciphertext is replaced with a removal marker.',
    },
    {
      title: 'Console and activity log',
      tags: ['console', 'log', 'activity', 'taskbar', 'command line', 'debug', 'terminal'],
      summary: 'A visual-only readout of client activity, with a command line that changes nothing outside this device.',
      body: 'The console opens from the taskbar, from Start, or with Ctrl+Shift+O. It logs local events as they happen: the realtime link going up or down, inbound and outbound message counts, channel and key changes, notice levels, and request lines whose record ids are masked to “•••”. It never records message text, files, keys, tokens or account names, and it cannot change server state. Its command line accepts help, clear, status, log on|off, theme, accent, wall, open, lock, whoami, net, time and ver — each of them local to this tab.',
    },
    {
      title: 'One-time DM codes',
      tags: ['dm code', 'one time code', 'contact admin', 'operator chat', 'redeem'],
      summary: 'A single-use code that opens a masked channel with the operator.',
      body: 'Generate a code in Settings → Storage & requests and hand it to the operator through any channel you trust. When they redeem it, a private conversation opens and they appear as “Server Administration” — their account name is never exposed. Operators can also issue a code targeted at one member, which that member redeems to open the same kind of masked channel. A code works once, expires after 72 hours and cannot be reused.',
    },
    {
      title: 'Storage requests',
      tags: ['storage request', 'quota', 'limit', 'upload limit', 'drive quota', 'request more'],
      summary: 'Ask for more upload space, drive space, story size or the purple status.',
      body: 'Defaults are 15 MB per message attachment, 1 GB of drive storage and 1 GB per story item, and nothing is increased automatically. File a request and the operator approves it with a specific size, approves it as unlimited, or denies it — in which case your current limits stay exactly as they were. You get a notification with the decision and any note the operator attached, and the new limit applies to your next upload immediately.',
    },
    {
      title: 'Cloud drive',
      tags: ['drive', 'cloud', 'storage', 'folders', 'upload drive'],
      summary: 'Encrypted personal storage where uploads are limited only by remaining space.',
      body: 'Drive files are sealed with your master key, so only your devices can read them. Filenames live inside encrypted metadata. Inside the drive the only limit on a single file is how much space remains in your quota — a 900 MB file fits in a 1 GB drive as long as only 100 MB is used. Folders are created per account and names stay encrypted.',
    },
    {
      title: 'My files',
      tags: ['files', 'uploads', 'attachments', 'my uploads'],
      summary: 'Everything you have uploaded, grouped by destination.',
      body: 'My Files groups your ciphertext blobs by surface: chat attachments, community media, drive files, stories, airdrops, avatars and public posts. Deleting a blob returns the space immediately and removes the ciphertext from the server; members who already decrypted a file keep their own copy.',
    },
    {
      title: 'Media in communities and public posts',
      tags: ['forum media', 'media', 'images', 'communities media', 'default off'],
      summary: 'A client setting, off by default, that unlocks images in communities.',
      body: 'Off by default. While it is off you cannot upload images to communities or the public square, and images other people posted are not decrypted or displayed for you. Turning it on lets you attach images and see community media. It is enforced on both the client and the server for your own uploads.',
    },
    {
      title: 'Feature switches',
      tags: ['feature switches', 'disable features', 'turn off', 'clutter', 'clean menu'],
      summary: 'Turn individual features off for your account alone.',
      body: 'Settings → General → Feature switches lets you disable things you never use: file uploads, the drive, stories, profile pictures, direct messages, community replies, reactions, voting, one-time codes, emoji picker, editing, typing indicators, presence sharing, the Click Me box, search fields and toasts. Disabled features are hidden from menus and refused by the interface so you cannot trigger them by accident. Nothing changes for other members.',
    },
    {
      title: 'Appearance',
      tags: ['appearance', 'theme', 'accent', 'signal', 'monochrome', 'grey', 'gray', 'ink', 'chamfer', 'blur', 'backdrop', 'wallpaper', 'taskbar', 'nox', 'acid', 'sector', 'ice', 'chrome'],
      summary: 'Greyscale themes, one optional signal colour, backdrop and interface scale.',
      body: 'The interface is printed, not lit: flat plates, 1px ink rules, hard offset shadows, monospaced labels and heavy uppercase titles. There are no gradients, no glow, no glass and no rounded corners anywhere — an optional chamfer cuts one corner of a plate and nothing curves. Four ink-dark themes ship (NOX ink black, ACID bone and graphite, SECTOR carbon, ICE frost) plus CHROME, a paper theme with black ink. Every theme is a pure greyscale ramp, so the interface is monochrome out of the box; the signal setting is the only colour it is allowed, and it defaults to INK, taken from the theme itself. Choosing a hue switches focus rings, selection and active marks to that print-muted ink, and on the paper theme every hue is darkened automatically so it stays legible. Panel opacity is 100% out of the box — lower it only if you want transparency, in which case backdrop blur becomes relevant. Interface scale rescales type and controls together.',
    },
    {
      title: 'Accessibility',
      tags: ['accessibility', 'contrast', 'dyslexia', 'motion', 'colour blind', 'focus', 'line spacing', 'legibility'],
      summary: 'Contrast, dyslexia font, spacing, colour-blind filters and motion.',
      body: 'Every accessibility option is applied locally in your browser. High contrast doubles every rule to 2px, promotes faint text to full ink and makes all panels opaque — the clearest possible read. The dyslexia-friendly font widens spacing across the interface, line spacing is adjustable, and focus outlines keep keyboard navigation visible. Colour-blind filters shift hues, and only matter if you chose a signal colour: the default interface is greyscale, which no filter can disturb. Reduce motion stops every transition and animation, which also saves battery on the phone hosting your server.',
    },
    {
      title: 'Window management',
      tags: ['windows', 'drag', 'snap', 'maximize', 'minimize', 'shortcuts', 'plates'],
      summary: 'Move, resize, snap and stack window plates.',
      body: 'Drag a title bar to move a window; drag it to an edge or a screen corner to snap it into halves or quarters. Every window remembers its position and size. The focused plate draws its corner brackets in the signal colour and thickens its left rule so you always know which surface has input. Caption buttons minimise, maximise and close, Ctrl+W closes the focused window, Ctrl+M minimises it, and Ctrl+` cycles between open windows. On phones every window becomes a full-screen surface with a back arrow.',
    },
    {
      title: 'Click Me',
      tags: ['click me', 'clicker', 'gag', 'fun', 'counter'],
      summary: 'The shared global counter available to every member.',
      body: 'A single counter for the whole server, split into all-time and this-week totals. Anyone can click, everyone sees the total rise in real time, and your own contribution is counted privately. Hide it in Settings → Privacy if it is not your thing.',
    },
    {
      title: 'Operator console',
      tags: ['admin', 'operator', 'console', 'admin panel'],
      summary: 'What administrators can and cannot see.',
      body: 'Administrators see server statistics (uptime, memory, storage split, traffic), member lists with avatars, per-user limits, sessions with devices and IPs, request queues, every uploaded blob with owner and size, story storage, karma totals, the audit log and global switches. They cannot see message text, file names, file contents or drive data — those are encrypted with keys the server never receives.',
    },
    {
      title: 'Neural network view',
      tags: ['neural', 'graph', 'visualiser', 'spider web', 'network', 'admin'],
      summary: 'A live map of how the platform is growing, with zoom and drill-down.',
      body: 'Every member, channel and community becomes a node; participation becomes an edge. Nodes brighten and pulse when something happens, and the graph keeps growing as the server grows. Scroll to zoom, drag to pan, click a node to inspect it, and use the inspector to open a community or thread to read the title, body and replies. Public communities can be decrypted there for moderation; direct messages stay encrypted and are shown as structure and timing only. The graph only polls while the console window is open and the tab is visible, so it costs the host nothing while you are away.',
    },
    {
      title: 'Requests queue (operator)',
      tags: ['requests', 'approve', 'deny', 'operator', 'queue'],
      summary: 'Approve with a size, approve as unlimited, or deny and leave limits untouched.',
      body: 'Each request shows the member, their current limits, what they asked for and their message. Approving applies the new value instantly and notifies the member; approving with “unlimited” removes the ceiling entirely. Denying records a decision and a note but changes nothing. Purple and blue-check requests are capability requests and approve with a single click.',
    },
    {
      title: 'Moderation tools',
      tags: ['moderation', 'ban', 'suspend', 'disable', 'delete account', 'admin'],
      summary: 'Suspend, disable, verify, grant purple, adjust limits, delete content.',
      body: 'From the member panel an operator can add the blue check mark, unlock purple status, suspend an account (blocks sign-in and ends sessions), disable it without deleting anything, adjust every limit, reset drive usage, end sessions, generate a one-time DM code, and delete blobs. Private chats and group messages can be removed by operators; public community content can be removed by its author as well.',
    },
    {
      title: 'Usage agreement and non-liability',
      tags: ['terms', 'agreement', 'liability', 'legal', 'notice', 'non-liability'],
      summary: 'The agreement every member accepts, and what the operator is not responsible for.',
      body: 'The agreement states plainly that the operator hosts software, stores ciphertext and metadata, takes no part in what members send or publish, and cannot be held liable for content shared, posted, uploaded or viewed through the instance, nor for legal action arising from it. Accepting the notice records the version and timestamp on your account; the operator can bump the version to re-present it after changes.',
    },
    {
      title: 'Self-hosting on a phone',
      tags: ['termux', 'self host', 'phone', 'hosting', 'android', 'battery', 'performance'],
      summary: 'Running the server from Termux and keeping it fast.',
      body: 'The server has no third-party dependencies, so it runs comfortably from Termux: start it with npm start, keep the process alive with a wake lock, and open the printed network URL from other devices on the same Wi-Fi. The interface is tuned for that: panel opacity instead of heavy blur, a backdrop you can switch to void, and Reduce motion that stops every ambient animation. Data lives in the data/ directory — copy that folder to back the server up, and remember the operator cannot restore member keys.',
    },
    {
      title: 'Keyboard shortcuts',
      tags: ['shortcuts', 'keyboard', 'hotkeys'],
      summary: 'Everything reachable without a mouse.',
      body: 'Ctrl+Esc opens the start menu with the search field focused. Esc closes flyouts and dialogs. Ctrl+W closes the focused window, Ctrl+M minimises it, and Ctrl+` cycles between open windows. Enter sends a message (Shift+Enter adds a line) unless you change that in General. Alt+numbers are intentionally left to the browser.',
    },
  ];

  function search(query) {
    const text = String(query || '').trim().toLowerCase();
    if (!text) return ARTICLES;
    const words = text.split(/\s+/).filter(Boolean);
    return ARTICLES
      .map((article) => {
        const haystack = `${article.title} ${article.tags.join(' ')} ${article.summary} ${article.body}`.toLowerCase();
        let score = 0;
        for (const word of words) {
          if (!haystack.includes(word)) continue;
          if (article.title.toLowerCase().includes(word)) score += 6;
          if (article.tags.some((tag) => tag.includes(word))) score += 4;
          score += 1;
        }
        return { article, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.article);
  }

  function open(query = '') {
    const searchInput = el('input', { class: 'input', placeholder: 'Search the manual — try “backup codes”, “airdrop”, “drive quota”…', value: query || '' });
    const list = el('div', { class: 'stack-6' });
    const paint = () => {
      clear(list);
      const matches = search(searchInput.value).slice(0, 40);
      if (!matches.length) {
        list.append(UI.empty('⌕', 'Nothing matched', 'Try the exact name of a setting or feature.'));
        return;
      }
      for (const article of matches) {
        const node = el('div', { class: 'help-article', style: { cursor: 'pointer' }, onClick: () => article_(article) }, [
          el('h4', { text: article.title }),
          el('div', { class: 'body', text: article.summary }),
          el('div', { class: 'row' }, [
            el('span', { class: 'tiny faint', text: article.tags.slice(0, 6).join(' · ') }),
            el('div', { class: 'spacer' }),
            el('span', { class: 'tiny accent', text: 'Read →' }),
          ]),
        ]);
        list.append(node);
      }
    };
    paint();
    searchInput.addEventListener('input', paint);
    const dialog = UI.dialog({
      title: 'Help centre',
      glyph: '▣',
      size: 'wide',
      subtitle: `${ARTICLES.length} articles · settings docs · feature walkthroughs`,
      content: el('div', { class: 'stack-12' }, [
        el('div', { class: 'row' }, [
          el('div', { class: 'search-box grow' }, [searchInput]),
          el('button', { class: 'btn', text: 'Guided tour', onClick: () => { dialog.close(); tutorial(); } }),
        ]),
        list,
      ]),
      footer: [
        el('button', { class: 'btn', text: 'Usage agreement', onClick: () => Terms.show() }),
        el('button', { class: 'btn primary', text: 'Close', onClick: () => dialog.close() }),
      ],
    });
    return dialog;
  }

  function article_(article) {
    UI.dialog({
      title: article.title,
      glyph: '▣',
      size: 'wide',
      subtitle: article.tags.slice(0, 6).join(' · '),
      content: el('div', { class: 'stack-8' }, [
        el('div', { class: 'notice-strip', html: `<span>▸</span><span>${UI.esc(article.summary)}</span>` }),
        el('div', { class: 'small', style: { lineHeight: '1.65' }, text: article.body }),
        el('div', { class: 'row' }, [
          el('span', { class: 'tiny faint', text: `Search this title in Settings or the start menu to jump straight there.` }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn sm', text: 'Search again', onClick: () => open(article.title) }),
        ]),
      ]),
    });
  }

  // --------------------------------------------------------------- tutorial
  const TOUR = [
    {
      title: 'Welcome to AE Secure',
      body: 'This tour walks through the whole interface. Everything you send is encrypted on this device before it travels — the server forwards ciphertext it cannot read.',
      target: null,
    },
    {
      title: 'Your desktop',
      body: 'Shortcut icons launch each surface. Windows are movable, resizable plates with corner brackets, and they remember the position you leave them in. On a phone they open full-screen with a back arrow.',
      target: '#desktop-icons',
    },
    {
      title: 'The taskbar',
      body: 'Pinned apps sit here with running indicators. The tray on the right shows your availability, the clock, and the airdrop inbox with its badge.',
      target: '#taskbar',
      before: () => { UI.$('#start-menu')?.classList.remove('open'); },
    },
    {
      title: 'Start menu',
      body: 'Ctrl+Esc opens Start. Search jumps to any app or help article instantly — typing a setting name such as “backup codes” lands on the article that explains it fully.',
      target: '#start-menu',
      before: () => { UI.$('#start-menu')?.classList.add('open'); UI.$('#start-search')?.focus(); },
      after: () => { UI.$('#start-menu')?.classList.remove('open'); },
    },
    {
      title: 'Messages',
      body: 'Direct and group conversations with reactions, votes, replies, encrypted attachments and typing indicators. Group chats are owned by whoever created them; direct messages belong to nobody.',
      target: () => Windows.get('messages')?.node || '.window',
      before: () => Apps.open('messages'),
    },
    {
      title: 'Communities',
      body: 'Public squares are readable by every member; private rooms hand out wrapped keys instead. Media in communities is off by default and unlocked in Settings.',
      target: () => Windows.get('communities')?.node || '.window',
      before: () => Apps.open('communities'),
    },
    {
      title: 'Public square and stories',
      body: 'Stories expire 24 hours after posting and live on your public profile, which is off by default. Turn it on to publish an alias, bio, photos and posts.',
      target: () => Windows.get('stories')?.node || '.window',
      before: () => Apps.open('stories'),
    },
    {
      title: 'Airdrop',
      body: 'Enable airdrop to receive drops instantly while you are online. The airdrop mark in the tray shows how many are waiting.',
      target: '#tb-airdrop',
      before: () => Apps.open('airdrop'),
    },
    {
      title: 'Cloud drive',
      body: 'Encrypted storage where a file is only limited by the space that remains. Ask for more capacity from Settings and an operator decides on it.',
      target: () => Windows.get('drive')?.node || '.window',
      before: () => Apps.open('drive'),
    },
    {
      title: 'Console',
      body: 'The console on the taskbar shows what this client is doing: link state, message counts, key changes and request shapes, with record ids masked. It is a readout only — no message text, files or keys are recorded — and its command line changes nothing beyond this device.',
      target: '#tb-console',
      before: () => ConsoleLog.open(),
      after: () => ConsoleLog.close(),
    },
    {
      title: 'Settings',
      body: 'Theme, accessibility, privacy, feature switches, storage requests, backup codes, sessions and this help centre all live here. Each setting has a short description, and the ❔ button opens its long-form article.',
      target: () => Windows.get('settings')?.node || '.window',
      before: () => Apps.open('settings'),
    },
    {
      title: 'Requests and operator contact',
      body: 'Request larger attachments, more drive space, bigger stories or the purple status. You can also generate a one-time code to open a masked channel with the operator without ever learning their account name.',
      target: null,
      before: () => Apps.open('settings', { section: 'requests' }),
    },
    {
      title: 'You are set',
      body: 'Press Ctrl+Esc any time and search “how do I” topics in the help centre. Your backup codes are the single most important thing to keep safe — store them offline.',
      target: null,
    },
  ];

  let tourState = null;

  function tutorial() {
    if (tourState) stopTour();
    tourState = { index: 0, spotlight: el('div', { class: 'tutorial-spotlight', style: { display: 'none' } }), card: el('div', { class: 'tutorial-card' }) };
    document.body.append(tourState.spotlight, tourState.card);
    paintTour();
  }

  function stopTour() {
    if (!tourState) return;
    tourState.spotlight.remove();
    tourState.card.remove();
    tourState = null;
  }

  function paintTour() {
    if (!tourState) return;
    const step = TOUR[tourState.index];
    if (step.before) { try { step.before(); } catch { /* ignore */ } }
    const spotlight = tourState.spotlight;
    const card = tourState.card;

    let targetNode = null;
    try {
      targetNode = typeof step.target === 'function' ? step.target() : (step.target ? UI.$(step.target) : null);
    } catch { targetNode = null; }

    clear(card);
    card.append(
      el('div', { class: 'step-count', text: `Step ${tourState.index + 1} of ${TOUR.length}` }),
      el('div', { class: 'title-3', text: step.title }),
      el('div', { class: 'small muted', style: { marginTop: '6px' }, text: step.body }),
      el('div', { class: 'tutorial-progress' }, TOUR.map((_, index) => el('i', { class: index <= tourState.index ? 'done' : '' }))),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn sm', text: 'Skip tour', onClick: () => { if (step.after) step.after(); stopTour(); } }),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn sm', text: '‹ Back', disabled: tourState.index === 0, onClick: () => { if (tourState.index > 0) { tourState.index--; paintTour(); } } }),
        el('button', {
          class: 'btn sm primary',
          text: tourState.index === TOUR.length - 1 ? 'Finish' : 'Next ›',
          onClick: () => {
            if (step.after) step.after();
            if (tourState.index === TOUR.length - 1) stopTour();
            else { tourState.index++; paintTour(); }
          },
        }),
      ]),
    );

    if (targetNode && targetNode.getBoundingClientRect) {
      const rect = targetNode.getBoundingClientRect();
      Object.assign(spotlight.style, {
        display: 'block',
        left: `${Math.max(4, rect.left - 6)}px`,
        top: `${Math.max(4, rect.top - 6)}px`,
        width: `${Math.min(window.innerWidth - 8, rect.width + 12)}px`,
        height: `${Math.min(window.innerHeight - 8, rect.height + 12)}px`,
      });
      const below = rect.bottom + 190 < window.innerHeight;
      card.style.left = `${Math.min(window.innerWidth - 420, Math.max(12, rect.left))}px`;
      card.style.top = `${below ? rect.bottom + 14 : Math.max(12, rect.top - 230)}px`;
    } else {
      spotlight.style.display = 'none';
      card.style.left = `${Math.max(12, window.innerWidth / 2 - 200)}px`;
      card.style.top = `${Math.max(12, window.innerHeight / 2 - 140)}px`;
    }
  }

  return { open, search, tutorial, stopTour, ARTICLES };
})();

window.Help = Help;

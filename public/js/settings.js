/* ============================================================================
   AE Secure — settings: personalisation, accessibility, privacy, requests
   ========================================================================== */

const Settings = (() => {
  const { el, clear } = UI;
  let current = 'general';

  const FEATURES = [
    ['uploads', 'File uploads', 'Attachments in chats, communities and the drive. Turn off to avoid accidental uploads.'],
    ['drive', 'Cloud drive', 'The drive window, folders and storage requests.'],
    ['stories', 'Public square & stories', 'Public profiles, 24-hour stories and public posts.'],
    ['avatar', 'Profile pictures', 'Uploading and changing your avatar.'],
    ['dms', 'Direct messages', 'Starting new one-to-one conversations.'],
    ['forumReply', 'Replying in communities', 'Posting replies inside threads.'],
    ['communityPosts', 'Creating threads and communities', 'Starting new discussions or public squares.'],
    ['reactions', 'Reactions', 'Reacting to messages, posts and stories with emoji.'],
    ['votes', 'Up- and down-voting', 'Voting on other members’ messages and posts.'],
    ['dmCodes', 'One-time DM codes', 'Generating or redeeming operator chat codes.'],
    ['adminChat', 'Operator chat', 'Contacting the administration through settings.'],
    ['emojiPicker', 'Emoji picker', 'The quick emoji row in the composer.'],
    ['messageEdit', 'Editing messages', 'Editing your own messages after sending.'],
    ['typingIndicator', 'Typing indicator', 'Sharing when you are typing and seeing others.'],
    ['presence', 'Presence sharing', 'Letting other members see your availability.'],
    ['clickMe', 'Click Me counter', 'The shared global click box in settings.'],
    ['search', 'Search fields', 'Search boxes in the start menu, help and lists.'],
    ['notifications', 'In-app notifications', 'Toast notifications for new activity.'],
  ];

  const MENUS = [
    ['messages', '▤ Messages'], ['communities', '▩ Communities'], ['stories', '◉ Public square'],
    ['drive', '▦ Cloud drive'], ['files', '▥ My files'], ['airdrop', '⇣ Airdrop'], ['admin', '⬢ Admin console'],
  ];

  const SECTIONS = [
    ['general', '01', 'General'],
    ['appearance', '02', 'Appearance'],
    ['accessibility', '03', 'Accessibility'],
    ['notifications', '04', 'Notifications'],
    ['privacy', '05', 'Privacy & activity'],
    ['requests', '06', 'Storage & requests'],
    ['public', '07', 'Public profile'],
    ['account', '08', 'Account & security'],
    ['tutorial', '09', 'Tutorial & help'],
    ['about', '10', 'About'],
  ];

  const BUILDERS = {
    general: paintGeneral,
    appearance: paintAppearance,
    accessibility: paintAccessibility,
    notifications: paintNotifications,
    privacy: paintPrivacy,
    requests: paintRequests,
    public: paintPublic,
    account: paintAccount,
    tutorial: paintTutorial,
    about: paintAbout,
  };

  let viewBody = null;
  let viewApi = null;

  function render(body, api, section) {
    if (section && SECTIONS.some(([id]) => id === section)) current = section;
    viewBody = body;
    viewApi = api;
    clear(body);
    const shell = el('div', { class: 'settings-shell' });
    const nav = el('div', { class: 'settings-nav' });
    const host = el('div', { class: 'settings-body' });
    shell.append(nav, host);
    body.append(shell);
    api.setToolbar([]);

    for (const [id, glyph, label] of SECTIONS) {
      nav.append(el('button', { class: id === current ? 'on' : '', onClick: () => { current = id; render(body, api); } }, [el('span', { class: 'glyph', text: glyph }), el('span', { text: label })]));
    }
    const fragment = document.createDocumentFragment();
    (BUILDERS[current] || paintGeneral)(fragment);
    host.append(fragment);
  }

  // ----------------------------------------------------------- primitives
  // Section heading: one mono label and a rule. Per-row descriptions carry the
  // detail; a paragraph of prose above every section was noise.
  function heading(glyph, title) {
    return el('div', { class: 'section-title' }, [
      el('span', { class: 'glyph', text: glyph }),
      el('div', { class: 'title-3', text: title }),
    ]);
  }

  function row(name, description, control, helpKey) {
    const info = el('div', { class: 'info' }, [
      el('div', { class: 'name' }, [
        el('span', { text: name }),
        helpKey ? el('button', { class: 'btn icon sm subtle', text: '?', title: 'Explain this setting', onClick: () => Help.open(helpKey) }) : null,
      ]),
      el('div', { class: 'desc', text: description }),
    ]);
    return el('div', { class: 'setting-row' }, [info, el('div', { class: 'control' }, [control])]);
  }

  function switchControl(value, onChange) {
    const input = el('input', { type: 'checkbox', checked: !!value });
    input.addEventListener('change', () => onChange(input.checked));
    return el('span', { class: 'switch' }, [input, el('span', { class: 'track' }), el('span', { class: 'knob' })]);
  }

  function selectControl(value, options, onChange) {
    const select = el('select', { class: 'select' }, options.map(([optionValue, label]) => el('option', { value: optionValue, text: label, selected: optionValue === value })));
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function sliderControl(value, min, max, step, onChange, format = (v) => v) {
    const input = el('input', { class: 'slider', type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    const label = el('span', { class: 'tiny mono nowrap', text: format(value) });
    input.addEventListener('input', () => { label.textContent = format(Number(input.value)); });
    input.addEventListener('change', () => onChange(Number(input.value)));
    return el('div', { class: 'row', style: { gap: '10px', minWidth: '190px' } }, [input, label]);
  }

  async function save(patch) {
    await State.saveSettings(patch);
    Shell.applyTheme();
  }

  // ------------------------------------------------------------- general
  function paintGeneral(fragment) {
    const settings = State.settings();
    fragment.append(heading('GEN', 'General'));

    const display = el('input', { class: 'input', value: State.user.displayName || '' });
    const bio = el('textarea', { class: 'textarea', value: State.user.bio || '' });
    fragment.append(heading('ID', 'Profile'));
    fragment.append(row('Display name', 'Shown next to your coded handle. Your handle never changes.', display));
    fragment.append(row('Private bio', 'Only visible to you and administrators.', bio, 'Private bio'));
    fragment.append(el('div', { class: 'setting-row' }, [
      el('div', { class: 'info' }, [el('div', { class: 'name', text: 'Save profile' })]),
      el('div', { class: 'control' }, [el('button', { class: 'btn primary', text: 'Save', onClick: async () => {
        const updated = await API.patch('/api/profile', { displayName: display.value.trim(), bio: bio.value.trim() });
        State.set('user', updated.user);
        UI.toast({ level: 'success', title: 'Profile saved' });
      } })]),
    ]));

    fragment.append(heading('I/O', 'Messaging'));
    fragment.append(row('Enter sends the message', 'When off, Enter adds a new line and Ctrl+Enter sends.', switchControl(settings.enterToSend, (value) => save({ enterToSend: value })), 'Enter sends the message'));
    fragment.append(row('Timestamp style', 'Relative (“4m ago”) or absolute clock times.', selectControl(settings.timestamps, [['relative', 'Relative'], ['absolute', 'Absolute']], (value) => save({ timestamps: value })), 'Timestamp style'));

    fragment.append(heading('UI', 'Layout'));
    const order = [...(settings.layout.order || [])];
    const orderHost = el('div', { class: 'stack-4' });
    const paintOrder = () => {
      clear(orderHost);
      order.forEach((id, index) => {
        const meta = MENUS.find(([key]) => key === id) || [id, id];
        orderHost.append(el('div', { class: 'list-item' }, [
          el('span', { text: meta[1] }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn icon sm subtle', text: '▲', disabled: index === 0, onClick: () => { [order[index - 1], order[index]] = [order[index], order[index - 1]]; paintOrder(); save({ layout: { order } }); } }),
          el('button', { class: 'btn icon sm subtle', text: '▼', disabled: index === order.length - 1, onClick: () => { [order[index + 1], order[index]] = [order[index], order[index + 1]]; paintOrder(); save({ layout: { order } }); } }),
        ]));
      });
    };
    paintOrder();
    fragment.append(el('div', { class: 'setting-row' }, [
      el('div', { class: 'info' }, [el('div', { class: 'name', text: 'Surface order' }), el('div', { class: 'desc', text: 'Controls the order of pinned surfaces in the start menu and taskbar.' })]),
      el('div', { class: 'control' }, [orderHost]),
    ]));
    for (const [id, label] of MENUS) {
      fragment.append(row(`Show ${label.split(' ').slice(1).join(' ') || label}`, 'Hide this surface completely from your menus, taskbar and start screen.', switchControl(!(settings.layout.hidden || []).includes(id), (value) => {
        const hidden = new Set(settings.layout.hidden || []);
        if (value) hidden.delete(id); else hidden.add(id);
        save({ layout: { hidden: [...hidden] } });
      })));
    }
    fragment.append(row('Compact sidebar lists', 'Tighter rows in list panes, useful on small screens.', switchControl(settings.layout.sidebarCompact, (value) => save({ layout: { sidebarCompact: value } })), 'Compact sidebar lists'));

    fragment.append(heading('SYS', 'Feature switches'));
    const disabled = settings.disabledFeatures || {};
    for (const [key, label, description] of FEATURES) {
      fragment.append(row(label, description, switchControl(disabled[key] !== true, (value) => {
        const next = Object.assign({}, disabled);
        next[key] = !value;
        save({ disabledFeatures: next });
      }), label));
    }

    fragment.append(heading('DEV', 'Advanced'));
    const css = el('textarea', { class: 'textarea', placeholder: '/* custom css */', value: settings.customCss || '' });
    fragment.append(el('div', { class: 'setting-row' }, [
      el('div', { class: 'info' }, [el('div', { class: 'name', text: 'Custom CSS' }), el('div', { class: 'desc', text: 'Applied only in your browser. 20 KB limit. Use it to fine-tune anything the theme controls miss.' })]),
      el('div', { class: 'control', style: { flexDirection: 'column', alignItems: 'stretch' } }, [css, el('button', { class: 'btn sm', text: 'Apply CSS', onClick: () => save({ customCss: css.value.slice(0, 20000) }) })]),
    ], 'Custom CSS'));
  }

  // ------------------------------------------------------------ appearance
  function paintAppearance(fragment) {
    const settings = State.settings();
    fragment.append(heading('VIS', 'Appearance'));

    const themes = [['nox', 'NOX · ink black'], ['acid', 'ACID · bone and graphite'], ['sector', 'SECTOR · carbon'], ['ice', 'ICE · frost'], ['chrome', 'CHROME · paper and ink']];
    const accents = [['ink', 'INK · monochrome (default)'], ['phosphor', 'PHOSPHOR · acid green'], ['lime', 'LIME · chartreuse'], ['sodium', 'SODIUM · amber'], ['plasma', 'PLASMA · burnt orange'], ['crimson', 'CRIMSON · red'], ['magenta', 'MAGENTA · magenta'], ['cyan', 'CYAN · cyan'], ['teal', 'TEAL · teal'], ['violet', 'VIOLET · violet']];
    fragment.append(row('Theme', 'Four ink-dark greyscale ramps and one paper theme. No theme introduces a colour of its own.', selectControl(settings.theme, themes, (value) => save({ theme: value })), 'Theme'));
    fragment.append(row('Signal colour', 'The single colour the interface is allowed, used for focus, selection and active marks. INK keeps everything monochrome; the rest are print-muted hues, automatically darkened on paper.', selectControl(settings.accent, accents, (value) => save({ accent: value })), 'Signal colour'));
    fragment.append(row('Panel opacity', 'Opaque by default. Lower it only if you want the backdrop to show through window panels.', sliderControl(settings.glass, 30, 100, 1, (value) => save({ glass: value }), (value) => `${value}%`), 'Panel opacity'));
    fragment.append(row('Backdrop blur', 'Only relevant when panel opacity is below 95%. Zero is sharpest and cheapest on a phone.', sliderControl(settings.blur, 0, 40, 1, (value) => save({ blur: value }), (value) => `${value}px`), 'Backdrop blur'));
    fragment.append(row('Edge chamfer', 'The only corner treatment in the interface: a single cut corner, never a curve. Zero — the default — gives perfectly square plates.', sliderControl(settings.cornerRadius, 0, 24, 1, (value) => {
      document.documentElement.style.setProperty('--chamfer', `${value}px`);
      document.documentElement.style.setProperty('--chamfer-sm', `${Math.max(4, Math.round(value * 0.58))}px`);
      save({ cornerRadius: value });
    }, (value) => `${value}px`), 'Edge chamfer'));
    fragment.append(row('Interface scale', 'Scales text and control sizes across the whole app.', sliderControl(settings.fontScale, 0.85, 1.4, 0.05, (value) => save({ fontScale: value }), (value) => `${Math.round(value * 100)}%`), 'Interface scale'));
    fragment.append(row('Taskbar position', 'Center it like Windows 11, pin it to the left, or auto-hide it.', selectControl(settings.taskbarPosition || 'center', [['center', 'Centered'], ['left', 'Left edge'], ['hidden', 'Auto-hide']], (value) => save({ taskbarPosition: value })), 'Taskbar position'));
    fragment.append(row('Backdrop', 'A static ruled pattern behind every window. Nothing moves on its own.', selectControl(settings.wallpaper || 'theme', [
      ['theme', 'Hairline grid · matches the theme'],
      ['signal', 'Signal grid · stronger rule every fifth line'],
      ['rain', 'Ruled columns · vertical hairlines'],
      ['dots', 'Dot matrix · sparse points'],
      ['void', 'Void · flat field'],
    ], (value) => {
      document.body.dataset.wall = value === 'theme' ? '' : value;
      save({ wallpaper: value });
    }), 'Backdrop'));
  }

  // --------------------------------------------------------- accessibility
  function paintAccessibility(fragment) {
    const settings = State.settings();
    fragment.append(heading('A11Y', 'Accessibility'));
    fragment.append(row('High contrast', 'Stronger borders and solid surfaces for maximum legibility.', switchControl(settings.highContrast, (value) => save({ highContrast: value })), 'High contrast'));
    fragment.append(row('Dyslexia-friendly font', 'Wider letter spacing with a more distinct letterform set.', switchControl(settings.dyslexiaFont, (value) => save({ dyslexiaFont: value })), 'Dyslexia-friendly font'));
    fragment.append(row('Line spacing', 'Increase spacing between lines of text.', sliderControl(settings.lineHeight, 1.2, 2, 0.05, (value) => save({ lineHeight: value }), (value) => `${value.toFixed(2)}×`), 'Line spacing'));
    fragment.append(row('Colour-blind filter', 'Shift hues so status colours stay distinguishable.', selectControl(settings.colorBlind || 'none', [['none', 'None'], ['deuteranopia', 'Deuteranopia'], ['protanopia', 'Protanopia'], ['tritanopia', 'Tritanopia']], (value) => save({ colorBlind: value })), 'Colour-blind filter'));
    fragment.append(row('Focus outlines', 'Keep a visible outline around the focused control for keyboard use.', switchControl(settings.focusRing, (value) => save({ focusRing: value })), 'Focus outlines'));
    fragment.append(row('Reduce motion', 'Removes window animations, drifting wallpapers and transitions.', switchControl(settings.reduceMotion || !settings.animations, (value) => save({ reduceMotion: value, animations: !value })), 'Reduce motion'));
    fragment.append(row('Interface density', 'Comfortable spacing or a compact layout for small screens.', selectControl(settings.density, [['comfortable', 'Comfortable'], ['compact', 'Compact']], (value) => save({ density: value })), 'Interface density'));
    fragment.append(row('Screen-reader hints', 'Adds extra descriptive text to icons and controls.', switchControl(settings.screenReaderHints, (value) => save({ screenReaderHints: value })), 'Screen-reader hints'));
  }

  // -------------------------------------------------------- notifications
  function paintNotifications(fragment) {
    const settings = State.settings();
    fragment.append(heading('NTF', 'Notifications'));
    fragment.append(row('In-app toasts', 'Slide-in notifications in the corner of the desktop.', switchControl(settings.notificationToasts, (value) => save({ notificationToasts: value })), 'In-app toasts'));
    fragment.append(row('Desktop notifications', 'Use the browser notification system when the tab is in the background.', switchControl(settings.desktopNotifications, async (value) => {
      if (value && 'Notification' in window && Notification.permission !== 'granted') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') { UI.toast({ level: 'warning', title: 'Notifications were not granted by the browser' }); return; }
      }
      save({ desktopNotifications: value });
    }), 'Desktop notifications'));
    fragment.append(row('Interface sounds', 'A short tone when messages and airdrops arrive.', switchControl(settings.uiSounds, (value) => { save({ uiSounds: value }); if (value) Shell.blip(720); }), 'Interface sounds'));
    fragment.append(row('Message previews in notifications', 'When off, notifications never hint at content.', switchControl(!settings.hideMessagePreviews, (value) => save({ hideMessagePreviews: !value })), 'Message previews in notifications'));
    fragment.append(row('Auto-lock after inactivity', 'Lock the vault when you leave the app open. Zero disables auto-lock.', selectControl(String(settings.autoLockMinutes), [['0', 'Never'], ['5', '5 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours']], (value) => save({ autoLockMinutes: Number(value) })), 'Auto-lock after inactivity'));
    fragment.append(row('Remember unlock for this tab', 'Keep the vault unlocked while the tab stays open so refreshes do not ask for your passphrase again.', switchControl(settings.rememberUnlockInTab, (value) => save({ rememberUnlockInTab: value })), 'Remember unlock for this tab'));
  }

  // --------------------------------------------------------------- privacy
  function paintPrivacy(fragment) {
    const settings = State.settings();
    fragment.append(heading('PRV', 'Privacy & activity'));

    fragment.append(row('Share activity status', 'Other members see Online, Idle, Do Not Disturb or Invisible. Turn this off and you always appear offline.', switchControl(settings.activityStatus, (value) => save({ activityStatus: value })), 'Share activity status'));

    const statusRow = el('div', { class: 'row wrap' });
    const manual = Shell.manualStatus;
    const options = [['online', '● Online'], ['idle', '◐ Idle'], ['dnd', '⊘ Do Not Disturb'], ['invisible', '○ Invisible']];
    if (State.user.purpleAllowed) options.push(['purple', '◉ Purple (granted)']);
    options.push([null, '↻ Automatic']);
    for (const [value, label] of options) {
      statusRow.append(el('button', { class: `btn sm ${manual === value ? 'primary' : ''}`, text: label, onClick: () => { Shell.setManualStatus(value); paintRefresh(); } }));
    }
    statusRow.append(el('button', { class: 'btn sm subtle', text: 'Request purple status', disabled: State.user.purpleAllowed, onClick: () => requestDialog('purple') }));
    fragment.append(row('Availability now', 'Manual overrides: Idle keeps you idle while you read, Invisible makes you appear offline, Purple is granted by the operator on request.', statusRow, 'Availability now'));

    fragment.append(heading('AIR', 'Airdrop'));
    fragment.append(row('Airdrop delivery', 'When on, drops reach you while you are online. Off by default.', switchControl(settings.airdrop, (value) => { save({ airdrop: value }); AirdropClient.refresh(); }), 'Airdrop delivery'));
    fragment.append(row('Airdrop sounds', 'Play a tone when a drop lands.', switchControl(settings.airdropSound, (value) => save({ airdropSound: value })), 'Airdrop sounds'));
    fragment.append(el('div', { class: 'setting-row' }, [
      el('div', { class: 'info' }, [el('div', { class: 'name', text: 'Send an airdrop now' }), el('div', { class: 'desc', text: 'Delivers to every member with airdrop on who is online, plus operators at all times.' })]),
      el('div', { class: 'control' }, [el('button', { class: 'btn', text: 'Open airdrop', onClick: () => AirdropClient.composer() })]),
    ]));

    fragment.append(heading('COM', 'Communities and public posting'));
    fragment.append(row('Media in communities and public posts', 'Off by default. When off, you cannot upload or attach images in communities or the public square, and you are not shown their media.', switchControl(settings.forumMedia, (value) => { save({ forumMedia: value }); UI.toast({ level: 'info', title: value ? 'Community media enabled' : 'Community media disabled', body: value ? 'You can attach images to community and public posts.' : 'Uploads and image display in communities are now blocked.', duration: 4200 }); }), 'Media in communities and public posts'));
    fragment.append(row('Autoplay stories', 'Start videos automatically in the story viewer.', switchControl(settings.storyAutoplay, (value) => save({ storyAutoplay: value })), 'Autoplay stories'));

    fragment.append(heading('FUN', 'Click Me'));
    fragment.append(row('Show the Click Me box', 'Hide the counter if you would rather not see it.', switchControl(State.featureEnabled('clickMe'), (value) => save({ disabledFeatures: Object.assign({}, settings.disabledFeatures, { clickMe: !value }) })), 'Click Me'));
    fragment.append(Clicker.card());
  }

  // -------------------------------------------------------------- requests
  function paintRequests(fragment) {
    fragment.append(heading('QTA', 'Storage & requests'));
    const limits = State.user.limits;

    fragment.append(el('div', { class: 'card stack-8' }, [
      el('div', { class: 'uppercase', text: 'Your current allowances' }),
      limitLine('Message attachments', limits.dmUploadBytes, State.user.uploadUsed, 'Default 15 MB per file.'),
      limitLine('Cloud drive', limits.driveQuotaBytes, State.user.driveUsed, 'Default 1 GB total. Drive uploads are limited only by remaining space.'),
      limitLine('Story items', limits.storyQuotaBytes, 0, 'Default 1 GB per story item.'),
      el('div', { class: 'row small' }, [
        el('span', { class: 'grow', text: 'Purple status' }),
        el('span', { class: `pill tiny ${State.user.purpleAllowed ? 'success' : ''}`, text: State.user.purpleAllowed ? 'granted' : 'not granted' }),
      ]),
      el('div', { class: 'hint', text: 'Extra capacity is never granted automatically — an administrator approves every request.' }),
    ]));

    const requestGrid = el('div', { class: 'grid-2' });
    requestGrid.append(
      requestCard('⊕', 'Bigger message attachments', 'Ask for a larger per-file limit for chats, communities and airdrops.', 'dm', [25, 50, 100, 250].map((mb) => [mb * 1024 * 1024, `${mb} MB`])),
      requestCard('▦', 'More drive storage', 'Ask for more cloud drive space. Unlimited is possible.', 'drive', [[2, '2 GB'], [5, '5 GB'], [25, '25 GB'], [-1, 'Unlimited']].map(([gb, label]) => [gb === -1 ? -1 : gb * 1024 * 1024 * 1024, label])),
      requestCard('◉', 'Bigger story items', 'Ask for larger story images and videos.', 'story', [2, 5].map((gb) => [gb * 1024 * 1024 * 1024, `${gb} GB`])),
      requestCard('◉', 'Purple availability status', 'Adds the purple ring to your status options.', 'purple', []),
    );
    fragment.append(heading('REQ', 'Requests'));
    fragment.append(requestGrid);

    fragment.append(heading('OPS', 'Contact the administration'));
    fragment.append(contactCard());

    fragment.append(heading('CODE', 'One-time DM codes'));

    fragment.append(heading('KEY', 'Backup codes'));
    fragment.append(backupCard());

    fragment.append(heading('DEV', 'Signed-in devices'));
    fragment.append(sessionsCard());

    fragment.append(heading('LOG', 'Request history'));
    const history = el('div', { class: 'stack-6' });
    fragment.append(history);
    API.get('/api/requests').then((data) => {
      clear(history);
      if (!data.requests.length) { history.append(el('div', { class: 'caption', text: 'No requests filed yet.' })); return; }
      for (const request of data.requests) {
        history.append(el('div', { class: 'card stack-4' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'pill tiny', text: request.kind }),
            el('span', { class: `pill tiny ${request.status === 'approved' ? 'success' : request.status === 'denied' ? 'danger' : 'accent'}`, text: request.status }),
            el('div', { class: 'spacer' }),
            el('span', { class: 'tiny faint', text: UI.timeAgo(request.createdAt) }),
          ]),
          request.message ? el('div', { class: 'small muted', text: request.message }) : null,
          request.requestedLabel ? el('div', { class: 'tiny faint', text: `Requested: ${request.requestedLabel}` }) : null,
          request.decision ? el('div', { class: 'notice-strip', html: `<span>≡</span><span>${UI.esc(request.decision.status)}${request.decision.grantedBytes ? ` · granted ${UI.bytes(request.decision.grantedBytes)}` : ''}${request.decision.note ? ` · “${UI.esc(request.decision.note)}”` : ''}</span>` }) : null,
        ]));
      }
    });
  }

  function limitLine(label, quota, used, hint) {
    const line = el('div', { class: 'row small' }, [
      el('span', { class: 'grow', text: label }),
      el('span', { class: 'mono', text: quota === -1 ? 'Unlimited' : UI.bytes(quota) }),
    ]);
    const detail = el('div', {}, [line, quota !== -1 ? UI.meter(used || 0, quota) : el('div', { class: 'hint', text: 'Unlimited on this account.' }), el('div', { class: 'tiny faint', text: hint })]);
    return detail;
  }

  function requestCard(glyph, title, description, kind, presets) {
    const amount = el('input', { class: 'input', placeholder: 'How much? (bytes, MB, GB or “unlimited”)' });
    const message = el('textarea', { class: 'textarea', placeholder: 'Tell the operator why you need it (optional)', rows: 2 });
    const quick = el('div', { class: 'row wrap' });
    for (const [bytes, label] of presets) {
      quick.append(el('button', { class: 'btn sm subtle', text: label, onClick: () => { amount.value = bytes === -1 ? 'unlimited' : String(bytes); } }));
    }
    return el('div', { class: 'card stack-8' }, [
      el('div', { class: 'row' }, [el('span', { style: { fontSize: '18px' }, text: glyph }), el('div', {}, [el('div', { class: 'body-strong', text: title }), el('div', { class: 'tiny faint', text: description })])]),
      kind === 'dm' || kind === 'drive' || kind === 'story' ? el('div', { class: 'field' }, [el('label', { text: 'Amount requested' }), amount, quick]) : null,
      el('div', { class: 'field' }, [el('label', { text: 'Message' }), message]),
      el('button', { class: 'btn primary', text: 'Send request', onClick: async () => {
        const match = /^\s*([\d.]+)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(amount.value || '');
        let bytes = null;
        if (amount.value && /unlimited|∞/i.test(amount.value)) bytes = -1;
        else if (match) {
          const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[(match[2] || 'b').toLowerCase()];
          bytes = Math.round(Number(match[1]) * factor);
        }
        try {
          await API.post('/api/requests', {
            kind,
            requestedBytes: kind === 'purple' || kind === 'verified' ? null : bytes,
            requestedLabel: kind === 'purple' || kind === 'verified' ? `${kind} status` : (bytes ? UI.bytes(bytes) : amount.value),
            message: message.value,
          });
          UI.toast({ level: 'success', title: 'Request sent', body: 'The operator has been notified and you will get a decision notification.' });
          paintRefresh();
        } catch (error) {
          UI.toast({ level: 'danger', title: 'Request failed', body: error.message });
        }
      } }),
    ]);
  }

  function contactCard() {
    const status = el('div', { class: 'hint' });
    return el('div', { class: 'card stack-8' }, [
      el('div', { class: 'small muted', text: 'Generate a one-time code and hand it to the operator through any channel you trust. When they redeem it a private channel opens between the two of you, sealed with a key only the two of you can build, and the operator appears as “Server Administration”.' }),
      el('div', { class: 'row wrap' }, [
        el('button', {
          class: 'btn primary',
          text: 'Generate a one-time code',
          disabled: !State.featureEnabled('dmCodes') || !State.featureEnabled('adminChat'),
          onClick: async () => {
            try {
              const result = await API.post('/api/dm-codes', {});
              UI.dialog({
                title: 'Your operator chat code',
                glyph: '#',
                size: 'narrow',
                subtitle: 'Single use · hand it to the operator',
                content: el('div', { class: 'stack-8' }, [
                  el('div', { class: 'recovery-code', text: result.code, title: 'Click to copy', onClick: () => UI.copy(result.code, 'Code copied') }),
                  el('div', { class: 'hint', text: `Expires ${UI.dateTime(result.expiresAt)}. The code stops working the moment it is redeemed.` }),
                  el('div', { class: 'notice-strip', html: '<span>◍</span><span>Your handle is visible to the operator. Their account name is never exposed to you.</span>' }),
                ]),
                footer: [el('button', { class: 'btn primary', text: 'Copy code', onClick: () => UI.copy(result.code, 'Code copied') })],
              });
            } catch (error) {
              status.textContent = error.message;
            }
          },
        }),
        el('button', {
          class: 'btn',
          text: 'Redeem a code',
          disabled: !State.featureEnabled('dmCodes'),
          onClick: async () => {
            const code = await UI.prompt({ title: 'Redeem a one-time code', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX', confirmLabel: 'Open channel', glyph: '#' });
            if (!code) return;
            try {
              const result = await API.post('/api/dm-codes/redeem', { code });
              await Shell.openMaskedChannel(result);
            } catch (error) {
              status.textContent = error.message;
              UI.toast({ level: 'danger', title: 'That code was not accepted', body: error.message });
            }
          },
        }),
      ]),
      status,
    ]);
  }

  function backupCard() {
    const state = el('div', { class: 'row wrap' }, [
      el('span', { class: 'pill', text: `${State.user.backup?.count ?? 0} unused codes` }),
      el('span', { class: 'tiny faint', text: State.user.backup?.generatedAt ? `generated ${UI.timeAgo(State.user.backup.generatedAt)}` : 'never generated' }),
    ]);
    return el('div', { class: 'card stack-8' }, [
      el('div', { class: 'small muted', text: 'A backup code restores this account once and is then burned. If someone takes over your account, sign in with a code, set a new passphrase, and every other device is signed out at once. If the intruder changed the passphrase first, a code is still the only way back — then tell the operator so they can review the session list with you.' }),
      state,
      el('div', { class: 'row wrap' }, [
        el('button', {
          class: 'btn primary',
          text: 'Generate 5 new codes',
          onClick: async () => {
            const confirmed = await UI.confirm({
              title: 'Generate new backup codes?',
              message: 'Every existing code stops working immediately. The new set is shown once, so store it somewhere offline.',
              confirmLabel: 'Generate',
            });
            if (!confirmed) return;
            try {
              const codes = await generateRecoveryCodes();
              presentRecoveryCodes(codes);
            } catch (error) {
              UI.toast({ level: 'danger', title: 'Could not generate codes', body: error.message });
            }
          },
        }),
        el('button', {
          class: 'btn danger',
          text: 'Sign out on all devices',
          onClick: async () => {
            const confirmed = await UI.confirm({
              title: 'Sign out everywhere?',
              message: 'Every session including this one is ended. You will need your passphrase or a backup code to return.',
              danger: true,
              confirmLabel: 'Sign out everywhere',
            });
            if (!confirmed) return;
            try { await API.post('/api/sessions/revoke-others', {}); } catch { /* the session may already be gone */ }
            State.clearSession();
            location.reload();
          },
        }),
      ]),
      el('div', { class: 'hint', text: 'Codes are generated on this device from your unlocked vault. The server stores only a proof hash — it can never read a code or sign in with one.' }),
    ]);
  }

  /** Builds five fresh single-use codes from the vault held in memory. */
  async function generateRecoveryCodes() {
    if (!State.vault) throw new Error('Unlock the vault first.');
    const salt = await API.post('/api/auth/salt', { username: State.user.username });
    const codes = [];
    for (let index = 0; index < 5; index++) {
      const code = AE.generateRecoveryCode();
      codes.push({
        code,
        index,
        proof: await AE.recoveryProof(code, salt.authSalt),
        wrapped: await AE.recoveryWrap(code, State.user.username, index, State.vault),
        label: `Backup code ${index + 1}`,
      });
    }
    await API.post('/api/auth/recovery/regenerate', { codes });
    if (State.user.backup) { State.user.backup.count = 5; State.user.backup.generatedAt = Date.now(); }
    return codes;
  }

  function presentRecoveryCodes(codes) {
    const grid = el('div', { class: 'recovery-grid' });
    for (const entry of codes) {
      grid.append(el('div', { class: 'recovery-code', text: entry.code, title: 'Click to copy', onClick: () => UI.copy(entry.code, `Copied code ${entry.index + 1}`) }));
    }
    const ack = el('input', { type: 'checkbox' });
    const done = el('button', { class: 'btn primary', text: 'Done', disabled: true });
    const dialogRef = UI.dialog({
      title: 'Your five backup codes',
      glyph: '◇',
      size: 'wide',
      subtitle: 'Each code restores this account once, then it stops working.',
      dismissable: false,
      content: el('div', { class: 'stack-12' }, [
        el('div', { class: 'notice-strip warn', html: '<span>!</span><span>Store these offline. Anyone holding a code can sign in and reset your passphrase. They are shown only once.</span>' }),
        grid,
        el('div', { class: 'row wrap' }, [
          el('button', { class: 'btn sm', text: 'Copy all', onClick: () => UI.copy(codes.map((entry) => entry.code).join('\n'), 'All codes copied') }),
          el('button', {
            class: 'btn sm',
            text: 'Download .txt',
            onClick: () => UI.download(new Blob([`AE Secure backup codes for ${State.user.username}\nGenerated ${new Date().toLocaleString()}\n\n${codes.map((entry, index) => `${index + 1}. ${entry.code}`).join('\n')}\n\nKeep this file offline. Each code works once.\n`], { type: 'text/plain' }), 'ae-secure-backup-codes.txt'),
          }),
        ]),
        el('label', { class: 'row small' }, [ack, el('span', { text: 'I have saved my backup codes somewhere safe.' })]),
      ]),
      footer: [done],
    });
    ack.addEventListener('change', () => { done.disabled = !ack.checked; });
    done.addEventListener('click', () => { dialogRef.close(); paintRefresh(); });
  }

  function sessionsCard() {
    const host = el('div', { class: 'stack-6' });
    const paint = async () => {
      clear(host);
      const data = await API.get('/api/sessions');
      for (const session of data.sessions) {
        host.append(el('div', { class: `session-row ${session.current ? 'current' : ''}` }, [
          el('span', { class: 'device-glyph', text: /phone|android|iphone|ipad/i.test(session.device) ? '▭' : '▢' }),
          el('div', { class: 'grow' }, [
            el('div', { class: 'small body-strong', text: `${session.device} · ${session.platform}${session.current ? ' (this device)' : ''}` }),
            el('div', { class: 'tiny faint', text: `${session.ip} · last seen ${UI.timeAgo(session.lastSeenAt)}` }),
          ]),
          session.current ? el('span', { class: 'pill accent tiny', text: 'this device' }) : el('button', { class: 'btn sm danger', text: 'End', onClick: async () => {
            await API.post('/api/sessions/revoke', { id: session.id });
            paint();
          } }),
        ]));
      }
    };
    paint();
    return el('div', { class: 'card stack-8' }, [host, el('button', { class: 'btn sm', text: 'Refresh sessions', onClick: paint })]);
  }

  // ---------------------------------------------------------------- public
  function paintPublic(fragment) {
    const profile = State.user.publicProfile;
    fragment.append(heading('PUB', 'Public profile'));
    fragment.append(el('div', { class: 'card stack-8' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'grow' }, [
          el('div', { class: 'body-strong', text: profile.enabled ? `Public as “${profile.alias || State.user.displayName}”` : 'Public profile is off' }),
          el('div', { class: 'tiny faint', text: profile.enabled ? 'Stories, photos and public posts are visible to signed-in members.' : 'Nothing about you is shown in the public square.' }),
        ]),
        el('span', { class: `pill ${profile.enabled ? 'success' : ''}`, text: profile.enabled ? 'live' : 'hidden' }),
      ]),
      el('button', { class: 'btn primary', text: 'Edit public profile', onClick: () => StoriesClient.profileEditor({ then: () => paintRefresh() }) }),
      el('div', { class: 'hint', text: 'Turning the switch off hides your alias, bio, photos, stories and posts from everyone immediately. Turning it back on restores them.' }),
    ]));
    fragment.append(heading('STORY', 'Stories'));
    fragment.append(el('div', { class: 'row' }, [
      el('button', { class: 'btn', text: 'Post a story', onClick: () => Apps.open('stories') }),
      el('button', { class: 'btn', text: 'Open the public square', onClick: () => Apps.open('stories') }),
    ]));
  }

  // --------------------------------------------------------------- account
  function paintAccount(fragment) {
    fragment.append(heading('ACC', 'Account & security'));
    fragment.append(el('div', { class: 'card stack-6' }, [
      el('div', { class: 'row' }, [
        UI.avatar(State.user, { size: 'lg' }),
        el('div', {}, [
          el('div', { class: 'body-strong', text: State.user.displayName }),
          el('div', { class: 'caption', text: `@${State.user.username}` }),
          el('div', { class: 'tiny faint mono', text: `fingerprint ${AE.fingerprint(State.user.identityPublic)}` }),
        ]),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn sm', text: 'Edit profile', onClick: () => Apps.open('profile') }),
      ]),
      el('div', { class: 'tiny faint', text: `Role ${State.user.role} · joined ${UI.dateTime(State.user.createdAt)} · ${State.user.backup?.count ?? 0} unused backup codes` }),
    ]));

    const current = el('input', { class: 'input', type: 'password', placeholder: 'Current passphrase' });
    const next = el('input', { class: 'input', type: 'password', placeholder: 'New passphrase (12+ characters)' });
    const confirm = el('input', { class: 'input', type: 'password', placeholder: 'Repeat new passphrase' });
    fragment.append(heading('PASS', 'Change passphrase'));
    fragment.append(el('div', { class: 'card stack-8' }, [
      current, next, confirm,
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary', text: 'Change passphrase', onClick: async () => {
          if (next.value.length < 12) { UI.toast({ level: 'warning', title: 'Use at least 12 characters' }); return; }
          if (next.value !== confirm.value) { UI.toast({ level: 'warning', title: 'The new passphrases do not match' }); return; }
          if (!State.vault) { UI.toast({ level: 'warning', title: 'Unlock first', body: 'The vault must be unlocked to change the passphrase.' }); return; }
          if (!current.value) { UI.toast({ level: 'warning', title: 'Enter your current passphrase' }); return; }
          const iterations = State.user.kdf.iterations;
          const authSalt = AE.randomBytes(16);
          const vaultSalt = AE.randomBytes(16);
          const currentAuthKey = await AE.pbkdf2(`ae-auth|${State.user.username}|${current.value}`, State.user.kdf.authSalt, iterations);
          const newAuthKey = await AE.pbkdf2(`ae-auth|${State.user.username}|${next.value}`, authSalt, iterations);
          const vaultKey = await AE.pbkdf2(`ae-vault|${State.user.username}|${next.value}`, vaultSalt, iterations);
          const sealed = await AE.encryptJson(await AE.importAes(vaultKey), State.vault);
          const kdf = { authSalt: AE.b64encode(authSalt), vaultSalt: AE.b64encode(vaultSalt), iterations };
          try {
            await API.post('/api/auth/password', {
              currentAuthKey: AE.b64encode(currentAuthKey),
              newAuthKey: AE.b64encode(newAuthKey),
              newAuthSalt: kdf.authSalt,
              newVaultSalt: kdf.vaultSalt,
              vault: JSON.stringify(sealed),
              iterations,
              keepSessions: true,
            });
            State.user.kdf = kdf;
            await State.unlock(State.vault, kdf);
            UI.toast({ level: 'success', title: 'Passphrase changed', body: 'Other devices keep their sessions unless you sign them out.' });
            current.value = next.value = confirm.value = '';
            paintRefresh();
          } catch (error) {
            UI.toast({ level: 'danger', title: 'Could not change the passphrase', body: error.message });
          }
        } }),
        el('button', { class: 'btn', text: 'How recovery works', onClick: () => Help.open('Backup codes') }),
      ]),
      el('div', { class: 'hint', text: 'The passphrase never leaves this device. Your authKey is derived with PBKDF2-SHA256 (210 000 iterations) and only its hash reaches the server.' }),
    ]));

    fragment.append(heading('SESS', 'Sessions'));
    fragment.append(sessionsCard());
  }

  // -------------------------------------------------------------- tutorial
  function paintTutorial(fragment) {
    fragment.append(heading('DOC', 'Tutorial & help'));
    fragment.append(el('div', { class: 'card stack-8' }, [
      el('div', { class: 'body-strong', text: 'App usage tutorial' }),
      el('div', { class: 'small muted', text: 'The tour highlights each part of the interface in order — messages, communities, drive, airdrops, requests and the operator tools.' }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary', text: 'Start the guided tour', onClick: () => Help.tutorial() }),
        el('button', { class: 'btn', text: 'Open the help centre', onClick: () => Help.open() }),
      ]),
    ]));
    fragment.append(heading('FIND', 'How do I…?'));
    const search = el('input', { class: 'input', placeholder: 'Search: airdrop, backup codes, drive quota, purple status…' });
    const results = el('div', { class: 'stack-6' });
    const paint = () => {
      clear(results);
      const matches = Help.search(search.value).slice(0, 12);
      if (!matches.length) { results.append(el('div', { class: 'caption', text: 'Nothing matched. Try a feature name, such as “stories”.' })); return; }
      for (const article of matches) {
        results.append(el('div', { class: 'help-article' }, [
          el('h4', { text: article.title }),
          el('div', { class: 'body', text: article.summary }),
          el('div', { class: 'row' }, [
            el('span', { class: 'tiny faint', text: article.tags.slice(0, 5).join(' · ') }),
            el('div', { class: 'spacer' }),
            el('button', { class: 'btn sm subtle', text: 'Read more', onClick: () => Help.open(article.title) }),
          ]),
        ]));
      }
    };
    paint();
    search.addEventListener('input', paint);
    fragment.append(search, results);
  }

  function paintAbout(fragment) {
    fragment.append(heading('SYS', 'About'));
    fragment.append(el('div', { class: 'card stack-8' }, [
      el('div', { class: 'body-strong', text: `AE Secure ${State.get('boot')?.version || '1.0.0'}` }),
      el('div', { class: 'small muted', text: `Server uptime ${UI.duration(State.get('boot')?.server?.uptime || 0)} · ${State.get('boot')?.server?.counts?.users || 0} members` }),
      el('div', { class: 'divider' }),
      el('div', { class: 'small muted', text: 'Messages, files, stories and drive data are encrypted in your browser with AES-GCM-256. Keys are derived from your passphrase with PBKDF2-SHA256 and never leave the device. Channel keys are wrapped per member with ECDH P-256. The server stores ciphertext, wrapped keys, account metadata and counters.' }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', text: 'Read the usage agreement', onClick: () => Terms.show() }),
        el('button', { class: 'btn', text: 'Privacy, limits & liability', onClick: () => Help.open('Usage agreement and non-liability') }),
      ]),
    ]));
    fragment.append(heading('LAW', 'Operator notice'));
    fragment.append(el('div', { class: 'notice-strip', html: '<span>§</span><span>The operator of this server is not liable for anything shared, posted, uploaded or viewed by members, takes no part in user activity, and cannot read encrypted content.</span>' }));
  }

  function paintRefresh() {
    if (!viewBody) return;
    render(viewBody, viewApi, current);
  }

  /** Opens the settings window, optionally on a named section. */
  function open(section) {
    return Apps.open('settings', { section: section || current });
  }

  return { render, paintRefresh, open, FEATURES };
})();

window.Settings = Settings;

Apps.register({
  id: 'settings', title: 'Settings', glyph: '⚙', order: 80,
  description: 'Personalisation, accessibility, privacy, storage requests and help.',
  keywords: ['settings', 'theme', 'accessibility', 'privacy', 'requests', 'backup codes', 'tutorial', 'help'],
  run: (meta = {}) => Windows.open({
    id: 'settings', title: 'Settings', glyph: '⚙', geometry: { w: 1000, h: 700 },
    render: (body, api) => Settings.render(body, api, meta.section),
  }),
});


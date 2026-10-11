/* ============================================================================
   AE Secure — console
   ----------------------------------------------------------------------------
   A visual activity log and a small command line, both entirely local. Nothing
   in here can reach the server beyond the calls the interface already makes,
   and nothing sensitive is ever written: entries are produced from fixed
   templates that read counts, methods and event names only. Message text, keys,
   tokens, file names, member names and account identifiers never enter the
   buffer — request paths are masked before they are shown, and payload objects
   are never read.
   ========================================================================== */

const ConsoleLog = (() => {
  const CAP = 240;                 // entries kept in memory
  const MERGE_WINDOW = 1500;       // identical lines inside this window collapse
  const KINDS = ['LINK', 'NET', 'DATA', 'KEY', 'UI', 'OPS', 'WARN'];

  const entries = [];
  const history = [];
  const startedAt = Date.now();
  let sequence = 0;
  let capturing = true;
  let unread = 0;
  let host = null;
  let listNode = null;
  let metaNode = null;
  let inputNode = null;
  let badgeNode = null;
  let historyIndex = -1;
  let wired = false;

  // ------------------------------------------------------------- input mask
  /**
   * Renders a request path for display with every opaque segment replaced, so
   * the console can show the shape of traffic without showing identifiers.
   */
  function looksOpaque(part) {
    if (/^\d+$/.test(part)) return true;                  // numeric ids and page numbers
    if (/^[a-z]{1,3}_[A-Za-z0-9]+$/i.test(part)) return true; // u_ / f_ / c_ / s_ / rc_ record ids
    if (/^[0-9a-f]{8,}$/i.test(part)) return true;          // raw hex ids and tokens
    return part.length > 16;                                 // anything else long and unreadable
  }

  function maskPath(value) {
    if (typeof value !== 'string' || !value) return '/';
    const clean = value.split('?')[0].split('#')[0];
    const parts = clean.split('/').filter(Boolean).map((part) => (looksOpaque(part) ? '•••' : part));
    return `/${parts.join('/')}`;
  }

  // ------------------------------------------------------------------- write
  function stamp(at) {
    const date = new Date(at);
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function log(kind, text) {
    if (!capturing) return null;
    const label = KINDS.includes(kind) ? kind : 'UI';
    const message = String(text == null ? '' : text);
    const now = Date.now();
    const last = entries[entries.length - 1];
    if (last && last.kind === label && last.text === message && now - last.at < MERGE_WINDOW) {
      last.at = now;
      last.repeat += 1;
      paint(last);
      return last;
    }
    const entry = { id: ++sequence, at: now, kind: label, text: message, repeat: 1, node: null };
    entries.push(entry);
    if (entries.length > CAP) {
      const dropped = entries.shift();
      if (dropped && dropped.node && dropped.node.parentNode) dropped.node.remove();
    }
    append(entry);
    if (!host || host.hidden) {
      unread += 1;
      paintBadge();
    }
    return entry;
  }

  function clear() {
    entries.length = 0;
    unread = 0;
    if (listNode) listNode.textContent = '';
    paintBadge();
    paintMeta();
  }

  // ------------------------------------------------------------------ render
  function line(entry) {
    const node = UI.el('div', { class: `console-line k-${entry.kind.toLowerCase()}` }, [
      UI.el('span', { class: 't', text: stamp(entry.at) }),
      UI.el('span', { class: 'k', text: entry.kind }),
      UI.el('span', { class: 'm', text: entry.text }),
      UI.el('span', { class: 'r', text: entry.repeat > 1 ? `×${entry.repeat}` : '' }),
    ]);
    node.dataset.id = String(entry.id);
    return node;
  }

  function atBottom() {
    if (!listNode) return true;
    return listNode.scrollHeight - listNode.scrollTop - listNode.clientHeight < 48;
  }

  function append(entry) {
    if (!listNode) return;
    const pinned = atBottom();
    entry.node = line(entry);
    listNode.append(entry.node);
    if (pinned) listNode.scrollTop = listNode.scrollHeight;
    paintMeta();
  }

  function paint(entry) {
    if (entry.node) {
      const repeat = entry.node.querySelector('.r');
      const time = entry.node.querySelector('.t');
      if (repeat) repeat.textContent = entry.repeat > 1 ? `×${entry.repeat}` : '';
      if (time) time.textContent = stamp(entry.at);
    }
    paintMeta();
  }

  function paintBadge() {
    if (!badgeNode) return;
    badgeNode.textContent = unread > 99 ? '99+' : String(unread);
    badgeNode.hidden = unread === 0;
  }

  function paintMeta() {
    if (!metaNode) return;
    const linked = API.connected ? 'link up' : 'link down';
    metaNode.textContent = `${linked} · ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${capturing ? '' : ' · paused'}`;
  }

  function headState() {
    const dot = host && host.querySelector('.console-dot');
    if (dot) dot.classList.toggle('down', !API.connected);
  }

  // ---------------------------------------------------------------- commands
  /** Every command below is local: it changes this client, never the server. */
  const COMMANDS = {
    help: {
      hint: 'list the available commands',
      run() {
        banner('available commands');
        for (const [name, command] of Object.entries(COMMANDS)) {
          banner(`${name} ${command.args ? `${command.args} ` : ''}— ${command.hint}`);
        }
        banner('this console is local: it changes your interface only');
      },
    },
    clear: { hint: 'empty the log buffer', run() { clear(); banner('buffer cleared'); } },
    status: {
      hint: 'show link, theme and session state',
      run() {
        const settings = State.settings();
        banner(`link        · ${API.connected ? 'established' : 'not established'}`);
        banner(`session     · ${Math.round((Date.now() - startedAt) / 1000)}s · ${entries.length}/${CAP} entries`);
        banner(`surface     · ${settings.theme} / ${settings.accent} / ${settings.wallpaper || 'theme'} wallpaper`);
        banner(`viewport    · ${window.innerWidth}×${window.innerHeight} · ${window.matchMedia('(max-width: 760px)').matches ? 'phone' : window.matchMedia('(max-width: 1024px)').matches ? 'tablet' : 'desktop'}`);
      },
    },
    log: {
      args: 'on|off',
      hint: 'pause or resume capture',
      run(argument) {
        const value = (argument || '').toLowerCase();
        if (value !== 'on' && value !== 'off') { banner('usage: log on|off'); return; }
        capturing = value === 'on';
        paintMeta();
        banner(capturing ? 'capture resumed' : 'capture paused');
      },
    },
    theme: {
      args: '<name>',
      hint: 'switch the interface theme',
      run: (argument) => applySetting('theme', argument, ['nox', 'acid', 'sector', 'ice', 'chrome']),
    },
    accent: {
      args: '<name>',
      hint: 'switch the signal colour',
      run: (argument) => applySetting('accent', argument, ['ink', 'phosphor', 'lime', 'sodium', 'plasma', 'crimson', 'magenta', 'cyan', 'teal', 'violet']),
    },
    wall: {
      args: '<name>',
      hint: 'switch the backdrop',
      run: (argument) => applySetting('wallpaper', argument, ['theme', 'grid', 'signal', 'rain', 'dots', 'void']),
    },
    open: {
      args: '<surface>',
      hint: 'open a surface by name',
      run(argument) {
        const id = (argument || '').toLowerCase();
        if (!id) { banner(`surfaces: ${Apps.visible(State.user).map((app) => app.id).join(', ')}`); return; }
        if (!Apps.get(id)) { banner(`no surface named “${id}”`); return; }
        Apps.open(id);
        banner(`opened ${id}`);
      },
    },
    lock: { hint: 'lock the vault in this tab', run() { State.lock(); banner('vault locked'); } },
    whoami: { hint: 'show the account signed in to this tab', run() { banner(`signed in as ${State.user ? (State.user.publicAlias || State.user.displayName || State.user.username) : 'nobody'}`); } },
    net: { hint: 'show the realtime link state', run() { banner(`realtime channel ${API.connected ? 'established' : 'not established'}`); } },
    time: { hint: 'show the local clock', run() { banner(new Date().toLocaleString()); } },
    ver: { hint: 'version and privacy note', run() { banner(`AE Secure · ${State.boot?.server?.name || 'console'} · local telemetry only`); } },
  };

  function banner(text) { log('UI', text); }

  async function applySetting(key, argument, allowed) {
    const value = (argument || '').toLowerCase();
    if (!value) { banner(`options: ${allowed.join(', ')}`); return; }
    if (!allowed.includes(value)) { banner(`“${value}” is not one of: ${allowed.join(', ')}`); return; }
    await State.saveSettings({ [key]: value });
    if (window.Shell && window.Shell.applyTheme) window.Shell.applyTheme();
    banner(`${key} set to ${value}`);
  }

  function runCommand(input) {
    const raw = String(input || '').trim();
    if (!raw) return;
    log('UI', `> ${raw}`);
    history.push(raw);
    if (history.length > 40) history.shift();
    historyIndex = history.length;
    const [name, ...rest] = raw.split(/\s+/);
    const command = COMMANDS[name.toLowerCase()];
    if (!command) {
      banner(`unknown command “${name}” — type help`);
      return;
    }
    try {
      command.run(rest.join(' '));
    } catch (error) {
      banner(`command failed: ${error.message}`);
    }
  }

  // ------------------------------------------------------------------ panel
  function build() {
    if (host) return host;
    badgeNode = UI.el('span', { class: 'tb-badge', hidden: true });
    listNode = UI.el('div', { class: 'console-log', id: 'console-log' });
    metaNode = UI.el('span', { class: 'meta', id: 'console-meta' });
    inputNode = UI.el('input', {
      class: 'input', id: 'console-input', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'type help', 'aria-label': 'Console command',
    });
    const form = UI.el('form', { class: 'console-form' }, [UI.el('span', { class: 'prompt', text: '›' }), inputNode]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      runCommand(inputNode.value);
      inputNode.value = '';
    });
    host = UI.el('div', { class: 'console-panel', id: 'console-panel', hidden: true, role: 'log', 'aria-label': 'Activity console' }, [
      UI.el('div', { class: 'console-head' }, [
        UI.el('span', { class: 'console-dot' }),
        UI.el('span', { class: 'title', text: 'Console' }),
        metaNode,
        UI.el('button', { class: 'console-x', type: 'button', title: 'Close (Esc)', text: '✕', onClick: () => close() }),
      ]),
      listNode,
      form,
      UI.el('div', { class: 'console-foot', text: 'local telemetry · no message contents, keys or identifiers are recorded' }),
    ]);
    const root = document.body || document.documentElement;
    if (root && root.append) root.append(host);
    return host;
  }

  function isOpen() { return !!host && !host.hidden; }

  function open() {
    build();
    host.hidden = false;
    unread = 0;
    paintBadge();
    paintMeta();
    headState();
    listNode.scrollTop = listNode.scrollHeight;
    // Focusing a field on a phone raises the keyboard over the log, so the
    // command line waits for a tap there.
    if (!window.matchMedia('(max-width: 760px)').matches) inputNode.focus();
    wireOnce();
    return host;
  }

  function close() {
    if (!host) return;
    host.hidden = true;
    inputNode.blur();
  }

  function toggle() { if (isOpen()) close(); else open(); }

  function mount(button) {
    if (!button || !badgeNode) return;
    if (!badgeNode.parentNode) button.append(badgeNode);
    button.addEventListener('click', () => toggle());
    paintBadge();
  }

  function wireOnce() {
    if (wired) return;
    wired = true;
    document.addEventListener('pointerdown', (event) => {
      if (!isOpen()) return;
      const target = event.target;
      if (host.contains(target)) return;
      if (target.closest && target.closest('#tb-console')) return;
      close();
    }, true);
    inputNode.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key === 'ArrowUp' && history.length) {
        event.preventDefault();
        historyIndex = Math.max(0, historyIndex - 1);
        inputNode.value = history[historyIndex] || '';
        return;
      }
      if (event.key === 'ArrowDown' && history.length) {
        event.preventDefault();
        historyIndex = Math.min(history.length, historyIndex + 1);
        inputNode.value = history[historyIndex] || '';
        return;
      }
      if (event.key === 'Tab') {
        const match = Object.keys(COMMANDS).find((name) => name.startsWith(inputNode.value.trim().toLowerCase()));
        if (match) { event.preventDefault(); inputNode.value = `${match} `; }
      }
    });
  }

  // --------------------------------------------------------------- telemetry
  /**
   * Event templates. Each handler returns a fixed string; payload fields are
   * never interpolated except for the masked request paths below.
   */
  const FEED = {
    ready: ['LINK', () => 'realtime link established'],
    disconnected: ['WARN', () => 'realtime link lost · retrying'],
    message: ['DATA', () => 'inbound message · sealed payload'],
    'message.updated': ['DATA', () => 'outbound message accepted'],
    typing: ['DATA', () => 'typing state changed'],
    read: ['DATA', () => 'read receipt exchanged'],
    presence: ['DATA', () => 'presence update received'],
    'presence.changed': ['DATA', () => 'presence state changed'],
    'public.presence': ['DATA', () => 'public presence update received'],
    'conversation.created': ['KEY', () => 'channel opened'],
    'conversation.keys': ['KEY', () => 'channel keys merged'],
    'conversation.updated': ['DATA', () => 'channel metadata updated'],
    'conversation.removed': ['DATA', () => 'channel closed'],
    'forum.changed': ['DATA', () => 'community index updated'],
    'stories.changed': ['DATA', () => 'story index updated'],
    'public.changed': ['DATA', () => 'public feed updated'],
    storage: ['DATA', () => 'quota state refreshed'],
    airdrop: ['KEY', () => 'airdrop received · sealed for this device'],
    'dmcode.redeemed': ['KEY', () => 'one-time code redeemed'],
    'session.killed': ['WARN', () => 'session terminated'],
    'account.updated': ['WARN', () => 'account record updated by the operator'],
    'request.decision': ['DATA', () => 'request decision delivered'],
    global: ['WARN', () => 'server-wide state changed'],
    'users.changed': ['WARN', () => 'member list changed'],
    click: ['DATA', () => 'click counter updated'],
    neural: ['DATA', () => 'activity tick recorded'],
    'api.request': ['NET', (payload) => `${payload && payload.method ? payload.method : 'REQ'} ${maskPath(payload && payload.path)}`],
    'api.error': ['WARN', (payload) => `${(payload && payload.status) || 0} ${maskPath(payload && payload.path)}`],
    'api.offline': ['WARN', () => 'request failed · transport unreachable'],
  };

  function attach() {
    if (typeof API === 'undefined' || !API.on) return;
    API.on('*', (frame) => {
      if (!frame || !frame.event) return;
      const template = FEED[frame.event];
      if (!template) return;
      try {
        log(template[0], template[1](frame.payload));
      } catch { /* a malformed frame must not break the interface */ }
    });
  }

  attach();

  return {
    log, clear, open, close, toggle, mount,
    execute: runCommand,
    entries: () => entries.slice(),
    commands: () => Object.keys(COMMANDS),
    maskPath,
    kindCount: () => KINDS.length,
    isOpen,
    cap: CAP,
  };
})();

window.ConsoleLog = ConsoleLog;

// Registered as a surface so the start menu, deep links and shortcuts reach it.
Apps.register({
  id: 'console', title: 'Console', glyph: '›_', order: 95,
  description: 'Live activity log, and a command line for local interface settings.',
  keywords: ['log', 'console', 'terminal', 'activity', 'command'],
  run: () => ConsoleLog.toggle(),
});

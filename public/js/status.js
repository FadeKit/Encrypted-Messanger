/* ============================================================================
   AE Secure — 24-hour status bubbles

   The short note beside your name, in the shape people already know from
   Discord: a bubble that lives at most 24 hours, can be taken down at any
   moment, or set to a shorter window (30 minutes, 1 hour, 4 hours, 8 hours).
   "Keep until deleted" is offered too — it still expires at 24 hours, which is
   the ceiling the feature is defined by.

   The text is stored server-side as plain text on purpose: it is a public
   badge, not a message. Anything you would not put in your display name does
   not belong in it, and the composer says so.
   ========================================================================== */

const StatusBubble = (() => {
  const { el } = UI;

  const TTL_OPTIONS = [
    ['30m', '30 minutes'],
    ['1h', '1 hour'],
    ['4h', '4 hours'],
    ['8h', '8 hours'],
    ['24h', '24 hours (default)'],
    ['keep', 'Until I delete it'],
  ];

  const QUICK_EMOJI = ['', '💬', '🎧', '🌙', '🔥', '☕', '🎮', '💻', '📚', '🏃', '🎨', '✈️', '🍜', '😴', '🧠', '🛠️'];

  /** Turns the stored record into the small chip people see. */
  function chip(user, options = {}) {
    const record = user && user.statusMessage;
    if (!record || record.expired || (!record.text && !record.emoji)) return null;
    const mine = !!record.own || (State.user && user.id === State.user.id);
    // Two switches, both in the viewer's hands: one hides your own notes, the
    // other hides everybody else's.
    if (mine && !State.featureEnabled('statusBubbles')) return null;
    if (!mine && !State.featureEnabled('stores')) return null;
    const node = el('button', {
      class: `status-bubble ${options.compact ? 'compact' : ''} ${mine ? 'mine' : ''}`.trim(),
      type: 'button',
      title: mine ? 'Edit your status' : `${UI.timeAgo(record.updatedAt || record.createdAt)} · ${left(record)}`,
      onClick: (event) => {
        event.stopPropagation();
        if (mine) compose(record);
        else show(user);
      },
    }, [
      el('span', { class: 'bubble-mark', html: UI.icon('messages') }),
      record.emoji ? el('span', { class: 'bubble-emoji', text: record.emoji }) : null,
      el('span', { class: 'bubble-text', text: record.text || '' }),
      record.expiresAt ? el('span', { class: 'bubble-time', text: shortLeft(record) }) : null,
      mine ? el('span', { class: 'bubble-edit', html: UI.icon('edit') }) : null,
    ]);
    return node;
  }

  function left(record) {
    if (!record.expiresAt) return 'until you delete it';
    const ms = record.expiresAt - Date.now();
    if (ms <= 0) return 'expired';
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return hours >= 1 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
  }

  function shortLeft(record) {
    if (!record.expiresAt) return '';
    const ms = record.expiresAt - Date.now();
    if (ms <= 0) return 'expired';
    const hours = Math.ceil(ms / 3600000);
    return hours >= 1 ? `${hours}h` : `${Math.max(1, Math.ceil(ms / 60000))}m`;
  }

  /** Read-only view of someone else's bubble. */
  function show(user) {
    const record = user.statusMessage;
    if (!record) return;
    UI.dialog({
      title: `${user.displayName || user.username} — status`,
      icon: 'messages',
      size: 'narrow',
      content: el('div', { class: 'stack-12' }, [
        el('div', { class: 'status-bubble big' }, [
          record.emoji ? el('span', { class: 'bubble-emoji', text: record.emoji }) : null,
          el('span', { class: 'bubble-text', text: record.text || '' }),
        ]),
        el('div', { class: 'small muted', text: `Set ${UI.timeAgo(record.updatedAt || record.createdAt)} · ${left(record)}` }),
        el('div', { class: 'hint', text: 'Status notes disappear by themselves and never touch your messages.' }),
      ]),
    });
  }

  /** The composer, used both to post a new bubble and to edit the live one. */
  function compose(existing) {
    if (!State.featureEnabled('statusBubbles')) {
      UI.toast({ level: 'info', title: 'Status notes are switched off', body: 'Turn them back on in Settings → Privacy.' });
      return;
    }
    const text = el('input', { class: 'input', maxlength: '160', value: (existing && existing.text) || '', placeholder: 'What are you up to?' });
    const ttl = el('select', { class: 'input' }, TTL_OPTIONS.map(([value, label]) =>
      el('option', { value, text: label, selected: (existing && existing.ttl) === value || (!existing && value === '24h') })));
    let emoji = (existing && existing.emoji) || '';
    const emojiRow = el('div', { class: 'emoji-row' });
    const paintEmoji = () => {
      UI.clear(emojiRow);
      for (const candidate of QUICK_EMOJI) {
        emojiRow.append(el('button', {
          class: `emoji-pick ${candidate === emoji ? 'on' : ''}`.trim(),
          type: 'button',
          text: candidate || '∅',
          title: candidate ? `Use ${candidate}` : 'No symbol',
          onClick: () => { emoji = candidate; paintEmoji(); },
        }));
      }
    };
    paintEmoji();

    const save = async () => {
      try {
        const result = await API.put('/api/status', { text: text.value.trim(), emoji, ttl: ttl.value });
        State.set('user', Object.assign({}, State.user, { statusMessage: result.statusMessage }));
        State.emit('statusMessage', result.statusMessage);
        UI.toast({ level: 'success', title: result.statusMessage ? 'Status note posted' : 'Status note cleared' });
      } catch (error) {
        UI.toast({ level: 'danger', title: 'Could not set the note', body: error.message });
      }
    };

    const ref = UI.dialog({
      title: existing ? 'Edit your status note' : 'Set a status note',
      icon: 'messages',
      size: 'narrow',
      content: el('div', { class: 'stack-12' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Note' }), text]),
        el('div', { class: 'field' }, [el('label', { text: 'Symbol' }), emojiRow]),
        el('div', { class: 'field' }, [el('label', { text: 'How long' }), ttl]),
        el('div', { class: 'hint', text: 'A status note is public to everyone who can see your name, and it is stored unencrypted so it can show before your vault is unlocked. Never put secrets in it. The maximum is 24 hours.' }),
      ]),
      footer: [
        existing ? el('button', { class: 'btn danger', text: 'Delete note', onClick: async () => {
          try { await API.del('/api/status'); } catch { /* already gone */ }
          State.set('user', Object.assign({}, State.user, { statusMessage: null }));
          State.emit('statusMessage', null);
          UI.toast({ level: 'info', title: 'Status note deleted' });
          ref.close();
        } }) : null,
        el('button', { class: 'btn', text: 'Cancel', onClick: () => ref.close() }),
        el('button', { class: 'btn primary', text: existing ? 'Save note' : 'Post note', onClick: async () => {
          await save();
          ref.close();
        } }),
      ],
    });
  }

  return { chip, show, compose, TTL_OPTIONS, left };
})();

window.StatusBubble = StatusBubble;

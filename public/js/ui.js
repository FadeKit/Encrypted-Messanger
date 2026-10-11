/* ============================================================================
   AE Secure — UI kit: DOM helpers, toasts, dialogs, context menus, windows
   ========================================================================== */

const UI = (() => {
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function frag(children) {
    const fragment = document.createDocumentFragment();
    for (const child of [].concat(children)) if (child) fragment.append(child.nodeType ? child : document.createTextNode(String(child)));
    return fragment;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ------------------------------------------------------------- formatting
  function timeAgo(timestamp) {
    if (!timestamp) return 'never';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }

  function clockTime(timestamp, mode = 'absolute') {
    const date = new Date(timestamp);
    if (mode === 'relative') return timeAgo(timestamp);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return time;
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }

  function dateTime(timestamp) {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function duration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (days) return `${days}d ${hours}h ${minutes}m`;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }

  function bytes(value, { unlimited = 'Unlimited' } = {}) {
    if (value === -1 || value === null || value === undefined) return unlimited;
    if (!Number.isFinite(value)) return '—';
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const scaled = value / 1024 ** index;
    const digits = scaled >= 100 || index === 0 ? 0 : scaled >= 10 ? 1 : 2;
    return `${scaled.toFixed(digits)} ${units[index]}`;
  }

  function percent(part, whole) {
    if (!whole || whole < 0) return 0;
    return Math.min(100, Math.max(0, Math.round((part / whole) * 100)));
  }

  function initials(name) {
    const clean = String(name || '?').replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function hueFor(value) {
    let hash = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
    return hash;
  }

  // ---------------------------------------------------------------- avatars
  const avatarCache = new Map();

  function avatar(user, options = {}) {
    const size = options.size || '';
    const node = el('div', {
      class: `avatar ${size} ${options.square ? 'square' : ''}`.trim(),
      title: options.title || (user ? `${user.displayName || user.username}` : ''),
      dataset: options.status ? { status: options.status } : {},
    });
    const name = user ? (user.publicAlias || user.displayName || user.username) : '?';
    const wrap = el('span', { html: esc(initials(name)) });
    // Monochrome initials plate. Three deterministic ink treatments keep members
    // visually distinct in a list without introducing a colour of their own.
    node.dataset.tone = String(hueFor(user ? user.id || user.username : name) % 3);
    node.append(wrap);
    if (user && user.avatarId) {
      const cached = avatarCache.get(user.avatarId);
      if (cached) {
        clear(node).append(el('img', { src: cached, alt: '' }));
      } else {
        Media.loadAvatar(user.avatarId).then((url) => {
          if (!url) return;
          avatarCache.set(user.avatarId, url);
          clear(node).append(el('img', { src: url, alt: '' }));
        }).catch(() => {});
      }
    }
    if (options.status) node.dataset.status = options.status;
    else if (options.showStatus && user && user.status) node.dataset.status = user.status.key || 'offline';
    if (options.onClick) { node.style.cursor = 'pointer'; node.addEventListener('click', options.onClick); }
    return node;
  }

  function statusDot(key, label) {
    return el('span', {
      class: 'row-tight tiny',
      title: label,
      html: `<span style="width:8px;height:8px;display:inline-block;color:var(--status-${key === 'dnd' ? 'dnd' : key});background:var(--status-${key === 'dnd' ? 'dnd' : key});"></span>`,
    });
  }

  function verifiedBadge(user, small = true) {
    if (!user || !user.verified) return null;
    return el('span', { class: `verified-badge ${small ? 'sm' : ''}`, title: 'Verified by the operator', text: '✓' });
  }

  // ---------------------------------------------------------------- toasts
  function toast(options) {
    const config = typeof options === 'string' ? { title: options } : options;
    const stack = $('#toast-stack');
    if (!stack) return null;
    const node = el('div', { class: `toast ${config.level || ''}` });
    node.append(el('div', { class: 'toast-icon', text: config.glyph || { success: '✓', warning: '!', danger: '✕', info: 'i' }[config.level] || '◈' }));
    const body = el('div', { class: 'toast-body' });
    if (config.title) body.append(el('div', { class: 'body-strong', text: config.title }));
    if (config.body) body.append(el('div', { class: 'small muted', text: config.body }));
    if (config.actions && config.actions.length) {
      const actions = el('div', { class: 'toast-actions' });
      for (const action of config.actions) {
        actions.append(el('button', { class: `btn sm ${action.primary ? 'primary' : ''}`, text: action.label, onClick: () => { action.onClick && action.onClick(); dismiss(); } }));
      }
      body.append(actions);
    }
    node.append(body);
    node.append(el('button', { class: 'btn icon sm subtle', text: '✕', title: 'Dismiss', onClick: () => dismiss() }));
    let timeout = null;
    function dismiss() {
      clearTimeout(timeout);
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 200);
    }
    stack.append(node);
    const ms = config.duration || (config.actions ? 9000 : 4600);
    if (ms > 0) timeout = setTimeout(dismiss, ms);
    return { node, dismiss };
  }

  // --------------------------------------------------------------- dialogs
  function dialog(options) {
    const layer = $('#modal-layer');
    const scrim = el('div', { class: 'modal-scrim' });
    const modal = el('div', { class: `modal ${options.size || ''}` });
    const close = () => { layer.classList.remove('open'); clear(layer); options.onClose && options.onClose(); };
    modal.append(el('div', { class: 'modal-header' }, [
      el('div', { class: 'row' }, [
        options.glyph ? el('span', { class: 'title-2', text: options.glyph }) : null,
        el('div', { class: 'grow' }, [
          el('div', { class: 'title-2', text: options.title || '' }),
          options.subtitle ? el('div', { class: 'caption', text: options.subtitle }) : null,
        ]),
        el('button', { class: 'btn icon subtle', text: '✕', title: 'Close', onClick: close }),
      ]),
    ]));
    const body = el('div', { class: 'modal-body' });
    if (options.content) body.append(options.content);
    modal.append(body);
    if (options.footer) {
      const footer = el('div', { class: 'modal-footer' });
      for (const item of options.footer) footer.append(item);
      modal.append(footer);
    }
    scrim.addEventListener('click', () => { if (options.dismissable !== false) close(); });
    layer.append(scrim, modal);
    layer.classList.add('open');
    const api = { close, body, modal, el, clear, $: (sel) => $(sel, modal) };
    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape' && layer.classList.contains('open')) { close(); document.removeEventListener('keydown', onKey); }
    });
    return api;
  }

  function confirm(options) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      const dialogRef = dialog({
        title: options.title || 'Are you sure?',
        subtitle: options.subtitle,
        glyph: options.glyph || '!',
        size: 'narrow',
        content: el('div', { class: 'stack-8' }, [
          el('div', { class: 'caption', html: options.message || '' }),
          options.detail ? el('div', { class: 'notice-strip', html: options.detail }) : null,
        ]),
        footer: [
          el('button', { class: 'btn', text: options.cancelLabel || 'Cancel', onClick: () => { finish(false); dialogRef.close(); } }),
          el('button', { class: `btn ${options.danger ? 'danger' : 'primary'}`, text: options.confirmLabel || 'Confirm', onClick: () => { finish(true); dialogRef.close(); } }),
        ],
        onClose: () => finish(false),
      });
    });
  }

  function prompt(options) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      const input = el(options.multiline ? 'textarea' : 'input', {
        class: options.multiline ? 'textarea' : 'input',
        placeholder: options.placeholder || '',
        value: options.value || '',
        type: options.type || 'text',
      });
      if (options.required) input.required = true;
      const dialogRef = dialog({
        title: options.title || 'Enter a value',
        subtitle: options.subtitle,
        glyph: options.glyph || '✎',
        size: 'narrow',
        content: el('div', { class: 'stack-8' }, [
          options.message ? el('div', { class: 'caption', html: options.message }) : null,
          input,
          options.hint ? el('div', { class: 'hint', text: options.hint }) : null,
        ]),
        footer: [
          el('button', { class: 'btn', text: 'Cancel', onClick: () => { finish(null); dialogRef.close(); } }),
          el('button', {
            class: 'btn primary', text: options.confirmLabel || 'Save',
            onClick: () => {
              const value = input.value.trim();
              if (options.required && !value) { input.focus(); return; }
              finish(value);
              dialogRef.close();
            },
          }),
        ],
        onClose: () => finish(null),
      });
      setTimeout(() => input.focus(), 40);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !options.multiline) {
          event.preventDefault();
          const value = input.value.trim();
          if (!value && options.required) return;
          finish(value);
          dialogRef.close();
        }
      });
    });
  }

  // --------------------------------------------------------- context menus
  let openMenu = null;
  function contextMenu(items, position) {
    closeMenus();
    const menu = el('div', { class: 'context-menu' });
    for (const item of items) {
      if (!item) continue;
      if (item.separator) { menu.append(el('div', { class: 'sep' })); continue; }
      if (item.label && !item.onClick) { menu.append(el('div', { class: 'label', text: item.label })); continue; }
      menu.append(el('button', {
        class: item.danger ? 'danger' : '',
        disabled: item.disabled,
        onClick: () => { closeMenus(); item.onClick && item.onClick(); },
      }, [
        el('span', { text: item.glyph || '' }),
        el('span', { class: 'grow', text: item.label }),
        item.hint ? el('span', { class: 'hint', text: item.hint }) : null,
      ]));
    }
    document.body.append(menu);
    const { innerWidth, innerHeight } = window;
    const rect = menu.getBoundingClientRect();
    const x = Math.min(position.x, innerWidth - rect.width - 8);
    const y = Math.min(position.y, innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    openMenu = menu;
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
    return menu;
  }

  function onDocDown(event) { if (openMenu && !openMenu.contains(event.target)) closeMenus(); }
  function onEsc(event) { if (event.key === 'Escape') closeMenus(); }
  function closeMenus() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onEsc, true);
  }

  // --------------------------------------------------------------- helpers
  async function copy(text, message = 'Copied to clipboard') {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const area = el('textarea', { style: { position: 'fixed', opacity: '0' } });
        area.value = text;
        document.body.append(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      toast({ level: 'success', title: message, duration: 1800 });
      return true;
    } catch {
      toast({ level: 'warning', title: 'Copy failed', body: 'Select the text manually.' });
      return false;
    }
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function debounce(fn, wait = 220) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function throttle(fn, wait = 120) {
    let last = 0;
    let queued = null;
    return (...args) => {
      const now = Date.now();
      if (now - last >= wait) { last = now; fn(...args); }
      else {
        clearTimeout(queued);
        queued = setTimeout(() => { last = Date.now(); fn(...args); }, wait - (now - last));
      }
    };
  }

  function sparkline(values, options = {}) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sparkline');
    svg.setAttribute('viewBox', '0 0 100 30');
    svg.setAttribute('preserveAspectRatio', 'none');
    const max = Math.max(1, ...values);
    const step = values.length > 1 ? 100 / (values.length - 1) : 100;
    const points = values.map((value, index) => `${(index * step).toFixed(2)},${(28 - (value / max) * 26).toFixed(2)}`).join(' ');
    const area = `${points} 100,30 0,30`;
    svg.append(el('polygon', { points: area, fill: options.fill || 'rgba(76,194,255,0.18)' }));
    svg.append(el('polyline', { points, fill: 'none', stroke: options.stroke || 'var(--accent)', 'stroke-width': '1.4', 'vector-effect': 'non-scaling-stroke' }));
    return svg;
  }

  function meter(value, max, options = {}) {
    const pct = max === -1 ? 0 : percent(value, max);
    const track = el('div', { class: 'bar-track grow' });
    const fill = el('div', { class: `bar-fill ${pct > 92 ? 'danger' : pct > 75 ? 'warn' : ''}` });
    fill.style.width = `${pct}%`;
    track.append(fill);
    return el('div', { class: 'row', style: { gap: '10px' } }, [
      track,
      el('span', { class: 'tiny muted mono nowrap', text: max === -1 ? `${bytes(value)} / ∞` : `${bytes(value)} / ${bytes(max)}` }),
      options.hint ? el('span', { class: 'tiny faint', text: options.hint }) : null,
    ]);
  }

  function skeletonList(count = 5) {
    return el('div', { class: 'stack-8 pad-12' }, Array.from({ length: count }, () => el('div', { class: 'skeleton', style: { height: '42px' } })));
  }

  function empty(glyph, title, body, action) {
    return el('div', { class: 'empty-state' }, [
      el('div', { class: 'glyph', text: glyph }),
      el('div', { class: 'body-strong', text: title }),
      body ? el('div', { class: 'small muted', text: body }) : null,
      action || null,
    ]);
  }

  /**
   * Swipe right on a detail pane to go back to its list. Touch only: it reads
   * nothing but pointer travel and never prevents normal scrolling.
   */
  function swipeBack(node, handler) {
    if (!node || typeof handler !== 'function') return () => {};
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const begin = (event) => {
      const touch = event.touches ? event.touches[0] : event;
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    };
    const end = (event) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches ? event.changedTouches[0] : event;
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      const edge = node.getBoundingClientRect().left + 84;
      if (dx > 64 && dy < 56 && startX <= edge) handler();
    };
    node.addEventListener('touchstart', begin, { passive: true });
    node.addEventListener('touchend', end, { passive: true });
    return () => {
      node.removeEventListener('touchstart', begin);
      node.removeEventListener('touchend', end);
    };
  }

  function iconButton(glyph, title, onClick, extra = '') {
    return el('button', { class: `btn icon subtle ${extra}`, text: glyph, title, onClick });
  }

  return {
    $, $$, el, frag, clear, esc,
    timeAgo, clockTime, dateTime, duration, bytes, percent, initials, hueFor,
    avatar, statusDot, verifiedBadge, statusLabel,
    toast, dialog, confirm, prompt, contextMenu, closeMenus, swipeBack,
    copy, download, debounce, throttle, sparkline, meter, skeletonList, empty, iconButton,
  };

  function statusLabel(key) {
    return { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', purple: 'Online', offline: 'Offline' }[key] || 'Offline';
  }
})();
window.UI = UI;

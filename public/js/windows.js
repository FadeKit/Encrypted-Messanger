/* ============================================================================
   AE Secure — movable window manager: plates, chamfers, snapping, taskbar
   Drag, resize, snap layouts, minimise to the taskbar, maximise, z-order,
   per-window state memory and a mobile sheet mode for phone hosts.
   ========================================================================== */

const Windows = (() => {
  const { el, $ } = UI;
  const registry = new Map();   // id -> window record
  const taskbarButtons = new Map();
  let zCounter = 100;
  let focusedId = null;
  let snapPreview = null;
  // Matches the phone breakpoint in windows.css. Compact plates start at
  // 900px in CSS; below 760px they behave as full-screen phones.
  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

  const APP_ICONS = {
    messages: '▤', communities: '▩', stories: '◉', drive: '▦', files: '▥', airdrop: '⇣',
    settings: '⚙', admin: '⬢', profile: '◧', help: '▣', clicker: '⊞', airdropInbox: '⇣', cloud: '▦',
  };

  function desktop() { return $('#desktop'); }
  function taskbarStack() { return $('#taskbar-stack'); }

  function snapPreviewNode() {
    if (!snapPreview) {
      snapPreview = el('div', { id: 'snap-preview' });
      desktop().append(snapPreview);
    }
    return snapPreview;
  }

  function open(options) {
    const id = options.id || `win-${Math.random().toString(36).slice(2, 8)}`;
    if (registry.has(id) && options.singleton !== false) {
      const existing = registry.get(id);
      if (existing) { focus(id); if (existing.record.minimized) restore(id); return existing.record; }
    }
    const record = {
      id,
      title: options.title || 'Window',
      glyph: options.glyph || APP_ICONS[id] || '◈',
      subtitle: options.subtitle || '',
      minimized: false,
      maximized: false,
      pinned: !!options.pinned,
      bounds: null,
      geometry: Object.assign({ w: 720, h: 520, x: null, y: null }, options.geometry || {}),
      onClose: options.onClose || null,
      onFocus: options.onFocus || null,
      onResize: options.onResize || null,
      meta: options.meta || {},
      toolbar: null,
    };

    const titleNode = el('div', { class: 'window-title' }, [
      el('span', { text: record.title }),
      record.subtitle ? el('span', { class: 'sub', text: record.subtitle }) : null,
    ]);
    const pinButton = el('button', { class: 'caption-btn pin', title: 'Keep on top', html: '⌖', onClick: () => {
      record.pinned = !record.pinned;
      pinButton.classList.toggle('on', record.pinned);
      if (record.pinned) focus(id, true);
    } });
    const caption = el('div', { class: 'window-controls' }, [
      options.hidePin ? null : pinButton,
      el('button', { class: 'caption-btn', title: 'Minimize', html: '<svg viewBox="0 0 10 10"><rect x="0" y="4.4" width="10" height="1.2" fill="currentColor"/></svg>', onClick: () => minimize(id) }),
      el('button', { class: 'caption-btn', title: 'Maximize', html: '<svg viewBox="0 0 10 10"><rect x="0.6" y="0.6" width="8.8" height="8.8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>', onClick: () => toggleMaximize(id) }),
      el('button', { class: 'caption-btn close', title: 'Close', html: '<svg viewBox="0 0 10 10"><path d="M0.6 0.6 L9.4 9.4 M9.4 0.6 L0.6 9.4" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>', onClick: () => close(id) }),
    ]);
    const titlebar = el('div', { class: 'window-titlebar' }, [
      el('span', { class: 'glyph', text: record.glyph }),
      titleNode,
      caption,
    ]);

    const body = el('div', { class: 'window-body' });
    const win = el('div', { class: 'window', dataset: { win: id } }, [
      titlebar, body,
      ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].map((dir) => el('div', { class: `window-resize ${dir}`, dataset: { dir } })),
    ]);
    record.node = win;
    record.body = body;
    record.titleNode = titleNode;
    record.titlebar = titlebar;

    const geometry = loadGeometry(id, record.geometry);
    place(win, geometry);

    desktop().append(win);
    registry.set(id, { record, content: options.content || null, render: options.render || null });
    buildWindowBody(id, options);
    attachDrag(record, titlebar);
    attachResize(record);
    win.addEventListener('pointerdown', () => focus(id), true);
    focus(id);

    if (isMobile()) record.maximized = true;
    if (options.minimized) minimize(id);
    refreshTaskbar();

    return API(id);
  }

  function buildWindowBody(id, options) {
    const entry = registry.get(id);
    if (!entry) return;
    const { record, content, render } = entry;
    UI.clear(record.body);
    if (options && options.toolbar) {
      const toolbar = el('div', { class: 'toolbar' }, options.toolbar);
      record.body.append(toolbar);
      record.toolbar = toolbar;
    }
    if (content) record.body.append(content);
    else if (render) {
      const target = el('div', { class: 'pane', style: { flex: '1 1 auto' } });
      record.body.append(target);
      try { render(target, API(id)); } catch (error) {
        console.error('[ae] render failed for', id, error);
        target.append(UI.empty('!', 'This panel failed to render', error.message));
      }
    }
  }

  function loadGeometry(id, defaults) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(`ae.geo.${id}`) || 'null'); } catch { saved = null; }
    const base = Object.assign({}, defaults, saved || {});
    const width = Math.min(base.w, window.innerWidth - 24);
    const height = Math.min(base.h, window.innerHeight - 90);
    const offset = (registry.size % 7) * 26;
    const x = base.x === null || base.x === undefined ? Math.max(12, (window.innerWidth - width) / 2 - 60 + offset) : Math.min(base.x, window.innerWidth - 120);
    const y = base.y === null || base.y === undefined ? Math.max(12, (window.innerHeight - height) / 2 - 40 + offset) : Math.min(base.y, window.innerHeight - 70);
    return { x, y, w: width, h: height };
  }

  function saveGeometry(id, geometry) {
    try { localStorage.setItem(`ae.geo.${id}`, JSON.stringify(geometry)); } catch { /* ignore */ }
  }

  function place(node, geometry) {
    node.style.left = `${Math.round(geometry.x)}px`;
    node.style.top = `${Math.round(geometry.y)}px`;
    node.style.width = `${Math.round(geometry.w)}px`;
    node.style.height = `${Math.round(geometry.h)}px`;
  }

  function boundsOf(record) {
    const style = record.node.style;
    return { x: parseFloat(style.left), y: parseFloat(style.top), w: parseFloat(style.width), h: parseFloat(style.height) };
  }

  function captureBounds(record) {
    const rect = record.node.getBoundingClientRect();
    record.bounds = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }

  // ------------------------------------------------------------------ drag
  function attachDrag(record, handle) {
    let dragging = false;
    let start = null;
    let snapZone = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.caption-btn')) return;
      if (isMobile()) return;
      dragging = true;
      record.node.classList.add('dragging');
      const rect = record.node.getBoundingClientRect();
      start = { pointerX: event.clientX, pointerY: event.clientY, x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      handle.setPointerCapture(event.pointerId);
      if (record.maximized) {
        // un-maximise and continue under the cursor
        record.maximized = false;
        record.node.classList.remove('maximized');
        place(record.node, { x: start.pointerX - 120, y: start.pointerY - 18, w: start.w, h: start.h });
        start.x = start.pointerX - 120;
        start.y = start.pointerY - 18;
      }
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const dx = event.clientX - start.pointerX;
      const dy = event.clientY - start.pointerY;
      const x = Math.max(-start.w + 90, Math.min(window.innerWidth - 90, start.x + dx));
      const y = Math.max(0, Math.min(window.innerHeight - 62, start.y + dy));
      record.node.style.left = `${Math.round(x)}px`;
      record.node.style.top = `${Math.round(y)}px`;
      const zone = detectSnapZone(event.clientX, event.clientY);
      snapZone = zone;
      const preview = snapPreviewNode();
      if (zone) {
        const rect = zone.rect();
        Object.assign(preview.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
      } else {
        preview.style.display = 'none';
      }
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      record.node.classList.remove('dragging');
      snapPreviewNode().style.display = 'none';
      if (snapZone) applyZone(record, snapZone);
      else saveGeometry(record.id, boundsOf(record));
      snapZone = null;
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  const ZONES = {
    left: () => ({ x: 6, y: 6, w: window.innerWidth / 2 - 9, h: window.innerHeight - 74 }),
    right: () => ({ x: window.innerWidth / 2 + 3, y: 6, w: window.innerWidth / 2 - 9, h: window.innerHeight - 74 }),
    topLeft: () => ({ x: 6, y: 6, w: window.innerWidth / 2 - 9, h: (window.innerHeight - 74) / 2 - 3 }),
    topRight: () => ({ x: window.innerWidth / 2 + 3, y: 6, w: window.innerWidth / 2 - 9, h: (window.innerHeight - 74) / 2 - 3 }),
    bottomLeft: () => ({ x: 6, y: (window.innerHeight - 74) / 2 + 3, w: window.innerWidth / 2 - 9, h: (window.innerHeight - 74) / 2 - 3 }),
    bottomRight: () => ({ x: window.innerWidth / 2 + 3, y: (window.innerHeight - 74) / 2 + 3, w: window.innerWidth / 2 - 9, h: (window.innerHeight - 74) / 2 - 3 }),
  };

  function detectSnapZone(x, y) {
    const edge = 26;
    if (x <= edge) return y < window.innerHeight * 0.28 ? 'topLeft' : y > window.innerHeight * 0.72 ? 'bottomLeft' : 'left';
    if (x >= window.innerWidth - edge) return y < window.innerHeight * 0.28 ? 'topRight' : y > window.innerHeight * 0.72 ? 'bottomRight' : 'right';
    return null;
  }

  function applyZone(record, zone) {
    const rect = ZONES[zone]();
    record.node.classList.add('snapping');
    record.maximized = false;
    place(record.node, rect);
    saveGeometry(record.id, rect);
    setTimeout(() => record.node.classList.remove('snapping'), 240);
    if (record.onResize) record.onResize(rect);
  }

  // ---------------------------------------------------------------- resize
  function attachResize(record) {
    for (const handle of record.node.querySelectorAll('.window-resize')) {
      handle.addEventListener('pointerdown', (event) => {
        if (isMobile()) return;
        event.stopPropagation();
        const dir = handle.dataset.dir;
        const startRect = record.node.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        handle.setPointerCapture(event.pointerId);
        record.node.classList.add('dragging');
        const move = (moveEvent) => {
          let { left, top, width, height } = { left: startRect.left, top: startRect.top, width: startRect.width, height: startRect.height };
          const dx = moveEvent.clientX - startX;
          const dy = moveEvent.clientY - startY;
          if (dir.includes('e')) width = Math.max(320, startRect.width + dx);
          if (dir.includes('s')) height = Math.max(200, startRect.height + dy);
          if (dir.includes('w')) { width = Math.max(320, startRect.width - dx); left = startRect.left + (startRect.width - width); }
          if (dir.includes('n')) { height = Math.max(200, startRect.height - dy); top = startRect.top + (startRect.height - height); }
          place(record.node, { x: left, y: top, w: width, h: height });
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          record.node.classList.remove('dragging');
          const bounds = boundsOf(record);
          saveGeometry(record.id, bounds);
          if (record.onResize) record.onResize(bounds);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    }
  }

  // ----------------------------------------------------------------- state
  function focus(id, force = false) {
    const entry = registry.get(id);
    if (!entry) return;
    const { record } = entry;
    if (record.pinned && !force) return;
    for (const other of registry.values()) other.record.node.classList.remove('focused');
    record.node.classList.add('focused');
    record.node.style.zIndex = record.pinned ? 200 + (zCounter % 40) : ++zCounter;
    focusedId = id;
    refreshTaskbar();
    if (record.onFocus) record.onFocus();
  }

  function minimize(id) {
    const entry = registry.get(id);
    if (!entry) return;
    entry.record.minimized = true;
    entry.record.node.classList.add('minimized');
    if (focusedId === id) focusedId = null;
    refreshTaskbar();
  }

  function restore(id) {
    const entry = registry.get(id);
    if (!entry) return;
    entry.record.minimized = false;
    entry.record.node.classList.remove('minimized');
    focus(id, true);
    refreshTaskbar();
  }

  function toggleMaximize(id) {
    const entry = registry.get(id);
    if (!entry) return;
    const { record } = entry;
    if (!record.maximized) {
      captureBounds(record);
      record.maximized = true;
      record.node.classList.add('snapping');
      place(record.node, { x: 6, y: 6, w: window.innerWidth - 12, h: window.innerHeight - 74 });
      setTimeout(() => record.node.classList.remove('snapping'), 240);
      if (record.onResize) record.onResize(boundsOf(record));
    } else {
      record.maximized = false;
      const bounds = record.bounds || record.geometry;
      place(record.node, bounds);
      if (record.onResize) record.onResize(bounds);
    }
  }

  function close(id) {
    const entry = registry.get(id);
    if (!entry) return;
    const { record } = entry;
    if (record.onClose && record.onClose() === false) return;
    record.node.remove();
    registry.delete(id);
    if (focusedId === id) focusedId = null;
    refreshTaskbar();
  }

  function closeAll() { for (const id of [...registry.keys()]) close(id); }

  function get(id) { return registry.get(id)?.record || null; }
  function list() { return [...registry.values()].map((entry) => entry.record); }

  function setTitle(id, title, subtitle) {
    const record = get(id);
    if (!record) return;
    record.title = title;
    UI.clear(record.titleNode).append(
      el('span', { text: title }),
      subtitle ? el('span', { class: 'sub', text: subtitle }) : null,
    );
    refreshTaskbar();
  }

  function setToolbar(id, nodes) {
    const entry = registry.get(id);
    if (!entry) return;
    UI.clear(entry.record.toolbar || entry.record.body);
    const toolbar = entry.record.toolbar || el('div', { class: 'toolbar' });
    if (!entry.record.toolbar) entry.record.body.prepend(toolbar);
    for (const node of nodes) if (node) toolbar.append(node);
  }

  function setContent(id, nodes) {
    const entry = registry.get(id);
    if (!entry) return;
    UI.clear(entry.record.body);
    if (entry.record.toolbar) entry.record.body.append(entry.record.toolbar);
    for (const node of [].concat(nodes)) if (node) entry.record.body.append(node);
  }

  // --------------------------------------------------------------- taskbar
  function refreshTaskbar() {
    const stack = taskbarStack();
    if (!stack) return;
    for (const [id, record] of registry) {
      let button = taskbarButtons.get(id);
      if (!button) {
        button = el('button', { class: 'tb-btn', title: record.title, dataset: { win: id } }, [el('span', { text: record.glyph })]);
        button.addEventListener('click', () => {
          const entry = registry.get(id);
          if (!entry) return;
          if (entry.record.minimized) restore(id);
          else if (focusedId === id) minimize(id);
          else focus(id, true);
        });
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          UI.contextMenu([
            { glyph: '⤢', label: 'Restore', onClick: () => restore(id) },
            { glyph: '—', label: 'Minimize', onClick: () => minimize(id) },
            { glyph: '□', label: 'Maximize', onClick: () => toggleMaximize(id) },
            { separator: true },
            { glyph: '✕', label: 'Close', danger: true, onClick: () => close(id) },
          ], { x: event.clientX, y: event.clientY - 150 });
        });
        stack.append(button);
        taskbarButtons.set(id, button);
      }
      button.querySelector('span').textContent = record.glyph;
      button.title = record.title;
      button.classList.toggle('running', true);
      button.classList.toggle('focused', focusedId === id);
      button.classList.toggle('active', focusedId === id && !record.minimized);
    }
    for (const [id, button] of taskbarButtons) {
      if (!registry.has(id)) { button.remove(); taskbarButtons.delete(id); }
    }
  }

  // ------------------------------------------------------- keyboard shortcuts
  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'w' && focusedId) { event.preventDefault(); close(focusedId); }
    else if (mod && event.key.toLowerCase() === 'm' && focusedId) { event.preventDefault(); minimize(focusedId); }
    else if (mod && event.key === '`') {
      event.preventDefault();
      const ids = [...registry.keys()];
      if (!ids.length) return;
      const index = ids.indexOf(focusedId);
      const next = ids[(index + 1) % ids.length];
      focus(next, true);
    } else if (event.key === 'Escape' && focusedId && !UI.$('.context-menu')) {
      // escape leaves the window focused, closing stays explicit
    }
  });

  window.addEventListener('resize', UI.throttle(() => {
    for (const { record } of registry.values()) {
      if (record.maximized) place(record.node, { x: 6, y: 6, w: window.innerWidth - 12, h: window.innerHeight - 74 });
      else {
        const style = record.node.style;
        const x = Math.min(parseFloat(style.left), window.innerWidth - 120);
        const y = Math.min(parseFloat(style.top), window.innerHeight - 70);
        const w = Math.min(parseFloat(style.width), window.innerWidth - 12);
        style.left = `${Math.max(6, x)}px`;
        style.top = `${Math.max(6, y)}px`;
        style.width = `${w}px`;
      }
      if (record.onResize) record.onResize(boundsOf(record));
    }
  }, 160));

  function exists(id) { return registry.has(id); }
  function focusOrOpen(id, factory) {
    if (registry.has(id)) { restore(id); return API(id); }
    return factory();
  }

  function API(id) {
    const entry = registry.get(id);
    return {
      id,
      get record() { return registry.get(id)?.record || null; },
      body: entry ? entry.record.body : null,
      close: () => close(id),
      focus: () => focus(id, true),
      minimize: () => minimize(id),
      maximize: () => toggleMaximize(id),
      setTitle: (title, subtitle) => setTitle(id, title, subtitle),
      setToolbar: (nodes) => setToolbar(id, nodes),
      setContent: (nodes) => setContent(id, nodes),
      rebuild: (renderFn) => {
        const e = registry.get(id);
        if (!e) return;
        e.render = renderFn;
        buildWindowBody(id, { render: renderFn });
      },
      el,
    };
  }

  return { open, close, closeAll, focus, minimize, restore, toggleMaximize, get, list, exists, focusOrOpen, setTitle, setToolbar, setContent, refreshTaskbar, APP_ICONS };
})();

window.Windows = Windows;

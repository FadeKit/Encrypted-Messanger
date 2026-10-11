/* ============================================================================
   AE Secure — the viewer

   One surface for looking at anything the drive or a conversation holds: a
   picture you can zoom and pan, a video that plays with its own sound, an
   audio file with a transport, or a plain file with the details and a way to
   download it or read it in the editor.

   It is an ordinary window, deliberately.  On a desktop it can be dragged,
   resized, tiled against another window or sent to the taskbar and brought
   back from its tab; "maximise" makes it fill the screen and "fullscreen"
   takes the whole display.  On a phone it arrives full-screen as every surface
   does, with the back control in the title bar.
   ========================================================================== */

const FileKind = (() => {
  const KINDS = ['image', 'video', 'audio', 'text', 'file'];

  /** What a file is, as far as the viewer cares. */
  function kindFor(mime, name = '') {
    const type = String(mime || '').toLowerCase();
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    if (/^text\/|json|javascript|xml|html|csv|markdown/.test(type)) return 'text';
    if (/\.(txt|md|html?|css|js|json|csv|log|xml)$/i.test(name)) return 'text';
    return 'file';
  }

  const ICON = { image: 'image', video: 'film', audio: 'music', text: 'editor', file: 'files' };

  return { KINDS, kindFor, ICON, iconFor: (kind) => ICON[kind] || 'files' };
})();

const Viewer = (() => {
  const { el, clear } = UI;
  const viewerUrls = new Set();

  // The playlist the window is showing right now, and where in it we are.
  let items = [];
  let index = 0;
  let immersive = false;
  let opened = false;

  // per-item view state, so switching back and forth keeps a zoom level
  const viewState = new Map();

  const current = () => items[index] || null;

  function releaseUrls() {
    // The shell revokes these on sign out; here they are dropped when the
    // viewer closes so a long session does not hold every picture in memory.
    for (const url of viewerUrls) URL.revokeObjectURL(url);
    viewerUrls.clear();
  }

  /** Registers a blob url with the shell so signing out revokes it too. */
  function own(url) {
    if (!url) return '';
    viewerUrls.add(url);
    State.registerObjectUrl(url);
    return url;
  }

  // ------------------------------------------------------------------ items
  /**
   * Accepts a single item or a list.  An item is
   *   { url, name, mime, size, kind?, blob?, source? }
   * Anything without a url keeps its meta so the plate can name it.
   */
  function normalize(entry, fallbackName = 'file') {
    if (!entry) return null;
    const mime = entry.mime || entry.meta?.type || entry.type || '';
    const name = entry.name || fallbackName;
    return {
      url: entry.url || '',
      name,
      mime,
      size: entry.size || 0,
      blob: entry.blob || null,
      kind: entry.kind || FileKind.kindFor(mime, name),
      editor: !!entry.editor,
      file: entry.file || null,
      // how to get the bytes, when the surface that opened the viewer is the
      // one holding the key (a chat attachment is sealed under the channel key)
      resolve: typeof entry.resolve === 'function' ? entry.resolve : null,
      note: entry.note || '',
    };
  }

  // ------------------------------------------------------------- the window
  function layout(body, api) {
    return { body, api };
  }

  /**
   * Opens the viewer on a list of items at `start`.
   *   Viewer.open(items)                 one item, or a list
   *   Viewer.open(items, { index: 2 })   start at the third
   */
  function open(list, options = {}) {
    return Apps.open('viewer', { list, options });
  }

  /** The surface itself: what the shell runs when the viewer is summoned. */
  function show(list, options = {}) {
    const incoming = (Array.isArray(list) ? list : [list]).map((entry) => normalize(entry, options.name)).filter(Boolean);
    // Opened with nothing behind it — from a launcher or the console — the
    // window still opens and says so, rather than failing silently.
    items = incoming;
    index = Math.min(Math.max(options.index || 0, 0), items.length - 1);
    opened = true;
    const already = Windows.exists('viewer');
    Windows.open({
      id: 'viewer',
      title: current() ? current().name : 'Viewer',
      icon: FileKind.iconFor(current() ? current().kind : 'file'),
      geometry: { w: 980, h: 700 },
      render: (body, api) => paint(body, api),
      onClose: () => { opened = false; immersive = false; document.body.classList.remove('viewer-immersive'); releaseUrls(); },
    });
    // Built once and then reused: opening a second file from a grid replaces
    // the playlist inside the window that is already on screen.
    if (already) repaint();
    const record = Windows.get('viewer');
    if (record && record.minimized) Windows.restore('viewer');
    Windows.focus('viewer', true);
    return record;
  }

  function go(delta) {
    if (items.length < 2) return;
    index = (index + delta + items.length) % items.length;
    repaint();
  }

  function jump(to) {
    if (to < 0 || to >= items.length) return;
    index = to;
    repaint();
  }

  function repaint() {
    if (!Windows.exists('viewer')) return;
    Windows.rebuild('viewer');
  }

  // ------------------------------------------------------------ immersive
  /**
   * "Maximise" has two steps and both are here: the window fills the desktop,
   * and fullscreen takes the whole display.  The display itself is asked first
   * (so the browser hides its chrome), with the shell's own covering state as
   * the fallback on anything that refuses.
   */
  function setImmersive(on) {
    immersive = !!on;
    document.body.classList.toggle('viewer-immersive', immersive);
    const record = Windows.get('viewer');
    if (record) record.node.classList.toggle('immersive', immersive);
    const stage = record && record.body.querySelector('.viewer-stage');
    if (immersive) {
      if (stage && stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
    } else if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    repaint();
  }

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement || !immersive) return;
    // the display took the window away without the button being used
    if (!document.fullscreenElement && immersive && !Windows.get('viewer')) setImmersive(false);
  });

  // -------------------------------------------------------------- painting
  function toolbar(api, item) {
    if (!api.setToolbar) return;
    if (!item) { api.setToolbar([]); return; }
    const buttons = [];
    if (items.length > 1) {
      buttons.push(
        el('button', { class: 'btn sm subtle', html: UI.icon('back'), title: 'Previous (←)', onClick: () => go(-1) }),
        el('span', { class: 'pill tiny', text: `${index + 1} / ${items.length}` }),
        el('button', { class: 'btn sm subtle', html: UI.icon('forward'), title: 'Next (→)', onClick: () => go(1) }),
      );
    }
    if (item.kind === 'image') {
      const state = stateOf(item);
      buttons.push(
        el('button', { class: 'btn sm subtle', html: UI.icon('zoom-out'), title: 'Zoom out (−)', onClick: () => setZoom(state.zoom / 1.25) }),
        el('button', { class: 'btn sm subtle', html: UI.icon('zoom-in'), title: 'Zoom in (+)', onClick: () => setZoom(state.zoom * 1.25) }),
        el('button', { class: 'btn sm subtle', html: UI.icon('fit'), title: 'Fit to the window (0)', onClick: () => setZoom(1) }),
      );
    }
    if (item.kind === 'video' || item.kind === 'audio') {
      buttons.push(
        el('button', { class: 'btn sm subtle', html: UI.icon('volume'), title: 'Mute or unmute (M)', onClick: () => toggleMute() }),
        el('button', { class: 'btn sm subtle', text: '−10s', title: 'Back ten seconds', onClick: () => seek(-10) }),
        el('button', { class: 'btn sm subtle', text: '+10s', title: 'Forward ten seconds', onClick: () => seek(10) }),
      );
    }
    buttons.push(el('button', {
      class: 'btn sm subtle',
      html: UI.icon(immersive ? 'collapse' : 'expand'),
      title: immersive ? 'Leave fullscreen (F)' : 'Fullscreen (F)',
      onClick: () => setImmersive(!immersive),
    }));
    if (item.url || item.file) {
      buttons.push(el('button', {
        class: 'btn sm subtle', html: UI.icon('download'), title: 'Download & decrypt',
        onClick: () => download(item),
      }));
    }
    api.setToolbar(buttons);
  }

  function stateOf(item) {
    const key = item.url || item.name;
    if (!viewState.has(key)) viewState.set(key, { zoom: 1, x: 0, y: 0 });
    return viewState.get(key);
  }

  function setZoom(value) {
    const item = current();
    if (!item || item.kind !== 'image') return;
    const state = stateOf(item);
    state.zoom = Math.min(8, Math.max(0.2, value));
    if (state.zoom === 1) { state.x = 0; state.y = 0; }
    applyZoom();
  }

  function applyZoom() {
    const record = Windows.get('viewer');
    const item = current();
    if (!record || !item) return;
    const image = record.body.querySelector('.viewer-image');
    if (!image) return;
    const state = stateOf(item);
    image.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
    image.style.cursor = state.zoom > 1 ? 'grab' : 'zoom-in';
  }

  /**
   * A drive file and a chat attachment both arrive as ciphertext plus a wrapped
   * key.  This is where one becomes something on screen: unwrap the key,
   * download and decrypt a chunk at a time, read the sealed name back, and put
   * the plaintext blob url on the item.  Everything stays in this tab.
   */
  async function hydrate(item) {
    if (!item || item.url || item.hydrating) return item;
    // An item may arrive with its own way of producing bytes: a message
    // attachment is sealed under the channel key, not the master key, so the
    // surface that knows the channel hands over a resolver rather than a file.
    if (typeof item.resolve === 'function') {
      item.hydrating = true;
      try {
        const ready = await item.resolve();
        if (ready) {
          item.url = ready.url || item.url;
          item.blob = ready.blob || item.blob;
          if (ready.name) item.name = ready.name;
          item.mime = ready.mime || item.mime;
          item.size = ready.size || item.size;
          item.kind = FileKind.kindFor(item.mime, item.name);
          item.note = '';
        }
      } catch (error) {
        item.note = `This attachment could not be opened: ${error.message}`;
      }
      item.hydrating = false;
      repaint();
      return item;
    }
    if (!item.file) return item;
    item.hydrating = true;
    try {
      const file = item.file;
      const raw = await Media.resolveFileKey(file);
      if (!raw) {
        item.note = 'This device does not hold the key for this file.';
        item.hydrating = false;
        repaint();
        return item;
      }
      const mime = file.meta?.type || item.mime || 'application/octet-stream';
      const blob = await API.downloadDecrypted(file.id, { chunks: file.chunks, fileKeyRaw: raw, mime });
      const sealed = await Media.fileName(file, raw);
      item.blob = blob;
      item.url = own(URL.createObjectURL(blob));
      item.mime = mime;
      item.size = blob.size || item.size;
      item.kind = FileKind.kindFor(mime, sealed || item.name);
      if (sealed) item.name = sealed;
      item.editor = !!(file.meta && file.meta.editor) || /^text\//.test(mime);
      item.error = '';
    } catch (error) {
      item.note = `This file could not be opened: ${error.message}`;
      item.error = error.message;
    }
    item.hydrating = false;
    repaint();
    return item;
  }

  function mediaNode(item) {
    if (!item.url && (item.file || item.resolve)) {
      // Ciphertext in hand, plaintext on the way: a plate rather than a blank.
      const stage = el('div', { class: 'viewer-frame loading' });
      stage.append(
        el('div', { class: 'viewer-file-glyph', html: UI.icon(FileKind.iconFor(item.kind)) }),
        el('div', { class: 'body-strong', text: 'Decrypting…' }),
        el('div', { class: 'small muted', text: item.name }),
      );
      hydrate(item);
      return stage;
    }
    if (item.kind === 'image') {
      const stage = el('div', { class: 'viewer-frame' });
      const image = el('img', { class: 'viewer-image', src: item.url, alt: item.name, draggable: 'false' });
      const state = stateOf(item);
      // drag to pan, wheel to zoom, double tap to step between fit and 2x
      let dragging = null;
      image.addEventListener('pointerdown', (event) => {
        if (state.zoom <= 1) return;
        dragging = { x: event.clientX - state.x, y: event.clientY - state.y };
        image.setPointerCapture(event.pointerId);
        image.style.cursor = 'grabbing';
      });
      image.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        state.x = event.clientX - dragging.x;
        state.y = event.clientY - dragging.y;
        applyZoom();
      });
      const stop = (event) => {
        if (!dragging) return;
        dragging = null;
        image.style.cursor = 'grab';
        if (event.pointerId != null && image.hasPointerCapture?.(event.pointerId)) image.releasePointerCapture(event.pointerId);
      };
      image.addEventListener('pointerup', stop);
      image.addEventListener('pointercancel', stop);
      image.addEventListener('wheel', (event) => {
        event.preventDefault();
        setZoom(state.zoom * (event.deltaY < 0 ? 1.12 : 0.89));
      }, { passive: false });
      image.addEventListener('dblclick', () => setZoom(state.zoom > 1 ? 1 : 2));
      stage.append(image);
      requestAnimationFrame(applyZoom);
      return stage;
    }

    if (item.kind === 'video') {
      const stage = el('div', { class: 'viewer-frame dark' });
      const video = el('video', {
        class: 'viewer-video',
        src: item.url,
        controls: true,
        playsinline: '',
        'webkit-playsinline': '',
        preload: 'metadata',
      });
      video.volume = 1;
      video.muted = false;
      stage.append(video);
      // Autoplay with sound is allowed only when the browser still counts the
      // click that opened this; when it refuses, the file gets a play plate
      // rather than a silent black rectangle.
      const attempt = video.play();
      if (attempt && attempt.catch) {
        attempt.catch(() => {
          const cover = el('button', {
            class: 'viewer-play', html: `<span class="viewer-play-glyph">${UI.icon('play')}</span><span>Play with sound</span>`,
            title: 'Start playback',
            onClick: () => { cover.remove(); video.play().catch(() => {}); },
          });
          stage.append(cover);
        });
      }
      video.addEventListener('error', () => {
        clear(stage);
        stage.append(wrapNote(item, 'This browser cannot decode this video. You can still download it.', true));
      });
      stage.append(el('div', { class: 'viewer-caption', text: `${item.name}${item.size ? ` · ${UI.bytes(item.size)}` : ''}` }));
      return stage;
    }

    if (item.kind === 'audio') {
      const stage = el('div', { class: 'viewer-frame audio' });
      const audio = el('audio', { class: 'viewer-audio', src: item.url, controls: true, preload: 'metadata' });
      audio.volume = 1;
      audio.muted = false;
      const attempt = audio.play();
      if (attempt && attempt.catch) attempt.catch(() => {});
      stage.append(
        el('div', { class: 'viewer-audio-plate' }, [
          el('div', { class: 'viewer-audio-glyph', html: UI.icon('music') }),
          el('div', { class: 'body-strong truncate', text: item.name }),
          el('div', { class: 'tiny faint', text: item.size ? UI.bytes(item.size) : 'audio' }),
        ]),
        audio,
      );
      return stage;
    }

    // anything else: the details, the two useful actions, and nothing guessed
    const stage = el('div', { class: 'viewer-frame file' });
    stage.append(wrapNote(item, item.note || '', false));
    return stage;
  }

  function wrapNote(item, note, dark) {
    const files = item.file;
    const rows = [
      el('div', { class: 'viewer-file-glyph', html: UI.icon(FileKind.iconFor(item.kind)) }),
      el('div', { class: 'body-strong truncate', text: item.name }),
      el('div', { class: 'small muted', text: [item.mime || 'unknown type', item.size ? UI.bytes(item.size) : ''].filter(Boolean).join(' · ') }),
    ];
    if (note) rows.push(el('div', { class: 'notice-strip', html: `<span>!</span><span>${UI.esc(note)}</span>` }));
    const actions = el('div', { class: 'row wrap' });
    if (item.url || files) actions.append(el('button', { class: 'btn sm', html: `${UI.icon('download')}<span>Download &amp; decrypt</span>`, onClick: () => download(item) }));
    if ((item.kind === 'text' || item.editor) && files) {
      actions.append(el('button', { class: 'btn sm', html: `${UI.icon('editor')}<span>Open in the editor</span>`, onClick: () => { Windows.close('viewer'); FileEditor.openFromFile(files); } }));
    }
    if (files) actions.append(el('button', { class: 'btn sm subtle', text: 'File details', onClick: () => details(item) }));
    if (actions.children.length) rows.push(actions);
    return el('div', { class: `viewer-file ${dark ? 'dark' : ''}` }, rows);
  }

  async function download(item) {
    try {
      if (item.blob) { UI.download(item.blob, item.name); return; }
      if (item.file) {
        const raw = await AE.unwrapKey(State.masterKey(), item.file.keyWrap);
        const blob = await API.downloadDecrypted(item.file.id, { chunks: item.file.chunks, fileKeyRaw: raw, mime: item.file.meta?.type || 'application/octet-stream' });
        const name = (await Media.fileName(item.file, raw)) || item.name;
        UI.download(blob, name);
        return;
      }
      const response = await fetch(item.url);
      UI.download(await response.blob(), item.name);
    } catch (error) {
      UI.toast({ level: 'danger', title: 'Could not download this file', body: error.message });
    }
  }

  function details(item) {
    const file = item.file || {};
    UI.dialog({
      title: 'Encrypted file',
      icon: FileKind.iconFor(item.kind),
      content: el('div', { class: 'stack-8 small' }, [
        el('div', { text: `Name: ${item.name}` }),
        el('div', { text: `Type: ${item.mime || 'unknown'}` }),
        el('div', { text: `Ciphertext size: ${UI.bytes(file.size || item.size || 0)}` }),
        file.chunks ? el('div', { text: `Chunks: ${file.chunks} × 512 KiB sealed blocks` }) : null,
        el('div', { class: 'tiny faint', text: 'The server holds ciphertext and a wrapped key. Nothing here was readable to it.' }),
      ].filter(Boolean)),
      actions: [{ label: 'Close' }],
    });
  }

  // --------------------------------------------------------------- sound
  function activeMedia() {
    const record = Windows.get('viewer');
    if (!record) return null;
    return record.body.querySelector('video.viewer-video, audio.viewer-audio');
  }

  function toggleMute() {
    const media = activeMedia();
    if (!media) return;
    media.muted = !media.muted;
    const item = current();
    UI.toast({ level: 'info', icon: media.muted ? 'mute' : 'volume', title: media.muted ? 'Sound off' : 'Sound on', body: item ? item.name : '', duration: 2200 });
  }

  function seek(seconds) {
    const media = activeMedia();
    if (!media || Number.isNaN(media.duration)) return;
    media.currentTime = Math.min(Math.max(0, media.currentTime + seconds), media.duration || 0);
  }

  // -------------------------------------------------------------- painting
  function paint(body, api) {
    const item = current();
    clear(body);
    if (!item) {
      body.classList.toggle('viewer-body', true);
      body.append(el('div', { class: 'viewer-stage' }, [
        el('div', { class: 'viewer-file' }, [
          el('div', { class: 'viewer-file-glyph', html: UI.icon('image') }),
          el('div', { class: 'body-strong', text: 'Nothing open' }),
          el('div', { class: 'small muted', text: 'Pick a picture, a clip or any other file in the Cloud Drive, in a conversation, or in My files, and it opens here.' }),
          el('div', { class: 'row wrap' }, [
            el('button', { class: 'btn sm', html: `${UI.icon('cloud')}<span>Cloud Drive</span>`, onClick: () => Apps.open('drive') }),
            el('button', { class: 'btn sm subtle', html: `${UI.icon('files')}<span>My files</span>`, onClick: () => Apps.open('files') }),
          ]),
        ]),
      ]));
      Windows.setTitle('viewer', 'Viewer', 'nothing open');
      api.setToolbar([]);
      return;
    }
    body.classList.toggle('viewer-body', true);
    body.classList.toggle('immersive', immersive);
    Windows.setTitle('viewer', item.name, items.length > 1 ? `${index + 1} of ${items.length}` : (item.mime || ''));

    const stage = el('div', { class: 'viewer-stage' }, [mediaNode(item)]);
    body.append(stage);

    // a strip of the rest of the set: one tap to any of them
    if (items.length > 1) {
      const strip = el('div', { class: 'viewer-strip' });
      items.forEach((entry, position) => {
        strip.append(el('button', {
          class: position === index ? 'viewer-thumb on' : 'viewer-thumb',
          dataset: { position: String(position) },
          title: entry.name,
          onClick: () => jump(position),
        }, [
          el('span', { class: 'glyph', html: UI.icon(FileKind.iconFor(entry.kind)) }),
          el('span', { class: 'truncate', text: entry.name }),
        ]));
      });
      body.append(strip);
    }

    toolbar(api, item);
    wireKeys(body);
  }

  // ------------------------------------------------------------- keyboard
  function wireKeys(body) {
    if (body.dataset.viewerKeys === '1') return;
    body.dataset.viewerKeys = '1';
    body.tabIndex = -1;
    body.addEventListener('keydown', (event) => {
      const media = activeMedia();
      const item = current();
      if (event.key === 'Escape') {
        if (immersive) { setImmersive(false); event.stopPropagation(); }
        return;
      }
      if (event.key === 'ArrowRight') { go(1); event.preventDefault(); return; }
      if (event.key === 'ArrowLeft') { go(-1); event.preventDefault(); return; }
      if (event.key === 'f' || event.key === 'F') { setImmersive(!immersive); return; }
      if (event.key === 'm' || event.key === 'M') { toggleMute(); return; }
      if (!item) return;
      if (item.kind === 'image') {
        if (event.key === '+' || event.key === '=') setZoom(stateOf(item).zoom * 1.25);
        else if (event.key === '-') setZoom(stateOf(item).zoom / 1.25);
        else if (event.key === '0') setZoom(1);
        return;
      }
      if (!media) return;
      if (event.key === ' ' && !media.paused) { media.pause(); event.preventDefault(); }
      else if (event.key === ' ') { media.play().catch(() => {}); event.preventDefault(); }
      else if (event.key === 'ArrowUp') { media.volume = Math.min(1, media.volume + 0.1); event.preventDefault(); }
      else if (event.key === 'ArrowDown') { media.volume = Math.max(0, media.volume - 0.1); event.preventDefault(); }
    });
  }

  // ------------------------------------------------------- the drive, ready
  /**
   * The drive hands over the folder as it is listed, so ← and → walk from one
   * file to the next without going back to the grid.
   */
  function openDrive(files, startIndex = 0) {
    const list = (files || []).filter(Boolean);
    if (!list.length) return null;
    const at = Math.max(0, Math.min(startIndex, list.length - 1));
    const items = list.map((file) => ({
      // a drive cell opens a decrypting plate first: the bytes are fetched once
      // the viewer is on screen, so the window appears immediately
      name: file.displayName || 'Encrypted file',
      mime: file.meta?.type || '',
      size: file.size,
      kind: FileKind.kindFor(file.meta?.type, ''),
      file,
    }));
    // The name is sealed under the file key, so read it back straight away and
    // let the strip say what each file is instead of "Encrypted file".
    items.forEach((item, position) => {
      if (item.mime && item.mime !== 'application/octet-stream') return;
      Promise.resolve(Media.fileName(item.file)).then((name) => {
        if (!name) return;
        item.name = name;
        item.kind = FileKind.kindFor(item.mime, name);
        const record = Windows.get('viewer');
        const label = record && record.body.querySelector(`.viewer-thumb[data-position="${position}"] .truncate`);
        if (label) label.textContent = name;
      }).catch(() => {});
    });
    return open(items, { index: at, drive: true });
  }

  // The shell launches the viewer like any other surface; the app id is what
  // the switcher sheet, the taskbar and the window manager already understand.
  Apps.register({
    id: 'viewer', title: 'Viewer', icon: 'image', order: 62, hidden: true,
    description: 'Shows and plays anything you open: pictures you can zoom and pan, video and audio with sound, and other files with their details.',
    keywords: ['viewer', 'play', 'watch', 'listen', 'sound', 'zoom', 'video', 'image', 'audio', 'maximize', 'tab', 'fullscreen'],
    run: (meta) => show((meta && meta.list) || [], (meta && meta.options) || {}),
  });

  return {
    open,
    openDrive,
    next: () => go(1),
    previous: () => go(-1),
    toggleImmersive: () => setImmersive(!immersive),
    get isOpen() { return opened; },
    kindFor: FileKind.kindFor,
  };
})();

window.Viewer = Viewer;


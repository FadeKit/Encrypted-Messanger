/* ============================================================================
   AE Secure — the desktop background

   A picture for the desktop, chosen by the person looking at it and sealed the
   same way everything else here is: uploaded as ciphertext under this account's
   master key, decrypted in this tab, and never named to the server.  The server
   stores a blob it cannot read; the browser draws it.

   The library lives in the account's settings, so it follows the account to any
   device that can unlock the vault — and nowhere else.
   ========================================================================== */

const Background = (() => {
  const { el } = UI;
  const MAX_STORED = 6;
  const MAX_BYTES = 12 * 1024 * 1024;
  // object urls this module owns; the shell revokes its own set on sign out
  const urls = new Map();
  let painted = null;

  const FITS = {
    cover: { size: 'cover', repeat: 'no-repeat', position: 'center' },
    contain: { size: 'contain', repeat: 'no-repeat', position: 'center' },
    tile: { size: 'auto', repeat: 'repeat', position: 'top left' },
    centre: { size: 'auto', repeat: 'no-repeat', position: 'center' },
    stretch: { size: '100% 100%', repeat: 'no-repeat', position: 'center' },
  };

  function settings() { return State.settings(); }

  /**
   * Saving a setting does not repaint the shell on its own — the settings page
   * calls that itself.  The background library is changed from more than one
   * place, so it repaints for itself.
   */
  function repaint() {
    if (window.Shell && Shell.applyTheme) Shell.applyTheme();
    else apply();
  }

  function list() {
    const stored = settings().backgrounds;
    return Array.isArray(stored) ? stored.filter((entry) => entry && entry.id) : [];
  }

  function active() {
    const id = settings().wallpaperFileId;
    return id ? list().find((entry) => entry.id === id) || null : null;
  }

  /**
   * Renders the picture into a canvas once and hands back a new blob: this is
   * where "match the interface" happens, so a colour photograph becomes a
   * picture printed in the same ink as everything else.  It costs one frame per
   * file and the result is cached for the session.
   */
  async function tone(blob) {
    if (!settings().wallpaperTone) return blob;
    try {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      // Wallpapers are drawn behind windows; a desktop-sized copy is plenty and
      // keeps a phone's memory flat when the original is a 12-megapixel photo.
      const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close && bitmap.close();
      if (ctx.filter !== undefined) {
        // Safari and Firefox take the filter here; Chromium reads the pixels
        // below instead.  Either path ends in grayscale.
        ctx.filter = 'grayscale(1) contrast(1.06)';
        ctx.drawImage(canvas, 0, 0);
        ctx.filter = 'none';
      } else {
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = frame.data;
        for (let i = 0; i < data.length; i += 4) {
          const grey = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
          const lifted = Math.max(0, Math.min(255, (grey - 128) * 1.06 + 128));
          data[i] = lifted; data[i + 1] = lifted; data[i + 2] = lifted;
        }
        ctx.putImageData(frame, 0, 0);
      }
      const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
      return out || blob;
    } catch (error) {
      console.warn('[ae] the background could not be toned', error);
      return blob;
    }
  }

  function keyFor(entry) {
    return `${entry.id}:${settings().wallpaperTone ? 'tone' : 'plain'}`;
  }

  /** The decrypted, toned object url for one library entry, cached per session. */
  async function urlFor(entry) {
    const key = keyFor(entry);
    if (urls.has(key)) return urls.get(key);
    const info = await API.get(`/api/files/${entry.id}`);
    const file = info.file;
    const raw = await AE.unwrapKey(State.masterKey(), file.keyWrap);
    if (!raw) throw new Error('this device does not hold the key for that picture');
    const mime = file.meta?.type || entry.mime || 'image/*';
    const blob = await API.downloadDecrypted(file.id, { chunks: file.chunks, fileKeyRaw: raw, mime });
    const picture = await tone(blob);
    const url = URL.createObjectURL(picture);
    State.registerObjectUrl(url);
    urls.set(key, url);
    return url;
  }

  /** What the desktop is currently showing: the picture and how it is drawn. */
  function signature(entry, fit, dim) {
    return `${entry.id}|${fit}|${dim}`;
  }

  function clearPaint() {
    const desktop = document.getElementById('desktop');
    if (!desktop) return;
    desktop.style.removeProperty('--wall-image');
    desktop.style.removeProperty('--wall-size');
    desktop.style.removeProperty('--wall-repeat');
    desktop.style.removeProperty('--wall-position');
    desktop.style.removeProperty('--wall-dim');
    painted = null;
  }

  /**
   * Puts the chosen picture on the desktop, or takes it off again.  Nothing
   * here is allowed to throw: it runs from a theme pass that cannot wait for it,
   * and a broken wallpaper must never take the desktop with it.
   */
  async function apply() {
    try {
      await paint();
    } catch (error) {
      console.warn('[ae] the background could not be applied', error);
      clearPaint();
    }
  }

  async function paint() {
    const desktop = document.getElementById('desktop');
    if (!desktop) return;
    const entry = active();
    const wall = settings().wallpaper;
    if (wall !== 'custom' || !entry) {
      document.body.dataset.wall = wall === 'custom' ? 'theme' : (wall || 'theme') === 'theme' ? '' : wall;
      clearPaint();
      return;
    }
    document.body.dataset.wall = 'custom';
    const fitName = settings().wallpaperFit || 'cover';
    const fit = FITS[fitName] || FITS.cover;
    const dim = Math.max(0, Math.min(80, Number(settings().wallpaperDim) || 0));
    // A dark wash keeps labels readable on the ink ramps; on the paper ramp it
    // has to lift instead, or the page turns to mud.
    const wash = document.body.dataset.theme === 'chrome' ? '255, 255, 255' : '0, 0, 0';
    // Fitting, dimming and the wash are part of the draw, not just the file: a
    // change to any of them repaints even though the picture is the same one.
    const wanted = `${signature(entry, fitName, dim)}|${wash}`;
    if (painted === wanted && desktop.style.getPropertyValue('--wall-image')) return;
    try {
      const url = await urlFor(entry);
      // The picture is the bottom layer of the desktop; the dim sits above it
      // and the theme's grid stays on top, so the design language survives a
      // photograph the user picked themselves.
      desktop.style.setProperty('--wall-image', `linear-gradient(rgba(${wash}, ${dim / 100}), rgba(${wash}, ${dim / 100})), url("${url}")`);
      desktop.style.setProperty('--wall-size', `${fit.size}, ${fit.size}`);
      desktop.style.setProperty('--wall-repeat', `${fit.repeat}, ${fit.repeat}`);
      desktop.style.setProperty('--wall-position', `${fit.position}, ${fit.position}`);
      painted = wanted;
    } catch (error) {
      console.warn('[ae] the background could not be shown', error);
      clearPaint();
      UI.toast({ level: 'warning', title: 'That background could not be shown', body: error.message });
      if (settings().wallpaper === 'custom') State.saveSettings({ wallpaper: 'theme' });
    }
  }

  /** Uploads a picture, seals it, and adds it to the library. */
  async function upload(file) {
    if (!file) return null;
    if (!/^image\//.test(file.type)) {
      UI.toast({ level: 'warning', title: 'That is not a picture', body: 'Use a PNG, JPEG, WebP or GIF.' });
      return null;
    }
    if (file.size > MAX_BYTES) {
      UI.toast({ level: 'warning', title: 'That picture is too large', body: `Backgrounds are capped at ${UI.bytes(MAX_BYTES)} — this one is ${UI.bytes(file.size)}.` });
      return null;
    }
    const library = list();
    if (library.length >= MAX_STORED) {
      UI.toast({ level: 'info', title: 'The background library is full', body: `Delete one of the ${MAX_STORED} stored pictures first.` });
      return null;
    }
    const name = (file.name || 'background').replace(/\.[^.]+$/, '').slice(0, 40);
    try {
      const result = await API.uploadEncrypted({
        kind: 'background',
        blob: file,
        meta: { type: file.type, nameWrapped: null },
        wrapFileKey: (raw) => AE.wrapKey(State.masterKey(), raw),
        onProgress: () => {},
        label: 'background',
      });
      const entry = { id: result.fileId, name, mime: file.type, size: file.size, at: Date.now() };
      const next = library.concat(entry).slice(-MAX_STORED);
      await State.saveSettings({ backgrounds: next, wallpaper: 'custom', wallpaperFileId: entry.id });
      repaint();
      UI.toast({ level: 'success', title: 'Background set', body: `${name} is encrypted and now behind your windows.` });
      return entry;
    } catch (error) {
      UI.toast({ level: 'danger', title: 'Could not store that background', body: error.message });
      return null;
    }
  }

  /** Chooses one from the library. */
  async function use(id) {
    await State.saveSettings({ wallpaper: 'custom', wallpaperFileId: id });
    repaint();
  }

  /** Removes one from the library, ciphertext and all. */
  async function remove(id) {
    const entry = list().find((item) => item.id === id);
    if (!entry) return;
    const confirmed = await UI.confirm({
      title: 'Delete this background?',
      message: `${entry.name} is removed from the server. Any device showing it falls back to the theme's backdrop.`,
      danger: true, confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    const next = list().filter((item) => item.id !== id);
    const patch = { backgrounds: next };
    if (settings().wallpaperFileId === id) {
      patch.wallpaperFileId = next.length ? next[next.length - 1].id : null;
      patch.wallpaper = next.length ? 'custom' : 'theme';
    }
    await State.saveSettings(patch);
    await API.del(`/api/files/${id}`).catch(() => {});
    repaint();
    const cached = urls.get(`${id}:tone`) || urls.get(`${id}:plain`);
    if (cached) { URL.revokeObjectURL(cached); urls.delete(`${id}:tone`); urls.delete(`${id}:plain`); }
    painted = null;
  }

  /** After a sign-out: nothing of this account is left on the desktop. */
  function reset() {
    urls.clear();
    painted = null;
    clearPaint();
  }

  /** Drops every cached render — used when the tone or fit changes. */
  function invalidate() {
    for (const [key, url] of urls.entries()) {
      if (key.endsWith(':tone') || key.endsWith(':plain')) { URL.revokeObjectURL(url); urls.delete(key); }
    }
    painted = null;
  }

  /** A small preview tile for the settings page. */
  function preview(entry, size = 'md') {
    const node = el('div', { class: `wall-thumb wall-thumb-${size}`, 'data-name': entry.name });
    urlFor(entry).then((url) => { node.style.backgroundImage = `url("${url}")`; }).catch(() => node.classList.add('missing'));
    return node;
  }

  return { list, active, apply, upload, use, remove, invalidate, reset, preview, MAX_STORED, MAX_BYTES, FITS };
})();

window.Background = Background;

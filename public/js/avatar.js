/* ============================================================================
   AE Secure — profile pictures

   Uploading a picture is not enough: a phone camera shot is 4000px wide and
   square-cropped avatar boxes would cut people's heads off.  This module gives
   the profile screen a real editor —

     · pick a file, paste one, or drag it in
     · crop it on a canvas with a live preview, pan by dragging, zoom with a
       slider or a pinch
     · switch between the last three pictures without uploading anything again
     · the crop happens on the device; only the cropped, encrypted square is
       ever sent to the server

   Nothing here writes to the server on its own: it hands the finished blob to
   the caller.
   ========================================================================== */

const AvatarEditor = (() => {
  const { el } = UI;
  const OUTPUT = 512;            // exported square, large enough for every surface
  const MAX_HISTORY = 3;

  /**
   * Opens the cropper.  `resolve(blob)` receives a PNG square, or null when the
   * person backs out.
   */
  function openCrop(source, { title = 'Crop your picture', resolve } = {}) {
    const image = new Image();
    const state = { scale: 1, minScale: 1, offsetX: 0, offsetY: 0, dragging: false, lastX: 0, lastY: 0 };

    const canvas = el('canvas', { class: 'crop-canvas', width: 320, height: 320 });
    const preview = el('canvas', { class: 'crop-preview', width: 64, height: 64 });
    const zoom = el('input', { type: 'range', min: '100', max: '400', value: '100', class: 'crop-zoom' });
    const stage = el('div', { class: 'crop-stage' }, [canvas, el('div', { class: 'crop-guide' })]);
    const status = el('div', { class: 'hint', text: 'Drag to move · pinch or use the slider to zoom' });

    let settled = false;
    const finish = (blob) => { if (!settled) { settled = true; ref.close(); resolve(blob); } };

    const ref = UI.dialog({
      title,
      icon: 'camera',
      size: 'narrow',
      content: el('div', { class: 'stack-12' }, [
        stage,
        el('div', { class: 'row' }, [el('span', { class: 'uppercase tiny', text: 'Zoom' }), zoom, el('span', { class: 'grow' }), preview]),
        status,
      ]),
      footer: [
        el('button', { class: 'btn', text: 'Cancel', onClick: () => finish(null) }),
        el('button', { class: 'btn primary', text: 'Use this crop', onClick: () => canvasToBlob() }),
      ],
    });

    function draw() {
      const ctx = canvas.getContext('2d');
      const size = canvas.width;
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--fill-input') || '#000';
      ctx.fillRect(0, 0, size, size);
      const w = image.width * state.scale;
      const h = image.height * state.scale;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, (size - w) / 2 + state.offsetX, (size - h) / 2 + state.offsetY, w, h);

      const pctx = preview.getContext('2d');
      pctx.clearRect(0, 0, preview.width, preview.height);
      pctx.imageSmoothingQuality = 'high';
      pctx.drawImage(canvas, 0, 0, size, size, 0, 0, preview.width, preview.height);
    }

    function clampOffsets() {
      const size = canvas.width;
      const w = image.width * state.scale;
      const h = image.height * state.scale;
      const maxX = Math.max(0, (w - size) / 2);
      const maxY = Math.max(0, (h - size) / 2);
      state.offsetX = Math.min(maxX, Math.max(-maxX, state.offsetX));
      state.offsetY = Math.min(maxY, Math.max(-maxY, state.offsetY));
    }

    zoom.addEventListener('input', () => {
      state.scale = state.minScale * (Number(zoom.value) / 100);
      clampOffsets();
      draw();
    });

    stage.addEventListener('pointerdown', (event) => {
      state.dragging = true;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointermove', (event) => {
      if (!state.dragging) return;
      state.offsetX += event.clientX - state.lastX;
      state.offsetY += event.clientY - state.lastY;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      clampOffsets();
      draw();
    });
    const stop = (event) => {
      state.dragging = false;
      try { stage.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    };
    stage.addEventListener('pointerup', stop);
    stage.addEventListener('pointercancel', stop);

    // wheel zoom for a mouse, two-finger pinch for touch
    stage.addEventListener('wheel', (event) => {
      event.preventDefault();
      const next = Math.min(400, Math.max(100, Number(zoom.value) - Math.sign(event.deltaY) * 8));
      zoom.value = String(next);
      zoom.dispatchEvent(new Event('input'));
    }, { passive: false });

    let pinchStart = null;
    stage.addEventListener('touchstart', (event) => {
      if (event.touches.length === 2) {
        pinchStart = { distance: touchDistance(event), value: Number(zoom.value) };
      }
    }, { passive: true });
    stage.addEventListener('touchmove', (event) => {
      if (event.touches.length !== 2 || !pinchStart) return;
      const ratio = touchDistance(event) / pinchStart.distance;
      zoom.value = String(Math.min(400, Math.max(100, pinchStart.value * ratio)));
      zoom.dispatchEvent(new Event('input'));
    }, { passive: true });
    stage.addEventListener('touchend', () => { pinchStart = null; });

    const touchDistance = (event) => Math.hypot(
      event.touches[0].clientX - event.touches[1].clientX,
      event.touches[0].clientY - event.touches[1].clientY,
    );

    /** Exports the visible square as a PNG blob. */
    function canvasToBlob() {
      const out = el('canvas', { width: OUTPUT, height: OUTPUT });
      const ctx = out.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, OUTPUT, OUTPUT);
      out.toBlob((blob) => finish(blob), 'image/png', 0.92);
    }

    image.onload = () => {
      // cover the square: a portrait shot is scaled so its short edge fills
      const size = canvas.width;
      state.minScale = Math.max(size / image.width, size / image.height);
      state.scale = state.minScale;
      state.offsetX = 0;
      state.offsetY = 0;
      draw();
    };
    image.onerror = () => {
      status.textContent = 'That file is not an image the browser can read.';
    };
    image.src = source;
    return ref;
  }

  /** Reads a File into a data URL, refusing anything that is not an image. */
  function fromFile(file) {
    if (!file) return Promise.resolve(null);
    if (!/^image\//.test(file.type)) {
      UI.toast({ level: 'warning', title: 'That is not an image', body: 'Pick a PNG, JPEG, GIF or WebP.' });
      return Promise.resolve(null);
    }
    const limit = State.settings().maxAvatarBytes || 8 * 1024 * 1024;
    if (file.size > limit) {
      UI.toast({ level: 'warning', title: 'Picture is too large', body: `Keep it under ${UI.bytes(limit)}.` });
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  /**
   * The history strip: the current picture plus the last three, each one click
   * away from becoming current again.
   */
  function historyStrip({ onChange } = {}) {
    const host = el('div', { class: 'avatar-strip' });
    let history = (State.user.avatarHistory || []).slice(0, MAX_HISTORY);

    async function refresh() {
      try {
        const data = await API.get('/api/profile/avatars');
        history = data.avatars.map((entry) => entry.fileId);
        State.set('user', Object.assign({}, State.user, { avatarId: data.current, avatarHistory: history }));
      } catch { /* keep what we have */ }
      paint();
    }

    function paint() {
      UI.clear(host);
      const current = State.user.avatarId;
      const ids = [current, ...history.filter((id) => id !== current)].slice(0, MAX_HISTORY + 1);
      if (!ids.length) {
        host.append(el('div', { class: 'small faint', text: 'No picture yet — add one and it is kept here to switch back.' }));
        return;
      }
      ids.forEach((fileId, index) => {
        const slot = el('button', {
          class: `avatar-slot ${fileId === current ? 'on' : ''}`,
          title: fileId === current ? 'Current picture' : 'Switch back to this one',
          onClick: async () => {
            if (fileId === current) return;
            const updated = await API.patch('/api/profile', { avatarId: fileId });
            State.set('user', updated.user);
            onChange && onChange();
            paint();
            UI.toast({ level: 'success', title: 'Profile picture switched' });
          },
        }, [
          el('span', { class: 'slot-frame' }, [UI.avatar({ id: 'me', avatarId: fileId, username: State.user.username }, { size: 'md', plain: true })]),
          el('span', { class: 'slot-label', text: index === 0 ? 'In use' : `Previous ${index}` }),
        ]);
        host.append(slot);
      });
    }

    refresh();
    return { node: host, refresh, paint };
  }

  return { openCrop, fromFile, historyStrip, MAX_HISTORY };
})();

window.AvatarEditor = AvatarEditor;

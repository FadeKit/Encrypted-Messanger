/* ============================================================================
   AE Secure — cloud drive and personal file vault
   Storage is granted by the operator through requests; uploads are limited only
   by the space that remains in the account.
   ========================================================================== */

const DriveClient = (() => {
  const { el, clear } = UI;
  const thumbUrls = new Map();
  let currentFolder = null;
  let view = { id: 'drive', folderId: null };

  async function refreshStatus() {
    const data = await API.get('/api/files');
    State.set('files', data.files);
    State.emit('storage', { drive: data.storage.drive, uploads: data.storage.uploads });
    const driveButton = UI.$('#drive-meter');
    if (driveButton) paintMeter(driveButton, data.storage.drive);
    return data;
  }

  function paintMeter(host, drive) {
    clear(host);
    host.append(UI.meter(drive.used, drive.quota));
  }

  function storageSummary() {
    return el('div', { class: 'row wrap small muted', id: 'drive-meter' });
  }

  // ------------------------------------------------------------- drive view
  function renderDrive(body, api) {
    clear(body);
    view = { id: 'drive', folderId: null };
    const pane = el('div', { class: 'pane' });
    body.append(pane);

    const meterHost = storageSummary();
    const header = el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'body-strong', text: 'Cloud drive' }),
        el('div', { class: 'tiny faint', text: 'Encrypted with your master key — only your devices can read it.' }),
      ]),
      meterHost,
      el('button', { class: 'btn sm', text: 'Request more space', onClick: () => Settings.open('requests') }),
      el('button', { class: 'btn sm', text: 'New file', onClick: () => FileEditor.create({ onSaved: () => Apps.open('drive') }) }),
      el('button', { class: 'btn sm', text: 'New folder', onClick: () => newFolder() }),
      el('button', { class: 'btn sm primary', text: 'Upload', onClick: () => picker() }),
    ]);

    const toolbar2 = el('div', { class: 'toolbar' }, []);
    const grid = el('div', { class: 'pane-scroll stack-12' });
    const uploads = el('div', { class: 'stack-6', style: { padding: '0 14px' } });
    const drop = el('div', { class: 'dropzone', text: 'Drop files here to encrypt and upload — only your remaining space limits the size.' });

    drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (event) => {
      event.preventDefault();
      drop.classList.remove('over');
      for (const file of [...event.dataTransfer.files]) await uploadFile(file, uploads);
    });

    pane.append(header, toolbar2, uploads, drop, grid);
    api.setToolbar([]);
    paint();

    async function paint() {
      clear(grid);
      clear(toolbar2);
      const status = await API.get('/api/files').catch(() => null);
      if (status) {
        State.set('files', status.files);
        State.emit('storage', { drive: status.storage.drive, uploads: status.storage.uploads });
      }
      const drive = status ? status.storage.drive : { used: 0, quota: -1 };
      paintMeter(meterHost, drive);
      if (drive.quota !== -1 && drive.used / drive.quota > 0.9) {
        grid.append(el('div', { class: 'notice-strip warn', html: `<span>!</span><span>You have used ${UI.bytes(drive.used)} of ${UI.bytes(drive.quota)}. Request more capacity in Settings → Storage.</span>` }));
      }
      const folders = await API.get('/api/drive/folders').catch(() => ({ folders: [] }));
      const files = (State.get('files') || []).filter((file) => file.kind === 'drive');
      const folderList = folders.folders.filter((folder) => (folder.parentId || null) === view.folderId);

      if (view.folderId) {
        const parent = folders.folders.find((folder) => folder.id === view.folderId);
        const root = folders.folders.find((folder) => folder.id === view.folderId && !folder.parentId);
        toolbar2.append(
          el('span', { class: 'pill tiny', text: `▢ ${view.folderId.slice(0, 6)}` }),
          root ? null : el('button', { class: 'btn sm subtle', text: '‹ Up one level', onClick: () => { view.folderId = parent ? parent.parentId : null; paint(); } }),
        );
      }

      const folderGrid = el('div', { class: 'drive-grid' });
      for (const folder of folderList) {
        const name = await AE.decryptJson(State.masterKey(), folder.payload).then((plain) => (plain && plain.name) || 'Folder').catch(() => 'Folder');
        const cell = el('div', { class: 'drive-cell', onClick: () => { view.folderId = folder.id; clear(toolbar2); paint(); } });
        cell.append(el('div', { class: 'thumb', text: '' }), el('div', { class: 'truncate small', text: name }), el('div', { class: 'tiny faint', text: UI.dateTime(folder.createdAt) }));
        cell.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          UI.contextMenu([
            { icon: 'messages', label: 'Open', onClick: () => { view.folderId = folder.id; clear(toolbar2); paint(); } },
            { icon: 'editor', label: 'Rename', onClick: async () => {
              const next = await UI.prompt({ title: 'Rename folder', value: name });
              if (!next) return;
              await API.patch(`/api/drive/folders/${folder.id}`, { payload: await AE.encryptJson(State.masterKey(), { name: next }) });
              paint();
            } },
            { icon: 'trash', label: 'Delete folder', danger: true, onClick: async () => {
              if (!await UI.confirm({ title: 'Delete this folder?', message: 'Files inside move back to the drive root.', danger: true, confirmLabel: 'Delete' })) return;
              await API.del(`/api/drive/folders/${folder.id}`);
              paint();
            } },
          ], { x: event.clientX, y: event.clientY });
        });
        folderGrid.append(cell);
      }

      const visible = files.filter((file) => (view.folderId ? file.ref?.folderId === view.folderId : !file.ref?.folderId));
      const gridHost = el('div', { class: 'drive-grid' });
      if (!folderList.length && !visible.length) {
        grid.append(UI.empty('drive', 'Your drive is empty', drive.quota === -1 ? 'Unlimited space is available on this account.' : `${UI.bytes(Math.max(0, drive.quota - drive.used))} of space is ready to use.`));
      }
      for (const file of visible) gridHost.append(driveCell(file));
      if (folderList.length) grid.append(el('div', {}, [el('div', { class: 'uppercase', text: 'Folders' }), folderGrid]));
      if (visible.length) grid.append(el('div', {}, [el('div', { class: 'uppercase', text: 'Files' }), gridHost]));
      grid.prepend(el('div', { class: 'row tiny faint pad-8' }, [
        el('span', { text: `${files.length} encrypted files · names and contents are unreadable to the server` }),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn sm subtle', text: 'Refresh', onClick: () => paint() }),
      ]));
    }

    function picker() {
      const input = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
      input.addEventListener('change', async () => {
        for (const file of [...input.files]) await uploadFile(file, uploads);
        input.remove();
      });
      document.body.append(input);
      input.click();
    }

    async function uploadFile(file, host) {
      if (!State.featureEnabled('uploads')) { UI.toast({ level: 'info', title: 'Uploads are switched off in your settings' }); return; }
      const status = await API.get('/api/files');
      const { drive } = status.storage;
      if (drive.quota !== -1 && file.size > drive.quota - drive.used) {
        UI.toast({
          level: 'danger', title: 'Not enough drive space',
          body: `${file.name} needs ${UI.bytes(file.size)}; ${UI.bytes(Math.max(0, drive.quota - drive.used))} remains.`,
          actions: [{ label: 'Request more space', primary: true, onClick: () => Settings.open('requests') }],
        });
        return;
      }
      const row = el('div', { class: 'upload-row' }, [
        el('div', { class: 'name' }, [el('span', { text: '▦' }), el('span', { class: 'grow truncate', text: file.name }), el('span', { class: 'tiny faint', text: '0%' })]),
        el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill' })]),
      ]);
      host.append(row);
      try {
        await API.uploadEncrypted({
          kind: 'drive',
          blob: file,
          meta: { type: file.type, width: 0, height: 0 },
          ref: { folderId: view.folderId },
          wrapFileKey: (raw) => AE.wrapKey(State.masterKey(), raw),
          onProgress: ({ percent }) => { row.querySelector('.bar-fill').style.width = `${percent}%`; row.querySelector('.tiny').textContent = `${percent}%`; },
        });
        row.querySelector('.tiny').textContent = '✓ stored';
        setTimeout(() => row.remove(), 2200);
        await refreshStatus();
        paint();
      } catch (error) {
        row.querySelector('.tiny').textContent = '✕ failed';
        UI.toast({ level: 'danger', title: 'Upload failed', body: error.message });
        setTimeout(() => row.remove(), 2600);
      }
    }
  }

  /** Reads the file's name back out of `meta.nameWrapped` when it has one. */
  // Kept as a local name for the drive's own reads; the work lives in Media so
  // the editor can resolve the same sealed name without a second copy.
  const encryptedName = (file, rawKey) => Media.fileName(file, rawKey);

  function isTextish(file) {
    const type = (file.meta && file.meta.type) || '';
    return (file.meta && file.meta.editor) || /^text\//.test(type) || /json|javascript|xml|html|csv/.test(type);
  }

  function driveCell(file) {
    const cell = el('div', { class: 'drive-cell' });
    const thumb = el('div', { class: 'thumb', text: '' });
    const label = el('div', { class: 'truncate small', text: 'Encrypted file' });
    cell.append(thumb, label, el('div', { class: 'tiny faint', text: `${UI.bytes(file.size)} · ${UI.timeAgo(file.createdAt)}` }));
    (async () => {
      const name = await encryptedName(file);
      if (name) label.textContent = name;
    })();
    (async () => {
      const raw = await AE.unwrapKey(State.masterKey(), file.keyWrap);
      if (!raw) { thumb.textContent = '▨'; return; }
      const mime = file.meta?.type || '';
      if (mime.startsWith('image/')) {
        if (thumbUrls.has(file.id)) {
          clear(thumb).append(el('img', { src: thumbUrls.get(file.id), alt: '' }));
          return;
        }
        const blob = await API.downloadDecrypted(file.id, { chunks: file.chunks, fileKeyRaw: raw, mime });
        const url = URL.createObjectURL(blob);
        State.registerObjectUrl(url);
        thumbUrls.set(file.id, url);
        clear(thumb).append(el('img', { src: url, alt: '' }));
      } else if (mime.startsWith('video/')) thumb.textContent = '▤';
      else if (mime.includes('pdf')) thumb.textContent = '¶';
      else if (mime.includes('zip')) thumb.textContent = '⌸';
      else if (mime.startsWith('audio/')) thumb.textContent = '♪';
      else thumb.textContent = '≡';
    })();
    cell.addEventListener('click', async () => {
      const raw = await AE.unwrapKey(State.masterKey(), file.keyWrap);
      if (!raw) { UI.toast({ level: 'warning', title: 'Key unavailable for this file' }); return; }
      const mime = file.meta?.type || 'application/octet-stream';
      const blob = await API.downloadDecrypted(file.id, { chunks: file.chunks, fileKeyRaw: raw, mime });
      if (mime.startsWith('image/')) Viewer.open(URL.createObjectURL(blob), 'encrypted image');
      else if (mime.startsWith('video/')) Viewer.open(URL.createObjectURL(blob), 'encrypted video', 'video');
      else UI.download(blob, `ae-drive-${file.id.slice(0, 8)}`);
    });
    cell.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      UI.contextMenu([
        isTextish(file) ? { icon: 'editor', label: 'Open in the editor', onClick: () => FileEditor.openFromFile(file) } : null,
        { icon: 'download', label: 'Download & decrypt', onClick: async () => {
          const raw = await AE.unwrapKey(State.masterKey(), file.keyWrap);
          const blob = await API.downloadDecrypted(file.id, { chunks: file.chunks, fileKeyRaw: raw, mime: file.meta?.type || 'application/octet-stream' });
          const name = await encryptedName(file, raw);
          UI.download(blob, name || `ae-drive-${file.id.slice(0, 8)}`);
        } },
        { icon: 'console', label: 'File details', onClick: () => UI.dialog({
          title: 'Encrypted file',
          icon: 'console',
          content: el('div', { class: 'stack-8 small' }, [
            el('div', { text: `Ciphertext size: ${UI.bytes(file.size)}` }),
            el('div', { text: `Chunks: ${file.chunks} × 512 KiB sealed blocks` }),
            el('div', { text: `Uploaded: ${UI.dateTime(file.createdAt)}` }),
            el('div', { text: `Key wrap: ${file.keyWrap ? 'wrapped with your master key' : 'missing'}` }),
            el('div', { class: 'notice-strip', html: '<span>▨</span><span>Contents never reach the server in readable form. A file made in the editor also carries its name as ciphertext.</span>' }),
          ]),
        }) },
        { icon: 'trash', label: 'Delete', danger: true, onClick: async () => {
          if (!await UI.confirm({ title: 'Delete this file?', message: 'Space is returned to your drive quota immediately.', danger: true, confirmLabel: 'Delete' })) return;
          await API.del(`/api/files/${file.id}`);
          await refreshStatus();
          Apps.open('drive');
        } },
      ], { x: event.clientX, y: event.clientY });
    });
    return cell;
  }

  async function newFolder() {
    const name = await UI.prompt({ title: 'New folder', placeholder: 'Folder name', confirmLabel: 'Create' });
    if (!name) return;
    await API.post('/api/drive/folders', { parentId: view.folderId, payload: await AE.encryptJson(State.masterKey(), { name }) });
    Apps.open('drive');
  }

  // -------------------------------------------------------------- my files
  function renderFiles(body, api) {
    clear(body);
    const pane = el('div', { class: 'pane' });
    const meterHost = storageSummary();
    const list = el('div', { class: 'pane-scroll stack-8' });
    const header = el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'body-strong', text: 'My uploads' }),
        el('div', { class: 'tiny faint', text: 'Every attachment you have sent: chats, communities, stories and airdrops.' }),
      ]),
      meterHost,
      el('button', { class: 'btn sm', text: 'New file', onClick: () => FileEditor.create() }),
      el('button', { class: 'btn sm', text: 'Refresh', onClick: () => paint() }),
    ]);
    pane.append(header, list);
    body.append(pane);
    api.setToolbar([]);
    paint();

    async function paint() {
      clear(list);
      const status = await API.get('/api/files');
      State.set('files', status.files);
      paintMeter(meterHost, status.storage.drive);
      const groups = {};
      for (const file of status.files) {
        groups[file.kind] = groups[file.kind] || [];
        groups[file.kind].push(file);
      }
      if (!status.files.length) {
        list.append(UI.empty('files', 'Nothing uploaded yet', 'Chats, communities and drive files appear here.'));
        return;
      }
      const labels = { dm: '▤ Chat attachments', forum: '▩ Community media', drive: '▦ Drive files', story: '◉ Stories', airdrop: '⇣ Airdrops', avatar: '◧ Avatars', public: '◍ Public posts' };
      for (const [kind, files] of Object.entries(groups)) {
        const section = el('div', { class: 'stack-6' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'body-strong', text: labels[kind] || kind }),
            el('span', { class: 'pill tiny', text: String(files.length) }),
            el('span', { class: 'pill tiny ghost', text: UI.bytes(files.reduce((sum, file) => sum + file.size, 0)) }),
          ]),
        ]);
        for (const file of files.slice(0, 60)) {
          section.append(el('div', { class: 'list-item' }, [
            el('span', { style: { fontSize: '18px' }, text: file.meta?.type?.startsWith('image/') ? '▣' : '≡' }),
            el('div', { class: 'meta' }, [
              el('div', { class: 'name', text: UI.bytes(file.size) }),
              el('div', { class: 'sub', text: `${UI.dateTime(file.createdAt)} · ${file.chunks} chunks` }),
            ]),
            el('span', { class: 'pill tiny', text: file.complete ? 'sealed' : 'partial' }),
            el('button', { class: 'btn sm danger', text: 'Delete', onClick: async () => {
              if (!await UI.confirm({ title: 'Delete this file?', message: 'The ciphertext blob is removed from the server.', danger: true, confirmLabel: 'Delete' })) return;
              await API.del(`/api/files/${file.id}`);
              await refreshStatus();
              paint();
            } }),
          ]));
        }
        list.append(section);
      }
    }
  }

  return { refreshStatus, renderDrive: renderDrive, renderFiles: renderFiles };
})();

window.DriveClient = DriveClient;

Apps.register({
  id: 'drive', title: 'Cloud Drive', icon: 'drive', order: 20, featureFlag: 'drive',
  description: 'Encrypted personal cloud storage with folders and space requests.',
  keywords: ['cloud', 'drive', 'storage', 'files', 'folders', 'quota', 'upload'],
  run: () => Windows.open({
    id: 'drive', title: 'Cloud Drive', icon: 'drive', geometry: { w: 1040, h: 680 },
    render: (body, api) => DriveClient.renderDrive(body, api),
  }),
});

Apps.register({
  id: 'files', title: 'My Files', icon: 'files', order: 22, featureFlag: 'drive',
  description: 'Every encrypted upload you own, grouped by destination.',
  keywords: ['uploads', 'attachments', 'files', 'storage'],
  run: () => Windows.open({
    id: 'files', title: 'My Files', icon: 'files', geometry: { w: 780, h: 620 },
    render: (body, api) => DriveClient.renderFiles(body, api),
  }),
});

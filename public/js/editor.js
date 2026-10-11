/* ============================================================================
   AE Secure — text and file editor

   A small, honest editor for the things people make on a phone: notes, lists,
   config snippets, an HTML page.  It is deliberately not an IDE.

     · create a .txt, .md, .html, .css, .js, .json or .csv file
     · edit an existing one, with a live preview for HTML and Markdown
     · save it straight to the encrypted cloud drive (or to chat attachments)
     · download it, or copy it to the clipboard
     · everything is sealed on the device before it leaves; the server never
       sees the text

   Files saved here are ordinary drive files, so they appear in Cloud Drive and
   in My files like anything else.
   ========================================================================== */

const FileEditor = (() => {
  const { el } = UI;

  const TEMPLATES = [
    {
      id: 'text', label: 'Text file', ext: 'txt', icon: 'editor', language: 'plain',
      description: 'Plain notes, lists, anything at all.',
      body: '',
    },
    {
      id: 'note', label: 'Markdown note', ext: 'md', icon: 'editor', language: 'markdown',
      description: 'Headings, lists and links with a live preview.',
      body: '# Title\n\n- first point\n- second point\n',
    },
    {
      id: 'html', label: 'HTML page', ext: 'html', icon: 'console', language: 'html',
      description: 'A web page you can preview and keep in your drive.',
      body: '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <title>New page</title>\n</head>\n<body>\n  <h1>Hello</h1>\n</body>\n</html>\n',
    },
    {
      id: 'css', label: 'Stylesheet', ext: 'css', icon: 'editor', language: 'css',
      description: 'Styles for a page you are making.',
      body: ':root { color-scheme: dark; }\n',
    },
    {
      id: 'js', label: 'Script', ext: 'js', icon: 'console', language: 'javascript',
      description: 'A small script, saved in your drive.',
      body: '// scratch pad\n',
    },
    {
      id: 'json', label: 'JSON data', ext: 'json', icon: 'editor', language: 'json',
      description: 'Structured data, validated as you type.',
      body: '{\n  "name": "value"\n}\n',
    },
    {
      id: 'csv', label: 'CSV table', ext: 'csv', icon: 'editor', language: 'csv',
      description: 'Comma-separated rows, saved as plain text.',
      body: 'name,value\n',
    },
  ];

  /** Warns about broken JSON before it is stored, not after. */
  function validate(language, text) {
    if (language === 'json' && text.trim()) {
      try { JSON.parse(text); } catch (error) { return error.message; }
    }
    if (language === 'csv') {
      const rows = text.split('\n').filter((row) => row.trim());
      const widths = new Set(rows.map((row) => row.split(',').length));
      if (widths.size > 1) return 'Rows have different numbers of columns.';
    }
    return null;
  }

  function byteLength(text) {
    return new Blob([text]).size;
  }

  function slug(name) {
    return String(name || 'untitled')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'untitled';
  }

  function ensureExtension(name, ext) {
    const clean = slug(name);
    if (!ext) return clean;
    return clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${clean}.${ext}`;
  }

  /**
   * The editor window.  `file` is an optional { name, text, language } to open
   * an existing document.
   */
  function open(file = {}, options = {}) {
    if (!State.featureEnabled('editor')) {
      UI.toast({ level: 'info', title: 'The editor is switched off', body: 'Turn it back on in Settings → General.' });
      return null;
    }
    const template = TEMPLATES.find((entry) => entry.id === (file.template || options.template)) || TEMPLATES[0];
    let language = file.language || template.language;
    let currentName = file.name || '';
    let text = file.text || '';

    const nameInput = el('input', { class: 'input', placeholder: 'file-name', value: currentName.replace(/\.[a-z0-9]+$/i, '') });
    const extSelect = el('select', { class: 'input' }, TEMPLATES
      .filter((entry, index, all) => all.findIndex((other) => other.ext === entry.ext) === index)
      .map((entry) => el('option', { value: entry.ext, text: `.${entry.ext}`, selected: entry.ext === (file.ext || template.ext) })));
    const area = el('textarea', { class: 'editor-area', spellcheck: 'false', value: text });
    const preview = el('div', { class: 'editor-preview' });
    const previewPane = () => body.querySelector('#editor-preview-pane');
    const status = el('div', { class: 'editor-status' });

    const saveDrive = el('button', { class: 'btn primary sm', text: 'Save to Drive', onClick: () => save('drive') });
    const saveChat = el('button', { class: 'btn sm', text: 'Save to Files', onClick: () => save('files') });

    function currentExt() { return extSelect.value; }
    function currentFileName() { return ensureExtension(nameInput.value || 'untitled', currentExt()); }

    function payload() {
      const body = area.value;
      const comment = { txt: '', md: '', html: '', css: '', js: '' };
      const header = comment[currentExt()] === undefined ? '' : '';
      return header + body;
    }

    function refreshPreview() {
      const body = area.value;
      const problem = validate(language, body);
      status.textContent = [
        currentFileName(),
        `${byteLength(body)} bytes`,
        `${body.split('\n').length} lines`,
        problem ? `⚠ ${problem}` : '',
      ].filter(Boolean).join(' · ');
      status.classList.toggle('bad', !!problem);

      const showPreview = language === 'html' || language === 'markdown';
      const pane = previewPane();
      if (pane) pane.style.display = showPreview ? 'flex' : 'none';
      if (!showPreview) return;
      // The preview is sandboxed in an iframe with no scripts: pasted markup
      // cannot reach this app's session, and nothing here is trusted.
      const doc = language === 'html'
        ? body
        : `<!doctype html><meta charset="utf-8"><body style="font:14px/1.6 system-ui;padding:14px;color:#eee;background:#111">${markdownToHtml(body)}</body>`;
      preview.innerHTML = `<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeAttr(doc)}"></iframe>`;
    }

    function escapeAttr(value) {
      return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /** A deliberately tiny Markdown subset: headings, bold, code, lists, links. */
    function markdownToHtml(source) {
      const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const lines = source.split('\n');
      const out = [];
      let inList = false;
      for (const raw of lines) {
        const line = esc(raw);
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const item = /^[-*]\s+(.*)$/.exec(line);
        if (heading) {
          if (inList) { out.push('</ul>'); inList = false; }
          const level = heading[1].length;
          out.push(`<h${level}>${heading[2]}</h${level}>`);
        } else if (item) {
          if (!inList) { out.push('<ul>'); inList = true; }
          out.push(`<li>${item[1]}</li>`);
        } else {
          if (inList) { out.push('</ul>'); inList = false; }
          out.push(line.trim() ? `<p>${line}</p>` : '');
        }
      }
      if (inList) out.push('</ul>');
      return out.join('\n')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\[(.+?)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
    }

    async function save(target) {
      const body = payload();
      const fileName = currentFileName();
      const problem = validate(language, body);
      if (problem) {
        UI.toast({ level: 'warning', title: 'Fix the file first', body: problem });
        return;
      }
      if (!body.trim()) {
        UI.toast({ level: 'info', title: 'Nothing to save', body: 'The file is empty.' });
        return;
      }
      const kind = target === 'drive' ? 'drive' : 'dm';
      saveDrive.disabled = true;
      saveChat.disabled = true;
      try {
        const blob = new Blob([body], { type: mimeFor(currentExt()) });
        // The name travels as ciphertext sealed with the file's own key: the
        // drive can show "notes.txt" while the server only ever holds blobs.
        const meta = { type: mimeFor(currentExt()), editor: true };
        const result = await API.uploadEncrypted({
          kind,
          blob,
          meta,
          wrapFileKey: async (raw) => {
            meta.nameWrapped = await AE.sealJson(raw, { name: fileName });
            return AE.wrapKey(State.masterKey(), raw);
          },
        });
        if (kind === 'drive') DriveClient.refreshStatus && DriveClient.refreshStatus().catch(() => {});
        UI.toast({
          level: 'success',
          title: `${fileName} saved`,
          body: target === 'drive' ? 'It is in your Cloud Drive, encrypted.' : 'It is in My files, encrypted.',
        });
        if (options.onSaved) options.onSaved({ fileId: result.fileId, name: fileName, bytes: blob.size });
      } catch (error) {
        UI.toast({ level: 'danger', title: 'Could not save', body: error.message });
      } finally {
        saveDrive.disabled = false;
        saveChat.disabled = false;
      }
    }

    function mimeFor(ext) {
      return {
        txt: 'text/plain', md: 'text/markdown', html: 'text/html', css: 'text/css',
        js: 'text/javascript', json: 'application/json', csv: 'text/csv',
      }[ext] || 'text/plain';
    }

    const body = el('div', { class: 'editor-shell' }, [
      el('div', { class: 'editor-bar' }, [
        el('label', { class: 'editor-name' }, [el('span', { class: 'uppercase tiny', text: 'Name' }), nameInput]),
        el('label', { class: 'editor-ext' }, [el('span', { class: 'uppercase tiny', text: 'Type' }), extSelect]),
        el('div', { class: 'grow' }),
        el('button', { class: 'btn sm', text: 'Copy', onClick: async () => { await UI.copy(area.value, 'File copied'); } }),
        el('button', { class: 'btn sm', text: 'Download', onClick: () => UI.download(new Blob([area.value], { type: mimeFor(currentExt()) }), currentFileName()) }),
        saveChat,
        saveDrive,
      ]),
      el('div', { class: 'editor-panes' }, [
        el('div', { class: 'editor-pane' }, [area]),
        el('div', { class: 'editor-pane', id: 'editor-preview-pane', style: { display: language === 'html' || language === 'markdown' ? 'flex' : 'none' } }, [preview]),
      ]),
      status,
    ]);

    area.addEventListener('input', refreshPreview);
    nameInput.addEventListener('input', refreshPreview);
    extSelect.addEventListener('change', () => {
      const match = TEMPLATES.find((entry) => entry.ext === extSelect.value);
      language = match ? match.language : 'plain';
      refreshPreview();
    });
    area.addEventListener('keydown', (event) => {
      // Tab indents instead of leaving the field; Escape closes the window.
      if (event.key === 'Tab') {
        event.preventDefault();
        const start = area.selectionStart;
        area.value = `${area.value.slice(0, start)}  ${area.value.slice(area.selectionEnd)}`;
        area.selectionStart = area.selectionEnd = start + 2;
        refreshPreview();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save('drive');
      }
    });

    refreshPreview();
    const win = Windows.open({
      id: options.id || `editor-${Math.random().toString(36).slice(2, 6)}`,
      title: options.title || (file.name ? `Editing ${file.name}` : 'New file'),
      icon: 'editor',
      geometry: { w: 1000, h: 700 },
      content: body,
      onClose: () => {
        if (options.onClose) options.onClose(area.value);
      },
    });
    setTimeout(() => area.focus(), 80);
    return win;
  }

  /** The "new file" picker: choose a kind, land in the editor with it. */
  function create(options = {}) {
    if (!State.featureEnabled('editor')) {
      UI.toast({ level: 'info', title: 'The editor is switched off', body: 'Turn it back on in Settings → General.' });
      return null;
    }
    const cards = el('div', { class: 'file-type-grid' });
    const ref = UI.dialog({
      title: 'Create a file',
      icon: 'editor',
      size: 'wide',
      content: el('div', { class: 'stack-12' }, [
        cards,
        el('div', { class: 'hint', text: 'Files are encrypted on this device before they are stored. Save them to your Cloud Drive, or to My files, and open them again from there.' }),
      ]),
      footer: [
        el('button', { class: 'btn', text: 'Open a blank text file', onClick: () => { ref.close(); open({}, options); } }),
      ],
    });
    for (const template of TEMPLATES) {
      cards.append(el('button', {
        class: 'file-type-card',
        onClick: () => {
          ref.close();
          open({ template: template.id, name: `untitled.${template.ext}` }, options);
        },
      }, [
        el('span', { class: 'glyph', html: UI.icon(template.icon) }),
        el('span', { class: 'label', text: template.label }),
        el('span', { class: 'small muted', text: template.description }),
      ]));
    }
    return ref;
  }

  /**
   * Opens a Drive or My-files entry in the editor.  Text-ish uploads can be
   * edited; anything binary is refused with a readable reason.
   */
  async function openFromFile(entry) {
    // The name is not on the record: the drive stores it sealed with the file's
    // own key, so it has to be opened before it can be shown.
    const name = entry.name || await Media.fileName(entry) || 'untitled.txt';
    const type = entry.meta?.type || '';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const textish = /^text\//.test(type) || ['txt', 'md', 'html', 'htm', 'css', 'js', 'json', 'csv', 'log', 'xml', 'svg'].includes(ext) || entry.meta?.editor;
    if (!textish) {
      UI.toast({ level: 'info', title: 'Not a text file', body: 'Download it instead — the editor only handles text.' });
      return null;
    }
    const text = await Media.loadTextFile(entry);
    if (text === null) {
      UI.toast({ level: 'danger', title: 'Could not decrypt that file' });
      return null;
    }
    const template = TEMPLATES.find((item) => item.ext === ext);
    return open({ name, text, language: template ? template.language : 'plain' }, { title: `Editing ${name}` });
  }

  return { open, create, openFromFile, TEMPLATES, slug, ensureExtension };
})();

window.FileEditor = FileEditor;

Apps.register({
  id: 'editor', title: 'Editor', icon: 'editor', order: 24,
  description: 'Create and edit text, Markdown, HTML, CSS, JS, JSON and CSV files, then save them to your encrypted drive.',
  keywords: ['editor', 'file', 'text', 'create', 'write', 'html', 'markdown', 'note', 'txt', 'code', 'save'],
  run: (meta = {}) => {
    if (meta.file) return FileEditor.openFromFile(meta.file);
    return FileEditor.create();
  },
});

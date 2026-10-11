/* ============================================================================
   AE Secure — inline icon set

   The interface used to draw its surfaces with unicode symbols (▤ ▩ ◉ ▦ ▥ ⇣ ⚙ ⬢).
   Those characters live in fonts nobody guarantees: Android, Windows and headless
   browsers all pick different fallbacks, and when the glyph is missing the icon
   is simply invisible.  Every icon here is an inline SVG in the ink style —
   square joins, one hairline weight, currentColor — so it renders identically on
   every device and inherits the theme.
   ========================================================================== */

const Icons = (() => {
  // 24×24 grid, drawn for stroke, never filled.
  const PATHS = {
    messages: '<path d="M3 4.5h18v12H9.5L3 21z"/><path d="M7 9h10M7 12.5h6"/>',
    communities: '<circle cx="8.6" cy="9" r="3"/><circle cx="16.6" cy="10.2" r="2.2"/><path d="M2.8 19.2c0-3 2.6-5 5.8-5s5.8 2 5.8 5"/><path d="M15.4 19.2c0-2.1 1.4-3.5 3.6-3.5"/>',
    stories: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="3.4"/><path d="M12 3.4V1.6M12 22.4v-1.8"/>',
    drive: '<path d="M7.2 18.5h9.1a4.1 4.1 0 0 0 .4-8.1 6.1 6.1 0 0 0-11.6 1.6 3.6 3.6 0 0 0 2.1 6.5z"/>',
    files: '<path d="M2.8 6.2h6.4l2 2.6h10V19.4H2.8z"/>',
    airdrop: '<path d="M12 2.8v10.4"/><path d="M7.6 9.4 12 13.8l4.4-4.4"/><path d="M3.6 17.6h16.8v3.6H3.6z"/>',
    settings: '<circle cx="12" cy="12" r="3.3"/><path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.6 5.6l1.9 1.9M16.5 16.5l1.9 1.9M18.4 5.6l-1.9 1.9M7.5 16.5l-1.9 1.9"/>',
    admin: '<path d="M12 2.6 20 7.4v9.2L12 21.4 4 16.6V7.4z"/><path d="M12 8.4v7.2M8.6 11.2h6.8"/>',
    console: '<path d="M3.6 6.4 8.6 11l-5 4.6"/><path d="M11.6 16.8h8.8"/>',
    profile: '<circle cx="12" cy="8.2" r="3.7"/><path d="M4.8 20.4c0-3.7 3.2-6.1 7.2-6.1s7.2 2.4 7.2 6.1"/>',
    help: '<circle cx="12" cy="12" r="8.8"/><path d="M9.5 9.4a2.6 2.6 0 1 1 3.7 2.3c-.8.5-1.2 1-1.2 2"/><path d="M12 17.3h.02"/>',
    clicker: '<path d="M9.4 3.2v6.4M5.6 6.6l3.8 3M3.2 12h4M16.6 5.4 13.4 9"/><path d="M11 11.4 20.6 20l-4.2 1.3-1.4-4.1z"/>',
    editor: '<path d="M5.2 2.8h8.6l5 5v13.4H5.2z"/><path d="M13.8 2.8v5h5"/><path d="M8.6 13.2h6.8M8.6 16.6h4.4"/>',
    generic: '<rect x="3.6" y="3.6" width="16.8" height="16.8"/>',
    // window and menu marks
    window: '<rect x="3.4" y="4.6" width="17.2" height="14.8"/><path d="M3.4 8.6h17.2"/>',
    minimize: '<path d="M4.4 12h15.2"/>',
    maximize: '<rect x="4.4" y="4.4" width="15.2" height="15.2"/>',
    close: '<path d="M5.2 5.2 18.8 18.8M18.8 5.2 5.2 18.8"/>',
    pin: '<path d="M8.4 2.8h7.2l-1.2 5.6 3.2 3.2-5.6 1.2v6.4l-1.6-5.4-5.6-1.2 3.2-3.2z"/>',
    plus: '<path d="M12 4.4v15.2M4.4 12h15.2"/>',
    check: '<path d="M4.4 12.6 9.6 18 19.6 6.4"/>',
    upload: '<path d="M12 15.2V3.6"/><path d="M7.6 8 12 3.6 16.4 8"/><path d="M3.6 20.4h16.8"/>',
    download: '<path d="M12 3.6v11.6"/><path d="M7.6 10.8 12 15.2l4.4-4.4"/><path d="M3.6 20.4h16.8"/>',
    trash: '<path d="M4.4 6.6h15.2"/><path d="M6.4 6.6v13.8h11.2V6.6"/><path d="M9.4 6.6V3.6h5.2v3"/>',
    search: '<circle cx="10.6" cy="10.6" r="6.2"/><path d="M15.2 15.2 20.4 20.4"/>',
    reply: '<path d="M9.2 5.6 3.6 11l5.6 5.4"/><path d="M3.6 11h10a7 7 0 0 1 7 7v1.4"/>',
    image: '<rect x="3.4" y="4.6" width="17.2" height="14.8"/><circle cx="8.6" cy="9.6" r="1.6"/><path d="M3.9 17.4 9.4 12l4 4 3-2.6 4.2 4"/>',
    folder: '<path d="M2.8 6.2h6.4l2 2.6h10V19.4H2.8z"/>',
  };

  const ALIASES = {
    cloud: 'drive', airdropInbox: 'airdrop', dm: 'messages', chat: 'messages', group: 'messages',
    forum: 'communities', community: 'communities', story: 'stories', public: 'stories',
    upload: 'drive', account: 'profile', user: 'profile', me: 'profile', operator: 'admin',
    terminal: 'console', log: 'console', note: 'editor', document: 'editor', text: 'editor',
  };

  /**
   * Returns the markup for one icon.  Unknown names fall back to a plain plate
   * so a surface is never icon-less.
   */
  function svg(name, options = {}) {
    const key = ALIASES[name] || name;
    const path = PATHS[key] || (PATHS[name] || PATHS.generic);
    const size = options.size ? ` width="${options.size}" height="${options.size}"` : '';
    const cls = options.class ? ` class="${options.class}"` : '';
    const title = options.title ? `<title>${String(options.title).replace(/[<>&]/g, '')}</title>` : '';
    return `<svg${cls}${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false">${title}${path}</svg>`;
  }

  function has(name) { return !!(PATHS[name] || ALIASES[name]); }

  return { svg, has, PATHS };
})();

if (typeof window !== 'undefined') window.Icons = Icons;

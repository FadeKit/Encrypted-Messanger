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
    refresh: '<path d="M20.4 12a8.4 8.4 0 1 1-2.6-6"/><path d="M20.4 3.6V10h-6.4"/>',
    logout: '<path d="M15.4 4.4H5.2v15.2h10.2"/><path d="M12.6 12h8.2"/><path d="M17.4 8.6 20.8 12l-3.4 3.4"/>',
    smile: '<circle cx="12" cy="12" r="8.6"/><path d="M8.6 14a4.4 4.4 0 0 0 6.8 0"/><path d="M9.4 9.2h.02M14.6 9.2h.02"/>',
    'zoom-in': '<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.6 15.6 20.6 20.6"/><path d="M10.8 7.8v6M7.8 10.8h6"/>',
    // navigation, media and the viewer
    switcher: '<rect x="3.4" y="3.4" width="7.2" height="7.2"/><rect x="13.4" y="3.4" width="7.2" height="7.2"/><rect x="3.4" y="13.4" width="7.2" height="7.2"/><rect x="13.4" y="13.4" width="7.2" height="7.2"/>',
    back: '<path d="M14.4 5.2 7.6 12l6.8 6.8"/>',
    forward: '<path d="M9.6 5.2 16.4 12l-6.8 6.8"/>',
    play: '<path d="M7.4 4.6 19 12 7.4 19.4z"/>',
    pause: '<path d="M8.4 4.8v14.4M15.6 4.8v14.4"/>',
    volume: '<path d="M4.4 9.4h3.2l4.4-3.6v12.4l-4.4-3.6H4.4z"/><path d="M15.6 9a4.4 4.4 0 0 1 0 6"/><path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/>',
    mute: '<path d="M4.4 9.4h3.2l4.4-3.6v12.4l-4.4-3.6H4.4z"/><path d="M15.4 9.6 20.6 14.4M20.6 9.6 15.4 14.4"/>',
    expand: '<path d="M4.4 9.6V4.4h5.2M19.6 14.4v5.2h-5.2M19.6 9.6V4.4h-5.2M4.4 14.4v5.2h5.2"/>',
    collapse: '<path d="M9.6 4.4v5.2H4.4M14.4 19.6v-5.2h5.2M14.4 4.4v5.2h5.2M9.6 19.6v-5.2H4.4"/>',
    fit: '<rect x="3.6" y="5.6" width="16.8" height="12.8"/><path d="M7.6 9.6h8.8v4.8H7.6z"/>',
    film: '<rect x="2.8" y="4.6" width="18.4" height="14.8"/><path d="M7.6 4.6v14.8M16.4 4.6v14.8M2.8 12h18.4"/>',
    music: '<circle cx="7.4" cy="17.4" r="2.8"/><circle cx="17.4" cy="15.4" r="2.8"/><path d="M10.2 17.4V6.6l10-2v10.8"/>',
    'zoom-out': '<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.6 15.6 20.6 20.6"/><path d="M7.8 10.8h6"/>',
    download: '<path d="M12 3.6v11.6"/><path d="M7.6 10.8 12 15.2l4.4-4.4"/><path d="M3.6 20.4h16.8"/>',
    trash: '<path d="M4.4 6.6h15.2"/><path d="M6.4 6.6v13.8h11.2V6.6"/><path d="M9.4 6.6V3.6h5.2v3"/>',
    search: '<circle cx="10.6" cy="10.6" r="6.2"/><path d="M15.2 15.2 20.4 20.4"/>',
    // an open eye: the operator's read action
    eye: '<path d="M2 12s3.6-6.2 10-6.2S22 12 22 12s-3.6 6.2-10 6.2S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
    reply: '<path d="M9.2 5.6 3.6 11l5.6 5.4"/><path d="M3.6 11h10a7 7 0 0 1 7 7v1.4"/>',
    image: '<rect x="3.4" y="4.6" width="17.2" height="14.8"/><circle cx="8.6" cy="9.6" r="1.6"/><path d="M3.9 17.4 9.4 12l4 4 3-2.6 4.2 4"/>',
    folder: '<path d="M2.8 6.2h6.4l2 2.6h10V19.4H2.8z"/>',
    upvote: '<path d="M12 4.4 4.6 11.8h14.8z"/>',
    downvote: '<path d="M12 19.6 4.6 12.2h14.8z"/>',
    react: '<path d="M3.6 11.4a8.4 8.4 0 1 1 16.8 0 8.4 8.4 0 0 1-16.8 0"/><path d="M8.6 14.4a4.4 4.4 0 0 0 6.8 0"/><path d="M9.4 9.2h.02M14.6 9.2h.02"/>',
    members: '<circle cx="9" cy="8.6" r="3.2"/><path d="M2.8 19.4c0-3.2 2.8-5.4 6.2-5.4s6.2 2.2 6.2 5.4"/><path d="M16.4 6.2a3.2 3.2 0 0 1 0 6"/><path d="M17.8 14.4c2 .6 3.4 2.2 3.4 5"/>',
    hash: '<path d="M9.4 3.6 7.2 20.4M16.8 3.6l-2.2 16.8M3.8 8.8h16.4M3 15.2h16.4"/>',
    edit: '<path d="M4.4 19.6h4l11-11-4-4-11 11z"/><path d="M14.4 5.6l4 4"/>',
    copy: '<rect x="8.4" y="8.4" width="11.2" height="11.2"/><path d="M15.6 8.4V4.4H4.4v11.2h4"/>',
    star: '<path d="M12 3.6l2.6 5.6 6 .7-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.4 9.9l6-.7z"/>',
    key: '<circle cx="8.4" cy="12" r="4.4"/><path d="M12.8 12h7.6M17.2 12v3.2M20.4 12v2.2"/>',
    mail: '<path d="M3.4 5.6h17.2v12.8H3.4z"/><path d="M3.4 6.4 12 12.8l8.6-6.4"/>',
    clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 6.8V12l3.6 2.4"/>',
    camera: '<path d="M3.4 7.6h4l1.6-2.4h6l1.6 2.4h4v11.6H3.4z"/><circle cx="12" cy="13.4" r="3.2"/>',
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

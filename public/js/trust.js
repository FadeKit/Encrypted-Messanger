/* ============================================================================
   /trust — the one page a device needs to open to stop the browser warning.

   Everything here is local: it fetches the public certificate, shows where it
   is and what it is, and tells the person which settings screen to open.  It
   never touches an account, a key or the API.
   ========================================================================== */
(() => {
  const fingerprintNode = document.getElementById('fingerprint');
  const statusRow = document.getElementById('status-row');
  const isSecure = window.isSecureContext;

  const line = (text, level) => {
    const node = document.createElement('div');
    node.className = `small ${level || 'muted'}`;
    node.textContent = text;
    return node;
  };

  if (statusRow) {
    statusRow.append(
      line(isSecure
        ? 'This page is already open over a secure connection.'
        : 'This page is open over plain http — certificates only apply after you switch to the https address.', isSecure ? '' : 'muted'),
      line(`Encryption available in this browser: ${window.crypto && window.crypto.subtle ? 'yes' : 'no'} (messages and files need it).`),
    );
  }

  // The fingerprint is computed in the browser from the file the server hands
  // out, so what you compare on the phone is what you installed.
  (async () => {
    if (!fingerprintNode) return;
    try {
      const response = await fetch('/ca.crt', { cache: 'no-store' });
      if (!response.ok) throw new Error(`no authority on this install (${response.status})`);
      const der = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', der);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
      fingerprintNode.textContent = hex.match(/.{1,47}/g).join('\n');
    } catch (error) {
      fingerprintNode.textContent = `unavailable — ${error.message}`;
    }
  })();
})();

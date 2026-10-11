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

  // The fingerprint shown here is the certificate's own SHA-256, the same value
  // `ae-secure trust` prints on the phone.  Asking the server first keeps this
  // page quiet on an install that has no certificate authority yet.
  (async () => {
    if (!fingerprintNode) return;
    try {
      const response = await fetch('/api/ca', { cache: 'no-store' });
      if (!response.ok) throw new Error(`server did not answer (${response.status})`);
      const info = await response.json();
      if (!info.available || !info.fingerprint) {
        fingerprintNode.textContent = 'This install has no certificate authority yet.';
        const download = document.querySelector('a[download]');
        if (download) {
          download.removeAttribute('href');
          download.setAttribute('aria-disabled', 'true');
          download.classList.add('disabled');
          download.textContent = 'Nothing to download yet';
        }
        return;
      }
      fingerprintNode.textContent = info.fingerprint;
    } catch (error) {
      fingerprintNode.textContent = `unavailable — ${error.message}`;
    }
  })();
})();

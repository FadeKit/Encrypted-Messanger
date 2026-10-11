/* ============================================================================
   AE Secure — which build is this?

   A phone that was patched, restarted and refreshed should be able to say what
   it is running.  The identifier is a hash of the files this install actually
   ships (`public/` and `server/*.js`), so any change to the interface or the
   API moves it, and two installs on the same build report the same string.

   The server also stamps the value into the index page it serves.  The page
   prints its own stamp, so a browser holding an older copy of the interface
   sees a mismatch and can say so instead of quietly running stale code.
   ========================================================================== */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function gather(dir, list = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return list;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) gather(full, list);
    // Tests, screenshots and the harness never ship to a browser.
    else if (/\.(js|css|html|webmanifest|json|svg|png|woff2?)$/.test(entry.name)) list.push(full);
  }
  return list;
}

function compute() {
  const files = [
    ...gather(path.join(ROOT, 'public')),
    ...gather(path.join(ROOT, 'server')).filter((file) => path.extname(file) === '.js'),
  ].sort();
  const hash = crypto.createHash('sha1');
  let newest = 0;
  for (const file of files) {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    newest = Math.max(newest, stat.mtimeMs);
    hash.update(path.relative(ROOT, file));
    hash.update(String(stat.size));
    hash.update(String(Math.floor(stat.mtimeMs)));
  }
  return {
    id: hash.digest('hex').slice(0, 7),
    at: newest ? new Date(newest).toISOString() : null,
    files: files.length,
  };
}

// Read once at startup: the files cannot change under a running server except
// during a patch, and a patch restarts it.
const build = compute();

module.exports = { build, compute, ROOT };

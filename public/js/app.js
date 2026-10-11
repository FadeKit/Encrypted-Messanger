/* ============================================================================
   AE Secure — shell: authentication, unlock, desktop, taskbar, presence
   ========================================================================== */

const Shell = (() => {
  const { el, $, clear } = UI;
  const S = State;
  let presenceTimer = null;
  let clockTimer = null;
  let lastActivity = Date.now();
  let manualStatus = null;
  let lastSentStatus = null;
  let lockTimer = null;
  let audioContext = null;

  // ------------------------------------------------------------------ sound
  function blip(frequency = 660, durationMs = 90, gain = 0.045) {
    if (!S.settings().uiSounds) return;
    try {
      audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioContext.createOscillator();
      const amp = audioContext.createGain();
      osc.frequency.value = frequency;
      osc.type = 'sine';
      amp.gain.value = gain;
      osc.connect(amp).connect(audioContext.destination);
      osc.start();
      amp.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + durationMs / 1000);
      osc.stop(audioContext.currentTime + durationMs / 1000);
    } catch { /* audio unavailable */ }
  }

  // ------------------------------------------------------------------ theme
  function applyTheme() {
    const settings = S.settings();
    const body = document.body;
    body.dataset.theme = settings.theme || 'midnight';
    body.dataset.accent = settings.accent || 'azure';
    body.dataset.contrast = settings.highContrast ? 'high' : 'normal';
    body.dataset.glass = settings.glass >= 95 ? 'solid' : 'acrylic';
    body.dataset.dyslexia = settings.dyslexiaFont ? 'on' : 'off';
    body.dataset.motion = settings.animations === false || settings.reduceMotion ? 'reduced' : 'full';
    body.dataset.colorblind = settings.colorBlind && settings.colorBlind !== 'none' ? settings.colorBlind : 'off';
    body.dataset.focusRing = settings.focusRing === false ? 'off' : 'on';
    body.dataset.taskbar = settings.taskbarPosition || 'center';
    const root = document.documentElement;
    root.style.setProperty('--glass-alpha', String((settings.glass ?? 78) / 100));
    root.style.setProperty('--glass-blur', `${settings.blur ?? 22}px`);
    root.style.setProperty('--window-radius', `${settings.cornerRadius ?? 14}px`);
    root.style.setProperty('--font-scale', String(settings.fontScale || 1));
    root.style.setProperty('--line-height', String(settings.lineHeight || 1.45));
    let custom = $('#custom-css');
    if (settings.customCss) {
      if (!custom) { custom = el('style', { id: 'custom-css' }); document.head.append(custom); }
      custom.textContent = settings.customCss;
    } else if (custom) custom.remove();
  }

  // -------------------------------------------------------------- presence
  function startPresence() {
    clearInterval(presenceTimer);
    const effective = S.settings().activityStatus === false
      ? 'invisible'
      : manualStatus || computeStatus();
    sendPresence(effective);
    presenceTimer = setInterval(() => {
      const next = manualStatus || (S.settings().activityStatus === false ? 'invisible' : computeStatus());
      const mode = manualStatus && S.settings().activityStatus === false ? 'invisible' : next;
      if (mode !== lastSentStatus) sendPresence(mode);
      else API.post('/api/presence', {}).catch(() => {});
    }, 30000);
  }

  function computeStatus() {
    const idleFor = Date.now() - lastActivity;
    if (idleFor < 3 * 60 * 1000) return 'online';
    if (idleFor < 5 * 60 * 1000) return 'idle';
    return 'offline';
  }

  async function sendPresence(mode) {
    lastSentStatus = mode;
    try {
      await API.post('/api/presence', { mode, manual: !!manualStatus, custom: S.settings().statusMessage || '' });
    } catch { /* offline */ }
  }

  function setManualStatus(mode) {
    manualStatus = mode;
    try {
      if (mode) localStorage.setItem('ae.status', mode);
      else localStorage.removeItem('ae.status');
    } catch { /* ignore */ }
    sendPresence(mode || computeStatus());
    UI.toast({ level: 'info', title: `Status set to ${UI.statusLabel(mode || computeStatus())}`, duration: 2200 });
  }

  function markActivity() {
    lastActivity = Date.now();
    resetLockTimer();
    if (manualStatus === 'idle' || manualStatus === 'invisible' || manualStatus === 'dnd') return;
    if (lastSentStatus !== 'online' && S.settings().activityStatus !== false && !manualStatus) sendPresence('online');
  }

  function activityLoop() {
    for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(event, markActivity, { passive: true });
    }
    window.addEventListener('focus', markActivity);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) markActivity(); });
  }

  // -------------------------------------------------------------- auto lock
  function resetLockTimer() {
    clearTimeout(lockTimer);
    const minutes = Number(S.settings().autoLockMinutes || 0);
    if (!minutes || !S.user) return;
    lockTimer = setTimeout(showLockScreen, minutes * 60 * 1000);
  }

  function showLockScreen() {
    if (S.locked || !S.user) return;
    S.locked = true;
    const input = el('input', { class: 'input', type: 'password', placeholder: 'Passphrase', autocomplete: 'current-password' });
    const error = el('div', { class: 'small', style: { color: 'var(--danger)', minHeight: '16px' } });
    const card = el('div', { class: 'lock-card' }, [
      el('div', { class: 'auth-logo' }, [el('div', { class: 'mark', text: 'AE' }), el('div', {}, [
        el('div', { class: 'title-3', text: 'AE Secure is locked' }),
        el('div', { class: 'caption', text: 'Your keys stay in this tab only while unlocked.' }),
      ])]),
      S.avatarNode ? S.avatarNode() : null,
      input,
      error,
      el('button', { class: 'btn primary block', text: 'Unlock', onClick: attempt }),
      el('button', { class: 'btn subtle block', text: 'Sign out', onClick: () => { S.clearSession(); location.reload(); } }),
    ]);
    const screen = el('div', { class: 'lock-screen', id: 'lock-screen' }, [card]);
    document.body.append(screen);
    input.focus();
    async function attempt() {
      error.textContent = '';
      const passphrase = input.value;
      if (!passphrase) return;
      try {
        const kdf = S.user.kdf;
        const vault = await AE.openVault(passphrase, S.user.username, kdf, S.user.wrappedMaster);
        await S.unlock(vault, { password: passphrase, kdf });
        S.locked = false;
        screen.remove();
        resetLockTimer();
        UI.toast({ level: 'success', title: 'Unlocked', duration: 1600 });
      } catch {
        error.textContent = 'That passphrase did not open the key vault.';
        input.select();
      }
    }
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') attempt(); });
  }

  // ------------------------------------------------------- auth screens
  function authScreen() {
    document.body.innerHTML = '';
    document.body.append(el('div', { id: 'desktop' }));
    document.body.append(el('div', { id: 'modal-layer' }));
    document.body.append(el('div', { id: 'toast-stack' }));
    renderAuth('signin');
  }

  function renderAuth(mode) {
    clear($('#desktop'));
    const panel = el('div', { class: 'auth-panel' });
    const screen = el('div', { class: 'auth-screen' });
    const card = el('div', { class: 'auth-card' }, [authHero(), panel]);
    screen.append(card);
    document.body.append(screen);
    const title = { signin: 'Welcome back', register: 'Create your account', recover: 'Recover an account' }[mode];
    panel.append(el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title-1', text: title }),
        el('div', { class: 'caption', text: mode === 'register' ? 'Your passphrase never leaves this device — not even as a hash.' : 'Everything is decrypted locally after you sign in.' }),
      ]),
    ]));
    panel.append(el('div', { class: 'auth-tabs' }, [
      el('button', { class: mode === 'signin' ? 'on' : '', text: 'Sign in', onClick: () => swap('signin') }),
      el('button', { class: mode === 'register' ? 'on' : '', text: 'Create account', onClick: () => swap('register') }),
      el('button', { class: mode === 'recover' ? 'on' : '', text: 'Recovery', onClick: () => swap('recover') }),
    ]));
    if (mode === 'signin') panel.append(signInForm(swap));
    else if (mode === 'register') panel.append(registerForm(swap));
    else panel.append(recoverForm(swap));
    panel.append(el('div', { class: 'legal-foot', html: 'By continuing you agree to the <a href="#" data-terms>usage terms and non-liability notice</a>. The operator of this server cannot read your messages or files.' }));
    screen.querySelector('[data-terms]').addEventListener('click', (event) => { event.preventDefault(); Terms.show(); });

    function swap(next) {
      const current = $('.auth-screen');
      if (current) current.remove();
      renderAuth(next);
    }
  }

  function authHero() {
    return el('div', { class: 'auth-hero' }, [
      el('div', { class: 'auth-logo' }, [
        el('div', { class: 'mark', text: 'AE' }),
        el('div', {}, [
          el('div', { class: 'title-2', text: 'AE Secure' }),
          el('div', { class: 'caption', text: 'Encrypted messaging · communities · cloud drive' }),
        ]),
      ]),
      el('div', { class: 'stack-8' }, [
        tick('Every message and file is sealed with AES-GCM-256 before it leaves this device.'),
        tick('Keys live in your vault, wrapped by your passphrase with PBKDF2-SHA256.'),
        tick('Five one-time backup codes restore your account if a device is lost or stolen.'),
        tick('Administrators see traffic and storage statistics — never plaintext.'),
      ]),
      el('div', { class: 'notice-strip', html: '<span>🛡️</span><span>Zero-knowledge by design: the server stores ciphertext, wrapped keys and counters only.</span>' }),
    ]);
  }

  function tick(text) {
    return el('div', { class: 'feature-tick' }, [el('span', { class: 'tick', text: '✓' }), el('span', { text })]);
  }

  function signInForm(swap) {
    const username = el('input', { class: 'input', placeholder: 'Handle', autocomplete: 'username', autocapitalize: 'off' });
    const password = el('input', { class: 'input', type: 'password', placeholder: 'Passphrase', autocomplete: 'current-password' });
    const info = el('div', { class: 'hint' });
    const status = el('div', { class: 'small', style: { minHeight: '18px', color: 'var(--danger)' } });
    const submit = el('button', { class: 'btn primary block', text: 'Unlock and sign in' });
    const form = el('form', { class: 'stack-12' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Handle' }), username, info]),
      el('div', { class: 'field' }, [el('label', { text: 'Passphrase' }), password]),
      status,
      submit,
      el('button', { class: 'btn subtle block', type: 'button', text: 'Use a backup code instead', onClick: () => swap('recover') }),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.textContent = '';
      const handle = username.value.trim().toLowerCase();
      if (!handle || !password.value) { status.textContent = 'Enter your handle and passphrase.'; return; }
      submit.disabled = true;
      submit.textContent = 'Deriving keys…';
      try {
        const salt = await API.post('/api/auth/salt', { username: handle });
        info.textContent = salt.exists ? '' : 'No local record — creating a decoy derivation.';
        const authKey = await AE.pbkdf2(`ae-auth|${handle}|${password.value}`, AE.b64decode(salt.authSalt), salt.iterations);
        const result = await API.post('/api/auth/login', { username: handle, authKey: AE.b64encode(authKey) });
        API.setToken(result.token);
        S.set('user', result.user);
        S.set('session', { id: result.session.id, device: result.session.device });
        const vault = await AE.openVault(password.value, handle, result.user.kdf, result.user.wrappedMaster);
        await S.unlock(vault, { password: password.value, kdf: result.user.kdf });
        $('.auth-screen').remove();
        await startShell();
      } catch (error) {
        status.textContent = error.status === 401 ? 'That handle and passphrase do not match.' : error.message;
        submit.disabled = false;
        submit.textContent = 'Unlock and sign in';
      }
    });
    return form;
  }

  function registerForm(swap) {
    const handle = el('input', { class: 'input', placeholder: 'e.g. crimson-otter-4821', autocapitalize: 'off' });
    const display = el('input', { class: 'input', placeholder: 'Display name (optional)' });
    const password = el('input', { class: 'input', type: 'password', placeholder: 'Passphrase', autocomplete: 'new-password' });
    const confirm = el('input', { class: 'input', type: 'password', placeholder: 'Repeat passphrase', autocomplete: 'new-password' });
    const strength = el('div', { class: 'strength' }, Array.from({ length: 4 }, () => el('i')));
    const strengthLabel = el('div', { class: 'hint', text: 'Aim for 12+ characters with words you can remember.' });
    const status = el('div', { class: 'small', style: { minHeight: '18px', color: 'var(--danger)' } });
    const submit = el('button', { class: 'btn primary block', text: 'Create account' });
    const random = el('button', { class: 'btn subtle', type: 'button', text: '🎲 Suggest a handle', onClick: () => { handle.value = randomHandle(); } });
    const form = el('form', { class: 'stack-12' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Handle' }), el('div', { class: 'input-row' }, [handle, random])]),
      el('div', { class: 'field' }, [el('label', { text: 'Display name' }), display]),
      el('div', { class: 'field' }, [el('label', { text: 'Passphrase' }), password, strength, strengthLabel]),
      el('div', { class: 'field' }, [el('label', { text: 'Repeat passphrase' }), confirm]),
      status,
      submit,
    ]);
    password.addEventListener('input', () => {
      const score = scorePassword(password.value);
      [...strength.children].forEach((bar, index) => { bar.style.background = index < score ? ['#f87171', '#fbbf24', '#4ade80', '#22d3ee'][score - 1] : 'var(--line-strong)'; });
      strengthLabel.textContent = ['Too short', 'Weak', 'Reasonable', 'Strong', 'Excellent'][score] || '';
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.textContent = '';
      const name = (handle.value.trim().toLowerCase() || randomHandle()).replace(/[^a-z0-9._-]/g, '');
      if (name.length < 3) { status.textContent = 'Handles need at least 3 characters (a–z, 0–9, dot, dash, underscore).'; return; }
      if (password.value.length < 12) { status.textContent = 'Use at least 12 characters — this passphrase is the only key to your vault.'; return; }
      if (password.value !== confirm.value) { status.textContent = 'The two passphrases do not match.'; return; }
      submit.disabled = true;
      submit.textContent = 'Generating keys…';
      try {
        const material = await AE.createVault(password.value, name, { iterations: 210000 });
        const proofSalt = AE.b64encode(AE.randomBytes(16));
        const vaultPlain = material.vaultPlain;
        const recoveryCodes = [];
        for (let index = 0; index < 5; index++) {
          recoveryCodes.push({ code: AE.generateRecoveryCode(), index, proof: null, wrapped: null });
        }
        const prepared = [];
        for (const entry of recoveryCodes) {
          prepared.push({
            proof: await AE.recoveryProof(entry.code, proofSalt),
            wrapped: await AE.recoveryWrap(entry.code, name, entry.index, vaultPlain),
            label: `Backup code ${entry.index + 1}`,
          });
        }
        const payload = {
          username: name,
          displayName: display.value.trim() || name,
          authKey: material.authKey,
          authSalt: material.authSalt,
          vaultSalt: material.vaultSalt,
          iterations: material.iterations,
          vault: material.sealed,
          identityPublic: material.identityPublic,
          recoveryCodes: prepared,
          proofSalt,
          termsAccepted: true,
        };
        const result = await API.post('/api/auth/register', payload);
        API.setToken(result.token);
        S.set('user', result.user);
        await S.unlock(vaultPlain, { password: password.value, kdf: result.user.kdf });
        $('.auth-screen')?.remove();
        showRecoveryCodes(recoveryCodes, () => startShell());
      } catch (error) {
        status.textContent = error.message || 'Registration failed.';
        submit.disabled = false;
        submit.textContent = 'Create account';
      }
    });
    return form;
  }

  function recoverForm(swap) {
    const handle = el('input', { class: 'input', placeholder: 'Handle', autocapitalize: 'off' });
    const code = el('input', { class: 'input', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX', autocapitalize: 'characters', spellcheck: 'false' });
    const status = el('div', { class: 'small', style: { minHeight: '18px', color: 'var(--danger)' } });
    const submit = el('button', { class: 'btn primary block', text: 'Recover account' });
    const form = el('form', { class: 'stack-12' }, [
      el('div', { class: 'notice-strip', html: '<span>🆘</span><span>A backup code signs you in once. Afterwards you set a new passphrase, sign out every device and generate five fresh codes.</span>' }),
      el('div', { class: 'field' }, [el('label', { text: 'Handle' }), handle]),
      el('div', { class: 'field' }, [el('label', { text: 'Backup code' }), code, el('div', { class: 'hint', text: 'Codes are single use: one is consumed every time you recover.' })]),
      status,
      submit,
      el('button', { class: 'btn subtle block', type: 'button', text: 'Back to sign in', onClick: () => swap('signin') }),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.textContent = '';
      if (!handle.value.trim() || !code.value.trim()) { status.textContent = 'Enter your handle and one backup code.'; return; }
      submit.disabled = true;
      submit.textContent = 'Verifying…';
      try {
        const name = handle.value.trim().toLowerCase();
        const salt = await API.post('/api/auth/salt', { username: name });
        const proof = await AE.recoveryProof(code.value.trim(), salt.proofSalt || salt.authSalt);
        const result = await API.post('/api/auth/login', { username: name, recoveryProof: proof });
        API.setToken(result.token);
        S.set('user', result.user);
        $('.auth-screen')?.remove();
        await showRecoveryWizard(result, code.value.trim(), name);
        await startShell();
      } catch (error) {
        status.textContent = error.message || 'Recovery failed.';
        submit.disabled = false;
        submit.textContent = 'Recover account';
      }
    });
    return form;
  }

  async function showRecoveryWizard(loginResult, usedCode, username) {
    return new Promise((resolve) => {
      const password = el('input', { class: 'input', type: 'password', placeholder: 'New passphrase' });
      const confirm = el('input', { class: 'input', type: 'password', placeholder: 'Repeat passphrase' });
      const status = el('div', { class: 'small', style: { minHeight: '18px', color: 'var(--danger)' } });
      const finish = el('button', { class: 'btn primary', text: 'Set passphrase and continue' });
      let dialogRef;
      finish.addEventListener('click', async () => {
        status.textContent = '';
        if (password.value.length < 12) { status.textContent = 'Use at least 12 characters.'; return; }
        if (password.value !== confirm.value) { status.textContent = 'Passphrases do not match.'; return; }
        finish.disabled = true;
        finish.textContent = 'Re-sealing vault…';
        try {
          const vaultPlain = await AE.recoveryUnwrap(usedCode, username, loginResult.codeIndex || 0, loginResult.vault.wrapped);
          const authSalt = AE.randomBytes(16);
          const vaultSalt = AE.randomBytes(16);
          const iterations = loginResult.user.kdf.iterations;
          const authKey = await AE.pbkdf2(`ae-auth|${username}|${password.value}`, authSalt, iterations);
          const vaultKey = await AE.pbkdf2(`ae-vault|${username}|${password.value}`, vaultSalt, iterations);
          const sealed = await AE.encryptJson(await AE.importAes(vaultKey), vaultPlain);
          await API.post('/api/auth/password', {
            currentAuthKey: AE.b64encode(authKey),
            newAuthKey: AE.b64encode(authKey),
            newAuthSalt: AE.b64encode(authSalt),
            newVaultSalt: AE.b64encode(vaultSalt),
            vault: JSON.stringify(sealed),
            iterations,
            keepSessions: false,
          });
          S.set('user', Object.assign({}, S.user, { kdf: { authSalt: AE.b64encode(authSalt), vaultSalt: AE.b64encode(vaultSalt), iterations } }));
          await S.unlock(vaultPlain, { password: password.value, kdf: S.user.kdf });
          await API.post('/api/sessions/revoke-others', {});
          const codes = await regenerateRecoveryCodes(username, password.value, vaultPlain);
          dialogRef.close();
          showRecoveryCodes(codes, () => resolve());
        } catch (error) {
          status.textContent = error.message || 'Could not complete recovery.';
          finish.disabled = false;
          finish.textContent = 'Set passphrase and continue';
        }
      });
      dialogRef = UI.dialog({
        title: 'Secure the account again',
        glyph: '🛡️',
        subtitle: 'One backup code was consumed. Set a new passphrase — every other session is signed out immediately.',
        content: el('div', { class: 'stack-12' }, [
          el('div', { class: 'notice-strip warn', html: '<span>⚠️</span><span>Your old passphrase no longer works. Save the new backup codes that appear next.</span>' }),
          el('div', { class: 'field' }, [el('label', { text: 'New passphrase' }), password]),
          el('div', { class: 'field' }, [el('label', { text: 'Repeat' }), confirm]),
          status,
        ]),
        footer: [finish],
        dismissable: false,
      });
    });
  }

  async function regenerateRecoveryCodes(username, password, vaultPlain) {
    const salt = await API.post('/api/auth/salt', { username });
    const codes = [];
    for (let index = 0; index < 5; index++) {
      const code = AE.generateRecoveryCode();
      codes.push({
        code,
        index,
        proof: await AE.recoveryProof(code, salt.authSalt),
        wrapped: await AE.recoveryWrap(code, username, index, vaultPlain),
        label: `Backup code ${index + 1}`,
      });
    }
    await API.post('/api/auth/recovery/regenerate', { codes });
    return codes;
  }

  function showRecoveryCodes(codes, done) {
    const grid = el('div', { class: 'recovery-grid' });
    for (const entry of codes) {
      grid.append(el('div', { class: 'recovery-code', text: entry.code, title: 'Click to copy', onClick: () => UI.copy(entry.code, `Copied code ${entry.index + 1}`) }));
    }
    const ack = el('input', { type: 'checkbox' });
    const button = el('button', { class: 'btn primary', text: 'Continue to AE Secure', disabled: true });
    ack.addEventListener('change', () => { button.disabled = !ack.checked; });
    button.addEventListener('click', () => { dialogRef.close(); done && done(); });
    const dialogRef = UI.dialog({
      title: 'Your five backup codes',
      glyph: '🔑',
      subtitle: 'Each code restores this account once — but only while it stays unused.',
      size: 'wide',
      dismissable: false,
      content: el('div', { class: 'stack-12' }, [
        el('div', { class: 'notice-strip warn', html: '<span>⚠️</span><span>Store these somewhere offline. Anyone holding a code can sign in and reset your passphrase. They are shown only once.</span>' }),
        grid,
        el('div', { class: 'row' }, [
          el('button', { class: 'btn sm', text: '📋 Copy all', onClick: () => UI.copy(codes.map((entry) => entry.code).join('\n'), 'All backup codes copied') }),
          el('button', { class: 'btn sm', text: '💾 Download .txt', onClick: () => UI.download(new Blob([`AE Secure backup codes for ${S.user?.username || ''}\nGenerated ${new Date().toLocaleString()}\n\n${codes.map((entry, index) => `${index + 1}. ${entry.code}`).join('\n')}\n\nKeep this file offline. Each code works once.\n`], { type: 'text/plain' }), 'ae-secure-backup-codes.txt') }),
        ]),
        el('label', { class: 'row small' }, [ack, el('span', { text: 'I have saved my backup codes somewhere safe.' })]),
      ]),
      footer: [button],
    });
  }

  function randomHandle() {
    const a = ['silent', 'amber', 'crimson', 'quiet', 'nova', 'lunar', 'iron', 'velvet', 'cobalt', 'hollow', 'static', 'ember', 'onyx', 'violet', 'frost', 'drift'];
    const b = ['otter', 'falcon', 'cipher', 'harbor', 'beacon', 'kestrel', 'lattice', 'summit', 'quarry', 'meridian', 'cascade', 'thistle', 'aurora', 'basalt'];
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    return `${pick(a)}-${pick(b)}-${1000 + Math.floor(Math.random() * 8999)}`;
  }

  function scorePassword(value) {
    if (!value) return 0;
    let score = 0;
    if (value.length >= 8) score++;
    if (value.length >= 12) score++;
    if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
    if (/[0-9]/.test(value) || /[^A-Za-z0-9]/.test(value)) score++;
    if (value.length < 8) score = 1;
    return Math.min(4, score);
  }

  // ------------------------------------------------------------- the shell
  async function startShell() {
    document.body.innerHTML = '';
    document.body.append(
      el('a', { class: 'skip-link', href: '#taskbar', text: 'Skip to navigation' }),
      el('div', { id: 'desktop' }),
      el('div', { id: 'snap-preview' }),
      el('div', { id: 'toast-stack' }),
      el('div', { id: 'modal-layer' }),
    );
    applyTheme();
    activityLoop();
    manualStatus = (() => { try { return localStorage.getItem('ae.status'); } catch { return null; } })();
    buildDesktopIcons();
    buildTaskbar();
    buildStartMenu();
    startClock();
    startPresence();
    resetLockTimer();
    API.connect();
    wireRealtime();
    await Promise.all([
      ConversationClient.refresh().catch(() => {}),
      CommunityClient.refresh().catch(() => {}),
      DriveClient.refreshStatus().catch(() => {}),
      AirdropClient.refresh().catch(() => {}),
    ]);
    if (!S.user.terms || !S.user.terms.accepted) Terms.gate();
    if (S.boot?.server?.notice) UI.toast({ level: 'info', title: 'Operator notice', body: S.boot.server.notice, duration: 9000 });
    // Deep links from the installed app shortcuts: /?app=drive, /?app=settings…
    const requested = new URLSearchParams(location.search).get('app');
    if (requested && Apps.visible(S.user).some((app) => app.id === requested)) {
      Apps.open(requested);
      if (requested !== 'messages') {
        Windows.open({
          id: 'messages', title: 'Messages', glyph: '💬', geometry: { w: 1120, h: 720, x: null, y: null },
          render: (body, api) => ConversationClient.render(body, api),
        });
      }
      return;
    }
    Windows.open({
      id: 'messages', title: 'Messages', glyph: '💬', geometry: { w: 1120, h: 720, x: null, y: null },
      render: (body, api) => ConversationClient.render(body, api),
    });
  }

  function buildDesktopIcons() {
    const desktop = $('#desktop');
    const grid = el('div', { id: 'desktop-icons' });
    const apps = [
      { id: 'messages', glyph: '💬', label: 'Messages' },
      { id: 'communities', glyph: '🗣️', label: 'Communities' },
      { id: 'stories', glyph: '📸', label: 'Public' },
      { id: 'drive', glyph: '☁️', label: 'Cloud Drive' },
      { id: 'files', glyph: '🗂️', label: 'My Files' },
      { id: 'airdrop', glyph: '🪂', label: 'Airdrop' },
      { id: 'settings', glyph: '⚙️', label: 'Settings' },
    ];
    if (S.user.role === 'owner' || S.user.role === 'admin') apps.push({ id: 'admin', glyph: '🛡️', label: 'Admin Console' });
    for (const app of apps) {
      if (S.menuHidden(app.id)) continue;
      grid.append(el('button', { class: 'desk-icon', onClick: () => Apps.open(app.id), ondblclick: () => Apps.open(app.id) }, [
        el('span', { class: 'glyph', text: app.glyph }),
        el('span', { class: 'label', text: app.label }),
      ]));
    }
    desktop.append(grid);
  }

  function buildTaskbar() {
    const stack = el('div', { id: 'taskbar-stack', class: 'row-tight' });
    const startButton = el('button', { class: 'tb-btn', title: 'Start (Ctrl+Esc)', html: '<span>🪟</span>', onClick: (event) => toggleStart(event) });
    stack.append(startButton);
    const pinned = ['messages', 'communities', 'stories', 'drive', 'airdrop'];
    for (const id of pinned) {
      if (S.menuHidden(id)) continue;
      const app = Apps.get(id);
      stack.append(el('button', { class: 'tb-btn', title: app ? app.title : id, html: `<span>${(app && app.glyph) || '🪟'}</span>`, onClick: () => Apps.open(id) }));
    }
    if (S.user.role === 'owner' || S.user.role === 'admin') {
      stack.append(el('button', { class: 'tb-btn', title: 'Admin Console', html: '<span>🛡️</span>', onClick: () => Apps.open('admin') }));
    }
    const airdropButton = el('button', { class: 'tb-btn', id: 'tb-airdrop', title: 'Airdrop inbox', html: '<span>🪂</span>', onClick: () => Apps.open('airdrop') });
    if (S.get('airdropCount') > 0) airdropButton.append(el('span', { class: 'tb-badge', text: String(S.get('airdropCount')) }));
    stack.append(airdropButton);
    stack.append(el('button', { class: 'tb-btn', title: 'Settings', html: '<span>⚙️</span>', onClick: () => Apps.open('settings') }));

    const tray = el('div', { id: 'taskbar-tray' }, [
      el('button', { class: 'tb-btn', id: 'tb-status', title: 'Set activity status', html: `<span style="width:11px;height:11px;border-radius:50%;background:var(--status-online);display:block"></span>`, onClick: (event) => statusMenu(event) }),
      el('div', { class: 'tray-clock' }, [
        el('div', { class: 'time', id: 'clock-time', text: '--:--' }),
        el('div', { class: 'faint tiny', id: 'clock-date', text: '' }),
      ]),
    ]);

    const taskbar = el('div', { id: 'taskbar' }, [stack, el('div', { class: 'spacer', style: { minWidth: '12px' } }), tray]);
    document.body.append(taskbar);
  }

  function startClock() {
    clearInterval(clockTimer);
    const tickClock = () => {
      const now = new Date();
      const time = $('#clock-time');
      const date = $('#clock-date');
      if (time) time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (date) date.textContent = now.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' });
    };
    tickClock();
    clockTimer = setInterval(tickClock, 15000);
  }

  function statusMenu(event) {
    const settings = S.settings();
    const items = [];
    if (settings.activityStatus !== false) {
      items.push({ label: 'Availability' });
      items.push({ glyph: '🟢', label: 'Online', onClick: () => setManualStatus('online') });
      items.push({ glyph: '🌙', label: 'Idle (stay idle while here)', onClick: () => setManualStatus('idle') });
      items.push({ glyph: '⛔', label: 'Do Not Disturb', onClick: () => setManualStatus('dnd') });
      items.push({ glyph: '👻', label: 'Invisible (appear offline)', onClick: () => setManualStatus('invisible') });
      if (S.user.purpleAllowed) items.push({ glyph: '🟣', label: 'Purple status (granted by the operator)', onClick: () => setManualStatus('purple') });
      items.push({ separator: true });
      items.push({ glyph: '🔄', label: 'Automatic (based on activity)', onClick: () => setManualStatus(null) });
    } else {
      items.push({ label: 'Activity status is off in Settings → Privacy' });
      items.push({ glyph: '⚙️', label: 'Open activity settings', onClick: () => Apps.open('settings', { section: 'privacy' }) });
    }
    UI.contextMenu(items, { x: event.clientX - 120, y: event.clientY - 250 });
  }

  function updateStatusPill(status) {
    const pill = $('#tb-status');
    if (!pill) return;
    const key = (status && status.effective && status.effective.key) || (status && status.key) || 'offline';
    const color = { online: 'var(--status-online)', idle: 'var(--status-idle)', dnd: 'var(--status-dnd)', purple: 'var(--status-purple)', offline: 'var(--status-offline)' }[key] || 'var(--status-offline)';
    pill.innerHTML = `<span style="width:11px;height:11px;border-radius:50%;background:${color};display:block"></span>`;
    pill.title = `Status: ${UI.statusLabel(key)} — click to change`;
  }

  // -------------------------------------------------------------- start menu
  function buildStartMenu() {
    const menu = el('div', { id: 'start-menu' });
    const search = el('input', { class: 'input', placeholder: 'Search apps and help…', id: 'start-search' });
    const grid = el('div', { class: 'start-grid' });
    menu.append(
      el('div', { class: 'start-search' }, [search]),
      el('div', { class: 'start-section-label uppercase', text: 'Pinned' }),
      grid,
      el('div', { class: 'start-section-label uppercase', text: 'Help' }),
      el('div', { style: { padding: '0 16px 12px' } }, [
        el('button', { class: 'btn block', text: '📘 Open the guided tutorial and help centre', onClick: () => { closeStart(); Help.open(); } }),
      ]),
      startFooter(),
    );
    document.body.append(menu);

    const renderGrid = (filter = '') => {
      clear(grid);
      const query = filter.trim().toLowerCase();
      const items = Apps.visible(S.user).filter((app) => !query || app.title.toLowerCase().includes(query) || (app.description || '').toLowerCase().includes(query) || app.keywords?.some((word) => word.includes(query)) || Help.search(query).length);
      if (!items.length) {
        grid.append(el('div', { class: 'caption pad-8', text: 'Nothing matched. Try the help centre search with a feature name.' }));
        return;
      }
      for (const app of items) {
        grid.append(el('button', { class: 'start-tile', onClick: () => { closeStart(); Apps.open(app.id); } }, [
          el('span', { class: 'glyph', text: app.glyph }),
          el('span', { class: 'label', text: app.title }),
        ]));
      }
    };
    renderGrid();
    search.addEventListener('input', () => renderGrid(search.value));
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const query = search.value.trim();
        if (!query) return;
        closeStart();
        Help.open(query);
      }
    });
  }

  function startFooter() {
    const user = S.user;
    return el('div', { class: 'start-footer' }, [
      UI.avatar(user, { size: 'sm', showStatus: S.settings().activityStatus !== false, onClick: () => { closeStart(); Apps.open('profile'); } }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'small body-strong truncate', text: user.displayName || user.username }),
        el('div', { class: 'tiny faint truncate', text: `@${user.username}${user.role !== 'member' ? ` · ${user.role}` : ''}` }),
      ]),
      el('button', { class: 'btn icon subtle', title: 'Settings', text: '⚙️', onClick: () => { closeStart(); Apps.open('settings'); } }),
      el('button', { class: 'btn icon subtle', title: 'Sign out', text: '⏏', onClick: async () => {
        try { await API.post('/api/auth/logout', {}); } catch { /* ignore */ }
        API.disconnect();
        S.clearSession();
        location.reload();
      } }),
    ]);
  }

  function toggleStart(event) {
    const menu = $('#start-menu');
    if (!menu) return;
    if (menu.classList.contains('open')) closeStart();
    else {
      menu.classList.add('open');
      const search = $('#start-search');
      if (search) { search.value = ''; setTimeout(() => search.focus(), 60); }
    }
    if (event) event.stopPropagation();
  }

  function closeStart() {
    const menu = $('#start-menu');
    if (menu) menu.classList.remove('open');
  }

  document.addEventListener('pointerdown', (event) => {
    const menu = $('#start-menu');
    if (!menu || !menu.classList.contains('open')) return;
    if (menu.contains(event.target) || event.target.closest('#taskbar-stack')) return;
    closeStart();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeStart();
    if (event.ctrlKey && event.key === 'Escape') { event.preventDefault(); toggleStart(); }
  });

  // -------------------------------------------------------------- realtime
  function wireRealtime() {
    API.on('message', (payload) => {
      ConversationClient.onIncomingMessage(payload);
      const isActive = S.get('activeConversationId') === payload.conversationId && !document.hidden;
      if (!isActive) {
        blip(720);
        const message = payload.message;
        ConversationClient.bumpUnread(payload.conversationId);
        if (!S.settings().hideMessagePreviews && message) {
          notify({ title: 'New encrypted message', body: 'Open Messages to decrypt and read.', level: 'info', glyph: '💬' });
        }
      }
    });
    API.on('presence.changed', (payload) => {
      const presence = Object.assign({}, S.get('presence'));
      presence[payload.userId] = payload.status;
      S.set('presence', presence);
      if (payload.userId === S.user.id) updateStatusPill(payload.status);
    });
    API.on('click', (payload) => { S.set('clicker', payload); });
    API.on('notify', (payload) => notify(payload));
    API.on('request.decision', (payload) => {
      if (payload.limits) {
        S.user.limits = payload.limits;
        S.emit('user', S.user);
      }
      UI.toast({
        level: payload.decision?.status === 'approved' ? 'success' : 'info',
        title: payload.decision?.status === 'approved' ? 'Request approved' : 'Request declined',
        body: payload.decision?.note || 'Open Settings → Storage & requests for details.',
        actions: [{ label: 'View', onClick: () => Apps.open('settings', { section: 'requests' }) }],
      });
    });
    API.on('airdrop', (payload) => {
      AirdropClient.handle(payload);
    });
    API.on('dmcode', (payload) => {
      UI.toast({
        level: 'info', title: 'One-time chat code received',
        body: payload.note || 'An operator opened a private channel to you.',
        actions: [{ label: 'Read the code', primary: true, onClick: () => Apps.open('settings', { section: 'requests' }) }],
      });
    });
    API.on('dmcode.redeemed', (payload) => {
      UI.toast({ level: 'success', title: 'Chat code redeemed', body: payload.note || 'A conversation was opened.' });
      ConversationClient.refresh().catch(() => {});
    });
    API.on('session.killed', (payload) => {
      if (payload.reason === 'admin' || payload.reason === 'admin-all') {
        UI.toast({ level: 'warning', title: 'Signed out by an administrator', body: `A device session ended (${payload.device || 'another device'}).`, duration: 9000 });
      }
    });
    API.on('account.updated', (payload) => {
      if (payload.banned) { notify({ level: 'danger', title: 'Account suspended', body: 'Contact the operator to resolve this.' }); return; }
      if (payload.limits) { S.user.limits = payload.limits; S.emit('user', S.user); }
      S.user.verified = payload.verified;
      S.user.purpleAllowed = payload.purpleAllowed;
      S.emit('user', S.user);
    });
    API.on('global', () => {});
    API.on('disconnected', () => {
      const banner = el('div', { class: 'banner-offline', id: 'offline-banner', text: 'Reconnecting to the server…' });
      if (!$('#offline-banner')) document.body.append(banner);
    });
    API.on('ready', () => {
      const banner = $('#offline-banner');
      if (banner) banner.remove();
    });
  }

  /**
   * Opens the channel behind a redeemed one-time code and seals it if the other
   * side has not done so yet. Operator channels wrap the key for the alias
   * "administration" because the account id is intentionally hidden.
   */
  async function openMaskedChannel(result) {
    if (!result || !result.conversationId) return null;
    await ConversationClient.refresh();
    Apps.open('messages');
    let conversation = ConversationClient.conversationById(result.conversationId);
    if (!conversation) {
      await ConversationClient.refresh();
      conversation = ConversationClient.conversationById(result.conversationId);
    }
    if (conversation && !conversation.keyWrap) {
      const peer = result.peer && result.peer.id !== State.user.id
        ? result.peer
        : (conversation.members || []).find((member) => member.id && member.id !== State.user.id)
          || (conversation.members || []).find((member) => member.identityPublic);
      if (peer && peer.identityPublic) {
        const raw = await AE.generateAesRaw();
        const wraps = {};
        wraps[State.user.id] = await State.wrapChannelKey('conv', conversation.id, raw, State.vault.identityPublic);
        wraps[peer.masked ? 'administration' : peer.id] = await State.wrapChannelKey('conv', conversation.id, raw, peer.identityPublic);
        await API.post(`/api/conversations/${conversation.id}/keys`, { keyWraps: wraps });
        await ConversationClient.refresh();
      }
    }
    ConversationClient.open(result.conversationId);
    UI.toast({
      level: 'success',
      title: 'Secure channel open',
      body: 'The operator appears as Server Administration — their account is never revealed in this chat.',
      duration: 6500,
    });
    return result.conversationId;
  }

  function notify(payload) {
    const config = Object.assign({ level: 'info' }, payload);
    if (S.settings().notificationToasts !== false) UI.toast(config);
    if (S.settings().desktopNotifications && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(config.title || 'AE Secure', { body: config.body || '' }); } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    API.loadToken();
    Terms.inject();
    try {
      const bootData = await API.get('/api/bootstrap');
      S.set('boot', bootData);
      S.set('presence', bootData.presence || {});
      S.set('clicker', bootData.clicks);
      if (bootData.server.maintenance && (!bootData.user || (bootData.user.role !== 'owner' && bootData.user.role !== 'admin'))) {
        authScreen();
        UI.toast({ level: 'warning', title: 'Maintenance mode', body: 'Only operators can sign in right now.', duration: 8000 });
        return;
      }
      if (!bootData.user) { authScreen(); return; }
      S.set('user', bootData.user);
      const cached = S.cachedUnlock();
      if (cached && cached.vaultKey && cached.vaultKey.kdf) {
        try {
          const settings = S.settings();
              const vault = await AE.openVault(cached.vaultKey.password, bootData.user.username, bootData.user.kdf, bootData.user.wrappedMaster);
          await S.unlock(vault, cached.vaultKey);
          await startShell();
          return;
        } catch {
          try { sessionStorage.removeItem('ae.unlock'); } catch { /* ignore */ }
        }
      }
      unlockedPrompt();
    } catch (error) {
      console.error(error);
      document.body.innerHTML = '';
      document.body.append(el('div', { id: 'desktop' }), el('div', { id: 'modal-layer' }), el('div', { id: 'toast-stack' }));
      renderAuth('signin');
      UI.toast({ level: 'danger', title: 'Server unreachable', body: error.message });
    }
  }

  function unlockedPrompt() {
    document.body.innerHTML = '';
    document.body.append(el('div', { id: 'desktop' }), el('div', { id: 'modal-layer' }), el('div', { id: 'toast-stack' }));
    const password = el('input', { class: 'input', type: 'password', placeholder: 'Passphrase' });
    const status = el('div', { class: 'small', style: { color: 'var(--danger)', minHeight: '16px' } });
    const card = el('div', { class: 'lock-card' }, [
      el('div', { class: 'auth-logo' }, [el('div', { class: 'mark', text: 'AE' }), el('div', {}, [
        el('div', { class: 'title-3', text: `Welcome back, ${S.user.displayName}` }),
        el('div', { class: 'caption', text: 'Enter your passphrase to unwrap the vault for this tab.' }),
      ])]),
      password, status,
      el('button', { class: 'btn primary block', text: 'Unlock', onClick: attempt }),
      el('button', { class: 'btn subtle block', text: 'Sign out', onClick: () => { S.clearSession(); location.reload(); } }),
    ]);
    document.body.append(el('div', { class: 'lock-screen' }, [card]));
    setTimeout(() => password.focus(), 60);
    async function attempt() {
      status.textContent = '';
      try {
        const vault = await AE.openVault(password.value, S.user.username, S.user.kdf, S.user.wrappedMaster);
        await S.unlock(vault, { password: password.value, kdf: S.user.kdf });
        await startShell();
      } catch {
        status.textContent = 'That passphrase did not open the vault.';
      }
    }
    password.addEventListener('keydown', (event) => { if (event.key === 'Enter') attempt(); });
  }

  return {
    boot, applyTheme, renderAuth, startShell, notify, blip, randomHandle, scorePassword, openMaskedChannel,
    showRecoveryCodes, setManualStatus, markActivity, resetLockTimer, updateStatusPill, buildStartMenu,
    get manualStatus() { return manualStatus; },
  };
})();

window.Shell = Shell;

document.addEventListener('DOMContentLoaded', () => {
  Shell.boot();
});

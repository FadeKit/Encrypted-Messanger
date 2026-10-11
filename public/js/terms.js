/* ============================================================================
   AE Secure — usage agreement and non-liability notice
   ========================================================================== */

const Terms = (() => {
  const TITLE = 'AE Secure — Usage Agreement & Non-Liability Notice';
  const SECTIONS = [
    ['1. What this service is', `AE Secure is self-hosted, end-to-end encrypted software. Messages, files, stories and community posts are encrypted in your browser before they reach the server. The server operator ("the operator") hosts the software and stores ciphertext, account metadata, wrapped encryption keys and traffic counters. The operator holds no encryption keys for member content.`],
    ['2. Your keys are your responsibility', `Your passphrase and your five one-time backup codes are the only ways to unlock your vault. The operator cannot reset, recover or read your content. Losing every backup code means the encrypted content in your account becomes permanently unreadable, and no party — including the operator — is able to restore it.`],
    ['3. Content and conduct', `You are solely responsible for everything you send, upload, post, store or share through AE Secure, including attachments, public profile material, stories and community posts. Do not use this service for content that is unlawful in the jurisdiction where it is hosted or where you reside.`],
    ['4. No liability', `The software is provided "as is", without warranty of any kind, express or implied. To the maximum extent permitted by law, the operator is not liable for any content posted, uploaded, stored, transmitted, received or viewed by any user of this service, nor for any direct, indirect, incidental, consequential, special or exemplary damages arising from the use of, or inability to use, this service. This includes, without limitation, data loss, storage exhaustion, device failure, network interruption, unauthorised access, third-party claims, or any legal action arising from content published by users of this service.`],
    ['5. Moderation and access', `The operator may suspend, disable or delete accounts, communities and uploaded material to enforce storage limits, protect the service, or comply with a lawful order. Administrative tools operate on metadata and access control; they cannot decrypt member content. Sessions can be ended by the operator at a member\'s request or during abuse handling.`],
    ['6. Storage limits and requests', `Each account starts with a 15 MB per-message upload allowance and 1 GB of drive storage. Additional capacity is granted only through a request that an administrator approves. Approved capacity may be reduced again if the operator changes server policy; content already stored is never incrementally charged.`],
    ['7. Public content', `Content you place in a public profile, public story or public community is intentionally readable by other signed-in members of this server and is not covered by the confidentiality guarantees that apply to direct messages, private communities and your personal drive. Turning the public profile switch off hides that content from other members but does not erase the server\'s stored history.`],
    ['8. Availability', `This instance may run on ordinary consumer hardware, including a mobile device hosting arrangement. Downtime, restarts and bandwidth limits may occur without notice. Keep your own copy of anything important.`],
    ['9. Acceptance', `Creating an account, signing in, or continuing to use AE Secure constitutes acceptance of this agreement. If you do not accept these terms, do not use the service.`],
  ];

  function bodyNodes() {
    return [
      el('div', { class: 'notice-strip', html: '<span>§</span><span>The operator of this server takes no responsibility for anything shared, posted, uploaded or viewed using this site, and takes no part in user activity.</span>' }),
      el('div', { class: 'terms-box' }, SECTIONS.map(([heading, paragraph]) => el('div', {}, [
        el('h4', { text: heading }),
        el('p', { text: paragraph }),
      ]))),
    ];
  }

  function inject() { /* agreement is rendered on demand; nothing to preload */ }

  async function accept() {
    try {
      const result = await API.post('/api/auth/terms', { accepted: true });
      State.user.terms = result.terms;
      State.emit('user', State.user);
      UI.toast({ level: 'success', title: 'Agreement accepted', body: `Version ${result.terms.version} recorded for your account.`, duration: 2600 });
      return true;
    } catch (error) {
      UI.toast({ level: 'danger', title: 'Could not record acceptance', body: error.message });
      return false;
    }
  }

  function show({ requireAccept = false, onAccept = null } = {}) {
    const checkbox = el('input', { type: 'checkbox' });
    let dialogRef;
    const acceptButton = el('button', {
      class: 'btn primary',
      text: requireAccept ? 'I agree — continue' : 'I agree',
      disabled: requireAccept,
      onClick: async () => {
        acceptButton.disabled = true;
        acceptButton.textContent = 'Recording…';
        const done = await accept();
        if (done) {
          dialogRef.close();
          if (onAccept) onAccept();
        } else {
          acceptButton.disabled = !requireAccept;
          acceptButton.textContent = requireAccept ? 'I agree — continue' : 'I agree';
        }
      },
    });
    checkbox.addEventListener('change', () => { acceptButton.disabled = !checkbox.checked; });
    dialogRef = UI.dialog({
      title: TITLE,
      icon: 'editor',
      size: 'wide',
      dismissable: !requireAccept,
      content: el('div', { class: 'stack-12' }, [
        ...bodyNodes(),
        el('label', { class: 'row small' }, [
          checkbox,
          el('span', { text: 'I have read and accept this agreement, including the non-liability notice.' }),
        ]),
      ]),
      footer: [
        el('button', { class: 'btn subtle', text: 'Close', onClick: () => dialogRef.close(), hidden: requireAccept }),
        acceptButton,
      ],
    });
    return dialogRef;
  }

  /** Blocks the app until the current agreement version is accepted. */
  function gate() {
    const checkbox = el('input', { type: 'checkbox' });
    let dialogRef;
    const button = el('button', { class: 'btn primary', text: 'I agree and continue', disabled: true, onClick: async () => {
      const done = await accept();
      if (done) dialogRef.close();
    } });
    checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; });
    dialogRef = UI.dialog({
      title: TITLE,
      icon: 'editor',
      size: 'wide',
      dismissable: false,
      content: el('div', { class: 'stack-12' }, [
        ...bodyNodes(),
        el('div', { class: 'notice-strip warn', html: '<span>!</span><span>Your account records which version of this notice you accepted.</span>' }),
        el('label', { class: 'row small' }, [checkbox, el('span', { text: 'I have read and accept this agreement, including the non-liability notice.' })]),
      ]),
      footer: [
        button,
        el('button', { class: 'btn danger', text: 'Sign out', onClick: () => { State.clearSession(); location.reload(); } }),
      ],
    });
  }

  return { TITLE, SECTIONS, inject, show, gate, accept, bodyNodes };
})();

window.Terms = Terms;

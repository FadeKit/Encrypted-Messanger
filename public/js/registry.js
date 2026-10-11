/* ============================================================================
   AE Secure — application registry
   Feature modules register their surfaces here; the shell (start menu,
   taskbar, shortcuts) is generated from this list.
   ========================================================================== */

const Apps = (() => {
  const registry = new Map();

  function register(definition) {
    registry.set(definition.id, Object.assign({
      id: definition.id,
      title: definition.id,
      glyph: '🪟',
      order: 50,
      pinned: false,
      adminOnly: false,
      guestVisible: false,
      description: '',
      run: () => {},
    }, definition));
  }

  function all() {
    return [...registry.values()].sort((a, b) => a.order - b.order);
  }

  function visible(user) {
    const isAdmin = !!user && (user.role === 'owner' || user.role === 'admin');
    return all().filter((app) => {
      if (app.adminOnly && !isAdmin) return false;
      if (app.hiddenWhenOff) {
        const value = State.settings()[app.hiddenWhenOff];
        if (value !== true) return false;
      }
      return true;
    });
  }

  function open(id, meta = {}) {
    const app = registry.get(id);
    if (!app) {
      UI.toast({ level: 'warning', title: 'That panel is not available', body: `No application registered as “${id}”.` });
      return null;
    }
    const user = State.user;
    const isAdmin = !!user && (user.role === 'owner' || user.role === 'admin');
    if (app.adminOnly && !isAdmin) {
      UI.toast({ level: 'danger', title: 'Administrator access required' });
      return null;
    }
    const featureKey = app.featureFlag;
    if (featureKey && !State.featureEnabled(featureKey)) {
      UI.toast({ level: 'info', title: `${app.title} is switched off`, body: 'Re-enable it in Settings → General → Feature switches.' });
      return null;
    }
    return app.run(meta);
  }

  return { register, all, visible, open, get: (id) => registry.get(id) };
})();

window.Apps = Apps;

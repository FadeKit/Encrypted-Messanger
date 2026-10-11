/* ============================================================================
   AE Secure — Click Me: the shared global counter
   ========================================================================== */

const Clicker = (() => {
  const { el } = UI;
  const floats = [];

  function push(count) {
    State.set('clicker', count);
  }

  async function press(event) {
    try {
      const result = await API.post('/api/click', {});
      push(result);
      burst(event);
      Shell.blip(520 + Math.random() * 320, 60, 0.05);
    } catch (error) {
      UI.toast({ level: 'danger', title: 'The counter did not answer', body: error.message });
    }
  }

  function burst(event) {
    const node = el('div', { class: 'float-num', text: '+1' });
    const x = event && event.clientX ? event.clientX : window.innerWidth / 2;
    const y = event && event.clientY ? event.clientY : window.innerHeight / 2;
    Object.assign(node.style, { left: `${x - 8}px`, top: `${y - 24}px` });
    document.body.append(node);
    floats.push(node);
    setTimeout(() => { node.remove(); const index = floats.indexOf(node); if (index >= 0) floats.splice(index, 1); }, 1000);
    const visual = event && event.currentTarget;
    if (visual) {
      visual.classList.add('pulse');
      setTimeout(() => visual.classList.remove('pulse'), 260);
    }
  }

  function card() {
    const total = el('div', { class: 'clicker-total', text: compact(State.get('clicker').total) });
    const week = el('div', { class: 'clicker-week', text: `${State.get('clicker').week || 0} clicks this week` });
    const mine = el('div', { class: 'tiny faint', text: `You have added ${State.get('clicker').mine || 0}` });
    const podium = el('div', { class: 'clicker-podium' });
    const button = el('button', { class: 'clicker-button', text: 'Click Me', onClick: press });

    const paintPodium = (count) => {
      const cells = [
        ['all time', count.total, '01'],
        ['this week', count.week, '02'],
        ['week index', count.weekLabel, '03'],
        ['your clicks', count.mine, '04'],
      ];
      UI.clear(podium);
      for (const [label, value, glyph] of cells) {
        if (value === undefined || value === null) continue;
        podium.append(el('div', { class: 'clicker-cell' }, [
          el('span', { class: 'glyph', text: glyph }),
          el('span', { class: 'value mono', text: compact(value) }),
          el('span', { class: 'label', text: label }),
        ]));
      }
    };

    const apply = (count) => {
      total.textContent = compact(count.total || 0);
      week.textContent = `${count.week || 0} clicks this week`;
      mine.textContent = `You have added ${count.mine || 0}`;
      paintPodium(count);
      total.classList.add('bump');
      setTimeout(() => total.classList.remove('bump'), 200);
    };

    apply(State.get('clicker'));
    const unsubscribe = State.subscribe('clicker', apply);
    card.cleanup = unsubscribe;

    const node = el('div', { class: 'clicker-card' }, [
      el('div', { class: 'clicker-head' }, [
        el('span', { class: 'uppercase', text: 'Server-wide counter' }),
        el('span', { class: 'pill tiny accent', text: 'live' }),
      ]),
      total,
      button,
      week,
      mine,
      podium,
      el('div', { class: 'hint', text: 'Every member of this instance shares one counter. Totals update as other people click.' }),
    ]);
    return node;
  }

  function compact(value) {
    const number = Number(value) || 0;
    if (number < 10000) return number.toLocaleString();
    if (number < 1000000) return `${(number / 1000).toFixed(number < 100000 ? 1 : 0)}k`;
    return `${(number / 1000000).toFixed(1)}M`;
  }

  async function refresh() {
    try { push(await API.get('/api/click')); } catch { /* keep the last known total */ }
  }

  function render(body) {
    UI.clear(body);
    body.append(el('div', { class: 'clicker-stage' }, [card()]));
    refresh();
  }

  return { render, card, refresh, handleCount: push, compact };
})();

window.Clicker = Clicker;

Apps.register({
  id: 'clicker', title: 'Click Me', glyph: '⊞', order: 70,
  description: 'The shared global click counter.',
  keywords: ['click', 'clicker', 'counter', 'fun'],
  featureFlag: 'clickMe',
  run: () => Windows.open({
    id: 'clicker', title: 'Click Me', glyph: '⊞', geometry: { w: 520, h: 520 },
    render: (body) => Clicker.render(body),
  }),
});

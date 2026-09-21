// Home page (SPEC §3.1). The copy is static HTML; this script fills every number from settings at render time, keeps the hours
// line current, and draws the non-interactive coverage map (zone labels plus the bridge corridor). Re-renders on settings changes
// and on a demo reset through the store's subscriptions; the map is built once.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const HOURS_TICK_MS = 60000;
  const fmt = n => MDM.pricing.format(n);
  const node = testid => document.querySelector('[data-testid="' + testid + '"]');
  const setText = (testid, text) => { const n = node(testid); if (n) n.textContent = text == null ? '' : String(text); };

  // "MVR 35 to 45" for a size cell; a single figure when both sides of the bridge cost the same.
  function rangeText(cell) {
    if (!cell) return '';
    const same = Math.round(Number(cell.same) || 0), cross = Math.round(Number(cell.cross) || 0);
    return same === cross ? fmt(same) : fmt(same) + ' to ' + fmt(cross).replace(/^MVR /, '');
  }
  const perText = (per, what) => per === 'order' ? 'once per order' : 'per ' + what;

  async function render() {
    const s = await MDM.store.settings();
    const rates = s.rates || {}, sizes = rates.sizes || {}, rules = s.rules || {}, guide = s.sizeGuide || {}, ops = s.ops || {};
    const pct = Math.round(Number(rates.shoppingPct) || 0);

    setText('home-hours', MDM.shell.hoursLine(s));

    setText('home-service-price-pick', 'From ' + fmt(sizes.bag ? sizes.bag.same : 0));
    setText('home-service-price-shop', 'From ' + fmt(sizes.bag ? sizes.bag.same : 0));
    setText('home-service-fee-shop', 'plus a ' + pct + '% shopping fee');
    setText('home-service-price-business', fmt(rates.business));

    setText('home-rate-bag', rangeText(sizes.bag));
    setText('home-rate-box', rangeText(sizes.box));
    setText('home-rate-xl', 'from ' + fmt(sizes.xl ? sizes.xl.same : 0));
    setText('home-guide-bag', guide.bag);
    setText('home-guide-box', guide.box);
    setText('home-guide-xl', guide.xl);

    setText('home-fee-shopping', pct + '% of the receipt');
    setText('home-fee-cargo', fmt(rates.cargo));
    setText('home-fee-cargo-note', 'Pickup or drop-off at a harbour or ferry terminal, ' + perText(rules.cargoFeePer, 'package'));
    setText('home-fee-airport', fmt(rates.airport));
    setText('home-fee-airport-note', 'Pickup or drop-off at ' + MDM.geo.zoneLabel('airport') + ', ' + perText(rules.airportFeePer, 'package'));
    setText('home-fee-business', fmt(rates.business) + ' per package');

    setText('home-review-time', ops.reviewText ? ', usually in ' + ops.reviewText : '');
  }

  // ---- Coverage map: zone labels as point markers, the Malé → Hulhumalé corridor at 35% opacity, fitted to the zones ------
  function showFallback(box) {
    if (box.querySelector('.map__fallback')) return;
    box.appendChild(el('div', { class: 'map__fallback', 'data-testid': 'home-map-fallback' },
      el('div', { class: 'alert alert--warn', role: 'status' }, html(MDM.icon('alert-triangle', 16)),
        el('div', { class: 'alert__body' }, 'Map unavailable right now. The zones we cover are listed below.'))));
    box.dataset.state = 'fallback';
  }
  async function mountMap() {
    const box = document.getElementById('coverage-map');
    if (!box) return;
    if (!MDM.map.available()) { showFallback(box); return; }
    let map;
    try { map = await MDM.map.create(box, { interactive: false, center: MDM.geo.CENTER, zoom: 11.6 }); }
    catch (e) { showFallback(box); return; }
    const zones = MDM.geo.ZONE_LIST;
    const male = MDM.geo.zone('male'), p2 = MDM.geo.zone('hulhumale_p2');
    const corridor = MDM.geo.routeBetween({ lat: male.center[0], lng: male.center[1], zone: male.key }, { lat: p2.center[0], lng: p2.center[1], zone: p2.key });
    const line = Array.isArray(corridor) ? corridor : [];
    if (line.length > 1) MDM.map.route(map, 'corridor', line, { active: false });
    // The airport gets its short name on the map; the sentence under the map spells it out. Extra bottom padding keeps the
    // southern labels clear of the attribution control, which wraps to two lines on a narrow map.
    zones.forEach(z => { const m = MDM.map.marker(map, 'point', z.center, { label: z.airport ? z.short : z.label }); m.el.dataset.zone = z.key; });
    const narrow = box.clientWidth < 600;
    MDM.map.fit(map, zones.map(z => z.center), { padding: { top: 28, right: narrow ? 24 : 32, bottom: narrow ? 76 : 56, left: narrow ? 24 : 32 }, maxZoom: 13 });
    box.dataset.state = 'ready';
    box.dataset.corridor = String(line.length);
  }

  async function main() {
    await MDM.store.ready;
    await render();
    MDM.store.subscribe('settings', () => { render(); });
    MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') render(); });
    // The hours line flips at open and close without a reload; the shell keeps the settings cache current.
    setInterval(() => { setText('home-hours', MDM.shell.hoursLine()); }, HOURS_TICK_MS);
    mountMap();
  }
  main();
})(window.MDM);

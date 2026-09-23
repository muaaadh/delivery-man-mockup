// Home: the customer-facing one-pager. The copy is static HTML; this script fills every number from settings, draws the icons,
// runs the live demo order inside the hero phone (real map, real rider position, real ETA) and the coverage map.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const fmt = n => MDM.pricing.format(n);
  const node = testid => document.querySelector('[data-testid="' + testid + '"]');
  const setText = (testid, text) => { const n = node(testid); if (n) n.textContent = text == null ? '' : String(text); };
  const DEMO_CODE = 'MDM-1038';

  function rangeText(cell) {
    if (!cell) return '';
    const same = Math.round(Number(cell.same) || 0), cross = Math.round(Number(cell.cross) || 0);
    return same === cross ? fmt(same) : fmt(same) + ' to ' + fmt(cross).replace(/^MVR /, '');
  }

  async function render() {
    const s = await MDM.store.settings();
    const rates = s.rates || {}, sizes = rates.sizes || {}, rules = s.rules || {}, guide = s.sizeGuide || {}, ops = s.ops || {};
    const pct = Math.round(Number(rates.shoppingPct) || 0);
    const bag = sizes.bag || {}, box = sizes.box || {}, xl = sizes.xl || {};

    const hours = MDM.shell.hoursLine(s);
    setText('home-hours', hours);
    const status = node('home-hours') && node('home-hours').parentElement;
    if (status) status.dataset.open = String(/^Open/.test(hours));

    const mins = /(\d+\s*to\s*\d+)\s*minutes/.exec(ops.asapText || '');
    setText('home-glance-time', mins ? mins[1] + ' min' : 'Same day');
    setText('home-glance-bag', fmt(bag.same));
    setText('home-hero-from', fmt(bag.same));

    setText('home-service-price-pick', 'From ' + fmt(bag.same));
    setText('home-service-price-shop', 'From ' + fmt(bag.same));
    setText('home-service-fee-shop', 'plus a ' + pct + '% shopping fee');
    setText('home-service-price-business', fmt(rates.business));

    setText('home-route-cross', fmt(bag.cross)); setText('home-rate-bag', rangeText(bag)); setText('home-rate-bag-same', fmt(bag.same)); setText('home-rate-bag-cross', fmt(bag.cross));
    setText('home-rate-box', rangeText(box)); setText('home-rate-box-same', fmt(box.same)); setText('home-rate-box-cross', fmt(box.cross));
    setText('home-rate-xl', 'from ' + fmt(xl.same));
    setText('home-guide-bag', guide.bag); setText('home-guide-box', guide.box); setText('home-guide-xl', guide.xl);

    setText('home-fee-shopping', pct + '% of the receipt');
    setText('home-fee-cargo', fmt(rates.cargo));
    setText('home-fee-cargo-note', rules.cargoFeePer === 'order' ? 'once per order at a terminal' : 'per package at a terminal');
    setText('home-fee-airport', fmt(rates.airport));
    setText('home-fee-airport-note', rules.airportFeePer === 'package' ? 'per package' : 'once per order');
    setText('home-fee-business', fmt(rates.business));
    setText('home-due-days', 'due in ' + (Number(s.invoiceDueDays) || 14) + ' days');

    const review = ops.reviewText ? ', usually in ' + ops.reviewText : '';
    setText('home-review-time', review); setText('home-faq-review', review);
    if (ops.asapText) setText('home-faq-asap', ops.asapText + ' when you choose "as soon as possible". You can also pick a 2-hour window later today or another day.');
    if (s.terms) setText('home-terms', s.terms);

    const c = MDM.shell.contactLinks();
    const wa = document.querySelector('[data-contact="whatsapp"]'), tel = document.querySelector('[data-contact="tel"]');
    if (wa) { if (c.whatsapp) { wa.href = c.whatsapp; wa.target = '_blank'; wa.rel = 'noopener'; } else wa.hidden = true; }
    if (tel) { if (c.tel) { tel.href = c.tel; tel.textContent = 'Call ' + c.display; } else tel.hidden = true; }
  }

  function drawIcons() {
    document.querySelectorAll('[data-icon]').forEach(n => { if (!n.firstChild) n.innerHTML = MDM.icon(n.dataset.icon, n.classList.contains('route-demo__bike') ? 16 : 24); });
  }

  // ---- Hero phone + tracking card: the live demo order ----------------------------------------------------------------
  const demo = { order: null, driver: null, map: null, marker: null, unsub: null, cross: false, settings: null };
  function hhmm(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function updateEta(pos) {
    if (!demo.order || !pos) return;
    const km = MDM.geo.remainingKm(demo.order.route.polyline, pos);
    const min = MDM.geo.etaMinutes(km, demo.cross, demo.settings);
    setText('home-phone-eta', hhmm(new Date(Date.now() + min * 60000)));
  }
  async function loadDemo() {
    let order = await MDM.store.orderByCode(DEMO_CODE);
    if (!order || !order.driverId || !order.route || !(order.route.polyline || []).length) {
      order = (await MDM.store.list('orders', { where: { status: ['in_transit', 'picked_up', 'assigned'] } })).find(o => o.driverId && o.route && (o.route.polyline || []).length) || null;
    }
    demo.order = order;
    demo.settings = await MDM.store.settings();
    if (!order) return;
    demo.driver = await MDM.store.get('drivers', order.driverId);
    const pkg = order.packages && order.packages[0];
    demo.cross = !!(pkg && pkg.price && pkg.price.crossIsland);
    const label = (MDM.STATUS[order.status] || {}).customer || order.status;
    setText('home-phone-code', order.code); setText('home-track-code', order.code);
    ['home-phone-status', 'home-track-status'].forEach(id => { const n = node(id); if (n) n.outerHTML = MDM.badgeFor(order.status, { customer: true }).replace('<span ', '<span data-testid="' + id + '" '); });
    if (demo.driver) {
      setText('home-phone-rider', demo.driver.name);
      setText('home-phone-initials', demo.driver.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase());
      setText('home-phone-vehicle', ({ bike: 'Bike', car: 'Car', pickup: 'Pickup' }[demo.driver.vehicle] || 'Bike') + (demo.driver.vehicleNote ? ' · ' + demo.driver.vehicleNote : ''));
    }
    const a = document.querySelector('[data-testid="home-try-tracking"]'); if (a) a.href = MDM.href('track/?code=' + encodeURIComponent(order.code));
    renderTimeline(order);
  }
  function renderTimeline(order) {
    const list = node('home-track-events'); if (!list) return;
    const pub = (order.events || []).filter(e => e.visibility !== 'internal');
    const pick = type => pub.filter(e => e.type === type).pop();
    const rows = [
      { label: 'Order placed', ev: pick('created') },
      { label: 'Payment verified', ev: pick('payment_verified') },
      { label: 'Picked up', ev: pick('picked_up') },
      { label: (MDM.STATUS[order.status] || {}).customer || 'On the way', ev: null, current: true },
      { label: 'Delivered', ev: pick('delivered') },
    ];
    list.replaceChildren(...rows.map(r => el('li', { class: r.ev ? 'is-done' : r.current ? 'is-current' : '' }, el('span', null, r.label), r.ev ? el('small', null, MDM.ui.fmtDate(r.ev.at)) : r.current ? el('small', null, 'Now') : null)));
  }
  async function mountHeroMap() {
    const box = document.getElementById('hero-map');
    if (!box || !demo.order || !MDM.map.available()) return;
    let map;
    try { map = await MDM.map.create(box, { interactive: false, zoom: 12.5 }); } catch (e) { return; }
    demo.map = map;
    const o = demo.order;
    MDM.map.route(map, 'demo-route', o.route.polyline, {});
    MDM.map.stopMarkers(map, (o.route.stops || []).map(s => Object.assign({}, s, { label: '' })));
    const pos = MDM.live.last(o.driverId) || await MDM.store.get('positions', o.driverId);
    if (pos) { demo.marker = MDM.map.driverMarker(map, pos, demo.driver); updateEta(pos); }
    MDM.map.fit(map, o.route.polyline, { padding: { top: 24, right: 24, bottom: 40, left: 24 }, maxZoom: 15 });
    demo.unsub = MDM.live.onPosition(o.driverId, p => {
      if (!demo.marker) demo.marker = MDM.map.driverMarker(map, p, demo.driver); else demo.marker.moveTo(p, 1000);
      updateEta(p);
    });
  }

  // ---- Coverage map ---------------------------------------------------------------------------------------------------
  function showFallback(box) {
    if (box.querySelector('.map__fallback')) return;
    box.appendChild(el('div', { class: 'map__fallback', 'data-testid': 'home-map-fallback' },
      el('div', { class: 'alert alert--warn', role: 'status' }, html(MDM.icon('alert-triangle', 16)),
        el('div', { class: 'alert__body' }, 'Map unavailable right now. The zones we cover are listed here.'))));
    box.dataset.state = 'fallback';
  }
  async function mountCoverage() {
    const box = document.getElementById('coverage-map');
    if (!box) return;
    if (!MDM.map.available()) { showFallback(box); return; }
    let map;
    try { map = await MDM.map.create(box, { interactive: false, center: MDM.geo.CENTER, zoom: 11.6 }); }
    catch (e) { showFallback(box); return; }
    const zones = MDM.geo.ZONE_LIST;
    const male = MDM.geo.zone('male'), p2 = MDM.geo.zone('hulhumale_p2');
    const corridor = MDM.geo.routeBetween({ lat: male.center[0], lng: male.center[1], zone: male.key }, { lat: p2.center[0], lng: p2.center[1], zone: p2.key });
    if (Array.isArray(corridor) && corridor.length > 1) MDM.map.route(map, 'corridor', corridor, { active: false });
    zones.forEach(z => { const m = MDM.map.marker(map, 'point', z.center, { label: z.airport ? z.short : z.label }); m.el.dataset.zone = z.key; });
    MDM.map.fit(map, zones.map(z => z.center), { padding: { top: 32, right: 40, bottom: 60, left: 40 }, maxZoom: 13 });
    box.dataset.state = 'ready';
  }

  async function main() {
    drawIcons();
    await MDM.store.ready;
    await render();
    MDM.store.subscribe('settings', () => { render(); });
    MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') { render(); loadDemo(); } });
    MDM.store.subscribe('orders', () => { if (demo.order) MDM.store.get('orders', demo.order.id).then(o => { if (o) { demo.order = o; renderTimeline(o); } }); });
    setInterval(() => { const h = MDM.shell.hoursLine(); setText('home-hours', h); const st = node('home-hours'); if (st) st.parentElement.dataset.open = String(/^Open/.test(h)); }, 60000);
    await loadDemo();
    mountHeroMap();
    mountCoverage();
  }
  main();
})(window.MDM);

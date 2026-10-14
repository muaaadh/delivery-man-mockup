// Home: the three service categories, the delivery methods and the rate ranges (web app updates 11/10/2026 §1, §3, §4) are
// filled from the shared lists and settings; it also runs the live demo order in the hero phone (real map, rider, ETA), drives the
// scrubbed hero stage and the pinned "How it works" story, and draws the coverage map. Motion primitives come from js/motion.js.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const fmt = n => MDM.pricing.format(n);
  const node = testid => document.querySelector('[data-testid="' + testid + '"]');
  const setText = (testid, text) => { const n = node(testid); if (n && text != null) n.textContent = String(text); };
  const setKey = (k, text) => document.querySelectorAll('[data-k="' + k + '"]').forEach(n => { if (text != null) n.textContent = String(text); });
  const DEMO_CODE = 'MDM-1038';

  // Count-up numbers ([data-count]) end on dataset.countFinal, so a settings change mid-animation still lands on the right text.
  const setCount = (testid, text) => { const n = node(testid); if (n && text != null) { n.textContent = String(text); n.dataset.countFinal = String(text); } };

  // Service categories (§1), collection types and delivery methods (§3) take their wording from the shared lists.
  function renderLabels() {
    MDM.SERVICE_CATEGORIES.forEach(c => {
      document.querySelectorAll('[data-cat-label="' + c.value + '"]').forEach(n => { n.textContent = c.label; });
      document.querySelectorAll('[data-cat-hint="' + c.value + '"]').forEach(n => { n.textContent = c.hint.replace(/([^.])$/, '$1.'); });
    });
    MDM.REQUEST_TYPES.forEach(t => document.querySelectorAll('[data-type-label="' + t.value + '"]').forEach(n => { n.textContent = t.label; }));
    MDM.DELIVERY_METHODS.forEach(m => document.querySelectorAll('[data-method-label="' + m.value + '"]').forEach(n => { n.textContent = m.label; }));
  }
  // Business size categories (§1.3) with their starting rates, smallest first; each business then agrees its own rates.
  function renderTiers(s) {
    const list = node('home-business-tiers');
    const tiers = MDM.pricing.businessTiers(s);
    if (list) list.replaceChildren(...tiers.map(t => el('li', { 'data-tier': t.value }, el('span', null, t.label + ', ' + (t.size === 'xl' ? 'XL' : MDM.pricing.sizeLabel(t.size).toLowerCase()) + ' size'),
      el('strong', { class: 'mono' }, el('span', { class: 'tiers__from' }, 'from'), ' ' + fmt(t.rate)))));
    return tiers.reduce((m, t) => Math.min(m, Number(t.rate) || Infinity), Infinity);
  }

  async function render() {
    const s = await MDM.store.settings();
    const rates = s.rates || {}, sizes = rates.sizes || {}, guide = s.sizeGuide || {}, ops = s.ops || {};
    const pct = Math.round(Number(rates.shoppingPct) || 0);
    const bag = sizes.bag || {};

    const hours = MDM.shell.hoursLine(s);
    setText('home-hours', hours);
    const status = node('home-hours'); if (status) status.parentElement.dataset.open = String(/^Open/.test(hours));

    renderLabels();
    const bizFrom = renderTiers(s);
    const bizMin = isFinite(bizFrom) ? bizFrom : Math.round(Number(rates.business) || 0);

    setText('home-hero-from', fmt(bag.same));
    setText('home-service-price-pick', 'From ' + fmt(bag.same));
    setText('home-service-price-shop', 'From ' + fmt(bag.same));
    setText('home-service-fee-shop', 'Shopping fee ' + pct + '%');
    const fee = document.querySelector('.receipt__fee .mono'); if (fee) fee.textContent = fmt(Math.round(136 * pct / 100));
    // The cargo fee is per package unless rules.cargoFeePer is 'order' (and the airport fee per order unless airportFeePer is 'package').
    const rules = s.rules || {};
    const cargoEach = rules.cargoFeePer === 'order' ? '' : ' a package', airportEach = rules.airportFeePer === 'package' ? ' a package' : '';
    setText('home-method-cargo-fee', fmt(rates.cargo) + cargoEach); setText('home-method-airport-fee', fmt(rates.airport) + airportEach);
    setText('home-fee-cargo-note', (cargoEach ? 'a package, ' : '') + 'only for Maldivian Cargo deliveries');
    setText('home-fee-airport-note', (airportEach ? 'a package, ' : '') + 'airport deliveries');

    // §4: rates as ranges (Bag MVR 35–45, Box MVR 45–60, XL MVR 60++) straight from settings.rates.sizes.
    ['bag', 'box', 'xl'].forEach(size => { setCount('home-rate-' + size, MDM.pricing.rangeLabel(size, s)); setKey('range-' + size, MDM.pricing.rangeLabel(size, s)); });
    setText('home-guide-bag', guide.bag); setText('home-guide-box', guide.box);
    setText('home-fee-shopping', pct + '% of the budget');
    setText('home-fee-cargo', fmt(rates.cargo)); setText('home-fee-airport', fmt(rates.airport));
    setKey('fee-cargo', fmt(rates.cargo) + cargoEach); setKey('fee-airport', fmt(rates.airport) + airportEach);
    setText('home-fee-business-from', 'from ' + fmt(bizMin));
    setCount('home-fee-business', String(bizMin));
    setText('home-due-days', 'due in ' + (Number(s.invoiceDueDays) || 14) + ' days');

    setKey('bag-cross', fmt(bag.cross)); setKey('bag-same', fmt(bag.same)); setKey('bag-cross-num', String(bag.cross));
    const bank = (s.banks || [])[0]; if (bank) { setKey('bank-name', bank.name); setKey('bank-no', bank.accountNo); }
    setKey('review', ops.reviewText ? ', usually in ' + ops.reviewText : '');
    if (ops.asapText) setText('home-faq-asap', ops.asapText + ' on a normal order. Choose Express to jump the queue (we confirm it first), or an Advance order to book the collection and delivery days ahead.');
    if (s.terms) setText('home-terms', s.terms);

    const c = MDM.shell.contactLinks();
    const wa = document.querySelector('[data-contact="whatsapp"]'), tel = document.querySelector('[data-contact="tel"]');
    if (wa) { if (c.whatsapp) { wa.href = c.whatsapp; wa.target = '_blank'; wa.rel = 'noopener'; } else wa.hidden = true; }
    if (tel) { if (c.tel) { tel.href = c.tel; tel.textContent = 'Call ' + c.display; } else tel.hidden = true; }
  }

  function drawIcons(scope) {
    (scope || document).querySelectorAll('[data-icon]').forEach(n => { if (!n.firstChild) n.innerHTML = MDM.icon(n.dataset.icon, 24); });
  }

  // ---- Hero: the live demo order inside the phone --------------------------------------------------------------------
  const demo = { order: null, driver: null, marker: null, cross: false, settings: null };
  const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  function updateEta(pos) {
    if (!demo.order || !pos) return;
    const km = MDM.geo.remainingKm(demo.order.route.polyline, pos);
    setText('home-phone-eta', hhmm(new Date(Date.now() + MDM.geo.etaMinutes(km, demo.cross, demo.settings) * 60000)));
  }
  async function loadDemo() {
    let order = await MDM.store.orderByCode(DEMO_CODE);
    if (!order || !order.driverId || !(order.route && (order.route.polyline || []).length)) {
      order = (await MDM.store.list('orders', { where: { status: ['out_for_delivery', 'collected', 'on_the_way', 'arrived', 'dispatched'] } })).find(o => o.driverId && o.route && (o.route.polyline || []).length) || null;
    }
    demo.order = order; demo.settings = await MDM.store.settings();
    if (!order) return;
    demo.driver = await MDM.store.get('drivers', order.driverId);
    const pkg = order.packages && order.packages[0];
    demo.cross = !!(pkg && pkg.price && pkg.price.crossIsland);
    setText('home-phone-code', order.code);
    const badge = node('home-phone-status'); if (badge) badge.outerHTML = MDM.badgeFor(order.status, { customer: true }).replace('<span ', '<span data-testid="home-phone-status" ');
    if (demo.driver) {
      setText('home-phone-rider', demo.driver.name);
      setText('home-phone-initials', demo.driver.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase());
      setText('home-phone-vehicle', ({ bike: 'Bike', car: 'Car', pickup: 'Pickup' }[demo.driver.vehicle] || 'Bike') + (demo.driver.vehicleNote ? ' · ' + demo.driver.vehicleNote : ''));
    }
  }
  async function mountHeroMap() {
    const box = document.getElementById('hero-map');
    if (!box || !demo.order || !MDM.map.available()) return;
    let map;
    try { map = await MDM.map.create(box, { interactive: false, zoom: 12.5 }); } catch (e) { return; }
    const o = demo.order;
    MDM.map.route(map, 'demo-route', o.route.polyline, {});
    MDM.map.stopMarkers(map, (o.route.stops || []).map(s => Object.assign({}, s, { label: '' })));
    const pos = MDM.live.last(o.driverId) || await MDM.store.get('positions', o.driverId);
    if (pos) { demo.marker = MDM.map.driverMarker(map, pos, demo.driver); updateEta(pos); }
    MDM.map.fit(map, o.route.polyline, { padding: { top: 28, right: 28, bottom: 44, left: 28 }, maxZoom: 15 });
    MDM.live.onPosition(o.driverId, p => { if (!demo.marker) demo.marker = MDM.map.driverMarker(map, p, demo.driver); else demo.marker.moveTo(p, 1000); updateEta(p); });
  }

  // Scrubbed hero: as the page scrolls, the red stage widens to full width and the phone rises through it.
  function heroScene() {
    const stage = document.querySelector('.hero__stage');
    if (!stage) return;
    let top = 0;
    MDM.motion.addScene({
      measure() { top = MDM.motion.pageTop(stage); },
      update(y, vh) {
        const p = MDM.motion.clamp((y + vh - top) / (vh * 1.1), 0, 1);
        stage.style.setProperty('--panel', (0.9 + 0.1 * p).toFixed(4));
        stage.style.setProperty('--lift', (36 - 80 * p).toFixed(1) + 'px');
      },
    });
  }

  // ---- How it works: the step crossing the middle of the viewport picks the phone screen --------------------------------
  function story() {
    const phone = document.getElementById('story-phone');
    const steps = Array.from(document.querySelectorAll('.story__step'));
    if (!phone || !steps.length) return;
    // Phones below 900px get their own small phone per step (the sticky one is hidden there).
    steps.forEach(step => {
      const n = step.dataset.step;
      const src = phone.querySelector('.scr--' + n);
      if (!src) return;
      const mini = el('div', { class: 'story__mini', 'aria-hidden': 'true' },
        el('div', { class: 'phone', 'data-step': n }, el('div', { class: 'phone__screen' }, src.cloneNode(true))));
      step.insertBefore(mini, step.firstChild);
    });
    drawIcons(document.querySelector('.story'));
    const setStep = n => {
      if (phone.dataset.step === n) return;
      phone.dataset.step = n;
      steps.forEach(s => s.classList.toggle('is-active', s.dataset.step === n));
    };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) setStep(e.target.dataset.step); }), { rootMargin: '-50% 0px -50% 0px', threshold: 0 });
      steps.forEach(s => io.observe(s));
      const miniIo = new IntersectionObserver(entries => entries.forEach(e => e.target.classList.toggle('is-active', e.isIntersecting)), { threshold: 0.4 });
      document.querySelectorAll('.story__mini').forEach(m => miniIo.observe(m));
    } else document.querySelectorAll('.story__mini').forEach(m => m.classList.add('is-active'));
  }

  // ---- Coverage map ---------------------------------------------------------------------------------------------------
  function showFallback(box) {
    if (box.querySelector('.map__fallback')) return;
    box.appendChild(el('div', { class: 'map__fallback', 'data-testid': 'home-map-fallback' },
      el('div', { class: 'alert alert--warn', role: 'status' }, html(MDM.icon('alert-triangle', 16)),
        el('div', { class: 'alert__body' }, 'Map unavailable right now. The zones we cover are listed below.'))));
  }
  async function mountCoverage() {
    const box = document.getElementById('coverage-map');
    if (!box) return;
    if (!MDM.map.available()) { showFallback(box); return; }
    let map;
    try { map = await MDM.map.create(box, { interactive: false, center: MDM.geo.CENTER, zoom: 11.6 }); } catch (e) { showFallback(box); return; }
    const male = MDM.geo.zone('male'), p2 = MDM.geo.zone('hulhumale_p2');
    const corridor = MDM.geo.routeBetween({ lat: male.center[0], lng: male.center[1], zone: male.key }, { lat: p2.center[0], lng: p2.center[1], zone: p2.key });
    if (Array.isArray(corridor) && corridor.length > 1) MDM.map.route(map, 'corridor', corridor, { active: false });
    MDM.geo.ZONE_LIST.forEach(z => { const m = MDM.map.marker(map, 'point', z.center, { label: z.airport ? z.short : z.label }); m.el.dataset.zone = z.key; });
    MDM.map.fit(map, MDM.geo.ZONE_LIST.map(z => z.center), { padding: { top: 40, right: 48, bottom: 64, left: 48 }, maxZoom: 13 });
  }

  async function main() {
    drawIcons();
    story();
    heroScene();
    await MDM.store.ready;
    await render();
    MDM.store.subscribe('settings', () => { render(); });
    MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') { render(); loadDemo(); } });
    setInterval(() => { const h = MDM.shell.hoursLine(); setText('home-hours', h); const st = node('home-hours'); if (st) st.parentElement.dataset.open = String(/^Open/.test(h)); }, 60000);
    await loadDemo();
    mountHeroMap();
    mountCoverage();
    MDM.motion.measure();
  }
  main();
})(window.MDM);

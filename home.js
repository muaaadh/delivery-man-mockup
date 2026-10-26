// Home: the three service categories and the delivery methods take their wording from the shared lists (web app updates
// 11/10/2026 §1, §3); the review and delivery times, the invoice terms, the terms and the contact links come from settings. No
// prices at all on this page (client, 24 and 25 Oct 2026): they show when an order is placed. It also plays the drawn delivery in the
// hero phone, runs the "How it works" phone that follows the step on screen, two scrubbed scenes (hero phone lift, business
// panel), the header scroll-spy, the phone quick bar and the coverage map (MapLibre loads only when the map is near). Motion
// primitives come from js/motion.js.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const node = testid => document.querySelector('[data-testid="' + testid + '"]');
  const setText = (testid, text) => { const n = node(testid); if (n && text != null) n.textContent = String(text); };
  const setKey = (k, text) => document.querySelectorAll('[data-k="' + k + '"]').forEach(n => { if (text != null) n.textContent = String(text); });
  const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

  // Service categories (§1), collection types and delivery methods (§3) take their wording from the shared lists.
  function renderLabels() {
    MDM.SERVICE_CATEGORIES.forEach(c => document.querySelectorAll('[data-cat-label="' + c.value + '"]').forEach(n => { n.textContent = c.label; }));
    MDM.REQUEST_TYPES.forEach(t => document.querySelectorAll('[data-type-label="' + t.value + '"]').forEach(n => { n.textContent = t.label; }));
    MDM.DELIVERY_METHODS.forEach(m => document.querySelectorAll('[data-method-label="' + m.value + '"]').forEach(n => { n.textContent = m.label; }));
  }
  function setHours(line) {
    setText('home-hours', line);
    const status = node('home-hours'); if (status) status.parentElement.dataset.open = String(/^Open/.test(line));
  }

  async function render() {
    const s = await MDM.store.settings();
    const ops = s.ops || {}, due = Number(s.invoiceDueDays) || 14;

    setHours(MDM.shell.hoursLine(s));
    renderLabels();
    setText('home-due-days', 'due in ' + due + ' day' + (due === 1 ? '' : 's'));
    setKey('review', ops.reviewText ? ', usually in ' + ops.reviewText : '');
    if (ops.asapText) setText('home-faq-asap', ops.asapText + '. Express jumps the queue; an advance order books a set day and time.');
    if (s.terms) setText('home-terms', s.terms);

    // Closing call to action: WhatsApp, Viber and the phone from settings.contact; a channel without a number is hidden.
    const c = MDM.shell.contactLinks();
    const link = (key, href, external) => {
      const a = document.querySelector('[data-contact="' + key + '"]');
      if (!a) return null;
      a.hidden = !href;
      if (href) { a.href = href; if (external) { a.target = '_blank'; a.rel = 'noopener'; } }
      return a;
    };
    link('whatsapp', c.whatsapp, true);
    link('viber', c.viber, false);
    const tel = link('tel', c.tel, false);
    if (tel && c.tel) { tel.setAttribute('aria-label', 'Call ' + c.display); const num = tel.querySelector('.finale__num'); if (num) num.textContent = ' ' + c.display; }
  }

  // Icons on this page are drawn once into their [data-icon] holders.
  function drawIcons() {
    document.querySelectorAll('[data-icon]').forEach(n => { if (!n.firstChild) n.innerHTML = MDM.icon(n.dataset.icon, 24); });
  }

  // ---- Hero: a drawn delivery on a calm loop -------------------------------------------------------------------------------
  // The phone plays the same trip on the demo and on the live site (no map, no order data): the red route draws itself from the
  // pickup, the rider rides it to the jetty, and the status pill, the arrival time and the progress bars follow in step:
  // Collected, On the way, Delivered. Then it fades and starts again. It pauses while off screen or in a background tab; reduced
  // motion shows one still frame with the rider on the way.
  const TRIP = { LOOP: 12500, IN: 400, DRAW: [200, 1600], RIDE: [1900, 9100], FADE: [11600, 12300], MINUTES: 12, STILL: 0.6 };
  const STATES = { collected: 'Collected', way: 'On the way', done: 'Delivered' };
  const ORDER = ['collected', 'way', 'done'];
  const easeOut = x => 1 - Math.pow(1 - x, 3);
  const easeInOut = x => x * x * (3 - 2 * x);
  const span = (t, [a, b]) => MDM.motion.clamp((t - a) / (b - a), 0, 1);

  function heroTrip() {
    const phone = node('home-phone');
    const svg = phone && phone.querySelector('.trip');
    const route = svg && svg.querySelector('.trip__route');
    if (!route || typeof route.getTotalLength !== 'function') return;
    const rider = svg.querySelector('.trip__rider'), fx = svg.querySelector('.trip__fx');
    const pill = node('home-phone-status'), eta = node('home-phone-eta'), etaLabel = node('home-phone-eta-label');
    const steps = Array.from(phone.querySelectorAll('.phone__steps li')), fills = steps.map(li => li.querySelector('.phone__fill'));
    const len = route.getTotalLength();
    route.style.strokeDasharray = len.toFixed(1);
    const last = {};
    const put = (key, value, apply) => { if (last[key] !== value) { last[key] = value; apply(value); } };

    // One frame of the story: state, how much of the route is drawn, where the rider is (0 to 1) and the overlay opacity.
    function paint(state, drawn, p, shown) {
      put('state', state, st => {
        const at = ORDER.indexOf(st);
        pill.dataset.state = st; pill.textContent = STATES[st];
        steps.forEach((li, i) => { li.classList.toggle('is-done', i < at || st === 'done'); li.classList.toggle('is-current', i === at && st !== 'done'); });
        svg.classList.toggle('is-done', st === 'done');
        etaLabel.textContent = st === 'done' ? 'Delivered at' : 'Arriving in';
        if (st === 'done') eta.textContent = hhmm(new Date());
      });
      if (state !== 'done') put('eta', Math.max(1, Math.ceil(TRIP.MINUTES * (1 - p))) + ' min', v => { eta.textContent = v; });
      put('drawn', drawn.toFixed(3), () => { route.style.strokeDashoffset = (len * (1 - drawn)).toFixed(1); });
      put('p', p.toFixed(4), () => {
        const pt = route.getPointAtLength(len * p);
        rider.setAttribute('transform', 'translate(' + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1) + ')');
        if (fills[1]) fills[1].style.transform = 'scaleX(' + p.toFixed(3) + ')';
      });
      put('done', state === 'done', d => { if (fills[2]) fills[2].style.transform = 'scaleX(' + (d ? 1 : 0) + ')'; });
      put('shown', shown.toFixed(2), v => { fx.style.opacity = v; });
    }
    function frame(t) {
      if (t < 0) { paint('collected', 0, 0, 0); return; }
      const p = easeInOut(span(t, TRIP.RIDE));
      const state = t >= TRIP.RIDE[1] ? 'done' : t >= TRIP.RIDE[0] ? 'way' : 'collected';
      const shown = t < TRIP.FADE[0] ? span(t, [0, TRIP.IN]) : 1 - span(t, TRIP.FADE);
      paint(state, easeOut(span(t, TRIP.DRAW)), p, shown);
    }

    if (MDM.motion.reduced) { paint('way', 1, TRIP.STILL, 1); return; }
    // The first loop waits for the phone to rise into place.
    let t = -900, prev = 0, raf = 0, onScreen = false;
    const tick = now => {
      raf = 0;
      t += Math.min(64, prev ? now - prev : 16); prev = now;
      if (t >= TRIP.LOOP) t -= TRIP.LOOP;
      frame(t);
      if (onScreen && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const run = () => { if (!raf && onScreen && !document.hidden) { prev = 0; raf = requestAnimationFrame(tick); } };
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
    frame(t);
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; if (onScreen) run(); else stop(); }).observe(phone);
    else { onScreen = true; run(); }
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else run(); });
  }

  // ---- Scrubbed scenes (skipped under reduced motion by MDM.motion.addScene); each writes one custom property, only on change ----
  // Hero: as the hero scrolls away the phone lifts up to 56px, ahead of the red panel behind it.
  function heroScene() {
    const hero = document.querySelector('.hero'), lift = document.querySelector('.hero__lift');
    if (!hero || !lift) return;
    let top = 0, h = 1, last = '';
    MDM.motion.addScene({
      measure() { top = MDM.motion.pageTop(hero); h = Math.max(1, hero.offsetHeight); },
      update(y) {
        const v = (-56 * MDM.motion.clamp((y - top) / h, 0, 1)).toFixed(1) + 'px';
        if (v !== last) { lift.style.setProperty('--lift', v); last = v; }
      },
    });
  }
  // Business strip: the dark panel opens from 94% to full width as it rises into view.
  function bizScene() {
    const wrap = document.querySelector('.biz-scale');
    if (!wrap) return;
    let top = 0, last = '';
    MDM.motion.addScene({
      measure() { top = MDM.motion.pageTop(wrap); },
      update(y, vh) {
        const v = (0.94 + 0.06 * MDM.motion.clamp((y + vh - top) / (vh * 0.65), 0, 1)).toFixed(4);
        if (v !== last) { wrap.style.setProperty('--biz', v); last = v; }
      },
    });
  }
  // The road under the hero: the logo's rider rides along it with the scroll, from the content edge to off the right end by the time
  // the road reaches the header. The wheels turn with the distance (--roll); while it moves the boxes hop (.is-rolling).
  function heroRoad() {
    const holder = document.querySelector('.hero__rider-go'), road = document.querySelector('.hero__road');
    if (!holder || !road || !MDM.shell || !MDM.shell.RIDER) return;
    holder.innerHTML = MDM.shell.RIDER;
    const rider = holder.firstChild, box = holder.parentNode;
    let roadY = 1, travel = 0, last = '', idle = 0;
    MDM.motion.addScene({
      measure() {
        roadY = Math.max(1, MDM.motion.pageTop(road) - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 60));
        travel = road.offsetWidth - box.offsetLeft + 20;
      },
      update(y) {
        const x = travel * MDM.motion.clamp(y / roadY, 0, 1), v = x.toFixed(1);
        if (v === last) return;
        last = v;
        holder.style.setProperty('--rx', v + 'px');
        rider.style.setProperty('--roll', (x / box.offsetWidth * 426 % 360).toFixed(1) + 'deg');   // rolls without slipping: 86-unit wheels on a 640-unit logo
        rider.classList.add('is-rolling');
        clearTimeout(idle); idle = setTimeout(() => rider.classList.remove('is-rolling'), 160);
      },
    });
  }
  // Photo band: the photo drifts against the scroll (the media box is 20% taller than the band, so it never shows an edge).
  function bandScene() {
    const band = document.querySelector('.band'), media = band && band.querySelector('.band__media');
    if (!media) return;
    let top = 0, h = 1, last = '';
    MDM.motion.addScene({
      measure() { top = MDM.motion.pageTop(band); h = Math.max(1, band.offsetHeight); },
      update(y, vh) {
        const p = MDM.motion.clamp((y + vh - top) / (vh + h), 0, 1), v = ((p - 0.5) * 0.18 * h).toFixed(1) + 'px';
        if (v !== last) { media.style.setProperty('--band-y', v); last = v; }
      },
    });
  }

  // ---- How it works: the step on screen picks the phone screen ---------------------------------------------------------------
  // Desktop: the step crossing the middle of the screen, beside the sticky phone. Phones: the phone sits above a plain list and the
  // step that has just scrolled up into view (a line near the bottom) picks the screen, so the phone is still in sight for step 4.
  function story() {
    const phone = document.getElementById('story-phone');
    const steps = Array.from(document.querySelectorAll('.story__step'));
    if (!phone || !steps.length || !('IntersectionObserver' in window)) return;
    const setStep = n => {
      if (phone.dataset.step === n) return;
      phone.dataset.step = n;
      steps.forEach(s => s.classList.toggle('is-active', s.dataset.step === n));
    };
    const small = window.matchMedia('(max-width: 900px)');
    let io = null;
    const watch = () => {
      if (io) io.disconnect();
      io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) setStep(e.target.dataset.step); }),
        { rootMargin: small.matches ? '-90% 0px -10% 0px' : '-50% 0px -50% 0px', threshold: 0 });
      steps.forEach(s => io.observe(s));
    };
    watch();
    if (small.addEventListener) small.addEventListener('change', watch); else if (small.addListener) small.addListener(watch);
  }

  // ---- Navigation helpers -------------------------------------------------------------------------------------------
  // Scroll-spy: the header link for the section crossing the middle of the screen reads as the current place.
  function navSpy() {
    if (!('IntersectionObserver' in window)) return;
    const sections = Array.from(document.querySelectorAll('main > section[id]'));
    const mark = id => document.querySelectorAll('.site-nav a[href*="#"]').forEach(a => {
      const on = a.hash === '#' + id;
      if (on && a.getAttribute('aria-current') !== 'location') a.setAttribute('aria-current', 'location');
      else if (!on && a.getAttribute('aria-current') === 'location') a.removeAttribute('aria-current');
    });
    const io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) mark(e.target.id); }), { rootMargin: '-45% 0px -54% 0px', threshold: 0 });
    sections.forEach(s => io.observe(s));
  }
  // Phones: once the hero buttons have scrolled away, a bar keeps "Request a delivery" in thumb reach; it steps aside again at
  // the closing call to action (and for the footer below it).
  function quickbar() {
    const start = document.querySelector('.hero__actions'), end = document.getElementById('contact');
    if (!start || !end || !('IntersectionObserver' in window)) return;
    const bar = el('div', { class: 'quickbar', 'data-testid': 'home-quickbar' },
      el('a', { class: 'btn btn--brand btn--pill', href: MDM.href('request/') }, 'Request a delivery'),
      el('a', { class: 'btn btn--secondary btn--pill', href: MDM.href('track/') }, 'Track'));
    document.body.appendChild(bar);
    let past = false, done = false;
    const sync = () => bar.classList.toggle('is-on', past && !done);
    new IntersectionObserver(([e]) => { past = !e.isIntersecting && e.boundingClientRect.top < 0; sync(); }).observe(start);
    new IntersectionObserver(([e]) => { done = e.isIntersecting || e.boundingClientRect.top < 0; sync(); }).observe(end);
  }

  // ---- Coverage map ---------------------------------------------------------------------------------------------------
  // MapLibre (about 800 KB) loads only when the map comes within a screen of view; the hero never needs it.
  const MAPLIBRE = {
    css: 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.css', cssHash: 'sha384-K282sW/zFjTkrjR/+yr1H+gCukuy4OEYrkXRybV88g7pk+kZZYpNV6SAV59NcgFg',
    js: 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.js', jsHash: 'sha384-KKgyz2mG25bKJ1O2PyqTJPlAF8Kw2BpDmsLTNBXslICOBvhTAyF5F0XhLWF2ZovY',
  };
  let mapLibrary = null;
  function loadMapLibre() {
    if (MDM.map.available()) return Promise.resolve();
    if (!mapLibrary) mapLibrary = new Promise((resolve, reject) => {
      document.head.appendChild(el('link', { rel: 'stylesheet', href: MAPLIBRE.css, integrity: MAPLIBRE.cssHash, crossorigin: 'anonymous' }));
      document.head.appendChild(el('script', { src: MAPLIBRE.js, integrity: MAPLIBRE.jsHash, crossorigin: 'anonymous', on: { load: () => resolve(), error: () => reject(new Error('map_unavailable')) } }));
    });
    return mapLibrary;
  }
  // The places we cover, traced from the basemap as [lat, lng] outlines (they set the map's frame; nothing is drawn round them, client
  // 25/10/2026: names only), with where each name sits beside its island. Villimalé is a name at its ferry side.
  const AREAS = [
    { key: 'male', label: 'Malé', tag: [4.16662, 73.50969],
      outline: [
        [4.17668, 73.5011], [4.17892, 73.50297], [4.18041, 73.50596], [4.18078, 73.51081], [4.18004, 73.5153],
        [4.17832, 73.51791], [4.17631, 73.51918], [4.17258, 73.51844], [4.17072, 73.51642], [4.16983, 73.51007],
        [4.16886, 73.50372], [4.1696, 73.5011], [4.17258, 73.5005],
      ] },
    { key: 'airport', label: 'Velana Airport', tag: [4.19457, 73.51941],
      outline: [
        [4.17609, 73.528], [4.1819, 73.52591], [4.1901, 73.52516], [4.19755, 73.52591], [4.205, 73.5274],
        [4.21133, 73.52949], [4.21804, 73.53159], [4.21901, 73.53233], [4.2173, 73.53308], [4.21096, 73.53383],
        [4.20664, 73.53562], [4.20336, 73.53861], [4.20008, 73.54055], [4.19457, 73.53921], [4.18861, 73.53659],
        [4.18264, 73.53338], [4.17758, 73.53009],
      ] },
    { key: 'hulhumale', label: 'Hulhumalé', tag: [4.2199, 73.55677],
      outline: [
        [4.20008, 73.54085], [4.20336, 73.53846], [4.20679, 73.53547], [4.21245, 73.53517], [4.21767, 73.53547],
        [4.2199, 73.53263], [4.22437, 73.53435], [4.22959, 73.53734], [4.23555, 73.53958], [4.23965, 73.54055],
        [4.24122, 73.54294], [4.24122, 73.54967], [4.23928, 73.55161], [4.23332, 73.55154], [4.22475, 73.55079],
        [4.22214, 73.54817], [4.22102, 73.54653], [4.21469, 73.54556], [4.20798, 73.54332],
      ] },
    { key: 'villimale', label: 'Villimalé', tag: [4.17360, 73.48450],
      outline: [[4.17640, 73.48250], [4.17660, 73.48660], [4.17330, 73.48760], [4.17060, 73.48520], [4.17200, 73.48230]] },
  ];
  // Chaikin corner cutting, two passes: each edge keeps its middle half, so the traced corners become soft curves.
  function rounded(points) {
    let ring = points;
    for (let pass = 0; pass < 2; pass++) {
      ring = [].concat(...ring.map((p, i) => { const q = ring[(i + 1) % ring.length]; return [[p[0] * .75 + q[0] * .25, p[1] * .75 + q[1] * .25], [p[0] * .25 + q[0] * .75, p[1] * .25 + q[1] * .75]]; }));
    }
    const out = ring.map(p => [+p[1].toFixed(6), +p[0].toFixed(6)]);
    return out.concat([out[0]]);
  }
  function showFallback(box) {
    if (box.querySelector('.map__fallback')) return;
    box.appendChild(el('div', { class: 'map__fallback', 'data-testid': 'home-map-fallback' },
      el('div', { class: 'alert alert--warn', role: 'status' }, html(MDM.icon('alert-triangle', 16)),
        el('div', { class: 'alert__body' }, 'Map unavailable right now. We cover Malé, Hulhumalé, Velana Airport and Villimalé.'))));
  }
  async function mountCoverage(box) {
    try { await loadMapLibre(); } catch (e) { showFallback(box); return; }
    let map;
    try { map = await MDM.map.create(box, { interactive: false, center: MDM.geo.CENTER, zoom: 11.6 }); } catch (e) { showFallback(box); return; }
    const rings = AREAS.map(z => rounded(z.outline));
    AREAS.forEach(z => { const m = MDM.map.marker(map, 'point', z.tag, { label: z.label, testid: 'home-area-' + z.key }); m.el.classList.add('area-tag'); });
    // After every style load (and a light/dark swap): the basemap's own place and street names stay hidden, since they would repeat
    // ours. Each property is set only when it differs, so this settles.
    let pending = false;
    const set = (kind, id, key, value) => { if (map.getLayer(id) && map[kind === 'layout' ? 'getLayoutProperty' : 'getPaintProperty'](id, key) !== value) map[kind === 'layout' ? 'setLayoutProperty' : 'setPaintProperty'](id, key, value); };
    const tune = () => {
      pending = false;
      try {
        map.getStyle().layers.forEach(l => { if (l.type === 'symbol') set('layout', l.id, 'visibility', 'none'); });
      } catch (e) { /* the style is mid-swap */ }
    };
    tune();
    map.on('styledata', () => { if (!pending) { pending = true; requestAnimationFrame(tune); } });
    // Room at the bottom for Malé's name and the attribution; narrow maps keep less at the sides.
    const side = box.clientWidth < 500 ? 24 : 56;
    MDM.map.fit(map, [].concat(...rings).map(p => [p[1], p[0]]), { padding: { top: side === 24 ? 28 : 48, right: side, bottom: side === 24 ? 96 : 76, left: side }, maxZoom: 13 });
    box.dataset.state = 'ready';
  }
  function coverage() {
    const box = document.getElementById('coverage-map');
    if (!box) return;
    if (!('IntersectionObserver' in window)) { mountCoverage(box); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); mountCoverage(box); } }, { rootMargin: '0px 0px 100% 0px' });
    io.observe(box);
  }

  async function main() {
    drawIcons();
    heroTrip();
    story();
    heroScene();
    heroRoad();
    bizScene();
    bandScene();
    navSpy();
    quickbar();
    await MDM.store.ready;
    await render();
    MDM.store.subscribe('settings', () => { render(); });
    MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') render(); });
    setInterval(() => setHours(MDM.shell.hoursLine()), 60000);
    coverage();
    MDM.motion.measure();
  }
  main();
})(window.MDM);

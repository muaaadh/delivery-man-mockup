// Rider console (SPEC §3.6). One column: pick your name, go online, share location (route simulation or the phone's GPS) and work
// today's stops in route order. Every write goes through MDM.store (update drivers, startRoute, setStop, insert files); the stop
// list and the map re-render from one render() whenever orders or drivers change, in this tab or another.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const SESSION_KEY = 'mdm:driver';
  const q = sel => document.querySelector(sel);

  const ui = {
    select: q('[data-testid="driver-select"]'),
    online: q('[data-testid="driver-online"]'),
    status: q('[data-testid="driver-status"]'),
    simulate: q('[data-testid="driver-simulate"]'),
    gps: q('[data-testid="driver-gps"]'),
    gpsNote: q('[data-testid="driver-gps-note"]'),
    gpsAlert: q('[data-testid="driver-gps-alert"]'),
    mapEl: q('#driver-map'),
    recenter: q('[data-testid="driver-recenter"]'),
    route: q('#driver-route'),
    summary: q('[data-testid="driver-route-summary"]'),
  };

  const state = {
    driverId: null, driver: null, drivers: [], route: { orders: [], stops: [], polyline: [] },
    online: false,                 // mirrors drivers.status !== 'offline'; the doc is the truth so another tab's change shows here
    sim: null, gpsOn: false, gpsFix: null,
    currentId: null,               // the stop with is-current on the last render
    nearId: null,                  // the stop the simulation is waiting at (set by onStop, cleared when the rider completes it)
    focusStop: null,               // stop whose primary button takes focus after the next render (keyboard flow)
    wakeLock: null, speed: null, renderSeq: 0,
  };
  const map = { map: null, ready: null, route: null, stops: null, driver: null, posUnsub: null, fitted: false };

  // ---- Session, wake lock, time scale ----
  function readSession() {
    try { const v = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
  }
  function writeSession() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ driverId: state.driverId, online: state.online })); } catch (e) { /* storage blocked: nothing to remember */ }
  }
  function speedParam() { const v = parseFloat(new URLSearchParams(location.search).get('speed')); return v > 0 ? v : null; }
  async function keepAwake() {
    if (!('wakeLock' in navigator) || state.wakeLock || document.visibilityState !== 'visible') return;
    try {
      const w = await navigator.wakeLock.request('screen');
      state.wakeLock = w;
      w.addEventListener('release', () => { if (state.wakeLock === w) state.wakeLock = null; });
    } catch (e) { /* refused (battery saver, hidden tab): the note under the status line covers it */ }
  }
  function letSleep() { const w = state.wakeLock; state.wakeLock = null; if (w) w.release().catch(() => {}); }
  const by = () => 'driver:' + state.driverId;
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const isOpen = s => s.status === 'pending' || s.status === 'arrived';

  // ---- Stop text helpers ----
  function packageOf(order, stop) { return (order.packages || []).find(p => p.id === stop.packageId) || null; }
  function typeWord(stop) { return stop.type === 'pickup' ? 'Pickup' : stop.type === 'return' ? 'Return to sender' : 'Drop-off'; }
  function kindLine(order, stop) {
    const pkg = packageOf(order, stop);
    const parts = [typeWord(stop)];
    if (pkg) { parts.push(MDM.pricing.sizeLabel(pkg.size)); if (pkg.description) parts.push(pkg.description); }
    return parts.join(' · ');
  }
  function addressText(order, stop) {
    const pkg = packageOf(order, stop);
    if (stop.shop && pkg && pkg.shop) return pkg.shop.address ? pkg.shop.name + ', ' + pkg.shop.address : pkg.shop.name;
    return stop.address || '';
  }
  const MEET = { door: 'Meet at the door', lobby: 'Customer comes down to the lobby', reception: 'Leave at reception or security' };
  function detailLine(stop) {
    const parts = [];
    if (stop.zone) parts.push(MDM.geo.zoneLabel(stop.zone));
    if (stop.landmark) parts.push(stop.landmark);
    const cargo = stop.cargo;
    if (cargo && cargo.terminal) {
      const t = MDM.geo.terminals().find(x => x.value === cargo.terminal);
      parts.push(t ? t.label : cargo.terminal);
      if (cargo.boat) parts.push('Boat ' + cargo.boat);
      if (cargo.time) parts.push('Expected ' + cargo.time);
      if (cargo.consignee) parts.push('Consignee ' + cargo.consignee);
      if (cargo.receiptNo) parts.push('Cargo receipt ' + cargo.receiptNo);
    }
    if (stop.zone === 'airport' && stop.meetAt) { const a = MDM.geo.airportPoints().find(x => x.value === stop.meetAt); parts.push('Meeting point: ' + (a ? a.label : stop.meetAt)); }
    else if (stop.type !== 'pickup' && stop.meetAt) parts.push(MEET[stop.meetAt] || stop.meetAt);
    return parts.join(' · ');
  }
  function contactNode(stop) {
    const c = stop.contact || {};
    const links = c.phone ? MDM.ui.phone.links(c.phone) : null;
    if (!c.name && !links) return null;
    return el('div', { class: 'driver-stop__contact' }, c.name || '', c.name && links ? ' · ' : '', links ? el('a', { class: 'mono nowrap', href: links.tel }, MDM.ui.phone.format(c.phone)) : null);
  }
  function shopNode(order, stop) {
    const pkg = packageOf(order, stop);
    if (!stop.shop || !pkg || !pkg.shop) return null;
    const s = pkg.shop;
    const unavailable = { call: 'Call the customer', skip: 'Skip it', closest: 'Buy the closest match' }[s.unavailable] || s.unavailable || '';
    return el('dl', { class: 'driver-stop__shop' },
      el('dt', null, 'Shopping list'), el('dd', null, s.list || ''),
      el('dt', null, 'Budget'), el('dd', { class: 'mono' }, MDM.pricing.format(s.budget)),
      el('dt', null, 'If something is unavailable'), el('dd', null, unavailable));
  }
  function doneLabel(stop) { return stop.type === 'pickup' ? 'Picked up' : stop.type === 'return' ? 'Returned to sender' : 'Delivered'; }
  function markerType(stop) { return stop.type === 'pickup' ? 'pickup' : stop.type === 'return' ? 'return' : 'dropoff'; }

  // ---- Route list ----
  function stopCard(order, stop, n, isCurrent, active) {
    const pkg = packageOf(order, stop);
    const tags = [];
    if (stop.shop) tags.push(el('span', { class: 'tag' }, 'Shop'));
    if (pkg && pkg.fragile) tags.push(el('span', { class: 'tag' }, 'Fragile'));
    const links = stop.contact && stop.contact.phone ? MDM.ui.phone.links(stop.contact.phone) : null;
    const directions = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(stop.lat + ',' + stop.lng) + '&travelmode=driving';
    const detail = detailLine(stop);
    const primary = stop.status === 'arrived'
      ? el('button', { type: 'button', class: 'btn btn--primary btn--xl btn--block', 'data-testid': 'driver-stop-done', on: { click: e => onDone(e.currentTarget, order, stop) } }, doneLabel(stop))
      : el('button', { type: 'button', class: 'btn btn--primary btn--xl btn--block', 'data-testid': 'driver-stop-arrived', on: { click: e => onArrived(e.currentTarget, order, stop) } }, 'Arrived');
    const failed = el('button', { type: 'button', class: 'btn btn--ghost btn--block', 'data-testid': 'driver-stop-failed', on: { click: e => onFailed(e.currentTarget, order, stop) } }, "Couldn't complete");
    return el('article', { class: ['card', 'driver-stop', isCurrent && 'is-current'], 'data-testid': 'driver-stop', 'data-stop-id': stop.id, 'data-status': stop.status, 'data-order-id': order.id, 'aria-current': isCurrent ? 'true' : null },
      el('div', { class: 'card__body' },
        el('div', { class: ['stop', 'stop--' + markerType(stop), isCurrent && 'is-current'] },
          el('div', { class: 'stop__marker', 'aria-hidden': 'true' }, String(n)),
          el('div', null,
            el('div', { class: 'stop__meta' }, kindLine(order, stop), tags.length ? el('span', { class: 'driver-stop__tags' }, tags) : null),
            el('div', { class: 'driver-stop__address' }, addressText(order, stop)),
            detail ? el('div', { class: 'driver-stop__line' }, detail) : null,
            contactNode(stop),
            shopNode(order, stop))),
        el('div', { class: 'grid-2 grid-2--keep driver-stop__links' },
          links ? el('a', { class: 'btn btn--secondary btn--block', href: links.tel }, html(MDM.icon('phone', 16)), 'Call')
            : el('button', { type: 'button', class: 'btn btn--secondary btn--block', disabled: true }, html(MDM.icon('phone', 16)), 'Call'),
          el('a', { class: 'btn btn--secondary btn--block', href: directions, target: '_blank', rel: 'noopener' }, html(MDM.icon('navigation', 16)), 'Directions')),
        active ? el('div', { class: 'driver-stop__actions' }, stop.status === 'arrived' ? el('div', { class: 'driver-stop__line', 'data-testid': 'driver-stop-arrived-at' }, 'Arrived ' + MDM.ui.fmtTime(stop.arrivedAt)) : null, primary, failed) : null));
  }
  function stopRow(order, stop, n) {
    const failed = stop.status === 'failed';
    const reason = failed ? (MDM.FAIL_REASONS.find(r => r.value === stop.failReason) || { label: stop.failReason || '' }).label : '';
    return el('div', { class: ['stop', 'stop--' + markerType(stop), 'driver-stop--row', failed ? 'is-failed' : 'is-done'], 'data-testid': 'driver-stop', 'data-stop-id': stop.id, 'data-status': stop.status, 'data-order-id': order.id },
      el('div', { class: 'stop__marker' }, html(MDM.icon(failed ? 'x' : 'check', 14)), el('span', { class: 'sr-only' }, failed ? 'Not completed' : 'Done')),
      el('div', null,
        el('div', { class: 'stop__title', title: addressText(order, stop) }, n + ' · ' + typeWord(stop) + ' · ' + addressText(order, stop)),
        failed ? el('div', { class: 'stop__meta' }, "Couldn't complete: " + reason.toLowerCase() + (stop.note ? ' · ' + stop.note : '')) : null),
      el('div', { class: 'stop__aside' }, MDM.ui.fmtTime(failed ? stop.failedAt : stop.at)));
  }
  function orderBlock(order, stops, currentId, numbers) {
    const links = MDM.ui.phone.links(order.customer.phone);
    const active = order.status !== 'assigned';
    return el('div', { class: 'driver-order', 'data-testid': 'driver-order', 'data-order-id': order.id, 'data-status': order.status },
      el('div', { class: 'driver-order__head' }, el('h3', { class: 'mono' }, order.code), html(MDM.badgeFor(order.status))),
      el('p', { class: 'driver-order__customer' }, order.customer.name, links ? [' · ', el('a', { class: 'mono nowrap', href: links.tel }, MDM.ui.phone.format(order.customer.phone))] : null),
      order.status === 'assigned' ? el('button', { type: 'button', class: 'btn btn--primary btn--xl btn--block driver-order__start', 'data-testid': 'driver-start-route', 'data-order-id': order.id, on: { click: e => onStart(e.currentTarget, order) } }, 'Start route') : null,
      el('div', { class: 'driver-order__stops' }, stops.map(s => isOpen(s) ? stopCard(order, s, numbers[s.id], s.id === currentId, active) : stopRow(order, s, numbers[s.id]))));
  }
  // The current stop: where the simulation is waiting, else the stop the rider has arrived at, else the first open stop of a started order.
  function computeCurrent(route) {
    const open = route.stops.filter(isOpen);
    if (state.nearId && open.some(s => s.id === state.nearId)) return state.nearId;
    const arrived = open.find(s => s.status === 'arrived');
    if (arrived) return arrived.id;
    const started = open.find(s => s.orderStatus !== 'assigned');
    return started ? started.id : (open.length ? open[0].id : null);
  }
  function renderRoute() {
    const route = state.route;
    const prev = state.currentId;
    ui.summary.hidden = true; ui.summary.textContent = '';
    if (!state.driver) {
      ui.route.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'Choose your name to see your route.')));
      state.currentId = null; return;
    }
    if (!route.orders.length) {
      ui.route.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'No stops assigned to you today.'), el('div', { class: 'empty__hint' }, 'Stops appear here as soon as the office assigns you an order.')));
      state.currentId = null; return;
    }
    const numbers = {};
    route.stops.forEach((s, i) => { numbers[s.id] = i + 1; });   // stops are numbered across the whole route, the same on the map
    const currentId = computeCurrent(route);
    ui.route.replaceChildren(...route.orders.map(o => orderBlock(o, route.stops.filter(s => s.orderId === o.id), currentId, numbers)));
    const open = route.stops.filter(isOpen).length;
    ui.summary.textContent = plural(route.orders.length, 'order') + ' · ' + (open ? plural(open, 'stop') + ' left' : 'all stops done');
    ui.summary.hidden = false;
    state.currentId = currentId;
    if (state.focusStop) {
      const target = ui.route.querySelector('[data-stop-id="' + state.focusStop + '"] .btn--primary') || (currentId && ui.route.querySelector('[data-stop-id="' + currentId + '"] .btn--primary'));
      state.focusStop = null;
      if (target) { try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); } }
    }
    if (currentId && prev && currentId !== prev) {
      const card = ui.route.querySelector('[data-stop-id="' + currentId + '"]');
      if (card) MDM.ui.scrollIntoViewIfNeeded(card, 'start');
    }
  }

  // ---- Controls and status line ----
  function renderControls() {
    const sig = state.drivers.map(d => d.id + ':' + d.name).join('|');
    if (ui.select.dataset.sig !== sig) {
      ui.select.replaceChildren(el('option', { value: '' }, 'Choose your name'), ...state.drivers.map(d => el('option', { value: d.id }, d.name)));
      ui.select.dataset.sig = sig;
    }
    ui.select.value = state.driverId || '';
    const has = !!state.driver;
    ui.online.disabled = !has;
    const radio = ui.online.querySelector('input[value="' + (state.online ? 'online' : 'offline') + '"]');
    if (radio) radio.checked = true;
    ui.simulate.disabled = !has || !state.online;
    ui.simulate.textContent = state.sim ? 'Stop simulation' : 'Simulate route';
    ui.gps.disabled = !has || !state.online || !window.isSecureContext;
    ui.gps.textContent = state.gpsOn ? 'Stop GPS' : 'Use my GPS';
    ui.gpsNote.hidden = !!window.isSecureContext;
  }
  function statusText() {
    if (!state.driver || !state.online) return 'Location off';
    if (state.gpsOn) {
      if (state.gpsFix && state.gpsFix.accuracy > 100) return 'Weak GPS signal';
      const last = MDM.live.last(state.driverId);
      return 'Sharing location · GPS · ' + (last && last.source === 'gps' ? MDM.ui.timeAgo(last.at, { seconds: true }) : 'waiting for a fix');
    }
    if (state.sim) return 'Sharing location · Demo route';
    return 'Location off';
  }
  function renderStatus() { const t = statusText(); if (ui.status.textContent !== t) ui.status.textContent = t; }
  function hideGpsAlert() { ui.gpsAlert.hidden = true; ui.gpsAlert.replaceChildren(); }
  function showGpsError(err) {
    const code = err && err.code;
    const msg = code === 1 ? 'Location permission is off. Allow location for this site in your browser settings, or use Simulate route for the demo.'
      : code === 'insecure' ? 'Location sharing needs an https address (it works on the published site).'
      : code === 'unsupported' ? 'This browser cannot share location. Use Simulate route for the demo.'
      : 'Could not get a location fix. Try again outdoors.';
    ui.gpsAlert.replaceChildren(el('div', { class: 'alert alert--danger', role: 'alert' }, html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' }, msg)));
    ui.gpsAlert.hidden = false;
  }

  // ---- Map: route line, numbered stop markers, own position ----
  function showMapFallback() {
    ui.mapEl.appendChild(el('div', { class: 'map__fallback' }, el('div', { class: 'alert alert--warn', role: 'status' }, html(MDM.icon('alert-triangle', 16)),
      el('div', { class: 'alert__body' }, 'Map unavailable right now. Stops and status are still updated below.'))));
  }
  function ensureMap() {
    if (map.ready) return map.ready;
    const create = MDM.map.available() ? MDM.map.create(ui.mapEl, { interactive: true }) : Promise.reject(new Error('map_unavailable'));
    map.ready = create.then(m => { map.map = m; ui.recenter.hidden = false; return m; }).catch(() => { showMapFallback(); return null; });
    return map.ready;
  }
  function placeDriver(pos) {
    if (!map.map) return;
    if (!pos || !state.driver) { if (map.driver) { map.driver.remove(); map.driver = null; } return; }
    if (map.driver && map.driver.driverId === state.driverId) { map.driver.moveTo(pos, 1000); return; }
    if (map.driver) map.driver.remove();
    map.driver = MDM.map.driverMarker(map.map, pos, state.driver);
    map.driver.driverId = state.driverId;
  }
  function fitMap() {
    if (!map.map) return;
    const pts = state.route.polyline.slice().concat(state.route.stops.map(s => [s.lat, s.lng]));
    if (map.driver) { const p = map.driver.position(); pts.push([p.lat, p.lng]); }
    MDM.map.fit(map.map, pts, { padding: { top: 44, right: 56, bottom: 60, left: 36 }, maxZoom: 15 });   // room for the marker label and the attribution
  }
  function watchPositions() {
    if (map.posUnsub) { map.posUnsub(); map.posUnsub = null; }
    if (!state.driverId) return;
    map.posUnsub = MDM.live.onPosition(state.driverId, p => { placeDriver(p); if (state.gpsOn) renderStatus(); });
  }
  async function syncMap() {
    const m = await ensureMap();
    if (!m) return;
    const line = state.route.polyline.length >= 2 ? state.route.polyline : [];
    const stops = state.route.stops.map((s, i) => Object.assign({}, s, { label: String(i + 1) }));
    if (!map.route) map.route = MDM.map.route(m, 'driver-route', line); else map.route.update(line);
    if (!map.stops) map.stops = MDM.map.stopMarkers(m, stops); else map.stops.update(stops);
    const pos = state.driverId ? (MDM.live.last(state.driverId) || await MDM.store.get('positions', state.driverId)) : null;
    placeDriver(pos);
    if (!map.fitted) { fitMap(); map.fitted = true; }
  }

  // ---- Location sharing: simulation and GPS ----
  function stopSim() { if (state.sim) { state.sim.stop(); state.sim = null; } state.nearId = null; }
  function stopGps() { if (state.gpsOn) MDM.live.stopGPS(); state.gpsOn = false; state.gpsFix = null; }
  function resumeSimAt(stopId) {
    const s = state.sim && state.sim.state;
    if (s && s.atStop && s.stop && s.stop.id === stopId) { state.nearId = null; state.sim.resume(); }
  }
  function onSimStop(stop) {
    const cur = state.route.stops.find(s => s.id === stop.id);
    // A stop the rider already completed before the simulated bike got there: drive on without waiting.
    if (!cur || !isOpen(cur)) { setTimeout(() => { if (state.sim) state.sim.resume(); }, 0); return; }
    const order = state.route.orders.find(o => o.id === cur.orderId);
    state.nearId = cur.id;
    MDM.ui.toast('Arrived near ' + (order ? addressText(order, cur) : cur.address), 'info');
    renderRoute();
  }
  function onSimEnd() { state.sim = null; state.nearId = null; renderControls(); renderStatus(); MDM.ui.toast('Route simulation finished', 'neutral'); }
  async function toggleSimulate() {
    if (state.sim) { stopSim(); renderControls(); renderStatus(); return; }
    const route = await MDM.store.driverRoute(state.driverId);
    if (route.polyline.length < 2) { MDM.ui.toast('No route to simulate yet. Stops appear once the office assigns you an order.', 'warn'); return; }
    stopGps(); hideGpsAlert();
    const opts = { stops: route.stops.filter(isOpen), autoStops: false, onStop: onSimStop, onEnd: onSimEnd };
    if (state.speed) opts.timeScale = state.speed;   // otherwise live.js reads localStorage mdm:timeScale
    try { state.sim = MDM.live.simulate(state.driverId, route.polyline, opts); }
    catch (e) { MDM.ui.toast(e.message || 'Could not start the simulation', 'danger'); }
    renderControls(); renderStatus();
  }
  function toggleGps() {
    if (state.gpsOn) { stopGps(); hideGpsAlert(); renderControls(); renderStatus(); return; }
    hideGpsAlert(); stopSim();
    state.gpsOn = true; state.gpsFix = null;
    // watchGPS calls navigator.geolocation.watchPosition synchronously here, so the permission prompt is tied to this tap.
    MDM.live.watchGPS(state.driverId, {
      onFix: f => { state.gpsFix = f; renderStatus(); },
      onError: err => { if (!err || err.code === 1 || MDM.live.gpsState() !== 'on') stopGps(); showGpsError(err); renderControls(); renderStatus(); },
    }).catch(err => { if (MDM.live.gpsState() !== 'on') stopGps(); showGpsError(err); renderControls(); renderStatus(); });
    renderControls(); renderStatus();
  }

  // ---- Stop actions ----
  function storeErrorMessage(e, fallback) {
    if (e && e.code === 'quota') return 'This browser is out of storage space for the demo. Reset demo data from the admin or use a smaller file.';
    if (e && (e.message === 'image_decode' || e.message === 'image_encode')) return 'Could not read that photo. Try another one.';
    return (e && e.message) || fallback;
  }
  async function storePhoto(file, kind, orderId) {
    const img = await MDM.ui.imageToJpeg(file, { maxEdge: 800, quality: 0.8 });
    const doc = await MDM.store.insert('files', { kind, orderId, name: file.name || kind + '.jpg', type: img.type, size: img.size, dataUrl: img.dataUrl, at: new Date().toISOString() });
    return doc.id;
  }
  async function onStart(btn, order) {
    btn.disabled = true;
    try { await MDM.store.startRoute(order.id, { by: by() }); MDM.ui.toast('Route started for ' + order.code, 'ok'); }
    catch (e) { btn.disabled = false; MDM.ui.toast(storeErrorMessage(e, 'Could not start the route'), 'danger'); }
  }
  async function onArrived(btn, order, stop) {
    btn.disabled = true; state.focusStop = stop.id;
    try { await MDM.store.setStop(order.id, stop.id, { status: 'arrived', by: by() }); }
    catch (e) { btn.disabled = false; MDM.ui.toast(storeErrorMessage(e, 'Could not update the stop'), 'danger'); }
  }
  function shopDialog(order, stop) {
    const pkg = packageOf(order, stop);
    const budget = pkg && pkg.shop ? pkg.shop.budget : null;
    return MDM.ui.dialog({ title: 'Shopping done', message: 'Enter the receipt total and take a photo of the receipt.',
      fields: [
        { name: 'receiptTotal', label: 'Receipt total (MVR)', type: 'number', required: true, min: 0, step: 1, inputmode: 'decimal', hint: budget != null ? 'Budget ' + MDM.pricing.format(budget) : null, requiredMessage: 'Enter the receipt total' },
        { name: 'receiptPhoto', label: 'Receipt photo', type: 'file', required: true, accept: 'image/*', capture: 'environment', buttonLabel: 'Take a photo', requiredMessage: 'Take a photo of the receipt' },
      ],
      okLabel: 'Confirm pickup' });
  }
  function deliveryDialog(stop) {
    const isReturn = stop.type === 'return';
    const nameField = { name: 'recipientName', label: 'Name', type: 'text', required: true, autocomplete: 'name', hint: 'Who received it. Not needed when left as instructed.', requiredMessage: 'Enter who received it' };
    const p = MDM.ui.dialog({ title: isReturn ? 'Returned to sender' : 'Delivered',
      fields: [
        { name: 'handedTo', label: 'Handed to', type: 'segmented', required: true, value: 'recipient', options: MDM.HANDED_TO },
        nameField,
        { name: 'photo', label: 'Photo', type: 'file', required: false, accept: 'image/*', capture: 'environment', buttonLabel: 'Take a photo', hint: 'Skip the photo if the customer would rather not.' },
      ],
      okLabel: isReturn ? 'Confirm return' : 'Confirm delivery' });
    // dialog() reads each field's `required` flag at submit time, so the name becomes optional the moment "Left as instructed" is picked.
    const seg = document.querySelector('dialog[open] [data-testid="dialog-handedTo"]');
    if (seg) {
      seg.classList.add('segmented--stack');
      seg.addEventListener('change', () => { const c = seg.querySelector('input:checked'); nameField.required = !(c && c.value === 'left'); });
    }
    return p;
  }
  function failDialog() {
    return MDM.ui.dialog({ title: "Couldn't complete this stop", message: 'The order goes on hold and the office follows up with the customer.',
      fields: [
        { name: 'failReason', label: 'Reason', type: 'select', required: true, placeholder: 'Choose a reason', options: MDM.FAIL_REASONS, requiredMessage: 'Choose a reason' },
        { name: 'note', label: 'Note', type: 'textarea', required: false, rows: 3, hint: 'What you tried, for example called twice' },
      ],
      okLabel: 'Mark as not completed', danger: true });
  }
  async function onDone(btn, order, stop) {
    let patch = { status: 'done', by: by() };
    if (stop.type === 'pickup' && stop.shop) {
      const v = await shopDialog(order, stop);
      if (!v) return;
      btn.disabled = true;
      try { patch.receiptTotal = v.receiptTotal; patch.receiptPhotoId = await storePhoto(v.receiptPhoto, 'receipt', order.id); }
      catch (e) { btn.disabled = false; MDM.ui.toast(storeErrorMessage(e, 'Could not save the receipt'), 'danger'); return; }
    } else if (stop.type !== 'pickup') {
      const v = await deliveryDialog(stop);
      if (!v) return;
      btn.disabled = true;
      patch.handedTo = v.handedTo; patch.recipientName = v.recipientName || '';
      if (v.photo) {
        try { patch.photoId = await storePhoto(v.photo, 'proof', order.id); }
        catch (e) { btn.disabled = false; MDM.ui.toast(storeErrorMessage(e, 'Could not save the photo'), 'danger'); return; }
      }
    } else btn.disabled = true;
    state.focusStop = stop.id;
    try {
      const o = await MDM.store.setStop(order.id, stop.id, patch);
      resumeSimAt(stop.id);
      if (o.status === 'delivered') MDM.ui.toast(o.code + ' delivered', 'ok');
      else if (o.status === 'returned') MDM.ui.toast(o.code + ' returned to sender', 'ok');
    } catch (e) { btn.disabled = false; MDM.ui.toast(storeErrorMessage(e, 'Could not update the stop'), 'danger'); }
  }
  async function onFailed(btn, order, stop) {
    const v = await failDialog();
    if (!v) return;
    btn.disabled = true; state.focusStop = stop.id;
    try {
      const o = await MDM.store.setStop(order.id, stop.id, { status: 'failed', failReason: v.failReason, note: v.note || '', by: by() });
      resumeSimAt(stop.id);
      MDM.ui.toast(o.code + ' is on hold. The office will follow up with the customer.', 'warn');
    } catch (e) { btn.disabled = false; MDM.ui.toast(storeErrorMessage(e, 'Could not update the stop'), 'danger'); }
  }

  // ---- Online state and rider choice ----
  async function setOnline(v) {
    if (v) keepAwake(); else { letSleep(); stopSim(); stopGps(); hideGpsAlert(); }
    state.online = v; writeSession();
    renderControls(); renderStatus();
    try {
      const d = await MDM.store.get('drivers', state.driverId);
      // A rider already on a route stays on_route; only offline → online and anything → offline are written.
      if (d && (v ? d.status === 'offline' : d.status !== 'offline')) await MDM.store.update('drivers', state.driverId, { status: v ? 'online' : 'offline' });
    } catch (e) { MDM.ui.toast(storeErrorMessage(e, 'Could not change your status'), 'danger'); }
  }
  async function selectDriver(id) {
    if ((id || null) === state.driverId) return;
    stopSim(); stopGps(); hideGpsAlert(); letSleep();
    state.driverId = id || null; state.driver = null; state.online = false; state.currentId = null; state.nearId = null;
    map.fitted = false;
    writeSession();
    watchPositions();
    await render();
  }

  // ---- Render ----
  async function render() {
    const seq = ++state.renderSeq;
    const drivers = await MDM.store.list('drivers', { order: 'createdAt' });
    const driver = state.driverId ? drivers.find(d => d.id === state.driverId) || null : null;
    const route = driver ? await MDM.store.driverRoute(driver.id) : { orders: [], stops: [], polyline: [] };
    if (seq !== state.renderSeq) return;
    state.drivers = drivers; state.driver = driver; state.route = route;
    if (!driver && state.driverId) { state.driverId = null; state.currentId = null; writeSession(); watchPositions(); }   // rider removed or demo reset
    const wasOnline = state.online;
    state.online = !!driver && driver.status !== 'offline';
    if (state.online !== wasOnline) { writeSession(); if (state.online) keepAwake(); else { letSleep(); stopSim(); stopGps(); } }
    renderControls(); renderStatus(); renderRoute();
    await syncMap();
  }
  let queued = false;
  function requestRender() {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; render().catch(e => { setTimeout(() => { throw e; }, 0); }); });
  }

  async function main() {
    await MDM.store.ready;
    state.speed = speedParam();
    const sess = readSession();
    state.driverId = typeof sess.driverId === 'string' && sess.driverId ? sess.driverId : null;
    ui.select.addEventListener('change', () => { selectDriver(ui.select.value).catch(e => { setTimeout(() => { throw e; }, 0); }); });
    ui.online.addEventListener('change', e => { if (e.target && e.target.name === 'online') setOnline(e.target.value === 'online'); });
    ui.simulate.addEventListener('click', () => { toggleSimulate().catch(e => { MDM.ui.toast(storeErrorMessage(e, 'Could not start the simulation'), 'danger'); }); });
    ui.gps.addEventListener('click', toggleGps);
    ui.recenter.addEventListener('click', fitMap);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.online) keepAwake(); });
    MDM.store.subscribe('*', msg => { if (msg && (msg.op === 'reset' || msg.op === 'refresh' || msg.collection === 'orders' || msg.collection === 'drivers')) requestRender(); });
    setInterval(renderStatus, 1000);   // keeps "12 s ago" honest while GPS is on; text only, no data reads
    watchPositions();
    await render();
  }
  main();
})(window.MDM);

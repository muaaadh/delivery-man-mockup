// Driver console (client requirements §2 driver, §10, §13, §14, §22; How it works §2, §5, §10, §11).
// One phone-first column: duty (punch in/out, online, location sharing, leave), then the driver's own jobs in priority order with the
// step-by-step flow Start → Arrived for collection → Collected (proof photo, size) → Out for delivery → Delivered (proof), a failed
// report at any step, and the route map last. Every write goes through MDM.store; render() rebuilds from the store whenever orders,
// drivers, attendance or leave change, in this tab or another.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const SESSION_KEY = 'mdm:driver';
  const q = sel => document.querySelector(sel);
  const ACTIVE = ['dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery'];

  const ui = {
    pick: q('[data-testid="driver-pick"]'), select: q('[data-testid="driver-select"]'),
    duty: q('[data-testid="driver-duty"]'), name: q('[data-testid="driver-name"]'), dutyStatus: q('[data-testid="driver-duty-status"]'),
    punch: q('[data-testid="driver-punch"]'), zones: q('[data-testid="driver-zones"]'),
    online: q('[data-testid="driver-online"]'), status: q('[data-testid="driver-status"]'),
    simulate: q('[data-testid="driver-simulate"]'), gps: q('[data-testid="driver-gps"]'),
    gpsNote: q('[data-testid="driver-gps-note"]'), gpsAlert: q('[data-testid="driver-gps-alert"]'),
    leaveBtn: q('[data-testid="driver-leave-request"]'), leave: q('[data-testid="driver-leave"]'),
    signedIn: q('[data-testid="driver-signed-in"]'), switchBtn: q('[data-testid="driver-switch"]'),
    jobsSection: q('[data-testid="driver-jobs-section"]'), jobs: q('#driver-jobs'), summary: q('[data-testid="driver-route-summary"]'),
    mapSection: q('[data-testid="driver-map-section"]'), mapEl: q('#driver-map'), recenter: q('[data-testid="driver-recenter"]'),
  };

  const state = {
    driverId: null, driver: null, drivers: [], staff: null, settings: {},
    route: { orders: [], stops: [], polyline: [] }, upcoming: [], doneToday: [], zoneQueue: [], batches: {},
    shift: null, today: [], leaves: [],
    online: false, sim: null, gpsOn: false, gpsFix: null, nearId: null, focusOrder: null,
    wakeLock: null, speed: null, renderSeq: 0,
  };
  const map = { map: null, ready: null, route: null, stops: null, driver: null, posUnsub: null, fitted: false };

  // ---- Session, wake lock, time scale ---------------------------------------------------------------------------------------
  function readSession() { try { const v = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }
  function writeSession() { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ driverId: state.driverId, online: state.online })); } catch (e) { /* storage blocked */ } }
  function speedParam() { const v = parseFloat(new URLSearchParams(location.search).get('speed')); return v > 0 ? v : null; }
  async function keepAwake() {
    if (!('wakeLock' in navigator) || state.wakeLock || document.visibilityState !== 'visible') return;
    try { const w = await navigator.wakeLock.request('screen'); state.wakeLock = w; w.addEventListener('release', () => { if (state.wakeLock === w) state.wakeLock = null; }); }
    catch (e) { /* refused (battery saver, hidden tab): the note under the status line covers it */ }
  }
  function letSleep() { const w = state.wakeLock; state.wakeLock = null; if (w) w.release().catch(() => {}); }
  const by = () => 'driver:' + state.driverId;
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const isOpen = s => s.status === 'pending' || s.status === 'arrived';
  const icon = (name, size) => html(MDM.icon(name, size || 16));
  function errMsg(e, fallback) {
    if (e && e.code === 'quota') return 'This browser is out of storage space for the demo. Reset demo data from the admin or use a smaller photo.';
    if (e && (e.message === 'image_decode' || e.message === 'image_encode')) return 'Could not read that photo. Try another one.';
    return (e && e.message) || fallback;
  }
  const fail = (e, fallback) => MDM.ui.toast(errMsg(e, fallback), 'danger');

  // ---- Order and stop text ----------------------------------------------------------------------------------------------------
  const optLabel = (list, v) => ((list || []).find(x => x.value === v) || {}).label || v || '';
  const sizeName = s => MDM.pricing.sizeLabel(s);
  function dimsText(d) { return d && d.l ? [d.l, d.w, d.h].map(n => Number(n)).join(' × ') + ' cm' : ''; }
  function parseDims(str) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(cm)?\s*$/i.exec(String(str || ''));
    return m ? { l: Number(m[1]), w: Number(m[2]), h: Number(m[3]) } : null;
  }
  function packagesLine(o) {
    const n = {}; (o.packages || []).forEach(p => { n[p.size] = (n[p.size] || 0) + 1; });
    return Object.keys(n).map(k => n[k] + ' × ' + sizeName(k)).join(', ');
  }
  function priorityOf(o) {
    const p = o.priority || {};
    if (p.status === 'approved') return { rank: p.level === 'urgent' ? 0 : 1, label: optLabel(MDM.PRIORITY_LEVELS, p.level) || 'Priority' };
    if (o.serviceLevel === 'express') return { rank: 2, label: 'Express' };
    return { rank: 9, label: '' };
  }
  function sortJobs(list) {
    return list.slice().sort((a, b) => priorityOf(a).rank - priorityOf(b).rank || (a.createdAt < b.createdAt ? -1 : 1));
  }
  function scheduleLine(o) {
    const s = o.schedule || {};
    const parts = [];
    if (s.type === 'advance') {
      if (s.collectDate) parts.push('Collect ' + MDM.ui.fmtDate(s.collectDate + 'T00:00', { time: false }) + (s.collectTime ? ' at ' + s.collectTime : ''));
      if (s.deliverDate) parts.push('deliver by ' + (s.deliverDate !== s.collectDate ? MDM.ui.fmtDate(s.deliverDate + 'T00:00', { time: false }) + ' ' : '') + (s.deliverTime || ''));
    } else if (s.type === 'slot' && s.date) parts.push('Slot ' + MDM.ui.fmtDate(s.date + 'T00:00', { time: false }) + (s.window ? ' ' + s.window : ''));
    if (s.rescheduledFor) parts.push('Rescheduled for ' + s.rescheduledFor);
    return parts.join(', ');
  }
  // The stop the driver is working on: the first open collection, then the first open delivery (or return).
  function currentStop(o) {
    const stops = (o.route && o.route.stops) || [];
    return stops.find(s => s.type === 'pickup' && isOpen(s)) || stops.find(s => s.type !== 'pickup' && isOpen(s)) || null;
  }
  // phase(o) → { key, label } for the one primary action of the card.
  function phase(o) {
    const s = currentStop(o);
    if (o.status === 'assigned') return { key: 'upcoming' };
    if (o.status === 'failed') return { key: 'waiting' };
    if (o.status === 'dispatched') return { key: 'start', label: 'Start' };
    if ((o.status === 'on_the_way' || o.status === 'arrived') && s && s.type === 'pickup') return s.status === 'arrived' ? { key: 'collect', label: s.shop ? 'Shopping done' : 'Collected', stop: s } : { key: 'arrive', label: 'Arrived for collection', stop: s };
    if (o.status === 'collected') return { key: 'out', label: 'Out for delivery' };
    if (o.status === 'out_for_delivery' && s) return s.type === 'return' ? { key: 'return', label: 'Returned to sender', stop: s } : { key: 'deliver', label: 'Delivered', stop: s };
    return { key: 'none' };
  }
  const STEPS = ['Start', 'Arrived', 'Collected', 'Out for delivery', 'Delivered'];
  const STEP_AT = { dispatched: 0, on_the_way: 1, arrived: 2, collected: 3, out_for_delivery: 4, delivered: 5 };
  // The bar marks done steps and the next one; a failed job keeps the progress it had and marks the step that went wrong.
  function stepsNode(o) {
    const failed = o.status === 'failed';
    const before = failed ? ((o.statusHistory || []).slice().reverse().find(h => h.to === 'failed') || {}).from : o.status;
    const at = STEP_AT[before] != null ? STEP_AT[before] : -1;
    return el('ol', { class: 'job__steps', 'aria-label': 'Progress' }, STEPS.map((t, i) =>
      el('li', { class: ['job__step', i < at && 'is-done', i === at && (failed ? 'is-failed' : 'is-current')], 'aria-current': i === at ? 'step' : null }, el('span', { class: 'job__dot', 'aria-hidden': 'true' }), el('span', { class: 'job__steptext' }, t))));
  }
  const MEET = { door: 'Meet at the door', lobby: 'Customer comes down to the lobby', reception: 'Leave at reception or security' };
  function placeLine(stop) {
    const parts = [];
    if (stop.zone) parts.push(MDM.geo.zoneLabel(stop.zone));
    if (stop.landmark) parts.push(stop.landmark);
    const cargo = stop.cargo;
    if (cargo && cargo.terminal) {
      const t = MDM.geo.terminals().find(x => x.value === cargo.terminal);
      parts.push(t ? t.label : cargo.terminal);
      if (cargo.boat) parts.push('Boat ' + cargo.boat);
      if (cargo.time) parts.push((stop.type === 'pickup' ? 'Expected ' : 'Leaves ') + cargo.time);
      if (cargo.consignee) parts.push('Consignee ' + cargo.consignee);
    }
    if (stop.zone === 'airport' && stop.meetAt) { const a = MDM.geo.airportPoints().find(x => x.value === stop.meetAt); parts.push('Meeting point: ' + (a ? a.label : stop.meetAt)); }
    else if (stop.type !== 'pickup' && stop.meetAt && !(cargo && cargo.terminal)) parts.push(MEET[stop.meetAt] || stop.meetAt);
    return parts.join(' · ');
  }
  function addressText(o, stop) {
    const pkg = (o.packages || []).find(p => p.id === stop.packageId);
    if (stop.shop && pkg && pkg.shop) return pkg.shop.address ? pkg.shop.name + ', ' + pkg.shop.address : pkg.shop.name;
    return stop.address || '';
  }
  function contactRow(name, phone, testid) {
    const links = phone ? MDM.ui.phone.links(phone, null) : null;
    if (!name && !links) return null;
    return el('div', { class: 'job__contact' },
      el('div', { class: 'job__person' }, el('span', null, name || ''), links ? el('span', { class: 'mono job__phone' }, MDM.ui.phone.format(phone)) : null),
      links ? el('div', { class: 'job__contact-btns' },
        el('a', { class: 'btn btn--secondary btn--icon job__iconbtn', href: links.tel, 'aria-label': 'Call ' + (name || 'contact'), 'data-testid': testid + '-call' }, icon('phone', 18)),
        el('a', { class: 'btn btn--secondary job__wa', href: links.wa, target: '_blank', rel: 'noopener', 'aria-label': 'WhatsApp ' + (name || 'contact'), 'data-testid': testid + '-whatsapp' }, 'WhatsApp')) : null);
  }
  // Request-type details the driver needs on the spot (client requirements §5, §6): collection codes, flights, office tasks.
  function detailRows(o) {
    const d = o.details || {}, rows = [];
    const add = (k, v, cls) => { if (v != null && v !== '') rows.push([k, v, cls]); };
    if (o.requestType === 'postal') {
      add('Carrier', optLabel(MDM.CARRIERS, d.carrier));
      add('Pikpost location', d.location ? optLabel(MDM.PIKPOST_LOCATIONS, d.location) : '');
      add('Post office', d.postOffice ? optLabel(MDM.POST_OFFICES, d.postOffice) : '');
      add('Collection code', d.collectionCode, 'job__code');
      add('Collect before', d.collectBefore);
      add('Tracking number', d.trackingNo, 'mono');
      add('Owner', [d.ownerName, d.ownerContact ? MDM.ui.phone.format(d.ownerContact) : ''].filter(Boolean).join(' · '));
      add('Shipping address', d.shippingAddress);
      add('Note', d.idNote || d.smsNote);
    } else if (o.requestType === 'airport') {
      add('Service', optLabel(MDM.AIRPORT_MODES, d.mode));
      add('Airport area', d.area ? ((MDM.geo.airportPoints().find(x => x.value === d.area) || {}).label || d.area) : '');
      add('Flight', [d.flight, d.flightTime].filter(Boolean).join(' at '));
      add('Passenger', [d.passengerName, d.passengerPhone ? MDM.ui.phone.format(d.passengerPhone) : ''].filter(Boolean).join(' · '));
      add('Bags', d.bags);
    } else if (o.requestType === 'office') {
      add('Task', optLabel(MDM.OFFICE_TASKS, d.task));
      add('Office', d.organisation);
      add('Reference', d.reference, 'mono');
      add('What to do', d.details);
      if (d.returnDocs) add('Bring back', 'The stamped receipt or documents');
    } else if (o.requestType === 'shop_collect') {
      add('Shop', d.shopName);
      add('Proof', { invoice: 'Invoice', quotation: 'Quotation and payment slip', order_no: 'Order number' }[d.proof] || d.proof);
      add('Order number', d.orderNo, 'mono');
      if (d.paidByCustomer) add('Payment', 'Already paid by the customer');
    } else if (o.requestType === 'bulk') {
      const b = state.batches[o.batchId];
      add('Bulk order', b ? b.code + ' · package ' + o.batchIndex + ' of ' + (b.orderIds || []).length : '');
      add('Reference', d.reference, 'mono');
    } else if (o.requestType === 'store' && o.items) {
      add('Items', o.items.map(i => i.qty + ' × ' + i.name).join(', '));
    }
    add('When', scheduleLine(o));
    return rows;
  }
  function shopRows(o, stop) {
    const pkg = (o.packages || []).find(p => p.id === stop.packageId);
    if (!stop.shop || !pkg || !pkg.shop) return [];
    const s = pkg.shop;
    return [['Shopping list', s.list || ''], ['Budget', MDM.pricing.format(s.budget), 'mono'], ['If unavailable', { call: 'Call the customer', skip: 'Skip it', closest: 'Buy the closest match' }[s.unavailable] || s.unavailable || '']];
  }
  function dl(rows) {
    if (!rows.length) return null;
    return el('dl', { class: 'job__dl' }, rows.map(r => [el('dt', null, r[0]), el('dd', { class: r[2] || null }, String(r[1]))]));
  }

  // ---- Job cards ----------------------------------------------------------------------------------------------------------------
  function stopBlock(o, stop, title, testid) {
    const isPickup = stop.type === 'pickup';
    const c = stop.contact || {};
    // A place with no phone of its own (a Pikpost locker, a shop) shows its name, then the customer to call instead.
    const name = c.name || (isPickup ? o.collection && o.collection.contactName : o.delivery && o.delivery.recipientName) || '';
    const phone = c.name ? (c.phone || '') : (isPickup ? o.collection && o.collection.contactPhone : o.delivery && o.delivery.recipientPhone) || '';
    const cust = o.customer || {};
    const fallback = !phone && cust.phone ? contactRow('Customer: ' + (cust.name || ''), cust.phone, testid + '-customer') : null;
    const note = stop.instructions || (isPickup ? o.collection && o.collection.instructions : o.delivery && o.delivery.instructions) || '';
    const place = placeLine(stop);
    return el('div', { class: ['job__stop', stop.status === 'done' && 'is-done', state.nearId === stop.id && 'is-near'], 'data-testid': testid, 'data-stop-id': stop.id, 'data-stop-status': stop.status },
      el('div', { class: 'job__label' }, title, stop.status === 'done' ? el('span', { class: 'job__ok' }, icon('check', 14), ' Done ' + MDM.ui.fmtTime(stop.at)) : stop.status === 'failed' ? el('span', { class: 'job__bad' }, 'Problem reported') : state.nearId === stop.id ? el('span', { class: 'job__near' }, 'You are here') : null),
      el('div', { class: 'job__address' }, addressText(o, stop)),
      place ? el('div', { class: 'job__line' }, place) : null,
      phone ? contactRow(name, phone, testid) : (name ? el('div', { class: 'job__line' }, name) : null),
      fallback,
      note ? el('div', { class: 'job__note' }, icon('info', 14), el('span', null, note)) : null,
      isPickup ? dl(shopRows(o, stop)) : null);
  }
  function filesRow(o) {
    const items = [];
    (o.documents || []).forEach(d => items.push({ id: d.fileId, label: d.name || 'Document' }));
    (o.packages || []).forEach((p, i) => { if (p.photoId && p.photoSource !== 'driver') items.push({ id: p.photoId, label: 'Package photo' + ((o.packages || []).length > 1 ? ' ' + (i + 1) : '') }); });
    if (!items.length) return null;
    return el('div', { class: 'job__files' }, items.map(it => el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'driver-file', on: { click: () => viewFile(it.id, it.label) } }, icon('file', 16), it.label)));
  }
  function packagesBlock(o) {
    return el('div', { class: 'job__pkgs' },
      el('div', { class: 'job__label' }, 'Packages', el('span', { class: 'job__count' }, packagesLine(o))),
      el('ul', { class: 'job__pkglist' }, (o.packages || []).map(p => el('li', null,
        el('span', { class: 'job__pkgsize' }, sizeName(p.size)),
        el('span', { class: 'job__pkgtext' }, [p.description, dimsText(p.dims), p.weightKg ? p.weightKg + ' kg' : '', p.fragile ? 'Fragile' : '', p.needsVehicle ? 'Needs a vehicle' : ''].filter(Boolean).join(' · ') || 'No description')))),
      filesRow(o));
  }
  function directionsHref(stop) { return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(Number(stop.lat).toFixed(5) + ',' + Number(stop.lng).toFixed(5)) + '&travelmode=driving'; }
  function officeAlert(o) {
    const stop = (o.route.stops || []).find(s => s.status === 'failed');
    const reason = stop ? optLabel(MDM.FAIL_REASONS, stop.failReason) : '';
    const phone = (state.settings.contact || {}).phone;
    const links = phone ? MDM.ui.phone.links(phone) : null;
    return el('div', { class: 'alert alert--warn job__alert', role: 'status', 'data-testid': 'driver-waiting' }, icon('clock', 16),
      el('div', { class: 'alert__body' }, el('strong', null, 'Waiting for the office. '), (reason ? reason + '. ' : '') + 'They will reschedule, reassign, return or contact the customer.',
        links ? el('div', { class: 'job__alert-link' }, el('a', { href: links.tel }, 'Call the office')) : null));
  }
  function jobCard(o) {
    const ph = phase(o);
    const pri = priorityOf(o);
    const stops = (o.route && o.route.stops) || [];
    const pickups = stops.filter(s => s.type === 'pickup'), drops = stops.filter(s => s.type !== 'pickup');
    const cur = currentStop(o);
    const showPick = pickups.find(s => cur && s.id === cur.id) || pickups.find(isOpen) || pickups[pickups.length - 1];
    const showDrop = drops.find(s => cur && s.id === cur.id) || drops.find(isOpen) || drops[drops.length - 1];
    const tags = [];
    if (pri.label) tags.push(el('span', { class: 'tag tag--hot', 'data-testid': 'driver-priority' }, pri.label));
    if ((o.packages || []).some(p => p.fragile)) tags.push(el('span', { class: 'tag' }, 'Fragile'));
    const meta = [MDM.requestTypeLabel(o.requestType), o.customer && o.customer.name].filter(Boolean).join(' · ');
    const target = (ph.stop || cur || showDrop || showPick);
    const primary = ph.label ? el('button', { type: 'button', class: 'btn btn--primary btn--xl btn--block', 'data-testid': 'driver-action', 'data-action': ph.key, on: { click: e => act(e.currentTarget, o, ph) } }, ph.label) : null;
    const canFail = ACTIVE.indexOf(o.status) >= 0 && cur;
    return el('article', { class: ['card', 'job', pri.rank < 9 && 'is-priority', state.focusOrder === o.id && 'is-focus'], 'data-testid': 'driver-job', 'data-order-id': o.id, 'data-code': o.code, 'data-status': o.status },
      el('div', { class: 'card__body job__top' },
        el('div', { class: 'job__head' }, el('h3', { class: 'mono job__code' }, o.code), html(MDM.badgeFor(o.status))),
        tags.length ? el('div', { class: 'job__tags' }, tags) : null,
        el('div', { class: 'job__meta' }, meta),
        stepsNode(o)),
      el('div', { class: 'card__body job__body' },
        pickups.length > 1 ? el('div', { class: 'job__multi' }, pickups.every(s => s.status === 'done') ? 'All ' + pickups.length + ' collections done, showing the last' : 'Collection ' + (pickups.indexOf(showPick) + 1) + ' of ' + pickups.length) : null,
        showPick ? stopBlock(o, showPick, 'Collect from', 'driver-pickup') : null,
        drops.length > 1 ? el('div', { class: 'job__multi' }, 'Delivery ' + (drops.indexOf(showDrop) + 1) + ' of ' + drops.length) : null,
        showDrop ? stopBlock(o, showDrop, showDrop.type === 'return' ? 'Return to' : 'Deliver to', 'driver-drop') : null),
      el('div', { class: 'card__body job__body' },
        packagesBlock(o),
        dl(detailRows(o))),
      el('div', { class: 'card__body job__actions' },
        o.status === 'failed' ? officeAlert(o) : null,
        primary,
        el('div', { class: 'job__links' },
          target ? el('a', { class: 'btn btn--secondary', href: directionsHref(target), target: '_blank', rel: 'noopener', 'data-testid': 'driver-directions' }, icon('navigation', 16), 'Directions') : null,
          el('a', { class: 'btn btn--secondary', href: MDM.href('labels/?order=' + encodeURIComponent(o.id)), 'data-testid': 'driver-label' }, icon('printer', 16), 'Label'),
          canFail ? el('button', { type: 'button', class: 'btn btn--ghost job__problem', 'data-testid': 'driver-problem', on: { click: e => onFailed(e.currentTarget, o, cur) } }, icon('flag', 16), 'Report a problem') : null)));
  }
  function compactRow(o, aside, testid) {
    const pri = priorityOf(o);
    return el('li', { class: 'list__item job__row', 'data-testid': testid, 'data-order-id': o.id, 'data-code': o.code },
      el('div', { class: 'list__main' },
        el('div', { class: 'list__title' }, el('span', { class: 'mono' }, o.code), ' · ', MDM.requestTypeLabel(o.requestType), pri.label ? [' ', el('span', { class: 'tag tag--hot' }, pri.label)] : null),
        el('div', { class: 'list__meta' }, (o.collection ? MDM.geo.zoneShort(o.collection.zone) : '') + ' to ' + (o.delivery ? MDM.geo.zoneShort(o.delivery.zone) : '') + ' · ' + packagesLine(o))),
      el('div', { class: 'list__aside' }, aside));
  }
  function group(title, desc, body, testid) {
    return el('div', { class: 'jobs-group', 'data-testid': testid }, el('h3', { class: 'jobs-group__title' }, title), desc ? el('p', { class: 'jobs-group__desc' }, desc) : null, body);
  }
  function renderJobs() {
    const active = sortJobs(state.route.orders.filter(o => ACTIVE.indexOf(o.status) >= 0));
    const waiting = state.route.orders.filter(o => o.status === 'failed');
    const parts = [];
    if (!active.length && !waiting.length && !state.upcoming.length) {
      parts.push(el('div', { class: 'empty', 'data-testid': 'driver-empty' }, el('div', { class: 'empty__title' }, 'No jobs right now.'), el('div', { class: 'empty__hint' }, 'Jobs appear here as soon as the office dispatches an order to you.')));
    }
    if (active.length) parts.push(el('div', { class: 'jobs-list', 'data-testid': 'driver-active' }, active.map(jobCard)));
    if (waiting.length) parts.push(group('Waiting for the office', 'You reported a problem. The office decides what happens next.', el('div', { class: 'jobs-list' }, waiting.map(jobCard)), 'driver-waiting-list'));
    if (state.upcoming.length) parts.push(group('Upcoming', 'Assigned to you, waiting for dispatch.', el('ul', { class: 'card jobs-rows' }, sortJobs(state.upcoming).map(o => compactRow(o, 'Waiting for dispatch', 'driver-upcoming'))), 'driver-upcoming-list'));
    if (state.zoneQueue.length) parts.push(group('In your zones', 'Bulk packages sorted at the hub for your zones, not assigned yet.', el('ul', { class: 'card jobs-rows' }, state.zoneQueue.map(o => compactRow(o, MDM.geo.zoneShort(o.delivery.zone), 'driver-zone-queue'))), 'driver-zone-list'));
    if (state.doneToday.length) parts.push(group('Done today', null, el('ul', { class: 'card jobs-rows' }, state.doneToday.map(o => compactRow(o, MDM.STATUS[o.status].label + ' ' + MDM.ui.fmtTime(o.updatedAt), 'driver-done-today'))), 'driver-done-list'));
    ui.jobs.replaceChildren(...parts);
    const open = state.route.stops.filter(isOpen).length;
    ui.summary.textContent = state.driver ? plural(active.length, 'active job') + (open ? ' · ' + plural(open, 'stop') + ' left' : '') + (state.upcoming.length ? ' · ' + state.upcoming.length + ' upcoming' : '') : '';
    if (state.focusOrder) {
      const target = ui.jobs.querySelector('[data-order-id="' + state.focusOrder + '"] [data-testid="driver-action"]') || ui.jobs.querySelector('[data-order-id="' + state.focusOrder + '"]');
      state.focusOrder = null;
      if (target) { if (target.tabIndex < 0 && target.tagName === 'ARTICLE') target.tabIndex = -1; try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); } MDM.ui.scrollIntoViewIfNeeded(target.closest('.job') || target, 'start'); }
    }
  }

  // ---- Duty: punch in/out, hours, leave -----------------------------------------------------------------------------------------
  function minutesWorked() {
    const now = Date.now();
    return Math.round(state.today.reduce((n, a) => n + Math.max(0, (a.outAt ? new Date(a.outAt).getTime() : now) - new Date(a.inAt).getTime()), 0) / 60000);
  }
  const hm = m => Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';
  function renderDuty() {
    const d = state.driver;
    ui.pick.hidden = !!d;
    ui.duty.hidden = !d;
    ui.jobsSection.hidden = !d;
    ui.mapSection.hidden = !d;
    if (!d) return;
    ui.name.textContent = d.name;
    const worked = minutesWorked();
    ui.dutyStatus.textContent = state.shift ? 'On duty since ' + MDM.ui.fmtTime(state.shift.inAt) + ' · ' + hm(worked) + ' today' : (worked ? 'Off duty · ' + hm(worked) + ' worked today' : 'Off duty. Punch in to start your shift.');
    ui.dutyStatus.classList.toggle('is-on', !!state.shift);
    ui.punch.textContent = state.shift ? 'Punch out' : 'Punch in';
    ui.punch.className = 'btn btn--lg ' + (state.shift ? 'btn--secondary' : 'btn--primary');
    ui.punch.disabled = !state.staff;
    const vehicle = ({ bike: 'Bike', pickup: 'Pickup truck', car: 'Car', van: 'Van' }[d.vehicle] || '') + (d.vehicleNote ? (d.vehicle ? ', ' : '') + d.vehicleNote : '');
    ui.zones.textContent = [d.zones && d.zones.length ? 'Zones: ' + d.zones.map(z => MDM.geo.zoneLabel(z)).join(', ') : '', vehicle ? 'Vehicle: ' + vehicle : ''].filter(Boolean).join(' · ');
    ui.signedIn.textContent = 'Signed in as ' + d.name;
    renderLeave();
  }
  const LEAVE_KIND = { pending: 'warn', approved: 'ok', rejected: 'danger' };
  function renderLeave() {
    const s = state.staff;
    const bal = s && s.leaveBalance ? 'Annual ' + s.leaveBalance.annual + ' days left · Sick ' + s.leaveBalance.sick + ' days left' : '';
    const rows = state.leaves.slice(0, 3).map(l => el('li', { class: 'list__item', 'data-testid': 'driver-leave-item', 'data-status': l.status },
      el('div', { class: 'list__main' },
        el('div', { class: 'list__title' }, optLabel(MDM.LEAVE_TYPES, l.type)),
        el('div', { class: 'list__meta' }, MDM.ui.fmtDate(l.from + 'T00:00', { time: false }) + (l.to !== l.from ? ' to ' + MDM.ui.fmtDate(l.to + 'T00:00', { time: false }) : '') + ' · ' + plural(l.days, 'day') + (l.remarks ? ' · ' + l.remarks : ''))),
      el('div', { class: 'list__aside' }, html(MDM.ui.badge(LEAVE_KIND[l.status] || 'neutral', l.status === 'pending' ? 'Pending' : l.status === 'approved' ? 'Approved' : 'Not approved')))));
    ui.leave.replaceChildren(
      bal ? el('p', { class: 'driver-duty__line' }, bal) : null,
      rows.length ? el('ul', { class: 'driver-leave' }, rows) : el('p', { class: 'driver-duty__line' }, 'No leave requests yet.'));
  }
  async function onPunch() {
    if (!state.staff) return;
    ui.punch.disabled = true;
    try {
      if (state.shift) {
        const busy = state.route.orders.filter(o => ACTIVE.indexOf(o.status) >= 0 && o.status !== 'dispatched').length;
        if (busy && !(await MDM.ui.confirm({ title: 'Punch out?', message: 'You still have ' + plural(busy, 'job') + ' in progress. The office will need to reassign them.', okLabel: 'Punch out', danger: true }))) { ui.punch.disabled = false; return; }
        await MDM.store.punchOut(state.staff.id, { note: '' });
        if (state.online) await setOnline(false, { quiet: true });
        MDM.ui.toast('Punched out. ' + hm(minutesWorked()) + ' today.', 'ok');
      } else {
        await MDM.store.punchIn(state.staff.id, { source: 'driver app' });
        MDM.ui.toast('Punched in at ' + MDM.ui.fmtTime(new Date().toISOString()), 'ok');
      }
    } catch (e) { fail(e, 'Could not update your duty'); }
    await render();
  }
  async function onLeave() {
    if (!state.staff) return;
    const today = MDM.ui.dayKey();
    const v = await MDM.ui.dialog({ title: 'Request leave', message: 'The office approves or declines it, and you see the answer here.',
      fields: [
        { name: 'type', label: 'Type', type: 'select', required: true, value: 'annual', options: MDM.LEAVE_TYPES },
        { name: 'from', label: 'From', type: 'date', required: true, value: today, requiredMessage: 'Choose the first day' },
        { name: 'to', label: 'To', type: 'date', required: true, value: today, requiredMessage: 'Choose the last day' },
        { name: 'reason', label: 'Reason', type: 'textarea', required: false, rows: 2 },
      ],
      validate: vals => vals.to < vals.from ? { to: 'The last day must be on or after the first day' } : null,
      okLabel: 'Send request' });
    if (!v) return;
    try { await MDM.store.requestLeave({ staffId: state.staff.id, type: v.type, from: v.from, to: v.to, reason: v.reason }); MDM.ui.toast('Leave request sent', 'ok'); }
    catch (e) { fail(e, 'Could not send the request'); }
    await render();
  }

  // ---- Location: controls, simulation and GPS ------------------------------------------------------------------------------------
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
    if (!state.driver || !state.online) return 'Offline · location off';
    if (state.gpsOn) {
      if (state.gpsFix && state.gpsFix.accuracy > 100) return 'Online · weak GPS signal';
      const last = MDM.live.last(state.driverId);
      return 'Online · sharing GPS · ' + (last && last.source === 'gps' ? MDM.ui.timeAgo(last.at, { seconds: true }) : 'waiting for a fix');
    }
    if (state.sim) return 'Online · sharing location (demo route)';
    return 'Online · location off';
  }
  function renderStatus() { const t = statusText(); if (ui.status.textContent !== t) ui.status.textContent = t; }
  function hideGpsAlert() { ui.gpsAlert.hidden = true; ui.gpsAlert.replaceChildren(); }
  function showGpsError(err) {
    const code = err && err.code;
    const msg = code === 1 ? 'Location permission is off. Allow location for this site in your browser settings, or use Simulate route for the demo.'
      : code === 'insecure' ? 'Location sharing needs an https address (it works on the published site).'
      : code === 'unsupported' ? 'This browser cannot share location. Use Simulate route for the demo.'
      : 'Could not get a location fix. Try again outdoors.';
    ui.gpsAlert.replaceChildren(el('div', { class: 'alert alert--danger', role: 'alert' }, icon('info', 16), el('div', { class: 'alert__body' }, msg)));
    ui.gpsAlert.hidden = false;
  }
  function stopSim() { if (state.sim) { state.sim.stop(); state.sim = null; } state.nearId = null; }
  function stopGps() { if (state.gpsOn) MDM.live.stopGPS(); state.gpsOn = false; state.gpsFix = null; }
  function resumeSimAt(stopId) { const s = state.sim && state.sim.state; if (s && s.atStop && s.stop && s.stop.id === stopId) { state.nearId = null; state.sim.resume(); } }
  function onSimStop(stop) {
    const cur = state.route.stops.find(s => s.id === stop.id);
    if (!cur || !isOpen(cur)) { setTimeout(() => { if (state.sim) state.sim.resume(); }, 0); return; }
    const order = state.route.orders.find(o => o.id === cur.orderId);
    state.nearId = cur.id;
    MDM.ui.toast('Arrived near ' + (order ? addressText(order, cur) : cur.address), 'info');
    renderJobs();
  }
  function onSimEnd() { state.sim = null; state.nearId = null; renderControls(); renderStatus(); MDM.ui.toast('Route simulation finished', 'neutral'); }
  async function toggleSimulate() {
    if (state.sim) { stopSim(); renderControls(); renderStatus(); renderJobs(); return; }
    const route = await MDM.store.driverRoute(state.driverId);
    if (route.polyline.length < 2) { MDM.ui.toast('No route to simulate yet. Jobs appear once the office dispatches an order to you.', 'warn'); return; }
    stopGps(); hideGpsAlert();
    const opts = { stops: route.stops.filter(isOpen), autoStops: false, onStop: onSimStop, onEnd: onSimEnd };
    if (state.speed) opts.timeScale = state.speed;
    try { state.sim = MDM.live.simulate(state.driverId, route.polyline, opts); }
    catch (e) { fail(e, 'Could not start the simulation'); }
    renderControls(); renderStatus();
  }
  function toggleGps() {
    if (state.gpsOn) { stopGps(); hideGpsAlert(); renderControls(); renderStatus(); return; }
    hideGpsAlert(); stopSim();
    state.gpsOn = true; state.gpsFix = null;
    MDM.live.watchGPS(state.driverId, {
      onFix: f => { state.gpsFix = f; renderStatus(); },
      onError: err => { if (!err || err.code === 1 || MDM.live.gpsState() !== 'on') stopGps(); showGpsError(err); renderControls(); renderStatus(); },
    }).catch(err => { if (MDM.live.gpsState() !== 'on') stopGps(); showGpsError(err); renderControls(); renderStatus(); });
    renderControls(); renderStatus();
  }
  async function setOnline(v, opts) {
    if (v && !state.shift) {
      const ok = await MDM.ui.confirm({ title: 'Punch in first', message: 'You are off duty. Punch in now to go online?', okLabel: 'Punch in and go online' });
      if (!ok) { renderControls(); return; }
      try { await MDM.store.punchIn(state.staff.id, { source: 'driver app' }); } catch (e) { fail(e, 'Could not punch in'); renderControls(); return; }
    }
    if (v) keepAwake(); else { letSleep(); stopSim(); stopGps(); hideGpsAlert(); }
    state.online = v; writeSession();
    renderControls(); renderStatus();
    try {
      const d = await MDM.store.get('drivers', state.driverId);
      if (d && (v ? d.status === 'offline' : d.status !== 'offline')) await MDM.store.update('drivers', state.driverId, { status: v ? 'online' : 'offline' });
    } catch (e) { if (!(opts && opts.quiet)) fail(e, 'Could not change your status'); }
    if (!(opts && opts.quiet)) await render();
  }

  // ---- Map ------------------------------------------------------------------------------------------------------------------------
  function showMapFallback() {
    ui.mapEl.appendChild(el('div', { class: 'map__fallback' }, el('div', { class: 'alert alert--warn', role: 'status' }, icon('info', 16), el('div', { class: 'alert__body' }, 'Map unavailable right now. Your jobs above are still up to date.'))));
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
    MDM.map.fit(map.map, pts, { padding: { top: 44, right: 56, bottom: 60, left: 36 }, maxZoom: 15 });
  }
  function watchPositions() {
    if (map.posUnsub) { map.posUnsub(); map.posUnsub = null; }
    if (!state.driverId) return;
    map.posUnsub = MDM.live.onPosition(state.driverId, p => { placeDriver(p); if (state.gpsOn) renderStatus(); });
  }
  async function syncMap() {
    if (!state.driver) return;
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

  // ---- Job actions ------------------------------------------------------------------------------------------------------------------
  async function storePhoto(file, kind, orderId) {
    const img = await MDM.ui.imageToJpeg(file, { maxEdge: 800, quality: 0.8 });
    const doc = await MDM.store.insert('files', { kind, orderId, name: file.name || kind + '.jpg', type: img.type, size: img.size, dataUrl: img.dataUrl, at: new Date().toISOString() });
    return doc.id;
  }
  async function viewFile(fileId, title) {
    const f = await MDM.store.get('files', fileId);
    if (!f || !f.dataUrl) { MDM.ui.toast('That file is no longer available', 'warn'); return; }
    const close = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'driver-file-close' }, 'Close');
    const dlg = el('dialog', { class: 'dialog dialog--wide', 'aria-label': title, 'data-testid': 'driver-file-view' },
      el('div', { class: 'dialog__body' }, el('h2', { class: 'dialog__title' }, title), el('img', { src: f.dataUrl, alt: title, class: 'job__preview' })),
      el('div', { class: 'dialog__footer' }, close));
    close.addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    close.focus();
  }
  function act(btn, o, ph) {
    if (ph.key === 'start') return onStart(btn, o);
    if (ph.key === 'arrive') return onArrived(btn, o, ph.stop);
    if (ph.key === 'collect') return onCollected(btn, o, ph.stop);
    if (ph.key === 'out') return onOut(btn, o);
    if (ph.key === 'deliver' || ph.key === 'return') return onDelivered(btn, o, ph.stop);
  }
  async function run(btn, o, fn, okMsg, fallback) {
    btn.disabled = true; state.focusOrder = o.id;
    try { const r = await fn(); if (okMsg) MDM.ui.toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok'); return r; }
    catch (e) { state.focusOrder = null; btn.disabled = false; fail(e, fallback); return null; }
  }
  function onStart(btn, o) { return run(btn, o, () => MDM.store.startRoute(o.id, { by: by() }), o.code + ': on the way to collect', 'Could not start'); }
  function onArrived(btn, o, stop) { return run(btn, o, () => MDM.store.setStop(o.id, stop.id, { status: 'arrived', by: by() }), null, 'Could not update the stop'); }
  function onOut(btn, o) { return run(btn, o, () => MDM.store.outForDelivery(o.id, { by: by() }), o.code + ': out for delivery', 'Could not update the order'); }
  // Collected: proof photo is required; the driver can correct each package's size and dimensions (How it works §2).
  async function onCollected(btn, o, stop) {
    const pkgs = (o.packages || []).filter(p => (stop.packageIds || [stop.packageId]).indexOf(p.id) >= 0);
    const fields = [];
    if (stop.shop) {
      const pkg = pkgs[0];
      fields.push({ name: 'receiptTotal', label: 'Receipt total (MVR)', type: 'number', required: true, min: 0, step: 1, hint: pkg && pkg.shop ? 'Budget ' + MDM.pricing.format(pkg.shop.budget) : null, requiredMessage: 'Enter the receipt total' });
      fields.push({ name: 'receiptPhoto', label: 'Receipt photo', type: 'file', required: true, accept: 'image/*', capture: 'environment', buttonLabel: 'Take a photo', requiredMessage: 'Take a photo of the receipt' });
    }
    fields.push({ name: 'photo', label: 'Proof of collection', type: 'file', required: !stop.shop, accept: 'image/*', capture: 'environment', buttonLabel: 'Take a photo', hint: 'A clear photo of the package. The office uses it to confirm the price.', requiredMessage: 'Take a photo of the package' });
    pkgs.forEach((p, i) => {
      const n = pkgs.length > 1 ? ' ' + (i + 1) : '';
      fields.push({ name: 'size_' + i, label: 'Package' + n + ' size', type: 'segmented', required: true, value: p.size, options: Object.keys(MDM.pricing.SIZES).map(k => ({ value: k, label: MDM.pricing.SIZES[k] })) });
      fields.push({ name: 'dims_' + i, label: 'Package' + n + ' dimensions', type: 'text', required: false, value: p.dims ? [p.dims.l, p.dims.w, p.dims.h].join(' x ') : '', placeholder: 'L x W x H in cm, e.g. 30 x 20 x 15', inputmode: 'text',
        validate: v => v && !parseDims(v) ? 'Write it as length x width x height, e.g. 30 x 20 x 15' : null });
    });
    fields.push({ name: 'remarks', label: 'Remarks', type: 'textarea', required: false, rows: 2 });
    const v = await MDM.ui.dialog({ title: stop.shop ? 'Shopping done' : 'Collected', message: o.code + ' · ' + addressText(o, stop), fields, okLabel: 'Confirm collection' });
    if (!v) return;
    btn.disabled = true;
    const patch = { status: 'done', by: by(), remarks: v.remarks || '' };
    try {
      if (v.photo) patch.photoId = await storePhoto(v.photo, 'proof_collection', o.id);
      if (stop.shop) { patch.receiptTotal = v.receiptTotal; patch.receiptPhotoId = await storePhoto(v.receiptPhoto, 'receipt', o.id); if (!patch.photoId) patch.photoId = patch.receiptPhotoId; }
    } catch (e) { btn.disabled = false; fail(e, 'Could not save the photo'); return; }
    const sizes = {};
    pkgs.forEach((p, i) => {
      const size = v['size_' + i], dims = parseDims(v['dims_' + i]);
      const sameDims = JSON.stringify(dims) === JSON.stringify(p.dims && p.dims.l ? { l: p.dims.l, w: p.dims.w, h: p.dims.h } : null);
      if (size !== p.size || (dims && !sameDims)) sizes[p.id] = { size, dims: dims || p.dims || null };
    });
    if (Object.keys(sizes).length) patch.sizes = sizes;
    const r = await run(btn, o, () => MDM.store.setStop(o.id, stop.id, patch), x => x.status === 'collected' ? o.code + ' collected' : 'Collection saved', 'Could not save the collection');
    if (r) resumeSimAt(stop.id);
  }
  async function onDelivered(btn, o, stop) {
    const isReturn = stop.type === 'return';
    const nameField = { name: 'recipientName', label: isReturn ? 'Received by' : 'Recipient name', type: 'text', required: true, autocomplete: 'off', value: !isReturn && stop.contact && stop.contact.name ? stop.contact.name : '', hint: 'Who took the package. Not needed when left as instructed.', requiredMessage: 'Enter who received it' };
    const p = MDM.ui.dialog({ title: isReturn ? 'Returned to sender' : 'Delivered', message: o.code + ' · ' + addressText(o, stop),
      fields: [
        { name: 'handedTo', label: 'Handed to', type: 'segmented', required: true, value: 'recipient', options: MDM.HANDED_TO },
        nameField,
        { name: 'confirmed', label: 'The recipient confirmed they received it', type: 'checkbox', value: false },
        { name: 'photo', label: 'Proof of delivery', type: 'file', required: false, accept: 'image/*', capture: 'environment', buttonLabel: 'Take a photo', hint: 'Needed when nobody confirms in person.' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', required: false, rows: 2 },
      ],
      validate: vals => !vals.photo && !vals.confirmed ? { photo: 'Take a photo, or tick that the recipient confirmed' } : null,
      okLabel: isReturn ? 'Confirm return' : 'Confirm delivery' });
    const seg = document.querySelector('dialog[open] [data-testid="dialog-handedTo"]');
    if (seg) {
      seg.classList.add('segmented--stack');
      seg.addEventListener('change', () => { const c = seg.querySelector('input:checked'); nameField.required = !(c && c.value === 'left'); });
    }
    const v = await p;
    if (!v) return;
    btn.disabled = true;
    const patch = { status: 'done', by: by(), handedTo: v.handedTo, recipientName: v.recipientName || '', confirmed: !!v.confirmed, remarks: v.remarks || '' };
    if (v.photo) { try { patch.photoId = await storePhoto(v.photo, 'proof', o.id); } catch (e) { btn.disabled = false; fail(e, 'Could not save the photo'); return; } }
    const r = await run(btn, o, () => MDM.store.setStop(o.id, stop.id, patch), x => x.status === 'delivered' ? o.code + ' delivered' : x.status === 'returned' ? o.code + ' returned to sender' : 'Delivery saved', 'Could not save the delivery');
    if (r) resumeSimAt(stop.id);
  }
  // Failed collection or delivery (client requirements §14): reason, remarks, optional photo; the office decides what happens next.
  async function onFailed(btn, o, stop) {
    const v = await MDM.ui.dialog({ title: stop.type === 'pickup' ? 'Collection problem' : 'Delivery problem', message: 'The job goes to the office, who will reschedule, reassign, return or contact the customer.',
      fields: [
        { name: 'failReason', label: 'Reason', type: 'select', required: true, placeholder: 'Choose a reason', options: MDM.FAIL_REASONS, requiredMessage: 'Choose a reason' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', required: false, rows: 3, hint: 'What you tried, for example called twice' },
        { name: 'photo', label: 'Photo', type: 'file', required: false, accept: 'image/*', capture: 'environment', buttonLabel: 'Take a photo' },
      ],
      validate: vals => vals.failReason === 'other' && !vals.remarks ? { remarks: 'Tell the office what happened' } : null,
      okLabel: 'Report problem', danger: true });
    if (!v) return;
    btn.disabled = true;
    const patch = { status: 'failed', failReason: v.failReason, remarks: v.remarks || '', by: by() };
    if (v.photo) { try { patch.photoId = await storePhoto(v.photo, 'failed', o.id); } catch (e) { btn.disabled = false; fail(e, 'Could not save the photo'); return; } }
    const r = await run(btn, o, () => MDM.store.setStop(o.id, stop.id, patch), null, 'Could not report the problem');
    if (r) { resumeSimAt(stop.id); MDM.ui.toast(o.code + ' sent to the office', 'warn'); }
  }

  // ---- Driver choice ----------------------------------------------------------------------------------------------------------------
  async function selectDriver(id) {
    if ((id || null) === state.driverId) return;
    stopSim(); stopGps(); hideGpsAlert(); letSleep();
    state.driverId = id || null; state.driver = null; state.online = false; state.nearId = null;
    map.fitted = false;
    writeSession();
    watchPositions();
    await render();
    if (!id) ui.select.focus();
  }

  // ---- Render -------------------------------------------------------------------------------------------------------------------------
  async function render() {
    const seq = ++state.renderSeq;
    const [drivers, settings] = await Promise.all([MDM.store.list('drivers', { order: 'createdAt' }), MDM.store.settings()]);
    const driver = state.driverId ? drivers.find(d => d.id === state.driverId) || null : null;
    let route = { orders: [], stops: [], polyline: [] }, upcoming = [], done = [], zoneQueue = [], staff = null, shift = null, today = [], leaves = [], batches = {};
    if (driver) {
      const today0 = new Date(); today0.setHours(0, 0, 0, 0);
      const [r, mine, collected, st, bl] = await Promise.all([
        MDM.store.driverRoute(driver.id),
        MDM.store.list('orders', { where: { driverId: driver.id } }),
        MDM.store.list('orders', { where: { status: 'collected' } }),
        driver.staffId ? MDM.store.get('staff', driver.staffId) : null,
        MDM.store.list('batches'),
      ]);
      route = r; staff = st;
      upcoming = mine.filter(o => o.status === 'assigned');
      done = mine.filter(o => (o.status === 'delivered' || o.status === 'returned') && new Date(o.updatedAt) >= today0);
      zoneQueue = collected.filter(o => o.batchId && !o.driverId && o.delivery && (driver.zones || []).indexOf(o.delivery.zone) >= 0);
      bl.forEach(b => { batches[b.id] = b; });
      if (staff) {
        [shift, today, leaves] = await Promise.all([
          MDM.store.openShift(staff.id),
          MDM.store.list('attendance', { where: { staffId: staff.id, date: MDM.ui.dayKey() } }),
          MDM.store.list('leaves', { where: { staffId: staff.id } }),
        ]);
      }
    }
    if (seq !== state.renderSeq) return;
    Object.assign(state, { drivers, settings: settings || {}, driver, route, upcoming, doneToday: done, zoneQueue, staff, shift, today, leaves, batches });
    if (!driver && state.driverId) { state.driverId = null; writeSession(); watchPositions(); }
    const wasOnline = state.online;
    state.online = !!driver && driver.status !== 'offline';
    if (state.online !== wasOnline) { writeSession(); if (state.online) keepAwake(); else { letSleep(); stopSim(); stopGps(); } }
    renderDuty(); renderControls(); renderStatus(); renderJobs();
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
    const asParam = new URLSearchParams(location.search).get('driver');
    state.driverId = asParam || (typeof sess.driverId === 'string' && sess.driverId ? sess.driverId : null);
    if (asParam) writeSession();
    ui.select.addEventListener('change', () => { selectDriver(ui.select.value).catch(e => { setTimeout(() => { throw e; }, 0); }); });
    ui.online.addEventListener('change', e => { if (e.target && e.target.name === 'online') setOnline(e.target.value === 'online').catch(err => fail(err, 'Could not change your status')); });
    ui.simulate.addEventListener('click', () => { toggleSimulate().catch(e => fail(e, 'Could not start the simulation')); });
    ui.gps.addEventListener('click', toggleGps);
    ui.recenter.addEventListener('click', fitMap);
    ui.punch.addEventListener('click', () => { onPunch().catch(e => fail(e, 'Could not update your duty')); });
    ui.leaveBtn.addEventListener('click', () => { onLeave().catch(e => fail(e, 'Could not send the request')); });
    ui.switchBtn.addEventListener('click', () => { selectDriver('').catch(e => { setTimeout(() => { throw e; }, 0); }); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.online) keepAwake(); });
    const WATCH = ['orders', 'drivers', 'attendance', 'leaves', 'staff', 'batches'];
    MDM.store.subscribe('*', msg => { if (msg && (msg.op === 'reset' || msg.op === 'refresh' || WATCH.indexOf(msg.collection) >= 0)) requestRender(); });
    setInterval(renderStatus, 1000);
    setInterval(() => { if (state.driver) renderDuty(); }, 60000);
    watchPositions();
    await render();
  }
  main();
})(window.MDM);

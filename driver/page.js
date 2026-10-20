// Driver console (client requirements §2 driver, §10, §13, §14, §22; How it works §2, §5, §10, §11).
// One phone-first column: duty (punch in/out, online, location sharing, leave), then the driver's own jobs in priority order with the
// step-by-step flow Start → Arrived for collection → Collected (proof photo, size) → Out for delivery → Delivered (proof), a failed
// report at any step, and the route map last. Every write goes through MDM.store; render() rebuilds from the store whenever orders,
// drivers, attendance or leave change, in this tab or another.
// Web app updates 11/10/2026: delivery method details on each job (boat, Maldivian Cargo, airport), "Update boat details" (§5.3),
// naalu on proof of collection and delivery, packing charge and cash collected on proof of delivery (§5.6, §6), cash on hand,
// messages from the office and returns of orders the business cancelled (§5.5), accumulated off days and a collapsible leave
// section (§7). Package category stays editable on collection; no measurements (§2.2, §2.3).
// Updates 17/10/2026: Maldivian Cargo charges (with a photo of their bill) on proof of delivery to the cargo counter, extra
// collection and shop stops on one order, and the proof of collection the office prices a no-photo order from.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const SESSION_KEY = 'mdm:driver';
  const READ_KEY = 'mdm:driver-read';   // localStorage { driverId: [notificationId, ...] }: messages this driver has read
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const q = sel => document.querySelector(sel);
  const ACTIVE = ['dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery'];

  const ui = {
    pick: q('[data-testid="driver-pick"]'), select: q('[data-testid="driver-select"]'),
    duty: q('[data-testid="driver-duty"]'), name: q('[data-testid="driver-name"]'), dutyStatus: q('[data-testid="driver-duty-status"]'),
    punch: q('[data-testid="driver-punch"]'), zones: q('[data-testid="driver-zones"]'),
    online: q('[data-testid="driver-online"]'), status: q('[data-testid="driver-status"]'),
    simulate: q('[data-testid="driver-simulate"]'), gps: q('[data-testid="driver-gps"]'),
    gpsNote: q('[data-testid="driver-gps-note"]'), gpsAlert: q('[data-testid="driver-gps-alert"]'),
    leave: q('[data-testid="driver-leave"]'), leaveSection: q('[data-testid="driver-leave-section"]'), leaveCount: q('[data-testid="driver-leave-count"]'),
    leaveBalance: q('[data-testid="driver-leave-balance"]'), leaveFormSlot: q('[data-slot="leave-form"]'),
    offDays: q('[data-testid="driver-offdays"]'), offDayBalance: q('[data-testid="driver-offday-balance"]'), offDayDetail: q('[data-testid="driver-offday-detail"]'),
    notes: q('[data-testid="driver-notes"]'), notesList: q('[data-testid="driver-notes-list"]'), notesUnread: q('[data-testid="driver-notes-unread"]'),
    notesRead: q('[data-testid="driver-notes-read"]'), notesMore: q('[data-testid="driver-notes-more"]'), notesFoot: q('.driver-notes__foot'),
    cash: q('[data-testid="driver-cash"]'), cashTitle: q('[data-testid="driver-cash-title"]'), cashNote: q('[data-testid="driver-cash-note"]'),
    cashList: q('[data-testid="driver-cash-list"]'), cashPending: q('[data-testid="driver-cash-pending"]'), cashOwed: q('[data-testid="driver-cash-owed"]'),
    signedIn: q('[data-testid="driver-signed-in"]'), switchBtn: q('[data-testid="driver-switch"]'), me: q('[data-testid="driver-me"]'),
    jobsSection: q('[data-testid="driver-jobs-section"]'), jobs: q('#driver-jobs'), summary: q('[data-testid="driver-route-summary"]'),
    mapSection: q('[data-testid="driver-map-section"]'), mapEl: q('#driver-map'), recenter: q('[data-testid="driver-recenter"]'),
  };

  const state = {
    driverId: null, driver: null, drivers: [], staff: null, settings: {},
    route: { orders: [], stops: [], polyline: [], returns: [] }, upcoming: [], doneToday: [], zoneQueue: [], batches: {},
    shift: null, today: [], leaves: [], offDays: null, cashHeld: [], owed: [], notes: [], notesAll: false, noteIds: null, readMem: {},
    online: false, sim: null, gpsOn: false, gpsFix: null, nearId: null, focusOrder: null,
    wakeLock: null, speed: null, renderSeq: 0, moreOpen: new Set(), entered: false,
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
  const money = n => MDM.pricing.format(n);
  const phoneText = p => p ? MDM.ui.phone.format(p) : '';
  // "Name · +960 772 0006" for a definition list, with the number kept on one line.
  function personNodes(name, phone) {
    const ph = phoneText(phone);
    if (!name && !ph) return '';
    return [name || '', name && ph ? ' · ' : '', ph ? el('span', { class: 'nowrap' }, ph) : ''];
  }
  // Business size category (§5.2): "Medium (Box)" from the rate card's tiers.
  function tierText(p) {
    if (!p || !p.tier) return '';
    const t = MDM.pricing.businessTiers(state.settings).find(x => x.value === p.tier);
    return (t ? t.label : p.tier) + ' (' + sizeName(p.size || (t && t.size)) + ')';
  }
  function dayText(d) {
    if (!d) return '';
    const today = MDM.ui.dayKey(), tomorrow = MDM.ui.dayKey(new Date(Date.now() + 86400000));
    return d === today ? 'Today' : d === tomorrow ? 'Tomorrow' : MDM.ui.fmtDate(d + 'T00:00', { time: false });
  }
  const departText = (date, time) => [dayText(date), time ? (date ? 'at ' : '') + time : ''].filter(Boolean).join(' ');
  const terminalLabel = v => ((MDM.geo.terminals().find(t => t.value === v) || {}).label) || v || '';
  const vesselLabel = v => optLabel(MDM.VESSEL_TYPES, v) || 'Boat';
  const isBoatJob = o => !!(o.delivery && o.delivery.method === 'boat' && ['delivered', 'cancelled', 'returned'].indexOf(o.status) < 0);
  // Delivery method details (§3.2 to §3.4) the driver needs at the jetty, the cargo counter or the airport.
  function methodRows(o) {
    const d = o.delivery || {}, rows = [];
    const add = (k, v, cls) => { if (v != null && v !== '') rows.push([k, v, cls]); };
    if (d.method === 'boat' && d.boat) {
      const b = d.boat;
      add('Vessel', [vesselLabel(b.vesselType), b.name].filter(Boolean).join(': '));
      add('Departs', departText(b.departureDate, b.departureTime));
      add('Harbour or jetty', terminalLabel(b.jetty));
      add('Island', b.island);
      add('Destination address', b.address);
      add('Receiver', personNodes(d.recipientName, b.contact || d.recipientPhone));
    } else if (d.method === 'cargo') {
      const c = d.cargo || {};
      add('Drop at', c.counter || MDM.geo.cargoCounter().label);
      add('Island', c.island);
      add('Consignee', c.consignee || d.recipientName);
      add('Receiver contact', personNodes('', d.recipientPhone));
    } else if (d.method === 'airport') {
      const a = d.airport || {};
      add('Meeting point', a.point ? ((MDM.geo.airportPoints().find(x => x.value === a.point) || {}).label || a.point) : '');
      add('Counter or point', a.counter);
      add('Resort or destination', a.resort);
      add('Resort speedboat', a.speedboat);
      add('Departs', a.departureTime);
      add('Handover', a.instructions);
      add('Receiver', personNodes(d.recipientName, d.recipientPhone));
    }
    return rows;
  }
  const STAGE_TEXT = { collection: 'at collection', delivery: 'at delivery', office: 'by the office' };
  // Money recorded on the order (§6): naalu says whether it was paid at collection or at delivery; packing is on the customer's bill.
  function chargeRows(o) {
    return (o.charges || []).filter(c => !c.void).map(c => {
      const what = c.type === 'naalu' ? 'Naalu paid ' + (STAGE_TEXT[c.stage] || '') : c.type === 'packing' ? 'Packing charge' : c.type === 'cargo' ? 'Maldivian Cargo charges' : (c.description || 'Other charge');
      const note = [c.type !== 'other' && c.description ? c.description : '', c.billable ? 'on the customer\'s bill' : '',
        c.paidBy === 'driver' ? (c.by === by() ? (c.reimbursedAt ? 'reimbursed to you' : 'paid by you') : (c.reimbursedAt ? 'reimbursed to the driver' : 'paid by the driver')) : ''].filter(Boolean).join(' · ');
      return [what.trim(), money(c.amount) + (note ? ' · ' + note : ''), null, c];
    });
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
  // The shop for a shopping stop: the Shop & Deliver package's, or an extra shop stop on a multi-collection order (updates 17/10/2026).
  function shopOf(o, stop) {
    if (!stop.shop) return null;
    const pkg = (o.packages || []).find(p => p.id === stop.packageId);
    if (pkg && pkg.shop) return pkg.shop;
    const c = stop.collectionId ? (o.extraCollections || []).find(x => x.id === stop.collectionId) : null;
    return c && c.shop ? Object.assign({ address: c.address }, c.shop) : null;
  }
  function addressText(o, stop) {
    const sh = shopOf(o, stop);
    if (sh) return sh.address ? sh.name + ', ' + sh.address : sh.name;
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
      add('Courier', d.courierName);
      add('Courier office', d.courierAddress);
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
    const tiers = Array.from(new Set((o.packages || []).map(tierText).filter(Boolean)));
    if (tiers.length) add('Size category', tiers.join(', '));
    add('When', scheduleLine(o));
    return rows;
  }
  function shopRows(o, stop) {
    const s = shopOf(o, stop);
    if (!s) return [];
    return [['Shopping list', s.list || ''], ['Budget', MDM.pricing.format(s.budget), 'mono'], ['If unavailable', { call: 'Call the customer', skip: 'Skip it', closest: 'Buy the closest match' }[s.unavailable] || s.unavailable || '']];
  }
  function dl(rows) {
    if (!rows.length) return null;
    return el('dl', { class: 'job__dl' }, rows.map(r => [el('dt', null, r[0]), el('dd', { class: r[2] || null }, typeof r[1] === 'string' || typeof r[1] === 'number' ? String(r[1]) : r[1])]));
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
    // An extra collection stop has its own instructions; the order's collection note belongs to the first collection.
    const note = stop.instructions || (stop.collectionId ? '' : (isPickup ? o.collection && o.collection.instructions : o.delivery && o.delivery.instructions)) || '';
    const place = placeLine(stop);
    // A finished stop shrinks to its label and address: the contact and notes matter only while it is still to do.
    if (stop.status === 'done') {
      return el('div', { class: 'job__stop is-done', 'data-testid': testid, 'data-stop-id': stop.id, 'data-stop-status': stop.status },
        el('div', { class: 'job__label' }, title, el('span', { class: 'job__ok' }, icon('check', 14), ' Done ' + MDM.ui.fmtTime(stop.at))),
        el('div', { class: 'job__address' }, addressText(o, stop)));
    }
    return el('div', { class: ['job__stop', state.nearId === stop.id && 'is-near'], 'data-testid': testid, 'data-stop-id': stop.id, 'data-stop-status': stop.status },
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
        el('span', { class: 'job__pkgtext' }, [p.description, p.fragile ? 'Fragile' : '', p.needsVehicle ? 'Needs a vehicle' : ''].filter(Boolean).join(' · ') || 'No description')))),
      filesRow(o));
  }
  function directionsHref(stop) { return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(Number(stop.lat).toFixed(5) + ',' + Number(stop.lng).toFixed(5)) + '&travelmode=driving'; }
  function officeAlert(o) {
    const stop = (o.route.stops || []).find(s => s.status === 'failed');
    const reason = stop ? optLabel(MDM.FAIL_REASONS, stop.failReason) : '';
    const phone = (state.settings.contact || {}).phone;
    const links = phone ? MDM.ui.phone.links(phone) : null;
    return el('div', { class: 'alert alert--warn job__alert', role: 'status', 'data-testid': 'driver-waiting' }, icon('clock', 16),
      el('div', { class: 'alert__body' }, el('strong', null, 'Waiting for the office. '), (reason ? reason + '. ' : '') + 'They decide what happens next.',
        links ? el('div', { class: 'job__alert-link' }, el('a', { href: links.tel }, 'Call the office')) : null));
  }
  // The office sent a failed delivery back to the sender: there is an open return stop, so no cash is collected on it.
  const returning = o => ((o.route && o.route.stops) || []).some(s => s.type === 'return' && s.status !== 'done' && s.status !== 'skipped');
  const codDue = o => !!(o.cod && o.cod.amount > 0 && o.cod.status === 'pending') && !returning(o);
  function methodTag(o) {
    const d = o.delivery || {};
    if (d.method === 'boat') return vesselLabel(d.boat && d.boat.vesselType).replace(' (dhoni)', '');
    if (d.method === 'cargo') return 'Maldivian Cargo';
    if (d.method === 'airport') return 'Airport';
    return '';
  }
  function whoChanged(byStr) {
    if (byStr === by()) return 'you';
    if (/^driver:/.test(byStr || '')) return 'the driver';
    if (/^business:/.test(byStr || '')) return 'the business';
    return 'the office';
  }
  const whenText = iso => MDM.ui.dayKey(iso) === MDM.ui.dayKey() ? MDM.ui.fmtTime(iso) : MDM.ui.fmtDate(iso);
  // "Boat changed 14:20 by you: missed the boat… (was Huraa Speed 1, 16:00)": the previous value of every field that changed.
  function boatChangeText(h) {
    const reason = optLabel(MDM.BOAT_CHANGE_REASONS, h.reason);
    const f = h.from || {};
    const was = [f.vesselType ? vesselLabel(f.vesselType) : '', f.name, f.departureDate ? dayText(f.departureDate) : '', f.departureTime, f.jetty ? terminalLabel(f.jetty) : '', f.island].filter(Boolean).join(', ');
    return 'Boat changed ' + whenText(h.at) + ' by ' + whoChanged(h.by) + (reason ? ': ' + reason.toLowerCase() : '') + (was ? ' (was ' + was + ')' : '') + (h.note ? '. ' + h.note : '');
  }
  // Every change, newest first (§5.3 note: the speedboat can change more than once); the oldest beyond three are counted.
  function boatHistory(hist) {
    if (!hist.length) return null;
    const recent = hist.slice().reverse(), shown = recent.slice(0, 3), more = recent.length - shown.length;
    return el('div', { class: 'job__note job__boatlog', 'data-testid': 'driver-boat-change', 'data-count': String(hist.length) }, icon('history', 14),
      shown.length === 1 ? el('span', null, boatChangeText(shown[0]))
        : el('ul', { class: 'job__boatlist', 'aria-label': 'Boat changes, newest first' }, shown.map(h => el('li', null, boatChangeText(h))), more ? el('li', { class: 'job__boatmore' }, plural(more, 'earlier change')) : null));
  }
  function methodBlock(o) {
    const d = o.delivery || {};
    if (!d.method || d.method === 'home') return null;
    const hist = (d.method === 'boat' && d.boat && d.boat.history) || [];
    const ico = { boat: 'ship', cargo: 'package', airport: 'plane' }[d.method];
    return el('div', { class: 'card__body job__body job__method', 'data-testid': 'driver-method', 'data-method': d.method },
      el('div', { class: 'job__label' }, el('span', { class: 'job__method-title' }, icon(ico, 16), MDM.deliveryMethodLabel(d.method))),
      dl(methodRows(o)),
      boatHistory(hist),
      isBoatJob(o) ? el('button', { type: 'button', class: 'btn btn--secondary btn--block job__boatbtn', 'data-testid': 'driver-boat-update', on: { click: e => onBoatUpdate(e.currentTarget, o) } }, icon('edit', 16), 'Update boat details') : null);
  }
  function chargesBlock(o) {
    const rows = chargeRows(o);
    if (!rows.length) return null;
    return el('div', { class: 'job__charges', 'data-testid': 'driver-charges' },
      el('div', { class: 'job__label' }, 'Money recorded'),
      el('dl', { class: 'job__dl' }, rows.map(r => [el('dt', null, r[0]), el('dd', { 'data-charge-type': r[3].type, 'data-charge-stage': r[3].stage }, r[1])])));
  }
  // jobCard(o, { hero }): the job to work on now is the hero, with everything open. The others keep their stops, method details and
  // actions in view and fold the packages and order details into "Details" (the open state survives re-renders).
  function jobCard(o, opts) {
    const hero = !!(opts && opts.hero);
    const ph = phase(o);
    const pri = priorityOf(o);
    const stops = (o.route && o.route.stops) || [];
    const pickups = stops.filter(s => s.type === 'pickup'), drops = stops.filter(s => s.type !== 'pickup');
    const cur = currentStop(o);
    const showPick = pickups.find(s => cur && s.id === cur.id) || pickups.find(isOpen) || pickups[pickups.length - 1];
    const showDrop = drops.find(s => cur && s.id === cur.id) || drops.find(isOpen) || drops[drops.length - 1];
    const tags = [];
    if (pri.label) tags.push(el('span', { class: 'tag tag--hot', 'data-testid': 'driver-priority' }, pri.label));
    if (methodTag(o)) tags.push(el('span', { class: 'tag', 'data-testid': 'driver-method-tag' }, methodTag(o)));
    if (codDue(o)) tags.push(el('span', { class: 'tag tag--cash', 'data-testid': 'driver-cod-tag' }, 'Cash ' + money(o.cod.amount)));
    if ((o.packages || []).some(p => p.fragile)) tags.push(el('span', { class: 'tag' }, 'Fragile'));
    const meta = [MDM.requestTypeLabel(o.requestType), o.customer && o.customer.name].filter(Boolean).join(' · ');
    const target = (ph.stop || cur || showDrop || showPick);
    const primary = ph.label ? el('button', { type: 'button', class: 'btn btn--primary btn--xl btn--block job__primary', 'data-testid': 'driver-action', 'data-action': ph.key, on: { click: e => act(e.currentTarget, o, ph) } }, ph.label) : null;
    const canFail = ACTIVE.indexOf(o.status) >= 0 && cur;
    const detailsBody = el('div', { class: 'card__body job__body' }, packagesBlock(o), dl(detailRows(o)), chargesBlock(o));
    let more = detailsBody;
    if (!hero) {
      more = el('details', { class: 'job__more', open: state.moreOpen.has(o.id) || null },
        el('summary', { class: 'job__more-summary', 'data-testid': 'driver-details' }, el('span', null, 'Details'), el('span', { class: 'job__more-meta' }, packagesLine(o)), el('span', { class: 'job__more-chevron', 'aria-hidden': 'true' }, icon('chevron-down', 18))),
        detailsBody);
      more.addEventListener('toggle', () => { if (more.open) state.moreOpen.add(o.id); else state.moreOpen.delete(o.id); });
    }
    return el('article', { class: ['card', 'job', hero && 'job--hero', pri.rank < 9 && 'is-priority', state.focusOrder === o.id && 'is-focus'], 'data-testid': 'driver-job', 'data-order-id': o.id, 'data-code': o.code, 'data-status': o.status },
      el('div', { class: 'card__body job__top' },
        el('div', { class: 'job__head' }, el('h3', { class: 'mono mono--code job__code' }, o.code), html(MDM.badgeFor(o.status))),
        tags.length ? el('div', { class: 'job__tags' }, tags) : null,
        meta ? el('div', { class: 'job__meta' }, meta) : null,
        stepsNode(o)),
      el('div', { class: 'card__body job__body job__stops' },
        pickups.length > 1 ? el('div', { class: 'job__multi' }, pickups.every(s => s.status === 'done') ? 'All ' + pickups.length + ' collections done' : 'Collection ' + (pickups.indexOf(showPick) + 1) + ' of ' + pickups.length) : null,
        showPick ? stopBlock(o, showPick, 'Collect from', 'driver-pickup') : null,
        drops.length > 1 ? el('div', { class: 'job__multi' }, 'Delivery ' + (drops.indexOf(showDrop) + 1) + ' of ' + drops.length) : null,
        showDrop ? stopBlock(o, showDrop, showDrop.type === 'return' ? 'Return to' : 'Deliver to', 'driver-drop') : null),
      el('div', { class: 'card__body job__actions' },
        o.status === 'failed' ? officeAlert(o) : null,
        codDue(o) ? MDM.ui.notice('warn', 'Enter it on proof of delivery.', { testid: 'driver-cod', title: 'Collect ' + money(o.cod.amount) + ' in cash' }) : null,
        returning(o) && o.cod && o.cod.amount > 0 && o.cod.status === 'pending' ? el('p', { class: 'job__line', 'data-testid': 'driver-return-cash' }, 'No cash to collect: it goes back to the sender.') : null,
        primary,
        el('div', { class: 'job__links' },
          target ? el('a', { class: 'btn btn--secondary', href: directionsHref(target), target: '_blank', rel: 'noopener', 'data-testid': 'driver-directions' }, icon('navigation', 16), 'Directions') : null,
          el('a', { class: 'btn btn--secondary', href: MDM.href('labels/?order=' + encodeURIComponent(o.id)), 'data-testid': 'driver-label' }, icon('printer', 16), 'Label'),
          canFail ? el('button', { type: 'button', class: 'btn btn--ghost job__problem', 'data-testid': 'driver-problem', on: { click: e => onFailed(e.currentTarget, o, cur) } }, icon('flag', 16), 'Report a problem') : null)),
      methodBlock(o),
      more);
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
  // The business (§5.5) or the office cancelled this order after it was collected: no delivery actions, only bring it back and confirm
  // the return. The store sends the driver a message for either and lists the order in driverRoute().returns.
  function returnCard(o) {
    const c = o.cancellation || {};
    const prev = c.previousStatus || ((o.statusHistory || []).filter(h => h.to === 'cancelled').pop() || {}).from;
    const pick = ((o.route && o.route.stops) || []).find(s => s.type === 'pickup') || null;
    const col = o.collection || {}, pc = (pick && pick.contact) || {};
    const address = col.address || (pick && pick.address) || '';
    const name = col.contactName || pc.name || (o.customer && o.customer.name) || '';
    const phone = col.contactPhone || pc.phone || (o.customer && o.customer.phone) || '';
    const who = c.byBusiness ? (o.customer && o.customer.name) || 'the business' : 'the office';
    const at = c.decidedAt || o.cancelledAt, reason = c.reason || o.cancelReason || '';   // an office cancellation keeps its reason on the order
    const was = prev === 'out_for_delivery' ? 'It was out for delivery. ' : prev === 'collected' ? 'It was already collected. ' : '';
    const meta = [MDM.requestTypeLabel(o.requestType), o.delivery && o.delivery.recipientName ? 'for ' + o.delivery.recipientName : ''].filter(Boolean).join(' · ');
    return el('article', { class: 'card job job--return', 'data-testid': 'driver-return', 'data-order-id': o.id, 'data-code': o.code, 'data-status': o.status },
      el('div', { class: 'card__body job__top' },
        el('div', { class: 'job__head' }, el('h3', { class: 'mono mono--code job__code' }, o.code), html(MDM.badgeFor(o.status))),
        el('div', { class: 'job__meta' }, meta),
        el('div', { class: 'job__returnalert' }, MDM.ui.notice('danger', was + 'Do not deliver it. Bring it back to the sender.' + (reason ? ' Reason: ' + reason + '.' : ''),
          { title: 'Cancelled by ' + who + (at ? ' at ' + MDM.ui.fmtTime(at) : ''), testid: 'driver-return-alert' }))),
      el('div', { class: 'card__body job__body' },
        el('div', { class: 'job__stop', 'data-testid': 'driver-return-to' },
          el('div', { class: 'job__label' }, 'Return to'),
          el('div', { class: 'job__address' }, address),
          col.zone ? el('div', { class: 'job__line' }, [MDM.geo.zoneLabel(col.zone), col.landmark].filter(Boolean).join(' · ')) : null,
          contactRow(name, phone, 'driver-return-contact')),
        el('div', { class: 'job__pkgs job__pkgs--return' },
          el('div', { class: 'job__label' }, 'Package', el('span', { class: 'job__count' }, packagesLine(o))),
          el('ul', { class: 'job__pkglist' }, (o.packages || []).map(p => el('li', null, el('span', { class: 'job__pkgsize' }, sizeName(p.size)), el('span', { class: 'job__pkgtext' }, p.description || 'No description'))))),
        o.cod && o.cod.amount > 0 ? el('p', { class: 'job__line', 'data-testid': 'driver-return-cash' }, 'No cash to collect: the ' + money(o.cod.amount) + ' is cancelled.') : null),
      el('div', { class: 'card__body job__actions' },
        el('button', { type: 'button', class: 'btn btn--primary btn--xl btn--block', 'data-testid': 'driver-return-done', on: { click: e => onReturned(e.currentTarget, o) } }, 'Returned to sender'),
        el('div', { class: 'job__links' },
          pick ? el('a', { class: 'btn btn--secondary', href: directionsHref(pick), target: '_blank', rel: 'noopener', 'data-testid': 'driver-return-directions' }, icon('navigation', 16), 'Directions') : null,
          el('a', { class: 'btn btn--secondary', href: MDM.href('labels/?order=' + encodeURIComponent(o.id)), 'data-testid': 'driver-return-label' }, icon('printer', 16), 'Label'))));
  }
  // When a finished job was finished: the return to the sender for a business cancellation, otherwise the last update.
  const doneAt = o => (o.status === 'cancelled' && o.cancellation && o.cancellation.returnedAt) || o.updatedAt || '';
  function doneAside(o) {
    return (o.status === 'cancelled' ? 'Returned to sender' : MDM.STATUS[o.status].label) + ' ' + MDM.ui.fmtTime(doneAt(o));
  }
  function renderJobs() {
    const active = sortJobs(state.route.orders.filter(o => ACTIVE.indexOf(o.status) >= 0));
    const waiting = state.route.orders.filter(o => o.status === 'failed');
    const returns = state.route.returns || [];
    const parts = [];
    if (!active.length && !waiting.length && !returns.length && !state.upcoming.length) {
      parts.push(el('div', { class: 'empty driver-empty', 'data-testid': 'driver-empty' }, el('div', { class: 'empty__title' }, 'No jobs right now'), el('div', { class: 'empty__hint' }, 'New jobs appear here.')));
    }
    if (returns.length) parts.push(group('Returns', 'Bring each package back to the sender.', el('div', { class: 'jobs-list' }, returns.map(returnCard)), 'driver-returns'));
    // The first active job (priority first, then oldest) is the one to work on now; the rest follow under Next.
    if (active.length) parts.push(el('div', { class: ['jobs-list', returns.length && 'jobs-list--after'], 'data-testid': 'driver-active' },
      el('p', { class: 'jobs-label' }, el('span', { class: 'jobs-label__dot', 'aria-hidden': 'true' }), 'Now'), jobCard(active[0], { hero: true }),
      active.length > 1 ? el('p', { class: 'jobs-label jobs-label--next' }, 'Next · ' + (active.length - 1)) : null,
      active.slice(1).map(o => jobCard(o))));
    if (waiting.length) parts.push(group('Waiting for the office', 'They decide what happens next.', el('div', { class: 'jobs-list' }, waiting.map(o => jobCard(o))), 'driver-waiting-list'));
    if (state.upcoming.length) parts.push(group('Upcoming', null, el('ul', { class: 'card jobs-rows' }, sortJobs(state.upcoming).map(o => compactRow(o, 'Not dispatched yet', 'driver-upcoming'))), 'driver-upcoming-list'));
    if (state.zoneQueue.length) parts.push(group('In your zones', 'At the hub, not assigned yet.', el('ul', { class: 'card jobs-rows' }, state.zoneQueue.map(o => compactRow(o, MDM.geo.zoneShort(o.delivery.zone), 'driver-zone-queue'))), 'driver-zone-list'));
    if (state.doneToday.length) parts.push(group('Done today', null, el('ul', { class: 'card jobs-rows' }, state.doneToday.map(o => compactRow(o, doneAside(o), 'driver-done-today'))), 'driver-done-list'));
    ui.jobs.replaceChildren(...parts);
    const open = state.route.stops.filter(isOpen).length;
    ui.summary.textContent = state.driver ? plural(active.length, 'active job') + (open ? ' · ' + plural(open, 'stop') + ' left' : '') + (returns.length ? ' · ' + plural(returns.length, 'return') : '') + (state.upcoming.length ? ' · ' + state.upcoming.length + ' upcoming' : '') : '';
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
  const hm = m => Math.floor(m / 60) + '\u00a0h ' + String(m % 60).padStart(2, '0') + '\u00a0min';   // "1 h 30 min" never breaks after the number
  function renderDuty() {
    const d = state.driver;
    ui.pick.hidden = !!d;
    ui.duty.hidden = !d;
    ui.jobsSection.hidden = !d;
    ui.mapSection.hidden = !d;
    ui.me.hidden = !d;
    if (!d) { ui.cash.hidden = true; ui.notes.hidden = true; return; }
    ui.name.textContent = d.name;
    const worked = minutesWorked();
    ui.dutyStatus.textContent = state.shift ? 'On duty since ' + MDM.ui.fmtTime(state.shift.inAt) + ' · ' + hm(worked) : (worked ? 'Off duty · ' + hm(worked) + ' today' : 'Off duty');
    ui.dutyStatus.classList.toggle('is-on', !!state.shift);
    ui.punch.textContent = state.shift ? 'Punch out' : 'Punch in';
    ui.punch.className = 'btn btn--lg ' + (state.shift ? 'btn--secondary' : 'btn--primary');
    ui.punch.disabled = !state.staff;
    const vehicle = ({ bike: 'Bike', pickup: 'Pickup truck', car: 'Car', van: 'Van' }[d.vehicle] || '') + (d.vehicleNote ? (d.vehicle ? ', ' : '') + d.vehicleNote : '');
    ui.zones.textContent = [d.zones && d.zones.length ? d.zones.map(z => MDM.geo.zoneShort(z)).join(', ') : '', vehicle].filter(Boolean).join(' · ');
    ui.signedIn.textContent = 'Signed in as ' + d.name;
    renderOffDays();
    renderLeave();
    renderCash();
    renderNotes();
  }
  // Accumulated off days (§7): earned by working the weekly off day, used through approved off_day leave.
  function renderOffDays() {
    const b = state.offDays;
    ui.offDays.hidden = !b;
    if (!b) return;
    ui.offDayBalance.replaceChildren(String(b.balance), el('span', { class: 'driver-offdays__unit' }, b.balance === 1 ? ' day' : ' days'));
    const day = WEEKDAYS[b.weeklyOffDay] || 'the weekly off day';
    const asked = pendingOffDays();
    ui.offDayDetail.textContent = [b.opening ? b.opening + ' carried over' : '', b.earned + ' earned by working on ' + day + 's',
      b.adjust ? (b.adjust > 0 ? '+' : '') + b.adjust + ' adjusted by the office' : '', b.taken + ' taken', overdrawnText(b), asked ? asked + ' requested, waiting for the office' : ''].filter(Boolean).join(' · ');
  }
  // store.offDayBalance().overdrawn: days taken beyond the balance (approved before it was checked). The balance itself stops at 0.
  const overdrawnText = b => b && b.overdrawn > 0 ? 'overdrawn by ' + plural(b.overdrawn, 'day') : '';
  // Off days already asked for and not decided yet. The balance only drops on approval, so these are shown and held back.
  const pendingOffDays = () => state.leaves.filter(l => l.type === 'off_day' && l.status === 'pending').reduce((n, l) => n + (Number(l.days) || 0), 0);
  const LEAVE_KIND = { pending: 'warn', approved: 'ok', rejected: 'danger' };
  const leaveForm = {};
  function renderLeave() {
    const s = state.staff;
    const pending = state.leaves.filter(l => l.status === 'pending').length;
    ui.leaveCount.replaceChildren(pending ? html(MDM.ui.badge('warn', pending + ' pending')) : (state.leaves.length ? plural(state.leaves.length, 'request') : ''));
    const bal = [];
    if (s && s.leaveBalance) bal.push('Annual ' + s.leaveBalance.annual + ' days left', 'Sick ' + s.leaveBalance.sick + ' days left');
    if (state.offDays) bal.push('Accumulated off days ' + state.offDays.balance);
    ui.leaveBalance.textContent = bal.join(' · ');
    ui.leaveBalance.hidden = !bal.length;
    const sorted = state.leaves.slice().sort((a, b) => (a.createdAt || '') < (b.createdAt || '') ? 1 : -1);
    const rows = sorted.map(l => el('li', { class: 'list__item', 'data-testid': 'driver-leave-item', 'data-status': l.status, 'data-type': l.type },
      el('div', { class: 'list__main' },
        el('div', { class: 'list__title' }, optLabel(MDM.LEAVE_TYPES, l.type)),
        el('div', { class: 'list__meta' }, MDM.ui.fmtDate(l.from + 'T00:00', { time: false }) + (l.to !== l.from ? ' to ' + MDM.ui.fmtDate(l.to + 'T00:00', { time: false }) : '') + ' · ' + plural(l.days, 'day') + (l.reason ? ' · ' + l.reason : '')),
        l.remarks ? el('div', { class: 'list__meta' }, 'Office: ' + l.remarks) : null),
      el('div', { class: 'list__aside' }, html(MDM.ui.badge(LEAVE_KIND[l.status] || 'neutral', l.status === 'pending' ? 'Pending' : l.status === 'approved' ? 'Approved' : 'Not approved')))));
    ui.leave.replaceChildren(rows.length ? el('ul', { class: 'driver-leave' }, rows) : el('p', { class: 'driver-duty__line' }, 'No requests yet.'));
    syncLeaveForm();
  }
  // The leave form is built once and lives inside the collapsible section, so a re-render never wipes what the driver typed.
  function buildLeaveForm() {
    const today = MDM.ui.dayKey();
    const f = leaveForm;
    f.type = el('select', { class: 'select', name: 'type', 'data-testid': 'driver-leave-type' }, MDM.LEAVE_TYPES.map(t => el('option', { value: t.value }, t.label)));
    f.from = el('input', { class: 'input', type: 'date', name: 'from', min: today, value: today, 'data-testid': 'driver-leave-from' });
    f.to = el('input', { class: 'input', type: 'date', name: 'to', min: today, value: today, 'data-testid': 'driver-leave-to' });
    f.reason = el('textarea', { class: 'textarea', name: 'reason', rows: 2, 'data-testid': 'driver-leave-reason' });
    f.days = el('span', { class: 'driver-leave__days', role: 'status', 'data-testid': 'driver-leave-days' });
    f.error = el('div', { class: 'driver-leave__error', role: 'alert', 'data-testid': 'driver-leave-error' });
    f.submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'driver-leave-submit' }, 'Send request');
    f.typeField = MDM.ui.field({ name: 'type', label: 'Type', control: f.type, hint: 'The office approves or declines it.' });
    f.form = el('form', { class: 'form driver-leave__form', novalidate: true, 'data-testid': 'driver-leave-form' },
      f.typeField,
      el('div', { class: 'grid-2 grid-2--keep' }, MDM.ui.field({ name: 'from', label: 'From', control: f.from }), MDM.ui.field({ name: 'to', label: 'To', control: f.to })),
      MDM.ui.field({ name: 'reason', label: 'Reason', control: f.reason, optional: true }),
      f.error,
      el('div', { class: 'form-actions driver-leave__actions' }, f.days, f.submit));
    const clearError = () => { f.error.replaceChildren(); };
    f.type.addEventListener('change', () => { clearError(); syncLeaveForm(); });
    f.from.addEventListener('change', () => { if (!f.to.value || f.to.value < f.from.value) f.to.value = f.from.value; f.to.min = f.from.value || today; clearError(); syncLeaveForm(); });
    f.to.addEventListener('change', () => { clearError(); syncLeaveForm(); });
    f.form.addEventListener('submit', e => { e.preventDefault(); submitLeave().catch(err => fail(err, 'Could not send the request')); });
    ui.leaveFormSlot.replaceChildren(f.form);
  }
  function leaveDays() {
    const f = leaveForm;
    if (!f.from.value || !f.to.value || f.to.value < f.from.value) return 0;
    return Math.round((new Date(f.to.value) - new Date(f.from.value)) / 86400000) + 1;
  }
  function syncLeaveForm() {
    const f = leaveForm;
    if (!f.form) return;
    const n = leaveDays();
    f.days.textContent = n ? plural(n, 'day') : '';
    const hint = f.typeField.querySelector('.field__hint');
    const asked = pendingOffDays();
    if (hint) hint.textContent = f.type.value === 'off_day' && state.offDays
      ? 'You have ' + plural(state.offDays.balance, 'accumulated off day') + ' to use' + (asked ? ' (' + asked + ' already requested, waiting for the office)' : '') + '.'
      : 'The office approves or declines it.';
    f.submit.disabled = !state.staff;
  }
  function resetLeaveForm() {
    const f = leaveForm;
    if (!f.form) return;
    const today = MDM.ui.dayKey();
    f.form.reset();
    f.type.value = MDM.LEAVE_TYPES[0].value;
    f.from.value = today; f.to.value = today; f.to.min = today;
    f.error.replaceChildren();
    ['from', 'to'].forEach(n => MDM.ui.setError(f[n], null));
    syncLeaveForm();
  }
  async function submitLeave() {
    const f = leaveForm;
    f.error.replaceChildren();
    if (!state.staff) return;
    const r = MDM.ui.validate(f.form, { from: v => v ? null : 'Choose the first day', to: (v, vals) => !v ? 'Choose the last day' : (v < vals.from ? 'The last day must be on or after the first day' : null) });
    if (!r.ok) { MDM.ui.focusFirstInvalid(f.form); return; }
    // Same rule and wording as store.requestLeave (the balance minus off days already requested); checked here first to add the detail.
    const free = state.offDays ? state.offDays.balance - pendingOffDays() : 0;
    if (f.type.value === 'off_day' && state.offDays && leaveDays() > free) {
      f.error.replaceChildren(MDM.ui.notice('danger', 'Only ' + plural(Math.max(0, free), 'accumulated off day') + ' left to request' + (pendingOffDays() ? ' (' + pendingOffDays() + ' already requested, waiting for the office)' : '') + '.'));
      return;
    }
    MDM.ui.setLoading(f.submit, true);
    try {
      await MDM.store.requestLeave({ staffId: state.staff.id, type: f.type.value, from: f.from.value, to: f.to.value, reason: f.reason.value.trim() });
      MDM.ui.toast('Leave request sent to the office', 'ok');
      resetLeaveForm();
    } catch (e) {
      f.error.replaceChildren(MDM.ui.notice('danger', errMsg(e, 'Could not send the request')));
    }
    MDM.ui.setLoading(f.submit, false);
    syncLeaveForm();
  }

  // ---- Cash on hand (§5.6): cash collected on delivery stays with the driver until the office records the handover ----------
  function renderCash() {
    const held = state.cashHeld, owed = state.owed;
    const due = state.route.orders.filter(o => ACTIVE.indexOf(o.status) >= 0 && codDue(o));
    ui.cash.hidden = !state.driver || (!held.length && !due.length && !owed.length);
    if (ui.cash.hidden) return;
    const total = held.reduce((n, o) => n + (Number(o.cod.collectedAmount) || 0), 0);
    ui.cashTitle.textContent = 'Cash with you: ' + money(total) + (held.length ? ' (' + MDM.ui.plural(held.length, 'order') + ')' : '');
    ui.cashNote.textContent = held.length ? 'Hand it to the office.' : 'Cash you collect shows here.';
    ui.cashList.hidden = !held.length;
    ui.cashList.replaceChildren(...held.map(o => {
      const c = o.cod, diff = c.variance || ((Number(c.collectedAmount) || 0) - (Number(c.amount) || 0));
      return el('li', { class: 'list__item', 'data-testid': 'driver-cash-item', 'data-code': o.code },
        el('div', { class: 'list__main' },
          el('div', { class: 'list__title' }, el('span', { class: 'mono mono--code' }, o.code), o.delivery && o.delivery.recipientName ? ' · ' + o.delivery.recipientName : ''),
          el('div', { class: 'list__meta' }, [o.customer && o.customer.name, c.collectedAt ? 'collected ' + whenText(c.collectedAt) : '', diff ? 'expected ' + money(c.amount) : ''].filter(Boolean).join(' · '))),
        el('div', { class: 'list__aside driver-cash__amount mono' }, money(c.collectedAmount)));
    }));
    const dueTotal = due.reduce((n, o) => n + o.cod.amount, 0);
    ui.cashPending.hidden = !due.length;
    ui.cashPending.textContent = due.length ? 'Still to collect: ' + money(dueTotal) + ' on ' + plural(due.length, 'job') : '';
    // §6.1 reconciliation: naalu and other charges the driver paid out of pocket, until the office reimburses them.
    const owedTotal = owed.reduce((n, x) => n + (Number(x.charge.amount) || 0), 0);
    const owedJobs = new Set(owed.map(x => x.order.id)).size;
    ui.cashOwed.hidden = !owed.length;
    const kinds = ['naalu', 'packing', 'cargo', 'other'].filter(t => owed.some(x => x.charge.type === t)).map(t => ({ naalu: 'naalu', packing: 'packing', cargo: 'Maldivian Cargo charges', other: 'other charges' })[t]);
    const kindText = kinds.length > 1 ? kinds.slice(0, -1).join(', ') + ' and ' + kinds[kinds.length - 1] : kinds[0] || 'charges';
    ui.cashOwed.textContent = owed.length ? 'Paid by you, to be reimbursed: ' + money(owedTotal) + ' (' + kindText + ' on ' + plural(owedJobs, 'job') + ')' : '';
  }

  // ---- Messages from the office (§5.5 cancellations, boat changes): notifications with audience 'driver' sent to this phone ----
  const NOTE_LIMIT = 5;
  function readIds() {
    const ids = new Set(state.readMem[state.driverId] || []);
    try { const all = JSON.parse(localStorage.getItem(READ_KEY) || '{}'); ((all && all[state.driverId]) || []).forEach(id => ids.add(id)); } catch (e) { /* storage blocked: memory only */ }
    return ids;
  }
  function saveRead(ids) {
    const arr = Array.from(ids).slice(-300);
    state.readMem[state.driverId] = arr;
    try { const all = JSON.parse(localStorage.getItem(READ_KEY) || '{}') || {}; all[state.driverId] = arr; localStorage.setItem(READ_KEY, JSON.stringify(all)); } catch (e) { /* storage blocked: kept for this visit */ }
  }
  function noteItem(n, unread) {
    return el('li', { class: ['list__item', 'driver-note', unread && 'is-unread'], 'data-testid': 'driver-note', 'data-note-id': n.id, 'data-code': n.code || null, 'data-unread': unread ? 'true' : 'false' },
      el('button', { type: 'button', class: 'driver-note__btn', on: { click: () => openNote(n) } },
        el('span', { class: 'driver-note__dot', 'aria-hidden': 'true' }),
        el('span', { class: 'driver-note__main' },
          el('span', { class: 'driver-note__title' }, n.title || 'Message', unread ? el('span', { class: 'sr-only' }, ' (new)') : null),
          el('span', { class: 'driver-note__msg' }, n.message || ''),
          el('span', { class: 'driver-note__time' }, MDM.ui.timeAgo(n.at)))));
  }
  function renderNotes() {
    const list = state.notes;
    ui.notes.hidden = !state.driver || !list.length;
    if (ui.notes.hidden) return;
    const read = readIds();
    const unread = list.filter(n => !read.has(n.id)).length;
    ui.notesUnread.replaceChildren(unread ? html(MDM.ui.badge('danger', unread + ' new')) : '');
    ui.notesRead.hidden = !unread;
    ui.notesMore.hidden = list.length <= NOTE_LIMIT;
    ui.notesFoot.hidden = ui.notesRead.hidden && ui.notesMore.hidden;
    const shown = state.notesAll ? list : list.slice(0, NOTE_LIMIT);
    const active = document.activeElement, focusedId = ui.notesList.contains(active) && active.closest('[data-note-id]') ? active.closest('[data-note-id]').dataset.noteId : null;
    ui.notesList.replaceChildren(...shown.map(n => noteItem(n, !read.has(n.id))));
    const refocus = focusedId ? ui.notesList.querySelector('[data-note-id="' + focusedId + '"] button') : null;
    if (refocus) { try { refocus.focus({ preventScroll: true }); } catch (e) { refocus.focus(); } }
    ui.notesMore.textContent = state.notesAll ? 'Show the latest ' + NOTE_LIMIT : 'Show all ' + list.length + ' messages';
  }
  function openNote(n) {
    const read = readIds(); read.add(n.id); saveRead(read);
    renderNotes();
    const card = n.orderId ? ui.jobs.querySelector('[data-order-id="' + n.orderId + '"]') : null;
    const target = card || ui.notesList.querySelector('[data-note-id="' + n.id + '"] button');
    if (!target) return;
    if (card && card.tabIndex < 0) card.tabIndex = -1;
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    if (card) MDM.ui.scrollIntoViewIfNeeded(card, 'start');
  }
  function markAllRead() {
    const read = readIds(); state.notes.forEach(n => read.add(n.id)); saveRead(read);
    renderNotes();
    const h = q('#driver-notes-title'); h.tabIndex = -1;
    try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); }
  }
  // A message that arrives while the console is open also shows as a toast.
  function announceNew(list) {
    const ids = new Set(list.map(n => n.id));
    if (state.noteIds) {
      const read = readIds();
      const fresh = list.filter(n => !state.noteIds.has(n.id) && !read.has(n.id));
      if (fresh.length) MDM.ui.toast(fresh[0].title + '. ' + fresh[0].message + (fresh.length > 1 ? ' (+' + (fresh.length - 1) + ' more)' : ''), 'warn');
    }
    state.noteIds = ids;
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
    ui.simulate.hidden = !!MDM.store._live;   // route simulation is a demo tool
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
  function renderStatus() {
    const t = statusText();
    if (ui.status.textContent !== t) ui.status.textContent = t;
    const on = !!(state.driver && state.online);
    ui.status.classList.toggle('is-online', on);
    ui.status.classList.toggle('is-live', on && !!(state.sim || state.gpsOn));
  }
  function hideGpsAlert() { ui.gpsAlert.hidden = true; ui.gpsAlert.replaceChildren(); }
  function showGpsError(err) {
    const code = err && err.code;
    const sim = MDM.store._live ? '' : ', or use Simulate route for the demo';
    const msg = code === 1 ? 'Location permission is off. Allow location for this site in your browser settings' + sim + '.'
      : code === 'insecure' ? 'Location sharing needs an https address (it works on the published site).'
      : code === 'unsupported' ? 'This browser cannot share location' + (sim ? '. Use Simulate route for the demo.' : '.')
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
  // The office or the business can cancel, close or move a job while one of its dialogs is open. Re-read it before saving, so a
  // collection is never recorded on a cancelled order and the driver gets a plain instruction instead of a status error. The store
  // refuses the same writes (setStop on a cancelled, delivered or returned order); this check comes first so the wording is the driver's.
  async function stillYours(o) {
    const cur = await MDM.store.get('orders', o.id);
    let msg = '';
    if (!cur) msg = o.code + ' is no longer in the system. Call the office.';
    else if (cur.status === 'cancelled') {
      const c = cur.cancellation || {};
      const who = c.byBusiness ? 'the business' : 'the office';
      const held = ((cur.route && cur.route.stops) || []).some(s => s.type === 'pickup' && s.status === 'done');
      msg = c.returnStatus === 'pending' ? o.code + ' was cancelled by ' + who + '. Do not deliver it: bring the package back to the sender (see Returns).'
        : held ? o.code + ' was cancelled by ' + who + '. Do not deliver it: call the office about the package you have.'
        : o.code + ' was cancelled by ' + who + ' before collection. Do not collect it.';
    } else if (cur.status === 'delivered' || cur.status === 'returned') msg = o.code + ' is already ' + (cur.status === 'delivered' ? 'delivered' : 'returned to the sender') + '. Nothing more to do on it.';
    else if (cur.driverId !== state.driverId) msg = o.code + ' was moved to another driver by the office.';
    if (msg) { MDM.ui.toast(msg, 'warn'); requestRender(); return false; }
    return true;
  }
  async function run(btn, o, fn, okMsg, fallback, opts) {
    btn.disabled = true; state.focusOrder = o.id;
    if (!(opts && opts.anyStatus) && !(await stillYours(o))) { state.focusOrder = null; btn.disabled = false; return null; }
    try { const r = await fn(); if (okMsg) MDM.ui.toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok'); return r; }
    catch (e) { state.focusOrder = null; btn.disabled = false; fail(e, fallback); return null; }
  }
  function onStart(btn, o) { return run(btn, o, () => MDM.store.startRoute(o.id, { by: by() }), o.code + ': on the way to collect', 'Could not start'); }
  function onArrived(btn, o, stop) { return run(btn, o, () => MDM.store.setStop(o.id, stop.id, { status: 'arrived', by: by() }), null, 'Could not update the stop'); }
  function onOut(btn, o) { return run(btn, o, () => MDM.store.outForDelivery(o.id, { by: by() }), o.code + ': out for delivery', 'Could not update the order'); }
  // A small group heading inside a dialog built by MDM.ui.dialog (which only lays out fields), placed before the named field.
  function dialogHeading(fieldName, text) {
    const wrap = document.querySelector('dialog[open] [data-field="' + fieldName + '"]');
    if (wrap) wrap.parentNode.insertBefore(el('h3', { class: 'driver-dlg-group' }, text), wrap);
  }
  const amountOrNote = (amountKey, noteKey, msg) => vals => vals[noteKey] && !(Number(vals[amountKey]) > 0) ? { [amountKey]: msg } : null;
  // Money fields take whole MVR. A number input that holds text the browser cannot read ("1e", "--") reports an empty value, so
  // without this check a mistyped naalu or packing charge would be dropped silently and the job closed without it.
  const wholeMvr = (name, laari) => v => {
    const input = document.querySelector('dialog[open] [data-testid="dialog-' + name + '"]');
    if (input && input.validity && input.validity.badInput) return 'Enter the amount as a number, for example 20';
    return !laari && v != null && !isNaN(v) && !Number.isInteger(v) ? 'Enter a whole amount in MVR, without laari' : null;
  };
  // Collected: proof photo is required; the driver can correct each package's category (Bag / Box / XL, no measurements: §2.2, §2.3)
  // and record a naalu paid to collect it from a boat (§6.1).
  async function onCollected(btn, o, stop) {
    const pkgs = (o.packages || []).filter(p => (stop.packageIds || [stop.packageId]).indexOf(p.id) >= 0);
    const fields = [];
    if (stop.shop) {
      const sh = shopOf(o, stop);
      fields.push({ name: 'receiptTotal', label: 'Receipt total (MVR)', type: 'number', required: true, min: 0, step: 'any', inputmode: 'decimal', validate: wholeMvr('receiptTotal', true), hint: sh ? 'Budget ' + MDM.pricing.format(sh.budget) : null, requiredMessage: 'Enter the receipt total' });
      fields.push({ name: 'receiptPhoto', label: 'Receipt photo', type: 'file', required: true, accept: 'image/*', capture: 'environment', buttonLabel: 'Take a photo', requiredMessage: 'Take a photo of the receipt' });
    }
    // No customer photo (updates 17/10/2026): the office sets this order's price from the proof of collection. An extra collection
    // stop has no package of its own yet (it is packed with the rest), so it only needs a photo of what was collected.
    const photoHint = stop.collectionId && !stop.shop ? 'What you collected, packed with the rest.'
      : MDM.priceAfterCollection(o) ? 'The office prices the order from this photo.' : 'The office uses it to confirm the price.';
    fields.push({ name: 'photo', label: 'Proof of collection', type: 'file', required: !stop.shop, accept: 'image/*', capture: 'environment', buttonLabel: 'Take a photo', hint: photoHint, requiredMessage: 'Take a photo of the package' });
    pkgs.forEach((p, i) => {
      const n = pkgs.length > 1 ? ' ' + (i + 1) : '';
      fields.push({ name: 'size_' + i, label: 'Package' + n + ' category', type: 'segmented', required: true, value: p.size, options: Object.keys(MDM.pricing.SIZES).map(k => ({ value: k, label: MDM.pricing.SIZES[k] })),
        hint: i === pkgs.length - 1 ? 'Change it if it does not fit. No measuring.' : null });
    });
    fields.push({ name: 'naalu', label: 'Naalu paid at collection (MVR)', type: 'number', required: false, min: 0, step: 1, placeholder: '0', validate: wholeMvr('naalu'),
      hint: 'Only if you paid a crew or porters.' });
    fields.push({ name: 'naaluNote', label: 'Naalu note', type: 'text', required: false, autocomplete: 'off', placeholder: 'e.g. Dhoni crew, North Harbour' });
    fields.push({ name: 'remarks', label: 'Remarks', type: 'textarea', required: false, rows: 2 });
    const p = MDM.ui.dialog({ title: stop.shop ? 'Shopping done' : 'Collected', message: o.code + ' · ' + addressText(o, stop), fields,
      validate: amountOrNote('naalu', 'naaluNote', 'Enter the naalu you paid, or clear the note'), okLabel: 'Confirm collection' });
    dialogHeading('naalu', 'Paid at collection');
    const v = await p;
    if (!v || !(await stillYours(o))) return;
    btn.disabled = true;
    const patch = { status: 'done', by: by(), remarks: v.remarks || '' };
    try {
      if (v.photo) patch.photoId = await storePhoto(v.photo, 'proof_collection', o.id);
      if (stop.shop) { patch.receiptTotal = v.receiptTotal; patch.receiptPhotoId = await storePhoto(v.receiptPhoto, 'receipt', o.id); if (!patch.photoId) patch.photoId = patch.receiptPhotoId; }
    } catch (e) { btn.disabled = false; fail(e, 'Could not save the photo'); return; }
    const sizes = {};
    pkgs.forEach((p, i) => { const size = v['size_' + i]; if (size && size !== p.size) sizes[p.id] = { size }; });
    if (Object.keys(sizes).length) patch.sizes = sizes;
    const naalu = Number(v.naalu) > 0 ? Math.round(v.naalu) : 0;
    if (naalu) { patch.naalu = naalu; patch.naaluNote = v.naaluNote || ''; }
    const extra = [Object.keys(sizes).length ? 'category changed' : '', naalu ? 'naalu ' + money(naalu) + ' at collection recorded' : ''].filter(Boolean).join(', ');
    const r = await run(btn, o, () => MDM.store.setStop(o.id, stop.id, patch), x => (x.status === 'collected' ? o.code + ' collected' : 'Collection saved') + (extra ? ': ' + extra : ''), 'Could not save the collection');
    if (r) resumeSimAt(stop.id);
  }
  // Delivered: proof, then the money (§5.6, §6): cash collected (required when there is cash on delivery), naalu paid at delivery and a
  // packing charge that goes on the customer's bill.
  async function onDelivered(btn, o, stop) {
    const isReturn = stop.type === 'return';
    const cod = !isReturn && codDue(o) ? o.cod.amount : 0;
    const nameField = { name: 'recipientName', label: isReturn ? 'Received by' : 'Recipient name', type: 'text', required: true, autocomplete: 'off', value: !isReturn && stop.contact && stop.contact.name ? stop.contact.name : '', hint: 'Not needed when left as instructed.', requiredMessage: 'Enter who received it' };
    const fields = [
      { name: 'handedTo', label: 'Handed to', type: 'segmented', required: true, value: 'recipient', options: MDM.HANDED_TO },
      nameField,
      { name: 'confirmed', label: 'The recipient confirmed they received it', type: 'checkbox', value: false },
      { name: 'photo', label: 'Proof of delivery', type: 'file', required: false, accept: 'image/*', capture: 'environment', buttonLabel: 'Take a photo', hint: 'Needed if nobody confirms in person.' },
    ];
    if (cod) fields.push({ name: 'cashCollected', label: 'Cash collected (MVR)', type: 'number', required: true, min: 0, step: 1, placeholder: String(cod), validate: wholeMvr('cashCollected'),
      hint: 'Amount to collect: ' + money(cod), requiredMessage: 'Enter the cash you collected (amount to collect: ' + money(cod) + '). Enter 0 if the receiver did not pay.' });
    // Maldivian Cargo (updates 17/10/2026): the counter's bill, paid by the driver, goes on the customer's delivery charges with its photo.
    const cargo = !isReturn && (o.delivery || {}).method === 'cargo';
    if (cargo) {
      fields.push({ name: 'cargoCharge', label: 'Maldivian Cargo charges (MVR)', type: 'number', required: false, min: 0, step: 1, placeholder: '0', validate: wholeMvr('cargoCharge'),
        hint: 'From their bill. Added to the customer\'s charges.' });
      fields.push({ name: 'cargoBill', label: 'Maldivian Cargo bill', type: 'file', required: false, accept: 'image/*', capture: 'environment', buttonLabel: 'Take a photo', hint: 'Needed when you enter the charges.' });
      fields.push({ name: 'cargoNote', label: 'Cargo note', type: 'text', required: false, autocomplete: 'off', placeholder: 'e.g. Bill MC-204517' });
    }
    fields.push({ name: 'naalu', label: 'Naalu paid at delivery (MVR)', type: 'number', required: false, min: 0, step: 1, placeholder: '0', validate: wholeMvr('naalu'),
      hint: 'Only if you paid a crew or porters.' });
    fields.push({ name: 'naaluNote', label: 'Naalu note', type: 'text', required: false, autocomplete: 'off', placeholder: 'e.g. Speedboat crew' });
    if (!isReturn) {
      fields.push({ name: 'packing', label: 'Packing charge (MVR)', type: 'number', required: false, min: 0, step: 1, placeholder: '0', validate: wholeMvr('packing'), hint: 'Added to the customer\'s bill.' });
      fields.push({ name: 'packingNote', label: 'Packing note', type: 'text', required: false, autocomplete: 'off', placeholder: 'e.g. Bubble wrap and a box' });
    }
    fields.push({ name: 'remarks', label: 'Remarks', type: 'textarea', required: false, rows: 2 });
    const p = MDM.ui.dialog({ title: isReturn ? 'Returned to sender' : 'Delivered', message: o.code + ' · ' + addressText(o, stop), fields,
      validate: vals => {
        if (!vals.photo && !vals.confirmed) return { photo: 'Take a photo, or tick that the recipient confirmed' };
        if (cargo && Number(vals.cargoCharge) > 0 && !vals.cargoBill) return { cargoBill: 'Take a photo of the Maldivian Cargo bill' };
        return (cargo ? amountOrNote('cargoCharge', 'cargoNote', 'Enter the Maldivian Cargo charges, or clear the note')(vals) : null)
          || amountOrNote('naalu', 'naaluNote', 'Enter the naalu you paid, or clear the note')(vals) || (isReturn ? null : amountOrNote('packing', 'packingNote', 'Enter the packing charge, or clear the note')(vals));
      },
      okLabel: isReturn ? 'Confirm return' : 'Confirm delivery' });
    const seg = document.querySelector('dialog[open] [data-testid="dialog-handedTo"]');
    if (seg) {
      seg.classList.add('segmented--stack');
      seg.addEventListener('change', () => { const c = seg.querySelector('input:checked'); nameField.required = !(c && c.value === 'left'); });
    }
    dialogHeading(cod ? 'cashCollected' : cargo ? 'cargoCharge' : 'naalu', cod ? 'Cash and charges' : 'Charges');
    if (cod) {
      // A different amount is allowed (the receiver paid part, or nothing) but called out, and the office is told about the difference.
      const wrap = document.querySelector('dialog[open] [data-field="cashCollected"]');
      const input = wrap && wrap.querySelector('input');
      if (input) {
        const warn = el('div', { class: 'driver-cash-warn', role: 'status', 'data-testid': 'driver-cash-warn', hidden: true });
        wrap.appendChild(warn);
        input.addEventListener('input', () => {
          const raw = input.value.trim(), got = Math.round(Number(raw));
          const show = raw !== '' && !isNaN(got) && got !== cod;
          warn.hidden = !show;
          warn.textContent = show ? (got === 0 ? 'No cash collected. ' : 'Different from the ' + money(cod) + ' to collect. ') + 'You can still save; the office is told about the difference.' : '';
        });
      }
    }
    const v = await p;
    if (!v || !(await stillYours(o))) return;
    btn.disabled = true;
    const patch = { status: 'done', by: by(), handedTo: v.handedTo, recipientName: v.recipientName || '', confirmed: !!v.confirmed, remarks: v.remarks || '' };
    if (cod) patch.cashCollected = Math.round(Number(v.cashCollected) || 0);
    if (Number(v.naalu) > 0) { patch.naalu = Math.round(v.naalu); patch.naaluNote = v.naaluNote || ''; }
    if (!isReturn && Number(v.packing) > 0) { patch.packing = Math.round(v.packing); patch.packingNote = v.packingNote || ''; }
    if (cargo && Number(v.cargoCharge) > 0) { patch.cargoCharge = Math.round(v.cargoCharge); patch.cargoNote = v.cargoNote || ''; }
    try {
      if (v.photo) patch.photoId = await storePhoto(v.photo, 'proof', o.id);
      if (patch.cargoCharge) patch.cargoBillPhotoId = await storePhoto(v.cargoBill, 'cargo_bill', o.id);
    } catch (e) { btn.disabled = false; fail(e, 'Could not save the photo'); return; }
    const cashText = (cod ? (patch.cashCollected > 0 ? ', cash ' + money(patch.cashCollected) + ' with you' : ', no cash collected') : '')
      + (patch.cargoCharge ? ', Maldivian Cargo charges ' + money(patch.cargoCharge) + ' added to the bill' : '');
    const r = await run(btn, o, () => MDM.store.setStop(o.id, stop.id, patch), x => (x.status === 'delivered' ? o.code + ' delivered' : x.status === 'returned' ? o.code + ' returned to sender' : 'Delivery saved') + cashText, 'Could not save the delivery');
    if (r) resumeSimAt(stop.id);
  }
  // Boat details change after booking (§5.3 note): the speedboat changed, the departure moved, or the driver missed it.
  async function onBoatUpdate(btn, o) {
    const b = (o.delivery && o.delivery.boat) || {};
    const jetties = MDM.geo.jetties().map(t => ({ value: t.value, label: t.label }));
    const KEYS = ['vesselType', 'name', 'departureDate', 'departureTime', 'jetty'];
    const p = MDM.ui.dialog({ title: 'Update boat details', message: o.code + ' · the office' + (o.accountId ? ', the business' : '') + ' and the customer see the new boat.',
      fields: [
        { name: 'reason', label: 'What happened', type: 'segmented', required: true, options: MDM.BOAT_CHANGE_REASONS, requiredMessage: 'Choose what happened' },
        { name: 'vesselType', label: 'Vessel type', type: 'select', required: true, value: b.vesselType || 'speedboat', options: MDM.VESSEL_TYPES },
        { name: 'name', label: 'Boat, ferry or speedboat name', type: 'text', required: true, autocomplete: 'off', value: b.name || '', requiredMessage: 'Enter the name of the boat' },
        { name: 'departureDate', label: 'Departure date', type: 'date', required: false, value: b.departureDate || '' },
        { name: 'departureTime', label: 'Departure time', type: 'time', required: true, value: b.departureTime || '', requiredMessage: 'Enter the departure time' },
        { name: 'jetty', label: 'Harbour or jetty', type: 'select', required: true, value: b.jetty || jetties[0].value, options: jetties },
        { name: 'note', label: 'Note', type: 'textarea', required: false, rows: 2, placeholder: 'e.g. The 17:00 was full' },
      ],
      validate: vals => {
        if (vals.reason === 'other' && !vals.note) return { note: 'Tell the office what changed' };
        return KEYS.every(k => String(vals[k] || '') === String(b[k] || '')) ? 'Nothing changed yet. Edit the boat details, or cancel.' : null;
      },
      okLabel: 'Save boat details' });
    const seg = document.querySelector('dialog[open] [data-testid="dialog-reason"]');
    if (seg) seg.classList.add('segmented--stack');
    const v = await p;
    if (!v) return;
    const boat = {};
    KEYS.forEach(k => { boat[k] = v[k] || ''; });
    await run(btn, o, () => MDM.store.updateBoat(o.id, boat, { reason: v.reason, note: v.note || '', by: by() }), o.code + ': boat details updated, the office has been told', 'Could not update the boat details');
  }
  // Returned to sender (§5.5): closes a business cancellation after the driver hands the package back.
  async function onReturned(btn, o) {
    const col = o.collection || {};
    const v = await MDM.ui.dialog({ title: 'Returned to sender', message: o.code + (col.address ? ' · ' + col.address : ''),
      fields: [
        { name: 'receivedBy', label: 'Received by', type: 'text', required: false, autocomplete: 'off', value: col.contactName || '' },
        { name: 'note', label: 'Remarks', type: 'textarea', required: false, rows: 2 },
      ],
      okLabel: 'Confirm return' });
    if (!v) return;
    const note = [v.receivedBy ? 'received by ' + v.receivedBy : '', v.note].filter(Boolean).join('. ');
    await run(btn, o, () => MDM.store.markReturned(o.id, { note, by: by() }), o.code + ' returned to the sender', 'Could not confirm the return', { anyStatus: true });
  }
  // Failed collection or delivery (client requirements §14): reason, remarks, optional photo; the office decides what happens next.
  async function onFailed(btn, o, stop) {
    const v = await MDM.ui.dialog({ title: stop.type === 'pickup' ? 'Collection problem' : 'Delivery problem', message: 'The office decides what happens next.',
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
    state.noteIds = null; state.notesAll = false; state.entered = false; state.moreOpen.clear();
    map.fitted = false;
    ui.leaveSection.open = false;
    resetLeaveForm();
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
    let route = { orders: [], stops: [], polyline: [], returns: [] }, upcoming = [], done = [], zoneQueue = [], staff = null, shift = null, today = [], leaves = [], batches = {};
    let offDays = null, cashHeld = [], owed = [], notes = [];
    if (driver) {
      const today0 = new Date(); today0.setHours(0, 0, 0, 0);
      const [r, mine, collected, st, bl, nt] = await Promise.all([
        MDM.store.driverRoute(driver.id),
        MDM.store.list('orders', { where: { driverId: driver.id } }),
        MDM.store.list('orders', { where: { status: 'collected' } }),
        driver.staffId ? MDM.store.get('staff', driver.staffId) : null,
        MDM.store.list('batches'),
        MDM.store.list('notifications', { where: { audience: 'driver' } }),
      ]);
      route = r; staff = st;
      upcoming = mine.filter(o => o.status === 'assigned');
      const returnedToday = o => o.status === 'cancelled' && o.cancellation && o.cancellation.returnStatus === 'done' && o.cancellation.returnedAt && new Date(o.cancellation.returnedAt) >= today0;
      done = mine.filter(o => ((o.status === 'delivered' || o.status === 'returned') && new Date(o.updatedAt) >= today0) || returnedToday(o)).sort((a, b) => doneAt(a) < doneAt(b) ? 1 : -1);
      mine.forEach(o => (o.charges || []).forEach(c => { if (c.paidBy === 'driver' && !c.void && !c.reimbursedAt && c.amount > 0 && (!/^driver:/.test(c.by || '') || c.by === 'driver:' + driver.id)) owed.push({ order: o, charge: c }); }));
      cashHeld = mine.filter(o => o.cod && o.cod.status === 'collected').sort((a, b) => (a.cod.collectedAt || '') < (b.cod.collectedAt || '') ? 1 : -1);
      zoneQueue = collected.filter(o => o.batchId && !o.driverId && o.delivery && (driver.zones || []).indexOf(o.delivery.zone) >= 0);
      bl.forEach(b => { batches[b.id] = b; });
      const phone = MDM.ui.phone.normalize(driver.phone) || driver.phone;
      notes = nt.filter(n => n.to === driver.phone || MDM.ui.phone.normalize(n.to) === phone).sort((a, b) => (a.at || '') < (b.at || '') ? 1 : -1);
      if (staff) {
        [shift, today, leaves, offDays] = await Promise.all([
          MDM.store.openShift(staff.id),
          MDM.store.list('attendance', { where: { staffId: staff.id, date: MDM.ui.dayKey() } }),
          MDM.store.list('leaves', { where: { staffId: staff.id } }),
          MDM.store.offDayBalance(staff.id).catch(() => null),
        ]);
      }
    }
    if (seq !== state.renderSeq) return;
    Object.assign(state, { drivers, settings: settings || {}, driver, route, upcoming, doneToday: done, zoneQueue, staff, shift, today, leaves, batches, offDays, cashHeld, owed, notes });
    if (driver) announceNew(notes);
    if (!driver && state.driverId) { state.driverId = null; writeSession(); watchPositions(); }
    const wasOnline = state.online;
    state.online = !!driver && driver.status !== 'offline';
    if (state.online !== wasOnline) { writeSession(); if (state.online) keepAwake(); else { letSleep(); stopSim(); stopGps(); } }
    renderDuty(); renderControls(); renderStatus(); renderJobs();
    // The console eases in once per driver; live re-renders after that swap content in place.
    if (driver && !state.entered) { state.entered = true; MDM.motion.enter(q('.driver'), { selector: ':scope > section:not([hidden])', max: 6 }); }
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
    buildLeaveForm();
    ui.notesRead.addEventListener('click', markAllRead);
    ui.notesMore.addEventListener('click', () => { state.notesAll = !state.notesAll; renderNotes(); });
    ui.switchBtn.addEventListener('click', () => { selectDriver('').catch(e => { setTimeout(() => { throw e; }, 0); }); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.online) keepAwake(); });
    window.addEventListener('storage', e => { if (e.key === READ_KEY) renderNotes(); });
    const WATCH = ['orders', 'drivers', 'attendance', 'leaves', 'staff', 'batches', 'notifications'];
    MDM.store.subscribe('*', msg => { if (msg && (msg.op === 'reset' || msg.op === 'refresh' || WATCH.indexOf(msg.collection) >= 0)) requestRender(); });
    setInterval(renderStatus, 1000);
    setInterval(() => { if (state.driver) renderDuty(); }, 60000);
    watchPositions();
    await render();
  }
  main();
})(window.MDM);

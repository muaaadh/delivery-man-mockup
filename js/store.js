// Data layer. Everything the pages read or write goes through MDM.store; nothing else touches localStorage.
//
// Swapping this for a real backend (Supabase) later:
//   collection            → Postgres table of the same name (orders, batches, customers, drivers, staff, zones, attendance, leaves,
//                           products, notifications, business_requests, business_accounts, invoices, positions, events, files);
//                           `files.dataUrl` → a Storage bucket object, keep the metadata row
//   get / list({where})   → .select().eq()/.in() ; order → .order(); limit → .limit()
//   insert / update       → .insert() / .update().eq('id', id)   (update is a shallow merge at the top level, same as here)
//   subscribe(col, cb)    → supabase.channel('mdm:' + col).on('postgres_changes', …) ; positions → one row per driver, upserted at 1 Hz
//   domain functions      → server-side functions (RPC) so the order, payment and HR state machines have one implementation;
//                           every one of them writes an audit event with who did it and when
//   notifications         → a queue table read by an SMS / WhatsApp / email sender; here they are only logged
//   settings              → a single-row table; codes (MDM-1042, BLK-1001, INV-2026-09-001) → sequences
// Every method already returns a Promise, so pages will not change.
(function (MDM) { 'use strict';

  const PREFIX = 'mdm:v' + MDM.SCHEMA + ':';
  const COLLECTIONS = ['orders', 'batches', 'customers', 'drivers', 'staff', 'zones', 'attendance', 'leaves', 'products', 'notifications',
    'business_requests', 'business_accounts', 'invoices', 'positions', 'events', 'files'];
  const ID_PREFIX = { orders: 'ord', batches: 'blk', customers: 'cus', drivers: 'drv', staff: 'stf', zones: 'zon', attendance: 'att', leaves: 'lv', products: 'prd', notifications: 'ntf', business_requests: 'breq', business_accounts: 'bacc', invoices: 'inv', positions: 'pos', events: 'evt', files: 'file' };
  const EVENT_CAP = 1500, NOTIFY_CAP = 600;
  const RESEED_AFTER_MS = 12 * 60 * 60 * 1000;

  class StoreError extends Error { constructor(code, message) { super(message || code); this.code = code; this.name = 'StoreError'; } }
  MDM.StoreError = StoreError;

  // ---- Order lifecycle (client requirements §7, §13; How it works §5) ---------------------------------------------------
  MDM.STATUS = {
    requested:        { label: 'Requested',              customer: 'Request received',                 kind: 'warn' },
    confirmed:        { label: 'Confirmed',              customer: 'Order confirmed',                  kind: 'info' },
    assigned:         { label: 'Driver assigned',        customer: 'Driver assigned',                  kind: 'info' },
    dispatched:       { label: 'Dispatched',             customer: 'Dispatched',                       kind: 'info' },
    on_the_way:       { label: 'On the way',             customer: 'Driver on the way to collect',     kind: 'info' },
    arrived:          { label: 'Arrived for collection', customer: 'Driver at the collection point',   kind: 'info' },
    collected:        { label: 'Collected',              customer: 'Collected',                        kind: 'info' },
    out_for_delivery: { label: 'Out for delivery',       customer: 'Out for delivery',                 kind: 'info' },
    delivered:        { label: 'Delivered',              customer: 'Delivered',                        kind: 'ok' },
    failed:           { label: 'Failed',                 customer: 'There was a problem, we will contact you', kind: 'danger' },
    returned:         { label: 'Returned',               customer: 'Returned to sender',               kind: 'neutral' },
    cancelled:        { label: 'Cancelled',              customer: 'Cancelled',                        kind: 'danger' },
  };
  // The forward path every order follows; bulk business packages skip assigned/dispatched/on_the_way/arrived (collected at the hub).
  MDM.FLOW = ['requested', 'confirmed', 'assigned', 'dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery', 'delivered'];
  MDM.BULK_FLOW = ['confirmed', 'collected', 'out_for_delivery', 'delivered'];
  MDM.ACTIVE_STATUSES = ['assigned', 'dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery', 'failed'];
  MDM.CANCELLABLE = ['requested', 'confirmed', 'assigned', 'dispatched', 'on_the_way', 'arrived'];   // customers may ask until collection
  MDM.ALLOWED = {
    requested: ['confirmed', 'assigned', 'cancelled'],   // assigned: no package photo, so the price is set from the proof of collection
    confirmed: ['assigned', 'collected', 'cancelled'],
    assigned: ['dispatched', 'confirmed', 'cancelled'],
    dispatched: ['on_the_way', 'assigned', 'failed', 'cancelled'],
    on_the_way: ['arrived', 'collected', 'failed', 'cancelled'],
    arrived: ['collected', 'on_the_way', 'failed', 'cancelled'],   // on_the_way: on to the next collection of a multi-collection order
    collected: ['out_for_delivery', 'failed', 'cancelled'],
    out_for_delivery: ['delivered', 'failed', 'returned', 'cancelled'],   // cancelled: a business cancels after dispatch, the package comes back
    failed: ['dispatched', 'assigned', 'confirmed', 'on_the_way', 'collected', 'out_for_delivery', 'returned', 'cancelled'],
    delivered: [], returned: [], cancelled: [],
  };
  // Payment runs alongside the order (client requirements §4): invoiced after delivery by default, or paid upfront once confirmed.
  MDM.PAYMENT = {
    pending:   { label: 'Payment pending',   kind: 'neutral' },
    requested: { label: 'Payment requested', kind: 'warn' },
    received:  { label: 'Payment received',  kind: 'info' },
    paid:      { label: 'Paid',              kind: 'ok' },
    refunded:  { label: 'Refunded',          kind: 'neutral' },
    invoiced:  { label: 'Monthly invoice',   kind: 'neutral' },
  };
  // Service categories on the home page and the request form (web app updates 11/10/2026 §1).
  MDM.SERVICE_CATEGORIES = [
    { value: 'pick', label: 'Pick & Deliver', hint: 'We collect from a home, a shop or godown, a post or courier office, or a government office, and deliver it', types: ['home', 'shop_collect', 'postal', 'office'] },
    { value: 'shop', label: 'Shop & Deliver', hint: 'Tell us the shop and the items; we buy them and bring them to you', types: ['shop_buy'] },
    { value: 'business', label: 'Business Delivery', hint: 'Fixed rates for your package sizes, bulk orders, cash on delivery and one monthly invoice', types: [] },
  ];
  MDM.REQUEST_TYPES = [
    { value: 'home',         category: 'pick', label: 'Home collection',              hint: 'Collect from a home address' },
    { value: 'shop_collect', category: 'pick', label: 'Shop or godown collection',    hint: 'Collect what you bought from a shop or warehouse; add the invoice or quotation and the payment slip' },
    { value: 'postal',       category: 'pick', label: 'Postal & courier collection',  hint: 'Redbox, Pikpost, Post Office, DHL, FedEx and other couriers' },
    { value: 'office',       category: 'pick', label: 'Administrative services',      hint: 'Collect or submit documents at government offices and ministries' },
    { value: 'shop_buy',     category: 'shop', label: 'Shop & deliver',               hint: 'We buy the items on your list and deliver them' },
    { value: 'airport',      category: 'pick', label: 'Airport & baggage',            hint: 'Older orders only: airport runs are now a delivery method', legacy: true },
  ];
  MDM.requestTypes = category => MDM.REQUEST_TYPES.filter(t => !t.legacy && (!category || t.category === category));
  MDM.categoryOf = type => ((MDM.REQUEST_TYPES.find(t => t.value === type) || {}).category) || (type === 'bulk' || type === 'business' ? 'business' : 'pick');
  // Delivery methods (§3): where the package is handed over.
  MDM.DELIVERY_METHODS = [
    { value: 'home',    label: 'Home delivery',            hint: 'To an address in Malé, Hulhumalé or Villimalé' },
    { value: 'boat',    label: 'Boat, ferry or speedboat', hint: 'Handed to the vessel at the jetty, for another island' },
    { value: 'cargo',   label: 'Maldivian Cargo',          hint: 'To the Maldivian Cargo counter at the main bus terminal' },
    { value: 'airport', label: 'Airport delivery',         hint: 'To a resort counter or meeting point at Velana Airport' },
  ];
  MDM.deliveryMethodLabel = v => ((MDM.DELIVERY_METHODS.find(m => m.value === v) || {}).label) || 'Home delivery';
  MDM.VESSEL_TYPES = [{ value: 'boat', label: 'Boat (dhoni)' }, { value: 'ferry', label: 'Ferry' }, { value: 'speedboat', label: 'Speedboat' }];
  MDM.BOAT_CHANGE_REASONS = [
    { value: 'changed', label: 'Boat or speedboat changed' }, { value: 'missed', label: 'Missed the boat, sending on the next one' },
    { value: 'delayed', label: 'Departure time changed' }, { value: 'other', label: 'Other' },
  ];
  // Business package size categories (§1.3, §5.2). Each business account has agreed rates for some of these.
  MDM.DEFAULT_BUSINESS_TIERS = [
    { value: 'small',  label: 'Small',  size: 'bag', hint: 'Fits in a carrier bag, under about 1 ft (30 cm)', rate: 25 },
    { value: 'medium', label: 'Medium', size: 'box', hint: 'A carton up to about 2 ft (60 cm) a side', rate: 35 },
    { value: 'large',  label: 'Large',  size: 'xl',  hint: 'Bigger or heavy, may need a vehicle', rate: 60 },
  ];
  // Charges recorded on proof of collection / delivery or by the office (§6).
  // cargo: the Maldivian Cargo bill the driver pays at the counter (updates 17/10/2026), always added to the customer's delivery charges.
  MDM.CHARGE_TYPES = [{ value: 'naalu', label: 'Naalu' }, { value: 'packing', label: 'Packing charge' }, { value: 'cargo', label: 'Maldivian Cargo charges' }, { value: 'other', label: 'Other charge' }];
  // Pick & deliver orders without a package photo are collected first; the operator sets the price from the proof of collection
  // (updates 17/10/2026). pricing.afterCollection is fixed when the order is created.
  MDM.priceAfterCollection = o => !!(o && o.pricing && o.pricing.afterCollection && o.pricing.status !== 'confirmed');
  // priceToFinalise(o) → true once the proof of collection is in and the price still waits for the operator.
  MDM.priceToFinalise = o => MDM.priceAfterCollection(o) && ['cancelled', 'returned'].indexOf(o.status) < 0 && ((o.route && o.route.stops) || []).some(s => s.type === 'pickup' && s.status === 'done');
  // Extra collection points on one order (updates 17/10/2026): collect from an address or buy at a shop, all packed together and
  // delivered to the one delivery address. order.extraCollections = [{ id, kind: 'collect'|'shop', address, zone, landmark,
  // contactName, contactPhone, instructions, shop: { name, phone, list, budget, unavailable, receiptTotal, receiptPhotoId } }].
  MDM.EXTRA_COLLECTION_KINDS = [{ value: 'collect', label: 'Collect an item' }, { value: 'shop', label: 'Buy from a shop' }];
  MDM.MAX_EXTRA_COLLECTIONS = 4;
  // Cash on delivery for business orders (§5.6): collected by the driver, handed to the office, paid to the business.
  MDM.COD_STATUS = {
    pending:       { label: 'To collect',           kind: 'warn' },
    collected:     { label: 'With the driver',      kind: 'info' },
    with_office:   { label: 'With the office',      kind: 'info' },
    remitted:      { label: 'Paid to the business', kind: 'ok' },
    not_collected: { label: 'Not collected',        kind: 'danger' },
  };
  MDM.codBadge = function (status) {
    const s = MDM.COD_STATUS[status] || { label: status || 'No cash', kind: 'neutral' };
    return '<span class="badge badge--' + s.kind + '" data-cod="' + esc(status) + '">' + esc(s.label) + '</span>';
  };
  MDM.ADDRESS_LABELS = ['Home', "Wife's home", 'Office', 'Other'];
  MDM.SERVICE_LEVELS = [
    { value: 'normal',  label: 'Normal',        hint: 'On our regular delivery schedule' },
    { value: 'express', label: 'Express',       hint: 'Faster, subject to availability and confirmation' },
    { value: 'advance', label: 'Advance order', hint: 'Choose a future collection and delivery time' },
  ];
  MDM.CARRIERS = [
    { value: 'redbox_maafannu', label: 'Redbox (Maafannu)', zone: 'male', address: 'Redbox collection point, Maafannu' },
    { value: 'redbox_main',     label: 'Redbox (Main office)', zone: 'male', address: 'Redbox main office, Malé' },
    { value: 'pikpost',         label: 'Pikpost', zone: 'male', address: 'Pikpost locker' },
    { value: 'post_office',     label: 'Post Office', zone: 'male', address: 'Maldives Post' },
    { value: 'courier',         label: 'FedEx, CPEX, PDU, UPS, Aramex or other', zone: 'male', address: 'Courier office' },
    { value: 'dhl',             label: 'DHL', zone: 'male', address: 'DHL office, Malé' },
  ];
  MDM.PIKPOST_LOCATIONS = [
    { value: 'velaanaage', label: 'Velaanaage', zone: 'male' }, { value: 'bus_terminal', label: 'Bus Terminal', zone: 'male' },
    { value: 'museum', label: 'National Museum', zone: 'male' }, { value: 'hm_nirolhu', label: 'Hulhumalé, Nirolhu Magu', zone: 'hulhumale_p1' },
    { value: 'hm_amin', label: 'Hulhumalé, Amin Avenue', zone: 'hulhumale_p1' },
  ];
  MDM.POST_OFFICES = [{ value: 'male_7th', label: 'Post Office, 7th floor (Malé)', zone: 'male' }, { value: 'hulhumale', label: 'Hulhumalé Post Office', zone: 'hulhumale_p1' }];
  MDM.OFFICE_TASKS = [
    { value: 'submit', label: 'Document submission' }, { value: 'collect', label: 'Document collection' },
    { value: 'procedure', label: 'Procedure or application assistance' }, { value: 'other', label: 'Other administrative request' },
  ];
  MDM.AIRPORT_MODES = [
    { value: 'collect', label: 'Collect from the airport' }, { value: 'deliver', label: 'Deliver to the airport' }, { value: 'baggage', label: 'Baggage service' },
  ];
  MDM.ADJUSTMENT_PRESETS = [
    { value: 'vehicle', label: 'Extra vehicle charge' }, { value: 'size', label: 'Size correction' }, { value: 'waiting', label: 'Waiting time' },
    { value: 'freight', label: 'Boat freight advanced' }, { value: 'express', label: 'Express handling' }, { value: 'redelivery', label: 'Re-delivery' },
    { value: 'discount', label: 'Discount' }, { value: 'quote', label: 'Price confirmation' }, { value: 'packing', label: 'Packing charge' }, { value: 'naalu', label: 'Naalu' },
    { value: 'cargo', label: 'Maldivian Cargo charges' }, { value: 'stop', label: 'Extra collection' }, { value: 'other', label: 'Other' },
  ];
  MDM.FAIL_REASONS = [
    { value: 'customer_unavailable', label: 'Customer unavailable' }, { value: 'recipient_unavailable', label: 'Recipient unavailable' },
    { value: 'no_contact', label: 'Unable to contact customer' }, { value: 'wrong_address', label: 'Wrong address' },
    { value: 'wrong_phone', label: 'Wrong contact number' }, { value: 'not_ready', label: 'Package not ready' },
    { value: 'refused', label: 'Recipient refused package' }, { value: 'other', label: 'Other reason' },
  ];
  MDM.FAIL_ACTIONS = [
    { value: 'reschedule', label: 'Reschedule' }, { value: 'reassign', label: 'Reassign' }, { value: 'return', label: 'Return the package' },
    { value: 'contact', label: 'Contact the customer' }, { value: 'cancel', label: 'Cancel the order' },
  ];
  MDM.HANDED_TO = [
    { value: 'recipient', label: 'Recipient' }, { value: 'family', label: 'Family or colleague' }, { value: 'security', label: 'Security or reception' }, { value: 'left', label: 'Left as instructed' },
  ];
  MDM.PRIORITY_LEVELS = [{ value: 'priority', label: 'Priority' }, { value: 'urgent', label: 'Urgent' }, { value: 'express', label: 'Express' }];
  MDM.LEAVE_TYPES = [{ value: 'annual', label: 'Annual leave' }, { value: 'sick', label: 'Sick leave' }, { value: 'emergency', label: 'Emergency leave' }, { value: 'off_day', label: 'Accumulated off day' }, { value: 'unpaid', label: 'Unpaid leave' }];
  MDM.ROLES = [{ value: 'admin', label: 'Admin' }, { value: 'operator', label: 'Operator' }, { value: 'office', label: 'Office staff' }, { value: 'driver', label: 'Driver' }];
  // Events that reach the customer as a notification (client requirements §17).
  const NOTIFY = {
    created: 'Order submitted', confirmed: 'Order confirmed', price_confirmed: 'Price confirmed', assigned: 'Driver assigned',
    collected: 'Package collected', out_for_delivery: 'Out for delivery', delivered: 'Delivered', failed: 'Delivery problem',
    payment_requested: 'Payment requested', payment_submitted: 'Payment submitted', payment_verified: 'Payment verified',
    priority_approved: 'Priority request approved', priority_rejected: 'Priority request rejected', cancelled: 'Order cancelled',
    cancel_rejected: 'Cancellation request declined', boat_updated: 'Boat details updated', cod_remitted: 'Cash on delivery paid to you',
  };

  MDM.NOTIFY = NOTIFY;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  MDM.badgeFor = function (status, opts) {
    const s = MDM.STATUS[status] || { label: status, customer: status, kind: 'neutral' };
    const label = opts && opts.customer ? s.customer : s.label;
    return '<span class="badge badge--' + s.kind + '" data-status="' + esc(status) + '">' + esc(label) + '</span>';
  };
  MDM.payBadge = function (status) {
    const s = MDM.PAYMENT[status] || { label: status || 'Payment pending', kind: 'neutral' };
    return '<span class="badge badge--' + s.kind + '" data-payment="' + esc(status) + '">' + esc(s.label) + '</span>';
  };
  MDM.requestTypeLabel = v => ((MDM.REQUEST_TYPES.find(t => t.value === v) || {}).label) || (v === 'store' ? 'E-store order' : v === 'bulk' ? 'Business bulk' : v === 'business' ? 'Business delivery' : v || 'Delivery');

  // ---- Low-level storage ----------------------------------------------------------------------------------------------
  const clone = typeof structuredClone === 'function' ? (v => structuredClone(v)) : (v => JSON.parse(JSON.stringify(v)));
  const cache = {};
  let settingsCache = null, metaCache = null;
  let tabId = null;
  function getTabId() { return tabId || (tabId = MDM.id('tab')); }
  let readyResolve; const ready = new Promise(r => { readyResolve = r; });
  let readyState = 'booting';
  let seedBuilder = null;

  function readRaw(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } }
  function writeRaw(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { throw new StoreError('quota', 'This browser is out of storage space for the demo.'); }
  }
  function readCol(col) {
    if (COLLECTIONS.indexOf(col) < 0) throw new StoreError('validation', 'Unknown collection: ' + col);
    if (!cache[col]) cache[col] = readRaw(PREFIX + col, []);
    return cache[col];
  }
  function writeCol(col, arr) {
    writeRaw(PREFIX + col, arr); cache[col] = arr;
    if (col !== 'positions') { const m = meta(); if (!m.dirty) { m.dirty = true; writeMeta(m); } }
  }
  function meta() { if (!metaCache) metaCache = readRaw(PREFIX + 'meta', { seededAt: 0, dirty: false, orderSeq: 1000, batchSeq: 1000, invoiceSeq: 1 }); return metaCache; }
  function writeMeta(m) { metaCache = m; writeRaw(PREFIX + 'meta', m); }
  function now() { return new Date().toISOString(); }

  // ---- Cross-tab propagation: exactly one transport ---------------------------------------------------------------------
  const subs = { '*': new Set() }; COLLECTIONS.forEach(c => { subs[c] = new Set(); }); subs.settings = new Set();
  const pending = new Map();
  let flushTimer = null;
  function schedule(collection, id, op, origin) {
    const p = pending.get(collection) || { ids: new Set(), ops: new Set(), origin };
    if (id) p.ids.add(id); p.ops.add(op); if (origin === 'remote') p.origin = 'remote';
    pending.set(collection, p);
    if (!flushTimer) flushTimer = setTimeout(flush, 0);
  }
  function flush() {
    flushTimer = null;
    const batch = [...pending.entries()]; pending.clear();
    batch.forEach(([collection, p]) => {
      const payload = { collection, id: p.ids.size === 1 ? [...p.ids][0] : null, ids: [...p.ids], op: p.ops.size === 1 ? [...p.ops][0] : 'update', origin: p.origin };
      (subs[collection] || new Set()).forEach(cb => { try { cb(payload); } catch (e) { /* subscriber errors never break the store */ } });
      subs['*'].forEach(cb => { try { cb(payload); } catch (e) { /* same */ } });
    });
  }
  let channel = null;
  function broadcast(msg) { if (channel) { try { channel.postMessage(Object.assign({ v: 1, tabId: getTabId() }, msg)); } catch (e) { /* channel closed */ } } }
  function onRemote(msg) {
    if (!msg || msg.tabId === getTabId()) return;
    if (msg.op === 'reset') { invalidateAll(); schedule('*', null, 'reset', 'remote'); COLLECTIONS.forEach(c => schedule(c, null, 'reset', 'remote')); schedule('settings', null, 'reset', 'remote'); return; }
    if (msg.collection === 'settings') { settingsCache = null; schedule('settings', null, 'update', 'remote'); return; }
    if (msg.collection) { cache[msg.collection] = undefined; schedule(msg.collection, msg.id, msg.op, 'remote'); }
  }
  function invalidateAll() { COLLECTIONS.forEach(c => { cache[c] = undefined; }); settingsCache = null; metaCache = null; }
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel('mdm');
    channel.onmessage = e => onRemote(e.data);
  } else {
    window.addEventListener('storage', e => {
      if (e.key === null) { onRemote({ op: 'reset', tabId: null }); return; }
      if (!e.key || e.key.indexOf(PREFIX) !== 0) return;
      const col = e.key.slice(PREFIX.length);
      if (col === 'settings') onRemote({ collection: 'settings', op: 'update', tabId: null });
      else if (COLLECTIONS.indexOf(col) >= 0) onRemote({ collection: col, id: null, op: 'update', tabId: null });
    });
  }
  function wake() { if (readyState !== 'ready') return; invalidateAll(); schedule('*', null, 'refresh', 'remote'); COLLECTIONS.forEach(c => schedule(c, null, 'refresh', 'remote')); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  window.addEventListener('focus', wake);
  function notifyLocal(collection, id, op) { schedule(collection, id, op, 'local'); broadcast({ collection, id, op }); }

  // ---- Generic API -----------------------------------------------------------------------------------------------------
  function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
  function matches(doc, where) {
    if (!where) return true;
    return Object.keys(where).every(k => { const want = where[k], have = getPath(doc, k); return Array.isArray(want) ? want.indexOf(have) >= 0 : have === want; });
  }
  function sortBy(arr, order) {
    const desc = order[0] === '-', field = desc ? order.slice(1) : order;
    return arr.slice().sort((a, b) => { const x = a[field] || '', y = b[field] || ''; return x < y ? (desc ? 1 : -1) : x > y ? (desc ? -1 : 1) : 0; });
  }
  function get(col, id) { const doc = readCol(col).find(d => d.id === id); return doc ? clone(doc) : null; }
  function list(col, q) {
    q = q || {};
    let arr = readCol(col).filter(d => matches(d, q.where));
    arr = sortBy(arr, q.order || '-createdAt');
    if (q.limit) arr = arr.slice(0, q.limit);
    return clone(arr);
  }
  function insert(col, doc) {
    const arr = readCol(col).slice();
    const d = clone(doc || {});
    const t = now();
    if (!d.id) d.id = MDM.id(ID_PREFIX[col] || 'doc');
    if (!d.createdAt) d.createdAt = t;
    d.updatedAt = t;
    if (col === 'orders' && !d.code) { const m = meta(); d.code = 'MDM-' + m.orderSeq; m.orderSeq += 1; writeMeta(m); }
    if (col === 'batches' && !d.code) { const m = meta(); d.code = 'BLK-' + (m.batchSeq || 1000); m.batchSeq = (m.batchSeq || 1000) + 1; writeMeta(m); }
    if (col === 'events' || col === 'notifications') { arr.push(d); const cap = col === 'events' ? EVENT_CAP : NOTIFY_CAP; while (arr.length > cap) arr.shift(); }
    else { const i = arr.findIndex(x => x.id === d.id); if (i >= 0) arr[i] = d; else arr.push(d); }
    writeCol(col, arr); notifyLocal(col, d.id, 'insert');
    return clone(d);
  }
  function update(col, id, patchOrFn) {
    cache[col] = undefined;
    const arr = readCol(col).slice();
    const i = arr.findIndex(x => x.id === id);
    if (i < 0) throw new StoreError('not_found', col + ' ' + id + ' not found');
    const current = arr[i];
    const patch = typeof patchOrFn === 'function' ? patchOrFn(clone(current)) : patchOrFn;
    const next = Object.assign({}, current, clone(patch || {}), { id: current.id, createdAt: current.createdAt, updatedAt: now() });
    arr[i] = next; writeCol(col, arr); notifyLocal(col, id, 'update');
    return clone(next);
  }
  function remove(col, id) { const arr = readCol(col).filter(x => x.id !== id); writeCol(col, arr); notifyLocal(col, id, 'remove'); }
  const SETTINGS_KEYS = ['rates', 'rules', 'sizeGuide', 'ops', 'banks', 'contact', 'terms', 'notice', 'invoiceDueDays', 'gstPercent', 'demo', 'notifications', 'hr', 'store'];
  function settings() { if (!settingsCache) settingsCache = readRaw(PREFIX + 'settings', {}); return clone(settingsCache); }
  function deepMerge(a, b) {
    if (Array.isArray(b) || b === null || typeof b !== 'object') return clone(b);
    const out = Object.assign({}, a || {});
    Object.keys(b).forEach(k => { out[k] = (a && typeof a[k] === 'object' && !Array.isArray(a[k]) && b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k], b[k]) : clone(b[k]); });
    return out;
  }
  function saveSettings(patch) {
    const cur = settings(); const next = Object.assign({}, cur);
    const keys = Object.keys(patch || {}).filter(k => SETTINGS_KEYS.indexOf(k) >= 0);
    keys.forEach(k => { next[k] = deepMerge(cur[k], patch[k]); });
    writeRaw(PREFIX + 'settings', next); settingsCache = next;
    schedule('settings', null, 'update', 'local'); broadcast({ collection: 'settings', op: 'update' });
    audit('settings_changed', 'Settings updated: ' + keys.join(', '), (patch && patch.__by) || 'admin');
    return clone(next);
  }
  function subscribe(col, cb) { const set = subs[col]; if (!set) throw new StoreError('validation', 'Unknown collection: ' + col); set.add(cb); return () => set.delete(cb); }

  // ---- Seed / boot / reset / export ------------------------------------------------------------------------------------
  function writeSeed(seed) {
    const t = now();
    COLLECTIONS.forEach(c => { cache[c] = seed[c] || []; writeRaw(PREFIX + c, cache[c]); });
    settingsCache = seed.settings || {}; writeRaw(PREFIX + 'settings', settingsCache);
    const codes = (seed.orders || []).map(o => Number(String(o.code || '').replace(/\D/g, ''))).filter(n => n > 0);
    const bcodes = (seed.batches || []).map(o => Number(String(o.code || '').replace(/\D/g, ''))).filter(n => n > 0);
    writeMeta({ seededAt: Date.now(), dirty: false, orderSeq: (codes.length ? Math.max.apply(null, codes) : 1000) + 1, batchSeq: (bcodes.length ? Math.max.apply(null, bcodes) : 1000) + 1, invoiceSeq: (seed.invoices || []).length + 1, seededISO: t });
    writeRaw('mdm:schema', MDM.SCHEMA);
  }
  function clearAll() {
    // Sign-ins survive a reset; the portals check that the account, customer or employee still exists.
    const keep = ['mdm:session', 'mdm:business', 'mdm:me', 'mdm:staff', 'mdm:timeScale', 'mdm:theme'];
    const keys = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf('mdm:') === 0 && keep.indexOf(k) < 0) keys.push(k); }
    keys.forEach(k => localStorage.removeItem(k));
    invalidateAll();
  }
  function boot(buildSeed) {
    seedBuilder = buildSeed;
    const schema = readRaw('mdm:schema', null);
    const m = meta();
    if (schema !== MDM.SCHEMA || !m.seededAt) { clearAll(); writeSeed(buildSeed(new Date())); }
    else if (!m.dirty && Date.now() - m.seededAt > RESEED_AFTER_MS) { clearAll(); writeSeed(buildSeed(new Date())); }
    readyState = 'ready'; readyResolve();
  }
  function reset() {
    if (!seedBuilder) throw new StoreError('validation', 'No seed available');
    clearAll(); writeSeed(seedBuilder(new Date()));
    schedule('*', null, 'reset', 'local'); COLLECTIONS.forEach(c => schedule(c, null, 'reset', 'local')); schedule('settings', null, 'reset', 'local');
    broadcast({ op: 'reset' });
  }
  function exportJSON(opts) {
    const cols = {}; COLLECTIONS.forEach(c => { if (c === 'files' && !(opts && opts.includeFiles)) return; cols[c] = readCol(c); });
    return JSON.stringify({ schema: MDM.SCHEMA, exportedAt: now(), settings: settings(), meta: meta(), collections: cols }, null, 2);
  }
  function importJSON(text) {
    let data; try { data = JSON.parse(text); } catch (e) { throw new StoreError('schema', 'Not valid JSON'); }
    if (!data || data.schema !== MDM.SCHEMA || !data.collections) throw new StoreError('schema', 'This file is not a Mr. Delivery Man export');
    COLLECTIONS.forEach(c => { if (data.collections[c]) { cache[c] = data.collections[c]; writeRaw(PREFIX + c, cache[c]); } });
    if (data.settings) { settingsCache = data.settings; writeRaw(PREFIX + 'settings', settingsCache); }
    if (data.meta) writeMeta(Object.assign({}, meta(), data.meta, { dirty: true }));
    schedule('*', null, 'reset', 'local'); COLLECTIONS.forEach(c => schedule(c, null, 'reset', 'local')); schedule('settings', null, 'reset', 'local');
    broadcast({ op: 'reset' });
  }

  // ---- Audit, events and notifications ----------------------------------------------------------------------------------
  function normPhone(raw) {
    if (MDM.ui && MDM.ui.phone) return MDM.ui.phone.normalize(raw);
    const d = String(raw || '').replace(/\D/g, ''); const s = d.length > 7 && d.indexOf('960') === 0 ? d.slice(3) : d;
    return /^[3679]\d{6}$/.test(s) ? s : (d.length >= 8 && d.length <= 15 ? '+' + d : null);
  }
  const fmt = n => (MDM.pricing ? MDM.pricing.format(n) : 'MVR ' + n);
  function byName(by) {
    if (!by || by === 'system') return 'System';
    if (by === 'customer') return 'Customer';
    if (by === 'admin') return 'Admin';
    const m = /^(driver|staff|business|operator):(.+)$/.exec(by);
    if (m) {
      if (m[1] === 'driver') { const d = readCol('drivers').find(x => x.id === m[2]); return d ? d.name + ' (driver)' : 'Driver'; }
      if (m[1] === 'staff' || m[1] === 'operator') { const s = readCol('staff').find(x => x.id === m[2] || x.username === m[2]); return s ? s.name : 'Staff'; }
      if (m[1] === 'business') { const a = readCol('business_accounts').find(x => x.id === m[2]); return a ? a.name : 'Business'; }
    }
    return by;
  }
  MDM.byName = byName;
  // Audit entries that are not tied to one order (settings, HR, products, zones) go straight into the events log.
  function audit(type, label, by, extra) { insert('events', Object.assign({ orderId: null, code: null, at: now(), type, label, by: by || 'system', visibility: 'internal' }, extra || {})); }
  function orderOrThrow(id) { const o = readCol('orders').find(x => x.id === id); if (!o) throw new StoreError('not_found', 'Order not found'); return clone(o); }
  function makeEvent(type, label, by, visibility, meta_) { return { id: MDM.id('evt'), at: now(), type, label, by: by || 'system', visibility: visibility || 'internal', meta: meta_ || null }; }
  function pushEvent(order, ev) {
    order.events = (order.events || []).concat([ev]);
    insert('events', { id: ev.id, orderId: order.id, code: order.code, at: ev.at, type: ev.type, label: ev.label, by: ev.by, visibility: ev.visibility });
    if (NOTIFY[ev.type] && ev.visibility !== 'internal') notify(order, ev);
  }
  function notify(order, ev) {
    const s = settings(); const cfg = s.notifications || {};
    if (cfg.enabled === false) return;
    const c = order.customer || {};
    const channel = cfg.channel === 'customer' || !cfg.channel ? (c.notify || 'sms') : cfg.channel;
    const message = 'Mr. Delivery Man: ' + order.code + ' ' + NOTIFY[ev.type].toLowerCase() + '. ' + ev.label;
    insert('notifications', { orderId: order.id, code: order.code, to: c.phone || '', name: c.name || '', channel, event: ev.type, title: NOTIFY[ev.type], message, status: 'sent', at: ev.at });
  }
  // notifyStaff: operational messages for the driver, the operations desk or the business (not the end customer). In production these
  // become push notifications in the driver and office apps; here they are rows in the same notifications log with an audience.
  function notifyStaff(order, audience, title, message) {
    let to = '', name = '';
    if (audience === 'driver') { const d = readCol('drivers').find(x => x.id === order.driverId); if (!d) return; to = d.phone; name = d.name; }
    else if (audience === 'business') { const a = readCol('business_accounts').find(x => x.id === order.accountId); if (!a) return; to = a.phone; name = a.name; }
    else { to = 'operations'; name = 'Operations'; }
    insert('notifications', { orderId: order.id, code: order.code, to, name, audience, channel: 'app', event: 'staff_' + audience, title, message: order.code + ': ' + message, status: 'sent', at: now() });
  }
  function save(order) { return update('orders', order.id, order); }
  function setStatus(o, next, type, label, by, visibility, meta_) {
    if (!MDM.STATUS[next]) throw new StoreError('validation', 'Unknown status ' + next);
    if (o.status !== next && (MDM.ALLOWED[o.status] || []).indexOf(next) < 0) throw new StoreError('transition', 'Cannot go from ' + MDM.STATUS[o.status].label + ' to ' + MDM.STATUS[next].label);
    const from = o.status;
    o.status = next;
    o.statusHistory = (o.statusHistory || []).concat([{ at: now(), from, to: next, by: by || 'system' }]);
    pushEvent(o, makeEvent(type || next, label || MDM.STATUS[next].customer, by, visibility || 'public', meta_));
  }

  function addEvent(orderId, ev) { const o = orderOrThrow(orderId); pushEvent(o, makeEvent(ev.type, ev.label, ev.by, ev.visibility, ev.meta)); return save(o); }
  function transition(orderId, next, opts) { opts = opts || {}; const o = orderOrThrow(orderId); setStatus(o, next, opts.type, opts.label, opts.by, opts.visibility, opts.meta); return save(o); }
  function addNote(orderId, n) {
    const o = orderOrThrow(orderId);
    o.notes = (o.notes || []).concat([{ id: MDM.id('note'), at: now(), text: n.text, by: n.by || 'admin' }]);
    pushEvent(o, makeEvent('note', 'Operator remark: ' + n.text, n.by, 'internal'));
    return save(o);
  }
  function recalc(o) { const s = settings(); return MDM.pricing && MDM.pricing.recalc ? MDM.pricing.recalc(o, s) : o; }
  function priceHistory(o, from, to, note, by) { o.pricing = o.pricing || { status: 'estimated', history: [] }; o.pricing.history = (o.pricing.history || []).concat([{ at: now(), by: by || 'admin', from, to, note: note || '' }]); }

  // ---- Pricing: estimates, confirmation and manual adjustments (requirements §3 step 4, §15) -----------------------------
  function addAdjustment(orderId, a) {
    const o = orderOrThrow(orderId);
    const preset = MDM.ADJUSTMENT_PRESETS.find(p => p.value === a.preset) || { value: 'other', label: a.label || 'Adjustment' };
    const label = a.label || preset.label;
    const adj = { id: MDM.id('adj'), preset: preset.value, label, amount: Math.round(Number(a.amount) || 0), at: now(), by: a.by || 'admin', remarks: a.remarks || '' };
    o.fees = o.fees || { cargo: 0, airport: 0, shopping: 0, adjustments: [] };
    const before = o.totals ? o.totals.total : 0;
    o.fees.adjustments = (o.fees.adjustments || []).concat([adj]);
    recalc(o);
    priceHistory(o, before, o.totals.total, label + (a.remarks ? ': ' + a.remarks : ''), a.by);
    const visible = o.pricing && o.pricing.status === 'confirmed';
    pushEvent(o, makeEvent('adjustment', (visible ? 'Price updated: ' : 'Adjustment: ') + label + ' ' + fmt(adj.amount), a.by, visible ? 'public' : 'internal', { adjustmentId: adj.id }));
    return save(o);
  }
  // confirmPrice: the operator finalises the price after reviewing the package photo (or the driver's proof of collection).
  function confirmPrice(orderId, q) {
    const o = orderOrThrow(orderId);
    const before = o.totals.total;
    const total = q.total == null || q.total === '' ? before : Math.round(Number(q.total));
    if (total !== before) {
      o.fees.adjustments = (o.fees.adjustments || []).concat([{ id: MDM.id('adj'), preset: q.preset || 'quote', label: q.label || 'Price confirmation', amount: total - before, at: now(), by: q.by || 'admin', remarks: q.remarks || '' }]);
      recalc(o);
    }
    const fromProof = MDM.priceToFinalise(o);
    priceHistory(o, before, o.totals.total, 'Final price confirmed' + (fromProof ? ' from the proof of collection' : '') + (q.remarks ? ': ' + q.remarks : ''), q.by);
    o.pricing = Object.assign({}, o.pricing, { status: 'confirmed', confirmedAt: now(), confirmedBy: q.by || 'admin', remarks: q.remarks || '' });
    o.totals.quoteRequired = false;
    pushEvent(o, makeEvent('price_confirmed', 'Price confirmed: ' + fmt(o.totals.total) + (q.remarks ? ' (' + q.remarks + ')' : ''), q.by, 'public'));
    if (o.status === 'requested') setStatus(o, 'confirmed', 'confirmed', 'Order confirmed', q.by);
    // Delivered before the price was set (price after collection): the invoice that waited for it goes out now.
    if (o.status === 'delivered' && o.payment.status === 'pending') requestPaymentOn(o, q.by, false);
    else if (q.requestPayment || o.payment.upfrontRequired) requestPaymentOn(o, q.by, o.status !== 'delivered');
    return save(o);
  }

  // ---- Payments (requirements §4) ---------------------------------------------------------------------------------------
  function invoiceNo(o) { return 'INV-' + o.code.replace('MDM-', ''); }
  function requestPaymentOn(o, by, upfront) {
    if (o.payment.method === 'invoice') return;
    o.payment = Object.assign({}, o.payment, { status: 'requested', requestedAt: now(), requestedBy: by || 'admin', invoiceNo: o.payment.invoiceNo || invoiceNo(o), upfront: !!upfront, rejectReason: null });
    pushEvent(o, makeEvent('payment_requested', (upfront ? 'Payment requested before delivery: ' : 'Invoice issued: ') + fmt(o.totals.total), by, 'public'));
  }
  function requestPayment(orderId, p) { const o = orderOrThrow(orderId); requestPaymentOn(o, p && p.by, p && p.upfront); return save(o); }
  // submitPayment: the customer uploads a transfer slip; allowed once the order is confirmed (upfront) or after delivery (invoice).
  function submitPayment(orderId, p) {
    const o = orderOrThrow(orderId);
    if (['paid', 'refunded', 'invoiced'].indexOf(o.payment.status) >= 0) throw new StoreError('validation', 'This order is already settled');
    o.payment = Object.assign({}, o.payment, { status: 'received', bank: p.bank || '', payerName: p.payerName || '', paidAmount: p.paidAmount != null ? Math.round(Number(p.paidAmount)) : o.totals.total, reference: p.reference || '', slip: p.slip || o.payment.slip || null, submittedAt: now(), invoiceNo: o.payment.invoiceNo || invoiceNo(o), rejectReason: null });
    pushEvent(o, makeEvent('payment_submitted', 'Transfer slip received, we are checking it', p.by || 'customer', 'public'));
    return save(o);
  }
  function verifyPayment(orderId, p) {
    const o = orderOrThrow(orderId);
    o.payment = Object.assign({}, o.payment, { status: 'paid', verifiedAt: now(), verifiedBy: p && p.by || 'admin', paidAt: now(), rejectReason: null });
    if (o.payment.paidAmount == null) o.payment.paidAmount = o.totals.total;
    pushEvent(o, makeEvent('payment_verified', 'Payment verified, thank you', p && p.by, 'public'));
    return save(o);
  }
  function markPaid(orderId, p) {
    const o = orderOrThrow(orderId);
    o.payment = Object.assign({}, o.payment, { status: 'paid', method: p.method || o.payment.method, verifiedAt: now(), verifiedBy: p.by || 'admin', paidAt: now(), note: p.note || '', paidAmount: o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total, invoiceNo: o.payment.invoiceNo || invoiceNo(o) });
    pushEvent(o, makeEvent('payment_verified', 'Payment received' + (p.note ? ' (' + p.note + ')' : ''), p.by, 'public'));
    return save(o);
  }
  function rejectPayment(orderId, p) {
    const o = orderOrThrow(orderId);
    o.payment = Object.assign({}, o.payment, { status: 'requested', rejectReason: p.reason || '', rejectedAt: now() });
    pushEvent(o, makeEvent('payment_rejected', "We couldn't match your transfer: " + (p.reason || ''), p.by, 'public'));
    return save(o);
  }
  function recordRefund(orderId, r) {
    const o = orderOrThrow(orderId);
    o.payment = Object.assign({}, o.payment, { status: 'refunded', refund: { amount: Math.round(Number(r.amount) || 0), toBank: r.toBank || '', toAccount: r.toAccount || '', reference: r.reference || '', at: now(), by: r.by || 'admin' } });
    pushEvent(o, makeEvent('refund', 'Refund sent ' + fmt(o.payment.refund.amount), r.by, 'public'));
    return save(o);
  }
  function markSettled(orderId, s) {
    const o = orderOrThrow(orderId);
    o.settlement = Object.assign({}, o.settlement || {}, { status: 'settled', settledAt: now(), reference: s.reference || '' });
    pushEvent(o, makeEvent('settled', 'Shopping balance settled' + (s.reference ? ' (' + s.reference + ')' : ''), s.by, 'public'));
    return save(o);
  }

  // ---- Cancellation and changes (requirements §9) -----------------------------------------------------------------------
  // cancelOn: the office cancels (directly, on a customer's request or after a failure). Once something is collected the driver holds
  // the package, so it becomes a return to the sender the same way a business cancellation does (§5.5).
  function cancelOn(o, reason, by) {
    if ((MDM.ALLOWED[o.status] || []).indexOf('cancelled') < 0) throw new StoreError('transition', 'This order can no longer be cancelled');
    const prev = o.status;
    const withUs = ((o.route && o.route.stops) || []).some(x => x.type === 'pickup' && x.status === 'done');
    o.cancelReason = reason || ''; o.cancelledBy = by || 'admin'; o.cancelledAt = now();
    o.cancellation = Object.assign({}, o.cancellation, { previousStatus: prev, actionRequired: withUs ? 'return_to_sender' : 'none', returnStatus: withUs ? 'pending' : null });
    if (o.cod && o.cod.status === 'pending') o.cod = Object.assign({}, o.cod, { status: 'not_collected', note: 'Order cancelled' });
    setStatus(o, 'cancelled', 'cancelled', (by === 'customer' ? 'Cancelled at your request' : 'Order cancelled') + (reason ? ': ' + reason : ''), by, 'public', { previousStatus: prev });
    if (o.driverId) notifyStaff(o, 'driver', 'Order cancelled', withUs ? (prev === 'out_for_delivery' ? 'out for delivery: do not deliver, bring it back to the sender' : 'already collected: return it to the sender') : 'not collected yet: skip this collection');
    if (o.driverId && !withUs) releaseDriverIfIdle(o.driverId, o.id);
  }
  function cancel(orderId, p) { const o = orderOrThrow(orderId); cancelOn(o, p.reason, p.by); return save(o); }
  function requestCancel(orderId, p) {
    const o = orderOrThrow(orderId);
    if (MDM.CANCELLABLE.indexOf(o.status) < 0) throw new StoreError('transition', 'The package is already collected, please contact us');
    o.cancellation = { status: 'requested', reason: p.reason || '', requestedAt: now(), requestedBy: p.by || 'customer', decidedAt: null, decidedBy: null, remarks: '' };
    pushEvent(o, makeEvent('cancel_requested', 'Cancellation requested' + (p.reason ? ': ' + p.reason : ''), p.by || 'customer', 'public'));
    return save(o);
  }
  function decideCancel(orderId, p) {
    const o = orderOrThrow(orderId);
    if (!o.cancellation || o.cancellation.status !== 'requested') throw new StoreError('validation', 'No cancellation request to decide');
    o.cancellation = Object.assign({}, o.cancellation, { status: p.approve ? 'approved' : 'rejected', decidedAt: now(), decidedBy: p.by || 'admin', remarks: p.remarks || '' });
    if (p.approve) cancelOn(o, o.cancellation.reason || p.remarks, p.by);
    else pushEvent(o, makeEvent('cancel_rejected', 'Cancellation declined' + (p.remarks ? ': ' + p.remarks : ''), p.by, 'public'));
    return save(o);
  }
  // modifyOrder: operator edits with a field-by-field change history. A corrected collection contact, receiver or home address also
  // reaches the packages (label, pricing), the boat contact or cargo consignee, and the driver's stops that are still to do. A package or
  // stop that had its own person or address (a multi-drop order) keeps it.
  function modifyOrder(orderId, patch, by) {
    const o = orderOrThrow(orderId);
    const d0 = Object.assign({}, o.delivery), c0 = Object.assign({}, o.collection);
    const changes = [];
    const walk = (target, src, path) => Object.keys(src).forEach(k => {
      const v = src[k], p = path ? path + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') walk(target[k], v, p);
      else if (JSON.stringify(target[k]) !== JSON.stringify(v)) { changes.push({ at: now(), by: by || 'admin', field: p, from: target[k] == null ? '' : target[k], to: v }); target[k] = v; }
    });
    walk(o, patch, '');
    if (!changes.length) return clone(o);
    const d = o.delivery || {}, c = o.collection || {};
    const person = (name, phone) => ({ name: name || '', phone: phone || '' });
    const samePhone = (a, b) => (normPhone(a) || String(a || '')) === (normPhone(b) || String(b || ''));
    const differs = (a, b) => a.name !== b.name || !samePhone(a.phone, b.phone);
    // A package or stop person "was" the old one when every part it has matches (a Pikpost locker has a name and no phone).
    const was = (x, prev) => !x || ((!x.name || String(x.name) === prev.name) && (!x.phone || samePhone(x.phone, prev.phone)));
    const recvFrom = person(d0.recipientName, d0.recipientPhone), recv = person(d.recipientName, d.recipientPhone);
    const colFrom = person(c0.contactName, c0.contactPhone), col = person(c.contactName, c.contactPhone);
    const recvChanged = differs(recv, recvFrom), colChanged = differs(col, colFrom);
    const moved = (a, b) => ['address', 'zone', 'landmark'].some(k => String(a[k] || '') !== String(b[k] || ''));
    const home = !d.method || d.method === 'home';
    const homeMoved = home && moved(d, d0), colMoved = moved(c, c0);
    const derived = (field, from, to) => changes.push({ at: now(), by: by || 'admin', field, from: from == null ? '' : from, to });
    // The boat's contact and the cargo consignee are the receiver unless the booking named someone else.
    if (recvChanged && d.method === 'boat' && d.boat && (!d.boat.contact || samePhone(d.boat.contact, recvFrom.phone)) && !samePhone(d.boat.contact, recv.phone)) {
      derived('delivery.boat.contact', d.boat.contact, recv.phone); d.boat = Object.assign({}, d.boat, { contact: recv.phone });
    }
    if (recvChanged && d.method === 'cargo' && d.cargo && d.cargo.consignee && d.cargo.consignee === recvFrom.name && recv.name !== recvFrom.name) {
      derived('delivery.cargo.consignee', d.cargo.consignee, recv.name); d.cargo = Object.assign({}, d.cargo, { consignee: recv.name });
    }
    // Keep each package's pickup/drop-off in step with the order-level addresses and people, which pricing, labels and routing read.
    // Bulk child orders too: each one is a single package to one receiver.
    const touched = { pickup: new Set(), dropoff: new Set(), movedPickup: new Set(), movedDrop: new Set() };
    (o.packages || []).forEach(pkg => {
      if (pkg.pickup && o.collection) {
        if (colMoved && (!pkg.pickup.address || pkg.pickup.address === c0.address)) { Object.assign(pkg.pickup, { address: c.address, zone: c.zone, landmark: c.landmark }); delete pkg.pickup.lat; delete pkg.pickup.lng; touched.movedPickup.add(pkg.id); }
        if (colChanged && was(pkg.pickup.contact, colFrom)) { pkg.pickup.contact = clone(col); touched.pickup.add(pkg.id); }
      }
      if (!pkg.dropoff || !o.delivery) return;
      if (!home) { const end = deliveryEndpoint(d); Object.assign(pkg.dropoff, end, { recipient: pkg.dropoff.recipient || end.recipient }); }
      else if (homeMoved && (!pkg.dropoff.address || pkg.dropoff.address === d0.address)) {
        // The old pin belongs to the old address; the stop is placed again from the new address and zone.
        Object.assign(pkg.dropoff, { address: d.address, zone: d.zone, landmark: d.landmark }); delete pkg.dropoff.lat; delete pkg.dropoff.lng; touched.movedDrop.add(pkg.id);
      }
      if (recvChanged && was(pkg.dropoff.recipient, recvFrom)) { pkg.dropoff.recipient = clone(recv); touched.dropoff.add(pkg.id); }
    });
    o.changes = (o.changes || []).concat(changes);
    if (o.route && o.route.stops && o.route.stops.length && ['delivered', 'cancelled', 'returned'].indexOf(o.status) < 0) {
      const done = o.route.stops.filter(s => s.status === 'done');
      if (!done.length) { o.route = { stops: buildStops(o), polyline: [] }; o.route.polyline = MDM.geo.routeThrough(o.route.stops); }
      else {
        // Something is already collected or delivered, so the route stays; the stops still to do take the new person and, for a home
        // delivery, the new address (as updateBoat does for a new jetty). A failed stop is still to do: it is retried after a reschedule.
        let relocated = false;
        o.route.stops.forEach(s => {
          if (['pending', 'arrived', 'failed'].indexOf(s.status) < 0 || s.shop) return;
          const ids = s.packageIds || [s.packageId];
          const pkg = (o.packages || []).find(k => ids.indexOf(k.id) >= 0);
          if (!pkg) return;
          const end = s.type === 'pickup' ? pkg.pickup : s.type === 'dropoff' ? pkg.dropoff : null;
          if (!end) return;
          if (s.type === 'pickup' ? touched.pickup.has(pkg.id) : touched.dropoff.has(pkg.id)) s.contact = clone(s.type === 'pickup' ? end.contact : end.recipient);
          if (s.type === 'pickup' ? touched.movedPickup.has(pkg.id) : touched.movedDrop.has(pkg.id)) {
            const pt = pointFor(end, end.zone || 'male', end.address || s.label);
            Object.assign(s, { address: end.address || '', zone: end.zone || 'male', landmark: end.landmark || '', lat: pt.lat, lng: pt.lng });
            relocated = true;
          }
        });
        if (relocated) {
          const open = o.route.stops.filter(s => s.status !== 'done' && s.status !== 'skipped');
          o.route.polyline = MDM.geo.routeThrough(open.length >= 2 ? open : o.route.stops.filter(s => s.status !== 'skipped'));
        }
      }
    }
    pushEvent(o, makeEvent('modified', 'Order details updated: ' + changes.map(x => x.field.replace(/\./g, ' ')).join(', '), by, 'internal'));
    return save(o);
  }

  // ---- Priority requests (requirements §11, §12) ------------------------------------------------------------------------
  function requestPriority(orderId, p) {
    const o = orderOrThrow(orderId);
    const req = { id: MDM.id('pri'), at: now(), by: p.by || 'customer', reason: p.reason || '', deadline: p.deadline || '', instructions: p.instructions || '', decision: 'pending', decidedAt: null, decidedBy: null, remarks: '' };
    o.priority = Object.assign({ level: 'normal', status: 'none', requests: [] }, o.priority);
    o.priority.status = 'requested';
    o.priority.requests = (o.priority.requests || []).concat([req]);
    pushEvent(o, makeEvent('priority_requested', 'Priority delivery requested' + (p.reason ? ': ' + p.reason : ''), p.by, 'public'));
    return save(o);
  }
  function decidePriority(orderId, p) {
    const o = orderOrThrow(orderId);
    o.priority = Object.assign({ level: 'normal', status: 'none', requests: [] }, o.priority);
    const req = (o.priority.requests || []).slice().reverse().find(r => r.decision === 'pending');
    const decision = p.decision;   // approved | rejected | updated
    if (req) Object.assign(req, { decision, decidedAt: now(), decidedBy: p.by || 'admin', remarks: p.remarks || '' });
    if (decision === 'approved' || decision === 'updated') { o.priority.status = 'approved'; o.priority.level = p.level || o.priority.level || 'priority'; }
    else if (decision === 'rejected') o.priority.status = 'rejected';
    const lvl = (MDM.PRIORITY_LEVELS.find(x => x.value === o.priority.level) || {}).label || 'Priority';
    const label = decision === 'rejected' ? 'Priority request declined' : decision === 'updated' ? 'Priority updated to ' + lvl : 'Priority approved: ' + lvl;
    pushEvent(o, makeEvent(decision === 'rejected' ? 'priority_rejected' : 'priority_approved', label + (p.remarks ? ' (' + p.remarks + ')' : ''), p.by, 'public'));
    return save(o);
  }

  // ---- Delivery methods (web app updates §3) ------------------------------------------------------------------------------
  // deliveryEndpoint(delivery) → the package drop-off for a delivery method: boats go to the jetty, Maldivian Cargo to its counter at the
  // main bus terminal, airport deliveries to a resort counter or meeting point. Pricing and routing read this end, the label prints it.
  function deliveryEndpoint(d) {
    d = d || {};
    const method = d.method || 'home';
    const recipient = { name: d.recipientName || '', phone: d.recipientPhone || '' };
    const base = { method, recipient, instructions: d.instructions || '' };
    if (method === 'boat') {
      const b = d.boat || {};
      const t = MDM.geo.terminals().find(x => x.value === b.jetty) || MDM.geo.jetties()[0];
      const vessel = ((MDM.VESSEL_TYPES.find(v => v.value === b.vesselType) || {}).label || 'Boat').replace(' (dhoni)', '');
      return Object.assign(base, { address: t.label + (b.name ? ', ' + vessel.toLowerCase() + ' ' + b.name : ''), zone: t.zone, landmark: [b.island, b.departureTime ? 'departs ' + b.departureTime : ''].filter(Boolean).join(', '), lat: t.point[0], lng: t.point[1], meetAt: '', boat: Object.assign({}, b, { history: undefined }) });
    }
    if (method === 'cargo') {
      const c = MDM.geo.cargoCounter();
      return Object.assign(base, { address: c.label, zone: c.zone, landmark: (d.cargo && d.cargo.island) ? 'For ' + d.cargo.island : '', lat: c.point[0], lng: c.point[1], meetAt: '', cargo: Object.assign({ counter: c.label }, d.cargo || {}) });
    }
    if (method === 'airport') {
      const a = d.airport || {};
      const pt = MDM.geo.airportPoints().find(x => x.value === a.point) || MDM.geo.airportPoints().find(x => x.value === 'resort_counters');
      return Object.assign(base, { address: 'Velana International Airport, ' + pt.label + (a.counter ? ', ' + a.counter : ''), zone: 'airport', landmark: a.resort || '', lat: pt.point[0], lng: pt.point[1], meetAt: pt.value, airport: Object.assign({}, a, { point: pt.value }) });
    }
    return Object.assign(base, { address: d.address || '', zone: d.zone || 'male', landmark: d.landmark || '', meetAt: d.meetAt || 'door' });
  }
  MDM.deliveryEndpoint = deliveryEndpoint;
  // §2.3: the Extra vehicle option appears when an order has more than one box or more than one XL package.
  MDM.extraVehicleEligible = packages => { const n = sz => (packages || []).filter(p => p.size === sz).length; return n('box') > 1 || n('xl') > 1; };
  // §2.1 Order again, for the request and account pages. Orders with the same request type, collection address and delivery end (home
  // address, boat island and address, cargo island, airport point and counter) are one route; the route placed most often, at least
  // twice, is "Your most frequent order" and a tie goes to the most recent. Older airport-type orders count as home collections, as the
  // request form rebuilds them.
  MDM.reorderType = o => (MDM.requestTypes().some(t => t.value === o.requestType) ? o.requestType : 'home');
  // reorderRoute(order) → { from, to } in plain words.
  MDM.reorderRoute = function (o) {
    const from = o.service === 'shop' ? ((o.details && o.details.shop && o.details.shop.name) || (o.packages && o.packages[0] && o.packages[0].shop && o.packages[0].shop.name) || 'Shop') : ((o.collection && o.collection.address) || '');
    const d = o.delivery || {}, m = d.method || 'home';
    const to = m === 'boat' ? ((d.boat && d.boat.island) || d.address || 'Boat') + ' by ' + ((MDM.VESSEL_TYPES.find(v => v.value === (d.boat || {}).vesselType) || {}).label || 'boat').replace(' (dhoni)', '').toLowerCase()
      : m === 'cargo' ? 'Maldivian Cargo for ' + ((d.cargo && d.cargo.island) || d.address || 'an island')
      : m === 'airport' ? 'Airport, ' + ((d.airport && (d.airport.counter || d.airport.resort || (MDM.geo.airportPoints().find(p => p.value === d.airport.point) || {}).label)) || 'meeting point')
      : d.address || '';
    return { from, to };
  };
  MDM.reorderRouteText = o => { const r = MDM.reorderRoute(o); return MDM.requestTypeLabel(MDM.reorderType(o)) + ': ' + r.from + ' to ' + r.to; };
  MDM.reorderKey = function (o) {
    const low = v => String(v == null ? '' : v).trim().toLowerCase();
    const d = o.delivery || {}, m = d.method || 'home', b = d.boat || {}, a = d.airport || {};
    const end = m === 'boat' ? [b.island, b.address] : m === 'cargo' ? [(d.cargo || {}).island || d.address] : m === 'airport' ? [a.point, a.counter || a.resort] : [d.address];
    return [MDM.reorderType(o), low((o.collection || {}).address), m].concat(end.map(low)).join('|');
  };
  // frequentRoute(orders) → { key, count, latest } | null
  MDM.frequentRoute = function (orders) {
    const groups = new Map();
    (orders || []).forEach(o => { const k = MDM.reorderKey(o); const g = groups.get(k) || { key: k, count: 0, latest: o }; g.count += 1; if (String(o.createdAt) > String(g.latest.createdAt)) g.latest = o; groups.set(k, g); });
    let best = null;
    groups.forEach(g => { if (g.count >= 2 && (!best || g.count > best.count || (g.count === best.count && String(g.latest.createdAt) > String(best.latest.createdAt)))) best = g; });
    return best;
  };

  // ---- Routing and driver workflow (requirements §13, §14, §16) ---------------------------------------------------------
  function pointFor(end, zone, key) {
    if (end && end.lat != null && end.lng != null) return { lat: end.lat, lng: end.lng };
    if (end && end.cargo && end.cargo.terminal && MDM.geo.terminalPoint(end.cargo.terminal)) { const p = MDM.geo.terminalPoint(end.cargo.terminal); return { lat: p[0], lng: p[1] }; }
    if (zone === 'airport' && end && end.meetAt && MDM.geo.airportPoint(end.meetAt)) { const p = MDM.geo.airportPoint(end.meetAt); return { lat: p[0], lng: p[1] }; }
    return MDM.geo.geocodeZone(zone === 'other' ? 'male' : zone, key);
  }
  // Packages that share a pickup (or a drop-off) become one stop: a 5-bag order is one collection and one delivery.
  function buildStops(o) {
    const stops = [], byKey = {};
    const add = (type, label, end, zone, contact, pkg, extra) => {
      const key = type + '|' + (end.address || '') + '|' + zone + (type === 'dropoff' ? '|' + (contact && contact.name || '') : '');
      if (byKey[key]) { byKey[key].packageIds.push(pkg.id); return; }
      const p = pointFor(end, zone, end.address || label);
      const s = Object.assign({ id: MDM.id('stp'), packageId: pkg.id, packageIds: [pkg.id], type, label, address: end.address || '', landmark: end.landmark || '', instructions: end.instructions || '', zone, lat: p.lat, lng: p.lng, contact: contact || { name: o.customer.name, phone: o.customer.phone }, cargo: end.cargo || null, meetAt: end.meetAt || '', status: 'pending', at: null, attempts: 0 }, extra || {});
      byKey[key] = s; stops.push(s);
    };
    (o.packages || []).forEach(pkg => {
      if (o.service === 'shop' && pkg.shop) add('pickup', 'Shop: ' + pkg.shop.name, { address: pkg.shop.address || pkg.shop.name, lat: pkg.shop.lat, lng: pkg.shop.lng }, pkg.shop.zone || 'male', { name: pkg.shop.name, phone: '' }, pkg, { shop: true });
      else if (pkg.pickup) add('pickup', 'Collection', pkg.pickup, pkg.pickup.zone || 'male', pkg.pickup.contact, pkg);
    });
    // Extra collection points (multi collection): each is its own stop; what is collected or bought there is packed with the rest, so
    // the stop carries no package of its own.
    (o.extraCollections || []).forEach(c => {
      const shop = c.kind === 'shop';
      const end = { address: shop ? [c.shop && c.shop.name, c.address].filter(Boolean).join(', ') : c.address, landmark: c.landmark || '', instructions: c.instructions || '', lat: c.lat, lng: c.lng };
      const p = pointFor(end, c.zone || 'male', end.address);
      stops.push({ id: MDM.id('stp'), packageId: null, packageIds: [], collectionId: c.id, type: 'pickup', label: shop ? 'Shop: ' + ((c.shop && c.shop.name) || 'shop') : 'Collection', address: end.address || '', landmark: end.landmark, instructions: end.instructions,
        zone: c.zone || 'male', lat: p.lat, lng: p.lng, contact: shop ? { name: (c.shop && c.shop.name) || '', phone: (c.shop && c.shop.phone) || '' } : { name: c.contactName || o.customer.name, phone: c.contactPhone || o.customer.phone },
        cargo: null, meetAt: '', status: 'pending', at: null, attempts: 0, shop: shop || undefined });
    });
    (o.packages || []).forEach(pkg => { const d = pkg.dropoff || {}; add('dropoff', 'Delivery', d, d.zone || 'male', d.recipient, pkg); });
    // Number the collections only when there is more than one (shop stops keep their 'Shop: …' label and are not counted).
    const nP = stops.filter(s => s.type === 'pickup' && !s.shop).length, nD = stops.filter(s => s.type === 'dropoff').length;
    let i = 0, j = 0;
    stops.forEach(s => { if (s.type === 'pickup' && nP > 1 && !s.shop) s.label = 'Collection ' + (++i); if (s.type === 'dropoff' && nD > 1) s.label = 'Delivery ' + (++j); });
    return stops;
  }
  function driverName(driverId) { const d = readCol('drivers').find(x => x.id === driverId); return d ? d.name : 'driver'; }
  function ensureRoute(o) { if (!o.route || !o.route.stops || !o.route.stops.length) { o.route = { stops: buildStops(o), polyline: [] }; o.route.polyline = MDM.geo.routeThrough(o.route.stops); } }
  function assignDriver(orderId, driverId, opts) {
    opts = opts || {};
    const o = orderOrThrow(orderId);
    const d = readCol('drivers').find(x => x.id === driverId); if (!d) throw new StoreError('not_found', 'Driver not found');
    const reassign = !!o.driverId && o.driverId !== driverId;
    const prev = o.driverId;
    o.driverId = driverId;
    ensureRoute(o);
    if (o.status === 'requested' && !MDM.priceAfterCollection(o)) throw new StoreError('transition', 'Confirm the price before assigning a driver');
    const label = (reassign ? 'Driver changed to ' : 'Driver assigned: ') + d.name;
    if (o.status === 'requested') setStatus(o, 'assigned', 'assigned', label + '. We confirm your price from the driver\'s photo at collection', opts.by);
    else if (o.status === 'confirmed' && !o.batchId) setStatus(o, 'assigned', 'assigned', label, opts.by);
    else if (o.status === 'failed' && !o.batchId) setStatus(o, 'assigned', 'assigned', label, opts.by);
    else pushEvent(o, makeEvent('assigned', label, opts.by, 'public', { driverId }));
    const saved = save(o);
    if (prev && prev !== driverId) releaseDriverIfIdle(prev, o.id);
    return saved;
  }
  function dispatch(orderId, opts) {
    opts = opts || {};
    const o = orderOrThrow(orderId);
    if (!o.driverId) throw new StoreError('validation', 'Assign a driver first');
    if (o.batchId && o.status === 'collected') { setStatus(o, 'out_for_delivery', 'out_for_delivery', 'Out for delivery with ' + driverName(o.driverId), opts.by); return save(o); }
    setStatus(o, 'dispatched', 'dispatched', 'Dispatched to ' + driverName(o.driverId), opts.by);
    return save(o);
  }
  function releaseDriverIfIdle(driverId, exceptOrderId) {
    const active = readCol('orders').some(x => x.driverId === driverId && x.id !== exceptOrderId && ['on_the_way', 'arrived', 'collected', 'out_for_delivery'].indexOf(x.status) >= 0);
    if (!active) { const d = readCol('drivers').find(x => x.id === driverId); if (d && d.status === 'on_route') update('drivers', driverId, { status: 'online' }); }
  }
  function startRoute(orderId, opts) {
    opts = opts || {};
    const o = orderOrThrow(orderId);
    if (o.status === 'collected') { setStatus(o, 'out_for_delivery', 'out_for_delivery', 'Out for delivery with ' + driverName(o.driverId), opts.by); }
    else setStatus(o, 'on_the_way', 'route_started', driverName(o.driverId) + ' is on the way to collect', opts.by);
    if (o.driverId) update('drivers', o.driverId, { status: 'on_route' });
    return save(o);
  }
  function outForDelivery(orderId, opts) {
    opts = opts || {};
    const o = orderOrThrow(orderId);
    setStatus(o, 'out_for_delivery', 'out_for_delivery', 'Out for delivery with ' + driverName(o.driverId), opts.by);
    if (o.driverId) update('drivers', o.driverId, { status: 'on_route' });
    return save(o);
  }
  function settleShop(o) {
    if (o.service !== 'shop' && !(o.extraCollections || []).some(c => c.kind === 'shop')) return;
    const paid = o.payment && o.payment.status === 'paid' && o.payment.paidAmount != null ? o.payment.paidAmount : null;
    if (paid == null) return;
    const due = o.totals.total, balance = paid - due;
    o.settlement = { status: balance > 0 ? 'refund_due' : balance < 0 ? 'topup_due' : 'settled', paid, due, balance, settledAt: balance === 0 ? now() : null, reference: '' };
  }
  // setStop drives the driver's stop actions: arrived → done (collected / delivered) or failed.
  function setStop(orderId, stopId, p) {
    const o = orderOrThrow(orderId);
    if (!o.route || !o.route.stops) throw new StoreError('validation', 'Order has no route');
    const s = o.route.stops.find(x => x.id === stopId); if (!s) throw new StoreError('not_found', 'Stop not found');
    // A finished order takes no more stop actions; the one exception is bringing a cancelled order's package back (a return stop).
    if (['cancelled', 'delivered', 'returned'].indexOf(o.status) >= 0 && !(o.status === 'cancelled' && s.type === 'return')) throw new StoreError('transition', 'This order is already ' + MDM.STATUS[o.status].label.toLowerCase());
    const by = p.by || ('driver:' + (o.driverId || ''));
    const who = driverName(o.driverId);
    if (p.status === 'arrived') {
      s.status = 'arrived'; s.arrivedAt = now();
      if (s.type === 'pickup') {
        if (['dispatched', 'assigned'].indexOf(o.status) >= 0) setStatus(o, 'on_the_way', 'route_started', who + ' is on the way to collect', by);
        setStatus(o, 'arrived', 'arrived', who + ' arrived for collection', by, 'public', { stopId });
      } else pushEvent(o, makeEvent('arrived_delivery', who + ' arrived at ' + s.label.toLowerCase(), by, 'public', { stopId }));
    } else if (p.status === 'done') {
      s.status = 'done'; s.at = now(); s.remarks = p.remarks || s.remarks || '';
      if (s.type === 'pickup') {
        s.proofPhotoId = p.photoId || null;
        if (p.photoId) o.packages.filter(k => (s.packageIds || [s.packageId]).indexOf(k.id) >= 0).forEach(k => { if (!k.photoId) { k.photoId = p.photoId; k.photoSource = 'driver'; } });
        if (p.sizes) applySizes(o, p.sizes, by);
        if (s.shop) {
          // The receipt replaces the budget for the shopping fee: on the package (Shop & Deliver) or on the extra shop stop.
          const pkg = o.packages.find(k => k.id === s.packageId);
          const extra = s.collectionId ? (o.extraCollections || []).find(c => c.id === s.collectionId) : null;
          const sh = pkg && pkg.shop ? pkg.shop : extra && extra.shop ? extra.shop : null;
          if (sh) { sh.receiptTotal = Math.round(Number(p.receiptTotal) || 0); sh.receiptPhotoId = p.receiptPhotoId || null; recalc(o); }
          s.receiptTotal = p.receiptTotal; s.receiptPhotoId = p.receiptPhotoId || null;
        }
        const pickups = o.route.stops.filter(x => x.type === 'pickup');
        const label = s.shop ? 'Shopping done, receipt ' + fmt(s.receiptTotal || 0) : 'Collected from ' + (s.address || 'the collection point');
        if (pickups.every(x => x.status === 'done')) {
          if (o.status === 'dispatched') setStatus(o, 'on_the_way', 'route_started', who + ' is on the way to collect', by);
          if (o.status === 'on_the_way' || o.status === 'arrived') setStatus(o, 'collected', 'collected', label + (p.photoId ? ', proof photo added' : ''), by, 'public', { stopId });
          else pushEvent(o, makeEvent('collected', label, by, 'public', { stopId }));
        } else {
          pushEvent(o, makeEvent('collected_partial', label, by, 'public', { stopId }));
          if (o.status === 'arrived') setStatus(o, 'on_the_way', 'next_collection', who + ' is on the way to the next collection', by);
        }
        if (p.remarks) pushEvent(o, makeEvent('note', 'Driver remark: ' + p.remarks, by, 'internal', { stopId }));
        if (Number(p.naalu) > 0) addChargeOn(o, { type: 'naalu', stage: 'collection', amount: p.naalu, description: p.naaluNote || 'Paid at collection', paidBy: 'driver', by });
        if (MDM.priceToFinalise(o) && pickups.every(x => x.status === 'done')) notifyStaff(o, 'operations', 'Finalise the price', 'collected' + (p.photoId ? ' with a proof of collection photo' : '') + ': confirm the price while it is being delivered');
      } else {
        s.handedTo = p.handedTo || 'recipient'; s.recipientName = p.recipientName || ''; s.photoId = p.photoId || null; s.confirmed = !!p.confirmed;
        if (Number(p.naalu) > 0) addChargeOn(o, { type: 'naalu', stage: 'delivery', amount: p.naalu, description: p.naaluNote || 'Paid at delivery', paidBy: 'driver', by });
        if (Number(p.packing) > 0) addChargeOn(o, { type: 'packing', stage: 'delivery', amount: p.packing, description: p.packingNote || 'Packing at delivery', paidBy: 'driver', billable: true, by });
        // Maldivian Cargo deliveries: the counter's own bill, paid by the driver, goes on the customer's delivery charges with its photo.
        if (Number(p.cargoCharge) > 0) addChargeOn(o, { type: 'cargo', stage: 'delivery', amount: p.cargoCharge, description: p.cargoNote || 'Maldivian Cargo bill', paidBy: 'driver', billable: true, photoId: p.cargoBillPhotoId || null, by });
        if (o.cod && o.cod.amount > 0 && p.cashCollected != null && p.cashCollected !== '') {
          const got = Math.round(Number(p.cashCollected) || 0);
          // The cash is with the order's driver even when the office records the proof of delivery for them.
          const holder = by.indexOf('driver:') === 0 || !o.driverId ? by : 'driver:' + o.driverId;
          o.cod = Object.assign({}, o.cod, { status: got > 0 ? 'collected' : 'not_collected', collectedAmount: got, collectedAt: now(), collectedBy: holder, variance: got - o.cod.amount }, holder !== by ? { recordedBy: by } : {});
          pushEvent(o, makeEvent('cod_collected', 'Cash collected ' + fmt(got) + (got !== o.cod.amount ? ' (expected ' + fmt(o.cod.amount) + ')' : ''), by, 'internal', { stopId }));
          if (got !== o.cod.amount) notifyStaff(o, 'operations', 'Cash difference', 'driver collected ' + fmt(got) + ', expected ' + fmt(o.cod.amount));
        }
        const handed = { recipient: '', family: ' (family or colleague)', security: ' (security or reception)', left: ' (left as instructed)' }[s.handedTo] || '';
        const label = s.type === 'return' ? 'Returned to sender' : 'Delivered' + (s.recipientName ? ' to ' + s.recipientName : '') + handed;
        if (o.status === 'collected') setStatus(o, 'out_for_delivery', 'out_for_delivery', 'Out for delivery with ' + who, by);
        const drops = o.route.stops.filter(x => x.type === 'dropoff'), returns = o.route.stops.filter(x => x.type === 'return');
        if (returns.length && returns.every(x => x.status === 'done')) {
          if (o.cod && o.cod.status === 'pending') o.cod = Object.assign({}, o.cod, { status: 'not_collected', note: 'Returned to sender' });
          if (o.status === 'cancelled') closeReturn(o, by, p.remarks);
          else setStatus(o, 'returned', 'returned', 'Returned to sender', by, 'public', { stopId });
        } else if (o.status !== 'cancelled' && drops.every(x => x.status === 'done')) {
          setStatus(o, 'delivered', 'delivered', label, by, 'public', { stopId });
          settleShop(o);
          // A price still to be set from the proof of collection holds the invoice back; confirmPrice sends it.
          if (MDM.priceAfterCollection(o)) notifyStaff(o, 'operations', 'Finalise the price', 'delivered before the price was confirmed: confirm it to send the invoice');
          else if (o.payment && o.payment.status === 'pending') requestPaymentOn(o, 'system', false);
        } else pushEvent(o, makeEvent('delivered_partial', label, by, 'public', { stopId }));
        if (p.remarks) pushEvent(o, makeEvent('note', 'Driver remark: ' + p.remarks, by, 'internal', { stopId }));
        if (['delivered', 'returned'].indexOf(o.status) >= 0 && o.driverId) releaseDriverIfIdle(o.driverId, o.id);
      }
    } else if (p.status === 'failed') {
      s.status = 'failed'; s.failReason = p.failReason || 'other'; s.remarks = p.remarks || ''; s.failedAt = now(); s.failPhotoId = p.photoId || null;
      const r = MDM.FAIL_REASONS.find(x => x.value === s.failReason);
      const what = s.type === 'pickup' ? 'Collection failed' : 'Delivery failed';
      setStatus(o, 'failed', 'failed', what + ': ' + (r ? r.label.toLowerCase() : s.failReason), by, 'public', { stopId });
      if (p.remarks) pushEvent(o, makeEvent('note', 'Driver remark: ' + p.remarks, by, 'internal', { stopId }));
    }
    return save(o);
  }
  function applySizes(o, sizes, by) {
    // sizes: { packageId: { size, dims } } from the driver or operator; prices are re-derived from the rate card.
    const s = settings(); const before = o.totals.total;
    const acc = o.service === 'business' && o.accountId ? readCol('business_accounts').find(a => a.id === o.accountId) : null;
    o.packages.forEach(pkg => {
      const u = sizes[pkg.id]; if (!u) return;
      // Business packages are priced by size category (§5.2): a new size moves the package to that category at the account's agreed rate.
      if (o.service === 'business' && (u.tier || (u.size && u.size !== pkg.size))) {
        const tiers = MDM.pricing.businessTiers(s);
        const t = u.tier ? tiers.find(x => x.value === u.tier) : (tiers.find(x => x.size === u.size && acc && acc.rates && acc.rates[x.value] != null) || tiers.find(x => x.size === u.size));
        if (t) { if (pkg.tier !== t.value) o.changes = (o.changes || []).concat([{ at: now(), by, field: 'package ' + pkg.id + ' size category', from: pkg.tier || '', to: t.value }]); pkg.tier = t.value; pkg.tierRate = MDM.pricing.businessRate(acc, t.value, s); if (!u.size) u.size = t.size; }
      }
      if (u.size && u.size !== pkg.size) u.from = pkg.size;
      if (u.size && u.size !== pkg.size) o.changes = (o.changes || []).concat([{ at: now(), by, field: 'package ' + pkg.id + ' size', from: pkg.size, to: u.size }]);
      if (u.size) pkg.size = u.size;
      if (u.dims) pkg.dims = u.dims;
      pkg.sizeSource = by && by.indexOf('driver') === 0 ? 'driver' : 'operator';
    });
    const q = MDM.pricing.quote({ service: o.service, packages: o.packages }, s);
    o.packages = q.packages.map((p, i) => Object.assign({}, o.packages[i], { price: p.price }));
    recalc(o);
    const changed = Object.keys(sizes).filter(id => sizes[id] && sizes[id].from && sizes[id].size && sizes[id].from !== sizes[id].size).map(id => MDM.pricing.sizeLabel(sizes[id].from) + ' to ' + MDM.pricing.sizeLabel(sizes[id].size));
    if (o.totals.total !== before || changed.length) {
      priceHistory(o, before, o.totals.total, 'Package category changed' + (changed.length ? ': ' + changed.join(', ') : ''), by);
      pushEvent(o, makeEvent('size_updated', 'Package category changed' + (changed.length ? ' (' + changed.join(', ') + ')' : '') + (o.totals.total !== before ? ', price ' + fmt(before) + ' to ' + fmt(o.totals.total) : ''), by, o.pricing && o.pricing.status === 'confirmed' ? 'public' : 'internal'));
    }
  }
  function updatePackages(orderId, sizes, by) { const o = orderOrThrow(orderId); applySizes(o, sizes, by); return save(o); }
  // resolveFailure: the operator's decision on a failed collection or delivery.
  function resolveFailure(orderId, p) {
    const o = orderOrThrow(orderId);
    const failed = (o.route && o.route.stops || []).filter(x => x.status === 'failed');
    const by = p.by || 'admin';
    const resetFailed = () => failed.forEach(s => { s.status = 'pending'; s.attempts = (s.attempts || 0) + 1; s.failReason = null; s.failedAt = null; });
    const backTo = () => { const anyPickupDone = o.route.stops.some(s => s.type === 'pickup' && s.status === 'done'); return anyPickupDone ? 'collected' : 'dispatched'; };
    if (p.action === 'reschedule') {
      resetFailed();
      o.schedule = Object.assign({}, o.schedule, { rescheduledFor: p.when || '' });
      setStatus(o, backTo(), 'rescheduled', 'Rescheduled' + (p.when ? ' for ' + p.when : '') + (p.remarks ? ' (' + p.remarks + ')' : ''), by);
    } else if (p.action === 'reassign') {
      resetFailed();
      const d = readCol('drivers').find(x => x.id === p.driverId); if (!d) throw new StoreError('validation', 'Choose a driver');
      const prev = o.driverId; o.driverId = d.id;
      setStatus(o, backTo() === 'collected' ? 'collected' : 'assigned', 'reassigned', 'Reassigned to ' + d.name + (p.remarks ? ' (' + p.remarks + ')' : ''), by);
      if (prev && prev !== d.id) releaseDriverIfIdle(prev, o.id);
    } else if (p.action === 'return') {
      if (!failed.length) throw new StoreError('validation', 'No failed stop to return');
      const pickup = o.route.stops.find(x => x.type === 'pickup') || o.route.stops[0];
      failed.forEach(s => { s.status = 'skipped'; });
      o.route.stops.push({ id: MDM.id('stp'), packageId: failed[0].packageId, packageIds: failed[0].packageIds || [failed[0].packageId], type: 'return', label: 'Return to sender', address: pickup.address, landmark: pickup.landmark || '', zone: pickup.zone, lat: pickup.lat, lng: pickup.lng, contact: pickup.contact, status: 'pending', at: null, attempts: 0 });
      o.route.polyline = MDM.geo.routeThrough(o.route.stops.filter(x => x.status !== 'done' && x.status !== 'skipped'));
      setStatus(o, 'out_for_delivery', 'return_added', 'Returning the package to the sender' + (p.remarks ? ' (' + p.remarks + ')' : ''), by);
    } else if (p.action === 'contact') {
      pushEvent(o, makeEvent('contacted', 'We are contacting you about this order' + (p.remarks ? ': ' + p.remarks : ''), by, 'public'));
    } else if (p.action === 'cancel') {
      cancelOn(o, p.remarks || 'Could not be completed', by);
    }
    return save(o);
  }
  function driverRoute(driverId) {
    const mine = readCol('orders').filter(o => o.driverId === driverId && ['dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery', 'failed'].indexOf(o.status) >= 0);
    // Priority and express jobs first, then oldest first.
    const rank = o => (o.priority && o.priority.status === 'approved' ? 0 : 1);
    const orders = sortBy(mine, 'createdAt').sort((a, b) => rank(a) - rank(b));
    const stops = [];
    orders.forEach(o => (o.route && o.route.stops || []).forEach(s => stops.push(Object.assign({}, s, { orderId: o.id, code: o.code, orderStatus: o.status }))));
    const open = stops.filter(s => ['done', 'failed', 'skipped'].indexOf(s.status) < 0);
    const done = stops.filter(s => s.status === 'done').sort((a, b) => (a.at || '') < (b.at || '') ? -1 : 1);
    const chain = (done.length ? [done[done.length - 1]] : []).concat(open);
    const polyline = chain.length >= 2 ? MDM.geo.routeThrough(chain) : (chain.length === 1 ? [[chain[0].lat, chain[0].lng]] : []);
    // Business cancellations after collection: the driver still holds the package and has to bring it back (§5.5).
    const returns = readCol('orders').filter(o => o.driverId === driverId && o.status === 'cancelled' && o.cancellation && o.cancellation.returnStatus === 'pending');
    return clone({ orders, stops, polyline, returns });
  }

  // ---- Bulk business orders (requirements §10) --------------------------------------------------------------------------
  // A batch is one collection from the business and one child order per package, so every package stays trackable on its own.
  function createBatch(b) {
    const acc = readCol('business_accounts').find(a => a.id === b.accountId); if (!acc) throw new StoreError('not_found', 'Business account not found');
    const s = settings();
    const col = Object.assign({}, b.collection || {});
    const batch = insert('batches', { accountId: acc.id, name: acc.name, serviceLevel: b.serviceLevel || 'normal', collection: col, collectionPointId: col.pointId || null, preferredTime: col.preferredTime || '', notes: b.notes || '', status: 'confirmed', orderIds: [], source: b.source || 'portal', by: b.by || ('business:' + acc.id) });
    const ids = [];
    (b.rows || []).forEach((r, i) => {
      const tier = r.tier || (acc.tiers && acc.tiers[0]) || 'small';
      const tierInfo = MDM.pricing.businessTiers(s).find(t => t.value === tier) || {};
      const size = r.size || tierInfo.size || 'bag';
      const delivery = { method: r.method || 'home', address: r.address || '', zone: r.zone || 'male', landmark: r.landmark || '', recipientName: r.name || '', recipientPhone: r.phone || '', instructions: r.instructions || '', meetAt: 'door', boat: r.boat || null, cargo: r.cargo || null, airport: r.airport || null };
      const end = deliveryEndpoint(delivery);
      const pkg = { id: MDM.id('pkg'), size, tier, tierRate: MDM.pricing.businessRate(acc, tier, s), description: r.description || '', underOneFt: size === 'bag', fragile: !!r.fragile, needsVehicle: false,
        pickup: { address: col.address, zone: col.zone, landmark: col.landmark || '', contact: { name: col.contactName, phone: col.contactPhone } },
        dropoff: end };
      const q = MDM.pricing.quote({ service: 'business', packages: [pkg] }, s);
      const cod = Math.round(Number(r.cod) || 0);
      const order = insert('orders', {
        source: b.source || 'business', requestType: 'bulk', service: 'business', serviceLevel: b.serviceLevel || 'normal', accountId: acc.id, batchId: batch.id, batchIndex: i + 1,
        customerId: null, customer: { name: acc.name, phone: acc.phone, email: acc.email || '', notify: 'whatsapp' },
        collection: col, delivery: Object.assign({}, delivery, { address: delivery.method === 'home' ? delivery.address : (r.address || end.address), zone: end.zone }),
        details: { reference: r.reference || '' }, documents: [], packages: q.packages, fees: q.fees, totals: q.totals,
        estimate: { min: q.totals.total, max: q.totals.total }, pricing: { status: 'confirmed', confirmedAt: now(), confirmedBy: 'system', remarks: 'Business rate: ' + (tierInfo.label || tier), history: [] },
        schedule: { type: 'asap' }, payment: { method: 'invoice', status: 'invoiced' }, cod: cod > 0 ? { amount: cod, status: 'pending', collectedAmount: null } : null, charges: [],
        priority: { level: 'normal', status: 'none', requests: [] }, cancellation: { status: 'none' }, changes: [], statusHistory: [{ at: now(), from: null, to: 'confirmed', by: b.by || ('business:' + acc.id) }],
        status: 'confirmed', driverId: null, route: { stops: [], polyline: [] }, events: [], notes: [] });
      ids.push(order.id);
    });
    const saved = update('batches', batch.id, { orderIds: ids });
    readCol('orders').filter(o => ids.indexOf(o.id) >= 0).forEach(o => { const x = clone(o); pushEvent(x, makeEvent('created', 'Order submitted (bulk ' + saved.code + ', package ' + x.batchIndex + ' of ' + ids.length + ')', b.by || 'business', 'public')); save(x); });
    audit('batch_created', 'Bulk order ' + saved.code + ' with ' + ids.length + ' packages', b.by || ('business:' + acc.id), { batchId: saved.id });
    return clone(saved);
  }
  function batchCollected(batchId, p) {
    const batch = readCol('batches').find(x => x.id === batchId); if (!batch) throw new StoreError('not_found', 'Batch not found');
    readCol('orders').filter(o => o.batchId === batchId && o.status === 'confirmed').forEach(o => { const x = clone(o); ensureRoute(x); x.route.stops.filter(s => s.type === 'pickup').forEach(s => { s.status = 'done'; s.at = now(); }); setStatus(x, 'collected', 'collected', 'Collected, sorting at our hub', p && p.by); save(x); });
    return update('batches', batchId, { status: 'collected', collectedAt: now() });
  }
  // assignByZone: every package goes to the first active driver of its delivery zone (requirements §10, §16).
  function assignByZone(batchId, p) {
    const zones = readCol('zones');
    const out = { assigned: 0, unmatched: 0 };
    readCol('orders').filter(o => o.batchId === batchId && ['confirmed', 'collected'].indexOf(o.status) >= 0).forEach(o => {
      const z = zones.find(x => x.key === (o.delivery && o.delivery.zone));
      const drv = z && (z.driverIds || [])[0];
      if (!drv) { out.unmatched++; return; }
      const x = clone(o); ensureRoute(x); x.driverId = drv;
      pushEvent(x, makeEvent('assigned', 'Assigned to ' + driverName(drv) + ' for ' + (z.name || z.key), p && p.by, 'public', { driverId: drv }));
      save(x); out.assigned++;
    });
    return out;
  }
  // batchStatus → the bulk order's own status: confirmed, collected, out_for_delivery (a package is out), partly_delivered (some delivered,
  // none out, some still to go), delivered (every package finished) or paid. amount leaves out cancelled packages.
  function batchStatus(batch) {
    const kids = readCol('orders').filter(o => o.batchId === batch.id);
    const by = st => kids.filter(o => o.status === st).length;
    const n = kids.length;
    let status = 'confirmed';
    if (n && kids.every(o => ['delivered', 'cancelled', 'returned'].indexOf(o.status) >= 0)) status = 'delivered';
    else if (kids.some(o => o.status === 'out_for_delivery')) status = 'out_for_delivery';
    else if (kids.some(o => o.status === 'delivered')) status = 'partly_delivered';
    else if (kids.some(o => o.status === 'collected')) status = 'collected';
    const paid = kids.length && kids.every(o => o.payment && o.payment.status === 'paid');
    return { status: paid && status === 'delivered' ? 'paid' : status, total: n, delivered: by('delivered'), out: by('out_for_delivery'), collected: by('collected'), failed: by('failed'), cancelled: by('cancelled'), amount: kids.filter(o => o.status !== 'cancelled').reduce((t, o) => t + (o.totals ? o.totals.total : 0), 0) };
  }

  // ---- E-store (How it works §7) ----------------------------------------------------------------------------------------
  function createStoreOrder(o) {
    const s = settings();
    const products = readCol('products');
    const items = (o.items || []).map(it => { const p = products.find(x => x.id === it.productId); if (!p) throw new StoreError('validation', 'A product is no longer available'); if (p.stock != null && p.stock < it.qty) throw new StoreError('validation', p.name + ': only ' + p.stock + ' left'); return { productId: p.id, name: p.name, unit: p.unit || '', qty: it.qty, price: p.price, total: p.price * it.qty }; });
    if (!items.length) throw new StoreError('validation', 'Your cart is empty');
    const store = s.store || {};
    const pkg = { id: MDM.id('pkg'), size: items.reduce((n, i) => n + i.qty, 0) > 6 ? 'box' : 'bag', description: items.map(i => i.qty + ' × ' + i.name).join(', '), pickup: { address: store.address || 'Mr. Delivery Man store, Malé', zone: store.zone || 'male', landmark: '', contact: { name: 'Mr. Delivery Man store', phone: (s.contact || {}).phone || '' } }, dropoff: { address: o.delivery.address, zone: o.delivery.zone, landmark: o.delivery.landmark || '', recipient: { name: o.customer.name, phone: o.customer.phone }, instructions: o.delivery.instructions || '' } };
    const q = MDM.pricing.quote({ service: 'pick', packages: [pkg] }, s);
    const itemsTotal = items.reduce((n, i) => n + i.total, 0);
    const totals = Object.assign({}, q.totals, { items: itemsTotal, total: q.totals.total + itemsTotal });
    items.forEach(it => { const p = products.find(x => x.id === it.productId); if (p.stock != null) update('products', p.id, { stock: p.stock - it.qty }); });
    const order = insert('orders', {
      source: 'store', requestType: 'store', service: 'store', serviceLevel: 'normal', customerId: o.customerId || null, customer: o.customer, items,
      collection: { address: pkg.pickup.address, zone: pkg.pickup.zone, contactName: 'Mr. Delivery Man store', contactPhone: pkg.pickup.contact.phone },
      delivery: Object.assign({ recipientName: o.customer.name, recipientPhone: o.customer.phone }, o.delivery), details: {}, documents: [],
      packages: q.packages, fees: q.fees, totals, estimate: { min: totals.total, max: totals.total }, pricing: { status: 'confirmed', confirmedAt: now(), confirmedBy: 'system', remarks: 'Store prices', history: [] },
      schedule: o.schedule || { type: 'asap' }, payment: { method: 'transfer', status: 'pending' }, priority: { level: 'normal', status: 'none', requests: [] }, cancellation: { status: 'none' }, changes: [], statusHistory: [{ at: now(), from: null, to: 'confirmed', by: 'customer' }],
      status: 'confirmed', driverId: null, route: { stops: [], polyline: [] }, events: [], notes: [] });
    const x = clone(order); pushEvent(x, makeEvent('created', 'E-store order placed: ' + items.length + ' item' + (items.length > 1 ? 's' : ''), 'customer', 'public'));
    if (o.payNow) requestPaymentOn(x, 'system', true);
    return save(x);
  }

  // ---- HR: attendance and leave (How it works §10, §11; requirements §22) -----------------------------------------------
  const dayKey = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  function openShift(staffId) { return readCol('attendance').find(a => a.staffId === staffId && !a.outAt) || null; }
  function punchIn(staffId, p) {
    p = p || {};
    if (openShift(staffId)) throw new StoreError('validation', 'Already punched in');
    const st = readCol('staff').find(x => x.id === staffId); if (!st) throw new StoreError('not_found', 'Employee not found');
    const rec = insert('attendance', { staffId, date: dayKey(new Date()), inAt: now(), outAt: null, source: p.source || 'portal', note: p.note || '' });
    audit('punch_in', st.name + ' punched in', 'staff:' + staffId, { staffId });
    return rec;
  }
  function punchOut(staffId, p) {
    p = p || {};
    const open = openShift(staffId); if (!open) throw new StoreError('validation', 'Not punched in');
    const st = readCol('staff').find(x => x.id === staffId);
    const rec = update('attendance', open.id, { outAt: now(), note: p.note || open.note || '' });
    audit('punch_out', (st ? st.name : 'Employee') + ' punched out', 'staff:' + staffId, { staffId });
    return rec;
  }
  function requestLeave(l) {
    const st = readCol('staff').find(x => x.id === l.staffId); if (!st) throw new StoreError('not_found', 'Employee not found');
    const from = new Date(l.from), to = new Date(l.to);
    if (!(from <= to)) throw new StoreError('validation', 'The end date must be on or after the start date');
    const days = Math.round((to - from) / 86400000) + 1;
    if (l.type === 'off_day') {
      // Off days already asked for (pending) are spoken for, so they do not count twice.
      const asked = readCol('leaves').filter(x => x.staffId === l.staffId && x.type === 'off_day' && x.status === 'pending').reduce((n, x) => n + (Number(x.days) || 0), 0);
      const left = Math.max(0, offDayBalance(l.staffId).balance - asked);
      if (days > left) throw new StoreError('validation', 'Only ' + left + ' accumulated off day' + (left === 1 ? '' : 's') + ' left to request');
    }
    const rec = insert('leaves', { staffId: l.staffId, type: l.type || 'annual', from: l.from, to: l.to, days, reason: l.reason || '', status: 'pending', decidedBy: null, decidedAt: null, remarks: '' });
    audit('leave_requested', st.name + ' requested ' + days + ' day' + (days > 1 ? 's' : '') + ' of leave', 'staff:' + l.staffId, { leaveId: rec.id });
    return rec;
  }
  function decideLeave(leaveId, p) {
    const lv = readCol('leaves').find(x => x.id === leaveId); if (!lv) throw new StoreError('not_found', 'Leave request not found');
    if (p.approve && lv.type === 'off_day' && lv.status !== 'approved') {
      const b = offDayBalance(lv.staffId).balance;
      if ((Number(lv.days) || 0) > b) throw new StoreError('validation', 'Only ' + b + ' accumulated off day' + (b === 1 ? '' : 's') + ' available');
    }
    const rec = update('leaves', leaveId, { status: p.approve ? 'approved' : 'rejected', decidedBy: p.by || 'admin', decidedAt: now(), remarks: p.remarks || '' });
    const st = readCol('staff').find(x => x.id === lv.staffId);
    audit(p.approve ? 'leave_approved' : 'leave_rejected', (p.approve ? 'Approved' : 'Rejected') + ' leave for ' + (st ? st.name : 'employee'), p.by || 'admin', { leaveId });
    return rec;
  }

  // ---- Customers, invoices, lookups ------------------------------------------------------------------------------------
  function upsertCustomer(c) {
    const phone = normPhone(c.phone);
    if (!phone) throw new StoreError('validation', 'A valid phone number is required');
    const existing = readCol('customers').find(x => x.phone === phone);
    const t = now();
    if (existing) {
      const patch = { name: c.name || existing.name, email: c.email || existing.email || '', notify: c.notify || existing.notify || 'whatsapp', lastOrderAt: c.touch === false ? existing.lastOrderAt : t, orderCount: (existing.orderCount || 0) + (c.touch === false ? 0 : 1) };
      if (c.termsAcceptedAt && !existing.termsAcceptedAt) patch.termsAcceptedAt = c.termsAcceptedAt;
      if (c.address && !(existing.addresses || []).some(a => a.address === c.address.address)) patch.addresses = (existing.addresses || []).concat([Object.assign({ id: MDM.id('adr'), label: 'Other' }, c.address)]);
      return update('customers', existing.id, patch);
    }
    return insert('customers', { name: c.name || '', phone, email: c.email || '', notify: c.notify || 'whatsapp', addresses: c.address ? [Object.assign({ id: MDM.id('adr'), label: 'Home' }, c.address)] : [], lastOrderAt: c.touch === false ? null : t, orderCount: c.touch === false ? 0 : 1, termsAcceptedAt: c.termsAcceptedAt || null });
  }
  // createOrder: the one place customer and admin requests become orders (keeps the shape identical everywhere).
  function createOrder(d) {
    const s = settings();
    d = Object.assign({}, d, { delivery: Object.assign({ method: 'home' }, d.delivery || {}) });
    const method = d.delivery.method;
    // Boat, cargo and airport deliveries drop at the jetty, the cargo counter or the airport point; keep each package's end in step.
    if (method !== 'home') {
      const end = deliveryEndpoint(d.delivery);
      d.packages = (d.packages || []).map(p => Object.assign({}, p, { dropoff: Object.assign({}, p.dropoff || {}, end, { recipient: (p.dropoff && p.dropoff.recipient) || end.recipient }) }));
      if (!d.delivery.address) d.delivery.address = end.address;
      d.delivery.zone = end.zone;
    }
    if (d.extraVehicle) d.packages = (d.packages || []).map(p => (p.size === 'box' || p.size === 'xl') ? Object.assign({}, p, { needsVehicle: true }) : p);
    if (d.service === 'business' && d.accountId) {
      const acc = readCol('business_accounts').find(a => a.id === d.accountId);
      if (acc) d.packages = (d.packages || []).map(p => p.tier && p.tierRate == null ? Object.assign({}, p, { tierRate: MDM.pricing.businessRate(acc, p.tier, s) }) : p);
    }
    // Extra collection points (multi collection): cleaned here so every page stores the same shape.
    const extraCollections = (Array.isArray(d.extraCollections) ? d.extraCollections : []).filter(c => c && String(c.address || '').trim()).slice(0, MDM.MAX_EXTRA_COLLECTIONS).map(c => {
      const shop = c.kind === 'shop';
      return { id: c.id || MDM.id('col'), kind: shop ? 'shop' : 'collect', address: String(c.address).trim(), zone: c.zone && c.zone !== 'airport' ? c.zone : 'male', landmark: String(c.landmark || '').trim(),
        contactName: shop ? '' : String(c.contactName || '').trim(), contactPhone: shop ? '' : normPhone(c.contactPhone) || String(c.contactPhone || '').trim(), instructions: String(c.instructions || '').trim(),
        shop: shop ? { name: String((c.shop || {}).name || '').trim(), phone: normPhone((c.shop || {}).phone) || '', list: String((c.shop || {}).list || '').trim(), budget: Math.round(Number((c.shop || {}).budget) || 0), unavailable: (c.shop || {}).unavailable || 'call', receiptTotal: null, receiptPhotoId: null } : null };
    });
    const shopStop = extraCollections.some(c => c.kind === 'shop');
    const q = MDM.pricing.quote({ service: d.service || 'pick', packages: d.packages, extraCollections }, s);
    const est = MDM.pricing.estimateRange(d.packages, s, d.service || 'pick', extraCollections);
    const level = d.serviceLevel || 'normal';
    const needsReview = q.totals.quoteRequired || (d.packages || []).some(p => p.photoId) || level === 'express' || d.requestType === 'office';
    // No package photo on a pick & deliver request: a driver can be assigned straight away and the price is set from the proof of
    // collection. Shopping (paid upfront, before we buy) and orders created already confirmed keep the price-first flow.
    const afterCollection = (d.service || 'pick') === 'pick' && !shopStop && (!d.status || d.status === 'requested') && !(d.packages || []).some(p => p.photoId);
    const order = insert('orders', {
      source: d.source || 'web', requestType: d.requestType || 'home', service: d.service || 'pick', serviceLevel: level, accountId: d.accountId || null,
      customerId: d.customerId || null, customer: d.customer, collection: d.collection, delivery: d.delivery, details: d.details || {}, documents: d.documents || [],
      packages: q.packages, fees: q.fees, totals: q.totals, estimate: est, pricing: { status: 'estimated', history: [], needsReview, afterCollection },
      schedule: d.schedule || { type: 'asap' }, payment: Object.assign({ method: 'transfer', status: 'pending', upfrontRequired: d.service === 'shop' }, d.payment || {}, shopStop ? { upfrontRequired: true } : {}),
      extraCollections, termsAcceptedAt: d.termsAcceptedAt || null,
      priority: { level: level === 'express' ? 'express' : 'normal', status: 'none', requests: [] }, cancellation: { status: 'none' }, changes: [],
      statusHistory: [{ at: now(), from: null, to: d.status || 'requested', by: d.by || 'customer' }],
      status: d.status || 'requested', driverId: null, route: { stops: [], polyline: [] }, events: [], notes: d.notes || [],
      extraVehicle: !!d.extraVehicle, items: d.items || null, charges: [],
      cod: Number(d.cod) > 0 ? { amount: Math.round(Number(d.cod)), status: 'pending', collectedAmount: null } : null });
    const x = clone(order);
    const acc = d.accountId ? readCol('business_accounts').find(a => a.id === d.accountId) : null;
    const createdLabel = d.source === 'web' || !d.source ? 'Order submitted, we will confirm the price shortly'
      : d.source === 'business' ? 'Order submitted by ' + (acc ? acc.name : 'the business')
      : d.source === 'store' ? 'E-store order placed' : 'Order created by our team (' + d.source + ')';
    pushEvent(x, makeEvent('created', createdLabel, d.by || 'customer', 'public'));
    if (level === 'express') { x.priority.status = 'requested'; x.priority.requests = [{ id: MDM.id('pri'), at: now(), by: d.by || 'customer', reason: 'Express delivery chosen when booking', deadline: '', instructions: '', decision: 'pending', decidedAt: null, decidedBy: null, remarks: '' }]; }
    if (d.status === 'confirmed') { x.pricing.status = 'confirmed'; x.pricing.confirmedAt = now(); x.pricing.confirmedBy = d.by || 'admin'; }
    return save(x);
  }
  function createInvoice(accountId, month) {
    const acc = readCol('business_accounts').find(a => a.id === accountId); if (!acc) throw new StoreError('not_found', 'Account not found');
    const s = settings();
    const orders = readCol('orders').filter(o => o.accountId === accountId && o.status === 'delivered');
    const lines = [];
    orders.forEach(o => {
      const ev = (o.events || []).filter(e => e.type === 'delivered').pop();
      const at = ev ? ev.at : o.updatedAt;
      if (at.slice(0, 7) !== month) return;
      (o.packages || []).forEach(pkg => {
        const rate = pkg.price ? pkg.price.lineTotal : (acc.ratePerPackage || s.rates.business);
        lines.push({ kind: 'package', tier: pkg.tier || null, size: pkg.size, date: at, orderCode: o.code, recipient: pkg.dropoff && pkg.dropoff.recipient ? pkg.dropoff.recipient.name : '', description: pkg.description || '', packages: 1, rate, amount: rate });
      });
      if (o.fees && o.fees.cargo) lines.push({ kind: 'cargo', date: at, orderCode: o.code, recipient: '', description: 'Maldivian Cargo fee', packages: 0, rate: o.fees.cargo, amount: o.fees.cargo });
      if (o.fees && o.fees.airport) lines.push({ kind: 'airport', date: at, orderCode: o.code, recipient: '', description: 'Airport fee', packages: 0, rate: o.fees.airport, amount: o.fees.airport });
      (o.fees && o.fees.adjustments || []).forEach(a => lines.push({ kind: 'adjustment', preset: a.preset || null, date: at, orderCode: o.code, recipient: '', description: a.label, packages: 0, rate: a.amount, amount: a.amount }));
    });
    const subtotal = lines.reduce((n, l) => n + l.amount, 0);
    const gstPercent = Number(s.gstPercent) || 0;
    const gst = Math.round(subtotal * gstPercent) / 100;
    const m = meta(); const number = 'INV-' + month + '-' + String(m.invoiceSeq).padStart(3, '0'); m.invoiceSeq += 1; writeMeta(m);
    const issued = new Date(); const due = new Date(issued.getTime() + (Number(s.invoiceDueDays) || 14) * 86400000);
    const inv = insert('invoices', { accountId, month, number, lines, subtotal, gstPercent, gst, total: Math.round((subtotal + gst) * 100) / 100, status: 'draft', issuedAt: issued.toISOString(), dueAt: due.toISOString(), paidAt: null, reference: '' });
    audit('invoice_created', 'Invoice ' + number + ' for ' + acc.name, 'admin', { invoiceId: inv.id });
    return inv;
  }
  function orderByCode(code) {
    let c = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (/^\d+$/.test(c)) c = 'MDM-' + c;
    if (/^MDM\d+$/.test(c)) c = 'MDM-' + c.slice(3);
    const o = readCol('orders').find(x => x.code === c);
    return o ? clone(o) : null;
  }


  // ---- Charges on proof of collection / delivery (web app updates §6) ---------------------------------------------------
  // A charge records money paid out for an order (naalu to boat porters, packing, anything else). Billable charges are also added to the
  // customer's price as an adjustment, linked both ways so un-billing or voiding removes exactly that line.
  function chargeLabel(ch) { const t = (MDM.CHARGE_TYPES.find(x => x.value === ch.type) || {}).label || 'Charge'; return ch.type === 'other' && ch.description ? ch.description : t; }
  function billCharge(o, ch, by) {
    const before = o.totals.total;
    const adj = { id: MDM.id('adj'), preset: ch.type === 'other' ? 'other' : ch.type, label: chargeLabel(ch), amount: ch.amount, at: now(), by: by || 'admin', remarks: ch.description || '', chargeId: ch.id };
    o.fees = o.fees || { cargo: 0, airport: 0, shopping: 0, adjustments: [] };
    o.fees.adjustments = (o.fees.adjustments || []).concat([adj]);
    recalc(o); priceHistory(o, before, o.totals.total, chargeLabel(ch) + ' added to the price', by);
    ch.billable = true; ch.adjustmentId = adj.id;
    if (o.pricing && o.pricing.status === 'confirmed') pushEvent(o, makeEvent('adjustment', 'Price updated: ' + chargeLabel(ch) + ' ' + fmt(ch.amount), by, 'public', { chargeId: ch.id }));
  }
  function unbillCharge(o, ch, by) {
    if (!ch.adjustmentId) { ch.billable = false; return; }
    const before = o.totals.total;
    o.fees.adjustments = (o.fees.adjustments || []).filter(a => a.id !== ch.adjustmentId);
    recalc(o); priceHistory(o, before, o.totals.total, chargeLabel(ch) + ' removed from the price', by);
    ch.billable = false; ch.adjustmentId = null;
  }
  function addChargeOn(o, c) {
    const type = MDM.CHARGE_TYPES.some(t => t.value === c.type) ? c.type : 'other';
    const amount = Math.round(Number(c.amount) || 0);
    if (!(amount > 0)) throw new StoreError('validation', 'Enter an amount');
    if (type === 'other' && !String(c.description || '').trim()) throw new StoreError('validation', 'Describe the charge');
    const by = c.by || 'admin';
    const rules = settings().rules || {};
    const billable = c.billable != null ? !!c.billable : type === 'packing' || type === 'cargo' ? true : type === 'naalu' ? !!rules.naaluBillable : false;
    const ch = { id: MDM.id('chg'), type, stage: c.stage || 'office', amount, description: String(c.description || '').trim(), paidBy: c.paidBy || (by.indexOf('driver:') === 0 ? 'driver' : 'office'), billable: false, adjustmentId: null, photoId: c.photoId || null, by, at: now(), void: false };
    o.charges = (o.charges || []).concat([ch]);
    if (billable) billCharge(o, ch, by);
    const where = { collection: ' at collection', delivery: ' at delivery' }[ch.stage] || '';
    pushEvent(o, makeEvent('charge_added', chargeLabel(ch) + ' ' + fmt(amount) + where + (ch.paidBy === 'driver' ? ', paid by the driver' : '') + (ch.billable ? ', added to the price' : ''), by, 'internal', { chargeId: ch.id }));
    return ch;
  }
  function addCharge(orderId, c) { const o = orderOrThrow(orderId); addChargeOn(o, c); return save(o); }
  function setChargeBillable(orderId, chargeId, billable, by) {
    const o = orderOrThrow(orderId);
    const ch = (o.charges || []).find(x => x.id === chargeId); if (!ch || ch.void) throw new StoreError('not_found', 'Charge not found');
    if (!!billable === !!ch.billable) return clone(o);
    if (billable) billCharge(o, ch, by); else unbillCharge(o, ch, by);
    pushEvent(o, makeEvent('charge_updated', chargeLabel(ch) + ' ' + fmt(ch.amount) + (billable ? ' added to the price' : ' no longer charged to the customer'), by, 'internal', { chargeId }));
    return save(o);
  }
  function voidCharge(orderId, chargeId, p) {
    const o = orderOrThrow(orderId);
    const ch = (o.charges || []).find(x => x.id === chargeId); if (!ch || ch.void) throw new StoreError('not_found', 'Charge not found');
    if (ch.billable) unbillCharge(o, ch, p && p.by);
    ch.void = true; ch.voidedAt = now(); ch.voidedBy = (p && p.by) || 'admin'; ch.voidReason = (p && p.reason) || '';
    pushEvent(o, makeEvent('charge_voided', chargeLabel(ch) + ' ' + fmt(ch.amount) + ' voided' + (ch.voidReason ? ': ' + ch.voidReason : ''), p && p.by, 'internal', { chargeId }));
    return save(o);
  }
  // §6.1 reconciliation: charges a driver paid out of pocket (naalu, fees) are reimbursed by the office; stamp them so the balance owed is clear.
  // The driver who paid is the one who recorded the charge; an office entry for a driver counts against the order's driver. Orders can
  // change driver after a charge, so this (not order.driverId) decides who is owed.
  function reimburseCharges(driverId, p) {
    p = p || {};
    let total = 0, count = 0;
    const payer = (c, o) => c.by && String(c.by).indexOf('driver:') === 0 ? String(c.by).slice(7) : o.driverId;
    const owed = (c, o) => c.paidBy === 'driver' && !c.void && !c.reimbursedAt && payer(c, o) === driverId && (!p.chargeIds || p.chargeIds.indexOf(c.id) >= 0);
    readCol('orders').filter(o => (o.charges || []).some(c => owed(c, o))).forEach(row => {
      const o = clone(row);
      o.charges.forEach(c => {
        if (!owed(c, o)) return;
        c.reimbursedAt = now(); c.reimbursedBy = p.by || 'admin'; c.reimbursementRef = p.reference || '';
        total += c.amount; count++;
        pushEvent(o, makeEvent('charge_reimbursed', chargeLabel(c) + ' ' + fmt(c.amount) + ' reimbursed to ' + driverName(driverId) + (p.reference ? ' (ref ' + p.reference + ')' : ''), p.by, 'internal', { chargeId: c.id }));
      });
      save(o);
    });
    if (count) audit('charges_reimbursed', 'Reimbursed ' + fmt(total) + ' to ' + driverName(driverId) + ' for ' + count + ' charge' + (count > 1 ? 's' : '') + (p.reference ? ' (ref ' + p.reference + ')' : ''), p.by || 'admin', { driverId, total });
    return { count, total };
  }
  // §2.3: operators can add an extra vehicle charge to any order. order.extraVehicle stays what the customer asked for at booking;
  // order.vehicleCharged says the office has charged for a vehicle.
  function addVehicleCharge(orderId, p) {
    const o = orderOrThrow(orderId);
    const amount = Math.round(Number(p.amount) || 0); if (!(amount > 0)) throw new StoreError('validation', 'Enter the vehicle charge');
    const before = o.totals.total;
    o.fees.adjustments = (o.fees.adjustments || []).concat([{ id: MDM.id('adj'), preset: 'vehicle', label: 'Extra vehicle charge', amount, at: now(), by: p.by || 'admin', remarks: p.remarks || '' }]);
    o.vehicleCharged = true;
    recalc(o); priceHistory(o, before, o.totals.total, 'Extra vehicle charge' + (p.remarks ? ': ' + p.remarks : ''), p.by);
    const visible = o.pricing && o.pricing.status === 'confirmed';
    pushEvent(o, makeEvent('adjustment', (visible ? 'Price updated: ' : 'Adjustment: ') + 'extra vehicle ' + fmt(amount), p.by, visible ? 'public' : 'internal'));
    return save(o);
  }

  // ---- Boat details can change after booking (§5.3 note: speedboat changed, missed by the driver) ---------------------------
  const BOAT_FIELDS = ['vesselType', 'name', 'departureDate', 'departureTime', 'jetty', 'island', 'address', 'contact'];
  function updateBoat(orderId, boat, p) {
    p = p || {};
    const o = orderOrThrow(orderId);
    if (!o.delivery || o.delivery.method !== 'boat') throw new StoreError('validation', 'This order is not a boat delivery');
    if (['delivered', 'cancelled', 'returned'].indexOf(o.status) >= 0) throw new StoreError('transition', 'This order is already ' + MDM.STATUS[o.status].label.toLowerCase());
    const cur = o.delivery.boat || {};
    const changed = BOAT_FIELDS.filter(k => boat[k] != null && String(boat[k]) !== String(cur[k] == null ? '' : cur[k]));
    if (!changed.length) return clone(o);
    const by = p.by || 'admin';
    const from = {}, to = {};
    changed.forEach(k => { from[k] = cur[k] == null ? '' : cur[k]; to[k] = boat[k]; });
    const next = Object.assign({}, cur, to, { history: (cur.history || []).concat([{ at: now(), by, reason: p.reason || 'other', note: p.note || '', from, to }]) });
    o.delivery = Object.assign({}, o.delivery, { boat: next });
    o.changes = (o.changes || []).concat(changed.map(k => ({ at: now(), by, field: 'delivery boat ' + k, from: from[k], to: to[k] })));
    // The jetty decides where the driver goes; re-point the drop-off and redraw the route if it is not done yet.
    const oldEnd = deliveryEndpoint(Object.assign({}, o.delivery, { boat: cur }));
    const end = deliveryEndpoint(o.delivery);
    // The order-level copy follows: the landmark ('Huraa, departs 23:30') and zone always; the address only where it was the hand-over
    // point itself (not the receiver's address on the island, unless that is what changed).
    const dAddr = o.delivery.address || '';
    o.delivery.landmark = end.landmark; o.delivery.zone = end.zone;
    if (!dAddr || dAddr === oldEnd.address) o.delivery.address = end.address;
    else if (to.address != null && dAddr === String(from.address)) o.delivery.address = to.address;
    (o.packages || []).forEach(pkg => { pkg.dropoff = Object.assign({}, pkg.dropoff, end, { recipient: (pkg.dropoff && pkg.dropoff.recipient) || end.recipient }); });
    if (o.route && o.route.stops) o.route.stops.forEach(st => { if (st.type === 'dropoff' && st.status !== 'done') Object.assign(st, { address: end.address, zone: end.zone, landmark: end.landmark, lat: end.lat, lng: end.lng }); });
    if (o.route && o.route.stops && o.route.stops.length) o.route.polyline = MDM.geo.routeThrough(o.route.stops.filter(x => x.status !== 'skipped'));
    const reason = (MDM.BOAT_CHANGE_REASONS.find(r => r.value === p.reason) || {}).label;
    // 'now on speedboat Huraa Speed 2' or 'now a ferry' when only the vessel type changed.
    const vessel = to.vesselType ? ((MDM.VESSEL_TYPES.find(v => v.value === to.vesselType) || {}).label || String(to.vesselType)).toLowerCase() : '';
    const what = [to.name ? 'now on ' + (vessel ? vessel.replace(' (dhoni)', '') + ' ' : '') + to.name : vessel ? 'now a ' + vessel : '', to.departureTime ? 'departs ' + to.departureTime : '', to.jetty ? 'from ' + ((MDM.geo.terminals().find(t => t.value === to.jetty) || {}).label || to.jetty) : '', to.island ? 'to ' + to.island : ''].filter(Boolean).join(', ');
    pushEvent(o, makeEvent('boat_updated', 'Boat details updated' + (what ? ': ' + what : '') + (reason ? ' (' + reason.toLowerCase() + ')' : ''), by, 'public'));
    if (o.driverId && by.indexOf('driver:') !== 0) notifyStaff(o, 'driver', 'Boat details changed', what || 'check the new boat details');
    if (by.indexOf('driver:') === 0 || by.indexOf('business:') === 0) notifyStaff(o, 'operations', 'Boat details changed', what + (reason ? ' (' + reason.toLowerCase() + ')' : ''));
    if (o.accountId && by.indexOf('business:') !== 0) notifyStaff(o, 'business', 'Boat details changed', what);
    return save(o);
  }

  // ---- Business cancels one order inside a bulk order (§5.5) ------------------------------------------------------------
  function businessCancel(orderId, p) {
    p = p || {};
    const o = orderOrThrow(orderId);
    if (!o.accountId) throw new StoreError('validation', 'Only business orders can be cancelled here');
    if (['delivered', 'returned', 'cancelled'].indexOf(o.status) >= 0) throw new StoreError('transition', 'This order is already ' + MDM.STATUS[o.status].label.toLowerCase());
    const acc = readCol('business_accounts').find(a => a.id === o.accountId);
    const by = p.by || ('business:' + o.accountId);
    const prev = o.status;
    const withUs = ['collected', 'out_for_delivery'].indexOf(prev) >= 0 || (prev === 'failed' && (o.route && o.route.stops || []).some(x => x.type === 'pickup' && x.status === 'done'));
    o.cancellation = { status: 'approved', reason: p.reason || '', requestedAt: now(), requestedBy: by, decidedAt: now(), decidedBy: by, remarks: 'Cancelled by the business', byBusiness: true,
      previousStatus: prev, actionRequired: withUs ? 'return_to_sender' : 'none', returnStatus: withUs ? 'pending' : null };
    o.cancelReason = p.reason || ''; o.cancelledBy = by; o.cancelledAt = now();
    if (o.cod && o.cod.status === 'pending') o.cod = Object.assign({}, o.cod, { status: 'not_collected', note: 'Order cancelled' });
    const label = 'Cancelled by ' + (acc ? acc.name : 'the business') + (p.reason ? ': ' + p.reason : '') + (withUs ? '. The package is with us and goes back to the business' : '');
    setStatus(o, 'cancelled', 'cancelled', label, by, 'public', { previousStatus: prev });
    const action = withUs ? (prev === 'out_for_delivery' ? 'out for delivery: do not deliver, bring it back' : 'already collected: return it to the business') : 'not collected yet: skip this collection';
    notifyStaff(o, 'operations', 'Order cancelled by the business', action);
    if (o.driverId) notifyStaff(o, 'driver', 'Order cancelled by the business', action);
    if (!withUs && o.driverId) releaseDriverIfIdle(o.driverId, o.id);
    return save(o);
  }
  // closeReturn: a cancelled order's package is back with the sender. Closes the return task and any return stop still open on the route.
  function closeReturn(o, by, note) {
    o.cancellation = Object.assign({}, o.cancellation, { returnStatus: 'done', returnedAt: now(), returnedBy: by, returnNote: note || '' });
    ((o.route && o.route.stops) || []).forEach(s => { if (s.type === 'return' && s.status !== 'done' && s.status !== 'skipped') { s.status = 'done'; s.at = now(); } });
    pushEvent(o, makeEvent('returned', 'Package returned to ' + (o.collection && o.collection.contactName ? o.collection.contactName : o.accountId ? 'the business' : 'the sender') + (note ? ' (' + note + ')' : ''), by, 'public'));
    notifyStaff(o, 'operations', 'Cancelled package returned', 'returned by ' + byName(by));
    if (o.driverId) releaseDriverIfIdle(o.driverId, o.id);
  }
  function markReturned(orderId, p) {
    p = p || {};
    const o = orderOrThrow(orderId);
    if (!o.cancellation || o.cancellation.returnStatus !== 'pending') throw new StoreError('validation', 'Nothing to return for this order');
    closeReturn(o, p.by || (o.driverId ? 'driver:' + o.driverId : 'admin'), p.note);
    return save(o);
  }

  // ---- Cash on delivery (§5.6): driver collects → hands to the office → office pays the business --------------------------
  function cashHandover(driverId, p) {
    p = p || {};
    const ids = p.orderIds || readCol('orders').filter(o => o.driverId === driverId && o.cod && o.cod.status === 'collected').map(o => o.id);
    let total = 0, count = 0;
    ids.forEach(id => {
      const o = orderOrThrow(id);
      if (!o.cod || o.cod.status !== 'collected') return;
      o.cod = Object.assign({}, o.cod, { status: 'with_office', handedAt: now(), handedTo: p.by || 'admin', handoverRef: p.reference || '' });
      total += o.cod.collectedAmount || 0; count++;
      pushEvent(o, makeEvent('cod_handover', 'Cash ' + fmt(o.cod.collectedAmount || 0) + ' handed to the office by ' + driverName(o.driverId), p.by, 'internal'));
      save(o);
    });
    if (count) audit('cash_handover', driverName(driverId) + ' handed over ' + fmt(total) + ' in cash for ' + count + ' order' + (count > 1 ? 's' : ''), p.by || 'admin', { driverId, total });
    return { count, total };
  }
  function remitCash(accountId, p) {
    p = p || {};
    const acc = readCol('business_accounts').find(a => a.id === accountId); if (!acc) throw new StoreError('not_found', 'Business account not found');
    const ids = p.orderIds || readCol('orders').filter(o => o.accountId === accountId && o.cod && o.cod.status === 'with_office').map(o => o.id);
    let total = 0, count = 0;
    ids.forEach(id => {
      const o = orderOrThrow(id);
      if (!o.cod || o.cod.status !== 'with_office') return;
      o.cod = Object.assign({}, o.cod, { status: 'remitted', remittedAt: now(), remittedBy: p.by || 'admin', remittanceRef: p.reference || '' });
      total += o.cod.collectedAmount || 0; count++;
      // Internal: the business name and the transfer reference are not for the receiver's tracking page. The business is still told
      // (orders with cash on delivery are business orders, so order.customer is the business).
      const ev = makeEvent('cod_remitted', 'Cash on delivery ' + fmt(o.cod.collectedAmount || 0) + ' paid to ' + acc.name + (p.reference ? ' (ref ' + p.reference + ')' : ''), p.by, 'internal');
      pushEvent(o, ev); notify(o, ev);
      save(o);
    });
    if (count) audit('cash_remitted', 'Paid ' + fmt(total) + ' cash on delivery to ' + acc.name + ' for ' + count + ' order' + (count > 1 ? 's' : '') + (p.reference ? ' (ref ' + p.reference + ')' : ''), p.by || 'admin', { accountId, total });
    return { count, total };
  }

  // ---- Accumulated off days (§7): earned by working the weekly off day, used through 'off_day' leave ---------------------------
  function offDayBalance(staffId) {
    const st = readCol('staff').find(x => x.id === staffId); if (!st) throw new StoreError('not_found', 'Employee not found');
    const hr = settings().hr || {};
    const offDay = hr.weeklyOffDay != null ? Number(hr.weeklyOffDay) : 5;
    const od = st.offDays || {};
    const earned = new Set(readCol('attendance').filter(a => a.staffId === staffId && a.date && new Date(a.date + 'T12:00:00').getDay() === offDay).map(a => a.date)).size;
    const taken = readCol('leaves').filter(l => l.staffId === staffId && l.type === 'off_day' && l.status === 'approved').reduce((n, l) => n + (Number(l.days) || 0), 0);
    const opening = Number(od.opening) || 0, adjust = Number(od.adjust) || 0;
    const net = opening + earned + adjust - taken;
    // balance never shows below 0; overdrawn is how many days were taken beyond it (approved before the balance was checked).
    return { opening, earned, adjust, taken, balance: Math.max(0, net), overdrawn: Math.max(0, -net), weeklyOffDay: offDay };
  }

  // ---- Address books: customers (§2.1) and business collection points (§5.1) -----------------------------------------------
  function saveAddress(phone, a) {
    const ph = normPhone(phone); if (!ph) throw new StoreError('validation', 'A valid phone number is required');
    if (!a || !String(a.address || '').trim()) throw new StoreError('validation', 'Enter the address');
    let c = readCol('customers').find(x => x.phone === ph);
    if (!c) c = insert('customers', { name: a.customerName || '', phone: ph, email: '', notify: 'whatsapp', addresses: [], lastOrderAt: null, orderCount: 0 });
    const list = (c.addresses || []).map(x => x.id ? x : Object.assign({ id: MDM.id('adr') }, x));
    const rec = { id: a.id || MDM.id('adr'), label: String(a.label || 'Other').trim() || 'Other', address: String(a.address).trim(), zone: a.zone || 'male', landmark: a.landmark || '', meetAt: a.meetAt || 'door', contactName: a.contactName || '', contactPhone: a.contactPhone || '', notes: a.notes || '' };
    const i = list.findIndex(x => x.id === rec.id);
    if (i >= 0) list[i] = Object.assign({}, list[i], rec); else list.push(rec);
    return update('customers', c.id, { addresses: list });
  }
  function removeAddress(phone, id) {
    const c = readCol('customers').find(x => x.phone === normPhone(phone)); if (!c) throw new StoreError('not_found', 'Customer not found');
    return update('customers', c.id, { addresses: (c.addresses || []).filter(x => x.id !== id) });
  }
  function saveCollectionPoint(accountId, pt) {
    const acc = readCol('business_accounts').find(a => a.id === accountId); if (!acc) throw new StoreError('not_found', 'Business account not found');
    if (!pt || !String(pt.address || '').trim()) throw new StoreError('validation', 'Enter the collection address');
    const list = (acc.collectionPoints || []).slice();
    const rec = { id: pt.id || MDM.id('cpt'), label: String(pt.label || 'Collection point').trim(), address: String(pt.address).trim(), zone: pt.zone || acc.zone || 'male', landmark: pt.landmark || '', contactName: pt.contactName || acc.contactName || '', contactPhone: pt.contactPhone || acc.phone || '', preferredTime: pt.preferredTime || '', isDefault: !!pt.isDefault };
    if (rec.isDefault) list.forEach(x => { x.isDefault = false; });
    const i = list.findIndex(x => x.id === rec.id);
    if (i >= 0) list[i] = Object.assign({}, list[i], rec); else list.push(rec);
    if (!list.some(x => x.isDefault) && list.length) list[0].isDefault = true;
    return update('business_accounts', accountId, { collectionPoints: list });
  }
  function removeCollectionPoint(accountId, id) {
    const acc = readCol('business_accounts').find(a => a.id === accountId); if (!acc) throw new StoreError('not_found', 'Business account not found');
    const list = (acc.collectionPoints || []).filter(x => x.id !== id);
    if (list.length && !list.some(x => x.isDefault)) list[0].isDefault = true;
    return update('business_accounts', accountId, { collectionPoints: list });
  }
  // §1.3: the office looks at the typical package photo, picks the size categories and agrees a fixed rate for each.
  function approveBusinessRequest(requestId, p) {
    p = p || {};
    const req = readCol('business_requests').find(r => r.id === requestId); if (!req) throw new StoreError('not_found', 'Request not found');
    const rates = {}; Object.keys(p.rates || {}).forEach(k => { const v = Math.round(Number(p.rates[k])); if (v > 0) rates[k] = v; });
    if (!Object.keys(rates).length) throw new StoreError('validation', 'Agree a rate for at least one package size');
    const tiers = MDM.pricing.businessTiers(settings()).map(t => t.value).filter(k => rates[k] != null);
    const acc = insert('business_accounts', { name: req.name, contactName: req.contactName, phone: req.phone, landline: req.landline || '', email: req.email || '', tin: req.tin || '', zone: req.zone, pickupAddress: req.pickupAddress, pickupWindow: req.pickupWindow || '',
      rates, tiers, ratePerPackage: rates[tiers[0]], packagePhotoId: req.packagePhotoId || null, assessment: p.notes || '', priorityAllowed: true, status: 'approved', approvedAt: now(), approvedBy: p.by || 'admin',
      collectionPoints: [{ id: MDM.id('cpt'), label: 'Main', address: req.pickupAddress, zone: req.zone, landmark: '', contactName: req.contactName, contactPhone: req.phone, preferredTime: '', isDefault: true }] });
    update('business_requests', requestId, { status: 'approved', accountId: acc.id, decidedAt: now(), decidedBy: p.by || 'admin', rates });
    audit('business_approved', 'Business account approved: ' + req.name + ' (' + tiers.map(k => k + ' ' + fmt(rates[k])).join(', ') + ')', p.by || 'admin', { accountId: acc.id });
    return acc;
  }
  function setBusinessRates(accountId, rates, by) {
    const acc = readCol('business_accounts').find(a => a.id === accountId); if (!acc) throw new StoreError('not_found', 'Business account not found');
    const clean = {}; Object.keys(rates || {}).forEach(k => { const v = Math.round(Number(rates[k])); if (v > 0) clean[k] = v; });
    if (!Object.keys(clean).length) throw new StoreError('validation', 'Keep at least one package size with a rate');
    const tiers = MDM.pricing.businessTiers(settings()).map(t => t.value).filter(k => clean[k] != null);
    const saved = update('business_accounts', accountId, { rates: clean, tiers, ratePerPackage: clean[tiers[0]] });
    audit('business_rates', 'Rates for ' + acc.name + ': ' + tiers.map(k => k + ' ' + fmt(clean[k])).join(', '), by || 'admin', { accountId });
    return saved;
  }

  // ---- Public surface: every method returns a Promise -----------------------------------------------------------------
  const P = fn => function () { const args = arguments; return new Promise((resolve, reject) => { try { resolve(fn.apply(null, args)); } catch (e) { reject(e); } }); };
  MDM.store = {
    ready, get readyState() { return readyState; }, COLLECTIONS,
    get: P(get), list: P(list), insert: P(insert), update: P(update), remove: P(remove),
    settings: P(settings), saveSettings: P(saveSettings), subscribe,
    reset: P(reset), exportJSON: P(exportJSON), importJSON: P(importJSON),
    _boot: boot, get _tabId() { return getTabId(); },
    audit: P(audit), transition: P(transition), addEvent: P(addEvent), addNote: P(addNote),
    createOrder: P(createOrder), modifyOrder: P(modifyOrder), addAdjustment: P(addAdjustment), confirmPrice: P(confirmPrice), updatePackages: P(updatePackages),
    requestPayment: P(requestPayment), submitPayment: P(submitPayment), verifyPayment: P(verifyPayment), markPaid: P(markPaid), rejectPayment: P(rejectPayment), recordRefund: P(recordRefund), markSettled: P(markSettled),
    cancel: P(cancel), requestCancel: P(requestCancel), decideCancel: P(decideCancel), requestPriority: P(requestPriority), decidePriority: P(decidePriority),
    assignDriver: P(assignDriver), dispatch: P(dispatch), startRoute: P(startRoute), outForDelivery: P(outForDelivery), setStop: P(setStop), resolveFailure: P(resolveFailure),
    driverRoute: P(driverRoute), createBatch: P(createBatch), batchCollected: P(batchCollected), assignByZone: P(assignByZone), batchStatus: P(b => batchStatus(b)),
    createStoreOrder: P(createStoreOrder), punchIn: P(punchIn), punchOut: P(punchOut), openShift: P(openShift), requestLeave: P(requestLeave), decideLeave: P(decideLeave),
    upsertCustomer: P(upsertCustomer), createInvoice: P(createInvoice), orderByCode: P(orderByCode),
    addCharge: P(addCharge), setChargeBillable: P(setChargeBillable), voidCharge: P(voidCharge), reimburseCharges: P(reimburseCharges), addVehicleCharge: P(addVehicleCharge),
    updateBoat: P(updateBoat), businessCancel: P(businessCancel), markReturned: P(markReturned), cashHandover: P(cashHandover), remitCash: P(remitCash),
    offDayBalance: P(offDayBalance), saveAddress: P(saveAddress), removeAddress: P(removeAddress), saveCollectionPoint: P(saveCollectionPoint), removeCollectionPoint: P(removeCollectionPoint),
    approveBusinessRequest: P(approveBusinessRequest), setBusinessRates: P(setBusinessRates), deliveryEndpoint: P(d => deliveryEndpoint(d)),
    buildStops: P(o => buildStops(clone(o))),
    _buildStops: buildStops, _batchStatus: batchStatus, _list: list, _settings: settings, _offDayBalance: offDayBalance,   // synchronous, for seed.js, geo zones and reports
  };
})(window.MDM);

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
    requested: ['confirmed', 'cancelled'],
    confirmed: ['assigned', 'collected', 'cancelled'],
    assigned: ['dispatched', 'confirmed', 'cancelled'],
    dispatched: ['on_the_way', 'assigned', 'failed', 'cancelled'],
    on_the_way: ['arrived', 'collected', 'failed', 'cancelled'],
    arrived: ['collected', 'failed', 'cancelled'],
    collected: ['out_for_delivery', 'failed', 'cancelled'],
    out_for_delivery: ['delivered', 'failed', 'returned'],
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
  MDM.REQUEST_TYPES = [
    { value: 'home',         label: 'Home delivery',     hint: 'Collect from one address and deliver to another' },
    { value: 'shop_buy',     label: 'Shop & deliver',    hint: 'Send a list and a budget, we buy it and bring it' },
    { value: 'shop_collect', label: 'Shop collection',   hint: 'Collect something you have already bought' },
    { value: 'postal',       label: 'Postal & courier',  hint: 'Redbox, Pikpost, Post Office, FedEx, DHL and others' },
    { value: 'airport',      label: 'Airport & baggage', hint: 'Airport collections, airport drop-offs and luggage' },
    { value: 'office',       label: 'Office assistance', hint: 'Document runs, submissions and applications' },
  ];
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
    { value: 'discount', label: 'Discount' }, { value: 'quote', label: 'Price confirmation' }, { value: 'other', label: 'Other' },
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
  MDM.LEAVE_TYPES = [{ value: 'annual', label: 'Annual leave' }, { value: 'sick', label: 'Sick leave' }, { value: 'emergency', label: 'Emergency leave' }, { value: 'unpaid', label: 'Unpaid leave' }];
  MDM.ROLES = [{ value: 'admin', label: 'Admin' }, { value: 'operator', label: 'Operator' }, { value: 'office', label: 'Office staff' }, { value: 'driver', label: 'Driver' }];
  // Events that reach the customer as a notification (client requirements §17).
  const NOTIFY = {
    created: 'Order submitted', confirmed: 'Order confirmed', price_confirmed: 'Price confirmed', assigned: 'Driver assigned',
    collected: 'Package collected', out_for_delivery: 'Out for delivery', delivered: 'Delivered', failed: 'Delivery problem',
    payment_requested: 'Payment requested', payment_submitted: 'Payment submitted', payment_verified: 'Payment verified',
    priority_approved: 'Priority request approved', priority_rejected: 'Priority request rejected', cancelled: 'Order cancelled',
    cancel_rejected: 'Cancellation request declined',
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
    const keep = ['mdm:session', 'mdm:timeScale', 'mdm:theme'];
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
    return /^[379]\d{6}$/.test(s) ? s : (d.length >= 8 && d.length <= 15 ? '+' + d : null);
  }
  const fmt = n => (MDM.pricing ? MDM.pricing.format(n) : 'MVR ' + n);
  function byName(by) {
    if (!by) return 'System';
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
    priceHistory(o, before, o.totals.total, 'Final price confirmed' + (q.remarks ? ': ' + q.remarks : ''), q.by);
    o.pricing = Object.assign({}, o.pricing, { status: 'confirmed', confirmedAt: now(), confirmedBy: q.by || 'admin', remarks: q.remarks || '' });
    o.totals.quoteRequired = false;
    pushEvent(o, makeEvent('price_confirmed', 'Price confirmed: ' + fmt(o.totals.total) + (q.remarks ? ' (' + q.remarks + ')' : ''), q.by, 'public'));
    if (o.status === 'requested') setStatus(o, 'confirmed', 'confirmed', 'Order confirmed', q.by);
    if (q.requestPayment || o.payment.upfrontRequired) requestPaymentOn(o, q.by, true);
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
  function cancelOn(o, reason, by) {
    if ((MDM.ALLOWED[o.status] || []).indexOf('cancelled') < 0) throw new StoreError('transition', 'This order can no longer be cancelled');
    o.cancelReason = reason || ''; o.cancelledBy = by || 'admin'; o.cancelledAt = now();
    setStatus(o, 'cancelled', 'cancelled', (by === 'customer' ? 'Cancelled at your request' : 'Order cancelled') + (reason ? ': ' + reason : ''), by);
    if (o.driverId) releaseDriverIfIdle(o.driverId, o.id);
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
  // modifyOrder: operator edits with a field-by-field change history.
  function modifyOrder(orderId, patch, by) {
    const o = orderOrThrow(orderId);
    const changes = [];
    const walk = (target, src, path) => Object.keys(src).forEach(k => {
      const v = src[k], p = path ? path + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') walk(target[k], v, p);
      else if (JSON.stringify(target[k]) !== JSON.stringify(v)) { changes.push({ at: now(), by: by || 'admin', field: p, from: target[k] == null ? '' : target[k], to: v }); target[k] = v; }
    });
    walk(o, patch, '');
    if (!changes.length) return clone(o);
    // Keep each package's pickup/drop-off in step with the order-level addresses, which pricing and routing read.
    (o.packages || []).forEach(pkg => {
      if (pkg.pickup && o.collection) Object.assign(pkg.pickup, { address: o.collection.address, zone: o.collection.zone, landmark: o.collection.landmark });
      if (pkg.dropoff && o.delivery && !o.batchId) Object.assign(pkg.dropoff, { address: o.delivery.address, zone: o.delivery.zone, landmark: o.delivery.landmark });
    });
    o.changes = (o.changes || []).concat(changes);
    if (o.route && o.route.stops && o.route.stops.length && ['delivered', 'cancelled', 'returned'].indexOf(o.status) < 0) {
      const done = o.route.stops.filter(s => s.status === 'done');
      if (!done.length) { o.route = { stops: buildStops(o), polyline: [] }; o.route.polyline = MDM.geo.routeThrough(o.route.stops); }
    }
    pushEvent(o, makeEvent('modified', 'Order details updated: ' + changes.map(c => c.field.replace(/\./g, ' ')).join(', '), by, 'internal'));
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
    (o.packages || []).forEach(pkg => { const d = pkg.dropoff || {}; add('dropoff', 'Delivery', d, d.zone || 'male', d.recipient, pkg); });
    const nP = stops.filter(s => s.type === 'pickup').length, nD = stops.filter(s => s.type === 'dropoff').length;
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
    if (o.status === 'requested') throw new StoreError('transition', 'Confirm the price before assigning a driver');
    const label = (reassign ? 'Driver changed to ' : 'Driver assigned: ') + d.name;
    if (o.status === 'confirmed' && !o.batchId) setStatus(o, 'assigned', 'assigned', label, opts.by);
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
    if (o.service !== 'shop') return;
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
          const pkg = o.packages.find(k => k.id === s.packageId);
          if (pkg && pkg.shop) { pkg.shop.receiptTotal = Math.round(Number(p.receiptTotal) || 0); pkg.shop.receiptPhotoId = p.receiptPhotoId || null; recalc(o); }
          s.receiptTotal = p.receiptTotal; s.receiptPhotoId = p.receiptPhotoId || null;
        }
        const pickups = o.route.stops.filter(x => x.type === 'pickup');
        const label = s.shop ? 'Shopping done, receipt ' + fmt(s.receiptTotal || 0) : 'Collected from ' + (s.address || 'the collection point');
        if (pickups.every(x => x.status === 'done')) {
          if (o.status === 'dispatched') setStatus(o, 'on_the_way', 'route_started', who + ' is on the way to collect', by);
          if (o.status === 'on_the_way' || o.status === 'arrived') setStatus(o, 'collected', 'collected', label + (p.photoId ? ', proof photo added' : ''), by, 'public', { stopId });
          else pushEvent(o, makeEvent('collected', label, by, 'public', { stopId }));
        } else pushEvent(o, makeEvent('collected_partial', label, by, 'public', { stopId }));
        if (p.remarks) pushEvent(o, makeEvent('note', 'Driver remark: ' + p.remarks, by, 'internal', { stopId }));
      } else {
        s.handedTo = p.handedTo || 'recipient'; s.recipientName = p.recipientName || ''; s.photoId = p.photoId || null; s.confirmed = !!p.confirmed;
        const handed = { recipient: '', family: ' (family or colleague)', security: ' (security or reception)', left: ' (left as instructed)' }[s.handedTo] || '';
        const label = s.type === 'return' ? 'Returned to sender' : 'Delivered' + (s.recipientName ? ' to ' + s.recipientName : '') + handed;
        if (o.status === 'collected') setStatus(o, 'out_for_delivery', 'out_for_delivery', 'Out for delivery with ' + who, by);
        const drops = o.route.stops.filter(x => x.type === 'dropoff'), returns = o.route.stops.filter(x => x.type === 'return');
        if (returns.length && returns.every(x => x.status === 'done')) setStatus(o, 'returned', 'returned', 'Returned to sender', by, 'public', { stopId });
        else if (drops.every(x => x.status === 'done')) {
          setStatus(o, 'delivered', 'delivered', label, by, 'public', { stopId });
          settleShop(o);
          if (o.payment && o.payment.status === 'pending') requestPaymentOn(o, 'system', false);
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
    o.packages.forEach(pkg => {
      const u = sizes[pkg.id]; if (!u) return;
      if (u.size && u.size !== pkg.size) o.changes = (o.changes || []).concat([{ at: now(), by, field: 'package ' + pkg.id + ' size', from: pkg.size, to: u.size }]);
      if (u.size) pkg.size = u.size;
      if (u.dims) pkg.dims = u.dims;
      pkg.sizeSource = by && by.indexOf('driver') === 0 ? 'driver' : 'operator';
    });
    const q = MDM.pricing.quote({ service: o.service, packages: o.packages }, s);
    o.packages = q.packages.map((p, i) => Object.assign({}, o.packages[i], { price: p.price }));
    recalc(o);
    if (o.totals.total !== before) { priceHistory(o, before, o.totals.total, 'Package size updated', by); pushEvent(o, makeEvent('size_updated', 'Package size updated, price ' + fmt(before) + ' to ' + fmt(o.totals.total), by, 'internal')); }
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
    return clone({ orders, stops, polyline });
  }

  // ---- Bulk business orders (requirements §10) --------------------------------------------------------------------------
  // A batch is one collection from the business and one child order per package, so every package stays trackable on its own.
  function createBatch(b) {
    const acc = readCol('business_accounts').find(a => a.id === b.accountId); if (!acc) throw new StoreError('not_found', 'Business account not found');
    const s = settings();
    const batch = insert('batches', { accountId: acc.id, name: acc.name, serviceLevel: b.serviceLevel || 'normal', collection: b.collection, notes: b.notes || '', status: 'confirmed', orderIds: [], by: b.by || ('business:' + acc.id) });
    const ids = [];
    (b.rows || []).forEach((r, i) => {
      const pkg = { id: MDM.id('pkg'), size: r.size || 'bag', description: r.description || '', underOneFt: r.size !== 'xl', fragile: !!r.fragile, needsVehicle: false,
        pickup: { address: b.collection.address, zone: b.collection.zone, landmark: b.collection.landmark || '', contact: { name: b.collection.contactName, phone: b.collection.contactPhone } },
        dropoff: { address: r.address, zone: r.zone, landmark: r.landmark || '', recipient: { name: r.name, phone: r.phone }, instructions: r.instructions || '' } };
      const q = MDM.pricing.quote({ service: 'business', packages: [pkg] }, s);
      const order = insert('orders', {
        source: b.source || 'business', requestType: 'bulk', service: 'business', serviceLevel: b.serviceLevel || 'normal', accountId: acc.id, batchId: batch.id, batchIndex: i + 1,
        customerId: null, customer: { name: acc.name, phone: acc.phone, email: acc.email || '', notify: 'whatsapp' },
        collection: Object.assign({}, b.collection), delivery: { address: r.address, zone: r.zone, landmark: r.landmark || '', recipientName: r.name, recipientPhone: r.phone, instructions: r.instructions || '' },
        details: { reference: r.reference || '' }, documents: [], packages: q.packages, fees: q.fees, totals: q.totals,
        estimate: { min: q.totals.total, max: q.totals.total }, pricing: { status: 'confirmed', confirmedAt: now(), confirmedBy: 'system', remarks: 'Business rate', history: [] },
        schedule: { type: 'asap' }, payment: { method: 'invoice', status: 'invoiced' },
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
  function batchStatus(batch) {
    const kids = readCol('orders').filter(o => o.batchId === batch.id);
    const by = st => kids.filter(o => o.status === st).length;
    const n = kids.length;
    let status = 'confirmed';
    if (n && kids.every(o => ['delivered', 'cancelled', 'returned'].indexOf(o.status) >= 0)) status = 'delivered';
    else if (kids.some(o => o.status === 'out_for_delivery' || o.status === 'delivered')) status = 'out_for_delivery';
    else if (kids.some(o => o.status === 'collected')) status = 'collected';
    const paid = kids.length && kids.every(o => o.payment && o.payment.status === 'paid');
    return { status: paid && status === 'delivered' ? 'paid' : status, total: n, delivered: by('delivered'), out: by('out_for_delivery'), collected: by('collected'), failed: by('failed'), cancelled: by('cancelled'), amount: kids.reduce((t, o) => t + (o.totals ? o.totals.total : 0), 0) };
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
    const rec = insert('leaves', { staffId: l.staffId, type: l.type || 'annual', from: l.from, to: l.to, days, reason: l.reason || '', status: 'pending', decidedBy: null, decidedAt: null, remarks: '' });
    audit('leave_requested', st.name + ' requested ' + days + ' day' + (days > 1 ? 's' : '') + ' of leave', 'staff:' + l.staffId, { leaveId: rec.id });
    return rec;
  }
  function decideLeave(leaveId, p) {
    const lv = readCol('leaves').find(x => x.id === leaveId); if (!lv) throw new StoreError('not_found', 'Leave request not found');
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
      if (c.address && !(existing.addresses || []).some(a => a.address === c.address.address)) patch.addresses = (existing.addresses || []).concat([c.address]);
      return update('customers', existing.id, patch);
    }
    return insert('customers', { name: c.name || '', phone, email: c.email || '', notify: c.notify || 'whatsapp', addresses: c.address ? [c.address] : [], lastOrderAt: c.touch === false ? null : t, orderCount: c.touch === false ? 0 : 1 });
  }
  // createOrder: the one place customer and admin requests become orders (keeps the shape identical everywhere).
  function createOrder(d) {
    const s = settings();
    const q = MDM.pricing.quote({ service: d.service || 'pick', packages: d.packages }, s);
    const est = MDM.pricing.estimateRange(d.packages, s, d.service || 'pick');
    const level = d.serviceLevel || 'normal';
    const needsReview = q.totals.quoteRequired || (d.packages || []).some(p => p.photoId) || level === 'express' || d.requestType === 'office';
    const order = insert('orders', {
      source: d.source || 'web', requestType: d.requestType || 'home', service: d.service || 'pick', serviceLevel: level, accountId: d.accountId || null,
      customerId: d.customerId || null, customer: d.customer, collection: d.collection, delivery: d.delivery, details: d.details || {}, documents: d.documents || [],
      packages: q.packages, fees: q.fees, totals: q.totals, estimate: est, pricing: { status: 'estimated', history: [], needsReview },
      schedule: d.schedule || { type: 'asap' }, payment: d.payment || { method: 'transfer', status: 'pending', upfrontRequired: d.service === 'shop' },
      priority: { level: level === 'express' ? 'express' : 'normal', status: 'none', requests: [] }, cancellation: { status: 'none' }, changes: [],
      statusHistory: [{ at: now(), from: null, to: d.status || 'requested', by: d.by || 'customer' }],
      status: d.status || 'requested', driverId: null, route: { stops: [], polyline: [] }, events: [], notes: d.notes || [] });
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
        lines.push({ date: at, orderCode: o.code, recipient: pkg.dropoff && pkg.dropoff.recipient ? pkg.dropoff.recipient.name : '', description: pkg.description || '', packages: 1, rate, amount: rate });
      });
      (o.fees && o.fees.adjustments || []).forEach(a => lines.push({ date: at, orderCode: o.code, recipient: '', description: a.label, packages: 0, rate: a.amount, amount: a.amount }));
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
    buildStops: P(o => buildStops(clone(o))),
    _buildStops: buildStops, _batchStatus: batchStatus, _list: list, _settings: settings,   // synchronous, for seed.js, geo zones and reports
  };
})(window.MDM);

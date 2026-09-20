// Data layer. Everything the pages read or write goes through MDM.store; nothing else touches localStorage.
//
// Swapping this for a real backend (Supabase) later:
//   collection            → Postgres table of the same name (orders, customers, drivers, business_requests, business_accounts,
//                           invoices, positions, events, files); `files.dataUrl` → a Storage bucket object, keep the metadata row
//   get / list({where})   → .select().eq()/.in() ; order → .order(); limit → .limit()
//   insert / update       → .insert() / .update().eq('id', id)   (update is a shallow merge at the top level, same as here)
//   subscribe(col, cb)    → supabase.channel('mdm:' + col).on('postgres_changes', …) ; positions → one row per driver, upserted at 1 Hz
//   transition/setStop/…  → keep as server-side functions (RPC) so the status machine has one implementation
//   settings              → a single-row table; codes (MDM-1042, INV-2026-09-001) → sequences
// Every method already returns a Promise, so pages will not change.
(function (MDM) { 'use strict';

  const PREFIX = 'mdm:v' + MDM.SCHEMA + ':';
  const COLLECTIONS = ['orders', 'customers', 'drivers', 'business_requests', 'business_accounts', 'invoices', 'positions', 'events', 'files'];
  const EVENT_CAP = 1000;
  const RESEED_AFTER_MS = 12 * 60 * 60 * 1000;

  class StoreError extends Error { constructor(code, message) { super(message || code); this.code = code; this.name = 'StoreError'; } }
  MDM.StoreError = StoreError;

  // ---- Status machine -------------------------------------------------------------------------------------------------
  MDM.STATUS = {
    draft:            { label: 'Draft',            customer: 'Draft',                          kind: 'neutral' },
    quote_pending:    { label: 'Quote pending',    customer: 'Confirming your price',          kind: 'warn' },
    awaiting_payment: { label: 'Awaiting payment', customer: 'Awaiting your transfer',         kind: 'warn' },
    payment_review:   { label: 'Payment review',   customer: 'Checking your payment',          kind: 'warn' },
    confirmed:        { label: 'Confirmed',        customer: 'Confirmed, assigning a rider',   kind: 'info' },
    assigned:         { label: 'Assigned',         customer: 'Rider assigned',                 kind: 'info' },
    picked_up:        { label: 'Picked up',        customer: 'Picked up',                      kind: 'info' },
    in_transit:       { label: 'In transit',       customer: 'On the way',                     kind: 'info' },
    on_hold:          { label: 'On hold',          customer: "We couldn't complete a stop",    kind: 'warn' },
    delivered:        { label: 'Delivered',        customer: 'Delivered',                      kind: 'ok' },
    returned:         { label: 'Returned',         customer: 'Returned to sender',             kind: 'neutral' },
    cancelled:        { label: 'Cancelled',        customer: 'Cancelled',                      kind: 'danger' },
  };
  MDM.ALLOWED = {
    draft: ['awaiting_payment', 'quote_pending', 'cancelled'],
    quote_pending: ['awaiting_payment', 'cancelled'],
    awaiting_payment: ['payment_review', 'confirmed', 'cancelled'],
    payment_review: ['confirmed', 'awaiting_payment', 'cancelled'],
    confirmed: ['assigned', 'cancelled'],
    assigned: ['in_transit', 'picked_up', 'cancelled'],
    picked_up: ['in_transit', 'on_hold', 'delivered', 'cancelled'],
    in_transit: ['picked_up', 'delivered', 'on_hold', 'cancelled'],
    on_hold: ['in_transit', 'picked_up', 'returned', 'cancelled'],
    delivered: [], returned: [], cancelled: [],
  };
  MDM.ACTIVE_STATUSES = ['assigned', 'picked_up', 'in_transit', 'on_hold'];
  MDM.EVENT_TYPES = ['created', 'quote_sent', 'payment_submitted', 'payment_verified', 'payment_rejected', 'payment_marked', 'confirmed', 'assigned', 'reassigned', 'route_started', 'arrived', 'picked_up', 'delivered', 'stop_failed', 'stop_retried', 'return_added', 'on_hold', 'returned', 'cancelled', 'refund', 'adjustment', 'quote_adjustment', 'settled', 'note', 'update_sent'];
  MDM.ADJUSTMENT_PRESETS = [
    { value: 'vehicle', label: 'Extra vehicle charge' }, { value: 'waiting', label: 'Waiting time' }, { value: 'freight', label: 'Boat freight advanced' },
    { value: 'redelivery', label: 'Re-delivery' }, { value: 'discount', label: 'Discount' }, { value: 'quote', label: 'Quote adjustment' }, { value: 'other', label: 'Other' },
  ];
  MDM.FAIL_REASONS = [
    { value: 'no_answer', label: 'No answer' }, { value: 'wrong_address', label: 'Wrong address' }, { value: 'closed', label: 'Closed' },
    { value: 'refused', label: 'Refused' }, { value: 'not_ready', label: 'Not ready' }, { value: 'boat_not_arrived', label: 'Boat not arrived' },
  ];
  MDM.HANDED_TO = [
    { value: 'recipient', label: 'Recipient' }, { value: 'family', label: 'Family or colleague' }, { value: 'security', label: 'Security or reception' }, { value: 'left', label: 'Left as instructed' },
  ];
  MDM.badgeFor = function (status, opts) {
    const s = MDM.STATUS[status] || { label: status, customer: status, kind: 'neutral' };
    const label = opts && opts.customer ? s.customer : s.label;
    return '<span class="badge badge--' + s.kind + '" data-status="' + esc(status) + '">' + esc(label) + '</span>';
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---- Low-level storage ----------------------------------------------------------------------------------------------
  const clone = typeof structuredClone === 'function' ? (v => structuredClone(v)) : (v => JSON.parse(JSON.stringify(v)));
  const cache = {};                     // collection → array (parsed) | undefined when invalidated
  let settingsCache = null, metaCache = null;
  const tabId = MDM.id('tab');
  let readyResolve; const ready = new Promise(r => { readyResolve = r; });
  let readyState = 'booting';
  let seedBuilder = null;

  function readRaw(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
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
  function meta() { if (!metaCache) metaCache = readRaw(PREFIX + 'meta', { seededAt: 0, dirty: false, orderSeq: 1000, invoiceSeq: 1 }); return metaCache; }
  function writeMeta(m) { metaCache = m; writeRaw(PREFIX + 'meta', m); }
  function now() { return new Date().toISOString(); }

  // ---- Cross-tab propagation: exactly one transport ---------------------------------------------------------------------
  const subs = { '*': new Set() }; COLLECTIONS.forEach(c => { subs[c] = new Set(); }); subs.settings = new Set();
  const pending = new Map();   // collection → { ids:Set, ops:Set, origin }
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
  function broadcast(msg) {
    if (channel) { try { channel.postMessage(Object.assign({ v: 1, tabId }, msg)); } catch (e) { /* channel closed */ } }
  }
  function onRemote(msg) {
    if (!msg || msg.tabId === tabId) return;
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
  // A tab that wakes up re-reads everything (this replaces page-level polling).
  function wake() { if (readyState !== 'ready') return; invalidateAll(); schedule('*', null, 'refresh', 'remote'); COLLECTIONS.forEach(c => schedule(c, null, 'refresh', 'remote')); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  window.addEventListener('focus', wake);

  function notifyLocal(collection, id, op) { schedule(collection, id, op, 'local'); broadcast({ collection, id, op }); }

  // ---- Generic API -----------------------------------------------------------------------------------------------------
  function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
  function matches(doc, where) {
    if (!where) return true;
    return Object.keys(where).every(k => {
      const want = where[k], have = getPath(doc, k);
      return Array.isArray(want) ? want.indexOf(have) >= 0 : have === want;
    });
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
    if (!d.id) d.id = MDM.id({ orders: 'ord', customers: 'cus', drivers: 'drv', business_requests: 'breq', business_accounts: 'bacc', invoices: 'inv', positions: 'pos', events: 'evt', files: 'file' }[col] || 'doc');
    if (!d.createdAt) d.createdAt = t;
    d.updatedAt = t;
    if (col === 'orders' && !d.code) { const m = meta(); d.code = 'MDM-' + m.orderSeq; m.orderSeq += 1; writeMeta(m); }
    if (col === 'events') { arr.push(d); while (arr.length > EVENT_CAP) arr.shift(); }
    else { const i = arr.findIndex(x => x.id === d.id); if (i >= 0) arr[i] = d; else arr.push(d); }
    writeCol(col, arr); notifyLocal(col, d.id, 'insert');
    return clone(d);
  }
  function update(col, id, patchOrFn) {
    cache[col] = undefined;                                   // read-modify-write against storage, not the memory cache
    const arr = readCol(col).slice();
    const i = arr.findIndex(x => x.id === id);
    if (i < 0) throw new StoreError('not_found', col + ' ' + id + ' not found');
    const current = arr[i];
    const patch = typeof patchOrFn === 'function' ? patchOrFn(clone(current)) : patchOrFn;
    const next = Object.assign({}, current, clone(patch || {}), { id: current.id, createdAt: current.createdAt, updatedAt: now() });
    arr[i] = next; writeCol(col, arr); notifyLocal(col, id, 'update');
    return clone(next);
  }
  function remove(col, id) {
    const arr = readCol(col).filter(x => x.id !== id);
    writeCol(col, arr); notifyLocal(col, id, 'remove');
  }
  const SETTINGS_KEYS = ['rates', 'rules', 'sizeGuide', 'ops', 'banks', 'contact', 'terms', 'notice', 'invoiceDueDays', 'gstPercent', 'demo'];
  function settings() { if (!settingsCache) settingsCache = readRaw(PREFIX + 'settings', {}); return clone(settingsCache); }
  function deepMerge(a, b) {
    if (Array.isArray(b) || b === null || typeof b !== 'object') return clone(b);
    const out = Object.assign({}, a || {});
    Object.keys(b).forEach(k => { out[k] = (a && typeof a[k] === 'object' && !Array.isArray(a[k]) && b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k], b[k]) : clone(b[k]); });
    return out;
  }
  function saveSettings(patch) {
    const cur = settings(); const next = Object.assign({}, cur);
    Object.keys(patch || {}).forEach(k => { if (SETTINGS_KEYS.indexOf(k) >= 0) next[k] = deepMerge(cur[k], patch[k]); });
    writeRaw(PREFIX + 'settings', next); settingsCache = next;
    schedule('settings', null, 'update', 'local'); broadcast({ collection: 'settings', op: 'update' });
    return clone(next);
  }
  function subscribe(col, cb) {
    const set = subs[col]; if (!set) throw new StoreError('validation', 'Unknown collection: ' + col);
    set.add(cb); return () => set.delete(cb);
  }

  // ---- Seed / boot / reset / export ------------------------------------------------------------------------------------
  function writeSeed(seed) {
    const t = now();
    COLLECTIONS.forEach(c => { cache[c] = seed[c] || []; writeRaw(PREFIX + c, cache[c]); });
    settingsCache = seed.settings || {}; writeRaw(PREFIX + 'settings', settingsCache);
    const codes = (seed.orders || []).map(o => Number(String(o.code || '').replace(/\D/g, ''))).filter(n => n > 0);
    const invs = (seed.invoices || []).length;
    writeMeta({ seededAt: Date.now(), dirty: false, orderSeq: (codes.length ? Math.max.apply(null, codes) : 1000) + 1, invoiceSeq: invs + 1, seededISO: t });
    writeRaw('mdm:schema', MDM.SCHEMA);
  }
  function clearAll() {
    const keys = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf('mdm:') === 0 && k !== 'mdm:session' && k !== 'mdm:timeScale') keys.push(k); }
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

  // ---- Domain helpers (the only writers of status, events, stops, adjustments, notes, quote, settlement) -------------
  function normPhone(raw) {
    if (MDM.ui && MDM.ui.phone) return MDM.ui.phone.normalize(raw);
    const d = String(raw || '').replace(/\D/g, ''); const s = d.length > 7 && d.indexOf('960') === 0 ? d.slice(3) : d;
    return /^[379]\d{6}$/.test(s) ? s : (d.length >= 8 && d.length <= 15 ? '+' + d : null);
  }
  function orderOrThrow(id) { const o = readCol('orders').find(x => x.id === id); if (!o) throw new StoreError('not_found', 'Order not found'); return clone(o); }
  function makeEvent(type, label, by, visibility, meta_) { return { id: MDM.id('evt'), at: now(), type, label, by: by || 'system', visibility: visibility || 'internal', meta: meta_ || null }; }
  function pushEvent(order, ev) { order.events = (order.events || []).concat([ev]); insert('events', { id: ev.id, orderId: order.id, code: order.code, at: ev.at, type: ev.type, label: ev.label, by: ev.by, visibility: ev.visibility }); }
  function save(order) { return update('orders', order.id, order); }

  function addEvent(orderId, ev) {
    const o = orderOrThrow(orderId);
    pushEvent(o, makeEvent(ev.type, ev.label, ev.by, ev.visibility, ev.meta));
    return save(o);
  }
  function transition(orderId, next, opts) {
    opts = opts || {};
    const o = orderOrThrow(orderId);
    if (!MDM.STATUS[next]) throw new StoreError('validation', 'Unknown status ' + next);
    if ((MDM.ALLOWED[o.status] || []).indexOf(next) < 0) throw new StoreError('transition', 'Cannot go from ' + o.status + ' to ' + next);
    o.status = next;
    const defaults = { awaiting_payment: ['payment_submitted', 'Awaiting transfer'], payment_review: ['payment_submitted', 'Payment slip submitted'], confirmed: ['confirmed', 'Payment verified, order confirmed'], assigned: ['assigned', 'Rider assigned'], in_transit: ['route_started', 'Rider on the way'], picked_up: ['picked_up', 'Package picked up'], delivered: ['delivered', 'Delivered'], cancelled: ['cancelled', 'Order cancelled'], on_hold: ['on_hold', 'Stop could not be completed'], returned: ['returned', 'Returned to sender'], quote_pending: ['created', 'Quote requested'] };
    const d = defaults[next] || [next, next];
    pushEvent(o, makeEvent(d[0], opts.label || d[1], opts.by, opts.visibility || 'public', opts.meta));
    return save(o);
  }
  function addNote(orderId, n) {
    const o = orderOrThrow(orderId);
    o.notes = (o.notes || []).concat([{ id: MDM.id('note'), at: now(), text: n.text, by: n.by || 'admin' }]);
    pushEvent(o, makeEvent('note', 'Note added', n.by, 'internal'));
    return save(o);
  }
  function recalc(o) { const s = settings(); return MDM.pricing && MDM.pricing.recalc ? MDM.pricing.recalc(o, s) : o; }
  function addAdjustment(orderId, a) {
    const o = orderOrThrow(orderId);
    const preset = MDM.ADJUSTMENT_PRESETS.find(p => p.value === a.preset) || { value: 'other', label: a.label || 'Adjustment' };
    const label = a.label || preset.label;
    const adj = { id: MDM.id('adj'), preset: preset.value, label, amount: Math.round(Number(a.amount) || 0), at: now(), by: a.by || 'admin' };
    o.fees = o.fees || { cargo: 0, airport: 0, shopping: 0, adjustments: [] };
    o.fees.adjustments = (o.fees.adjustments || []).concat([adj]);
    recalc(o);
    const verified = o.payment && o.payment.status === 'verified';
    const fmt = MDM.pricing ? MDM.pricing.format(adj.amount) : 'MVR ' + adj.amount;
    pushEvent(o, makeEvent(a.type || 'adjustment', verified ? 'Total updated: ' + label + ' ' + fmt : 'Adjustment: ' + label + ' ' + fmt, a.by, a.visibility || (verified ? 'public' : 'internal'), { adjustmentId: adj.id }));
    return save(o);
  }
  function sendQuote(orderId, q) {
    const o = orderOrThrow(orderId);
    if (o.status !== 'quote_pending') throw new StoreError('transition', 'Order is not waiting for a quote');
    const total = Math.round(Number(q.total) || o.totals.total);
    const diff = total - o.totals.total;
    if (diff !== 0) {
      const adj = { id: MDM.id('adj'), preset: 'quote', label: q.note ? 'Quote adjustment: ' + q.note : 'Quote adjustment', amount: diff, at: now(), by: q.by || 'admin' };
      o.fees.adjustments = (o.fees.adjustments || []).concat([adj]);
      recalc(o);
    }
    o.quote = { status: 'sent', total: o.totals.total, note: q.note || '', sentAt: now(), by: q.by || 'admin' };
    o.totals.quoteRequired = false;
    o.status = 'awaiting_payment';
    const fmt = MDM.pricing ? MDM.pricing.format(o.totals.total) : 'MVR ' + o.totals.total;
    pushEvent(o, makeEvent('quote_sent', 'Quote sent: ' + fmt + (q.note ? ' (' + q.note + ')' : ''), q.by, 'public'));
    return save(o);
  }
  function verifyPayment(orderId, p) {
    const o = orderOrThrow(orderId);
    o.payment = Object.assign({}, o.payment, { status: 'verified', verifiedAt: now(), verifiedBy: p && p.by || 'admin', rejectReason: null });
    if (o.payment.paidAmount == null) o.payment.paidAmount = o.totals.total;
    pushEvent(o, makeEvent('payment_verified', 'Payment verified', p && p.by, 'public'));
    if (o.status === 'payment_review' || o.status === 'awaiting_payment') { o.status = 'confirmed'; pushEvent(o, makeEvent('confirmed', 'Order confirmed, assigning a rider', p && p.by, 'public')); }
    return save(o);
  }
  function markPaid(orderId, p) {
    const o = orderOrThrow(orderId);
    o.payment = Object.assign({}, o.payment, { status: 'verified', verifiedAt: now(), verifiedBy: p.by || 'admin', note: p.note || '', paidAmount: o.payment && o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total });
    pushEvent(o, makeEvent('payment_marked', 'Marked as paid' + (p.note ? ': ' + p.note : ''), p.by, 'internal'));
    o.status = 'confirmed'; pushEvent(o, makeEvent('confirmed', 'Payment received, order confirmed', p.by, 'public'));
    return save(o);
  }
  function rejectPayment(orderId, p) {
    const o = orderOrThrow(orderId);
    o.payment = Object.assign({}, o.payment, { status: 'rejected', rejectReason: p.reason || '', rejectedAt: now() });
    pushEvent(o, makeEvent('payment_rejected', "We couldn't match your transfer: " + (p.reason || ''), p.by, 'public'));
    o.status = 'awaiting_payment';
    return save(o);
  }
  function cancel(orderId, p) {
    const o = orderOrThrow(orderId);
    if ((MDM.ALLOWED[o.status] || []).indexOf('cancelled') < 0) throw new StoreError('transition', 'Cannot cancel a ' + o.status + ' order');
    o.status = 'cancelled'; o.cancelReason = p.reason || ''; o.cancelledBy = p.by || 'admin';
    pushEvent(o, makeEvent('cancelled', (p.by === 'customer' ? 'Cancelled by customer' : 'Order cancelled') + (p.reason ? ': ' + p.reason : ''), p.by, 'public'));
    if (o.driverId) releaseDriverIfIdle(o.driverId, o.id);
    return save(o);
  }
  function recordRefund(orderId, r) {
    const o = orderOrThrow(orderId);
    o.payment = Object.assign({}, o.payment, { refund: { amount: Math.round(Number(r.amount) || 0), toBank: r.toBank || '', toAccount: r.toAccount || '', reference: r.reference || '', at: now(), by: r.by || 'admin' } });
    const fmt = MDM.pricing ? MDM.pricing.format(o.payment.refund.amount) : 'MVR ' + o.payment.refund.amount;
    pushEvent(o, makeEvent('refund', 'Refund sent ' + fmt, r.by, 'public'));
    return save(o);
  }
  function markSettled(orderId, s) {
    const o = orderOrThrow(orderId);
    o.settlement = Object.assign({}, o.settlement || {}, { status: 'settled', settledAt: now(), reference: s.reference || '' });
    pushEvent(o, makeEvent('settled', 'Shopping balance settled' + (s.reference ? ' (' + s.reference + ')' : ''), s.by, 'public'));
    return save(o);
  }

  // Route building: pickups first (in package order), then drop-offs; each stop geocoded from its zone + address.
  function pointFor(end, zone, key) {
    if (end && end.lat != null && end.lng != null) return { lat: end.lat, lng: end.lng };
    if (end && end.cargo && end.cargo.terminal && MDM.geo.terminalPoint(end.cargo.terminal)) { const p = MDM.geo.terminalPoint(end.cargo.terminal); return { lat: p[0], lng: p[1] }; }
    if (zone === 'airport' && end && end.meetAt && MDM.geo.airportPoint(end.meetAt)) { const p = MDM.geo.airportPoint(end.meetAt); return { lat: p[0], lng: p[1] }; }
    return MDM.geo.geocodeZone(zone === 'other' ? 'male' : zone, key);
  }
  function buildStops(o) {
    const stops = [];
    (o.packages || []).forEach((pkg, i) => {
      const n = i + 1;
      if (o.service === 'shop' && pkg.shop) {
        const zone = pkg.shop.zone || 'male';
        const p = pointFor({ lat: pkg.shop.lat, lng: pkg.shop.lng }, zone, pkg.shop.name + ' ' + (pkg.shop.address || ''));
        stops.push({ id: MDM.id('stp'), packageId: pkg.id, type: 'pickup', label: 'Shop: ' + pkg.shop.name, address: pkg.shop.address || pkg.shop.name, zone, lat: p.lat, lng: p.lng, contact: { name: pkg.shop.name, phone: '' }, status: 'pending', at: null, attempts: 0, shop: true });
      } else if (pkg.pickup) {
        const zone = pkg.pickup.zone || 'male';
        const p = pointFor(pkg.pickup, zone, pkg.pickup.address);
        stops.push({ id: MDM.id('stp'), packageId: pkg.id, type: 'pickup', label: 'Pickup ' + n, address: pkg.pickup.address, landmark: pkg.pickup.landmark || '', zone, lat: p.lat, lng: p.lng, contact: pkg.pickup.contact || { name: o.customer.name, phone: o.customer.phone }, cargo: pkg.pickup.cargo || null, meetAt: pkg.pickup.meetAt || '', status: 'pending', at: null, attempts: 0 });
      }
    });
    (o.packages || []).forEach((pkg, i) => {
      const n = i + 1, d = pkg.dropoff || {};
      const zone = d.zone || 'male';
      const p = pointFor(d, zone, d.address);
      stops.push({ id: MDM.id('stp'), packageId: pkg.id, type: 'dropoff', label: 'Drop-off ' + n, address: d.address, landmark: d.landmark || '', zone, lat: p.lat, lng: p.lng, contact: d.recipient || { name: o.customer.name, phone: o.customer.phone }, cargo: d.cargo || null, meetAt: d.meetAt || '', status: 'pending', at: null, attempts: 0 });
    });
    return stops;
  }
  function driverName(driverId) { const d = readCol('drivers').find(x => x.id === driverId); return d ? d.name : 'rider'; }
  function assignDriver(orderId, driverId, opts) {
    opts = opts || {};
    const o = orderOrThrow(orderId);
    const d = readCol('drivers').find(x => x.id === driverId); if (!d) throw new StoreError('not_found', 'Rider not found');
    const reassign = !!o.driverId && o.driverId !== driverId;
    if (o.status === 'confirmed') o.status = 'assigned';
    else if (MDM.ACTIVE_STATUSES.indexOf(o.status) < 0) throw new StoreError('transition', 'Cannot assign a rider to a ' + o.status + ' order');
    const prev = o.driverId;
    o.driverId = driverId;
    if (!o.route || !o.route.stops || !o.route.stops.length) o.route = { stops: buildStops(o), polyline: [] };
    o.route.polyline = MDM.geo.routeThrough(o.route.stops);
    pushEvent(o, makeEvent(reassign ? 'reassigned' : 'assigned', (reassign ? 'Rider changed to ' : 'Rider assigned: ') + d.name, opts.by, 'public', { driverId }));
    const saved = save(o);
    if (prev && prev !== driverId) releaseDriverIfIdle(prev, o.id);
    if (d.status === 'offline') update('drivers', driverId, { status: 'online' });
    return saved;
  }
  function releaseDriverIfIdle(driverId, exceptOrderId) {
    const active = readCol('orders').some(x => x.driverId === driverId && x.id !== exceptOrderId && MDM.ACTIVE_STATUSES.indexOf(x.status) >= 0);
    if (!active) { const d = readCol('drivers').find(x => x.id === driverId); if (d && d.status === 'on_route') update('drivers', driverId, { status: 'online' }); }
  }
  function startRoute(orderId, opts) {
    opts = opts || {};
    const o = orderOrThrow(orderId);
    if (o.status !== 'assigned') throw new StoreError('transition', 'Route already started');
    o.status = 'in_transit';
    pushEvent(o, makeEvent('route_started', driverName(o.driverId) + ' is on the way', opts.by, 'public'));
    if (o.driverId) update('drivers', o.driverId, { status: 'on_route' });
    return save(o);
  }
  function deriveStatus(o) {
    const stops = o.route.stops;
    const pickups = stops.filter(s => s.type === 'pickup'), drops = stops.filter(s => s.type === 'dropoff'), returns = stops.filter(s => s.type === 'return');
    if (stops.some(s => s.status === 'failed') && !returns.length) return 'on_hold';
    if (returns.length && returns.every(s => s.status === 'done') && drops.every(s => s.status === 'done' || s.status === 'failed')) return 'returned';
    if (drops.length && drops.every(s => s.status === 'done')) return 'delivered';
    if (pickups.length && pickups.every(s => s.status === 'done')) return 'in_transit';
    if (pickups.some(s => s.status === 'done')) return 'picked_up';
    return o.status === 'assigned' ? 'assigned' : 'in_transit';
  }
  function settleShop(o) {
    if (o.service !== 'shop') return;
    const paid = o.payment && o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total;
    const due = o.totals.total;
    const balance = paid - due;
    o.settlement = { status: balance > 0 ? 'refund_due' : balance < 0 ? 'topup_due' : 'settled', paid, due, balance, settledAt: balance === 0 ? now() : null, reference: '' };
  }
  function setStop(orderId, stopId, p) {
    const o = orderOrThrow(orderId);
    if (!o.route || !o.route.stops) throw new StoreError('validation', 'Order has no route');
    const s = o.route.stops.find(x => x.id === stopId); if (!s) throw new StoreError('not_found', 'Stop not found');
    const by = p.by || ('driver:' + (o.driverId || ''));
    const who = driverName(o.driverId);
    const before = o.status;
    if (p.status === 'arrived') {
      s.status = 'arrived'; s.arrivedAt = now();
      pushEvent(o, makeEvent('arrived', who + ' arrived at ' + s.label.toLowerCase(), by, 'public', { stopId }));
      if (o.status === 'assigned') { o.status = 'in_transit'; if (o.driverId) update('drivers', o.driverId, { status: 'on_route' }); }
    } else if (p.status === 'done') {
      s.status = 'done'; s.at = now(); s.note = p.note || s.note || '';
      if (s.type === 'pickup') {
        if (s.shop) {
          const pkg = o.packages.find(k => k.id === s.packageId);
          if (pkg && pkg.shop) { pkg.shop.receiptTotal = Math.round(Number(p.receiptTotal) || 0); pkg.shop.receiptPhotoId = p.receiptPhotoId || null; recalc(o); }
          s.receiptTotal = p.receiptTotal; s.receiptPhotoId = p.receiptPhotoId || null;
          pushEvent(o, makeEvent('picked_up', 'Shopping done, receipt ' + (MDM.pricing ? MDM.pricing.format(pkg && pkg.shop ? pkg.shop.receiptTotal : 0) : ''), by, 'public', { stopId }));
        } else pushEvent(o, makeEvent('picked_up', 'Picked up from ' + s.address, by, 'public', { stopId }));
      } else {
        s.handedTo = p.handedTo || 'recipient'; s.recipientName = p.recipientName || ''; s.photoId = p.photoId || null;
        const handed = { recipient: '', family: ' (family or colleague)', security: ' (security or reception)', left: ' (left as instructed)' }[s.handedTo] || '';
        const label = s.type === 'return' ? 'Returned to sender' : 'Delivered' + (s.recipientName ? ' to ' + s.recipientName : '') + handed;
        pushEvent(o, makeEvent(s.type === 'return' ? 'returned' : 'delivered', label, by, 'public', { stopId }));
      }
      o.status = deriveStatus(o);
      if (o.status === 'delivered' && before !== 'delivered') settleShop(o);
      if (o.status === 'delivered' || o.status === 'returned') { if (o.driverId) releaseDriverIfIdle(o.driverId, o.id); }
    } else if (p.status === 'failed') {
      s.status = 'failed'; s.failReason = p.failReason || 'no_answer'; s.note = p.note || ''; s.failedAt = now();
      const r = MDM.FAIL_REASONS.find(x => x.value === s.failReason);
      pushEvent(o, makeEvent('stop_failed', "Couldn't complete " + s.label.toLowerCase() + ': ' + (r ? r.label.toLowerCase() : s.failReason) + (p.note ? ' (' + p.note + ')' : ''), by, 'public', { stopId }));
      o.status = 'on_hold';
    } else if (p.status === 'pending') {
      s.status = 'pending'; s.attempts = (s.attempts || 0) + 1; s.failReason = null;
    }
    if (o.status !== before && ['in_transit', 'picked_up', 'delivered', 'on_hold', 'returned'].indexOf(o.status) >= 0 && ['in_transit', 'picked_up'].indexOf(o.status) >= 0) {
      pushEvent(o, makeEvent(o.status === 'picked_up' ? 'picked_up' : 'route_started', MDM.STATUS[o.status].customer, by, 'internal'));
    }
    return save(o);
  }
  function retryStop(orderId, stopId, p) {
    const o = orderOrThrow(orderId);
    const s = (o.route && o.route.stops || []).find(x => x.id === stopId); if (!s) throw new StoreError('not_found', 'Stop not found');
    s.status = 'pending'; s.attempts = (s.attempts || 0) + 1; s.failReason = null; s.failedAt = null;
    pushEvent(o, makeEvent('stop_retried', 'Retrying ' + s.label.toLowerCase(), p && p.by, 'public', { stopId }));
    o.status = o.route.stops.some(x => x.type === 'pickup' && x.status !== 'done') && o.route.stops.some(x => x.type === 'pickup' && x.status === 'done') ? 'picked_up' : 'in_transit';
    if (o.driverId) update('drivers', o.driverId, { status: 'on_route' });
    return save(o);
  }
  function returnToSender(orderId, p) {
    const o = orderOrThrow(orderId);
    const failed = (o.route && o.route.stops || []).filter(x => x.status === 'failed');
    if (!failed.length) throw new StoreError('validation', 'No failed stop to return');
    const pickup = o.route.stops.find(x => x.type === 'pickup') || o.route.stops[0];
    o.route.stops.push({ id: MDM.id('stp'), packageId: failed[0].packageId, type: 'return', label: 'Return to sender', address: pickup.address, landmark: pickup.landmark || '', zone: pickup.zone, lat: pickup.lat, lng: pickup.lng, contact: pickup.contact, status: 'pending', at: null, attempts: 0 });
    o.route.polyline = MDM.geo.routeThrough(o.route.stops.filter(x => x.status !== 'done'));
    pushEvent(o, makeEvent('return_added', 'Returning package to sender', p && p.by, 'public'));
    o.status = 'in_transit';
    if (o.driverId) update('drivers', o.driverId, { status: 'on_route' });
    return save(o);
  }
  function driverRoute(driverId) {
    const orders = sortBy(readCol('orders').filter(o => o.driverId === driverId && MDM.ACTIVE_STATUSES.indexOf(o.status) >= 0), 'createdAt');
    const stops = [];
    orders.forEach(o => (o.route && o.route.stops || []).forEach(s => stops.push(Object.assign({}, s, { orderId: o.id, code: o.code, orderStatus: o.status }))));
    const open = stops.filter(s => s.status !== 'done' && s.status !== 'failed');
    // Draw from the most recently completed stop (where the rider is coming from) through every open stop.
    const done = stops.filter(s => s.status === 'done').sort((a, b) => (a.at || '') < (b.at || '') ? -1 : 1);
    const chain = (done.length ? [done[done.length - 1]] : []).concat(open);
    const polyline = chain.length >= 2 ? MDM.geo.routeThrough(chain) : (chain.length === 1 ? [[chain[0].lat, chain[0].lng]] : []);
    return clone({ orders, stops, polyline });
  }
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
  function createInvoice(accountId, month, opts) {
    opts = opts || {};
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
    return insert('invoices', { accountId, month, number, lines, subtotal, gstPercent, gst, total: Math.round((subtotal + gst) * 100) / 100, status: 'draft', issuedAt: issued.toISOString(), dueAt: due.toISOString(), paidAt: null, reference: '' });
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
    _boot: boot, _tabId: tabId,
    transition: P(transition), addEvent: P(addEvent), addNote: P(addNote), addAdjustment: P(addAdjustment), sendQuote: P(sendQuote),
    verifyPayment: P(verifyPayment), markPaid: P(markPaid), rejectPayment: P(rejectPayment), cancel: P(cancel), recordRefund: P(recordRefund), markSettled: P(markSettled),
    assignDriver: P(assignDriver), startRoute: P(startRoute), setStop: P(setStop), retryStop: P(retryStop), returnToSender: P(returnToSender),
    driverRoute: P(driverRoute), upsertCustomer: P(upsertCustomer), createInvoice: P(createInvoice), orderByCode: P(orderByCode),
    buildStops: P(o => buildStops(clone(o))),
    _buildStops: buildStops,   // synchronous, for seed.js only
  };
})(window.MDM);

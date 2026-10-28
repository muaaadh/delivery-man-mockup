// Orders view: quick tabs and filters kept in the hash query (client requirements §8), the paginated table, the order drawer with
// every operator action (price confirmation §3/§15, payments §4, driver workflow §13, failures §14, cancellation and changes §9,
// priority §11) and "New order": a customer's order on the customer request form in office mode (request/?office=1), a business
// account's order in the drawer here. Every write goes through MDM.store's domain methods with the signed-in user as `by`;
// nothing here pushes into events, stops, adjustments or notes directly. The drawer re-renders on store changes while open.
(function (MDM) { 'use strict';
  const { el, html, toast, dialog, confirm, drawer, setError, phone, fmtDate, timeAgo, dayKey } = MDM.ui;
  const F = MDM.admin.fmt;
  const money = F.money;
  const by = () => MDM.admin.by();
  const PAGE = 25;
  const DONE = F.DONE;
  const IN_PROGRESS = ['confirmed', 'assigned', 'dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery'];
  const open = o => DONE.indexOf(o.status) < 0;
  // Client 28/10/2026: a delivered order's price and package categories can still be corrected (a driver chose the wrong category)
  // until it is paid or goes on a weekly business invoice. The invoice shows the new total.
  const correctable = o => o.status === 'delivered' && !!o.payment && ['pending', 'requested', 'received'].indexOf(o.payment.status) >= 0;
  const TABS = [
    { value: 'all', label: 'All', test: () => true },
    // Needs price: requests to price, and orders collected without a photo whose price is set from the proof of collection (17/10/2026).
    { value: 'price', label: 'Needs price', test: o => o.status === 'requested' || MDM.priceToFinalise(o) },
    { value: 'payments', label: 'Payments to verify', test: o => o.payment && o.payment.status === 'received' },
    { value: 'unassigned', label: 'Unassigned', test: o => F.toAssign(o) },
    { value: 'active', label: 'Active', test: o => IN_PROGRESS.indexOf(o.status) >= 0 },
    { value: 'failed', label: 'Failed', test: o => o.status === 'failed' },
    { value: 'cancels', label: 'Cancel requests', test: o => o.cancellation && o.cancellation.status === 'requested' && open(o) },
    { value: 'priority', label: 'Priority requests', test: o => o.priority && o.priority.status === 'requested' && open(o) },
    { value: 'returns', label: 'Returns', test: o => F.returnPending(o) },
    { value: 'cash', label: 'Cash differences', test: o => F.cashDifference(o) },
    { value: 'done', label: 'Done', test: o => DONE.indexOf(o.status) >= 0 },
  ];
  const TYPES = MDM.REQUEST_TYPES.map(t => ({ value: t.value, label: t.legacy ? t.label + ' (older orders)' : t.label }))
    .concat([{ value: 'business', label: 'Business delivery' }, { value: 'bulk', label: 'Business bulk' }, { value: 'store', label: 'E-store order' }]);
  const METHODS = MDM.DELIVERY_METHODS.map(m => ({ value: m.value, label: m.label }));
  const methodOf = o => (o.delivery && o.delivery.method) || 'home';
  const SOURCES = [{ value: 'phone', label: 'Phone' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'viber', label: 'Viber' }, { value: 'walkin', label: 'Walk-in' }];
  const SIZE_OPTIONS = ['bag', 'box', 'xl'].map(s => ({ value: s, label: MDM.pricing.sizeLabel(s) }));
  // Package categories only (web app updates §2.2): nobody measures, so the meta line says who chose the category.
  const CATEGORY_SOURCE = { customer: 'Category chosen by the customer', driver: 'Category set by the driver', operator: 'Category set by the office', estimate: 'Category chosen when booking' };
  const STAGE = { collection: 'Paid at collection', delivery: 'Paid at delivery', office: 'Recorded by the office' };
  const STAGE_OPTIONS = [{ value: 'collection', label: 'At collection' }, { value: 'delivery', label: 'At delivery' }, { value: 'office', label: 'Office' }];
  const PAID_BY = [{ value: 'driver', label: 'Driver' }, { value: 'office', label: 'Office' }];
  const AUDIENCE = { driver: 'To the driver', operations: 'To operations', business: 'To the business' };
  const FILE_KIND = { package: 'Package photo', proof_collection: 'Proof of collection', proof: 'Proof of delivery', failed: 'Failed attempt', slip: 'Transfer slip', receipt: 'Shop receipt', document: 'Document', cargo_bill: 'Maldivian Cargo bill' };
  // What a customer upload is for (request form documents): shown before the file name.
  const DOC_KIND = { invoice: 'Invoice', quotation: 'Quotation', payment_slip: 'Payment slip', collection_doc: 'Collection document', document: 'Document' };
  const state = {
    host: null, alive: false, unsubs: [], timer: null, filters: {}, page: 0, controls: null, slots: {}, settings: null,
    drawer: { kind: null, id: null, silent: false, noteDraft: {}, assignChoice: {}, order: null },
    neworder: null,
  };
  const trim = v => String(v == null ? '' : v).trim();
  const plural = F.plural;
  const label = (list, v) => ((list || []).find(x => x.value === v) || {}).label || v || '';

  // ---- Filters ------------------------------------------------------------------------------------------------------------
  const FILTER_KEYS = ['tab', 'status', 'type', 'method', 'payment', 'driver', 'zone', 'from', 'to', 'q', 'customer', 'account', 'batch'];
  function readFilters(q) {
    const f = {}; FILTER_KEYS.forEach(k => { f[k] = q.get(k) || ''; });
    if (!TABS.some(t => t.value === f.tab)) f.tab = 'all';
    if (f.status && !MDM.STATUS[f.status]) f.status = '';
    if (f.payment && !MDM.PAYMENT[f.payment]) f.payment = '';
    if (f.method && !METHODS.some(m => m.value === f.method)) f.method = '';
    return f;
  }
  function setFilters(patch) {
    Object.assign(state.filters, patch);
    state.page = 0;
    const q = {};
    FILTER_KEYS.forEach(k => { q[k] = k === 'tab' && state.filters.tab === 'all' ? null : state.filters[k]; });
    MDM.admin.setQuery(q);
    render().catch(() => {});
  }
  function clearFilters() { const p = {}; FILTER_KEYS.forEach(k => { p[k] = k === 'tab' ? state.filters.tab : ''; }); setFilters(p); }
  function activeCount() { return FILTER_KEYS.filter(k => k !== 'tab' && state.filters[k]).length; }
  function zonesOf(o) {
    const z = [o.collection && o.collection.zone, o.delivery && o.delivery.zone];
    (o.packages || []).forEach(p => { if (o.service === 'shop' && p.shop) z.push(p.shop.zone); else if (p.pickup) z.push(p.pickup.zone); if (p.dropoff) z.push(p.dropoff.zone); });
    return z.filter(Boolean);
  }
  function matchesQ(o, q, ctx) {
    const s = q.toLowerCase().replace(/\s+/g, '');
    const digits = s.replace(/\D/g, '');
    const d = o.delivery || {}, b = d.boat || {};
    // Boat orders are found by the vessel (including one it was moved off) and the destination island too (§3.2, §5.3).
    const boatNames = [b.name].concat((b.history || []).map(h => h.from && h.from.name));
    const hay = [o.code, o.customer && o.customer.name, d.recipientName, o.collection && o.collection.contactName,
      ctx.accountName[o.accountId], ctx.batchCode[o.batchId], o.details && (o.details.reference || o.details.trackingNo || o.details.collectionCode || o.details.orderNo),
      b.island, d.cargo && d.cargo.island, d.airport && d.airport.resort, d.airport && d.airport.speedboat].concat(boatNames)
      .filter(Boolean).map(x => String(x).toLowerCase().replace(/\s+/g, '')).join('|');
    const phones = [o.customer && o.customer.phone, o.delivery && o.delivery.recipientPhone, o.collection && o.collection.contactPhone].filter(Boolean).map(x => String(x).replace(/\D/g, '')).join('|');
    return hay.indexOf(s) >= 0 || hay.replace(/-/g, '').indexOf(s.replace(/-/g, '')) >= 0 || (digits.length >= 3 && phones.indexOf(digits) >= 0);
  }
  function applyFilters(orders, ctx, skipTab) {
    const f = state.filters;
    const tab = TABS.find(t => t.value === f.tab) || TABS[0];
    return orders.filter(o => {
      if (!skipTab && !tab.test(o)) return false;
      if (f.status && o.status !== f.status) return false;
      if (f.type && o.requestType !== f.type) return false;
      if (f.method && methodOf(o) !== f.method) return false;
      if (f.payment && (o.payment || {}).status !== f.payment) return false;
      if (f.driver && (f.driver === 'none' ? !!o.driverId : o.driverId !== f.driver)) return false;
      if (f.zone && zonesOf(o).indexOf(f.zone) < 0) return false;
      if (f.from && dayKey(o.createdAt) < f.from) return false;
      if (f.to && dayKey(o.createdAt) > f.to) return false;
      if (f.customer && o.customerId !== f.customer) return false;
      if (f.account && o.accountId !== f.account) return false;
      if (f.batch && o.batchId !== f.batch) return false;
      if (f.q && !matchesQ(o, f.q, ctx)) return false;
      return true;
    });
  }
  // One set of filter controls; built once for the desktop row and again for the mobile drawer (test ids match).
  function buildControls(drivers) {
    const opt = (value, text) => el('option', { value }, text);
    const status = el('select', { class: 'select', 'aria-label': 'Status', 'data-testid': 'orders-filter-status' }, opt('', 'All statuses'), Object.keys(MDM.STATUS).map(k => opt(k, MDM.STATUS[k].label)));
    const type = el('select', { class: 'select', 'aria-label': 'Request type', 'data-testid': 'orders-filter-type' }, opt('', 'All types'), TYPES.map(s => opt(s.value, s.label)));
    const method = el('select', { class: 'select', 'aria-label': 'Delivery method', 'data-testid': 'orders-filter-method' }, opt('', 'All delivery methods'), METHODS.map(m => opt(m.value, m.label)));
    const payment = el('select', { class: 'select', 'aria-label': 'Payment', 'data-testid': 'orders-filter-payment' }, opt('', 'All payments'), Object.keys(MDM.PAYMENT).map(k => opt(k, MDM.PAYMENT[k].label)));
    const driver = el('select', { class: 'select', 'aria-label': 'Driver', 'data-testid': 'orders-filter-driver' }, opt('', 'All drivers'), opt('none', 'No driver'), drivers.map(d => opt(d.id, d.name)));
    const zone = el('select', { class: 'select', 'aria-label': 'Zone', 'data-testid': 'orders-filter-zone' }, opt('', 'All zones'), MDM.geo.zoneOptions().map(z => opt(z.value, z.label)));
    const from = el('input', { class: 'input', type: 'date', 'aria-label': 'Created from', 'data-testid': 'orders-filter-from' });
    const to = el('input', { class: 'input', type: 'date', 'aria-label': 'Created to', 'data-testid': 'orders-filter-to' });
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Order, name, phone or boat', 'aria-label': 'Search orders', autocomplete: 'off', 'data-testid': 'orders-search' });
    [[status, 'status'], [type, 'type'], [method, 'method'], [payment, 'payment'], [driver, 'driver'], [zone, 'zone'], [from, 'from'], [to, 'to']].forEach(([c, k]) => c.addEventListener('change', () => { const p = {}; p[k] = c.value; setFilters(p); }));
    const deb = MDM.ui.debounce(() => setFilters({ q: trim(search.value) }), 250);
    search.addEventListener('input', deb);
    search.addEventListener('search', () => { deb.cancel(); setFilters({ q: trim(search.value) }); });
    const node = el('div', { class: 'filters filters--orders' }, search, status, type, method, payment, driver, zone, el('div', { class: 'filters__dates' }, from, el('span', { class: 'filters__dash', 'aria-hidden': 'true' }, 'to'), to));
    function sync() {
      const f = state.filters;
      status.value = f.status; type.value = f.type; method.value = f.method; payment.value = f.payment; driver.value = f.driver; zone.value = f.zone; from.value = f.from; to.value = f.to;
      if (document.activeElement !== search) search.value = f.q;
    }
    sync();
    return { el: node, sync };
  }
  function openFiltersDrawer() {
    const controls = buildControls(state.drivers || []);
    const body = el('div', { class: 'drawer__section' }, el('h3', null, 'Show orders that match'), controls.el);
    state.drawer.kind = 'filters';
    drawer.open({ title: 'Filters', body, size: 'md', onClose: () => { if (state.drawer.kind === 'filters') state.drawer.kind = null; },
      footer: [el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'orders-clear', on: { click: () => { clearFilters(); controls.sync(); } } }, 'Clear filters'),
        el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'orders-filters-done', on: { click: () => drawer.close() } }, 'Show orders')] });
  }
  function chips(ctx) {
    const f = state.filters, out = [];
    const chip = (key, text) => el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'orders-chip', 'data-filter': key, on: { click: () => { const p = {}; p[key] = ''; setFilters(p); } } },
      text, html(MDM.icon('x', 16)), el('span', { class: 'sr-only' }, ', remove this filter'));
    if (f.status) out.push(chip('status', 'Status: ' + MDM.STATUS[f.status].label));
    if (f.type) out.push(chip('type', 'Type: ' + label(TYPES, f.type)));
    if (f.method) out.push(chip('method', 'Delivery: ' + label(METHODS, f.method)));
    if (f.payment) out.push(chip('payment', 'Payment: ' + MDM.PAYMENT[f.payment].label));
    if (f.driver) out.push(chip('driver', 'Driver: ' + (f.driver === 'none' ? 'none' : F.driverName(f.driver, ctx.drivers) || f.driver)));
    if (f.zone) out.push(chip('zone', 'Zone: ' + MDM.geo.zoneLabel(f.zone)));
    if (f.from) out.push(chip('from', 'From ' + F.fmtDay(f.from)));
    if (f.to) out.push(chip('to', 'To ' + F.fmtDay(f.to)));
    if (f.q) out.push(chip('q', 'Search: ' + f.q));
    if (f.customer) out.push(chip('customer', 'Customer: ' + (ctx.customer ? ctx.customer.name : f.customer)));
    if (f.account) out.push(chip('account', 'Business: ' + (ctx.accountName[f.account] || f.account)));
    if (f.batch) out.push(chip('batch', 'Bulk: ' + (ctx.batchCode[f.batch] || f.batch)));
    if (out.length) out.push(el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'orders-clear', on: { click: clearFilters } }, 'Clear filters'));
    return out;
  }

  // ---- List -----------------------------------------------------------------------------------------------------------------
  async function render() {
    if (!state.alive) return;
    const f = state.filters;
    const [orders, drivers, customer, accounts, batches, settings] = await Promise.all([
      MDM.store.list('orders'), MDM.store.list('drivers'), f.customer ? MDM.store.get('customers', f.customer) : null,
      MDM.store.list('business_accounts'), MDM.store.list('batches'), MDM.store.settings()]);
    if (!state.alive) return;
    state.settings = settings; state.drivers = drivers;
    const ctx = { drivers, customer, accountName: {}, batchCode: {} };
    accounts.forEach(a => { ctx.accountName[a.id] = a.name; });
    batches.forEach(b => { ctx.batchCode[b.id] = b.code; });
    const base = applyFilters(orders, ctx, true);
    state.slots.tabs.querySelectorAll('[data-tab]').forEach(t => {
      const def = TABS.find(x => x.value === t.dataset.tab);
      const n = base.filter(def.test).length;
      t.setAttribute('aria-selected', f.tab === def.value ? 'true' : 'false');
      t.querySelector('.tab__count').textContent = def.value === 'all' || def.value === 'done' || def.value === 'active' ? String(n) : (n ? String(n) : '');
      t.classList.toggle('is-hot', def.value !== 'all' && def.value !== 'done' && def.value !== 'active' && n > 0);
    });
    // Eleven queues do not fit a phone: bring the chosen tab into view inside the scrolling tab bar when the tab changes.
    // The view eases in when it is first mounted and the list when the tab changes; data re-renders do not replay it.
    const entering = state.lastTab === null ? 'view' : state.lastTab !== f.tab ? 'tab' : null;
    if (state.lastTab !== f.tab) {
      state.lastTab = f.tab;
      const bar = state.slots.tabs, cur = bar.querySelector('[aria-selected="true"]');
      if (cur) { const br = bar.getBoundingClientRect(), cr = cur.getBoundingClientRect(); if (cr.left < br.left || cr.right > br.right) bar.scrollLeft += (cr.left - br.left) - (br.width - cr.width) / 2; }
    }
    const rows = applyFilters(orders, ctx, false);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (state.page >= pages) state.page = pages - 1;
    const from = state.page * PAGE, slice = rows.slice(from, from + PAGE);
    state.controls.sync();
    state.slots.chips.replaceChildren(...chips(ctx));
    const n = activeCount();
    state.slots.filtersBtn.replaceChildren(html(MDM.icon('filter', 16)), n ? 'Filters · ' + n : 'Filters');
    const narrow = window.innerWidth < 1400;
    const cols = F.columnsFor({ narrow });
    if (!slice.length) {
      state.slots.table.replaceChildren(F.emptyBlock('No orders match.', f.tab !== 'all' ? 'Nothing in "' + label(TABS, f.tab) + '" right now.' : 'Try a wider date range or clear a filter.',
        activeCount() ? el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'orders-empty-clear', on: { click: clearFilters } }, 'Clear filters') : null));
    } else {
      const prev = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'orders-prev', disabled: state.page === 0, on: { click: () => { state.page -= 1; render(); } } }, 'Previous');
      const next = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'orders-next', disabled: state.page >= pages - 1, on: { click: () => { state.page += 1; render(); } } }, 'Next');
      state.slots.table.replaceChildren(
        el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack', 'data-testid': 'orders-table' }, F.orderTableHead(cols), el('tbody', null, slice.map(o => F.orderRow(o, cols, { drivers, narrow }))))),
        el('div', { class: 'pagination', 'data-testid': 'orders-pagination' },
          el('span', null, 'Showing ' + (from + 1) + ' to ' + (from + slice.length) + ' of ' + rows.length),
          el('div', { class: 'pagination__actions' }, el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'orders-export', on: { click: () => exportRows(rows, ctx) } }, html(MDM.icon('download', 16)), 'Export CSV'), prev, next)));
    }
    if (entering && MDM.motion) MDM.motion.enter(entering === 'view' ? state.host : state.slots.table);
    if (state.drawer.kind === 'order' && state.drawer.id) await renderOrderDrawer();
  }
  function exportRows(rows, ctx) {
    const head = ['Order', 'Created', 'Type', 'Service level', 'Customer', 'Phone', 'Business', 'Collection', 'Extra collections', 'Delivery method', 'Delivery', 'Packages', 'Total MVR', 'Price', 'Payment', 'Cash to collect MVR', 'Cash status', 'Status', 'Driver'];
    F.downloadCsv([head].concat(rows.map(o => [o.code, o.createdAt.slice(0, 16).replace('T', ' '), F.typeLabel(o), F.LEVEL[o.serviceLevel] || 'Normal', o.customer.name, o.customer.phone, ctx.accountName[o.accountId] || '',
      (o.collection || {}).address || '', (o.extraCollections || []).length, F.methodText(o), (o.delivery || {}).address || '', (o.packages || []).length, o.totals.total, (o.pricing || {}).status === 'confirmed' ? 'Confirmed' : 'Estimated',
      (MDM.PAYMENT[(o.payment || {}).status] || {}).label || '', o.cod ? o.cod.amount : '', o.cod ? ((MDM.COD_STATUS[o.cod.status] || {}).label || o.cod.status) : '',
      MDM.STATUS[o.status].label, F.driverName(o.driverId, ctx.drivers)])), 'mdm-orders-' + dayKey(new Date()) + '.csv');
    toast('Exported ' + plural(rows.length, 'order'), 'ok');
  }

  // ---- Drawer building blocks ---------------------------------------------------------------------------------------------
  const sec = (title, testid, ...children) => el('div', { class: 'drawer__section', 'data-testid': testid }, el('h3', null, title), children);
  const row = (k, value, opts) => (value == null || value === '') ? null : el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, k), el('div', { class: 'rate-table__value' + (opts && opts.mono ? ' mono' : '') }, value));
  const rowNode = (k, node) => el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, k), el('div', { class: 'rate-table__value' }, node));
  const badgeNode = (kind, text, attrs) => html(MDM.ui.badge(kind, text, attrs));
  const smallBtn = (text, testid, fn, cls) => el('button', { type: 'button', class: 'btn btn--sm ' + (cls || 'btn--secondary'), 'data-testid': testid, on: { click: () => act(fn) } }, text);
  function person(name, ph) { return [trim(name), ph ? phone.format(ph) : ''].filter(Boolean).join(' · '); }
  function contactLinks(ph) {
    const l = phone.links(ph);
    return l ? el('small', { class: 'contact-links' }, el('a', { href: l.tel }, 'Call'), ' · ', el('a', { href: l.wa, target: '_blank', rel: 'noopener' }, 'WhatsApp'), ' · ', el('a', { href: l.sms }, 'SMS')) : null;
  }
  function bankName(id) { const b = ((state.settings || {}).banks || []).find(x => x.id === id); return b ? b.name : (id === 'other' ? 'Other bank' : (id || '')); }
  function thumbButton(file, text) {
    if (!file || !/^image\//.test(file.type || '')) return null;
    return el('button', { type: 'button', class: 'thumb-btn', 'data-testid': 'drawer-photo', 'data-kind': file.kind, 'aria-label': 'Open ' + text, title: text, on: { click: () => showImage(file.dataUrl, text) } }, el('img', { class: 'thumb', src: file.dataUrl, alt: '' }));
  }
  function showImage(src, title) {
    const dlg = el('dialog', { class: 'dialog dialog--wide', 'data-testid': 'image-dialog', 'aria-label': title });
    dlg.append(el('div', { class: 'dialog__body' }, el('p', { class: 'image-dialog__title' }, title), el('img', { src, alt: title })),
      el('div', { class: 'dialog__footer' }, el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'image-dialog-close', on: { click: () => dlg.close() } }, 'Close')));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  // A button that runs an action and carries extra attributes (data-package-id, data-charge-id) for the row it belongs to.
  const rowBtn = (text, testid, fn, cls, attrs) => el('button', Object.assign({ type: 'button', class: 'btn btn--sm ' + (cls || 'btn--secondary'), 'data-testid': testid, on: { click: () => act(fn) } }, attrs || {}), text);
  const sum = (list, f) => (list || []).reduce((t, x) => t + (Number(f ? f(x) : x) || 0), 0);
  const jettyLabel = v => label(MDM.geo.terminals(), v);
  const vesselLabel = v => label(MDM.VESSEL_TYPES, v);
  function departureText(b) { return [b.departureDate ? F.fmtDay(b.departureDate) : '', b.departureTime || ''].filter(Boolean).join(', '); }
  // The vehicle charge the office usually adds (settings.rates.vehicle); empty when the rate card has none.
  const vehicleRate = () => { const v = Number((((state.settings || {}).rates) || {}).vehicle); return v > 0 ? Math.round(v) : null; };
  // Extra vehicle (§2.3): order.extraVehicle is the customer's request at booking; the charge is order.vehicleCharged (set by
  // store.addVehicleCharge, read with F.vehicleCharged) and its 'vehicle' price adjustments.
  const vehicleCharges = o => ((o.fees || {}).adjustments || []).filter(a => a.preset === 'vehicle');
  // '2 XL-size packages', '2 boxes and 1 XL-size package': what makes an order need a vehicle (§2.3).
  function bigPackagesText(o) {
    const count = sz => (o.packages || []).filter(p => p.size === sz).length;
    return [count('box') ? plural(count('box'), 'box', 'boxes') : '', count('xl') ? plural(count('xl'), 'XL-size package') : ''].filter(Boolean).join(' and ');
  }
  const chargeTitle = c => c.type === 'other' ? (c.description || 'Other charge') : label(MDM.CHARGE_TYPES, c.type);
  // Runs `fn(dialogEl)` on the dialog MDM.ui.dialog just opened (it mounts synchronously), to link one field to another.
  function withDialog(promise, fn) {
    const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
    if (dlg) { try { fn(dlg); } catch (e) { /* the dialog still works without the link */ } }
    return promise;
  }
  function nextStop(o, types) { return ((o.route && o.route.stops) || []).find(s => types.indexOf(s.type) >= 0 && ['done', 'failed', 'skipped'].indexOf(s.status) < 0) || null; }
  function openStops(o) { return ((o.route && o.route.stops) || []).filter(s => ['done', 'failed', 'skipped'].indexOf(s.status) < 0); }
  const isPaid = o => o.payment && o.payment.status === 'paid';

  // ---- Drawer sections -------------------------------------------------------------------------------------------------------
  // Banners for whatever needs a decision on this order, with the action right there.
  function alertsSection(o, ctx) {
    const out = [];
    const banner = (kind, title, body, actions, testid) => out.push(el('div', { class: 'alert alert--' + kind + ' drawer-alert', 'data-testid': testid }, html(MDM.icon(kind === 'danger' ? 'alert-circle' : 'alert-triangle', 16)),
      el('div', { class: 'alert__body' }, el('div', { class: 'alert__title' }, title), body ? el('div', null, body) : null, actions && actions.length ? el('div', { class: 'drawer-alert__actions' }, actions) : null)));
    const est = o.estimate ? money(o.estimate.min) + (o.estimate.max !== o.estimate.min ? ' to ' + money(o.estimate.max) : '') : money(o.totals.total);
    // §2.3: the customer's Extra vehicle request is the first thing the operator sees on a request, whichever way it is priced.
    const charged = F.vehicleCharged(o);
    const big = bigPackagesText(o);
    const vehicle = o.status === 'requested' && (o.extraVehicle || charged) ? el('div', { class: 'vehicle-request', 'data-testid': 'drawer-extra-vehicle', 'data-requested': o.extraVehicle ? 'true' : 'false', 'data-charged': charged ? 'true' : 'false' },
      badgeNode(charged ? 'info' : 'warn', o.extraVehicle ? 'Extra vehicle requested' : 'Extra vehicle'),
      el('span', null, charged ? ' Vehicle charge added: ' + money(sum(vehicleCharges(o), a => a.amount)) + (big ? ' for ' + big : '') + '.'
        : ' For ' + (big || 'this order') + '. Add its charge before you confirm the price.')) : null;
    const vehicleBtn = !charged && (o.extraVehicle || (o.packages || []).some(p => p.needsVehicle)) ? smallBtn('Add extra vehicle charge', 'alert-vehicle-charge', () => addVehicleCharge(o)) : null;
    // Updates 17/10/2026: no package photo, so a driver is assigned straight away and the price is set from the proof of collection.
    if (o.status === 'requested' && MDM.priceAfterCollection(o)) {
      const sel = assignSelect(o, ctx, 'alert-assign-driver');
      banner('info', 'No package photo: assign a driver', [vehicle, el('span', null, 'Estimate ' + est + '. Price it from the driver\'s collection photo.')],
        [sel, smallBtn('Assign driver', 'alert-assign', () => assign(o, sel.value), 'btn--primary'), vehicleBtn, smallBtn('Confirm price now', 'alert-confirm-price', () => confirmPrice(o))].filter(Boolean), 'drawer-alert-price');
      out[out.length - 1].setAttribute('data-mode', 'assign');
    } else if (o.status === 'requested') {
      // Client 28/10/2026: the office may also assign a driver first (a shopping stop, a photo to check later); the price is then set
      // after collection, like an order without a package photo.
      const photos = (o.packages || []).map(p => thumbButton(ctx.fileById[p.photoId], 'package photo')).filter(Boolean);
      const sel = assignSelect(o, ctx, 'alert-assign-driver');
      banner('warn', 'Confirm the price', [vehicle, el('span', null, 'Estimate ' + est + '. ' + (photos.length ? 'Check the photo and confirm the price' : 'Confirm the price now') + ', or assign a driver and set it after collection.'),
        photos.length ? el('div', { class: 'thumbs' }, photos) : null],
      [vehicleBtn, smallBtn('Confirm price', 'alert-confirm-price', () => confirmPrice(o), 'btn--primary'), sel, smallBtn('Assign driver', 'alert-assign', () => assign(o, sel.value))].filter(Boolean), 'drawer-alert-price');
    }
    if (MDM.priceToFinalise(o)) {
      const proofIds = ((o.route && o.route.stops) || []).filter(s => s.type === 'pickup' && s.proofPhotoId).map(s => s.proofPhotoId);
      const ids = proofIds.concat((o.packages || []).map(p => p.photoId).filter(id => id && proofIds.indexOf(id) < 0));
      const photos = ids.filter((id, i) => ids.indexOf(id) === i).map(id => thumbButton(ctx.fileById[id], 'proof of collection')).filter(Boolean);
      const changed = (o.packages || []).some(p => p.sizeSource === 'driver');
      banner('warn', 'Finalise the price', [el('span', null, 'Estimate ' + est + ', now ' + money(o.totals.total) + (changed ? ' with the driver\'s category' : '') + '. ' +
          (o.status === 'delivered' ? 'The invoice goes out once you confirm.' : 'Confirm it from the collection photo.')),
        photos.length ? el('div', { class: 'thumbs' }, photos) : el('div', { class: 'muted small' }, 'No collection photo.')],
        [smallBtn('Finalise price', 'alert-finalise-price', () => confirmPrice(o), 'btn--primary')], 'drawer-alert-finalise');
    }
    if (F.returnPending(o)) {
      const c = o.cancellation || {}, prev = MDM.STATUS[c.previousStatus];
      banner('danger', 'Cancelled by ' + (ctx.account ? ctx.account.name : 'the business') + ': return pending',
        (prev ? 'It was ' + prev.label.toLowerCase() + '. ' : '') + (F.driverName(o.driverId, ctx.drivers) || 'The driver') + ' brings the package back to ' + ((o.collection || {}).address || 'the business') + '.',
        [smallBtn('Mark returned', 'alert-mark-returned', () => markReturned(o), 'btn--primary')], 'drawer-alert-return');
    }
    if (F.cashDifference(o)) {
      const v = o.cod.variance;
      banner('warn', 'Cash difference: ' + (v < 0 ? 'short by ' : 'over by ') + money(Math.abs(v)),
        'Collected ' + money(o.cod.collectedAmount) + ' of ' + money(o.cod.amount) + '. Settle it before paying the business.',
        MDM.admin.can('cash') ? [el('a', { class: 'btn btn--secondary btn--sm', href: '#/cash', 'data-testid': 'alert-open-cash' }, 'Open Cash & COD')] : null, 'drawer-alert-cash');
    }
    if (o.payment && o.payment.status === 'received') banner('info', 'Payment slip to verify', 'Declared ' + money(o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total) + ' from ' + (bankName(o.payment.bank) || 'a bank') + '. Check the statement first.',
      [smallBtn('Reject', 'alert-reject', () => rejectPayment(o)), smallBtn('Verify payment', 'alert-verify', () => verify(o), 'btn--primary')], 'drawer-alert-payment');
    if (o.status === 'failed') {
      const s = ((o.route && o.route.stops) || []).find(x => x.status === 'failed');
      const r = s && MDM.FAIL_REASONS.find(x => x.value === s.failReason);
      const photo = s && thumbButton(ctx.fileById[s.failPhotoId], 'photo from the attempt');
      banner('danger', (s && s.type === 'pickup' ? 'Collection' : 'Delivery') + ' failed: ' + (r ? r.label.toLowerCase() : 'reason not given'), [s && s.remarks ? el('div', null, 'Driver: ' + s.remarks) : null, photo ? el('div', { class: 'thumbs' }, photo) : null],
        [smallBtn('Decide what happens next', 'alert-resolve', () => resolveFailure(o, ctx), 'btn--primary')], 'drawer-alert-failed');
    }
    if (o.cancellation && o.cancellation.status === 'requested' && open(o)) banner('danger', 'Customer asked to cancel', (o.cancellation.reason || 'No reason given') + ' · ' + timeAgo(o.cancellation.requestedAt),
      [smallBtn('Decline', 'alert-cancel-reject', () => decideCancel(o, false)), smallBtn('Approve cancellation', 'alert-cancel-approve', () => decideCancel(o, true), 'btn--primary')], 'drawer-alert-cancel');
    if (o.priority && o.priority.status === 'requested' && open(o)) {
      const r = (o.priority.requests || []).slice().reverse().find(x => x.decision === 'pending') || {};
      banner('warn', 'Priority requested', [r.reason ? el('div', null, r.reason) : null, r.deadline ? el('div', null, 'Deadline: ' + r.deadline) : null, r.instructions ? el('div', null, 'Instructions: ' + r.instructions) : null],
        [smallBtn('Reject', 'alert-priority-reject', () => decidePriority(o, 'rejected')), smallBtn('Approve', 'alert-priority-approve', () => decidePriority(o, 'approved'), 'btn--primary')], 'drawer-alert-priority');
    }
    return out.length ? el('div', { class: 'drawer__section drawer-alerts', 'data-testid': 'drawer-alerts' }, out) : null;
  }
  function summarySection(o, ctx) {
    const c = o.customer || {};
    const drv = ctx.drivers.find(d => d.id === o.driverId);
    const f = F.flags(o);
    return sec('Order', 'drawer-customer', el('div', { class: 'rate-table' },
      rowNode('Status', el('span', { class: 'row-flags' }, html(MDM.badgeFor(o.status)), f.map(x => badgeNode(x.kind, x.label, { 'data-flag': x.key })))),
      row('Request type', F.typeLabel(o)),
      rowNode('Delivery method', el('span', { 'data-testid': 'drawer-method', 'data-method': methodOf(o) }, MDM.deliveryMethodLabel(methodOf(o)))),
      row('Service level', F.LEVEL[o.serviceLevel] || 'Normal'),
      row('Schedule', F.scheduleText(o)),
      row('Received via', F.SOURCE[o.source] || o.source),
      rowNode('Customer', el('span', null, c.name || '', el('small', { class: 'mono' }, phone.format(c.phone)), contactLinks(c.phone))),
      row('Email', c.email),
      row('Notify by', F.NOTIFY[c.notify] || c.notify),
      // Roles without the Bulk orders or Business pages (office staff) get the matching orders list instead of a page they cannot open.
      o.accountId ? rowNode('Business account', el('a', { href: MDM.admin.can('business') ? '#/business/' + encodeURIComponent(o.accountId) : '#/orders?account=' + encodeURIComponent(o.accountId), 'data-testid': 'drawer-account-link' }, ctx.account ? ctx.account.name : 'View account')) : null,
      ctx.batch ? rowNode('Bulk order', el('a', { href: MDM.admin.can('bulk') ? '#/bulk/' + encodeURIComponent(ctx.batch.id) : '#/orders?batch=' + encodeURIComponent(ctx.batch.id), 'data-testid': 'drawer-batch-link' }, ctx.batch.code + ' · package ' + o.batchIndex + ' of ' + (ctx.batch.orderIds || []).length)) : null,
      drv ? rowNode('Driver', el('span', null, drv.name, el('small', { class: 'mono' }, phone.format(drv.phone)), contactLinks(drv.phone))) : null));
  }
  const DETAIL_LABELS = {
    carrier: 'Carrier', location: 'Pikpost location', postOffice: 'Post office', collectionCode: 'Collection code', collectBefore: 'Collect before', smsNote: 'SMS note',
    courierName: 'Courier', courierAddress: 'Courier office', trackingNo: 'Tracking number', ownerName: 'Owner name', ownerContact: 'Owner contact', shippingAddress: 'Shipping address', idNote: 'ID details',
    mode: 'Airport service', area: 'Airport area', flight: 'Flight', flightTime: 'Flight time', passengerName: 'Passenger', passengerPhone: 'Passenger phone', bags: 'Bags',
    task: 'Task', organisation: 'Office or organisation', reference: 'Reference', details: 'Details', returnDocs: 'Bring documents back',
    shopName: 'Shop or godown', shopAddress: 'Shop or godown address', shopZone: 'Shop or godown area', proof: 'Proof of purchase', orderNo: 'Order or invoice number',
    paidByCustomer: 'Already paid', notes: 'Notes',
  };
  function detailValue(k, v) {
    if (v === true) return 'Yes'; if (v === false) return 'No';
    if (k === 'carrier') return label(MDM.CARRIERS, v);
    if (k === 'location') return label(MDM.PIKPOST_LOCATIONS, v);
    if (k === 'postOffice') return label(MDM.POST_OFFICES, v);
    if (k === 'mode') return label(MDM.AIRPORT_MODES, v);
    if (k === 'area') return label(MDM.geo.airportPoints(), v);
    if (k === 'task') return label(MDM.OFFICE_TASKS, v);
    if (k === 'shopZone') return MDM.geo.zoneLabel(v);
    if (k === 'proof') return { invoice: 'Invoice and payment slip', quotation: 'Quotation and payment slip', order_no: 'Order number' }[v] || v;
    if (k === 'ownerContact' || k === 'passengerPhone') return phone.format(v);
    return String(v);
  }
  function detailsSection(o) {
    const d = o.details || {};
    // Shop & deliver keeps the shop, the item list and the budget as structured details (web app updates §1); everything else is a plain value.
    const SPECIAL = ['shop', 'items', 'budget'];
    const keys = Object.keys(d).filter(k => SPECIAL.indexOf(k) < 0 && d[k] != null && d[k] !== '' && typeof d[k] !== 'object');
    const shop = d.shop && typeof d.shop === 'object' ? d.shop : null;
    const rows = [];
    if (shop) {
      rows.push(row('Shop', shop.name || 'Any shop, chosen on the call'), row('Shop address', [shop.address, shop.zone ? MDM.geo.zoneLabel(shop.zone) : ''].filter(Boolean).join(' · ')));
      if (shop.phone) rows.push(rowNode('Shop phone', el('span', null, el('span', { class: 'mono' }, phone.format(shop.phone)), contactLinks(shop.phone))));
    }
    if (d.budget != null && d.budget !== '') rows.push(row('Budget', money(d.budget), { mono: true }));
    keys.forEach(k => rows.push(row(DETAIL_LABELS[k] || k.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, c => c.toUpperCase()), detailValue(k, d[k]))));
    const shopItems = Array.isArray(d.items) && d.items.length ? el('div', { class: 'stack-2 item-list' }, el('h4', null, 'Items to buy (' + d.items.length + ')'),
      el('div', { class: 'list', 'data-testid': 'drawer-items' }, d.items.map((i, n) => el('div', { class: 'list__item', 'data-testid': 'drawer-item' },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, (n + 1) + '. ' + (i.name || 'Item')),
          i.details ? el('div', { class: 'list__meta' }, i.details) : null,
          i.instructions ? el('div', { class: 'list__meta' }, 'Note: ' + i.instructions) : null),
        el('div', { class: 'list__aside mono' }, '× ' + (i.qty || 1)))))) : null;
    const storeItems = o.items && o.items.length ? el('div', { class: 'list' }, o.items.map(i => el('div', { class: 'list__item' }, el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, i.qty + ' × ' + i.name)), el('div', { class: 'list__aside mono' }, money(i.total))))) : null;
    if (!rows.filter(Boolean).length && !shopItems && !storeItems) return null;
    return sec(F.typeLabel(o) + ' details', 'drawer-details', rows.filter(Boolean).length ? el('div', { class: 'rate-table' }, rows) : null, shopItems, storeItems);
  }
  // Where the package is handed over: a home address, or the jetty / cargo counter / airport point of the delivery method (§3).
  function deliverToBlock(o) {
    const d = o.delivery || {}, m = methodOf(o);
    const recipient = el('div', { class: 'addr__meta' }, person(d.recipientName, d.recipientPhone));
    const note = d.instructions ? el('div', { class: 'addr__note' }, d.instructions) : null;
    if (m === 'home') {
      const meet = d.meetAt && d.zone !== 'airport' ? label(MDM.geo.meetAtOptions(), d.meetAt) : (d.zone === 'airport' ? label(MDM.geo.airportPoints(), d.meetAt) : '');
      return el('div', { class: 'addr' }, el('div', { class: 'addr__label' }, 'Deliver to'), el('div', { class: 'addr__line' }, d.address || ''), el('div', { class: 'addr__meta' }, [MDM.geo.zoneLabel(d.zone), d.landmark, meet ? 'Meet at: ' + meet : ''].filter(Boolean).join(' · ')),
        recipient, note);
    }
    const end = MDM.deliveryEndpoint(d);
    // The endpoint address already names the jetty and vessel, the cargo counter, or the airport point and resort counter.
    const a = d.airport || {};
    const dest = m === 'boat' ? [d.boat && d.boat.island ? 'For ' + d.boat.island : '', d.boat && d.boat.address].filter(Boolean).join(' · ') : m === 'cargo' ? (d.cargo && d.cargo.island ? 'For ' + d.cargo.island : '')
      : [a.resort ? 'For ' + a.resort : '', a.speedboat ? 'speedboat ' + a.speedboat + (a.departureTime ? ' at ' + a.departureTime : '') : ''].filter(Boolean).join(' · ');
    return el('div', { class: 'addr' }, el('div', { class: 'addr__label' }, 'Hand over at · ' + MDM.deliveryMethodLabel(m)), el('div', { class: 'addr__line' }, end.address || d.address || ''),
      dest ? el('div', { class: 'addr__meta' }, dest) : null, recipient, note);
  }
  // Packages counted at a collection (round 4): the extra stop's by package.collectionId, the first collection's are the rest.
  function stopSizes(o, collectionId) {
    const ids = (o.extraCollections || []).map(c => c.id), n = {};
    (o.packages || []).forEach(p => { const at = ids.indexOf(p.collectionId) >= 0 ? p.collectionId : null; if (at === (collectionId || null)) n[p.size] = (n[p.size] || 0) + 1; });
    return ['bag', 'box', 'xl'].filter(k => n[k]).map(k => n[k] + ' × ' + MDM.pricing.sizeLabel(k)).join(', ');
  }
  // Multi collection (updates 17/10/2026): each extra point is collected from or bought at, then everything goes to the one delivery.
  function extraCollectionBlock(o, c, n) {
    const sh = c.shop || {}, shop = c.kind === 'shop', sizes = stopSizes(o, c.id);
    return el('div', { class: 'addr', 'data-testid': 'drawer-extra-collection', 'data-kind': c.kind },
      el('div', { class: 'addr__label' }, 'Collection ' + n + (shop ? ' · buy at a shop' : '')),
      el('div', { class: 'addr__line' }, shop ? [MDM.shopName(sh), c.address].filter(Boolean).join(', ') : c.address || ''),
      sizes ? el('div', { class: 'addr__meta', 'data-testid': 'drawer-stop-sizes' }, 'Packages: ' + sizes) : null,
      el('div', { class: 'addr__meta' }, [MDM.geo.zoneLabel(c.zone), c.landmark].filter(Boolean).join(' · ')),
      shop ? (sh.phone ? el('div', { class: 'addr__meta' }, 'Shop phone ' + phone.format(sh.phone)) : null) : el('div', { class: 'addr__meta' }, person(c.contactName, c.contactPhone)),
      shop && sh.list ? el('div', { class: 'addr__note wrap-anywhere' }, 'To buy: ' + sh.list) : null,
      shop ? el('div', { class: 'addr__meta mono' }, (sh.budget ? 'Items agreed ' + money(sh.budget) : 'Items not agreed yet') + (sh.receiptTotal > 0 ? ' · receipt ' + money(sh.receiptTotal) : '')) : null,
      shop && sh.unavailable ? el('div', { class: 'addr__meta' }, 'If not available: ' + ({ call: 'call the customer', skip: 'skip it', closest: 'buy the closest match' }[sh.unavailable] || sh.unavailable)) : null,
      c.instructions ? el('div', { class: 'addr__note' }, c.instructions) : null);
  }
  function addressesSection(o) {
    const c = o.collection || {};
    const extra = o.extraCollections || [];
    return sec('Collection and delivery', 'drawer-addresses', el('div', { class: 'grid-2 addr-grid' },
      el('div', { class: 'addr', 'data-testid': 'drawer-collection' }, el('div', { class: 'addr__label' }, (extra.length ? 'Collection 1' : 'Collect from') + (c.label ? ' · ' + c.label : '')), el('div', { class: 'addr__line' }, c.address || ''),
        el('div', { class: 'addr__meta' }, [MDM.geo.zoneLabel(c.zone), c.landmark, c.preferredTime ? 'around ' + c.preferredTime : ''].filter(Boolean).join(' · ')),
        el('div', { class: 'addr__meta' }, person(c.contactName, c.contactPhone)), extra.length && stopSizes(o, null) ? el('div', { class: 'addr__meta', 'data-testid': 'drawer-stop-sizes' }, 'Packages: ' + stopSizes(o, null)) : null,
        c.instructions ? el('div', { class: 'addr__note' }, c.instructions) : null),
      extra.map((x, i) => extraCollectionBlock(o, x, i + 2)),
      deliverToBlock(o)),
      extra.length ? el('p', { class: 'muted small', style: { marginTop: '8px' }, 'data-testid': 'drawer-multi-note' }, plural(extra.length + 1, 'collection') + ', delivered together to one address.') : null,
      open(o) ? el('div', { class: 'row', style: { marginTop: '12px' } }, smallBtn('Modify order', 'drawer-modify', () => modifyOrder(o))) : null);
  }
  // ---- Delivery method details (§3.2 boat, §3.3 Maldivian Cargo, §3.4 airport), with the boat change log (§5.3) ----------------
  const BOAT_FIELD = { vesselType: 'Vessel', name: 'Name', departureDate: 'Departure date', departureTime: 'Departure time', jetty: 'Harbour or jetty', island: 'Island', address: 'Destination address', contact: 'Contact' };
  function boatValue(k, v) {
    if (v == null || v === '') return 'empty';
    if (k === 'vesselType') return vesselLabel(v) || v;
    if (k === 'jetty') return jettyLabel(v) || v;
    if (k === 'departureDate') return F.fmtDay(v);
    if (k === 'contact') return phone.format(v);
    return String(v);
  }
  function methodSection(o) {
    const d = o.delivery || {}, m = methodOf(o);
    if (m === 'home') return null;
    const receiver = rowNode('Receiver', el('span', null, d.recipientName || '', d.recipientPhone ? el('small', { class: 'mono' }, phone.format(d.recipientPhone)) : null, contactLinks(d.recipientPhone)));
    const labelsLink = el('a', { class: 'btn btn--ghost btn--sm', href: MDM.href('labels/?order=' + encodeURIComponent(o.id)), target: '_blank', rel: 'noopener', 'data-testid': 'drawer-method-labels' }, html(MDM.icon('printer', 16)), 'Print package labels');
    // A cancelled order keeps its method details for the record; the driver must not hand the package over (§5.5).
    const cancelled = o.status === 'cancelled' ? el('div', { class: 'alert alert--warn', 'data-testid': 'drawer-method-cancelled' }, html(MDM.icon('alert-triangle', 16)),
      el('div', { class: 'alert__body' }, 'Order cancelled: do not hand this package over' + (F.returnPending(o) ? '. It goes back to the business.' : '.'))) : null;
    if (m === 'boat') {
      const b = d.boat || {};
      const history = (b.history || []).slice().reverse();
      const pkgLabel = el('div', { class: 'pkg-label', 'data-testid': 'drawer-boat-label', 'aria-label': 'Package label details' },
        el('div', { class: 'pkg-label__title' }, 'Package label'),
        el('div', null, 'To: ' + [d.recipientName, d.recipientPhone ? phone.format(d.recipientPhone) : ''].filter(Boolean).join(', ')),
        el('div', null, 'Island: ' + (b.island || 'not given')),
        b.address ? el('div', null, 'Address: ' + b.address) : null,
        el('div', null, 'Vessel: ' + [vesselLabel(b.vesselType), b.name].filter(Boolean).join(' ') + (departureText(b) ? ', departs ' + departureText(b) : '')),
        el('div', null, 'Hand over at: ' + (jettyLabel(b.jetty) || 'not given')),
        el('div', null, 'Order: ', el('span', { class: 'mono' }, o.code)));
      const log = history.length ? el('div', { class: 'stack-2' }, el('h4', null, 'Boat changes (' + history.length + ')'),
        el('div', { class: 'list', 'data-testid': 'drawer-boat-history' }, history.map(h => el('div', { class: 'list__item', 'data-testid': 'drawer-boat-change' },
          el('div', { class: 'list__main' },
            el('div', { class: 'list__title' }, label(MDM.BOAT_CHANGE_REASONS, h.reason) || 'Boat details changed'),
            Object.keys(h.to || {}).map(k => el('div', { class: 'list__meta wrap-anywhere' }, (BOAT_FIELD[k] || k) + ': ' + boatValue(k, (h.from || {})[k]) + ' → ' + boatValue(k, h.to[k]))),
            h.note ? el('div', { class: 'list__meta' }, 'Note: ' + h.note) : null,
            el('div', { class: 'list__meta' }, F.byLabel(h.by))),
          el('div', { class: 'list__aside' }, fmtDate(h.at)))))) : null;
      return sec('Boat, ferry or speedboat delivery', 'drawer-delivery-method', el('div', { class: 'stack-4' }, cancelled,
        el('div', { class: 'rate-table', 'data-testid': 'drawer-boat' },
          row('Vessel', [vesselLabel(b.vesselType), b.name].filter(Boolean).join(' · ')),
          row('Departure', departureText(b)),
          row('Harbour or jetty', jettyLabel(b.jetty)),
          row('Destination island', b.island),
          row('Destination address', b.address),
          receiver,
          b.contact && phone.normalize(b.contact) !== phone.normalize(d.recipientPhone) ? rowNode('Contact on the island', el('span', null, el('span', { class: 'mono' }, phone.format(b.contact)), contactLinks(b.contact))) : null,
          row('Instructions', d.instructions)),
        pkgLabel, log,
        el('div', { class: 'row row--wrap' }, open(o) ? smallBtn('Update boat details', 'drawer-update-boat', () => updateBoat(o), 'btn--secondary') : null, labelsLink)));
    }
    if (m === 'cargo') {
      const c = d.cargo || {};
      const fee = (o.fees || {}).cargo || 0;
      return sec('Maldivian Cargo delivery', 'drawer-delivery-method', el('div', { class: 'stack-4' }, cancelled,
        el('div', { class: 'rate-table', 'data-testid': 'drawer-cargo' },
          row('Drop at', c.counter || (MDM.geo.cargoCounter() || {}).label),
          row('Destination island', c.island),
          row('Name on the cargo', c.consignee),
          receiver,
          row('Instructions', d.instructions),
          // The amount is itemised once, in Pricing; here only whether it is charged, so the drawer never shows the fee twice.
          rowNode('Maldivian Cargo fee', el('span', { 'data-testid': 'drawer-cargo-fee', 'data-amount': String(fee) }, fee ? 'Charged once, see Pricing' : 'Not charged on this order'))),
        el('div', { class: 'row row--wrap' }, labelsLink)));
    }
    const a = d.airport || {};
    const fee = (o.fees || {}).airport || 0;
    return sec('Airport delivery', 'drawer-delivery-method', el('div', { class: 'stack-4' }, cancelled,
      el('div', { class: 'rate-table', 'data-testid': 'drawer-airport' },
        row('Collection point', label(MDM.geo.airportPoints(), a.point)),
        row('Resort counter or point', a.counter),
        row('Resort or destination', a.resort),
        row('Resort speedboat', a.speedboat),
        row('Departure', a.departureTime),
        receiver,
        row('Handover instructions', a.instructions),
        row('Delivery instructions', d.instructions),
        rowNode('Airport fee', el('span', { 'data-testid': 'drawer-airport-fee', 'data-amount': String(fee) }, fee ? 'Charged, see Pricing' : 'Not charged on this order'))),
      el('div', { class: 'row row--wrap' }, labelsLink)));
  }
  function packagesSection(o, ctx) {
    const items = (o.packages || []).map((pkg, i) => {
      const lines = [];
      if (o.service === 'shop' && pkg.shop) {
        if (pkg.shop.list) lines.push('List: ' + pkg.shop.list);
        lines.push((pkg.shop.budget ? 'Items agreed ' + money(pkg.shop.budget) : 'Items not agreed yet') + ' · if unavailable: ' + ({ call: 'call the customer', skip: 'skip it', closest: 'buy the closest match' }[pkg.shop.unavailable] || pkg.shop.unavailable) + (pkg.shop.receiptTotal ? ' · receipt ' + money(pkg.shop.receiptTotal) : ''));
      } else if (pkg.dropoff && (o.packages || []).length > 1) lines.push('To ' + person(pkg.dropoff.recipient && pkg.dropoff.recipient.name, pkg.dropoff.recipient && pkg.dropoff.recipient.phone) + ' · ' + (pkg.dropoff.address || ''));
      if (pkg.tier) {
        // The store moves a re-categorised business package to the matching size category at the account's rate (§5.2), so the tier on
        // the package is current. A category the account never agreed falls back to the default rate card; say so.
        const t = MDM.pricing.businessTiers(state.settings).find(x => x.value === pkg.tier);
        const agreed = !!(ctx.account && ctx.account.rates && ctx.account.rates[pkg.tier] != null);
        lines.push('Business size category: ' + (t ? t.label : pkg.tier) + (pkg.tierRate != null ? ' · ' + (!ctx.account ? 'rate ' : agreed ? 'agreed rate ' : 'default rate, not agreed with the business ') + money(pkg.tierRate) : ''));
      }
      const tags = [];
      if (pkg.fragile) tags.push('Fragile'); if (pkg.needsVehicle) tags.push('Needs a vehicle'); if (o.service === 'business' && pkg.underOneFt === false) tags.push('Over 1 ft');
      const photo = thumbButton(ctx.fileById[pkg.photoId], pkg.photoSource === 'driver' ? 'proof of collection' : 'package photo');
      const canChange = (open(o) || correctable(o)) && o.service !== 'store';
      return el('div', { class: 'list__item', 'data-testid': 'drawer-package', 'data-package-id': pkg.id, 'data-size': pkg.size },
        el('div', { class: 'list__main' },
          el('div', { class: 'list__title' }, (i + 1) + '. ' + MDM.pricing.sizeLabel(pkg.size) + (pkg.description ? ' · ' + pkg.description : '')),
          el('div', { class: 'list__meta' }, CATEGORY_SOURCE[pkg.sizeSource] || CATEGORY_SOURCE.estimate),
          lines.map(l => el('div', { class: 'list__meta' }, l)),
          tags.length ? el('div', { class: 'tags' }, tags.map(f => el('span', { class: 'tag' }, f))) : null,
          photo ? el('div', { class: 'thumbs' }, photo) : null),
        el('div', { class: 'list__aside' }, el('span', { class: 'mono' }, money(pkg.price ? pkg.price.lineTotal : 0)),
          canChange ? el('div', { class: 'row' }, rowBtn('Change category', 'drawer-change-category', () => changeCategory(o, pkg.id), 'btn--secondary', { 'data-package-id': pkg.id })) : null));
    });
    return sec('Packages', 'drawer-packages', el('div', { class: 'list' }, items), categoryHistory(o));
  }
  // Category changes (§2.3) with the order total before and after: the store writes a price-history entry for each change ('Package
  // category changed: XL to Box', business packages included since it re-prices them itself); older orders fall back to o.changes.
  function categoryHistory(o) {
    const index = {}; (o.packages || []).forEach((p, i) => { index[p.id] = i + 1; });
    const priced = ((o.pricing || {}).history || []).filter(h => /^Package (category changed|size updated)/.test(h.note || ''));
    const rows = priced.length ? priced.map(h => ({ at: h.at, by: h.by, text: h.note.replace(/^Package category changed: /, 'Category changed: '),
      price: h.from === h.to ? 'Order total unchanged at ' + money(h.to) : 'Order total ' + money(h.from) + ' → ' + money(h.to) }))
      : (o.changes || []).filter(c => /^package .+ size$/.test(c.field)).map(c => {
        const id = c.field.replace(/^package /, '').replace(/ size$/, '');
        return { at: c.at, by: c.by, text: 'Package ' + (index[id] || '') + ': ' + MDM.pricing.sizeLabel(c.from) + ' to ' + MDM.pricing.sizeLabel(c.to), price: '' };
      });
    if (!rows.length) return null;
    return el('details', { class: 'history', open: true, 'data-testid': 'drawer-category-history' }, el('summary', null, 'Category changes (' + rows.length + ')'),
      el('div', { class: 'list' }, rows.slice().reverse().map(r => el('div', { class: 'list__item', 'data-testid': 'drawer-category-change' },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title wrap-anywhere' }, r.text),
          r.price ? el('div', { class: 'list__meta', 'data-testid': 'drawer-category-price' }, r.price) : null, el('div', { class: 'list__meta' }, F.byLabel(r.by))),
        el('div', { class: 'list__aside' }, fmtDate(r.at))))));
  }
  // Photos show as thumbnails; other uploads (a PDF invoice, quotation or payment slip for a shop collection, §1.1) are listed with a
  // download link so the office can still open them.
  function filesSection(o, ctx) {
    const doc = id => (o.documents || []).find(d => d.fileId === id) || {};
    const textOf = f => { const d = doc(f.id); return f.kind === 'document' ? [DOC_KIND[d.kind], d.name || f.name].filter(Boolean).join(': ') : (FILE_KIND[f.kind] || f.name); };
    const images = ctx.files.filter(f => /^image\//.test(f.type || ''));
    const others = ctx.files.filter(f => !/^image\//.test(f.type || '') && f.dataUrl);
    if (!images.length && !others.length) return null;
    return sec('Photos and documents', 'drawer-files',
      images.length ? el('div', { class: 'file-grid' }, images.map(f => {
        const text = textOf(f);
        return el('figure', { class: 'file-grid__item', 'data-kind': f.kind }, thumbButton(f, text), el('figcaption', null, text, el('small', null, fmtDate(f.at || f.createdAt))));
      })) : null,
      others.length ? el('div', { class: 'list file-list', 'data-testid': 'drawer-documents' }, others.map(f => el('div', { class: 'list__item', 'data-testid': 'drawer-document', 'data-kind': f.kind },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title wrap-anywhere' }, textOf(f)), el('div', { class: 'list__meta' }, fmtDate(f.at || f.createdAt))),
        el('div', { class: 'list__aside' }, el('a', { class: 'btn btn--secondary btn--sm', href: f.dataUrl, download: f.name || 'document', 'data-testid': 'drawer-document-download' }, html(MDM.icon('download', 16)), 'Download'))))) : null);
  }
  function routeSection(o, ctx) {
    const stops = (o.route && o.route.stops) || [];
    if (!stops.length) return sec('Route', 'drawer-route', el('p', { class: 'muted small' }, o.status === 'requested' || o.status === 'confirmed' ? 'Stops are built when a driver is assigned.' : 'No route for this order.'));
    const currentId = (stops.find(s => s.status === 'pending' || s.status === 'arrived') || {}).id;
    const items = stops.map((s, i) => {
      const cls = ['stop', s.type === 'pickup' ? 'stop--pickup' : s.type === 'return' ? 'stop--return' : null, s.status === 'done' ? 'is-done' : s.status === 'failed' ? 'is-failed' : (s.id === currentId && open(o) ? 'is-current' : null)];
      const meta = [MDM.geo.zoneLabel(s.zone)];
      if (s.contact && (s.contact.name || s.contact.phone)) meta.push(person(s.contact.name, s.contact.phone));
      if (s.landmark) meta.push(s.landmark);
      if (s.type === 'pickup' && (s.packageIds || []).length) { const n = {}; (o.packages || []).forEach(p => { if (s.packageIds.indexOf(p.id) >= 0) n[p.size] = (n[p.size] || 0) + 1; }); meta.push(['bag', 'box', 'xl'].filter(k => n[k]).map(k => n[k] + ' × ' + MDM.pricing.sizeLabel(k)).join(', ')); }
      else if ((s.packageIds || []).length > 1) meta.push(plural(s.packageIds.length, 'package'));
      if (s.status === 'done' && s.type !== 'pickup') { const h = MDM.HANDED_TO.find(x => x.value === s.handedTo); meta.push('Handed to ' + (s.recipientName || '') + (h && h.value !== 'recipient' ? ' (' + h.label.toLowerCase() + ')' : '') + (s.confirmed ? ', confirmed' : '')); }
      if (s.status === 'done' && s.receiptTotal != null) meta.push('Receipt ' + money(s.receiptTotal));
      if (s.status === 'failed') { const r = MDM.FAIL_REASONS.find(x => x.value === s.failReason); meta.push((r ? r.label : 'Could not complete') + (s.remarks ? ': ' + s.remarks : '')); }
      else if (s.remarks) meta.push('Remark: ' + s.remarks);
      if (s.attempts > 0) meta.push('Attempt ' + (s.attempts + 1));
      const aside = s.status === 'done' ? fmtDate(s.at) : s.status === 'failed' ? 'Failed ' + fmtDate(s.failedAt) : s.status === 'arrived' ? 'Arrived ' + fmtDate(s.arrivedAt) : s.status === 'skipped' ? 'Skipped' : 'Pending';
      const photos = [thumbButton(ctx.fileById[s.proofPhotoId], 'proof of collection'), thumbButton(ctx.fileById[s.photoId], 'proof of delivery'), thumbButton(ctx.fileById[s.receiptPhotoId], 'shop receipt'), thumbButton(ctx.fileById[s.failPhotoId], 'photo from the failed attempt')].filter(Boolean);
      return el('div', { class: cls.filter(Boolean).join(' '), 'data-testid': 'drawer-stop', 'data-stop-id': s.id, 'data-status': s.status },
        el('div', { class: 'stop__marker' }, s.status === 'done' ? html(MDM.icon('check', 14)) : String(i + 1)),
        el('div', null, el('div', { class: 'stop__title' }, s.label + ' · ' + s.address), el('div', { class: 'stop__meta' }, meta.join(' · ')), photos.length ? el('div', { class: 'thumbs' }, photos) : null),
        el('div', { class: 'stop__aside' }, aside));
    });
    return sec('Route', 'drawer-route', el('div', { class: 'stops' }, items));
  }
  function pricingSection(o) {
    const t = o.totals || {}, p = o.pricing || {};
    const confirmed = p.status === 'confirmed';
    const lines = (o.packages || []).map(pkg => el('div', { class: 'summary__line' },
      el('div', { class: 'summary__desc' }, MDM.pricing.lineLabel(pkg, o.service === 'store' ? 'pick' : o.service), pkg.description ? el('span', { class: 'summary__sub' }, pkg.description) : null),
      el('div', { class: 'summary__amount mono' }, money(pkg.price ? pkg.price.lineTotal : 0))));
    if (t.items) lines.push(el('div', { class: 'summary__line' }, el('div', { class: 'summary__desc' }, 'Store items'), el('div', { class: 'summary__amount mono' }, money(t.items))));
    const extraShops = (o.extraCollections || []).filter(c => c.kind === 'shop' && c.shop);
    if ((o.service === 'shop' || extraShops.length) && t.budget) {
      const receipt = (o.packages || []).some(x => x.shop && x.shop.receiptTotal) || extraShops.some(c => c.shop.receiptTotal);
      lines.push(el('div', { class: 'summary__line' }, el('div', { class: 'summary__desc' }, receipt ? 'Receipt total' : 'Items agreed'), el('div', { class: 'summary__amount mono' }, money(t.budget))));
    }
    const adjById = {}; ((o.fees || {}).adjustments || []).forEach(a => { adjById[a.id] = a; });
    MDM.pricing.feeLines(o, state.settings).forEach(f => {
      const a = f.id ? adjById[f.id] : null;
      lines.push(el('div', { class: 'summary__line summary__line--fee', 'data-testid': f.key === 'adjustment' ? 'drawer-adjustment' : null },
        el('div', { class: 'summary__desc' }, f.label, f.reason ? el('span', { class: 'summary__sub' }, f.reason) : null, a ? el('span', { class: 'summary__sub' }, [a.remarks, F.byLabel(a.by) + ', ' + fmtDate(a.at)].filter(Boolean).join(' · ')) : null),
        el('div', { class: 'summary__amount mono' }, money(f.amount))));
    });
    const summary = el('div', { class: 'summary', 'data-testid': 'drawer-summary' }, lines, el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, confirmed ? 'Confirmed total' : 'Estimated total'), el('span', { class: 'mono', 'data-testid': 'drawer-total' }, money(t.total))));
    const est = o.estimate && !confirmed ? el('p', { class: 'muted small' }, 'Customer estimate: ' + money(o.estimate.min) + (o.estimate.max !== o.estimate.min ? ' to ' + money(o.estimate.max) : '') + '. The final price includes any vehicle fee.') : null;
    const reasons = !confirmed && t.quoteRequired && (t.quoteReasons || []).length ? el('div', { class: 'alert alert--warn' }, html(MDM.icon('alert-triangle', 16)),
      el('div', { class: 'alert__body' }, el('div', { class: 'alert__title' }, MDM.priceAfterCollection(o) ? 'Price to set from the proof of collection' : 'Price to confirm before collection'), (t.quoteReasons || []).map(r => el('div', null, MDM.pricing.reasonText(r))))) : null;
    const status = el('div', { class: 'rate-table' }, rowNode('Price', el('span', null, badgeNode(confirmed ? 'ok' : 'warn', confirmed ? 'Confirmed' : 'Estimated', { 'data-testid': 'drawer-price-status', 'data-status': confirmed ? 'confirmed' : 'estimated' }),
      confirmed && p.confirmedAt ? el('small', null, F.byLabel(p.confirmedBy) + ', ' + fmtDate(p.confirmedAt) + (p.remarks ? ' · ' + p.remarks : '')) : null)));
    const hist = (p.history || []).length ? el('details', { class: 'history', 'data-testid': 'drawer-price-history' }, el('summary', null, 'Price changes (' + p.history.length + ')'),
      el('div', { class: 'list' }, p.history.slice().reverse().map(h => el('div', { class: 'list__item' }, el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, money(h.from) + ' → ' + money(h.to)), el('div', { class: 'list__meta' }, [h.note, F.byLabel(h.by), fmtDate(h.at)].filter(Boolean).join(' · ')))))) ) : null;
    // §2.3: the extra vehicle charge can go on any order the office still handles, whatever the customer chose.
    const vehicleBtn = o.status !== 'cancelled' ? smallBtn('Add extra vehicle charge', 'drawer-add-vehicle', () => addVehicleCharge(o)) : null;
    const charged = F.vehicleCharged(o);
    const vehicleNote = o.extraVehicle || charged ? el('p', { class: 'small', 'data-testid': 'drawer-vehicle-note' }, badgeNode(charged ? 'info' : 'warn', o.extraVehicle ? 'Extra vehicle requested' : 'Extra vehicle'), ' ',
      el('span', { class: 'muted' }, charged ? 'Vehicle charge included below.' : 'No vehicle charge added yet.')) : null;
    // A price set after delivery (price after collection) is still finalised here; it releases the invoice. A delivered order that is not
    // paid yet can still be corrected (correctable).
    const actions = open(o) || MDM.priceToFinalise(o) || correctable(o) ? el('div', { class: 'row row--wrap' },
      smallBtn(confirmed ? 'Change confirmed price' : MDM.priceToFinalise(o) ? 'Finalise price' : 'Confirm price', 'drawer-confirm-price', () => confirmPrice(o), confirmed ? 'btn--secondary' : 'btn--primary'),
      vehicleBtn, smallBtn('Add adjustment', 'drawer-add-adjustment', () => addAdjustment(o))) : (vehicleBtn ? el('div', { class: 'row row--wrap' }, vehicleBtn) : null);
    return sec('Pricing', 'drawer-pricing', el('div', { class: 'stack-3' }, status, vehicleNote, summary, est, reasons, hist, actions));
  }
  // ---- Charges on proof of collection / delivery (§6): naalu, packing and other charges, billed to the customer or not ----------
  function chargesSection(o, ctx) {
    const list = o.charges || [];
    const live = list.filter(c => !c.void);
    const billed = sum(live.filter(c => c.billable), c => c.amount);
    const naalu = stage => sum(live.filter(c => c.type === 'naalu' && c.stage === stage), c => c.amount);
    const cargo = sum(live.filter(c => c.type === 'cargo'), c => c.amount);
    // §6.1 reconciliation: what the driver paid out of pocket and the office has not paid back yet (store.reimburseCharges).
    const owed = sum(live.filter(c => c.paidBy === 'driver' && !c.reimbursedAt), c => c.amount);
    const repaid = sum(live.filter(c => c.paidBy === 'driver' && c.reimbursedAt), c => c.amount);
    const totals = list.length ? el('div', { class: 'rate-table', 'data-testid': 'drawer-charges-totals' },
      row('Paid out for this order', money(sum(live, c => c.amount)), { mono: true }),
      naalu('collection') ? row('Naalu at collection', money(naalu('collection')), { mono: true }) : null,
      naalu('delivery') ? row('Naalu at delivery', money(naalu('delivery')), { mono: true }) : null,
      cargo ? row('Maldivian Cargo charges', money(cargo), { mono: true }) : null,
      row('Billed to the customer', money(billed), { mono: true }),
      owed ? rowNode('To pay back to the driver', el('span', { class: 'mono', 'data-testid': 'drawer-charges-owed' }, money(owed))) : null,
      repaid ? row('Paid back to the driver', money(repaid), { mono: true }) : null) : null;
    const items = list.slice().reverse().map(c => {
      const kind = c.void ? badgeNode('neutral', 'Voided', { 'data-testid': 'drawer-charge-state' }) : c.billable ? badgeNode('ok', 'Billed to the customer', { 'data-testid': 'drawer-charge-state' }) : badgeNode('neutral', 'Not billed', { 'data-testid': 'drawer-charge-state' });
      const where = c.stage === 'collection' || c.stage === 'delivery' ? STAGE[c.stage] : STAGE.office;
      return el('div', { class: 'list__item charge' + (c.void ? ' is-void' : ''), 'data-testid': 'drawer-charge', 'data-charge-id': c.id, 'data-type': c.type, 'data-stage': c.stage, 'data-billable': c.billable ? 'true' : 'false', 'data-void': c.void ? 'true' : 'false' },
        el('div', { class: 'list__main' },
          el('div', { class: 'list__title' }, chargeTitle(c) + ' · ' + where.toLowerCase()),
          c.description && c.type !== 'other' ? el('div', { class: 'list__meta wrap-anywhere' }, c.description) : null,
          el('div', { class: 'list__meta' }, 'Paid by ' + (c.paidBy === 'driver' ? 'the driver' : 'the office') + ' · ' + F.byLabel(c.by) + ', ' + fmtDate(c.at)),
          c.paidBy === 'driver' && c.reimbursedAt ? el('div', { class: 'list__meta', 'data-testid': 'drawer-charge-reimbursed' }, 'Paid back to the driver ' + fmtDate(c.reimbursedAt) + ' · ' + F.byLabel(c.reimbursedBy) + (c.reimbursementRef ? ' · ref ' + c.reimbursementRef : '')) : null,
          c.void ? el('div', { class: 'list__meta' }, 'Voided by ' + F.byLabel(c.voidedBy) + ', ' + fmtDate(c.voidedAt) + (c.voidReason ? ': ' + c.voidReason : '')) : null,
          c.photoId && ctx.fileById[c.photoId] ? el('div', { class: 'thumbs' }, thumbButton(ctx.fileById[c.photoId], c.type === 'cargo' ? 'Maldivian Cargo bill' : 'bill or receipt')) : null),
        el('div', { class: 'list__aside' }, el('span', { class: 'mono charge__amount' }, money(c.amount)), el('div', null, kind)),
        c.void ? null : el('div', { class: 'row row--wrap charge__actions' },
          rowBtn(c.billable ? 'Stop billing the customer' : 'Bill to the customer', 'drawer-charge-bill', () => toggleChargeBilling(o, c), 'btn--secondary', { 'data-charge-id': c.id }),
          rowBtn('Void', 'drawer-charge-void', () => voidCharge(o, c), 'btn--ghost', { 'data-charge-id': c.id })));
    });
    return sec('Charges', 'drawer-charges',
      items.length ? el('div', { class: 'stack-3' }, totals, el('div', { class: 'list' }, items)) : el('p', { class: 'muted small' }, 'No naalu, packing, Maldivian Cargo or other charges recorded.'),
      el('div', { class: 'row', style: { marginTop: '12px' } }, smallBtn('Add charge', 'drawer-add-charge', () => addCharge(o))));
  }
  // ---- Cash on delivery (§5.6): the amount the business asked for, what the driver collected, and where the cash is now -----------
  function codSection(o, ctx) {
    const c = o.cod;
    if (!c || !(Number(c.amount) > 0)) return null;
    // collectedBy is the driver who holds the cash ('driver:<id>'), also when the office recorded the proof of delivery for them
    // (then recordedBy is that office user).
    const collector = c.collectedBy ? F.byLabel(c.collectedBy) : '';
    const v = c.variance;
    const diff = typeof v === 'number' ? (v === 0 ? badgeNode('ok', 'Matches', { 'data-testid': 'drawer-cod-variance', 'data-variance': '0' })
      : badgeNode(v < 0 ? 'danger' : 'warn', (v < 0 ? 'Short by ' : 'Over by ') + money(Math.abs(v)), { 'data-testid': 'drawer-cod-variance', 'data-variance': String(v) })) : null;
    return sec('Cash on delivery', 'drawer-cod', el('div', { class: 'rate-table' },
      row('Cash to collect', money(c.amount), { mono: true }),
      rowNode('Cash status', el('span', { 'data-testid': 'drawer-cod-status', 'data-status': c.status }, html(MDM.codBadge(c.status)))),
      c.collectedAmount != null ? rowNode('Collected by the driver', el('span', null, el('span', { class: 'mono' }, money(c.collectedAmount)), c.collectedAt ? el('small', { 'data-testid': 'drawer-cod-collector' }, [collector, fmtDate(c.collectedAt)].filter(Boolean).join(', ')) : null)) : null,
      c.recordedBy ? rowNode('Recorded by', el('span', { 'data-testid': 'drawer-cod-recorded' }, F.byLabel(c.recordedBy), el('small', null, 'Proof of delivery entered by the office'))) : null,
      diff ? rowNode('Difference', diff) : null,
      c.handedAt ? rowNode('Handed to the office', el('span', null, fmtDate(c.handedAt), el('small', null, [F.byLabel(c.handedTo), c.handoverRef].filter(Boolean).join(' · ')))) : null,
      c.remittedAt ? rowNode('Paid to the business', el('span', null, fmtDate(c.remittedAt), el('small', null, [F.byLabel(c.remittedBy), c.remittanceRef ? 'ref ' + c.remittanceRef : ''].filter(Boolean).join(' · ')))) : null,
      c.note ? row('Note', c.note) : null),
    MDM.admin.can('cash') ? el('p', { class: 'small', style: { marginTop: '12px' } }, el('a', { href: '#/cash', 'data-testid': 'drawer-cod-link' }, 'Open Cash & COD to record handovers and payments to businesses')) : null);
  }
  function paymentSection(o, ctx) {
    const p = o.payment || {};
    const st = p.status || 'pending';
    const rows = [rowNode('Status', el('span', null, html(MDM.payBadge(st).replace('<span ', '<span data-testid="drawer-payment-status" ')), p.upfront ? el('small', null, 'Requested before delivery') : null))];
    if (p.method === 'invoice') {
      rows.push(row('Method', 'Weekly business invoice'), row('Amount', money(o.totals.total), { mono: true }));
      return sec('Payment', 'drawer-payment', el('div', { class: 'rate-table' }, rows), o.accountId && MDM.admin.can('business') ? el('p', { class: 'muted small' }, el('a', { href: '#/business/' + encodeURIComponent(o.accountId) }, 'Open the account invoices')) : null);
    }
    rows.push(row('Method', p.method === 'cash' ? 'Cash' : 'Bank transfer'));
    rows.push(row('When', p.upfrontRequired ? 'Before collection (shopping and upfront orders)' : ((state.settings || {}).rules || {}).paymentTiming === 'upfront' ? 'Upfront once the price is confirmed' : 'After delivery, upfront optional'));
    rows.push(row('Invoice', p.invoiceNo, { mono: true }));
    if (p.paidAmount != null) {
      const ok = Math.round(Number(p.paidAmount)) === Math.round(Number(o.totals.total));
      rows.push(rowNode('Amount paid', el('span', null, el('span', { class: 'mono' }, money(p.paidAmount)), ' ', badgeNode(ok ? 'ok' : 'warn', ok ? 'Matches' : 'Differs', { 'data-testid': 'drawer-payment-match' }), el('small', null, 'Order total ' + money(o.totals.total)))));
    } else rows.push(row('Amount due', money(o.totals.total), { mono: true }));
    rows.push(row('Reference', p.reference, { mono: true }), row('Paid from', bankName(p.bank)), row('Account holder', p.payerName));
    if (p.requestedAt) rows.push(row('Requested', fmtDate(p.requestedAt)));
    if (p.submittedAt) rows.push(row('Slip received', fmtDate(p.submittedAt)));
    const slip = p.slip && ctx.fileById[p.slip.fileId];
    if (p.slip) rows.push(rowNode('Transfer slip', slip ? el('span', { class: 'slip' }, thumbButton(slip, 'transfer slip ' + o.code), el('small', null, p.slip.name)) : el('span', null, p.slip.name, el('small', null, 'File missing from this browser'))));
    if (p.verifiedAt && st === 'paid') rows.push(row('Verified', fmtDate(p.verifiedAt) + ' by ' + F.byLabel(p.verifiedBy)));
    if (p.note) rows.push(row('Note', p.note));
    if (p.rejectReason) rows.push(row('Last rejection', p.rejectReason));
    if (p.refund) rows.push(rowNode('Refund', el('span', null, el('span', { class: 'mono' }, money(p.refund.amount)), el('small', null, [bankName(p.refund.toBank), p.refund.toAccount, p.refund.reference, F.byLabel(p.refund.by), fmtDate(p.refund.at)].filter(Boolean).join(' · ')))));
    const s = o.settlement;
    if (o.service === 'shop' && s) rows.push(rowNode('Shopping balance', el('span', null, s.status === 'settled' ? 'Settled' : (s.balance > 0 ? money(s.balance) + ' to refund' : money(-s.balance) + ' to collect'), s.reference ? el('small', null, s.reference) : null)));
    const actions = [];
    if (st === 'pending' && o.status !== 'cancelled') actions.push(smallBtn('Request payment', 'drawer-request-payment', () => requestPayment(o)));
    if (st === 'received') actions.push(smallBtn('Reject slip', 'drawer-reject', () => rejectPayment(o)), smallBtn('Verify payment', 'drawer-verify', () => verify(o), 'btn--primary'));
    if (['pending', 'requested', 'received'].indexOf(st) >= 0 && o.status !== 'cancelled') actions.push(smallBtn('Mark as paid', 'drawer-mark-paid', () => markPaid(o)));
    if (st === 'paid' && !p.refund) actions.push(smallBtn('Record refund', 'drawer-refund', () => recordRefund(o)));
    if (o.service === 'shop' && s && s.status !== 'settled' && s.balance) actions.push(smallBtn('Mark balance settled', 'drawer-settle', () => markSettled(o)));
    actions.push(el('a', { class: 'btn btn--ghost btn--sm', href: MDM.href('invoice/?order=' + encodeURIComponent(o.id)), target: '_blank', rel: 'noopener', 'data-testid': 'drawer-invoice' }, html(MDM.icon('receipt', 16)), 'Customer invoice'));
    return sec('Payment', 'drawer-payment', el('div', { class: 'rate-table' }, rows), el('div', { class: 'row row--wrap', style: { marginTop: '12px' } }, actions));
  }
  function prioritySection(o) {
    const p = o.priority || { level: 'normal', status: 'none', requests: [] };
    const lvl = label(MDM.PRIORITY_LEVELS, p.level) || 'Normal';
    const statusText = { none: 'Normal priority', requested: 'Requested, waiting for a decision', approved: 'Approved: ' + lvl, rejected: 'Request declined' }[p.status] || p.status;
    const reqs = (p.requests || []).slice().reverse().map(r => el('div', { class: 'list__item', 'data-testid': 'drawer-priority-request' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, r.reason || 'Priority request'),
        el('div', { class: 'list__meta' }, [r.deadline ? 'Deadline ' + r.deadline : '', r.instructions, F.byLabel(r.by) + ', ' + fmtDate(r.at)].filter(Boolean).join(' · ')),
        r.decision !== 'pending' ? el('div', { class: 'list__meta' }, ({ approved: 'Approved', rejected: 'Declined', updated: 'Updated' }[r.decision] || r.decision) + ' by ' + F.byLabel(r.decidedBy) + (r.remarks ? ': ' + r.remarks : '')) : null),
      el('div', { class: 'list__aside' }, badgeNode(r.decision === 'pending' ? 'warn' : r.decision === 'rejected' ? 'danger' : 'ok', r.decision === 'pending' ? 'Pending' : r.decision === 'rejected' ? 'Declined' : 'Approved'))));
    const actions = open(o) ? el('div', { class: 'row row--wrap', style: { marginTop: '12px' } },
      p.status === 'requested' ? [smallBtn('Reject', 'drawer-priority-reject', () => decidePriority(o, 'rejected')), smallBtn('Approve', 'drawer-priority-approve', () => decidePriority(o, 'approved'), 'btn--primary')] : smallBtn(p.status === 'approved' ? 'Change priority' : 'Mark as priority', 'drawer-priority-update', () => decidePriority(o, 'updated'))) : null;
    if (p.status === 'none' && !(p.requests || []).length && !open(o)) return null;
    return sec('Priority', 'drawer-priority', el('div', { class: 'rate-table' }, row('Priority', statusText)), reqs.length ? el('div', { class: 'list' }, reqs) : null, actions);
  }
  function cancellationSection(o, ctx) {
    const c = o.cancellation;
    if ((!c || c.status === 'none') && !o.cancelReason) return null;
    // §5.5: a business cancelled one order of a bulk shipment; the other orders carry on.
    if (c && c.byBusiness) {
      const prev = MDM.STATUS[c.previousStatus];
      const ret = c.returnStatus === 'pending' ? el('span', null, badgeNode('warn', 'Return pending', { 'data-testid': 'drawer-return-status', 'data-status': 'pending' }), ' ', rowBtn('Mark returned', 'drawer-mark-returned-inline', () => markReturned(o), 'btn--secondary'))
        : c.returnStatus === 'done' ? el('span', null, badgeNode('ok', 'Returned', { 'data-testid': 'drawer-return-status', 'data-status': 'done' }), el('small', null, F.byLabel(c.returnedBy) + ', ' + fmtDate(c.returnedAt) + (c.returnNote ? ' · ' + c.returnNote : ''))) : null;
      return sec('Cancellation', 'drawer-cancellation', el('div', { class: 'rate-table' },
        rowNode('Cancelled by', el('span', { 'data-testid': 'drawer-cancelled-by' }, (ctx.account ? ctx.account.name : 'The business'), el('small', null, 'Business owner, from the business portal'))),
        c.reason ? row('Reason given', c.reason) : null,
        prev ? row('Status when cancelled', prev.label) : null,
        row('When', fmtDate(c.decidedAt || c.requestedAt)),
        row('Action needed', c.actionRequired === 'return_to_sender' ? 'Bring the package back to the business' : 'None: it was not collected yet'),
        ret ? rowNode('Return', ret) : null),
      ctx.batch ? el('p', { class: 'muted small', style: { marginTop: '8px' } }, 'The other orders in ' + ctx.batch.code + ' are not affected.') : null);
    }
    return sec('Cancellation', 'drawer-cancellation', el('div', { class: 'rate-table' },
      c && c.status !== 'none' ? row('Request', ({ requested: 'Waiting for a decision', approved: 'Approved', rejected: 'Declined' }[c.status] || c.status)) : null,
      c && c.reason ? row('Reason given', c.reason) : null,
      c && c.requestedAt ? row('Asked', F.byLabel(c.requestedBy) + ', ' + fmtDate(c.requestedAt)) : null,
      c && c.decidedAt ? row('Decided', F.byLabel(c.decidedBy) + ', ' + fmtDate(c.decidedAt) + (c.remarks ? ' · ' + c.remarks : '')) : null,
      o.status === 'cancelled' ? row('Cancelled', (o.cancelReason || '') + (o.cancelledBy ? ' · ' + F.byLabel(o.cancelledBy) : '')) : null));
  }
  function historySection(o) {
    const h = (o.statusHistory || []).slice().reverse();
    if (!h.length) return null;
    return sec('Status history', 'drawer-status-history', el('div', { class: 'list' }, h.map(x => el('div', { class: 'list__item', 'data-testid': 'drawer-status-row' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, (x.from ? MDM.STATUS[x.from].label + ' → ' : '') + MDM.STATUS[x.to].label), el('div', { class: 'list__meta' }, F.byLabel(x.by))),
      el('div', { class: 'list__aside' }, fmtDate(x.at))))));
  }
  function changesSection(o) {
    const ch = (o.changes || []).slice().reverse();
    if (!ch.length) return null;
    const index = {}; (o.packages || []).forEach((p, i) => { index[p.id] = i + 1; });
    // Readable names for the machine paths: 'package pkg_x size' → 'Package 1 category', 'package pkg_x size category' → 'Package 1
    // business size category' (tier keys become their labels), 'delivery boat name' → 'Boat: name'.
    const tiers = MDM.pricing.businessTiers(state.settings);
    const name = f => {
      let m = /^package (.+) size$/.exec(f); if (m) return 'Package ' + (index[m[1]] || '') + ' category';
      m = /^package (.+) size category$/.exec(f); if (m) return 'Package ' + (index[m[1]] || '') + ' business size category';
      m = /^delivery boat (.+)$/.exec(f); if (m) return 'Boat: ' + (BOAT_FIELD[m[1]] || m[1]).toLowerCase();
      return f.replace(/\./g, ' ').replace(/^./, c => c.toUpperCase());
    };
    const v = (f, x) => {
      if (x === '' || x == null) return 'empty';
      if (/^package .+ size$/.test(f)) return MDM.pricing.sizeLabel(x);
      if (/^package .+ size category$/.test(f)) return (tiers.find(t => t.value === x) || {}).label || String(x);
      if (/^(collection|delivery)\.zone$/.test(f)) return MDM.geo.zoneLabel(x);
      if (f === 'serviceLevel') return F.LEVEL[x] || String(x);
      const m = /^delivery boat (.+)$/.exec(f); if (m) return boatValue(m[1], x);
      return typeof x === 'object' ? JSON.stringify(x) : String(x);
    };
    return sec('Changes', 'drawer-changes', el('div', { class: 'list' }, ch.map(x => el('div', { class: 'list__item', 'data-testid': 'drawer-change', 'data-field': x.field },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, name(x.field)), el('div', { class: 'list__meta wrap-anywhere' }, v(x.field, x.from) + ' → ' + v(x.field, x.to)), el('div', { class: 'list__meta' }, F.byLabel(x.by))),
      el('div', { class: 'list__aside' }, fmtDate(x.at))))));
  }
  function notificationsSection(ctx) {
    if (!ctx.notifications.length) return null;
    return sec('Notifications sent', 'drawer-notifications', el('div', { class: 'list' }, ctx.notifications.slice().reverse().map(n => el('div', { class: 'list__item', 'data-testid': 'drawer-notification', 'data-audience': n.audience || 'customer' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, n.title), el('div', { class: 'list__meta wrap-anywhere' }, n.message)),
      el('div', { class: 'list__aside' }, el('span', null, n.audience ? [AUDIENCE[n.audience] || n.audience, F.NOTIFY[n.channel]].filter(Boolean).join(' · ') : (F.NOTIFY[n.channel] || n.channel || '')), el('small', null, fmtDate(n.at)))))));
  }
  function notesSection(o) {
    const items = (o.notes || []).slice().reverse().map(n => el('div', { class: 'list__item', 'data-testid': 'drawer-note-item' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title wrap-anywhere' }, n.text), el('div', { class: 'list__meta' }, F.byLabel(n.by) + ' · ' + fmtDate(n.at)))));
    const ta = el('textarea', { class: 'textarea', id: 'drawer-note', rows: 2, placeholder: 'Only the team sees remarks', 'data-testid': 'drawer-note', value: state.drawer.noteDraft[o.id] || '', on: { input: e => { state.drawer.noteDraft[o.id] = e.target.value; } } });
    const btn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'drawer-add-note', on: { click: () => act(async () => {
      const text = trim(ta.value); if (!text) { setError(ta.closest('.field'), 'Type the remark first'); ta.focus(); return; }
      delete state.drawer.noteDraft[o.id]; ta.value = '';
      await MDM.store.addNote(o.id, { text, by: by() }); toast('Remark added', 'ok');
    }) } }, 'Add remark');
    return sec('Operator remarks', 'drawer-notes',
      items.length ? el('div', { class: 'list' }, items) : el('p', { class: 'muted small' }, 'No remarks yet.'),
      el('div', { class: 'field', style: { marginTop: '12px' } }, el('label', { for: 'drawer-note' }, 'Add a remark'), ta),
      el('div', { class: 'row', style: { marginTop: '8px' } }, btn));
  }
  function activitySection(o) {
    const events = (o.events || []).slice().sort((a, b) => (a.at || '') < (b.at || '') ? -1 : 1);
    if (!events.length) return sec('Activity', 'drawer-activity', el('p', { class: 'muted small' }, 'No activity yet.'));
    const items = events.map((e, i) => el('div', { class: 'timeline__item ' + (i === events.length - 1 ? 'is-current' : 'is-done'), 'data-testid': 'drawer-event', 'data-type': e.type, 'data-visibility': e.visibility },
      el('div', { class: 'timeline__label' }, e.label, e.visibility === 'internal' ? el('span', { class: 'timeline__flag' }, 'Internal') : null),
      el('div', { class: 'timeline__time' }, fmtDate(e.at) + ' · ' + F.byLabel(e.by))));
    return sec('Activity', 'drawer-activity', el('div', { class: 'timeline' }, items));
  }

  // ---- Drawer footer: the next step for this status ---------------------------------------------------------------------------
  function btn(text, testid, cls, fn, attrs) { return el('button', Object.assign({ type: 'button', class: 'btn ' + cls, 'data-testid': testid, on: { click: () => act(fn) } }, attrs || {}), text); }
  function footerFor(o, ctx) {
    const st = o.status, items = [];
    const cancelBtn = () => btn('Cancel order', 'drawer-cancel', 'btn--ghost', () => cancelOrder(o));
    const labels = el('a', { class: 'btn btn--ghost', href: MDM.href('labels/?order=' + encodeURIComponent(o.id)), target: '_blank', rel: 'noopener', 'data-testid': 'drawer-labels' }, html(MDM.icon('printer', 16)), 'Labels');
    items.push(labels);
    if (open(o)) items.push(btn('Send update', 'drawer-send-update', 'btn--ghost', () => sendUpdate(o, statusMessage(o))));
    if (st === 'requested' && MDM.priceAfterCollection(o)) {
      const sel = assignSelect(o, ctx, 'drawer-assign-driver');
      items.push(cancelBtn(), btn('Confirm price', 'drawer-confirm', 'btn--secondary', () => confirmPrice(o)), sel, btn('Assign driver', 'drawer-assign', 'btn--primary', () => assign(o, sel.value)));
    } else if (st === 'requested') {
      const sel = assignSelect(o, ctx, 'drawer-assign-driver');
      items.push(cancelBtn(), sel, btn('Assign driver', 'drawer-assign', 'btn--secondary', () => assign(o, sel.value)), btn('Confirm price', 'drawer-confirm', 'btn--primary', () => confirmPrice(o)));
    }
    else if (st === 'confirmed' || (st === 'collected' && o.batchId && !o.driverId)) {
      const sel = assignSelect(o, ctx, 'drawer-assign-driver');
      if (st === 'confirmed') items.push(cancelBtn());
      items.push(sel, btn('Assign driver', 'drawer-assign', 'btn--primary', () => assign(o, sel.value)));
    } else if (st === 'assigned') items.push(btn('Reassign', 'drawer-reassign', 'btn--secondary', () => reassign(o, ctx)), btn('Dispatch', 'drawer-dispatch', 'btn--primary', () => dispatchOrder(o)));
    else if (st === 'dispatched') items.push(btn('Reassign', 'drawer-reassign', 'btn--secondary', () => reassign(o, ctx)), btn('On the way', 'drawer-start', 'btn--primary', () => startRoute(o)));
    else if (st === 'on_the_way') items.push(btn('Report failed', 'drawer-fail', 'btn--ghost', () => reportFailed(o)), btn('Arrived', 'drawer-arrived', 'btn--secondary', () => arrived(o)), btn('Mark collected', 'drawer-collected', 'btn--primary', () => collected(o)));
    else if (st === 'arrived') items.push(btn('Report failed', 'drawer-fail', 'btn--ghost', () => reportFailed(o)), btn('Mark collected', 'drawer-collected', 'btn--primary', () => collected(o)));
    else if (st === 'collected') items.push(o.driverId ? btn('Reassign', 'drawer-reassign', 'btn--secondary', () => reassign(o, ctx)) : null, btn(o.batchId ? 'Dispatch for delivery' : 'Out for delivery', 'drawer-out', 'btn--primary', () => outForDelivery(o)));
    else if (st === 'out_for_delivery') items.push(btn('Report failed', 'drawer-fail', 'btn--ghost', () => reportFailed(o)), btn(nextStop(o, ['return']) ? 'Mark returned' : 'Mark delivered', 'drawer-deliver', 'btn--primary', () => delivered(o)));
    else if (st === 'failed') items.push(btn('Decide what happens next', 'drawer-resolve', 'btn--primary', () => resolveFailure(o, ctx)));
    else if (st === 'cancelled' && F.returnPending(o)) items.push(btn('Mark returned', 'drawer-mark-returned', 'btn--primary', () => markReturned(o)));
    return items.filter(Boolean);
  }
  // driverSelect: drivers covering the order's zone first (zone assignments, requirements §16), then the rest; off-duty marked.
  function driverChoices(o, ctx, current) {
    const zoneKey = ['collected', 'out_for_delivery'].indexOf(o.status) >= 0 || o.batchId ? (o.delivery || {}).zone : (o.collection || {}).zone;
    const z = ctx.zones.find(x => x.key === zoneKey);
    const inZone = d => (z && (z.driverIds || []).indexOf(d.id) >= 0) || (d.zones || []).indexOf(zoneKey) >= 0;
    const sorted = ctx.drivers.slice().sort((a, b) => (inZone(b) - inZone(a)) || ((a.status === 'offline') - (b.status === 'offline')) || a.name.localeCompare(b.name));
    return sorted.map(d => ({ value: d.id, disabled: d.id === current,
      label: d.name + (inZone(d) ? ' · ' + MDM.geo.zoneShort(zoneKey) : '') + (d.status === 'offline' ? ' (offline)' : d.status === 'on_route' ? ' (on route)' : '') + (ctx.onDuty[d.staffId] ? '' : ' · not punched in') }));
  }
  // assignSelect: the driver picker for a first assignment. The banner and the footer can both show one; they keep the same choice.
  function assignSelect(o, ctx, testid) {
    const sel = driverSelect(o, ctx, testid, null, state.drawer.assignChoice[o.id]);
    const peers = ctx.assignSelects = ctx.assignSelects || [];
    peers.push(sel);
    sel.addEventListener('change', () => { state.drawer.assignChoice[o.id] = sel.value; peers.forEach(x => { if (x !== sel) x.value = sel.value; }); });
    return sel;
  }
  function driverSelect(o, ctx, testid, current, chosen) {
    const opts = driverChoices(o, ctx, current);
    const sel = el('select', { class: 'select', 'aria-label': 'Driver', 'data-testid': testid }, opts.map(x => el('option', { value: x.value, disabled: x.disabled }, x.label)));
    const first = opts.find(x => !x.disabled); if (first) sel.value = first.value;
    if (chosen && chosen !== current && opts.some(x => x.value === chosen)) sel.value = chosen;
    return sel;
  }

  // ---- Actions ------------------------------------------------------------------------------------------------------------
  async function act(fn) {
    try { await fn(); }
    catch (e) { toast(e && e.message ? e.message : 'Something went wrong', 'danger'); }
  }
  async function fresh(o) { return (await MDM.store.get('orders', o.id)) || o; }
  // The live service's link carries the order's secret (MDM.remote.trackLink), so the customer opens it on any phone without signing in.
  function trackUrl(o) { return MDM.remote && MDM.remote.trackLink ? MDM.remote.trackLink(o) : MDM.href('track/?order=' + encodeURIComponent(o.id)); }
  function statusMessage(o) { return 'Mr. Delivery Man, order ' + o.code + ': ' + MDM.STATUS[o.status].customer + '. Track it here: ' + trackUrl(o); }
  function openExternal(href) { const a = el('a', { href, target: '_blank', rel: 'noopener', class: 'sr-only' }, 'Open'); document.body.appendChild(a); a.click(); a.remove(); }
  async function sendUpdate(o, text) {
    const c = o.customer || {};
    const links = phone.links(c.phone, text);
    if (!links) { toast('This order has no phone number to message', 'warn'); return; }
    const ch = c.notify === 'viber' ? 'viber' : c.notify === 'sms' ? 'sms' : 'whatsapp';
    if (ch === 'viber') { await MDM.ui.copy(text); toast('Message copied. Paste it into the Viber chat.', 'ok'); }
    openExternal(ch === 'viber' ? links.viber : ch === 'sms' ? links.sms : links.wa);
    await MDM.store.addEvent(o.id, { type: 'update_sent', label: 'Update sent via ' + F.NOTIFY[ch], by: by(), visibility: 'internal' });
  }
  async function storePhoto(file, orderId, kind) {
    if (!file) return null;
    const img = await MDM.ui.imageToJpeg(file, { maxEdge: 1000, quality: 0.8 });
    const r = await MDM.store.insert('files', { kind, orderId, name: file.name || (kind + '.jpg'), type: img.type, size: img.size, dataUrl: img.dataUrl, at: new Date().toISOString() });
    return r.id;
  }
  const upfrontDefault = o => !!(o.payment && o.payment.upfrontRequired) || ((state.settings || {}).rules || {}).paymentTiming === 'upfront';
  // What a correction after delivery does to the bill (correctable): the invoice already sent shows the new total.
  const correctionNote = o => !correctable(o) || o.payment.status === 'pending' ? ''
    : ' Already delivered: the invoice changes to the new total' + (o.payment.status === 'received' ? '; the customer\'s transfer slip of ' + money(o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total) + ' still waits to be checked.' : '.');
  async function confirmPrice(o) {
    o = await fresh(o);
    const presets = MDM.ADJUSTMENT_PRESETS.filter(p => p.value !== 'discount');
    const est = o.estimate ? money(o.estimate.min) + (o.estimate.max !== o.estimate.min ? ' to ' + money(o.estimate.max) : '') : money(o.totals.total);
    // Price after collection (17/10/2026): finalised from the proof of collection; once delivered, confirming it sends the invoice.
    const finalise = MDM.priceToFinalise(o), delivered = o.status === 'delivered';
    const canAsk = o.payment && o.payment.method !== 'invoice' && o.payment.status === 'pending' && !delivered;
    // Shopping (round 4): no budget on the request; the items and their cost are agreed with the customer on a call, entered here per
    // shop, and the shopping fee follows them. The rest of the price is the delivery.
    const shopsOn = MDM.orderShops(o), pct = Number(((state.settings || {}).rates || {}).shoppingPct) || 0;
    const shoppingNow = (o.totals.budget || 0) + ((o.fees || {}).shopping || 0);
    const priceFields = shopsOn.length
      ? shopsOn.map(x => ({ name: 'item_' + x.key, label: 'Items at ' + MDM.shopName(x.shop) + ', MVR', type: 'number', required: true, min: 0, step: 1, value: x.shop.budget || '',
        hint: x.shop.list ? 'To buy: ' + x.shop.list : null, requiredMessage: 'Enter what the items cost, as agreed on the call' }))
        .concat([{ name: 'delivery', label: 'Delivery price, MVR', type: 'number', required: true, value: o.totals.total - shoppingNow, min: 0, step: 1, hint: 'Packages and fees, without the items' + (pct ? ' and the ' + pct + '% shopping fee' : '') }])
      : [{ name: 'total', label: 'Final price (MVR)', type: 'number', required: true, value: o.totals.total, min: 0, step: 1 }];
    const v = await dialog({ title: (finalise ? 'Finalise the price for ' : 'Confirm the price for ') + o.code, okLabel: finalise ? 'Finalise price' : 'Confirm price',
      message: 'Now ' + money(o.totals.total) + ', estimate ' + est + '. ' + (finalise ? 'Set it from the collection photo. ' : '') + (shopsOn.length ? 'Enter the items as agreed with the customer on the call; the ' + pct + '% shopping fee is added to them. ' : '') + 'Include any vehicle fee.' +
        (finalise && delivered && o.payment && o.payment.status === 'pending' ? ' The invoice goes out once you confirm.' : '') + correctionNote(o),
      fields: priceFields.concat([
        { name: 'preset', label: 'Reason for any difference', type: 'select', required: true, options: presets,
          value: (o.packages || []).some(p => p.needsVehicle) && !((o.fees || {}).adjustments || []).some(a => a.preset === 'vehicle') ? 'vehicle' : 'quote' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2, placeholder: 'Checked the photo: 2 boxes, needs the pickup truck' },
        canAsk ? { name: 'requestPayment', label: 'Ask the customer to pay now', type: 'checkbox', value: upfrontDefault(o), hint: 'Otherwise the invoice goes out after delivery' } : null]).filter(Boolean) });
    if (!v) return;
    const itemCosts = shopsOn.length ? shopsOn.reduce((m, x) => { m[x.key] = v['item_' + x.key]; return m; }, {}) : null;
    const upd = await MDM.store.confirmPrice(o.id, { total: shopsOn.length ? null : v.total, delivery: shopsOn.length ? v.delivery : null, itemCosts, preset: v.preset, label: v.preset === 'quote' ? 'Price confirmation' : label(presets, v.preset), remarks: v.remarks, requestPayment: !!v.requestPayment, by: by() });
    toast('Price confirmed: ' + money(upd.totals.total) + (upd.payment.status === 'requested' ? (delivered ? ', invoice sent' : ', payment requested') : ''), 'ok');
  }
  async function addAdjustment(o) {
    const presets = MDM.ADJUSTMENT_PRESETS.filter(p => p.value !== 'quote');
    const v = await dialog({ title: 'Adjust the price of ' + o.code, message: (o.pricing && o.pricing.status === 'confirmed' ? 'The customer sees the new total on the tracking page.' : 'Added to the estimate before the price is confirmed.') + correctionNote(o), okLabel: 'Add adjustment',
      fields: [
        { name: 'preset', label: 'Type', type: 'select', options: presets, value: presets[0].value },
        { name: 'amount', label: 'Amount (MVR)', type: 'number', required: true, step: 1, hint: 'Discounts are negative, for example −20', validate: (val, all) => all.preset === 'discount' ? (val < 0 ? null : 'A discount is a negative amount') : (val > 0 ? null : 'Enter an amount above 0') },
        { name: 'label', label: 'Shown as', type: 'text', placeholder: 'Waiting time at the harbour' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2, required: true, placeholder: 'Why the price changed' }] });
    if (!v) return;
    await MDM.store.addAdjustment(o.id, { preset: v.preset, label: trim(v.label) || undefined, amount: v.amount, remarks: v.remarks, by: by() });
    toast('Adjustment added', 'ok');
  }
  // §2.3: an extra vehicle charge on any order, prefilled from the rate card when it has a vehicle rate.
  async function addVehicleCharge(o) {
    o = await fresh(o);
    if (o.status === 'cancelled') { toast(o.code + ' is cancelled: no vehicle charge', 'warn'); return; }
    const rate = vehicleRate();
    const big = bigPackagesText(o);
    const confirmed = o.pricing && o.pricing.status === 'confirmed';
    const already = vehicleCharges(o);
    const v = await dialog({ title: 'Extra vehicle charge · ' + o.code, okLabel: 'Add vehicle charge',
      message: (o.extraVehicle ? 'The customer asked for an extra vehicle. ' : '') + (already.length ? 'Vehicle charges already on this order: ' + money(sum(already, a => a.amount)) + '. ' : '') +
        'Current total ' + money(o.totals.total) + (big ? ' for ' + big : '') + '. ' +
        (confirmed ? 'The customer sees the new total on the tracking page.' : 'It is part of the price you confirm.') +
        (isPaid(o) ? ' The customer already paid ' + money(o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total) + ': the charge is due on top.' : ''),
      fields: [
        { name: 'amount', label: 'Vehicle charge (MVR)', type: 'number', required: true, min: 1, step: 1, value: rate, hint: rate ? 'Rate card: ' + money(rate) : 'No vehicle rate on the rate card: enter the agreed amount' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2, placeholder: 'Pickup truck for the 2 wardrobe boxes' }] });
    if (!v) return;
    const upd = await MDM.store.addVehicleCharge(o.id, { amount: v.amount, remarks: v.remarks, by: by() });
    toast('Vehicle charge ' + money(v.amount) + ' added · total ' + money(upd.totals.total), 'ok');
  }
  // §2.3: change one package's category (Bag, Box, XL-size package). The store re-prices it and logs the change with the price.
  async function changeCategory(o, pkgId) {
    o = await fresh(o);
    const settings = state.settings || await MDM.store.settings();
    const idx = (o.packages || []).findIndex(p => p.id === pkgId);
    const pkg = o.packages[idx];
    if (!pkg) { toast('This package is no longer on the order', 'warn'); return; }
    if (!open(o) && !correctable(o)) { toast(o.code + (o.status === 'delivered' ? ' is paid or invoiced' : ' is ' + MDM.STATUS[o.status].label.toLowerCase()) + ': the category can no longer change', 'warn'); return; }
    const business = o.service === 'business';   // the store re-tiers every business package whose size changes
    const acc = business && o.accountId ? await MDM.store.get('business_accounts', o.accountId) : null;
    const tiers = business ? MDM.pricing.accountTiers(acc, settings) : [];
    // The line price for each category: business packages move to the account's agreed rate for the matching size category (the store
    // does the same), or the default rate card when the business has no agreed rate for that size.
    const lineFor = size => {
      if (business) {
        const t = tiers.find(x => x.size === size) || MDM.pricing.businessTiers(settings).find(x => x.size === size);
        return t ? { amount: MDM.pricing.businessRate(acc, t.value, settings), note: acc && acc.rates && acc.rates[t.value] == null ? 'default rate' : '' } : null;
      }
      const q = MDM.pricing.quote({ service: o.service === 'store' ? 'pick' : o.service, packages: o.packages.map(p => p.id === pkgId ? Object.assign({}, p, { size }) : p) }, settings);
      return { amount: q.packages[idx].price.lineTotal, note: '' };
    };
    const options = SIZE_OPTIONS.map(s => { const line = lineFor(s.value); return { value: s.value, label: s.label, hint: line ? money(line.amount) + (line.note ? ', ' + line.note : '') : 'No rate' }; });
    const current = pkg.price ? pkg.price.lineTotal : 0;
    const v = await dialog({ title: 'Change category · package ' + (idx + 1), okLabel: 'Change category',
      message: (pkg.description ? pkg.description + '. ' : '') + 'Now ' + MDM.pricing.sizeLabel(pkg.size) + ' at ' + money(current) + '. Choose the category the package really is; ' +
        (business ? 'it moves to the business\'s rate for that size, ' : '') + 'the price and the order total follow and the change is logged with your name.' + correctionNote(o),
      fields: [
        { name: 'size', label: 'Package category', type: 'segmented', required: true, options, value: pkg.size, validate: val => val === pkg.size ? 'Choose a different category' : null },
        { name: 'remarks', label: 'Why it changed', type: 'textarea', rows: 2, placeholder: 'Driver found two boxes taped together, not a bag' }] });
    if (!v) return;
    const before = o.totals.total;
    // For business packages the store also moves the package to the matching size category at the account's agreed rate (§5.2).
    const upd = await MDM.store.updatePackages(o.id, { [pkgId]: { size: v.size } }, by());
    if (v.remarks) await MDM.store.addNote(o.id, { text: 'Package ' + (idx + 1) + ' category ' + MDM.pricing.sizeLabel(pkg.size) + ' to ' + MDM.pricing.sizeLabel(v.size) + ': ' + v.remarks, by: by() });
    toast('Package ' + (idx + 1) + ' is now ' + MDM.pricing.sizeLabel(v.size) + ' · total ' + money(before) + ' to ' + money(upd.totals.total), 'ok');
  }
  // §5.3 note: the boat can change after booking (speedboat changed, missed, delayed); the store keeps the history and tells the driver.
  async function updateBoat(o) {
    o = await fresh(o);
    const b = (o.delivery && o.delivery.boat) || {};
    const jetties = MDM.geo.jetties().map(t => ({ value: t.value, label: t.label }));
    const v = await dialog({ title: 'Update boat details · ' + o.code, okLabel: 'Save boat details',
      message: 'Now ' + ([vesselLabel(b.vesselType), b.name].filter(Boolean).join(' ') || 'no vessel') + (departureText(b) ? ', departs ' + departureText(b) : '') + '. The driver' + (o.accountId ? ', the business' : '') + ' and the tracking page get the new details.',
      fields: [
        { name: 'reason', label: 'What happened', type: 'select', required: true, options: MDM.BOAT_CHANGE_REASONS, value: 'changed' },
        { name: 'vesselType', label: 'Vessel', type: 'segmented', required: true, options: MDM.VESSEL_TYPES, value: b.vesselType || 'speedboat' },
        { name: 'name', label: 'Boat, ferry or speedboat name', type: 'text', required: true, value: b.name || '' },
        { name: 'departureDate', label: 'Departure date', type: 'date', required: true, value: b.departureDate || dayKey(new Date()) },
        { name: 'departureTime', label: 'Departure time', type: 'time', required: true, value: b.departureTime || '' },
        { name: 'jetty', label: 'Harbour or jetty', type: 'select', required: true, options: jetties, value: b.jetty && jetties.some(j => j.value === b.jetty) ? b.jetty : jetties[0].value },
        { name: 'island', label: 'Destination island', type: 'text', required: true, value: b.island || '' },
        { name: 'address', label: 'Destination address', type: 'text', value: b.address || '' },
        { name: 'contact', label: 'Contact on the island', type: 'tel', intl: true, value: b.contact || '' },
        { name: 'note', label: 'Note', type: 'textarea', rows: 2, placeholder: 'Huraa Speed 1 was full, sent on Huraa Speed 2', validate: (val, all) => all.reason === 'other' && !val ? 'Say what happened' : null }] });
    if (!v) return;
    const count = (b.history || []).length;
    const upd = await MDM.store.updateBoat(o.id, { vesselType: v.vesselType, name: v.name, departureDate: v.departureDate, departureTime: v.departureTime, jetty: v.jetty, island: v.island, address: v.address, contact: v.contact ? (phone.normalize(v.contact) || v.contact) : '' },
      { reason: v.reason, note: v.note, by: by() });
    const changed = ((upd.delivery && upd.delivery.boat && upd.delivery.boat.history) || []).length > count;
    toast(changed ? 'Boat details updated' + (upd.driverId ? ', the driver is notified' : '') : 'Nothing changed', 'ok');
  }
  // §6: charges recorded by the office. Packing is normally billed, naalu only when the rules say so; the checkbox follows the type until touched.
  async function addCharge(o) {
    const naaluBilled = !!(((state.settings || {}).rules) || {}).naaluBillable;
    const p = dialog({ title: 'Add a charge · ' + o.code, okLabel: 'Add charge',
      message: 'Money paid out for this order. Billed charges are added to the customer\'s price.',
      fields: [
        { name: 'type', label: 'Charge', type: 'segmented', required: true, options: MDM.CHARGE_TYPES, value: 'naalu' },
        { name: 'stage', label: 'When it was paid', type: 'segmented', required: true, options: STAGE_OPTIONS, value: 'delivery', hint: 'Cargo charges are paid on delivery',
          validate: (val, all) => all.type === 'naalu' && val === 'office' ? 'Naalu is paid at collection or at delivery' : null },
        { name: 'amount', label: 'Amount (MVR)', type: 'number', required: true, min: 1, step: 1 },
        { name: 'description', label: 'Description', type: 'text', placeholder: 'Porter at North Harbour', hint: 'Required for an other charge', validate: (val, all) => all.type === 'other' && !val ? 'Describe the charge' : null },
        { name: 'paidBy', label: 'Paid by', type: 'segmented', required: true, options: PAID_BY, value: 'driver' },
        { name: 'billable', label: 'Bill to the customer', type: 'checkbox', value: naaluBilled, hint: 'Adds the amount to the order price' },
        { name: 'photo', label: 'Bill or receipt photo', type: 'file', accept: 'image/*' }] });
    const v = await withDialog(p, dlg => {
      const box = dlg.querySelector('[data-testid="dialog-billable"]');
      let touched = false;
      box.addEventListener('change', () => { touched = true; });
      const optional = dlg.querySelector('[data-field="description"] .optional');
      dlg.querySelector('[data-testid="dialog-type"]').addEventListener('change', e => {
        if (optional) optional.hidden = e.target.value === 'other';
        if (touched) return;
        box.checked = e.target.value === 'packing' || e.target.value === 'cargo' ? true : e.target.value === 'naalu' ? naaluBilled : false;
      });
    });
    if (!v) return;
    const photoId = await storePhoto(v.photo, o.id, v.type === 'cargo' ? 'cargo_bill' : 'receipt');
    const upd = await MDM.store.addCharge(o.id, { type: v.type, stage: v.stage, amount: v.amount, description: v.description, paidBy: v.paidBy, billable: !!v.billable, photoId, by: by() });
    toast(label(MDM.CHARGE_TYPES, v.type) + ' ' + money(v.amount) + ' recorded' + (v.billable ? ' · total ' + money(upd.totals.total) : ''), 'ok');
  }
  // Both re-read the charge first: a double click or a drawer that is behind another tab acts on what is stored now.
  async function currentCharge(o, c) {
    const cur = ((await fresh(o)).charges || []).find(x => x.id === c.id);
    if (!cur) { toast('This charge is no longer on the order', 'warn'); return null; }
    if (cur.void) { toast(chargeTitle(cur) + ' is already voided', 'warn'); return null; }
    return cur;
  }
  async function toggleChargeBilling(o, c) {
    c = await currentCharge(o, c); if (!c) return;
    const upd = await MDM.store.setChargeBillable(o.id, c.id, !c.billable, by());
    toast(chargeTitle(c) + (c.billable ? ' no longer billed' : ' billed to the customer') + ' · total ' + money(upd.totals.total), 'ok');
  }
  async function voidCharge(o, c) {
    c = await currentCharge(o, c); if (!c) return;
    const v = await dialog({ title: 'Void ' + chargeTitle(c).toLowerCase() + ' ' + money(c.amount), okLabel: 'Void charge', danger: true,
      message: (c.billable ? 'It is also removed from the customer\'s price.' : 'It stays in the list, marked as voided.') +
        (c.paidBy === 'driver' && c.reimbursedAt ? ' The driver was already paid back ' + money(c.amount) + (c.reimbursementRef ? ' (ref ' + c.reimbursementRef + ')' : '') + ': recover it from the driver.' : ''),
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', rows: 2, required: true, placeholder: 'Entered twice' }] });
    if (!v) return;
    const upd = await MDM.store.voidCharge(o.id, c.id, { reason: v.reason, by: by() });
    toast('Charge voided · total ' + money(upd.totals.total), 'warn');
  }
  // §5.5: the package of a cancelled business order is back with the business.
  async function markReturned(o) {
    o = await fresh(o);
    if (!F.returnPending(o)) { toast(o.code + ' is already marked returned', 'warn'); return; }
    const c = o.collection || {};
    const v = await dialog({ title: 'Mark ' + o.code + ' returned', okLabel: 'Mark returned',
      message: 'Confirm the package is back with ' + (c.contactName || 'the business') + (c.address ? ' at ' + c.address : '') + '. Operations and the driver are told.',
      fields: [{ name: 'note', label: 'Note', type: 'text', placeholder: 'Handed to Ahmed at the shop counter' }] });
    if (!v) return;
    await MDM.store.markReturned(o.id, { note: v.note, by: by() });
    toast('Return recorded', 'ok');
  }
  async function requestPayment(o) {
    const delivered = o.status === 'delivered';
    const v = await dialog({ title: 'Request payment for ' + o.code, message: 'The customer gets the invoice ' + money(o.totals.total) + ' and the bank details by ' + (F.NOTIFY[o.customer.notify] || 'SMS') + '.', okLabel: 'Request payment',
      fields: delivered ? [] : [{ name: 'upfront', label: 'This is an upfront payment, before delivery', type: 'checkbox', value: true }] });
    if (!v) return;
    await MDM.store.requestPayment(o.id, { by: by(), upfront: delivered ? false : !!v.upfront });
    toast('Payment requested', 'ok');
  }
  async function verify(o) {
    const v = await dialog({ title: 'Verify payment for ' + o.code, message: 'Declared ' + money(o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total) + ', reference ' + (o.payment.reference || o.code) + '.', okLabel: 'Verify payment',
      fields: [{ name: 'received', label: 'The amount is in our account', type: 'checkbox', value: false, hint: 'Check the bank statement first', validate: val => val ? null : 'Tick this once you have checked the statement' }] });
    if (!v) return;
    await MDM.store.verifyPayment(o.id, { by: by() });
    toast('Payment verified', 'ok');
  }
  async function rejectPayment(o) {
    const v = await dialog({ title: 'Reject this slip', message: 'The customer is told the reason and can upload the slip again.', okLabel: 'Reject slip', danger: true,
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'Amount on the slip does not match the order' }] });
    if (!v) return;
    await MDM.store.rejectPayment(o.id, { reason: v.reason, by: by() });
    toast('Slip rejected, payment requested again', 'warn');
  }
  async function markPaid(o) {
    const v = await dialog({ title: 'Mark ' + o.code + ' as paid', message: 'For a transfer that arrived without a slip, or cash at the office or on delivery.', okLabel: 'Mark as paid',
      fields: [{ name: 'method', label: 'Paid by', type: 'segmented', options: [{ value: 'transfer', label: 'Bank transfer' }, { value: 'cash', label: 'Cash' }], value: 'transfer' },
        { name: 'note', label: 'Note', type: 'textarea', required: true, rows: 2, placeholder: 'Cash collected by the driver, MVR 45' }] });
    if (!v) return;
    await MDM.store.markPaid(o.id, { method: v.method, note: v.note, by: by() });
    toast('Marked as paid', 'ok');
  }
  function refundDialog(o) {
    const p = o.payment || {};
    const banks = ((state.settings || {}).banks || []).map(b => ({ value: b.id, label: b.name })).concat([{ value: 'other', label: 'Other bank' }]);
    return dialog({ title: 'Record refund for ' + o.code, message: 'The customer paid ' + money(p.paidAmount != null ? p.paidAmount : o.totals.total) + '. Record the transfer you sent back.', okLabel: 'Record refund',
      fields: [
        { name: 'amount', label: 'Amount refunded (MVR)', type: 'number', required: true, value: p.paidAmount != null ? p.paidAmount : o.totals.total, min: 1, step: 1 },
        { name: 'toBank', label: 'Sent to bank', type: 'select', options: banks, value: p.bank && banks.some(b => b.value === p.bank) ? p.bank : banks[0].value },
        { name: 'toAccount', label: 'Account number or name', type: 'text', required: true, value: p.payerName || '' },
        { name: 'reference', label: 'Transfer reference', type: 'text' }] });
  }
  async function recordRefund(o) {
    const v = await refundDialog(o);
    if (!v) return;
    await MDM.store.recordRefund(o.id, Object.assign({ by: by() }, v));
    toast('Refund recorded', 'ok');
  }
  async function markSettled(o) {
    const s = o.settlement || {};
    const v = await dialog({ title: 'Mark the shopping balance settled', message: (s.balance > 0 ? 'We refunded ' : 'The customer paid ') + money(Math.abs(s.balance)) + '.', okLabel: 'Mark settled',
      fields: [{ name: 'reference', label: 'Transfer reference', type: 'text' }] });
    if (!v) return;
    await MDM.store.markSettled(o.id, { reference: v.reference, by: by() });
    toast('Settled', 'ok');
  }
  async function cancelOrder(o) {
    const v = await dialog({ title: 'Cancel ' + o.code, message: 'The customer sees the reason on the tracking page and gets a notification.', okLabel: 'Cancel order', cancelLabel: 'Keep order', danger: true,
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'Customer asked to cancel by phone' }] });
    if (!v) return;
    let refund = null;
    if (isPaid(o) && !o.payment.refund) { refund = await refundDialog(o); if (!refund) return; }
    await MDM.store.cancel(o.id, { reason: v.reason, by: by() });
    if (refund) await MDM.store.recordRefund(o.id, Object.assign({ by: by() }, refund));
    toast('Order cancelled' + (refund ? ', refund recorded' : ''), 'warn');
  }
  async function decideCancel(o, approve) {
    const v = await dialog({ title: (approve ? 'Approve' : 'Decline') + ' the cancellation of ' + o.code, message: approve ? 'The order is cancelled and the customer is told.' : 'The order carries on. Tell the customer why.', okLabel: approve ? 'Approve cancellation' : 'Decline', danger: approve,
      fields: [{ name: 'remarks', label: approve ? 'Remarks' : 'Reason', type: 'textarea', rows: 2, required: !approve, placeholder: approve ? 'No charge' : 'The driver has already collected it' }] });
    if (!v) return;
    let refund = null;
    if (approve && isPaid(o) && !o.payment.refund) { refund = await refundDialog(o); if (!refund) return; }
    await MDM.store.decideCancel(o.id, { approve, remarks: v.remarks, by: by() });
    if (refund) await MDM.store.recordRefund(o.id, Object.assign({ by: by() }, refund));
    toast(approve ? 'Cancellation approved' : 'Cancellation declined', approve ? 'warn' : 'ok');
  }
  async function decidePriority(o, decision) {
    const fields = [];
    if (decision !== 'rejected') fields.push({ name: 'level', label: 'Mark as', type: 'segmented', options: MDM.PRIORITY_LEVELS, value: (o.priority && o.priority.level !== 'normal' && o.priority.level) || 'priority' });
    fields.push({ name: 'remarks', label: decision === 'rejected' ? 'Reason' : 'Remarks', type: 'textarea', rows: 2, required: decision === 'rejected', placeholder: decision === 'rejected' ? 'No driver free before the deadline' : 'Nazim takes it first' });
    const title = { approved: 'Approve the priority request', rejected: 'Decline the priority request', updated: 'Set the priority' }[decision];
    const v = await dialog({ title: title + ' · ' + o.code, message: 'Priority orders go to the top of the driver\'s list and show a flag to the whole team.', okLabel: decision === 'rejected' ? 'Decline' : 'Save priority', danger: decision === 'rejected', fields });
    if (!v) return;
    await MDM.store.decidePriority(o.id, { decision, level: v.level, remarks: v.remarks, by: by() });
    toast(decision === 'rejected' ? 'Priority declined' : 'Priority saved', 'ok');
  }
  async function assign(o, driverId) {
    if (!driverId) { toast('Choose a driver first', 'warn'); return; }
    const upd = await MDM.store.assignDriver(o.id, driverId, { by: by() });
    delete state.drawer.assignChoice[o.id];
    toast('Driver assigned: ' + F.driverName(driverId, state.drivers) + ' · ' + plural(upd.route.stops.length, 'stop'), 'ok');
  }
  async function reassign(o, ctx) {
    const options = driverChoices(o, ctx, o.driverId);
    const first = options.find(x => !x.disabled);
    const v = await dialog({ title: 'Reassign ' + o.code, message: 'Currently with ' + (F.driverName(o.driverId, ctx.drivers) || 'nobody') + '. The route stays the same.', okLabel: 'Reassign',
      fields: [{ name: 'driverId', label: 'New driver', type: 'select', options, value: first ? first.value : '' }, { name: 'remarks', label: 'Remarks', type: 'text' }] });
    if (!v || !v.driverId) return;
    await MDM.store.assignDriver(o.id, v.driverId, { by: by() });
    if (v.remarks) await MDM.store.addNote(o.id, { text: 'Reassigned: ' + v.remarks, by: by() });
    toast('Driver changed to ' + F.driverName(v.driverId, ctx.drivers), 'ok');
  }
  async function dispatchOrder(o) { await MDM.store.dispatch(o.id, { by: by() }); toast('Dispatched to ' + F.driverName(o.driverId, state.drivers), 'ok'); }
  async function startRoute(o) { await MDM.store.startRoute(o.id, { by: by() }); toast('Marked on the way', 'ok'); }
  async function outForDelivery(o) {
    if (o.batchId && o.status === 'collected') { await MDM.store.dispatch(o.id, { by: by() }); toast('Out for delivery', 'ok'); return; }
    await MDM.store.outForDelivery(o.id, { by: by() }); toast('Out for delivery', 'ok');
  }
  async function arrived(o) {
    const s = nextStop(o, ['pickup']);
    if (!s) { toast('No collection stop left', 'warn'); return; }
    await MDM.store.setStop(o.id, s.id, { status: 'arrived', by: by() });
    toast('Arrived for collection', 'ok');
  }
  // Naalu paid by the driver at a boat (§6.1), optional on both proofs; the store records it against the stage.
  const naaluFields = (stage, o) => [
    { name: 'naalu', label: 'Naalu paid at ' + stage + ' (MVR)', type: 'number', min: 0, step: 1, hint: methodOf(o) === 'boat' || stage === 'collection' ? 'Paid by the driver when ' + (stage === 'collection' ? 'collecting from' : 'handing it to') + ' a boat' : null },
    { name: 'naaluNote', label: 'Naalu note', type: 'text', placeholder: stage === 'collection' ? 'Porter at the cargo boat' : 'Porter at North Harbour' }];
  // Collected: proof of collection photo, the category of each package (no measurements, §2.2), naalu and remarks (§3 step 4, §13).
  async function collected(o) {
    o = await fresh(o);
    const s = nextStop(o, ['pickup']);
    if (!s) { toast('No collection stop left', 'warn'); return; }
    const pkgs = (o.packages || []).filter(p => (s.packageIds || [s.packageId]).indexOf(p.id) >= 0);
    const fields = [];
    if (s.shop) fields.push({ name: 'receiptTotal', label: 'Receipt total (MVR)', type: 'number', required: true, min: 0, step: 1 }, { name: 'receipt', label: 'Receipt photo', type: 'file', accept: 'image/*' });
    fields.push({ name: 'photo', label: 'Proof of collection photo', type: 'file', accept: 'image/*', hint: MDM.priceAfterCollection(o) ? 'No package photo from the customer: the price is set from this photo' : o.pricing && o.pricing.status !== 'confirmed' ? 'No customer photo yet: this is what the price is confirmed from' : null });
    pkgs.forEach((p, i) => fields.push(
      { name: 'size_' + i, label: 'Package ' + (i + 1) + (p.description ? ', ' + p.description : '') + ': category', type: 'segmented', options: SIZE_OPTIONS, value: p.size }));
    fields.push(...naaluFields('collection', o), { name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2 });
    const v = await dialog({ title: (s.shop ? 'Shopping done at ' : 'Collected from ') + s.address, message: 'Recorded on behalf of ' + (F.driverName(o.driverId, state.drivers) || 'the driver') + '.', okLabel: 'Mark collected', fields });
    if (!v) return;
    const photoId = await storePhoto(v.photo, o.id, 'proof_collection');
    const receiptPhotoId = s.shop ? await storePhoto(v.receipt, o.id, 'receipt') : null;
    const sizes = {};
    pkgs.forEach((p, i) => { if (v['size_' + i] && v['size_' + i] !== p.size) sizes[p.id] = { size: v['size_' + i] }; });
    await MDM.store.setStop(o.id, s.id, { status: 'done', photoId, sizes: Object.keys(sizes).length ? sizes : null, remarks: v.remarks, receiptTotal: v.receiptTotal, receiptPhotoId,
      naalu: v.naalu || null, naaluNote: v.naaluNote, by: by() });
    toast('Collected' + (v.naalu ? ', naalu ' + money(v.naalu) + ' recorded' : ''), 'ok');
  }
  // Delivered: proof of delivery plus the cash collected for cash-on-delivery orders (§5.6), naalu and a packing charge (§6).
  async function delivered(o) {
    o = await fresh(o);
    const s = nextStop(o, ['dropoff', 'return']);
    if (!s) { toast('No delivery stop left', 'warn'); return; }
    const isReturn = s.type === 'return';
    const cod = !isReturn && o.cod && Number(o.cod.amount) > 0 && o.cod.status === 'pending' ? o.cod : null;
    const fields = [
      { name: 'handedTo', label: 'Handed to', type: 'segmented', required: true, options: MDM.HANDED_TO, value: 'recipient' },
      { name: 'recipientName', label: 'Name of the person', type: 'text', hint: 'Not needed when the package was left as instructed', value: s.contact && s.contact.name || '', validate: (val, all) => all.handedTo !== 'left' && !trim(val) ? 'Enter who received it' : null },
      { name: 'confirmed', label: 'Recipient confirmed receipt', type: 'checkbox', value: true },
      { name: 'photo', label: 'Proof of delivery photo', type: 'file', accept: 'image/*' }];
    if (cod) fields.push({ name: 'cashCollected', label: 'Cash collected (MVR)', type: 'number', required: true, min: 0, step: 1, requiredMessage: 'Enter the cash the driver collected, 0 if none',
      hint: 'The business asked for ' + money(cod.amount) + '. Enter what the driver actually collected.' });
    fields.push(...naaluFields('delivery', o));
    if (!isReturn) fields.push({ name: 'packing', label: 'Packing charge (MVR)', type: 'number', min: 0, step: 1, hint: 'Billed to the customer' }, { name: 'packingNote', label: 'Packing note', type: 'text', placeholder: 'Boxed the loose items' });
    // Maldivian Cargo deliveries (17/10/2026): the counter's own bill, paid by the driver, goes on the customer's delivery charges.
    const cargo = !isReturn && s.type === 'dropoff' && methodOf(o) === 'cargo';
    if (cargo) fields.push({ name: 'cargoCharge', label: 'Maldivian Cargo charges (MVR)', type: 'number', min: 0, step: 1, hint: 'From the Maldivian Cargo bill. Added to the customer\'s delivery charges.' },
      { name: 'cargoBill', label: 'Maldivian Cargo bill', type: 'file', accept: 'image/*' },
      { name: 'cargoNote', label: 'Bill note', type: 'text', placeholder: 'Bill MC-204517' });
    fields.push({ name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2 });
    const p = dialog({ title: (isReturn ? 'Returned to ' : 'Delivered at ') + s.address, message: s.label + (s.contact && s.contact.name ? ' · ' + s.contact.name : '') + '. Recorded on behalf of ' + (F.driverName(o.driverId, state.drivers) || 'the driver') + '.', okLabel: isReturn ? 'Mark returned' : 'Mark delivered', fields });
    // The name is required unless the package was left as instructed: only then does the label say optional.
    const v = await withDialog(p, dlg => {
      const opt = dlg.querySelector('[data-field="recipientName"] .optional'), seg = dlg.querySelector('[data-testid="dialog-handedTo"]');
      const sync = () => { const c = seg.querySelector('input:checked'); if (opt) opt.hidden = !c || c.value !== 'left'; };
      seg.addEventListener('change', sync); sync();
    });
    if (!v) return;
    const photoId = await storePhoto(v.photo, o.id, 'proof');
    const cargoCharge = cargo && Number(v.cargoCharge) > 0 ? Math.round(v.cargoCharge) : null;
    const cargoBillPhotoId = cargoCharge ? await storePhoto(v.cargoBill, o.id, 'cargo_bill') : null;
    const upd = await MDM.store.setStop(o.id, s.id, { status: 'done', handedTo: v.handedTo, recipientName: trim(v.recipientName), confirmed: !!v.confirmed, photoId, remarks: v.remarks,
      cashCollected: cod ? v.cashCollected : undefined, naalu: v.naalu || null, naaluNote: v.naaluNote, packing: isReturn ? null : (v.packing || null), packingNote: v.packingNote,
      cargoCharge, cargoNote: cargoCharge ? trim(v.cargoNote) : '', cargoBillPhotoId, by: by() });
    const diff = cod && upd.cod && typeof upd.cod.variance === 'number' && upd.cod.variance !== 0;
    toast((isReturn ? 'Returned to sender' : 'Delivered') + (cod ? ', cash ' + money(v.cashCollected) + (diff ? ' (expected ' + money(cod.amount) + ')' : '') + ' with the driver' : '') + (cargoCharge ? ', Maldivian Cargo charges ' + money(cargoCharge) + ' added' : ''), diff ? 'warn' : 'ok');
  }
  async function reportFailed(o) {
    const stops = openStops(o);
    if (!stops.length) { toast('No open stop on this order', 'warn'); return; }
    const fields = [];
    if (stops.length > 1) fields.push({ name: 'stopId', label: 'Which stop', type: 'select', options: stops.map(s => ({ value: s.id, label: s.label + ' · ' + s.address })), value: stops[0].id });
    fields.push({ name: 'failReason', label: 'Reason', type: 'select', options: MDM.FAIL_REASONS, value: 'customer_unavailable' },
      { name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2, required: true, placeholder: 'Called twice, no answer' },
      { name: 'photo', label: 'Photo', type: 'file', accept: 'image/*' });
    const v = await dialog({ title: 'Report a failed stop · ' + o.code, message: 'The order goes to Failed and waits for a decision.', okLabel: 'Report failed', danger: true, fields });
    if (!v) return;
    const photoId = await storePhoto(v.photo, o.id, 'failed');
    await MDM.store.setStop(o.id, v.stopId || stops[0].id, { status: 'failed', failReason: v.failReason, remarks: v.remarks, photoId, by: by() });
    toast('Marked as failed', 'warn');
  }
  async function resolveFailure(o, ctx) {
    o = await fresh(o);
    const drivers = driverChoices(o, ctx, null);
    const v = await dialog({ title: 'What happens next with ' + o.code + '?', message: 'Your decision and remarks are recorded and the customer is updated.', okLabel: 'Save decision',
      fields: [
        { name: 'action', label: 'Decision', type: 'segmented', options: MDM.FAIL_ACTIONS, value: 'reschedule' },
        { name: 'when', label: 'New date and time (for reschedule)', type: 'datetime-local', validate: (val, all) => all.action === 'reschedule' && !val ? 'Choose when to try again' : null },
        { name: 'driverId', label: 'Driver (for reassign)', type: 'select', options: drivers, value: (drivers.find(x => x.value !== o.driverId) || drivers[0] || {}).value },
        { name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2, required: true, placeholder: 'Customer asked for tomorrow after 4 pm' }] });
    if (!v) return;
    await MDM.store.resolveFailure(o.id, { action: v.action, when: v.when ? v.when.replace('T', ' ') : '', driverId: v.driverId, remarks: v.remarks, by: by() });
    toast({ reschedule: 'Rescheduled', reassign: 'Reassigned', return: 'Return to sender added', contact: 'Logged: contacting the customer', cancel: 'Order cancelled' }[v.action] || 'Saved', 'ok');
  }
  // Modify order (requirements §9): addresses, contacts, instructions, service level and schedule, with a field-by-field history.
  // Boat, cargo and airport orders keep their hand-over point (store.modifyOrder keeps the drop-off on the jetty, counter or airport
  // point); their method details change through "Update boat details" or a new order. Airport hand-overs are a delivery method now, so
  // a home delivery cannot be moved to the airport zone here (older orders already there keep it).
  async function modifyOrder(o) {
    o = await fresh(o);
    const c = o.collection || {}, d = o.delivery || {}, s = o.schedule || {};
    const home = methodOf(o) === 'home';
    const zones = MDM.geo.zoneOptions();
    const v = await dialog({ title: 'Modify ' + o.code, message: 'Changes are recorded with your name.' + (home ? '' : ' The hand-over point comes from the delivery method.'), okLabel: 'Save changes',
      fields: [
        { name: 'cAddress', label: 'Collection address', type: 'text', required: true, value: c.address },
        { name: 'cZone', label: 'Collection zone', type: 'select', required: true, options: zones, value: c.zone },
        { name: 'cLandmark', label: 'Collection landmark', type: 'text', value: c.landmark },
        { name: 'cName', label: 'Collection contact', type: 'text', value: c.contactName },
        { name: 'cPhone', label: 'Collection contact number', type: 'tel', value: c.contactPhone, intl: true },
        { name: 'cNote', label: 'Collection instructions', type: 'textarea', rows: 2, value: c.instructions },
        home ? { name: 'dAddress', label: 'Delivery address', type: 'text', required: true, value: d.address } : null,
        home ? { name: 'dZone', label: 'Delivery zone', type: 'select', required: true, options: zones.filter(z => z.value !== 'airport' || d.zone === 'airport'), value: d.zone } : null,
        home ? { name: 'dLandmark', label: 'Delivery landmark', type: 'text', value: d.landmark } : null,
        { name: 'dName', label: home ? 'Recipient' : 'Receiver', type: 'text', value: d.recipientName },
        { name: 'dPhone', label: home ? 'Recipient number' : 'Receiver number', type: 'tel', value: d.recipientPhone, intl: true },
        { name: 'dNote', label: 'Delivery instructions', type: 'textarea', rows: 2, value: d.instructions },
        { name: 'level', label: 'Service level', type: 'segmented', required: true, options: MDM.SERVICE_LEVELS, value: o.serviceLevel || 'normal' },
        { name: 'collectAt', label: 'Collect at (advance orders)', type: 'datetime-local', value: s.collectDate ? s.collectDate + 'T' + (s.collectTime || '09:00') : '' },
        { name: 'deliverAt', label: 'Deliver by (advance orders)', type: 'datetime-local', value: s.deliverDate ? s.deliverDate + 'T' + (s.deliverTime || '12:00') : '' }].filter(Boolean) });
    if (!v) return;
    const ph = x => phone.normalize(x) || trim(x);
    const delivery = { recipientName: v.dName, recipientPhone: ph(v.dPhone), instructions: v.dNote };
    if (home) Object.assign(delivery, { address: v.dAddress, zone: v.dZone, landmark: v.dLandmark });
    const patch = {
      collection: { address: v.cAddress, zone: v.cZone, landmark: v.cLandmark, contactName: v.cName, contactPhone: ph(v.cPhone), instructions: v.cNote },
      delivery,
      serviceLevel: v.level,
    };
    if (v.level === 'advance' && v.collectAt) {
      const [cd, ct] = v.collectAt.split('T'), [dd, dt] = (v.deliverAt || v.collectAt).split('T');
      patch.schedule = { type: 'advance', collectDate: cd, collectTime: ct, deliverDate: dd, deliverTime: dt };
    } else if (v.level !== 'advance' && s.type === 'advance') patch.schedule = { type: 'asap' };
    const upd = await MDM.store.modifyOrder(o.id, patch, by());
    toast((upd.changes || []).length > (o.changes || []).length ? 'Changes saved' : 'Nothing changed', 'ok');
  }

  // ---- Order drawer ---------------------------------------------------------------------------------------------------------
  async function openOrderDrawer(id) {
    if (state.drawer.kind && state.drawer.kind !== 'order') { state.drawer.silent = true; drawer.close(); state.drawer.silent = false; }
    state.drawer.kind = 'order'; state.drawer.id = id;
    await renderOrderDrawer();
  }
  async function renderOrderDrawer() {
    const id = state.drawer.id;
    const o = await MDM.store.get('orders', id);
    if (!state.alive || state.drawer.kind !== 'order' || state.drawer.id !== id) return;
    if (!o) { toast('No order with this id', 'warn'); closeOrderDrawer(); return; }
    const [drivers, files, account, batch, notifications, zones, attendance, settings] = await Promise.all([MDM.store.list('drivers'), MDM.store.list('files', { where: { orderId: id }, order: 'createdAt' }),
      o.accountId ? MDM.store.get('business_accounts', o.accountId) : null, o.batchId ? MDM.store.get('batches', o.batchId) : null,
      MDM.store.list('notifications', { where: { orderId: id }, order: 'at' }), MDM.store.list('zones'), MDM.store.list('attendance'), MDM.store.settings()]);
    if (!state.alive || state.drawer.id !== id) return;
    state.settings = settings; state.drivers = drivers;
    const onDuty = {}; attendance.filter(a => !a.outAt).forEach(a => { onDuty[a.staffId] = true; });
    const ctx = { drivers, account, batch, notifications, zones, onDuty, files, fileById: {} };
    files.forEach(f => { ctx.fileById[f.id] = f; });
    const footer = footerFor(o, ctx);
    const body = [alertsSection(o, ctx), summarySection(o, ctx), detailsSection(o), addressesSection(o), methodSection(o), packagesSection(o, ctx), filesSection(o, ctx), routeSection(o, ctx),
      pricingSection(o), chargesSection(o, ctx), codSection(o, ctx), paymentSection(o, ctx), prioritySection(o), cancellationSection(o, ctx), historySection(o), changesSection(o), notificationsSection(ctx), notesSection(o), activitySection(o)].filter(Boolean);
    const panel = drawer.el(), bodyEl = drawer.bodyEl();
    const active = document.activeElement;
    const keepId = active && panel.contains(active) ? active.getAttribute('data-testid') : null;
    const keepSel = keepId && active.tagName === 'TEXTAREA' ? [active.selectionStart, active.selectionEnd] : null;
    const top = drawer.isOpen() ? bodyEl.scrollTop : 0;
    drawer.open({ title: o.code, badge: MDM.badgeFor(o.status), body, footer, size: 'lg', onClose: () => onDrawerClosed('order') });
    bodyEl.scrollTop = top;
    if (keepId) { const n = panel.querySelector('[data-testid="' + keepId + '"]'); if (n && !n.disabled) { try { n.focus({ preventScroll: true }); } catch (e) { /* not focusable any more */ } if (keepSel && n.setSelectionRange) n.setSelectionRange(keepSel[0], keepSel[1]); } }
    state.drawer.order = o;
  }
  function onDrawerClosed(kind) {
    if (state.drawer.kind !== kind) return;
    const closedId = state.drawer.id;
    state.drawer.kind = null; state.drawer.id = null; state.drawer.order = null;
    state.drawer.assignChoice = {};
    if (kind === 'new') { destroyNewOrder(); return; }
    if (!state.alive || state.drawer.silent) return;
    const p = MDM.admin.params();
    if (p.view === 'orders' && p.id) history.replaceState(null, '', '#/orders' + (p.query.toString() ? '?' + p.query.toString() : ''));
    const a = document.activeElement;
    if (state.host && !document.querySelector('dialog[open]') && (!a || a === document.body || !state.host.contains(a))) {
      const link = (closedId && state.host.querySelector('a[href="#/orders/' + encodeURIComponent(closedId) + '"]')) || state.host.querySelector('h1[tabindex="-1"]');
      if (link) { try { link.focus({ preventScroll: true }); } catch (e) { /* not focusable */ } }
    }
  }
  function closeOrderDrawer() { if (state.drawer.kind === 'order') drawer.close(); }

  // ---- New order (phone, WhatsApp, Viber and walk-in orders) ------------------------------------------------------------------
  // "New order" first asks who the order is for (updates 20/10/2026). A customer's order is entered on the customer request form in
  // office mode (request/?office=1): the same six steps, fields and rules as a customer order, so the office records exactly what a
  // customer records. A business account's order is booked in the drawer below, which records what the business portal's own
  // booking records: the collection (a saved collection point or a one-off address, contact, preferred time, instructions), the
  // delivery method with its handover details, the packages at the account's size categories, and cash on delivery.
  function chooseNewOrder() {
    if (document.querySelector('dialog[data-testid="neworder-choose"]')) return;
    const choice = (tag, attrs, icon, title, sub) => el(tag, Object.assign({ class: 'list__item list__item--link' }, attrs),
      html(MDM.icon(icon, 20, 'icon--muted')),
      el('span', { class: 'list__main', style: { display: 'grid' } }, el('span', { class: 'list__title' }, title), el('span', { class: 'list__meta' }, sub)),
      html(MDM.icon('chevron-right', 16, 'icon--muted')));
    const forCustomer = choice('a', { href: MDM.href('request/?office=1'), 'data-testid': 'neworder-for-customer' }, 'user', 'For a customer', 'The same form customers use');
    const forBusiness = choice('button', { type: 'button', 'data-testid': 'neworder-for-business', on: { click: () => { dlg.close(); act(openNewOrder); } } }, 'building', 'For a business account', 'Agreed rates, from a collection point');
    const dlg = el('dialog', { class: 'dialog', 'aria-labelledby': 'neworder-choose-title', 'data-testid': 'neworder-choose' },
      el('div', { class: 'dialog__body' },
        el('h2', { class: 'dialog__title', id: 'neworder-choose-title' }, 'New order'),
        el('div', { class: 'card', style: { overflow: 'hidden', marginTop: '16px' } }, el('div', { class: 'list' }, forCustomer, forBusiness)),
        el('div', { class: 'dialog__actions' }, el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'neworder-choose-cancel', on: { click: () => dlg.close() } }, 'Cancel'))));
    // A click on the backdrop (outside the box) cancels, as in every other dialog.
    dlg.addEventListener('click', e => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    forCustomer.focus();
  }

  function segmented(name, options, current, testid, onChange) {
    const fs = el('fieldset', { class: 'segmented', 'data-testid': testid },
      options.map(o => el('label', { class: 'segmented__option', 'data-testid': testid + '-' + o.value }, el('input', { class: 'sr-only', type: 'radio', name, value: o.value, checked: o.value === current }), el('span', null, o.label))));
    fs.addEventListener('change', () => { const c = fs.querySelector('input:checked'); if (c) onChange(c.value); });
    return fs;
  }
  function field(id, text, control, opts) {
    opts = opts || {};
    return el('div', { class: 'field' }, el('label', { for: id }, text, opts.optional ? el('span', { class: 'optional' }, ' (optional)') : null), control, opts.hint ? el('div', { class: 'field__hint' }, opts.hint) : null);
  }
  // A labelled group (segmented choices): the label names the fieldset for screen readers.
  let groupSeq = 0;
  function groupField(text, control) {
    const id = 'no-group-' + (++groupSeq);
    const fs = control.tagName === 'FIELDSET' ? control : control.querySelector('fieldset');
    if (fs) fs.setAttribute('aria-labelledby', id);
    return el('div', { class: 'field' }, el('span', { class: 'field__label', id }, text), control);
  }
  function endpointCoords(end, keyText) {
    if (!end) return end;
    if (end.cargo && end.cargo.terminal && MDM.geo.terminalPoint(end.cargo.terminal)) { const p = MDM.geo.terminalPoint(end.cargo.terminal); return Object.assign({}, end, { lat: p[0], lng: p[1] }); }
    if (end.zone === 'airport' && end.meetAt && MDM.geo.airportPoint(end.meetAt)) { const p = MDM.geo.airportPoint(end.meetAt); return Object.assign({}, end, { lat: p[0], lng: p[1] }); }
    const p = MDM.geo.geocodeZone(end.zone === 'other' ? 'male' : end.zone || 'male', keyText || end.address || '');
    return Object.assign({}, end, { lat: p.lat, lng: p.lng });
  }
  function destroyNewOrder() {
    const n = state.neworder;
    if (n && n.editor) { try { n.editor.destroy(); } catch (e) { /* already gone */ } }
    state.neworder = null;
  }
  // The business order drawer.
  async function openNewOrder() {
    if (!MDM.packageEditor || typeof MDM.packageEditor.create !== 'function') { toast('The package form is not loaded on this page', 'danger'); return; }
    if (state.drawer.kind) { state.drawer.silent = true; drawer.close(); state.drawer.silent = false; }
    const [accounts, settings] = await Promise.all([MDM.store.list('business_accounts', { where: { status: 'approved' } }), MDM.store.settings()]);
    state.settings = settings;
    const n = state.neworder = { source: 'phone', level: 'normal', service: 'business', accountId: accounts.length ? accounts[0].id : '', packages: [], editor: null, editing: null,
      schedule: { date: dayKey(new Date(Date.now() + 86400000)), time: '10:00' }, method: 'home', extraVehicle: false, tiers: {} };
    state.drawer.kind = 'new'; state.drawer.id = null;
    const uid = 'no';
    const account = () => accounts.find(x => x.id === n.accountId) || null;
    const input = (key, attrs) => el('input', Object.assign({ class: 'input', id: uid + '-' + key, type: 'text', autocomplete: 'off', 'data-testid': 'neworder-' + key }, attrs || {}));
    const clearOnInput = (ctrl, wrap) => { ctrl.addEventListener('input', () => setError(wrap, null)); ctrl.addEventListener('change', () => setError(wrap, null)); return wrap; };
    const zoneOptions = () => MDM.geo.zoneOptions().filter(z => z.value !== 'airport');

    // Account: the agreed size categories (§1.3, §5.2) and how the order came in.
    const accountSel = el('select', { class: 'select', id: uid + '-account', 'data-testid': 'neworder-account' }, accounts.map(a => el('option', { value: a.id }, a.name)));
    const tiersHint = el('div', { class: 'field__hint', 'data-testid': 'neworder-account-tiers' });
    const accountTiers = () => MDM.pricing.accountTiers(account(), settings);
    function syncTiers() {
      const t = accountTiers();
      tiersHint.textContent = t.length ? t.map(x => x.label + ' ' + money(x.rate)).join(' · ') : 'No agreed rates yet';
    }
    const accountField = field(accountSel.id, 'Business account', accountSel);
    accountField.appendChild(tiersHint);
    const sourceSeg = segmented(uid + '-source', SOURCES, n.source, 'neworder-source', v => { n.source = v; });
    const accountBlock = el('div', { class: 'stack-4', 'data-testid': 'neworder-business' },
      accounts.length ? accountField : el('div', { class: 'alert alert--info' }, html(MDM.icon('info', 16)), el('div', { class: 'alert__body' }, 'No approved business accounts yet.')),
      groupField('Order received by', sourceSeg));

    // Collection (as the business portal books it): a saved collection point, preselected when it is the default, or a one-off
    // address with its contact; the preferred time and instructions for the driver.
    const pointSel = el('select', { class: 'select', id: uid + '-collection-point', 'data-testid': 'neworder-collection-point' });
    const pointSummary = el('div', { class: 'field__hint', 'data-testid': 'neworder-collection-summary' });
    const cAddress = input('collection-address', { placeholder: 'House or building, floor, road', autocomplete: 'off' });
    const cZone = el('select', { class: 'select', id: uid + '-collection-zone', 'data-testid': 'neworder-collection-zone' }, zoneOptions().map(z => el('option', { value: z.value }, z.label)));
    const cLandmark = input('collection-landmark', { placeholder: 'Near the stadium' });
    const cName = input('collection-contact-name');
    const cPhone = input('collection-contact-phone', { type: 'tel', inputmode: 'numeric', placeholder: '3XX XXXX or 7XX XXXX' });
    const cTime = input('collection-time', { type: 'time' });
    const cNote = input('collection-instructions', { placeholder: 'Ask for the dispatch shelf' });
    const cFields = {
      address: clearOnInput(cAddress, field(cAddress.id, 'Collection address', cAddress)),
      phone: clearOnInput(cPhone, field(cPhone.id, 'Contact number', cPhone)),
    };
    const onceBlock = el('div', { class: 'stack-4', 'data-testid': 'neworder-collection-once' },
      el('div', { class: 'grid-2' }, cFields.address, field(cZone.id, 'Area', cZone)),
      field(cLandmark.id, 'Landmark', cLandmark, { optional: true }),
      el('div', { class: 'grid-2' }, field(cName.id, 'Contact person', cName), cFields.phone));
    const pointField = field(pointSel.id, 'Collect from', pointSel);
    pointField.appendChild(pointSummary);
    const point = () => ((account() || {}).collectionPoints || []).find(p => p.id === pointSel.value) || null;
    // Fill the one-off fields and the point list from the chosen account (a business without points types the address).
    function syncPoints() {
      const a = account(), pts = (a && a.collectionPoints) || [];
      const def = pts.find(p => p.isDefault) || pts[0] || null;
      pointSel.replaceChildren(...pts.map(p => el('option', { value: p.id }, p.label + ' · ' + p.address)), el('option', { value: 'once' }, 'Another address (this order only)'));
      pointSel.value = def ? def.id : 'once';
      cAddress.value = !pts.length && a && a.pickupAddress ? a.pickupAddress : '';
      cZone.value = a && a.zone && zoneOptions().some(z => z.value === a.zone) ? a.zone : 'male';
      cLandmark.value = '';
      cName.value = (a && a.contactName) || ''; cPhone.value = (a && a.phone) || '';
      syncPoint(true);
    }
    function syncPoint(setTime) {
      const p = point(), a = account() || {};
      onceBlock.hidden = !!p; pointSummary.hidden = !p;
      if (p) pointSummary.textContent = [p.address, MDM.geo.zoneLabel(p.zone), p.landmark, [p.contactName || a.contactName, phone.format(p.contactPhone || a.phone)].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
      if (setTime) cTime.value = p ? (p.preferredTime || '') : '';
      setError(cFields.address, null); setError(cFields.phone, null);
    }
    pointSel.addEventListener('change', () => { syncPoint(true); renderPackages(); });
    cZone.addEventListener('change', () => renderPackages());
    // collectionFor() → order.collection, recorded as the business portal records it.
    function collectionFor() {
      const p = point(), a = account() || {}, extra = { instructions: trim(cNote.value), preferredTime: cTime.value || '' };
      if (p) return Object.assign({ pointId: p.id, label: p.label, address: p.address, zone: p.zone || 'male', landmark: p.landmark || '', contactName: p.contactName || a.contactName || '', contactPhone: p.contactPhone || a.phone || '' }, extra);
      return Object.assign({ pointId: null, label: '', address: trim(cAddress.value), zone: cZone.value || 'male', landmark: trim(cLandmark.value), contactName: trim(cName.value), contactPhone: phone.normalize(cPhone.value) || trim(cPhone.value) }, extra);
    }
    // The pickup end every package carries: the collection above.
    function pickupEnd() {
      const c = collectionFor();
      return { address: c.address, zone: c.zone, landmark: c.landmark, contact: { name: c.contactName, phone: c.contactPhone }, instructions: c.instructions };
    }
    function checkCollection() {
      if (point()) return true;
      let ok = true;
      if (!trim(cAddress.value)) { setError(cFields.address, 'Enter the collection address'); ok = false; }
      if (!phone.valid(cPhone.value, { landline: true, intl: true })) { setError(cFields.phone, 'Enter a valid contact number'); ok = false; }
      return ok;
    }
    // Timing: normal, express or an advance collection date and time.
    const dateIn = el('input', { class: 'input', id: uid + '-date', type: 'date', value: n.schedule.date, min: dayKey(new Date()), 'data-testid': 'neworder-date' });
    const timeIn = el('input', { class: 'input', id: uid + '-time', type: 'time', value: n.schedule.time, 'data-testid': 'neworder-time' });
    const dateField = clearOnInput(dateIn, field(dateIn.id, 'Collection date', dateIn));
    const advBlock = el('div', { class: 'grid-2', hidden: true }, dateField, field(timeIn.id, 'Collection time', timeIn));
    const levelSeg = segmented(uid + '-level', MDM.SERVICE_LEVELS, 'normal', 'neworder-level', v => { n.level = v; advBlock.hidden = v !== 'advance'; });
    const collectionBlock = el('div', { class: 'stack-4', 'data-testid': 'neworder-collection' },
      pointField, onceBlock,
      el('div', { class: 'grid-2' }, field(cTime.id, 'Preferred collection time', cTime, { optional: true }), field(cNote.id, 'Collection instructions', cNote, { optional: true })),
      groupField('When', levelSeg), advBlock);

    // Delivery method (§3): home delivery uses each package's drop-off; boat, Maldivian Cargo and airport have their own details.
    const rName = input('recipient-name', { autocomplete: 'off' });
    const rPhone = input('recipient-phone', { type: 'tel', inputmode: 'numeric', placeholder: '7XX XXXX' });
    const dNote = el('textarea', { class: 'textarea', id: uid + '-delivery-instructions', rows: 2, 'data-testid': 'neworder-delivery-instructions', placeholder: 'Call the receiver when the boat leaves' });
    const rNameField = clearOnInput(rName, field(rName.id, "Receiver's name", rName));
    const rPhoneField = clearOnInput(rPhone, field(rPhone.id, "Receiver's contact number", rPhone, { hint: 'Overseas numbers start with +' }));
    const receiverBlock = el('div', { class: 'stack-4', hidden: true, 'data-testid': 'neworder-receiver' },
      el('div', { class: 'grid-2' }, rNameField, rPhoneField), field(dNote.id, 'Delivery instructions', dNote, { optional: true }));
    const homeNote = el('p', { class: 'muted small', 'data-testid': 'neworder-method-home' }, 'Each package has its own drop-off and receiver.');
    // Boat, ferry or speedboat (§3.2)
    let vessel = 'speedboat';
    const vesselSeg = segmented(uid + '-vessel', MDM.VESSEL_TYPES, vessel, 'neworder-vessel', v => { vessel = v; renderPackages(); });
    const boatName = input('boat-name', { placeholder: 'Thulusdhoo Express' });
    const boatDate = input('boat-date', { type: 'date', value: dayKey(new Date()) });
    const boatTime = input('boat-time', { type: 'time' });
    const jettySel = el('select', { class: 'select', id: uid + '-boat-jetty', 'data-testid': 'neworder-boat-jetty' }, MDM.geo.jetties().map(t => el('option', { value: t.value }, t.label)));
    const boatIsland = input('boat-island', { placeholder: 'Thulusdhoo, Kaafu Atoll' });
    const boatAddress = input('boat-address', { placeholder: 'Ma. Fehi Villa' });
    const boatContact = input('boat-contact', { type: 'tel', inputmode: 'numeric', placeholder: '7XX XXXX' });
    const boatFields = {
      name: clearOnInput(boatName, field(boatName.id, 'Boat, ferry or speedboat name', boatName)),
      time: clearOnInput(boatTime, field(boatTime.id, 'Departure time', boatTime)),
      island: clearOnInput(boatIsland, field(boatIsland.id, 'Destination island', boatIsland)),
      contact: clearOnInput(boatContact, field(boatContact.id, 'Contact on the island', boatContact, { optional: true, hint: 'If not the receiver' })),
    };
    const boatBlock = el('div', { class: 'stack-4', hidden: true, 'data-testid': 'neworder-boat' },
      groupField('Vessel', vesselSeg),
      el('div', { class: 'grid-2' }, boatFields.name, field(jettySel.id, 'Harbour or jetty', jettySel)),
      el('div', { class: 'grid-2' }, field(boatDate.id, 'Departure date', boatDate), boatFields.time),
      el('div', { class: 'grid-2' }, boatFields.island, field(boatAddress.id, 'Destination address', boatAddress, { optional: true })),
      boatFields.contact);
    [jettySel, boatName, boatTime, boatIsland].forEach(c => c.addEventListener('change', () => renderPackages()));
    // Maldivian Cargo (§3.3)
    const counter = MDM.geo.cargoCounter() || { label: 'Maldivian Cargo counter, main bus terminal' };
    const cargoIsland = input('cargo-island', { placeholder: 'Kulhudhuffushi, Haa Dhaalu' });
    const cargoConsignee = input('cargo-consignee', { placeholder: 'Name written on the cargo' });
    const cargoIslandField = clearOnInput(cargoIsland, field(cargoIsland.id, 'Destination island', cargoIsland));
    const cargoBlock = el('div', { class: 'stack-4', hidden: true, 'data-testid': 'neworder-cargo' },
      el('p', { class: 'muted small' }, 'To the ' + counter.label + '. Fee ' + money((settings.rates || {}).cargo || 0) + '.'),
      el('div', { class: 'grid-2' }, cargoIslandField, field(cargoConsignee.id, 'Name on the cargo', cargoConsignee, { optional: true, hint: 'Defaults to the receiver' })));
    // Airport (§3.4)
    const airportSel = el('select', { class: 'select', id: uid + '-airport-point', 'data-testid': 'neworder-airport-point' }, MDM.geo.airportPoints().map(p => el('option', { value: p.value }, p.label)));
    airportSel.value = 'resort_counters';
    const aCounter = input('airport-counter', { placeholder: 'Lagoon Point Resort counter' });
    const aResort = input('airport-resort', { placeholder: 'Lagoon Point Resort, Baa Atoll' });
    const aBoat = input('airport-speedboat', { placeholder: 'Lagoon Express 3' });
    const aTime = input('airport-time', { type: 'time' });
    const aNote = el('textarea', { class: 'textarea', id: uid + '-airport-instructions', rows: 2, 'data-testid': 'neworder-airport-instructions', placeholder: 'Hand to the resort host' });
    const airportFields = {
      counter: clearOnInput(aCounter, field(aCounter.id, 'Resort counter or collection point', aCounter)),
      resort: clearOnInput(aResort, field(aResort.id, 'Resort or destination', aResort)),
    };
    const airportBlock = el('div', { class: 'stack-4', hidden: true, 'data-testid': 'neworder-airport' },
      el('div', { class: 'grid-2' }, field(airportSel.id, 'Meeting point at the airport', airportSel), airportFields.counter),
      airportFields.resort,
      el('div', { class: 'grid-2' }, field(aBoat.id, 'Resort speedboat', aBoat, { optional: true }), field(aTime.id, 'Departure time', aTime, { optional: true })),
      field(aNote.id, 'Handover instructions', aNote, { optional: true }));
    airportSel.addEventListener('change', () => renderPackages());
    const methodSeg = segmented(uid + '-method', METHODS, n.method, 'neworder-method', v => { n.method = v; syncMethod(); });
    const methodHint = el('div', { class: 'field__hint', 'data-testid': 'neworder-method-hint' });
    function syncMethod() {
      const m = n.method;
      methodHint.textContent = (MDM.DELIVERY_METHODS.find(x => x.value === m) || {}).hint || '';
      homeNote.hidden = m !== 'home'; receiverBlock.hidden = m === 'home';
      boatBlock.hidden = m !== 'boat'; cargoBlock.hidden = m !== 'cargo'; airportBlock.hidden = m !== 'airport';
      syncEditor();
      renderPackages();
    }
    // The delivery object for createOrder; for previews (pricing, list lines) the receiver can still be empty.
    function deliveryFor(first) {
      const m = n.method;
      if (m === 'home') {
        const d = (first && first.dropoff) || {}, r = d.recipient || {};
        return { method: 'home', address: d.address || '', zone: d.zone || 'male', landmark: d.landmark || '', recipientName: r.name || '', recipientPhone: r.phone || '',
          instructions: (first && first.notes) || '', meetAt: d.meetAt || 'door' };
      }
      const out = { method: m, recipientName: trim(rName.value), recipientPhone: phone.normalize(rPhone.value) || trim(rPhone.value), instructions: trim(dNote.value), landmark: '', meetAt: '' };
      if (m === 'boat') {
        out.boat = { vesselType: vessel, name: trim(boatName.value), departureDate: boatDate.value, departureTime: boatTime.value, jetty: jettySel.value, island: trim(boatIsland.value), address: trim(boatAddress.value),
          contact: phone.normalize(boatContact.value) || trim(boatContact.value), history: [] };
        out.address = out.boat.address || out.boat.island;
      } else if (m === 'cargo') {
        out.cargo = { counter: counter.label, island: trim(cargoIsland.value), consignee: trim(cargoConsignee.value) || out.recipientName };
        out.address = out.cargo.island;
      } else {
        out.airport = { point: airportSel.value, counter: trim(aCounter.value), resort: trim(aResort.value), speedboat: trim(aBoat.value), departureTime: aTime.value, instructions: trim(aNote.value) };
      }
      return out;
    }

    // Packages (shared package editor). The collection above is every package's pickup, so the editor's pickup part is hidden; for
    // boat, cargo and airport deliveries its drop-off part is hidden too: the method sets the hand-over point.
    const list = el('div', { class: 'list', 'data-testid': 'neworder-packages' });
    const editorSlot = el('div', { class: 'neworder-editor' });
    const pkgError = el('div', { class: 'field__error', 'data-testid': 'neworder-packages-error', hidden: true });
    const addBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'neworder-add-package', on: { click: () => openEditor(null) } }, html(MDM.icon('plus', 16)), 'Add a package');
    const evInput = el('input', { type: 'checkbox', id: uid + '-extra-vehicle', 'data-testid': 'neworder-extra-vehicle' });
    const evBlock = el('label', { class: 'checkbox', for: evInput.id, hidden: true, 'data-testid': 'neworder-extra-vehicle-field' }, evInput,
      el('span', null, 'Extra vehicle', el('span', { class: 'hint' }, 'Charge added when the price is confirmed')));
    evInput.addEventListener('change', () => { n.extraVehicle = evInput.checked; renderPackages(); });
    const codIn = input('cod', { type: 'number', min: 0, step: 1, inputmode: 'numeric', placeholder: '0' });
    const codField = clearOnInput(codIn, field(codIn.id, 'Cash to collect (MVR)', codIn, { optional: true, hint: 'Leave empty if already paid' }));
    const refIn = input('reference', { placeholder: 'Invoice or order number' });
    const estimate = el('div', { 'data-testid': 'neworder-estimate' });
    function me() { const a = account(); return a ? { name: a.contactName, phone: a.phone } : null; }
    function cancelEditor() { if (n.editor) { n.editor.destroy(); n.editor = null; } n.editing = null; editorSlot.replaceChildren(); addBtn.hidden = false; }
    function syncEditor() {
      if (!n.editor) return;
      const root = n.editor.el, hide = n.method !== 'home';
      const heads = Array.from(root.querySelectorAll('h3'));
      const pickHead = heads.find(h => trim(h.textContent) === 'Pickup'), pickBlock = root.querySelector('[data-endpoint="pickup"]');
      if (pickHead) pickHead.hidden = true;
      if (pickBlock) pickBlock.hidden = true;
      const block = root.querySelector('[data-endpoint="dropoff"]');
      const same = root.querySelector('[data-testid="package-dropoff-same-as-first"]');
      const sameLabel = same ? same.closest('label') : null;
      const head = heads.find(h => trim(h.textContent) === 'Drop-off');
      if (block) block.hidden = hide || !!(same && same.checked);
      if (sameLabel) sameLabel.hidden = hide;
      let note = root.querySelector('[data-testid="neworder-editor-method"]');
      if (!note && head) { note = el('p', { class: 'muted small', 'data-testid': 'neworder-editor-method' }); head.after(note); }
      if (note) { note.hidden = !hide; note.textContent = hide ? MDM.deliveryMethodLabel(n.method) + ': handed over at ' + MDM.deliveryEndpoint(deliveryFor(null)).address + '.' : ''; }
    }
    function openEditor(index) {
      cancelEditor();
      n.editing = index;
      // §3.3: a boat, Maldivian Cargo or airport hand-over is a delivery method with its own fee, so the package drop-off is an address
      // only (no cargo terminal, no airport zone; either would add the cargo or airport fee to a home delivery).
      n.editor = MDM.packageEditor.create({ service: 'business', settings, dropoffKinds: 'address', value: index == null ? null : n.packages[index], first: index !== 0 && n.packages.length ? n.packages[0] : null, me: me(), savedAddresses: [],
        onSave: pkg => { if (index == null) n.packages.push(pkg); else n.packages[index] = pkg; cancelEditor(); renderPackages(); },
        onCancel: cancelEditor });
      editorSlot.replaceChildren(n.editor.el);
      // A new package goes to the business's customer, not to the business: the receiver is typed.
      const self = index == null ? n.editor.el.querySelector('[data-testid="package-dropoff-recipient-me"]') : null;
      if (self && self.checked) { self.checked = false; self.dispatchEvent(new Event('change', { bubbles: true })); }
      syncEditor();
      addBtn.hidden = true; pkgError.hidden = true;
      n.editor.focus();
    }
    // Business packages carry the account's size category and its agreed rate; the category also sets the package size. A size the
    // business never agreed a rate for keeps its own category at the default rate (as the store does on a category change), instead of
    // silently becoming the cheapest agreed category.
    function tierChoices() {
      const agreed = accountTiers();
      return MDM.pricing.businessTiers(settings).map(t => agreed.find(a => a.value === t.value) || Object.assign({}, t, { rate: MDM.pricing.businessRate(account(), t.value, settings), notAgreed: true }));
    }
    function tierOf(pkg) {
      const tiers = tierChoices();
      const chosen = n.tiers[pkg.id] && tiers.find(t => t.value === n.tiers[pkg.id]);
      return chosen || tiers.find(t => t.size === pkg.size) || tiers[0] || null;
    }
    // What createOrder will price: the collection as the pickup, the method's hand-over point, the extra vehicle flag, business tiers.
    function effectivePackages() {
      const end = n.method !== 'home' ? MDM.deliveryEndpoint(deliveryFor(null)) : null;
      const pick = pickupEnd();
      const eligible = MDM.extraVehicleEligible(n.packages);
      return n.packages.map(p => {
        let x = Object.assign({}, p, { pickup: Object.assign({}, p.pickup || {}, pick) });
        if (end) x.dropoff = Object.assign({}, p.dropoff || {}, end, { recipient: end.recipient });
        if (n.extraVehicle && eligible && (x.size === 'box' || x.size === 'xl')) x.needsVehicle = true;
        const t = tierOf(p); if (t) x = Object.assign(x, { tier: t.value, tierRate: t.rate, size: t.size });
        return x;
      });
    }
    function renderPackages() {
      const eligible = MDM.extraVehicleEligible(n.packages);
      evBlock.hidden = !eligible;
      if (!eligible && n.extraVehicle) { n.extraVehicle = false; evInput.checked = false; }
      if (n.editor) syncEditor();
      if (!n.packages.length) { list.replaceChildren(el('p', { class: 'muted small' }, 'No packages yet.')); estimate.replaceChildren(el('p', { class: 'muted small' }, 'Add a package to see the price.')); return; }
      const eff = effectivePackages();
      const q = MDM.pricing.quote({ service: 'business', packages: eff }, settings);
      const tiers = tierChoices();
      list.replaceChildren(...n.packages.map((pkg, i) => {
        const s = MDM.packageEditor.summary(eff[i], 'business');
        let tierCtl = null;
        if (tiers.length) {
          const t = tierOf(pkg);
          const sel = el('select', { class: 'select', id: uid + '-tier-' + i, 'data-testid': 'neworder-package-tier', 'data-package-id': pkg.id },
            tiers.map(x => el('option', { value: x.value }, x.label + ' · ' + MDM.pricing.sizeLabel(x.size) + ' · ' + money(x.rate) + (x.notAgreed ? ', default rate' : ''))));
          sel.value = t ? t.value : tiers[0].value;
          sel.addEventListener('change', () => { n.tiers[pkg.id] = sel.value; const nt = tiers.find(x => x.value === sel.value); if (nt) pkg.size = nt.size; renderPackages(); });
          tierCtl = el('div', { class: 'field neworder-tier' }, el('label', { for: sel.id }, 'Size category'), sel);
        }
        return el('div', { class: 'list__item', 'data-testid': 'neworder-package', 'data-package-id': pkg.id },
          el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, (i + 1) + '. ' + s.title + (s.description ? ' · ' + s.description : '')),
            el('div', { class: 'list__meta' }, 'To ' + (n.method === 'home' ? s.dropoffLine : MDM.deliveryMethodLabel(n.method) + ', ' + s.dropoffLine)),
            s.flags.length ? el('div', { class: 'tags' }, s.flags.map(f => el('span', { class: 'tag' }, f))) : null,
            tierCtl),
          el('div', { class: 'list__aside' }, el('span', { class: 'mono' }, money(q.packages[i].price.lineTotal)),
            el('div', { class: 'row' },
              el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'neworder-package-edit', on: { click: () => openEditor(i) } }, 'Edit'),
              el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'neworder-package-remove', on: { click: () => { const gone = n.packages.splice(i, 1)[0]; if (gone) delete n.tiers[gone.id]; cancelEditor(); renderPackages(); } } }, 'Remove'))));
      }));
      const fees = (q.feeLines || []).map(f => el('div', { class: 'summary__line summary__line--fee', 'data-testid': 'neworder-fee', 'data-key': f.key },
        el('div', { class: 'summary__desc' }, f.label, f.reason ? el('span', { class: 'summary__sub' }, f.reason) : null), el('div', { class: 'summary__amount mono' }, money(f.amount))));
      const codAmount = Math.round(Number(codIn.value) || 0);
      estimate.replaceChildren(el('div', { class: 'summary' },
        el('div', { class: 'summary__line' }, el('div', { class: 'summary__desc' }, plural(n.packages.length, 'package')), el('div', { class: 'summary__amount mono' }, money(q.packages.reduce((t, p) => t + p.price.lineTotal, 0)))),
        fees,
        el('div', { class: 'summary__rule' }),
        el('div', { class: 'summary__total' }, el('span', null, 'Business rate'), el('span', { class: 'mono', 'data-testid': 'neworder-total' }, money(q.totals.total))),
        codAmount > 0 ? el('p', { class: 'muted small', 'data-testid': 'neworder-cod-note' }, 'Plus ' + money(codAmount) + ' cash collected for the business.') : null));
    }
    codIn.addEventListener('input', () => renderPackages());
    accountSel.addEventListener('change', () => { n.accountId = accountSel.value; n.tiers = {}; syncTiers(); syncPoints(); cancelEditor(); renderPackages(); });

    const body = [
      sec('Account', 'neworder-account-section', accountBlock),
      sec('Collection', 'neworder-collection-section', collectionBlock),
      sec('Delivery', 'neworder-delivery-section', el('div', { class: 'stack-4' },
        groupField('Delivery method', el('div', null, methodSeg, methodHint)),
        homeNote, receiverBlock, boatBlock, cargoBlock, airportBlock)),
      sec('Packages', 'neworder-packages-section', el('div', { class: 'stack-4' }, list, editorSlot, pkgError, addBtn, evBlock,
        el('div', { class: 'grid-2' }, codField, field(refIn.id, 'Reference', refIn, { optional: true })))),
      sec('Price', 'neworder-estimate-section', estimate),
    ];
    const createBtn = el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'neworder-create', on: { click: () => act(createOrder) } }, 'Create order');
    const footer = [el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'neworder-cancel', on: { click: () => drawer.close() } }, 'Cancel'), createBtn];
    syncTiers(); syncPoints(); syncMethod();
    drawer.open({ title: 'New business order', body, footer, size: 'lg', onClose: () => onDrawerClosed('new') });
    if (accounts.length) accountSel.focus();

    // Method fields the operator must fill: the receiver; the boat name, departure time and island; the cargo island; the airport
    // counter and resort.
    function checkMethod() {
      let ok = true;
      const need = (wrap, ctrl, msg) => { if (!trim(ctrl.value)) { setError(wrap, msg); ok = false; } };
      if (n.method === 'home') return true;
      need(rNameField, rName, "Enter the receiver's name");
      if (!phone.valid(rPhone.value, { intl: true })) { setError(rPhoneField, 'Enter the receiver\'s mobile number'); ok = false; }
      if (n.method === 'boat') {
        need(boatFields.name, boatName, 'Enter the boat, ferry or speedboat name');
        need(boatFields.time, boatTime, 'Enter the departure time');
        need(boatFields.island, boatIsland, 'Enter the destination island');
        if (trim(boatContact.value) && !phone.valid(boatContact.value, { intl: true })) { setError(boatFields.contact, 'Enter a valid mobile number'); ok = false; }
      } else if (n.method === 'cargo') need(cargoIslandField, cargoIsland, 'Enter the destination island');
      else { need(airportFields.counter, aCounter, 'Enter the resort counter or collection point'); need(airportFields.resort, aResort, 'Enter the resort or destination'); }
      return ok;
    }
    async function createOrder() {
      if (!state.neworder) return;
      const acc = account();
      if (!acc) { toast('Choose a business account', 'warn'); return; }
      let ok = checkCollection();
      if (n.level === 'advance' && !(dateIn.value && dateIn.value >= dayKey(new Date()))) { setError(dateField, 'Choose today or a later date'); ok = false; }
      if (trim(codIn.value) && !(Number(codIn.value) >= 0)) { setError(codField, 'Enter the cash amount in MVR'); ok = false; }
      if (!checkMethod()) ok = false;
      if (n.editor) { if (n.editor.validate()) { const pkg = n.editor.getValue(); if (n.editing == null) n.packages.push(pkg); else n.packages[n.editing] = pkg; cancelEditor(); renderPackages(); } else ok = false; }
      // While a package is open in the editor its own errors say what is missing.
      if (!n.packages.length) { if (!n.editor) { pkgError.textContent = 'Add at least 1 package'; pkgError.hidden = false; } ok = false; }
      else if (n.method === 'home') {
        // Packages saved while another method was chosen have no drop-off address of their own.
        const missing = n.packages.findIndex(p => !(p.dropoff && trim(p.dropoff.address)));
        if (missing >= 0) { pkgError.textContent = 'Package ' + (missing + 1) + ' has no drop-off address. Edit it, or choose another delivery method.'; pkgError.hidden = false; ok = false; }
      }
      if (!ok) { MDM.ui.focusFirstInvalid(drawer.el()); return; }
      MDM.ui.setLoading(createBtn, true);
      try {
        const eligible = MDM.extraVehicleEligible(n.packages);
        const collection = collectionFor(), pick = pickupEnd();
        const delivery = deliveryFor(n.packages[0]);
        const receiver = n.method === 'home' ? null : { name: delivery.recipientName, phone: delivery.recipientPhone };
        const packages = n.packages.map(p => {
          let x = Object.assign({}, p, {
            pickup: endpointCoords(Object.assign({}, p.pickup || {}, pick, { cargo: null, meetAt: '' })),
            dropoff: receiver ? Object.assign({}, p.dropoff || {}, { recipient: receiver }) : endpointCoords(p.dropoff),
            shop: null, sizeSource: 'operator' });
          const t = tierOf(p); if (t) x = Object.assign(x, { tier: t.value, tierRate: t.rate, size: t.size });
          return x;
        });
        const tiers = Array.from(new Set(packages.map(p => p.tier).filter(Boolean)));
        const details = {};
        if (trim(refIn.value)) details.reference = trim(refIn.value);
        if (tiers.length === 1) details.tier = tiers[0];
        const schedule = n.level === 'advance' ? { type: 'advance', collectDate: dateIn.value, collectTime: timeIn.value, deliverDate: dateIn.value, deliverTime: '' } : { type: 'asap' };
        const order = await MDM.store.createOrder({
          source: n.source, requestType: 'business', service: 'business', serviceLevel: n.level, accountId: acc.id, customerId: null,
          customer: { name: acc.name, phone: acc.phone, email: acc.email || '', notify: 'whatsapp' },
          collection, delivery, details, packages, schedule, by: by(),
          extraVehicle: !!(n.extraVehicle && eligible),
          cod: Math.round(Number(codIn.value) || 0),
          payment: { method: 'invoice', status: 'invoiced' }, status: 'confirmed' });
        toast('Order ' + order.code + ' created', 'ok');
        state.drawer.silent = true; drawer.close(); state.drawer.silent = false;
        MDM.admin.openOrder(order.id);
      } finally { if (createBtn.isConnected) MDM.ui.setLoading(createBtn, false); }
    }
  }

  // ---- View registration ---------------------------------------------------------------------------------------------------
  function tabsBar() {
    return el('div', { class: 'tabs orders-tabs', role: 'tablist', 'aria-label': 'Order queues', 'data-testid': 'orders-tabs' }, TABS.map(t =>
      el('button', { type: 'button', class: 'tab', role: 'tab', 'data-tab': t.value, 'data-testid': 'orders-tab-' + t.value, 'aria-selected': 'false', on: { click: () => setFilters({ tab: t.value }) } }, t.label, el('span', { class: 'tab__count' }))));
  }
  // #/orders?new=business (from the office request form's Business Delivery card) opens the business order drawer once.
  async function openFromQuery(p) {
    if (p.query.get('new') !== 'business') return;
    MDM.admin.setQuery({ new: null });
    await act(openNewOrder);
  }
  MDM.admin.views.orders = {
    title: 'Orders',
    async mount(host, p) {
      state.host = host; state.alive = true; state.page = 0; state.lastTab = null;
      state.filters = readFilters(p.query);
      state.drivers = await MDM.store.list('drivers');
      state.controls = buildControls(state.drivers);
      state.slots.tabs = tabsBar();
      state.slots.chips = el('div', { class: 'filters__chips', 'data-testid': 'orders-chips' });
      state.slots.table = el('div', { class: 'card', 'data-testid': 'orders-list' });
      state.slots.filtersBtn = el('button', { type: 'button', class: 'btn btn--secondary orders-filters-btn', 'data-testid': 'orders-filters-button', on: { click: openFiltersDrawer } }, 'Filters');
      host.append(
        el('div', { class: 'page-head' },
          el('h1', { tabindex: '-1' }, 'Orders'),
          el('div', { class: 'page-head__actions' }, el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'orders-new', 'aria-haspopup': 'dialog', on: { click: chooseNewOrder } }, html(MDM.icon('plus', 16)), 'New order'))),
        state.slots.tabs,
        el('div', { class: 'orders-toolbar' }, el('div', { class: 'orders-filters' }, state.controls.el), state.slots.filtersBtn),
        state.slots.chips,
        state.slots.table);
      await render();
      const schedule = () => { clearTimeout(state.timer); state.timer = setTimeout(() => render().catch(() => {}), 40); };
      ['orders', 'drivers', 'files', 'notifications'].forEach(c => state.unsubs.push(MDM.store.subscribe(c, schedule)));
      state.unsubs.push(MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') { if (state.drawer.kind) { state.drawer.silent = true; drawer.close(); state.drawer.silent = false; } schedule(); } }));
      if (p.id) await openOrderDrawer(p.id);
      else await openFromQuery(p);
    },
    async update(p) {
      state.filters = readFilters(p.query);
      state.page = 0;
      if (p.id) { if (state.drawer.kind !== 'order' || state.drawer.id !== p.id) await openOrderDrawer(p.id); }
      else if (state.drawer.kind === 'order') { state.drawer.silent = true; drawer.close(); state.drawer.silent = false; }
      await render();
      if (!p.id) await openFromQuery(p);
    },
    async unmount() {
      state.alive = false;
      clearTimeout(state.timer);
      state.unsubs.forEach(u => u()); state.unsubs = [];
      if (state.drawer.kind) { state.drawer.silent = true; drawer.close(); state.drawer.silent = false; }
      state.drawer.kind = null; state.drawer.id = null; state.drawer.order = null;
      state.host = null; state.controls = null; state.slots = {};
    },
  };
  // Every "New order" goes through the orders view's [data-testid="orders-new"] button (as the top bar and the go-to palette do).
  MDM.admin.openNewOrder = () => {
    if (!/^#\/orders(\?|$)/.test(location.hash)) location.hash = '#/orders';
    const t0 = Date.now();
    (function press() { const b = document.querySelector('[data-testid="orders-new"]'); if (b) b.click(); else if (Date.now() - t0 < 4000) setTimeout(press, 100); })();
  };
})(window.MDM);

// Orders view: quick tabs and filters kept in the hash query (client requirements §8), the paginated table, the order drawer with
// every operator action (price confirmation §3/§15, payments §4, driver workflow §13, failures §14, cancellation and changes §9,
// priority §11) and the "New order" drawer. Every write goes through MDM.store's domain methods with the signed-in user as `by`;
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
  const TABS = [
    { value: 'all', label: 'All', test: () => true },
    { value: 'price', label: 'Needs price', test: o => o.status === 'requested' },
    { value: 'payments', label: 'Payments to verify', test: o => o.payment && o.payment.status === 'received' },
    { value: 'unassigned', label: 'Unassigned', test: o => o.status === 'confirmed' && !o.driverId && !o.batchId },
    { value: 'active', label: 'Active', test: o => IN_PROGRESS.indexOf(o.status) >= 0 },
    { value: 'failed', label: 'Failed', test: o => o.status === 'failed' },
    { value: 'cancels', label: 'Cancel requests', test: o => o.cancellation && o.cancellation.status === 'requested' && open(o) },
    { value: 'priority', label: 'Priority requests', test: o => o.priority && o.priority.status === 'requested' && open(o) },
    { value: 'done', label: 'Done', test: o => DONE.indexOf(o.status) >= 0 },
  ];
  const TYPES = MDM.REQUEST_TYPES.map(t => ({ value: t.value, label: t.label })).concat([{ value: 'store', label: 'E-store order' }, { value: 'bulk', label: 'Business bulk' }]);
  const SOURCES = [{ value: 'phone', label: 'Phone' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'viber', label: 'Viber' }, { value: 'walkin', label: 'Walk-in' }];
  const NOTIFY = [{ value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'viber', label: 'Viber' }, { value: 'email', label: 'Email' }];
  const SIZE_OPTIONS = ['bag', 'box', 'xl'].map(s => ({ value: s, label: MDM.pricing.sizeLabel(s) }));
  const SIZE_SOURCE = { customer: 'Measured by the customer', driver: 'Measured by the driver', operator: 'Set by the office', estimate: 'Size chosen when booking' };
  const FILE_KIND = { package: 'Package photo', proof_collection: 'Proof of collection', proof: 'Proof of delivery', failed: 'Failed attempt', slip: 'Transfer slip', receipt: 'Shop receipt', document: 'Document' };
  const state = {
    host: null, alive: false, unsubs: [], timer: null, filters: {}, page: 0, controls: null, slots: {}, settings: null,
    drawer: { kind: null, id: null, silent: false, noteDraft: {}, assignChoice: {}, order: null },
    neworder: null,
  };
  const trim = v => String(v == null ? '' : v).trim();
  const plural = F.plural;
  const label = (list, v) => ((list || []).find(x => x.value === v) || {}).label || v || '';

  // ---- Filters ------------------------------------------------------------------------------------------------------------
  const FILTER_KEYS = ['tab', 'status', 'type', 'payment', 'driver', 'zone', 'from', 'to', 'q', 'customer', 'account', 'batch'];
  function readFilters(q) {
    const f = {}; FILTER_KEYS.forEach(k => { f[k] = q.get(k) || ''; });
    if (!TABS.some(t => t.value === f.tab)) f.tab = 'all';
    if (f.status && !MDM.STATUS[f.status]) f.status = '';
    if (f.payment && !MDM.PAYMENT[f.payment]) f.payment = '';
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
    const hay = [o.code, o.customer && o.customer.name, o.delivery && o.delivery.recipientName, o.collection && o.collection.contactName,
      ctx.accountName[o.accountId], ctx.batchCode[o.batchId], o.details && (o.details.reference || o.details.trackingNo || o.details.collectionCode || o.details.orderNo)]
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
    const type = el('select', { class: 'select', 'aria-label': 'Delivery type', 'data-testid': 'orders-filter-type' }, opt('', 'All types'), TYPES.map(s => opt(s.value, s.label)));
    const payment = el('select', { class: 'select', 'aria-label': 'Payment', 'data-testid': 'orders-filter-payment' }, opt('', 'All payments'), Object.keys(MDM.PAYMENT).map(k => opt(k, MDM.PAYMENT[k].label)));
    const driver = el('select', { class: 'select', 'aria-label': 'Driver', 'data-testid': 'orders-filter-driver' }, opt('', 'All drivers'), opt('none', 'No driver'), drivers.map(d => opt(d.id, d.name)));
    const zone = el('select', { class: 'select', 'aria-label': 'Zone', 'data-testid': 'orders-filter-zone' }, opt('', 'All zones'), MDM.geo.zoneOptions().map(z => opt(z.value, z.label)));
    const from = el('input', { class: 'input', type: 'date', 'aria-label': 'Created from', 'data-testid': 'orders-filter-from' });
    const to = el('input', { class: 'input', type: 'date', 'aria-label': 'Created to', 'data-testid': 'orders-filter-to' });
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Order, customer, business or phone', 'aria-label': 'Search orders', autocomplete: 'off', 'data-testid': 'orders-search' });
    [[status, 'status'], [type, 'type'], [payment, 'payment'], [driver, 'driver'], [zone, 'zone'], [from, 'from'], [to, 'to']].forEach(([c, k]) => c.addEventListener('change', () => { const p = {}; p[k] = c.value; setFilters(p); }));
    const deb = MDM.ui.debounce(() => setFilters({ q: trim(search.value) }), 250);
    search.addEventListener('input', deb);
    search.addEventListener('search', () => { deb.cancel(); setFilters({ q: trim(search.value) }); });
    const node = el('div', { class: 'filters filters--orders' }, search, status, type, payment, driver, zone, el('div', { class: 'filters__dates' }, from, el('span', { class: 'filters__dash', 'aria-hidden': 'true' }, 'to'), to));
    function sync() {
      const f = state.filters;
      status.value = f.status; type.value = f.type; payment.value = f.payment; driver.value = f.driver; zone.value = f.zone; from.value = f.from; to.value = f.to;
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
    if (state.drawer.kind === 'order' && state.drawer.id) await renderOrderDrawer();
  }
  function exportRows(rows, ctx) {
    const head = ['Order', 'Created', 'Type', 'Service level', 'Customer', 'Phone', 'Business', 'Collection', 'Delivery', 'Packages', 'Total MVR', 'Price', 'Payment', 'Status', 'Driver'];
    F.downloadCsv([head].concat(rows.map(o => [o.code, o.createdAt.slice(0, 16).replace('T', ' '), F.typeLabel(o), F.LEVEL[o.serviceLevel] || 'Normal', o.customer.name, o.customer.phone, ctx.accountName[o.accountId] || '',
      (o.collection || {}).address || '', (o.delivery || {}).address || '', (o.packages || []).length, o.totals.total, (o.pricing || {}).status === 'confirmed' ? 'Confirmed' : 'Estimated',
      (MDM.PAYMENT[(o.payment || {}).status] || {}).label || '', MDM.STATUS[o.status].label, F.driverName(o.driverId, ctx.drivers)])), 'mdm-orders-' + dayKey(new Date()) + '.csv');
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
  const dims = d => d && (d.l || d.w || d.h) ? [d.l, d.w, d.h].map(x => x || '?').join(' × ') + ' cm' : '';
  function parseDims(text) {
    const n = String(text || '').split(/[^0-9.]+/).filter(Boolean).map(Number);
    return n.length >= 3 ? { l: n[0], w: n[1], h: n[2] } : null;
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
    if (o.status === 'requested') {
      const photos = (o.packages || []).map(p => thumbButton(ctx.fileById[p.photoId], 'package photo')).filter(Boolean);
      const est = o.estimate ? money(o.estimate.min) + (o.estimate.max !== o.estimate.min ? ' to ' + money(o.estimate.max) : '') : money(o.totals.total);
      banner('warn', 'Confirm the price', [el('span', null, 'Customer saw an estimate of ' + est + '. ' + (photos.length ? 'Check the package photo, then set the exact price.' : 'No package photo: confirm now, or after the driver adds a proof of collection.')),
        photos.length ? el('div', { class: 'thumbs' }, photos) : null], [smallBtn('Confirm price', 'alert-confirm-price', () => confirmPrice(o), 'btn--primary')], 'drawer-alert-price');
    }
    if (o.payment && o.payment.status === 'received') banner('info', 'Payment slip to verify', 'Declared ' + money(o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total) + ' from ' + (bankName(o.payment.bank) || 'a bank') + '. Check the statement before verifying.',
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
      row('Service level', F.LEVEL[o.serviceLevel] || 'Normal'),
      row('Schedule', F.scheduleText(o)),
      row('Received via', F.SOURCE[o.source] || o.source),
      rowNode('Customer', el('span', null, c.name || '', el('small', { class: 'mono' }, phone.format(c.phone)), contactLinks(c.phone))),
      row('Email', c.email),
      row('Notify by', F.NOTIFY[c.notify] || c.notify),
      o.accountId ? rowNode('Business account', el('a', { href: '#/business/' + encodeURIComponent(o.accountId) }, ctx.account ? ctx.account.name : 'View account')) : null,
      ctx.batch ? rowNode('Bulk order', el('a', { href: '#/bulk/' + encodeURIComponent(ctx.batch.id) }, ctx.batch.code + ' · package ' + o.batchIndex + ' of ' + (ctx.batch.orderIds || []).length)) : null,
      drv ? rowNode('Driver', el('span', null, drv.name, el('small', { class: 'mono' }, phone.format(drv.phone)), contactLinks(drv.phone))) : null));
  }
  const DETAIL_LABELS = {
    carrier: 'Carrier', location: 'Pikpost location', postOffice: 'Post office', collectionCode: 'Collection code', collectBefore: 'Collect before', smsNote: 'SMS note',
    trackingNo: 'Tracking number', ownerName: 'Owner name', ownerContact: 'Owner contact', shippingAddress: 'Shipping address', idNote: 'ID details',
    mode: 'Airport service', area: 'Airport area', flight: 'Flight', flightTime: 'Flight time', passengerName: 'Passenger', passengerPhone: 'Passenger phone', bags: 'Bags',
    task: 'Task', organisation: 'Office or organisation', reference: 'Reference', details: 'Details', returnDocs: 'Bring documents back',
    shopName: 'Shop', proof: 'Proof of purchase', orderNo: 'Order or invoice number', paidByCustomer: 'Already paid', notes: 'Notes',
  };
  function detailValue(k, v) {
    if (v === true) return 'Yes'; if (v === false) return 'No';
    if (k === 'carrier') return label(MDM.CARRIERS, v);
    if (k === 'location') return label(MDM.PIKPOST_LOCATIONS, v);
    if (k === 'postOffice') return label(MDM.POST_OFFICES, v);
    if (k === 'mode') return label(MDM.AIRPORT_MODES, v);
    if (k === 'area') return label(MDM.geo.airportPoints(), v);
    if (k === 'task') return label(MDM.OFFICE_TASKS, v);
    if (k === 'proof') return { invoice: 'Invoice', quotation: 'Quotation and payment slip', order_no: 'Order number' }[v] || v;
    if (k === 'ownerContact' || k === 'passengerPhone') return phone.format(v);
    return String(v);
  }
  function detailsSection(o) {
    const d = o.details || {};
    const keys = Object.keys(d).filter(k => d[k] != null && d[k] !== '');
    const items = o.items && o.items.length ? el('div', { class: 'list' }, o.items.map(i => el('div', { class: 'list__item' }, el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, i.qty + ' × ' + i.name)), el('div', { class: 'list__aside mono' }, money(i.total))))) : null;
    if (!keys.length && !items) return null;
    return sec(F.typeLabel(o) + ' details', 'drawer-details', el('div', { class: 'rate-table' }, keys.map(k => row(DETAIL_LABELS[k] || k.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, c => c.toUpperCase()), detailValue(k, d[k])))), items);
  }
  function addressesSection(o) {
    const c = o.collection || {}, d = o.delivery || {};
    const meet = d.meetAt && d.zone !== 'airport' ? label(MDM.geo.meetAtOptions(), d.meetAt) : (d.zone === 'airport' ? label(MDM.geo.airportPoints(), d.meetAt) : '');
    return sec('Collection and delivery', 'drawer-addresses', el('div', { class: 'grid-2 addr-grid' },
      el('div', { class: 'addr' }, el('div', { class: 'addr__label' }, 'Collect from'), el('div', { class: 'addr__line' }, c.address || ''), el('div', { class: 'addr__meta' }, [MDM.geo.zoneLabel(c.zone), c.landmark].filter(Boolean).join(' · ')),
        el('div', { class: 'addr__meta' }, person(c.contactName, c.contactPhone)), c.instructions ? el('div', { class: 'addr__note' }, c.instructions) : null),
      el('div', { class: 'addr' }, el('div', { class: 'addr__label' }, 'Deliver to'), el('div', { class: 'addr__line' }, d.address || ''), el('div', { class: 'addr__meta' }, [MDM.geo.zoneLabel(d.zone), d.landmark, meet ? 'Meet at: ' + meet : ''].filter(Boolean).join(' · ')),
        el('div', { class: 'addr__meta' }, person(d.recipientName, d.recipientPhone)), d.instructions ? el('div', { class: 'addr__note' }, d.instructions) : null)),
      open(o) ? el('div', { class: 'row', style: { marginTop: '12px' } }, smallBtn('Modify order', 'drawer-modify', () => modifyOrder(o))) : null);
  }
  function packagesSection(o, ctx) {
    const items = (o.packages || []).map((pkg, i) => {
      const lines = [];
      if (o.service === 'shop' && pkg.shop) {
        if (pkg.shop.list) lines.push('List: ' + pkg.shop.list);
        lines.push('Budget ' + money(pkg.shop.budget) + ' · if unavailable: ' + ({ call: 'call the customer', skip: 'skip it', closest: 'buy the closest match' }[pkg.shop.unavailable] || pkg.shop.unavailable) + (pkg.shop.receiptTotal ? ' · receipt ' + money(pkg.shop.receiptTotal) : ''));
      } else if (pkg.dropoff && (o.packages || []).length > 1) lines.push('To ' + person(pkg.dropoff.recipient && pkg.dropoff.recipient.name, pkg.dropoff.recipient && pkg.dropoff.recipient.phone) + ' · ' + (pkg.dropoff.address || ''));
      const size = [dims(pkg.dims), pkg.weightKg ? pkg.weightKg + ' kg' : ''].filter(Boolean).join(' · ');
      const tags = [];
      if (pkg.fragile) tags.push('Fragile'); if (pkg.needsVehicle) tags.push('Needs a vehicle'); if (o.service === 'business' && pkg.underOneFt === false) tags.push('Over 1 ft');
      const photo = thumbButton(ctx.fileById[pkg.photoId], pkg.photoSource === 'driver' ? 'proof of collection' : 'package photo');
      return el('div', { class: 'list__item', 'data-testid': 'drawer-package', 'data-package-id': pkg.id },
        el('div', { class: 'list__main' },
          el('div', { class: 'list__title' }, (i + 1) + '. ' + MDM.pricing.sizeLabel(pkg.size) + (pkg.description ? ' · ' + pkg.description : '')),
          size ? el('div', { class: 'list__meta' }, size + ' · ' + (SIZE_SOURCE[pkg.sizeSource] || '').toLowerCase()) : el('div', { class: 'list__meta' }, SIZE_SOURCE[pkg.sizeSource] || SIZE_SOURCE.estimate),
          lines.map(l => el('div', { class: 'list__meta' }, l)),
          tags.length ? el('div', { class: 'tags' }, tags.map(f => el('span', { class: 'tag' }, f))) : null,
          photo ? el('div', { class: 'thumbs' }, photo) : null),
        el('div', { class: 'list__aside mono' }, money(pkg.price ? pkg.price.lineTotal : 0)));
    });
    return sec('Packages', 'drawer-packages', el('div', { class: 'list' }, items),
      open(o) && o.service !== 'store' ? el('div', { class: 'row', style: { marginTop: '12px' } }, smallBtn('Update sizes', 'drawer-update-sizes', () => updateSizes(o))) : null);
  }
  function filesSection(o, ctx) {
    const files = ctx.files.filter(f => /^image\//.test(f.type || ''));
    if (!files.length) return null;
    const docName = id => ((o.documents || []).find(d => d.fileId === id) || {}).name;
    return sec('Photos and documents', 'drawer-files', el('div', { class: 'file-grid' }, files.map(f => {
      const text = f.kind === 'document' ? (docName(f.id) || f.name) : (FILE_KIND[f.kind] || f.name);
      return el('figure', { class: 'file-grid__item', 'data-kind': f.kind }, thumbButton(f, text), el('figcaption', null, text, el('small', null, fmtDate(f.at || f.createdAt))));
    })));
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
      if ((s.packageIds || []).length > 1) meta.push(plural(s.packageIds.length, 'package'));
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
    if (o.service === 'shop' && t.budget) {
      const receipt = (o.packages || []).some(x => x.shop && x.shop.receiptTotal);
      lines.push(el('div', { class: 'summary__line' }, el('div', { class: 'summary__desc' }, receipt ? 'Receipt total' : 'Shopping budget'), el('div', { class: 'summary__amount mono' }, money(t.budget))));
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
      el('div', { class: 'alert__body' }, el('div', { class: 'alert__title' }, 'Price to confirm before collection'), (t.quoteReasons || []).map(r => el('div', null, MDM.pricing.reasonText(r))))) : null;
    const status = el('div', { class: 'rate-table' }, rowNode('Price', el('span', null, badgeNode(confirmed ? 'ok' : 'warn', confirmed ? 'Confirmed' : 'Estimated', { 'data-testid': 'drawer-price-status', 'data-status': confirmed ? 'confirmed' : 'estimated' }),
      confirmed && p.confirmedAt ? el('small', null, F.byLabel(p.confirmedBy) + ', ' + fmtDate(p.confirmedAt) + (p.remarks ? ' · ' + p.remarks : '')) : null)));
    const hist = (p.history || []).length ? el('details', { class: 'history', 'data-testid': 'drawer-price-history' }, el('summary', null, 'Price changes (' + p.history.length + ')'),
      el('div', { class: 'list' }, p.history.slice().reverse().map(h => el('div', { class: 'list__item' }, el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, money(h.from) + ' → ' + money(h.to)), el('div', { class: 'list__meta' }, [h.note, F.byLabel(h.by), fmtDate(h.at)].filter(Boolean).join(' · ')))))) ) : null;
    const actions = open(o) ? el('div', { class: 'row row--wrap' },
      smallBtn(confirmed ? 'Change confirmed price' : 'Confirm price', 'drawer-confirm-price', () => confirmPrice(o), confirmed ? 'btn--secondary' : 'btn--primary'),
      smallBtn('Add adjustment', 'drawer-add-adjustment', () => addAdjustment(o))) : null;
    return sec('Pricing', 'drawer-pricing', el('div', { class: 'stack-3' }, status, summary, est, reasons, hist, actions));
  }
  function paymentSection(o, ctx) {
    const p = o.payment || {};
    const st = p.status || 'pending';
    const rows = [rowNode('Status', el('span', null, html(MDM.payBadge(st).replace('<span ', '<span data-testid="drawer-payment-status" ')), p.upfront ? el('small', null, 'Requested before delivery') : null))];
    if (p.method === 'invoice') {
      rows.push(row('Method', 'Monthly business invoice'), row('Amount', money(o.totals.total), { mono: true }));
      return sec('Payment', 'drawer-payment', el('div', { class: 'rate-table' }, rows), o.accountId ? el('p', { class: 'muted small' }, el('a', { href: '#/business/' + encodeURIComponent(o.accountId) }, 'Open the account invoices')) : null);
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
  function cancellationSection(o) {
    const c = o.cancellation;
    if ((!c || c.status === 'none') && !o.cancelReason) return null;
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
    const v = x => x === '' || x == null ? 'empty' : typeof x === 'object' ? JSON.stringify(x) : String(x);
    return sec('Changes', 'drawer-changes', el('div', { class: 'list' }, ch.map(x => el('div', { class: 'list__item', 'data-testid': 'drawer-change' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, x.field.replace(/\./g, ' ')), el('div', { class: 'list__meta wrap-anywhere' }, v(x.from) + ' → ' + v(x.to)), el('div', { class: 'list__meta' }, F.byLabel(x.by))),
      el('div', { class: 'list__aside' }, fmtDate(x.at))))));
  }
  function notificationsSection(ctx) {
    if (!ctx.notifications.length) return null;
    return sec('Notifications sent', 'drawer-notifications', el('div', { class: 'list' }, ctx.notifications.slice().reverse().map(n => el('div', { class: 'list__item', 'data-testid': 'drawer-notification' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, n.title), el('div', { class: 'list__meta wrap-anywhere' }, n.message)),
      el('div', { class: 'list__aside' }, el('span', null, F.NOTIFY[n.channel] || n.channel), el('small', null, fmtDate(n.at)))))));
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
    if (st === 'requested') items.push(cancelBtn(), btn('Confirm price', 'drawer-confirm', 'btn--primary', () => confirmPrice(o)));
    else if (st === 'confirmed' || (st === 'collected' && o.batchId && !o.driverId)) {
      const sel = driverSelect(o, ctx, 'drawer-assign-driver', null, state.drawer.assignChoice[o.id]);
      sel.addEventListener('change', () => { state.drawer.assignChoice[o.id] = sel.value; });
      if (st === 'confirmed') items.push(cancelBtn());
      items.push(sel, btn('Assign driver', 'drawer-assign', 'btn--primary', () => assign(o, sel.value)));
    } else if (st === 'assigned') items.push(btn('Reassign', 'drawer-reassign', 'btn--secondary', () => reassign(o, ctx)), btn('Dispatch', 'drawer-dispatch', 'btn--primary', () => dispatchOrder(o)));
    else if (st === 'dispatched') items.push(btn('Reassign', 'drawer-reassign', 'btn--secondary', () => reassign(o, ctx)), btn('On the way', 'drawer-start', 'btn--primary', () => startRoute(o)));
    else if (st === 'on_the_way') items.push(btn('Report failed', 'drawer-fail', 'btn--ghost', () => reportFailed(o)), btn('Arrived', 'drawer-arrived', 'btn--secondary', () => arrived(o)), btn('Mark collected', 'drawer-collected', 'btn--primary', () => collected(o)));
    else if (st === 'arrived') items.push(btn('Report failed', 'drawer-fail', 'btn--ghost', () => reportFailed(o)), btn('Mark collected', 'drawer-collected', 'btn--primary', () => collected(o)));
    else if (st === 'collected') items.push(o.driverId ? btn('Reassign', 'drawer-reassign', 'btn--secondary', () => reassign(o, ctx)) : null, btn(o.batchId ? 'Dispatch for delivery' : 'Out for delivery', 'drawer-out', 'btn--primary', () => outForDelivery(o)));
    else if (st === 'out_for_delivery') items.push(btn('Report failed', 'drawer-fail', 'btn--ghost', () => reportFailed(o)), btn(nextStop(o, ['return']) ? 'Mark returned' : 'Mark delivered', 'drawer-deliver', 'btn--primary', () => delivered(o)));
    else if (st === 'failed') items.push(btn('Decide what happens next', 'drawer-resolve', 'btn--primary', () => resolveFailure(o, ctx)));
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
  function statusMessage(o) { return 'Mr. Delivery Man: order ' + o.code + ' is ' + MDM.STATUS[o.status].customer.toLowerCase() + '. Track: ' + MDM.href('track/?order=' + encodeURIComponent(o.id)); }
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
  async function confirmPrice(o) {
    o = await fresh(o);
    const presets = MDM.ADJUSTMENT_PRESETS.filter(p => p.value !== 'discount');
    const est = o.estimate ? money(o.estimate.min) + (o.estimate.max !== o.estimate.min ? ' to ' + money(o.estimate.max) : '') : money(o.totals.total);
    const canAsk = o.payment && o.payment.method !== 'invoice' && o.payment.status === 'pending';
    const v = await dialog({ title: 'Confirm the price for ' + o.code, message: 'Current total ' + money(o.totals.total) + ', the customer was shown ' + est + '. Include any vehicle fee. The difference is recorded with your name.', okLabel: 'Confirm price',
      fields: [
        { name: 'total', label: 'Final price (MVR)', type: 'number', required: true, value: o.totals.total, min: 0, step: 1 },
        { name: 'preset', label: 'Reason for any difference', type: 'select', options: presets, value: (o.packages || []).some(p => p.needsVehicle) ? 'vehicle' : 'quote' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2, placeholder: 'Checked the photo: 2 boxes, needs the pickup truck' },
        canAsk ? { name: 'requestPayment', label: 'Ask the customer to pay now', type: 'checkbox', value: upfrontDefault(o), hint: 'Otherwise the invoice goes out after delivery' } : null].filter(Boolean) });
    if (!v) return;
    const upd = await MDM.store.confirmPrice(o.id, { total: v.total, preset: v.preset, label: v.preset === 'quote' ? 'Price confirmation' : label(presets, v.preset), remarks: v.remarks, requestPayment: !!v.requestPayment, by: by() });
    toast('Price confirmed: ' + money(upd.totals.total) + (upd.payment.status === 'requested' ? ', payment requested' : ''), 'ok');
  }
  async function addAdjustment(o) {
    const presets = MDM.ADJUSTMENT_PRESETS.filter(p => p.value !== 'quote');
    const v = await dialog({ title: 'Adjust the price of ' + o.code, message: o.pricing && o.pricing.status === 'confirmed' ? 'The customer sees the new total on the tracking page.' : 'Added to the estimate before the price is confirmed.', okLabel: 'Add adjustment',
      fields: [
        { name: 'preset', label: 'Type', type: 'select', options: presets, value: presets[0].value },
        { name: 'amount', label: 'Amount (MVR)', type: 'number', required: true, step: 1, hint: 'Discounts are negative, for example −20', validate: (val, all) => all.preset === 'discount' ? (val < 0 ? null : 'A discount is a negative amount') : (val > 0 ? null : 'Enter an amount above 0') },
        { name: 'label', label: 'Shown as', type: 'text', placeholder: 'Waiting time at the harbour' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2, required: true, placeholder: 'Why the price changed' }] });
    if (!v) return;
    await MDM.store.addAdjustment(o.id, { preset: v.preset, label: trim(v.label) || undefined, amount: v.amount, remarks: v.remarks, by: by() });
    toast('Adjustment added', 'ok');
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
  // Collected: proof of collection photo, the measured size of each package and any remarks (requirements §3 step 4, §13).
  async function collected(o) {
    o = await fresh(o);
    const s = nextStop(o, ['pickup']);
    if (!s) { toast('No collection stop left', 'warn'); return; }
    const pkgs = (o.packages || []).filter(p => (s.packageIds || [s.packageId]).indexOf(p.id) >= 0);
    const fields = [];
    if (s.shop) fields.push({ name: 'receiptTotal', label: 'Receipt total (MVR)', type: 'number', required: true, min: 0, step: 1 }, { name: 'receipt', label: 'Receipt photo', type: 'file', accept: 'image/*' });
    fields.push({ name: 'photo', label: 'Proof of collection photo', type: 'file', accept: 'image/*', hint: o.pricing && o.pricing.status !== 'confirmed' ? 'No customer photo yet: this is what the price is confirmed from' : null });
    pkgs.forEach((p, i) => fields.push(
      { name: 'size_' + i, label: 'Package ' + (i + 1) + (p.description ? ', ' + p.description : '') + ': size', type: 'segmented', options: SIZE_OPTIONS, value: p.size },
      { name: 'dims_' + i, label: 'Measured size in cm', type: 'text', value: p.dims ? [p.dims.l, p.dims.w, p.dims.h].join(' × ') : '', placeholder: '30 × 20 × 15' }));
    fields.push({ name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2 });
    const v = await dialog({ title: (s.shop ? 'Shopping done at ' : 'Collected from ') + s.address, message: 'Recorded on behalf of ' + (F.driverName(o.driverId, state.drivers) || 'the driver') + '.', okLabel: 'Mark collected', fields });
    if (!v) return;
    const photoId = await storePhoto(v.photo, o.id, 'proof_collection');
    const receiptPhotoId = s.shop ? await storePhoto(v.receipt, o.id, 'receipt') : null;
    const sizes = {};
    pkgs.forEach((p, i) => { const d = parseDims(v['dims_' + i]); if (v['size_' + i] !== p.size || d) sizes[p.id] = { size: v['size_' + i], dims: d || p.dims || null }; });
    await MDM.store.setStop(o.id, s.id, { status: 'done', photoId, sizes: Object.keys(sizes).length ? sizes : null, remarks: v.remarks, receiptTotal: v.receiptTotal, receiptPhotoId, by: by() });
    toast('Collected', 'ok');
  }
  async function delivered(o) {
    const s = nextStop(o, ['dropoff', 'return']);
    if (!s) { toast('No delivery stop left', 'warn'); return; }
    const v = await dialog({ title: (s.type === 'return' ? 'Returned to ' : 'Delivered at ') + s.address, message: s.label + (s.contact && s.contact.name ? ' · ' + s.contact.name : '') + '. Recorded on behalf of the driver.', okLabel: s.type === 'return' ? 'Mark returned' : 'Mark delivered',
      fields: [
        { name: 'handedTo', label: 'Handed to', type: 'segmented', options: MDM.HANDED_TO, value: 'recipient' },
        { name: 'recipientName', label: 'Name of the person', type: 'text', value: s.contact && s.contact.name || '', validate: (val, all) => all.handedTo !== 'left' && !trim(val) ? 'Enter who received it' : null },
        { name: 'confirmed', label: 'Recipient confirmed receipt', type: 'checkbox', value: true },
        { name: 'photo', label: 'Proof of delivery photo', type: 'file', accept: 'image/*' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2 }] });
    if (!v) return;
    const photoId = await storePhoto(v.photo, o.id, 'proof');
    await MDM.store.setStop(o.id, s.id, { status: 'done', handedTo: v.handedTo, recipientName: trim(v.recipientName), confirmed: !!v.confirmed, photoId, remarks: v.remarks, by: by() });
    toast(s.type === 'return' ? 'Returned to sender' : 'Delivered', 'ok');
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
  async function updateSizes(o) {
    o = await fresh(o);
    const fields = [];
    (o.packages || []).forEach((p, i) => fields.push(
      { name: 'size_' + i, label: 'Package ' + (i + 1) + (p.description ? ', ' + p.description : ''), type: 'segmented', options: SIZE_OPTIONS, value: p.size },
      { name: 'dims_' + i, label: 'Size in cm', type: 'text', value: p.dims ? [p.dims.l, p.dims.w, p.dims.h].join(' × ') : '', placeholder: '30 × 20 × 15' }));
    const v = await dialog({ title: 'Package sizes · ' + o.code, message: 'Prices are re-derived from the rate card; the change is logged with your name.', okLabel: 'Save sizes', fields });
    if (!v) return;
    const sizes = {};
    (o.packages || []).forEach((p, i) => { const d = parseDims(v['dims_' + i]); if (v['size_' + i] !== p.size || (d && JSON.stringify(d) !== JSON.stringify(p.dims))) sizes[p.id] = { size: v['size_' + i], dims: d || p.dims || null }; });
    if (!Object.keys(sizes).length) { toast('Nothing changed', 'ok'); return; }
    const upd = await MDM.store.updatePackages(o.id, sizes, by());
    toast('Sizes saved · total ' + money(upd.totals.total), 'ok');
  }
  // Modify order (requirements §9): addresses, contacts, instructions, service level and schedule, with a field-by-field history.
  async function modifyOrder(o) {
    o = await fresh(o);
    const c = o.collection || {}, d = o.delivery || {}, s = o.schedule || {};
    const zones = MDM.geo.zoneOptions();
    const v = await dialog({ title: 'Modify ' + o.code, message: 'Every change is recorded with your name. Routes are rebuilt when nothing has been collected yet.', okLabel: 'Save changes',
      fields: [
        { name: 'cAddress', label: 'Collection address', type: 'text', required: true, value: c.address },
        { name: 'cZone', label: 'Collection zone', type: 'select', options: zones, value: c.zone },
        { name: 'cLandmark', label: 'Collection landmark', type: 'text', value: c.landmark },
        { name: 'cName', label: 'Collection contact', type: 'text', value: c.contactName },
        { name: 'cPhone', label: 'Collection contact number', type: 'tel', value: c.contactPhone, intl: true },
        { name: 'cNote', label: 'Collection instructions', type: 'textarea', rows: 2, value: c.instructions },
        { name: 'dAddress', label: 'Delivery address', type: 'text', required: true, value: d.address },
        { name: 'dZone', label: 'Delivery zone', type: 'select', options: zones, value: d.zone },
        { name: 'dLandmark', label: 'Delivery landmark', type: 'text', value: d.landmark },
        { name: 'dName', label: 'Recipient', type: 'text', value: d.recipientName },
        { name: 'dPhone', label: 'Recipient number', type: 'tel', value: d.recipientPhone, intl: true },
        { name: 'dNote', label: 'Delivery instructions', type: 'textarea', rows: 2, value: d.instructions },
        { name: 'level', label: 'Service level', type: 'segmented', options: MDM.SERVICE_LEVELS, value: o.serviceLevel || 'normal' },
        { name: 'collectAt', label: 'Collect at (advance orders)', type: 'datetime-local', value: s.collectDate ? s.collectDate + 'T' + (s.collectTime || '09:00') : '' },
        { name: 'deliverAt', label: 'Deliver by (advance orders)', type: 'datetime-local', value: s.deliverDate ? s.deliverDate + 'T' + (s.deliverTime || '12:00') : '' }] });
    if (!v) return;
    const ph = x => phone.normalize(x) || trim(x);
    const patch = {
      collection: { address: v.cAddress, zone: v.cZone, landmark: v.cLandmark, contactName: v.cName, contactPhone: ph(v.cPhone), instructions: v.cNote },
      delivery: { address: v.dAddress, zone: v.dZone, landmark: v.dLandmark, recipientName: v.dName, recipientPhone: ph(v.dPhone), instructions: v.dNote },
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
    const body = [alertsSection(o, ctx), summarySection(o, ctx), detailsSection(o), addressesSection(o), packagesSection(o, ctx), filesSection(o, ctx), routeSection(o, ctx), pricingSection(o), paymentSection(o, ctx),
      prioritySection(o), cancellationSection(o), historySection(o), changesSection(o), notificationsSection(ctx), notesSection(o), activitySection(o)].filter(Boolean);
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

  // ---- New order drawer (phone, WhatsApp, Viber and walk-in orders) ----------------------------------------------------------
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
  async function openNewOrder() {
    if (!MDM.packageEditor || typeof MDM.packageEditor.create !== 'function') { toast('The package form is not loaded on this page', 'danger'); return; }
    if (state.drawer.kind) { state.drawer.silent = true; drawer.close(); state.drawer.silent = false; }
    const [accounts, settings] = await Promise.all([MDM.store.list('business_accounts', { where: { status: 'approved' } }), MDM.store.settings()]);
    state.settings = settings;
    const n = state.neworder = { source: 'phone', type: 'customer', requestType: 'home', level: 'normal', service: 'pick', existing: null, accountId: accounts.length ? accounts[0].id : '', packages: [], editor: null, editing: null,
      schedule: { date: dayKey(new Date(Date.now() + 86400000)), time: '10:00' } };
    state.drawer.kind = 'new'; state.drawer.id = null;
    const uid = 'no';
    // Customer
    const phoneIn = el('input', { class: 'input', id: uid + '-phone', type: 'tel', inputmode: 'numeric', autocomplete: 'off', placeholder: '7XX XXXX', 'data-testid': 'neworder-phone' });
    const nameIn = el('input', { class: 'input', id: uid + '-name', type: 'text', autocomplete: 'off', 'data-testid': 'neworder-name' });
    const emailIn = el('input', { class: 'input', id: uid + '-email', type: 'email', autocomplete: 'off', 'data-testid': 'neworder-email' });
    const hint = el('div', { class: 'field__hint', 'data-testid': 'neworder-customer-hint' }, 'New customer');
    const phoneField = field(phoneIn.id, 'Mobile', phoneIn); phoneField.appendChild(hint);
    const nameField = field(nameIn.id, 'Name', nameIn);
    let notify = 'whatsapp';
    const notifySeg = segmented(uid + '-notify', NOTIFY, notify, 'neworder-notify', v => { notify = v; });
    const lookup = MDM.ui.debounce(async () => {
      const norm = phone.normalize(phoneIn.value);
      n.existing = null;
      if (!norm) { hint.textContent = 'New customer'; return; }
      const found = await MDM.store.list('customers', { where: { phone: norm } });
      if (!state.neworder) return;
      if (found.length) {
        n.existing = found[0];
        if (!trim(nameIn.value)) nameIn.value = found[0].name || '';
        if (!trim(emailIn.value) && found[0].email) emailIn.value = found[0].email;
        if (found[0].notify) { notify = found[0].notify; const r = notifySeg.querySelector('input[value="' + found[0].notify + '"]'); if (r) r.checked = true; }
        hint.textContent = 'Existing customer · ' + plural(found[0].orderCount || 0, 'order') + (found[0].lastOrderAt ? ', last ' + timeAgo(found[0].lastOrderAt) : '');
      } else hint.textContent = 'New customer';
    }, 200);
    phoneIn.addEventListener('input', () => { setError(phoneField, null); lookup(); });
    nameIn.addEventListener('input', () => setError(nameField, null));
    const customerBlock = el('div', { class: 'stack-4', 'data-testid': 'neworder-customer' },
      el('div', { class: 'grid-2' }, phoneField, nameField), field(emailIn.id, 'Email', emailIn, { optional: true }),
      el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Notify by'), notifySeg));
    const accountSel = el('select', { class: 'select', id: uid + '-account', 'data-testid': 'neworder-account' }, accounts.map(a => el('option', { value: a.id }, a.name)));
    accountSel.addEventListener('change', () => { n.accountId = accountSel.value; });
    const businessBlock = el('div', { class: 'stack-4', hidden: true, 'data-testid': 'neworder-business' },
      accounts.length ? field(accountSel.id, 'Business account', accountSel, { hint: 'Business rate, invoiced monthly' }) : el('div', { class: 'alert alert--info' }, html(MDM.icon('info', 16)), el('div', { class: 'alert__body' }, 'No approved business accounts yet.')));
    // Request type and details
    const typeSel = el('select', { class: 'select', id: uid + '-rtype', 'data-testid': 'neworder-request-type' }, MDM.REQUEST_TYPES.map(t => el('option', { value: t.value }, t.label)));
    const carrierSel = el('select', { class: 'select', id: uid + '-carrier', 'data-testid': 'neworder-carrier' }, MDM.CARRIERS.map(c => el('option', { value: c.value }, c.label)));
    const codeIn = el('input', { class: 'input', id: uid + '-code', type: 'text', 'data-testid': 'neworder-code', placeholder: 'RB-48213 or 1234 5678 90' });
    const postalBlock = el('div', { class: 'grid-2', hidden: true }, field(carrierSel.id, 'Carrier', carrierSel), field(codeIn.id, 'Collection code or tracking number', codeIn, { optional: true }));
    const detailsIn = el('textarea', { class: 'textarea', id: uid + '-details', rows: 2, 'data-testid': 'neworder-details', placeholder: 'Flight number, office task, shop invoice number, anything the driver needs' });
    typeSel.addEventListener('change', () => { n.requestType = typeSel.value; postalBlock.hidden = n.requestType !== 'postal'; setService(n.type === 'business' ? 'business' : (n.requestType === 'shop_buy' ? 'shop' : 'pick')); });
    const levelSeg = segmented(uid + '-level', MDM.SERVICE_LEVELS, 'normal', 'neworder-level', v => { n.level = v; advBlock.hidden = v !== 'advance'; });
    const typeSeg = segmented(uid + '-type', [{ value: 'customer', label: 'Customer' }, { value: 'business', label: 'Business account' }], 'customer', 'neworder-type', v => { n.type = v; syncType(); });
    function syncType() {
      customerBlock.hidden = n.type !== 'customer'; businessBlock.hidden = n.type !== 'business';
      setService(n.type === 'business' ? 'business' : (n.requestType === 'shop_buy' ? 'shop' : 'pick'));
    }
    function setService(v) {
      if (n.service === v) return;
      const had = n.packages.length;
      n.service = v; n.packages = []; cancelEditor();
      if (had) toast('Packages cleared because the service changed', 'warn');
      renderPackages();
    }
    // Packages (shared package editor)
    const list = el('div', { class: 'list', 'data-testid': 'neworder-packages' });
    const editorSlot = el('div', { class: 'neworder-editor' });
    const pkgError = el('div', { class: 'field__error', 'data-testid': 'neworder-packages-error', hidden: true });
    const addBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'neworder-add-package', on: { click: () => openEditor(null) } }, html(MDM.icon('plus', 16)), 'Add a package');
    const estimate = el('div', { 'data-testid': 'neworder-estimate' });
    function me() {
      if (n.type === 'business') { const a = accounts.find(x => x.id === n.accountId); return a ? { name: a.contactName, phone: a.phone } : null; }
      return trim(phoneIn.value) ? { name: trim(nameIn.value), phone: trim(phoneIn.value) } : null;
    }
    function savedAddresses() {
      if (n.type === 'business') { const a = accounts.find(x => x.id === n.accountId); return a ? [{ label: a.name, address: a.pickupAddress, zone: a.zone, meetAt: 'door' }] : []; }
      return n.existing && n.existing.addresses ? n.existing.addresses : [];
    }
    function cancelEditor() { if (n.editor) { n.editor.destroy(); n.editor = null; } n.editing = null; editorSlot.replaceChildren(); addBtn.hidden = false; }
    function openEditor(index) {
      cancelEditor();
      n.editing = index;
      n.editor = MDM.packageEditor.create({ service: n.service, settings, value: index == null ? null : n.packages[index], first: index !== 0 && n.packages.length ? n.packages[0] : null, me: me(), savedAddresses: savedAddresses(),
        onSave: pkg => { if (index == null) n.packages.push(pkg); else n.packages[index] = pkg; cancelEditor(); renderPackages(); },
        onCancel: cancelEditor });
      editorSlot.replaceChildren(n.editor.el);
      addBtn.hidden = true; pkgError.hidden = true;
      n.editor.focus();
    }
    function quote() { return MDM.pricing.quote({ service: n.service, packages: n.packages }, settings); }
    function renderPackages() {
      const q = quote();
      list.replaceChildren(...n.packages.map((pkg, i) => {
        const s = MDM.packageEditor.summary(pkg, n.service);
        return el('div', { class: 'list__item', 'data-testid': 'neworder-package', 'data-package-id': pkg.id },
          el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, (i + 1) + '. ' + s.title + (s.description ? ' · ' + s.description : '')),
            el('div', { class: 'list__meta' }, s.pickupLine + ' → ' + s.dropoffLine)),
          el('div', { class: 'list__aside' }, el('span', { class: 'mono' }, money(q.packages[i].price.lineTotal)),
            el('div', { class: 'row' },
              el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'neworder-package-edit', on: { click: () => openEditor(i) } }, 'Edit'),
              el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'neworder-package-remove', on: { click: () => { n.packages.splice(i, 1); cancelEditor(); renderPackages(); } } }, 'Remove'))));
      }));
      if (!n.packages.length) { list.replaceChildren(el('p', { class: 'muted small' }, 'No packages yet.')); estimate.replaceChildren(el('p', { class: 'muted small' }, 'Add a package to see the estimate.')); return; }
      const est = MDM.pricing.estimateRange(n.packages, settings, n.service);
      estimate.replaceChildren(el('div', { class: 'summary' },
        el('div', { class: 'summary__total' }, el('span', null, n.type === 'business' ? 'Business rate' : 'Estimated total'), el('span', { class: 'mono', 'data-testid': 'neworder-total' }, money(q.totals.total))),
        n.type !== 'business' ? el('p', { class: 'muted small' }, 'Range shown to the customer: ' + money(est.min) + (est.max !== est.min ? ' to ' + money(est.max) : '') + '. You confirm the exact price on the order.') : null));
    }
    // Schedule for advance orders
    const dateIn = el('input', { class: 'input', id: uid + '-date', type: 'date', value: n.schedule.date, min: dayKey(new Date()), 'data-testid': 'neworder-date' });
    const timeIn = el('input', { class: 'input', id: uid + '-time', type: 'time', value: n.schedule.time, 'data-testid': 'neworder-time' });
    const advBlock = el('div', { class: 'grid-2', hidden: true }, field(dateIn.id, 'Collection date', dateIn), field(timeIn.id, 'Collection time', timeIn));
    const sourceSeg = segmented(uid + '-source', SOURCES, n.source, 'neworder-source', v => { n.source = v; });
    const body = [
      sec('Customer', 'neworder-customer-section', el('div', { class: 'stack-4' },
        el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Order received by'), sourceSeg),
        el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Order for'), typeSeg), customerBlock, businessBlock)),
      sec('Request', 'neworder-request-section', el('div', { class: 'stack-4' },
        field(typeSel.id, 'Request type', typeSel), postalBlock, field(detailsIn.id, 'Request details', detailsIn, { optional: true }),
        el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Service level'), levelSeg), advBlock)),
      sec('Packages', 'neworder-packages-section', el('div', { class: 'stack-4' }, list, editorSlot, pkgError, addBtn)),
      sec('Estimate', 'neworder-estimate-section', estimate),
    ];
    const createBtn = el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'neworder-create', on: { click: () => act(createOrder) } }, 'Create order');
    const footer = [el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'neworder-cancel', on: { click: () => drawer.close() } }, 'Cancel'), createBtn];
    renderPackages();
    drawer.open({ title: 'New order', body, footer, size: 'lg', onClose: () => onDrawerClosed('new') });
    phoneIn.focus();

    async function createOrder() {
      if (!state.neworder) return;
      let ok = true, customer;
      const business = n.type === 'business';
      const acc = accounts.find(x => x.id === n.accountId);
      if (business) {
        if (!acc) { toast('Choose a business account', 'warn'); return; }
        customer = { name: acc.name, phone: acc.phone, email: acc.email || '', notify: 'whatsapp' };
      } else {
        if (!phone.valid(phoneIn.value)) { setError(phoneField, 'Enter a Maldivian mobile number, 7 digits starting with 7 or 9'); ok = false; }
        if (!trim(nameIn.value)) { setError(nameField, "Enter the customer's name"); ok = false; }
        customer = { name: trim(nameIn.value), phone: phone.normalize(phoneIn.value), email: trim(emailIn.value), notify };
      }
      if (n.editor) { if (n.editor.validate()) { const pkg = n.editor.getValue(); if (n.editing == null) n.packages.push(pkg); else n.packages[n.editing] = pkg; cancelEditor(); renderPackages(); } else ok = false; }
      if (!n.packages.length) { pkgError.textContent = 'Add at least 1 package'; pkgError.hidden = false; ok = false; }
      if (!ok) { MDM.ui.focusFirstInvalid(drawer.el()); return; }
      MDM.ui.setLoading(createBtn, true);
      try {
        const packages = n.packages.map(p => Object.assign({}, p, {
          pickup: p.pickup ? endpointCoords(p.pickup) : null, dropoff: endpointCoords(p.dropoff),
          shop: p.shop ? Object.assign({ receiptTotal: null, receiptPhotoId: null }, p.shop, MDM.geo.geocodeZone(p.shop.zone || 'male', p.shop.name)) : null,
          sizeSource: 'operator' }));
        const first = packages[0];
        const pick = first.shop ? { address: first.shop.name + (first.shop.address ? ', ' + first.shop.address : ''), zone: first.shop.zone || 'male', landmark: '', contact: { name: first.shop.name, phone: '' } } : first.pickup;
        const cust = business ? null : await MDM.store.upsertCustomer(customer);
        const details = {};
        if (n.requestType === 'postal') { details.carrier = carrierSel.value; if (trim(codeIn.value)) details[carrierSel.value === 'courier' || carrierSel.value === 'redbox_main' || carrierSel.value === 'dhl' ? 'trackingNo' : 'collectionCode'] = trim(codeIn.value); }
        if (trim(detailsIn.value)) details.notes = trim(detailsIn.value);
        const schedule = n.level === 'advance' ? { type: 'advance', collectDate: dateIn.value, collectTime: timeIn.value, deliverDate: dateIn.value, deliverTime: '' } : { type: 'asap' };
        const order = await MDM.store.createOrder({
          source: n.source, requestType: business ? 'home' : n.requestType, service: n.service, serviceLevel: n.level, accountId: business ? acc.id : null, customerId: cust ? cust.id : null, customer,
          collection: { address: pick.address, zone: pick.zone, landmark: pick.landmark || '', contactName: (pick.contact && pick.contact.name) || customer.name, contactPhone: (pick.contact && pick.contact.phone) || customer.phone, instructions: '' },
          delivery: { address: first.dropoff.address, zone: first.dropoff.zone, landmark: first.dropoff.landmark || '', recipientName: (first.dropoff.recipient && first.dropoff.recipient.name) || customer.name, recipientPhone: (first.dropoff.recipient && first.dropoff.recipient.phone) || customer.phone, instructions: first.dropoff.instructions || '', meetAt: first.dropoff.meetAt || 'door' },
          details, packages, schedule, by: by(),
          payment: business ? { method: 'invoice', status: 'invoiced' } : undefined, status: business ? 'confirmed' : undefined });
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
  MDM.admin.views.orders = {
    title: 'Orders',
    async mount(host, p) {
      state.host = host; state.alive = true; state.page = 0;
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
          el('p', { class: 'page-head__desc' }, 'Every order, newest first. Open one to confirm the price, verify payment, assign a driver or record a decision.'),
          el('div', { class: 'page-head__actions' }, el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'orders-new', on: { click: () => act(openNewOrder) } }, html(MDM.icon('plus', 16)), 'New order'))),
        state.slots.tabs,
        el('div', { class: 'orders-toolbar' }, el('div', { class: 'orders-filters' }, state.controls.el), state.slots.filtersBtn),
        state.slots.chips,
        state.slots.table);
      await render();
      const schedule = () => { clearTimeout(state.timer); state.timer = setTimeout(() => render().catch(() => {}), 40); };
      ['orders', 'drivers', 'files', 'notifications'].forEach(c => state.unsubs.push(MDM.store.subscribe(c, schedule)));
      state.unsubs.push(MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') { if (state.drawer.kind) { state.drawer.silent = true; drawer.close(); state.drawer.silent = false; } schedule(); } }));
      if (p.id) await openOrderDrawer(p.id);
    },
    async update(p) {
      state.filters = readFilters(p.query);
      state.page = 0;
      if (p.id) { if (state.drawer.kind !== 'order' || state.drawer.id !== p.id) await openOrderDrawer(p.id); }
      else if (state.drawer.kind === 'order') { state.drawer.silent = true; drawer.close(); state.drawer.silent = false; }
      await render();
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
  MDM.admin.openNewOrder = () => act(openNewOrder);
})(window.MDM);

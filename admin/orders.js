// Orders view (SPEC §3.7): filters kept in the hash query, the paginated table, the order drawer with every status action and the
// "New order" drawer. Every write goes through MDM.store's domain methods; nothing here pushes into events, stops, adjustments
// or notes directly. The drawer re-renders on store changes while open and keeps unsent textarea text.
(function (MDM) { 'use strict';
  const { el, html, toast, dialog, confirm, drawer, setError, phone, fmtDate, timeAgo, dayKey } = MDM.ui;
  const F = MDM.admin.fmt;
  const money = F.money;
  const PAGE = 25;
  const RANGES = [{ value: 'today', label: 'Today' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: 'all', label: 'All' }];
  const SERVICES = [{ value: 'pick', label: 'Pick & deliver' }, { value: 'shop', label: 'Shop & deliver' }, { value: 'business', label: 'Business' }];
  const SOURCES = [{ value: 'web', label: 'Web' }, { value: 'viber', label: 'Viber' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'phone', label: 'Phone' }, { value: 'walkin', label: 'Walk-in' }];
  const NOTIFY = [{ value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'viber', label: 'Viber' }];
  const BANKS_OTHER = { value: 'other', label: 'Other bank' };
  const state = {
    host: null, alive: false, unsubs: [], timer: null, filters: {}, page: 0, controls: null, slots: {}, settings: null,
    drawer: { kind: null, id: null, silent: false, received: {}, noteDraft: {}, assignChoice: {}, urls: {}, order: null },
    neworder: null,
  };
  const trim = v => String(v == null ? '' : v).trim();
  const plural = F.plural;

  // ---- Filters ------------------------------------------------------------------------------------------------------------
  function readFilters(q) {
    const f = { status: q.get('status') || '', service: q.get('service') || '', zone: q.get('zone') || '', range: q.get('range') || 'all', q: q.get('q') || '', customer: q.get('customer') || '', account: q.get('account') || '' };
    if (f.status && !MDM.STATUS[f.status]) f.status = '';
    if (f.service && !F.SERVICE[f.service]) f.service = '';
    if (!RANGES.some(r => r.value === f.range)) f.range = 'all';
    return f;
  }
  function setFilters(patch) {
    Object.assign(state.filters, patch);
    state.page = 0;
    const q = {};
    Object.keys(state.filters).forEach(k => { q[k] = k === 'range' && state.filters.range === 'all' ? null : state.filters[k]; });
    MDM.admin.setQuery(q);
    render().catch(() => {});
  }
  function clearFilters() { setFilters({ status: '', service: '', zone: '', range: 'all', q: '', customer: '', account: '' }); }
  function activeCount() { const f = state.filters; return ['status', 'service', 'zone', 'q', 'customer', 'account'].filter(k => f[k]).length + (f.range !== 'all' ? 1 : 0); }
  function zonesOf(pkg, service) {
    const z = [];
    if (service === 'shop' && pkg.shop) z.push(pkg.shop.zone); else if (pkg.pickup) z.push(pkg.pickup.zone);
    if (pkg.dropoff) z.push(pkg.dropoff.zone);
    return z;
  }
  function matchesQ(o, q) {
    const s = q.toLowerCase().replace(/\s+/g, '');
    const code = String(o.code || '').toLowerCase().replace('-', '');
    const name = (o.customer && o.customer.name || '').toLowerCase().replace(/\s+/g, '');
    const ph = (o.customer && o.customer.phone || '').replace(/\D/g, '');
    const digits = s.replace(/\D/g, '');
    return code.indexOf(s.replace('-', '')) >= 0 || name.indexOf(s) >= 0 || (digits.length >= 3 && ph.indexOf(digits) >= 0);
  }
  function applyFilters(orders) {
    const f = state.filters, now = Date.now(), today = dayKey(new Date());
    const since = f.range === '7d' ? now - 7 * 864e5 : f.range === '30d' ? now - 30 * 864e5 : null;
    return orders.filter(o => {
      if (o.status === 'draft' && f.status !== 'draft') return false;
      if (f.status && o.status !== f.status) return false;
      if (f.service && o.service !== f.service) return false;
      if (f.zone && !(o.packages || []).some(p => zonesOf(p, o.service).indexOf(f.zone) >= 0)) return false;
      if (f.range === 'today' && dayKey(o.createdAt) !== today) return false;
      if (since && new Date(o.createdAt).getTime() < since) return false;
      if (f.customer && o.customerId !== f.customer) return false;
      if (f.account && o.accountId !== f.account) return false;
      if (f.q && !matchesQ(o, f.q)) return false;
      return true;
    });
  }
  // One set of filter controls; built once for the desktop row and again for the mobile drawer (radio names differ, test ids match).
  function buildControls(radioName) {
    const opt = (value, label) => el('option', { value }, label);
    const status = el('select', { class: 'select', 'aria-label': 'Status', 'data-testid': 'orders-filter-status' }, opt('', 'All statuses'), Object.keys(MDM.STATUS).map(k => opt(k, MDM.STATUS[k].label)));
    const service = el('select', { class: 'select', 'aria-label': 'Service', 'data-testid': 'orders-filter-service' }, opt('', 'All services'), SERVICES.map(s => opt(s.value, s.label)));
    const zone = el('select', { class: 'select', 'aria-label': 'Zone', 'data-testid': 'orders-filter-zone' }, opt('', 'All zones'), MDM.geo.zoneOptions().map(z => opt(z.value, z.label)));
    const range = el('fieldset', { class: 'segmented', 'aria-label': 'Created', 'data-testid': 'orders-filter-range' },
      RANGES.map(r => el('label', { class: 'segmented__option', 'data-testid': 'orders-filter-range-' + r.value }, el('input', { class: 'sr-only', type: 'radio', name: radioName, value: r.value }), el('span', null, r.label))));
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Code, name or phone', 'aria-label': 'Search orders', autocomplete: 'off', 'data-testid': 'orders-search' });
    status.addEventListener('change', () => setFilters({ status: status.value }));
    service.addEventListener('change', () => setFilters({ service: service.value }));
    zone.addEventListener('change', () => setFilters({ zone: zone.value }));
    range.addEventListener('change', () => { const c = range.querySelector('input:checked'); setFilters({ range: c ? c.value : 'all' }); });
    const deb = MDM.ui.debounce(() => setFilters({ q: trim(search.value) }), 250);
    search.addEventListener('input', deb);
    search.addEventListener('search', () => { deb.cancel(); setFilters({ q: trim(search.value) }); });
    const node = el('div', { class: 'filters' }, status, service, zone, range, search);
    function sync() {
      const f = state.filters;
      status.value = f.status; service.value = f.service; zone.value = f.zone;
      const r = range.querySelector('input[value="' + f.range + '"]'); if (r) r.checked = true;
      if (document.activeElement !== search) search.value = f.q;
    }
    sync();
    return { el: node, sync };
  }
  function openFiltersDrawer() {
    const controls = buildControls('orders-mrange');
    const body = el('div', { class: 'drawer__section' }, el('h3', null, 'Show orders that match'), controls.el);
    state.drawer.kind = 'filters';
    drawer.open({ title: 'Filters', body, size: 'md', onClose: () => { if (state.drawer.kind === 'filters') state.drawer.kind = null; },
      footer: [el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'orders-clear', on: { click: () => { clearFilters(); controls.sync(); } } }, 'Clear filters'),
        el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'orders-filters-done', on: { click: () => drawer.close() } }, 'Show orders')] });
  }
  function chips(ctx) {
    const f = state.filters, out = [];
    const chip = (key, label) => el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'orders-chip', 'data-filter': key, on: { click: () => { const p = {}; p[key] = key === 'range' ? 'all' : ''; setFilters(p); } } },
      label, html(MDM.icon('x', 16)), el('span', { class: 'sr-only' }, ', remove this filter'));
    if (f.status) out.push(chip('status', 'Status: ' + MDM.STATUS[f.status].label));
    if (f.service) out.push(chip('service', 'Service: ' + F.SERVICE[f.service]));
    if (f.zone) out.push(chip('zone', 'Zone: ' + MDM.geo.zoneLabel(f.zone)));
    if (f.range !== 'all') out.push(chip('range', 'Created: ' + (RANGES.find(r => r.value === f.range) || {}).label));
    if (f.q) out.push(chip('q', 'Search: ' + f.q));
    if (f.customer) out.push(chip('customer', 'Customer: ' + (ctx.customer ? ctx.customer.name : f.customer)));
    if (f.account) out.push(chip('account', 'Account: ' + (ctx.account ? ctx.account.name : f.account)));
    if (out.length) out.push(el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'orders-clear', on: { click: clearFilters } }, 'Clear filters'));
    return out;
  }

  // ---- List -----------------------------------------------------------------------------------------------------------------
  async function render() {
    if (!state.alive) return;
    const f = state.filters;
    const [orders, drivers, customer, account, settings] = await Promise.all([
      MDM.store.list('orders'), MDM.store.list('drivers'),
      f.customer ? MDM.store.get('customers', f.customer) : null, f.account ? MDM.store.get('business_accounts', f.account) : null,
      MDM.store.settings()]);
    if (!state.alive) return;
    state.settings = settings;
    const rows = applyFilters(orders);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (state.page >= pages) state.page = pages - 1;
    const from = state.page * PAGE, slice = rows.slice(from, from + PAGE);
    state.controls.sync();
    state.slots.chips.replaceChildren(...chips({ customer, account }));
    const n = activeCount();
    state.slots.filtersBtn.replaceChildren(html(MDM.icon('filter', 16)), n ? 'Filters · ' + n : 'Filters');
    const cols = F.columns;
    if (!slice.length) {
      state.slots.table.replaceChildren(F.emptyBlock('No orders match these filters.', 'Try a wider date range or clear a filter.',
        el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'orders-empty-clear', on: { click: clearFilters } }, 'Clear filters')));
    } else {
      const prev = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'orders-prev', disabled: state.page === 0, on: { click: () => { state.page -= 1; render(); } } }, 'Previous');
      const next = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'orders-next', disabled: state.page >= pages - 1, on: { click: () => { state.page += 1; render(); } } }, 'Next');
      state.slots.table.replaceChildren(
        el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack', 'data-testid': 'orders-table' }, F.orderTableHead(cols), el('tbody', null, slice.map(o => F.orderRow(o, cols, { drivers }))))),
        el('div', { class: 'pagination', 'data-testid': 'orders-pagination' },
          el('span', null, 'Showing ' + (from + 1) + ' to ' + (from + slice.length) + ' of ' + rows.length),
          el('div', { class: 'pagination__actions' }, prev, next)));
    }
    if (state.drawer.kind === 'order' && state.drawer.id) await renderOrderDrawer();
  }

  // ---- Drawer building blocks ---------------------------------------------------------------------------------------------
  const sec = (title, testid, ...children) => el('div', { class: 'drawer__section', 'data-testid': testid }, el('h3', null, title), children);
  const row = (label, value, opts) => (value == null || value === '') ? null : el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, label), el('div', { class: 'rate-table__value' + (opts && opts.mono ? ' mono' : '') }, value));
  const rowNode = (label, node) => el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, label), node);
  const badgeNode = (kind, label, attrs) => html(MDM.ui.badge(kind, label, attrs));
  function scheduleText(o) {
    const s = o.schedule || {};
    if (s.type !== 'slot') return 'ASAP';
    return fmtDate(s.date + 'T00:00:00', { dateOnly: true }) + ', ' + MDM.ui.window(s.window || '');
  }
  function bankName(id) {
    const b = ((state.settings || {}).banks || []).find(x => x.id === id);
    return b ? b.name : (id === 'other' ? 'Other bank' : (id || ''));
  }
  function thumbButton(file, label) {
    if (!file || !/^image\//.test(file.type || '')) return null;
    return el('button', { type: 'button', class: 'thumb-btn', 'data-testid': 'drawer-photo', 'aria-label': 'Open ' + label, on: { click: () => showImage(file.dataUrl, label) } }, el('img', { class: 'thumb', src: file.dataUrl, alt: '' }));
  }
  function showImage(src, title) {
    const dlg = el('dialog', { class: 'dialog dialog--wide', 'data-testid': 'image-dialog', 'aria-label': title });
    dlg.append(el('div', { class: 'dialog__body' }, el('img', { src, alt: title })),
      el('div', { class: 'dialog__footer' }, el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'image-dialog-close', on: { click: () => dlg.close() } }, 'Close')));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  async function objectUrlFor(file) {
    if (state.drawer.urls[file.id]) return state.drawer.urls[file.id];
    const blob = await (await fetch(file.dataUrl)).blob();
    const url = URL.createObjectURL(blob);
    state.drawer.urls[file.id] = url;
    return url;
  }
  function revokeUrls() { Object.keys(state.drawer.urls).forEach(k => URL.revokeObjectURL(state.drawer.urls[k])); state.drawer.urls = {}; }
  function packageSummary(pkg, service) {
    if (MDM.packageEditor && typeof MDM.packageEditor.summary === 'function') return MDM.packageEditor.summary(pkg, service);
    const flags = []; if (pkg.fragile) flags.push('Fragile'); if (pkg.needsVehicle) flags.push('Vehicle'); if (service === 'business' && pkg.underOneFt === false) flags.push('Over 1 ft');
    const from = service === 'shop' && pkg.shop ? 'Shop: ' + pkg.shop.name : (pkg.pickup ? pkg.pickup.address : '');
    return { title: MDM.pricing.lineLabel(pkg, service), description: pkg.description || '', pickupLine: from, pickupZone: MDM.geo.zoneLabel(service === 'shop' && pkg.shop ? pkg.shop.zone : (pkg.pickup ? pkg.pickup.zone : 'male')), dropoffLine: pkg.dropoff ? pkg.dropoff.address : '', dropoffZone: MDM.geo.zoneLabel(pkg.dropoff ? pkg.dropoff.zone : 'male'), flags };
  }
  function person(p) { return p && (p.name || p.phone) ? trim(p.name) + (p.phone ? ' ' + phone.format(p.phone) : '') : ''; }
  // The summary leaves the zone empty for an airport endpoint (the airport line already names it): no empty "()" then.
  const zoneSuffix = v => v ? ' (' + v + ')' : '';
  const legText = s => s.pickupLine + zoneSuffix(s.pickupZone) + ' → ' + s.dropoffLine + zoneSuffix(s.dropoffZone);

  // ---- Drawer sections -------------------------------------------------------------------------------------------------------
  function customerSection(o, ctx) {
    const c = o.customer || {};
    const links = phone.links(c.phone);
    const phoneNode = el('div', { class: 'rate-table__value' }, el('span', { class: 'mono' }, phone.format(c.phone)),
      links ? el('small', { class: 'contact-links' },
        el('a', { href: links.tel, 'data-testid': 'drawer-tel' }, 'Call'), ' · ',
        el('a', { href: links.wa, target: '_blank', rel: 'noopener', 'data-testid': 'drawer-wa' }, 'WhatsApp'), ' · ',
        el('a', { href: links.viber, 'data-testid': 'drawer-viber' }, 'Viber')) : null);
    return sec('Customer', 'drawer-customer', el('div', { class: 'rate-table' },
      row('Name', c.name),
      rowNode('Phone', phoneNode),
      row('Email', c.email),
      row('Notify by', F.NOTIFY[c.notify] || c.notify),
      row('Source', F.SOURCE[o.source] || o.source),
      o.accountId ? rowNode('Business account', el('div', { class: 'rate-table__value' }, el('a', { href: '#/business/' + encodeURIComponent(o.accountId) }, ctx.account ? ctx.account.name : 'View account'))) : null,
      row('Schedule', scheduleText(o))));
  }
  function packagesSection(o) {
    const items = (o.packages || []).map((pkg, i) => {
      const s = packageSummary(pkg, o.service);
      const lines = [];
      if (o.service === 'shop' && pkg.shop) {
        lines.push('Shop: ' + pkg.shop.name + (pkg.shop.address ? ', ' + pkg.shop.address : '') + zoneSuffix(s.pickupZone) + ' → ' + s.dropoffLine + zoneSuffix(s.dropoffZone));
        if (pkg.shop.list) lines.push('List: ' + pkg.shop.list);
        lines.push('Budget ' + money(pkg.shop.budget) + ' · if unavailable: ' + ({ call: 'call the customer', skip: 'skip it', closest: 'buy the closest match' }[pkg.shop.unavailable] || pkg.shop.unavailable) + (pkg.shop.receiptTotal ? ' · receipt ' + money(pkg.shop.receiptTotal) : ''));
      } else {
        lines.push(legText(s));
        const contact = person(pkg.pickup && pkg.pickup.contact), recipient = person(pkg.dropoff && pkg.dropoff.recipient);
        if (contact || recipient) lines.push([contact ? 'From ' + contact : null, recipient ? 'to ' + recipient : null].filter(Boolean).join(' · '));
      }
      const extras = [];
      if (pkg.pickup && pkg.pickup.landmark) extras.push('Pickup: ' + pkg.pickup.landmark);
      if (pkg.dropoff && pkg.dropoff.landmark) extras.push('Drop-off: ' + pkg.dropoff.landmark);
      if (pkg.dropoff && pkg.dropoff.meetAt && pkg.dropoff.zone !== 'airport') { const m = MDM.geo.meetAtOptions().find(x => x.value === pkg.dropoff.meetAt); if (m) extras.push('Meet at: ' + m.label); }
      if (pkg.notes) extras.push('Notes: ' + pkg.notes);
      return el('div', { class: 'list__item', 'data-testid': 'drawer-package', 'data-package-id': pkg.id },
        el('div', { class: 'list__main' },
          el('div', { class: 'list__title' }, (i + 1) + '. ' + s.title + (s.description ? ' · ' + s.description : '')),
          lines.map(l => el('div', { class: 'list__meta' }, l)),
          extras.length ? el('div', { class: 'list__meta' }, extras.join(' · ')) : null,
          s.flags.length ? el('div', { class: 'tags' }, s.flags.map(f => el('span', { class: 'tag' }, f))) : null),
        el('div', { class: 'list__aside mono' }, money(pkg.price ? pkg.price.lineTotal : 0)));
    });
    return sec('Packages', 'drawer-packages', el('div', { class: 'list' }, items));
  }
  function routeSection(o, ctx) {
    const stops = (o.route && o.route.stops) || [];
    if (!stops.length) return sec('Route', 'drawer-route', el('p', { class: 'muted small' }, o.status === 'confirmed' ? 'Stops are built when a rider is assigned.' : 'No route for this order yet.'));
    const currentId = MDM.ACTIVE_STATUSES.indexOf(o.status) >= 0 ? (stops.find(s => s.status === 'pending' || s.status === 'arrived') || {}).id : null;
    const items = stops.map((s, i) => {
      const cls = ['stop', s.type === 'pickup' ? 'stop--pickup' : s.type === 'return' ? 'stop--return' : null, s.status === 'done' ? 'is-done' : s.status === 'failed' ? 'is-failed' : (s.id === currentId ? 'is-current' : null)];
      const meta = [MDM.geo.zoneLabel(s.zone)];
      if (s.contact && (s.contact.name || s.contact.phone)) meta.push(person(s.contact));
      if (s.landmark) meta.push(s.landmark);
      if (s.status === 'done' && s.type !== 'pickup') { const h = MDM.HANDED_TO.find(x => x.value === s.handedTo); meta.push('Handed to ' + (s.recipientName ? s.recipientName : '') + (h && h.value !== 'recipient' ? ' (' + h.label.toLowerCase() + ')' : '')); }
      if (s.status === 'done' && s.receiptTotal != null) meta.push('Receipt ' + money(s.receiptTotal));
      if (s.status === 'failed') { const r = MDM.FAIL_REASONS.find(x => x.value === s.failReason); meta.push((r ? r.label : 'Could not complete') + (s.note ? ': ' + s.note : '')); }
      if (s.attempts > 1) meta.push('Attempt ' + s.attempts);
      const aside = s.status === 'done' ? fmtDate(s.at) : s.status === 'failed' ? 'Failed ' + fmtDate(s.failedAt) : s.status === 'arrived' ? 'Arrived ' + fmtDate(s.arrivedAt) : 'Pending';
      const photos = [thumbButton(ctx.fileById[s.photoId], 'proof photo for ' + s.label.toLowerCase()), thumbButton(ctx.fileById[s.receiptPhotoId], 'receipt photo')].filter(Boolean);
      return el('div', { class: cls, 'data-testid': 'drawer-stop', 'data-stop-id': s.id, 'data-status': s.status },
        el('div', { class: 'stop__marker' }, s.status === 'done' ? html(MDM.icon('check', 14)) : String(i + 1)),
        el('div', null, el('div', { class: 'stop__title' }, s.label + ' · ' + s.address), el('div', { class: 'stop__meta' }, meta.join(' · ')), photos.length ? el('div', { class: 'thumbs' }, photos) : null),
        el('div', { class: 'stop__aside' }, aside));
    });
    return sec('Route', 'drawer-route', el('div', { class: 'stops' }, items));
  }
  function pricingSection(o) {
    const t = o.totals || {};
    const lines = (o.packages || []).map(pkg => el('div', { class: 'summary__line' },
      el('div', { class: 'summary__desc' }, MDM.pricing.lineLabel(pkg, o.service), pkg.description ? el('span', { class: 'summary__sub' }, pkg.description) : null),
      el('div', { class: 'summary__amount mono' }, money(pkg.price ? pkg.price.lineTotal : 0))));
    if (o.service === 'shop' && t.budget) {
      const receipt = (o.packages || []).some(p => p.shop && p.shop.receiptTotal);
      lines.push(el('div', { class: 'summary__line' }, el('div', { class: 'summary__desc' }, receipt ? 'Receipt total' : 'Shopping budget (paid up front)'), el('div', { class: 'summary__amount mono' }, money(t.budget))));
    }
    MDM.pricing.feeLines(o, state.settings).forEach(f => lines.push(el('div', { class: 'summary__line summary__line--fee', 'data-testid': f.key === 'adjustment' ? 'drawer-adjustment' : null },
      el('div', { class: 'summary__desc' }, f.label, f.reason ? el('span', { class: 'summary__sub' }, f.reason) : null), el('div', { class: 'summary__amount mono' }, money(f.amount)))));
    const summary = el('div', { class: 'summary', 'data-testid': 'drawer-summary' }, lines, el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, t.quoteRequired ? 'Estimated total' : 'Total'), el('span', { class: 'mono', 'data-testid': 'drawer-total' }, money(t.total))));
    const reasons = t.quoteRequired && (t.quoteReasons || []).length ? el('div', { class: 'alert alert--warn' }, html(MDM.icon('alert-triangle', 16)),
      el('div', { class: 'alert__body' }, el('div', { class: 'alert__title' }, 'Quote needed before pickup'), (t.quoteReasons || []).map(r => el('div', null, MDM.pricing.reasonText(r))))) : null;
    const canAdjust = o.status !== 'cancelled' && o.status !== 'returned';
    const add = canAdjust ? el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'drawer-add-adjustment', on: { click: () => act(() => addAdjustment(o)) } }, html(MDM.icon('plus', 16)), 'Add adjustment') : null;
    return sec('Pricing', 'drawer-pricing', el('div', { class: 'stack-3' }, summary, reasons, add));
  }
  // For shop orders the customer pays budget + fee + delivery up front (SPEC §1); the receipt later re-derives totals.total and the
  // difference lives in Settlement. The declared transfer is compared against the budget-based amount, via MDM.pricing.recalc.
  function amountDueAtPayment(o) {
    const hasReceipt = o.service === 'shop' && (o.packages || []).some(p => p.shop && p.shop.receiptTotal > 0);
    if (!hasReceipt) return o.totals.total;
    const clone = JSON.parse(JSON.stringify(o));
    clone.packages.forEach(p => { if (p.shop) p.shop.receiptTotal = null; });
    return MDM.pricing.recalc(clone, state.settings || {}).totals.total;
  }
  function paymentSection(o, ctx) {
    const p = o.payment || {};
    const rows = [];
    const pd = F.PAYMENT[p.status] || ['neutral', p.status || 'Unpaid'];
    rows.push(rowNode('Status', el('div', { class: 'rate-table__value' }, badgeNode(pd[0], pd[1], { 'data-status': p.status || 'unpaid', 'data-testid': 'drawer-payment-status' }))));
    if (p.method === 'invoice') {
      rows.push(row('Method', 'Monthly invoice'));
      rows.push(row('Amount', money(o.totals.total), { mono: true }));
      return sec('Payment', 'drawer-payment', el('div', { class: 'rate-table' }, rows));
    }
    rows.push(row('Method', 'Bank transfer'));
    const due = amountDueAtPayment(o);
    const changed = due !== o.totals.total;
    if (p.paidAmount != null) {
      const ok = Math.round(Number(p.paidAmount)) === Math.round(Number(due));
      rows.push(rowNode('Amount declared', el('div', { class: 'rate-table__value' }, el('span', { class: 'mono' }, money(p.paidAmount)), ' ',
        badgeNode(ok ? 'ok' : 'danger', ok ? 'Matches' : 'Does not match', { 'data-status': ok ? 'match' : 'mismatch', 'data-testid': 'drawer-payment-match' }),
        el('small', null, changed ? 'Due at checkout ' + money(due) + ' · the receipt changed the total, balance handled in Settlement' : 'Order total ' + money(o.totals.total)))));
    } else rows.push(row('Amount due', money(due), { mono: true }));
    rows.push(row('Reference', p.reference, { mono: true }));
    rows.push(row('Paid from', bankName(p.bank)));
    rows.push(row('Account holder', p.payerName));
    if (p.submittedAt) rows.push(row('Submitted', fmtDate(p.submittedAt)));
    const slip = p.slip && ctx.fileById[p.slip.fileId];
    if (p.slip) {
      let node;
      if (slip && /^image\//.test(slip.type || '')) node = el('div', { class: 'rate-table__value slip' },
        el('button', { type: 'button', class: 'thumb-btn', 'data-testid': 'drawer-slip-thumb', 'aria-label': 'Open the transfer slip', on: { click: () => showImage(slip.dataUrl, 'Transfer slip ' + o.code) } }, el('img', { class: 'thumb', src: slip.dataUrl, alt: '' })),
        el('small', null, p.slip.name + ' · ' + MDM.ui.formatBytes(p.slip.size)));
      else if (slip && ctx.slipUrl) node = el('div', { class: 'rate-table__value' }, el('a', { href: ctx.slipUrl, target: '_blank', rel: 'noopener', 'data-testid': 'drawer-slip-open' }, 'Open PDF'), el('small', null, p.slip.name + ' · ' + MDM.ui.formatBytes(p.slip.size)));
      else node = el('div', { class: 'rate-table__value' }, p.slip.name, el('small', null, 'File missing from this browser'));
      rows.push(rowNode('Transfer slip', node));
    }
    if (p.status === 'verified') rows.push(row('Verified', fmtDate(p.verifiedAt) + (p.verifiedBy ? ' by ' + F.byLabel(p.verifiedBy, ctx.drivers) : '')));
    if (p.note) rows.push(row('Note', p.note));
    if (p.status === 'rejected') rows.push(row('Rejected', (p.rejectedAt ? fmtDate(p.rejectedAt) + ' · ' : '') + (p.rejectReason || '')));
    if (p.refund) rows.push(rowNode('Refund', el('div', { class: 'rate-table__value' }, el('span', { class: 'mono' }, money(p.refund.amount)), el('small', null, [bankName(p.refund.toBank), p.refund.toAccount, p.refund.reference].filter(Boolean).join(' · ') + ' · ' + fmtDate(p.refund.at)))));
    const children = [el('div', { class: 'rate-table' }, rows)];
    if (o.status === 'payment_review') {
      const cb = el('input', { type: 'checkbox', 'data-testid': 'drawer-verify-received', checked: !!state.drawer.received[o.id], on: { change: e => { state.drawer.received[o.id] = e.target.checked; if (ctx.verifyBtn) ctx.verifyBtn.disabled = !e.target.checked; } } });
      children.push(el('label', { class: 'checkbox' }, cb, el('span', null, 'Amount received in our account', el('span', { class: 'hint' }, 'Check the bank statement before verifying'))));
    }
    return sec('Payment', 'drawer-payment', children);
  }
  function quoteSection(o) {
    const q = o.quote || {};
    if (!q.status || q.status === 'none') return null;
    return sec('Quote', 'drawer-quote', el('div', { class: 'rate-table' },
      rowNode('Status', el('div', { class: 'rate-table__value' }, badgeNode(q.status === 'sent' ? 'ok' : 'warn', q.status === 'sent' ? 'Sent' : 'Pending', { 'data-status': 'quote_' + q.status }))),
      q.total != null ? row('Quoted total', money(q.total), { mono: true }) : null,
      row('Note', q.note),
      q.sentAt ? row('Sent', fmtDate(q.sentAt)) : null));
  }
  function settlementSection(o) {
    const s = o.settlement;
    if (o.service !== 'shop' || !s) return null;
    const label = { refund_due: 'We owe the customer', topup_due: 'The customer owes us', settled: 'Settled', none: 'Nothing due' }[s.status] || s.status;
    return sec('Settlement', 'drawer-settlement', el('div', { class: 'rate-table' },
      rowNode('Status', el('div', { class: 'rate-table__value' }, badgeNode(s.status === 'settled' ? 'ok' : 'warn', label, { 'data-status': 'settlement_' + s.status }))),
      row('Paid up front', money(s.paid), { mono: true }),
      row('Final amount', money(s.due), { mono: true }),
      row('Balance', money(Math.abs(s.balance)) + (s.balance > 0 ? ' to refund' : s.balance < 0 ? ' to collect' : ''), { mono: true }),
      s.settledAt ? row('Settled', fmtDate(s.settledAt) + (s.reference ? ' · ' + s.reference : '')) : null));
  }
  function notesSection(o, ctx) {
    const items = (o.notes || []).slice().reverse().map(n => el('div', { class: 'list__item', 'data-testid': 'drawer-note-item' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title wrap-anywhere' }, n.text), el('div', { class: 'list__meta' }, F.byLabel(n.by, ctx.drivers) + ' · ' + fmtDate(n.at)))));
    const ta = el('textarea', { class: 'textarea', id: 'drawer-note', rows: 2, placeholder: 'Only the team sees notes', 'data-testid': 'drawer-note', value: state.drawer.noteDraft[o.id] || '', on: { input: e => { state.drawer.noteDraft[o.id] = e.target.value; } } });
    const btn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'drawer-add-note', on: { click: () => act(async () => {
      const text = trim(ta.value); if (!text) { setError(ta.closest('.field'), 'Type the note first'); ta.focus(); return; }
      delete state.drawer.noteDraft[o.id]; ta.value = '';
      await MDM.store.addNote(o.id, { text, by: 'admin' }); toast('Note added', 'ok');
    }) } }, 'Add note');
    return sec('Notes', 'drawer-notes',
      items.length ? el('div', { class: 'list' }, items) : el('p', { class: 'muted small' }, 'No notes yet.'),
      el('div', { class: 'field', style: { marginTop: '12px' } }, el('label', { for: 'drawer-note' }, 'Add note'), ta),
      el('div', { class: 'row', style: { marginTop: '8px' } }, btn));
  }
  function activitySection(o, ctx) {
    const events = (o.events || []).slice().sort((a, b) => (a.at || '') < (b.at || '') ? -1 : 1);
    if (!events.length) return sec('Activity', 'drawer-activity', el('p', { class: 'muted small' }, 'No activity yet.'));
    const items = events.map((e, i) => el('div', { class: 'timeline__item ' + (i === events.length - 1 ? 'is-current' : 'is-done'), 'data-testid': 'drawer-event', 'data-type': e.type, 'data-visibility': e.visibility },
      el('div', { class: 'timeline__label' }, e.label, e.visibility === 'internal' ? el('span', { class: 'timeline__flag' }, 'Internal') : null),
      el('div', { class: 'timeline__time' }, fmtDate(e.at) + ' · ' + F.byLabel(e.by, ctx.drivers))));
    return sec('Activity', 'drawer-activity', el('div', { class: 'timeline' }, items));
  }

  // ---- Drawer footer (status-gated actions) --------------------------------------------------------------------------------
  function btn(label, testid, cls, fn, attrs) {
    return el('button', Object.assign({ type: 'button', class: 'btn ' + cls, 'data-testid': testid, on: { click: () => act(fn) } }, attrs || {}), label);
  }
  function footerFor(o, ctx) {
    const st = o.status, items = [];
    const cancelBtn = label => btn(label || 'Cancel order', 'drawer-cancel', 'btn--ghost', () => cancelOrder(o));
    if (st === 'quote_pending') items.push(cancelBtn(), btn('Send quote', 'drawer-send-quote', 'btn--primary', () => sendQuote(o)));
    else if (st === 'awaiting_payment') items.push(cancelBtn('Cancel unpaid order'), btn('Mark as paid', 'drawer-mark-paid', 'btn--primary', () => markPaid(o)));
    else if (st === 'payment_review') {
      ctx.verifyBtn = btn('Verify payment', 'drawer-verify', 'btn--primary', () => verify(o), { disabled: !state.drawer.received[o.id] });
      items.push(btn('Reject', 'drawer-reject', 'btn--secondary', () => reject(o)), ctx.verifyBtn);
    } else if (st === 'confirmed') {
      // The footer is rebuilt on every store write while the drawer is open; the admin's pending choice survives the rebuild.
      const sel = driverSelect(ctx.drivers, 'drawer-assign-driver', null, state.drawer.assignChoice[o.id]);
      sel.addEventListener('change', () => { state.drawer.assignChoice[o.id] = sel.value; });
      items.push(cancelBtn(), sel, btn('Assign rider', 'drawer-assign', 'btn--primary', () => assign(o, sel.value)));
    } else if (st === 'assigned') items.push(btn('Reassign', 'drawer-reassign', 'btn--secondary', () => reassign(o, ctx.drivers)), cancelBtn(), btn('Mark picked up', 'drawer-pickup', 'btn--primary', () => markPickedUp(o)));
    else if (st === 'picked_up' || st === 'in_transit') {
      if ((o.route && o.route.stops || []).some(s => s.type === 'pickup' && s.status !== 'done')) items.push(btn('Mark picked up', 'drawer-pickup', 'btn--secondary', () => markPickedUp(o)));
      items.push(btn('Mark delivered', 'drawer-deliver', 'btn--primary', () => markDelivered(o, ctx)));
    } else if (st === 'on_hold') items.push(cancelBtn(), btn('Return to sender', 'drawer-return', 'btn--secondary', () => returnToSender(o)), btn('Retry stop', 'drawer-retry', 'btn--primary', () => retryStop(o)));
    else if (st === 'delivered') { if (o.service === 'shop' && o.settlement && o.settlement.status !== 'settled' && o.settlement.balance !== 0) items.push(btn('Mark settled', 'drawer-settle', 'btn--primary', () => markSettled(o))); }
    else if (st === 'cancelled') { if (o.payment && o.payment.status === 'verified' && !o.payment.refund) items.push(btn('Record refund', 'drawer-refund', 'btn--primary', () => recordRefund(o))); }
    if (['delivered', 'cancelled', 'returned'].indexOf(st) < 0) items.unshift(btn('Send update', 'drawer-send-update', 'btn--secondary', () => sendUpdate(o, statusMessage(o))));
    return items;
  }
  // driverSelect(drivers, testid, current, chosen): online riders first; `chosen` (a rider picked before a re-render) wins over the default.
  function driverSelect(drivers, testid, current, chosen) {
    const sorted = drivers.slice().sort((a, b) => (a.status === 'offline') - (b.status === 'offline') || a.name.localeCompare(b.name));
    const sel = el('select', { class: 'select', 'aria-label': 'Rider', 'data-testid': testid },
      sorted.map(d => el('option', { value: d.id, disabled: d.id === current }, d.name + (d.status === 'offline' ? ' (offline)' : d.status === 'on_route' ? ' (on route)' : ''))));
    const first = sorted.find(d => d.id !== current); if (first) sel.value = first.id;
    if (chosen && chosen !== current && sorted.some(d => d.id === chosen)) sel.value = chosen;
    return sel;
  }

  // ---- Actions ------------------------------------------------------------------------------------------------------------
  async function act(fn) {
    try { await fn(); }
    catch (e) { toast(e && e.message ? e.message : 'Something went wrong', 'danger'); }
  }
  function statusMessage(o) { return 'Mr. Delivery Man: order ' + o.code + ' is ' + MDM.STATUS[o.status].customer.toLowerCase() + '. Track: ' + MDM.href('track/?order=' + encodeURIComponent(o.id)); }
  function quoteMessage(o) { return 'Mr. Delivery Man: your quote for ' + o.code + ' is ' + money(o.totals.total) + '. Pay by bank transfer here: ' + MDM.href('checkout/?order=' + encodeURIComponent(o.id)); }
  function openExternal(href) { const a = el('a', { href, target: '_blank', rel: 'noopener', class: 'sr-only' }, 'Open'); document.body.appendChild(a); a.click(); a.remove(); }
  async function sendUpdate(o, text) {
    const c = o.customer || {};
    const links = phone.links(c.phone, text);
    if (!links) { toast('This order has no phone number to message', 'warn'); return; }
    const ch = c.notify === 'viber' ? 'viber' : c.notify === 'sms' ? 'sms' : 'whatsapp';
    if (ch === 'viber') { await MDM.ui.copy(text); toast('Message copied. Paste it into the Viber chat.', 'ok'); }
    openExternal(ch === 'viber' ? links.viber : ch === 'sms' ? links.sms : links.wa);
    await MDM.store.addEvent(o.id, { type: 'update_sent', label: 'Update sent via ' + F.NOTIFY[ch], by: 'admin', visibility: 'internal' });
  }
  async function sendQuote(o) {
    const c = o.customer || {};
    const v = await dialog({ title: 'Send quote for ' + o.code, message: 'The customer gets the final price and pays by transfer before pickup.', okLabel: 'Send quote',
      fields: [
        { name: 'total', label: 'Final total (MVR)', type: 'number', required: true, value: o.totals.total, min: 0, step: 1, hint: 'Estimated ' + money(o.totals.total) + '. The difference is recorded as a quote adjustment.' },
        { name: 'note', label: 'Note to the customer', type: 'textarea', placeholder: 'Includes the ferry to Villimalé' }] });
    if (!v) return;
    const upd = await MDM.store.sendQuote(o.id, { total: v.total, note: v.note, by: 'admin' });
    toast('Quote sent: ' + money(upd.totals.total), 'ok');
    const ok = await confirm({ title: 'Send the payment link?', message: 'Open ' + (F.NOTIFY[c.notify] || 'WhatsApp') + ' with the quote and the payment link for ' + (c.name || 'the customer') + '.', okLabel: 'Send update', cancelLabel: 'Not now' });
    if (ok) await sendUpdate(upd, quoteMessage(upd));
  }
  async function markPaid(o) {
    const v = await dialog({ title: 'Mark ' + o.code + ' as paid', message: 'Use this when the transfer arrived without a slip, or the customer paid in cash.', okLabel: 'Mark as paid',
      fields: [{ name: 'note', label: 'How was it paid', type: 'textarea', required: true, placeholder: 'Cash at the office, MVR 45' }] });
    if (!v) return;
    await MDM.store.markPaid(o.id, { note: v.note, by: 'admin' });
    toast('Marked as paid, order confirmed', 'ok');
  }
  async function verify(o) {
    if (!state.drawer.received[o.id]) { toast('Tick "Amount received in our account" first', 'warn'); return; }
    await MDM.store.verifyPayment(o.id, { by: 'admin' });
    delete state.drawer.received[o.id];
    toast('Payment verified, order confirmed', 'ok');
  }
  async function reject(o) {
    const v = await dialog({ title: 'Reject this payment', message: 'The customer is told the reason and can upload the slip again.', okLabel: 'Reject payment', danger: true,
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'Amount on the slip does not match the order' }] });
    if (!v) return;
    await MDM.store.rejectPayment(o.id, { reason: v.reason, by: 'admin' });
    delete state.drawer.received[o.id];
    toast('Payment rejected', 'warn');
  }
  function refundDialog(o) {
    const p = o.payment || {};
    const banks = ((state.settings || {}).banks || []).map(b => ({ value: b.id, label: b.name })).concat([BANKS_OTHER]);
    return dialog({ title: 'Record refund for ' + o.code, message: 'The customer paid ' + money(p.paidAmount != null ? p.paidAmount : o.totals.total) + '. Record the transfer you sent back.', okLabel: 'Record refund',
      fields: [
        { name: 'amount', label: 'Amount refunded (MVR)', type: 'number', required: true, value: p.paidAmount != null ? p.paidAmount : o.totals.total, min: 1, step: 1 },
        { name: 'toBank', label: 'Sent to bank', type: 'select', options: banks, value: p.bank && banks.some(b => b.value === p.bank) ? p.bank : banks[0].value },
        { name: 'toAccount', label: 'Account number or name', type: 'text', required: true, value: p.payerName || '' },
        { name: 'reference', label: 'Transfer reference', type: 'text' }] });
  }
  async function cancelOrder(o) {
    const v = await dialog({ title: 'Cancel ' + o.code, message: 'The customer sees the reason on the tracking page.', okLabel: 'Cancel order', cancelLabel: 'Keep order', danger: true,
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'Customer asked to cancel' }] });
    if (!v) return;
    let refund = null;
    if (o.payment && o.payment.status === 'verified' && !o.payment.refund) { refund = await refundDialog(o); if (!refund) return; }
    await MDM.store.cancel(o.id, { reason: v.reason, by: 'admin' });
    if (refund) await MDM.store.recordRefund(o.id, Object.assign({ by: 'admin' }, refund));
    toast('Order cancelled' + (refund ? ', refund recorded' : ''), 'warn');
  }
  async function recordRefund(o) {
    const v = await refundDialog(o);
    if (!v) return;
    await MDM.store.recordRefund(o.id, Object.assign({ by: 'admin' }, v));
    toast('Refund recorded', 'ok');
  }
  async function assign(o, driverId) {
    if (!driverId) { toast('Choose a rider first', 'warn'); return; }
    const upd = await MDM.store.assignDriver(o.id, driverId, { by: 'admin' });
    delete state.drawer.assignChoice[o.id];
    toast('Rider assigned: ' + F.driverName(driverId, await MDM.store.list('drivers')) + ' · ' + upd.route.stops.length + ' stops', 'ok');
  }
  async function reassign(o, drivers) {
    const options = drivers.slice().sort((a, b) => (a.status === 'offline') - (b.status === 'offline') || a.name.localeCompare(b.name)).map(d => ({ value: d.id, label: d.name + (d.status === 'offline' ? ' (offline)' : ''), disabled: d.id === o.driverId }));
    const first = options.find(x => !x.disabled);
    const v = await dialog({ title: 'Reassign ' + o.code, message: 'Currently with ' + (F.driverName(o.driverId, drivers) || 'nobody') + '. The route stays the same.', okLabel: 'Reassign rider',
      fields: [{ name: 'driverId', label: 'New rider', type: 'select', options, value: first ? first.value : '' }] });
    if (!v || !v.driverId) return;
    await MDM.store.assignDriver(o.id, v.driverId, { by: 'admin' });
    toast('Rider changed to ' + F.driverName(v.driverId, drivers), 'ok');
  }
  async function storePhoto(file, orderId, kind) {
    if (!file) return null;
    const img = await MDM.ui.imageToJpeg(file, { maxEdge: 800, quality: 0.8 });
    const row_ = await MDM.store.insert('files', { kind, orderId, name: file.name || (kind + '.jpg'), type: img.type, size: img.size, dataUrl: img.dataUrl, at: new Date().toISOString() });
    return row_.id;
  }
  async function markPickedUp(o) {
    const stops = (o.route && o.route.stops) || [];
    const stop = stops.find(s => s.type === 'pickup' && s.status !== 'done');
    if (!stop) { await MDM.store.transition(o.id, 'picked_up', { by: 'admin' }); toast('Marked as picked up', 'ok'); return; }
    if (stop.shop) {
      const v = await dialog({ title: 'Shopping done at ' + stop.address, message: 'Enter the receipt total. The shopping fee is recomputed from it.', okLabel: 'Mark picked up',
        fields: [{ name: 'receiptTotal', label: 'Receipt total (MVR)', type: 'number', required: true, min: 0, step: 1 }, { name: 'photo', label: 'Receipt photo', type: 'file', accept: 'image/*' }] });
      if (!v) return;
      const photoId = await storePhoto(v.photo, o.id, 'receipt');
      await MDM.store.setStop(o.id, stop.id, { status: 'done', by: 'admin', receiptTotal: v.receiptTotal, receiptPhotoId: photoId });
    } else {
      const ok = await confirm({ title: 'Mark picked up', message: stop.label + ' at ' + stop.address + ' is marked done.', okLabel: 'Mark picked up' });
      if (!ok) return;
      await MDM.store.setStop(o.id, stop.id, { status: 'done', by: 'admin' });
    }
    toast('Picked up', 'ok');
  }
  async function markDelivered(o) {
    const stops = (o.route && o.route.stops) || [];
    const stop = stops.find(s => (s.type === 'dropoff' || s.type === 'return') && s.status !== 'done' && s.status !== 'failed');
    if (!stop) {
      if (stops.some(s => s.status === 'failed')) { toast('Retry the failed stop first', 'warn'); return; }
      await MDM.store.transition(o.id, 'delivered', { by: 'admin' }); toast('Marked as delivered', 'ok'); return;
    }
    const v = await dialog({ title: 'Mark delivered', message: stop.label + ' at ' + stop.address + '.', okLabel: 'Mark delivered',
      fields: [
        { name: 'handedTo', label: 'Handed to', type: 'segmented', options: MDM.HANDED_TO, value: 'recipient' },
        { name: 'recipientName', label: 'Name of the person', type: 'text', autocomplete: 'name', value: stop.contact && stop.contact.name || '', validate: (val, all) => all.handedTo !== 'left' && !trim(val) ? 'Enter who received it' : null },
        { name: 'photo', label: 'Photo', type: 'file', accept: 'image/*' }] });
    if (!v) return;
    const photoId = await storePhoto(v.photo, o.id, 'proof');
    await MDM.store.setStop(o.id, stop.id, { status: 'done', by: 'admin', handedTo: v.handedTo, recipientName: trim(v.recipientName), photoId });
    toast('Delivered', 'ok');
  }
  async function retryStop(o) {
    const failed = (o.route && o.route.stops || []).find(s => s.status === 'failed');
    if (!failed) { toast('No failed stop on this order', 'warn'); return; }
    const preset = MDM.ADJUSTMENT_PRESETS.find(p => p.value === 'redelivery');
    const v = await dialog({ title: 'Retry ' + failed.label.toLowerCase(), message: failed.address + '. The stop goes back to the rider as attempt ' + ((failed.attempts || 0) + 2) + '.', okLabel: 'Retry stop',
      fields: [
        { name: 'charge', label: 'Add a re-delivery charge', type: 'checkbox', value: false },
        { name: 'amount', label: (preset ? preset.label : 'Re-delivery') + ' (MVR)', type: 'number', min: 1, step: 1, validate: (val, all) => all.charge && !(val > 0) ? 'Enter the charge' : null }] });
    if (!v) return;
    if (v.charge) await MDM.store.addAdjustment(o.id, { preset: 'redelivery', amount: v.amount, by: 'admin' });
    await MDM.store.retryStop(o.id, failed.id, { by: 'admin' });
    toast('Stop sent back to the rider', 'ok');
  }
  async function returnToSender(o) {
    const pickup = (o.route && o.route.stops || []).find(s => s.type === 'pickup');
    const ok = await confirm({ title: 'Return to sender', message: 'A return stop is added at ' + (pickup ? pickup.address : 'the pickup') + ' and the rider takes the package back.', okLabel: 'Return to sender' });
    if (!ok) return;
    await MDM.store.returnToSender(o.id, { by: 'admin' });
    toast('Return stop added', 'ok');
  }
  async function markSettled(o) {
    const s = o.settlement || {};
    const v = await dialog({ title: 'Mark settled', message: (s.balance > 0 ? 'We refunded ' : 'The customer paid ') + money(Math.abs(s.balance)) + '.', okLabel: 'Mark settled',
      fields: [{ name: 'reference', label: 'Transfer reference', type: 'text' }] });
    if (!v) return;
    await MDM.store.markSettled(o.id, { reference: v.reference, by: 'admin' });
    toast('Settled', 'ok');
  }
  async function addAdjustment(o) {
    const presets = MDM.ADJUSTMENT_PRESETS.filter(p => p.value !== 'quote');
    const v = await dialog({ title: 'Add adjustment to ' + o.code, message: o.payment && o.payment.status === 'verified' ? 'The customer sees the new total on the tracking page.' : 'Added to the total before payment.', okLabel: 'Add adjustment',
      fields: [
        { name: 'preset', label: 'Type', type: 'select', options: presets, value: presets[0].value },
        { name: 'amount', label: 'Amount (MVR)', type: 'number', required: true, step: 1, hint: 'Discounts are negative, for example −20', validate: (val, all) => all.preset === 'discount' ? (val < 0 ? null : 'A discount is a negative amount') : (val > 0 ? null : 'Enter an amount above 0') },
        { name: 'label', label: 'Shown as', type: 'text', placeholder: 'Waiting time at the harbour' }] });
    if (!v) return;
    await MDM.store.addAdjustment(o.id, { preset: v.preset, label: trim(v.label) || undefined, amount: v.amount, by: 'admin' });
    toast('Adjustment added', 'ok');
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
    const [drivers, files, account] = await Promise.all([MDM.store.list('drivers'), MDM.store.list('files', { where: { orderId: id } }), o.accountId ? MDM.store.get('business_accounts', o.accountId) : null]);
    const ctx = { drivers, account, fileById: {}, slipUrl: null, verifyBtn: null };
    files.forEach(f => { ctx.fileById[f.id] = f; });
    const slip = o.payment && o.payment.slip && ctx.fileById[o.payment.slip.fileId];
    if (slip && !/^image\//.test(slip.type || '')) { try { ctx.slipUrl = await objectUrlFor(slip); } catch (e) { ctx.slipUrl = null; } }
    if (!state.alive || state.drawer.id !== id) return;
    const footer = footerFor(o, ctx);
    const body = [customerSection(o, ctx), packagesSection(o), routeSection(o, ctx), pricingSection(o), paymentSection(o, ctx), quoteSection(o), settlementSection(o), notesSection(o, ctx), activitySection(o, ctx)].filter(Boolean);
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
    revokeUrls();
    if (kind === 'new') { destroyNewOrder(); return; }
    if (!state.alive || state.drawer.silent) return;
    const p = MDM.admin.params();
    if (p.view === 'orders' && p.id) history.replaceState(null, '', '#/orders' + (p.query.toString() ? '?' + p.query.toString() : ''));
    // SPEC §2.5: focus returns to the opener. The table is rebuilt while the drawer is open (update() and every store write), so the
    // <a> the drawer recorded as its opener is detached by the time it closes; put focus on the same order's current row link, or on
    // the view H1 when the order is no longer on this page of the list.
    const a = document.activeElement;
    if (state.host && !document.querySelector('dialog[open]') && (!a || a === document.body || !state.host.contains(a))) {
      const link = (closedId && state.host.querySelector('a[href="#/orders/' + encodeURIComponent(closedId) + '"]')) || state.host.querySelector('h1[tabindex="-1"]');
      if (link) { try { link.focus({ preventScroll: true }); } catch (e) { /* not focusable */ } }
    }
  }
  function closeOrderDrawer() { if (state.drawer.kind === 'order') drawer.close(); }

  // ---- New order drawer ------------------------------------------------------------------------------------------------------
  function segmented(name, options, current, testid, onChange) {
    const fs = el('fieldset', { class: 'segmented', 'data-testid': testid },
      options.map(o => el('label', { class: 'segmented__option', 'data-testid': testid + '-' + o.value }, el('input', { class: 'sr-only', type: 'radio', name, value: o.value, checked: o.value === current }), el('span', null, o.label))));
    fs.addEventListener('change', () => { const c = fs.querySelector('input:checked'); if (c) onChange(c.value); });
    return fs;
  }
  function field(id, label, control, opts) {
    opts = opts || {};
    return el('div', { class: 'field' }, el('label', { for: id }, label, opts.optional ? el('span', { class: 'optional' }, ' (optional)') : null), control, opts.hint ? el('div', { class: 'field__hint' }, opts.hint) : null);
  }
  function endpointCoords(end, keyText) {
    if (!end) return end;
    if (end.cargo && end.cargo.terminal && MDM.geo.terminalPoint(end.cargo.terminal)) { const p = MDM.geo.terminalPoint(end.cargo.terminal); return Object.assign({}, end, { lat: p[0], lng: p[1] }); }
    if (end.zone === 'airport' && end.meetAt && MDM.geo.airportPoint(end.meetAt)) { const p = MDM.geo.airportPoint(end.meetAt); return Object.assign({}, end, { lat: p[0], lng: p[1] }); }
    const p = MDM.geo.geocodeZone(end.zone === 'other' ? 'male' : end.zone || 'male', keyText || end.address || '');
    return Object.assign({}, end, { lat: p.lat, lng: p.lng });
  }
  function slotWindows(ops, date) {
    const start = MDM.ui.parseHHMM(ops.slotStart || '09:00'), end = MDM.ui.parseHHMM(ops.slotEnd || '23:00'), step = Number(ops.slotMinutes) || 120;
    const out = [];
    if (start == null || end == null) return out;
    const today = date === dayKey(new Date());
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes() + 30;
    for (let m = start; m + step <= end; m += step) {
      if (today && m < nowMin) continue;
      out.push(MDM.ui.minutesToHHMM(m) + '-' + MDM.ui.minutesToHHMM(m + step));
    }
    return out;
  }
  // Minimal inline editor used only when js/package-editor.js is not loaded; same interface as MDM.packageEditor.create.
  function fallbackEditor(opts) {
    const value = opts.value || {};
    const uid = MDM.id('fe');
    const input = (k, attrs) => el('input', Object.assign({ class: 'input', id: uid + '-' + k, type: 'text', 'data-testid': 'package-' + k, autocomplete: 'off' }, attrs || {}));
    const select = (k, options, val) => el('select', { class: 'select', id: uid + '-' + k, 'data-testid': 'package-' + k, value: val }, options.map(o => el('option', { value: o.value }, o.label)));
    const zones = MDM.geo.zoneOptions();
    const size = segmented(uid + '-size', ['bag', 'box', 'xl'].map(s => ({ value: s, label: MDM.pricing.sizeLabel(s) })), value.size || 'bag', 'package-size', () => {});
    const desc = input('description', { value: value.description || '' });
    const pa = input('pickup-address', { value: value.pickup ? value.pickup.address : '', autocomplete: 'street-address' });
    const pz = select('pickup-zone', zones, value.pickup ? value.pickup.zone : 'male');
    const da = input('dropoff-address', { value: value.dropoff ? value.dropoff.address : '', autocomplete: 'street-address' });
    const dz = select('dropoff-zone', zones, value.dropoff ? value.dropoff.zone : 'male');
    const rn = input('dropoff-recipient-name', { value: value.dropoff && value.dropoff.recipient ? value.dropoff.recipient.name : '', autocomplete: 'name' });
    const rp = input('dropoff-recipient-phone', { type: 'tel', inputmode: 'numeric', value: value.dropoff && value.dropoff.recipient ? value.dropoff.recipient.phone : '' });
    const under = el('input', { type: 'checkbox', id: uid + '-under', 'data-testid': 'package-under-one-ft', checked: value.underOneFt !== false });
    const root = el('div', { class: 'card', 'data-testid': 'package-editor' },
      el('div', { class: 'card__header' }, el('h3', null, opts.value ? 'Edit package' : 'New package')),
      el('div', { class: 'card__body stack-4' },
        el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Size'), size),
        field(desc.id, 'What is it', desc),
        opts.service === 'business' ? el('label', { class: 'checkbox', for: under.id }, under, el('span', null, 'Under 1 ft')) : null,
        el('div', { class: 'grid-2' }, field(pa.id, 'Pickup address', pa), field(pz.id, 'Pickup zone', pz)),
        el('div', { class: 'grid-2' }, field(da.id, 'Drop-off address', da), field(dz.id, 'Drop-off zone', dz)),
        el('div', { class: 'grid-2' }, field(rn.id, 'Recipient name', rn), field(rp.id, 'Recipient mobile', rp))),
      el('div', { class: 'card__footer' },
        el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'package-cancel', on: { click: () => opts.onCancel && opts.onCancel() } }, 'Cancel'),
        el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'package-save', on: { click: () => { if (validate()) opts.onSave(getValue()); } } }, opts.value ? 'Save changes' : 'Save package')));
    function validate() {
      let ok = true;
      const req = (c, msg) => { const bad = !trim(c.value); setError(c.closest('.field'), bad ? msg : null); if (bad) ok = false; };
      req(desc, 'Tell us what the package is'); req(pa, 'Enter the pickup address'); req(da, 'Enter the drop-off address'); req(rn, "Enter the recipient's name");
      const badPhone = !phone.valid(rp.value, { intl: dz.value === 'airport' }); setError(rp.closest('.field'), badPhone ? 'Enter a valid mobile number' : null); if (badPhone) ok = false;
      if (!ok) MDM.ui.focusFirstInvalid(root);
      return ok;
    }
    function getValue() {
      const c = size.querySelector('input:checked');
      const pkg = { id: value.id || MDM.id('pkg'), size: c ? c.value : 'bag', description: trim(desc.value), needsVehicle: false, fragile: false,
        pickup: { address: trim(pa.value), zone: pz.value, landmark: '', contact: null, cargo: null, meetAt: '' },
        dropoff: { address: trim(da.value), zone: dz.value, landmark: '', recipient: { name: trim(rn.value), phone: phone.normalize(rp.value) || trim(rp.value) }, cargo: null, meetAt: 'door' },
        shop: null, notes: '' };
      if (opts.service === 'business') pkg.underOneFt = under.checked;
      return pkg;
    }
    return { el: root, validate, getValue, focus: () => desc.focus(), destroy: () => root.remove() };
  }
  function createEditor(opts) {
    if (MDM.packageEditor && typeof MDM.packageEditor.create === 'function') return MDM.packageEditor.create(opts);
    state.neworder.fallback = true;
    return fallbackEditor(opts);
  }
  function destroyNewOrder() {
    const n = state.neworder;
    if (n && n.editor) { try { n.editor.destroy(); } catch (e) { /* already gone */ } }
    state.neworder = null;
  }
  async function openNewOrder() {
    if (state.drawer.kind) { state.drawer.silent = true; drawer.close(); state.drawer.silent = false; }
    const [accounts, settings] = await Promise.all([MDM.store.list('business_accounts', { where: { status: 'approved' } }), MDM.store.settings()]);
    state.settings = settings;
    const n = state.neworder = { source: 'phone', type: 'customer', service: 'pick', phone: '', name: '', email: '', notify: 'whatsapp', existing: null, accountId: accounts.length ? accounts[0].id : '', accounts, packages: [], editor: null, editing: null, schedule: { type: 'asap', date: dayKey(new Date()), window: '' }, fallback: false, slots: {}, settings };
    state.drawer.kind = 'new'; state.drawer.id = null;
    const uid = 'no';
    // Customer
    const phoneIn = el('input', { class: 'input', id: uid + '-phone', type: 'tel', inputmode: 'numeric', autocomplete: 'off', placeholder: '7XX XXXX', 'data-testid': 'neworder-phone' });
    const nameIn = el('input', { class: 'input', id: uid + '-name', type: 'text', autocomplete: 'off', 'data-testid': 'neworder-name' });
    const emailIn = el('input', { class: 'input', id: uid + '-email', type: 'email', autocomplete: 'off', 'data-testid': 'neworder-email' });
    const hint = el('div', { class: 'field__hint', 'data-testid': 'neworder-customer-hint' }, 'New customer');
    const phoneField = field(phoneIn.id, 'Mobile', phoneIn); phoneField.appendChild(hint);
    const nameField = field(nameIn.id, 'Name', nameIn);
    const lookup = MDM.ui.debounce(async () => {
      const norm = phone.normalize(phoneIn.value);
      n.phone = phoneIn.value; n.existing = null;
      if (!norm) { hint.textContent = 'New customer'; return; }
      const found = await MDM.store.list('customers', { where: { phone: norm } });
      if (!state.neworder || phoneIn.value !== n.phone) return;
      if (found.length) {
        n.existing = found[0];
        if (!trim(nameIn.value)) { nameIn.value = found[0].name || ''; n.name = nameIn.value; }
        if (!trim(emailIn.value) && found[0].email) { emailIn.value = found[0].email; n.email = emailIn.value; }
        if (found[0].notify) { n.notify = found[0].notify; const r = notifySeg.querySelector('input[value="' + found[0].notify + '"]'); if (r) r.checked = true; }
        hint.textContent = 'Existing customer · ' + plural(found[0].orderCount || 0, 'order') + (found[0].lastOrderAt ? ', last ' + timeAgo(found[0].lastOrderAt) : '');
      } else hint.textContent = 'New customer';
    }, 200);
    phoneIn.addEventListener('input', () => { setError(phoneField, null); lookup(); });
    phoneIn.addEventListener('blur', () => { if (trim(phoneIn.value) && !phone.valid(phoneIn.value)) setError(phoneField, 'Enter a Maldivian mobile number, 7 digits starting with 7 or 9'); });
    nameIn.addEventListener('input', () => { n.name = nameIn.value; setError(nameField, null); });
    emailIn.addEventListener('input', () => { n.email = emailIn.value; });
    const notifySeg = segmented(uid + '-notify', NOTIFY, n.notify, 'neworder-notify', v => { n.notify = v; });
    const customerBlock = el('div', { class: 'stack-4', 'data-testid': 'neworder-customer' },
      el('div', { class: 'grid-2' }, phoneField, nameField),
      field(emailIn.id, 'Email', emailIn, { optional: true }),
      el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Notify by'), notifySeg));
    const accountSel = el('select', { class: 'select', id: uid + '-account', 'data-testid': 'neworder-account' }, accounts.map(a => el('option', { value: a.id }, a.name)));
    const accountHint = el('div', { class: 'field__hint', 'data-testid': 'neworder-account-hint' });
    const accountField = field(accountSel.id, 'Business account', accountSel); accountField.appendChild(accountHint);
    const syncAccount = () => { const a = accounts.find(x => x.id === accountSel.value); n.accountId = accountSel.value; accountHint.textContent = a ? a.contactName + ' · ' + phone.format(a.phone) + ' · ' + a.pickupAddress + ' · ' + money(a.ratePerPackage != null ? a.ratePerPackage : settings.rates.business) + ' per package under 1 ft' : ''; };
    accountSel.addEventListener('change', syncAccount); syncAccount();
    const businessBlock = el('div', { class: 'stack-4', hidden: true, 'data-testid': 'neworder-business' },
      accounts.length ? accountField : el('div', { class: 'alert alert--info' }, html(MDM.icon('info', 16)), el('div', { class: 'alert__body' }, 'No approved business accounts yet. Approve a request under Business first.')));
    const typeSeg = segmented(uid + '-type', [{ value: 'customer', label: 'Customer' }, { value: 'business', label: 'Business account' }], 'customer', 'neworder-type', v => { n.type = v; syncType(); });
    const serviceSeg = segmented(uid + '-service', [{ value: 'pick', label: 'Pick & deliver' }, { value: 'shop', label: 'Shop & deliver' }], 'pick', 'neworder-service', v => { setService(v); });
    const serviceNote = el('p', { class: 'muted small', hidden: true }, 'Business rate ' + money(settings.rates.business) + ' per package under 1 ft within Malé and Hulhumalé. Invoiced monthly.');
    function syncType() {
      customerBlock.hidden = n.type !== 'customer'; businessBlock.hidden = n.type !== 'business';
      serviceSeg.hidden = n.type === 'business'; serviceNote.hidden = n.type !== 'business';
      setService(n.type === 'business' ? 'business' : (serviceSeg.querySelector('input:checked') || {}).value || 'pick');
    }
    function setService(v) {
      if (n.service === v) return;
      const had = n.packages.length;
      n.service = v; n.packages = []; cancelEditor();
      if (had) toast('Packages cleared because the service changed', 'warn');
      renderPackages();
    }
    // Packages
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
      const value = index == null ? null : n.packages[index];
      n.editor = createEditor({ service: n.service, settings, value, first: index !== 0 && n.packages.length ? n.packages[0] : null, me: me(), savedAddresses: savedAddresses(),
        onSave: pkg => { if (index == null) n.packages.push(pkg); else n.packages[index] = pkg; cancelEditor(); renderPackages(); },
        onCancel: cancelEditor });
      editorSlot.replaceChildren(n.editor.el);
      addBtn.hidden = true;
      pkgError.hidden = true;
      n.editor.focus();
    }
    function quote() { return MDM.pricing.quote({ service: n.service, packages: n.packages }, settings); }
    function renderPackages() {
      const q = quote();
      list.replaceChildren(...n.packages.map((pkg, i) => {
        const s = packageSummary(pkg, n.service);
        return el('div', { class: 'list__item', 'data-testid': 'neworder-package', 'data-package-id': pkg.id },
          el('div', { class: 'list__main' },
            el('div', { class: 'list__title' }, (i + 1) + '. ' + s.title + (s.description ? ' · ' + s.description : '')),
            el('div', { class: 'list__meta' }, legText(s)),
            s.flags.length ? el('div', { class: 'tags' }, s.flags.map(f => el('span', { class: 'tag' }, f))) : null),
          el('div', { class: 'list__aside' }, el('span', { class: 'mono' }, money(q.packages[i].price.lineTotal)),
            el('div', { class: 'row' },
              el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'neworder-package-edit', on: { click: () => openEditor(i) } }, 'Edit'),
              el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'neworder-package-remove', on: { click: () => { n.packages.splice(i, 1); cancelEditor(); renderPackages(); } } }, 'Remove'))));
      }));
      if (!n.packages.length) list.replaceChildren(el('p', { class: 'muted small' }, 'No packages yet.'));
      if (!n.packages.length) { estimate.replaceChildren(el('p', { class: 'muted small' }, 'Add a package to see the estimate.')); return; }
      const lines = q.packages.map(p => el('div', { class: 'summary__line' }, el('div', { class: 'summary__desc' }, MDM.pricing.lineLabel(p, n.service)), el('div', { class: 'summary__amount mono' }, money(p.price.lineTotal))));
      if (q.totals.budget) lines.push(el('div', { class: 'summary__line' }, el('div', { class: 'summary__desc' }, 'Shopping budget (paid up front)'), el('div', { class: 'summary__amount mono' }, money(q.totals.budget))));
      q.feeLines.forEach(f => lines.push(el('div', { class: 'summary__line summary__line--fee' }, el('div', { class: 'summary__desc' }, f.label), el('div', { class: 'summary__amount mono' }, money(f.amount)))));
      const summaryEl = el('div', { class: 'summary' }, lines, el('div', { class: 'summary__rule' }),
        el('div', { class: 'summary__total' }, el('span', null, q.totals.quoteRequired ? 'Estimated total' : 'Total'), el('span', { class: 'mono', 'data-testid': 'neworder-total' }, money(q.totals.total))));
      const quoteAlert = q.totals.quoteRequired ? el('div', { class: 'alert alert--warn', style: { marginTop: '12px' } }, html(MDM.icon('alert-triangle', 16)), el('div', { class: 'alert__body' }, el('div', { class: 'alert__title' }, 'Saved as quote pending'), q.totals.quoteReasons.map(r => el('div', null, MDM.pricing.reasonText(r))))) : null;
      // replaceChildren() stringifies null, so only real nodes go in.
      estimate.replaceChildren(...[summaryEl, quoteAlert].filter(Boolean));
    }
    // Schedule
    const dateIn = el('input', { class: 'input', id: uid + '-date', type: 'date', value: n.schedule.date, min: dayKey(new Date()), 'data-testid': 'neworder-date' });
    const windowSel = el('select', { class: 'select', id: uid + '-window', 'data-testid': 'neworder-window' });
    const slotBlock = el('div', { class: 'grid-2', hidden: true }, field(dateIn.id, 'Date', dateIn), field(windowSel.id, 'Window', windowSel));
    function syncWindows() {
      const wins = slotWindows(settings.ops || {}, dateIn.value);
      windowSel.replaceChildren(...wins.map(w => el('option', { value: w }, MDM.ui.window(w))));
      if (!wins.length) windowSel.appendChild(el('option', { value: '' }, 'No windows left today'));
      n.schedule.date = dateIn.value; n.schedule.window = windowSel.value;
    }
    dateIn.addEventListener('change', syncWindows); windowSel.addEventListener('change', () => { n.schedule.window = windowSel.value; });
    syncWindows();
    const schedSeg = segmented(uid + '-sched', [{ value: 'asap', label: 'ASAP' }, { value: 'slot', label: 'Pick a time' }], 'asap', 'neworder-schedule', v => { n.schedule.type = v; slotBlock.hidden = v !== 'slot'; });
    const sourceSeg = segmented(uid + '-source', SOURCES, n.source, 'neworder-source', v => { n.source = v; });
    const body = [
      sec('Customer', 'neworder-customer-section',
        el('div', { class: 'stack-4' },
          el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Order received by'), sourceSeg),
          el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Order for'), typeSeg),
          customerBlock, businessBlock)),
      sec('Service and packages', 'neworder-packages-section', el('div', { class: 'stack-4' }, serviceSeg, serviceNote, list, editorSlot, pkgError, addBtn)),
      sec('Schedule', 'neworder-schedule-section', el('div', { class: 'stack-4' }, schedSeg, el('p', { class: 'muted small' }, (settings.ops || {}).asapText || ''), slotBlock)),
      sec('Estimate', 'neworder-estimate-section', estimate),
    ];
    const createBtn = el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'neworder-create', on: { click: () => act(createOrder) } }, 'Create order');
    const footer = [el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'neworder-cancel', on: { click: () => drawer.close() } }, 'Cancel'), createBtn];
    renderPackages();
    drawer.open({ title: 'New order', body, footer, size: 'lg', onClose: () => onDrawerClosed('new') });
    if (n.fallback) toast('Using the basic package form: the shared package editor is not loaded', 'warn');
    phoneIn.focus();

    async function createOrder() {
      if (!state.neworder) return;
      let ok = true;
      let customer;
      if (n.type === 'business') {
        const a = accounts.find(x => x.id === n.accountId);
        if (!a) { toast('Choose a business account', 'warn'); return; }
        customer = { name: a.name, phone: a.phone, email: a.email || '', notify: 'viber' };
      } else {
        if (!phone.valid(phoneIn.value)) { setError(phoneField, 'Enter a Maldivian mobile number, 7 digits starting with 7 or 9'); ok = false; }
        if (!trim(nameIn.value)) { setError(nameField, "Enter the customer's name"); ok = false; }
        customer = { name: trim(nameIn.value), phone: phone.normalize(phoneIn.value), email: trim(emailIn.value), notify: n.notify };
      }
      if (n.editor) { if (n.editor.validate()) { const pkg = n.editor.getValue(); if (n.editing == null) n.packages.push(pkg); else n.packages[n.editing] = pkg; cancelEditor(); renderPackages(); } else ok = false; }
      if (!n.packages.length) { pkgError.textContent = 'Add at least 1 package'; pkgError.hidden = false; ok = false; }
      if (n.schedule.type === 'slot' && !n.schedule.window) { toast('Choose a delivery window', 'warn'); ok = false; }
      if (!ok) { MDM.ui.focusFirstInvalid(drawer.el()); return; }
      MDM.ui.setLoading(createBtn, true);
      try {
        const q = quote();
        const packages = q.packages.map(p => Object.assign({}, p, {
          pickup: p.pickup ? endpointCoords(p.pickup) : null,
          dropoff: endpointCoords(p.dropoff),
          shop: p.shop ? Object.assign({ receiptTotal: null, receiptPhotoId: null }, p.shop, MDM.geo.geocodeZone(p.shop.zone || 'male', p.shop.name)) : null,
        }));
        const cust = await MDM.store.upsertCustomer(customer);
        const business = n.type === 'business';
        const status = business ? 'confirmed' : (q.totals.quoteRequired ? 'quote_pending' : 'awaiting_payment');
        const order = await MDM.store.insert('orders', {
          source: n.source, service: n.service, customerId: cust.id, customer, accountId: business ? n.accountId : null,
          packages, fees: q.fees, totals: q.totals,
          schedule: n.schedule.type === 'slot' ? { type: 'slot', date: n.schedule.date, window: n.schedule.window } : { type: 'asap' },
          payment: business ? { method: 'invoice', status: 'invoiced' } : { method: 'transfer', status: 'unpaid', bank: '', payerName: '', paidAmount: null, reference: '', slip: null, submittedAt: null, verifiedAt: null, verifiedBy: null, rejectReason: null, note: '', refund: null },
          quote: { status: !business && q.totals.quoteRequired ? 'pending' : 'none', total: null, note: '', sentAt: null, by: null },
          settlement: null, status, driverId: null, route: { stops: [], polyline: [] }, events: [], notes: [],
        });
        const src = (SOURCES.find(s => s.value === n.source) || {}).label || n.source;
        await MDM.store.addEvent(order.id, { type: 'created', label: business ? 'Order created by admin (' + src.toLowerCase() + ')' : 'Order placed (' + src.toLowerCase() + ')', by: 'admin', visibility: business ? 'internal' : 'public' });
        toast('Order ' + order.code + ' created', 'ok');
        state.drawer.silent = true; drawer.close(); state.drawer.silent = false;
        MDM.admin.openOrder(order.id);
      } finally { if (createBtn.isConnected) MDM.ui.setLoading(createBtn, false); }
    }
  }

  // ---- View registration ---------------------------------------------------------------------------------------------------
  MDM.admin.views.orders = {
    title: 'Orders',
    async mount(host, p) {
      state.host = host; state.alive = true; state.page = 0;
      state.filters = readFilters(p.query);
      state.controls = buildControls('orders-range');
      state.slots.chips = el('div', { class: 'filters__chips', 'data-testid': 'orders-chips' });
      state.slots.table = el('div', { class: 'card', 'data-testid': 'orders-list' });
      state.slots.filtersBtn = el('button', { type: 'button', class: 'btn btn--secondary orders-filters-btn', 'data-testid': 'orders-filters-button', on: { click: openFiltersDrawer } }, 'Filters');
      host.append(
        el('div', { class: 'page-head' },
          el('h1', { tabindex: '-1' }, 'Orders'),
          el('p', { class: 'page-head__desc' }, 'Every order, newest first. Open one to verify payment, assign a rider or send an update.'),
          el('div', { class: 'page-head__actions' }, el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'orders-new', on: { click: () => act(openNewOrder) } }, html(MDM.icon('plus', 16)), 'New order'))),
        el('div', { class: 'orders-toolbar' }, el('div', { class: 'orders-filters' }, state.controls.el), state.slots.filtersBtn),
        state.slots.chips,
        state.slots.table);
      await render();
      const schedule = () => { clearTimeout(state.timer); state.timer = setTimeout(() => render().catch(() => {}), 40); };
      ['orders', 'drivers', 'files'].forEach(c => state.unsubs.push(MDM.store.subscribe(c, schedule)));
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
      revokeUrls();
      state.drawer.kind = null; state.drawer.id = null; state.drawer.order = null;
      state.host = null; state.controls = null; state.slots = {};
    },
  };
})(window.MDM);

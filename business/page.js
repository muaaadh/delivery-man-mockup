// For businesses: the public page (rate, how it works, account request) and, once signed in, the business portal
// (client requirements §2 business, §8, §10, §11, §18; How it works §8, §9, §12).
// Session: localStorage mdm:business = { accountId, name, phone, at }, written here (phone + one-time code) or by the sign-in page.
// Portal tabs live in the hash (#overview, #new, #bulk, #orders, #priority, #invoices, #labels) so each one can be linked to.
// Orders are created with MDM.store.createOrder (single) and MDM.store.createBatch (bulk); priority with MDM.store.requestPriority.
(function (MDM) { 'use strict';
  const { el, html, setError } = MDM.ui;
  const SESSION = 'mdm:business';
  const BUSINESS_ISLANDS = ['male', 'hulhumale'];
  const OPEN = ['requested', 'confirmed', 'assigned', 'dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery', 'failed'];
  const DONE = ['delivered', 'returned', 'cancelled'];
  const TABS = [
    { key: 'overview', label: 'Overview' }, { key: 'new', label: 'New order' }, { key: 'bulk', label: 'Bulk order' },
    { key: 'orders', label: 'Orders' }, { key: 'priority', label: 'Priority' }, { key: 'invoices', label: 'Invoices' }, { key: 'labels', label: 'Labels' },
  ];
  const PICKUP_WINDOWS = [
    { value: 'morning', label: 'Morning 09:00 to 12:00' }, { value: 'afternoon', label: 'Afternoon 13:00 to 17:00' }, { value: 'evening', label: 'Evening 18:00 to 22:00' },
  ];
  const VOLUMES = [{ value: '1-10', label: '1 to 10' }, { value: '11-30', label: '11 to 30' }, { value: '31-100', label: '31 to 100' }, { value: '100+', label: 'More than 100' }];
  const SIZES = [{ value: 'bag', label: 'Bag' }, { value: 'box', label: 'Box' }, { value: 'xl', label: 'XL' }];
  const CSV_COLUMNS = ['name', 'phone', 'address', 'zone', 'size', 'description', 'reference'];
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const LANDLINE = /^3\d{6}$/;
  const money = n => MDM.pricing.format(n);
  const plural = MDM.ui.plural;
  const fmtDate = (iso, o) => MDM.ui.fmtDate(iso, o);

  const app = document.querySelector('[data-slot="app"]');
  const state = {
    acc: null, tab: 'overview', settings: {}, received: null, signin: { step: 1, phone: '' },
    filters: { q: '', status: 'all', range: '30', batch: '' }, done: { order: null, batch: null }, selected: new Set(),
  };

  // ---- Session -----------------------------------------------------------------------------------------------------------
  function readSession() { try { const v = JSON.parse(localStorage.getItem(SESSION) || 'null'); return v && v.accountId ? v : null; } catch (e) { return null; } }
  function writeSession(acc) { try { localStorage.setItem(SESSION, JSON.stringify({ accountId: acc.id, name: acc.name, phone: acc.phone, at: new Date().toISOString() })); } catch (e) { /* storage blocked: signed in for this page only */ } }
  function clearSession() { try { localStorage.removeItem(SESSION); } catch (e) { /* nothing stored */ } }
  async function currentAccount() {
    const s = readSession(); if (!s) return null;
    const acc = await MDM.store.get('business_accounts', s.accountId);
    return acc && acc.status === 'approved' ? acc : null;
  }

  // ---- Small builders ----------------------------------------------------------------------------------------------------
  const input = attrs => el('input', Object.assign({ class: 'input', type: 'text' }, attrs));
  const select = (options, prompt, value) => el('select', { class: 'select', value: value == null ? '' : value }, prompt ? el('option', { value: '' }, prompt) : null, options.map(o => el('option', { value: o.value }, o.label)));
  function field(name, label, control, opts) {
    opts = opts || {};
    control.name = name;
    if (!control.id) control.id = 'biz-' + name + '-' + Math.random().toString(36).slice(2, 7);
    return MDM.ui.field({ name, label, control, hint: opts.hint, optional: opts.optional, class: opts.class });
  }
  function segmented(name, options, value, testid) {
    return el('fieldset', { class: 'segmented', 'data-testid': testid || null }, options.map(o => el('label', { class: 'segmented__option', 'data-testid': testid ? testid + '-' + o.value : null },
      el('input', { class: 'sr-only', type: 'radio', name, value: o.value, checked: o.value === value }), el('span', null, o.label, o.hint ? el('small', null, o.hint) : null))));
  }
  function section(title, desc, body, action) {
    const id = 'biz-' + title.toLowerCase().replace(/[^a-z]+/g, '-');
    return el('section', { class: 'section', 'aria-labelledby': id },
      el('div', { class: 'section-head' }, el('h2', { id }, title), desc ? el('p', { class: 'section-head__desc' }, desc) : null, action ? el('div', { class: 'section-head__action' }, action) : null),
      body);
  }
  const empty = (title, hint) => el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, title), hint ? el('div', { class: 'empty__hint' }, hint) : null);
  const zoneOptions = () => MDM.geo.zoneOptions();
  const pickupZones = () => MDM.geo.zoneOptions().filter(o => BUSINESS_ISLANDS.indexOf(MDM.geo.island(o.value)) >= 0);
  const trackHref = o => MDM.href('track/?code=' + encodeURIComponent(o.code));
  const labelsHref = q => MDM.href('labels/?' + q);
  function deliveredAt(o) {
    const h = (o.statusHistory || []).filter(x => x.to === 'delivered').pop();
    if (h) return h.at;
    const e = (o.events || []).filter(x => x.type === 'delivered').pop();
    return e ? e.at : o.updatedAt;
  }
  function priorityTag(o) {
    const p = o.priority || {};
    if (p.status === 'approved') return el('span', { class: 'tag biz-tag--priority' }, (MDM.PRIORITY_LEVELS.find(x => x.value === p.level) || { label: 'Priority' }).label);
    if (p.status === 'requested') return el('span', { class: 'tag' }, 'Priority requested');
    return null;
  }
  function recipientOf(o) { const pkg = (o.packages || [])[0] || {}; const r = (pkg.dropoff && pkg.dropoff.recipient) || {}; return { name: r.name || (o.delivery || {}).recipientName || '', phone: r.phone || (o.delivery || {}).recipientPhone || '' }; }

  // ---- Data ----------------------------------------------------------------------------------------------------------------
  async function load() {
    const [orders, batches, invoices, settings] = await Promise.all([
      MDM.store.list('orders', { where: { accountId: state.acc.id } }), MDM.store.list('batches', { where: { accountId: state.acc.id } }),
      MDM.store.list('invoices', { where: { accountId: state.acc.id } }), MDM.store.settings()]);
    state.settings = settings || {};
    return { orders, batches, invoices, settings: state.settings };
  }

  // =========================================================================================================================
  // Public page
  // =========================================================================================================================
  function sizeRange(cell) {
    cell = cell || {};
    if (cell.quoted || cell.same === cell.cross) return 'from ' + money(cell.same);
    return money(cell.same) + ' to ' + Math.round(cell.cross).toLocaleString('en-US');
  }
  function ratesBlock(s) {
    const rates = s.rates || {}, sizes = rates.sizes || {}, guide = s.sizeGuide || {};
    const standard = 'Bags ' + sizeRange(sizes.bag) + ' · Box ' + sizeRange(sizes.box) + ' · XL ' + sizeRange(sizes.xl);
    const row = MDM.ui.rateRow;
    return el('div', null,
      el('div', { class: 'rate-table', 'data-slot': 'rates' },
        row('Rate per package', money(rates.business), { sub: 'Malé and Hulhumalé Phase 1 & 2', mono: true }),
        row('Package size', 'Under 1 ft', { sub: guide.box || '' }),
        row('Larger packages or other areas', 'Standard rates', { sub: standard }),
        row('Bulk orders', 'Spreadsheet or form', { sub: 'Upload a CSV or type the rows; each package gets its own tracking code and label' }),
        row('Priority and express', 'On request', { sub: 'Ask for a deadline on any open order; our team approves it' }),
        row('Billing', 'Monthly', { sub: 'One invoice for every package delivered that month', valueSub: 'Due in ' + plural(s.invoiceDueDays || 14, 'day') })),
      el('p', { class: 'business-note' }, 'Prices in Maldivian Rufiyaa.'));
  }
  function stepsBlock(s) {
    const reply = (s.ops || {}).businessReplyText || 'within 1 working day';
    const items = [
      ['Request an account', 'Fill in the form below. We call you ' + reply + ' to confirm the details and open the account.'],
      ['Send orders your way', 'Book one delivery at a time, or upload the day\'s orders as a spreadsheet. We collect from your shop or office.'],
      ['Sorted by zone', 'Packages are sorted at our hub and handed to the driver for each zone. Print a label for every package from the portal.'],
      ['Track and get invoiced', 'Every package has a tracking code to share with your customer. Delivered packages go on one monthly invoice at ' + money((s.rates || {}).business) + '.'],
    ];
    return el('ol', { class: 'steps', 'data-slot': 'steps' }, items.map((it, i) => el('li', { class: 'steps__item' },
      el('div', { class: 'steps__head' }, el('span', { class: 'steps__num mono' }, String(i + 1)), el('h3', { class: 'steps__title' }, it[0])),
      el('p', { class: 'steps__text' }, it[1]))));
  }

  function signinCard() {
    const st = state.signin;
    const body = el('div', { class: 'card__body' });
    const card = el('div', { class: 'card biz-signin', 'data-testid': 'biz-signin' }, el('div', { class: 'card__header' }, el('h2', null, 'Business sign-in'), el('span', { class: 'small muted' }, 'For approved accounts')), body);
    if (st.step === 2) {
      const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '4', placeholder: '4 digits', 'data-testid': 'biz-signin-code' });
      const form = el('form', { class: 'form', novalidate: true, on: { submit: async e => {
        e.preventDefault();
        if (!/^\d{4}$/.test(code.value.trim())) { setError(code, 'Enter the 4-digit code'); code.focus(); return; }
        const phone = MDM.ui.phone.normalize(st.phone);
        const acc = (await MDM.store.list('business_accounts')).find(a => a.phone === phone && a.status === 'approved');
        if (!acc) { setError(code, 'No business account uses this number any more'); return; }
        writeSession(acc); st.step = 1; state.acc = acc;
        if (!location.hash) history.replaceState(null, '', '#overview');
        await render();
      } } },
        MDM.ui.notice('info', 'We sent a code to ' + MDM.ui.phone.format(st.phone) + '. In this demo any 4 digits work.'),
        field('code', 'Code', code),
        el('div', { class: 'form-actions' },
          el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => { st.step = 1; renderPublicSignin(); } } }, 'Use another number'),
          el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'biz-signin-submit' }, 'Sign in')));
      body.appendChild(form);
      setTimeout(() => code.focus(), 0);
      return card;
    }
    const phone = input({ type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '7XX XXXX', value: st.phone, 'data-testid': 'biz-signin-phone' });
    const form = el('form', { class: 'form', novalidate: true, on: { submit: async e => {
      e.preventDefault();
      if (!MDM.ui.phone.valid(phone.value)) { setError(phone, 'Enter the 7-digit mobile number on your business account'); phone.focus(); return; }
      const n = MDM.ui.phone.normalize(phone.value);
      const acc = (await MDM.store.list('business_accounts')).find(a => a.phone === n);
      if (!acc) { setError(phone, 'We have no business account for this number. Request one below.'); phone.focus(); return; }
      if (acc.status !== 'approved') { setError(phone, 'This account is not active yet. We will call you.'); return; }
      st.phone = phone.value; st.step = 2; renderPublicSignin();
    } } },
      field('phone', 'Account mobile number', phone, { hint: 'We send a one-time code to this number. Demo account: 780 1122' }),
      el('div', { class: 'form-actions' }, el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'biz-signin-continue' }, 'Send code')));
    body.appendChild(form);
    return card;
  }
  function renderPublicSignin() { const old = app.querySelector('[data-testid="biz-signin"]'); if (old) old.replaceWith(signinCard()); }

  // Account request form (inserts business_requests; the admin approves it under Business → Requests).
  const requestRules = {
    name: v => v ? null : 'Enter your business name',
    contactName: v => v ? null : 'Enter the name of the person we should call',
    phone: v => !v ? 'Enter a mobile number we can call' : (MDM.ui.phone.valid(v) ? null : 'Enter a 7-digit Maldives mobile number'),
    landline: v => { if (!v) return null; const n = MDM.ui.phone.normalize(v); return n && LANDLINE.test(n) ? null : 'Enter a 7-digit landline number starting with 3'; },
    email: v => !v ? 'Enter an email address for invoices' : (EMAIL.test(v) ? null : 'Enter a valid email address'),
    zone: v => v ? null : 'Choose your island',
    pickupAddress: v => v ? null : 'Enter the address we pick up from',
    pickupWindow: v => v ? null : 'Choose a pickup window',
    volume: v => v ? null : 'Choose how many packages you expect',
  };
  function requestForm() {
    const f = el('form', { class: 'form', novalidate: true, 'data-testid': 'business-form' });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'business-submit' }, 'Request an account');
    const duplicate = MDM.ui.notice('warn', 'We already have a request for this number. We will call you about it.', { testid: 'business-duplicate' });
    duplicate.hidden = true; duplicate.setAttribute('role', 'alert'); duplicate.tabIndex = -1;
    const failure = el('div', { class: 'alert alert--danger', role: 'alert', tabindex: '-1', hidden: true });
    f.append(
      field('name', 'Business name', input({ autocomplete: 'organization', 'data-testid': 'business-name' })),
      field('contactName', 'Contact person', input({ autocomplete: 'name', 'data-testid': 'business-contact' })),
      el('div', { class: 'grid-2' },
        field('phone', 'Mobile', input({ type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '7XX XXXX', 'data-testid': 'business-phone' })),
        field('landline', 'Landline', input({ type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '3XX XXXX' }), { optional: true })),
      field('email', 'Email', input({ type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'name@company.mv' }), { hint: 'Invoices are sent here' }),
      el('div', { class: 'grid-2' }, field('zone', 'Island', select(pickupZones(), 'Choose an island')), field('pickupWindow', 'Pickup window', select(PICKUP_WINDOWS, 'Choose a window'))),
      field('pickupAddress', 'Pickup address', input({ autocomplete: 'street-address', placeholder: 'M. Kaneerumaage, 2nd floor, Majeedhee Magu' }), { hint: 'House or building name, floor and road' }),
      field('volume', 'Packages per week', select(VOLUMES, 'Choose a range'), { hint: 'A rough number is fine' }),
      field('notes', 'Notes', el('textarea', { class: 'textarea', rows: 3 }), { optional: true, hint: 'Opening hours, fragile items or anything the driver should know' }),
      duplicate, failure, el('div', { class: 'form-actions' }, submit));
    const dirty = new Set();
    const valueOf = c => typeof c.value === 'string' ? c.value.trim() : c.value;
    const check = n => { const c = f.elements[n]; const msg = requestRules[n](valueOf(c)); setError(c, msg); return !msg; };
    const onEdit = e => { const n = e.target.name; if (!n) return; dirty.add(n); if (requestRules[n] && e.target.closest('.field').classList.contains('is-invalid')) check(n); if (n === 'phone') duplicate.hidden = true; failure.hidden = true; };
    f.addEventListener('input', onEdit); f.addEventListener('change', onEdit);
    f.addEventListener('focusout', e => { const n = e.target.name; if (n && requestRules[n] && dirty.has(n)) check(n); });
    f.addEventListener('submit', async e => {
      e.preventDefault(); duplicate.hidden = true; failure.hidden = true;
      const r = MDM.ui.validate(f, requestRules);
      if (!r.ok) { MDM.ui.focusFirstInvalid(f); return; }
      const phone = MDM.ui.phone.normalize(r.values.phone);
      MDM.ui.setLoading(submit, true);
      try {
        const existing = await MDM.store.list('business_requests');
        if (existing.some(x => x.phone === phone)) { duplicate.hidden = false; duplicate.focus(); return; }
        state.received = await MDM.store.insert('business_requests', {
          name: r.values.name, contactName: r.values.contactName, phone, landline: MDM.ui.phone.normalize(r.values.landline) || '', email: r.values.email,
          zone: r.values.zone, pickupAddress: r.values.pickupAddress, pickupWindow: r.values.pickupWindow, volume: r.values.volume, notes: valueOf(f.elements.notes), status: 'pending' });
        await render();
      } catch (err) {
        failure.replaceChildren(html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' }, 'We could not save your request. ' + (err && err.code === 'quota' ? 'This browser is out of storage space for the demo. Reset demo data from the admin.' : 'Please try again or call us.')));
        failure.hidden = false; failure.focus();
      } finally { if (document.contains(submit)) MDM.ui.setLoading(submit, false); }
    });
    return f;
  }
  function receivedCard(s) {
    const r = state.received, reply = (s.ops || {}).businessReplyText || 'within 1 working day';
    return el('div', { class: 'card business-received', 'data-testid': 'business-received' },
      el('div', { class: 'card__header' }, el('h2', { tabindex: '-1' }, 'Request received')),
      el('div', { class: 'card__body stack-4' },
        el('p', null, 'Thanks, ', el('strong', null, r.name), '. We will call ', el('span', { class: 'mono nowrap' }, MDM.ui.phone.format(r.phone)), ' ' + reply + '.'),
        el('p', { class: 'small muted' }, 'Nothing to pay now. The rate and the pickup window are confirmed on the call.'),
        el('a', { class: 'btn btn--secondary', href: MDM.href('') }, 'Back to home')));
  }
  function renderPublic(s) {
    document.title = 'For businesses · Mr. Delivery Man';
    const request = state.received ? receivedCard(s) : requestForm();
    app.replaceChildren(el('div', { class: 'container container--narrow' },
      el('div', { class: 'page-head' }, el('h1', null, 'Delivery for businesses'),
        el('p', { class: 'page-head__desc' }, 'Daily pickups from your shop or office, one rate per package, bulk orders from a spreadsheet and one invoice a month.')),
      signinCard(),
      section('Rate and conditions', null, ratesBlock(s)),
      section('How it works', null, stepsBlock(s)),
      section('Request an account', 'Tell us about your business and we call you to set up the account and the pickup routine.', request)));
    if (state.received) { const h = app.querySelector('.business-received h2'); if (h) h.focus(); }
  }

  // =========================================================================================================================
  // Portal
  // =========================================================================================================================
  function tabFromHash() { const k = (location.hash || '').replace(/^#\/?/, '').split('?')[0]; return TABS.some(t => t.key === k) ? k : 'overview'; }
  function go(tab) { if (location.hash !== '#' + tab) location.hash = tab; else renderTab(); }
  let panel = null, tabsEl = null;

  function renderPortal() {
    const acc = state.acc;
    document.title = acc.name + ' · Business · Mr. Delivery Man';
    tabsEl = el('nav', { class: 'tabs biz-tabs', 'aria-label': 'Business portal' }, TABS.map(t => el('a', { class: 'tab', href: '#' + t.key, 'data-tab': t.key, 'data-testid': 'biz-tab-' + t.key }, t.label)));
    panel = el('div', { class: 'biz-panel', 'data-testid': 'biz-panel' });
    app.replaceChildren(el('div', { class: 'container' },
      el('div', { class: 'page-head biz-head' },
        el('h1', null, acc.name),
        el('p', { class: 'page-head__desc' }, 'Business account · ' + money(acc.ratePerPackage || (state.settings.rates || {}).business) + ' per package under 1 ft · invoiced monthly'),
        el('div', { class: 'page-head__actions' },
          el('button', { type: 'button', class: 'btn btn--brand', 'data-testid': 'biz-head-new', on: { click: () => go('new') } }, html(MDM.icon('plus', 16)), 'New order'),
          el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'biz-signout', on: { click: () => { clearSession(); state.acc = null; history.replaceState(null, '', location.pathname); render(); } } }, 'Sign out'))),
      tabsEl, panel));
    renderTab();
  }
  async function renderTab() {
    if (!panel) return;
    state.tab = tabFromHash();
    tabsEl.querySelectorAll('[data-tab]').forEach(a => { if (a.dataset.tab === state.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const fn = { overview: tabOverview, new: tabNew, bulk: tabBulk, orders: tabOrders, priority: tabPriority, invoices: tabInvoices, labels: tabLabels }[state.tab];
    const node = await fn();
    panel.replaceChildren(node);
  }
  // Store changes refresh the read-only tabs; tabs with a form in progress keep their inputs.
  const LIVE_TABS = ['overview', 'orders', 'invoices', 'labels'];
  const refresh = MDM.ui.debounce(() => { if (state.acc && LIVE_TABS.indexOf(state.tab) >= 0) renderTab(); else if (state.acc && state.tab === 'priority') refreshPriorityList(); }, 150);

  // ---- Overview -------------------------------------------------------------------------------------------------------------
  function kpi(label, value, note, testid) { return el('div', { class: 'kpi', 'data-testid': testid || null }, el('div', { class: 'kpi__label' }, label), el('div', { class: 'kpi__value' }, value), note ? el('div', { class: 'kpi__note' }, note) : null); }
  function batchProgress(b) {
    const st = MDM.store._batchStatus(b);
    const pct = st.total ? Math.round((st.delivered / st.total) * 100) : 0;
    return { st, pct, bar: el('div', { class: 'biz-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(st.total), 'aria-valuenow': String(st.delivered), 'aria-label': st.delivered + ' of ' + st.total + ' delivered' }, el('span', { style: { width: pct + '%' } })) };
  }
  function batchRow(b) {
    const p = batchProgress(b);
    const parts = [plural(p.st.total, 'package'), p.st.delivered + ' delivered'];
    if (p.st.out) parts.push(p.st.out + ' out for delivery');
    if (p.st.collected) parts.push(p.st.collected + ' at the hub');
    if (p.st.failed) parts.push(p.st.failed + ' failed');
    return el('div', { class: 'list__item biz-batch', 'data-testid': 'biz-batch-' + b.code },
      el('div', { class: 'list__main' },
        el('div', { class: 'list__title' }, el('span', { class: 'mono--code' }, b.code), ' ', html(MDM.badgeFor(p.st.status === 'paid' ? 'delivered' : p.st.status))),
        el('div', { class: 'list__meta' }, fmtDate(b.createdAt) + ' · ' + parts.join(' · ') + (b.notes ? ' · ' + b.notes : '')),
        p.bar),
      el('div', { class: 'list__aside biz-actions' },
        el('a', { class: 'btn btn--secondary btn--sm', href: labelsHref('batch=' + encodeURIComponent(b.id)), 'data-testid': 'biz-batch-labels' }, html(MDM.icon('printer', 16)), 'Labels'),
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => { state.filters.batch = b.id; state.filters.status = 'all'; state.filters.range = 'all'; go('orders'); } } }, 'Packages')));
  }
  function orderRow(o) {
    const r = recipientOf(o), pkg = (o.packages || [])[0] || {};
    return el('a', { class: 'list__item list__item--link', href: trackHref(o), 'data-testid': 'biz-order-' + o.code },
      el('div', { class: 'list__main' },
        el('div', { class: 'list__title' }, el('span', { class: 'mono--code' }, o.code), ' · ', r.name || 'Recipient', ' ', priorityTag(o)),
        el('div', { class: 'list__meta' }, MDM.geo.zoneShort((o.delivery || {}).zone) + ' · ' + MDM.pricing.sizeLabel(pkg.size) + (pkg.description ? ' · ' + pkg.description : '') + ' · ' + MDM.ui.timeAgo(o.createdAt))),
      el('div', { class: 'list__aside' }, html(MDM.badgeFor(o.status))));
  }
  async function tabOverview() {
    const d = await load();
    const month = MDM.ui.monthKey();
    const open = d.orders.filter(o => OPEN.indexOf(o.status) >= 0);
    const delivered = d.orders.filter(o => o.status === 'delivered' && MDM.ui.monthKey(deliveredAt(o)) === month);
    const amount = delivered.reduce((n, o) => n + (o.totals ? o.totals.total : 0), 0);
    const pri = d.orders.filter(o => o.priority && o.priority.status === 'requested');
    const failed = d.orders.filter(o => o.status === 'failed');
    const recent = d.orders.slice(0, 6);
    const batches = d.batches.slice(0, 4);
    return el('div', { class: 'stack-6' },
      el('div', { class: 'kpi-row' },
        kpi('Open orders', String(open.length), open.filter(o => o.status === 'out_for_delivery').length + ' out for delivery now', 'biz-kpi-open'),
        kpi('Delivered this month', String(delivered.length), plural(delivered.reduce((n, o) => n + (o.packages || []).length, 0), 'package')),
        kpi('This month so far', money(amount), 'Invoiced at the end of the month', 'biz-kpi-amount'),
        kpi('Priority requests', String(pri.length), pri.length ? 'Waiting for our team' : 'None waiting')),
      failed.length ? MDM.ui.notice('warn', el('div', null, plural(failed.length, 'delivery', 'deliveries') + ' could not be completed. We will contact you, or call us. ',
        failed.map((o, i) => [i ? ', ' : '', el('a', { href: trackHref(o) }, o.code)])), { title: 'Needs attention' }) : null,
      el('div', { class: 'grid-2 biz-overview' },
        el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Bulk orders'), el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => go('bulk') } }, 'New bulk order')),
          batches.length ? el('div', { class: 'list' }, batches.map(batchRow)) : empty('No bulk orders yet', 'Upload a spreadsheet of the day\'s deliveries under Bulk order.')),
        el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Recent orders'), el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => go('orders') } }, 'All orders')),
          recent.length ? el('div', { class: 'list' }, recent.map(orderRow)) : empty('No orders yet', 'Book your first delivery under New order.'))));
  }

  // ---- New order (single delivery) -------------------------------------------------------------------------------------------
  function collectionFields(acc, prefix) {
    return [
      el('div', { class: 'grid-2' },
        field(prefix + 'Address', 'Collection address', input({ value: acc.pickupAddress || '', 'data-testid': 'biz-c-address' })),
        field(prefix + 'Zone', 'Island or zone', select(zoneOptions(), null, acc.zone || 'male'))),
      el('div', { class: 'grid-2' },
        field(prefix + 'Name', 'Contact person', input({ value: acc.contactName || '', autocomplete: 'name' })),
        field(prefix + 'Phone', 'Contact number', input({ type: 'tel', inputmode: 'numeric', value: acc.phone || '' }))),
      field(prefix + 'Note', 'Collection instructions', input({ placeholder: 'Ask for the dispatch shelf' }), { optional: true }),
    ];
  }
  function scheduleBlock(form) {
    const adv = el('div', { class: 'grid-2 biz-advance', hidden: true },
      field('collectDate', 'Collection date', input({ type: 'date' })), field('collectTime', 'Collection time', input({ type: 'time', value: '10:00' })),
      field('deliverDate', 'Delivery date', input({ type: 'date' })), field('deliverTime', 'Delivery time', input({ type: 'time', value: '14:00' })));
    const seg = segmented('level', MDM.SERVICE_LEVELS.map(l => ({ value: l.value, label: l.label, hint: l.value === 'normal' ? 'Same day' : l.value === 'express' ? 'Confirmed by us' : 'Pick a date' })), 'normal', 'biz-level');
    seg.addEventListener('change', () => { adv.hidden = form.elements.level.value !== 'advance'; });
    return [MDM.ui.field({ label: 'Service', control: seg, hint: 'Express is subject to availability; our team confirms it. Advance orders are collected on the date you choose.' }), adv];
  }
  function scheduleValue(v) {
    if (v.level === 'advance') return { type: 'advance', collectDate: v.collectDate, collectTime: v.collectTime, deliverDate: v.deliverDate || v.collectDate, deliverTime: v.deliverTime };
    return { type: 'asap' };
  }
  function advanceRules(v) {
    if (v.level !== 'advance') return {};
    const today = MDM.ui.dayKey();
    return { collectDate: !v.collectDate ? 'Choose the collection date' : (v.collectDate < today ? 'Choose today or a later date' : null),
      deliverDate: v.deliverDate && v.deliverDate < v.collectDate ? 'Delivery cannot be before collection' : null };
  }
  function draftPackage(v) {
    return {
      id: MDM.id('pkg'), size: v.size || 'bag', description: v.description || '', fragile: !!v.fragile, underOneFt: v.size !== 'xl', needsVehicle: false, notes: v.reference || '',
      pickup: { address: v.cAddress, zone: v.cZone, landmark: '', contact: { name: v.cName, phone: MDM.ui.phone.normalize(v.cPhone) || v.cPhone }, instructions: v.cNote || '' },
      dropoff: { address: v.dAddress, zone: v.dZone, landmark: v.dLandmark || '', recipient: { name: v.dName, phone: MDM.ui.phone.normalize(v.dPhone) || v.dPhone }, instructions: v.dNote || '', meetAt: 'door' },
    };
  }
  async function tabNew() {
    const acc = state.acc, s = await MDM.store.settings();
    if (state.done.order) return newOrderDone(state.done.order);
    const form = el('form', { class: 'biz-form', novalidate: true, 'data-testid': 'biz-new-form' });
    const priceBox = el('div', { class: 'summary biz-price', 'data-testid': 'biz-new-price' });
    const failure = el('div', { class: 'alert alert--danger', role: 'alert', tabindex: '-1', hidden: true });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg', 'data-testid': 'biz-new-submit' }, 'Book delivery');
    const sizeSeg = segmented('size', SIZES.map(z => ({ value: z.value, label: z.label, hint: z.value === 'bag' ? 'Carrier bag' : z.value === 'box' ? 'Up to 1 ft' : 'Bigger, quoted' })), 'bag', 'biz-size');
    form.append(
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Collection')), el('div', { class: 'card__body stack-4' }, collectionFields(acc, 'c'))),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Delivery')), el('div', { class: 'card__body stack-4' },
        el('div', { class: 'grid-2' }, field('dName', 'Recipient name', input({ autocomplete: 'off', 'data-testid': 'biz-d-name' })), field('dPhone', 'Recipient number', input({ type: 'tel', inputmode: 'numeric', placeholder: '7XX XXXX', 'data-testid': 'biz-d-phone' }))),
        field('dAddress', 'Delivery address', input({ placeholder: 'House or building, floor, road', 'data-testid': 'biz-d-address' })),
        el('div', { class: 'grid-2' }, field('dZone', 'Island or zone', select(zoneOptions(), 'Choose a zone', ''), {}), field('dLandmark', 'Landmark', input({ placeholder: 'Near the school' }), { optional: true })),
        field('dNote', 'Delivery instructions', input({ placeholder: 'Call before arriving' }), { optional: true }))),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Package and service')), el('div', { class: 'card__body stack-4' },
        MDM.ui.field({ label: 'Size', control: sizeSeg, hint: (s.sizeGuide || {}).box || '' }),
        el('div', { class: 'grid-2' }, field('description', 'What is it', input({ placeholder: 'Textbook order 1290', 'data-testid': 'biz-description' }), { optional: true }), field('reference', 'Your reference', input({ placeholder: 'Invoice or order number' }), { optional: true })),
        el('label', { class: 'checkbox' }, el('input', { type: 'checkbox', name: 'fragile' }), el('span', null, 'Fragile, handle with care')),
        scheduleBlock(form))),
      priceBox, failure,
      el('div', { class: 'form-actions' }, el('span', { class: 'small muted' }, 'Added to your monthly invoice. Nothing to pay now.'), submit));
    form.elements.dZone.closest('.field').querySelector('select').setAttribute('data-testid', 'biz-d-zone');
    const values = () => {
      const v = {}; ['cAddress', 'cZone', 'cName', 'cPhone', 'cNote', 'dName', 'dPhone', 'dAddress', 'dZone', 'dLandmark', 'dNote', 'description', 'reference', 'collectDate', 'collectTime', 'deliverDate', 'deliverTime'].forEach(k => { const c = form.elements[k]; v[k] = c ? String(c.value || '').trim() : ''; });
      v.size = form.elements.size.value; v.level = form.elements.level.value; v.fragile = form.elements.fragile.checked;
      return v;
    };
    const updatePrice = () => {
      const v = values();
      if (!v.dZone) { priceBox.replaceChildren(el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, 'Price', el('small', null, 'Choose the delivery zone to see the price')), el('span', { class: 'summary__amount' }, money(acc.ratePerPackage || (s.rates || {}).business)))); return; }
      const q = MDM.pricing.quote({ service: 'business', packages: [draftPackage(v)] }, s);
      const p = q.packages[0].price;
      priceBox.replaceChildren(...[
        el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, MDM.pricing.lineLabel(q.packages[0], 'business'), el('small', null, p.businessRate ? 'Business rate' : 'Standard rate (larger package or outside Malé and Hulhumalé)')), el('span', { class: 'summary__amount' }, money(q.totals.total))),
        q.totals.quoteRequired ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, q.totals.quoteReasons.map(MDM.pricing.reasonText).join('. ') + '. We confirm the final price before collection.')) : null,
        v.level === 'express' ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Express handling is confirmed by our team, any extra charge is shown before collection.')) : null].filter(Boolean));
    };
    form.addEventListener('input', updatePrice); form.addEventListener('change', updatePrice); updatePrice();
    const rules = {
      cAddress: v => v ? null : 'Enter the collection address', cZone: v => v ? null : 'Choose the zone',
      cPhone: v => MDM.ui.phone.valid(v, { landline: true }) ? null : 'Enter a valid contact number',
      dName: v => v ? null : 'Enter the recipient\'s name', dPhone: v => !v ? 'Enter the recipient\'s number' : (MDM.ui.phone.valid(v, { intl: true }) ? null : 'Enter a 7-digit Maldives number'),
      dAddress: v => v ? null : 'Enter the delivery address', dZone: v => v ? null : 'Choose the delivery zone',
    };
    form.addEventListener('submit', async e => {
      e.preventDefault(); failure.hidden = true;
      const r = MDM.ui.validate(form, rules);
      const v = values();
      const extra = advanceRules(v);
      Object.keys(extra).forEach(k => { if (form.elements[k]) setError(form.elements[k], extra[k]); });
      if (!r.ok || Object.keys(extra).some(k => extra[k])) { MDM.ui.focusFirstInvalid(form); return; }
      MDM.ui.setLoading(submit, true);
      try {
        const pkg = draftPackage(v);
        const q = MDM.pricing.quote({ service: 'business', packages: [pkg] }, s);
        const order = await MDM.store.createOrder({
          source: 'business', requestType: 'home', service: 'business', serviceLevel: v.level, accountId: acc.id, by: 'business:' + acc.id,
          customer: { name: acc.name, phone: acc.phone, email: acc.email || '', notify: 'whatsapp' },
          collection: { address: v.cAddress, zone: v.cZone, landmark: '', contactName: v.cName, contactPhone: pkg.pickup.contact.phone, instructions: v.cNote },
          delivery: { address: v.dAddress, zone: v.dZone, landmark: v.dLandmark, recipientName: v.dName, recipientPhone: pkg.dropoff.recipient.phone, instructions: v.dNote, meetAt: 'door' },
          details: { reference: v.reference }, packages: [pkg], schedule: scheduleValue(v), payment: { method: 'invoice', status: 'invoiced' },
          // Business-rate packages are priced already; anything that needs a quote (XL, Villimalé) waits for our team.
          status: q.totals.quoteRequired ? 'requested' : 'confirmed',
        });
        state.done.order = order;
        renderTab();
        MDM.ui.toast('Delivery booked: ' + order.code, 'ok');
      } catch (err) {
        failure.replaceChildren(html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' }, (err && err.message) || 'We could not book this delivery. Please try again.'));
        failure.hidden = false; failure.focus();
      } finally { if (document.contains(submit)) MDM.ui.setLoading(submit, false); }
    });
    return el('div', { class: 'biz-two' }, form, el('aside', { class: 'biz-aside' }, el('div', { class: 'card' }, el('div', { class: 'card__body stack-3 small' },
      el('h3', null, 'Many packages today?'), el('p', { class: 'muted' }, 'Use Bulk order to upload a spreadsheet. Every row becomes its own trackable delivery with a label.'),
      el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => go('bulk') } }, 'Bulk order')))));
  }
  function newOrderDone(o) {
    const title = el('h2', { tabindex: '-1' }, 'Delivery booked');
    setTimeout(() => title.focus(), 0);
    return el('div', { class: 'card biz-done', 'data-testid': 'biz-new-done' },
      el('div', { class: 'card__header' }, title, html(MDM.badgeFor(o.status))),
      el('div', { class: 'card__body stack-4' },
        el('p', null, 'Order ', el('strong', { class: 'mono--code' }, o.code), ' to ', el('strong', null, o.delivery.recipientName), ' in ' + MDM.geo.zoneLabel(o.delivery.zone) + '. ',
          o.status === 'requested' ? 'We confirm the price before collection.' : 'Priced at ' + money(o.totals.total) + ', added to your monthly invoice.'),
        el('div', { class: 'row row--wrap' },
          el('a', { class: 'btn btn--primary', href: labelsHref('order=' + encodeURIComponent(o.id)), 'data-testid': 'biz-done-label' }, html(MDM.icon('printer', 16)), 'Print label'),
          el('a', { class: 'btn btn--secondary', href: trackHref(o) }, 'Track'),
          el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'biz-new-another', on: { click: () => { state.done.order = null; renderTab(); } } }, 'Book another'))));
  }

  // ---- Bulk order --------------------------------------------------------------------------------------------------------------
  const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function parseZone(raw) {
    const n = norm(raw);
    if (!n) return '';
    const opts = zoneOptions();
    const direct = opts.find(o => norm(o.value) === n || norm(o.value.replace(/_/g, ' ')) === n || norm(o.label) === n || norm(MDM.geo.zoneShort(o.value)) === n);
    if (direct) return direct.value;
    if (/villi/.test(n)) return 'villimale';
    if (/airport|hulhule|velana/.test(n)) return 'airport';
    if (/(phase|ph|p) ?2|hm ?2/.test(n)) return 'hulhumale_p2';
    if (/hulhumale|hulhumal|phase|hm/.test(n)) return 'hulhumale_p1';
    if (/^male|^mal/.test(n)) return 'male';
    return '';
  }
  function parseSize(raw) { const n = norm(raw); if (!n) return 'bag'; if (/^x|large|big/.test(n)) return 'xl'; if (/^box|carton/.test(n)) return 'box'; return 'bag'; }
  // parseCSV(text) → rows of cells; handles quotes, commas, tabs (pasted from a spreadsheet) and semicolons.
  function parseCSV(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
    if (!lines.length) return [];
    const delim = lines[0].indexOf('\t') >= 0 ? '\t' : (lines[0].indexOf(';') >= 0 && lines[0].indexOf(',') < 0 ? ';' : ',');
    return lines.map(line => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else if (c === '"') q = true; else if (c === delim) { out.push(cur); cur = ''; } else cur += c;
      }
      out.push(cur);
      return out.map(x => x.trim());
    });
  }
  function csvToRows(text) {
    const cells = parseCSV(text);
    if (!cells.length) return [];
    let cols = CSV_COLUMNS.slice();
    const head = cells[0].map(norm);
    const known = { name: ['name', 'recipient', 'recipient name', 'customer'], phone: ['phone', 'mobile', 'number', 'contact', 'recipient phone'], address: ['address', 'delivery address'], zone: ['zone', 'island', 'area'], size: ['size', 'package size'], description: ['description', 'item', 'items', 'contents'], reference: ['reference', 'ref', 'order', 'order number', 'invoice'] };
    const isHeader = head.some(h => known.name.indexOf(h) >= 0) && head.some(h => known.phone.indexOf(h) >= 0 || known.address.indexOf(h) >= 0);
    let body = cells;
    if (isHeader) { cols = head.map(h => Object.keys(known).find(k => known[k].indexOf(h) >= 0) || null); body = cells.slice(1); }
    return body.map(r => { const o = {}; cols.forEach((k, i) => { if (k) o[k] = r[i] || ''; }); return { name: o.name || '', phone: o.phone || '', address: o.address || '', zone: parseZone(o.zone), zoneRaw: o.zone || '', size: parseSize(o.size), description: o.description || '', reference: o.reference || '' }; })
      .filter(r => r.name || r.phone || r.address);
  }
  const bulk = { rows: [], csv: false };
  const blankRow = () => ({ name: '', phone: '', address: '', zone: '', size: 'bag', description: '', reference: '' });
  async function tabBulk() {
    const acc = state.acc, s = await MDM.store.settings();
    if (state.done.batch) return bulkDone(state.done.batch);
    if (!bulk.rows.length) bulk.rows = [blankRow(), blankRow(), blankRow()];
    const form = el('form', { class: 'biz-form', novalidate: true, 'data-testid': 'biz-bulk-form' });
    const rowsEl = el('div', { class: 'bulk-rows', 'data-testid': 'biz-bulk-rows' });
    const summary = el('div', { class: 'summary', 'data-testid': 'biz-bulk-summary' });
    const failure = el('div', { class: 'alert alert--danger', role: 'alert', tabindex: '-1', hidden: true });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg', 'data-testid': 'biz-bulk-submit' }, 'Submit bulk order');
    const csvText = el('textarea', { class: 'textarea mono', rows: 4, placeholder: 'name,phone,address,zone,size,description,reference\nAishath Nadha,7720001,Amin Avenue Block B 4-02,Hulhumalé Phase 1,bag,Grade 7 textbooks,KB-2401', 'data-testid': 'biz-csv-text' });
    const fileInput = el('input', { type: 'file', accept: '.csv,text/csv,text/plain', class: 'sr-only', tabindex: '-1', 'data-testid': 'biz-csv-file' });
    const csvMsg = el('div', { class: 'small muted', role: 'status' });
    const template = 'data:text/csv;charset=utf-8,' + encodeURIComponent(CSV_COLUMNS.join(',') + '\nAishath Nadha,7720001,"Amin Avenue, Block B, Apt 4-02",Hulhumalé Phase 1,bag,Grade 7 textbook set,KB-2401\nIbrahim Shareef,7720002,"Ma. Ranfaru, Ameenee Magu",Malé,box,Grade 9 textbook set,KB-2402\n');

    function cell(label, ctrl, cls) { return el('label', { class: 'bulk-cell ' + (cls || '') }, el('span', { class: 'bulk-cell__label' }, label), ctrl); }
    function rowNode(r, i) {
      const upd = k => e => { r[k] = e.target.value; e.target.classList.remove('is-invalid'); e.target.removeAttribute('aria-invalid'); drawSummary(); };
      const zoneSel = el('select', { class: 'select input--sm', 'aria-label': 'Zone, row ' + (i + 1), on: { change: upd('zone') } }, el('option', { value: '' }, r.zoneRaw ? 'Check: ' + r.zoneRaw : 'Zone'), zoneOptions().map(o => el('option', { value: o.value }, MDM.geo.zoneShort(o.value))));
      zoneSel.value = r.zone || '';
      const sizeSel = el('select', { class: 'select input--sm', 'aria-label': 'Size, row ' + (i + 1), on: { change: upd('size') } }, SIZES.map(z => el('option', { value: z.value }, z.label)));
      sizeSel.value = r.size || 'bag';
      const inp = (k, label, attrs) => el('input', Object.assign({ class: 'input input--sm', value: r[k] || '', 'aria-label': label + ', row ' + (i + 1), 'data-k': k, on: { input: upd(k) } }, attrs || {}));
      return el('div', { class: 'bulk-row', 'data-row': String(i), 'data-testid': 'biz-bulk-row' },
        el('span', { class: 'bulk-row__num mono', 'aria-hidden': 'true' }, String(i + 1)),
        cell('Recipient', inp('name', 'Recipient')), cell('Phone', inp('phone', 'Phone', { type: 'tel', inputmode: 'numeric', placeholder: '7XX XXXX' })),
        cell('Address', inp('address', 'Address'), 'bulk-cell--wide'), cell('Zone', zoneSel), cell('Size', sizeSel),
        cell('Description', inp('description', 'Description')), cell('Reference', inp('reference', 'Reference')),
        el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm bulk-row__remove', 'aria-label': 'Remove row ' + (i + 1), on: { click: () => { bulk.rows.splice(i, 1); if (!bulk.rows.length) bulk.rows.push(blankRow()); drawRows(); } } }, html(MDM.icon('trash', 16))));
    }
    function drawRows() { rowsEl.replaceChildren(el('div', { class: 'bulk-head', 'aria-hidden': 'true' }, el('span', null, '#'), ['Recipient', 'Phone', 'Address', 'Zone', 'Size', 'Description', 'Reference'].map(h => el('span', null, h)), el('span', null)), ...bulk.rows.map(rowNode)); drawSummary(); }
    const filled = () => bulk.rows.filter(r => r.name || r.phone || r.address);
    function drawSummary() {
      const rows = filled();
      const byZone = {};
      let total = 0;
      rows.forEach(r => {
        byZone[r.zone || 'unknown'] = (byZone[r.zone || 'unknown'] || 0) + 1;
        if (r.zone) total += MDM.pricing.quote({ service: 'business', packages: [{ id: 'x', size: r.size, underOneFt: r.size !== 'xl', pickup: { zone: form.elements.cZone ? form.elements.cZone.value : acc.zone }, dropoff: { zone: r.zone } }] }, s).totals.total;
      });
      summary.replaceChildren(...[
        el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, plural(rows.length, 'package'), el('small', null, 'Each row becomes its own order with a tracking code and a label')), el('span', { class: 'summary__amount' }, money(total))),
        rows.length ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'By zone: ' + Object.keys(byZone).map(z => (z === 'unknown' ? 'Zone missing' : MDM.geo.zoneShort(z)) + ': ' + byZone[z]).join(' · '))) : null,
        el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Priced at the business rate where it applies; larger packages and other areas at standard rates. Invoiced monthly.'))].filter(Boolean));
    }
    function loadCSV(text, how) {
      const rows = csvToRows(text);
      if (!rows.length) { csvMsg.textContent = 'No rows found. Use the columns ' + CSV_COLUMNS.join(', ') + '.'; return; }
      const keep = filled();
      bulk.rows = keep.concat(rows); bulk.csv = true;
      const missing = rows.filter(r => !r.zone).length;
      csvMsg.textContent = 'Added ' + plural(rows.length, 'row') + ' from ' + how + '.' + (missing ? ' Choose the zone for ' + plural(missing, 'row') + '.' : '');
      drawRows();
    }
    fileInput.addEventListener('change', async () => { const f = fileInput.files && fileInput.files[0]; if (!f) return; loadCSV(await f.text(), f.name); fileInput.value = ''; });

    form.append(
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Collection'), el('span', { class: 'small muted' }, 'One pickup for the whole batch')),
        el('div', { class: 'card__body stack-4' }, collectionFields(acc, 'c'),
          el('div', { class: 'grid-2' }, MDM.ui.field({ label: 'Service', control: segmented('level', [{ value: 'normal', label: 'Normal' }, { value: 'express', label: 'Express' }], 'normal', 'biz-bulk-level') }),
            field('notes', 'Notes for our team', input({ placeholder: 'Term 3 textbook orders' }), { optional: true })))),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Import from a spreadsheet'), el('a', { class: 'btn btn--ghost btn--sm', href: template, download: 'mr-delivery-man-bulk-template.csv' }, html(MDM.icon('download', 16)), 'Template')),
        el('div', { class: 'card__body stack-3' },
          el('p', { class: 'small muted' }, 'Paste rows from Excel or Google Sheets, or upload a CSV. Columns: name, phone, address, zone, size, description, reference. A header row is optional.'),
          csvText,
          el('div', { class: 'row row--wrap' },
            el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'biz-csv-add', on: { click: () => { loadCSV(csvText.value, 'the pasted text'); csvText.value = ''; } } }, 'Add pasted rows'),
            el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => fileInput.click() } }, html(MDM.icon('upload', 16)), 'Upload CSV'), fileInput),
          csvMsg)),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Packages'),
        el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'biz-bulk-add', on: { click: () => { bulk.rows.push(blankRow()); drawRows(); const last = rowsEl.querySelector('.bulk-row:last-child input'); if (last) last.focus(); } } }, html(MDM.icon('plus', 16)), 'Add row')),
        el('div', { class: 'card__body' }, rowsEl)),
      summary, failure,
      el('div', { class: 'form-actions' }, el('span', { class: 'small muted' }, 'We collect, sort by zone and hand each package to the driver for its zone.'), submit));
    drawRows();

    form.addEventListener('submit', async e => {
      e.preventDefault(); failure.hidden = true;
      const crules = { cAddress: v => v ? null : 'Enter the collection address', cZone: v => v ? null : 'Choose the zone', cPhone: v => MDM.ui.phone.valid(v, { landline: true }) ? null : 'Enter a valid contact number' };
      const c = MDM.ui.validate(form, crules);
      const rows = filled();
      const problems = [];
      rowsEl.querySelectorAll('.bulk-row').forEach(node => {
        const r = bulk.rows[Number(node.dataset.row)];
        if (!(r.name || r.phone || r.address)) return;
        const bad = [];
        if (!r.name) bad.push(['name', 'recipient']);
        if (!MDM.ui.phone.valid(r.phone, { intl: true })) bad.push(['phone', 'phone']);
        if (!r.address) bad.push(['address', 'address']);
        if (!r.zone) bad.push(['zone', 'zone']);
        bad.forEach(b => { const ctl = b[0] === 'zone' ? node.querySelector('select') : node.querySelector('[data-k="' + b[0] + '"]'); if (ctl) { ctl.classList.add('is-invalid'); ctl.setAttribute('aria-invalid', 'true'); } });
        if (bad.length) problems.push('Row ' + (Number(node.dataset.row) + 1) + ': check the ' + bad.map(b => b[1]).join(', '));
      });
      if (!rows.length) problems.push('Add at least one package');
      if (!c.ok || problems.length) {
        if (problems.length) { failure.replaceChildren(html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' }, el('div', { class: 'alert__title' }, 'Fix these rows'), el('div', null, problems.slice(0, 6).join('. ') + (problems.length > 6 ? '. And ' + (problems.length - 6) + ' more.' : '.')))); failure.hidden = false; }
        const first = form.querySelector('[aria-invalid="true"]');
        if (first) { MDM.ui.scrollIntoViewIfNeeded(first); first.focus(); } else failure.focus();
        return;
      }
      MDM.ui.setLoading(submit, true);
      try {
        const v = c.values;
        const batch = await MDM.store.createBatch({
          accountId: acc.id, serviceLevel: form.elements.level.value, notes: String(form.elements.notes.value || '').trim(), source: bulk.csv ? 'csv' : 'portal', by: 'business:' + acc.id,
          collection: { address: v.cAddress, zone: v.cZone, landmark: '', contactName: String(form.elements.cName.value || '').trim(), contactPhone: MDM.ui.phone.normalize(v.cPhone) || v.cPhone, instructions: String(form.elements.cNote.value || '').trim() },
          rows: rows.map(r => ({ name: r.name.trim(), phone: MDM.ui.phone.normalize(r.phone) || r.phone, address: r.address.trim(), zone: r.zone, size: r.size, description: r.description.trim(), reference: r.reference.trim(), fragile: false, instructions: '' })),
        });
        bulk.rows = []; bulk.csv = false;
        state.done.batch = batch;
        renderTab();
        MDM.ui.toast('Bulk order ' + batch.code + ' submitted', 'ok');
      } catch (err) {
        failure.replaceChildren(html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' }, (err && err.message) || 'We could not submit this bulk order.'));
        failure.hidden = false; failure.focus();
      } finally { if (document.contains(submit)) MDM.ui.setLoading(submit, false); }
    });
    return form;
  }
  function bulkDone(b) {
    const title = el('h2', { tabindex: '-1' }, 'Bulk order submitted');
    setTimeout(() => title.focus(), 0);
    const n = (b.orderIds || []).length;
    return el('div', { class: 'card biz-done', 'data-testid': 'biz-bulk-done' },
      el('div', { class: 'card__header' }, title, el('span', { class: 'mono--code' }, b.code)),
      el('div', { class: 'card__body stack-4' },
        el('p', null, plural(n, 'package') + ' confirmed at your business rate. We collect from ' + b.collection.address + ', sort them by zone and send each one with the driver for that zone.'),
        el('div', { class: 'row row--wrap' },
          el('a', { class: 'btn btn--primary', href: labelsHref('batch=' + encodeURIComponent(b.id)), 'data-testid': 'biz-bulk-labels' }, html(MDM.icon('printer', 16)), 'Print ' + plural(n, 'label')),
          el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => { state.done.batch = null; state.filters.batch = b.id; state.filters.status = 'all'; state.filters.range = 'all'; go('orders'); } } }, 'See the packages'),
          el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => { state.done.batch = null; renderTab(); } } }, 'New bulk order'))));
  }

  // ---- Orders --------------------------------------------------------------------------------------------------------------------
  const STATUS_FILTERS = [
    { value: 'all', label: 'All statuses' }, { value: 'open', label: 'Open' }, { value: 'out_for_delivery', label: 'Out for delivery' },
    { value: 'delivered', label: 'Delivered' }, { value: 'failed', label: 'Failed' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'requested', label: 'Waiting for price' },
  ];
  const RANGES = [{ value: 'today', label: 'Today' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: 'month', label: 'This month' }, { value: 'all', label: 'All time' }];
  function inRange(iso, range) {
    if (range === 'all') return true;
    const d = new Date(iso), now = new Date();
    if (range === 'today') return MDM.ui.dayKey(d) === MDM.ui.dayKey(now);
    if (range === 'month') return MDM.ui.monthKey(d) === MDM.ui.monthKey(now);
    return now - d <= Number(range) * 86400000;
  }
  async function tabOrders() {
    const d = await load();
    const f = state.filters;
    const batchById = {}; d.batches.forEach(b => { batchById[b.id] = b; });
    const q = norm(f.q);
    const rows = d.orders.filter(o => {
      if (f.status === 'open' ? OPEN.indexOf(o.status) < 0 : (f.status !== 'all' && o.status !== f.status)) return false;
      if (f.batch === 'single' ? !!o.batchId : (f.batch && o.batchId !== f.batch)) return false;
      if (!inRange(o.createdAt, f.range)) return false;
      if (q) { const r = recipientOf(o); const hay = norm([o.code, r.name, r.phone, (o.delivery || {}).address, (o.details || {}).reference, (o.packages || []).map(p => p.description).join(' ')].join(' ')); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Code, recipient, reference', value: f.q, 'aria-label': 'Search orders', 'data-testid': 'biz-orders-search' });
    search.addEventListener('input', MDM.ui.debounce(() => { f.q = search.value; redraw(); }, 200));
    const sel = (opts, key, label, testid) => { const s = el('select', { class: 'select', 'aria-label': label, 'data-testid': testid, on: { change: e => { f[key] = e.target.value; redraw(); } } }, opts.map(o => el('option', { value: o.value }, o.label))); s.value = f[key]; return s; };
    const batchOpts = [{ value: '', label: 'All orders' }, { value: 'single', label: 'Single orders' }].concat(d.batches.map(b => ({ value: b.id, label: 'Bulk ' + b.code })));
    const table = rows.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack', 'data-testid': 'biz-orders-table' },
      el('thead', null, el('tr', null, ['Order', 'Recipient', 'Package', 'Status', 'Amount', ''].map((h, i) => el('th', { class: i === 4 ? 'num' : null }, h)))),
      el('tbody', null, rows.map(o => {
        const r = recipientOf(o), pkg = (o.packages || [])[0] || {}, b = o.batchId ? batchById[o.batchId] : null;
        return el('tr', { 'data-testid': 'biz-row-' + o.code },
          el('td', { class: 'table__primary' }, el('div', null, el('a', { class: 'mono--code', href: trackHref(o) }, o.code), el('span', { class: 'table__sub' }, fmtDate(o.createdAt) + (b ? ' · ' + b.code + ' #' + o.batchIndex : '')))),
          el('td', { 'data-label': 'Recipient' }, el('div', null, r.name, el('span', { class: 'table__sub table__address' }, MDM.geo.zoneShort((o.delivery || {}).zone) + ' · ' + ((o.delivery || {}).address || '')))),
          el('td', { 'data-label': 'Package' }, el('div', null, MDM.pricing.sizeLabel(pkg.size) + (pkg.description ? ' · ' + pkg.description : ''), (o.details || {}).reference ? el('span', { class: 'table__sub' }, 'Ref ' + o.details.reference) : null)),
          el('td', { 'data-label': 'Status' }, el('div', { class: 'biz-status' }, html(MDM.badgeFor(o.status)), priorityTag(o))),
          el('td', { class: 'num mono nowrap', 'data-label': 'Amount' }, money(o.totals ? o.totals.total : 0)),
          el('td', { class: 'biz-row-actions' }, el('div', { class: 'row' },
            OPEN.indexOf(o.status) >= 0 && !(o.priority && ['requested', 'approved'].indexOf(o.priority.status) >= 0) ? el('a', { class: 'btn btn--ghost btn--sm', href: '#priority?order=' + encodeURIComponent(o.id), 'aria-label': 'Ask for priority on ' + o.code }, 'Priority') : null,
            el('a', { class: 'btn btn--ghost btn--sm', href: labelsHref('order=' + encodeURIComponent(o.id)), 'aria-label': 'Label for ' + o.code }, html(MDM.icon('printer', 16)), 'Label'),
            el('a', { class: 'btn btn--secondary btn--sm', href: trackHref(o) }, 'Track'))));
      })))) : empty('No orders match', 'Change the filters or search for another code.');
    const batches = f.batch && f.batch !== 'single' && batchById[f.batch] ? [batchById[f.batch]] : d.batches;
    const wrap = el('div', { class: 'stack-6' },
      d.batches.length ? el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, f.batch && batchById[f.batch] ? 'Bulk order ' + batchById[f.batch].code : 'Bulk orders')), el('div', { class: 'list' }, batches.map(batchRow))) : null,
      el('div', { class: 'stack-4' },
        el('div', { class: 'filters' }, search, sel(STATUS_FILTERS, 'status', 'Status', 'biz-orders-status'), sel(RANGES, 'range', 'Date', 'biz-orders-range'), sel(batchOpts, 'batch', 'Batch', 'biz-orders-batch')),
        el('p', { class: 'small muted', role: 'status' }, plural(rows.length, 'order') + (rows.length ? ' · ' + money(rows.reduce((n, o) => n + (o.totals ? o.totals.total : 0), 0)) : '')),
        table));
    function redraw() { tabOrders().then(n => { const focusSearch = document.activeElement === search; panel.replaceChildren(n); if (focusSearch) { const s2 = panel.querySelector('[data-testid="biz-orders-search"]'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } } }); }
    return wrap;
  }

  // ---- Priority (requirements §11) ------------------------------------------------------------------------------------------
  let priorityList = null;
  function decisionBadge(r) {
    const map = { pending: ['warn', 'Waiting'], approved: ['ok', 'Approved'], updated: ['info', 'Updated'], rejected: ['danger', 'Declined'] };
    const m = map[r.decision] || ['neutral', r.decision];
    return html(MDM.ui.badge(m[0], m[1]));
  }
  function deadlineLabel(v) { const d = new Date(String(v).replace(' ', 'T')); return isNaN(d) ? String(v) : fmtDate(d); }
  async function priorityRequests() {
    const orders = await MDM.store.list('orders', { where: { accountId: state.acc.id } });
    const out = [];
    orders.forEach(o => ((o.priority || {}).requests || []).forEach(r => out.push({ o, r })));
    return out.sort((a, b) => a.r.at < b.r.at ? 1 : -1);
  }
  async function refreshPriorityList() { if (priorityList && document.contains(priorityList)) await fillPriorityList(priorityList); }
  async function fillPriorityList(target) {
    const reqs = await priorityRequests();
    target.replaceChildren(reqs.length ? el('div', { class: 'list' }, reqs.map(({ o, r }) => el('div', { class: 'list__item list__item--top', 'data-testid': 'biz-priority-' + o.code },
      el('div', { class: 'list__main' },
        el('div', { class: 'list__title' }, el('a', { class: 'mono--code', href: trackHref(o) }, o.code), ' · ', recipientOf(o).name),
        el('div', { class: 'list__meta' }, r.reason || 'No reason given'),
        el('div', { class: 'list__meta' }, 'Asked ' + fmtDate(r.at) + (r.deadline ? ' · Needed by ' + deadlineLabel(r.deadline) : '') + (r.instructions ? ' · ' + r.instructions : '')),
        r.remarks ? el('div', { class: 'list__meta' }, 'Our team: ' + r.remarks) : null,
        r.decision !== 'pending' && r.decision !== 'rejected' && o.priority && o.priority.level ? el('div', { class: 'list__meta' }, 'Marked ' + ((MDM.PRIORITY_LEVELS.find(x => x.value === o.priority.level) || {}).label || 'Priority')) : null),
      el('div', { class: 'list__aside' }, decisionBadge(r))))) : empty('No priority requests yet', 'Ask for a deadline on any open order and our team approves it.'));
  }
  async function tabPriority() {
    const acc = state.acc;
    const orders = (await MDM.store.list('orders', { where: { accountId: acc.id } })).filter(o => OPEN.indexOf(o.status) >= 0 && !(o.priority && o.priority.status === 'requested'));
    const form = el('form', { class: 'form', novalidate: true, 'data-testid': 'biz-priority-form' });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'biz-priority-submit' }, 'Send priority request');
    const pre = new URLSearchParams((location.hash.split('?')[1]) || '').get('order');
    const orderSel = el('select', { class: 'select', 'data-testid': 'biz-priority-order' }, el('option', { value: '' }, orders.length ? 'Choose an open order' : 'No open orders'),
      orders.map(o => el('option', { value: o.id }, o.code + ' · ' + recipientOf(o).name + ' · ' + MDM.STATUS[o.status].label + (o.priority && o.priority.status === 'approved' ? ' · already priority' : ''))));
    if (pre) orderSel.value = pre;
    form.append(
      field('order', 'Order', orderSel),
      field('reason', 'Reason', input({ placeholder: 'Exam papers must arrive before the 2 pm paper', 'data-testid': 'biz-priority-reason' })),
      el('div', { class: 'grid-2' }, field('deadline', 'Deadline', input({ type: 'datetime-local', 'data-testid': 'biz-priority-deadline' })), el('div')),
      field('instructions', 'Instructions', el('textarea', { class: 'textarea', rows: 2, placeholder: 'Hand to the exam office only, signature needed' }), { optional: true }),
      el('div', { class: 'form-actions' }, el('span', { class: 'small muted' }, 'Our team approves or declines it; you see the decision here and on the tracking page.'), submit));
    if (acc.priorityAllowed === false) form.prepend(MDM.ui.notice('warn', 'Priority requests are not enabled on this account. Call us to turn them on.'));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const r = MDM.ui.validate(form, { order: v => v ? null : 'Choose the order', reason: v => v ? null : 'Tell us why it is urgent', deadline: v => !v ? 'Choose the deadline' : (new Date(v) < new Date() ? 'Choose a time in the future' : null) });
      if (!r.ok) { MDM.ui.focusFirstInvalid(form); return; }
      MDM.ui.setLoading(submit, true);
      try {
        const o = await MDM.store.requestPriority(r.values.order, { reason: r.values.reason, deadline: r.values.deadline.replace('T', ' '), instructions: String(form.elements.instructions.value || '').trim(), by: 'business:' + acc.id });
        MDM.ui.toast('Priority requested for ' + o.code, 'ok');
        panel.replaceChildren(await tabPriority());
      } catch (err) { MDM.ui.toast((err && err.message) || 'Could not send the request', 'danger'); }
      finally { if (document.contains(submit)) MDM.ui.setLoading(submit, false); }
    });
    priorityList = el('div', { class: 'biz-plist', 'data-testid': 'biz-priority-list' });
    const out = el('div', { class: 'grid-2 biz-overview' },
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Request priority delivery')), el('div', { class: 'card__body' }, form)),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Your requests')), priorityList));
    await fillPriorityList(priorityList);
    return out;
  }

  // ---- Invoices ----------------------------------------------------------------------------------------------------------------
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthLabel = key => { const m = /^(\d{4})-(\d{2})$/.exec(key || ''); return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : String(key || ''); };
  async function tabInvoices() {
    const d = await load();
    const month = MDM.ui.monthKey();
    const delivered = d.orders.filter(o => o.status === 'delivered' && MDM.ui.monthKey(deliveredAt(o)) === month);
    const pkgs = delivered.reduce((n, o) => n + (o.packages || []).length, 0);
    const amount = delivered.reduce((n, o) => n + (o.totals ? o.totals.total : 0), 0);
    const invoices = d.invoices.slice().sort((a, b) => a.month < b.month ? 1 : -1);
    return el('div', { class: 'stack-6' },
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, monthLabel(month) + ' so far'), el('span', { class: 'small muted' }, 'Running total, invoiced at month end')),
        el('div', { class: 'card__body' }, el('div', { class: 'rate-table' },
          MDM.ui.rateRow('Packages delivered', String(pkgs)), MDM.ui.rateRow('Orders', String(delivered.length)), MDM.ui.rateRow('Amount', money(amount), { mono: true }),
          MDM.ui.rateRow('Payment', 'Bank transfer', { valueSub: 'Due ' + plural(d.settings.invoiceDueDays || 14, 'day') + ' after the invoice' })))),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Invoices')),
        invoices.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack', 'data-testid': 'biz-invoices' },
          el('thead', null, el('tr', null, ['Invoice', 'Month', 'Status', 'Due', 'Total', ''].map((h, i) => el('th', { class: i === 4 ? 'num' : null }, h)))),
          el('tbody', null, invoices.map(inv => el('tr', null,
            el('td', { class: 'table__primary' }, el('span', { class: 'mono--code' }, inv.number)),
            el('td', { 'data-label': 'Month' }, monthLabel(inv.month)),
            el('td', { 'data-label': 'Status' }, html(MDM.ui.invoiceBadge(inv.status))),
            el('td', { 'data-label': 'Due' }, fmtDate(inv.dueAt, { dateOnly: true })),
            el('td', { class: 'num mono', 'data-label': 'Total' }, MDM.pricing.format(inv.total, { cents: true })),
            el('td', null, el('a', { class: 'btn btn--secondary btn--sm', href: MDM.href('admin/invoice.html?id=' + encodeURIComponent(inv.id)), target: '_blank', rel: 'noopener', 'data-testid': 'biz-invoice-open' }, 'Open')))))))
          : empty('No invoices yet', 'Your first invoice is issued at the end of the month.')));
  }

  // ---- Labels (How it works §9) ------------------------------------------------------------------------------------------------
  async function tabLabels() {
    const d = await load();
    const open = d.orders.filter(o => OPEN.indexOf(o.status) >= 0 && o.status !== 'failed');
    const sel = state.selected;
    [...sel].forEach(id => { if (!open.some(o => o.id === id)) sel.delete(id); });
    const printBtn = el('a', { class: 'btn btn--primary', 'data-testid': 'biz-labels-print' });
    const sync = () => {
      const n = sel.size;
      printBtn.textContent = n ? 'Print ' + plural(n, 'label') : 'Select orders to print';
      if (n) { printBtn.href = labelsHref('orders=' + [...sel].map(encodeURIComponent).join(',')); printBtn.removeAttribute('aria-disabled'); }
      else { printBtn.removeAttribute('href'); printBtn.setAttribute('aria-disabled', 'true'); }
    };
    const all = el('input', { type: 'checkbox', 'aria-label': 'Select all', checked: open.length > 0 && open.every(o => sel.has(o.id)), on: { change: e => { open.forEach(o => { if (e.target.checked) sel.add(o.id); else sel.delete(o.id); }); panel.querySelectorAll('[data-pick]').forEach(c => { c.checked = e.target.checked; }); sync(); } } });
    sync();
    return el('div', { class: 'stack-6' },
      d.batches.length ? el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'By bulk order'), el('span', { class: 'small muted' }, 'One label per package')),
        el('div', { class: 'list' }, d.batches.map(b => el('div', { class: 'list__item' },
          el('div', { class: 'list__main' }, el('div', { class: 'list__title mono--code' }, b.code), el('div', { class: 'list__meta' }, fmtDate(b.createdAt) + ' · ' + plural((b.orderIds || []).length, 'package') + (b.notes ? ' · ' + b.notes : ''))),
          el('a', { class: 'btn btn--secondary btn--sm', href: labelsHref('batch=' + encodeURIComponent(b.id)) }, html(MDM.icon('printer', 16)), 'Print ' + plural((b.orderIds || []).length, 'label')))))) : null,
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Open orders'), printBtn),
        open.length ? el('div', { class: 'list biz-pick' },
          el('label', { class: 'checkbox biz-pick__all' }, all, el('span', null, 'Select all ' + plural(open.length, 'open order'))),
          open.map(o => el('label', { class: 'checkbox biz-pick__item' },
            el('input', { type: 'checkbox', 'data-pick': o.id, checked: sel.has(o.id), on: { change: e => { if (e.target.checked) sel.add(o.id); else sel.delete(o.id); sync(); } } }),
            el('span', null, el('span', { class: 'mono--code' }, o.code), ' · ', recipientOf(o).name),
            el('span', { class: 'checkbox__hint' }, MDM.geo.zoneShort((o.delivery || {}).zone) + ' · ' + plural((o.packages || []).length, 'package') + ' · ' + MDM.STATUS[o.status].label))))
          : empty('No open orders', 'Labels for delivered orders are not needed.')));
  }

  // =========================================================================================================================
  async function render() {
    const s = await MDM.store.settings();
    state.settings = s || {};
    state.acc = await currentAccount();
    if (state.acc) { if (!panel || !app.contains(panel)) renderPortal(); else renderTab(); }
    else { panel = null; if (readSession()) clearSession(); renderPublic(state.settings); }
  }
  async function main() {
    await MDM.store.ready;
    await render();
    window.addEventListener('hashchange', () => { if (state.acc) renderTab(); });
    ['orders', 'batches', 'invoices'].forEach(c => MDM.store.subscribe(c, refresh));
    MDM.store.subscribe('settings', () => { if (!state.acc) render(); });
    MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') { state.received = null; state.done = { order: null, batch: null }; panel = null; render(); } });
    window.addEventListener('storage', e => { if (e.key === SESSION) { panel = null; render(); } });
  }
  main();
})(window.MDM);

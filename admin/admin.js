// Admin portal core: the sign-in gate (admin, operator and office roles), the hash router with role permissions, sidebar counts,
// the Overview dashboard (client requirements §19) and the helpers every admin view shares. Views register themselves as
// MDM.admin.views[name] = { title, mount(el, params) → Promise, unmount(), update?(params) }; the router awaits unmount() before
// mount() and calls update() instead when only the id or query of the same view changed. Filters write back to the hash through
// MDM.admin.setQuery (history.replaceState), so a reload keeps them.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const SESSION_KEY = 'mdm:session';
  const PASSWORD = 'delivery';
  const TITLE = 'Mr. Delivery Man';
  const ONLINE_MS = 10 * 60 * 1000;          // a driver counts as online when their last position is this recent
  const STALE_MS = 60 * 1000;
  const ROLE_LABEL = { admin: 'Admin', operator: 'Operator', office: 'Office staff' };
  const views = {};
  const mainEl = document.getElementById('main');
  const state = { session: null, current: null, name: null, routing: null, queued: false, loginUser: '', countsUnsub: null, countsTimer: null };

  // ---- Session and permissions ---------------------------------------------------------------------------------------------
  function readSession() {
    try {
      const v = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!v || !v.user) return null;
      if (!v.role) v.role = 'admin';
      if (!v.name) v.name = ROLE_LABEL[v.role] || v.user;
      return v;
    } catch (e) { return null; }
  }
  function writeSession(v) {
    try { if (v) localStorage.setItem(SESSION_KEY, JSON.stringify(v)); else localStorage.removeItem(SESSION_KEY); } catch (e) { /* private mode: the session lasts for this page only */ }
  }
  function user() { return state.session ? Object.assign({}, state.session) : null; }
  // by(): the actor string written on every audit event (admin → 'admin', everyone else → 'operator:<staffId>').
  function by() { const s = state.session || {}; return !s.role || s.role === 'admin' ? 'admin' : 'operator:' + (s.staffId || s.user); }
  function allowed() { return (MDM.shell && MDM.shell.allowedViews) ? MDM.shell.allowedViews() : Object.keys(views); }
  function can(view) { return allowed().indexOf(view) >= 0; }

  // ---- Hash grammar: #/<view>[/<id>][?<query>] ---------------------------------------------------------------------------
  function parseHash(h) {
    const m = /^#?\/?([a-z_-]*)(?:\/([^?#]*))?(?:\?(.*))?$/i.exec(String(h || ''));
    let id = m && m[2] ? m[2] : null;
    if (id) { try { id = decodeURIComponent(id); } catch (e) { /* keep as typed */ } }
    return { view: m && m[1] ? m[1].toLowerCase() : '', id, query: new URLSearchParams(m && m[3] ? m[3] : '') };
  }
  function params() { return parseHash(location.hash); }
  function buildHash(view, id, query) {
    const q = query ? String(query) : '';
    return '#/' + view + (id ? '/' + encodeURIComponent(id) : '') + (q ? '?' + q : '');
  }
  function navigate(hash) {
    const h = String(hash || '');
    location.hash = h.charAt(0) === '#' ? h : '#' + (h.charAt(0) === '/' ? '' : '/') + h;
  }
  // setQuery({ status: 'assigned', q: null }) merges into the current query; null/'' removes a key. No hashchange fires.
  function setQuery(obj) {
    const p = params();
    Object.keys(obj || {}).forEach(k => { const v = obj[k]; if (v == null || v === '' || v === false) p.query.delete(k); else p.query.set(k, String(v)); });
    history.replaceState(null, '', buildHash(p.view || 'overview', p.id, p.query));
    return params();
  }
  function openOrder(orderId) {
    const p = params();
    navigate(buildHash('orders', orderId, p.view === 'orders' ? p.query : null));
  }

  // ---- Router ---------------------------------------------------------------------------------------------------------------
  async function teardown() {
    const cur = state.current;
    state.current = null; state.name = null;
    if (cur) { try { await cur.unmount(); } catch (e) { /* a view that fails to unmount must not block the next one */ } }
    if (MDM.ui.drawer.isOpen()) MDM.ui.drawer.close();
    mainEl.replaceChildren();
  }
  function focusHeading(host) {
    const h1 = host.querySelector('h1[tabindex="-1"]');
    if (h1) { try { h1.focus({ preventScroll: true }); } catch (e) { h1.focus(); } }
  }
  function forbidden(view) {
    const host = el('div', { class: 'view view--forbidden', 'data-view': 'forbidden', 'data-testid': 'admin-forbidden' },
      el('div', { class: 'page-head' }, el('h1', { tabindex: '-1' }, 'Your role cannot open this page'),
        el('p', { class: 'page-head__desc' }, 'You are signed in as ' + (ROLE_LABEL[(state.session || {}).role] || 'staff').toLowerCase() + '. Ask an admin if you need ' + view + '.')),
      el('div', { class: 'card' }, el('div', { class: 'card__body' }, el('a', { class: 'btn btn--secondary', href: '#/overview' }, 'Back to the overview'))));
    return host;
  }
  async function route() {
    if (!state.session) return;
    if (state.routing) { state.queued = true; return; }
    const p = params();
    if (!p.view || !views[p.view]) { location.replace(buildHash(can('overview') ? 'overview' : allowed()[0])); return; }
    state.routing = (async () => {
      if (!can(p.view)) {
        await teardown();
        mainEl.classList.add('admin__content');
        const host = forbidden(p.view);
        mainEl.appendChild(host);
        document.title = 'No access · Admin · ' + TITLE;
        MDM.shell.setActive(p.view);
        focusHeading(host);
        return;
      }
      const view = views[p.view];
      if (state.current === view && typeof view.update === 'function') { await view.update(p); return; }
      await teardown();
      mainEl.classList.add('admin__content');
      const host = el('div', { class: 'view view--' + p.view, 'data-view': p.view });
      mainEl.appendChild(host);
      state.current = view; state.name = p.view;
      document.title = view.title + ' · Admin · ' + TITLE;
      MDM.shell.setActive(p.view);
      await view.mount(host, p);
      if (state.current === view) focusHeading(host);
    })();
    try { await state.routing; }
    catch (e) { MDM.ui.toast('This view could not load. ' + (e && e.message ? e.message : ''), 'danger'); }
    finally { state.routing = null; }
    if (state.queued) { state.queued = false; route(); }
  }

  // ---- Sign in ----------------------------------------------------------------------------------------------------------------
  // Office staff (admin, operators, office) sign in with their username; the demo password is the same for everyone.
  function renderLogin(showError) {
    MDM.shell.setChrome(false);
    mainEl.classList.remove('admin__content');
    document.title = 'Sign in · Admin · ' + TITLE;
    const userIn = el('input', { class: 'input', id: 'admin-user', name: 'username', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', 'data-testid': 'admin-user', value: state.loginUser || '' });
    const passIn = el('input', { class: 'input', id: 'admin-pass', name: 'password', type: 'password', autocomplete: 'current-password', 'data-testid': 'admin-pass' });
    const errBox = el('div', { class: 'alert alert--danger', role: 'alert', 'data-testid': 'admin-login-error', hidden: !showError },
      html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' }, 'Wrong username or password'));
    const form = el('form', { class: 'card auth__card', novalidate: true, 'data-testid': 'admin-login-form', on: { submit: async e => {
      e.preventDefault();
      const u = userIn.value.trim().toLowerCase(), pw = passIn.value;
      state.loginUser = u;
      const staff = await MDM.store.list('staff');
      const s = staff.find(x => String(x.username || '').toLowerCase() === u && ['admin', 'operator', 'office'].indexOf(x.role) >= 0 && x.status !== 'inactive');
      if (s && pw === PASSWORD) { signIn({ user: s.username, staffId: s.id, role: s.role, name: s.name, at: new Date().toISOString() }); return; }
      errBox.hidden = false; passIn.value = ''; passIn.focus();
    } } },
      el('div', { class: 'brand' }, html(MDM.logo())),
      el('h1', null, 'Office sign-in'),
      el('div', { class: 'alert alert--info' }, html(MDM.icon('info', 16)), el('div', { class: 'alert__body' }, 'Demo: admin, operator or lamya (office staff), password delivery')),
      errBox,
      el('div', { class: 'field' }, el('label', { for: 'admin-user' }, 'Username'), userIn),
      el('div', { class: 'field' }, el('label', { for: 'admin-pass' }, 'Password'), passIn),
      el('button', { type: 'submit', class: 'btn btn--primary btn--block', 'data-testid': 'admin-login' }, 'Sign in'),
      el('p', { class: 'auth__note' }, el('a', { href: MDM.href('login/?as=admin&reset=1') }, 'Forgot your password?')));
    mainEl.replaceChildren(el('div', { class: 'auth' }, form));
    (showError || userIn.value ? passIn : userIn).focus();
  }
  // The sidebar is built from the role when the page loads, so a fresh sign-in reloads once to show the right menu.
  function signIn(session) { writeSession(session); location.reload(); }
  async function signOut() {
    await teardown();
    stopCounts();
    if (state.session) MDM.store.audit('signed_out', (state.session.name || 'Staff') + ' signed out of the portal', by()).catch(() => {});
    state.session = null; writeSession(null);
    renderLogin(false);
  }

  // ---- Sidebar counts: what needs someone ---------------------------------------------------------------------------------------
  function queues(orders) {
    return {
      quotes: orders.filter(o => o.status === 'requested'),
      reviews: orders.filter(o => o.payment && o.payment.status === 'received'),
      unassigned: orders.filter(o => o.status === 'confirmed' && !o.driverId && !o.batchId),
      failed: orders.filter(o => o.status === 'failed'),
      cancels: orders.filter(o => o.cancellation && o.cancellation.status === 'requested' && ['cancelled', 'delivered', 'returned'].indexOf(o.status) < 0),
      priority: orders.filter(o => o.priority && o.priority.status === 'requested' && ['cancelled', 'delivered', 'returned'].indexOf(o.status) < 0),
    };
  }
  async function refreshCounts() {
    if (!state.session) return;
    const [orders, requests, leaves, batches] = await Promise.all([MDM.store.list('orders'), MDM.store.list('business_requests', { where: { status: 'pending' } }),
      MDM.store.list('leaves', { where: { status: 'pending' } }), MDM.store.list('batches', { where: { status: 'confirmed' } })]);
    const q = queues(orders);
    const counts = {};
    Object.keys(q).forEach(k => { counts[k] = q[k].length; });
    counts.requests = { value: requests.length, hot: true };
    counts.leaves = { value: leaves.length, hot: true };
    counts.batches = { value: batches.length, hot: true };
    MDM.shell.setCounts(counts);
  }
  function startCounts() {
    refreshCounts().catch(() => {});
    if (!state.countsUnsub) state.countsUnsub = MDM.store.subscribe('*', () => { clearTimeout(state.countsTimer); state.countsTimer = setTimeout(() => refreshCounts().catch(() => {}), 60); });
  }
  function stopCounts() { if (state.countsUnsub) { state.countsUnsub(); state.countsUnsub = null; } clearTimeout(state.countsTimer); }

  // ---- Shared formatting and table helpers (MDM.admin.fmt) ----------------------------------------------------------------
  const SERVICE = { pick: 'Pick & deliver', shop: 'Shop & deliver', business: 'Business', store: 'E-store' };
  const LEVEL = { normal: 'Normal', express: 'Express', advance: 'Advance order' };
  const SOURCE = { web: 'Website', viber: 'Viber', whatsapp: 'WhatsApp', phone: 'Phone', walkin: 'Walk-in', business: 'Business portal', portal: 'Business portal', csv: 'CSV import', store: 'E-store' };
  const NOTIFY = { sms: 'SMS', whatsapp: 'WhatsApp', viber: 'Viber', email: 'Email' };
  const DONE = ['delivered', 'returned', 'cancelled'];
  const money = n => MDM.pricing.format(n);
  const plural = (n, word, pluralForm) => MDM.ui.plural(n, word, pluralForm);
  function uniq(arr) { return arr.filter((v, i) => v && arr.indexOf(v) === i); }
  const NBSP = ' ';
  const nb = s => String(s).replace(/ /g, NBSP);
  // One line per cell: "just now" / "22 min ago" as is, the time ("12:24") for the rest of today, the date ("20 Sep") for older rows.
  function whenCell(iso) {
    const t = MDM.ui.timeAgo(iso);
    if (t.indexOf(',') < 0) return nb(t);
    return nb(MDM.ui.dayKey(iso) === MDM.ui.dayKey(new Date()) ? MDM.ui.fmtTime(iso) : MDM.ui.fmtDate(iso, { dateOnly: true }));
  }
  function pickupZone(pkg, service) { return service === 'shop' && pkg.shop ? pkg.shop.zone : (pkg.pickup ? pkg.pickup.zone : null); }
  // routeText(order) → 'Malé → HM Ph. 1' (zone shorts, unique, in package order)
  function routeText(o) {
    const pk = (o.packages || []);
    const from = uniq(pk.map(p => MDM.geo.zoneShort(pickupZone(p, o.service) || (o.collection && o.collection.zone) || 'male')));
    const to = uniq(pk.map(p => MDM.geo.zoneShort(p.dropoff ? p.dropoff.zone || 'male' : 'male')));
    return (from.map(nb).join(', ') || 'Malé') + NBSP + '→' + NBSP + (to.map(nb).join(', ') || 'Malé');
  }
  function paymentBadge(o) {
    const st = (o.payment && o.payment.status) || 'pending';
    const s = MDM.PAYMENT[st] || { label: st, kind: 'neutral' };
    return html(MDM.ui.badge(s.kind, s.label, { 'data-status': st, 'data-testid': 'payment-badge' }));
  }
  function typeLabel(o) { return MDM.requestTypeLabel(o.requestType); }
  // flags(order) → [{ kind, label }]: priority, express, advance, cancellation and priority requests the office has to see in a list.
  function flags(o) {
    const out = [];
    const p = o.priority || {};
    if (p.status === 'approved' && p.level && p.level !== 'normal') out.push({ kind: 'warn', label: (MDM.PRIORITY_LEVELS.find(x => x.value === p.level) || {}).label || 'Priority', key: 'priority' });
    else if (o.serviceLevel === 'express' && DONE.indexOf(o.status) < 0) out.push({ kind: 'warn', label: 'Express', key: 'express' });
    if (p.status === 'requested' && DONE.indexOf(o.status) < 0) out.push({ kind: 'warn', label: 'Priority requested', key: 'priority-request' });
    if (o.cancellation && o.cancellation.status === 'requested' && DONE.indexOf(o.status) < 0) out.push({ kind: 'danger', label: 'Cancel requested', key: 'cancel-request' });
    if (o.serviceLevel === 'advance' && DONE.indexOf(o.status) < 0) out.push({ kind: 'info', label: 'Advance', key: 'advance' });
    return out;
  }
  function flagNodes(o) { const f = flags(o); return f.length ? el('span', { class: 'row-flags' }, f.map(x => html(MDM.ui.badge(x.kind, x.label, { 'data-flag': x.key })))) : null; }
  function driverName(id, drivers) { const d = id && (drivers || []).find(x => x.id === id); return d ? d.name : ''; }
  function byLabel(who) { return who === 'system' || !who ? 'System' : MDM.byName(who); }
  function deliveredAt(o) { const ev = (o.events || []).filter(e => e.type === 'delivered').pop(); return ev ? ev.at : null; }
  function scheduleText(o) {
    const s = o.schedule || {};
    if (s.type === 'advance') return 'Collect ' + fmtDay(s.collectDate) + ' ' + (s.collectTime || '') + ' · deliver ' + fmtDay(s.deliverDate) + ' ' + (s.deliverTime || '');
    if (s.type === 'slot') return fmtDay(s.date) + ', ' + MDM.ui.window(s.window || '');
    return 'As soon as possible';
  }
  function fmtDay(d) { return d ? MDM.ui.fmtDate(d + 'T00:00:00', { dateOnly: true }) : ''; }

  // Below 1400px the orders list folds Type into the Code sub-line and the Payment badge into the Total sub-line (ctx.narrow) so the
  // table fits the 1280 desktop width; at 1400px and up, and in the stacked phone layout, every column is its own.
  const COLUMNS = {
    code: { label: 'Order', cell: (o, ctx) => el('td', { class: 'table__primary', 'data-label': 'Order' }, el('a', { href: '#/orders/' + encodeURIComponent(o.id), class: 'mono', 'data-testid': 'orders-row-link' }, o.code),
      ctx.narrow ? el('span', { class: 'table__sub' }, typeLabel(o)) : null) },
    customer: { label: 'Customer', cell: o => el('td', { 'data-label': 'Customer' }, o.customer ? o.customer.name : '', el('span', { class: 'table__sub mono' }, o.customer ? MDM.ui.phone.format(o.customer.phone) : '')) },
    type: { label: 'Type', cell: o => el('td', { 'data-label': 'Type' }, typeLabel(o), o.serviceLevel && o.serviceLevel !== 'normal' ? el('span', { class: 'table__sub' }, LEVEL[o.serviceLevel]) : null) },
    route: { label: 'Route', cell: o => el('td', { 'data-label': 'Route' }, routeText(o), el('span', { class: 'table__sub' }, nb(plural((o.packages || []).length, 'package')))) },
    total: { label: 'Total', th: 'num', cell: (o, ctx) => el('td', { class: 'num mono', 'data-label': 'Total' }, money(o.totals ? o.totals.total : 0), ctx.narrow ? el('span', { class: 'table__sub' }, paymentBadge(o)) : (o.pricing && o.pricing.status !== 'confirmed' ? el('span', { class: 'table__sub' }, 'estimate') : null)) },
    payment: { label: 'Payment', cell: o => el('td', { 'data-label': 'Payment' }, paymentBadge(o)) },
    status: { label: 'Status', cell: o => el('td', { class: 'table__primary', 'data-label': 'Status' }, html(MDM.badgeFor(o.status)), flagNodes(o)) },
    driver: { label: 'Driver', cell: (o, ctx) => el('td', { 'data-label': 'Driver' }, driverName(o.driverId, ctx.drivers) || el('span', { class: 'subtle' }, o.status === 'confirmed' ? 'Unassigned' : '')) },
    created: { label: 'Created', cell: o => el('td', { 'data-label': 'Created' }, whenCell(o.createdAt)) },
  };
  function columnsFor(ctx) { return ctx && ctx.narrow ? ['code', 'customer', 'route', 'total', 'status', 'driver', 'created'] : ['code', 'customer', 'type', 'route', 'total', 'payment', 'status', 'driver', 'created']; }
  function orderTableHead(columns) {
    return el('thead', null, el('tr', null, columns.map(k => el('th', { scope: 'col', class: COLUMNS[k].th || null }, COLUMNS[k].label))));
  }
  // orderRow(order, columns, { drivers, narrow }) → <tr class="is-clickable" data-testid="orders-row"> that opens the drawer on click.
  function orderRow(o, columns, ctx) {
    ctx = ctx || {};
    return el('tr', { class: 'orders-row is-clickable', 'data-testid': 'orders-row', 'data-order-id': o.id, 'data-status': o.status, 'data-code': o.code,
      on: { click: e => { if (e.target.closest('a, button')) return; openOrder(o.id); } } },
      columns.map(k => COLUMNS[k].cell(o, ctx)));
  }
  function section(id, title, desc, action) {
    const head = el('div', { class: 'section-head' }, el('h2', { id: id + '-title' }, title), desc ? el('p', { class: 'section-head__desc' }, desc) : null, action ? el('div', { class: 'section-head__action' }, action) : null);
    return el('section', { class: 'section', 'aria-labelledby': id + '-title', 'data-section': id }, head);
  }
  function emptyBlock(title, hint, action) {
    return el('div', { class: 'empty' }, el('p', { class: 'empty__title' }, title), hint ? el('p', { class: 'empty__hint' }, hint) : null, action || null);
  }
  function mapFallback(mapEl) {
    if (mapEl.querySelector('.map__fallback')) return;
    mapEl.appendChild(el('div', { class: 'map__fallback' }, el('div', { class: 'alert alert--warn' }, html(MDM.icon('alert-triangle', 16)),
      el('div', { class: 'alert__body' }, 'Map unavailable right now. Stops and status are still updated below.'))));
  }
  // CSV export shared by reports and lists: rows of arrays, quoted where needed, UTF-8 with BOM so Excel keeps "Malé".
  function csv(rows) { return rows.map(r => r.map(v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n'); }
  function downloadCsv(rows, filename) {
    const url = URL.createObjectURL(new Blob(['﻿' + csv(rows)], { type: 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: filename, hidden: true });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- Overview: dashboard figures (requirements §19) and the action queues --------------------------------------------------
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
  function todayLine() { return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }); }
  const AWAITING = ['confirmed', 'assigned', 'dispatched', 'on_the_way', 'arrived'];
  function overviewView() {
    const v = { host: null, alive: false, unsubs: [], timer: null, map: null, mapEl: null, markers: Object.create(null), stopPos: null, staleTimer: null, fitted: false, slots: {} };
    function kpi(label, value, note, testid, icon, href) {
      return el(href ? 'a' : 'div', { class: 'kpi' + (href ? ' kpi--link' : ''), href: href || null, 'data-testid': 'kpi-' + testid },
        icon ? el('span', { class: 'kpi__icon', 'aria-hidden': 'true' }, html(MDM.icon(icon, 18))) : null,
        el('div', { class: 'kpi__label' }, label),
        el('div', { class: 'kpi__value mono', 'data-testid': 'kpi-' + testid + '-value' }, String(value)),
        note ? el('div', { class: 'kpi__note' }, note) : null);
    }
    function attention(orders, requests, leaves, batches, drivers) {
      const q = queues(orders);
      const groups = [];
      const link = (o, meta, aside) => el('a', { class: 'list__item list__item--link', href: '#/orders/' + encodeURIComponent(o.id), 'data-testid': 'attention-item', 'data-status': o.status, 'data-code': o.code },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, el('span', { class: 'mono' }, o.code), ' · ' + (o.customer ? o.customer.name : '')), el('div', { class: 'list__meta' }, meta)),
        el('div', { class: 'list__aside' }, aside));
      // Each queue shows its 3 oldest-first items; the rest are one click away in the matching orders tab.
      const MORE = { price: '#/orders?tab=price', payments: '#/orders?tab=payments', failed: '#/orders?tab=failed', cancels: '#/orders?tab=cancels', priority: '#/orders?tab=priority', unassigned: '#/orders?tab=unassigned', bulk: '#/bulk', leave: '#/team?tab=leave', business: '#/business' };
      const group = (key, title, items) => {
        if (!items.length) return;
        const shown = items.slice(0, 3);
        const more = items.length > shown.length ? el('a', { class: 'queue__more', href: MORE[key] || '#/orders', 'data-testid': 'attention-more' }, 'See ' + (items.length - shown.length) + ' more') : null;
        groups.push(el('div', { class: 'queue', 'data-queue': key }, el('div', { class: 'queue__head' }, el('a', { href: MORE[key] || '#/orders' }, title), el('span', { class: 'queue__count mono' }, String(items.length))), el('div', { class: 'list' }, shown), more));
      };
      group('price', 'Price to confirm', q.quotes.map(o => link(o, typeLabel(o) + ' · estimated ' + money(o.estimate ? o.estimate.min : o.totals.total) + (o.estimate && o.estimate.max !== o.estimate.min ? ' to ' + money(o.estimate.max) : '') + ((o.packages || []).some(p => p.photoId) ? ' · photo attached' : ''), MDM.ui.timeAgo(o.createdAt))));
      group('payments', 'Payments to verify', q.reviews.map(o => link(o, 'Transfer slip · ' + money(o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total) + ' declared', MDM.ui.timeAgo(o.payment.submittedAt || o.updatedAt))));
      group('failed', 'Failed collection or delivery', q.failed.map(o => {
        const s = (o.route && o.route.stops || []).find(x => x.status === 'failed');
        const r = s && MDM.FAIL_REASONS.find(x => x.value === s.failReason);
        return link(o, (r ? r.label : 'Could not complete') + ' · ' + (driverName(o.driverId, drivers) || 'driver') + ' is waiting for a decision', MDM.ui.timeAgo(o.updatedAt));
      }));
      group('cancels', 'Cancellation requests', q.cancels.map(o => link(o, (o.cancellation.reason || 'No reason given') + ' · ' + MDM.STATUS[o.status].label, MDM.ui.timeAgo(o.cancellation.requestedAt))));
      group('priority', 'Priority requests', q.priority.map(o => { const r = (o.priority.requests || []).slice().reverse().find(x => x.decision === 'pending') || {}; return link(o, (r.reason || 'Priority delivery') + (r.deadline ? ' · by ' + r.deadline : ''), MDM.ui.timeAgo(r.at || o.updatedAt)); }));
      group('unassigned', 'Driver to assign', q.unassigned.map(o => link(o, routeText(o) + ' · ' + typeLabel(o), MDM.ui.timeAgo(o.updatedAt))));
      if (can('bulk')) group('bulk', 'Bulk orders to collect', batches.map(b => el('a', { class: 'list__item list__item--link', href: '#/bulk/' + encodeURIComponent(b.id), 'data-testid': 'attention-item', 'data-status': 'batch' },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, el('span', { class: 'mono' }, b.code), ' · ' + b.name), el('div', { class: 'list__meta' }, plural((b.orderIds || []).length, 'package') + ' · ' + (b.collection ? b.collection.address : ''))),
        el('div', { class: 'list__aside' }, MDM.ui.timeAgo(b.createdAt)))));
      if (can('team')) group('leave', 'Leave requests', leaves.map(l => el('a', { class: 'list__item list__item--link', href: '#/team?tab=leave', 'data-testid': 'attention-item', 'data-status': 'leave' },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, l.staffName || 'Employee'), el('div', { class: 'list__meta' }, ((MDM.LEAVE_TYPES.find(t => t.value === l.type) || {}).label || 'Leave') + ' · ' + plural(l.days, 'day') + ' from ' + fmtDay(l.from))),
        el('div', { class: 'list__aside' }, MDM.ui.timeAgo(l.createdAt)))));
      if (can('business')) group('business', 'Business account requests', requests.map(r => el('a', { class: 'list__item list__item--link', href: '#/business', 'data-testid': 'attention-item', 'data-status': 'request' },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, r.name), el('div', { class: 'list__meta' }, r.contactName + ' · ' + MDM.geo.zoneLabel(r.zone))),
        el('div', { class: 'list__aside' }, MDM.ui.timeAgo(r.createdAt)))));
      if (!groups.length) return emptyBlock('Nothing needs attention right now.', 'Prices to confirm, payment slips, failed stops, cancellations, priority requests and leave appear here.');
      return el('div', { class: 'queues', 'data-testid': 'attention-list' }, groups);
    }
    async function render() {
      if (!v.alive) return;
      const [orders, requests, drivers, leaves, staff, batches, positions] = await Promise.all([MDM.store.list('orders'), MDM.store.list('business_requests', { where: { status: 'pending' } }), MDM.store.list('drivers'),
        MDM.store.list('leaves', { where: { status: 'pending' } }), MDM.store.list('staff'), MDM.store.list('batches', { where: { status: 'confirmed' } }), MDM.store.list('positions')]);
      if (!v.alive) return;
      leaves.forEach(l => { const s = staff.find(x => x.id === l.staffId); l.staffName = s ? s.name : 'Employee'; });
      const today = MDM.ui.dayKey(new Date());
      const n = st => orders.filter(o => (Array.isArray(st) ? st.indexOf(o.status) >= 0 : o.status === st)).length;
      const onDay = (list, at) => list.filter(o => MDM.ui.dayKey(at(o)) === today).length;
      const pendingPay = orders.filter(o => o.payment && (o.payment.status === 'requested' || o.payment.status === 'received'));
      const revenueToday = orders.filter(o => o.payment && o.payment.status === 'paid' && o.payment.verifiedAt && MDM.ui.dayKey(o.payment.verifiedAt) === today).reduce((t, o) => t + (o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total), 0);
      const now = Date.now();
      const active = drivers.filter(d => d.status !== 'offline' && (d.status === 'on_route' || positions.some(p => p.driverId === d.id && now - new Date(p.at).getTime() < ONLINE_MS)));
      const delivered = orders.filter(o => o.status === 'delivered'), cancelled = orders.filter(o => o.status === 'cancelled');
      v.slots.kpis.replaceChildren(
        kpi('Total orders', orders.length, onDay(orders, o => o.createdAt) + ' placed today', 'total', 'package', '#/orders'),
        kpi('Pending', n('requested'), 'waiting for price confirmation', 'pending', 'file', '#/orders?tab=price'),
        kpi('Awaiting collection', n(AWAITING), 'confirmed, not collected yet', 'awaiting-collection', 'clock', '#/orders?tab=active'),
        kpi('Collected', n('collected'), 'at the hub or with a driver', 'collected', 'package', '#/orders?status=collected'),
        kpi('Out for delivery', n('out_for_delivery'), 'on the way to recipients', 'out-for-delivery', 'bike', '#/orders?status=out_for_delivery'),
        kpi('Completed', delivered.length, onDay(delivered, o => deliveredAt(o)) + ' delivered today', 'completed', 'check-circle', '#/orders?tab=done'),
        kpi('Failed', n('failed'), 'need a decision', 'failed', 'alert-triangle', '#/orders?tab=failed'),
        kpi('Cancelled', cancelled.length, onDay(cancelled, o => o.cancelledAt || o.updatedAt) + ' today', 'cancelled', 'x', '#/orders?status=cancelled'),
        kpi('Pending payments', pendingPay.length, money(pendingPay.reduce((t, o) => t + o.totals.total, 0)) + ' outstanding', 'pending-payments', 'receipt', '#/orders?payment=requested'),
        kpi('Active drivers', active.length, 'of ' + drivers.length + ' on the team', 'active-drivers', 'users', can('drivers') ? '#/drivers' : null));
      v.slots.revenue.textContent = money(revenueToday) + ' received today';
      v.slots.attention.replaceChildren(attention(orders, requests, leaves, batches, drivers));
      const recent = orders.slice(0, 10);
      const cols = ['code', 'customer', 'type', 'total', 'status', 'created'];
      v.slots.recent.replaceChildren(recent.length
        ? el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack', 'data-testid': 'recent-orders' }, orderTableHead(cols), el('tbody', null, recent.map(o => orderRow(o, cols, { drivers })))))
        : emptyBlock('No orders yet.', 'Orders placed on the site or created here appear in this list.'));
      await syncRiders(drivers);
    }
    async function syncRiders(drivers) {
      if (!v.alive) return;
      drivers = drivers || await MDM.store.list('drivers');
      const positions = await MDM.store.list('positions');
      if (!v.alive) return;
      const now = Date.now();
      const online = drivers.filter(d => d.status !== 'offline').map(d => ({ d, pos: positions.find(p => p.driverId === d.id) })).filter(x => x.pos && now - new Date(x.pos.at).getTime() < ONLINE_MS);
      v.slots.riders.textContent = online.length ? online.length + ' online · ' + online.map(x => x.d.name).join(', ') : 'No drivers online.';
      if (!v.map) return;
      const keep = {};
      online.forEach(x => {
        keep[x.d.id] = true;
        const stale = now - new Date(x.pos.at).getTime() > STALE_MS;
        if (v.markers[x.d.id]) { v.markers[x.d.id].moveTo(x.pos, 0); v.markers[x.d.id].setStale(stale); }
        else { v.markers[x.d.id] = MDM.map.driverMarker(v.map, x.pos, x.d); v.markers[x.d.id].setStale(stale); }
      });
      Object.keys(v.markers).forEach(id => { if (!keep[id]) { v.markers[id].remove(); delete v.markers[id]; } });
      if (!v.fitted && online.length) { v.fitted = true; MDM.map.fit(v.map, online.map(x => [x.pos.lat, x.pos.lng]), { padding: 56, maxZoom: 14 }); }
    }
    async function initMap() {
      if (!MDM.map.available()) { mapFallback(v.mapEl); return; }
      let map;
      v.mapEl.replaceChildren();
      try { map = await MDM.map.create(v.mapEl, { interactive: true, zoom: 12.2 }); }
      catch (e) { if (v.alive) mapFallback(v.mapEl); return; }
      if (!v.alive) { MDM.map.destroy(map); return; }
      v.map = map;
      MDM.map.refresh(map);
      await syncRiders();
      v.stopPos = MDM.live.onPosition('*', pos => {
        if (!v.alive || !v.map) return;
        const m = v.markers[pos.driverId];
        if (m) { m.moveTo(pos, 1000); m.setStale(false); } else syncRiders().catch(() => {});
      });
      v.staleTimer = setInterval(() => syncRiders().catch(() => {}), 30000);
    }
    return {
      title: 'Overview',
      async mount(host) {
        v.host = host; v.alive = true; v.fitted = false;
        v.slots.kpis = el('div', { class: 'kpi-row kpi-row--fluid', 'data-testid': 'overview-kpis' });
        v.slots.attention = el('div', { class: 'card' });
        v.slots.recent = el('div', { class: 'card' });
        v.mapEl = el('div', { class: 'map map--short', 'data-testid': 'overview-map' }, el('div', { class: 'skeleton', style: { height: '100%' } }));
        v.slots.riders = el('p', { class: 'map-legend', 'data-testid': 'overview-riders' });
        const attentionSec = section('attention', 'Needs attention', null, el('a', { href: '#/orders' }, 'See all orders'));
        attentionSec.appendChild(v.slots.attention);
        const ridersSec = section('riders', 'Drivers online', null, can('live') ? el('a', { href: '#/live' }, 'Open the live map') : null);
        ridersSec.append(v.mapEl, v.slots.riders);
        const recentSec = section('recent', 'Recent orders', 'The 10 newest orders. Click a row to open it.', el('a', { href: '#/orders' }, 'See all orders'));
        recentSec.appendChild(v.slots.recent);
        const s = state.session || {};
        v.slots.revenue = el('a', { href: can('reports') ? '#/reports' : '#/orders?payment=paid', 'data-testid': 'overview-revenue' });
        host.append(
          el('div', { class: 'page-head' }, el('h1', { tabindex: '-1' }, greeting() + (s.name ? ', ' + s.name.split(' ')[0] : '')), el('p', { class: 'page-head__desc' }, todayLine() + ' · ', v.slots.revenue, ' · Click a figure to see its orders.')),
          v.slots.kpis,
          el('div', { class: 'admin-grid' }, attentionSec, ridersSec),
          recentSec);
        await render();
        const schedule = () => { clearTimeout(v.timer); v.timer = setTimeout(() => render().catch(() => {}), 40); };
        ['orders', 'business_requests', 'drivers', 'leaves', 'batches'].forEach(c => v.unsubs.push(MDM.store.subscribe(c, schedule)));
        v.unsubs.push(MDM.store.subscribe('*', msg => { if (msg && (msg.op === 'reset' || msg.op === 'refresh')) schedule(); }));
        initMap().catch(() => { if (v.alive) mapFallback(v.mapEl); });
      },
      async unmount() {
        v.alive = false;
        clearTimeout(v.timer); clearInterval(v.staleTimer);
        v.unsubs.forEach(u => u()); v.unsubs = [];
        if (v.stopPos) { v.stopPos(); v.stopPos = null; }
        Object.keys(v.markers).forEach(id => v.markers[id].remove()); v.markers = Object.create(null);
        if (v.map) { MDM.map.destroy(v.map); v.map = null; }
        v.host = null;
      },
    };
  }

  // ---- Public contract -------------------------------------------------------------------------------------------------------
  MDM.admin = {
    views, navigate, params, openOrder, setQuery, user, by, can, queues,
    fmt: { SERVICE, LEVEL, SOURCE, NOTIFY, DONE, money, plural, routeText, paymentBadge, typeLabel, flags, flagNodes, driverName, byLabel, deliveredAt, scheduleText, fmtDay,
      orderTableHead, orderRow, columnsFor, section, emptyBlock, mapFallback, whenCell, csv, downloadCsv, columns: Object.keys(COLUMNS) },
  };
  views.overview = overviewView();

  // ---- Boot ----------------------------------------------------------------------------------------------------------------------
  // Deferred scripts run while readyState is already 'interactive', so only 'complete' proves DOMContentLoaded has fired. Waiting for
  // it (or load, whichever comes first) guarantees the later-deferred view scripts have registered before the first route().
  function domReady() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise(r => { document.addEventListener('DOMContentLoaded', r, { once: true }); window.addEventListener('load', r, { once: true }); });
  }
  async function main() {
    await MDM.store.ready;
    await domReady();
    window.addEventListener('hashchange', () => { route(); });
    document.addEventListener('mdm:signout', () => { signOut().catch(() => {}); });
    state.session = readSession();
    if (state.session) { MDM.shell.setChrome(true); mainEl.classList.add('admin__content'); startCounts(); await route(); }
    else renderLogin(false);
  }
  main();
})(window.MDM);

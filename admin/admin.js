// Admin portal core (SPEC §3.7): the login gate, the hash router, sidebar counts, the Overview view and the helpers every admin
// view shares. Views register themselves as MDM.admin.views[name] = { title, mount(el, params) → Promise, unmount(), update?(params) };
// the router awaits unmount() before mount() and calls update() instead when only the id or query of the same view changed.
// Filters write back to the hash through MDM.admin.setQuery (history.replaceState), so a reload keeps them.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const SESSION_KEY = 'mdm:session';
  const DEMO = { user: 'admin', pass: 'delivery' };
  const TITLE = 'Mr. Delivery Man';
  const ONLINE_MS = 10 * 60 * 1000;          // a rider counts as online when their last position is this recent
  const STALE_MS = 60 * 1000;
  const views = {};
  const mainEl = document.getElementById('main');
  const state = { session: null, current: null, name: null, routing: null, queued: false, loginUser: '', countsUnsub: null, countsTimer: null };

  // ---- Session ------------------------------------------------------------------------------------------------------------
  function readSession() {
    try { const v = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); return v && v.user ? v : null; } catch (e) { return null; }
  }
  function writeSession(v) {
    try { if (v) localStorage.setItem(SESSION_KEY, JSON.stringify(v)); else localStorage.removeItem(SESSION_KEY); } catch (e) { /* private mode: the session lasts for this page only */ }
  }
  function user() { return state.session ? Object.assign({}, state.session) : null; }

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
  async function route() {
    if (!state.session) return;
    if (state.routing) { state.queued = true; return; }
    const p = params();
    if (!p.view || !views[p.view]) { location.replace(buildHash('overview')); return; }
    state.routing = (async () => {
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

  // ---- Login ----------------------------------------------------------------------------------------------------------------
  function renderLogin(showError) {
    MDM.shell.setChrome(false);
    mainEl.classList.remove('admin__content');
    document.title = 'Sign in · Admin · ' + TITLE;
    const userIn = el('input', { class: 'input', id: 'admin-user', name: 'username', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', 'data-testid': 'admin-user', value: state.loginUser || '' });
    const passIn = el('input', { class: 'input', id: 'admin-pass', name: 'password', type: 'password', autocomplete: 'current-password', 'data-testid': 'admin-pass' });
    const errBox = el('div', { class: 'alert alert--danger', role: 'alert', 'data-testid': 'admin-login-error', hidden: !showError },
      html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' }, 'Wrong username or password'));
    const form = el('form', { class: 'card auth__card', novalidate: true, 'data-testid': 'admin-login-form', on: { submit: e => {
      e.preventDefault();
      const u = userIn.value.trim(), pw = passIn.value;
      state.loginUser = u;
      if (u.toLowerCase() === DEMO.user && pw === DEMO.pass) { signIn({ user: 'admin', at: new Date().toISOString() }); return; }
      errBox.hidden = false; passIn.value = ''; passIn.focus();
    } } },
      el('div', { class: 'brand' }, html(MDM.logo())),
      el('h1', null, 'Sign in'),
      el('div', { class: 'alert alert--info' }, html(MDM.icon('info', 16)), el('div', { class: 'alert__body' }, 'Demo sign-in: admin / delivery')),
      errBox,
      el('div', { class: 'field' }, el('label', { for: 'admin-user' }, 'Username'), userIn),
      el('div', { class: 'field' }, el('label', { for: 'admin-pass' }, 'Password'), passIn),
      el('button', { type: 'submit', class: 'btn btn--primary btn--block', 'data-testid': 'admin-login' }, 'Sign in'));
    mainEl.replaceChildren(el('div', { class: 'auth' }, form));
    (showError || userIn.value ? passIn : userIn).focus();
  }
  function signIn(session) {
    state.session = session; writeSession(session);
    MDM.shell.setChrome(true);
    mainEl.replaceChildren(); mainEl.classList.add('admin__content');
    startCounts();
    route();
  }
  async function signOut() {
    await teardown();
    stopCounts();
    state.session = null; writeSession(null);
    renderLogin(false);
  }

  // ---- Sidebar counts ------------------------------------------------------------------------------------------------------
  async function refreshCounts() {
    if (!state.session) return;
    const [orders, requests] = await Promise.all([MDM.store.list('orders'), MDM.store.list('business_requests', { where: { status: 'pending' } })]);
    const n = st => orders.filter(o => o.status === st).length;
    MDM.shell.setCounts({
      orders: orders.filter(o => o.status === 'confirmed' || MDM.ACTIVE_STATUSES.indexOf(o.status) >= 0).length,
      reviews: n('payment_review'), quotes: n('quote_pending'),
      business: { value: requests.length, hot: true },
    });
  }
  function startCounts() {
    refreshCounts().catch(() => {});
    if (!state.countsUnsub) state.countsUnsub = MDM.store.subscribe('*', () => { clearTimeout(state.countsTimer); state.countsTimer = setTimeout(() => refreshCounts().catch(() => {}), 60); });
  }
  function stopCounts() { if (state.countsUnsub) { state.countsUnsub(); state.countsUnsub = null; } clearTimeout(state.countsTimer); }

  // ---- Shared formatting and table helpers (MDM.admin.fmt) ----------------------------------------------------------------
  const SERVICE = { pick: 'Pick & deliver', shop: 'Shop & deliver', business: 'Business' };
  const SERVICE_SHORT = { pick: 'Pickup', shop: 'Shopping', business: 'Business' };   // table cells only; the drawer uses the full names
  const SOURCE = { web: 'Web', viber: 'Viber', whatsapp: 'WhatsApp', phone: 'Phone', walkin: 'Walk-in' };
  const NOTIFY = { sms: 'SMS', whatsapp: 'WhatsApp', viber: 'Viber' };
  const PAYMENT = { unpaid: ['warn', 'Unpaid'], review: ['warn', 'In review'], verified: ['ok', 'Verified'], rejected: ['danger', 'Rejected'], invoiced: ['neutral', 'Invoiced'] };
  const money = n => MDM.pricing.format(n);
  const plural = (n, word) => n + ' ' + word + (Number(n) === 1 ? '' : 's');
  function uniq(arr) { return arr.filter((v, i) => v && arr.indexOf(v) === i); }
  const NBSP = '\u00a0';
  const nb = s => String(s).replace(/ /g, NBSP);
  // Table cells wrap only at commas: "21 Sep, 04:59" breaks after the comma, "22 min ago" never does.
  function whenCell(iso) { const t = MDM.ui.timeAgo(iso); return t.indexOf(',') >= 0 ? t.replace(/^(\S+) (\S+),/, '$1' + NBSP + '$2,') : nb(t); }
  function pickupZone(pkg, service) { return service === 'shop' && pkg.shop ? pkg.shop.zone : (pkg.pickup ? pkg.pickup.zone : null); }
  // routeText(order) → 'Malé → HM Ph. 1' (zone shorts, unique, in package order)
  function routeText(o) {
    const pk = (o.packages || []);
    const from = uniq(pk.map(p => MDM.geo.zoneShort(pickupZone(p, o.service) || 'male')));
    const to = uniq(pk.map(p => MDM.geo.zoneShort(p.dropoff ? p.dropoff.zone || 'male' : 'male')));
    return (from.map(nb).join(', ') || 'Malé') + NBSP + '→' + NBSP + (to.map(nb).join(', ') || 'Malé');
  }
  function paymentBadge(o) {
    const p = o.payment || {}; const st = p.status || 'unpaid';
    const d = PAYMENT[st] || ['neutral', st];
    return html(MDM.ui.badge(d[0], d[1], { 'data-status': st, 'data-testid': 'payment-badge' }));
  }
  function driverName(id, drivers) { const d = id && (drivers || []).find(x => x.id === id); return d ? d.name : ''; }
  function byLabel(by, drivers) {
    if (!by) return 'System';
    if (by === 'customer') return 'Customer';
    if (by === 'admin') return 'Admin';
    if (by === 'system') return 'System';
    if (by.indexOf('driver:') === 0) return driverName(by.slice(7), drivers) || 'Rider';
    return by;
  }
  function deliveredAt(o) { const ev = (o.events || []).filter(e => e.type === 'delivered').pop(); return ev ? ev.at : null; }

  const COLUMNS = {
    code: { label: 'Code', cell: o => el('td', { class: 'table__primary', 'data-label': 'Code' }, el('a', { href: '#/orders/' + encodeURIComponent(o.id), class: 'mono', 'data-testid': 'orders-row-link' }, o.code)) },
    customer: { label: 'Customer', cell: o => el('td', { 'data-label': 'Customer' }, o.customer ? o.customer.name : '', el('span', { class: 'table__sub mono' }, o.customer ? MDM.ui.phone.format(o.customer.phone) : '')) },
    service: { label: 'Service', cell: o => el('td', { 'data-label': 'Service' }, SERVICE_SHORT[o.service] || o.service) },
    route: { label: 'Route', cell: o => el('td', { 'data-label': 'Route' }, routeText(o), el('span', { class: 'table__sub' }, nb(plural((o.packages || []).length, 'package')))) },
    total: { label: 'Total', th: 'num', cell: o => el('td', { class: 'num mono', 'data-label': 'Total' }, money(o.totals ? o.totals.total : 0)) },
    payment: { label: 'Payment', cell: o => el('td', { 'data-label': 'Payment' }, paymentBadge(o)) },
    status: { label: 'Status', cell: o => el('td', { class: 'table__primary', 'data-label': 'Status' }, html(MDM.badgeFor(o.status))) },
    rider: { label: 'Rider', cell: (o, ctx) => el('td', { 'data-label': 'Rider' }, driverName(o.driverId, ctx.drivers) || el('span', { class: 'subtle' }, o.status === 'confirmed' ? 'Unassigned' : '')) },
    created: { label: 'Created', cell: o => el('td', { 'data-label': 'Created' }, whenCell(o.createdAt)) },
  };
  function orderTableHead(columns) {
    return el('thead', null, el('tr', null, columns.map(k => el('th', { scope: 'col', class: COLUMNS[k].th || null }, COLUMNS[k].label))));
  }
  // orderRow(order, columns, { drivers }) → <tr class="is-clickable" data-testid="orders-row"> that opens the drawer on click.
  function orderRow(o, columns, ctx) {
    ctx = ctx || {};
    return el('tr', { class: 'orders-row is-clickable', 'data-testid': 'orders-row', 'data-order-id': o.id, 'data-status': o.status,
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

  // ---- Overview view ---------------------------------------------------------------------------------------------------------
  function overviewView() {
    const v = { host: null, alive: false, unsubs: [], timer: null, map: null, mapEl: null, markers: Object.create(null), stopPos: null, staleTimer: null, fitted: false, slots: {} };
    function kpi(label, value, note, testid) {
      return el('div', { class: 'kpi', 'data-testid': 'kpi-' + testid },
        el('div', { class: 'kpi__label' }, label),
        el('div', { class: 'kpi__value mono', 'data-testid': 'kpi-' + testid + '-value' }, String(value)),
        note ? el('div', { class: 'kpi__note' }, note) : null);
    }
    function attention(orders, requests, drivers) {
      const items = [];
      const link = (o, meta, aside) => el('a', { class: 'list__item list__item--link', href: '#/orders/' + encodeURIComponent(o.id), 'data-testid': 'attention-item', 'data-status': o.status },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, el('span', { class: 'mono' }, o.code), ' · ' + (o.customer ? o.customer.name : '')), el('div', { class: 'list__meta' }, meta)),
        el('div', { class: 'list__aside' }, aside));
      orders.filter(o => o.status === 'payment_review').forEach(o => items.push(link(o, 'Payment slip to verify · ' + money(o.payment && o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total) + ' declared', MDM.ui.timeAgo(o.payment && o.payment.submittedAt || o.updatedAt))));
      orders.filter(o => o.status === 'quote_pending').forEach(o => items.push(link(o, 'Quote to send · ' + routeText(o) + ' · estimated ' + money(o.totals.total), MDM.ui.timeAgo(o.createdAt))));
      orders.filter(o => o.status === 'confirmed' && !o.driverId).forEach(o => items.push(link(o, 'Rider to assign · ' + routeText(o), MDM.ui.timeAgo(o.updatedAt))));
      orders.filter(o => o.status === 'on_hold').forEach(o => {
        const failed = (o.route && o.route.stops || []).find(s => s.status === 'failed');
        const r = failed && MDM.FAIL_REASONS.find(x => x.value === failed.failReason);
        items.push(link(o, 'Stop could not be completed' + (r ? ': ' + r.label.toLowerCase() : '') + ' · ' + (driverName(o.driverId, drivers) || 'rider') + ' is waiting', MDM.ui.timeAgo(o.updatedAt)));
      });
      requests.forEach(r => items.push(el('a', { class: 'list__item list__item--link', href: '#/business', 'data-testid': 'attention-item', 'data-status': 'request' },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, r.name), el('div', { class: 'list__meta' }, 'Business account request · ' + r.contactName + ' · ' + MDM.geo.zoneLabel(r.zone))),
        el('div', { class: 'list__aside' }, MDM.ui.timeAgo(r.createdAt)))));
      if (!items.length) return emptyBlock('Nothing needs attention right now.', 'New payment slips, quotes, unassigned orders and account requests appear here.');
      return el('div', { class: 'list', 'data-testid': 'attention-list' }, items);
    }
    async function render() {
      if (!v.alive) return;
      const [orders, requests, drivers] = await Promise.all([MDM.store.list('orders'), MDM.store.list('business_requests', { where: { status: 'pending' } }), MDM.store.list('drivers')]);
      if (!v.alive) return;
      const today = MDM.ui.dayKey(new Date());
      const yesterday = MDM.ui.dayKey(new Date(Date.now() - 86400000));
      const live = orders.filter(o => o.status !== 'draft');
      const createdOn = day => live.filter(o => o.status !== 'cancelled' && MDM.ui.dayKey(o.createdAt) === day).length;
      const deliveredOn = day => live.filter(o => o.status === 'delivered' && MDM.ui.dayKey(deliveredAt(o)) === day).length;
      const verifiedToday = live.filter(o => o.payment && o.payment.verifiedAt && MDM.ui.dayKey(o.payment.verifiedAt) === today).reduce((n, o) => n + (o.totals ? o.totals.total : 0), 0);
      v.slots.kpis.replaceChildren(
        kpi('Orders today', createdOn(today), plural(createdOn(yesterday), 'order') + ' yesterday', 'orders-today'),
        kpi('Awaiting verification', live.filter(o => o.payment && o.payment.status === 'review').length, 'payment slips to check', 'awaiting'),
        kpi('Quotes to send', live.filter(o => o.status === 'quote_pending').length, 'waiting for a price', 'quotes'),
        kpi('In transit', live.filter(o => MDM.ACTIVE_STATUSES.indexOf(o.status) >= 0).length, 'assigned to a rider', 'in-transit'),
        kpi('Delivered today', deliveredOn(today), plural(deliveredOn(yesterday), 'delivery') + ' yesterday', 'delivered-today'),
        kpi('Payments verified today', money(verifiedToday), 'bank transfers matched', 'verified-today'));
      v.slots.attention.replaceChildren(attention(orders, requests, drivers));
      const recent = live.slice(0, 10);
      const cols = ['code', 'customer', 'service', 'route', 'total', 'status', 'created'];
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
      v.slots.riders.textContent = online.length ? online.length + ' online · ' + online.map(x => x.d.name).join(', ') : 'No riders online.';
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
        v.slots.kpis = el('div', { class: 'kpi-row', 'data-testid': 'overview-kpis' });
        v.slots.attention = el('div', { class: 'card' });
        v.slots.recent = el('div', { class: 'card' });
        v.mapEl = el('div', { class: 'map map--short', 'data-testid': 'overview-map' }, el('div', { class: 'skeleton', style: { height: '100%' } }));
        v.slots.riders = el('p', { class: 'map-legend', 'data-testid': 'overview-riders' });
        const attentionSec = section('attention', 'Needs attention', null, el('a', { href: '#/orders' }, 'See all orders'));
        attentionSec.appendChild(v.slots.attention);
        const ridersSec = section('riders', 'Riders online', null, el('a', { href: '#/live' }, 'Open the live map'));
        ridersSec.append(v.mapEl, v.slots.riders);
        const recentSec = section('recent', 'Recent orders', 'The 10 newest orders. Click a row to open it.', el('a', { href: '#/orders' }, 'See all orders'));
        recentSec.appendChild(v.slots.recent);
        host.append(
          el('div', { class: 'page-head' }, el('h1', { tabindex: '-1' }, 'Overview'), el('p', { class: 'page-head__desc' }, 'Today at a glance. Counts update as orders change.')),
          v.slots.kpis,
          el('div', { class: 'admin-grid' }, attentionSec, ridersSec),
          recentSec);
        await render();
        const schedule = () => { clearTimeout(v.timer); v.timer = setTimeout(() => render().catch(() => {}), 40); };
        ['orders', 'business_requests', 'drivers'].forEach(c => v.unsubs.push(MDM.store.subscribe(c, schedule)));
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
    views, navigate, params, openOrder, setQuery, user,
    fmt: { SERVICE, SERVICE_SHORT, SOURCE, NOTIFY, PAYMENT, money, plural, routeText, paymentBadge, driverName, byLabel, deliveredAt, orderTableHead, orderRow, section, emptyBlock, mapFallback, columns: Object.keys(COLUMNS) },
  };
  views.overview = overviewView();

  // ---- Boot ----------------------------------------------------------------------------------------------------------------------
  function domReady() { return document.readyState === 'loading' ? new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true })) : Promise.resolve(); }
  async function main() {
    await MDM.store.ready;
    await domReady();                       // every deferred script (orders.js, views.js) has registered its views by now
    window.addEventListener('hashchange', () => { route(); });
    document.addEventListener('mdm:signout', () => { signOut().catch(() => {}); });
    state.session = readSession();
    if (state.session) { MDM.shell.setChrome(true); mainEl.classList.add('admin__content'); startCounts(); await route(); }
    else renderLogin(false);
  }
  main();
})(window.MDM);

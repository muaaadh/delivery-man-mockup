// Admin secondary views (SPEC §3.7): #/live, #/drivers, #/customers, #/business (+ #/business/:accountId), #/rates and #/settings.
// Each view registers on MDM.admin.views as { title, mount(el, params), unmount() }; the router in admin.js awaits unmount()
// (which unsubscribes, clears timers and destroys the map) before the next mount(). Every view reads and writes through MDM.store
// only and re-renders from one render() on store changes; nothing here patches the DOM from a change payload.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  if (!MDM.admin) MDM.admin = { views: {} };
  if (!MDM.admin.views) MDM.admin.views = {};

  // views.css sits next to this file; admin/index.html links admin.css only, so the stylesheet is attached here once.
  (function attachCss() {
    if (!document.currentScript) return;
    const href = new URL('./views.css', document.currentScript.src).href;
    const linked = Array.prototype.some.call(document.querySelectorAll('link[rel="stylesheet"]'), l => l.href === href);
    if (!linked) document.head.appendChild(el('link', { rel: 'stylesheet', href }));
  })();

  // ---- Shared helpers -------------------------------------------------------------------------------------------------------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const VEHICLES = { bike: 'Bike', car: 'Car', pickup: 'Pickup' };
  const DRIVER_STATUS = { online: { label: 'Online', kind: 'ok' }, on_route: { label: 'On route', kind: 'info' }, offline: { label: 'Offline', kind: 'neutral' } };
  const REQUEST_STATUS = { pending: { label: 'Pending', kind: 'warn' }, approved: { label: 'Approved', kind: 'ok' }, declined: { label: 'Declined', kind: 'danger' } };
  const INVOICE_STATUS = { draft: { label: 'Draft', kind: 'neutral' }, sent: { label: 'Sent', kind: 'info' }, paid: { label: 'Paid', kind: 'ok' } };
  const VOLUMES = { '1-10': '1 to 10 a week', '11-30': '11 to 30 a week', '31-100': '31 to 100 a week', '100+': 'More than 100 a week' };
  const WINDOWS = { morning: 'Morning 09:00 to 12:00', afternoon: 'Afternoon 13:00 to 17:00', evening: 'Evening 18:00 to 22:00' };
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const money = (n, o) => MDM.pricing.format(n, o);
  const fmtDate = (iso, o) => MDM.ui.fmtDate(iso, o);
  const phone = MDM.ui.phone;
  const toast = (msg, kind) => MDM.ui.toast(msg, kind || 'ok');
  const icon = (name, size) => html(MDM.icon(name, size || 16));
  const nowIso = () => new Date().toISOString();
  const plural = (n, word) => n + ' ' + word + (Number(n) === 1 ? '' : 's');
  const monthLabel = key => { const m = /^(\d{4})-(\d{2})$/.exec(key || ''); return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : String(key || ''); };
  const deliveredAt = o => (((o.events || []).filter(e => e.type === 'delivered').pop() || {}).at) || o.updatedAt || o.createdAt;
  const thisMonth = () => MDM.ui.monthKey(new Date());

  // Router bridge: admin.js provides these; the fallbacks keep the views usable when it has not loaded (test host).
  function navigate(hash) { if (typeof MDM.admin.navigate === 'function') MDM.admin.navigate(hash); else location.hash = hash; }
  function openOrder(orderId) { if (typeof MDM.admin.openOrder === 'function') MDM.admin.openOrder(orderId); else navigate('#/orders/' + orderId); }
  function setQuery(obj) {
    if (typeof MDM.admin.setQuery === 'function') { MDM.admin.setQuery(obj); return; }
    const m = /^#([^?]*)(?:\?(.*))?$/.exec(location.hash || '#/overview');
    const q = new URLSearchParams(m && m[2] ? m[2] : '');
    Object.keys(obj || {}).forEach(k => { if (obj[k] == null || obj[k] === '') q.delete(k); else q.set(k, obj[k]); });
    const s = q.toString();
    history.replaceState(null, '', '#' + (m ? m[1] : '/overview') + (s ? '?' + s : ''));
  }
  function queryOf(params) {
    if (params && params.query instanceof URLSearchParams) return params.query;
    const m = /\?(.*)$/.exec(location.hash || '');
    return new URLSearchParams(m ? m[1] : '');
  }

  // Per-mount bookkeeping: subscriptions and intervals are released together in unmount().
  function context() {
    const c = { alive: true, subs: [], timers: [], pending: null };
    c.sub = (col, fn) => { c.subs.push(MDM.store.subscribe(col, fn)); };
    c.every = (ms, fn) => { c.timers.push(setInterval(fn, ms)); };
    c.dispose = () => { c.alive = false; c.subs.forEach(u => { try { u(); } catch (e) { /* already released */ } }); c.timers.forEach(clearInterval); c.subs = []; c.timers = []; };
    // Bursts of store notifications collapse into one render on the next tick.
    c.schedule = fn => { if (c.pending) return; c.pending = setTimeout(() => { c.pending = null; if (c.alive) fn().catch(rethrow); }, 0); };
    return c;
  }

  function pageHead(title, desc, actions) {
    return el('div', { class: 'page-head' },
      el('h1', { tabindex: '-1' }, title),
      desc ? el('p', { class: 'page-head__desc' }, desc) : null,
      actions && actions.length ? el('div', { class: 'page-head__actions' }, actions) : null);
  }
  function sectionHead(id, title, desc, action) {
    return el('div', { class: 'section-head' }, el('h2', { id }, title), desc ? el('p', { class: 'section-head__desc' }, desc) : null, action ? el('div', { class: 'section-head__action' }, action) : null);
  }
  function badge(map, status) { const s = map[status] || { label: status || '', kind: 'neutral' }; return html(MDM.ui.badge(s.kind, s.label, { 'data-status': status })); }
  function telLink(raw) {
    const l = phone.links(raw);
    return l ? el('a', { class: 'mono', href: l.tel }, phone.format(raw)) : el('span', { class: 'mono' }, raw || '');
  }
  function empty(title, hint, action) {
    return el('div', { class: 'empty' }, el('p', { class: 'empty__title' }, title), hint ? el('p', { class: 'empty__hint' }, hint) : null, action || null);
  }
  // Long free-text values (addresses, emails) wrap instead of squeezing the label column.
  function wrapValue(v) { return el('span', { class: 'wrap-value' }, v); }
  function rateRow(label, value, opts) {
    opts = opts || {};
    return el('div', { class: 'rate-table__row' },
      el('div', { class: 'rate-table__label' }, label, opts.sub ? el('small', null, opts.sub) : null),
      el('div', { class: 'rate-table__value' + (opts.mono ? ' mono' : '') }, value));
  }
  // table(cols, rows): cols [{ label, key, num, primary, actions, render(row) → Node|string }]; rows carry { attrs, cells } built by render().
  function table(cols, rows, opts) {
    opts = opts || {};
    const head = el('tr', null, cols.map(c => el('th', { scope: 'col', class: [c.num ? 'num' : null, c.actions ? 'table__actions' : null].filter(Boolean).join(' ') || null }, c.label)));
    const body = el('tbody', null, rows.map(r => el('tr', r.attrs || null, cols.map(c => {
      const cls = [c.num ? 'num mono' : null, c.primary ? 'table__primary' : null, c.actions ? 'table__actions' : null, c.nowrap ? 'nowrap' : null].filter(Boolean).join(' ');
      return el('td', { class: cls || null, 'data-label': c.primary || c.actions ? null : c.label }, c.render(r.data));
    }))));
    const t = el('table', { class: 'table table--stack' + (opts.compact ? ' table--compact' : ''), 'data-testid': opts.testid }, el('thead', null, head), body);
    return el('div', { class: 'table-wrap' }, t);
  }
  function card(header, body, attrs) {
    return el('div', Object.assign({ class: 'card' }, attrs || {}), header ? el('div', { class: 'card__header' }, header) : null, body);
  }
  function actionsRow() { return el('div', { class: 'table__actions-row' }, Array.prototype.slice.call(arguments)); }
  // .field builders for the settings forms (label above, hint below; errors via MDM.ui.setError).
  let fieldSeq = 0;
  function field(label, control, opts) {
    opts = opts || {};
    const id = control.id || ('vf-' + (++fieldSeq));
    control.id = id;
    if (opts.hint) control.setAttribute('aria-describedby', id + '-hint');
    return el('div', { class: 'field' }, el('label', { for: id }, label, opts.optional ? el('span', { class: 'optional' }, ' (optional)') : null), control,
      opts.hint ? el('div', { class: 'field__hint', id: id + '-hint' }, opts.hint) : null);
  }
  function input(name, value, attrs) { return el('input', Object.assign({ class: 'input', type: 'text', name, value: value == null ? '' : String(value), 'data-testid': name }, attrs || {})); }
  function numInput(name, value, attrs) { return input(name, value, Object.assign({ type: 'number', inputmode: 'numeric', min: '0', step: '1' }, attrs || {})); }
  function textarea(name, value, attrs) { return el('textarea', Object.assign({ class: 'textarea', name, rows: 3, 'data-testid': name, value: value == null ? '' : String(value) }, attrs || {})); }
  function select(name, value, options, attrs) {
    return el('select', Object.assign({ class: 'select', name, 'data-testid': name, value }, attrs || {}), options.map(o => el('option', { value: o.value }, o.label)));
  }
  function checkbox(name, checked, label, hint) {
    const id = 'vf-' + (++fieldSeq);
    return el('label', { class: 'checkbox', for: id }, el('input', { type: 'checkbox', id, name, 'data-testid': name, checked: !!checked }),
      el('span', null, label, hint ? el('span', { class: 'hint' }, hint) : null));
  }
  const val = (form, name) => { const c = form.elements[name]; return c ? (c.type === 'checkbox' ? c.checked : String(c.value == null ? '' : c.value).trim()) : ''; };
  function download(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = el('a', { href: url, download: filename, hidden: true });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function storeMessage(e) { return e && e.message ? e.message : 'Something went wrong'; }
  // fill(node, ...children): replaces a node's children with el()'s child semantics (arrays flatten, null/false skip, strings are text).
  function flat(c, out) { if (Array.isArray(c)) c.forEach(x => flat(x, out)); else if (c != null && c !== false && c !== true) out.push(c instanceof Node ? c : document.createTextNode(String(c))); return out; }
  function fill(node) { node.replaceChildren.apply(node, flat(Array.prototype.slice.call(arguments, 1), [])); }
  function rethrow(e) { setTimeout(() => { throw e; }, 0); }   // a failed render surfaces as a page error instead of vanishing

  // Delivered business orders of one account in a month (the same rule createInvoice uses: the delivered event's month).
  function monthOrders(orders, accountId, month) {
    return orders.filter(o => o.accountId === accountId && o.service === 'business' && o.status === 'delivered' && String(deliveredAt(o)).slice(0, 7) === month);
  }
  const packageCount = orders => orders.reduce((n, o) => n + (o.packages || []).length, 0);
  const orderTotal = orders => orders.reduce((n, o) => n + ((o.totals && o.totals.total) || 0), 0);

  // ==== #/live =================================================================================================================
  MDM.admin.views.live = (function () {
    const RECENT_MS = 10 * 60000, STALE_MS = 60000;
    let ctx = null, root = null, ui = null, map = null, selected = null, state = null;
    const listed = id => !!(state && state.drivers.some(d => d.id === id));
    const ageMs = p => p && p.at ? Date.now() - new Date(p.at).getTime() : Infinity;
    const recent = p => ageMs(p) <= RECENT_MS;

    async function mount(host, params) {
      ctx = context(); root = host; map = null;
      selected = queryOf(params).get('driver') || null;
      state = { drivers: [], routes: {}, positions: {}, orders: [], markers: {}, lines: {}, stops: null, fitted: false, mapFailed: false };
      build();
      ctx.sub('drivers', () => ctx.schedule(render));
      ctx.sub('orders', () => ctx.schedule(render));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      ctx.subs.push(MDM.live.onPosition('*', onPosition));
      ctx.every(5000, tick);
      await render();
      createMap();
    }
    function unmount() {
      if (ctx) ctx.dispose();
      Object.keys(state ? state.markers : {}).forEach(id => state.markers[id].remove());
      if (map) MDM.map.destroy(map);
      map = null; ctx = null; root = null; ui = null; state = null;
    }
    function build() {
      ui = {};
      ui.overlay = el('div', { class: 'map__overlay' },
        el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'live-recenter', on: { click: () => fitAll(true) } }, icon('locate'), 'Recenter'));
      ui.mapEl = el('div', { class: 'map map--fill', role: 'region', 'aria-label': 'Riders map', 'data-testid': 'live-map' }, ui.overlay);
      ui.riders = el('ul', { class: 'list', 'data-testid': 'live-riders' });
      ui.orders = el('ul', { class: 'list', 'data-testid': 'live-orders' });
      ui.riderCount = el('span', { class: 'count' });
      ui.orderCount = el('span', { class: 'count' });
      fill(root,
        pageHead('Live map', 'Riders online now, the order each one is on and their next stop.'),
        el('div', { class: 'live-layout' }, ui.mapEl,
          el('div', { class: 'live-side' },
            card([el('h2', null, 'Riders'), ui.riderCount], ui.riders),
            card([el('h2', null, 'Active orders'), ui.orderCount], ui.orders))));
    }
    async function render() {
      const [drivers, orders, positions] = await Promise.all([
        MDM.store.list('drivers'), MDM.store.list('orders', { where: { status: MDM.ACTIVE_STATUSES } }), MDM.store.list('positions')]);
      if (!ctx || !ctx.alive) return;
      const online = drivers.filter(d => d.status === 'online' || d.status === 'on_route').sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'on_route' ? -1 : 1));
      const routes = {};
      for (const d of online) routes[d.id] = await MDM.store.driverRoute(d.id);
      if (!ctx || !ctx.alive) return;
      state.drivers = online; state.routes = routes; state.orders = orders;
      positions.forEach(p => { const live = MDM.live.last(p.id); state.positions[p.id] = live && String(live.at) >= String(p.at) ? live : p; });
      if (selected && !listed(selected)) { selected = null; setQuery({ driver: null }); }
      renderRiders(); renderOrders(); drawMap(); tick();
    }
    // The stop the rider is heading to; on hold, the stop that could not be completed.
    function currentStop(route) {
      const stops = route.stops || [];
      return stops.find(s => s.status === 'pending' || s.status === 'arrived') || stops.find(s => s.status === 'failed') || null;
    }
    function stopText(stop) {
      if (stop.status === 'failed') return 'on hold at ' + stop.label.toLowerCase() + ', ' + stop.address;
      return (stop.status === 'arrived' ? 'at ' : 'next ') + stop.label.toLowerCase() + ', ' + stop.address;
    }
    function renderRiders() {
      ui.riderCount.textContent = state.drivers.length ? String(state.drivers.length) : '';
      if (!state.drivers.length) { ui.riders.replaceChildren(el('li', null, empty('No riders online.', 'Riders appear here once they go online in the rider console.'))); return; }
      fill(ui.riders, state.drivers.map(d => {
        const route = state.routes[d.id] || { orders: [], stops: [] };
        const stop = currentStop(route);
        const order = stop ? route.orders.find(o => o.id === stop.orderId) : (route.orders[0] || null);
        const meta = el('div', { class: 'list__meta live-rider__meta' });
        if (order) {
          meta.append(el('a', { href: '#/orders/' + order.id, class: 'mono', on: { click: e => { e.preventDefault(); e.stopPropagation(); openOrder(order.id); } } }, order.code));
          meta.append(' · ' + (stop ? stopText(stop) : 'all stops done'));
        } else meta.append('No active order');
        const updated = el('div', { class: 'list__meta', 'data-updated': d.id }, updatedText(d.id));
        return el('li', { class: 'list__item live-rider' + (selected === d.id ? ' is-selected' : ''), 'data-testid': 'live-rider', 'data-driver-id': d.id, 'data-status': d.status,
          on: { click: () => choose(d.id) } },
          el('div', { class: 'list__main' },
            el('div', { class: 'list__title' },
              el('button', { type: 'button', class: 'live-rider__name', 'aria-pressed': selected === d.id ? 'true' : 'false', on: { click: e => { e.stopPropagation(); choose(d.id); } } }, d.name)),
            meta, updated),
          el('div', { class: 'list__aside' }, badge(DRIVER_STATUS, d.status)));
      }));
    }
    function renderOrders() {
      ui.orderCount.textContent = state.orders.length ? String(state.orders.length) : '';
      if (!state.orders.length) { ui.orders.replaceChildren(el('li', null, empty('No active orders.', 'Assigned, picked up, in transit and on hold orders show here.'))); return; }
      const byId = {}; state.drivers.forEach(d => { byId[d.id] = d; });
      fill(ui.orders, state.orders.map(o => {
        const rider = o.driverId ? byId[o.driverId] : null;
        return el('li', { class: 'list__item', 'data-testid': 'live-order', 'data-order-id': o.id, 'data-status': o.status },
          el('div', { class: 'list__main' },
            el('div', { class: 'list__title live-order__title' },
              el('button', { type: 'button', class: 'live-order__code mono', on: { click: () => openOrder(o.id) } }, o.code),
              html(MDM.badgeFor(o.status))),
            el('div', { class: 'list__meta' }, o.customer.name + (rider ? ' · ' + rider.name : o.driverId ? '' : ' · No rider'))),
          el('div', { class: 'list__aside' }, plural((o.packages || []).length, 'package')));
      }));
    }
    function updatedText(driverId) {
      const p = state.positions[driverId];
      if (!p || !recent(p)) return 'No location in the last 10 min';
      return ageMs(p) < 5000 ? 'Updated just now' : 'Updated ' + MDM.ui.timeAgo(p.at, { seconds: true });
    }
    function choose(driverId) {
      selected = selected === driverId ? null : driverId;
      setQuery({ driver: selected });
      ui.riders.querySelectorAll('.live-rider').forEach(li => {
        const on = li.dataset.driverId === selected;
        li.classList.toggle('is-selected', on);
        const b = li.querySelector('.live-rider__name'); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      drawMap();
      if (selected) fitAll(true);
    }
    // ---- Map ----
    function createMap() {
      const p = MDM.map.available() ? MDM.map.create(ui.mapEl, { center: MDM.geo.CENTER, zoom: 12.4 }) : Promise.reject(new Error('map_unavailable'));
      p.then(m => {
        if (!ctx || !ctx.alive) { MDM.map.destroy(m); return; }
        map = m; MDM.map.refresh(map); drawMap();
      }).catch(() => {
        if (!ctx || !ctx.alive || !ui) return;
        state.mapFailed = true; ui.overlay.hidden = true;
        ui.mapEl.appendChild(el('div', { class: 'map__fallback', 'data-testid': 'live-map-fallback' },
          el('div', { class: 'alert alert--warn', role: 'status' }, icon('alert-triangle'), el('div', { class: 'alert__body' }, 'Map unavailable right now. Stops and status are still updated below.'))));
      });
    }
    function drawMap() {
      if (!map || !state) return;
      const ids = state.drivers.map(d => d.id);
      Object.keys(state.markers).forEach(id => { if (ids.indexOf(id) < 0 || !recent(state.positions[id])) { state.markers[id].remove(); delete state.markers[id]; } });
      Object.keys(state.lines).forEach(id => { if (ids.indexOf(id) < 0) { state.lines[id].remove(); delete state.lines[id]; } });
      state.drivers.forEach(d => {
        const pos = state.positions[d.id];
        if (pos && recent(pos)) {
          if (state.markers[d.id]) state.markers[d.id].moveTo(pos, 0); else state.markers[d.id] = MDM.map.driverMarker(map, pos, d);
          state.markers[d.id].setStale(ageMs(pos) > STALE_MS);
        }
        const line = (state.routes[d.id] || {}).polyline || [];
        const active = !selected || selected === d.id;
        if (line.length >= 2) {
          if (state.lines[d.id]) { state.lines[d.id].update(line); state.lines[d.id].setActive(active); }
          else state.lines[d.id] = MDM.map.route(map, 'live-' + d.id, line, { active });
        } else if (state.lines[d.id]) { state.lines[d.id].remove(); delete state.lines[d.id]; }
      });
      const stops = selected && state.routes[selected] ? state.routes[selected].stops.filter(s => s.status !== 'done') : [];
      if (state.stops) state.stops.update(stops); else if (stops.length) state.stops = MDM.map.stopMarkers(map, stops);
      if (!state.fitted) { state.fitted = true; fitAll(false); }
    }
    function fitAll(animate) {
      if (!map || !state) return;
      const pts = [];
      const ids = selected ? [selected] : state.drivers.map(d => d.id);
      ids.forEach(id => {
        const p = state.positions[id]; if (p && recent(p)) pts.push([p.lat, p.lng]);
        ((state.routes[id] || {}).stops || []).forEach(s => { if (s.status !== 'done' && s.lat != null) pts.push([s.lat, s.lng]); });
      });
      if (!pts.length) pts.push(MDM.geo.CENTER);
      MDM.map.fit(map, pts, { padding: 64, maxZoom: 15, animate: !!animate });
    }
    function onPosition(pos) {
      if (!state || !pos || !pos.driverId) return;
      state.positions[pos.driverId] = pos;
      if (!listed(pos.driverId)) return;
      if (map) {
        const d = state.drivers.find(x => x.id === pos.driverId);
        if (state.markers[pos.driverId]) state.markers[pos.driverId].moveTo(pos, 1000); else state.markers[pos.driverId] = MDM.map.driverMarker(map, pos, d);
        state.markers[pos.driverId].setStale(false);
      }
      const node = ui && ui.riders.querySelector('[data-updated="' + pos.driverId + '"]');
      if (node) node.textContent = updatedText(pos.driverId);
    }
    // Every 5 s: refresh "Updated n s ago", fade markers older than 60 s, drop markers older than 10 min.
    function tick() {
      if (!state || !ui) return;
      ui.riders.querySelectorAll('[data-updated]').forEach(n => { n.textContent = updatedText(n.dataset.updated); });
      Object.keys(state.markers).forEach(id => {
        const p = state.positions[id];
        if (!recent(p)) { state.markers[id].remove(); delete state.markers[id]; return; }
        state.markers[id].setStale(ageMs(p) > STALE_MS);
      });
    }
    return { title: 'Live map', mount, unmount };
  })();

  // ==== #/drivers ==============================================================================================================
  MDM.admin.views.drivers = (function () {
    let ctx = null, root = null, body = null;
    const VEHICLE_OPTIONS = [{ value: 'bike', label: 'Bike' }, { value: 'car', label: 'Car' }, { value: 'pickup', label: 'Pickup' }];
    async function mount(host) {
      ctx = context(); root = host;
      body = el('div', null, el('div', { class: 'skeleton', style: 'height: 96px' }));
      root.replaceChildren(
        pageHead('Riders', 'Every rider, their vehicle and the stops on their route right now.',
          [el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'drivers-add', on: { click: addRider } }, icon('plus'), 'Add rider')]),
        card(null, body, { 'data-testid': 'drivers-card' }));
      ctx.sub('drivers', () => ctx.schedule(render));
      ctx.sub('orders', () => ctx.schedule(render));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; body = null; }
    async function render() {
      const drivers = await MDM.store.list('drivers');
      const routes = {};
      for (const d of drivers) routes[d.id] = await MDM.store.driverRoute(d.id);
      if (!ctx || !ctx.alive) return;
      if (!drivers.length) { body.replaceChildren(empty('Nothing here yet.', 'Add a rider to start assigning orders.')); return; }
      const cols = [
        { label: 'Name', primary: true, render: d => el('span', null, d.name) },
        { label: 'Phone', nowrap: true, render: d => telLink(d.phone) },
        { label: 'Vehicle', render: d => el('span', null, VEHICLES[d.vehicle] || d.vehicle, d.vehicleNote ? el('span', { class: 'table__sub' }, d.vehicleNote) : null) },
        { label: 'Status', primary: true, render: d => badge(DRIVER_STATUS, d.status) },
        { label: 'Stops today', num: true, render: d => { const st = routes[d.id].stops; const done = st.filter(s => s.status === 'done').length; return el('span', null, String(st.length), done ? el('span', { class: 'table__sub' }, done + ' done') : null); } },
        { label: 'Actions', actions: true, render: d => actionsRow(
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'drivers-edit', on: { click: () => editRider(d) } }, 'Edit'),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'drivers-toggle', on: { click: () => toggle(d) } }, d.status === 'offline' ? 'Set online' : 'Set offline')) },
      ];
      body.replaceChildren(table(cols, drivers.map(d => ({ data: d, attrs: { 'data-testid': 'drivers-row', 'data-driver-id': d.id, 'data-status': d.status } })), { testid: 'drivers-table' }));
    }
    function riderFields(d) {
      d = d || {};
      return [
        { name: 'name', label: 'Name', type: 'text', required: true, value: d.name || '', autocomplete: 'off' },
        { name: 'phone', label: 'Mobile number', type: 'tel', required: true, value: d.phone ? phone.format(d.phone) : '', placeholder: '7XX XXXX' },
        { name: 'vehicle', label: 'Vehicle', type: 'select', required: true, value: d.vehicle || 'bike', options: VEHICLE_OPTIONS },
        { name: 'vehicleNote', label: 'Vehicle note', type: 'text', value: d.vehicleNote || '', placeholder: 'Honda Wave' },
      ];
    }
    async function addRider() {
      const v = await MDM.ui.dialog({ title: 'Add rider', fields: riderFields(null), okLabel: 'Add rider' });
      if (!v) return;
      try {
        await MDM.store.insert('drivers', { name: v.name, phone: phone.normalize(v.phone), vehicle: v.vehicle, vehicleNote: v.vehicleNote || '', status: 'offline' });
        toast(v.name + ' added as a rider');
      } catch (e) { toast(storeMessage(e), 'danger'); }
    }
    async function editRider(d) {
      const v = await MDM.ui.dialog({ title: 'Edit rider', fields: riderFields(d), okLabel: 'Save rider' });
      if (!v) return;
      try {
        await MDM.store.update('drivers', d.id, { name: v.name, phone: phone.normalize(v.phone), vehicle: v.vehicle, vehicleNote: v.vehicleNote || '' });
        toast('Rider updated');
      } catch (e) { toast(storeMessage(e), 'danger'); }
    }
    async function toggle(d) {
      const next = d.status === 'offline' ? 'online' : 'offline';
      try { await MDM.store.update('drivers', d.id, { status: next }); toast(d.name + ' is now ' + DRIVER_STATUS[next].label.toLowerCase()); }
      catch (e) { toast(storeMessage(e), 'danger'); }
    }
    return { title: 'Riders', mount, unmount };
  })();

  // ==== #/customers ============================================================================================================
  MDM.admin.views.customers = (function () {
    let ctx = null, root = null, body = null;
    async function mount(host) {
      ctx = context(); root = host;
      body = el('div', null, el('div', { class: 'skeleton', style: 'height: 96px' }));
      root.replaceChildren(pageHead('Customers', 'Everyone who has placed an order. Open a customer to see their orders.'), card(null, body));
      ctx.sub('customers', () => ctx.schedule(render));
      ctx.sub('orders', () => ctx.schedule(render));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; body = null; }
    async function render() {
      const [customers, orders] = await Promise.all([MDM.store.list('customers'), MDM.store.list('orders')]);
      if (!ctx || !ctx.alive) return;
      if (!customers.length) { body.replaceChildren(empty('Nothing here yet.', 'Customers appear here after their first order.')); return; }
      const stats = {};
      orders.forEach(o => { if (o.status === 'draft') return; const s = stats[o.customerId] || (stats[o.customerId] = { count: 0, last: null }); s.count += 1; if (!s.last || o.createdAt > s.last) s.last = o.createdAt; });
      const rows = customers.map(c => { const s = stats[c.id] || { count: c.orderCount || 0, last: c.lastOrderAt || null }; return { c, count: s.count, last: s.last || c.lastOrderAt || null }; })
        .sort((a, b) => (b.last || '') < (a.last || '') ? -1 : (b.last || '') > (a.last || '') ? 1 : a.c.name.localeCompare(b.c.name));
      const target = c => '#/orders?customer=' + encodeURIComponent(c.id);
      const cols = [
        { label: 'Name', primary: true, render: r => el('a', { href: target(r.c), on: { click: e => { e.preventDefault(); navigate(target(r.c)); } } }, r.c.name || phone.format(r.c.phone)) },
        { label: 'Phone', nowrap: true, render: r => telLink(r.c.phone) },
        { label: 'Orders', num: true, render: r => String(r.count) },
        { label: 'Last order', nowrap: true, render: r => r.last ? fmtDate(r.last) : 'No orders yet' },
      ];
      body.replaceChildren(table(cols, rows.map(r => ({ data: r, attrs: { class: 'is-clickable', 'data-testid': 'customers-row', 'data-customer-id': r.c.id, on: { click: e => { if (e.target.closest('a')) return; navigate(target(r.c)); } } } })), { testid: 'customers-table' }));
    }
    return { title: 'Customers', mount, unmount };
  })();

  // ==== #/business (tabs Requests | Accounts) and #/business/:accountId ============================================================
  MDM.admin.views.business = (function () {
    let ctx = null, root = null, ui = null, accountId = null, tab = 'requests';
    async function mount(host, params) {
      ctx = context(); root = host;
      accountId = params && params.id ? params.id : null;
      tab = queryOf(params).get('tab') === 'accounts' ? 'accounts' : 'requests';
      ui = { body: el('div', null, el('div', { class: 'skeleton', style: 'height: 96px' })) };
      if (accountId) buildAccount(); else buildList();
      ['business_requests', 'business_accounts', 'orders', 'invoices'].forEach(c => ctx.sub(c, () => ctx.schedule(render)));
      ctx.sub('settings', () => ctx.schedule(render));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; ui = null; accountId = null; }
    function render() { return accountId ? renderAccount() : renderList(); }

    // ---- List: tabs ----
    function buildList() {
      ui.tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Business' },
        tabButton('requests', 'Requests'), tabButton('accounts', 'Accounts'));
      root.replaceChildren(pageHead('Business', 'Account requests from the website and the accounts you invoice monthly.'), ui.tabs, ui.body);
    }
    function tabButton(key, label) {
      const count = el('span', { class: 'business-tab__count', 'data-tab-count': key });
      return el('button', { type: 'button', class: 'tab', role: 'tab', id: 'business-tab-' + key, 'aria-selected': tab === key ? 'true' : 'false', 'aria-controls': 'business-panel', 'data-testid': 'business-tab-' + key,
        on: { click: () => { if (tab === key) return; tab = key; setQuery({ tab: key === 'requests' ? null : key }); ui.tabs.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t.id === 'business-tab-' + key ? 'true' : 'false')); ctx.schedule(render); } } }, label, count);
    }
    async function renderList() {
      const [requests, accounts, orders, settings] = await Promise.all([MDM.store.list('business_requests'), MDM.store.list('business_accounts'), MDM.store.list('orders'), MDM.store.settings()]);
      if (!ctx || !ctx.alive) return;
      const pending = requests.filter(r => r.status === 'pending').length;
      const rc = ui.tabs.querySelector('[data-tab-count="requests"]'), ac = ui.tabs.querySelector('[data-tab-count="accounts"]');
      rc.textContent = pending ? String(pending) : ''; ac.textContent = accounts.length ? String(accounts.length) : '';
      ui.body.id = 'business-panel'; ui.body.setAttribute('role', 'tabpanel'); ui.body.setAttribute('aria-labelledby', 'business-tab-' + tab);
      ui.body.replaceChildren(tab === 'requests' ? requestsCard(requests, settings) : accountsCard(accounts, orders));
    }
    function requestsCard(requests) {
      if (!requests.length) return card(null, empty('Nothing here yet.', 'Requests from the business page appear here.'));
      const sorted = requests.slice().sort((a, b) => (a.status === 'pending') === (b.status === 'pending') ? 0 : a.status === 'pending' ? -1 : 1);
      const cols = [
        { label: 'Business', primary: true, render: r => el('span', null, r.name, el('span', { class: 'table__sub nowrap' }, 'Requested ' + fmtDate(r.createdAt))) },
        { label: 'Contact', nowrap: true, render: r => el('span', null, r.contactName || '', el('span', { class: 'table__sub' }, telLink(r.phone))) },
        { label: 'Zone', render: r => el('span', null, MDM.geo.zoneLabel(r.zone), r.pickupAddress ? el('span', { class: 'table__sub table__address', title: r.pickupAddress }, r.pickupAddress) : null) },
        { label: 'Volume', nowrap: true, render: r => VOLUMES[r.volume] || r.volume || '' },
        { label: 'Status', primary: true, render: r => badge(REQUEST_STATUS, r.status) },
        { label: 'Actions', actions: true, render: r => r.status !== 'pending' ? el('span', { class: 'table__sub' }, r.status === 'declined' && r.declineReason ? r.declineReason : '') : actionsRow(
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'business-approve', on: { click: () => approve(r) } }, 'Approve'),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'business-decline', on: { click: () => decline(r) } }, 'Decline')) },
      ];
      return card(null, table(cols, sorted.map(r => ({ data: r, attrs: { 'data-testid': 'business-request-row', 'data-request-id': r.id, 'data-status': r.status } })), { testid: 'business-requests' }));
    }
    function accountsCard(accounts, orders) {
      if (!accounts.length) return card(null, empty('Nothing here yet.', 'Approve a request to open the first business account.'));
      const month = thisMonth();
      const cols = [
        { label: 'Business', primary: true, render: a => el('a', { href: '#/business/' + a.id, on: { click: e => { e.preventDefault(); navigate('#/business/' + a.id); } } }, a.name) },
        { label: 'Contact', nowrap: true, render: a => el('span', null, a.contactName || '', el('span', { class: 'table__sub mono' }, phone.format(a.phone))) },
        { label: 'Packages this month', num: true, render: a => String(packageCount(monthOrders(orders, a.id, month))) },
        { label: 'Invoice total', num: true, render: a => money(orderTotal(monthOrders(orders, a.id, month)), { cents: true }) },
        { label: 'Status', primary: true, render: a => badge({ approved: { label: 'Approved', kind: 'ok' }, paused: { label: 'Paused', kind: 'neutral' } }, a.status) },
        { label: 'Actions', actions: true, render: a => el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'business-view', on: { click: () => navigate('#/business/' + a.id) } }, 'View') },
      ];
      return card(null, table(cols, accounts.map(a => ({ data: a, attrs: { class: 'is-clickable', 'data-testid': 'business-account-row', 'data-account-id': a.id, 'data-status': a.status, on: { click: e => { if (e.target.closest('a, button')) return; navigate('#/business/' + a.id); } } } })), { testid: 'business-accounts' }));
    }
    async function approve(r) {
      try {
        const [settings, accounts] = await Promise.all([MDM.store.settings(), MDM.store.list('business_accounts')]);
        const existing = accounts.find(a => a.phone === r.phone);
        let account = existing;
        if (!account) {
          account = await MDM.store.insert('business_accounts', { name: r.name, contactName: r.contactName || '', phone: r.phone, landline: r.landline || '', email: r.email || '', tin: '', zone: r.zone,
            pickupAddress: r.pickupAddress || '', pickupWindow: r.pickupWindow || '', ratePerPackage: settings.rates.business, status: 'approved', approvedAt: nowIso(), requestId: r.id });
        }
        await MDM.store.update('business_requests', r.id, { status: 'approved', accountId: account.id, approvedAt: nowIso() });
        toast(existing ? 'Request approved. An account for this number already exists, so it was linked to ' + existing.name + '.' : 'Account opened for ' + r.name + ' at ' + money(account.ratePerPackage) + ' per package');
      } catch (e) { toast(storeMessage(e), 'danger'); }
    }
    async function decline(r) {
      const v = await MDM.ui.dialog({ title: 'Decline ' + r.name, message: 'The reason is kept on the request for your records.', danger: true, okLabel: 'Decline request',
        fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'Outside our delivery area' }] });
      if (!v) return;
      try { await MDM.store.update('business_requests', r.id, { status: 'declined', declineReason: v.reason, declinedAt: nowIso() }); toast('Request from ' + r.name + ' declined'); }
      catch (e) { toast(storeMessage(e), 'danger'); }
    }

    // ---- Account page ----
    function buildAccount() {
      ui.head = pageHead('Business account');
      ui.details = el('div', { class: 'rate-table' });
      ui.orders = el('div', { class: 'card' });
      ui.invoices = el('div', { class: 'card' });
      root.replaceChildren(ui.head,
        el('div', { class: 'stack-6' },
          el('section', { 'aria-labelledby': 'acc-details' }, sectionHead('acc-details', 'Account'), card(null, ui.details)),
          el('section', { 'aria-labelledby': 'acc-orders' }, sectionHead('acc-orders', 'Delivered this month'), ui.orders),
          el('section', { 'aria-labelledby': 'acc-invoices' }, sectionHead('acc-invoices', 'Invoices'), ui.invoices)));
    }
    async function renderAccount() {
      const [account, orders, invoices, settings] = await Promise.all([MDM.store.get('business_accounts', accountId), MDM.store.list('orders'), MDM.store.list('invoices', { where: { accountId } }), MDM.store.settings()]);
      if (!ctx || !ctx.alive) return;
      if (!account) {
        root.replaceChildren(pageHead('Business account'), card(null, empty('No account with this link.', 'It may have been removed when the demo data was reset.',
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => navigate('#/business?tab=accounts') } }, 'Back to accounts'))));
        return;
      }
      const month = thisMonth(), mine = monthOrders(orders, account.id, month);
      const generate = el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'business-generate-invoice', on: { click: () => generateInvoice(account, mine, invoices, month) } }, icon('receipt'), 'Generate invoice');
      const back = el('a', { class: 'btn btn--ghost', href: '#/business?tab=accounts', on: { click: e => { e.preventDefault(); navigate('#/business?tab=accounts'); } } }, 'All accounts');
      const head = pageHead(account.name, 'Business account since ' + fmtDate(account.approvedAt || account.createdAt, { dateOnly: true }) + ' · ' + money(account.ratePerPackage) + ' per package, invoiced monthly.', [back, generate]);
      ui.head.replaceWith(head); ui.head = head;
      const l = phone.links(account.phone);
      fill(ui.details,
        rateRow('Contact person', wrapValue(account.contactName || '')),
        rateRow('Mobile', el('a', { href: l ? l.tel : null }, phone.format(account.phone)), { mono: true }),
        account.landline ? rateRow('Landline', phone.format(account.landline), { mono: true }) : null,
        rateRow('Email', account.email ? wrapValue(el('a', { href: 'mailto:' + account.email }, account.email)) : ''),
        account.tin ? rateRow('TIN', account.tin, { mono: true }) : null,
        rateRow('Island', MDM.geo.zoneLabel(account.zone)),
        rateRow('Pickup address', wrapValue(account.pickupAddress || '')),
        rateRow('Pickup window', WINDOWS[account.pickupWindow] || account.pickupWindow || ''),
        rateRow('Rate per package', money(account.ratePerPackage), { mono: true, sub: 'Packages under 1 ft within Malé and Hulhumalé' }),
        rateRow('Status', badge({ approved: { label: 'Approved', kind: 'ok' }, paused: { label: 'Paused', kind: 'neutral' } }, account.status)),
        rateRow('Invoice terms', 'Due in ' + plural(settings.invoiceDueDays, 'day') + (Number(settings.gstPercent) > 0 ? ' · GST ' + settings.gstPercent + '%' : '')));
      // This month's delivered orders
      if (!mine.length) ui.orders.replaceChildren(empty('Nothing here yet.', 'Delivered business orders for ' + monthLabel(month) + ' appear here.'));
      else {
        const sorted = mine.slice().sort((a, b) => deliveredAt(b) < deliveredAt(a) ? -1 : 1);
        const cols = [
          { label: 'Order', primary: true, render: o => el('button', { type: 'button', class: 'mono', on: { click: () => openOrder(o.id) } }, o.code) },
          { label: 'Delivered', nowrap: true, render: o => fmtDate(deliveredAt(o)) },
          { label: 'Recipients', render: o => el('span', { class: 'table__address', title: recipients(o) }, recipients(o)) },
          { label: 'Packages', num: true, render: o => String((o.packages || []).length) },
          { label: 'Amount', num: true, render: o => money(o.totals.total, { cents: true }) },
        ];
        ui.orders.replaceChildren(table(cols, sorted.map(o => ({ data: o, attrs: { class: 'is-clickable', 'data-testid': 'business-order-row', 'data-order-id': o.id, 'data-status': o.status, on: { click: e => { if (e.target.closest('button, a')) return; openOrder(o.id); } } } })), { testid: 'business-orders' }),
          el('div', { class: 'pagination' }, el('span', null, plural(packageCount(mine), 'package') + ' delivered in ' + monthLabel(month)), el('span', { class: 'mono' }, money(orderTotal(mine), { cents: true }))));
      }
      // Invoices
      if (!invoices.length) ui.invoices.replaceChildren(empty('No invoices yet.', 'Generate the invoice for ' + monthLabel(month) + ' once the month is delivered.'));
      else {
        const cols = [
          { label: 'Number', primary: true, render: i => el('span', { class: 'mono nowrap' }, i.number) },
          { label: 'Period', nowrap: true, render: i => monthLabel(i.month) },
          { label: 'Total', num: true, render: i => money(i.total, { cents: true }) },
          { label: 'Status', primary: true, render: i => badge(INVOICE_STATUS, i.status) },
          { label: 'Issued', nowrap: true, render: i => fmtDate(i.issuedAt, { dateOnly: true }) },
          { label: 'Due', nowrap: true, render: i => i.status === 'paid' ? 'Paid ' + fmtDate(i.paidAt, { dateOnly: true }) : fmtDate(i.dueAt, { dateOnly: true }) },
          { label: 'Actions', actions: true, render: i => invoiceActions(i, account) },
        ];
        ui.invoices.replaceChildren(table(cols, invoices.map(i => ({ data: i, attrs: { 'data-testid': 'business-invoice-row', 'data-invoice-id': i.id, 'data-status': i.status } })), { testid: 'business-invoices' }));
      }
    }
    function recipients(o) {
      const names = (o.packages || []).map(p => p.dropoff && p.dropoff.recipient ? p.dropoff.recipient.name : '').filter(Boolean);
      return names.length ? names.join(', ') : (o.packages || []).map(p => p.description).filter(Boolean).join(', ');
    }
    function invoiceUrl(inv) { return MDM.href('admin/invoice.html?id=' + encodeURIComponent(inv.id)); }
    function invoiceActions(inv, account) {
      const url = invoiceUrl(inv);
      const text = 'Mr. Delivery Man: invoice ' + inv.number + ' for ' + monthLabel(inv.month) + ', ' + money(inv.total, { cents: true }) + ', due ' + fmtDate(inv.dueAt, { dateOnly: true }) + '. ' + url;
      const links = phone.links(account.phone, text);
      const markSent = async () => { if (inv.status === 'draft') { try { await MDM.store.update('invoices', inv.id, { status: 'sent', sentAt: nowIso() }); } catch (e) { /* the link still opens */ } } };
      return actionsRow(
        el('a', { class: 'btn btn--secondary btn--sm', href: url, target: '_blank', rel: 'noopener', 'data-testid': 'invoice-open' }, 'Open'),
        inv.status !== 'paid' ? el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'invoice-mark-paid', on: { click: () => markPaid(inv) } }, 'Mark paid') : null,
        links ? el('a', { class: 'btn btn--ghost btn--sm', href: links.wa, target: '_blank', rel: 'noopener', title: 'Send on WhatsApp to ' + phone.format(account.phone), 'data-testid': 'invoice-send', on: { click: markSent } }, 'Send') : null);
    }
    async function generateInvoice(account, mine, invoices, month) {
      if (!mine.length) { toast('No delivered business orders in ' + monthLabel(month) + ' to invoice yet', 'warn'); return; }
      const existing = invoices.find(i => i.month === month);
      if (existing) {
        const ok = await MDM.ui.confirm({ title: 'Invoice already exists', message: existing.number + ' already covers ' + monthLabel(month) + '. Create another one for the same month?', okLabel: 'Create invoice' });
        if (!ok) return;
      }
      try {
        const inv = await MDM.store.createInvoice(account.id, month);
        toast('Invoice ' + inv.number + ' created, ' + money(inv.total, { cents: true }) + ' due ' + fmtDate(inv.dueAt, { dateOnly: true }));
      } catch (e) { toast(storeMessage(e), 'danger'); }
    }
    async function markPaid(inv) {
      const v = await MDM.ui.dialog({ title: 'Mark ' + inv.number + ' as paid', message: money(inv.total, { cents: true }) + ' received by bank transfer.', okLabel: 'Mark paid',
        fields: [{ name: 'paidAt', label: 'Date received', type: 'date', required: true, value: MDM.ui.dayKey(new Date()) }, { name: 'reference', label: 'Transfer reference', type: 'text', placeholder: 'FAVARA 2291' }] });
      if (!v) return;
      const d = new Date(v.paidAt + 'T12:00:00');
      try { await MDM.store.update('invoices', inv.id, { status: 'paid', paidAt: isNaN(d) ? nowIso() : d.toISOString(), reference: v.reference || '' }); toast(inv.number + ' marked as paid'); }
      catch (e) { toast(storeMessage(e), 'danger'); }
    }
    return { title: 'Business', mount, unmount };
  })();

  // ==== #/rates ================================================================================================================
  MDM.admin.views.rates = (function () {
    let ctx = null, root = null, form = null, dirty = false;
    async function mount(host) {
      ctx = context(); root = host; dirty = false;
      root.replaceChildren(pageHead('Rates', 'The figures the website quotes and the checkout uses. Saved values apply to new requests; existing orders keep their prices.'), el('div', { class: 'skeleton', style: 'height: 96px' }));
      ctx.sub('settings', () => { if (!dirty) ctx.schedule(render); });
      ctx.sub('*', m => { if (m && m.op === 'reset') { dirty = false; ctx.schedule(render); } });
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; form = null; }
    const grid = (s) => {
      const sizes = s.rates.sizes;
      const cell = (size, side) => numInput('sizes.' + size + '.' + side, sizes[size][side], { 'aria-label': MDM.pricing.sizeLabel(size) + ', ' + (side === 'same' ? 'within one island' : 'crossing the bridge'), 'data-testid': 'rates-size-' + size + '-' + side });
      return el('div', { class: 'rates-grid', role: 'group', 'aria-label': 'Package rates in MVR' },
        el('div', { class: 'rates-grid__head' }, 'Size'), el('div', { class: 'rates-grid__head' }, 'Within one island'), el('div', { class: 'rates-grid__head' }, 'Crossing the bridge'),
        ['bag', 'box', 'xl'].map(size => [el('div', { class: 'rates-grid__label' }, MDM.pricing.sizeLabel(size)), cell(size, 'same'), cell(size, 'cross')]));
    };
    async function render() {
      const s = await MDM.store.settings();
      if (!ctx || !ctx.alive) return;
      const ops = s.ops || {}, hours = ops.hours || {}, banks = (s.banks || []).slice(0, 2);
      while (banks.length < 2) banks.push({ id: banks.length ? 'bank2' : 'bank1', name: '', accountName: '', accountNo: '' });
      const formCard = (title, caption, children) => el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, title)),
        el('div', { class: 'card__body form-card__body' }, caption ? el('p', { class: 'form-caption' }, caption) : null, children));
      form = el('form', { class: 'form', novalidate: true, 'data-testid': 'rates-form', on: { submit: save, input: () => { dirty = true; } } },
        formCard('Package rates', 'MVR per package. The lower figure applies within one island, the higher one when pickup and drop-off are on different islands.',
          [grid(s), checkbox('xlQuoted', s.rates.sizes.xl.quoted, 'XL is quoted before pickup', 'The website prints "from MVR 60" for XL and the request waits for your quote')]),
        formCard('Fees', null, [
          el('div', { class: 'grid-2' }, field('Cargo fee, MVR', numInput('cargo', s.rates.cargo), { hint: 'Per package picked up or dropped at a terminal' }), field('Airport fee, MVR', numInput('airport', s.rates.airport), { hint: 'Once per order touching the airport' })),
          el('div', { class: 'grid-2' }, field('Shopping fee, % of the receipt', numInput('shoppingPct', s.rates.shoppingPct, { max: '100' })), field('Business rate per package, MVR', numInput('business', s.rates.business), { hint: 'New business accounts start on this rate' }))]),
        formCard('Rules', 'Assumed rule, confirm with client', [
          checkbox('airportReplacesCross', s.rules.airportReplacesCross, 'Airport replaces the cross-island figure', 'A package touching the airport is priced at its same-island figure and the airport fee is added once'),
          el('div', { class: 'grid-2' },
            field('Cargo fee charged per', select('cargoFeePer', s.rules.cargoFeePer, [{ value: 'package', label: 'Package' }, { value: 'order', label: 'Order' }])),
            field('Airport fee charged per', select('airportFeePer', s.rules.airportFeePer, [{ value: 'order', label: 'Order' }, { value: 'package', label: 'Package' }])))]),
        formCard('Size guide', 'Wording to confirm with client', [
          field('Bag', textarea('guide.bag', s.sizeGuide.bag, { rows: 2 })), field('Box', textarea('guide.box', s.sizeGuide.box, { rows: 2 })), field('XL', textarea('guide.xl', s.sizeGuide.xl, { rows: 2 }))]),
        formCard('Operations', 'Operations · demo defaults, not from the client brief', [
          el('div', { class: 'grid-2' }, field('Opens at', input('hours.open', hours.open, { placeholder: '09:00', inputmode: 'numeric' })), field('Closes at', input('hours.close', hours.close, { placeholder: '23:00', inputmode: 'numeric' }))),
          field('Days', input('days', ops.days)),
          field('ASAP wording', input('asapText', ops.asapText), { hint: 'Shown under "ASAP" on the request page' }),
          el('div', { class: 'grid-2' }, field('Payment review time', input('reviewText', ops.reviewText), { hint: 'Shown as "usually within …"' }), field('Business reply time', input('businessReplyText', ops.businessReplyText))),
          el('div', { class: 'grid-3' }, field('First slot', input('slotStart', ops.slotStart, { placeholder: '09:00' })), field('Last slot', input('slotEnd', ops.slotEnd, { placeholder: '23:00' })), field('Slot length, minutes', numInput('slotMinutes', ops.slotMinutes))),
          el('div', { class: 'grid-3' }, field('City speed, km/h', numInput('speedCityKmh', ops.speedCityKmh)), field('Bridge speed, km/h', numInput('speedHighwayKmh', ops.speedHighwayKmh)), field('Peak buffer, minutes', numInput('peakBufferMin', ops.peakBufferMin))),
          field('Peak windows', input('peakWindows', (ops.peakWindows || []).join(', ')), { hint: 'Comma separated, 24 h clock: 08:00-09:30, 17:00-19:30' }),
          field('Closed windows', input('closedWindows', (ops.closedWindows || []).join(', ')), { hint: 'Comma separated, optional day prefix: Fri 12:00-13:30' })]),
        formCard('Bank accounts', 'Printed at checkout and on invoices. Transfer reference is always the order or invoice number.', banks.map((b, i) => el('div', { class: 'grid-3' },
          field('Bank ' + (i + 1), input('banks.' + i + '.name', b.name)), field('Account name', input('banks.' + i + '.accountName', b.accountName)), field('Account number', input('banks.' + i + '.accountNo', b.accountNo, { class: 'input mono', inputmode: 'numeric' }))))),
        formCard('Terms and invoicing', null, [
          field('What we carry', textarea('terms', s.terms), { hint: 'Shown at checkout with the "I\'ve read what we carry" checkbox' }),
          el('div', { class: 'grid-2' }, field('Invoices due in, days', numInput('invoiceDueDays', s.invoiceDueDays)), field('GST, %', numInput('gstPercent', s.gstPercent, { max: '100' }), { hint: '0 hides the GST line on invoices' }))]),
        el('div', { class: 'form-actions' }, el('span', { class: 'form-caption' }, 'Changes apply to new requests and quotes.'), el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'rates-save' }, 'Save rates')));
      const old = root.querySelector('form, .skeleton'); if (old) old.replaceWith(form); else root.appendChild(form);
      dirty = false;
    }
    const intRule = v => /^\d+$/.test(v) ? null : 'Enter a whole number, 0 or more';
    const pctRule = v => intRule(v) || (Number(v) > 100 ? 'Enter at most 100' : null);
    const timeRule = v => MDM.ui.parseHHMM(v) == null ? 'Use the 24 h clock, like 09:00' : null;
    const windowsRule = v => (v ? v.split(',').map(x => x.trim()).filter(Boolean) : []).every(w => /^(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+)?\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(w)) ? null : 'Use 08:00-09:30, comma separated, with an optional day prefix';
    const textRule = v => v ? null : 'This field is required';
    async function save(e) {
      e.preventDefault();
      const rules = { cargo: intRule, airport: intRule, shoppingPct: pctRule, business: intRule, slotMinutes: intRule, speedCityKmh: intRule, speedHighwayKmh: intRule, peakBufferMin: intRule, invoiceDueDays: intRule, gstPercent: pctRule,
        'hours.open': timeRule, 'hours.close': timeRule, slotStart: timeRule, slotEnd: timeRule, peakWindows: windowsRule, closedWindows: windowsRule,
        'guide.bag': textRule, 'guide.box': textRule, 'guide.xl': textRule, terms: textRule, asapText: textRule, reviewText: textRule, businessReplyText: textRule, days: textRule };
      ['bag', 'box', 'xl'].forEach(size => ['same', 'cross'].forEach(side => { rules['sizes.' + size + '.' + side] = intRule; }));
      [0, 1].forEach(i => { rules['banks.' + i + '.name'] = textRule; rules['banks.' + i + '.accountName'] = textRule; rules['banks.' + i + '.accountNo'] = textRule; });
      const r = MDM.ui.validate(form, rules);
      if (!r.ok) { MDM.ui.focusFirstInvalid(form); toast('Check the highlighted fields', 'warn'); return; }
      const v = r.values, n = k => Number(v[k]), list = k => v[k] ? v[k].split(',').map(x => x.trim()).filter(Boolean) : [];
      const cur = await MDM.store.settings();
      const patch = {
        rates: { sizes: { bag: { same: n('sizes.bag.same'), cross: n('sizes.bag.cross') }, box: { same: n('sizes.box.same'), cross: n('sizes.box.cross') }, xl: { same: n('sizes.xl.same'), cross: n('sizes.xl.cross'), quoted: val(form, 'xlQuoted') } },
          cargo: n('cargo'), airport: n('airport'), shoppingPct: n('shoppingPct'), business: n('business') },
        rules: { airportReplacesCross: val(form, 'airportReplacesCross'), cargoFeePer: v.cargoFeePer, airportFeePer: v.airportFeePer },
        sizeGuide: { bag: v['guide.bag'], box: v['guide.box'], xl: v['guide.xl'] },
        ops: { hours: { open: v['hours.open'], close: v['hours.close'] }, days: v.days, asapText: v.asapText, reviewText: v.reviewText, businessReplyText: v.businessReplyText,
          slotStart: v.slotStart, slotEnd: v.slotEnd, slotMinutes: n('slotMinutes'), speedCityKmh: n('speedCityKmh'), speedHighwayKmh: n('speedHighwayKmh'), peakBufferMin: n('peakBufferMin'),
          peakWindows: list('peakWindows'), closedWindows: list('closedWindows') },
        banks: [0, 1].map(i => ({ id: (cur.banks && cur.banks[i] && cur.banks[i].id) || ('bank' + (i + 1)), name: v['banks.' + i + '.name'], accountName: v['banks.' + i + '.accountName'], accountNo: v['banks.' + i + '.accountNo'] })),
        terms: v.terms, invoiceDueDays: n('invoiceDueDays'), gstPercent: n('gstPercent'),
      };
      const btn = form.querySelector('[data-testid="rates-save"]');
      MDM.ui.setLoading(btn, true);
      try { await MDM.store.saveSettings(patch); dirty = false; toast('Rates saved. The website shows the new figures on its next load.'); }
      catch (err) { toast(storeMessage(err), 'danger'); }
      finally { MDM.ui.setLoading(btn, false); }
    }
    return { title: 'Rates', mount, unmount };
  })();

  // ==== #/settings =============================================================================================================
  MDM.admin.views.settings = (function () {
    let ctx = null, root = null, ui = null, dirty = false;
    async function mount(host) {
      ctx = context(); root = host; dirty = false; ui = {};
      root.replaceChildren(pageHead('Settings', 'Contact details, the public notice bar, the demo switches and your data.'), el('div', { class: 'skeleton', style: 'height: 96px' }));
      ctx.sub('settings', () => { if (!dirty) ctx.schedule(render); });
      ctx.sub('*', m => { if (m && m.op === 'reset') { dirty = false; ctx.schedule(render); } });
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; ui = null; }
    async function render() {
      const s = await MDM.store.settings();
      if (!ctx || !ctx.alive) return;
      const c = s.contact || {}, notice = s.notice || {}, demo = s.demo || {};
      const contactForm = el('form', { class: 'form', novalidate: true, 'data-testid': 'settings-contact-form', on: { submit: saveContact, input: () => { dirty = true; } } },
        el('div', { class: 'alert alert--info', role: 'note' }, icon('info'), el('div', { class: 'alert__body' }, 'Demo contact details, replace before launch')),
        el('div', { class: 'grid-2' }, field('Phone', input('phone', phone.format(c.phone), { type: 'tel', inputmode: 'numeric', autocomplete: 'tel', class: 'input mono' }), { hint: 'Shown in the footer and on "Call us"' }), field('WhatsApp', input('whatsapp', phone.format(c.whatsapp), { type: 'tel', inputmode: 'numeric', class: 'input mono' }))),
        el('div', { class: 'grid-2' }, field('Viber', input('viber', phone.format(c.viber), { type: 'tel', inputmode: 'numeric', class: 'input mono' })), field('Email', input('email', c.email, { type: 'email', autocomplete: 'email' }))),
        el('div', { class: 'form-actions' }, el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'settings-save-contact' }, 'Save contact details')));
      const noticeForm = el('form', { class: 'form', novalidate: true, 'data-testid': 'settings-notice-form', on: { submit: saveNotice, input: () => { dirty = true; } } },
        field('Notice text', textarea('noticeText', notice.text, { rows: 2, 'data-testid': 'settings-notice-text' }), { hint: 'One line under the website header, for closures and delays' }),
        checkbox('noticeActive', notice.active, 'Show the notice on the public site'),
        el('div', { class: 'form-actions' }, el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'settings-save-notice' }, 'Save notice')));
      ui.autopilot = el('input', { type: 'checkbox', id: 'settings-autopilot', 'data-testid': 'settings-autopilot', checked: !!demo.autopilot, on: { change: saveAutopilot } });
      const demoBody = el('div', { class: 'stack-4' },
        el('label', { class: 'checkbox', for: 'settings-autopilot' }, ui.autopilot, el('span', null, 'Demo autopilot', el('span', { class: 'hint' }, 'Keeps the sample rider on MDM-1038 moving so the tracking demo is never static. Off in production.'))),
        el('p', { class: 'settings-note' }, 'Reset puts back the sample orders, riders, customers and invoices and clears everything added since. Your sign-in stays.'),
        el('div', { class: 'settings-actions' }, el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'settings-reset', on: { click: resetDemo } }, icon('refresh'), 'Reset demo data')));
      ui.importInput = el('input', { class: 'sr-only', type: 'file', id: 'settings-import', accept: 'application/json,.json', 'data-testid': 'settings-import', on: { change: importFile } });
      ui.importError = el('div', { class: 'alert alert--danger', role: 'alert', hidden: true, 'data-testid': 'settings-import-error' }, icon('alert-circle'), el('div', { class: 'alert__body' }));
      const dataBody = el('div', { class: 'stack-4' },
        el('p', { class: 'settings-note' }, 'Export saves everything in this browser as one JSON file. With files includes uploaded slips and photos, which makes it much larger.'),
        el('div', { class: 'settings-actions' },
          el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'settings-export', on: { click: () => exportData(false) } }, icon('download'), 'Export JSON'),
          el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'settings-export-files', on: { click: () => exportData(true) } }, icon('download'), 'Export JSON with files')),
        el('p', { class: 'settings-note' }, 'Import replaces the data in this browser with a file exported from this demo.'),
        el('div', { class: 'settings-actions' }, el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'settings-import-button', on: { click: () => ui.importInput.click() } }, icon('upload'), 'Import JSON'), ui.importInput),
        ui.importError);
      const content = el('div', { class: 'stack-6' },
        el('section', { 'aria-labelledby': 'set-contact' }, sectionHead('set-contact', 'Contact details'), card(null, el('div', { class: 'card__body' }, contactForm))),
        el('section', { 'aria-labelledby': 'set-notice' }, sectionHead('set-notice', 'Public notice'), card(null, el('div', { class: 'card__body' }, noticeForm))),
        el('section', { 'aria-labelledby': 'set-demo' }, sectionHead('set-demo', 'Demo'), card(null, el('div', { class: 'card__body' }, demoBody))),
        el('section', { 'aria-labelledby': 'set-data' }, sectionHead('set-data', 'Your data'), card(null, el('div', { class: 'card__body' }, dataBody))));
      const old = root.querySelector('.stack-6, .skeleton'); if (old) old.replaceWith(content); else root.appendChild(content);
      dirty = false;
    }
    async function saveContact(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const mobile = v => !v ? 'Enter a mobile number' : (phone.valid(v) ? null : 'Enter a 7-digit Maldives mobile number');
      const r = MDM.ui.validate(form, { phone: mobile, whatsapp: mobile, viber: mobile, email: v => !v ? 'Enter an email address' : (EMAIL.test(v) ? null : 'Enter a valid email address') });
      if (!r.ok) { MDM.ui.focusFirstInvalid(form); return; }
      try {
        await MDM.store.saveSettings({ contact: { phone: phone.normalize(r.values.phone), whatsapp: phone.normalize(r.values.whatsapp), viber: phone.normalize(r.values.viber), email: r.values.email } });
        dirty = false; toast('Contact details saved');
      } catch (err) { toast(storeMessage(err), 'danger'); }
    }
    async function saveNotice(e) {
      e.preventDefault();
      const form = e.currentTarget, text = val(form, 'noticeText'), active = val(form, 'noticeActive');
      if (active && !text) { MDM.ui.setError(form.elements.noticeText, 'Enter the notice text or switch it off'); form.elements.noticeText.focus(); return; }
      MDM.ui.setError(form.elements.noticeText, null);
      try { await MDM.store.saveSettings({ notice: { text, active } }); dirty = false; toast(active ? 'Notice is showing on the public site' : 'Notice saved and hidden'); }
      catch (err) { toast(storeMessage(err), 'danger'); }
    }
    async function saveAutopilot() {
      const on = ui.autopilot.checked;
      try { await MDM.store.saveSettings({ demo: { autopilot: on } }); toast(on ? 'Demo autopilot on' : 'Demo autopilot off'); }
      catch (err) { ui.autopilot.checked = !on; toast(storeMessage(err), 'danger'); }
    }
    async function resetDemo() {
      const ok = await MDM.ui.confirm({ title: 'Reset demo data', message: 'Every order, rider, customer and invoice goes back to the sample set. Anything added or changed in this browser is lost.', okLabel: 'Reset demo data', danger: true });
      if (!ok) return;
      try { await MDM.store.reset(); toast('Demo data restored'); }
      catch (err) { toast(storeMessage(err), 'danger'); }
    }
    async function exportData(includeFiles) {
      try {
        const text = await MDM.store.exportJSON({ includeFiles });
        download(text, 'mdm-export-' + MDM.ui.dayKey(new Date()) + (includeFiles ? '-with-files' : '') + '.json');
        toast('Export ready, ' + MDM.ui.formatBytes(text.length));
      } catch (err) { toast(storeMessage(err), 'danger'); }
    }
    async function importFile() {
      const file = ui.importInput.files && ui.importInput.files[0];
      if (!file) return;
      const showError = msg => { ui.importError.querySelector('.alert__body').textContent = msg; ui.importError.hidden = false; };
      ui.importError.hidden = true;
      try {
        const text = await file.text();
        await MDM.store.importJSON(text);
        toast('Data imported from ' + file.name);
      } catch (err) {
        if (err && err.code === 'schema') showError(err.message + '. Choose a file exported from this demo.');
        else if (err && err.code === 'quota') showError('This browser is out of storage space for the demo. Reset demo data or use an export without files.');
        else showError('Could not read ' + file.name + '.');
      } finally { ui.importInput.value = ''; }
    }
    return { title: 'Settings', mount, unmount };
  })();
})(window.MDM);

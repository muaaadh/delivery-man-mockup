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
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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

  const actor = () => (MDM.admin.by ? MDM.admin.by() : 'admin');
  const canView = v => (typeof MDM.admin.can === 'function' ? MDM.admin.can(v) : true);

  // ---- Shared with ops.js and cash.js (MDM.admin.kit) -----------------------------------------------------------------------
  // formDialog({ title, message, content, okLabel, cancelLabel (null hides it), wide, danger, onOk() → false keeps it open }) → Promise<boolean>.
  // The same native <dialog> markup as MDM.ui.dialog, for forms that need more than a list of fields (a photo, a grid of rates).
  function formDialog(o) {
    return new Promise(resolve => {
      const titleId = 'fd-title-' + (++fieldSeq);
      const ok = el('button', { type: 'submit', class: 'btn ' + (o.danger ? 'btn--danger' : 'btn--primary'), 'data-testid': 'dialog-ok' }, o.okLabel || 'Save');
      const cancel = o.cancelLabel === null ? null : el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'dialog-cancel', on: { click: () => dlg.close('') } }, o.cancelLabel || 'Cancel');
      const form = el('form', { method: 'dialog', class: 'dialog__form', novalidate: true },
        el('h2', { class: 'dialog__title', id: titleId }, o.title || ''),
        o.message ? el('p', { class: 'dialog__message' }, o.message) : null,
        o.content ? el('div', { class: 'dialog__fields' }, o.content) : null,
        el('div', { class: 'dialog__actions' }, cancel, ok));
      const dlg = el('dialog', { class: 'dialog' + (o.wide ? ' dialog--wide' : ''), 'aria-labelledby': titleId, 'data-testid': o.testid || 'dialog' }, form);
      let busy = false;
      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (busy) return;
        busy = true; MDM.ui.setLoading(ok, true);
        let close = true;
        try { close = o.onOk ? (await o.onOk()) !== false : true; }
        catch (err) { close = false; toast(storeMessage(err), 'danger'); }
        finally { busy = false; if (dlg.isConnected) MDM.ui.setLoading(ok, false); }
        if (close) dlg.close('ok');
      });
      dlg.addEventListener('click', e => {
        if (e.target !== dlg) return;
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close('');
      });
      dlg.addEventListener('close', () => { const v = dlg.returnValue === 'ok'; dlg.remove(); resolve(v); });
      document.body.appendChild(dlg);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      const first = dlg.querySelector('.dialog__fields input:not([type="hidden"]):not([disabled]), .dialog__fields select, .dialog__fields textarea') || ok;
      try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
    });
  }
  // Uploaded photos (files collection) by id → { id: file } for the ids that exist.
  async function loadFiles(ids) {
    const want = (ids || []).filter((v, i, a) => v && a.indexOf(v) === i);
    const files = await Promise.all(want.map(id => MDM.store.get('files', id)));
    const out = {}; files.forEach(f => { if (f) out[f.id] = f; });
    return out;
  }
  function showPhoto(file, caption) {
    return formDialog({ title: caption || 'Photo', wide: true, okLabel: 'Close', cancelLabel: null, testid: 'photo-dialog',
      content: el('figure', { class: 'photo-view' }, el('img', { src: file.dataUrl, alt: caption || 'Photo' })) });
  }
  // A thumbnail that opens the full photo; a quiet "No photo" note when the file is missing.
  function photoThumb(file, caption, opts) {
    opts = opts || {};
    if (!file || !file.dataUrl) return el('span', { class: 'subtle' }, 'No photo');
    return el('button', { type: 'button', class: 'photo-btn' + (opts.large ? ' photo-btn--large' : ''), 'aria-label': 'Open the photo: ' + (caption || file.name || 'photo'), 'data-testid': opts.testid || 'photo-open', on: { click: e => { e.stopPropagation(); showPhoto(file, caption); } } },
      el('img', { class: 'thumb', src: file.dataUrl, alt: caption || file.name || 'Photo' }));
  }
  const tierInfo = (value, settings) => MDM.pricing.businessTiers(settings).find(t => t.value === value) || null;
  function tierName(value, settings) { const t = tierInfo(value, settings); return t ? t.label : (value || ''); }
  // "Small MVR 25 · Medium MVR 35" for an account's agreed rates.
  function ratesText(account, settings) { return MDM.pricing.accountTiers(account, settings).map(t => t.label + ' ' + money(t.rate)).join(' · '); }
  // tierEditor(tiers, { picked(tier) → bool, rate(tier) → number }) → { el, read() → { tier: rate } | null }: one row per size category with
  // "uses this size" and its agreed rate; read() checks at least one is picked and every picked rate is a whole number above 0.
  function tierEditor(tiers, opts) {
    const rows = tiers.map(t => {
      const id = 'tier-' + (++fieldSeq);
      const cb = el('input', { type: 'checkbox', id: id + '-on', checked: !!opts.picked(t), 'data-testid': 'tier-check-' + t.value });
      const rate = el('input', { class: 'input', type: 'number', inputmode: 'numeric', min: '1', step: '1', id: id + '-rate', value: opts.rate(t) == null ? '' : String(opts.rate(t)), 'data-testid': 'tier-rate-' + t.value, disabled: !cb.checked });
      cb.addEventListener('change', () => { rate.disabled = !cb.checked; MDM.ui.setError(rate.closest('.field'), null); if (cb.checked) rate.focus(); });
      const wrap = el('div', { class: 'tier-row', 'data-tier': t.value },
        el('label', { class: 'checkbox', for: cb.id }, cb, el('span', null, t.label + ' · ' + MDM.pricing.sizeLabel(t.size), t.hint ? el('span', { class: 'hint' }, t.hint) : null)),
        el('div', { class: 'field tier-row__rate' }, el('label', { for: rate.id }, 'Rate per package, MVR'), rate));
      return { t, cb, rate, wrap };
    });
    const error = el('div', { class: 'field__error', role: 'alert', hidden: true, 'data-testid': 'tier-error' });
    function read() {
      error.hidden = true;
      const out = {};
      let bad = null;
      rows.forEach(r => {
        MDM.ui.setError(r.rate.closest('.field'), null);
        if (!r.cb.checked) return;
        const v = String(r.rate.value || '').trim();
        if (!/^\d+$/.test(v) || Number(v) < 1) { MDM.ui.setError(r.rate.closest('.field'), 'Enter a whole number above 0'); bad = bad || r.rate; return; }
        out[r.t.value] = Number(v);
      });
      if (bad) { bad.focus(); return null; }
      if (!Object.keys(out).length) { error.textContent = 'Pick at least one package size and agree its rate'; error.hidden = false; (rows[0] && rows[0].cb).focus(); return null; }
      return out;
    }
    return { el: el('div', { class: 'tier-editor', 'data-testid': 'tier-editor' }, rows.map(r => r.wrap), error), read };
  }
  MDM.admin.kit = Object.assign(MDM.admin.kit || {}, { formDialog, loadFiles, photoThumb, showPhoto, tierEditor, tierName, ratesText });

  // Delivered business orders of one account in a month (the same rule createInvoice uses: the delivered event's month).
  function monthOrders(orders, accountId, month) {
    return orders.filter(o => o.accountId === accountId && o.service === 'business' && o.status === 'delivered' && String(deliveredAt(o)).slice(0, 7) === month);
  }
  const packageCount = orders => orders.reduce((n, o) => n + (o.packages || []).length, 0);
  const orderTotal = orders => orders.reduce((n, o) => n + ((o.totals && o.totals.total) || 0), 0);
  // Cash on delivery of one account by status (§5.6): { pending: { n, amount }, collected, with_office, remitted, not_collected }.
  function codSummary(orders, accountId) {
    const out = {}; Object.keys(MDM.COD_STATUS).forEach(k => { out[k] = { n: 0, amount: 0 }; });
    orders.forEach(o => {
      if (o.accountId !== accountId || !o.cod || !(o.cod.amount > 0)) return;
      const s = out[o.cod.status] || (out[o.cod.status] = { n: 0, amount: 0 });
      s.n += 1; s.amount += o.cod.status === 'pending' || o.cod.status === 'not_collected' ? o.cod.amount : (o.cod.collectedAmount || 0);
    });
    return out;
  }

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
    const by = () => (MDM.admin.by ? MDM.admin.by() : 'admin');
    async function mount(host) {
      ctx = context(); root = host;
      body = el('div', null, el('div', { class: 'skeleton', style: 'height: 96px' }));
      root.replaceChildren(
        pageHead('Drivers', 'Every driver, the zones they cover, whether they are on duty, today\'s deliveries and where they were last seen.',
          [el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'drivers-add', on: { click: addRider } }, icon('plus'), 'Add driver')]),
        card(null, body, { 'data-testid': 'drivers-card' }));
      ['drivers', 'orders', 'zones', 'attendance', 'staff', 'positions'].forEach(c => ctx.sub(c, () => ctx.schedule(render)));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      ctx.every(30000, () => ctx.schedule(render));
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; body = null; }
    async function render() {
      const [drivers, zones, attendance, orders, positions] = await Promise.all([MDM.store.list('drivers', { order: 'name' }), MDM.store.list('zones', { order: 'createdAt' }), MDM.store.list('attendance'), MDM.store.list('orders'), MDM.store.list('positions')]);
      if (!ctx || !ctx.alive) return;
      if (!drivers.length) { body.replaceChildren(empty('Nothing here yet.', 'Add a driver to start assigning orders.')); return; }
      const today = MDM.ui.dayKey(new Date());
      const zonesOf = d => zones.filter(z => (z.driverIds || []).indexOf(d.id) >= 0 || (d.zones || []).indexOf(z.key) >= 0);
      const shift = d => attendance.find(a => a.staffId === d.staffId && !a.outAt);
      const deliveredToday = d => orders.filter(o => o.driverId === d.id && o.status === 'delivered' && MDM.ui.dayKey(deliveredAt(o)) === today).length;
      const activeJobs = d => orders.filter(o => o.driverId === d.id && ['assigned', 'dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery', 'failed'].indexOf(o.status) >= 0).length;
      const pos = d => positions.find(p => p.driverId === d.id);
      const cols = [
        { label: 'Name', primary: true, render: d => el('span', null, d.name, el('span', { class: 'table__sub' }, (VEHICLES[d.vehicle] || d.vehicle) + (d.vehicleNote ? ' · ' + d.vehicleNote : ''))) },
        { label: 'Phone', nowrap: true, render: d => telLink(d.phone) },
        { label: 'Zones', render: d => { const zs = zonesOf(d); return zs.length ? el('span', { class: 'chip-list' }, zs.map(z => el('span', { class: 'tag' }, z.short || z.name))) : el('span', { class: 'subtle' }, 'No zone'); } },
        { label: 'Duty', nowrap: true, render: d => { const s = shift(d); return s ? el('span', null, html(MDM.ui.badge('ok', 'On duty', { 'data-duty': 'on' })), el('span', { class: 'table__sub' }, 'since ' + MDM.ui.fmtTime(s.inAt))) : html(MDM.ui.badge('neutral', 'Off duty', { 'data-duty': 'off' })); } },
        { label: 'Status', primary: true, render: d => badge(DRIVER_STATUS, d.status) },
        { label: 'Today', num: true, render: d => el('span', null, String(deliveredToday(d)) + ' delivered', el('span', { class: 'table__sub' }, plural(activeJobs(d), 'active job'))) },
        { label: 'Last seen', nowrap: true, render: d => { const p = pos(d); return p ? el('a', { href: '#/live?driver=' + encodeURIComponent(d.id), on: { click: e => { e.preventDefault(); navigate('#/live?driver=' + encodeURIComponent(d.id)); } } }, MDM.ui.timeAgo(p.at)) : el('span', { class: 'subtle' }, 'No location'); } },
        { label: 'Actions', actions: true, render: d => actionsRow(
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'drivers-edit', on: { click: () => editRider(d, zones) } }, 'Edit'),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'drivers-toggle', on: { click: () => toggle(d) } }, d.status === 'offline' ? 'Set online' : 'Set offline')) },
      ];
      body.replaceChildren(table(cols, drivers.map(d => ({ data: d, attrs: { 'data-testid': 'drivers-row', 'data-driver-id': d.id, 'data-status': d.status } })), { testid: 'drivers-table' }));
    }
    function riderFields(d, zones) {
      d = d || {};
      const mine = z => (z.driverIds || []).indexOf(d.id) >= 0 || (d.zones || []).indexOf(z.key) >= 0;
      return [
        { name: 'name', label: 'Name', type: 'text', required: true, value: d.name || '', autocomplete: 'off' },
        { name: 'phone', label: 'Mobile number', type: 'tel', required: true, value: d.phone ? phone.format(d.phone) : '', placeholder: '7XX XXXX' },
        { name: 'vehicle', label: 'Vehicle', type: 'select', required: true, value: d.vehicle || 'bike', options: VEHICLE_OPTIONS },
        { name: 'vehicleNote', label: 'Vehicle note', type: 'text', value: d.vehicleNote || '', placeholder: 'Honda Wave' },
      ].concat(zones.map(z => ({ name: 'zone_' + z.key, label: 'Covers ' + z.name, type: 'checkbox', value: d.id ? mine(z) : false })));
    }
    async function saveZones(driverId, v, zones) {
      const keys = zones.filter(z => v['zone_' + z.key]).map(z => z.key);
      await MDM.store.update('drivers', driverId, { zones: keys });
      for (const z of zones) {
        const has = (z.driverIds || []).indexOf(driverId) >= 0, want = keys.indexOf(z.key) >= 0;
        if (has !== want) await MDM.store.update('zones', z.id, { driverIds: want ? (z.driverIds || []).concat([driverId]) : (z.driverIds || []).filter(x => x !== driverId) });
      }
    }
    async function addRider() {
      const zones = await MDM.store.list('zones', { order: 'createdAt' });
      const v = await MDM.ui.dialog({ title: 'Add driver', message: 'The driver signs in with this mobile number and appears on the team list for attendance and leave.', fields: riderFields(null, zones), okLabel: 'Add driver' });
      if (!v) return;
      try {
        const ph = phone.normalize(v.phone);
        const staff = await MDM.store.insert('staff', { name: v.name, role: 'driver', title: v.vehicle === 'pickup' ? 'Driver (pickup truck)' : 'Rider', phone: ph, username: ph, status: 'active', joinedAt: MDM.ui.dayKey(new Date()), leaveBalance: { annual: 30, sick: 30 } });
        const d = await MDM.store.insert('drivers', { name: v.name, phone: ph, vehicle: v.vehicle, vehicleNote: v.vehicleNote || '', status: 'offline', staffId: staff.id, zones: [] });
        await MDM.store.update('staff', staff.id, { driverId: d.id });
        await saveZones(d.id, v, zones);
        await MDM.store.audit('driver_added', v.name + ' added as a driver', by());
        toast(v.name + ' added as a driver');
      } catch (e) { toast(storeMessage(e), 'danger'); }
    }
    async function editRider(d, zones) {
      const v = await MDM.ui.dialog({ title: 'Edit driver', fields: riderFields(d, zones), okLabel: 'Save driver' });
      if (!v) return;
      try {
        await MDM.store.update('drivers', d.id, { name: v.name, phone: phone.normalize(v.phone), vehicle: v.vehicle, vehicleNote: v.vehicleNote || '' });
        if (d.staffId) await MDM.store.update('staff', d.staffId, { name: v.name, phone: phone.normalize(v.phone) });
        await saveZones(d.id, v, zones);
        toast('Driver updated');
      } catch (e) { toast(storeMessage(e), 'danger'); }
    }
    async function toggle(d) {
      const next = d.status === 'offline' ? 'online' : 'offline';
      try { await MDM.store.update('drivers', d.id, { status: next }); toast(d.name + ' is now ' + DRIVER_STATUS[next].label.toLowerCase()); }
      catch (e) { toast(storeMessage(e), 'danger'); }
    }
    return { title: 'Drivers', mount, unmount };
  })();

  // ==== #/customers ============================================================================================================
  MDM.admin.views.customers = (function () {
    let ctx = null, root = null, body = null;
    async function mount(host) {
      ctx = context(); root = host;
      body = el('div', null, el('div', { class: 'skeleton', style: 'height: 96px' }));
      root.replaceChildren(pageHead('Customers', 'Everyone who has placed an order, with payments still due. Open a customer to see their order history.'), card(null, body));
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
      orders.forEach(o => { if (o.status === 'draft') return; const s = stats[o.customerId] || (stats[o.customerId] = { count: 0, last: null, unpaid: 0 }); s.count += 1; if (!s.last || o.createdAt > s.last) s.last = o.createdAt; if (o.payment && (o.payment.status === 'requested' || o.payment.status === 'received')) s.unpaid += o.totals.total; });
      const rows = customers.map(c => { const s = stats[c.id] || { count: c.orderCount || 0, last: c.lastOrderAt || null, unpaid: 0 }; return { c, count: s.count, last: s.last || c.lastOrderAt || null, unpaid: s.unpaid || 0 }; })
        .sort((a, b) => (b.last || '') < (a.last || '') ? -1 : (b.last || '') > (a.last || '') ? 1 : a.c.name.localeCompare(b.c.name));
      const target = c => '#/orders?customer=' + encodeURIComponent(c.id);
      const cols = [
        { label: 'Name', primary: true, render: r => el('a', { href: target(r.c), on: { click: e => { e.preventDefault(); navigate(target(r.c)); } } }, r.c.name || phone.format(r.c.phone)) },
        { label: 'Phone', nowrap: true, render: r => telLink(r.c.phone) },
        { label: 'Orders', num: true, render: r => String(r.count) },
        { label: 'Last order', nowrap: true, render: r => r.last ? fmtDate(r.last) : 'No orders yet' },
        { label: 'Unpaid', num: true, render: r => r.unpaid ? money(r.unpaid) : '' },
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
      ['business_requests', 'business_accounts', 'orders', 'invoices', 'files'].forEach(c => ctx.sub(c, () => ctx.schedule(render)));
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
      root.replaceChildren(pageHead('Business', 'Account requests from the website and the accounts you invoice monthly. Each business is approved on its package sizes, with a fixed rate for each size.'), ui.tabs, ui.body);
    }
    function tabButton(key, label) {
      const count = el('span', { class: 'business-tab__count', 'data-tab-count': key });
      return el('button', { type: 'button', class: 'tab', role: 'tab', id: 'business-tab-' + key, 'aria-selected': tab === key ? 'true' : 'false', 'aria-controls': 'business-panel', 'data-testid': 'business-tab-' + key,
        on: { click: () => { if (tab === key) return; tab = key; setQuery({ tab: key === 'requests' ? null : key }); ui.tabs.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t.id === 'business-tab-' + key ? 'true' : 'false')); ctx.schedule(render); } } }, label, count);
    }
    async function renderList() {
      const [requests, accounts, orders, settings] = await Promise.all([MDM.store.list('business_requests'), MDM.store.list('business_accounts'), MDM.store.list('orders'), MDM.store.settings()]);
      const files = await loadFiles(requests.map(r => r.packagePhotoId));
      if (!ctx || !ctx.alive) return;
      const pending = requests.filter(r => r.status === 'pending').length;
      const rc = ui.tabs.querySelector('[data-tab-count="requests"]'), ac = ui.tabs.querySelector('[data-tab-count="accounts"]');
      rc.textContent = pending ? String(pending) : ''; ac.textContent = accounts.length ? String(accounts.length) : '';
      ui.body.id = 'business-panel'; ui.body.setAttribute('role', 'tabpanel'); ui.body.setAttribute('aria-labelledby', 'business-tab-' + tab);
      ui.body.replaceChildren(tab === 'requests' ? requestsCard(requests, settings, files) : accountsCard(accounts, orders, settings));
    }
    // The business's own guess of its usual package (small / medium / large) as the size category name.
    function guessText(r, settings) { const t = tierInfo(r.typicalSize, settings); return t ? t.label + ' · ' + MDM.pricing.sizeLabel(t.size) : (r.typicalSize || 'Not given'); }
    function requestsCard(requests, settings, files) {
      if (!requests.length) return card(null, empty('Nothing here yet.', 'Requests from the business page appear here.'));
      const sorted = requests.slice().sort((a, b) => (a.status === 'pending') === (b.status === 'pending') ? 0 : a.status === 'pending' ? -1 : 1);
      const cols = [
        { label: 'Business', primary: true, render: r => el('span', null, r.name, el('span', { class: 'table__sub nowrap' }, 'Requested ' + fmtDate(r.createdAt)), r.volume ? el('span', { class: 'table__sub nowrap' }, VOLUMES[r.volume] || r.volume) : null) },
        { label: 'Contact', nowrap: true, render: r => el('span', null, r.contactName || '', el('span', { class: 'table__sub' }, telLink(r.phone))) },
        { label: 'Zone', render: r => el('span', null, MDM.geo.zoneLabel(r.zone), r.pickupAddress ? el('span', { class: 'table__sub table__address request-address', title: r.pickupAddress }, r.pickupAddress) : null) },
        { label: 'Typical package', render: r => el('span', { class: 'pkg-cell', 'data-testid': 'business-request-package' },
          el('span', null, r.typicalSize ? el('span', { class: 'nowrap' }, guessText(r, settings)) : 'No size given', el('span', { class: 'table__sub nowrap' }, r.typicalSize ? 'their guess' : (r.packagePhotoId ? '' : 'no photo sent')),
            r.status === 'approved' && r.rates ? el('span', { class: 'table__sub' }, 'Agreed ' + Object.keys(r.rates).map(k => tierName(k, settings) + ' ' + money(r.rates[k])).join(' · ')) : null),
          r.packagePhotoId ? photoThumb(files[r.packagePhotoId], 'Typical package from ' + r.name, { testid: 'business-request-photo' }) : null) },
        { label: 'Status', primary: true, render: r => badge(REQUEST_STATUS, r.status) },
        { label: 'Actions', actions: true, render: r => r.status !== 'pending' ? el('span', { class: 'table__sub' }, r.status === 'declined' && r.declineReason ? r.declineReason : '') : el('div', { class: 'table__actions-row actions-stack' },
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'business-approve', on: { click: () => approve(r, files[r.packagePhotoId]) } }, 'Approve'),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'business-decline', on: { click: () => decline(r) } }, 'Decline')) },
      ];
      return card(null, table(cols, sorted.map(r => ({ data: r, attrs: { 'data-testid': 'business-request-row', 'data-request-id': r.id, 'data-status': r.status } })), { testid: 'business-requests' }));
    }
    function accountsCard(accounts, orders, settings) {
      if (!accounts.length) return card(null, empty('Nothing here yet.', 'Approve a request to open the first business account.'));
      const month = thisMonth();
      const cols = [
        { label: 'Business', primary: true, render: a => el('a', { href: '#/business/' + a.id, on: { click: e => { e.preventDefault(); navigate('#/business/' + a.id); } } }, a.name) },
        { label: 'Contact', nowrap: true, render: a => el('span', null, a.contactName || '', el('span', { class: 'table__sub mono' }, phone.format(a.phone))) },
        { label: 'Agreed rates', render: a => el('span', { class: 'business-rates', 'data-testid': 'business-account-rates' }, MDM.pricing.accountTiers(a, settings).map(t => el('span', { class: 'business-rates__line' }, t.label + ' ' + money(t.rate)))) },
        { label: 'This month', num: true, render: a => { const m = monthOrders(orders, a.id, month); return el('span', null, money(orderTotal(m)), el('span', { class: 'table__sub' }, plural(packageCount(m), 'package') + ' delivered')); } },
        { label: 'Cash to pay', num: true, render: a => { const c = codSummary(orders, a.id).with_office; return c.n ? money(c.amount) : ''; } },
        { label: 'Status', primary: true, render: a => badge({ approved: { label: 'Approved', kind: 'ok' }, paused: { label: 'Paused', kind: 'neutral' } }, a.status) },
        { label: 'Actions', actions: true, render: a => el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'business-view', on: { click: () => navigate('#/business/' + a.id) } }, 'View') },
      ];
      return card(null, table(cols, accounts.map(a => ({ data: a, attrs: { class: 'is-clickable', 'data-testid': 'business-account-row', 'data-account-id': a.id, 'data-status': a.status, on: { click: e => { if (e.target.closest('a, button')) return; navigate('#/business/' + a.id); } } } })), { testid: 'business-accounts' }));
    }
    // §1.3: look at the typical package photo, pick the size categories the business sends and agree a fixed rate for each.
    async function approve(r, photo) {
      try {
        const [settings, accounts] = await Promise.all([MDM.store.settings(), MDM.store.list('business_accounts')]);
        const existing = accounts.find(a => a.phone === r.phone);
        if (existing) {
          const ok = await MDM.ui.confirm({ title: 'Link to ' + existing.name, message: 'An account for ' + phone.format(r.phone) + ' already exists. Approving links this request to ' + existing.name + ' and keeps its agreed rates.', okLabel: 'Approve and link' });
          if (!ok) return;
          await MDM.store.update('business_requests', r.id, { status: 'approved', accountId: existing.id, decidedAt: nowIso(), decidedBy: actor() });
          await MDM.store.audit('business_approved', 'Business request from ' + r.name + ' linked to ' + existing.name, actor(), { accountId: existing.id });
          toast('Request approved and linked to ' + existing.name);
          return;
        }
        const tiers = MDM.pricing.businessTiers(settings);
        const guess = tiers.some(t => t.value === r.typicalSize) ? r.typicalSize : (tiers[0] || {}).value;
        const editor = tierEditor(tiers, { picked: t => t.value === guess, rate: t => t.rate });
        const notes = textarea('assessment', '', { rows: 2, placeholder: 'Cake boxes about 1 ft, fragile', 'data-testid': 'approve-assessment' });
        const content = [
          el('div', { class: 'approve-photo' },
            photo ? photoThumb(photo, 'Typical package from ' + r.name, { large: true, testid: 'approve-photo' }) : el('div', { class: 'approve-photo__none' }, 'No photo sent'),
            el('div', { class: 'approve-photo__text' },
              el('p', null, el('strong', null, 'Their guess: '), r.typicalSize ? guessText(r, settings) : 'not given'),
              r.volume ? el('p', { class: 'muted small' }, VOLUMES[r.volume] || r.volume) : null,
              r.notes ? el('p', { class: 'muted small' }, r.notes) : null)),
          el('fieldset', { class: 'tier-fieldset' }, el('legend', { class: 'field__label' }, 'Package sizes and agreed rates'), editor.el),
          field('Assessment', notes, { optional: true, hint: 'What the photo shows; kept on the account for the team' }),
        ];
        let account = null;
        const ok = await formDialog({ title: 'Approve ' + r.name, message: 'Check the package photo, pick the sizes this business sends and agree a fixed rate per package for each size.', content, wide: true, okLabel: 'Approve and open account',
          onOk: async () => { const rates = editor.read(); if (!rates) return false; account = await MDM.store.approveBusinessRequest(r.id, { rates, notes: notes.value.trim(), by: actor() }); return true; } });
        if (ok && account) toast('Account opened for ' + r.name + ': ' + ratesText(account, settings));
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
      ui.rates = el('div', { class: 'card' });
      ui.ratesAction = el('div');
      ui.points = el('div', { class: 'card' });
      ui.pointsAction = el('div');
      ui.cod = el('div', { class: 'card' });
      ui.codAction = el('div');
      ui.orders = el('div', { class: 'card' });
      ui.invoices = el('div', { class: 'card' });
      root.replaceChildren(ui.head,
        el('div', { class: 'stack-6' },
          el('section', { 'aria-labelledby': 'acc-details' }, sectionHead('acc-details', 'Account'), card(null, ui.details)),
          el('section', { 'aria-labelledby': 'acc-rates' }, sectionHead('acc-rates', 'Package sizes and agreed rates', 'Fixed delivery rate per package for each size category this business is approved on.', ui.ratesAction), ui.rates),
          el('div', { class: 'admin-grid' },
            el('section', { 'aria-labelledby': 'acc-points' }, sectionHead('acc-points', 'Collection points', 'Where we collect bulk orders from; the business picks one per bulk order.', ui.pointsAction), ui.points),
            el('section', { 'aria-labelledby': 'acc-cod' }, sectionHead('acc-cod', 'Cash on delivery', 'Cash our drivers collect from this business\'s customers, any date.', ui.codAction), ui.cod)),
          el('section', { 'aria-labelledby': 'acc-orders' }, sectionHead('acc-orders', 'Delivered this month'), ui.orders),
          el('section', { 'aria-labelledby': 'acc-invoices' }, sectionHead('acc-invoices', 'Invoices'), ui.invoices)));
    }
    async function renderAccount() {
      const [account, orders, invoices, settings] = await Promise.all([MDM.store.get('business_accounts', accountId), MDM.store.list('orders'), MDM.store.list('invoices', { where: { accountId } }), MDM.store.settings()]);
      const files = account ? await loadFiles([account.packagePhotoId]) : {};
      if (!ctx || !ctx.alive) return;
      if (!account) {
        root.replaceChildren(pageHead('Business account'), card(null, empty('No account with this link.', 'It may have been removed when the demo data was reset.',
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => navigate('#/business?tab=accounts') } }, 'Back to accounts'))));
        return;
      }
      const month = thisMonth(), mine = monthOrders(orders, account.id, month);
      const generate = el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'business-generate-invoice', on: { click: () => generateInvoice(account, mine, invoices, month) } }, icon('receipt'), 'Generate invoice');
      const back = el('a', { class: 'btn btn--ghost', href: '#/business?tab=accounts', on: { click: e => { e.preventDefault(); navigate('#/business?tab=accounts'); } } }, 'All accounts');
      const allOrders = el('a', { class: 'btn btn--secondary', href: '#/orders?account=' + encodeURIComponent(account.id), 'data-testid': 'business-all-orders' }, 'Order history');
      const bulk = canView('bulk') ? el('a', { class: 'btn btn--secondary', href: '#/bulk?account=' + encodeURIComponent(account.id), 'data-testid': 'business-bulk' }, 'Bulk orders') : null;
      const head = pageHead(account.name, 'Business account since ' + fmtDate(account.approvedAt || account.createdAt, { dateOnly: true }) + ' · fixed rates per package size, invoiced monthly' + (account.priorityAllowed ? ' · may request priority' : '') + '.', [back, allOrders, bulk, generate].filter(Boolean));
      ui.head.replaceWith(head); ui.head = head;
      renderRates(account, settings, files[account.packagePhotoId]);
      renderPoints(account);
      renderCod(account, orders);
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
          { label: 'Amount', num: true, render: o => money(o.totals.total) },
        ];
        ui.orders.replaceChildren(table(cols, sorted.map(o => ({ data: o, attrs: { class: 'is-clickable', 'data-testid': 'business-order-row', 'data-order-id': o.id, 'data-status': o.status, on: { click: e => { if (e.target.closest('button, a')) return; openOrder(o.id); } } } })), { testid: 'business-orders' }),
          el('div', { class: 'pagination' }, el('span', null, plural(packageCount(mine), 'package') + ' delivered in ' + monthLabel(month)), el('span', { class: 'mono' }, money(orderTotal(mine)))));
      }
      // Invoices
      if (!invoices.length) ui.invoices.replaceChildren(empty('No invoices yet.', 'Generate the invoice for ' + monthLabel(month) + ' once the month is delivered.'));
      else {
        const cols = [
          { label: 'Number', primary: true, render: i => el('span', { class: 'mono nowrap' }, i.number) },
          { label: 'Period', nowrap: true, render: i => monthLabel(i.month) },
          { label: 'Total', num: true, render: i => money(i.total) },
          { label: 'Status', primary: true, render: i => badge(INVOICE_STATUS, i.status) },
          { label: 'Issued', nowrap: true, render: i => fmtDate(i.issuedAt, { dateOnly: true }) },
          { label: 'Due', nowrap: true, render: i => i.status === 'paid' ? 'Paid ' + fmtDate(i.paidAt, { dateOnly: true }) : fmtDate(i.dueAt, { dateOnly: true }) },
          { label: 'Actions', actions: true, render: i => invoiceActions(i, account) },
        ];
        ui.invoices.replaceChildren(table(cols, invoices.map(i => ({ data: i, attrs: { 'data-testid': 'business-invoice-row', 'data-invoice-id': i.id, 'data-status': i.status } })), { testid: 'business-invoices' }));
      }
    }
    // Package photo + assessment and the agreed rate per size category, with "Edit rates" (MDM.store.setBusinessRates).
    function renderRates(account, settings, photo) {
      const tiers = MDM.pricing.accountTiers(account, settings);
      const agreed = account.rates && Object.keys(account.rates).length;
      ui.ratesAction.replaceChildren(el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'business-edit-rates', on: { click: () => editRates(account, settings) } }, 'Edit rates'));
      const rows = el('div', { class: 'rate-table', 'data-testid': 'business-rates' },
        tiers.map(t => el('div', { class: 'rate-table__row', 'data-tier': t.value },
          el('div', { class: 'rate-table__label' }, t.label + ' · ' + MDM.pricing.sizeLabel(t.size), t.hint ? el('small', null, t.hint) : null),
          el('div', { class: 'rate-table__value mono', 'data-testid': 'business-rate-' + t.value }, money(t.rate)))),
        agreed ? null : el('p', { class: 'muted small' }, 'No agreed sizes yet: every size is offered at the default rate until you edit the rates.'));
      ui.rates.replaceChildren(el('div', { class: 'card__body account-rates' },
        el('div', { class: 'account-rates__photo' },
          photoThumb(photo, 'Typical package from ' + account.name, { large: true, testid: 'business-package-photo' }),
          el('div', { class: 'account-rates__assess' }, el('div', { class: 'field__label' }, 'Assessment'), el('p', { 'data-testid': 'business-assessment' }, account.assessment || 'No assessment written yet.'))),
        rows));
    }
    async function editRates(account, settings) {
      const tiers = MDM.pricing.businessTiers(settings);
      const has = t => account.rates && account.rates[t.value] != null;
      const editor = tierEditor(tiers, { picked: t => account.rates && Object.keys(account.rates).length ? has(t) : true, rate: t => has(t) ? account.rates[t.value] : t.rate });
      const ok = await formDialog({ title: 'Rates for ' + account.name, message: 'Agreed fixed rate per package for each size this business sends. New bulk orders use these rates; existing orders keep their prices.', content: editor.el, wide: true, okLabel: 'Save rates',
        onOk: async () => { const rates = editor.read(); if (!rates) return false; await MDM.store.setBusinessRates(account.id, rates, actor()); return true; } });
      if (ok) toast('Rates saved for ' + account.name);
    }
    function renderPoints(account) {
      const points = account.collectionPoints || [];
      ui.pointsAction.replaceChildren(el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'business-point-add', on: { click: () => editPoint(account, null) } }, icon('plus'), 'Add collection point'));
      if (!points.length) { ui.points.replaceChildren(empty('No collection points yet.', 'Bulk orders are collected from the pickup address until you add one.')); return; }
      ui.points.replaceChildren(el('ul', { class: 'list business-points', 'data-testid': 'business-points' }, points.map(p => el('li', { class: 'list__item', 'data-testid': 'business-point', 'data-point-id': p.id },
        el('div', { class: 'list__main' },
          el('div', { class: 'list__title' }, p.label, p.isDefault ? html(MDM.ui.badge('neutral', 'Default')) : null),
          el('div', { class: 'list__meta wrap-anywhere' }, [p.address, MDM.geo.zoneLabel(p.zone), p.landmark].filter(Boolean).join(' · ')),
          el('div', { class: 'list__meta' }, [p.contactName, p.contactPhone ? phone.format(p.contactPhone) : '', p.preferredTime ? 'preferred ' + p.preferredTime : 'any time'].filter(Boolean).join(' · '))),
        el('div', { class: 'list__aside point-actions' },
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'business-point-edit', on: { click: () => editPoint(account, p) } }, 'Edit'),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'business-point-remove', on: { click: () => removePoint(account, p) } }, 'Remove'))))));
    }
    async function editPoint(account, p) {
      p = p || {};
      const v = await MDM.ui.dialog({ title: p.id ? 'Edit ' + p.label : 'Add collection point', okLabel: p.id ? 'Save collection point' : 'Add collection point',
        fields: [
          { name: 'label', label: 'Name', type: 'text', required: true, value: p.label || '', placeholder: 'Godown' },
          { name: 'address', label: 'Address', type: 'text', required: true, value: p.address || '' },
          { name: 'zone', label: 'Zone', type: 'select', options: MDM.geo.zoneOptions(), value: p.zone || account.zone || 'male' },
          { name: 'landmark', label: 'Landmark', type: 'text', value: p.landmark || '' },
          { name: 'contactName', label: 'Contact person', type: 'text', value: p.contactName || account.contactName || '' },
          { name: 'contactPhone', label: 'Contact number', type: 'tel', value: p.contactPhone ? phone.format(p.contactPhone) : phone.format(account.phone) },
          { name: 'preferredTime', label: 'Preferred collection time', type: 'time', value: p.preferredTime || '', hint: 'Suggested on new bulk orders from this point' },
          { name: 'isDefault', label: 'Default collection point', type: 'checkbox', value: p.id ? !!p.isDefault : !(account.collectionPoints || []).length }] });
      if (!v) return;
      try {
        await MDM.store.saveCollectionPoint(account.id, { id: p.id, label: v.label, address: v.address, zone: v.zone, landmark: v.landmark, contactName: v.contactName, contactPhone: v.contactPhone ? phone.normalize(v.contactPhone) : '', preferredTime: v.preferredTime, isDefault: v.isDefault });
        await MDM.store.audit('business_updated', (p.id ? 'Updated' : 'Added') + ' collection point ' + v.label + ' for ' + account.name, actor());
        toast(p.id ? 'Collection point saved' : v.label + ' added');
      } catch (e) { toast(storeMessage(e), 'danger'); }
    }
    async function removePoint(account, p) {
      const ok = await MDM.ui.confirm({ title: 'Remove ' + p.label, message: 'Bulk orders already placed keep their collection address. New bulk orders cannot pick ' + p.label + ' any more.', okLabel: 'Remove', danger: true });
      if (!ok) return;
      try {
        await MDM.store.removeCollectionPoint(account.id, p.id);
        await MDM.store.audit('business_updated', 'Removed collection point ' + p.label + ' for ' + account.name, actor());
        toast(p.label + ' removed');
      } catch (e) { toast(storeMessage(e), 'danger'); }
    }
    function renderCod(account, orders) {
      const s = codSummary(orders, account.id);
      ui.codAction.replaceChildren(canView('cash') ? el('a', { class: 'btn btn--secondary btn--sm', href: '#/cash?account=' + encodeURIComponent(account.id), 'data-testid': 'business-cash-link' }, 'Open Cash & COD') : null);
      const line = (key, label, sub) => rateRow(label, el('span', { 'data-testid': 'business-cod-' + key }, money(s[key].amount)), { mono: true, sub: plural(s[key].n, 'order') + (sub ? ' · ' + sub : '') });
      const any = Object.keys(s).some(k => s[k].n);
      ui.cod.replaceChildren(el('div', { class: 'card__body' }, any ? el('div', { class: 'rate-table', 'data-testid': 'business-cod' },
        line('pending', 'To collect', 'with the customer'), line('collected', 'With the driver', 'collected, not handed in'), line('with_office', 'With the office', 'to pay the business'),
        line('remitted', 'Paid to the business'), line('not_collected', 'Not collected', 'cancelled or refused'))
        : empty('No cash on delivery yet.', 'Cash amounts entered on bulk orders appear here.')));
    }
    function recipients(o) {
      const names = (o.packages || []).map(p => p.dropoff && p.dropoff.recipient ? p.dropoff.recipient.name : '').filter(Boolean);
      return names.length ? names.join(', ') : (o.packages || []).map(p => p.description).filter(Boolean).join(', ');
    }
    function invoiceUrl(inv) { return MDM.href('admin/invoice.html?id=' + encodeURIComponent(inv.id)); }
    function invoiceActions(inv, account) {
      const url = invoiceUrl(inv);
      const text = 'Mr. Delivery Man: invoice ' + inv.number + ' for ' + monthLabel(inv.month) + ', ' + money(inv.total) + ', due ' + fmtDate(inv.dueAt, { dateOnly: true }) + '. ' + url;
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
        toast('Invoice ' + inv.number + ' created, ' + money(inv.total) + ' due ' + fmtDate(inv.dueAt, { dateOnly: true }));
      } catch (e) { toast(storeMessage(e), 'danger'); }
    }
    async function markPaid(inv) {
      const v = await MDM.ui.dialog({ title: 'Mark ' + inv.number + ' as paid', message: money(inv.total) + ' received by bank transfer.', okLabel: 'Mark paid',
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
    let ctx = null, root = null, form = null, dirty = false, tierList = null, tierRows = [], accounts = [];
    async function mount(host) {
      ctx = context(); root = host; dirty = false;
      root.replaceChildren(pageHead('Rates', 'The figures the website quotes and the checkout uses. Saved values apply to new requests; existing orders keep their prices.'), el('div', { class: 'skeleton', style: 'height: 96px' }));
      ctx.sub('settings', () => { if (!dirty) ctx.schedule(render); });
      ctx.sub('business_accounts', () => { if (!dirty) ctx.schedule(render); });
      ctx.sub('*', m => { if (m && m.op === 'reset') { dirty = false; ctx.schedule(render); } });
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; form = null; tierList = null; tierRows = []; }
    const grid = (s) => {
      const sizes = s.rates.sizes;
      const cell = (size, side) => numInput('sizes.' + size + '.' + side, sizes[size][side], { 'aria-label': MDM.pricing.sizeLabel(size) + ', ' + (side === 'same' ? 'within one island' : 'crossing the bridge'), 'data-testid': 'rates-size-' + size + '-' + side });
      return el('div', { class: 'rates-grid', role: 'group', 'aria-label': 'Package rates in MVR' },
        el('div', { class: 'rates-grid__head' }, 'Size'), el('div', { class: 'rates-grid__head' }, 'Within one island'), el('div', { class: 'rates-grid__head' }, 'Crossing the bridge'),
        ['bag', 'box', 'xl'].map(size => [el('div', { class: 'rates-grid__label' }, MDM.pricing.sizeLabel(size)), cell(size, 'same'), cell(size, 'cross')]));
    };
    // §4: the website shows each size as a range (MVR 35–45, MVR 45–60, MVR 60++), worked out from the two figures above as you type.
    function rangesPreview() {
      const box = el('div', { class: 'rate-table rates-ranges', 'data-testid': 'rates-ranges' });
      function update() {
        if (!form) return;
        const sizes = {};
        ['bag', 'box', 'xl'].forEach(size => { sizes[size] = { same: Number(form.elements['sizes.' + size + '.same'].value) || 0, cross: Number(form.elements['sizes.' + size + '.cross'].value) || 0 }; });
        const st = { rates: { sizes } };
        fill(box, el('div', { class: 'rate-table__row rate-table__row--head' }, el('div', null, 'Shown on the website'), el('div', null)),
          ['bag', 'box', 'xl'].map(size => el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, size === 'xl' ? 'XL-size package' : MDM.pricing.sizeLabel(size)),
            el('div', { class: 'rate-table__value mono', 'data-testid': 'rates-range-' + size }, MDM.pricing.rangeLabel(size, st)))));
      }
      return { el: box, update };
    }
    // Business size categories (§1.3, §5.2): label, hint, matching size and default rate. Edited in place; saved with the rest of the form.
    function tierBlock(t, i) {
      const id = 'tier-' + (++fieldSeq);
      const sizeSel = select('tierSize', t.size || 'bag', [{ value: 'bag', label: 'Bag' }, { value: 'box', label: 'Box' }, { value: 'xl', label: 'XL' }], { id: id + '-size', 'data-testid': 'tier-size' });
      const row = { value: t.value || null, label: input('tierLabel', t.label, { id: id + '-label', 'data-testid': 'tier-label', placeholder: 'Medium' }), size: sizeSel,
        rate: numInput('tierRate', t.rate, { id: id + '-rate', 'data-testid': 'tier-default-rate', min: '1' }), hint: input('tierHint', t.hint, { id: id + '-hint', 'data-testid': 'tier-hint', placeholder: 'A box up to about 2 ft' }) };
      const users = row.value ? accounts.filter(a => a.rates && a.rates[row.value] != null) : [];
      row.el = el('div', { class: 'tier-block', 'data-testid': 'rates-tier', 'data-tier': row.value || 'new' },
        el('div', { class: 'tier-block__head' }, el('span', { class: 'tier-block__title' }, 'Size category ' + (i + 1)),
          users.length ? el('span', { class: 'muted small' }, 'Agreed with ' + users.map(a => a.name).join(', ')) : null,
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'tier-remove', 'aria-label': 'Remove size category ' + (i + 1), on: { click: () => removeTier(row) } }, 'Remove')),
        el('div', { class: 'grid-2' }, field('Name', row.label), field('Matching size', row.size)),
        el('div', { class: 'grid-2' }, field('Default rate, MVR', row.rate, { hint: 'Offered when a business is approved' }), field('Description', row.hint, { optional: true })));
      row.users = users;
      return row;
    }
    function drawTiers() { tierList.replaceChildren(...tierRows.map(r => r.el)); }
    function renumber() { tierRows = tierRows.map((r, i) => { const keep = { value: r.value, label: r.label.value, size: r.size.value, rate: r.rate.value, hint: r.hint.value }; return tierBlock(keep, i); }); drawTiers(); }
    async function removeTier(row) {
      if (row.users.length) { toast('Agreed with ' + row.users.map(a => a.name).join(', ') + '. Change their rates on the business account first.', 'warn'); return; }
      if (tierRows.length <= 1) { toast('Keep at least one size category', 'warn'); return; }
      tierRows = tierRows.filter(r => r !== row); dirty = true; renumber();
    }
    function addTier() { tierRows.push(tierBlock({ label: '', size: 'box', rate: '', hint: '' }, tierRows.length)); dirty = true; drawTiers(); tierRows[tierRows.length - 1].label.focus(); }
    function readTiers() {
      let bad = null; const used = new Set();
      const out = tierRows.map(r => {
        const lbl = r.label.value.trim(), rate = String(r.rate.value || '').trim();
        MDM.ui.setError(r.label.closest('.field'), null); MDM.ui.setError(r.rate.closest('.field'), null);
        if (!lbl) { MDM.ui.setError(r.label.closest('.field'), 'Enter a name'); bad = bad || r.label; }
        else if (used.has(lbl.toLowerCase())) { MDM.ui.setError(r.label.closest('.field'), 'Two categories have this name'); bad = bad || r.label; }
        used.add(lbl.toLowerCase());
        if (!/^\d+$/.test(rate) || Number(rate) < 1) { MDM.ui.setError(r.rate.closest('.field'), 'Enter a whole number above 0'); bad = bad || r.rate; }
        return { value: r.value, label: lbl, hint: r.hint.value.trim(), size: r.size.value, rate: Number(rate) };
      });
      if (bad) return { bad };
      const keys = new Set(out.filter(t => t.value).map(t => t.value));
      out.forEach(t => {
        if (t.value) return;
        const base = (t.label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'size').slice(0, 16);
        let key = base, n = 2; while (keys.has(key)) key = base + '_' + (n++);
        keys.add(key); t.value = key;
      });
      return { tiers: out };
    }
    async function render() {
      const [s, accs] = await Promise.all([MDM.store.settings(), MDM.store.list('business_accounts')]);
      if (!ctx || !ctx.alive) return;
      accounts = accs;
      const ranges = rangesPreview();
      tierRows = MDM.pricing.businessTiers(s).map(tierBlock);
      tierList = el('div', { class: 'tier-list', 'data-testid': 'rates-tiers' });
      const ops = s.ops || {}, hours = ops.hours || {}, banks = (s.banks || []).slice(0, 2);
      while (banks.length < 2) banks.push({ id: banks.length ? 'bank2' : 'bank1', name: '', accountName: '', accountNo: '' });
      // Same section rhythm as #/settings (SPEC §2.5): <section aria-labelledby> → .section-head (H2 + caption as its desc) → full-width card,
      // with the fields inside capped at the 640px form width by .form-card__body.
      const formSection = (id, title, caption, children) => el('section', { 'aria-labelledby': id }, sectionHead(id, title, caption),
        card(null, el('div', { class: 'card__body' }, el('div', { class: 'form-card__body' }, children))));
      form = el('form', { class: 'form form--wide', novalidate: true, 'data-testid': 'rates-form', on: { submit: save, input: e => { dirty = true; if (e.target && /^sizes\./.test(e.target.name || '')) ranges.update(); } } },
        formSection('rates-sizes', 'Package rates', 'Assumed rule, confirm with client. MVR per package. The lower figure applies within one island, the higher one when pickup and drop-off are on different islands. The website shows the two as a range.',
          [grid(s), ranges.el, checkbox('xlQuoted', s.rates.sizes.xl.quoted, 'XL is quoted before pickup', 'The website prints "' + MDM.pricing.rangeLabel('xl', s) + '" for XL and the request waits for your quote')]),
        formSection('rates-fees', 'Fees', null, [
          el('div', { class: 'rates-cargo' }, field('Maldivian Cargo fee (only for Maldivian Cargo deliveries)', numInput('cargo', s.rates.cargo), { hint: 'MVR, once per order. Its own line on the order, charged only when the delivery method is Maldivian Cargo (counter at the main bus terminal)' })),
          el('div', { class: 'grid-2' }, field('Airport fee, MVR', numInput('airport', s.rates.airport), { hint: 'For airport deliveries, per order or per package as set under Rules' }), field('Shopping fee, % of the receipt', numInput('shoppingPct', s.rates.shoppingPct, { max: '100' }))),
          el('div', { class: 'grid-2' }, field('Extra vehicle charge, MVR', numInput('vehicle', s.rates.vehicle == null ? '' : s.rates.vehicle, { placeholder: 'Ask each time' }), { optional: true, hint: 'Suggested when an operator adds a vehicle to an order. Leave empty to enter it each time.' }), field('Business rate without size categories, MVR', numInput('business', s.rates.business), { hint: 'Only for older business accounts with no agreed sizes' }))]),
        formSection('rates-tiers', 'Business size categories', 'The package sizes businesses are approved on. Each business agrees its own fixed rate per category; the default rate is the starting offer.', [
          tierList,
          el('div', null, el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'rates-tier-add', on: { click: addTier } }, icon('plus'), 'Add size category'))]),
        formSection('rates-rules', 'Rules', 'Assumed, confirm with client', [
          checkbox('airportReplacesCross', s.rules.airportReplacesCross, 'Airport replaces the cross-island figure', 'A package touching the airport is priced at its same-island figure and the airport fee is added once'),
          el('div', { class: 'grid-2' },
            field('Airport fee charged per', select('airportFeePer', s.rules.airportFeePer, [{ value: 'order', label: 'Order' }, { value: 'package', label: 'Package' }])))]),
        formSection('rates-size-guide', 'Size guide', 'Wording to confirm with client', [
          field('Bag', textarea('guide.bag', s.sizeGuide.bag, { rows: 2 })), field('Box', textarea('guide.box', s.sizeGuide.box, { rows: 2 })), field('XL', textarea('guide.xl', s.sizeGuide.xl, { rows: 2 }))]),
        formSection('rates-ops', 'Operations', 'Operations · demo defaults, not from the client brief', [
          el('div', { class: 'grid-2' }, field('Opens at', input('hours.open', hours.open, { placeholder: '09:00', inputmode: 'numeric' })), field('Closes at', input('hours.close', hours.close, { placeholder: '23:00', inputmode: 'numeric' }))),
          field('Days', input('days', ops.days)),
          field('ASAP wording', input('asapText', ops.asapText), { hint: 'Shown under "ASAP" on the request page' }),
          el('div', { class: 'grid-2' }, field('Payment review time', input('reviewText', ops.reviewText), { hint: 'Shown as "usually within …"' }), field('Business reply time', input('businessReplyText', ops.businessReplyText))),
          el('div', { class: 'grid-3' }, field('First slot', input('slotStart', ops.slotStart, { placeholder: '09:00' })), field('Last slot', input('slotEnd', ops.slotEnd, { placeholder: '23:00' })), field('Slot length, minutes', numInput('slotMinutes', ops.slotMinutes))),
          el('div', { class: 'grid-3' }, field('City speed, km/h', numInput('speedCityKmh', ops.speedCityKmh)), field('Bridge speed, km/h', numInput('speedHighwayKmh', ops.speedHighwayKmh)), field('Peak buffer, minutes', numInput('peakBufferMin', ops.peakBufferMin))),
          field('Peak windows', input('peakWindows', (ops.peakWindows || []).join(', ')), { hint: 'Comma separated, 24 h clock: 08:00-09:30, 17:00-19:30' }),
          field('Closed windows', input('closedWindows', (ops.closedWindows || []).join(', ')), { hint: 'Comma separated, optional day prefix: Fri 12:00-13:30' })]),
        formSection('rates-banks', 'Bank accounts', 'Printed at checkout and on invoices. Transfer reference is always the order or invoice number.', banks.map((b, i) => el('div', { class: 'grid-3' },
          field('Bank ' + (i + 1), input('banks.' + i + '.name', b.name)), field('Account name', input('banks.' + i + '.accountName', b.accountName)), field('Account number', input('banks.' + i + '.accountNo', b.accountNo, { class: 'input mono', inputmode: 'numeric' }))))),
        formSection('rates-terms', 'Terms and invoicing', null, [
          field('What we carry', textarea('terms', s.terms), { hint: 'Shown at checkout with the "I\'ve read what we carry" checkbox' }),
          el('div', { class: 'grid-2' }, field('Invoices due in, days', numInput('invoiceDueDays', s.invoiceDueDays)), field('GST, %', numInput('gstPercent', s.gstPercent, { max: '100' }), { hint: '0 hides the GST line on invoices' }))]),
        el('div', { class: 'form-actions' }, el('span', { class: 'form-caption' }, 'Changes apply to new requests and quotes.'), el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'rates-save' }, 'Save rates')));
      const old = root.querySelector('form, .skeleton'); if (old) old.replaceWith(form); else root.appendChild(form);
      drawTiers(); ranges.update();
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
      rules.vehicle = v => v === '' ? null : intRule(v);
      const r = MDM.ui.validate(form, rules);
      const t = readTiers();
      if (!r.ok || t.bad) { if (r.ok && t.bad) t.bad.focus(); else MDM.ui.focusFirstInvalid(form); toast('Check the highlighted fields', 'warn'); return; }
      const v = r.values, n = k => Number(v[k]), list = k => v[k] ? v[k].split(',').map(x => x.trim()).filter(Boolean) : [];
      const cur = await MDM.store.settings();
      const patch = {
        rates: { sizes: { bag: { same: n('sizes.bag.same'), cross: n('sizes.bag.cross') }, box: { same: n('sizes.box.same'), cross: n('sizes.box.cross') }, xl: { same: n('sizes.xl.same'), cross: n('sizes.xl.cross'), quoted: val(form, 'xlQuoted') } },
          cargo: n('cargo'), airport: n('airport'), shoppingPct: n('shoppingPct'), business: n('business'), vehicle: v.vehicle === '' ? null : n('vehicle'), businessTiers: t.tiers },
        // §3.3: one MVR 20 Maldivian Cargo fee per order that uses Maldivian Cargo (no per-package option).
        rules: { airportReplacesCross: val(form, 'airportReplacesCross'), cargoFeePer: 'order', airportFeePer: v.airportFeePer },
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
      root.replaceChildren(pageHead('Settings', 'Contact details, payments and naalu, notifications, staff hours and off days, the e-store, the public notice, the demo switches and your data.'), el('div', { class: 'skeleton', style: 'height: 96px' }));
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
      const rules = s.rules || {}, notif = s.notifications || {}, chans = notif.channels || {}, hr = s.hr || {}, st = s.store || {};
      const saveBtn = (testid, text) => el('div', { class: 'form-actions' }, el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': testid }, text));
      const payForm = el('form', { class: 'form', novalidate: true, 'data-testid': 'settings-payment-form', on: { submit: savePayment, input: () => { dirty = true; } } },
        field('When customers pay', select('paymentTiming', rules.paymentTiming || 'after_delivery', [{ value: 'after_delivery', label: 'After delivery, the invoice goes out automatically' }, { value: 'upfront', label: 'Upfront, once the price is confirmed' }]), { hint: 'Shopping orders are always paid before we buy. Business accounts are invoiced monthly.' }),
        checkbox('upfrontOptional', rules.upfrontOptional !== false, 'Customers may pay upfront', 'Shows "Pay now" on the tracking page as soon as the price is confirmed'),
        field('Express handling fee, MVR', numInput('expressFee', (s.rates || {}).express || 0), { hint: 'Suggested when you confirm the price of an express order' }),
        checkbox('naaluBillable', !!rules.naaluBillable, 'Charge naalu to the customer by default', 'Naalu a driver pays at a jetty is added to the customer\'s price. When off, it is recorded for the driver\'s reimbursement only and the office can still bill it on an order.'),
        saveBtn('settings-save-payment', 'Save payment settings'));
      const notifyForm = el('form', { class: 'form', novalidate: true, 'data-testid': 'settings-notify-form', on: { submit: saveNotify, input: () => { dirty = true; } } },
        checkbox('notifEnabled', notif.enabled !== false, 'Send customer notifications', 'Submitted, confirmed, price confirmed, driver assigned, collected, out for delivery, delivered or failed, payments, priority and cancellations'),
        field('Send by', select('notifChannel', notif.channel || 'customer', [{ value: 'customer', label: 'What each customer chose' }, { value: 'sms', label: 'SMS for everyone' }, { value: 'whatsapp', label: 'WhatsApp for everyone' }, { value: 'viber', label: 'Viber for everyone' }, { value: 'email', label: 'Email for everyone' }])),
        el('div', { class: 'stack-2' }, el('span', { class: 'field__label' }, 'Channels connected'), [['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['viber', 'Viber'], ['email', 'Email']].map(c => checkbox('ch_' + c[0], chans[c[0]] !== false, c[1]))),
        field('Sender name', input('senderName', notif.senderName || 'MrDelivery'), { hint: 'Shown as the SMS sender. The mockup logs messages under Notifications; sending needs an SMS or WhatsApp provider.' }),
        saveBtn('settings-save-notify', 'Save notification settings'));
      const hrForm = el('form', { class: 'form', novalidate: true, 'data-testid': 'settings-hr-form', on: { submit: saveHr, input: () => { dirty = true; } } },
        el('div', { class: 'grid-2' }, field('Shift starts', input('shiftStart', hr.shiftStart || '08:00', { inputmode: 'numeric', placeholder: '08:00' })), field('Shift ends', input('shiftEnd', hr.shiftEnd || '17:00', { inputmode: 'numeric', placeholder: '17:00' }))),
        el('div', { class: 'grid-3' }, field('Late after, minutes', numInput('graceMinutes', hr.graceMinutes != null ? hr.graceMinutes : 10)), field('Annual leave, days', numInput('annualLeaveDays', hr.annualLeaveDays || 30)), field('Sick leave, days', numInput('sickLeaveDays', hr.sickLeaveDays || 30))),
        field('Weekly off day', select('weeklyOffDay', String(hr.weeklyOffDay != null ? hr.weeklyOffDay : 5), WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))), { hint: 'Working on this day earns the employee one accumulated off day' }),
        saveBtn('settings-save-hr', 'Save staff settings'));
      const storeForm = el('form', { class: 'form', novalidate: true, 'data-testid': 'settings-store-form', on: { submit: saveStore, input: () => { dirty = true; } } },
        checkbox('storeOpen', st.open !== false, 'The e-store is open', 'When closed, the store page shows the catalogue without the checkout'),
        el('div', { class: 'grid-2' }, field('Store address', input('storeAddress', st.address || ''), { hint: 'Where drivers collect store orders' }), field('Zone', select('storeZone', st.zone || 'male', MDM.geo.zoneOptions()))),
        field('Note on the store page', input('storeNote', st.note || '')),
        saveBtn('settings-save-store', 'Save store settings'));
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
        el('section', { 'aria-labelledby': 'set-payment' }, sectionHead('set-payment', 'Payments and naalu'), card(null, el('div', { class: 'card__body' }, payForm))),
        el('section', { 'aria-labelledby': 'set-notify' }, sectionHead('set-notify', 'Notifications'), card(null, el('div', { class: 'card__body' }, notifyForm))),
        el('section', { 'aria-labelledby': 'set-hr' }, sectionHead('set-hr', 'Staff hours, leave and off days'), card(null, el('div', { class: 'card__body' }, hrForm))),
        el('section', { 'aria-labelledby': 'set-store' }, sectionHead('set-store', 'E-store'), card(null, el('div', { class: 'card__body' }, storeForm))),
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
    async function saveSection(patch, msg) {
      try { await MDM.store.saveSettings(patch); dirty = false; toast(msg); }
      catch (err) { toast(storeMessage(err), 'danger'); }
    }
    async function savePayment(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const r = MDM.ui.validate(form, { expressFee: v => /^\d+$/.test(v) ? null : 'Enter a whole number, 0 or more' });
      if (!r.ok) { MDM.ui.focusFirstInvalid(form); return; }
      await saveSection({ rules: { paymentTiming: val(form, 'paymentTiming'), upfrontOptional: val(form, 'upfrontOptional'), naaluBillable: val(form, 'naaluBillable') }, rates: { express: Number(r.values.expressFee) } }, 'Payment settings saved');
    }
    async function saveNotify(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const channels = {}; ['sms', 'whatsapp', 'viber', 'email'].forEach(k => { channels[k] = val(form, 'ch_' + k); });
      await saveSection({ notifications: { enabled: val(form, 'notifEnabled'), channel: val(form, 'notifChannel'), channels, senderName: val(form, 'senderName') || 'MrDelivery' } }, 'Notification settings saved');
    }
    async function saveHr(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const time = v => MDM.ui.parseHHMM(v) == null ? 'Use the 24 h clock, like 08:00' : null, int = v => /^\d+$/.test(v) ? null : 'Enter a whole number';
      const r = MDM.ui.validate(form, { shiftStart: time, shiftEnd: time, graceMinutes: int, annualLeaveDays: int, sickLeaveDays: int });
      if (!r.ok) { MDM.ui.focusFirstInvalid(form); return; }
      await saveSection({ hr: { shiftStart: r.values.shiftStart, shiftEnd: r.values.shiftEnd, graceMinutes: Number(r.values.graceMinutes), annualLeaveDays: Number(r.values.annualLeaveDays), sickLeaveDays: Number(r.values.sickLeaveDays), weeklyOffDay: Number(val(form, 'weeklyOffDay')) } }, 'Staff settings saved');
    }
    async function saveStore(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const r = MDM.ui.validate(form, { storeAddress: v => v ? null : 'Enter the store address' });
      if (!r.ok) { MDM.ui.focusFirstInvalid(form); return; }
      await saveSection({ store: { open: val(form, 'storeOpen'), address: r.values.storeAddress, zone: val(form, 'storeZone'), note: val(form, 'storeNote') } }, 'Store settings saved');
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

// Admin operations views: #/bulk (+ #/bulk/:batchId) bulk business orders (client requirements §10), #/zones service zones and
// airport areas (§16, How it works §3), #/team attendance, leave and employees (§22, How it works §10–§11), #/reports (§20),
// #/notifications (§17), #/activity audit log (§21) and #/store e-store products and orders (How it works §7).
// Same contract as views.js: each registers { title, mount(el, params), unmount(), update?(params) }, reads and writes through
// MDM.store only, and re-renders from one render() on store changes.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const F = MDM.admin.fmt;
  const money = n => MDM.pricing.format(n);
  const fmtDate = (iso, o) => MDM.ui.fmtDate(iso, o);
  const phone = MDM.ui.phone;
  const toast = (msg, kind) => MDM.ui.toast(msg, kind || 'ok');
  const icon = (name, size) => html(MDM.icon(name, size || 16));
  const by = () => MDM.admin.by();
  const plural = F.plural;
  const dayKey = d => MDM.ui.dayKey(d);
  const trim = v => String(v == null ? '' : v).trim();
  const label = (list, v) => ((list || []).find(x => x.value === v) || {}).label || v || '';
  const errMsg = e => e && e.message ? e.message : 'Something went wrong';

  // ---- Shared helpers (the same shapes views.js uses) ----------------------------------------------------------------------
  function context() {
    const c = { alive: true, subs: [], timers: [], pending: null };
    c.sub = (col, fn) => { c.subs.push(MDM.store.subscribe(col, fn)); };
    c.dispose = () => { c.alive = false; c.subs.forEach(u => { try { u(); } catch (e) { /* released */ } }); c.timers.forEach(clearInterval); c.subs = []; c.timers = []; };
    c.schedule = fn => { if (c.pending) return; c.pending = setTimeout(() => { c.pending = null; if (c.alive) fn().catch(e => setTimeout(() => { throw e; }, 0)); }, 0); };
    return c;
  }
  function pageHead(title, desc, actions) {
    return el('div', { class: 'page-head' }, el('h1', { tabindex: '-1' }, title), desc ? el('p', { class: 'page-head__desc' }, desc) : null,
      actions && actions.filter(Boolean).length ? el('div', { class: 'page-head__actions' }, actions.filter(Boolean)) : null);
  }
  function sectionHead(id, title, desc, action) {
    return el('div', { class: 'section-head' }, el('h2', { id }, title), desc ? el('p', { class: 'section-head__desc' }, desc) : null, action ? el('div', { class: 'section-head__action' }, action) : null);
  }
  function card(header, body, attrs) { return el('div', Object.assign({ class: 'card' }, attrs || {}), header ? el('div', { class: 'card__header' }, header) : null, body); }
  function empty(title, hint, action) { return el('div', { class: 'empty' }, el('p', { class: 'empty__title' }, title), hint ? el('p', { class: 'empty__hint' }, hint) : null, action || null); }
  function badge(kind, text, attrs) { return html(MDM.ui.badge(kind, text, attrs)); }
  // table(cols, rows, { testid }): cols [{ label, num, primary, actions, nowrap, render(row) }]; rows [{ data, attrs }].
  function table(cols, rows, opts) {
    opts = opts || {};
    const head = el('tr', null, cols.map(c => el('th', { scope: 'col', class: [c.num ? 'num' : null, c.actions ? 'table__actions' : null].filter(Boolean).join(' ') || null }, c.label)));
    const body = el('tbody', null, rows.map(r => el('tr', r.attrs || null, cols.map(c => {
      const cls = [c.num ? 'num mono' : null, c.primary ? 'table__primary' : null, c.actions ? 'table__actions' : null, c.nowrap ? 'nowrap' : null].filter(Boolean).join(' ');
      return el('td', { class: cls || null, 'data-label': c.primary || c.actions ? null : c.label }, c.render(r.data));
    }))));
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack' + (opts.compact ? ' table--compact' : ''), 'data-testid': opts.testid }, el('thead', null, head), body));
  }
  function actionsRow() { return el('div', { class: 'table__actions-row' }, Array.prototype.slice.call(arguments).filter(Boolean)); }
  function smallBtn(text, testid, fn, cls) { return el('button', { type: 'button', class: 'btn btn--sm ' + (cls || 'btn--ghost'), 'data-testid': testid, on: { click: () => run(fn) } }, text); }
  async function run(fn) { try { await fn(); } catch (e) { toast(errMsg(e), 'danger'); } }
  function kpi(text, value, note, testid) {
    return el('div', { class: 'kpi', 'data-testid': 'kpi-' + testid }, el('div', { class: 'kpi__label' }, text), el('div', { class: 'kpi__value mono', 'data-testid': 'kpi-' + testid + '-value' }, String(value)), note ? el('div', { class: 'kpi__note' }, note) : null);
  }
  function tabs(list, current, onPick, testid) {
    return el('div', { class: 'tabs', role: 'tablist', 'data-testid': testid }, list.map(t => el('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': t.value === current ? 'true' : 'false', 'data-testid': testid + '-' + t.value,
      on: { click: () => onPick(t.value) } }, t.label, t.count != null ? el('span', { class: 'tab__count' }, t.count ? String(t.count) : '') : null)));
  }
  function progress(done, total, extra) {
    const pct = total ? Math.round(done / total * 100) : 0;
    return el('div', { class: 'progress', role: 'img', 'aria-label': done + ' of ' + total + ' delivered' }, el('div', { class: 'progress__bar' }, el('span', { style: { width: pct + '%' } })), el('div', { class: 'progress__text' }, done + ' of ' + total + ' delivered' + (extra ? ' · ' + extra : '')));
  }
  function dateInput(name, value, aria) { return el('input', { class: 'input', type: 'date', name, value: value || '', 'aria-label': aria, 'data-testid': name }); }
  const inRange = (iso, from, to) => { const d = iso ? dayKey(iso) : ''; return !!d && (!from || d >= from) && (!to || d <= to); };
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const queryOf = p => p && p.query instanceof URLSearchParams ? p.query : new URLSearchParams();
  const hours = (a, b) => { const ms = new Date(b || Date.now()) - new Date(a); return Math.max(0, ms / 3600000); };
  const hhmm = h => Math.floor(h) + 'h ' + String(Math.round((h % 1) * 60)).padStart(2, '0') + 'm';
  const BATCH_STATUS = { confirmed: ['warn', 'Awaiting collection'], collected: ['info', 'Collected, sorting'], out_for_delivery: ['info', 'Out for delivery'], delivered: ['ok', 'Delivered'], paid: ['ok', 'Delivered and paid'] };

  // ==== #/bulk and #/bulk/:batchId ==============================================================================================
  MDM.admin.views.bulk = (function () {
    let ctx = null, root = null, id = null, account = '';
    async function mount(host, params) {
      ctx = context(); root = host; id = params && params.id || null; account = queryOf(params).get('account') || '';
      ['batches', 'orders', 'drivers', 'zones', 'business_accounts'].forEach(c => ctx.sub(c, () => ctx.schedule(render)));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      await render();
    }
    async function update(params) { id = params && params.id || null; account = queryOf(params).get('account') || ''; await render(); }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; }
    function render() { return id ? renderDetail() : renderList(); }
    async function renderList() {
      const [batches, accounts] = await Promise.all([MDM.store.list('batches'), MDM.store.list('business_accounts')]);
      if (!ctx || !ctx.alive) return;
      const list = batches.filter(b => !account || b.accountId === account);
      const acc = accounts.find(a => a.id === account);
      const stats = {}; list.forEach(b => { stats[b.id] = MDM.store._batchStatus(b); });
      const cols = [
        { label: 'Bulk order', primary: true, render: b => el('a', { href: '#/bulk/' + encodeURIComponent(b.id), class: 'mono', 'data-testid': 'bulk-row-link' }, b.code) },
        { label: 'Business', render: b => el('span', null, b.name, el('span', { class: 'table__sub' }, F.SOURCE[b.source] || b.source || '')) },
        { label: 'Progress', render: b => progress(stats[b.id].delivered, stats[b.id].total, stats[b.id].failed ? stats[b.id].failed + ' failed' : '') },
        { label: 'Status', primary: true, render: b => { const s = BATCH_STATUS[stats[b.id].status] || ['neutral', stats[b.id].status]; return badge(s[0], s[1], { 'data-status': stats[b.id].status }); } },
        { label: 'Amount', num: true, render: b => money(stats[b.id].amount) },
        { label: 'Created', nowrap: true, render: b => F.whenCell(b.createdAt) },
      ];
      root.replaceChildren(
        pageHead(acc ? 'Bulk orders · ' + acc.name : 'Bulk orders', 'Business packages collected in one go, sorted by zone and delivered by the zone\'s driver. Every package is its own trackable order.',
          [acc ? el('a', { class: 'btn btn--ghost', href: '#/bulk' }, 'All businesses') : null, el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'bulk-new', on: { click: () => run(() => newBatch(accounts, account)) } }, icon('plus'), 'New bulk order')]),
        card(null, list.length ? table(cols, list.map(b => ({ data: b, attrs: { class: 'is-clickable', 'data-testid': 'bulk-row', 'data-batch-id': b.id, on: { click: e => { if (e.target.closest('a, button')) return; location.hash = '#/bulk/' + encodeURIComponent(b.id); } } } })), { testid: 'bulk-table' })
          : empty('No bulk orders yet.', 'Create one for a business account, or the business uploads it from their portal.')));
    }
    async function renderDetail() {
      const [b, orders, drivers, zones] = await Promise.all([MDM.store.get('batches', id), MDM.store.list('orders', { order: 'code' }), MDM.store.list('drivers'), MDM.store.list('zones', { order: 'createdAt' })]);
      if (!ctx || !ctx.alive) return;
      if (!b) { root.replaceChildren(pageHead('Bulk order not found'), card(null, empty('This bulk order does not exist in this browser.', null, el('a', { class: 'btn btn--secondary btn--sm', href: '#/bulk' }, 'All bulk orders')))); return; }
      const kids = orders.filter(o => o.batchId === b.id).sort((x, y) => (x.batchIndex || 0) - (y.batchIndex || 0));
      const st = MDM.store._batchStatus(b);
      const toDispatch = kids.filter(o => o.status === 'collected' && o.driverId);
      const unassigned = kids.filter(o => ['confirmed', 'collected'].indexOf(o.status) >= 0 && !o.driverId);
      const c = b.collection || {};
      const actions = [
        el('a', { class: 'btn btn--ghost', href: '#/bulk' }, 'All bulk orders'),
        el('a', { class: 'btn btn--secondary', href: MDM.href('labels/?batch=' + encodeURIComponent(b.id)), target: '_blank', rel: 'noopener', 'data-testid': 'bulk-labels' }, icon('printer'), 'Print labels'),
        b.status === 'confirmed' ? el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'bulk-collected', on: { click: () => run(async () => { await MDM.store.batchCollected(b.id, { by: by() }); toast(b.code + ' collected, packages at the hub'); }) } }, 'Mark collected') : null,
        unassigned.length ? el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'bulk-assign-zone', on: { click: () => run(async () => { const r = await MDM.store.assignByZone(b.id, { by: by() }); toast(plural(r.assigned, 'package') + ' assigned by zone' + (r.unmatched ? ', ' + r.unmatched + ' with no zone driver' : ''), r.unmatched ? 'warn' : 'ok'); }) } }, 'Assign by zone') : null,
        toDispatch.length ? el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'bulk-dispatch', on: { click: () => run(async () => { for (const o of toDispatch) await MDM.store.dispatch(o.id, { by: by() }); toast(plural(toDispatch.length, 'package') + ' out for delivery'); }) } }, 'Dispatch ' + plural(toDispatch.length, 'package')) : null,
      ];
      const s = BATCH_STATUS[st.status] || ['neutral', st.status];
      const summary = el('div', { class: 'rate-table' },
        rowNode('Status', badge(s[0], s[1], { 'data-testid': 'bulk-status', 'data-status': st.status })),
        rowNode('Business', el('a', { href: '#/business/' + encodeURIComponent(b.accountId) }, b.name)),
        rowNode('Collect from', el('span', null, c.address || '', el('small', null, [MDM.geo.zoneLabel(c.zone), [c.contactName, c.contactPhone ? phone.format(c.contactPhone) : ''].filter(Boolean).join(' · '), c.instructions].filter(Boolean).join(' · ')))),
        rowNode('Service', F.LEVEL[b.serviceLevel] || 'Normal'),
        b.notes ? rowNode('Notes', b.notes) : null,
        rowNode('Received', (F.SOURCE[b.source] || b.source || '') + ' · ' + fmtDate(b.createdAt)),
        b.collectedAt ? rowNode('Collected', fmtDate(b.collectedAt)) : null);
      const byZone = {};
      kids.forEach(o => { const z = (o.delivery || {}).zone || 'other'; (byZone[z] = byZone[z] || []).push(o); });
      const zoneCards = Object.keys(byZone).map(zk => {
        const z = zones.find(x => x.key === zk);
        const zd = (z && z.driverIds || []).map(d => F.driverName(d, drivers)).filter(Boolean);
        const cols = [
          { label: '#', render: o => String(o.batchIndex || '') },
          { label: 'Order', primary: true, render: o => el('a', { href: '#/orders/' + encodeURIComponent(o.id), class: 'mono' }, o.code) },
          { label: 'Recipient', render: o => el('span', null, (o.delivery || {}).recipientName || '', el('span', { class: 'table__sub mono' }, phone.format((o.delivery || {}).recipientPhone))) },
          { label: 'Address', render: o => el('span', { class: 'table__address' }, (o.delivery || {}).address || '') },
          { label: 'Package', render: o => { const p = (o.packages || [])[0] || {}; return el('span', null, MDM.pricing.sizeLabel(p.size), el('span', { class: 'table__sub' }, p.description || '')); } },
          { label: 'Status', primary: true, render: o => html(MDM.badgeFor(o.status)) },
          { label: 'Driver', render: o => F.driverName(o.driverId, drivers) || el('span', { class: 'subtle' }, 'Unassigned') },
          { label: 'Actions', actions: true, render: o => actionsRow(
            o.status === 'collected' && o.driverId ? smallBtn('Dispatch', 'bulk-row-dispatch', async () => { await MDM.store.dispatch(o.id, { by: by() }); toast(o.code + ' out for delivery'); }, 'btn--secondary') : null,
            ['confirmed', 'collected'].indexOf(o.status) >= 0 ? smallBtn(o.driverId ? 'Change driver' : 'Assign', 'bulk-row-assign', () => assignOne(o, drivers, zones)) : null,
            el('a', { class: 'btn btn--ghost btn--sm', href: MDM.href('labels/?order=' + encodeURIComponent(o.id)), target: '_blank', rel: 'noopener' }, 'Label')) },
        ];
        return el('section', { class: 'bulk-zone', 'aria-labelledby': 'bz-' + zk, 'data-zone': zk },
          sectionHead('bz-' + zk, (z ? z.name : MDM.geo.zoneLabel(zk)) + ' · ' + plural(byZone[zk].length, 'package'), zd.length ? 'Zone drivers: ' + zd.join(', ') : 'No driver assigned to this zone yet'),
          card(null, table(cols, byZone[zk].map(o => ({ data: o, attrs: { 'data-testid': 'bulk-package', 'data-order-id': o.id, 'data-status': o.status } })), { testid: 'bulk-packages-' + zk })));
      });
      root.replaceChildren(
        pageHead(b.code + ' · ' + b.name, plural(st.total, 'package') + ' · ' + money(st.amount) + ' on the monthly invoice', actions),
        el('div', { class: 'kpi-row kpi-row--fluid' }, kpi('Packages', st.total, null, 'bulk-total'), kpi('Collected', kids.filter(o => o.status !== 'confirmed').length, 'at the hub or later', 'bulk-collected'),
          kpi('Out for delivery', st.out, null, 'bulk-out'), kpi('Delivered', st.delivered, null, 'bulk-delivered'), kpi('Failed', st.failed, null, 'bulk-failed')),
        el('div', { class: 'admin-grid admin-grid--wide' }, el('section', { 'aria-labelledby': 'bulk-sum' }, sectionHead('bulk-sum', 'Collection'), card(null, el('div', { class: 'card__body' }, summary))),
          el('section', { 'aria-labelledby': 'bulk-prog' }, sectionHead('bulk-prog', 'Progress'), card(null, el('div', { class: 'card__body stack-4' }, progress(st.delivered, st.total, st.out + ' out now'),
            el('p', { class: 'muted small' }, unassigned.length ? plural(unassigned.length, 'package') + ' still need a driver. "Assign by zone" gives each package to the first driver of its delivery zone.' : 'Every package has a driver.'))))),
        ...zoneCards);
    }
    function rowNode(k, v) { return el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, k), el('div', { class: 'rate-table__value' }, v)); }
    async function assignOne(o, drivers, zones) {
      const z = zones.find(x => x.key === (o.delivery || {}).zone);
      const inZone = d => z && (z.driverIds || []).indexOf(d.id) >= 0;
      const options = drivers.slice().sort((a, b) => inZone(b) - inZone(a) || a.name.localeCompare(b.name)).map(d => ({ value: d.id, label: d.name + (inZone(d) ? ' · ' + (z.short || z.name) : '') }));
      const v = await MDM.ui.dialog({ title: 'Driver for ' + o.code, okLabel: 'Assign', fields: [{ name: 'driverId', label: 'Driver', type: 'select', options, value: o.driverId || (options[0] || {}).value }] });
      if (!v) return;
      await MDM.store.assignDriver(o.id, v.driverId, { by: by() });
      toast(o.code + ' assigned to ' + F.driverName(v.driverId, drivers));
    }
    // CSV rows: name, phone, address, zone, size, description, reference (a header line is skipped).
    function zoneKeyOf(text, zones) {
      const n = norm(text);
      if (!n) return null;
      const z = zones.find(x => norm(x.key) === n || norm(x.name) === n || norm(x.short) === n) || zones.find(x => norm(x.name).indexOf(n) === 0 || n.indexOf(norm(x.short)) === 0);
      return z ? z.key : null;
    }
    function parseRows(text, zones) {
      const out = [], errors = [];
      String(text || '').split(/\r?\n/).forEach((line, i) => {
        if (!trim(line)) return;
        const cells = line.split(/\t|,/).map(trim);
        if (i === 0 && /name/i.test(cells[0]) && /phone/i.test(cells[1] || '')) return;
        const [name, ph, address, zone, size, description, reference] = cells;
        const zk = zoneKeyOf(zone, zones);
        const sz = norm(size || 'bag');
        const why = !name ? 'name missing' : !phone.valid(ph || '') ? 'phone "' + (ph || '') + '" is not a Maldives mobile' : !address ? 'address missing' : !zk ? 'zone "' + (zone || '') + '" not found' : ['bag', 'box', 'xl'].indexOf(sz) < 0 ? 'size must be Bag, Box or XL' : null;
        if (why) { errors.push('Line ' + (i + 1) + ': ' + why); return; }
        out.push({ name, phone: phone.normalize(ph), address, zone: zk, size: sz, description: description || '', reference: reference || '' });
      });
      return { rows: out, errors };
    }
    async function newBatch(accounts, preset) {
      const zones = await MDM.store.list('zones', { order: 'createdAt' });
      const approved = accounts.filter(a => a.status === 'approved');
      if (!approved.length) { toast('Approve a business account first', 'warn'); return; }
      const sample = 'name, phone, address, zone, size, description, reference\nAishath Nadha, 7720001, Amin Avenue Block B, Hulhumalé Phase 1, bag, Grade 7 books, KB-2301';
      const v = await MDM.ui.dialog({ title: 'New bulk order', message: 'One line per package. Each package becomes its own order, invoiced to the account at its business rate.', okLabel: 'Create bulk order',
        fields: [
          { name: 'accountId', label: 'Business account', type: 'select', options: approved.map(a => ({ value: a.id, label: a.name })), value: preset && approved.some(a => a.id === preset) ? preset : approved[0].id },
          { name: 'address', label: 'Collection address', type: 'text', hint: 'Leave empty to use the account\'s pickup address' },
          { name: 'instructions', label: 'Collection instructions', type: 'text', placeholder: 'Ask for the dispatch shelf' },
          { name: 'level', label: 'Service', type: 'segmented', options: MDM.SERVICE_LEVELS.filter(x => x.value !== 'advance'), value: 'normal' },
          { name: 'rows', label: 'Packages (paste from a spreadsheet or CSV)', type: 'textarea', rows: 8, required: true, placeholder: sample, hint: 'Columns: name, phone, address, zone, size, description, reference. Zones: ' + zones.filter(z => z.active !== false).map(z => z.short || z.name).join(', ') + '.',
            validate: val => { const r = parseRows(val, zones); return r.errors.length ? r.errors.slice(0, 3).join('; ') + (r.errors.length > 3 ? ' and ' + (r.errors.length - 3) + ' more' : '') : (!r.rows.length ? 'Add at least one package' : null); } },
          { name: 'notes', label: 'Notes', type: 'text' }] });
      if (!v) return;
      const acc = approved.find(a => a.id === v.accountId);
      const parsed = parseRows(v.rows, zones);
      const b = await MDM.store.createBatch({ accountId: acc.id, rows: parsed.rows, serviceLevel: v.level, notes: v.notes, source: 'csv', by: by(),
        collection: { address: v.address || acc.pickupAddress, zone: acc.zone, landmark: '', contactName: acc.contactName, contactPhone: acc.phone, instructions: v.instructions || '' } });
      toast(b.code + ' created with ' + plural(parsed.rows.length, 'package'));
      location.hash = '#/bulk/' + encodeURIComponent(b.id);
    }
    return { title: 'Bulk orders', mount, update, unmount };
  })();

  // ==== #/zones ==================================================================================================================
  MDM.admin.views.zones = (function () {
    let ctx = null, root = null, ui = null, map = null, markers = {}, draftMarker = null, editing = null, zonesCache = [];
    const ISLANDS = [{ value: 'male', label: 'Malé' }, { value: 'hulhumale', label: 'Hulhumalé' }, { value: 'hulhule', label: 'Hulhulé (airport)' }, { value: 'villimale', label: 'Villimalé' }, { value: 'thilafushi', label: 'Thilafushi' }, { value: 'gulhifalhu', label: 'Gulhifalhu' }];
    async function mount(host) {
      ctx = context(); root = host; markers = {}; editing = null;
      ui = { mapEl: el('div', { class: 'map zones-map', 'data-testid': 'zones-map', role: 'region', 'aria-label': 'Zones map' }), side: el('div', { class: 'zones-side' }) };
      root.replaceChildren(pageHead('Zones', 'Where we deliver: each zone has its drivers, its island for pricing (same island or across the bridge) and, for the airport, its service areas.',
        [el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'zones-add', on: { click: () => startEdit('new') } }, icon('plus'), 'Add zone')]),
        el('div', { class: 'zones-layout' }, ui.mapEl, ui.side));
      ['zones', 'drivers'].forEach(c => ctx.sub(c, () => { if (!editing) ctx.schedule(render); }));
      ctx.sub('*', m => { if (m && m.op === 'reset') { editing = null; ctx.schedule(render); } });
      await render();
      initMap();
    }
    function unmount() { if (ctx) ctx.dispose(); Object.keys(markers).forEach(k => markers[k].remove()); markers = {}; if (draftMarker) draftMarker.remove(); draftMarker = null; if (map) MDM.map.destroy(map); map = null; ctx = null; root = null; ui = null; editing = null; }
    async function initMap() {
      if (!MDM.map.available()) { ui.mapEl.appendChild(el('div', { class: 'map__fallback' }, el('div', { class: 'alert alert--warn' }, icon('alert-triangle'), el('div', { class: 'alert__body' }, 'Map unavailable. Enter the centre as latitude and longitude.')))); return; }
      try { map = await MDM.map.create(ui.mapEl, { zoom: 12 }); } catch (e) { return; }
      if (!ctx || !ctx.alive) { MDM.map.destroy(map); map = null; return; }
      map.on('click', e => { if (!editing) return; setDraft(e.lngLat.lat, e.lngLat.lng); });
      drawMarkers();
    }
    function drawMarkers() {
      if (!map) return;
      Object.keys(markers).forEach(k => markers[k].remove()); markers = {};
      zonesCache.forEach(z => { if (!z.center) return; markers[z.key] = MDM.map.marker(map, 'zone', z.center, { label: z.short || z.name, testid: 'zone-marker' }); markers[z.key].el.classList.toggle('is-paused', z.active === false); markers[z.key].el.classList.toggle('is-selected', !!editing && editing.key === z.key); });
      if (zonesCache.length) MDM.map.fit(map, zonesCache.filter(z => z.center).map(z => z.center), { padding: 48, maxZoom: 13 });
    }
    function setDraft(lat, lng) {
      if (!ui || !ui.form) return;
      ui.form.elements.lat.value = lat.toFixed(5); ui.form.elements.lng.value = lng.toFixed(5);
      if (!map) return;
      if (draftMarker) draftMarker.setLatLng([lat, lng]); else { draftMarker = MDM.map.marker(map, 'zone', [lat, lng], { label: 'New centre', testid: 'zone-draft' }); draftMarker.el.classList.add('is-draft'); }
    }
    async function render() {
      const [zones, drivers] = await Promise.all([MDM.store.list('zones', { order: 'createdAt' }), MDM.store.list('drivers', { order: 'name' })]);
      if (!ctx || !ctx.alive) return;
      zonesCache = zones; ui.drivers = drivers;
      if (editing) { ui.side.replaceChildren(editor(editing === 'new' ? null : zones.find(z => z.id === editing.id), drivers)); drawMarkers(); return; }
      ui.side.replaceChildren(card(null, el('div', { class: 'list', 'data-testid': 'zones-list' }, zones.map(z => el('div', { class: 'list__item', 'data-testid': 'zone-row', 'data-zone': z.key },
        el('div', { class: 'list__main' },
          el('div', { class: 'list__title' }, z.name, z.active === false ? badge('neutral', 'Paused') : null, z.airport ? badge('info', 'Airport') : null, z.quoteOnly ? badge('warn', 'Price on request') : null),
          el('div', { class: 'list__meta' }, label(ISLANDS, z.island) + ' island · ' + ((z.driverIds || []).map(d => F.driverName(d, drivers)).filter(Boolean).join(', ') || 'no drivers')),
          z.airport && (z.areas || []).length ? el('div', { class: 'tags' }, z.areas.map(a => el('span', { class: 'tag' }, a.label))) : null,
          z.notes ? el('div', { class: 'list__meta' }, z.notes) : null),
        el('div', { class: 'list__aside' }, el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'zone-edit', on: { click: () => startEdit(z) } }, 'Edit')))))));
      drawMarkers();
    }
    function startEdit(z) { editing = z === 'new' ? 'new' : { id: z.id, key: z.key }; if (draftMarker) { draftMarker.remove(); draftMarker = null; } ctx.schedule(render); }
    function stopEdit() { editing = null; if (draftMarker) { draftMarker.remove(); draftMarker = null; } ctx.schedule(render); }
    function editor(z, drivers) {
      z = z || { name: '', short: '', island: 'male', active: true, quoteOnly: false, airport: false, center: null, radius: 0.003, driverIds: [], areas: [], notes: '' };
      const inp = (name, value, attrs) => el('input', Object.assign({ class: 'input', name, value: value == null ? '' : String(value), 'data-testid': 'zone-' + name }, attrs || {}));
      const fld = (text, control, hint) => { control.id = 'zf-' + control.name; return el('div', { class: 'field' }, el('label', { for: control.id }, text), control, hint ? el('div', { class: 'field__hint' }, hint) : null); };
      const chk = (name, checked, text) => el('label', { class: 'checkbox' }, el('input', { type: 'checkbox', name, checked: !!checked, 'data-testid': 'zone-' + name }), el('span', null, text));
      const sel = el('select', { class: 'select', name: 'island', 'data-testid': 'zone-island' }, ISLANDS.map(i => el('option', { value: i.value }, i.label))); sel.value = z.island || 'male';
      const areas = (z.areas || []).map(a => a.label).join('\n');
      ui.form = el('form', { class: 'form zone-form', novalidate: true, 'data-testid': 'zone-form', on: { submit: e => { e.preventDefault(); run(() => save(z, drivers)); } } },
        el('h2', null, z.id ? 'Edit ' + z.name : 'New zone'),
        el('div', { class: 'grid-2' }, fld('Name', inp('name', z.name, { required: true, placeholder: 'Thilafushi' })), fld('Short label', inp('short', z.short, { placeholder: 'Thila' }))),
        fld('Island', sel, 'Trips within one island use the lower rate, trips between islands the higher one'),
        el('div', { class: 'grid-2' }, fld('Latitude', inp('lat', z.center ? z.center[0] : '', { inputmode: 'decimal' })), fld('Longitude', inp('lng', z.center ? z.center[1] : '', { inputmode: 'decimal' }))),
        el('p', { class: 'muted small' }, map ? 'Click the map to set the centre of the zone.' : 'Enter the centre of the zone.'),
        el('div', { class: 'stack-2' }, chk('active', z.active !== false, 'Active: customers can choose it'), chk('quoteOnly', z.quoteOnly, 'Price on request (confirmed before collection)'), chk('airport', z.airport, 'Airport zone with service areas')),
        el('fieldset', { class: 'zone-drivers' }, el('legend', { class: 'field__label' }, 'Drivers for this zone'), drivers.map(d => chk('drv_' + d.id, (z.driverIds || []).indexOf(d.id) >= 0, d.name))),
        fld('Airport service areas', el('textarea', { class: 'textarea', name: 'areas', rows: 4, 'data-testid': 'zone-areas', value: areas }), 'One per line, for example Arrivals hall, Departures entrance, MACL cargo terminal'),
        fld('Notes', inp('notes', z.notes)),
        el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'zone-cancel', on: { click: stopEdit } }, 'Cancel'),
          z.id ? el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'zone-toggle', on: { click: () => run(async () => { await MDM.store.update('zones', z.id, { active: z.active === false }); await MDM.store.audit('zone_updated', (z.active === false ? 'Activated zone ' : 'Paused zone ') + z.name, by()); stopEdit(); toast(z.name + (z.active === false ? ' is active' : ' is paused')); }) } }, z.active === false ? 'Activate' : 'Pause') : null,
          el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'zone-save' }, 'Save zone')));
      return card(null, el('div', { class: 'card__body' }, ui.form));
    }
    async function save(z, drivers) {
      const f = ui.form, name = trim(f.elements.name.value);
      const lat = Number(f.elements.lat.value), lng = Number(f.elements.lng.value);
      if (!name) { MDM.ui.setError(f.elements.name.closest('.field'), 'Enter a name'); f.elements.name.focus(); return; }
      if (!isFinite(lat) || !isFinite(lng) || !f.elements.lat.value || lat < 3.9 || lat > 4.5 || lng < 73.3 || lng > 73.7) { MDM.ui.setError(f.elements.lat.closest('.field'), 'Set the centre: click the map or enter a point in Greater Malé'); f.elements.lat.focus(); return; }
      const oldAreas = z.areas || [];
      const areas = String(f.elements.areas.value || '').split(/\r?\n/).map(trim).filter(Boolean).map(t => { const old = oldAreas.find(a => a.label === t); return old || { value: norm(t).slice(0, 24), label: t, services: ['collect', 'deliver', 'baggage'] }; });
      const driverIds = drivers.filter(d => f.elements['drv_' + d.id].checked).map(d => d.id);
      const patch = { name, short: trim(f.elements.short.value) || name, island: f.elements.island.value, center: [lat, lng], active: f.elements.active.checked, quoteOnly: f.elements.quoteOnly.checked, airport: f.elements.airport.checked, areas, driverIds, notes: trim(f.elements.notes.value) };
      let saved;
      if (z.id) saved = await MDM.store.update('zones', z.id, patch);
      else {
        const key = norm(name).slice(0, 20) || 'zone';
        if (zonesCache.some(x => x.key === key)) { MDM.ui.setError(f.elements.name.closest('.field'), 'A zone with this name already exists'); return; }
        saved = await MDM.store.insert('zones', Object.assign({ key, radius: 0.003 }, patch));
      }
      for (const d of drivers) {
        const has = (d.zones || []).indexOf(saved.key) >= 0, want = driverIds.indexOf(d.id) >= 0;
        if (has !== want) await MDM.store.update('drivers', d.id, { zones: want ? (d.zones || []).concat([saved.key]) : (d.zones || []).filter(k => k !== saved.key) });
      }
      await MDM.store.audit(z.id ? 'zone_updated' : 'zone_created', (z.id ? 'Updated zone ' : 'Created zone ') + name, by());
      toast(z.id ? 'Zone saved' : name + ' added. It shows on the request form now.');
      stopEdit();
    }
    return { title: 'Zones', mount, unmount };
  })();

  // ==== #/team (attendance, records, leave, employees) ===========================================================================
  MDM.admin.views.team = (function () {
    let ctx = null, root = null, tab = 'today', range = null, body = null, tabsEl = null;
    const TABS = [{ value: 'today', label: 'Today' }, { value: 'records', label: 'Attendance records' }, { value: 'leave', label: 'Leave' }, { value: 'people', label: 'Employees' }];
    async function mount(host, params) {
      ctx = context(); root = host;
      const q = queryOf(params);
      tab = TABS.some(t => t.value === q.get('tab')) ? q.get('tab') : 'today';
      range = { from: q.get('from') || dayKey(new Date(Date.now() - 6 * 864e5)), to: q.get('to') || dayKey(new Date()), staff: q.get('staff') || '', status: q.get('status') || 'pending' };
      body = el('div', { class: 'stack-6' });
      root.replaceChildren(pageHead('Team & HR', 'Who is on duty, attendance records, leave requests and the people on the team.', [el('a', { class: 'btn btn--secondary', href: MDM.href('staff/'), target: '_blank', rel: 'noopener' }, 'Staff self-service')]), el('div', { class: 'team-tabs' }), body);
      ['staff', 'attendance', 'leaves', 'drivers', 'settings'].forEach(c => ctx.sub(c, () => ctx.schedule(render)));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      ctx.timers.push(setInterval(() => { if (tab === 'today') ctx.schedule(render); }, 60000));
      await render();
    }
    async function update(params) { const t = queryOf(params).get('tab'); tab = t && TABS.some(x => x.value === t) ? t : 'today'; await render(); }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; }
    function pick(t) { tab = t; MDM.admin.setQuery({ tab: t === 'today' ? null : t }); ctx.schedule(render); }
    async function render() {
      const [staff, attendance, leaves, settings] = await Promise.all([MDM.store.list('staff', { order: 'name' }), MDM.store.list('attendance', { order: '-inAt' }), MDM.store.list('leaves'), MDM.store.settings()]);
      if (!ctx || !ctx.alive) return;
      const pending = leaves.filter(l => l.status === 'pending').length;
      const t = tabs(TABS.map(x => Object.assign({}, x, { count: x.value === 'leave' ? pending : null })), tab, pick, 'team-tab');
      root.querySelector('.team-tabs').replaceChildren(t);
      const hr = settings.hr || {};
      const ctxData = { staff, attendance, leaves, hr, today: dayKey(new Date()) };
      if (tab === 'today') body.replaceChildren(...today(ctxData));
      else if (tab === 'records') body.replaceChildren(...records(ctxData));
      else if (tab === 'leave') body.replaceChildren(...leaveTab(ctxData));
      else body.replaceChildren(...people(ctxData));
    }
    const onLeave = (s, leaves, day) => leaves.find(l => l.staffId === s.id && l.status === 'approved' && l.from <= day && l.to >= day);
    function late(rec, hr) { const start = MDM.ui.parseHHMM(hr.shiftStart || '08:00'); const d = new Date(rec.inAt); return start != null && d.getHours() * 60 + d.getMinutes() > start + (Number(hr.graceMinutes) || 0); }
    function today(c) {
      const rows = c.staff.filter(s => s.status !== 'inactive').map(s => {
        const recs = c.attendance.filter(a => a.staffId === s.id && a.date === c.today);
        const openRec = recs.find(a => !a.outAt), last = recs[0];
        const lv = onLeave(s, c.leaves, c.today);
        const state = openRec ? 'on' : lv ? 'leave' : last ? 'out' : 'absent';
        return { s, recs, openRec, last, lv, state, hours: recs.reduce((n, a) => n + hours(a.inAt, a.outAt), 0), late: recs.length ? late(recs[recs.length - 1], c.hr) : false };
      });
      const count = st => rows.filter(r => r.state === st).length;
      const cols = [
        { label: 'Name', primary: true, render: r => el('span', null, r.s.name, el('span', { class: 'table__sub' }, label(MDM.ROLES, r.s.role) + (r.s.title ? ' · ' + r.s.title : ''))) },
        { label: 'Today', primary: true, render: r => r.state === 'on' ? el('span', null, badge(r.late ? 'warn' : 'ok', r.late ? 'On duty, late' : 'On duty', { 'data-duty': 'on' }), el('span', { class: 'table__sub' }, 'since ' + MDM.ui.fmtTime(r.openRec.inAt) + ' · ' + (r.openRec.source || ''))) :
          r.state === 'leave' ? badge('info', label(MDM.LEAVE_TYPES, r.lv.type), { 'data-duty': 'leave' }) :
          r.state === 'out' ? el('span', null, badge('neutral', 'Punched out', { 'data-duty': 'out' }), el('span', { class: 'table__sub' }, 'at ' + MDM.ui.fmtTime(r.last.outAt))) : badge('neutral', 'Not in yet', { 'data-duty': 'absent' }) },
        { label: 'Hours today', num: true, render: r => r.hours ? hhmm(r.hours) : '' },
        { label: 'Actions', actions: true, render: r => actionsRow(r.openRec
          ? smallBtn('Punch out', 'team-punch-out', async () => { await MDM.store.punchOut(r.s.id, { note: 'Recorded by ' + MDM.byName(by()) }); toast(r.s.name + ' punched out'); }, 'btn--secondary')
          : r.state !== 'leave' ? smallBtn('Punch in', 'team-punch-in', async () => { await MDM.store.punchIn(r.s.id, { source: 'office', note: 'Recorded by ' + MDM.byName(by()) }); toast(r.s.name + ' punched in'); }, 'btn--secondary') : null) },
      ];
      return [
        el('div', { class: 'kpi-row kpi-row--fluid' }, kpi('On duty', count('on'), 'shift ' + (c.hr.shiftStart || '08:00') + ' to ' + (c.hr.shiftEnd || '17:00'), 'team-on'), kpi('Late', rows.filter(r => r.late && r.recs.length).length, 'after ' + (c.hr.graceMinutes || 0) + ' min grace', 'team-late'),
          kpi('Not in yet', count('absent'), null, 'team-absent'), kpi('On leave', count('leave'), null, 'team-leave'), kpi('Punched out', count('out'), null, 'team-out')),
        card(null, table(cols, rows.map(r => ({ data: r, attrs: { 'data-testid': 'team-row', 'data-staff-id': r.s.id, 'data-duty': r.state } })), { testid: 'team-today' })),
      ];
    }
    function records(c) {
      const from = dateInput('team-from', range.from, 'From'), to = dateInput('team-to', range.to, 'To');
      const who = el('select', { class: 'select', 'aria-label': 'Employee', 'data-testid': 'team-staff' }, el('option', { value: '' }, 'Everyone'), c.staff.map(s => el('option', { value: s.id }, s.name))); who.value = range.staff;
      const apply = () => { range.from = from.value; range.to = to.value; range.staff = who.value; MDM.admin.setQuery({ from: range.from, to: range.to, staff: range.staff || null }); ctx.schedule(render); };
      [from, to, who].forEach(x => x.addEventListener('change', apply));
      const recs = c.attendance.filter(a => (!range.from || a.date >= range.from) && (!range.to || a.date <= range.to) && (!range.staff || a.staffId === range.staff));
      const name = id => (c.staff.find(s => s.id === id) || {}).name || 'Employee';
      const totals = {}; recs.forEach(a => { const t = totals[a.staffId] || (totals[a.staffId] = { days: new Set(), hours: 0, late: 0 }); t.days.add(a.date); t.hours += hours(a.inAt, a.outAt); if (late(a, c.hr)) t.late += 1; });
      const cols = [
        { label: 'Date', nowrap: true, render: a => F.fmtDay(a.date) },
        { label: 'Name', primary: true, render: a => name(a.staffId) },
        { label: 'In', nowrap: true, render: a => el('span', null, MDM.ui.fmtTime(a.inAt), late(a, c.hr) ? el('span', { class: 'table__sub' }, 'late') : null) },
        { label: 'Out', nowrap: true, render: a => a.outAt ? MDM.ui.fmtTime(a.outAt) : el('span', { class: 'subtle' }, 'still in') },
        { label: 'Hours', num: true, render: a => hhmm(hours(a.inAt, a.outAt)) },
        { label: 'Source', render: a => (a.source || '') + (a.note ? ' · ' + a.note : '') },
      ];
      const sumCols = [{ label: 'Name', primary: true, render: r => name(r[0]) }, { label: 'Days', num: true, render: r => String(r[1].days.size) }, { label: 'Hours', num: true, render: r => hhmm(r[1].hours) }, { label: 'Late', num: true, render: r => String(r[1].late) }];
      const exp = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'team-export', on: { click: () => { F.downloadCsv([['Date', 'Name', 'In', 'Out', 'Hours', 'Late', 'Source', 'Note']].concat(recs.map(a => [a.date, name(a.staffId), MDM.ui.fmtTime(a.inAt), a.outAt ? MDM.ui.fmtTime(a.outAt) : '', hours(a.inAt, a.outAt).toFixed(2), late(a, c.hr) ? 'yes' : '', a.source || '', a.note || ''])), 'mdm-attendance-' + range.from + '-' + range.to + '.csv'); toast('Attendance exported'); } } }, icon('download'), 'Export CSV');
      return [
        el('div', { class: 'filters' }, from, el('span', { class: 'filters__dash' }, 'to'), to, who, exp),
        el('section', { 'aria-labelledby': 'team-sum' }, sectionHead('team-sum', 'Summary'), card(null, Object.keys(totals).length ? table(sumCols, Object.keys(totals).map(k => ({ data: [k, totals[k]] })), { testid: 'team-summary' }) : empty('No attendance in this period.'))),
        el('section', { 'aria-labelledby': 'team-rec' }, sectionHead('team-rec', 'Punches'), card(null, recs.length ? table(cols, recs.map(a => ({ data: a, attrs: { 'data-testid': 'team-record' } })), { testid: 'team-records' }) : empty('No attendance in this period.'))),
      ];
    }
    function leaveTab(c) {
      const name = id => (c.staff.find(s => s.id === id) || {}).name || 'Employee';
      const status = el('select', { class: 'select', 'aria-label': 'Status', 'data-testid': 'leave-filter' }, [['pending', 'Waiting for a decision'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['', 'All requests']].map(x => el('option', { value: x[0] }, x[1])));
      status.value = range.status;
      status.addEventListener('change', () => { range.status = status.value; ctx.schedule(render); });
      const list = c.leaves.filter(l => !range.status || l.status === range.status).sort((a, b) => a.from < b.from ? -1 : 1);
      const KIND = { pending: ['warn', 'Pending'], approved: ['ok', 'Approved'], rejected: ['danger', 'Rejected'] };
      const cols = [
        { label: 'Name', primary: true, render: l => el('span', null, name(l.staffId), el('span', { class: 'table__sub' }, label(MDM.LEAVE_TYPES, l.type))) },
        { label: 'Dates', nowrap: true, render: l => F.fmtDay(l.from) + (l.to !== l.from ? ' to ' + F.fmtDay(l.to) : '') },
        { label: 'Days', num: true, render: l => String(l.days) },
        { label: 'Reason', render: l => l.reason || '' },
        { label: 'Balance', nowrap: true, render: l => { const s = c.staff.find(x => x.id === l.staffId) || {}; const bal = (s.leaveBalance || {})[l.type]; return bal != null ? bal + ' days left' : ''; } },
        { label: 'Status', primary: true, render: l => el('span', null, badge(KIND[l.status][0], KIND[l.status][1], { 'data-status': l.status }), l.decidedBy ? el('span', { class: 'table__sub' }, MDM.byName(l.decidedBy) + (l.remarks ? ': ' + l.remarks : '')) : null) },
        { label: 'Actions', actions: true, render: l => l.status !== 'pending' ? null : actionsRow(smallBtn('Reject', 'leave-reject', () => decide(l, false, c)), smallBtn('Approve', 'leave-approve', () => decide(l, true, c), 'btn--primary')) },
      ];
      return [
        el('div', { class: 'filters' }, status, el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'leave-add', on: { click: () => run(() => addLeave(c)) } }, icon('plus'), 'Record leave')),
        card(null, list.length ? table(cols, list.map(l => ({ data: l, attrs: { 'data-testid': 'leave-row', 'data-leave-id': l.id, 'data-status': l.status } })), { testid: 'leave-table' }) : empty('No leave requests here.', 'Staff request leave from the staff portal; requests appear here for approval.')),
      ];
    }
    async function decide(l, approve, c) {
      const v = await MDM.ui.dialog({ title: (approve ? 'Approve' : 'Reject') + ' leave', message: label(MDM.LEAVE_TYPES, l.type) + ', ' + plural(l.days, 'day') + ' from ' + F.fmtDay(l.from) + '.', okLabel: approve ? 'Approve' : 'Reject', danger: !approve,
        fields: [{ name: 'remarks', label: approve ? 'Remarks' : 'Reason', type: 'textarea', rows: 2, required: !approve }] });
      if (!v) return;
      await MDM.store.decideLeave(l.id, { approve, remarks: v.remarks, by: by() });
      const s = c.staff.find(x => x.id === l.staffId);
      if (approve && s && s.leaveBalance && s.leaveBalance[l.type] != null) await MDM.store.update('staff', s.id, { leaveBalance: Object.assign({}, s.leaveBalance, { [l.type]: Math.max(0, s.leaveBalance[l.type] - l.days) }) });
      toast(approve ? 'Leave approved' : 'Leave rejected', approve ? 'ok' : 'warn');
    }
    async function addLeave(c) {
      const v = await MDM.ui.dialog({ title: 'Record leave', okLabel: 'Save request',
        fields: [{ name: 'staffId', label: 'Employee', type: 'select', options: c.staff.map(s => ({ value: s.id, label: s.name })), value: (c.staff[0] || {}).id },
          { name: 'type', label: 'Type', type: 'select', options: MDM.LEAVE_TYPES, value: 'annual' },
          { name: 'from', label: 'From', type: 'date', required: true, value: dayKey(new Date()) }, { name: 'to', label: 'To', type: 'date', required: true, value: dayKey(new Date()), validate: (val, all) => val < all.from ? 'The end date is before the start' : null },
          { name: 'reason', label: 'Reason', type: 'textarea', rows: 2 }] });
      if (!v) return;
      await MDM.store.requestLeave({ staffId: v.staffId, type: v.type, from: v.from, to: v.to, reason: v.reason });
      toast('Leave request recorded');
    }
    function people(c) {
      const driverOf = s => s.driverId ? 'Driver profile linked' : '';
      const cols = [
        { label: 'Name', primary: true, render: s => el('span', null, s.name, el('span', { class: 'table__sub' }, s.title || '')) },
        { label: 'Role', render: s => label(MDM.ROLES, s.role) },
        { label: 'Phone', nowrap: true, render: s => el('span', { class: 'mono' }, phone.format(s.phone)) },
        { label: 'Sign-in', render: s => el('span', null, el('span', { class: 'mono' }, s.username || ''), el('span', { class: 'table__sub' }, driverOf(s))) },
        { label: 'Leave left', nowrap: true, render: s => s.leaveBalance ? 'Annual ' + s.leaveBalance.annual + ' · Sick ' + s.leaveBalance.sick : '' },
        { label: 'Status', primary: true, render: s => badge(s.status === 'active' ? 'ok' : s.status === 'on_leave' ? 'info' : 'neutral', { active: 'Active', on_leave: 'On leave', inactive: 'Inactive' }[s.status] || s.status) },
        { label: 'Actions', actions: true, render: s => actionsRow(smallBtn('Edit', 'staff-edit', () => editStaff(s))) },
      ];
      return [el('div', { class: 'filters' }, el('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-testid': 'staff-add', on: { click: () => run(() => editStaff(null)) } }, icon('plus'), 'Add employee')),
        card(null, table(cols, c.staff.map(s => ({ data: s, attrs: { 'data-testid': 'staff-row', 'data-staff-id': s.id } })), { testid: 'staff-table' }))];
    }
    async function editStaff(s) {
      const hr = (await MDM.store.settings()).hr || {};
      const v = await MDM.ui.dialog({ title: s ? 'Edit ' + s.name : 'Add employee', okLabel: s ? 'Save' : 'Add employee',
        fields: [
          { name: 'name', label: 'Name', type: 'text', required: true, value: s ? s.name : '' },
          { name: 'role', label: 'Role', type: 'select', options: MDM.ROLES, value: s ? s.role : 'operator', hint: 'Admins see everything; operators run orders and drivers; office staff handle customers and payments; drivers use the driver app' },
          { name: 'title', label: 'Job title', type: 'text', value: s ? s.title : '' },
          { name: 'phone', label: 'Mobile number', type: 'tel', required: true, value: s ? phone.format(s.phone) : '' },
          { name: 'username', label: 'Username', type: 'text', value: s ? s.username : '', hint: 'Drivers sign in with their mobile number' },
          { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'on_leave', label: 'On leave' }, { value: 'inactive', label: 'Inactive' }], value: s ? s.status : 'active' }] });
      if (!v) return;
      const ph = phone.normalize(v.phone);
      const patch = { name: v.name, role: v.role, title: v.title, phone: ph, username: v.role === 'driver' ? ph : (trim(v.username) || norm(v.name).slice(0, 12)), status: v.status };
      let saved;
      if (s) saved = await MDM.store.update('staff', s.id, patch);
      else saved = await MDM.store.insert('staff', Object.assign({ joinedAt: dayKey(new Date()), leaveBalance: { annual: Number(hr.annualLeaveDays) || 30, sick: Number(hr.sickLeaveDays) || 30 } }, patch));
      if (v.role === 'driver' && !saved.driverId) {
        const d = await MDM.store.insert('drivers', { name: v.name, phone: ph, vehicle: 'bike', vehicleNote: '', status: 'offline', staffId: saved.id, zones: [] });
        await MDM.store.update('staff', saved.id, { driverId: d.id });
      } else if (saved.driverId) await MDM.store.update('drivers', saved.driverId, { name: v.name, phone: ph });
      await MDM.store.audit(s ? 'staff_updated' : 'staff_added', (s ? 'Updated employee ' : 'Added employee ') + v.name + ' (' + label(MDM.ROLES, v.role) + ')', by());
      toast(s ? 'Employee saved' : v.name + ' added');
    }
    return { title: 'Team & HR', mount, update, unmount };
  })();

  // ==== #/reports ==================================================================================================================
  MDM.admin.views.reports = (function () {
    let ctx = null, root = null, body = null, range = null;
    const PRESETS = [{ value: 'today', label: 'Today' }, { value: '7d', label: '7 days' }, { value: 'month', label: 'This month' }, { value: 'last', label: 'Last month' }];
    function preset(p) {
      const now = new Date(), y = now.getFullYear(), m = now.getMonth();
      if (p === 'today') return { from: dayKey(now), to: dayKey(now) };
      if (p === '7d') return { from: dayKey(new Date(Date.now() - 6 * 864e5)), to: dayKey(now) };
      if (p === 'last') return { from: dayKey(new Date(y, m - 1, 1)), to: dayKey(new Date(y, m, 0)) };
      return { from: dayKey(new Date(y, m, 1)), to: dayKey(now) };
    }
    async function mount(host, params) {
      ctx = context(); root = host;
      const q = queryOf(params);
      range = q.get('from') ? { from: q.get('from'), to: q.get('to') || dayKey(new Date()) } : preset('month');
      body = el('div', { class: 'stack-6' });
      root.replaceChildren(pageHead('Reports', 'Orders, deliveries, revenue and payments for a date range, by driver, business, request type and zone. Every table exports to CSV.'), el('div', { class: 'report-range' }), body);
      ['orders', 'drivers', 'business_accounts'].forEach(c => ctx.sub(c, () => ctx.schedule(render)));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; }
    function setRange(r) { range = r; MDM.admin.setQuery({ from: r.from, to: r.to }); ctx.schedule(render); }
    async function render() {
      const [orders, drivers, accounts] = await Promise.all([MDM.store.list('orders'), MDM.store.list('drivers', { order: 'name' }), MDM.store.list('business_accounts')]);
      if (!ctx || !ctx.alive) return;
      const from = dateInput('report-from', range.from, 'From'), to = dateInput('report-to', range.to, 'To');
      [from, to].forEach(x => x.addEventListener('change', () => setRange({ from: from.value, to: to.value })));
      root.querySelector('.report-range').replaceChildren(el('div', { class: 'filters' },
        el('div', { class: 'row row--wrap' }, PRESETS.map(p => { const r = preset(p.value); return el('button', { type: 'button', class: 'chip', 'aria-pressed': r.from === range.from && r.to === range.to ? 'true' : 'false', 'data-testid': 'report-preset-' + p.value, on: { click: () => setRange(r) } }, p.label); })),
        from, el('span', { class: 'filters__dash' }, 'to'), to,
        el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'report-export-orders', on: { click: () => exportOrders(created) } }, icon('download'), 'Export orders')));
      const created = orders.filter(o => inRange(o.createdAt, range.from, range.to));
      const deliveredIn = orders.filter(o => o.status === 'delivered' && inRange(F.deliveredAt(o), range.from, range.to));
      const failedIn = orders.filter(o => (o.events || []).some(e => e.type === 'failed' && inRange(e.at, range.from, range.to)));
      const cancelledIn = orders.filter(o => o.status === 'cancelled' && inRange(o.cancelledAt || o.updatedAt, range.from, range.to));
      const paidIn = orders.filter(o => o.payment && o.payment.status === 'paid' && inRange(o.payment.verifiedAt || o.payment.paidAt, range.from, range.to));
      const revenue = paidIn.reduce((t, o) => t + (o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total), 0);
      const invoiced = deliveredIn.filter(o => o.payment && o.payment.method === 'invoice').reduce((t, o) => t + o.totals.total, 0);
      const pending = orders.filter(o => o.payment && (o.payment.status === 'requested' || o.payment.status === 'received'));
      const pendingAmt = pending.reduce((t, o) => t + o.totals.total, 0);
      const kpis = el('div', { class: 'kpi-row kpi-row--fluid', 'data-testid': 'report-kpis' },
        kpi('Orders', created.length, 'placed in this period', 'r-orders'), kpi('Completed', deliveredIn.length, 'delivered in this period', 'r-completed'),
        kpi('Failed', failedIn.length, 'a failed attempt in this period', 'r-failed'), kpi('Cancelled', cancelledIn.length, null, 'r-cancelled'),
        kpi('Revenue received', money(revenue), plural(paidIn.length, 'payment') + ' verified', 'r-revenue'), kpi('Invoiced to businesses', money(invoiced), 'delivered on account', 'r-invoiced'),
        kpi('Pending payments', money(pendingAmt), plural(pending.length, 'order') + ' waiting, any date', 'r-pending'));
      // By driver
      const drvRows = drivers.map(d => [d.name, deliveredIn.filter(o => o.driverId === d.id).length, failedIn.filter(o => o.driverId === d.id).length, deliveredIn.filter(o => o.driverId === d.id).reduce((n, o) => n + (o.packages || []).length, 0), money(deliveredIn.filter(o => o.driverId === d.id).reduce((n, o) => n + o.totals.total, 0))]);
      // By business
      const bizRows = accounts.map(a => { const mine = created.filter(o => o.accountId === a.id); const del = deliveredIn.filter(o => o.accountId === a.id); return [a.name, mine.length, mine.reduce((n, o) => n + (o.packages || []).length, 0), del.length, money(del.reduce((n, o) => n + o.totals.total, 0))]; });
      // By request type
      const types = {}; created.forEach(o => { const k = F.typeLabel(o); const t = types[k] || (types[k] = [k, 0, 0, 0]); t[1] += 1; if (o.status === 'delivered') t[2] += 1; if (o.status === 'cancelled') t[3] += 1; });
      // By delivery zone
      const zones = {}; created.forEach(o => { const k = MDM.geo.zoneLabel((o.delivery || {}).zone || 'male'); const t = zones[k] || (zones[k] = [k, 0, 0]); t[1] += 1; if (o.status === 'delivered') t[2] += 1; });
      // By day
      const days = {}; const touch = k => days[k] || (days[k] = [k, 0, 0, 0, 0]);
      created.forEach(o => { touch(dayKey(o.createdAt))[1] += 1; });
      deliveredIn.forEach(o => { touch(dayKey(F.deliveredAt(o)))[2] += 1; });
      cancelledIn.forEach(o => { touch(dayKey(o.cancelledAt || o.updatedAt))[3] += 1; });
      paidIn.forEach(o => { touch(dayKey(o.payment.verifiedAt || o.payment.paidAt))[4] += o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total; });
      const dayRows = Object.keys(days).sort().reverse().map(k => [F.fmtDay(k), days[k][1], days[k][2], days[k][3], money(days[k][4])]);
      body.replaceChildren(kpis,
        reportTable('rep-drivers', 'By driver', ['Driver', 'Delivered', 'Failed', 'Packages', 'Value'], drvRows, 'drivers'),
        reportTable('rep-business', 'By business account', ['Business', 'Orders', 'Packages', 'Delivered', 'Value'], bizRows, 'business'),
        el('div', { class: 'admin-grid' },
          reportTable('rep-types', 'By request type', ['Type', 'Orders', 'Delivered', 'Cancelled'], Object.values(types).sort((a, b) => b[1] - a[1]), 'types'),
          reportTable('rep-zones', 'By delivery zone', ['Zone', 'Orders', 'Delivered'], Object.values(zones).sort((a, b) => b[1] - a[1]), 'zones')),
        reportTable('rep-days', 'By day', ['Date', 'Orders', 'Delivered', 'Cancelled', 'Revenue'], dayRows, 'days'));
    }
    function reportTable(id, title, head, rows, key) {
      const exp = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'report-export-' + key, on: { click: () => { F.downloadCsv([head].concat(rows), 'mdm-report-' + key + '-' + range.from + '-' + range.to + '.csv'); toast(title + ' exported'); } } }, icon('download'), 'CSV');
      const cols = head.map((h, i) => ({ label: h, num: i > 0, primary: i === 0, render: r => String(r[i]) }));
      return el('section', { class: 'section', 'aria-labelledby': id }, sectionHead(id, title, null, exp),
        card(null, rows.length ? table(cols, rows.map(r => ({ data: r, attrs: { 'data-testid': 'report-row-' + key } })), { testid: 'report-' + key, compact: true }) : empty('Nothing in this period.')));
    }
    function exportOrders(list) {
      F.downloadCsv([['Order', 'Created', 'Type', 'Customer', 'Business', 'Status', 'Payment', 'Total MVR', 'Driver']].concat(list.map(o => [o.code, o.createdAt.slice(0, 16).replace('T', ' '), F.typeLabel(o), o.customer.name, o.accountId || '', MDM.STATUS[o.status].label, (MDM.PAYMENT[(o.payment || {}).status] || {}).label || '', o.totals.total, o.driverId || ''])), 'mdm-orders-' + range.from + '-' + range.to + '.csv');
      toast(plural(list.length, 'order') + ' exported');
    }
    return { title: 'Reports', mount, unmount };
  })();

  // ==== #/notifications ============================================================================================================
  MDM.admin.views.notifications = (function () {
    let ctx = null, root = null, body = null, f = { channel: '', event: '', q: '' }, page = 0;
    const PAGE = 50;
    async function mount(host) {
      ctx = context(); root = host; page = 0;
      body = el('div', { class: 'stack-4' });
      root.replaceChildren(pageHead('Notifications', 'Every message sent to customers when their order changes. The mockup logs them; a live system hands them to an SMS, WhatsApp or email provider.',
        [MDM.admin.can('settings') ? el('a', { class: 'btn btn--secondary', href: '#/settings' }, 'Notification settings') : null]), body);
      ctx.sub('notifications', () => ctx.schedule(render));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; }
    async function render() {
      const all = await MDM.store.list('notifications', { order: '-at' });
      if (!ctx || !ctx.alive) return;
      const today = dayKey(new Date());
      const ch = el('select', { class: 'select', 'aria-label': 'Channel', 'data-testid': 'notif-channel' }, el('option', { value: '' }, 'All channels'), Object.keys(F.NOTIFY).map(k => el('option', { value: k }, F.NOTIFY[k])));
      const ev = el('select', { class: 'select', 'aria-label': 'Event', 'data-testid': 'notif-event' }, el('option', { value: '' }, 'All events'), Object.keys(MDM.NOTIFY).map(k => el('option', { value: k }, MDM.NOTIFY[k])));
      const q = el('input', { class: 'input', type: 'search', placeholder: 'Order or phone', 'aria-label': 'Search', 'data-testid': 'notif-search', value: f.q });
      ch.value = f.channel; ev.value = f.event;
      ch.addEventListener('change', () => { f.channel = ch.value; page = 0; ctx.schedule(render); });
      ev.addEventListener('change', () => { f.event = ev.value; page = 0; ctx.schedule(render); });
      q.addEventListener('change', () => { f.q = trim(q.value); page = 0; ctx.schedule(render); });
      const list = all.filter(n => (!f.channel || n.channel === f.channel) && (!f.event || n.event === f.event) && (!f.q || norm(n.code + n.to + n.name).indexOf(norm(f.q)) >= 0));
      const slice = list.slice(page * PAGE, page * PAGE + PAGE);
      const todayN = all.filter(n => dayKey(n.at) === today);
      const cols = [
        { label: 'Sent', nowrap: true, render: n => F.whenCell(n.at) },
        { label: 'Order', primary: true, render: n => n.orderId ? el('a', { class: 'mono', href: '#/orders/' + encodeURIComponent(n.orderId) }, n.code) : '' },
        { label: 'To', render: n => el('span', null, n.name || '', el('span', { class: 'table__sub mono' }, phone.format(n.to))) },
        { label: 'Channel', render: n => F.NOTIFY[n.channel] || n.channel },
        { label: 'Message', render: n => el('span', null, el('strong', null, n.title), el('span', { class: 'table__sub wrap-anywhere' }, n.message)) },
        { label: 'Status', render: n => badge(n.status === 'sent' ? 'ok' : 'warn', n.status === 'sent' ? 'Sent' : n.status) },
      ];
      const pages = Math.max(1, Math.ceil(list.length / PAGE));
      body.replaceChildren(
        el('div', { class: 'kpi-row kpi-row--fluid' }, kpi('Sent today', todayN.length, null, 'n-today'), ...Object.keys(F.NOTIFY).map(k => kpi(F.NOTIFY[k], todayN.filter(n => n.channel === k).length, 'today', 'n-' + k))),
        el('div', { class: 'filters' }, q, ch, ev),
        card(null, slice.length ? [table(cols, slice.map(n => ({ data: n, attrs: { 'data-testid': 'notif-row', 'data-event': n.event } })), { testid: 'notif-table' }),
          el('div', { class: 'pagination' }, el('span', null, 'Showing ' + (page * PAGE + 1) + ' to ' + (page * PAGE + slice.length) + ' of ' + list.length),
            el('div', { class: 'pagination__actions' }, el('button', { type: 'button', class: 'btn btn--secondary btn--sm', disabled: page === 0, on: { click: () => { page -= 1; ctx.schedule(render); } } }, 'Previous'),
              el('button', { type: 'button', class: 'btn btn--secondary btn--sm', disabled: page >= pages - 1, on: { click: () => { page += 1; ctx.schedule(render); } } }, 'Next')))] : empty('No notifications match.')));
    }
    return { title: 'Notifications', mount, unmount };
  })();

  // ==== #/activity (audit log, requirements §21) ===================================================================================
  MDM.admin.views.activity = (function () {
    let ctx = null, root = null, body = null, f = { cat: '', who: '', from: '', to: '', q: '' }, page = 0;
    const PAGE = 50;
    const STATUS_TYPES = ['created', 'confirmed', 'assigned', 'dispatched', 'route_started', 'arrived', 'collected', 'out_for_delivery', 'delivered', 'failed', 'returned', 'rescheduled', 'reassigned', 'return_added'];
    const CATS = [
      { value: 'status', label: 'Status changes', test: t => STATUS_TYPES.indexOf(t) >= 0 },
      { value: 'price', label: 'Price changes', test: t => ['price_confirmed', 'adjustment', 'size_updated'].indexOf(t) >= 0 },
      { value: 'payment', label: 'Payments', test: t => /^payment_|^refund$|^settled$/.test(t) },
      { value: 'cancel', label: 'Cancellations', test: t => /cancel/.test(t) },
      { value: 'priority', label: 'Priority', test: t => /^priority_/.test(t) },
      { value: 'changes', label: 'Order changes and remarks', test: t => ['modified', 'note', 'update_sent', 'contacted'].indexOf(t) >= 0 },
      { value: 'hr', label: 'Attendance and leave', test: t => /^punch_|^leave_/.test(t) },
      { value: 'setup', label: 'Settings, zones, staff and store', test: t => /^settings_|^zone_|^staff_|^driver_|^product_|^batch_|^invoice_|^signed_/.test(t) },
    ];
    async function mount(host) {
      ctx = context(); root = host; page = 0;
      body = el('div', { class: 'stack-4' });
      root.replaceChildren(pageHead('Activity log', 'Who did what and when: status changes, price changes, payments, cancellations, priority decisions, attendance, leave and settings.'), body);
      ctx.sub('events', () => ctx.schedule(render));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; }
    async function render() {
      const all = await MDM.store.list('events', { order: '-at' });
      if (!ctx || !ctx.alive) return;
      const people = all.map(e => e.by || 'system').filter((v, i, a) => a.indexOf(v) === i).map(v => ({ value: v, label: v === 'system' ? 'System' : MDM.byName(v) })).sort((a, b) => a.label.localeCompare(b.label));
      const cat = el('select', { class: 'select', 'aria-label': 'Kind', 'data-testid': 'activity-cat' }, el('option', { value: '' }, 'Everything'), CATS.map(c => el('option', { value: c.value }, c.label)));
      const who = el('select', { class: 'select', 'aria-label': 'Who', 'data-testid': 'activity-who' }, el('option', { value: '' }, 'Everyone'), people.map(p => el('option', { value: p.value }, p.label)));
      const from = dateInput('activity-from', f.from, 'From'), to = dateInput('activity-to', f.to, 'To');
      const q = el('input', { class: 'input', type: 'search', placeholder: 'Order or words', 'aria-label': 'Search', 'data-testid': 'activity-search', value: f.q });
      cat.value = f.cat; who.value = f.who;
      [[cat, 'cat'], [who, 'who'], [from, 'from'], [to, 'to'], [q, 'q']].forEach(([c, k]) => c.addEventListener('change', () => { f[k] = trim(c.value); page = 0; ctx.schedule(render); }));
      const cdef = CATS.find(c => c.value === f.cat);
      const list = all.filter(e => (!cdef || cdef.test(e.type)) && (!f.who || (e.by || 'system') === f.who) && (!f.from || dayKey(e.at) >= f.from) && (!f.to || dayKey(e.at) <= f.to) && (!f.q || norm((e.code || '') + e.label).indexOf(norm(f.q)) >= 0));
      const slice = list.slice(page * PAGE, page * PAGE + PAGE);
      const pages = Math.max(1, Math.ceil(list.length / PAGE));
      const catOf = t => (CATS.find(c => c.test(t)) || {}).label || 'Other';
      const cols = [
        { label: 'When', nowrap: true, render: e => fmtDate(e.at) },
        { label: 'Who', render: e => F.byLabel(e.by) },
        { label: 'What', primary: true, render: e => el('span', { class: 'wrap-anywhere' }, e.label, e.visibility === 'internal' ? el('span', { class: 'table__sub' }, 'Internal') : null) },
        { label: 'Order', render: e => e.orderId ? el('a', { class: 'mono', href: '#/orders/' + encodeURIComponent(e.orderId) }, e.code) : '' },
        { label: 'Kind', render: e => catOf(e.type) },
      ];
      const exp = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'activity-export', on: { click: () => { F.downloadCsv([['When', 'Who', 'What', 'Order', 'Type']].concat(list.map(e => [e.at, F.byLabel(e.by), e.label, e.code || '', e.type])), 'mdm-activity-' + dayKey(new Date()) + '.csv'); toast(plural(list.length, 'entry') + ' exported'); } } }, icon('download'), 'Export CSV');
      body.replaceChildren(el('div', { class: 'filters' }, q, cat, who, from, el('span', { class: 'filters__dash' }, 'to'), to, exp),
        card(null, slice.length ? [table(cols, slice.map(e => ({ data: e, attrs: { 'data-testid': 'activity-row', 'data-type': e.type } })), { testid: 'activity-table' }),
          el('div', { class: 'pagination' }, el('span', null, 'Showing ' + (page * PAGE + 1) + ' to ' + (page * PAGE + slice.length) + ' of ' + list.length),
            el('div', { class: 'pagination__actions' }, el('button', { type: 'button', class: 'btn btn--secondary btn--sm', disabled: page === 0, on: { click: () => { page -= 1; ctx.schedule(render); } } }, 'Previous'),
              el('button', { type: 'button', class: 'btn btn--secondary btn--sm', disabled: page >= pages - 1, on: { click: () => { page += 1; ctx.schedule(render); } } }, 'Next')))] : empty('Nothing matches.')));
    }
    return { title: 'Activity log', mount, unmount };
  })();

  // ==== #/store (e-store products and orders) ======================================================================================
  MDM.admin.views.store = (function () {
    let ctx = null, root = null, body = null, tab = 'products', tabsEl = null;
    const CATEGORIES = [{ value: 'packaging', label: 'Packaging' }, { value: 'supplies', label: 'Supplies' }, { value: 'bundles', label: 'Delivery bundles' }];
    const LOW = 5;
    async function mount(host, params) {
      ctx = context(); root = host;
      tab = queryOf(params).get('tab') === 'orders' ? 'orders' : 'products';
      body = el('div', { class: 'stack-6' }); tabsEl = el('div');
      root.replaceChildren(pageHead('E-store', 'Packaging, supplies and delivery bundles sold on the website and delivered with the next order.',
        [el('a', { class: 'btn btn--secondary', href: MDM.href('store/'), target: '_blank', rel: 'noopener' }, 'Open the store'), el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'product-add', on: { click: () => run(() => edit(null)) } }, icon('plus'), 'Add product')]), tabsEl, body);
      ['products', 'orders'].forEach(c => ctx.sub(c, () => ctx.schedule(render)));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      await render();
    }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; }
    async function render() {
      const [products, orders] = await Promise.all([MDM.store.list('products', { order: 'name' }), MDM.store.list('orders', { where: { requestType: 'store' } })]);
      if (!ctx || !ctx.alive) return;
      const month = MDM.ui.monthKey(new Date());
      const monthOrders = orders.filter(o => MDM.ui.monthKey(o.createdAt) === month && o.status !== 'cancelled');
      const low = products.filter(p => p.active !== false && p.stock != null && p.stock <= LOW);
      tabsEl.replaceChildren(tabs([{ value: 'products', label: 'Products', count: products.length }, { value: 'orders', label: 'Store orders', count: orders.length }], tab, t => { tab = t; MDM.admin.setQuery({ tab: t === 'products' ? null : t }); ctx.schedule(render); }, 'store-tab'));
      const kpis = el('div', { class: 'kpi-row kpi-row--fluid' }, kpi('Products on sale', products.filter(p => p.active !== false).length, null, 's-active'), kpi('Low or out of stock', low.length, LOW + ' or fewer left', 's-low'),
        kpi('Orders this month', monthOrders.length, null, 's-orders'), kpi('Item sales this month', money(monthOrders.reduce((n, o) => n + ((o.totals || {}).items || 0), 0)), 'excluding delivery', 's-sales'));
      if (tab === 'orders') {
        const cols = [
          { label: 'Order', primary: true, render: o => el('a', { class: 'mono', href: '#/orders/' + encodeURIComponent(o.id) }, o.code) },
          { label: 'Customer', render: o => el('span', null, o.customer.name, el('span', { class: 'table__sub mono' }, phone.format(o.customer.phone))) },
          { label: 'Items', render: o => (o.items || []).map(i => i.qty + ' × ' + i.name).join(', ') },
          { label: 'Total', num: true, render: o => money(o.totals.total) },
          { label: 'Payment', render: o => F.paymentBadge(o) },
          { label: 'Status', primary: true, render: o => html(MDM.badgeFor(o.status)) },
          { label: 'Placed', nowrap: true, render: o => F.whenCell(o.createdAt) },
        ];
        body.replaceChildren(kpis, card(null, orders.length ? table(cols, orders.map(o => ({ data: o, attrs: { class: 'is-clickable', 'data-testid': 'store-order-row', on: { click: e => { if (e.target.closest('a')) return; MDM.admin.openOrder(o.id); } } } })), { testid: 'store-orders' }) : empty('No store orders yet.')));
        return;
      }
      const stockBadge = p => p.stock == null ? badge('neutral', 'Unlimited') : p.stock === 0 ? badge('danger', 'Out of stock', { 'data-stock': 'out' }) : p.stock <= LOW ? badge('warn', p.stock + ' left', { 'data-stock': 'low' }) : el('span', { class: 'mono' }, String(p.stock));
      const cols = [
        { label: 'Product', primary: true, render: p => el('span', null, p.name, el('span', { class: 'table__sub mono' }, p.sku || '')) },
        { label: 'Category', render: p => label(CATEGORIES, p.category) },
        { label: 'Price', num: true, render: p => money(p.price) + (p.unit ? ' / ' + p.unit : '') },
        { label: 'Stock', render: stockBadge },
        { label: 'On sale', render: p => p.active === false ? badge('neutral', 'Hidden') : badge('ok', 'On sale') },
        { label: 'Actions', actions: true, render: p => actionsRow(smallBtn('Stock', 'product-stock', () => restock(p)), smallBtn('Edit', 'product-edit', () => edit(p)),
          smallBtn(p.active === false ? 'Show' : 'Hide', 'product-toggle', async () => { await MDM.store.update('products', p.id, { active: p.active === false }); await MDM.store.audit('product_updated', (p.active === false ? 'Put on sale: ' : 'Hidden from the store: ') + p.name, by()); toast(p.name + (p.active === false ? ' is on sale' : ' is hidden')); })) },
      ];
      body.replaceChildren(kpis, card(null, products.length ? table(cols, products.map(p => ({ data: p, attrs: { 'data-testid': 'product-row', 'data-product-id': p.id } })), { testid: 'products-table' }) : empty('No products yet.')));
    }
    async function edit(p) {
      const v = await MDM.ui.dialog({ title: p ? 'Edit ' + p.name : 'Add product', okLabel: p ? 'Save product' : 'Add product',
        fields: [
          { name: 'name', label: 'Name', type: 'text', required: true, value: p ? p.name : '' },
          { name: 'sku', label: 'SKU', type: 'text', value: p ? p.sku : '' },
          { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, value: p ? p.category : 'packaging' },
          { name: 'price', label: 'Price (MVR)', type: 'number', required: true, min: 0, step: 1, value: p ? p.price : '' },
          { name: 'unit', label: 'Sold per', type: 'text', value: p ? p.unit : 'piece', placeholder: 'pack, roll, box' },
          { name: 'stock', label: 'Stock', type: 'number', min: 0, step: 1, value: p && p.stock != null ? p.stock : '', hint: 'Leave empty for bundles and services with no stock' },
          { name: 'description', label: 'Description', type: 'textarea', rows: 2, value: p ? p.description : '' },
          { name: 'active', label: 'On sale', type: 'checkbox', value: p ? p.active !== false : true }] });
      if (!v) return;
      const patch = { name: v.name, sku: v.sku, category: v.category, price: Math.round(v.price), unit: v.unit, stock: v.stock == null ? null : Math.round(v.stock), description: v.description, active: v.active };
      if (p) await MDM.store.update('products', p.id, patch); else await MDM.store.insert('products', patch);
      await MDM.store.audit('product_updated', (p ? 'Updated product ' : 'Added product ') + v.name, by());
      toast(p ? 'Product saved' : v.name + ' added to the store');
    }
    async function restock(p) {
      const v = await MDM.ui.dialog({ title: 'Stock for ' + p.name, message: p.stock == null ? 'This product has no stock count.' : p.stock + ' in stock now.', okLabel: 'Save stock',
        fields: [{ name: 'change', label: 'Add or remove', type: 'number', step: 1, required: true, hint: 'For example 50 for a delivery from the supplier, or −2 for damaged items' }, { name: 'note', label: 'Note', type: 'text' }] });
      if (!v) return;
      const next = Math.max(0, (p.stock || 0) + Math.round(v.change));
      await MDM.store.update('products', p.id, { stock: next });
      await MDM.store.audit('product_updated', 'Stock ' + (v.change >= 0 ? '+' : '') + v.change + ' for ' + p.name + ' (' + next + ' left)' + (v.note ? ': ' + v.note : ''), by());
      toast(p.name + ': ' + next + ' in stock');
    }
    return { title: 'E-store', mount, unmount };
  })();
})(window.MDM);

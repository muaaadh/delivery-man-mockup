// Track an order (client requirements §7, §9, §11, §17, §18). Status is the primary content: the progress list follows MDM.FLOW
// (MDM.BULK_FLOW for bulk business packages) and ends with Payment; each reached step shows when and by whom. Below it: notices and
// actions (pay, request cancellation), the route with the live driver map, price (estimated until our team confirms it), payment,
// request details, documents and proof photos, and the public activity log. One async render() re-reads the order on every
// 'orders' change; the driver marker follows MDM.live.onPosition; a 5 s timer only re-evaluates staleness.
// Updates 17/10/2026: orders without a package photo are collected first and priced from the driver's photo (MDM.priceAfterCollection),
// extra collection and shop stops on one order, and Maldivian Cargo charges with their bill.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;

  const NO_MAP = ['requested', 'cancelled'];
  const ROUTE_LINE = ['assigned', 'dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery', 'failed', 'delivered', 'returned'];
  const ACTIVE = ['assigned', 'dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery', 'failed'];
  const LIVE = ['on_the_way', 'arrived', 'collected', 'out_for_delivery'];
  const TERMINAL = ['delivered', 'returned', 'cancelled'];
  const RECENT_S = 120, STALE_S = 15, LOST_S = 60;
  const VEHICLES = { bike: 'Bike', car: 'Car', pickup: 'Pickup truck' };
  const CHANNEL_ON = { sms: 'by SMS', whatsapp: 'on WhatsApp', viber: 'on Viber', email: 'by email' };
  const MEET_AT = { door: 'At the door', lobby: 'At the lobby', reception: 'At reception or security' };
  const DOC_KIND = { collection_doc: 'Collection document', invoice: 'Shop invoice', quotation: 'Quotation', payment_slip: 'Payment slip', document: 'Document' };
  // Web app updates §3, §6: labels for the delivery method details and the charge stage shown beside a billable charge.
  const BOAT_FIELD = { vesselType: 'Vessel', name: 'Boat', departureDate: 'Departure date', departureTime: 'Departure time', jetty: 'Jetty', island: 'Island', address: 'Destination address', contact: 'Contact' };
  const CHARGE_STAGE = { collection: 'at collection', delivery: 'at delivery' };
  const FIXED_FEES = ['airport', 'cargo', 'shopping'];
  const SIZE_ORDER = ['bag', 'box', 'xl'];

  const state = { settings: null, account: null, order: null, stops: [], driver: null, pos: null, posDriverId: null, unsubPos: null, timer: null, map: null, refs: null, share: false, code: '', isNew: false, receiver: false };
  let renderSeq = 0;
  let form, input, fieldEl, emptyEl, resultEl;

  const fmt = n => MDM.pricing.format(n);
  const fmtDate = (iso, o) => MDM.ui.fmtDate(iso, o);
  const fmtWhen = iso => (MDM.ui.dayKey(iso) === MDM.ui.dayKey(new Date()) ? MDM.ui.fmtTime(iso) : fmtDate(iso));
  const codeUrl = code => new URL(MDM.href('track/?code=' + encodeURIComponent(code)), location.href).href;
  function normCode(raw) {
    let c = String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, '');
    if (/^\d+$/.test(c)) c = 'MDM-' + c;
    if (/^MDM\d+$/.test(c)) c = 'MDM-' + c.slice(3);
    return c;
  }
  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }
  function posAge() { return state.pos && state.pos.at ? (Date.now() - Date.parse(state.pos.at)) / 1000 : Infinity; }
  function crossIsland(o) { return (o.packages || []).some(p => p.price && p.price.crossIsland); }
  function bankName(id) { const b = ((state.settings || {}).banks || []).find(x => x.id === id); return b ? b.name : (id === 'other' ? 'Other bank' : String(id || '')); }
  function handedWords(v) { return { family: ' (family or colleague)', security: ' (security or reception)' }[v] || ''; }
  const notice = (kind, title, body, opts) => MDM.ui.notice(kind, body, Object.assign({ title }, opts || {}));
  function section(id, title, ...body) { return el('section', { class: 'section', 'aria-labelledby': id }, el('div', { class: 'section-head' }, el('h2', { id }, title)), body); }
  const row = (label, value, opts) => MDM.ui.rateRow(label, value, opts);
  function badgeNode(kind, label, status) { return html(MDM.ui.badge(kind, label, { 'data-status': status })).firstElementChild; }
  const priceConfirmed = o => !!(o.pricing && o.pricing.status === 'confirmed');
  const extraShop = o => (o.extraCollections || []).some(c => c.kind === 'shop' && c.shop);
  const rangeText = (min, max) => (min === max ? fmt(min) : fmt(min) + ' to ' + fmt(max).replace('MVR ', ''));
  // The estimate the customer was given: { min, max } from order.estimate, or the current total for orders without one.
  function estimateOf(o) {
    const est = o.estimate || {}, t = o.totals.total;
    return est.min != null ? { min: est.min, max: est.max != null ? est.max : est.min } : { min: t, max: t };
  }
  const canPay = o => {
    const p = o.payment || {};
    if (p.method === 'invoice' || o.status === 'cancelled') return false;
    if (p.status === 'requested') return true;
    return p.status === 'pending' && priceConfirmed(o);
  };
  const vesselLabel = v => ((MDM.VESSEL_TYPES.find(x => x.value === v) || {}).label || 'Boat');
  const jettyLabel = v => ((MDM.geo.terminals().find(t => t.value === v) || {}).label || v || '');
  const pointLabel = v => ((MDM.geo.airportPoints().find(x => x.value === v) || {}).label || v || '');
  const dayText = d => (d ? fmtDate(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T12:00:00' : d, { dateOnly: true }) : '');
  const departText = (date, time) => [dayText(date), time].filter(Boolean).join(' at ');
  // The receiver's number is shown only by its last digits: anyone with the order code can open this page.
  function phoneTail(raw) { const n = MDM.ui.phone.normalize(raw) || String(raw || '').replace(/\D/g, ''); return n.length >= 4 ? 'phone ending ' + n.slice(-4) : ''; }
  const isBusinessCancel = o => !!((o.cancellation && o.cancellation.byBusiness) || String(o.cancelledBy || '').indexOf('business:') === 0);
  const businessName = o => (state.account && state.account.id === o.accountId && state.account.name) || (o.customer && o.customer.name) || 'the business';
  // A business order (§1.3, §5) is opened mostly by its receiver, from the label or the message with the code. The receiver never sees
  // the business's agreed rate or invoice amounts: only who arranged the delivery and the cash to pay the driver. The business itself
  // (signed in on this browser, localStorage mdm:business with the same accountId) still sees its prices.
  const isBusinessOrder = o => !!(o.accountId || o.service === 'business' || o.requestType === 'bulk' || o.requestType === 'business');
  function signedInBusiness() { try { const b = JSON.parse(localStorage.getItem('mdm:business') || 'null'); return b && b.accountId ? b.accountId : null; } catch (e) { return null; } }
  const receiverView = o => isBusinessOrder(o) && signedInBusiness() !== o.accountId;
  // Public events that carry the business's price, invoice or cash remittance are left out of the receiver's activity log.
  const RECEIVER_HIDDEN = ['price_confirmed', 'adjustment', 'size_updated', 'payment_requested', 'payment_submitted', 'payment_verified', 'payment_rejected', 'refund', 'settled', 'cod_remitted', 'cancel_requested', 'cancel_rejected'];
  const tierLabel = v => { const t = MDM.pricing.businessTiers(state.settings).find(x => x.value === v); return t ? t.label + ' (' + MDM.pricing.sizeLabel(t.size) + ')' : String(v || ''); };
  const who = by => { const n = String(MDM.byName(by) || ''); return n.charAt(0).toUpperCase() + n.slice(1); };
  // Cash on delivery as the receiver sees it: to pay, paid (whatever the office did with it afterwards), or not collected.
  function codText(o, forReceiver) {
    const cod = o.cod;
    if (!cod || !(cod.amount > 0)) return '';
    const got = cod.collectedAmount != null ? cod.collectedAmount : cod.amount;
    if (cod.status === 'pending') return fmt(cod.amount) + ' to pay the driver in cash';
    if (cod.status === 'not_collected') return fmt(cod.amount) + ', not collected' + (o.status === 'cancelled' ? ' (order cancelled)' : '');
    return fmt(got) + (forReceiver ? ' paid in cash' : ' collected') + (cod.collectedAt ? ' on ' + fmtDate(cod.collectedAt) : '');
  }
  // Package category changes made by our team (operator or driver), from the order's change log: [{ n, pkgId, from, to, at, by }].
  function sizeChanges(o) {
    const idx = {};
    (o.packages || []).forEach((p, i) => { idx[p.id] = i + 1; });
    return (o.changes || []).map(c => { const m = /^package (.+) size$/.exec(c.field || ''); return m && c.from !== c.to ? { n: idx[m[1]], pkgId: m[1], from: c.from, to: c.to, at: c.at, by: c.by } : null; }).filter(Boolean);
  }
  // Fee rows the customer sees: airport, cargo and shopping fees, then price adjustments (extra vehicle, billable charges). A charge is on
  // the price only while it is billable; a voided or non-billable charge (naalu the driver paid, by default) is never listed (§6).
  function feeRows(o) {
    const adjs = {}, charges = o.charges || [];
    ((o.fees || {}).adjustments || []).forEach(a => { adjs[a.id] = a; });
    return MDM.pricing.feeLines(o, state.settings).map(f => {
      if (f.key !== 'adjustment') return f;
      const a = adjs[f.id] || {};
      const ch = charges.find(c => (a.chargeId && c.id === a.chargeId) || (c.adjustmentId && c.adjustmentId === a.id));
      if (ch && (ch.void || !ch.billable)) return null;
      if (ch && ch.type === 'cargo') { const ref = String(ch.description || '').replace(/^maldivian cargo bill\s*/i, '').trim(); return Object.assign({}, f, { key: 'charge-cargo', reason: 'From the Maldivian Cargo bill' + (ref ? ', ' + ref : '') }); }
      if (ch) return Object.assign({}, f, { key: 'charge-' + ch.type, reason: [ch.type !== 'other' ? ch.description : '', CHARGE_STAGE[ch.stage]].filter(Boolean).join(', ') });
      if (a.preset === 'vehicle') return Object.assign({}, f, { key: 'vehicle', reason: a.remarks || '' });
      return f;
    }).filter(Boolean);
  }

  // ---- Loading ------------------------------------------------------------------------------------------------------------
  async function loadFromUrl() {
    const q = new URLSearchParams(location.search);
    const id = q.get('order'), code = q.get('code');
    state.isNew = q.get('new') === '1';
    if (id) {
      const o = await MDM.store.get('orders', id) || await MDM.store.orderByCode(id);
      if (o) { input.value = o.code; return setOrder(o); }
      return showEmpty(code ? normCode(code) : '');
    }
    if (code) { input.value = normCode(code); return track(normCode(code), false); }
    return null;
  }
  async function track(code, push) {
    state.code = code;
    const o = await MDM.store.orderByCode(code);
    if (push) history.replaceState(null, '', location.pathname + '?code=' + encodeURIComponent(code));
    if (!o) return showEmpty(code);
    return setOrder(o, push);
  }
  function showEmpty(code) {
    clearOrder();
    emptyEl.replaceChildren(el('div', { class: 'empty', 'data-testid': 'track-empty' },
      el('div', { class: 'empty__title' }, code ? 'No order with the code ' + code + '.' : 'No order matches this link.'),
      el('div', { class: 'empty__hint' }, 'Check the code in your confirmation message.')));
    emptyEl.hidden = false;
    form.hidden = false;
    document.title = 'Track an order · Mr. Delivery Man';
  }
  async function setOrder(o, focus) {
    state.order = o; state.code = o.code;
    emptyEl.hidden = true; emptyEl.replaceChildren();
    if (!state.timer) state.timer = setInterval(updateLive, 5000);
    document.title = 'Track ' + o.code + ' · Mr. Delivery Man';
    await render();
    if (focus) { try { resultEl.focus({ preventScroll: true }); } catch (e) { /* focus is a courtesy */ } }
  }
  function clearOrder() {
    state.order = null; state.refs = null; state.stops = []; state.driver = null; state.share = false;
    watchDriver(null);
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    destroyMap();
    resultEl.hidden = true; resultEl.replaceChildren();
  }
  function trackAnother() {
    clearOrder();
    emptyEl.hidden = true; emptyEl.replaceChildren();
    history.replaceState(null, '', location.pathname);
    document.title = 'Track an order · Mr. Delivery Man';
    form.hidden = false; input.value = ''; MDM.ui.setError(fieldEl, null);
    input.focus();
  }

  // ---- Driver position feed -----------------------------------------------------------------------------------------------
  async function watchDriver(driverId) {
    if (driverId === state.posDriverId) return;
    if (state.unsubPos) { state.unsubPos(); state.unsubPos = null; }
    state.posDriverId = driverId; state.pos = null;
    if (!driverId) return;
    state.unsubPos = MDM.live.onPosition(driverId, onPosition);
    const p = MDM.live.last(driverId) || await MDM.store.get('positions', driverId);
    if (state.posDriverId === driverId && p && !state.pos) state.pos = p;
  }
  function onPosition(pos) {
    if (!pos || pos.driverId !== state.posDriverId) return;
    state.pos = pos;
    if (state.map && state.map.driver) state.map.driver.moveTo(pos, 1000);
    syncMarker();
    updateLive();
  }

  // ---- Map ----------------------------------------------------------------------------------------------------------------
  // mountMap() only places the box in the new tree; the MapLibre instance is created by syncMap() once the tree is attached.
  function mountMap(container) {
    const o = state.order;
    if (state.map && state.map.orderId !== o.id) destroyMap();
    if (!state.map) {
      const box = el('div', { class: 'map', role: 'region', 'aria-label': 'Route map' });
      const overlay = el('div', { class: 'map__overlay' },
        el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'track-recenter', on: { click: fitAll } }, html(MDM.icon('locate', 16)), 'Recenter'));
      box.appendChild(overlay);
      state.map = { el: box, overlay, map: null, creating: false, orderId: o.id, route: null, stops: null, driver: null, fitted: false };
    }
    container.appendChild(state.map.el);
  }
  function syncMap() {
    const m = state.map;
    if (!m) return;
    if (m.map) { MDM.map.refresh(m.map); drawMap(); return; }
    if (m.creating) return;
    m.creating = true;
    MDM.map.create(m.el, { center: MDM.geo.CENTER }).then(map => {
      if (state.map !== m) { MDM.map.destroy(map); return; }
      m.map = map; MDM.map.refresh(map); drawMap();
    }).catch(() => {
      if (state.map !== m) return;
      m.overlay.hidden = true;
      MDM.ui.mapFallback(m.el);
    });
  }
  function drawMap() {
    const m = state.map, o = state.order;
    if (!m || !m.map || !o) return;
    const line = ROUTE_LINE.indexOf(o.status) >= 0 && o.route && Array.isArray(o.route.polyline) && o.route.polyline.length >= 2 ? o.route.polyline : [];
    if (line.length) { if (m.route) m.route.update(line); else m.route = MDM.map.route(m.map, 'track-route', line, { active: true }); }
    else if (m.route) { m.route.remove(); m.route = null; }
    if (m.stops) m.stops.update(state.stops); else m.stops = MDM.map.stopMarkers(m.map, state.stops);
    syncMarker();
    if (!m.fitted) { m.fitted = true; fitAll(); }
  }
  function markerWanted() {
    const o = state.order;
    if (!o || !state.pos || !state.driver) return false;
    if (LIVE.indexOf(o.status) >= 0) return true;
    if (o.status === 'assigned' || o.status === 'dispatched' || o.status === 'failed') return posAge() <= RECENT_S;
    return false;
  }
  function syncMarker() {
    const m = state.map;
    if (!m || !m.map) return;
    const want = markerWanted();
    if (want && !m.driver) m.driver = MDM.map.driverMarker(m.map, state.pos, state.driver);
    else if (!want && m.driver) { m.driver.remove(); m.driver = null; }
    if (m.driver) m.driver.setStale(posAge() > LOST_S);
  }
  function fitAll() {
    const m = state.map;
    if (!m || !m.map) return;
    const pts = state.stops.map(s => [s.lat, s.lng]);
    if (m.driver && state.pos) pts.push([state.pos.lat, state.pos.lng]);
    MDM.map.fit(m.map, pts, { padding: 48, maxZoom: 15 });
  }
  function panToStop(s) { if (state.map && state.map.map && s.lat != null) MDM.map.panTo(state.map.map, [s.lat, s.lng]); }
  function destroyMap() {
    const m = state.map;
    if (!m) return;
    state.map = null;
    if (m.driver) m.driver.remove();
    if (m.map) MDM.map.destroy(m.map);
    m.el.remove();
  }

  // ---- Live text: ETA, staleness, "Updated … ago" ---------------------------------------------------------------------------
  function updateLive() {
    const o = state.order, r = state.refs;
    if (!o || !r) return;
    const pos = state.pos, age = posAge();
    let eta = '';
    if (LIVE.indexOf(o.status) >= 0 && pos) {
      if (age <= LOST_S) {
        const km = MDM.geo.remainingKm(o.route && o.route.polyline || [], pos);
        const min = MDM.geo.etaMinutes(km, crossIsland(o), state.settings);
        eta = (o.status === 'out_for_delivery' ? 'Estimated arrival ' : 'Driver expected at collection by ') + MDM.ui.fmtTime(new Date(Date.now() + min * 60000));
      } else eta = 'Driver location unavailable right now';
    }
    setText(r.eta, eta);
    setText(r.updated, 'Updated ' + MDM.ui.timeAgo(o.updatedAt));
    if (r.posAge) setText(r.posAge, pos && age > STALE_S ? 'Updated ' + MDM.ui.timeAgo(pos.at, { seconds: true }) : '');
    if (r.source) {
      const want = !pos ? 'none' : pos.source === 'gps' ? 'gps' : 'sim';
      if (r.source.dataset.status !== want) {
        const next = want === 'none' ? badgeNode('neutral', 'Not sharing yet', 'none') : want === 'gps' ? badgeNode('ok', 'GPS', 'gps') : badgeNode('neutral', 'Demo', 'sim');
        r.source.replaceWith(next); r.source = next;
      }
    }
    syncMarker();
  }

  // ---- Render -------------------------------------------------------------------------------------------------------------
  async function render() {
    const seq = ++renderSeq;
    const current = state.order;
    if (!current) return;
    const o = await MDM.store.get('orders', current.id);
    if (seq !== renderSeq) return;
    if (!o) return showEmpty(current.code);
    state.order = o;
    state.settings = await MDM.store.settings();
    const stops = o.route && o.route.stops && o.route.stops.length ? o.route.stops : (o.status === 'cancelled' ? [] : await MDM.store.buildStops(o));
    const driver = o.driverId ? await MDM.store.get('drivers', o.driverId) : null;
    const account = o.accountId ? await MDM.store.get('business_accounts', o.accountId) : null;
    const ids = new Set();
    stops.forEach(s => { [s.photoId, s.proofPhotoId].forEach(id => { if (id) ids.add(id); }); });
    (o.packages || []).forEach(p => { if (p.photoId) ids.add(p.photoId); });
    (o.documents || []).forEach(d => { if (d.fileId) ids.add(d.fileId); });
    (o.charges || []).forEach(c => { if (c.photoId && !c.void) ids.add(c.photoId); });
    const files = {};
    for (const id of ids) files[id] = await MDM.store.get('files', id);
    await watchDriver(driver ? o.driverId : null);
    if (seq !== renderSeq) return;
    state.stops = stops; state.driver = driver; state.account = account;
    state.receiver = receiverView(o);
    const refs = {};
    const parts = [buildHead(o, refs), buildNotices(o, stops), buildProgress(o)];
    if (NO_MAP.indexOf(o.status) < 0 || stops.length) parts.push(buildRoute(o, stops));
    else destroyMap();
    if (driver) parts.push(buildDriver(o, driver, refs));
    const collections = buildCollections(o);
    if (collections) parts.push(collections);
    parts.push(buildDelivery(o));
    if (state.receiver) parts.push(buildArranged(o));
    else parts.push(buildPrice(o), buildPayment(o));
    const details = buildDetails(o);
    if (details) parts.push(details);
    const proofs = buildProofs(o, stops, files);
    if (proofs) parts.push(proofs);
    parts.push(buildTimeline(o));
    resultEl.replaceChildren(...parts);
    state.refs = refs;
    resultEl.hidden = false; form.hidden = true;
    syncMap();
    updateLive();
  }

  // '1 × Bag, 2 × Box': the packages by size category.
  function pkgText(o) {
    const counts = {};
    (o.packages || []).forEach(p => { counts[p.size] = (counts[p.size] || 0) + 1; });
    return Object.keys(counts).sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b)).map(k => counts[k] + ' × ' + MDM.pricing.sizeLabel(k)).join(', ');
  }
  function summaryLine(o) {
    const pk = pkgText(o);
    const parts = [MDM.requestTypeLabel(o.requestType)];
    if (o.serviceLevel === 'express') parts.push('Express');
    if (pk) parts.push(pk);
    parts.push(MDM.geo.zoneShort((o.collection || {}).zone) + ' to ' + MDM.geo.zoneShort((o.delivery || {}).zone));
    const d = o.delivery || {};
    if (d.method === 'boat') parts.push(vesselLabel((d.boat || {}).vesselType).replace(' (dhoni)', '') + ((d.boat || {}).island ? ' to ' + d.boat.island : ''));
    else if (d.method === 'cargo') parts.push('Maldivian Cargo' + ((d.cargo || {}).island ? ' to ' + d.cargo.island : ''));
    else if (d.method === 'airport') parts.push('Airport delivery' + ((d.airport || {}).resort ? ' for ' + d.airport.resort : ''));
    const s = o.schedule || {};
    if (s.type === 'advance' && s.collectDate) parts.push('collect ' + fmtDate(s.collectDate, { dateOnly: true }) + ' ' + (s.collectTime || ''));
    return parts.join(' · ');
  }
  function buildHead(o, refs) {
    const url = codeUrl(o.code);
    const s = state.settings || {}, contact = s.contact || {};
    const badge = html(MDM.badgeFor(o.status, { customer: true })).firstElementChild;
    badge.setAttribute('data-testid', 'track-status');
    refs.eta = el('span', { class: 'track-eta', 'data-testid': 'track-eta' });
    refs.updated = el('span', { class: 'track-head__updated' });
    const recipient = { name: (o.delivery || {}).recipientName, phone: (o.delivery || {}).recipientPhone };

    const copyLabel = el('span', null, 'Copy tracking link');
    const copyBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'track-copy', on: { click: async () => {
      const ok = await MDM.ui.copy(url);
      if (ok) { setText(copyLabel, 'Copied'); setTimeout(() => setText(copyLabel, 'Copy tracking link'), 1500); }
      else MDM.ui.toast('Could not copy. The link is ' + url, 'warn');
    } } }, html(MDM.icon('link', 16)), copyLabel);
    const shareText = 'Track my Mr. Delivery Man delivery ' + o.code + ': ' + url;
    const recLinks = recipient.phone ? MDM.ui.phone.links(recipient.phone, shareText) : null;
    const waHref = recLinks ? recLinks.wa : 'https://wa.me/?text=' + encodeURIComponent(shareText);
    const shareRow = el('div', { class: 'track-share', id: 'track-share', hidden: !state.share },
      el('span', null, recipient.name ? 'Send the tracking link to ' + recipient.name + ':' : 'Send the tracking link:'),
      el('a', { class: 'btn btn--secondary btn--sm', href: waHref, target: '_blank', rel: 'noopener', 'data-testid': 'track-share-whatsapp' }, 'WhatsApp'),
      el('a', { class: 'btn btn--secondary btn--sm', href: 'viber://forward?text=' + encodeURIComponent(shareText), 'data-testid': 'track-share-viber' }, 'Viber'));
    const shareBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'track-share', 'aria-expanded': state.share ? 'true' : 'false', 'aria-controls': 'track-share',
      on: { click: () => { state.share = !state.share; shareRow.hidden = !state.share; shareBtn.setAttribute('aria-expanded', state.share ? 'true' : 'false'); } } },
      html(MDM.icon('share', 16)), 'Share');
    const callLinks = contact.phone ? MDM.ui.phone.links(contact.phone) : null;
    const callBtn = callLinks ? el('a', { class: 'btn btn--secondary', href: callLinks.tel, 'data-testid': 'track-call-us' }, html(MDM.icon('phone', 16)), 'Call us') : null;
    const another = el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'track-another', on: { click: trackAnother } }, 'Track another order');
    const priority = o.priority && o.priority.status === 'approved' && o.priority.level !== 'normal'
      ? html(MDM.ui.badge('danger', (MDM.PRIORITY_LEVELS.find(x => x.value === o.priority.level) || {}).label || 'Priority', { 'data-testid': 'track-priority-badge' })).firstElementChild : null;

    return el('div', { class: 'track-head' },
      el('div', { class: 'track-head__back' }, another),
      el('div', { class: 'track-head__row' }, el('div', { class: 'track-head__live', 'aria-live': 'polite' }, badge, priority, refs.eta), refs.updated),
      el('div', { class: 'track-head__code mono', 'data-testid': 'track-code' }, o.code),
      el('p', { class: 'track-head__summary' }, summaryLine(o)),
      el('div', { class: 'track-head__actions' }, copyBtn, callBtn, shareBtn),
      shareRow);
  }

  // ---- Notices and actions --------------------------------------------------------------------------------------------------
  async function askCancel(o) {
    const v = await MDM.ui.dialog({ title: 'Request cancellation', message: 'We review it straight away. Once the package is collected it can no longer be cancelled here.',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', rows: 2, required: true, requiredMessage: 'Tell us why, so we can help' }],
      okLabel: 'Send request', cancelLabel: 'Keep my order' });
    if (!v) return;
    try { await MDM.store.requestCancel(o.id, { reason: v.reason, by: 'customer' }); MDM.ui.toast('Cancellation requested. We will confirm shortly.', 'ok'); }
    catch (e) { MDM.ui.toast(e && e.code === 'transition' ? 'The package is already collected. Call us and we will sort it out.' : 'Could not send the request. Try again.', 'danger'); }
  }
  function payButton(o, label) {
    return el('a', { class: 'btn btn--brand', href: MDM.href('checkout/?order=' + encodeURIComponent(o.id)), 'data-testid': 'track-pay' }, label || 'Pay ' + fmt(o.totals.total));
  }
  function buildNotices(o, stops) {
    const s = state.settings || {}, ops = s.ops || {};
    const channelOn = CHANNEL_ON[o.customer && o.customer.notify] || CHANNEL_ON.whatsapp;
    const p = o.payment || {};
    const items = [];
    const actions = [];
    const priceAfter = MDM.priceAfterCollection(o) && !state.receiver;
    if (state.isNew && o.status === 'requested') items.push(notice('ok', 'Request sent', 'Your order code is ' + o.code + '. Keep it to track this delivery. We message you ' + channelOn + (priceAfter ? ' when a driver is on the way, and again with the final price after collection.' : ' once the price is confirmed.'), { testid: 'track-new' }));
    switch (o.status) {
      case 'requested': {
        if (state.receiver) { items.push(notice('info', 'Delivery booked by ' + businessName(o), 'We confirm the booking and assign a driver.')); break; }
        const est = estimateOf(o), range = rangeText(est.min, est.max);
        // No package photo: a driver collects first and our team prices it from the driver's photo (updates 17/10/2026).
        if (priceAfter) { items.push(notice('info', 'We collect first, then confirm your price', 'Estimated ' + range + '. You did not add a package photo, so our driver photographs the package at collection and our team confirms the final price while it is on the way. Nothing to pay until then.', { testid: 'track-price-after' })); break; }
        const photo = (o.packages || []).some(x => x.photoId);
        items.push(notice('warn', 'We are confirming your price', 'Estimated ' + range + '. ' + (photo ? 'We are checking your package photo' : 'Our team checks the details') + (ops.reviewText ? ', usually within ' + ops.reviewText : '') + ', then message you ' + channelOn + '.'));
        break;
      }
      case 'confirmed':
        if (state.receiver) { items.push(notice('info', 'Order confirmed', 'We are assigning a driver.')); break; }
        items.push(notice('info', 'Order confirmed', 'Final price ' + fmt(o.totals.total) + '. We are assigning a driver' + (o.schedule && o.schedule.type === 'advance' ? ' for your booked time' : '') + '.'));
        break;
      case 'assigned': case 'dispatched':
        items.push(notice('info', null, o.status === 'assigned' ? 'A driver is assigned. You will see them on the map once they set off.' : 'Your driver has the job and sets off shortly.'));
        break;
      case 'on_the_way': case 'arrived':
        items.push(notice('info', null, o.status === 'arrived' ? 'The driver is at the collection point.' : 'The driver is on the way to collect.'));
        break;
      case 'collected': case 'out_for_delivery':
        items.push(notice('info', null, o.status === 'collected' ? 'Collected. The driver photographed the package as proof of collection.' : 'Your package is out for delivery.'));
        break;
      case 'failed': {
        const failed = stops.find(x => x.status === 'failed');
        const r = failed ? MDM.FAIL_REASONS.find(x => x.value === failed.failReason) : null;
        items.push(notice('danger', 'There was a problem', (failed ? (failed.type === 'pickup' ? 'Collection' : 'Delivery') + ' could not be completed' : 'A stop could not be completed') + (r ? ' (' + r.label.toLowerCase() + ')' : '') + '. We will contact you ' + channelOn + ' to reschedule.'));
        break;
      }
      case 'returned':
        items.push(notice('info', null, 'We could not deliver this package, so it went back to the sender.'));
        break;
      case 'delivered':
        if (priceAfter) items.push(notice('info', 'We are confirming the final price', 'Delivered. Our team is confirming the final price from the driver\'s photo; your invoice follows ' + channelOn + '.', { testid: 'track-price-after' }));
        break;
      case 'cancelled': {
        // A business cancelled one of its orders (§5.5): after collection the package goes back to the sender.
        if (isBusinessCancel(o)) {
          const c0 = o.cancellation || {}, why = o.cancelReason || c0.reason;
          const body = [why ? 'Reason: ' + why + '.' : '',
            c0.returnStatus === 'pending' ? 'The package was already with us, so it is being returned to the sender.' : '',
            c0.returnStatus === 'done' ? 'Returned to the sender' + (c0.returnedAt ? ' on ' + fmtDate(c0.returnedAt) : '') + '.' : ''].filter(Boolean).join(' ');
          items.push(notice('danger', 'Cancelled by ' + businessName(o), body || 'This delivery will not go ahead.', { testid: 'track-business-cancel' }));
          break;
        }
        const refund = p.refund;
        let body = (o.cancelledBy === 'customer' || (o.cancellation && o.cancellation.status === 'approved') ? 'Cancelled at your request' : 'We cancelled this order') + (o.cancelReason ? ': ' + o.cancelReason : '') + '.';
        if (refund) body += ' ' + fmt(refund.amount) + ' was sent to ' + (bankName(refund.toBank) || 'your bank') + (refund.at ? ' on ' + fmtDate(refund.at, { time: false }) : '') + '.';
        else if (p.status === 'paid') body += ' We will contact you ' + channelOn + ' about your refund.';
        items.push(notice('danger', refund ? 'Cancelled, refund sent' : 'Cancelled', body));
        break;
      }
      default: break;
    }
    // Extra vehicle (§2.3): the customer asked for it; our team confirms the charge with the price.
    if (o.extraVehicle && !priceConfirmed(o) && o.status !== 'cancelled' && !state.receiver) items.push(notice('info', 'Extra vehicle requested, charge confirmed by our team', 'More than one box or XL package can need a second vehicle. We add the vehicle charge when we confirm your price, ' + (priceAfter ? 'after collection.' : 'before collection.'), { testid: 'track-extra-vehicle' }));
    // Cash on delivery on a business order (§5.6): the receiver pays the driver.
    const cod = o.cod;
    if (cod && cod.amount > 0 && cod.status === 'pending' && TERMINAL.indexOf(o.status) < 0) items.push(state.receiver
      ? notice('warn', 'Pay ' + fmt(cod.amount) + ' in cash to the driver', 'Cash on delivery for ' + businessName(o) + '. Have ' + fmt(cod.amount) + ' ready in cash when the package arrives.', { testid: 'track-cod' })
      : notice('warn', 'Cash on delivery ' + fmt(cod.amount), 'The receiver pays the driver ' + fmt(cod.amount) + ' in cash when the package is delivered.', { testid: 'track-cod' }));
    // Cancellation request (requirements §9)
    const c = o.cancellation || {};
    if (c.status === 'requested') items.push(notice('warn', 'Cancellation requested', 'We received your request' + (c.reason ? ' (' + c.reason + ')' : '') + ' and will confirm shortly.', { testid: 'track-cancel-pending' }));
    else if (c.status === 'rejected') items.push(notice('warn', 'Cancellation declined', (c.remarks || 'The order is already on its way') + '. Call us if you need help.', { testid: 'track-cancel-declined' }));
    // Priority (requirements §11)
    const pr = o.priority || {};
    if (pr.status === 'requested') items.push(notice('info', o.serviceLevel === 'express' ? 'Express requested' : 'Priority requested', 'Our team confirms whether we can take it' + (o.serviceLevel === 'express' ? ' as express' : ' with priority') + '.', { testid: 'track-priority' }));
    else if (pr.status === 'rejected') items.push(notice('warn', 'Priority not available', ((pr.requests || []).slice(-1)[0] || {}).remarks || 'We will deliver on the normal schedule.', { testid: 'track-priority' }));
    // Payment prompt
    if (p.status === 'requested' && p.rejectReason) items.push(notice('danger', 'We could not match your transfer', p.rejectReason + '. Upload the slip again.'));
    if (canPay(o) && p.status === 'requested') actions.push(payButton(o, 'Pay ' + fmt(o.totals.total)));
    if (MDM.CANCELLABLE.indexOf(o.status) >= 0 && c.status !== 'requested' && o.payment.method !== 'invoice')
      actions.push(el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'track-cancel', on: { click: () => askCancel(o) } }, 'Request cancellation'));
    if (actions.length) items.push(el('div', { class: 'track-actions' }, actions));
    return el('div', { class: 'track-notices' }, items);
  }

  // ---- Progress: the status flow plus payment (requirements §7) --------------------------------------------------------------
  function buildProgress(o) {
    const flow = o.batchId || o.requestType === 'bulk' ? MDM.BULK_FLOW : MDM.FLOW;
    const hist = o.statusHistory || [];
    const reached = {};
    hist.forEach(h => { reached[h.to] = h; });
    const at = MDM.FLOW.indexOf(o.status);
    const stopped = ['failed', 'returned', 'cancelled'].indexOf(o.status) >= 0;
    // The furthest flow step reached, also for failed/cancelled orders (their last flow status in the history).
    let furthest = at;
    if (furthest < 0) hist.forEach(h => { const i = MDM.FLOW.indexOf(h.to); if (i > furthest) furthest = i; });
    const items = flow.map(st => {
      const i = MDM.FLOW.indexOf(st);
      const h = reached[st];
      const done = h || (i >= 0 && i < furthest) || (i === furthest && furthest >= 0);
      const current = !stopped && st === o.status;
      const cls = ['timeline__item', current ? 'is-current' : done ? 'is-done' : 'is-upcoming'];
      return el('li', { class: cls, 'data-status': st, 'data-testid': 'track-step' },
        el('div', { class: 'timeline__label' }, MDM.STATUS[st].customer),
        h ? el('div', { class: 'timeline__time' }, fmtDate(h.at) + ' · ' + who(h.by)) : null);
    });
    if (stopped) {
      const h = reached[o.status];
      const cut = Math.max(0, flow.indexOf(MDM.FLOW[furthest]) + 1);
      // A cancelled or returned order ends here; a failed one can still resume, so its remaining steps stay listed.
      if (o.status !== 'failed') items.splice(cut);
      items.splice(cut, 0, el('li', { class: 'timeline__item is-current track-step--stop', 'data-status': o.status, 'data-testid': 'track-step' },
        el('div', { class: 'timeline__label' }, MDM.STATUS[o.status].customer), h ? el('div', { class: 'timeline__time' }, fmtDate(h.at) + ' · ' + who(h.by)) : null));
      const ret = (o.cancellation || {}).returnStatus;
      if (o.status === 'cancelled' && (ret === 'pending' || ret === 'done')) {
        const cx = o.cancellation;
        items.splice(cut + 1, 0, el('li', { class: ['timeline__item', ret === 'done' ? 'is-done' : 'is-upcoming'], 'data-status': 'return', 'data-testid': 'track-step' },
          el('div', { class: 'timeline__label' }, ret === 'done' ? 'Returned to the sender' : 'Being returned to the sender'),
          ret === 'done' && cx.returnedAt ? el('div', { class: 'timeline__time' }, fmtDate(cx.returnedAt) + (cx.returnedBy ? ' · ' + who(cx.returnedBy) : '')) : null));
      }
    }
    const p = o.payment || {};
    if (state.receiver) {
      // The receiver's only payment is the cash on delivery; the delivery itself is on the business's account.
      const cod = o.cod;
      if (cod && cod.amount > 0 && !(o.status === 'cancelled' && cod.status === 'not_collected')) {
        const paid = ['collected', 'with_office', 'remitted'].indexOf(cod.status) >= 0;
        items.push(el('li', { class: ['timeline__item', paid ? 'is-done' : 'is-upcoming'], 'data-status': 'payment', 'data-testid': 'track-step' },
          el('div', { class: 'timeline__label' }, paid ? 'Cash paid to the driver' : cod.status === 'not_collected' ? 'Cash on delivery not collected' : 'Cash on delivery ' + fmt(cod.amount)),
          paid && cod.collectedAt ? el('div', { class: 'timeline__time' }, fmtDate(cod.collectedAt)) : null));
      }
      return section('track-progress-h', 'Progress', el('ol', { class: 'timeline track-progress', 'data-testid': 'track-progress' }, items));
    }
    const payDone = p.status === 'paid' || p.status === 'refunded';
    const payCurrent = p.status === 'requested' || p.status === 'received';
    const payLabel = p.method === 'invoice' ? 'Payment on the monthly invoice' : 'Payment';
    items.push(el('li', { class: ['timeline__item', payDone ? 'is-done' : payCurrent ? 'is-current' : 'is-upcoming'], 'data-status': 'payment', 'data-testid': 'track-step' },
      el('div', { class: 'timeline__label' }, payLabel, ' ', html(MDM.payBadge(p.status))),
      p.verifiedAt && payDone ? el('div', { class: 'timeline__time' }, fmtDate(p.verifiedAt)) : null));
    return section('track-progress-h', 'Progress', el('ol', { class: 'timeline track-progress', 'data-testid': 'track-progress' }, items));
  }

  function buildRoute(o, stops) {
    const withMap = NO_MAP.indexOf(o.status) < 0;
    const clickable = withMap && MDM.map.available();
    const active = ACTIVE.indexOf(o.status) >= 0;
    const current = active ? stops.findIndex(x => x.status === 'arrived' || x.status === 'pending') : -1;
    const rows = stops.map((x, i) => {
      const isCurrent = active && i === current;
      const cls = ['stop', 'stop--' + x.type, x.status === 'done' ? 'is-done' : x.status === 'failed' ? 'is-failed' : isCurrent ? 'is-current' : ''];
      const kind = x.type === 'pickup' ? (x.shop ? 'Shop' : 'Collection') : x.type === 'return' ? 'Return to sender' : 'Delivery';
      const meta = [kind + ' · ' + MDM.geo.zoneLabel(x.zone)];
      if (x.landmark) meta.push(x.landmark);
      if (x.meetAt && MEET_AT[x.meetAt]) meta.push(MEET_AT[x.meetAt]);
      if (x.type !== 'pickup' && x.contact && x.contact.name) meta.push('Recipient ' + x.contact.name);
      if (x.cargo && x.cargo.boat) meta.push('Boat ' + x.cargo.boat + (x.cargo.time ? ', ' + x.cargo.time : ''));
      const aside = x.status === 'done' ? fmtWhen(x.at) : x.status === 'failed' ? "Couldn't complete" : x.status === 'skipped' ? 'Skipped' : o.status === 'cancelled' ? 'Cancelled' : x.status === 'arrived' ? 'Driver arrived' : isCurrent ? 'Next' : 'Pending';
      const shopName = x.shop ? String(x.label || '').replace(/^Shop: /, '') : '';
      const title = shopName ? (x.address && x.address.indexOf(shopName) === 0 ? x.address : shopName + (x.address && x.address !== shopName ? ' · ' + x.address : '')) : x.address;
      const attrs = { class: cls, 'data-testid': 'track-stop', dataset: { stopId: x.id, status: x.status } };
      if (clickable) { attrs.type = 'button'; attrs.on = { click: () => panToStop(x) }; attrs['aria-label'] = 'Show ' + kind.toLowerCase() + ' on the map: ' + x.address; }
      return el(clickable ? 'button' : 'div', attrs,
        el('span', { class: 'stop__marker', 'aria-hidden': 'true' }, String(i + 1)),
        el('span', { class: 'stop__main' }, el('span', { class: 'stop__title' }, title), el('span', { class: 'stop__meta' }, meta.join(' · '))),
        el('span', { class: 'stop__aside' }, aside));
    });
    const body = [];
    if (withMap) { const holder = el('div', { class: 'track-map-holder' }); mountMap(holder); body.push(holder); }
    else destroyMap();
    body.push(el('div', { class: 'stops', 'data-testid': 'track-stops' }, rows));
    return section('track-route-h', 'Route', body);
  }

  function buildDriver(o, d, refs) {
    const active = ACTIVE.indexOf(o.status) >= 0;
    const links = d.phone ? MDM.ui.phone.links(d.phone) : null;
    const rows = [row('Driver', d.name), row('Vehicle', (VEHICLES[d.vehicle] || d.vehicle || '') + (d.vehicleNote ? ' · ' + d.vehicleNote : ''))];
    if (active) {
      refs.source = badgeNode('neutral', 'Not sharing yet', 'none');
      refs.posAge = el('span', { class: 'small muted', 'data-testid': 'track-pos-age' });
      rows.push(row('Live location', el('span', { class: 'row row--wrap' }, refs.source, refs.posAge)));
    }
    if (links && active) rows.push(row('Phone', el('a', { class: 'btn btn--secondary btn--sm', href: links.tel, 'data-testid': 'track-call-driver' }, html(MDM.icon('phone', 16)), 'Call driver')));
    return section('track-driver-h', 'Your driver', el('div', { class: 'card', 'data-testid': 'track-driver' }, el('div', { class: 'rate-table' }, rows)));
  }

  // ---- Delivery method and its details (web app updates §3) ---------------------------------------------------------------------
  function boatChangeText(h) {
    const val = (k, v) => {
      if (v == null || v === '') return 'not set';
      if (k === 'vesselType') return vesselLabel(v);
      if (k === 'jetty') return jettyLabel(v);
      if (k === 'departureDate') return dayText(v);
      if (k === 'contact') return MDM.ui.phone.format(v) || v;
      return String(v);
    };
    return Object.keys(h.to || {}).map(k => (BOAT_FIELD[k] || k) + ': ' + val(k, (h.from || {})[k]) + ' to ' + val(k, h.to[k])).join(' · ');
  }
  // Extra collection points on one order (updates 17/10/2026): everything is packed together and delivered to the one address.
  function buildCollections(o) {
    const extra = o.extraCollections || [];
    if (!extra.length) return null;
    const c0 = o.collection || {};
    const rows = [row('Collection 1', [c0.address, c0.zone ? MDM.geo.zoneLabel(c0.zone) : ''].filter(Boolean).join(', '), { valueSub: c0.contactName || null })];
    extra.forEach((c, i) => {
      const where = [c.address, c.zone ? MDM.geo.zoneLabel(c.zone) : ''].filter(Boolean).join(', ');
      if (c.kind === 'shop' && c.shop) rows.push(row('Shop: ' + (c.shop.name || 'shop'), where, { valueSub: [c.shop.list, c.shop.budget ? 'budget ' + fmt(c.shop.budget) : ''].filter(Boolean).join(' · ') || null }));
      else rows.push(row('Collection ' + (i + 2), where, { valueSub: [c.contactName, c.instructions].filter(Boolean).join(' · ') || null }));
    });
    return section('track-collections-h', 'Collections', el('div', { class: 'rate-table', 'data-testid': 'track-collections' }, rows),
      el('p', { class: 'track-summary-note small muted' }, 'Everything is packed together and delivered to one address.'));
  }
  function buildDelivery(o) {
    const d = o.delivery || {}, method = d.method || 'home';
    const rows = [row('Method', el('span', { 'data-testid': 'track-method' }, MDM.deliveryMethodLabel(method)))];
    const add = (label, v, opts) => { if (v != null && String(v).trim()) rows.push(row(label, String(v), opts)); };
    const receiver = [d.recipientName, phoneTail(d.recipientPhone)].filter(Boolean).join(', ');
    const extra = [];
    if (method === 'boat') {
      const b = d.boat || {};
      add('Vessel', vesselLabel(b.vesselType) + (b.name ? ', ' + b.name : ''));
      add('Departure', departText(b.departureDate, b.departureTime));
      add('Harbour or jetty', jettyLabel(b.jetty));
      add('Island', b.island);
      add('Destination address', b.address);
      add('Receiver', receiver);
      const hist = (b.history || []).slice().reverse();
      if (hist.length) extra.push(el('div', { class: 'track-sub' }, el('h3', { class: 'track-h3' }, 'Boat changes'),
        el('ol', { class: 'timeline', 'data-testid': 'track-boat-history' }, hist.map(h => {
          const reason = (MDM.BOAT_CHANGE_REASONS.find(r => r.value === h.reason) || {}).label;
          return el('li', { class: 'timeline__item is-done', 'data-testid': 'track-boat-change' },
            el('div', { class: 'timeline__label' }, 'Boat details updated' + (reason ? ': ' + reason.charAt(0).toLowerCase() + reason.slice(1) : '')),
            el('div', { class: 'timeline__detail' }, boatChangeText(h) + (h.note ? '. ' + h.note : '')),
            el('div', { class: 'timeline__time' }, fmtDate(h.at) + (h.by ? ' · ' + who(h.by) : '')));
        }))));
    } else if (method === 'cargo') {
      const c = d.cargo || {};
      add('Drop-off', c.counter || MDM.geo.cargoCounter().label);
      add('Destination island', c.island);
      add('Consignee', c.consignee);
      add('Receiver', receiver);
      // The cargo fee is itemised once, in the Price section (§3.3); a second row here read as a second charge.
    } else if (method === 'airport') {
      const a = d.airport || {};
      add('Collection point', 'Velana International Airport, ' + pointLabel(a.point || 'resort_counters'));
      add('Counter', a.counter);
      add('Resort or destination', a.resort);
      if (a.speedboat) add('Resort speedboat', [a.speedboat, a.departureTime ? 'departs ' + a.departureTime : ''].filter(Boolean).join(', '));
      else add('Departure', a.departureTime);
      add('Receiver', receiver);
      add('Handover instructions', a.instructions);
    } else {
      // Several packages to different addresses: one row per drop-off, in the order the route visits them.
      const drops = [], seen = {};
      (o.packages || []).forEach(p => { const e = p.dropoff || {}, r = e.recipient || {}, k = (e.address || '') + '|' + (r.name || ''); if (e.address && !seen[k]) { seen[k] = 1; drops.push(e); } });
      if (drops.length > 1) drops.forEach((e, i) => rows.push(row('Delivery ' + (i + 1), [e.address, e.zone ? MDM.geo.zoneLabel(e.zone) : ''].filter(Boolean).join(', '),
        { valueSub: [e.recipient && e.recipient.name, phoneTail(e.recipient && e.recipient.phone), (MEET_AT[e.meetAt] || '').toLowerCase()].filter(Boolean).join(', ') || null })));
      else {
        add('Address', [d.address, d.zone ? MDM.geo.zoneLabel(d.zone) : ''].filter(Boolean).join(', '));
        add('Landmark', d.landmark);
        add('Handover', MEET_AT[d.meetAt] || '');
        add('Receiver', receiver);
      }
    }
    add('Instructions', d.instructions);
    return section('track-delivery-h', 'Delivery', el('div', { class: 'rate-table', 'data-testid': 'track-delivery', 'data-method': method }, rows), extra);
  }

  // ---- Price: estimated until our team confirms it (requirements §3 step 4, §15) ---------------------------------------------
  // Confirmed: every line (store items, packages, shopping budget, fees, extra vehicle, billable charges). Estimated: the delivery
  // range, the shopping budget and the fixed fees (airport, cargo, shopping), which add up to the estimated total; the rest waits for
  // our team. Packages show their size category only, never measurements (§2.2).
  function priceLine(desc, sub, amount, opts) {
    opts = opts || {};
    return el('div', { class: ['summary__line', opts.fee ? 'summary__line--fee' : null], dataset: opts.key ? { fee: opts.key } : null, 'data-testid': opts.testid || null },
      el('span', { class: 'summary__desc' }, desc, sub ? el('span', { class: 'summary__sub' }, sub) : null),
      el('span', { class: 'summary__amount mono' }, typeof amount === 'string' ? amount : fmt(amount)));
  }
  function buildPrice(o) {
    const confirmed = priceConfirmed(o);
    const changes = confirmed ? sizeChanges(o) : [];
    const firstFrom = {};
    changes.forEach(c => { if (!firstFrom[c.pkgId]) firstFrom[c.pkgId] = c.from; });
    const lines = [];
    // Shop & Deliver, or a shop stop on a multi-collection order: the shopping budget (then the receipt) is part of the price.
    const budget = o.service === 'shop' || extraShop(o) ? o.totals.budget || 0 : 0;
    const receipt = (o.packages || []).some(p => p.shop && p.shop.receiptTotal > 0) || (o.extraCollections || []).some(c => c.shop && c.shop.receiptTotal > 0);
    const budgetLine = sub => priceLine(receipt ? 'Shopping receipt' : 'Shopping budget', sub, budget, { testid: 'track-budget-line' });
    // Before the price is confirmed: the fixed fees, plus any charge already billed (naalu or Maldivian Cargo charges paid for a
    // no-photo order before our team priced it), which add to the estimate.
    const fees = feeRows(o).filter(f => confirmed || FIXED_FEES.indexOf(f.key) >= 0 || /^charge-/.test(f.key));
    const charged = confirmed ? 0 : fees.filter(f => /^charge-/.test(f.key)).reduce((n, f) => n + (Number(f.amount) || 0), 0);
    const est0 = estimateOf(o), est = { min: est0.min + charged, max: est0.max + charged };
    if (confirmed) {
      (o.items || []).forEach(it => lines.push(priceLine(it.qty + ' × ' + it.name, null, it.total)));
      o.packages.forEach(p => lines.push(priceLine(MDM.pricing.lineLabel(p, o.service),
        [p.description, p.price && p.price.businessRate && p.tier ? tierLabel(p.tier) + ' business rate' : null,
          firstFrom[p.id] && firstFrom[p.id] !== p.size ? 'changed from ' + MDM.pricing.sizeLabel(firstFrom[p.id]) + ' by our team' : null].filter(Boolean).join(' · '),
        p.price ? p.price.lineTotal : 0, { testid: 'track-package-line' })));
      if (budget) lines.push(budgetLine(null));
    } else {
      // The delivery part of the estimate is what is left once the budget and the fixed fees are taken out.
      const fixed = fees.reduce((n, f) => n + (Number(f.amount) || 0), 0) + budget;
      lines.push(priceLine('Delivery', pkgText(o), rangeText(Math.max(0, est.min - fixed), Math.max(0, est.max - fixed)), { testid: 'track-delivery-line' }));
      if (budget) lines.push(budgetLine('Paid upfront; we refund what is not spent'));
    }
    fees.forEach(f => lines.push(priceLine(f.label, f.key === 'cargo' ? 'Charged only for this delivery method' : f.reason, f.amount, { fee: true, key: f.key, testid: f.key === 'cargo' ? 'track-cargo-fee' : null })));
    const total = confirmed ? fmt(o.totals.total) : rangeText(est.min, est.max);
    const card = el('div', { class: 'summary', 'data-testid': 'track-summary' }, lines, lines.length ? el('div', { class: 'summary__rule' }) : null,
      el('div', { class: 'summary__total' }, el('span', null, confirmed ? 'Confirmed total' : 'Estimated total'), el('span', { class: 'mono', 'data-testid': 'track-total' }, total)));
    const body = [];
    if (changes.length) body.push(MDM.ui.notice('info', el('ul', { class: 'track-changes' }, changes.map(c =>
      el('li', null, (o.packages.length > 1 && c.n ? 'Package ' + c.n + ': ' : '') + MDM.pricing.sizeLabel(c.from) + ' to ' + MDM.pricing.sizeLabel(c.to) + ' · ' + fmtDate(c.at)))),
      { title: 'Package category changed by our team', testid: 'track-size-changes' }));
    body.push(card);
    if (!confirmed) body.push(el('p', { class: 'track-summary-note small muted', 'data-testid': 'track-price-note' }, MDM.priceAfterCollection(o)
      ? 'Final price confirmed after collection, from the driver\'s photo, including any vehicle or size charge.'
      : 'Our team confirms the final price, including any vehicle or size charge, before collection.'));
    else if (o.pricing.confirmedAt) {
      // A size change or a charge after confirmation updates the price; say when, so the confirmed time does not look stale.
      const last = (o.pricing.history || []).slice(-1)[0];
      const later = last && last.at && Date.parse(last.at) > Date.parse(o.pricing.confirmedAt) + 1000 ? ' Updated ' + fmtDate(last.at) + '.' : '';
      body.push(el('p', { class: 'track-summary-note small muted', 'data-testid': 'track-confirmed-note' }, 'Confirmed ' + fmtDate(o.pricing.confirmedAt) + ' by ' + who(o.pricing.confirmedBy) + (o.pricing.remarks ? ': ' + o.pricing.remarks : '') + '.' + later));
    }
    if (isBusinessOrder(o)) body.push(el('p', { class: 'track-summary-note small muted', 'data-testid': 'track-business-only' }, 'You see this price because you are signed in as ' + businessName(o) + '. Your receiver sees who arranged the delivery and the cash to pay, not your rate.'));
    if (confirmed && o.payment.method !== 'invoice') body.push(el('a', { class: 'btn btn--secondary btn--sm track-invoice', href: MDM.href('invoice/?order=' + encodeURIComponent(o.code)), 'data-testid': 'track-invoice' }, html(MDM.icon('receipt', 16)), 'View invoice'));
    return section('track-totals-h', 'Price', body);
  }

  // The receiver of a business order: who arranged the delivery and the cash to pay the driver, never the business's rate or invoice.
  function codRow(o) {
    const cod = o.cod && o.cod.amount > 0 ? o.cod : null, st = cod ? cod.status : 'none';
    const paid = ['collected', 'with_office', 'remitted'].indexOf(st) >= 0;
    const cancelled = o.status === 'cancelled' && (st === 'not_collected' || st === 'pending');
    const label = paid ? 'Cash paid to the driver' : st === 'not_collected' && !cancelled ? 'Cash on delivery' : 'Cash to pay the driver';
    const text = !cod ? 'Nothing to pay' : cancelled ? 'Nothing, the order was cancelled' : st === 'pending' ? fmt(cod.amount) : codText(o, true).replace(' paid in cash', '');
    return row(label, el('span', { 'data-testid': 'track-cod-status', 'data-status': st }, text), { mono: st === 'pending' });
  }
  function buildArranged(o) {
    const name = businessName(o);
    const rows = [row('Delivery arranged by', el('span', { 'data-testid': 'track-arranged-by' }, name)),
      row('Delivery charge', 'Billed to ' + name),
      codRow(o)];
    return section('track-payment-h', 'Payment', el('div', { class: 'rate-table', 'data-testid': 'track-arranged' }, rows),
      el('p', { class: 'track-summary-note small muted' }, 'Questions about the price of your order go to ' + name + '. ',
        el('a', { href: MDM.href('login/?as=business&next=' + encodeURIComponent('track/?code=' + o.code)), 'data-testid': 'track-business-signin' }, 'Are you ' + name + '? Sign in to see your price')));
  }
  function buildPayment(o) {
    const p = o.payment || {};
    const rows = [row('Status', html(MDM.payBadge(p.status))), row('Method', p.method === 'invoice' ? 'Monthly business invoice' : 'Bank transfer')];
    if (p.method !== 'invoice') {
      rows.push(row('When', p.upfrontRequired || p.upfront ? 'Upfront, once the price is confirmed' : 'After delivery'));
      if (p.invoiceNo) rows.push(row('Invoice', p.invoiceNo, { mono: true }));
      if (p.paidAmount != null && (p.status === 'received' || p.status === 'paid' || p.status === 'refunded')) rows.push(row('Amount transferred', fmt(p.paidAmount), { mono: true }));
      if (p.bank) rows.push(row('Paid from', bankName(p.bank)));
      if (p.submittedAt) rows.push(row('Slip uploaded', fmtDate(p.submittedAt)));
      if (p.verifiedAt && p.status === 'paid') rows.push(row('Verified', fmtDate(p.verifiedAt)));
      if (p.refund) rows.push(row('Refund', fmt(p.refund.amount) + (p.refund.at ? ' on ' + fmtDate(p.refund.at, { time: false }) : ''), { mono: true }));
    }
    const cod = o.cod;
    if (cod && cod.amount > 0) rows.push(row('Cash on delivery', el('span', { 'data-testid': 'track-cod-status', 'data-status': cod.status }, codText(o, false)), { valueSub: MDM.COD_STATUS[cod.status] && ['collected', 'with_office', 'remitted'].indexOf(cod.status) >= 0 ? MDM.COD_STATUS[cod.status].label : null }));
    const st = o.settlement;
    if (o.service === 'shop' && st) {
      const text = st.status === 'refund_due' ? 'We owe you ' + fmt(st.balance) : st.status === 'topup_due' ? 'Please pay the difference ' + fmt(Math.abs(st.balance)) : 'Settled' + (st.reference ? ' (' + st.reference + ')' : '');
      rows.push(row('Shopping balance', el('span', { 'data-testid': 'track-settlement' }, text)));
    }
    const body = [el('div', { class: 'rate-table', 'data-testid': 'track-payment' }, rows)];
    if (canPay(o)) body.push(el('div', { class: 'track-actions track-pay-row' }, payButton(o, p.status === 'requested' ? 'Pay ' + fmt(o.totals.total) : 'Pay now (optional)')));
    return section('track-payment-h', 'Payment', body);
  }

  // ---- Request details per type (requirements §5, §6) -------------------------------------------------------------------------
  function buildDetails(o) {
    const d = o.details || {}, rows = [];
    const add = (l, v) => { if (v != null && String(v).trim()) rows.push(row(l, String(v))); };
    const t = o.requestType;
    if (t === 'postal') {
      add('Carrier', (MDM.CARRIERS.find(c => c.value === d.carrier) || {}).label);
      add('Location', (MDM.PIKPOST_LOCATIONS.find(x => x.value === d.location) || {}).label);
      add('Post office', (MDM.POST_OFFICES.find(x => x.value === d.postOffice) || {}).label);
      add('Courier', d.courierName); add('Courier office', d.courierAddress);
      add(d.carrier === 'dhl' ? 'Waybill or tracking number' : 'Tracking number', d.trackingNo); add('Collection code', d.collectionCode); add('Collect before', d.collectBefore);
      add('Owner', d.ownerName); add('Owner contact', d.ownerContact ? MDM.ui.phone.format(d.ownerContact) : ''); add('Shipping address', d.shippingAddress); add('Note', d.idNote || d.smsNote);
    } else if (t === 'airport') {
      add('Service', (MDM.AIRPORT_MODES.find(x => x.value === d.mode) || {}).label);
      add('Airport area', ((MDM.geo.airportPoints().find(x => x.value === d.area)) || {}).label);
      add('Flight', [d.flight, d.flightTime].filter(Boolean).join(' at ')); add('Passenger', d.passengerName); add('Bags', d.mode === 'baggage' ? d.bags : '');
    } else if (t === 'office') {
      add('Task', (MDM.OFFICE_TASKS.find(x => x.value === d.task) || {}).label); add('Office', d.organisation); add('References', d.reference); add('Details', d.details);
      if (d.returnDocs) add('Return', 'Bring the receipt or documents back');
    } else if (t === 'shop_collect') {
      add('Shop', d.shopName); add('Proof', { invoice: 'Invoice', quotation: 'Quotation and payment slip', order_no: 'Order number' }[d.proof]); add('Order number', d.orderNo);
    } else if (t === 'shop_buy' || o.service === 'shop') {
      const shop = (o.packages.find(p => p.shop) || {}).shop || {}, ds = d.shop || {};
      add('Shop', [ds.name || shop.name || d.shopName, ds.address || shop.address].filter(Boolean).join(', '));
      if (!(d.items && d.items.length)) add('List', shop.list || d.list);
      const budget = d.budget || shop.budget;
      add('Budget', budget ? fmt(budget) : '');
    } else if (t === 'bulk' || t === 'business' || o.service === 'business') {
      add('Sender', businessName(o));
      add('Reference', d.reference);
      const tiers = [...new Set((o.packages || []).map(p => p.tier).filter(Boolean))];
      if (tiers.length) add('Package size', tiers.map(tierLabel).join(', '));
    }
    const s = o.schedule || {};
    if (s.type === 'advance') { add('Collection', fmtDate(s.collectDate, { dateOnly: true }) + ' ' + (s.collectTime || '')); add('Delivery', fmtDate(s.deliverDate, { dateOnly: true }) + ' ' + (s.deliverTime || '')); }
    if (o.serviceLevel === 'express') add('Service', 'Express');
    const pr = o.priority || {};
    if (pr.status === 'approved' && pr.level !== 'normal') add('Priority', (MDM.PRIORITY_LEVELS.find(x => x.value === pr.level) || {}).label);
    const last = (pr.requests || []).slice(-1)[0];
    if (last && last.deadline) add('Deadline', last.deadline);
    const items = (o.service === 'shop' || t === 'shop_buy') && Array.isArray(d.items) ? d.items.filter(i => i && i.name) : [];
    if (!rows.length && !items.length) return null;
    const list = items.length ? el('div', { class: 'track-sub' }, el('h3', { class: 'track-h3' }, 'Items to buy'),
      el('ul', { class: 'list track-items', 'data-testid': 'track-items' }, items.map(i => el('li', { class: 'list__item', 'data-testid': 'track-item' },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, (i.qty || 1) + ' × ' + i.name),
          i.details || i.instructions ? el('div', { class: 'list__meta' }, [i.details, i.instructions].filter(Boolean).join(' · ')) : null))))) : null;
    return section('track-details-h', MDM.requestTypeLabel(t) + ' details', rows.length ? el('div', { class: 'rate-table', 'data-testid': 'track-details' }, rows) : null, list);
  }

  // ---- Documents and proof photos (requirements §8, §13) -----------------------------------------------------------------------
  function thumbItem(f, title, meta, testid) {
    const isImg = f && f.dataUrl && /^data:image\//.test(f.dataUrl);
    return el('div', { class: 'list__item', 'data-testid': testid },
      isImg ? el('a', { href: f.dataUrl, download: f.name || 'photo', 'aria-label': 'Download ' + title }, el('img', { class: 'thumb', src: f.dataUrl, alt: title })) : el('span', { class: 'thumb track-file', 'aria-hidden': 'true' }, 'PDF'),
      el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, title), meta ? el('div', { class: 'list__meta' }, meta) : null),
      f && f.dataUrl ? el('a', { class: 'btn btn--ghost btn--sm', href: f.dataUrl, download: f.name || 'file' }, 'Download', el('span', { class: 'sr-only' }, ' ' + title)) : null);
  }
  function buildProofs(o, stops, files) {
    const items = [];
    stops.filter(x => x.type === 'pickup' && x.status === 'done').forEach(x => {
      const f = x.proofPhotoId ? files[x.proofPhotoId] : null;
      if (f) items.push(thumbItem(f, 'Proof of collection', 'Collected ' + fmtWhen(x.at) + (x.address ? ' · ' + x.address : ''), 'track-proof-collection'));
    });
    stops.filter(x => (x.type === 'dropoff' || x.type === 'return') && x.status === 'done').forEach(x => {
      const f = x.photoId ? files[x.photoId] : null;
      const who = x.recipientName || (x.contact && x.contact.name) || '';
      const text = x.type === 'return' ? 'Returned to sender' + (who ? ', received by ' + who : '') : x.handedTo === 'left' ? 'Left as instructed' + (who ? ' for ' + who : '') : 'Delivered to ' + (who || 'the recipient') + handedWords(x.handedTo);
      items.push(f ? thumbItem(f, 'Proof of delivery', text + ' at ' + fmtWhen(x.at), 'track-proof') :
        el('div', { class: 'list__item', 'data-testid': 'track-proof' }, el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, text + (x.at ? ' at ' + fmtWhen(x.at) : '')), el('div', { class: 'list__meta' }, x.address))));
    });
    const seenPhotos = new Set();
    (o.packages || []).forEach(p => {
      if (!p.photoId || seenPhotos.has(p.photoId) || p.photoSource === 'driver') return;
      seenPhotos.add(p.photoId);
      const f = files[p.photoId]; if (f) items.push(thumbItem(f, 'Your package photo', MDM.pricing.sizeLabel(p.size) + (p.description ? ' · ' + p.description : ''), 'track-package-photo'));
    });
    (o.documents || []).forEach(d => { const f = files[d.fileId]; items.push(thumbItem(f, d.name || 'Document', DOC_KIND[d.kind] || 'Document', 'track-document')); });
    // The Maldivian Cargo bill behind the charges on the price (a business's receiver never sees its prices).
    if (!state.receiver) (o.charges || []).filter(c => c.type === 'cargo' && c.photoId && c.billable && !c.void).forEach(c => {
      const f = files[c.photoId]; if (f) items.push(thumbItem(f, 'Maldivian Cargo bill', fmt(c.amount) + (c.description ? ' · ' + c.description : ''), 'track-cargo-bill'));
    });
    if (!items.length) return null;
    return section('track-files-h', 'Photos and documents', el('div', { class: 'list track-proof-list' }, items));
  }

  function buildTimeline(o) {
    const confirmedLabel = MDM.STATUS.confirmed.customer;
    const evs = (o.events || []).filter(e => e.visibility === 'public' && !(state.receiver && (RECEIVER_HIDDEN.indexOf(e.type) >= 0 || /MVR\s?\d/.test(e.label || ''))))
      .map(e => state.receiver && e.type === 'confirmed' ? Object.assign({}, e, { label: confirmedLabel }) : e);
    const terminal = TERMINAL.indexOf(o.status) >= 0;
    const items = evs.slice().reverse().map((e, i) => el('li', { class: ['timeline__item', i === 0 && !terminal ? 'is-current' : 'is-done'], dataset: { eventId: e.id, type: e.type } },
      el('div', { class: 'timeline__label' }, e.label), el('div', { class: 'timeline__time' }, fmtDate(e.at) + (e.by ? ' · ' + who(e.by) : ''))));
    return section('track-activity-h', 'Activity', el('ol', { class: 'timeline', 'data-testid': 'track-timeline' }, items));
  }

  // ---- Boot ---------------------------------------------------------------------------------------------------------------
  async function main() {
    await MDM.store.ready;
    form = document.querySelector('[data-testid="track-form"]');
    input = document.getElementById('track-code');
    fieldEl = input.closest('.field');
    emptyEl = document.getElementById('track-empty');
    resultEl = document.getElementById('track-result');
    state.settings = await MDM.store.settings();

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const code = normCode(input.value);
      if (!code) { MDM.ui.setError(fieldEl, 'Enter your order code'); input.focus(); return; }
      MDM.ui.setError(fieldEl, null);
      input.value = code;
      state.isNew = false;
      await track(code, true);
    });
    input.addEventListener('input', () => { if (input.value.trim()) MDM.ui.setError(fieldEl, null); });

    MDM.store.subscribe('orders', msg => {
      if (!state.order) return;
      if (msg && msg.ids && msg.ids.length && msg.ids.indexOf(state.order.id) < 0) return;
      render().catch(() => { /* a failed re-render keeps the last good view */ });
    });
    MDM.store.subscribe('settings', () => { if (state.order) render().catch(() => {}); });
    MDM.store.subscribe('drivers', () => { if (state.order && state.order.driverId) render().catch(() => {}); });

    await loadFromUrl();
  }
  main();
})(window.MDM);

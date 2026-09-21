// Track an order (SPEC §3.4). One async render() re-reads the order through the store on every 'orders' change; the rider marker
// and ETA follow MDM.live.onPosition for the order's driver; a 5 s timer only re-evaluates staleness from the last fix. No polling.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;

  const MAP_STATUSES = ['confirmed', 'assigned', 'picked_up', 'in_transit', 'on_hold', 'delivered', 'returned'];
  const ROUTE_LINE = ['assigned', 'picked_up', 'in_transit', 'on_hold', 'delivered', 'returned'];
  const ACTIVE = ['assigned', 'picked_up', 'in_transit', 'on_hold'];
  const LIVE = ['picked_up', 'in_transit'];
  const TERMINAL = ['delivered', 'returned', 'cancelled'];
  const ASK_CANCEL = ['payment_review', 'confirmed', 'assigned', 'picked_up', 'in_transit', 'on_hold'];
  const RECENT_S = 120, STALE_S = 15, LOST_S = 60;
  const VEHICLES = { bike: 'Bike', car: 'Car', pickup: 'Pickup' };
  const CHANNELS = { sms: 'SMS', whatsapp: 'WhatsApp', viber: 'Viber' };
  const MEET_AT = { door: 'At the door', lobby: 'At the lobby', reception: 'At reception or security' };
  const PAY_STATE = { unpaid: ['warn', 'Not paid yet'], review: ['warn', 'Checking your slip'], verified: ['ok', 'Verified'], rejected: ['danger', 'Could not match'], invoiced: ['neutral', 'On your monthly invoice'] };
  const ALERT_ICON = { info: 'info', warn: 'alert-triangle', danger: 'alert-circle', ok: 'check-circle' };
  const NEXT = {
    quote_pending: ['Quote sent', 'Payment verified', 'Rider assigned', 'Picked up', 'Delivered'],
    awaiting_payment: ['Payment verified', 'Rider assigned', 'Picked up', 'Delivered'],
    payment_review: ['Payment verified', 'Rider assigned', 'Picked up', 'Delivered'],
    confirmed: ['Rider assigned', 'Picked up', 'Delivered'],
    assigned: ['Picked up', 'Delivered'],
    picked_up: ['Delivered'], in_transit: ['Delivered'], on_hold: ['Delivered'],
  };

  const state = { settings: null, order: null, stops: [], driver: null, pos: null, posDriverId: null, unsubPos: null, timer: null, map: null, refs: null, share: false, code: '' };
  let renderSeq = 0;
  let form, input, fieldEl, emptyEl, resultEl;

  const fmt = n => MDM.pricing.format(n);
  const fmtDate = (iso, o) => MDM.ui.fmtDate(iso, o);
  const codeUrl = code => MDM.href('track/?code=' + encodeURIComponent(code));
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

  function notice(kind, title, text) {
    return el('div', { class: 'alert alert--' + kind }, html(MDM.icon(ALERT_ICON[kind], 16)),
      el('div', { class: 'alert__body' }, title ? el('div', { class: 'alert__title' }, title) : null, el('div', null, text)));
  }
  function section(id, title, ...body) {
    return el('section', { class: 'section', 'aria-labelledby': id }, el('div', { class: 'section-head' }, el('h2', { id }, title)), body);
  }
  function row(label, value, opts) {
    return el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, label), el('div', { class: 'rate-table__value' + (opts && opts.mono ? ' mono' : '') }, value));
  }
  function badgeNode(kind, label, status) { return html(MDM.ui.badge(kind, label, { 'data-status': status })).firstElementChild; }

  // ---- Loading ------------------------------------------------------------------------------------------------------------
  async function loadFromUrl() {
    const q = new URLSearchParams(location.search);
    const id = q.get('order'), code = q.get('code');
    if (id) {
      const o = await MDM.store.get('orders', id);
      if (o && o.status !== 'draft') { input.value = o.code; return setOrder(o); }
      return showEmpty(code ? normCode(code) : '');
    }
    if (code) { input.value = normCode(code); return track(normCode(code), false); }
    return null;
  }
  async function track(code, push) {
    state.code = code;
    const o = await MDM.store.orderByCode(code);
    if (push) history.replaceState(null, '', location.pathname + '?code=' + encodeURIComponent(code));
    if (!o || o.status === 'draft') return showEmpty(code);
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

  // ---- Rider position feed ------------------------------------------------------------------------------------------------
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
  // mountMap() only places the box in the new tree; the MapLibre instance is created by syncMap() once the tree is attached, so the
  // canvas is sized to the real box (creating it detached leaves a default-sized canvas).
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
      m.el.appendChild(el('div', { class: 'map__fallback' }, notice('warn', null, 'Map unavailable right now. Stops and status are still updated below.')));
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
    if (o.status === 'assigned' || o.status === 'on_hold') return posAge() <= RECENT_S;
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

  // ---- Live text: ETA, staleness, "Updated … ago" (called on every position, every 5 s and after each render) ------------
  function updateLive() {
    const o = state.order, r = state.refs;
    if (!o || !r) return;
    const pos = state.pos, age = posAge();
    let eta = '';
    if (LIVE.indexOf(o.status) >= 0 && pos) {
      if (age <= LOST_S) {
        const km = MDM.geo.remainingKm(o.route && o.route.polyline || [], pos);
        const min = MDM.geo.etaMinutes(km, crossIsland(o), state.settings);
        eta = 'Estimated arrival ' + MDM.ui.fmtTime(new Date(Date.now() + min * 60000));
      } else eta = 'Rider location unavailable right now';
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
    if (r.assignedAlert) r.assignedAlert.hidden = !!(pos && age <= RECENT_S);
    if (r.noPosAlert) r.noPosAlert.hidden = !!pos;
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
    const files = {};
    for (const s of stops) { if (s.photoId && !files[s.photoId]) files[s.photoId] = await MDM.store.get('files', s.photoId); }
    await watchDriver(driver ? o.driverId : null);
    if (seq !== renderSeq) return;
    state.stops = stops; state.driver = driver;
    const refs = {};
    const parts = [buildHead(o, refs), buildNotices(o, stops, files, refs)];
    if (o.status !== 'cancelled') parts.push(buildRoute(o, stops));
    if (driver) parts.push(buildDriver(o, driver, refs));
    parts.push(buildTotals(o), buildPayment(o), buildTimeline(o));
    resultEl.replaceChildren(...parts);
    state.refs = refs;
    resultEl.hidden = false; form.hidden = true;
    syncMap();
    updateLive();
  }

  function buildHead(o, refs) {
    const url = codeUrl(o.code);
    const s = state.settings || {}, contact = s.contact || {};
    const badge = html(MDM.badgeFor(o.status, { customer: true })).firstElementChild;
    badge.setAttribute('data-testid', 'track-status');
    refs.eta = el('span', { class: 'track-eta', 'data-testid': 'track-eta' });
    refs.updated = el('span', { class: 'track-head__updated' });
    const first = o.packages[0] || {};
    const recipient = first.dropoff && first.dropoff.recipient ? first.dropoff.recipient : null;
    const summary = [MDM.pricing.lineLabel(first, o.service)];
    if (o.packages.length > 1) summary.push(o.packages.length + ' packages');
    if (recipient && recipient.name) summary.push('to ' + recipient.name);
    if (o.schedule && o.schedule.type === 'slot') summary.push('scheduled ' + fmtDate(o.schedule.date, { dateOnly: true }) + ', ' + MDM.ui.window(o.schedule.window));

    const copyLabel = el('span', null, 'Copy tracking link');
    const copyBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'track-copy', on: { click: async () => {
      const ok = await MDM.ui.copy(url);
      if (ok) { setText(copyLabel, 'Copied'); setTimeout(() => setText(copyLabel, 'Copy tracking link'), 1500); }
      else MDM.ui.toast('Could not copy. The link is ' + url, 'warn');
    } } }, html(MDM.icon('link', 16)), copyLabel);

    const shareText = 'Track my Mr. Delivery Man delivery ' + o.code + ': ' + url;
    const recLinks = recipient && recipient.phone ? MDM.ui.phone.links(recipient.phone, shareText) : null;
    const waHref = recLinks ? recLinks.wa : 'https://wa.me/?text=' + encodeURIComponent(shareText);
    const viberHref = 'viber://forward?text=' + encodeURIComponent(shareText);
    const shareRow = el('div', { class: 'track-share', id: 'track-share', hidden: !state.share },
      el('span', null, recipient && recipient.name ? 'Send the tracking link to ' + recipient.name + ':' : 'Send the tracking link:'),
      el('a', { class: 'btn btn--secondary btn--sm', href: waHref, target: '_blank', rel: 'noopener', 'data-testid': 'track-share-whatsapp' }, 'WhatsApp'),
      el('a', { class: 'btn btn--secondary btn--sm', href: viberHref, 'data-testid': 'track-share-viber' }, 'Viber'));
    const shareBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'track-share', 'aria-expanded': state.share ? 'true' : 'false', 'aria-controls': 'track-share',
      on: { click: () => { state.share = !state.share; shareRow.hidden = !state.share; shareBtn.setAttribute('aria-expanded', state.share ? 'true' : 'false'); } } },
      html(MDM.icon('share', 16)), 'Share with recipient');
    const callLinks = contact.phone ? MDM.ui.phone.links(contact.phone) : null;
    const callBtn = callLinks ? el('a', { class: 'btn btn--secondary', href: callLinks.tel, 'data-testid': 'track-call-us' }, html(MDM.icon('phone', 16)), 'Call us') : null;
    const another = el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'track-another', on: { click: trackAnother } }, 'Track another order');

    return el('div', { class: 'track-head' },
      el('div', { class: 'track-head__back' }, another),
      el('div', { class: 'track-head__row' }, el('div', { class: 'track-head__live', 'aria-live': 'polite' }, badge, refs.eta), refs.updated),
      el('div', { class: 'track-head__code mono', 'data-testid': 'track-code' }, o.code),
      el('p', { class: 'track-head__summary' }, summary.join(' · ')),
      el('div', { class: 'track-head__actions' }, copyBtn, callBtn, shareBtn),
      shareRow);
  }

  function cancelButton(o) {
    return el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'track-cancel', on: { click: async () => {
      const v = await MDM.ui.dialog({ title: 'Cancel this request', message: 'We stop working on ' + o.code + ' and you can request a new delivery any time.',
        fields: [{ name: 'reason', label: 'Reason', type: 'textarea', rows: 2, hint: 'Helps us improve, for example "sent it another way".' }],
        okLabel: 'Cancel this request', cancelLabel: 'Keep it', danger: true });
      if (!v) return;
      try { await MDM.store.cancel(o.id, { by: 'customer', reason: v.reason || '' }); MDM.ui.toast('Request cancelled', 'ok'); }
      catch (e) { MDM.ui.toast(e && e.code === 'transition' ? 'This order can no longer be cancelled here. Call us and we will sort it out.' : 'Could not cancel right now. Please try again.', 'danger'); }
    } } }, 'Cancel this request');
  }
  function askToCancel(o) {
    const s = state.settings || {}, c = s.contact || {};
    const text = 'Mr. Delivery Man: I would like to cancel order ' + o.code + '.';
    const ch = (o.customer && o.customer.notify) || 'whatsapp';
    const raw = ch === 'viber' ? (c.viber || c.phone) : ch === 'sms' ? c.phone : (c.whatsapp || c.phone);
    const links = raw ? MDM.ui.phone.links(raw, text) : null;
    if (!links) return null;
    const href = ch === 'viber' ? links.viber : ch === 'sms' ? links.sms : links.wa;
    const attrs = { class: 'btn btn--ghost', href, 'data-testid': 'track-ask-cancel' };
    if (ch === 'whatsapp') { attrs.target = '_blank'; attrs.rel = 'noopener'; }
    return el('a', attrs, 'Ask to cancel on ' + (CHANNELS[ch] || 'WhatsApp'));
  }

  function buildNotices(o, stops, files, refs) {
    const s = state.settings || {}, ops = s.ops || {};
    const channel = CHANNELS[o.customer && o.customer.notify] || 'WhatsApp';
    const p = o.payment || {};
    const items = [];
    const actions = [];
    switch (o.status) {
      case 'quote_pending':
        items.push(notice('warn', null, "We're confirming your price. We'll send the payment link on " + channel + '.'));
        actions.push(cancelButton(o));
        break;
      case 'awaiting_payment': {
        if (p.status === 'rejected') items.push(notice('danger', "We couldn't match your transfer", (p.rejectReason ? p.rejectReason + '. ' : '') + 'Upload the slip again or contact us.'));
        const quoted = o.quote && o.quote.status === 'sent' ? 'Your quote is ' + fmt(o.totals.total) + (o.quote.note ? ' (' + o.quote.note + ')' : '') + '. ' : '';
        items.push(notice('warn', 'Awaiting your transfer', quoted + 'Transfer ' + fmt(o.totals.total) + ' with the reference ' + o.code + ', then upload your slip.'));
        actions.push(el('a', { class: 'btn btn--primary', href: MDM.href('checkout/?order=' + encodeURIComponent(o.id)), 'data-testid': 'track-pay' }, 'Pay and upload your slip'));
        actions.push(cancelButton(o));
        break;
      }
      case 'payment_review':
        items.push(notice('info', null, "Slip received, we'll confirm shortly (usually within " + (ops.reviewText || 'about 30 minutes') + ').'));
        break;
      case 'confirmed':
        items.push(notice('info', null, "Payment verified. We're assigning a rider."));
        break;
      case 'assigned':
        refs.assignedAlert = notice('info', null, 'Rider assigned. Live location appears once the rider starts.');
        items.push(refs.assignedAlert);
        break;
      case 'picked_up': case 'in_transit':
        refs.noPosAlert = notice('info', null, 'Your package is with the rider. Live location appears once the rider shares it.');
        items.push(refs.noPosAlert);
        break;
      case 'on_hold': {
        const failed = stops.find(x => x.status === 'failed');
        const r = failed ? MDM.FAIL_REASONS.find(x => x.value === failed.failReason) : null;
        const words = r ? r.label.toLowerCase() : (failed && failed.failReason ? String(failed.failReason).replace(/_/g, ' ') : 'no answer');
        items.push(notice('warn', null, "We couldn't complete " + (failed ? failed.label.toLowerCase() : 'a stop') + ' (' + words + "). We'll contact you on " + channel + '.'));
        break;
      }
      case 'delivered': case 'returned': {
        const done = stops.filter(x => (x.type === 'dropoff' || x.type === 'return') && x.status === 'done');
        if (done.length) {
          items.push(el('div', { class: 'list track-proof', 'data-testid': 'track-proof' }, done.map(x => {
            const f = x.photoId ? files[x.photoId] : null;
            const who = x.recipientName || (x.contact && x.contact.name) || '';
            const text = x.type === 'return' ? 'Returned to sender' + (who ? ', received by ' + who : '')
              : x.handedTo === 'left' ? 'Left as instructed' + (who ? ' for ' + who : '')
              : 'Delivered to ' + (who || 'the recipient') + handedWords(x.handedTo);
            return el('div', { class: 'list__item' },
              f && f.dataUrl ? el('img', { class: 'thumb', src: f.dataUrl, alt: 'Proof of delivery photo', 'data-testid': 'track-proof-photo' }) : null,
              el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, text + (x.at ? ' at ' + fmtDate(x.at) : '')), el('div', { class: 'list__meta' }, x.address)));
          })));
        }
        if (o.status === 'returned') items.push(notice('info', null, "We couldn't deliver this package, so it went back to the pickup address."));
        const st = o.settlement;
        if (o.service === 'shop' && st && st.status !== 'none') {
          const parts = ['Receipt ' + fmt(o.totals.budget), 'Shopping fee ' + fmt(o.fees.shopping)];
          let more = '';
          if (st.status === 'refund_due') { parts.push('We owe you ' + fmt(st.balance)); more = " We'll transfer it back and message you on " + channel + '.'; }
          else if (st.status === 'topup_due') { parts.push('Please pay the difference ' + fmt(Math.abs(st.balance))); more = ' Transfer it with the reference ' + o.code + '.'; }
          else parts.push(st.balance > 0 ? 'We refunded ' + fmt(st.balance) : st.balance < 0 ? 'Difference paid ' + fmt(Math.abs(st.balance)) : 'Nothing to settle');
          if (st.settledAt && st.status === 'settled') more = ' Settled on ' + fmtDate(st.settledAt, { time: false }) + (st.reference ? ' (' + st.reference + ')' : '') + '.';
          items.push(notice('info', 'Shopping settlement', el('span', { 'data-testid': 'track-settlement' }, parts.join(' · ') + '.' + more)));
        }
        break;
      }
      case 'cancelled': {
        const refund = p.refund;
        let body = (o.cancelledBy === 'customer' ? 'You cancelled this order' : 'We cancelled this order') + (o.cancelReason ? ': ' + o.cancelReason : '') + '.';
        if (refund) body += ' ' + fmt(refund.amount) + ' was sent to ' + (bankName(refund.toBank) || 'your bank') + (refund.at ? ' on ' + fmtDate(refund.at, { time: false }) : '') + '.';
        else if (p.status === 'verified') body += " We'll contact you on " + channel + ' about your refund.';
        items.push(notice('danger', refund ? 'Cancelled, refund sent' : 'Cancelled', body));
        break;
      }
      default: break;
    }
    if (ASK_CANCEL.indexOf(o.status) >= 0) { const a = askToCancel(o); if (a) actions.push(a); }
    if (actions.length) items.push(el('div', { class: 'track-actions' }, actions));
    return el('div', { class: 'track-notices' }, items);
  }

  function buildRoute(o, stops) {
    const withMap = MAP_STATUSES.indexOf(o.status) >= 0 && MDM.map.available();
    const active = ACTIVE.indexOf(o.status) >= 0;
    const current = active ? stops.findIndex(x => x.status === 'arrived' || x.status === 'pending') : -1;
    const rows = stops.map((x, i) => {
      const isCurrent = active && i === current;
      const cls = ['stop', 'stop--' + x.type, x.status === 'done' ? 'is-done' : x.status === 'failed' ? 'is-failed' : isCurrent ? 'is-current' : ''];
      const kind = x.type === 'pickup' ? (x.shop ? 'Shop pickup' : 'Pickup') : x.type === 'return' ? 'Return to sender' : 'Drop-off';
      const meta = [kind + ' · ' + MDM.geo.zoneLabel(x.zone)];
      if (x.landmark) meta.push(x.landmark);
      if (x.meetAt && MEET_AT[x.meetAt]) meta.push(MEET_AT[x.meetAt]);
      if (x.type !== 'pickup' && x.contact && x.contact.name) meta.push('Recipient ' + x.contact.name);
      if (x.cargo && x.cargo.boat) meta.push('Boat ' + x.cargo.boat + (x.cargo.time ? ', ' + x.cargo.time : ''));
      const aside = x.status === 'done' ? fmtDate(x.at) : x.status === 'failed' ? "Couldn't complete" : x.status === 'arrived' ? 'Rider arrived' : isCurrent ? 'Next' : 'Pending';
      const shopName = x.shop ? String(x.label || '').replace(/^Shop: /, '') : '';
      const title = shopName ? shopName + (x.address && x.address !== shopName ? ' · ' + x.address : '') : x.address;
      const attrs = { class: cls, 'data-testid': 'track-stop', dataset: { stopId: x.id, status: x.status } };
      if (withMap) { attrs.type = 'button'; attrs.on = { click: () => panToStop(x) }; attrs['aria-label'] = 'Show ' + kind.toLowerCase() + ' on the map: ' + x.address; }
      return el(withMap ? 'button' : 'div', attrs,
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
    const rows = [row('Rider', d.name), row('Vehicle', (VEHICLES[d.vehicle] || d.vehicle || '') + (d.vehicleNote ? ' · ' + d.vehicleNote : ''))];
    if (active) {
      refs.source = badgeNode('neutral', 'Not sharing yet', 'none');
      refs.posAge = el('span', { class: 'small muted', 'data-testid': 'track-pos-age' });
      rows.push(row('Live location', el('span', { class: 'row row--wrap' }, refs.source, refs.posAge)));
    }
    if (links) rows.push(row('Phone', el('a', { class: 'btn btn--secondary btn--sm', href: links.tel, 'data-testid': 'track-call-rider' }, html(MDM.icon('phone', 16)), 'Call rider')));
    return section('track-driver-h', 'Your rider', el('div', { class: 'card', 'data-testid': 'track-driver' }, el('div', { class: 'rate-table' }, rows)));
  }

  function buildTotals(o) {
    const lines = o.packages.map(p => el('div', { class: 'summary__line' },
      el('span', { class: 'summary__desc' }, MDM.pricing.lineLabel(p, o.service), p.description ? el('span', { class: 'summary__sub' }, p.description) : null),
      el('span', { class: 'summary__amount mono' }, fmt(p.price ? p.price.lineTotal : 0))));
    if (o.service === 'shop' && o.totals.budget) {
      const receipt = o.packages.some(p => p.shop && p.shop.receiptTotal > 0);
      lines.push(el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, receipt ? 'Shopping receipt' : 'Shopping budget (paid up front)'), el('span', { class: 'summary__amount mono' }, fmt(o.totals.budget))));
    }
    MDM.pricing.feeLines(o).forEach(f => lines.push(el('div', { class: 'summary__line summary__line--fee', dataset: { fee: f.key } },
      el('span', { class: 'summary__desc' }, f.label, f.reason ? el('span', { class: 'summary__sub' }, f.reason) : null),
      el('span', { class: 'summary__amount mono' }, fmt(f.amount)))));
    const card = el('div', { class: 'summary', 'data-testid': 'track-summary' }, lines, el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, o.totals.quoteRequired ? 'Estimated total' : 'Total'), el('span', { class: 'mono' }, fmt(o.totals.total))));
    const body = [card];
    if (o.totals.quoteRequired && o.totals.quoteReasons && o.totals.quoteReasons.length) {
      body.push(el('div', { class: 'track-summary-note' }, notice('warn', null, o.totals.quoteReasons.map(MDM.pricing.reasonText).join('. ') + '. We confirm the final price before pickup.')));
    }
    return section('track-totals-h', 'Totals', body);
  }

  function buildPayment(o) {
    const p = o.payment || {};
    const st = PAY_STATE[p.status] || ['neutral', p.status || 'Unknown'];
    const rows = [row('Status', badgeNode(st[0], st[1], p.status || 'unknown')), row('Method', p.method === 'invoice' ? 'Monthly invoice' : 'Bank transfer')];
    if (p.method !== 'invoice') {
      if (p.paidAmount != null && p.status !== 'unpaid') rows.push(row('Amount transferred', fmt(p.paidAmount), { mono: true }));
      if (p.bank) rows.push(row('Paid from', bankName(p.bank)));
      if (p.reference) rows.push(row('Reference', p.reference, { mono: true }));
      if (p.submittedAt) rows.push(row('Slip uploaded', fmtDate(p.submittedAt)));
      if (p.verifiedAt && p.status === 'verified') rows.push(row('Verified', fmtDate(p.verifiedAt)));
      if (p.status === 'rejected' && p.rejectReason) rows.push(row('Reason', p.rejectReason));
      if (p.refund) rows.push(row('Refund', fmt(p.refund.amount) + (p.refund.at ? ' on ' + fmtDate(p.refund.at, { time: false }) : ''), { mono: true }));
    }
    return section('track-payment-h', 'Payment', el('div', { class: 'rate-table', 'data-testid': 'track-payment' }, rows));
  }

  function buildTimeline(o) {
    const evs = (o.events || []).filter(e => e.visibility === 'public');   // store order is the logical order; seed timestamps can precede "created"
    const terminal = TERMINAL.indexOf(o.status) >= 0;
    const items = evs.map((e, i) => el('li', { class: ['timeline__item', i === evs.length - 1 && !terminal ? 'is-current' : 'is-done'], dataset: { eventId: e.id, type: e.type } },
      el('div', { class: 'timeline__label' }, e.label), el('div', { class: 'timeline__time' }, fmtDate(e.at))));
    (NEXT[o.status] || []).forEach(label => items.push(el('li', { class: 'timeline__item is-upcoming', dataset: { upcoming: '1' } },
      el('div', { class: 'timeline__label' }, o.service === 'shop' && label === 'Picked up' ? 'Shopping done' : label))));
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

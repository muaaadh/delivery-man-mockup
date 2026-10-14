// My orders (client requirements §17, §18; web app updates §2.1, §3): the signed-in customer's order history with number, date,
// collection and delivery (with the delivery method), packages, price, payment status and delivery status; "Order again" on every
// order and for the customer's most frequent request type and route; an order drawer with the status history (time and who), price,
// payment and actions (track, pay, invoice, order again, request cancellation); the messages we sent; and the address book (add, edit,
// remove labelled addresses through MDM.store.saveAddress / removeAddress).
// Identity comes from localStorage mdm:me (written by the sign-in page and by "Remember me" on the request form).
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const TABS = [{ key: 'orders', label: 'Orders' }, { key: 'messages', label: 'Messages' }, { key: 'addresses', label: 'Addresses' }];
  const FILTERS = [{ key: 'all', label: 'All' }, { key: 'active', label: 'In progress' }, { key: 'pay', label: 'To pay' }, { key: 'done', label: 'Completed' }];
  const CHANNEL = { sms: 'SMS', whatsapp: 'WhatsApp', viber: 'Viber', email: 'Email' };
  // Orders the request form can rebuild: everything except e-store purchases and business orders.
  const NO_REORDER = ['store', 'bulk', 'business'];
  let view, me = null, phoneKey = null;
  const state = { tab: 'orders', filter: 'all', openId: null };

  const fmt = n => MDM.pricing.format(n);
  const who = by => { const n = String(MDM.byName(by) || ''); return n.charAt(0).toUpperCase() + n.slice(1); };
  function loadMe() { try { const m = JSON.parse(localStorage.getItem('mdm:me')); return m && m.phone ? m : null; } catch (e) { return null; } }
  function signOut() { try { localStorage.removeItem('mdm:me'); } catch (e) { /* storage blocked */ } location.href = MDM.href(''); }
  const mine = o => o.customer && MDM.ui.phone.normalize(o.customer.phone) === phoneKey;
  const canPay = o => o.payment && o.payment.method !== 'invoice' && o.status !== 'cancelled' && (o.payment.status === 'requested' || (o.payment.status === 'pending' && o.pricing && o.pricing.status === 'confirmed'));
  const isDone = o => ['delivered', 'returned', 'cancelled'].indexOf(o.status) >= 0;
  const canReorder = o => !o.accountId && NO_REORDER.indexOf(o.requestType) < 0 && o.service !== 'store' && o.service !== 'business' && o.source !== 'store';
  const reorderHref = o => MDM.href('request/?reorder=' + encodeURIComponent(o.id));
  function pkgSummary(o) {
    if (o.items && o.items.length) return o.items.map(i => i.qty + ' × ' + i.name).join(', ');
    const c = {}; (o.packages || []).forEach(p => { c[p.size] = (c[p.size] || 0) + 1; });
    return Object.keys(c).map(k => c[k] + ' × ' + MDM.pricing.sizeLabel(k)).join(', ');
  }
  function priceText(o) {
    if (o.pricing && o.pricing.status === 'confirmed') return fmt(o.totals.total);
    const e = o.estimate || {};
    return e.min != null && e.min !== e.max ? fmt(e.min) + ' to ' + fmt(e.max).replace('MVR ', '') : fmt(o.totals.total);
  }
  const place = end => (end && end.address ? end.address : '') + (end && end.zone ? ', ' + MDM.geo.zoneShort(end.zone) : '');
  const methodOf = o => (o.delivery && o.delivery.method) || 'home';
  const pointLabel = v => ((MDM.geo.airportPoints().find(x => x.value === v) || {}).label || '');
  const jettyLabel = v => ((MDM.geo.terminals().find(t => t.value === v) || {}).label || '');
  const vesselLabel = v => ((MDM.VESSEL_TYPES.find(x => x.value === v) || {}).label || 'Boat').replace(' (dhoni)', '');
  // 'H. Blue Lagoon, Huraa' + 'Huraa, Kaafu Atoll' → 'H. Blue Lagoon, Huraa, Kaafu Atoll' (the island is not repeated).
  function withIsland(address, island) {
    const a = String(address || '').trim(), parts = String(island || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!a) return parts.join(', ');
    const low = a.toLowerCase();
    return [a].concat(parts.filter(x => low.indexOf(x.toLowerCase()) < 0)).join(', ');
  }
  // Where the package ends up, per delivery method (§3): the island address for boats, the cargo counter, the airport counter.
  function deliveryPlace(o) {
    const d = o.delivery || {}, m = methodOf(o);
    if (m === 'boat') { const b = d.boat || {}; return withIsland(b.address, b.island) || place(d); }
    if (m === 'cargo') { const c = d.cargo || {}; return 'Maldivian Cargo counter' + (c.island ? ', for ' + c.island : ''); }
    if (m === 'airport') { const a = d.airport || {}; return [a.counter || pointLabel(a.point), 'Velana International Airport'].filter(Boolean).join(', '); }
    return place(d);
  }
  // One line with the method's key details for the drawer: vessel and departure, cargo island, airport counter and resort.
  function methodDetail(o) {
    const d = o.delivery || {}, m = methodOf(o);
    if (m === 'boat') { const b = d.boat || {}; return [vesselLabel(b.vesselType) + (b.name ? ' ' + b.name : ''), b.departureTime ? 'departs ' + b.departureTime : '', jettyLabel(b.jetty) ? 'from ' + jettyLabel(b.jetty) : ''].filter(Boolean).join(', '); }
    if (m === 'cargo') { const c = d.cargo || {}; return [MDM.geo.cargoCounter().label, c.island ? 'for ' + c.island : ''].filter(Boolean).join(', '); }
    if (m === 'airport') { const a = d.airport || {}; return [a.counter || pointLabel(a.point), a.resort, a.speedboat ? 'speedboat ' + a.speedboat + (a.departureTime ? ' at ' + a.departureTime : '') : ''].filter(Boolean).join(', '); }
    return '';
  }
  function reorderLink(o) {
    const stop = e => e.stopPropagation();   // the row itself opens the drawer on click and Enter
    return el('a', { class: 'btn btn--secondary btn--sm', href: reorderHref(o), 'data-testid': 'account-reorder', 'data-order': o.id, on: { click: stop, keydown: stop } }, 'Order again',
      el('span', { class: 'sr-only' }, ' ' + o.code));
  }

  // ---- "Your most frequent order": the rule (MDM.frequentRoute, a route placed at least twice) lives in store.js, shared with
  // request/page.js; the wording below matches that page's "Order again" card. ---------------------------------------------------
  const frequentRoute = MDM.frequentRoute, routeText = MDM.reorderRouteText;
  const frequentMeta = g => 'Placed ' + g.count + ' times, last on ' + MDM.ui.fmtDate(g.latest.createdAt, { dateOnly: true }) + ' (' + g.latest.code + ')';
  function frequentCard(orders) {
    const g = frequentRoute(orders.filter(canReorder));
    if (!g) return null;
    const o = g.latest;
    return el('section', { class: 'card account-again', 'aria-labelledby': 'acc-again', 'data-testid': 'account-reorder-frequent', 'data-count': String(g.count) },
      el('div', { class: 'card__body account-again__body' },
        el('div', { class: 'account-again__main' },
          el('h2', { id: 'acc-again', class: 'account-h3' }, 'Your most frequent order'),
          el('p', { class: 'account-again__route' }, routeText(o)),
          el('p', { class: 'small muted' }, frequentMeta(g))),
        el('a', { class: 'btn btn--brand', href: reorderHref(o), 'data-testid': 'account-reorder-frequent-link', 'data-order': o.id }, 'Order again')));
  }

  // ---- Orders table (stacks into cards below 720px) ----------------------------------------------------------------------
  function ordersTable(orders) {
    const rows = orders.map(o => el('tr', { class: 'is-clickable', 'data-testid': 'account-order', 'data-status': o.status, 'data-order': o.id, tabindex: '0', on: {
      click: () => openOrder(o.id), keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrder(o.id); } } } },
      el('td', { class: 'table__primary', 'data-label': 'Order' }, el('span', null, el('span', { class: 'mono' }, o.code),
        el('span', { class: 'table__sub' }, MDM.requestTypeLabel(o.requestType)),
        el('span', { class: 'table__sub', 'data-testid': 'account-date' }, MDM.ui.fmtDate(o.createdAt)))),
      el('td', { 'data-label': 'Collection' }, el('span', { class: 'table__address', title: place(o.collection) }, place(o.collection))),
      el('td', { 'data-label': 'Delivery' }, el('span', null, el('span', { class: 'table__address', title: deliveryPlace(o) }, deliveryPlace(o)),
        el('span', { class: 'table__sub', 'data-testid': 'account-method' }, MDM.deliveryMethodLabel(methodOf(o))))),
      el('td', { 'data-label': 'Packages' }, pkgSummary(o)),
      el('td', { class: 'num mono', 'data-label': 'Price' }, priceText(o)),
      el('td', { class: 'account-status', 'data-label': 'Status' }, el('span', { class: 'account-badges' }, html(MDM.badgeFor(o.status, { customer: true })), html(MDM.payBadge(o.payment.status)))),
      el('td', { class: 'account-actions-cell' }, canReorder(o) ? reorderLink(o) : null)));
    const heads = ['Order', 'Collection', 'Delivery', 'Packages', 'Price', 'Status'];
    return el('div', { class: 'table-wrap account-table' }, el('table', { class: 'table table--stack', 'data-testid': 'account-orders' },
      el('thead', null, el('tr', null, heads.map(h => el('th', { scope: 'col', class: h === 'Price' ? 'num' : null }, h)),
        el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Order again')))),
      el('tbody', null, rows)));
  }

  // ---- Order drawer -------------------------------------------------------------------------------------------------------
  async function openOrder(id) {
    state.openId = id;
    const o = await MDM.store.get('orders', id);
    if (!o) { MDM.ui.drawer.close(); return; }
    const p = o.payment || {};
    const hist = (o.statusHistory || []).slice().reverse();
    const actions = [el('a', { class: 'btn btn--primary', href: MDM.href('track/?order=' + encodeURIComponent(o.id)), 'data-testid': 'account-track' }, 'Track')];
    if (canPay(o)) actions.push(el('a', { class: 'btn btn--brand', href: MDM.href('checkout/?order=' + encodeURIComponent(o.id)), 'data-testid': 'account-pay' }, 'Pay ' + fmt(o.totals.total)));
    if (o.pricing && o.pricing.status === 'confirmed' && p.method !== 'invoice') actions.push(el('a', { class: 'btn btn--secondary', href: MDM.href('invoice/?order=' + encodeURIComponent(o.code)), 'data-testid': 'account-invoice' }, 'Invoice'));
    if (canReorder(o)) actions.push(el('a', { class: 'btn btn--secondary', href: reorderHref(o), 'data-testid': 'account-drawer-reorder' }, 'Order again'));
    const c = o.cancellation || {};
    if (MDM.CANCELLABLE.indexOf(o.status) >= 0 && c.status !== 'requested') actions.push(el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'account-cancel', on: { click: () => askCancel(o) } }, 'Request cancellation'));
    const detail = methodDetail(o);
    const body = el('div', { class: 'stack-6' },
      c.status === 'requested' ? MDM.ui.notice('warn', 'We are reviewing your cancellation request' + (c.reason ? ': ' + c.reason : '') + '.') : null,
      c.status === 'rejected' ? MDM.ui.notice('warn', 'Cancellation declined' + (c.remarks ? ': ' + c.remarks : '') + '.') : null,
      el('div', { class: 'rate-table' },
        MDM.ui.rateRow('Request', MDM.requestTypeLabel(o.requestType) + (o.serviceLevel !== 'normal' ? ' · ' + ((MDM.SERVICE_LEVELS.find(x => x.value === o.serviceLevel) || {}).label || '') : '')),
        MDM.ui.rateRow('Placed', MDM.ui.fmtDate(o.createdAt)),
        MDM.ui.rateRow('Collection', place(o.collection)),
        MDM.ui.rateRow('Delivery method', el('span', { 'data-testid': 'account-drawer-method' }, MDM.deliveryMethodLabel(methodOf(o))), { valueSub: detail || null }),
        MDM.ui.rateRow('Delivery', deliveryPlace(o), { valueSub: o.delivery && o.delivery.recipientName ? 'To ' + o.delivery.recipientName : null }),
        MDM.ui.rateRow('Packages', pkgSummary(o), { valueSub: o.extraVehicle ? 'Extra vehicle requested' : null }),
        MDM.ui.rateRow(o.pricing && o.pricing.status === 'confirmed' ? 'Price' : 'Estimated price', priceText(o), { mono: true }),
        MDM.ui.rateRow('Payment', html(MDM.payBadge(p.status)))),
      el('section', { 'aria-labelledby': 'acc-hist' }, el('h3', { id: 'acc-hist', class: 'account-h3' }, 'Status history'),
        el('ol', { class: 'timeline', 'data-testid': 'account-history' }, hist.map((h, i) => el('li', { class: ['timeline__item', i === 0 ? 'is-current' : 'is-done'] },
          el('div', { class: 'timeline__label' }, (MDM.STATUS[h.to] || {}).customer || h.to),
          el('div', { class: 'timeline__time' }, MDM.ui.fmtDate(h.at) + ' · ' + who(h.by)))))));
    MDM.ui.drawer.open({ title: o.code, badge: MDM.badgeFor(o.status, { customer: true }), body, footer: el('div', { class: 'row row--wrap account-drawer-actions' }, actions), onClose: () => { state.openId = null; } });
  }
  async function askCancel(o) {
    const v = await MDM.ui.dialog({ title: 'Request cancellation', message: 'We review it straight away. Once the package is collected it can no longer be cancelled here.',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', rows: 2, required: true, requiredMessage: 'Tell us why, so we can help' }], okLabel: 'Send request', cancelLabel: 'Keep my order' });
    if (!v) return;
    try { await MDM.store.requestCancel(o.id, { reason: v.reason, by: 'customer' }); MDM.ui.toast('Cancellation requested', 'ok'); }
    catch (e) { MDM.ui.toast(e && e.code === 'transition' ? 'The package is already collected. Call us and we will sort it out.' : 'Could not send the request. Try again.', 'danger'); }
  }

  // ---- Address book (§2.1): labelled addresses, presets Home / Wife's home / Office / Other plus a custom name -----------------
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const meetLabel = v => ((MDM.geo.meetAtOptions().find(m => m.value === v) || {}).label || '');
  function openAddressForm(customer, a) {
    const editing = !!(a && a.id);
    const presets = MDM.ADDRESS_LABELS;
    const startLabel = a ? (a.label || 'Other') : presets[0];
    let preset = presets.indexOf(startLabel) >= 0 ? startLabel : 'Other';
    const customText = preset === 'Other' && startLabel !== 'Other' ? startLabel : '';
    const labelGroup = el('fieldset', { class: 'segmented account-labels', id: 'adr-label', 'data-testid': 'address-label' },
      presets.map(l => el('label', { class: 'segmented__option', 'data-testid': 'address-label-' + slug(l) },
        el('input', { class: 'sr-only', type: 'radio', name: 'adr-label', value: l, checked: l === preset, 'data-testid': 'address-label-' + slug(l) + '-input' }), el('span', null, l))));
    const custom = el('input', { class: 'input', id: 'adr-custom', type: 'text', maxlength: '40', autocomplete: 'off', value: customText, placeholder: "Mum's home, gym, school", 'data-testid': 'address-custom-label' });
    const customField = MDM.ui.field({ name: 'custom', label: 'Name this address', optional: true, control: custom, hint: 'Leave it empty to save it as Other.' });
    customField.hidden = preset !== 'Other';
    labelGroup.addEventListener('change', e => { if (e.target.name !== 'adr-label') return; preset = e.target.value; customField.hidden = preset !== 'Other'; });
    const address = el('input', { class: 'input', id: 'adr-address', type: 'text', autocomplete: 'street-address', value: a ? a.address : '', placeholder: 'House or building, street', 'data-testid': 'address-address' });
    // Airport runs are a delivery method now (§3), so the airport is not an area for a saved address. An older airport address still
    // lists and opens; editing it asks for its area.
    const wasAirport = !!(a && a.zone === 'airport');
    const zone = el('select', { class: 'select', id: 'adr-zone', 'data-testid': 'address-zone' }, el('option', { value: '' }, 'Choose the area'),
      MDM.geo.zoneOptions().filter(z => z.value !== 'airport').map(z => el('option', { value: z.value }, z.label)));
    zone.value = wasAirport ? '' : a && a.zone ? a.zone : 'male';
    const landmark = el('input', { class: 'input', id: 'adr-landmark', type: 'text', autocomplete: 'off', value: a ? a.landmark || '' : '', placeholder: 'Near a shop, mosque or school', 'data-testid': 'address-landmark' });
    const meetAt = el('select', { class: 'select', id: 'adr-meet', 'data-testid': 'address-meet' }, MDM.geo.meetAtOptions().map(m => el('option', { value: m.value }, m.label)));
    meetAt.value = a && a.meetAt ? a.meetAt : 'door';
    // Who takes the package at this address (Wife's home: the wife). The request form fills the receiver from these when the address is chosen.
    const contactName = el('input', { class: 'input', id: 'adr-contact', type: 'text', autocomplete: 'off', maxlength: '60', value: a ? a.contactName || '' : '', placeholder: 'Leave empty if it is you', 'data-testid': 'address-contact-name' });
    const contactPhone = el('input', { class: 'input', id: 'adr-contact-phone', type: 'tel', inputmode: 'tel', autocomplete: 'off', value: a && a.contactPhone ? MDM.ui.phone.format(a.contactPhone) : '', placeholder: '7XX XXXX', 'data-testid': 'address-contact-phone' });
    const fContactPhone = MDM.ui.field({ name: 'contactPhone', label: "Receiver's number", optional: true, control: contactPhone });
    const fAddress = MDM.ui.field({ name: 'address', label: 'Address', control: address });
    const fZone = MDM.ui.field({ name: 'zone', label: 'Area', control: zone, hint: wasAirport ? 'For the airport, choose Airport delivery when you place an order.' : null });
    const formError = el('div', { class: 'field__error', role: 'alert', hidden: true, 'data-testid': 'address-form-error' });
    const saveBtn = el('button', { type: 'submit', class: 'btn btn--primary', form: 'adr-form', 'data-testid': 'address-save' }, editing ? 'Save changes' : 'Save address');
    const form = el('form', { class: 'form stack-4 account-address-form', id: 'adr-form', novalidate: true, 'data-testid': 'address-form' },
      MDM.ui.field({ name: 'label', label: 'Label', control: labelGroup }),
      customField, fAddress, fZone,
      MDM.ui.field({ name: 'landmark', label: 'Landmark', optional: true, control: landmark }),
      MDM.ui.field({ name: 'meetAt', label: 'Handover point', control: meetAt, hint: 'Where the driver meets you at this address.' }),
      MDM.ui.field({ name: 'contactName', label: 'Receiver at this address', optional: true, control: contactName }),
      fContactPhone,
      formError);
    address.addEventListener('input', () => { if (address.value.trim()) MDM.ui.setError(fAddress, null); });
    zone.addEventListener('change', () => { if (zone.value) MDM.ui.setError(fZone, null); });
    contactPhone.addEventListener('input', () => { if (!contactPhone.value.trim() || MDM.ui.phone.valid(contactPhone.value, { intl: true })) MDM.ui.setError(fContactPhone, null); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const addr = address.value.trim();
      MDM.ui.setError(fAddress, addr ? null : 'Enter the address');
      MDM.ui.setError(fZone, zone.value ? null : 'Choose the area');
      const cPhone = contactPhone.value.trim();
      const phoneOk = !cPhone || MDM.ui.phone.valid(cPhone, { intl: true });
      MDM.ui.setError(fContactPhone, phoneOk ? null : 'Enter a 7-digit number, or + and the country code');
      if (!addr) { address.focus(); return; }
      if (!zone.value) { zone.focus(); return; }
      if (!phoneOk) { contactPhone.focus(); return; }
      const label = preset === 'Other' ? (custom.value.trim() || 'Other') : preset;
      const rec = Object.assign({}, a || {}, { label, address: addr, zone: zone.value, landmark: landmark.value.trim(), meetAt: meetAt.value,
        contactName: contactName.value.trim(), contactPhone: cPhone ? MDM.ui.phone.normalize(cPhone) : '', customerName: (customer && customer.name) || (me && me.name) || '' });
      if (!editing) delete rec.id;
      MDM.ui.setLoading(saveBtn, true);
      try {
        await MDM.store.saveAddress(phoneKey, rec);
        MDM.ui.drawer.close();
        MDM.ui.toast(editing ? 'Address updated' : 'Address saved', 'ok');
      } catch (err) {
        MDM.ui.setLoading(saveBtn, false);
        formError.textContent = err && err.code === 'quota' ? 'This browser is out of storage space for the demo.' : (err && err.message) || 'Could not save the address. Try again.';
        formError.hidden = false;
      }
    });
    MDM.ui.drawer.open({ title: editing ? 'Edit address' : 'Add an address', body: el('div', { class: 'account-drawer-form' }, form),
      footer: el('div', { class: 'row row--wrap account-drawer-actions' }, el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'address-cancel', on: { click: () => MDM.ui.drawer.close() } }, 'Cancel'), saveBtn) });
    const first = labelGroup.querySelector('input:checked') || address;
    try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
  }
  async function removeAddressAsk(a) {
    if (!(await MDM.ui.confirm({ title: 'Remove ' + (a.label || 'this address') + '?', message: a.address, okLabel: 'Remove', danger: true }))) return;
    try { await MDM.store.removeAddress(phoneKey, a.id); MDM.ui.toast('Address removed', 'ok'); }
    catch (e) { MDM.ui.toast('Could not remove the address. Try again.', 'danger'); }
  }
  function addressesPanel(customer) {
    const list = ((customer && customer.addresses) || []).filter(a => a && a.address);
    const addBtn = el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'address-add', on: { click: () => openAddressForm(customer, null) } }, html(MDM.icon('plus', 16)), 'Add an address');
    const head = el('div', { class: 'account-address-head' },
      el('div', null, el('h2', { class: 'account-h3' }, 'Saved addresses'), el('p', { class: 'small muted' }, 'Choose one when you place an order, or add a new address there.')), addBtn);
    if (!list.length) return el('div', { class: 'stack-4' }, head, el('div', { class: 'empty', 'data-testid': 'account-addresses-empty' }, el('div', { class: 'empty__title' }, 'No saved addresses.'), el('div', { class: 'empty__hint' }, 'Add your home, office or family addresses so ordering takes a few taps.')));
    return el('div', { class: 'stack-4' }, head,
      el('ul', { class: 'list account-addresses', 'data-testid': 'account-addresses' }, list.map(a => el('li', { class: 'list__item', 'data-testid': 'account-address', 'data-id': a.id || '' },
        el('div', { class: 'list__main' },
          el('div', { class: 'list__title', 'data-testid': 'account-address-label' }, a.label || 'Address'),
          el('div', { class: 'account-address__line', 'data-testid': 'account-address-text' }, a.address + (a.zone ? ', ' + MDM.geo.zoneLabel(a.zone) : '')),
          a.landmark || meetLabel(a.meetAt) ? el('div', { class: 'list__meta' }, [a.landmark, meetLabel(a.meetAt) ? 'Handover: ' + meetLabel(a.meetAt) : ''].filter(Boolean).join(' · ')) : null,
          a.contactName || a.contactPhone ? el('div', { class: 'list__meta', 'data-testid': 'account-address-contact' }, 'Receiver: ' + [a.contactName, a.contactPhone ? MDM.ui.phone.format(a.contactPhone) : ''].filter(Boolean).join(', ')) : null),
        a.id ? el('div', { class: 'account-address__actions' },
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'address-edit', on: { click: () => openAddressForm(customer, a) } }, 'Edit', el('span', { class: 'sr-only' }, ' ' + (a.label || 'address'))),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'address-remove', on: { click: () => removeAddressAsk(a) } }, 'Remove', el('span', { class: 'sr-only' }, ' ' + (a.label || 'address')))) : null))));
  }

  // ---- Tabs -----------------------------------------------------------------------------------------------------------------
  function ordersPanel(orders) {
    const counts = { all: orders.length, active: orders.filter(o => !isDone(o)).length, pay: orders.filter(canPay).length, done: orders.filter(isDone).length };
    const list = orders.filter(o => state.filter === 'all' || (state.filter === 'active' && !isDone(o)) || (state.filter === 'pay' && canPay(o)) || (state.filter === 'done' && isDone(o)));
    const chips = el('div', { class: 'filters__chips', role: 'group', 'aria-label': 'Show' }, FILTERS.map(f => el('button', { type: 'button', class: 'chip', 'aria-pressed': state.filter === f.key ? 'true' : 'false', 'data-testid': 'account-filter-' + f.key,
      on: { click: () => { state.filter = f.key; render(); } } }, f.label + ' ' + counts[f.key])));
    const toPay = orders.filter(canPay);
    return el('div', { class: 'stack-4' },
      toPay.length ? MDM.ui.notice('warn', toPay.length === 1 ? toPay[0].code + ' is ready to pay: ' + fmt(toPay[0].totals.total) + '.' : toPay.length + ' orders are ready to pay.', { action: el('a', { class: 'alert__action', href: MDM.href('checkout/?order=' + encodeURIComponent(toPay[0].id)), 'data-testid': 'account-pay-first' }, 'Pay now') }) : null,
      frequentCard(orders),
      chips,
      list.length ? ordersTable(list) : el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, orders.length ? 'Nothing here.' : 'No orders with this number yet.'), el('div', { class: 'empty__hint' }, 'Your deliveries appear here once you place a request.')));
  }
  function messagesPanel(notes) {
    if (!notes.length) return el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'No messages yet.'), el('div', { class: 'empty__hint' }, 'We message you when the price is confirmed, a driver is assigned, your package is collected and delivered.'));
    return el('div', { class: 'list account-messages', 'data-testid': 'account-messages' }, notes.map(n => el('div', { class: 'list__item', 'data-testid': 'account-message' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, n.title + ' · ', el('span', { class: 'mono' }, n.code)), el('div', { class: 'list__meta' }, n.message)),
      el('div', { class: 'list__aside small muted' }, MDM.ui.timeAgo(n.at), el('br'), CHANNEL[n.channel] || n.channel))));
  }

  async function render() {
    me = loadMe();
    if (!me) { location.replace(MDM.href('login/?as=customer&next=account/')); return; }
    phoneKey = MDM.ui.phone.normalize(me.phone) || me.phone;
    const [customers, all, notes] = await Promise.all([MDM.store.list('customers', { where: { phone: phoneKey } }), MDM.store.list('orders'), MDM.store.list('notifications', { where: { to: phoneKey } })]);
    const customer = customers[0] || null;
    const name = (customer && customer.name) || me.name || '';
    const orders = all.filter(mine).sort((a, b) => (String(b.createdAt) > String(a.createdAt) ? 1 : String(b.createdAt) < String(a.createdAt) ? -1 : 0));
    // Staff notifications (audience driver / operations / business) are operational messages, not the customer's.
    const mineNotes = notes.filter(n => !n.audience);
    const nAddresses = customer ? (customer.addresses || []).length : 0;
    const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Account' }, TABS.map(t => el('button', { type: 'button', class: 'tab', role: 'tab', id: 'acc-tab-' + t.key, 'aria-selected': state.tab === t.key ? 'true' : 'false', 'aria-controls': 'acc-panel', 'data-testid': 'account-tab-' + t.key,
      on: { click: () => { state.tab = t.key; render().then(() => { const b = document.getElementById('acc-tab-' + t.key); if (b) b.focus(); }); } } },
      t.label, t.key === 'messages' && mineNotes.length ? el('span', { class: 'count' }, String(mineNotes.length)) : null,
      t.key === 'addresses' && nAddresses ? el('span', { class: 'count' }, String(nAddresses)) : null)));
    const panel = el('div', { id: 'acc-panel', role: 'tabpanel', 'aria-labelledby': 'acc-tab-' + state.tab, class: 'account-panel' },
      state.tab === 'orders' ? ordersPanel(orders) : state.tab === 'messages' ? messagesPanel(mineNotes.slice().reverse()) : addressesPanel(customer));
    view.replaceChildren(
      el('div', { class: 'page-head' }, el('div', { class: 'account-id' },
        el('div', null, el('h1', null, name || 'My orders'), el('p', { class: 'page-head__desc' }, MDM.ui.phone.format(phoneKey) + (customer && customer.notify ? ' · Updates by ' + (CHANNEL[customer.notify] || customer.notify) : ''))),
        el('div', { class: 'row row--wrap' }, el('a', { class: 'btn btn--brand', href: MDM.href('request/') }, 'New request'), el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'account-signout', on: { click: signOut } }, 'Sign out')))),
      tabs, panel);
    if (state.openId && MDM.ui.drawer.isOpen()) openOrder(state.openId);
  }

  async function main() {
    await MDM.store.ready;
    view = document.getElementById('view');
    const q = new URLSearchParams(location.search);
    if (TABS.some(t => t.key === q.get('tab'))) state.tab = q.get('tab');
    await render();
    const again = () => { render().catch(() => {}); };
    const u1 = MDM.store.subscribe('orders', again), u2 = MDM.store.subscribe('notifications', again), u3 = MDM.store.subscribe('customers', again);
    window.addEventListener('pagehide', () => { u1(); u2(); u3(); });
  }
  main();
})(window.MDM);

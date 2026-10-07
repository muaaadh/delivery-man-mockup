// My orders (client requirements §17, §18): the signed-in customer's order history with number, date, collection and delivery
// location, packages, price, payment status and delivery status; an order drawer with the status history (time and who), price,
// payment and actions (track, pay, invoice, request cancellation); the messages we sent; saved addresses.
// Identity comes from localStorage mdm:me (written by the sign-in page and by "Remember me" on the request form).
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const TABS = [{ key: 'orders', label: 'Orders' }, { key: 'messages', label: 'Messages' }, { key: 'addresses', label: 'Addresses' }];
  const FILTERS = [{ key: 'all', label: 'All' }, { key: 'active', label: 'In progress' }, { key: 'pay', label: 'To pay' }, { key: 'done', label: 'Completed' }];
  const CHANNEL = { sms: 'SMS', whatsapp: 'WhatsApp', viber: 'Viber', email: 'Email' };
  let view, me = null, phoneKey = null;
  const state = { tab: 'orders', filter: 'all', openId: null };

  const fmt = n => MDM.pricing.format(n);
  function loadMe() { try { const m = JSON.parse(localStorage.getItem('mdm:me')); return m && m.phone ? m : null; } catch (e) { return null; } }
  function signOut() { try { localStorage.removeItem('mdm:me'); } catch (e) { /* storage blocked */ } location.href = MDM.href(''); }
  const mine = o => o.customer && MDM.ui.phone.normalize(o.customer.phone) === phoneKey;
  const canPay = o => o.payment && o.payment.method !== 'invoice' && o.status !== 'cancelled' && (o.payment.status === 'requested' || (o.payment.status === 'pending' && o.pricing && o.pricing.status === 'confirmed'));
  const isDone = o => ['delivered', 'returned', 'cancelled'].indexOf(o.status) >= 0;
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

  // ---- Orders table (stacks into cards below 720px) ----------------------------------------------------------------------
  function ordersTable(orders) {
    const head = ['Order', 'Date', 'Collection', 'Delivery', 'Packages', 'Price', 'Payment', 'Status'];
    const rows = orders.map(o => el('tr', { class: 'is-clickable', 'data-testid': 'account-order', 'data-status': o.status, tabindex: '0', on: {
      click: () => openOrder(o.id), keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrder(o.id); } } } },
      el('td', { class: 'table__primary mono', 'data-label': 'Order' }, el('span', null, o.code, el('span', { class: 'table__sub' }, MDM.requestTypeLabel(o.requestType)))),
      el('td', { 'data-label': 'Date' }, MDM.ui.fmtDate(o.createdAt)),
      el('td', { 'data-label': 'Collection' }, el('span', { class: 'table__address' }, place(o.collection))),
      el('td', { 'data-label': 'Delivery' }, el('span', { class: 'table__address' }, place(o.delivery))),
      el('td', { 'data-label': 'Packages' }, pkgSummary(o)),
      el('td', { class: 'num mono', 'data-label': 'Price' }, priceText(o)),
      el('td', { 'data-label': 'Payment' }, html(MDM.payBadge(o.payment.status))),
      el('td', { 'data-label': 'Status' }, html(MDM.badgeFor(o.status, { customer: true })))));
    return el('div', { class: 'table-wrap account-table' }, el('table', { class: 'table table--stack', 'data-testid': 'account-orders' },
      el('thead', null, el('tr', null, head.map((h, i) => el('th', { scope: 'col', class: i === 5 ? 'num' : null }, h)))),
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
    const c = o.cancellation || {};
    if (MDM.CANCELLABLE.indexOf(o.status) >= 0 && c.status !== 'requested') actions.push(el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'account-cancel', on: { click: () => askCancel(o) } }, 'Request cancellation'));
    const body = el('div', { class: 'stack-6' },
      c.status === 'requested' ? MDM.ui.notice('warn', 'We are reviewing your cancellation request' + (c.reason ? ': ' + c.reason : '') + '.') : null,
      c.status === 'rejected' ? MDM.ui.notice('warn', 'Cancellation declined' + (c.remarks ? ': ' + c.remarks : '') + '.') : null,
      el('div', { class: 'rate-table' },
        MDM.ui.rateRow('Request', MDM.requestTypeLabel(o.requestType) + (o.serviceLevel !== 'normal' ? ' · ' + ((MDM.SERVICE_LEVELS.find(x => x.value === o.serviceLevel) || {}).label || '') : '')),
        MDM.ui.rateRow('Collection', place(o.collection)),
        MDM.ui.rateRow('Delivery', place(o.delivery), { sub: null, valueSub: o.delivery && o.delivery.recipientName ? 'To ' + o.delivery.recipientName : null }),
        MDM.ui.rateRow('Packages', pkgSummary(o)),
        MDM.ui.rateRow(o.pricing && o.pricing.status === 'confirmed' ? 'Price' : 'Estimated price', priceText(o), { mono: true }),
        MDM.ui.rateRow('Payment', html(MDM.payBadge(p.status)))),
      el('section', { 'aria-labelledby': 'acc-hist' }, el('h3', { id: 'acc-hist', class: 'account-h3' }, 'Status history'),
        el('ol', { class: 'timeline', 'data-testid': 'account-history' }, hist.map((h, i) => el('li', { class: ['timeline__item', i === 0 ? 'is-current' : 'is-done'] },
          el('div', { class: 'timeline__label' }, (MDM.STATUS[h.to] || {}).customer || h.to),
          el('div', { class: 'timeline__time' }, MDM.ui.fmtDate(h.at) + ' · ' + MDM.byName(h.by)))))));
    MDM.ui.drawer.open({ title: o.code, badge: MDM.badgeFor(o.status, { customer: true }), body, footer: el('div', { class: 'row row--wrap account-drawer-actions' }, actions), onClose: () => { state.openId = null; } });
  }
  async function askCancel(o) {
    const v = await MDM.ui.dialog({ title: 'Request cancellation', message: 'We review it straight away. Once the package is collected it can no longer be cancelled here.',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', rows: 2, required: true, requiredMessage: 'Tell us why, so we can help' }], okLabel: 'Send request', cancelLabel: 'Keep my order' });
    if (!v) return;
    try { await MDM.store.requestCancel(o.id, { reason: v.reason, by: 'customer' }); MDM.ui.toast('Cancellation requested', 'ok'); }
    catch (e) { MDM.ui.toast(e && e.code === 'transition' ? 'The package is already collected. Call us and we will sort it out.' : 'Could not send the request. Try again.', 'danger'); }
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
      chips,
      list.length ? ordersTable(list) : el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, orders.length ? 'Nothing here.' : 'No orders with this number yet.'), el('div', { class: 'empty__hint' }, 'Your deliveries appear here once you place a request.')));
  }
  function messagesPanel(notes) {
    if (!notes.length) return el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'No messages yet.'), el('div', { class: 'empty__hint' }, 'We message you when the price is confirmed, a driver is assigned, your package is collected and delivered.'));
    return el('div', { class: 'list account-messages', 'data-testid': 'account-messages' }, notes.map(n => el('div', { class: 'list__item', 'data-testid': 'account-message' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, n.title + ' · ', el('span', { class: 'mono' }, n.code)), el('div', { class: 'list__meta' }, n.message)),
      el('div', { class: 'list__aside small muted' }, MDM.ui.timeAgo(n.at), el('br'), CHANNEL[n.channel] || n.channel))));
  }
  function addressesPanel(customer) {
    const list = (customer && customer.addresses) || [];
    if (!list.length) return el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'No saved addresses.'), el('div', { class: 'empty__hint' }, 'Addresses you deliver to are saved here for next time.'));
    return el('div', { class: 'rate-table', 'data-testid': 'account-addresses' }, list.map((a, i) => MDM.ui.rateRow(a.label || 'Address', el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: async () => {
      if (!(await MDM.ui.confirm({ title: 'Remove this address?', message: a.address, okLabel: 'Remove', danger: true }))) return;
      await MDM.store.update('customers', customer.id, { addresses: list.filter((x, j) => j !== i) });
    } } }, 'Remove'), { sub: a.address + ', ' + MDM.geo.zoneLabel(a.zone) })));
  }

  async function render() {
    me = loadMe();
    if (!me) { location.replace(MDM.href('login/?as=customer&next=account/')); return; }
    phoneKey = MDM.ui.phone.normalize(me.phone) || me.phone;
    const [customers, all, notes] = await Promise.all([MDM.store.list('customers', { where: { phone: phoneKey } }), MDM.store.list('orders'), MDM.store.list('notifications', { where: { to: phoneKey } })]);
    const customer = customers[0] || null;
    const name = (customer && customer.name) || me.name || '';
    const orders = all.filter(mine);
    const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Account' }, TABS.map(t => el('button', { type: 'button', class: 'tab', role: 'tab', id: 'acc-tab-' + t.key, 'aria-selected': state.tab === t.key ? 'true' : 'false', 'aria-controls': 'acc-panel', 'data-testid': 'account-tab-' + t.key,
      on: { click: () => { state.tab = t.key; render().then(() => { const b = document.getElementById('acc-tab-' + t.key); if (b) b.focus(); }); } } },
      t.label, t.key === 'messages' && notes.length ? el('span', { class: 'count' }, String(notes.length)) : null)));
    const panel = el('div', { id: 'acc-panel', role: 'tabpanel', 'aria-labelledby': 'acc-tab-' + state.tab, class: 'account-panel' },
      state.tab === 'orders' ? ordersPanel(orders) : state.tab === 'messages' ? messagesPanel(notes.slice().reverse()) : addressesPanel(customer));
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
    await render();
    const again = () => { render().catch(() => {}); };
    const u1 = MDM.store.subscribe('orders', again), u2 = MDM.store.subscribe('notifications', again), u3 = MDM.store.subscribe('customers', again);
    window.addEventListener('pagehide', () => { u1(); u2(); u3(); });
  }
  main();
})(window.MDM);

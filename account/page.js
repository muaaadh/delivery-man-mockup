// My orders: the signed-in customer's deliveries, newest first, with the next action for each (pay, track).
// Identity comes from localStorage mdm:me (written by the sign-in page and by "Remember me" on the request form).
(function (MDM) { 'use strict';
  const { el } = MDM.ui;
  let view, me = null, unsub = null;

  function loadMe() { try { const m = JSON.parse(localStorage.getItem('mdm:me')); return m && m.phone ? m : null; } catch (e) { return null; } }
  function signOut() { try { localStorage.removeItem('mdm:me'); } catch (e) { /* storage blocked */ } location.href = MDM.href(''); }

  function orderRow(o) {
    const pkg = o.packages && o.packages[0];
    const title = o.code + ' · ' + (pkg ? MDM.pricing.lineLabel(pkg, o.service) : MDM.STATUS[o.status].customer) + (o.packages && o.packages.length > 1 ? ' · ' + o.packages.length + ' packages' : '');
    const when = MDM.ui.fmtDate(o.createdAt);
    const href = o.status === 'awaiting_payment' ? MDM.href('checkout/?order=' + o.id) : MDM.href('track/?order=' + o.id);
    const action = o.status === 'awaiting_payment' ? 'Pay and upload your slip' : o.status === 'quote_pending' ? 'See your request' : 'Track';
    return el('a', { class: 'list__item list__item--link', href, 'data-testid': 'account-order', 'data-status': o.status },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, title), el('div', { class: 'list__meta' }, when + ' · ' + MDM.pricing.format(o.totals.total))),
      el('div', { class: 'list__aside' }, MDM.ui.html(MDM.badgeFor(o.status, { customer: true })), el('div', { class: 'small', style: { marginTop: '6px' } }, action)));
  }

  async function render() {
    me = loadMe();
    if (!me) { location.replace(MDM.href('login/?as=customer&next=account/')); return; }
    const phone = MDM.ui.phone.normalize(me.phone) || me.phone;
    const customer = (await MDM.store.list('customers', { where: { phone } }))[0] || null;
    const name = (customer && customer.name) || me.name || '';
    const orders = (await MDM.store.list('orders')).filter(o => o.customer && MDM.ui.phone.normalize(o.customer.phone) === phone && o.status !== 'draft');
    view.textContent = '';
    view.appendChild(el('div', { class: 'page-head' },
      el('div', { class: 'account-id' },
        el('div', {}, el('h1', {}, name ? name : 'My orders'), el('p', { class: 'page-head__desc' }, name ? MDM.ui.phone.format(phone) : 'Signed in as ' + MDM.ui.phone.format(phone))),
        el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'account-signout', on: { click: signOut } }, 'Sign out'))));
    const section = el('section', { 'aria-labelledby': 'orders-title' }, el('div', { class: 'section-head' }, el('h2', { id: 'orders-title' }, 'Your orders'), orders.length ? el('p', { class: 'section-head__desc' }, orders.length + (orders.length === 1 ? ' order' : ' orders') + ', newest first') : null));
    if (orders.length) section.appendChild(el('div', { class: 'list account-orders' }, orders.map(orderRow)));
    else section.appendChild(el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'No orders with this number yet.'), el('div', { class: 'empty__hint' }, 'Your deliveries will appear here once you place a request.')));
    section.appendChild(el('div', { class: 'account-cta' }, el('a', { class: 'btn btn--primary', href: MDM.href('request/') }, 'Request a delivery'), el('a', { class: 'btn btn--secondary', href: MDM.href('track/') }, 'Track an order by code')));
    view.appendChild(section);
    if (customer && customer.addresses && customer.addresses.length) {
      view.appendChild(el('section', { 'aria-labelledby': 'addr-title', class: 'section' },
        el('div', { class: 'section-head' }, el('h2', { id: 'addr-title' }, 'Saved addresses')),
        el('div', { class: 'rate-table' }, customer.addresses.map(a => el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, a.label || 'Address', el('small', {}, a.address)), el('div', { class: 'rate-table__value' }, MDM.geo.zoneLabel(a.zone)))))));
    }
  }

  async function main() {
    await MDM.store.ready;
    view = document.getElementById('view');
    await render();
    unsub = MDM.store.subscribe('orders', () => { render(); });
    window.addEventListener('pagehide', () => { if (unsub) unsub(); });
  }
  main();
})(window.MDM);

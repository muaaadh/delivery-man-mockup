// E-store (How it works §7): packaging, supplies and prepaid delivery bundles. The catalogue is the `products` collection (the admin
// edits prices, stock and visibility under E-store); the cart lives in localStorage mdm:cart = [{ productId, qty }].
// Checkout creates an ordinary delivery order through MDM.store.createStoreOrder (collected from the store, delivered by a driver),
// so it shows up in the admin, on the tracking page and in the customer's order history like any other order.
(function (MDM) { 'use strict';
  const { el, html, setError } = MDM.ui;
  const CART = 'mdm:cart';
  const CATEGORIES = [{ value: 'all', label: 'All' }, { value: 'packaging', label: 'Packaging' }, { value: 'supplies', label: 'Supplies' }, { value: 'bundles', label: 'Delivery bundles' }];
  const ICONS = { prd_mailer: 'mail', prd_box_s: 'package', prd_box_m: 'package', prd_box_l: 'package', prd_tape: 'circle-dot', prd_fragile: 'alert-triangle', prd_cooler: 'shopping-bag', prd_bundle10: 'bike', prd_bundle50: 'truck', prd_labels: 'printer' };
  const CAT_ICON = { packaging: 'package', supplies: 'clipboard-list', bundles: 'bike' };
  const LOW = 10;
  const money = n => MDM.pricing.format(n);
  const app = document.querySelector('[data-slot="app"]');
  const state = { products: [], settings: {}, cat: 'all', view: 'catalogue', me: null, customer: null };

  // ---- Cart --------------------------------------------------------------------------------------------------------------
  function readCart() { try { const v = JSON.parse(localStorage.getItem(CART) || '[]'); return Array.isArray(v) ? v.filter(x => x && x.productId && x.qty > 0) : []; } catch (e) { return []; } }
  function writeCart(c) { try { localStorage.setItem(CART, JSON.stringify(c)); } catch (e) { /* storage blocked: the cart lasts for this page */ } memCart = c; }
  let memCart = null;
  const cart = () => memCart || (memCart = readCart());
  const product = id => state.products.find(p => p.id === id);
  const maxQty = p => p.stock == null ? 99 : Math.max(0, p.stock);
  // Lines that still exist and are in stock, with quantities clamped to the stock left.
  function lines() {
    return cart().map(l => { const p = product(l.productId); return p && p.active !== false && maxQty(p) > 0 ? { p, qty: Math.min(l.qty, maxQty(p)) } : null; }).filter(Boolean);
  }
  function setQty(id, qty) {
    const p = product(id); if (!p) return;
    const c = cart().filter(l => l.productId !== id);
    const q = Math.max(0, Math.min(maxQty(p), Math.round(qty)));
    if (q > 0) { const i = cart().findIndex(l => l.productId === id); const line = { productId: id, qty: q }; if (i >= 0) c.splice(i, 0, line); else c.push(line); }
    writeCart(c);
    paint();
  }
  const qtyOf = id => (cart().find(l => l.productId === id) || {}).qty || 0;
  const itemsTotal = () => lines().reduce((n, l) => n + l.p.price * l.qty, 0);
  const itemCount = () => lines().reduce((n, l) => n + l.qty, 0);
  // Delivery is priced like any Bag (or Box above 6 items) from the store to the customer's zone; same rule as createStoreOrder.
  function deliveryFee(zone) {
    const s = state.settings, store = s.store || {};
    const size = itemCount() > 6 ? 'box' : 'bag';
    if (!zone) { const cell = ((s.rates || {}).sizes || {})[size] || {}; return { amount: cell.same || 0, from: true, size }; }
    const q = MDM.pricing.quote({ service: 'pick', packages: [{ id: 'x', size, pickup: { zone: store.zone || 'male' }, dropoff: { zone } }] }, s);
    return { amount: q.totals.total, from: false, size, quote: q.totals.quoteRequired };
  }

  // ---- Pieces --------------------------------------------------------------------------------------------------------------
  function stepper(p, qty, opts) {
    opts = opts || {};
    return el('div', { class: 'qty', role: 'group', 'aria-label': 'Quantity of ' + p.name },
      el('button', { type: 'button', class: 'btn btn--secondary btn--icon btn--sm qty__btn', 'aria-label': qty === 1 && opts.removable ? 'Remove ' + p.name : 'One less', 'data-testid': 'store-minus-' + p.id, on: { click: () => setQty(p.id, qty - 1) } }, html(MDM.icon(qty === 1 && opts.removable ? 'trash' : 'minus', 16))),
      el('span', { class: 'qty__value mono', 'aria-live': 'polite' }, String(qty)),
      el('button', { type: 'button', class: 'btn btn--secondary btn--icon btn--sm qty__btn', 'aria-label': 'One more', disabled: qty >= maxQty(p), 'data-testid': 'store-plus-' + p.id, on: { click: () => setQty(p.id, qty + 1) } }, html(MDM.icon('plus', 16))));
  }
  function stockNote(p, unit) {
    const per = unit ? 'per ' + unit + ' · ' : '';
    if (p.stock == null) return el('span', { class: 'store-stock' }, per + 'Always available');
    if (p.stock <= 0) return el('span', { class: 'store-stock' }, per, el('span', { class: 'store-stock--out' }, 'Out of stock'));
    if (p.stock <= LOW) return el('span', { class: 'store-stock' }, per, el('span', { class: 'store-stock--low' }, 'Only ' + p.stock + ' left'));
    return el('span', { class: 'store-stock' }, per + 'In stock');
  }
  function card(p, open) {
    const qty = qtyOf(p.id), out = maxQty(p) <= 0;
    return el('article', { class: 'card store-card' + (out ? ' is-out' : ''), 'data-testid': 'store-product-' + p.id },
      el('div', { class: 'store-card__art', 'aria-hidden': 'true' }, html(MDM.icon(ICONS[p.id] || CAT_ICON[p.category] || 'package', 40))),
      el('div', { class: 'store-card__body' },
        el('div', { class: 'store-card__cat' }, (CATEGORIES.find(c => c.value === p.category) || { label: p.category }).label),
        el('h3', { class: 'store-card__name' }, p.name),
        el('p', { class: 'store-card__desc' }, p.description || ''),
        el('div', { class: 'store-card__foot' },
          el('div', { class: 'store-card__pricebox' }, el('div', { class: 'store-card__price mono' }, money(p.price)), stockNote(p, p.unit)),
          !open ? null : qty ? stepper(p, qty) : el('button', { type: 'button', class: 'btn btn--primary btn--sm', disabled: out, 'data-testid': 'store-add-' + p.id, on: { click: () => { setQty(p.id, 1); MDM.ui.toast(p.name + ' added to your cart', 'ok', { action: { label: 'View cart', onClick: openCart } }); } } }, out ? 'Sold out' : 'Add to cart'))));
  }
  function cartButton() {
    const n = itemCount();
    return el('button', { type: 'button', class: 'btn btn--secondary store-cartbtn', 'data-testid': 'store-cart-open', on: { click: openCart } },
      html(MDM.icon('shopping-bag', 16)), n ? 'Cart · ' + n + ' · ' + money(itemsTotal()) : 'Cart');
  }

  // ---- Catalogue -----------------------------------------------------------------------------------------------------------
  function renderCatalogue() {
    const s = state.settings, open = (s.store || {}).open !== false;
    const visible = state.products.filter(p => p.active !== false && (state.cat === 'all' || p.category === state.cat));
    const chips = el('div', { class: 'filters__chips store-chips', role: 'group', 'aria-label': 'Category' }, CATEGORIES.map(c => {
      const n = c.value === 'all' ? state.products.filter(p => p.active !== false).length : state.products.filter(p => p.active !== false && p.category === c.value).length;
      return el('button', { type: 'button', class: 'chip', 'aria-pressed': state.cat === c.value ? 'true' : 'false', 'data-testid': 'store-cat-' + c.value, on: { click: () => { state.cat = c.value; paint(); } } }, c.label, el('span', { class: 'count' }, String(n)));
    }));
    app.replaceChildren(el('div', { class: 'container' },
      el('div', { class: 'page-head' },
        el('h1', null, 'Store'),
        el('p', { class: 'page-head__desc' }, 'Boxes, mailers, tape, labels and prepaid delivery bundles. A rider brings your order like any other delivery, usually within the day.'),
        el('div', { class: 'page-head__actions' }, cartButton())),
      !open ? MDM.ui.notice('warn', 'The store is closed right now. You can still browse; orders open again soon.', { title: 'Store closed' }) : null,
      el('div', { class: 'store-bar' }, chips, el('p', { class: 'small muted' }, (s.store || {}).note || '')),
      visible.length ? el('div', { class: 'store-grid' }, visible.map(p => card(p, open))) : el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'Nothing in this category yet')),
      el('section', { class: 'section store-how', 'aria-labelledby': 'store-how' },
        el('div', { class: 'section-head' }, el('h2', { id: 'store-how' }, 'How store orders work')),
        el('ol', { class: 'steps' }, [
          ['Add to cart', 'Prices include the item only; delivery is added at checkout from ' + money(deliveryFee('').amount) + '.'],
          ['Pay after delivery, or now', 'Pay by bank transfer once it arrives, or transfer now and upload the slip on the tracking page.'],
          ['Track it', 'You get an order code. Follow it from our store to your door like any other delivery.'],
        ].map((it, i) => el('li', { class: 'steps__item' }, el('div', { class: 'steps__head' }, el('span', { class: 'steps__num mono' }, String(i + 1)), el('h3', { class: 'steps__title' }, it[0])), el('p', { class: 'steps__text' }, it[1])))))));
  }

  // ---- Cart drawer ---------------------------------------------------------------------------------------------------------
  function cartBody() {
    const ls = lines();
    if (!ls.length) return el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'Your cart is empty'), el('div', { class: 'empty__hint' }, 'Add boxes, mailers or a delivery bundle from the store.'));
    const fee = deliveryFee('');
    return el('div', { class: 'stack-4' },
      el('div', { class: 'list store-lines' }, ls.map(l => el('div', { class: 'list__item', 'data-testid': 'store-line-' + l.p.id },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, l.p.name), el('div', { class: 'list__meta' }, money(l.p.price) + (l.p.unit ? ' / ' + l.p.unit : '') + (l.p.stock != null && l.qty >= l.p.stock ? ' · that is all we have' : ''))),
        el('div', { class: 'store-line__aside' }, stepper(l.p, l.qty, { removable: true }), el('div', { class: 'mono small' }, money(l.p.price * l.qty)))))),
      el('div', { class: 'summary' },
        el('div', { class: 'summary__line' }, el('span', null, 'Items'), el('span', { class: 'summary__amount' }, money(itemsTotal()))),
        el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Delivery', el('small', null, 'Set by your zone at checkout')), el('span', { class: 'summary__amount' }, 'from ' + money(fee.amount)))));
  }
  function openCart() {
    const open = (state.settings.store || {}).open !== false;
    const ls = lines();
    MDM.ui.drawer.open({ title: 'Your cart', body: cartBody(), onClose: () => {},
      footer: ls.length ? el('div', { class: 'row store-drawer-foot' },
        el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => MDM.ui.drawer.close() } }, 'Keep shopping'),
        el('button', { type: 'button', class: 'btn btn--primary', disabled: !open, 'data-testid': 'store-checkout', on: { click: () => { MDM.ui.drawer.close(); location.hash = 'checkout'; } } }, 'Checkout')) : null });
  }

  // ---- Checkout ------------------------------------------------------------------------------------------------------------
  function checkoutSummary(zone) {
    const fee = deliveryFee(zone);
    return el('div', { class: 'summary', 'data-testid': 'store-summary' },
      lines().map(l => el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, l.qty + ' × ' + l.p.name), el('span', { class: 'summary__amount' }, money(l.p.price * l.qty)))),
      el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Delivery', el('small', null, fee.from ? 'Choose your zone' : (fee.size === 'box' ? 'Travels as a Box' : 'Travels as a Bag') + ' from our store in ' + MDM.geo.zoneLabel((state.settings.store || {}).zone || 'male'))), el('span', { class: 'summary__amount' }, (fee.from ? 'from ' : '') + money(fee.amount))),
      fee.quote ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'We confirm the delivery price for this zone before dispatch.')) : null,
      el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, 'Total'), el('span', { 'data-testid': 'store-total' }, money(itemsTotal() + fee.amount))));
  }
  function renderCheckout() {
    const ls = lines();
    if (!ls.length) { history.replaceState(null, '', location.pathname); state.view = 'catalogue'; renderCatalogue(); return; }
    const me = state.me || {}, c = state.customer || {};
    const saved = (c.addresses || [])[0] || {};
    const form = el('form', { class: 'form store-form', novalidate: true, 'data-testid': 'store-form' });
    const submit = el('button', { type: 'submit', class: 'btn btn--brand btn--lg', 'data-testid': 'store-submit' }, 'Place order');
    const failure = el('div', { class: 'alert alert--danger', role: 'alert', tabindex: '-1', hidden: true });
    const sumSlot = el('div');
    const f = (name, label, control, opts) => { control.name = name; return MDM.ui.field(Object.assign({ name, label, control }, opts || {})); };
    const zoneSel = el('select', { class: 'select', 'data-testid': 'store-zone', value: saved.zone || '' }, el('option', { value: '' }, 'Choose your zone'), MDM.geo.zoneOptions().map(o => el('option', { value: o.value }, o.label)));
    const pay = el('fieldset', { class: 'segmented segmented--stack', 'data-testid': 'store-pay' },
      el('label', null, el('input', { class: 'sr-only', type: 'radio', name: 'pay', value: 'later', checked: true }), el('span', null, 'Pay after delivery', el('small', null, 'Bank transfer once it arrives'))),
      el('label', null, el('input', { class: 'sr-only', type: 'radio', name: 'pay', value: 'now', 'data-testid': 'store-pay-now' }), el('span', null, 'Pay now', el('small', null, 'Transfer now and upload the slip'))));
    form.append(
      el('h2', { class: 'h3' }, 'Your details'),
      el('div', { class: 'grid-2' },
        f('name', 'Name', el('input', { class: 'input', autocomplete: 'name', value: me.name || c.name || '', 'data-testid': 'store-name' })),
        f('phone', 'Mobile number', el('input', { class: 'input', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '7XX XXXX', value: me.phone || '', 'data-testid': 'store-phone' }), { hint: 'We send the order code and updates here' })),
      el('h2', { class: 'h3 store-form__h' }, 'Delivery'),
      f('address', 'Address', el('input', { class: 'input', autocomplete: 'street-address', placeholder: 'House or building, floor, road', value: saved.address || '', 'data-testid': 'store-address' })),
      el('div', { class: 'grid-2' }, f('zone', 'Island or zone', zoneSel), f('landmark', 'Landmark', el('input', { class: 'input', placeholder: 'Near the mosque' }), { optional: true })),
      f('instructions', 'Instructions for the rider', el('input', { class: 'input', placeholder: 'Call when downstairs' }), { optional: true }),
      el('h2', { class: 'h3 store-form__h' }, 'Payment'),
      MDM.ui.field({ label: 'When do you pay?', control: pay, hint: 'Bank transfer to BML or MIB. Card payments are not taken.' }),
      failure,
      el('div', { class: 'form-actions' }, el('a', { class: 'btn btn--ghost', href: '#', on: { click: e => { e.preventDefault(); history.replaceState(null, '', location.pathname); state.view = 'catalogue'; paint(); } } }, 'Back to the store'), submit));
    const drawSum = () => sumSlot.replaceChildren(checkoutSummary(zoneSel.value));
    zoneSel.addEventListener('change', drawSum); drawSum();
    const rules = {
      name: v => v ? null : 'Enter your name', phone: v => !v ? 'Enter your mobile number' : (MDM.ui.phone.valid(v) ? null : 'Enter a 7-digit Maldives mobile number'),
      address: v => v ? null : 'Enter the delivery address', zone: v => v ? null : 'Choose your zone',
    };
    form.addEventListener('submit', async e => {
      e.preventDefault(); failure.hidden = true;
      const r = MDM.ui.validate(form, rules);
      if (!r.ok) { MDM.ui.focusFirstInvalid(form); return; }
      if ((state.settings.store || {}).open === false) { failure.replaceChildren(html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' }, 'The store is closed right now.')); failure.hidden = false; return; }
      MDM.ui.setLoading(submit, true);
      try {
        const v = r.values;
        const phone = MDM.ui.phone.normalize(v.phone);
        const delivery = { address: v.address, zone: v.zone, landmark: String(form.elements.landmark.value || '').trim(), instructions: String(form.elements.instructions.value || '').trim() };
        const cust = await MDM.store.upsertCustomer({ name: v.name, phone, notify: (state.customer && state.customer.notify) || 'whatsapp', address: { label: 'Home', address: v.address, zone: v.zone, meetAt: 'door' } });
        const order = await MDM.store.createStoreOrder({
          items: lines().map(l => ({ productId: l.p.id, qty: l.qty })), customerId: cust.id,
          customer: { name: v.name, phone, email: cust.email || '', notify: cust.notify || 'whatsapp' },
          delivery, schedule: { type: 'asap' }, payNow: form.elements.pay.value === 'now',
        });
        writeCart([]);
        try { if (!state.me) localStorage.setItem('mdm:me', JSON.stringify({ name: v.name, phone, email: cust.email || '', notify: cust.notify || 'whatsapp', signedInAt: new Date().toISOString() })); } catch (err) { /* storage blocked */ }
        location.href = MDM.href('track/?code=' + encodeURIComponent(order.code));
      } catch (err) {
        failure.replaceChildren(html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' }, (err && err.message) || 'We could not place the order. Please try again.'));
        failure.hidden = false; failure.focus();
        await loadProducts();
      } finally { if (document.contains(submit)) MDM.ui.setLoading(submit, false); }
    });
    app.replaceChildren(el('div', { class: 'container' },
      el('div', { class: 'page-head' }, el('h1', null, 'Checkout'), el('p', { class: 'page-head__desc' }, MDM.ui.plural(itemCount(), 'item') + ' from the Mr. Delivery Man store.')),
      el('div', { class: 'store-checkout' }, form, el('aside', { class: 'store-checkout__aside' }, el('h2', { class: 'h3' }, 'Order summary'), sumSlot))));
  }

  // ---- Render ----------------------------------------------------------------------------------------------------------------
  function paint() {
    state.view = location.hash === '#checkout' ? 'checkout' : 'catalogue';
    if (state.view === 'checkout') {
      // Re-rendering the checkout would wipe what was typed; only the summary and the cart button follow the cart.
      if (!app.querySelector('[data-testid="store-form"]')) renderCheckout();
    } else renderCatalogue();
    if (MDM.ui.drawer.isOpen()) { MDM.ui.drawer.setBody(cartBody()); if (!lines().length) MDM.ui.drawer.setFooter(null); }
  }
  async function loadProducts() { state.products = (await MDM.store.list('products', { order: 'createdAt' })).sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0)); }
  async function main() {
    await MDM.store.ready;
    try { state.me = JSON.parse(localStorage.getItem('mdm:me') || 'null'); } catch (e) { state.me = null; }
    state.settings = await MDM.store.settings();
    if (state.me && state.me.phone) state.customer = (await MDM.store.list('customers', { where: { phone: state.me.phone } }))[0] || null;
    await loadProducts();
    paint();
    window.addEventListener('hashchange', () => { app.replaceChildren(); paint(); window.scrollTo(0, 0); });
    MDM.store.subscribe('products', async () => { await loadProducts(); if (state.view === 'catalogue') paint(); });
    MDM.store.subscribe('settings', async () => { state.settings = await MDM.store.settings(); if (state.view === 'catalogue') paint(); });
    window.addEventListener('storage', e => { if (e.key === CART) { memCart = null; paint(); } });
  }
  main();
})(window.MDM);

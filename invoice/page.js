// Customer invoice (client requirements §4; web app updates §3, §6): /invoice/?order=MDM-1031 (code or id). Renders the order's frozen
// prices: store items, packages, the shopping budget with the item list, the cargo / airport / shopping fees, the extra vehicle charge,
// billable charges (packing, naalu or other when billed; never voided or non-billable ones) and the total, with the delivery method,
// the payment status and the bank details from settings. Only the order's owner opens it (MDM.ownsOrder: our office, the business
// that sent it, the customer signed in with the order's number, or the browser that placed it; privacy, 24/10/2026); anyone else who
// has the code is asked to sign in. Forced light; print rules for body.page-invoice are in css/base.css. Updates 17/10/2026: Maldivian Cargo charges from the
// counter's bill, the shopping budget of a shop stop on a multi-collection order, and the estimate note for a price set after collection.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const BRAND = 'Mr. Delivery Man';
  const slot = document.querySelector('[data-slot="invoice"]');
  const money = n => MDM.pricing.format(n, { cents: true });
  const fmtDate = iso => MDM.ui.fmtDate(iso, { dateOnly: true, year: true });
  const row = (label, value, opts) => MDM.ui.rateRow(label, value, opts);
  const CHARGE_STAGE = { collection: 'at collection', delivery: 'at delivery' };
  const pointLabel = v => ((MDM.geo.airportPoints().find(x => x.value === v) || {}).label || '');
  const jettyLabel = v => ((MDM.geo.terminals().find(t => t.value === v) || {}).label || '');
  const vesselLabel = v => ((MDM.VESSEL_TYPES.find(x => x.value === v) || {}).label || 'Boat').replace(' (dhoni)', '');
  // Fee rows: airport, cargo and shopping fees, then adjustments. A charge is on the invoice only while billable (§6).
  function feeRows(o, settings) {
    const adjs = {}, charges = o.charges || [];
    ((o.fees || {}).adjustments || []).forEach(a => { adjs[a.id] = a; });
    return MDM.pricing.feeLines(o, settings).map(f => {
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
  // §2.3: the size each package had before our team changed its category, from the order's change log ({ pkgId: 'box' }).
  function sizeFrom(o) {
    const out = {};
    (o.changes || []).forEach(c => { const m = /^package (.+) size$/.exec(c.field || ''); if (m && c.from && !out[m[1]]) out[m[1]] = c.from; });
    return out;
  }
  // 'H. Blue Lagoon, Huraa' + 'Huraa, Kaafu Atoll' → 'H. Blue Lagoon, Huraa, Kaafu Atoll' (the island is not repeated).
  function withIsland(address, island) {
    const a = String(address || '').trim(), parts = String(island || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!a) return parts.join(', ');
    const low = a.toLowerCase();
    return [a].concat(parts.filter(x => low.indexOf(x.toLowerCase()) < 0)).join(', ');
  }
  // Delivery method (§3) with where the package was handed over: the vessel at the jetty, the cargo counter, the airport counter.
  function methodRows(o) {
    const d = o.delivery || {}, m = d.method || 'home';
    let detail = '', to = (d.address || '') + (d.zone ? ', ' + MDM.geo.zoneLabel(d.zone) : '');
    if (m === 'boat') {
      const b = d.boat || {};
      detail = [vesselLabel(b.vesselType) + (b.name ? ' ' + b.name : ''), b.departureTime ? 'departs ' + b.departureTime : '', jettyLabel(b.jetty) ? 'from ' + jettyLabel(b.jetty) : ''].filter(Boolean).join(', ');
      to = withIsland(b.address, b.island) || to;
    } else if (m === 'cargo') {
      const c = d.cargo || {};
      detail = c.counter || MDM.geo.cargoCounter().label;
      to = [c.consignee, c.island].filter(Boolean).join(', ') || to;
    } else if (m === 'airport') {
      const a = d.airport || {};
      detail = [a.counter, pointLabel(a.point)].filter(Boolean).join(', ');
      to = 'Velana International Airport' + (a.resort ? ' (for ' + a.resort + ')' : '');
    }
    const drops = [], seen = {};
    if (m === 'home') (o.packages || []).forEach(p => { const e = p.dropoff || {}, r = e.recipient || {}, k = (e.address || '') + '|' + (r.name || ''); if (e.address && !seen[k]) { seen[k] = 1; drops.push([r.name, e.address].filter(Boolean).join(', ')); } });
    return [row('Delivery method', el('span', { 'data-testid': 'invoice-method' }, MDM.deliveryMethodLabel(m)), { valueSub: detail || null }),
      row(o.status === 'delivered' ? 'Delivered to' : 'Delivery to', drops.length > 1 ? drops.map(x => el('span', { class: 'invoice-drop' }, x))
        : [d.recipientName && to.indexOf(d.recipientName) !== 0 ? d.recipientName : '', to].filter(Boolean).join(', '))];
  }

  // A business order is invoiced to the business every week. Its receiver (who has the order code from the label or a message) never
  // sees the agreed rate: only the business signed in on this browser (mdm:business) or our office (mdm:session) opens its invoice.
  const isBusinessOrder = o => !!(o.accountId || o.service === 'business' || o.requestType === 'bulk' || o.requestType === 'business');
  function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function mayOpen(o) {
    if (!isBusinessOrder(o)) return true;
    const biz = readJson('mdm:business'), office = readJson('mdm:session');
    return !!((biz && biz.accountId && biz.accountId === o.accountId) || (office && office.role));
  }
  function billedToBusiness(o) {
    const name = (o.customer && o.customer.name) || 'the business';
    document.title = 'Invoice · ' + BRAND;
    const cod = o.cod && o.cod.amount > 0 && o.cod.status === 'pending' && ['delivered', 'returned', 'cancelled'].indexOf(o.status) < 0 ? o.cod : null;
    slot.replaceChildren(el('div', { class: 'page-head' }, el('h1', null, 'Invoice')), el('div', { class: 'empty', 'data-testid': 'invoice-business-only' },
      el('p', { class: 'empty__title' }, 'Delivery arranged by ' + name),
      el('p', { class: 'empty__hint' }, 'It is billed to ' + name + ', so there is no invoice here.' + (cod ? ' Pay the driver ' + MDM.pricing.format(cod.amount) + ' in cash on delivery.' : '')),
      el('a', { class: 'btn btn--secondary', href: MDM.href('track/?code=' + encodeURIComponent(o.code)) }, 'Track ' + o.code)));
  }
  // Someone who is not the order's owner (a mistyped or shared code): no amounts, names or addresses, just a way to sign in.
  function notOwner(o) {
    document.title = 'Invoice · ' + BRAND;
    const back = 'invoice/?order=' + encodeURIComponent(o.code);
    const login = MDM.href('login/?' + (isBusinessOrder(o) ? 'as=business&' : '') + 'next=' + encodeURIComponent(back));
    slot.replaceChildren(el('div', { class: 'page-head' }, el('h1', null, 'Invoice')), el('div', { class: 'empty', 'data-testid': 'invoice-private' },
      el('p', { class: 'empty__title' }, 'This invoice is private'),
      el('p', { class: 'empty__hint' }, 'Sign in with the number on the order to see it.'),
      el('div', { class: 'row row--wrap invoice-private__actions' },
        el('a', { class: 'btn btn--primary btn--sm', href: login, 'data-testid': 'invoice-signin' }, 'Sign in'),
        el('a', { class: 'btn btn--secondary btn--sm', href: MDM.href('track/?code=' + encodeURIComponent(o.code)) }, 'Track ' + o.code))));
  }
  function notFound() {
    document.title = 'Invoice · ' + BRAND;
    slot.replaceChildren(el('div', { class: 'page-head' }, el('h1', null, 'Invoice')), el('div', { class: 'empty', 'data-testid': 'invoice-missing' },
      el('p', { class: 'empty__title' }, 'No invoice for this link'),
      el('p', { class: 'empty__hint' }, 'Check the link in your message.'),
      el('a', { class: 'btn btn--secondary btn--sm', href: MDM.href('track/') }, 'Track an order')));
  }
  function line(desc, sub, amount, fee, key) {
    return el('div', { class: ['summary__line', fee ? 'summary__line--fee' : null], dataset: key ? { fee: key } : null },
      el('span', { class: 'summary__desc' }, desc, sub ? el('span', { class: 'summary__sub' }, sub) : null),
      el('span', { class: 'summary__amount mono' }, money(amount)));
  }

  async function render(key) {
    let o = key ? await MDM.store.orderByCode(key) : null;
    if (!o && key) o = await MDM.store.get('orders', key);
    if (!o) { notFound(); return; }
    if (MDM.ownsOrder && !MDM.ownsOrder(o)) { notOwner(o); return; }
    if (!mayOpen(o)) { billedToBusiness(o); return; }
    const settings = await MDM.store.settings();
    const contact = settings.contact || {}, banks = settings.banks || [];
    const holders = banks.map(b => b.accountName).filter((v, i, a) => v && a.indexOf(v) === i), sharedName = holders.length === 1 ? holders[0] : null;
    const p = o.payment || {};
    const number = p.invoiceNo || 'INV-' + o.code.replace('MDM-', '');
    const confirmed = o.pricing && o.pricing.status === 'confirmed';
    const delivered = (o.statusHistory || []).filter(h => h.to === 'delivered').pop();
    const issued = p.requestedAt || (delivered && delivered.at) || (o.pricing && o.pricing.confirmedAt) || o.createdAt;
    const dueDays = Number(settings.invoiceDueDays) || 14;
    document.title = 'Invoice ' + number + ' · ' + BRAND;

    const printBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'invoice-print', on: { click: () => window.print() } }, html(MDM.icon('printer', 16)), 'Print or save PDF');
    const trackBtn = el('a', { class: 'btn btn--ghost', href: MDM.href('track/?code=' + encodeURIComponent(o.code)) }, 'Track ' + o.code);
    const payBtn = (p.status === 'requested' || (p.status === 'pending' && confirmed)) && p.method !== 'invoice' && o.status !== 'cancelled'
      ? el('a', { class: 'btn btn--brand', href: MDM.href('checkout/?order=' + encodeURIComponent(o.id)), 'data-testid': 'invoice-pay' }, 'Pay ' + MDM.pricing.format(o.totals.total)) : null;

    const brand = el('div', { class: 'invoice-brand' },
      el('img', { src: '../assets/logo-lockup.svg', alt: BRAND }),
      el('div', { class: 'invoice-brand__meta' }, BRAND + ' · Greater Malé', el('br'), [MDM.ui.phone.format(contact.phone || ''), contact.email].filter(Boolean).join(' · ')));

    const details = el('div', { class: 'rate-table' },
      row('Invoice number', el('span', { class: 'mono mono--code' }, number)),
      row('Order', el('span', { class: 'mono mono--code' }, o.code)),
      row('Issued', fmtDate(issued)),
      row('Due', p.status === 'paid' ? 'Paid ' + fmtDate(p.verifiedAt || p.paidAt) : fmtDate(new Date(new Date(issued).getTime() + dueDays * 86400000).toISOString())),
      row('Status', html(MDM.payBadge(p.status))));
    const c = o.customer || {};
    const billTo = el('div', { class: 'rate-table', 'data-testid': 'invoice-bill-to' },
      row('Name', c.name || ''), c.phone ? row('Phone', MDM.ui.phone.format(c.phone), { mono: true }) : null, c.email ? row('Email', c.email) : null,
      methodRows(o));

    const lines = [];
    (o.items || []).forEach(it => lines.push(line(it.qty + ' × ' + it.name, it.unit ? MDM.pricing.format(it.price) + ' per ' + it.unit : null, it.total)));
    const from = sizeFrom(o);
    (o.packages || []).forEach(pk => lines.push(line(MDM.pricing.lineLabel(pk, o.service),
      [pk.description, from[pk.id] && from[pk.id] !== pk.size ? 'changed from ' + MDM.pricing.sizeLabel(from[pk.id]) + ' by our team' : ''].filter(Boolean).join(' · ') || null, pk.price ? pk.price.lineTotal : 0)));
    // Shop & deliver: the budget (or receipt) line carries the shopping list so the shopping fee reads against it.
    // A shop stop on a multi-collection order carries its list the same way.
    const shopItems = o.service === 'shop' && Array.isArray((o.details || {}).items) ? o.details.items.filter(i => i && i.name) : [];
    const extraShops = (o.extraCollections || []).filter(c => c.kind === 'shop' && c.shop);
    const shopList = shopItems.length ? shopItems.map(i => (i.qty || 1) + ' × ' + i.name).join(', ') : extraShops.map(c => [c.shop.name, c.shop.list].filter(Boolean).join(': ')).join('; ');
    const receipt = o.packages.some(x => x.shop && x.shop.receiptTotal > 0) || extraShops.some(c => c.shop.receiptTotal > 0);
    if ((o.service === 'shop' || extraShops.length) && o.totals.budget) lines.push(line(receipt ? 'Shopping receipt' : 'Items', shopList || null, o.totals.budget, false, 'shop-budget'));
    feeRows(o, settings).forEach(f => lines.push(line(f.label, f.reason || null, f.amount, true, f.key)));
    const summary = el('div', { class: 'summary', 'data-testid': 'invoice-summary' }, lines, el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, confirmed ? 'Total' : 'Estimated total'), el('span', { class: 'mono', 'data-testid': 'invoice-total' }, money(o.totals.total))),
      p.paidAmount != null && (p.status === 'paid' || p.status === 'received') ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, p.status === 'paid' ? 'Paid' : 'Transfer received, being checked'), el('span', { class: 'summary__amount mono' }, money(p.paidAmount))) : null,
      p.refund ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Refunded'), el('span', { class: 'summary__amount mono' }, money(-p.refund.amount))) : null);

    const payBlock = p.method === 'invoice'
      ? el('section', { class: 'invoice-block' }, el('h2', null, 'Payment'), el('p', null, 'This order is billed on your weekly business invoice.'))
      : el('section', { class: 'invoice-block', 'aria-labelledby': 'inv-pay' },
        el('h2', { id: 'inv-pay' }, p.status === 'paid' ? 'Paid by bank transfer' : 'Pay by bank transfer'),
        // BML and MIB in MVR and USD (the currency is in each name); one shared account name is printed once.
        el('div', { class: 'rate-table', 'data-testid': 'invoice-banks' },
          sharedName ? row('Account name', sharedName) : null,
          banks.map(b => row(el('span', { class: 'invoice-bank' }, b.name), el('span', null, el('span', { class: 'mono' }, b.accountNo), sharedName ? null : el('small', null, b.accountName))))),
        el('p', { class: 'small muted', style: { marginTop: '8px' } }, 'Use ', el('span', { class: 'mono mono--code' }, o.code), ' as the transfer reference.'));

    slot.replaceChildren(
      el('div', { class: 'page-head page-head--stack' }, el('h1', { tabindex: '-1' }, 'Invoice ' + number),
        el('div', { class: 'page-head__actions invoice-actions no-print' }, payBtn, printBtn, trackBtn)),
      brand,
      el('div', { class: 'stack-8' },
        !confirmed ? MDM.ui.notice('warn', MDM.priceAfterCollection(o) ? 'Estimate. We confirm the final price after collection.' : 'Estimate. We confirm the final price before collection.') : null,
        el('div', { class: 'invoice-parties' },
          el('section', null, el('h2', null, 'Invoice'), details),
          el('section', null, el('h2', null, 'Billed to'), billTo)),
        el('section', { class: 'invoice-block', 'aria-labelledby': 'inv-items' }, el('h2', { id: 'inv-items' }, MDM.requestTypeLabel(o.requestType)), summary),
        payBlock),
      el('p', { class: 'invoice-foot' }, settings.terms || ''));
  }

  async function main() {
    await MDM.store.ready;
    const q = new URLSearchParams(location.search);
    const key = q.get('order') || q.get('code');
    await render(key);
    const again = () => { render(key).catch(() => {}); };
    MDM.store.subscribe('orders', again);
    MDM.store.subscribe('settings', again);
  }
  main();
})(window.MDM);

// Customer invoice (client requirements §4): /invoice/?order=MDM-1031 (code or id). Renders the order's frozen prices: store items,
// packages, fees, adjustments and the total, with the payment status and the bank details from settings. The link is what we
// message the customer after delivery, so it needs no sign-in. Forced light; print rules for body.page-invoice are in css/base.css.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const BRAND = 'Mr. Delivery Man';
  const slot = document.querySelector('[data-slot="invoice"]');
  const money = n => MDM.pricing.format(n, { cents: true });
  const fmtDate = iso => MDM.ui.fmtDate(iso, { dateOnly: true, year: true });
  const row = (label, value, opts) => MDM.ui.rateRow(label, value, opts);

  function notFound() {
    document.title = 'Invoice · ' + BRAND;
    slot.replaceChildren(el('div', { class: 'page-head' }, el('h1', null, 'Invoice')), el('div', { class: 'empty', 'data-testid': 'invoice-missing' },
      el('p', { class: 'empty__title' }, 'No invoice for this link.'),
      el('p', { class: 'empty__hint' }, 'Check the link in your message, or track the order with its code.'),
      el('a', { class: 'btn btn--secondary btn--sm', href: MDM.href('track/') }, 'Track an order')));
  }
  function line(desc, sub, amount, fee) {
    return el('div', { class: ['summary__line', fee ? 'summary__line--fee' : null] },
      el('span', { class: 'summary__desc' }, desc, sub ? el('span', { class: 'summary__sub' }, sub) : null),
      el('span', { class: 'summary__amount mono' }, money(amount)));
  }

  async function render(key) {
    let o = key ? await MDM.store.orderByCode(key) : null;
    if (!o && key) o = await MDM.store.get('orders', key);
    if (!o) { notFound(); return; }
    const settings = await MDM.store.settings();
    const contact = settings.contact || {}, banks = settings.banks || [];
    const p = o.payment || {};
    const number = p.invoiceNo || 'INV-' + o.code.replace('MDM-', '');
    const confirmed = o.pricing && o.pricing.status === 'confirmed';
    const delivered = (o.statusHistory || []).filter(h => h.to === 'delivered').pop();
    const issued = p.requestedAt || (delivered && delivered.at) || (o.pricing && o.pricing.confirmedAt) || o.createdAt;
    const dueDays = Number(settings.invoiceDueDays) || 14;
    document.title = 'Invoice ' + number + ' · ' + BRAND;

    const printBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'invoice-print', on: { click: () => window.print() } }, html(MDM.icon('printer', 16)), 'Print or save as PDF');
    const trackBtn = el('a', { class: 'btn btn--ghost', href: MDM.href('track/?code=' + encodeURIComponent(o.code)) }, 'Track ' + o.code);
    const payBtn = (p.status === 'requested' || (p.status === 'pending' && confirmed)) && p.method !== 'invoice' && o.status !== 'cancelled'
      ? el('a', { class: 'btn btn--brand', href: MDM.href('checkout/?order=' + encodeURIComponent(o.id)), 'data-testid': 'invoice-pay' }, 'Pay ' + MDM.pricing.format(o.totals.total)) : null;

    const brand = el('div', { class: 'invoice-brand' },
      el('img', { src: '../assets/logo-lockup.svg', alt: BRAND }),
      el('div', { class: 'invoice-brand__meta' }, BRAND + ' · Greater Malé', el('br'), [MDM.ui.phone.format(contact.phone || ''), contact.email].filter(Boolean).join(' · ')));

    const details = el('div', { class: 'rate-table' },
      row('Invoice number', number, { mono: true }),
      row('Order', o.code, { mono: true }),
      row('Issued', fmtDate(issued)),
      row('Due', p.status === 'paid' ? 'Paid ' + fmtDate(p.verifiedAt || p.paidAt) : fmtDate(new Date(new Date(issued).getTime() + dueDays * 86400000).toISOString())),
      row('Status', html(MDM.payBadge(p.status))));
    const c = o.customer || {};
    const billTo = el('div', { class: 'rate-table', 'data-testid': 'invoice-bill-to' },
      row('Name', c.name || ''), c.phone ? row('Phone', MDM.ui.phone.format(c.phone), { mono: true }) : null, c.email ? row('Email', c.email) : null,
      row('Delivered to', ((o.delivery || {}).recipientName || '') + ((o.delivery || {}).address ? ', ' + o.delivery.address : '')));

    const lines = [];
    (o.items || []).forEach(it => lines.push(line(it.qty + ' × ' + it.name, it.unit ? MDM.pricing.format(it.price) + ' per ' + it.unit : null, it.total)));
    (o.packages || []).forEach(pk => lines.push(line(MDM.pricing.lineLabel(pk, o.service), pk.description || null, pk.price ? pk.price.lineTotal : 0)));
    if (o.service === 'shop' && o.totals.budget) lines.push(line(o.packages.some(x => x.shop && x.shop.receiptTotal > 0) ? 'Shopping receipt' : 'Shopping budget', null, o.totals.budget));
    MDM.pricing.feeLines(o, settings).forEach(f => lines.push(line(f.label, f.reason || null, f.amount, true)));
    const summary = el('div', { class: 'summary', 'data-testid': 'invoice-summary' }, lines, el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, confirmed ? 'Total' : 'Estimated total'), el('span', { class: 'mono', 'data-testid': 'invoice-total' }, money(o.totals.total))),
      p.paidAmount != null && (p.status === 'paid' || p.status === 'received') ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, p.status === 'paid' ? 'Paid' : 'Transfer received, being checked'), el('span', { class: 'summary__amount mono' }, money(p.paidAmount))) : null,
      p.refund ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Refunded'), el('span', { class: 'summary__amount mono' }, money(-p.refund.amount))) : null);

    const payBlock = p.method === 'invoice'
      ? el('section', { class: 'invoice-block' }, el('h2', null, 'Payment'), el('p', null, 'This order is billed on your monthly business invoice.'))
      : el('section', { class: 'invoice-block', 'aria-labelledby': 'inv-pay' },
        el('h2', { id: 'inv-pay' }, p.status === 'paid' ? 'Paid by bank transfer' : 'Pay by bank transfer'),
        el('div', { class: 'rate-table', 'data-testid': 'invoice-banks' }, banks.map(b => row(b.name, el('span', null, el('span', { class: 'mono' }, b.accountNo), el('small', null, b.accountName))))),
        el('p', { class: 'small muted', style: { marginTop: '8px' } }, 'Use ', el('span', { class: 'mono' }, o.code), ' as the transfer reference.'));

    slot.replaceChildren(
      el('div', { class: 'page-head page-head--stack' }, el('h1', { tabindex: '-1' }, 'Invoice ' + number),
        el('div', { class: 'page-head__actions invoice-actions no-print' }, payBtn, printBtn, trackBtn)),
      brand,
      el('div', { class: 'stack-8' },
        !confirmed ? MDM.ui.notice('warn', 'This is an estimate. Our team confirms the final price before collection.') : null,
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

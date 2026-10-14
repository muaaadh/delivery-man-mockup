// Printable invoice (SPEC §3.7): /admin/invoice.html?id=<invoiceId>. Renders the stored invoice row as issued (its lines and
// totals are frozen by MDM.store.createInvoice), with the business account's details and the bank details from settings.
// The URL is what the admin sends to the business, so the page needs no sign-in. Print styles live in css/base.css (body.page-invoice).
// Web app updates 11/10/2026: package lines show the agreed size category, the Maldivian Cargo and airport fees the store adds are
// their own lines and subtotals, and a cash on delivery summary for the month sits below (it is paid separately, not invoiced).
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const BRAND = 'Mr. Delivery Man';
  const slot = document.querySelector('[data-slot="invoice"]');
  const money = n => MDM.pricing.format(n, { cents: true });
  const fmtDate = (iso, o) => MDM.ui.fmtDate(iso, Object.assign({ dateOnly: true, year: true }, o || {}));
  const monthLabel = key => { const m = /^(\d{4})-(\d{2})$/.exec(key || ''); return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : String(key || ''); };
  const STATUS = { draft: { label: 'Draft', kind: 'neutral' }, sent: { label: 'Sent', kind: 'info' }, paid: { label: 'Paid', kind: 'ok' } };
  // Line kinds: a package, the Maldivian Cargo fee (once per cargo order), the airport fee, or another charge (price adjustments, packing,
  // naalu billed, extra vehicle). createInvoice stamps l.kind ('package' | 'cargo' | 'airport' | 'adjustment'); invoices issued before
  // that carry no kind, so they fall back to the package count and the fee description.
  const KINDS = { package: 'package', cargo: 'cargo', airport: 'airport', adjustment: 'other' };
  function lineKind(l) {
    if (l.kind) return KINDS[l.kind] || 'other';
    if (Number(l.packages) > 0) return 'package';
    if (/cargo fee/i.test(l.description || '')) return 'cargo';
    if (/airport fee/i.test(l.description || '')) return 'airport';
    return 'other';
  }
  const KIND_LABEL = { cargo: 'Fee', airport: 'Fee', other: 'Charge' };

  function rateRow(label, value, opts) {
    opts = opts || {};
    return el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, label), el('div', { class: 'rate-table__value' + (opts.mono ? ' mono' : '') }, value));
  }
  function pageHead(title, desc, action) {
    return el('div', { class: 'page-head' }, el('h1', { tabindex: '-1' }, title), desc ? el('p', { class: 'page-head__desc' }, desc) : null, action ? el('div', { class: 'page-head__actions no-print' }, action) : null);
  }
  function notFound() {
    document.title = 'Invoice · ' + BRAND;
    slot.replaceChildren(pageHead('Invoice'), el('div', { class: 'empty', 'data-testid': 'invoice-missing' },
      el('p', { class: 'empty__title' }, 'No invoice with this link.'),
      el('p', { class: 'empty__hint' }, 'Check the link you were sent, or ask us for the invoice again.')));
  }

  async function render(id) {
    const inv = id ? await MDM.store.get('invoices', id) : null;
    if (!inv) { notFound(); return; }
    const [account, settings, orders] = await Promise.all([MDM.store.get('business_accounts', inv.accountId), MDM.store.settings(), MDM.store.list('orders', { where: { accountId: inv.accountId } })]);
    const contact = settings.contact || {}, banks = settings.banks || [];
    const ownPhone = MDM.ui.phone.format(contact.phone || '');
    document.title = 'Invoice ' + inv.number + ' · ' + BRAND;

    const printBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'invoice-print', on: { click: () => window.print() } }, html(MDM.icon('printer', 16)), 'Print');
    const head = pageHead('Invoice ' + inv.number, BRAND + ' · Greater Malé' + (ownPhone ? ' · ' + ownPhone : '') + (contact.email ? ' · ' + contact.email : ''), printBtn);

    const invoiceTable = el('div', { class: 'rate-table' },
      rateRow('Invoice number', inv.number, { mono: true }),
      rateRow('Period', monthLabel(inv.month)),
      rateRow('Issued', fmtDate(inv.issuedAt)),
      rateRow('Due', inv.status === 'paid' ? 'Paid ' + fmtDate(inv.paidAt) : fmtDate(inv.dueAt)),
      rateRow('Status', html(MDM.ui.badge((STATUS[inv.status] || STATUS.draft).kind, (STATUS[inv.status] || STATUS.draft).label, { 'data-status': inv.status, 'data-testid': 'invoice-status' }))));
    const billTo = el('div', { class: 'rate-table', 'data-testid': 'invoice-bill-to' });
    if (account) {
      billTo.append(...[
        rateRow('Business', account.name),
        account.contactName ? rateRow('Contact', account.contactName) : null,
        account.pickupAddress ? rateRow('Address', el('span', { class: 'invoice-address' }, account.pickupAddress + (account.zone ? ', ' + MDM.geo.zoneLabel(account.zone) : ''))) : null,
        account.tin ? rateRow('TIN', account.tin, { mono: true }) : null,
        account.phone ? rateRow('Phone', MDM.ui.phone.format(account.phone), { mono: true }) : null,
        account.email ? rateRow('Email', account.email) : null].filter(Boolean));
    } else billTo.append(rateRow('Business', 'Account no longer on file'));

    const lines = inv.lines || [];
    // The agreed size category of a package line: stamped on the line (l.tier, l.size) since the 11/10/2026 update; for older invoices it is
    // read from the order it came from (one package per bulk order; else matched by description and recipient).
    const tierLabel = v => (MDM.pricing.businessTiers(settings).find(t => t.value === v) || {}).label || v;
    const tierOf = l => {
      if (l.kind) return l.tier ? tierLabel(l.tier) : (l.size ? MDM.pricing.sizeLabel(l.size) : '');
      const o = orders.find(x => x.code === l.orderCode); if (!o) return '';
      const pk = (o.packages || []).length === 1 ? o.packages[0] : (o.packages || []).find(p => (p.description || '') === (l.description || '') && (!l.recipient || (p.dropoff && p.dropoff.recipient && p.dropoff.recipient.name === l.recipient)));
      const tier = pk && (pk.tier || (pk.price && pk.price.tier));
      return tier ? tierLabel(tier) : '';
    };
    const rows = lines.map(l => {
      const kind = lineKind(l), tier = kind === 'package' ? tierOf(l) : '';
      return el('tr', { 'data-testid': 'invoice-line', 'data-kind': kind, class: kind === 'package' ? null : 'invoice-line--fee' },
        el('td', { 'data-label': 'Date' }, MDM.ui.fmtDate(l.date, { dateOnly: true })),
        el('td', { 'data-label': 'Order', class: 'mono' }, l.orderCode || ''),
        el('td', { 'data-label': 'Details' }, kind === 'package' ? el('span', null, l.recipient || l.description || '', l.recipient && l.description ? el('span', { class: 'table__sub' }, l.description) : null)
          : el('span', null, l.description || 'Charge', el('span', { class: 'table__sub' }, kind === 'cargo' ? 'Delivered through Maldivian Cargo' : kind === 'airport' ? 'Airport delivery' : 'Added to this order'))),
        el('td', { 'data-label': 'Packages', class: 'num mono' }, kind === 'package' ? String(l.packages || 1) : KIND_LABEL[kind]),
        el('td', { 'data-label': 'Rate', class: 'num mono' + (kind === 'package' ? '' : ' invoice-cell--empty') }, kind === 'package' ? el('span', null, money(l.rate), tier ? el('span', { class: 'table__sub', 'data-testid': 'invoice-line-tier' }, tier) : null) : ''),
        el('td', { 'data-label': 'Amount', class: 'num mono' }, money(l.amount)));
    });
    const table = el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack', 'data-testid': 'invoice-lines' },
      el('thead', null, el('tr', null, ['Date', 'Order', 'Details', 'Packages', 'Rate', 'Amount'].map((h, i) => el('th', { scope: 'col', class: i >= 3 ? 'num' : null }, h)))),
      el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: '6' }, 'No delivered packages in ' + monthLabel(inv.month) + '.')))));
    const packages = lines.filter(l => lineKind(l) === 'package').reduce((n, l) => n + (Number(l.packages) || 1), 0);
    const kindSum = k => lines.filter(l => lineKind(l) === k).reduce((n, l) => n + (Number(l.amount) || 0), 0);
    const kindCount = k => lines.filter(l => lineKind(l) === k).length;
    const feeLine = (k, text, testid) => kindCount(k) ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, text, el('span', { class: 'summary__sub' }, kindCount(k) + (kindCount(k) === 1 ? ' order' : ' orders'))), el('span', { class: 'summary__amount mono', 'data-testid': testid }, money(kindSum(k)))) : null;
    const hasFees = ['cargo', 'airport', 'other'].some(k => kindCount(k));

    const summary = el('div', { class: 'summary', 'data-testid': 'invoice-summary' },
      hasFees ? el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, 'Deliveries', el('span', { class: 'summary__sub' }, packages + (packages === 1 ? ' package' : ' packages'))), el('span', { class: 'summary__amount mono', 'data-testid': 'invoice-deliveries' }, money(kindSum('package')))) : null,
      feeLine('cargo', 'Maldivian Cargo fees', 'invoice-fee-cargo'), feeLine('airport', 'Airport fees', 'invoice-fee-airport'), feeLine('other', 'Other charges', 'invoice-fee-other'),
      el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, 'Subtotal', hasFees ? null : el('span', { class: 'summary__sub' }, packages + (packages === 1 ? ' package' : ' packages'))), el('span', { class: 'summary__amount mono' }, money(inv.subtotal))),
      Number(inv.gstPercent) > 0 ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'GST ' + inv.gstPercent + '%'), el('span', { class: 'summary__amount mono', 'data-testid': 'invoice-gst' }, money(inv.gst))) : null,
      el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, 'Total'), el('span', { class: 'mono', 'data-testid': 'invoice-total' }, money(inv.total))));

    const bankTable = el('div', { class: 'rate-table', 'data-testid': 'invoice-banks' },
      banks.map(b => rateRow(b.name, el('span', null, el('span', { class: 'mono' }, b.accountNo), el('small', null, b.accountName)), { mono: false })));
    const payBlock = el('section', { 'aria-labelledby': 'inv-pay' },
      el('div', { class: 'section-head' }, el('h2', { id: 'inv-pay' }, 'Pay by bank transfer'),
        el('p', { class: 'section-head__desc' }, inv.status === 'paid' ? 'Received with thanks' + (inv.reference ? ', reference ' + inv.reference : '') + '.' : 'Due by ' + fmtDate(inv.dueAt) + '. Use the invoice number as the transfer reference.')),
      bankTable,
      el('p', { class: 'invoice-reference' }, 'Reference: ', el('span', { class: 'mono', 'data-testid': 'invoice-reference' }, inv.number)));
    const codBlock = codSummary(orders, inv.month);

    slot.replaceChildren(head,
      el('div', { class: 'stack-8' },
        el('div', { class: 'invoice-parties' },
          el('section', { 'aria-labelledby': 'inv-details' }, el('h2', { id: 'inv-details' }, 'Invoice'), invoiceTable),
          el('section', { 'aria-labelledby': 'inv-billto' }, el('h2', { id: 'inv-billto' }, 'Billed to'), billTo)),
        el('section', { 'aria-labelledby': 'inv-items' },
          el('div', { class: 'section-head' }, el('h2', { id: 'inv-items' }, 'Deliveries in ' + monthLabel(inv.month)),
            account ? el('p', { class: 'section-head__desc', 'data-testid': 'invoice-rates' }, 'Agreed rates per package: ' + MDM.pricing.accountTiers(account, settings).map(t => t.label + ' ' + MDM.pricing.format(t.rate)).join(', ') + '. Maldivian Cargo and airport fees are listed as their own lines.') : null),
          el('div', { class: 'stack-6' }, table, summary)),
        codBlock,
        payBlock));
  }

  // Cash on delivery for the invoice month (§5.6): cash our drivers collected from the business's customers. Orders count when their
  // cash was due, collected or paid out in the month. It is paid to the business separately, so it is not part of the invoice total.
  function codSummary(orders, month) {
    const inMonth = iso => !!iso && String(MDM.ui.monthKey(iso)) === month;
    const list = orders.filter(o => o.cod && o.cod.amount > 0 && (inMonth(o.createdAt) || inMonth(o.cod.collectedAt) || inMonth(o.cod.remittedAt)));
    if (!list.length) return null;
    const sum = (arr, k) => arr.reduce((n, o) => n + (k === 'amount' ? o.cod.amount : (o.cod.collectedAmount || 0)), 0);
    const by = st => list.filter(o => o.cod.status === st);
    const collected = list.filter(o => ['collected', 'with_office', 'remitted'].indexOf(o.cod.status) >= 0);
    const paid = by('remitted'), held = list.filter(o => o.cod.status === 'collected' || o.cod.status === 'with_office');
    const toCollect = by('pending').filter(o => o.status !== 'cancelled'), missed = list.filter(o => o.cod.status === 'not_collected' || (o.cod.status === 'pending' && o.status === 'cancelled'));
    const n = (arr, w) => arr.length + ' ' + w + (arr.length === 1 ? '' : 's');
    // Payments to the business, grouped by transfer reference.
    const pays = {};
    paid.forEach(o => { const k = (o.cod.remittanceRef || 'No reference') + '|' + MDM.ui.dayKey(o.cod.remittedAt); const p = pays[k] || (pays[k] = { ref: o.cod.remittanceRef || '', at: o.cod.remittedAt, codes: [], amount: 0 }); p.codes.push(o.code); p.amount += o.cod.collectedAmount || 0; });
    const payRows = Object.keys(pays).map(k => pays[k]).sort((a, b) => a.at < b.at ? -1 : 1);
    return el('section', { 'aria-labelledby': 'inv-cod', 'data-testid': 'invoice-cod' },
      el('div', { class: 'section-head' }, el('h2', { id: 'inv-cod' }, 'Cash on delivery in ' + monthLabel(month)),
        el('p', { class: 'section-head__desc invoice-cod-note' }, 'Cash our drivers collected from your customers. We pay it to you separately; it is not part of this invoice total.')),
      el('div', { class: 'stack-6' },
        el('div', { class: 'rate-table' },
          rateRow('Cash on delivery entered on your orders', el('span', { 'data-testid': 'invoice-cod-entered' }, money(sum(list, 'amount')), el('small', null, n(list, 'order'))), { mono: true }),
          rateRow('Collected by our drivers', el('span', { 'data-testid': 'invoice-cod-collected' }, money(sum(collected)), el('small', null, n(collected, 'order'))), { mono: true }),
          rateRow('Paid to you', el('span', { 'data-testid': 'invoice-cod-paid' }, money(sum(paid)), el('small', null, n(paid, 'order'))), { mono: true }),
          rateRow('Outstanding, held by us', el('span', { 'data-testid': 'invoice-cod-outstanding' }, money(sum(held)), el('small', null, n(held, 'order'))), { mono: true }),
          toCollect.length ? rateRow('Not delivered yet', el('span', null, money(sum(toCollect, 'amount')), el('small', null, n(toCollect, 'order'))), { mono: true }) : null,
          missed.length ? rateRow('Not collected', el('span', null, money(sum(missed, 'amount')), el('small', null, n(missed, 'order') + ', cancelled or refused')), { mono: true }) : null),
        payRows.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack', 'data-testid': 'invoice-cod-payments' },
          el('thead', null, el('tr', null, ['Paid', 'Reference', 'Orders', 'Amount'].map((h, i) => el('th', { scope: 'col', class: i === 3 ? 'num' : null }, h)))),
          el('tbody', null, payRows.map(p => el('tr', null,
            el('td', { 'data-label': 'Paid' }, fmtDate(p.at)),
            el('td', { 'data-label': 'Reference', class: 'mono' }, p.ref || 'No reference'),
            el('td', { 'data-label': 'Orders', class: 'mono' }, p.codes.join(', ')),
            el('td', { 'data-label': 'Amount', class: 'num mono' }, money(p.amount))))))) : null));
  }

  async function main() {
    await MDM.store.ready;
    const id = new URLSearchParams(location.search).get('id');
    await render(id);
    const again = () => { render(id).catch(() => {}); };
    MDM.store.subscribe('invoices', again);
    MDM.store.subscribe('settings', again);
    MDM.store.subscribe('orders', again);
    MDM.store.subscribe('*', m => { if (m && m.op === 'reset') again(); });
  }
  main();
})(window.MDM);

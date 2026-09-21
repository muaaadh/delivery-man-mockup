// Printable invoice (SPEC §3.7): /admin/invoice.html?id=<invoiceId>. Renders the stored invoice row as issued (its lines and
// totals are frozen by MDM.store.createInvoice), with the business account's details and the bank details from settings.
// The URL is what the admin sends to the business, so the page needs no sign-in. Print styles live in css/base.css (body.page-invoice).
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const BRAND = 'Mr. Delivery Man';
  const slot = document.querySelector('[data-slot="invoice"]');
  const money = n => MDM.pricing.format(n, { cents: true });
  const fmtDate = (iso, o) => MDM.ui.fmtDate(iso, Object.assign({ dateOnly: true, year: true }, o || {}));
  const monthLabel = key => { const m = /^(\d{4})-(\d{2})$/.exec(key || ''); return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : String(key || ''); };
  const STATUS = { draft: { label: 'Draft', kind: 'neutral' }, sent: { label: 'Sent', kind: 'info' }, paid: { label: 'Paid', kind: 'ok' } };

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
    const [account, settings] = await Promise.all([MDM.store.get('business_accounts', inv.accountId), MDM.store.settings()]);
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
    const rows = lines.map(l => el('tr', { 'data-testid': 'invoice-line' },
      el('td', { 'data-label': 'Date' }, MDM.ui.fmtDate(l.date, { dateOnly: true })),
      el('td', { 'data-label': 'Order', class: 'mono' }, l.orderCode || ''),
      el('td', { 'data-label': 'Recipient' }, el('span', null, l.recipient || l.description || '', l.recipient && l.description ? el('span', { class: 'table__sub' }, l.description) : null)),
      el('td', { 'data-label': 'Packages', class: 'num mono' }, l.packages ? String(l.packages) : ''),
      el('td', { 'data-label': 'Rate', class: 'num mono' }, l.packages ? money(l.rate) : ''),
      el('td', { 'data-label': 'Amount', class: 'num mono' }, money(l.amount))));
    const table = el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack', 'data-testid': 'invoice-lines' },
      el('thead', null, el('tr', null, ['Date', 'Order', 'Recipient', 'Packages', 'Rate', 'Amount'].map((h, i) => el('th', { scope: 'col', class: i >= 3 ? 'num' : null }, h)))),
      el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: '6' }, 'No delivered packages in ' + monthLabel(inv.month) + '.')))));
    const packages = lines.reduce((n, l) => n + (Number(l.packages) || 0), 0);

    const summary = el('div', { class: 'summary', 'data-testid': 'invoice-summary' },
      el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, 'Subtotal', el('span', { class: 'summary__sub' }, packages + (packages === 1 ? ' package' : ' packages'))), el('span', { class: 'summary__amount mono' }, money(inv.subtotal))),
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

    slot.replaceChildren(head,
      el('div', { class: 'stack-8' },
        el('div', { class: 'invoice-parties' },
          el('section', { 'aria-labelledby': 'inv-details' }, el('h2', { id: 'inv-details' }, 'Invoice'), invoiceTable),
          el('section', { 'aria-labelledby': 'inv-billto' }, el('h2', { id: 'inv-billto' }, 'Billed to'), billTo)),
        el('section', { 'aria-labelledby': 'inv-items' },
          el('div', { class: 'section-head' }, el('h2', { id: 'inv-items' }, 'Deliveries in ' + monthLabel(inv.month)),
            account ? el('p', { class: 'section-head__desc' }, 'Business rate ' + MDM.pricing.format(account.ratePerPackage) + ' per package under 1 ft within Malé and Hulhumalé, other packages at the standard rate.') : null),
          el('div', { class: 'stack-6' }, table, summary)),
        payBlock));
  }

  async function main() {
    await MDM.store.ready;
    const id = new URLSearchParams(location.search).get('id');
    await render(id);
    const again = () => { render(id).catch(() => {}); };
    MDM.store.subscribe('invoices', again);
    MDM.store.subscribe('settings', again);
    MDM.store.subscribe('*', m => { if (m && m.op === 'reset') again(); });
  }
  main();
})(window.MDM);

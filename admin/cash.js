// Admin #/cash, "Cash & COD" (web app updates 11/10/2026 §5.6 and §6): cash on delivery from the driver to the office to the
// business, and the naalu / packing / other charges drivers paid on proof of collection and delivery, for reconciliation.
// Same view contract as ops.js (mount / update / unmount, one render() on store changes); helpers come from MDM.admin.kit
// (views.js and ops.js). Money moves only through MDM.store.cashHandover / remitCash / setChargeBillable.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const K = MDM.admin.kit, F = MDM.admin.fmt;
  const money = n => MDM.pricing.format(n);
  const toast = (msg, kind) => MDM.ui.toast(msg, kind || 'ok');
  const icon = (name, size) => html(MDM.icon(name, size || 16));
  const by = () => MDM.admin.by();
  const plural = (n, w, p) => MDM.ui.plural(n, w, p);
  const dayKey = d => MDM.ui.dayKey(d);
  const fmtDay = k => F.fmtDay(k);
  const { pageHead, sectionHead, card, empty, badge, table, run, kpi, tabs, dateInput, inRange, queryOf } = K;
  const COLLECTED = ['collected', 'with_office', 'remitted'];
  const codOf = o => o.cod && o.cod.amount > 0 ? o.cod : null;
  const orderLink = o => el('a', { class: 'mono', href: '#/orders/' + encodeURIComponent(o.id), 'data-testid': 'cash-order-link' }, o.code);
  const variance = c => c.variance != null ? c.variance : (c.collectedAmount != null ? c.collectedAmount - c.amount : 0);
  const diffText = v => v === 0 ? 'None' : (v > 0 ? '+' : '') + money(v);

  MDM.admin.views.cash = (function () {
    let ctx = null, root = null, tabsEl = null, filtersEl = null, body = null, tab = 'cod', range = null, account = '';
    const TABS = [{ value: 'cod', label: 'Cash on delivery' }, { value: 'charges', label: 'Naalu and charges' }];
    const PRESETS = [{ value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: 'month', label: 'This month' }, { value: 'last', label: 'Last month' }];
    function preset(p) {
      const now = new Date(), y = now.getFullYear(), m = now.getMonth();
      if (p === '7d') return { from: dayKey(new Date(Date.now() - 6 * 864e5)), to: dayKey(now) };
      if (p === '30d') return { from: dayKey(new Date(Date.now() - 29 * 864e5)), to: dayKey(now) };
      if (p === 'last') return { from: dayKey(new Date(y, m - 1, 1)), to: dayKey(new Date(y, m, 0)) };
      return { from: dayKey(new Date(y, m, 1)), to: dayKey(now) };
    }
    function readQuery(params) {
      const q = queryOf(params);
      tab = TABS.some(t => t.value === q.get('tab')) ? q.get('tab') : 'cod';
      range = q.get('from') ? { from: q.get('from'), to: q.get('to') || dayKey(new Date()) } : preset('30d');
      account = q.get('account') || '';
    }
    async function mount(host, params) {
      ctx = K.context(); root = host;
      readQuery(params);
      tabsEl = el('div', { class: 'cash-tabs' }); filtersEl = el('div', { class: 'cash-filters' }); body = el('div', { class: 'stack-6' });
      root.replaceChildren(pageHead('Cash & COD', 'Cash our drivers collect for business customers: receive it from the driver, then pay it to the business. Naalu and other charges drivers paid on the way: reimburse the driver and bill the customer.'), tabsEl, filtersEl, body);
      ['orders', 'drivers', 'business_accounts'].forEach(c => ctx.sub(c, () => ctx.schedule(render)));
      ctx.sub('*', m => { if (m && m.op === 'reset') ctx.schedule(render); });
      await render();
    }
    async function update(params) { readQuery(params); await render(); }
    function unmount() { if (ctx) ctx.dispose(); ctx = null; root = null; }
    function setQuery() { MDM.admin.setQuery({ tab: tab === 'cod' ? null : tab, from: range.from, to: range.to, account: account || null }); }

    async function render() {
      const [orders, drivers, accounts] = await Promise.all([MDM.store.list('orders', { order: 'code' }), MDM.store.list('drivers', { order: 'name' }), MDM.store.list('business_accounts')]);
      if (!ctx || !ctx.alive) return;
      tabsEl.replaceChildren(tabs(TABS, tab, t => { tab = t; setQuery(); ctx.schedule(render); }, 'cash-tab'));
      filtersEl.replaceChildren(filters(accounts));
      const data = { orders, drivers, accounts, driverName: id => F.driverName(id, drivers) || 'Driver', accountName: id => (accounts.find(a => a.id === id) || {}).name || 'Business' };
      if (tab === 'charges') body.replaceChildren(...chargesTab(data)); else body.replaceChildren(...codTab(data));
    }
    function filters(accounts) {
      const from = dateInput('cash-from', range.from, 'From'), to = dateInput('cash-to', range.to, 'To');
      [from, to].forEach(x => x.addEventListener('change', () => { range = { from: from.value, to: to.value }; setQuery(); ctx.schedule(render); }));
      const biz = tab === 'cod' ? el('select', { class: 'select', 'aria-label': 'Business', 'data-testid': 'cash-account' }, el('option', { value: '' }, 'All businesses'), accounts.map(a => el('option', { value: a.id }, a.name))) : null;
      if (biz) { biz.value = account; biz.addEventListener('change', () => { account = biz.value; setQuery(); ctx.schedule(render); }); }
      return el('div', { class: 'filters' },
        el('div', { class: 'row row--wrap' }, PRESETS.map(p => { const r = preset(p.value); return el('button', { type: 'button', class: 'chip', 'aria-pressed': r.from === range.from && r.to === range.to ? 'true' : 'false', 'data-testid': 'cash-preset-' + p.value, on: { click: () => { range = r; setQuery(); ctx.schedule(render); } } }, p.label); })),
        el('span', { class: 'filters__dates' }, from, el('span', { class: 'filters__dash' }, 'to'), to), biz,
        range.from && range.to && range.from > range.to ? K.rangeWarning() : null);
    }

    // ==== Cash on delivery ===========================================================================================================
    function codTab(d) {
      const cod = d.orders.filter(o => codOf(o) && (!account || o.accountId === account));
      const st = s => cod.filter(o => o.cod.status === s);
      const withDrivers = st('collected'), withOffice = st('with_office'), pending = st('pending').filter(o => o.status !== 'cancelled');
      const paid = st('remitted').filter(o => inRange(o.cod.remittedAt, range.from, range.to)).sort((a, b) => a.cod.remittedAt < b.cod.remittedAt ? 1 : -1);
      const notCollected = cod.filter(o => o.cod.status === 'not_collected' || (o.cod.status === 'pending' && o.status === 'cancelled')).filter(o => inRange(o.cod.collectedAt || o.cancelledAt || o.updatedAt, range.from, range.to));
      const diffs = cod.filter(o => COLLECTED.indexOf(o.cod.status) >= 0 && variance(o.cod) !== 0 && inRange(o.cod.collectedAt, range.from, range.to));
      const sumGot = list => list.reduce((t, o) => t + (o.cod.collectedAmount || 0), 0);
      const sumDue = list => list.reduce((t, o) => t + o.cod.amount, 0);
      const kpis = el('div', { class: 'kpi-row kpi-row--fluid', 'data-testid': 'cash-kpis' },
        kpi('With drivers', money(sumGot(withDrivers)), plural(withDrivers.length, 'order') + ' to receive', 'cash-drivers'),
        kpi('With the office', money(sumGot(withOffice)), plural(withOffice.length, 'order') + ' to pay out', 'cash-office'),
        kpi('To collect', money(sumDue(pending)), plural(pending.length, 'order') + ' not delivered yet', 'cash-pending'),
        kpi('Paid to businesses', money(sumGot(paid)), plural(paid.length, 'order') + ' in this period', 'cash-paid'),
        kpi('Cash differences', diffText(diffs.reduce((t, o) => t + variance(o.cod), 0)), plural(diffs.length, 'order') + ' in this period', 'cash-variance'));

      // Cash with drivers, by driver: "Receive cash" → MDM.store.cashHandover.
      const byDriver = {};
      withDrivers.forEach(o => { const k = K.driverOfBy(o.cod.collectedBy, o) || 'none'; (byDriver[k] = byDriver[k] || []).push(o); });
      const driverCols = [
        { label: 'Order', primary: true, render: o => orderLink(o) },
        { label: 'Business', render: o => el('span', null, d.accountName(o.accountId), el('span', { class: 'table__sub' }, (o.delivery || {}).recipientName || '')) },
        { label: 'Collected', nowrap: true, render: o => F.whenCell(o.cod.collectedAt) },
        { label: 'Expected', num: true, render: o => money(o.cod.amount) },
        { label: 'Collected amount', num: true, render: o => money(o.cod.collectedAmount || 0) },
        { label: 'Difference', num: true, render: o => diffCell(variance(o.cod)) },
      ];
      const driverCards = Object.keys(byDriver).map(k => {
        const list = byDriver[k], total = sumGot(list), name = k === 'none' ? 'No driver recorded' : d.driverName(k);
        return card(groupHead(name, plural(list.length, 'order') + ' · ' + money(total) + ' in cash', k === 'none' ? null : el('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-testid': 'cash-receive', on: { click: () => run(() => receive(k, name, list)) } }, 'Receive cash')),
          table(driverCols, list.map(o => ({ data: o, attrs: { 'data-testid': 'cash-driver-row', 'data-order-id': o.id, 'data-code': o.code } })), { testid: 'cash-driver-' + k }), { 'data-testid': 'cash-driver', 'data-driver-id': k });
      });

      // With the office, by business: "Pay the business" → MDM.store.remitCash.
      const byAccount = {};
      withOffice.forEach(o => { (byAccount[o.accountId] = byAccount[o.accountId] || []).push(o); });
      const officeCols = [
        { label: 'Order', primary: true, render: o => orderLink(o) },
        { label: 'Recipient', render: o => (o.delivery || {}).recipientName || '' },
        { label: 'Driver', render: o => d.driverName(K.driverOfBy(o.cod.collectedBy, o)) },
        { label: 'Received', nowrap: true, render: o => el('span', null, F.whenCell(o.cod.handedAt), o.cod.handoverRef ? el('span', { class: 'table__sub' }, o.cod.handoverRef) : null) },
        { label: 'Amount', num: true, render: o => money(o.cod.collectedAmount || 0) },
      ];
      const officeCards = Object.keys(byAccount).map(k => {
        const list = byAccount[k], total = sumGot(list), name = d.accountName(k);
        return card(groupHead(name, plural(list.length, 'order') + ' · ' + money(total) + ' to pay', el('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-testid': 'cash-remit', on: { click: () => run(() => remit(k, name, list)) } }, 'Pay the business')),
          table(officeCols, list.map(o => ({ data: o, attrs: { 'data-testid': 'cash-office-row', 'data-order-id': o.id, 'data-code': o.code } })), { testid: 'cash-office-' + k }), { 'data-testid': 'cash-account-group', 'data-account-id': k });
      });

      const pendingCols = [
        { label: 'Order', primary: true, render: o => orderLink(o) },
        { label: 'Business', render: o => el('span', null, d.accountName(o.accountId), el('span', { class: 'table__sub' }, (o.delivery || {}).recipientName || '')) },
        { label: 'Status', render: o => html(MDM.badgeFor(o.status)) },
        { label: 'Driver', render: o => F.driverName(o.driverId, d.drivers) || el('span', { class: 'subtle' }, 'Unassigned') },
        { label: 'Amount', num: true, render: o => money(o.cod.amount) },
      ];
      const paidCols = [
        { label: 'Paid', nowrap: true, render: o => MDM.ui.fmtDate(o.cod.remittedAt) },
        { label: 'Order', primary: true, render: o => orderLink(o) },
        { label: 'Business', render: o => d.accountName(o.accountId) },
        { label: 'Reference', render: o => el('span', { class: 'mono', 'data-testid': 'cash-paid-ref' }, o.cod.remittanceRef || '') },
        { label: 'Paid by', render: o => F.byLabel(o.cod.remittedBy) },
        { label: 'Amount', num: true, render: o => money(o.cod.collectedAmount || 0) },
      ];
      const issueCols = [
        { label: 'Order', primary: true, render: o => orderLink(o) },
        { label: 'Business', render: o => d.accountName(o.accountId) },
        { label: 'Driver', render: o => F.driverName(K.driverOfBy(o.cod.collectedBy, o), d.drivers) || '' },
        { label: 'Cash', render: o => el('span', null, K.codBadge(o.status === 'cancelled' && o.cod.status === 'pending' ? 'not_collected' : o.cod.status), el('span', { class: 'table__sub' }, o.cod.note || (o.status === 'cancelled' ? 'Order cancelled' : ''))) },
        { label: 'Expected', num: true, render: o => money(o.cod.amount) },
        { label: 'Collected', num: true, render: o => money(o.cod.collectedAmount || 0) },
        { label: 'Difference', num: true, render: o => o.status === 'cancelled' && (o.cod.status === 'not_collected' || o.cod.status === 'pending') ? el('span', { class: 'subtle', 'data-testid': 'cash-diff-none' }, 'Not due') : diffCell(o.cod.status === 'not_collected' || o.cod.status === 'pending' ? -o.cod.amount : variance(o.cod)) },
      ];
      const issues = notCollected.concat(diffs.filter(o => notCollected.indexOf(o) < 0));
      const scope = account ? ' for ' + d.accountName(account) : '';
      return [kpis,
        el('section', { 'aria-labelledby': 'cash-drv' }, sectionHead('cash-drv', 'Cash with drivers', 'Collected on delivery and not yet handed in' + scope + ', any date. Count the cash, then receive it.'),
          driverCards.length ? el('div', { class: 'stack-4' }, driverCards) : card(null, empty('No cash with drivers.', 'Cash drivers collect on proof of delivery shows here until it is handed in.'))),
        el('section', { 'aria-labelledby': 'cash-off' }, sectionHead('cash-off', 'With the office, to pay businesses', 'Cash handed in by drivers' + scope + ', any date. Pay each business and record the transfer reference.'),
          officeCards.length ? el('div', { class: 'stack-4' }, officeCards) : card(null, empty('Nothing to pay out.', 'Cash received from drivers waits here until it is paid to the business.'))),
        el('section', { 'aria-labelledby': 'cash-pend' }, sectionHead('cash-pend', 'To collect', 'Orders with cash on delivery that are not delivered yet' + scope + '.'),
          card(null, pending.length ? table(pendingCols, pending.map(o => ({ data: o, attrs: { 'data-testid': 'cash-pending-row', 'data-code': o.code } })), { testid: 'cash-pending' }) : empty('Nothing to collect.'))),
        el('section', { 'aria-labelledby': 'cash-paid' }, sectionHead('cash-paid', 'Paid to businesses', 'Cash paid out in this period, with the transfer reference.', csvBtn('cash-export-paid', 'Paid to businesses', () => [['Paid', 'Order', 'Business', 'Reference', 'Paid by', 'Amount MVR']].concat(paid.map(o => [o.cod.remittedAt, o.code, d.accountName(o.accountId), o.cod.remittanceRef || '', F.byLabel(o.cod.remittedBy), o.cod.collectedAmount || 0])), 'paid')),
          card(null, paid.length ? table(paidCols, paid.map(o => ({ data: o, attrs: { 'data-testid': 'cash-paid-row', 'data-code': o.code } })), { testid: 'cash-paid' }) : empty('Nothing paid in this period.'))),
        el('section', { 'aria-labelledby': 'cash-diff' }, sectionHead('cash-diff', 'Not collected and cash differences', 'Orders where the driver brought back less or more than expected, or no cash at all, in this period.'),
          card(null, issues.length ? table(issueCols, issues.map(o => ({ data: o, attrs: { 'data-testid': 'cash-issue-row', 'data-code': o.code } })), { testid: 'cash-issues' }) : empty('No differences in this period.')))];
    }
    function diffCell(v) { return el('span', { class: v < 0 ? 'cash-diff cash-diff--short' : v > 0 ? 'cash-diff cash-diff--over' : 'cash-diff' }, diffText(v)); }
    function groupHead(title, sub, action) {
      return [el('div', { class: 'cash-group__title' }, el('h3', null, title), el('span', { class: 'cash-group__sub' }, sub)), action];
    }
    function csvBtn(testid, title, rows, key) {
      return el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': testid, on: { click: () => { F.downloadCsv(rows(), 'mdm-' + key + '-' + range.from + '-' + range.to + '.csv'); toast(title + ' exported'); } } }, icon('download'), 'CSV');
    }
    function pickFields(list, amountOf) {
      return list.map(o => ({ name: 'o_' + o.id, label: o.code + ' · ' + money(amountOf(o)) + ((o.delivery || {}).recipientName ? ' · ' + o.delivery.recipientName : ''), type: 'checkbox', value: true }));
    }
    async function receive(driverId, name, list) {
      const total = list.reduce((t, o) => t + (o.cod.collectedAmount || 0), 0);
      const v = await MDM.ui.dialog({ title: 'Receive cash from ' + name, message: 'Count the cash: ' + money(total) + ' for ' + plural(list.length, 'order') + '. Untick an order if its cash is not in the envelope.', okLabel: 'Receive cash',
        fields: pickFields(list, o => o.cod.collectedAmount || 0).concat([{ name: 'reference', label: 'Handover reference', type: 'text', placeholder: 'Cash sheet ' + MDM.ui.fmtDate(new Date(), { dateOnly: true }), hint: 'Optional, for example the cash sheet or envelope number' }]),
        validate: vals => list.some(o => vals['o_' + o.id]) ? null : 'Tick at least one order' });
      if (!v) return;
      const ids = list.filter(o => v['o_' + o.id]).map(o => o.id);
      const r = await MDM.store.cashHandover(driverId, { orderIds: ids, reference: v.reference, by: by() });
      if (!r.count) { toast('Nothing received: the cash for ' + (ids.length === 1 ? 'this order' : 'these orders') + ' is no longer with ' + name + ' (already handed in)', 'warn'); return; }
      const missed = ids.length - r.count;
      toast('Received ' + money(r.total) + ' from ' + name + ' for ' + plural(r.count, 'order') + '. It is now with the office.' + (missed ? ' ' + plural(missed, 'order') + ' had already been handed in.' : ''), missed ? 'warn' : 'ok');
    }
    async function remit(accountId, name, list) {
      const total = list.reduce((t, o) => t + (o.cod.collectedAmount || 0), 0);
      const v = await MDM.ui.dialog({ title: 'Pay ' + name, message: 'Pay the cash collected for ' + name + ': ' + money(total) + ' for ' + plural(list.length, 'order') + '. The business is told and sees the payment on its orders.', okLabel: 'Record payment',
        fields: pickFields(list, o => o.cod.collectedAmount || 0).concat([{ name: 'reference', label: 'Transfer reference', type: 'text', required: true, placeholder: 'FT-88214', hint: 'The bank transfer reference, or "Cash" with the receipt number' }]),
        validate: vals => list.some(o => vals['o_' + o.id]) ? null : 'Tick at least one order' });
      if (!v) return;
      const ids = list.filter(o => v['o_' + o.id]).map(o => o.id);
      const r = await MDM.store.remitCash(accountId, { orderIds: ids, reference: v.reference, by: by() });
      if (!r.count) { toast('Nothing paid: ' + (ids.length === 1 ? 'this order was' : 'these orders were') + ' already paid to ' + name, 'warn'); return; }
      const missed = ids.length - r.count;
      toast('Paid ' + money(r.total) + ' to ' + name + ' for ' + plural(r.count, 'order') + ', reference ' + v.reference + (missed ? '. ' + plural(missed, 'order') + ' had already been paid.' : ''), missed ? 'warn' : 'ok');
    }

    // ==== Naalu and charges ==========================================================================================================
    // A charge a driver paid out of pocket (naalu at a jetty, packing, a fee) is owed to that driver until the office reimburses it
    // (MDM.store.reimburseCharges stamps reimbursedAt / reimbursedBy / reimbursementRef). Charges the office paid are never owed.
    const chargeName = c => c.type === 'naalu' ? 'Naalu' : c.type === 'packing' ? 'Packing charge' : 'Other charge';
    const payerOf = x => x.c.paidBy === 'driver' ? (K.driverOfBy(x.c.by, x.o) || 'unknown') : 'office';
    const owedOf = x => x.c.paidBy === 'driver' && !x.c.void && !x.c.reimbursedAt;
    function chargesTab(d) {
      const every = [];
      d.orders.forEach(o => (o.charges || []).forEach(c => { if (!c.void) every.push({ o, c }); }));
      const all = every.filter(x => inRange(x.c.at, range.from, range.to));
      const naalu = all.filter(x => x.c.type === 'naalu');
      const others = all.filter(x => x.c.type !== 'naalu').sort((a, b) => a.c.at < b.c.at ? 1 : -1);
      const owed = every.filter(owedOf);
      const reimbursed = every.filter(x => x.c.reimbursedAt && inRange(x.c.reimbursedAt, range.from, range.to)).sort((a, b) => a.c.reimbursedAt < b.c.reimbursedAt ? 1 : -1);
      const sum = list => list.reduce((t, x) => t + x.c.amount, 0);
      const owedDrivers = {}; owed.forEach(x => { const k = payerOf(x); (owedDrivers[k] = owedDrivers[k] || []).push(x); });
      const kpis = el('div', { class: 'kpi-row kpi-row--fluid', 'data-testid': 'charges-kpis' },
        kpi('Owed to drivers', money(sum(owed)), plural(owed.length, 'charge') + ' · ' + plural(Object.keys(owedDrivers).length, 'driver') + ', any date', 'owed'),
        kpi('Reimbursed', money(sum(reimbursed)), plural(reimbursed.length, 'charge') + ' in this period', 'reimbursed'),
        kpi('Naalu paid', money(sum(naalu)), plural(naalu.length, 'payment') + ' · ' + money(sum(naalu.filter(x => x.c.billable))) + ' billed', 'naalu'),
        kpi('Packing and other', money(sum(others)), money(sum(others.filter(x => x.c.type === 'packing'))) + ' packing · ' + money(sum(others.filter(x => x.c.type === 'other'))) + ' other', 'other'),
        kpi('Not billed', money(sum(all.filter(x => !x.c.billable))), 'paid by us, not charged', 'unbilled'));

      // Owed to drivers, any date: one card per driver with "Reimburse" → MDM.store.reimburseCharges.
      const owedCols = [
        { label: 'Paid', nowrap: true, render: x => F.whenCell(x.c.at) },
        { label: 'Order', primary: true, render: x => orderLink(x.o) },
        { label: 'Charge', render: x => el('span', null, chargeName(x.c) + ' · ' + (K.STAGE[x.c.stage] || x.c.stage || '').toLowerCase(), x.c.description ? el('span', { class: 'table__sub wrap-anywhere' }, x.c.description) : null) },
        { label: 'Amount', num: true, render: x => money(x.c.amount) },
      ];
      const owedKeys = Object.keys(owedDrivers).sort((a, b) => sum(owedDrivers[b]) - sum(owedDrivers[a]));
      const owedCards = owedKeys.map(k => {
        const list = owedDrivers[k].slice().sort((a, b) => a.c.at < b.c.at ? -1 : 1), name = k === 'unknown' ? 'Driver not recorded' : d.driverName(k);
        return card(groupHead(name, plural(list.length, 'charge') + ' · ' + money(sum(list)) + ' owed', k === 'unknown' ? null : el('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-testid': 'reimburse-open', on: { click: () => run(() => reimburse(k, name, list)) } }, 'Reimburse')),
          table(owedCols, list.map(x => ({ data: x, attrs: { 'data-testid': 'owed-row', 'data-code': x.o.code, 'data-charge-id': x.c.id, 'data-type': x.c.type } })), { testid: 'owed-' + k }), { 'data-testid': 'owed-driver', 'data-driver-id': k });
      });

      // §6.1: naalu by who paid it (driver or the office) and day, with the order, the stage and whether it was reimbursed.
      const groups = {};
      naalu.forEach(x => { const k = payerOf(x); (groups[k] = groups[k] || []).push(x); });
      const keys = Object.keys(groups).sort((a, b) => (a === 'office') - (b === 'office') || sum(groups[b]) - sum(groups[a]));
      const naaluCards = keys.map(k => {
        const list = groups[k].slice().sort((a, b) => a.c.at < b.c.at ? 1 : -1);
        const name = k === 'office' ? 'Paid by the office' : k === 'unknown' ? 'Driver not recorded' : d.driverName(k);
        const stillOwed = list.filter(owedOf);
        const days = {}; list.forEach(x => { const dk = dayKey(x.c.at); (days[dk] = days[dk] || []).push(x); });
        return card(groupHead(name, plural(list.length, 'payment') + (k === 'office' ? '' : ' · ' + (stillOwed.length ? money(sum(stillOwed)) + ' still owed' : 'all reimbursed')), el('span', { class: 'cash-group__total mono', 'data-testid': 'naalu-driver-total' }, money(sum(list)))),
          el('div', { class: 'naalu-days' }, Object.keys(days).sort().reverse().map(dk => el('div', { class: 'naalu-day', 'data-day': dk },
            el('div', { class: 'naalu-day__head' }, el('span', null, fmtDay(dk)), el('span', { class: 'mono' }, money(sum(days[dk])))),
            el('ul', { class: 'list' }, days[dk].map(x => el('li', { class: 'list__item', 'data-testid': 'naalu-row', 'data-code': x.o.code, 'data-stage': x.c.stage, 'data-amount': String(x.c.amount), 'data-reimbursed': x.c.reimbursedAt ? 'yes' : 'no' },
              el('div', { class: 'list__main' },
                el('div', { class: 'list__title' }, orderLink(x.o), badge(x.c.stage === 'collection' ? 'info' : 'neutral', K.STAGE[x.c.stage] || x.c.stage, { 'data-stage': x.c.stage }), reimbursedBadge(x)),
                el('div', { class: 'list__meta' }, [x.c.description, MDM.ui.fmtTime(x.c.at), x.o.delivery && x.o.delivery.boat && x.o.delivery.boat.name ? x.o.delivery.boat.name : ''].filter(Boolean).join(' · '))),
              el('div', { class: 'list__aside naalu-aside' }, el('span', { class: 'mono' }, money(x.c.amount)), billToggle(x)))))))),
          { 'data-testid': 'naalu-driver', 'data-driver-id': k });
      });
      const payerName = x => x.c.paidBy === 'driver' ? d.driverName(payerOf(x)) : 'Office';
      const statusText = x => x.c.paidBy !== 'driver' ? 'paid by the office' : x.c.reimbursedAt ? 'reimbursed ' + dayKey(x.c.reimbursedAt) + (x.c.reimbursementRef ? ' ref ' + x.c.reimbursementRef : '') : 'owed to the driver';
      const naaluCsv = () => [['Paid by', 'Date', 'Order', 'Stage', 'Description', 'Amount MVR', 'Billed to customer', 'Reimbursement']].concat(naalu.slice().sort((a, b) => a.c.at < b.c.at ? -1 : 1).map(x => [payerName(x), dayKey(x.c.at), x.o.code, K.STAGE[x.c.stage] || x.c.stage, x.c.description || '', x.c.amount, x.c.billable ? 'yes' : 'no', statusText(x)]));
      const reimbCols = [
        { label: 'Reimbursed', nowrap: true, render: x => MDM.ui.fmtDate(x.c.reimbursedAt) },
        { label: 'Driver', primary: true, render: x => d.driverName(payerOf(x)) },
        { label: 'Order', render: x => orderLink(x.o) },
        { label: 'Charge', render: x => el('span', null, chargeName(x.c), el('span', { class: 'table__sub' }, 'paid ' + MDM.ui.fmtDate(x.c.at, { dateOnly: true }))) },
        { label: 'Reference', render: x => el('span', { class: 'mono wrap-anywhere', 'data-testid': 'reimbursed-ref' }, x.c.reimbursementRef || '') },
        { label: 'By', render: x => F.byLabel(x.c.reimbursedBy) },
        { label: 'Amount', num: true, render: x => money(x.c.amount) },
      ];
      const reimbCsv = () => [['Reimbursed', 'Driver', 'Order', 'Charge', 'Paid on', 'Reference', 'By', 'Amount MVR']].concat(reimbursed.map(x => [x.c.reimbursedAt, d.driverName(payerOf(x)), x.o.code, chargeName(x.c), dayKey(x.c.at), x.c.reimbursementRef || '', F.byLabel(x.c.reimbursedBy), x.c.amount]));
      const chargeCols = [
        { label: 'Date', nowrap: true, render: x => F.whenCell(x.c.at) },
        { label: 'Order', primary: true, render: x => orderLink(x.o) },
        { label: 'Charge', render: x => el('span', null, chargeName(x.c), el('span', { class: 'table__sub wrap-anywhere' }, x.c.description || '')) },
        { label: 'Recorded', render: x => el('span', null, K.STAGE[x.c.stage] || x.c.stage || '', el('span', { class: 'table__sub' }, x.c.paidBy === 'driver' ? 'paid by ' + d.driverName(payerOf(x)) + (x.c.reimbursedAt ? ', reimbursed' : ', owed') : 'paid by the office')) },
        { label: 'Amount', num: true, render: x => money(x.c.amount) },
        { label: 'Billed', render: x => x.c.billable ? badge('ok', 'Billed', { 'data-billed': 'yes' }) : badge('neutral', 'Not billed', { 'data-billed': 'no' }) },
        { label: 'Actions', actions: true, render: x => billToggle(x) },
      ];
      const chargesCsv = () => [['Date', 'Order', 'Charge', 'Description', 'Recorded', 'Paid by', 'Amount MVR', 'Billed', 'Reimbursement']].concat(others.map(x => [dayKey(x.c.at), x.o.code, chargeName(x.c), x.c.description || '', K.STAGE[x.c.stage] || x.c.stage || '', payerName(x), x.c.amount, x.c.billable ? 'yes' : 'no', statusText(x)]));
      return [kpis,
        el('section', { 'aria-labelledby': 'owed-sec' }, sectionHead('owed-sec', 'Owed to drivers', 'Naalu, packing and other charges drivers paid out of their own pocket and not reimbursed yet, any date. Pay the driver, then record it with the voucher or transfer reference.'),
          owedCards.length ? el('div', { class: 'stack-4', 'data-testid': 'owed-list' }, owedCards) : card(null, empty('Nothing owed to drivers.', 'Charges a driver pays on proof of collection or delivery show here until they are reimbursed.'))),
        el('section', { 'aria-labelledby': 'naalu-sec' }, sectionHead('naalu-sec', 'Naalu reconciliation', 'Naalu paid when collecting from or delivering to a boat in this period, by driver and day, and whether it was reimbursed.', csvBtn('naalu-export', 'Naalu', naaluCsv, 'naalu')),
          naaluCards.length ? el('div', { class: 'stack-4', 'data-testid': 'naalu-list' }, naaluCards) : card(null, empty('No naalu in this period.', 'Drivers record naalu on proof of collection or delivery.'))),
        el('section', { 'aria-labelledby': 'reimb-sec' }, sectionHead('reimb-sec', 'Reimbursed to drivers', 'Charges paid back to drivers in this period, with the reference.', csvBtn('reimbursed-export', 'Reimbursements', reimbCsv, 'reimbursed')),
          card(null, reimbursed.length ? table(reimbCols, reimbursed.map(x => ({ data: x, attrs: { 'data-testid': 'reimbursed-row', 'data-code': x.o.code, 'data-charge-id': x.c.id } })), { testid: 'reimbursed-table' }) : empty('Nothing reimbursed in this period.'))),
        el('section', { 'aria-labelledby': 'charges-sec' }, sectionHead('charges-sec', 'Packing and other charges', 'Charges recorded on proof of delivery or by the office in this period. Billed charges are on the customer\'s price.', csvBtn('charges-export', 'Charges', chargesCsv, 'charges')),
          card(null, others.length ? table(chargeCols, others.map(x => ({ data: x, attrs: { 'data-testid': 'charge-row', 'data-code': x.o.code, 'data-type': x.c.type } })), { testid: 'charges-table' }) : empty('No packing or other charges in this period.')))];
    }
    function reimbursedBadge(x) {
      if (x.c.paidBy !== 'driver') return null;
      return x.c.reimbursedAt ? badge('ok', 'Reimbursed', { 'data-testid': 'naalu-reimbursed', title: 'Reimbursed ' + MDM.ui.fmtDate(x.c.reimbursedAt) + (x.c.reimbursementRef ? ', ref ' + x.c.reimbursementRef : '') }) : badge('warn', 'Owed', { 'data-testid': 'naalu-owed' });
    }
    async function reimburse(driverId, name, list) {
      const total = list.reduce((t, x) => t + x.c.amount, 0);
      const v = await MDM.ui.dialog({ title: 'Reimburse ' + name, message: 'Pay ' + name + ' ' + money(total) + ' for ' + plural(list.length, 'charge') + ' paid on the job. Untick a charge you are not paying now.', okLabel: 'Record reimbursement',
        fields: list.map(x => ({ name: 'c_' + x.c.id, label: x.o.code + ' · ' + chargeName(x.c) + ' ' + (K.STAGE[x.c.stage] || '').toLowerCase() + ' · ' + money(x.c.amount), type: 'checkbox', value: true }))
          .concat([{ name: 'reference', label: 'Reimbursement reference', type: 'text', required: true, placeholder: 'PCV-0412', hint: 'The petty cash voucher or bank transfer reference' }]),
        validate: vals => list.some(x => vals['c_' + x.c.id]) ? null : 'Tick at least one charge' });
      if (!v) return;
      const ids = list.filter(x => v['c_' + x.c.id]).map(x => x.c.id);
      const r = await MDM.store.reimburseCharges(driverId, { chargeIds: ids, reference: v.reference, by: by() });
      if (!r.count) { toast('Nothing reimbursed: these charges were already paid back or the order is now with another driver', 'warn'); return; }
      const missed = ids.length - r.count;
      toast('Reimbursed ' + money(r.total) + ' to ' + name + ' for ' + plural(r.count, 'charge') + ', reference ' + v.reference + (missed ? '. ' + plural(missed, 'charge') + ' could not be reimbursed here (already paid back or the order is now with another driver)' : ''), missed ? 'warn' : 'ok');
    }
    // Bill a charge to the customer (it becomes a price adjustment) or take it off the price again.
    function billToggle(x) {
      const done = ['delivered', 'cancelled', 'returned'].indexOf(x.o.status) >= 0 && x.o.payment && x.o.payment.status === 'paid';
      if (done) return el('span', { class: 'table__sub' }, x.c.billable ? 'Billed, paid' : 'Not billed');
      return el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'charge-bill-toggle', 'data-billed': x.c.billable ? 'yes' : 'no',
        on: { click: () => run(async () => { await MDM.store.setChargeBillable(x.o.id, x.c.id, !x.c.billable, by()); toast(x.o.code + ': ' + (x.c.billable ? 'no longer charged to the customer' : money(x.c.amount) + ' added to the customer\'s price')); }) } },
        x.c.billable ? 'Stop billing' : 'Bill customer');
    }
    return { title: 'Cash & COD', mount, update, unmount };
  })();
})(window.MDM);

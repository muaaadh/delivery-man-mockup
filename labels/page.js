// Shipping labels (How it works §9): one 100 × 150 mm label per package, printable on a thermal label printer or A6 paper.
// URL: labels/?order=<orderId|code> · ?code=MDM-1038 · ?orders=<id>,<id> · ?batch=<batchId|code>. Bulk labels print grouped by zone,
// the order the hub sorts them in (client requirements §10). The QR code opens the tracking page for the order.
// Production note: the same markup feeds a server-side PDF (or ZPL for Zebra printers) without changes to the data it reads.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  const toolbar = document.querySelector('[data-slot="toolbar"]');
  const sheet = document.querySelector('[data-slot="labels"]');
  const params = new URLSearchParams(location.search);
  const ZONE_ORDER = () => MDM.geo.ZONE_LIST.map(z => z.key).concat(['other']);

  function trackUrl(code) { return new URL(MDM.href('track/?code=' + encodeURIComponent(code)), location.href).href; }
  // QR as crisp SVG modules; without the CDN library the label still carries the code and the tracking address in text.
  function qrSvg(text) {
    if (typeof window.qrcode !== 'function') return null;
    try {
      const q = window.qrcode(0, 'M'); q.addData(text); q.make();
      const n = q.getModuleCount(); let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + c + ' ' + r + 'h1v1h-1z';
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ' + (n + 4) + ' ' + (n + 4) + '" shape-rendering="crispEdges" role="img" aria-label="QR code to track this package"><rect x="-2" y="-2" width="' + (n + 4) + '" height="' + (n + 4) + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    } catch (e) { return null; }
  }
  const phoneFmt = p => p ? MDM.ui.phone.format(p) : '';
  function dims(pkg) { const d = pkg.dims; return d && d.l ? d.l + ' × ' + d.w + ' × ' + d.h + ' cm' : ''; }
  function serviceFlags(o) {
    const flags = [];
    const pri = o.priority || {};
    if (pri.status === 'approved') flags.push({ text: (MDM.PRIORITY_LEVELS.find(x => x.value === pri.level) || { label: 'Priority' }).label, strong: true });
    else if (o.serviceLevel === 'express') flags.push({ text: 'Express', strong: true });
    if (o.schedule && o.schedule.type === 'advance') flags.push({ text: 'Collect ' + MDM.ui.fmtDate(o.schedule.collectDate + 'T' + (o.schedule.collectTime || '09:00'), { year: false }) });
    return flags;
  }
  function paymentLine(o) {
    const p = o.payment || {};
    if (p.method === 'invoice' || p.status === 'invoiced') return 'Business account';
    if (p.status === 'paid') return 'Paid';
    return 'Pay by transfer';
  }

  function label(o, pkg, i, n, ctx) {
    const drop = pkg.dropoff || {}, rec = drop.recipient || {}, deliv = o.delivery || {};
    const pick = pkg.shop ? { address: pkg.shop.name + ', ' + (pkg.shop.address || ''), zone: pkg.shop.zone } : (pkg.pickup || {});
    const col = o.collection || {};
    const fromName = ctx.account ? ctx.account.name : (col.contactName || (pick.contact && pick.contact.name) || o.customer.name);
    const fromPhone = (pick.contact && pick.contact.phone) || col.contactPhone || o.customer.phone;
    const zone = drop.zone || deliv.zone || 'male';
    const zoneObj = MDM.geo.zone(zone) || {};
    const qr = qrSvg(trackUrl(o.code));
    const batch = ctx.batch;
    const flags = serviceFlags(o);
    const meta = [
      ['Size', MDM.pricing.sizeLabel(pkg.size) + (dims(pkg) ? ' · ' + dims(pkg) : '') + (pkg.weightKg ? ' · ' + pkg.weightKg + ' kg' : '')],
      ['Reference', (o.details && o.details.reference) || pkg.notes || ''],
      ['Contents', pkg.description || ''],
      ['Payment', paymentLine(o)],
    ];
    const det = o.details || {};
    if (o.requestType === 'airport' && det.flight) meta.splice(1, 0, ['Flight', [det.flight, det.flightTime, (MDM.geo.airportPoints().find(a => a.value === det.area) || {}).label].filter(Boolean).join(' · ')]);
    if (o.requestType === 'postal' && det.carrier) meta.splice(1, 0, ['Collect from', [(MDM.CARRIERS.find(c => c.value === det.carrier) || {}).label, det.collectionCode || det.trackingNo].filter(Boolean).join(' · ')]);
    if (o.items && o.items.length) meta.forEach(m => { if (m[0] === 'Contents') m[1] = o.items.map(it => it.qty + ' × ' + it.name).join(', '); });
    const rows = meta.filter(m => m[1]).slice(0, 5);
    return el('article', { class: 'label', 'data-testid': 'label', 'aria-label': 'Label for ' + o.code + ', package ' + i + ' of ' + n },
      el('header', { class: 'label__top' },
        el('span', { class: 'brand label__brand' }, html(MDM.logo())),
        el('div', { class: 'label__flags' },
          pkg.fragile ? el('span', { class: 'label__flag label__flag--outline' }, 'Fragile') : null,
          flags.map(f => el('span', { class: 'label__flag' + (f.strong ? '' : ' label__flag--outline') }, f.text)))),
      el('div', { class: 'label__id' },
        el('div', { class: 'label__idtext' },
          el('div', { class: 'label__code' }, o.code),
          batch && n === 1 ? el('div', { class: 'label__pkg' }, 'Package ' + o.batchIndex + ' of ' + (batch.orderIds || []).length + ' · ' + batch.code)
            : el('div', { class: 'label__pkg' }, 'Package ' + i + ' of ' + n + (batch ? ' · ' + batch.code : '')),
          el('div', { class: 'label__date' }, MDM.ui.fmtDate(o.createdAt, { year: true }))),
        el('div', { class: 'label__qr' }, qr ? html(qr) : el('div', { class: 'label__qr-fallback' }, o.code))),
      el('section', { class: 'label__to' },
        el('div', { class: 'label__k' }, 'Deliver to'),
        el('div', { class: 'label__name' }, rec.name || deliv.recipientName || o.customer.name),
        el('div', { class: 'label__phone' }, phoneFmt(rec.phone || deliv.recipientPhone || o.customer.phone)),
        el('div', { class: 'label__addr' }, drop.address || deliv.address || ''),
        (drop.landmark || deliv.landmark) ? el('div', { class: 'label__landmark' }, drop.landmark || deliv.landmark) : null,
        (drop.instructions || deliv.instructions) ? el('div', { class: 'label__landmark' }, drop.instructions || deliv.instructions) : null),
      el('div', { class: 'label__zone', 'data-zone': zone },
        el('span', { class: 'label__zone-name' }, MDM.geo.zoneLabel(zone)),
        (zoneObj.short || MDM.geo.zoneShort(zone)) !== MDM.geo.zoneLabel(zone) ? el('span', { class: 'label__zone-key' }, zoneObj.short || MDM.geo.zoneShort(zone)) : null),
      el('section', { class: 'label__from' },
        el('div', { class: 'label__k' }, 'From'),
        el('div', { class: 'label__fromline' }, el('strong', null, fromName), fromPhone ? ' · ' + phoneFmt(fromPhone) : ''),
        el('div', { class: 'label__fromline' }, (pick.address || col.address || '') + ' · ' + MDM.geo.zoneShort(pick.zone || col.zone || 'male'))),
      el('dl', { class: 'label__meta' }, rows.map(m => [el('dt', null, m[0]), el('dd', null, m[1])])),
      el('div', { class: 'label__sign' }, el('span', null, 'Received by'), el('span', null, 'Time')),
      el('footer', { class: 'label__foot' }, 'Track: ', el('span', { class: 'label__url' }, trackUrl(o.code).replace(/^https?:\/\//, ''))));
  }

  async function collect() {
    const out = { orders: [], batch: null, account: null, title: 'Shipping labels', back: null };
    const getOrder = async v => (await MDM.store.get('orders', v)) || (await MDM.store.orderByCode(v));
    if (params.get('batch')) {
      const v = params.get('batch');
      const b = (await MDM.store.get('batches', v)) || (await MDM.store.list('batches')).find(x => x.code === String(v).toUpperCase());
      if (b) {
        out.batch = b;
        const kids = await MDM.store.list('orders', { where: { batchId: b.id } });
        const zo = ZONE_ORDER();
        out.orders = kids.sort((a, c) => (zo.indexOf(a.delivery.zone) - zo.indexOf(c.delivery.zone)) || (a.batchIndex - c.batchIndex));
        out.title = 'Labels for ' + b.code;
      }
    } else if (params.get('orders')) {
      for (const id of params.get('orders').split(',').map(s => s.trim()).filter(Boolean)) { const o = await getOrder(id); if (o) out.orders.push(o); }
      out.title = 'Labels for ' + MDM.ui.plural(out.orders.length, 'order');
    } else if (params.get('order') || params.get('code')) {
      const o = await getOrder(params.get('order') || params.get('code'));
      if (o) { out.orders.push(o); out.title = 'Label for ' + o.code; }
    }
    const accId = (out.batch && out.batch.accountId) || (out.orders[0] && out.orders[0].accountId);
    if (accId && out.orders.every(o => o.accountId === accId)) out.account = await MDM.store.get('business_accounts', accId);
    return out;
  }

  async function render() {
    const data = await collect();
    const batches = {};
    for (const o of data.orders) if (o.batchId && !batches[o.batchId]) batches[o.batchId] = data.batch && data.batch.id === o.batchId ? data.batch : await MDM.store.get('batches', o.batchId);
    const labels = [];
    data.orders.forEach(o => {
      const pkgs = o.packages || [];
      pkgs.forEach((pkg, i) => labels.push(label(o, pkg, i + 1, pkgs.length, { batch: o.batchId ? batches[o.batchId] : null, account: data.account })));
    });
    document.title = data.title + ' · Mr. Delivery Man';
    const zones = {};
    data.orders.forEach(o => { const z = (o.delivery || {}).zone || 'male'; zones[z] = (zones[z] || 0) + (o.packages || []).length; });
    const back = document.referrer && new URL(document.referrer).origin === location.origin ? document.referrer : MDM.href('business/');
    toolbar.replaceChildren(el('div', { class: 'labels-toolbar__inner' },
      el('a', { class: 'brand', href: MDM.href(''), 'aria-label': 'Mr. Delivery Man, home' }, html(MDM.logo())),
      el('div', { class: 'labels-toolbar__text' },
        el('h1', null, data.title),
        el('p', { class: 'small muted' }, labels.length ? MDM.ui.plural(labels.length, 'label') + ' · 100 × 150 mm, one per page' + (Object.keys(zones).length > 1 ? ' · sorted by zone: ' + Object.keys(zones).map(z => MDM.geo.zoneShort(z) + ': ' + zones[z]).join(', ') : '') : 'Nothing to print')),
      el('div', { class: 'labels-toolbar__actions' },
        el('a', { class: 'btn btn--secondary', href: back }, 'Back'),
        el('button', { type: 'button', class: 'btn btn--primary', disabled: !labels.length, 'data-testid': 'labels-print', on: { click: () => window.print() } }, html(MDM.icon('printer', 16)), 'Print'))));
    if (!labels.length) {
      sheet.replaceChildren(el('div', { class: 'labels-empty card' }, el('div', { class: 'card__body' }, el('div', { class: 'empty' },
        el('div', { class: 'empty__title' }, 'No packages found'),
        el('div', { class: 'empty__hint' }, 'Open labels from an order, a bulk order or the business portal. The link may be for an order that was removed by a demo reset.')))));
      return;
    }
    sheet.replaceChildren(...labels);
  }
  async function main() {
    await MDM.store.ready;
    // The QR library loads deferred before this script; wait a moment for it if the CDN is slow, then draw without it.
    if (typeof window.qrcode !== 'function') await new Promise(r => { let n = 0; const t = setInterval(() => { if (typeof window.qrcode === 'function' || ++n > 20) { clearInterval(t); r(); } }, 100); });
    await render();
    MDM.store.subscribe('*', msg => { if (msg && (msg.op === 'reset' || msg.collection === 'orders')) render(); });
  }
  main();
})(window.MDM);

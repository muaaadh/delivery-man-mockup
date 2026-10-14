// Shipping labels (How it works §9): one 100 × 150 mm label per package, printable on a thermal label printer or A6 paper.
// Delivery methods (web app updates §3.2 to §3.4): boat labels print the island, vessel, departure and jetty; Maldivian Cargo labels the
// counter and island; airport labels the counter, resort and speedboat. Cash on delivery prints the amount to collect while pending.
// An order cancelled after collection (by the business, §5.5, or the office) prints as a return label to the sender; bulk sheets leave
// cancelled orders out.
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
  function serviceFlags(o) {
    const flags = [];
    if (o.status === 'cancelled') flags.push({ text: isReturn(o) ? 'Return to sender' : 'Cancelled', strong: true });   // only printed when asked for this one order
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

  // Business size category (web app updates §1.3): "Medium (box)"; other orders print the package size. The category only, never
  // measurements or weight (§2.2: a package is described by its category and a photo), even on older orders that still carry them.
  function sizeText(pkg) {
    const tiers = MDM.pricing.businessTiers(MDM.store._settings());
    const t = pkg.tier ? tiers.find(x => x.value === pkg.tier) : null;
    return t ? t.label + ' (' + MDM.pricing.sizeLabel(pkg.size).toLowerCase() + ')' : MDM.pricing.sizeLabel(pkg.size);
  }
  const fmtDay = ymd => ymd ? MDM.ui.fmtDate(ymd + 'T12:00:00', { dateOnly: true }) : '';
  // Delivery method details (§3.2 to §3.4): what the driver needs to hand the package to the right vessel, counter or person.
  // → { bar: { name, key }, title, rows: [[label, value]], dest } or null for home delivery.
  function methodInfo(o) {
    const d = o.delivery || {}, m = d.method || 'home';
    if (m === 'boat') {
      const b = d.boat || {};
      const vessel = ((MDM.VESSEL_TYPES.find(v => v.value === b.vesselType) || {}).label || 'Boat').replace(' (dhoni)', '');
      const jetty = (MDM.geo.terminals().find(t => t.value === b.jetty) || {}).label || '';
      return { method: m, bar: { name: 'To ' + (b.island || 'the island'), key: vessel }, title: 'Hand to the vessel',
        rows: [['Vessel', (vessel + ' ' + (b.name || '')).trim()], ['Departs', [fmtDay(b.departureDate), b.departureTime].filter(Boolean).join(', ') || 'Ask the office'], ['Jetty', jetty]],
        dest: b.address || b.island || '' };
    }
    if (m === 'cargo') {
      const c = d.cargo || {};
      return { method: m, bar: { name: 'Maldivian Cargo', key: c.island ? 'For ' + c.island.split(',')[0] : 'Cargo' }, title: 'Maldivian Cargo',
        rows: [['Drop at', c.counter || MDM.geo.cargoCounter().label], ['Island', c.island || '']],
        dest: 'For ' + (c.island || 'the island') + (c.consignee && c.consignee !== d.recipientName ? ', consignee ' + c.consignee : '') };
    }
    if (m === 'airport') {
      const a = d.airport || {};
      const pt = (MDM.geo.airportPoints().find(x => x.value === a.point) || {}).label || 'Velana International Airport';
      return { method: m, bar: { name: 'Velana Airport', key: a.counter ? pt.split(',')[0] : 'Airport' }, title: 'Airport handover',
        rows: [['Counter', a.counter || pt], ['Resort', a.resort || ''], a.speedboat ? ['Speedboat', [a.speedboat, a.departureTime ? 'departs ' + a.departureTime : ''].filter(Boolean).join(', ')] : ['Departs', a.departureTime || '']],
        dest: a.resort || pt };
    }
    return null;
  }
  // Cancelled after collection (by the business, §5.5, or the office): the driver brings the package back, so its label is a return label.
  const isReturn = o => o.status === 'cancelled' && !!(o.cancellation && o.cancellation.returnStatus === 'pending');
  // Cash on delivery (§5.6): printed while the driver still has to collect it.
  function codToCollect(o) { return o.cod && o.cod.amount > 0 && o.cod.status === 'pending' && ['delivered', 'cancelled', 'returned'].indexOf(o.status) < 0 ? o.cod.amount : 0; }

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
    const ret = isReturn(o);
    const mi = ret ? null : methodInfo(o);
    const cod = codToCollect(o);
    const meta = [
      ['Size', sizeText(pkg)],
      ['Reference', (o.details && o.details.reference) || pkg.notes || ''],
      ['Contents', pkg.description || ''],
      ['Payment', paymentLine(o)],
    ];
    const det = o.details || {};
    if (o.requestType === 'airport' && det.flight) meta.splice(1, 0, ['Flight', [det.flight, det.flightTime, (MDM.geo.airportPoints().find(a => a.value === det.area) || {}).label].filter(Boolean).join(' · ')]);
    // A courier order names its courier (details.courierName, e.g. 'FedEx' or what the customer typed), not the carrier group.
    if (o.requestType === 'postal' && det.carrier) meta.splice(1, 0, ['Collect from', [(det.carrier === 'courier' && det.courierName) || (MDM.CARRIERS.find(c => c.value === det.carrier) || {}).label, det.collectionCode || det.trackingNo].filter(Boolean).join(' · ')]);
    if (o.items && o.items.length) meta.forEach(m => { if (m[0] === 'Contents') m[1] = o.items.map(it => it.qty + ' × ' + it.name).join(', '); });
    // Every row is printed; fit() drops the least needed ones only when the label would run off its 100 × 150 mm page.
    const rows = meta.filter(m => m[1]);
    const c = o.cancellation || {};
    const instructions = ret ? 'Do not deliver: bring it back to the sender. Cancelled' + ((c.reason || o.cancelReason) ? ': ' + (c.reason || o.cancelReason) : '') : (drop.instructions || deliv.instructions);
    const backZone = col.zone || pick.zone || 'male';
    const bar = ret ? { name: 'Return to ' + MDM.geo.zoneLabel(backZone), key: 'Cancelled' } : mi ? mi.bar : { name: MDM.geo.zoneLabel(zone), key: (zoneObj.short || MDM.geo.zoneShort(zone)) !== MDM.geo.zoneLabel(zone) ? (zoneObj.short || MDM.geo.zoneShort(zone)) : '' };
    // Receiver box and "From" line: a return label swaps them (back to the sender, and who it was going to).
    const toName = ret ? fromName : (rec.name || deliv.recipientName || o.customer.name);
    const toPhone = ret ? fromPhone : (rec.phone || deliv.recipientPhone || o.customer.phone);
    const toAddr = ret ? [col.address || pick.address || '', MDM.geo.zoneShort(backZone)].filter(Boolean).join(' · ') : (mi ? mi.dest : (drop.address || deliv.address || ''));
    const toLandmark = ret ? (col.landmark || pick.landmark || '') : (!mi ? (drop.landmark || deliv.landmark || '') : '');
    return el('article', { class: 'label' + (mi ? ' label--' + mi.method : '') + (cod ? ' label--cod' : '') + (ret ? ' label--return' : ''), 'data-testid': 'label', 'data-method': ret ? 'return' : mi ? mi.method : 'home', 'aria-label': 'Label for ' + o.code + ', package ' + i + ' of ' + n },
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
        el('div', { class: 'label__k' }, ret ? 'Return to' : 'Deliver to'),
        el('div', { class: 'label__name', 'data-testid': 'label-receiver' }, toName),
        el('div', { class: 'label__phone', 'data-testid': 'label-phone' }, phoneFmt(toPhone)),
        el('div', { class: 'label__addr' }, toAddr),
        toLandmark ? el('div', { class: 'label__landmark', 'data-kind': 'landmark' }, toLandmark) : null,
        instructions ? el('div', { class: 'label__landmark', 'data-kind': 'instructions' }, instructions) : null),
      el('div', { class: 'label__zone', 'data-zone': zone, 'data-testid': 'label-bar' },
        el('span', { class: 'label__zone-name' }, bar.name),
        bar.key ? el('span', { class: 'label__zone-key' }, bar.key) : null),
      mi ? el('section', { class: 'label__method', 'data-testid': 'label-method' },
        el('div', { class: 'label__k' }, mi.title),
        el('dl', { class: 'label__mrows' }, mi.rows.filter(r => r[1]).map(r => [el('dt', null, r[0]), el('dd', null, r[1])]))) : null,
      cod ? el('div', { class: 'label__cod', 'data-testid': 'label-cod' }, 'Collect ' + MDM.pricing.format(cod) + ' cash',
        n > 1 ? el('span', { class: 'label__cod-note' }, 'Once for the whole order of ' + n + ' packages, not per package') : null) : null,
      el('section', { class: 'label__from' },
        el('div', { class: 'label__k' }, ret ? 'Was going to' : 'From'),
        ret ? el('div', { class: 'label__fromline' }, el('strong', null, rec.name || deliv.recipientName || ''), (rec.phone || deliv.recipientPhone) ? ' · ' + phoneFmt(rec.phone || deliv.recipientPhone) : '')
          : el('div', { class: 'label__fromline' }, el('strong', null, fromName), fromPhone ? ' · ' + phoneFmt(fromPhone) : ''),
        ret ? el('div', { class: 'label__fromline' }, MDM.deliveryMethodLabel(deliv.method) + (deliv.address ? ' · ' + deliv.address : ''))
          : el('div', { class: 'label__fromline' }, (pick.address || col.address || '') + ' · ' + MDM.geo.zoneShort(pick.zone || col.zone || 'male'))),
      el('dl', { class: 'label__meta', 'data-testid': 'label-meta' }, rows.map(m => [el('dt', { 'data-k': m[0] }, m[0]), el('dd', { 'data-k': m[0] }, m[1])])),
      el('div', { class: 'label__sign' }, el('span', null, ret ? 'Returned to (name)' : mi && mi.method === 'boat' ? 'Received by (crew)' : 'Received by'), el('span', null, 'Time')),
      el('footer', { class: 'label__foot' }, 'Track: ', el('span', { class: 'label__url' }, trackUrl(o.code).replace(/^https?:\/\//, ''))));
  }

  // fit(label): a label is exactly 100 × 150 mm, so when long names, two rows of flags, a method box or a cash strip would push the
  // bottom off the page, the least needed lines go first, one step at a time and only while the label still overflows: payment and
  // contents rows, the sender's address line, the landmark, then a tighter layout (smaller QR and spacing), the signature space, the
  // reference, then smaller type with long lines clamped, and last the instructions line. The receiver, the method details, the cash to
  // collect and the size category always stay.
  function fit(l) {
    const over = () => l.scrollHeight > l.clientHeight + 1;
    const drop = sel => () => l.querySelectorAll(sel).forEach(n => n.remove());
    const steps = [
      () => { const sign = l.querySelector('.label__sign'); if (sign) sign.classList.add('label__sign--tight'); },
      drop('.label__meta [data-k="Payment"]'),
      drop('.label__meta [data-k="Contents"]'),
      () => { const from2 = l.querySelectorAll('.label__fromline')[1]; if (from2) from2.remove(); },
      drop('.label__landmark[data-kind="landmark"]'),
      () => l.classList.add('label--compact'),
      drop('.label__sign'),
      drop('.label__meta [data-k="Reference"]'),
      drop('.label__meta [data-k="Flight"], .label__meta [data-k="Collect from"]'),
      () => l.classList.add('label--min'),
      drop('.label__landmark[data-kind="instructions"]'),
      drop('.label__date'),
    ];
    for (let i = 0; i < steps.length && over(); i++) steps[i]();
    l.dataset.fit = over() ? 'overflow' : 'ok';
  }
  const fitAll = () => sheet.querySelectorAll('.label').forEach(fit);

  async function collect() {
    const out = { orders: [], batch: null, account: null, title: 'Shipping labels', back: null, skipped: 0 };
    const getOrder = async v => (await MDM.store.get('orders', v)) || (await MDM.store.orderByCode(v));
    if (params.get('batch')) {
      const v = params.get('batch');
      const b = (await MDM.store.get('batches', v)) || (await MDM.store.list('batches')).find(x => x.code === String(v).toUpperCase());
      if (b) {
        out.batch = b;
        // A cancelled package must not get a label with the rest of the bulk order (§5.5); the toolbar says how many were left out.
        const all = await MDM.store.list('orders', { where: { batchId: b.id } });
        const kids = all.filter(o => o.status !== 'cancelled');
        out.skipped = all.length - kids.length;
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
        el('p', { class: 'small muted', 'data-testid': 'labels-summary' }, (labels.length ? MDM.ui.plural(labels.length, 'label') + ' · 100 × 150 mm, one per page' + (Object.keys(zones).length > 1 ? ' · sorted by zone: ' + Object.keys(zones).map(z => MDM.geo.zoneShort(z) + ': ' + zones[z]).join(', ') : '') : 'Nothing to print') +
          (data.skipped ? ' · ' + MDM.ui.plural(data.skipped, 'cancelled order') + ' left out' : ''))),
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
    fitAll();
  }
  async function main() {
    await MDM.store.ready;
    // The QR library loads deferred before this script; wait a moment for it if the CDN is slow, then draw without it.
    if (typeof window.qrcode !== 'function') await new Promise(r => { let n = 0; const t = setInterval(() => { if (typeof window.qrcode === 'function' || ++n > 20) { clearInterval(t); r(); } }, 100); });
    await render();
    // Inter arrives after the first layout; re-render and fit again with the real font metrics.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
    MDM.store.subscribe('*', msg => { if (msg && (msg.op === 'reset' || msg.collection === 'orders')) render(); });
  }
  main();
})(window.MDM);

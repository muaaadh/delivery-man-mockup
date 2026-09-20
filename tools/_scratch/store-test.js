module.paths.push('/Users/muadhhashim/.npm/_npx/6bcb61ec6d5aea22/node_modules');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(String(e))); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto('http://localhost:4180/mr-delivery-man-mockup/tools/_scratch/store-test.html');
  await p.waitForFunction(() => window.MDM && MDM.store.readyState === 'ready');
  const r = await p.evaluate(async () => {
    const S = MDM.store, out = {};
    const orders = await S.list('orders'); out.orders = orders.length; out.codes = orders.map(o => o.code).sort().slice(0, 3).join(',') + '…' + orders.map(o => o.code).sort().slice(-1);
    const live = await S.orderByCode('mdm 1038'); out.live = { status: live.status, stops: live.route.stops.map(s => s.type + ':' + s.status).join(' '), polyline: live.route.polyline.length, km: MDM.geo.distanceKm(live.route.polyline).toFixed(2), total: live.totals.total, driver: live.driverId };
    out.statusCounts = orders.reduce((a, o) => (a[o.status] = (a[o.status] || 0) + 1, a), {});
    out.totals = orders.map(o => o.code + '=' + o.totals.total).join(' ');
    const s = await S.settings(); out.rates = s.rates.sizes.bag;
    // pricing checks
    const q1 = MDM.pricing.quote({ service: 'pick', packages: [{ size: 'bag', pickup: { zone: 'male' }, dropoff: { zone: 'hulhumale_p1' } }, { size: 'box', pickup: { zone: 'male' }, dropoff: { zone: 'airport' } }] }, s);
    out.q1 = { lines: q1.packages.map(x => x.price.lineTotal), fees: q1.fees, total: q1.totals.total, quote: q1.totals.quoteRequired };
    const q2 = MDM.pricing.quote({ service: 'shop', packages: [{ size: 'bag', shop: { zone: 'male', budget: 450 }, dropoff: { zone: 'hulhumale_p2' } }] }, s);
    out.q2 = { line: q2.packages[0].price.lineTotal, shopping: q2.fees.shopping, budget: q2.totals.budget, total: q2.totals.total };
    const q3 = MDM.pricing.quote({ service: 'pick', packages: [{ size: 'xl', needsVehicle: true, pickup: { zone: 'male', cargo: { terminal: 'male_north' } }, dropoff: { zone: 'villimale' } }] }, s);
    out.q3 = { line: q3.packages[0].price.lineTotal, cargo: q3.fees.cargo, reasons: q3.totals.quoteReasons, total: q3.totals.total };
    out.fmt = [MDM.pricing.format(1250), MDM.pricing.format(-20), MDM.pricing.format(1250.5, { cents: true })];
    // status machine
    const conf = orders.find(o => o.code === 'MDM-1041');
    try { await S.transition(conf.id, 'delivered'); out.badTransition = 'allowed?!'; } catch (e) { out.badTransition = e.code; }
    const assigned = await S.assignDriver(conf.id, 'drv_shiyam', { by: 'admin' });
    out.assigned = { status: assigned.status, stops: assigned.route.stops.length, poly: assigned.route.polyline.length, lastEvent: assigned.events.slice(-1)[0].label };
    const started = await S.startRoute(conf.id, { by: 'driver:drv_shiyam' }); out.started = started.status;
    const s1 = started.route.stops[0]; await S.setStop(conf.id, s1.id, { status: 'arrived' }); const pu = await S.setStop(conf.id, s1.id, { status: 'done' }); out.afterPickup = pu.status;
    const s2 = pu.route.stops[1]; const dl = await S.setStop(conf.id, s2.id, { status: 'done', handedTo: 'family', recipientName: 'Aminath' }); out.afterDrop = { status: dl.status, lastEvent: dl.events.slice(-1)[0].label };
    const drv = await S.get('drivers', 'drv_shiyam'); out.driverStatus = drv.status;
    // quote flow
    const qp = orders.find(o => o.code === 'MDM-1034'); const sent = await S.sendQuote(qp.id, { total: 95, note: 'Ferry + handling', by: 'admin' }); out.quote = { status: sent.status, total: sent.totals.total, adj: sent.fees.adjustments.length, ev: sent.events.slice(-1)[0].label };
    // reject/verify
    const pr = orders.find(o => o.code === 'MDM-1036'); const rej = await S.rejectPayment(pr.id, { reason: 'Amount did not match', by: 'admin' }); out.rejected = { status: rej.status, ps: rej.payment.status };
    const ver = await S.verifyPayment((orders.find(o => o.code === 'MDM-1037')).id, { by: 'admin' }); out.verified = { status: ver.status, ps: ver.payment.status };
    // on hold → retry
    const oh = orders.find(o => o.code === 'MDM-1040'); const rt = await S.retryStop(oh.id, oh.route.stops[1].id, { by: 'admin' }); out.retry = { status: rt.status, attempts: rt.route.stops[1].attempts };
    // shop settlement
    const sh = orders.find(o => o.code === 'MDM-1026'); out.settle = sh.settlement; out.shopTotals = sh.totals;
    // driverRoute
    const dr = await S.driverRoute('drv_nazim'); out.driverRoute = { orders: dr.orders.length, stops: dr.stops.length, poly: dr.polyline.length };
    // customer upsert
    const c = await S.upsertCustomer({ name: 'Test Person', phone: '+960 777 9999', notify: 'sms' }); const c2 = await S.upsertCustomer({ name: 'Test Person', phone: '7779999' }); out.customer = { same: c.id === c2.id, count: c2.orderCount, phone: c2.phone };
    // invoice
    const inv = await S.createInvoice('bacc_kandu', new Date().toISOString().slice(0, 7)); out.invoice = { number: inv.number, lines: inv.lines.length, total: inv.total };
    // files + export
    const files = await S.list('files'); out.files = files.map(f => f.kind + ':' + Math.round(f.size / 1024) + 'k');
    out.exportLen = (await S.exportJSON()).length; out.exportWithFiles = (await S.exportJSON({ includeFiles: true })).length;
    const meta = JSON.parse(localStorage.getItem('mdm:v1:meta')); out.meta = { dirty: meta.dirty, orderSeq: meta.orderSeq, invoiceSeq: meta.invoiceSeq };
    const ins = await S.insert('orders', { service: 'pick', customer: { name: 'X', phone: '7770001' }, packages: [], fees: { adjustments: [] }, totals: { total: 0 }, status: 'awaiting_payment', events: [] }); out.newCode = ins.code;
    out.storageKB = Math.round(Object.keys(localStorage).reduce((n, k) => n + (localStorage.getItem(k) || '').length, 0) / 1024);
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  // two-tab sync
  const p2 = await ctx.newPage(); await p2.goto('http://localhost:4180/mr-delivery-man-mockup/tools/_scratch/store-test.html'); await p2.waitForFunction(() => window.MDM && MDM.store.readyState === 'ready');
  await p2.evaluate(() => { window.__got = []; MDM.store.subscribe('orders', e => window.__got.push(e.op + ':' + e.origin)); });
  await p.evaluate(async () => { const o = await MDM.store.orderByCode('MDM-1035'); await MDM.store.addNote(o.id, { text: 'hello', by: 'admin' }); });
  await p2.waitForTimeout(300);
  console.log('tab2 got', await p2.evaluate(() => window.__got));
  await p.evaluate(() => MDM.store.reset()); await p2.waitForTimeout(300);
  console.log('after reset tab2 orders', await p2.evaluate(async () => (await MDM.store.list('orders')).length), 'got', await p2.evaluate(() => window.__got.slice(-2)));
  console.log('errors', errors);
  await b.close();
})();

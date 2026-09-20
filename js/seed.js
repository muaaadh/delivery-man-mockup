// Demo data. MDM.seed.build(now) is pure: it returns every collection with dates relative to `now`, so the demo never looks stale.
// Fixed ids and codes are part of the contract (tests and screenshots reference them): MDM-1038 is always the live in-transit order.
// This file ends with the boot call that seeds the store on first visit (and re-seeds after 12 h when nothing was changed).
(function (MDM) { 'use strict';

  function build(now) {
    const NOW = now instanceof Date ? now : new Date(now || Date.now());
    const t = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();
    const days = (d, h) => (d * 24 + (h || 0)) * 60;

    const settings = {
      rates: { sizes: { bag: { same: 35, cross: 45 }, box: { same: 45, cross: 60 }, xl: { same: 60, cross: 60, quoted: true } }, cargo: 20, airport: 40, shoppingPct: 10, business: 25 },
      rules: { airportReplacesCross: true, cargoFeePer: 'package', airportFeePer: 'order' },
      sizeGuide: { bag: 'Fits in a carrier bag: documents, food, small parcels', box: 'A carton up to about 1 ft (30 cm) a side, strapped on the bike', xl: 'Bigger than a box or needs two hands; may need a pickup, price confirmed first' },
      ops: { hours: { open: '09:00', close: '23:00' }, days: 'Every day', asapText: 'Usually within 60 to 90 minutes in Malé and Hulhumalé', reviewText: 'about 30 minutes', businessReplyText: 'within 1 working day', slotStart: '09:00', slotEnd: '23:00', slotMinutes: 120, speedCityKmh: 18, speedHighwayKmh: 40, peakBufferMin: 10, peakWindows: ['08:00-09:30', '17:00-19:30'], closedWindows: ['Fri 12:00-13:30'] },
      banks: [
        { id: 'bml', name: 'Bank of Maldives', accountName: 'Mr. Delivery Man', accountNo: '7730 0000 12345' },
        { id: 'mib', name: 'Maldives Islamic Bank', accountName: 'Mr. Delivery Man', accountNo: '9010 0000 67890' },
      ],
      contact: { phone: '7770000', whatsapp: '7770000', viber: '7770000', email: 'hello@mrdeliveryman.mv' },
      terms: "We don't carry items prohibited under Maldives law or cash. Fragile items travel at the sender's risk unless they are boxed.",
      notice: { text: 'Sinamalé Bridge closed to motorcycles during heavy rain, Hulhumalé deliveries may be delayed', active: false },
      invoiceDueDays: 14, gstPercent: 0, demo: { autopilot: true },
    };

    const drivers = [
      { id: 'drv_nazim', name: 'Ahmed Nazim', phone: '7701234', vehicle: 'bike', vehicleNote: 'Honda Wave', status: 'on_route', createdAt: t(days(30)), updatedAt: t(8) },
      { id: 'drv_shiyam', name: 'Ibrahim Shiyam', phone: '9905678', vehicle: 'bike', vehicleNote: 'Yamaha', status: 'online', createdAt: t(days(30)), updatedAt: t(20) },
      { id: 'drv_rasheed', name: 'Hassan Rasheed', phone: '7609012', vehicle: 'pickup', vehicleNote: 'Toyota Hilux', status: 'on_route', createdAt: t(days(30)), updatedAt: t(30) },
    ];

    const C = {
      shifza:  { id: 'cus_shifza',  name: 'Aishath Shifza',   phone: '7912345', email: 'shifza@example.com', notify: 'whatsapp' },
      nazeeha: { id: 'cus_nazeeha', name: 'Mariyam Nazeeha',  phone: '9601234', email: '',                   notify: 'viber' },
      rilwan:  { id: 'cus_rilwan',  name: 'Mohamed Rilwan',   phone: '7778901', email: 'rilwan@example.com', notify: 'whatsapp' },
      zeena:   { id: 'cus_zeena',   name: 'Fathimath Zeena',  phone: '7654321', email: '',                   notify: 'sms' },
      waheed:  { id: 'cus_waheed',  name: 'Ali Waheed',       phone: '9912345', email: 'waheed@example.com', notify: 'whatsapp' },
      afeef:   { id: 'cus_afeef',   name: 'Hussain Afeef',    phone: '7345678', email: '',                   notify: 'viber' },
    };
    const A = {
      kaneeru: { address: 'M. Kaneerumaage, 2nd floor, Majeedhee Magu', zone: 'male' },
      dhonveli: { address: 'H. Dhonveli, Boduthakurufaanu Magu', zone: 'male' },
      handhuvaree: { address: 'G. Handhuvareege, Sosun Magu', zone: 'male' },
      ranfaru: { address: 'Ma. Ranfaru, Ameenee Magu', zone: 'male' },
      meerubahuru: { address: 'H. Meerubahuruge, Chandhanee Magu', zone: 'male' },
      amin: { address: 'Amin Avenue, Block B, Apt 4-02', zone: 'hulhumale_p1', landmark: 'Nirolhu Magu side' },
      rehendhi: { address: 'Rehendhi Flat 3, Apt 205', zone: 'hulhumale_p1' },
      hiyaa5: { address: 'Hiyaa Tower 5, Apt 14-03', zone: 'hulhumale_p2', landmark: 'Lift lobby B' },
      vinares: { address: 'Vinares Tower 3, Apt 9-01', zone: 'hulhumale_p2' },
      villi: { address: 'V. Hiyaleege, Villimalé', zone: 'villimale' },
      kandu: { address: 'Kandu Books & Stationery, M. Kaneerumaage, Chandhanee Magu', zone: 'male' },
    };

    // ---- helpers -----------------------------------------------------------------------------------------------------
    function endpoint(a, extra) {
      const e = Object.assign({ address: a.address, zone: a.zone, landmark: a.landmark || '' }, extra || {});
      if (e.cargo && e.cargo.terminal && MDM.geo.terminalPoint(e.cargo.terminal)) { const p = MDM.geo.terminalPoint(e.cargo.terminal); e.lat = p[0]; e.lng = p[1]; }
      else if (e.zone === 'airport' && e.meetAt && MDM.geo.airportPoint(e.meetAt)) { const p = MDM.geo.airportPoint(e.meetAt); e.lat = p[0]; e.lng = p[1]; }
      else { const p = MDM.geo.geocodeZone(e.zone, e.address); e.lat = p.lat; e.lng = p.lng; }
      return e;
    }
    let pkgSeq = 1;
    function pkg(o) {
      return {
        id: 'pkg_seed_' + String(pkgSeq++).padStart(2, '0'), size: o.size || 'bag', description: o.description || '', needsVehicle: !!o.needsVehicle, fragile: !!o.fragile,
        underOneFt: o.underOneFt !== false,
        pickup: o.shop ? null : endpoint(o.pickup, { contact: o.pickupContact || null, cargo: o.pickupCargo || null, meetAt: o.pickupMeetAt || '' }),
        dropoff: endpoint(o.dropoff, { recipient: o.recipient || null, cargo: o.dropCargo || null, meetAt: o.meetAt || 'door' }),
        shop: o.shop ? Object.assign({ address: '', unavailable: 'call', receiptTotal: null, receiptPhotoId: null }, o.shop, MDM.geo.geocodeZone(o.shop.zone, o.shop.name)) : null,
        notes: o.notes || '',
      };
    }
    let evSeq = 1;
    function ev(type, label, at, by, visibility) { return { id: 'evt_seed_' + String(evSeq++).padStart(3, '0'), at, type, label, by: by || 'system', visibility: visibility || 'public', meta: null }; }

    const files = [];
    function slipFile(orderId, name, amount, ref, at, payer, bank) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900" viewBox="0 0 640 900"><rect width="640" height="900" fill="#ffffff"/>' +
        '<text x="40" y="70" font-family="Inter,Arial,sans-serif" font-size="22" fill="#111114">Transfer successful</text>' +
        '<text x="40" y="100" font-family="Inter,Arial,sans-serif" font-size="14" fill="#5c5c66">' + esc(bank) + ' · Internet banking</text>' +
        '<line x1="40" y1="130" x2="600" y2="130" stroke="#e5e5ea"/>' +
        '<text x="40" y="200" font-family="Inter,Arial,sans-serif" font-size="14" fill="#5c5c66">Amount</text><text x="600" y="200" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="30" font-weight="600" fill="#111114">MVR ' + amount.toFixed(2) + '</text>' +
        '<text x="40" y="260" font-family="Inter,Arial,sans-serif" font-size="14" fill="#5c5c66">From</text><text x="600" y="260" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="16" fill="#111114">' + esc(payer) + ' · 7730 **** 4412</text>' +
        '<text x="40" y="310" font-family="Inter,Arial,sans-serif" font-size="14" fill="#5c5c66">To</text><text x="600" y="310" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="16" fill="#111114">Mr. Delivery Man · 7730 0000 12345</text>' +
        '<text x="40" y="360" font-family="Inter,Arial,sans-serif" font-size="14" fill="#5c5c66">Reference</text><text x="600" y="360" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="16" fill="#111114">' + esc(ref) + '</text>' +
        '<text x="40" y="410" font-family="Inter,Arial,sans-serif" font-size="14" fill="#5c5c66">Date</text><text x="600" y="410" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="16" fill="#111114">' + esc(at.slice(0, 10)) + ' ' + esc(at.slice(11, 16)) + '</text>' +
        '<text x="40" y="460" font-family="Inter,Arial,sans-serif" font-size="14" fill="#5c5c66">Transaction ID</text><text x="600" y="460" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="16" fill="#111114">TX' + esc(String(Math.abs(hash(ref)) % 100000000).padStart(8, '0')) + '</text>' +
        '<line x1="40" y1="500" x2="600" y2="500" stroke="#e5e5ea"/>' +
        '<text x="40" y="860" font-family="Inter,Arial,sans-serif" font-size="12" fill="#8a8a94">Demo receipt generated for the mockup</text></svg>';
      const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      const f = { id: 'file_seed_' + orderId.replace('ord_seed_', ''), kind: 'slip', orderId, name, type: 'image/svg+xml', size: dataUrl.length, dataUrl, at, createdAt: at, updatedAt: at };
      files.push(f);
      return { fileId: f.id, name, type: f.type, size: f.size };
    }
    function proofFile(orderId, at) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#d8d8dc"/><rect x="0" y="420" width="800" height="180" fill="#b9b9bf"/><rect x="290" y="250" width="220" height="180" rx="6" fill="#8a6f52"/><rect x="290" y="250" width="220" height="24" fill="#6f5740"/><rect x="380" y="250" width="40" height="180" fill="#a3866a"/><rect x="60" y="60" width="140" height="360" fill="#c9c9ce"/><text x="20" y="585" font-family="Inter,Arial,sans-serif" font-size="14" fill="#5c5c66">Proof of delivery photo (demo) · ' + esc(at.slice(0, 16).replace('T', ' ')) + '</text></svg>';
      const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      const f = { id: 'file_proof_' + orderId.replace('ord_seed_', ''), kind: 'proof', orderId, name: 'delivery.jpg', type: 'image/svg+xml', size: dataUrl.length, dataUrl, at, createdAt: at, updatedAt: at };
      files.push(f);
      return f.id;
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h | 0; }

    const orders = [];
    function order(spec) {
      const id = 'ord_seed_' + spec.code.slice(4);
      const q = MDM.pricing.quote({ service: spec.service, packages: spec.packages }, settings);
      const created = t(spec.createdMin);
      const o = {
        id, code: spec.code, createdAt: created, updatedAt: t(spec.updatedMin != null ? spec.updatedMin : spec.createdMin), source: spec.source || 'web',
        service: spec.service, customerId: spec.customer.id, customer: { name: spec.customer.name, phone: spec.customer.phone, email: spec.customer.email, notify: spec.customer.notify },
        accountId: spec.accountId || null,
        packages: q.packages, fees: q.fees, totals: q.totals,
        schedule: spec.schedule || { type: 'asap' },
        payment: Object.assign({ method: 'transfer', status: 'unpaid', bank: '', payerName: '', paidAmount: null, reference: '', slip: null, submittedAt: null, verifiedAt: null, verifiedBy: null, rejectReason: null, note: '', refund: null }, spec.payment || {}),
        quote: spec.quote || { status: q.totals.quoteRequired ? 'pending' : 'none', total: null, note: '', sentAt: null, by: null },
        settlement: null, status: spec.status, driverId: spec.driverId || null,
        route: { stops: [], polyline: [] }, events: spec.events || [], notes: spec.notes || [],
      };
      if (spec.adjustments) { o.fees.adjustments = spec.adjustments; MDM.pricing.recalc(o, settings); }
      if (spec.driverId || spec.withRoute) {
        o.route.stops = MDM.store._buildStops(o).map((s, i) => Object.assign(s, { id: 'stp_' + spec.code.slice(4) + '_' + (i + 1) }));
        if (spec.stops) spec.stops.forEach((st, i) => Object.assign(o.route.stops[i], st));
        const open = o.route.stops.filter(s => s.status !== 'done' && s.status !== 'failed');
        o.route.polyline = MDM.geo.routeThrough(open.length >= 2 ? open : o.route.stops);
      }
      if (spec.receipt != null) { o.packages[0].shop.receiptTotal = spec.receipt; MDM.pricing.recalc(o, settings); }
      if (spec.settle) {
        const paid = o.payment.paidAmount != null ? o.payment.paidAmount : o.totals.total; const due = o.totals.total; const balance = paid - due;
        o.settlement = { status: spec.settle === 'settled' ? 'settled' : (balance > 0 ? 'refund_due' : balance < 0 ? 'topup_due' : 'settled'), paid, due, balance, settledAt: spec.settle === 'settled' ? o.updatedAt : null, reference: spec.settle === 'settled' ? 'FAVARA 2291' : '' };
      }
      if (spec.cancelReason) { o.cancelReason = spec.cancelReason; o.cancelledBy = spec.cancelledBy || 'customer'; }
      orders.push(o);
      return o;
    }
    const paidOn = (min, amount, bank, payer, ref) => ({ status: 'verified', bank, payerName: payer, paidAmount: amount, reference: ref || '', submittedAt: t(min + 20), verifiedAt: t(min), verifiedBy: 'admin' });
    const stdEvents = (created, opts) => {
      // opts: { paidAt, confirmedAt, assignedAt, driver, startedAt, pickedAt, pickedFrom, deliveredAt, deliveredTo }
      const e = [ev('created', 'Order placed', t(created), 'customer')];
      if (opts.paidAt != null) { e.push(ev('payment_submitted', 'Payment slip submitted', t(opts.paidAt + 20), 'customer')); e.push(ev('payment_verified', 'Payment verified', t(opts.paidAt), 'admin')); e.push(ev('confirmed', 'Order confirmed, assigning a rider', t(opts.paidAt), 'admin')); }
      if (opts.assignedAt != null) e.push(ev('assigned', 'Rider assigned: ' + opts.driver, t(opts.assignedAt), 'admin'));
      if (opts.startedAt != null) e.push(ev('route_started', opts.driver + ' is on the way', t(opts.startedAt), 'driver'));
      if (opts.pickedAt != null) { e.push(ev('arrived', opts.driver + ' arrived at pickup 1', t(opts.pickedAt + 3), 'driver')); e.push(ev('picked_up', 'Picked up from ' + opts.pickedFrom, t(opts.pickedAt), 'driver')); }
      if (opts.deliveredAt != null) { e.push(ev('arrived', opts.driver + ' arrived at drop-off 1', t(opts.deliveredAt + 2), 'driver')); e.push(ev('delivered', 'Delivered to ' + opts.deliveredTo, t(opts.deliveredAt), 'driver')); }
      return e;
    };

    // ---- orders (16 mixed + 4 business) ----------------------------------------------------------------------------
    // Delivered over the last week
    order({ code: 'MDM-1025', service: 'pick', customer: C.shifza, status: 'delivered', createdMin: days(6, 3), updatedMin: days(6, 1), driverId: 'drv_shiyam',
      packages: [pkg({ size: 'bag', description: 'Documents in an envelope', pickup: A.kaneeru, dropoff: A.handhuvaree, recipient: { name: 'Ahmed Sobah', phone: '7788123' } })],
      payment: paidOn(days(6, 2.6), 35, 'bml', 'Aishath Shifza', 'MDM-1025'),
      events: stdEvents(days(6, 3), { paidAt: days(6, 2.6), assignedAt: days(6, 2.4), driver: 'Ibrahim Shiyam', startedAt: days(6, 2.2), pickedAt: days(6, 1.8), pickedFrom: A.kaneeru.address, deliveredAt: days(6, 1), deliveredTo: 'Ahmed Sobah' }),
      stops: [{ status: 'done', at: t(days(6, 1.8)) }, { status: 'done', at: t(days(6, 1)), handedTo: 'recipient', recipientName: 'Ahmed Sobah' }] });

    order({ code: 'MDM-1026', service: 'shop', customer: C.nazeeha, status: 'delivered', createdMin: days(5, 4), updatedMin: days(5, 1.5), driverId: 'drv_nazim',
      packages: [pkg({ size: 'bag', description: 'Groceries', shop: { name: 'STO People\'s Choice', zone: 'male', address: 'Boduthakurufaanu Magu', list: '2 kg rice, 1 L cooking oil, 12 eggs, 2 kg onions, dhal 1 kg, chilli 250 g', budget: 450, unavailable: 'closest' }, dropoff: A.ranfaru, recipient: { name: 'Mariyam Nazeeha', phone: '9601234' } })],
      payment: paidOn(days(5, 3.5), 530, 'mib', 'Mariyam Nazeeha', 'MDM-1026'),
      receipt: 412, settle: 'due',
      events: stdEvents(days(5, 4), { paidAt: days(5, 3.5), assignedAt: days(5, 3.2), driver: 'Ahmed Nazim', startedAt: days(5, 3), pickedAt: days(5, 2.2), pickedFrom: 'STO People\'s Choice (receipt MVR 412)', deliveredAt: days(5, 1.5), deliveredTo: 'Mariyam Nazeeha' }),
      stops: [{ status: 'done', at: t(days(5, 2.2)), receiptTotal: 412 }, { status: 'done', at: t(days(5, 1.5)), handedTo: 'recipient', recipientName: 'Mariyam Nazeeha' }] });

    order({ code: 'MDM-1027', service: 'pick', customer: C.rilwan, status: 'delivered', createdMin: days(4, 6), updatedMin: days(4, 3), driverId: 'drv_rasheed',
      packages: [pkg({ size: 'box', description: 'Printer cartridges (2 boxes taped together)', fragile: true, pickup: A.meerubahuru, dropoff: A.vinares, recipient: { name: 'Ibrahim Naail', phone: '7723456' }, meetAt: 'lobby' })],
      payment: paidOn(days(4, 5.5), 60, 'bml', 'Mohamed Rilwan', 'MDM-1027'),
      events: stdEvents(days(4, 6), { paidAt: days(4, 5.5), assignedAt: days(4, 5), driver: 'Hassan Rasheed', startedAt: days(4, 4.5), pickedAt: days(4, 4), pickedFrom: A.meerubahuru.address, deliveredAt: days(4, 3), deliveredTo: 'Ibrahim Naail' }),
      stops: [{ status: 'done', at: t(days(4, 4)) }, { status: 'done', at: t(days(4, 3)), handedTo: 'recipient', recipientName: 'Ibrahim Naail' }] });

    order({ code: 'MDM-1028', service: 'pick', customer: C.waheed, status: 'cancelled', createdMin: days(3, 5), updatedMin: days(3, 4), cancelReason: 'Recipient travelled', cancelledBy: 'customer',
      packages: [pkg({ size: 'bag', description: 'Birthday gift', pickup: A.dhonveli, dropoff: A.rehendhi, recipient: { name: 'Aminath Reesha', phone: '9955123' } })],
      events: [ev('created', 'Order placed', t(days(3, 5)), 'customer'), ev('cancelled', 'Cancelled by customer: Recipient travelled', t(days(3, 4)), 'customer')] });

    order({ code: 'MDM-1029', service: 'pick', customer: C.zeena, status: 'delivered', createdMin: days(2, 7), updatedMin: days(2, 4), driverId: 'drv_nazim',
      packages: [pkg({ size: 'bag', description: 'Passport and documents from a relative arriving on MLE flight', pickup: { address: 'Velana International Airport, Arrivals hall', zone: 'airport' }, pickupMeetAt: 'arrivals', pickupContact: { name: 'Hawwa Leena', phone: '+61412345678' }, dropoff: A.handhuvaree, recipient: { name: 'Fathimath Zeena', phone: '7654321' }, meetAt: 'reception' })],
      payment: paidOn(days(2, 6.5), 75, 'bml', 'Fathimath Zeena', 'MDM-1029'),
      events: stdEvents(days(2, 7), { paidAt: days(2, 6.5), assignedAt: days(2, 6), driver: 'Ahmed Nazim', startedAt: days(2, 5.5), pickedAt: days(2, 4.8), pickedFrom: 'Velana International Airport, Arrivals hall', deliveredAt: days(2, 4), deliveredTo: 'Fathimath Zeena (security or reception)' }),
      stops: [{ status: 'done', at: t(days(2, 4.8)) }, { status: 'done', at: t(days(2, 4)), handedTo: 'security', recipientName: 'Fathimath Zeena' }] });

    order({ code: 'MDM-1030', service: 'pick', customer: C.afeef, status: 'delivered', createdMin: days(1, 8), updatedMin: days(1, 6), driverId: 'drv_shiyam',
      packages: [pkg({ size: 'box', description: 'Spare parts for a dhoni engine, to the boat', pickup: A.ranfaru, dropoff: { address: 'Malé North Harbour', zone: 'male' }, dropCargo: { terminal: 'male_north', boat: 'Alihaa Express', time: '16:00', consignee: 'Hassan Ziyad, Thoddoo', receiptNo: '' }, recipient: { name: 'Boat crew, Alihaa Express', phone: '7911223' } })],
      payment: paidOn(days(1, 7.5), 65, 'mib', 'Hussain Afeef', 'MDM-1030'),
      events: stdEvents(days(1, 8), { paidAt: days(1, 7.5), assignedAt: days(1, 7), driver: 'Ibrahim Shiyam', startedAt: days(1, 6.8), pickedAt: days(1, 6.5), pickedFrom: A.ranfaru.address, deliveredAt: days(1, 6), deliveredTo: 'Alihaa Express crew (cargo receipt photo)' }),
      stops: [{ status: 'done', at: t(days(1, 6.5)) }, { status: 'done', at: t(days(1, 6)), handedTo: 'recipient', recipientName: 'Alihaa Express crew' }] });

    // Delivered today
    const o1031 = order({ code: 'MDM-1031', service: 'pick', customer: C.shifza, status: 'delivered', createdMin: 300, updatedMin: 180, driverId: 'drv_nazim',
      packages: [pkg({ size: 'bag', description: 'Lunch tiffin', pickup: A.kaneeru, dropoff: A.amin, recipient: { name: 'Mohamed Shaffan', phone: '7700456' } })],
      payment: paidOn(280, 45, 'bml', 'Aishath Shifza', 'MDM-1031'),
      events: stdEvents(300, { paidAt: 280, assignedAt: 270, driver: 'Ahmed Nazim', startedAt: 250, pickedAt: 235, pickedFrom: A.kaneeru.address, deliveredAt: 180, deliveredTo: 'Mohamed Shaffan' }),
      stops: [{ status: 'done', at: t(235) }, { status: 'done', at: t(180), handedTo: 'recipient', recipientName: 'Mohamed Shaffan' }] });
    o1031.route.stops[1].photoId = proofFile(o1031.id, t(180));

    order({ code: 'MDM-1032', service: 'pick', customer: C.nazeeha, status: 'delivered', createdMin: 260, updatedMin: 120, driverId: 'drv_rasheed',
      packages: [
        pkg({ size: 'bag', description: 'Keys and a charger', pickup: A.ranfaru, dropoff: A.dhonveli, recipient: { name: 'Ali Nasih', phone: '7712233' } }),
        pkg({ size: 'box', description: 'Baby clothes', pickup: A.ranfaru, dropoff: A.rehendhi, recipient: { name: 'Aminath Sana', phone: '9944556' }, meetAt: 'door' }),
      ],
      payment: paidOn(245, 95, 'bml', 'Mariyam Nazeeha', 'MDM-1032'),
      events: stdEvents(260, { paidAt: 245, assignedAt: 240, driver: 'Hassan Rasheed', startedAt: 230, pickedAt: 215, pickedFrom: A.ranfaru.address, deliveredAt: 120, deliveredTo: 'Aminath Sana' }).concat([ev('delivered', 'Delivered to Ali Nasih', t(190), 'driver')]),
      stops: [{ status: 'done', at: t(215) }, { status: 'done', at: t(215) }, { status: 'done', at: t(190), handedTo: 'recipient', recipientName: 'Ali Nasih' }, { status: 'done', at: t(120), handedTo: 'family', recipientName: 'Sana\'s mother' }] });

    order({ code: 'MDM-1033', service: 'shop', customer: C.rilwan, status: 'delivered', createdMin: 200, updatedMin: 60, driverId: 'drv_shiyam',
      packages: [pkg({ size: 'bag', description: 'Pharmacy run', shop: { name: 'Lifeline Pharmacy', zone: 'male', address: 'Majeedhee Magu', list: 'Panadol 2 strips, ORS sachets ×6, thermometer', budget: 300, unavailable: 'call' }, dropoff: A.meerubahuru, recipient: { name: 'Mohamed Rilwan', phone: '7778901' } })],
      payment: paidOn(185, 365, 'mib', 'Mohamed Rilwan', 'MDM-1033'),
      receipt: 300, settle: 'settled',
      events: stdEvents(200, { paidAt: 185, assignedAt: 180, driver: 'Ibrahim Shiyam', startedAt: 170, pickedAt: 110, pickedFrom: 'Lifeline Pharmacy (receipt MVR 300)', deliveredAt: 60, deliveredTo: 'Mohamed Rilwan' }),
      stops: [{ status: 'done', at: t(110), receiptTotal: 300 }, { status: 'done', at: t(60), handedTo: 'recipient', recipientName: 'Mohamed Rilwan' }] });

    // Waiting on the customer or the admin
    order({ code: 'MDM-1034', service: 'pick', customer: C.zeena, status: 'quote_pending', createdMin: 50,
      packages: [pkg({ size: 'bag', description: 'School books', pickup: A.handhuvaree, dropoff: A.villi, recipient: { name: 'Aishath Nuha', phone: '7688990' } })],
      events: [ev('created', 'Quote requested', t(50), 'customer')] });

    order({ code: 'MDM-1035', service: 'pick', customer: C.waheed, status: 'awaiting_payment', createdMin: 40,
      packages: [pkg({ size: 'box', description: 'Blender (boxed)', fragile: true, pickup: A.dhonveli, dropoff: A.hiyaa5, recipient: { name: 'Hawwa Rasheedha', phone: '9922334' }, meetAt: 'lobby' })],
      events: [ev('created', 'Order placed', t(40), 'customer')] });

    const o1036 = order({ code: 'MDM-1036', service: 'pick', customer: C.afeef, status: 'payment_review', createdMin: 35, updatedMin: 28,
      packages: [pkg({ size: 'bag', description: 'Signed contract', pickup: A.rehendhi, dropoff: A.kaneeru, recipient: { name: 'Hussain Afeef', phone: '7345678' }, pickupContact: { name: 'Zaha Adam', phone: '7901122' } })],
      payment: { status: 'review', bank: 'bml', payerName: 'Hussain Afeef', paidAmount: 45, reference: 'MDM-1036', submittedAt: t(28) },
      events: [ev('created', 'Order placed', t(35), 'customer'), ev('payment_submitted', 'Payment slip submitted', t(28), 'customer')] });
    o1036.payment.slip = slipFile(o1036.id, 'IMG_2041.jpg', 45, 'MDM-1036', t(29), 'Hussain Afeef', 'Bank of Maldives');

    const o1037 = order({ code: 'MDM-1037', service: 'pick', customer: C.shifza, status: 'payment_review', createdMin: 30, updatedMin: 24,
      packages: [
        pkg({ size: 'bag', description: 'Homemade cake box', fragile: true, pickup: A.amin, dropoff: A.vinares, recipient: { name: 'Ahmed Shan', phone: '7790011' } }),
        pkg({ size: 'bag', description: 'Second cake box', fragile: true, pickup: A.amin, dropoff: A.hiyaa5, recipient: { name: 'Aishath Rifa', phone: '9911002' } }),
      ],
      payment: { status: 'review', bank: 'mib', payerName: 'A. Shifza', paidAmount: 70, reference: 'MDM 1037', submittedAt: t(24) },
      events: [ev('created', 'Order placed', t(30), 'customer'), ev('payment_submitted', 'Payment slip submitted', t(24), 'customer')] });
    o1037.payment.slip = slipFile(o1037.id, 'Screenshot 2026-09-21.png', 70, 'MDM 1037', t(25), 'A. Shifza', 'Maldives Islamic Bank');

    // Live demo: on the way right now
    order({ code: 'MDM-1038', service: 'pick', customer: C.nazeeha, status: 'in_transit', createdMin: 45, updatedMin: 6, driverId: 'drv_nazim',
      packages: [pkg({ size: 'bag', description: 'Office keys and a laptop charger', pickup: A.kaneeru, dropoff: A.amin, recipient: { name: 'Ismail Riyaz', phone: '7755667' }, meetAt: 'lobby' })],
      payment: paidOn(30, 45, 'bml', 'Mariyam Nazeeha', 'MDM-1038'),
      events: stdEvents(45, { paidAt: 30, assignedAt: 22, driver: 'Ahmed Nazim', startedAt: 15, pickedAt: 6, pickedFrom: A.kaneeru.address }),
      stops: [{ status: 'done', at: t(6) }] });

    order({ code: 'MDM-1039', service: 'pick', customer: C.rilwan, status: 'assigned', createdMin: 38, updatedMin: 12, driverId: 'drv_shiyam',
      packages: [pkg({ size: 'box', description: 'Photo frames', fragile: true, pickup: A.meerubahuru, dropoff: A.handhuvaree, recipient: { name: 'Mariyam Waheeda', phone: '7733445' } })],
      payment: paidOn(20, 45, 'mib', 'Mohamed Rilwan', 'MDM-1039'),
      events: stdEvents(38, { paidAt: 20, assignedAt: 12, driver: 'Ibrahim Shiyam' }) });

    order({ code: 'MDM-1040', service: 'pick', customer: C.zeena, status: 'on_hold', createdMin: 95, updatedMin: 18, driverId: 'drv_rasheed',
      packages: [pkg({ size: 'bag', description: 'Medicine from the pharmacy', pickup: A.handhuvaree, dropoff: A.hiyaa5, recipient: { name: 'Aminath Shifana', phone: '7677889' }, meetAt: 'door' })],
      payment: paidOn(80, 45, 'bml', 'Fathimath Zeena', 'MDM-1040'),
      events: stdEvents(95, { paidAt: 80, assignedAt: 70, driver: 'Hassan Rasheed', startedAt: 60, pickedAt: 50, pickedFrom: A.handhuvaree.address }).concat([
        ev('arrived', 'Hassan Rasheed arrived at drop-off 1', t(22), 'driver'), ev('stop_failed', "Couldn't complete drop-off 1: no answer (called twice, no reply at 14-03)", t(18), 'driver')]),
      stops: [{ status: 'done', at: t(50) }, { status: 'failed', failReason: 'no_answer', failedAt: t(18), note: 'Called twice, no reply at 14-03', attempts: 1 }] });

    order({ code: 'MDM-1041', service: 'pick', customer: C.afeef, status: 'confirmed', createdMin: 25, updatedMin: 15,
      packages: [pkg({ size: 'bag', description: 'USB drive', pickup: A.dhonveli, dropoff: A.ranfaru, recipient: { name: 'Ahmed Fazeel', phone: '7811223' } })],
      payment: paidOn(15, 35, 'bml', 'Hussain Afeef', 'MDM-1041'),
      events: stdEvents(25, { paidAt: 15 }) });

    order({ code: 'MDM-1042', service: 'shop', customer: C.waheed, status: 'confirmed', createdMin: 22, updatedMin: 10,
      packages: [pkg({ size: 'bag', description: 'Snacks for the office', shop: { name: 'Fantasy Store', zone: 'male', address: 'Fareedhee Magu', list: '3 packs of biscuits, 6 juice boxes, 1 kg dates', budget: 250, unavailable: 'skip' }, dropoff: A.kaneeru, recipient: { name: 'Ali Waheed', phone: '9912345' }, meetAt: 'reception' })],
      payment: paidOn(10, 310, 'mib', 'Ali Waheed', 'MDM-1042'),
      events: stdEvents(22, { paidAt: 10 }) });

    order({ code: 'MDM-1043', service: 'pick', customer: C.shifza, status: 'picked_up', createdMin: 70, updatedMin: 9, driverId: 'drv_shiyam',
      packages: [
        pkg({ size: 'bag', description: 'Return parcel', pickup: A.handhuvaree, dropoff: A.rehendhi, recipient: { name: 'Nashwa Ahmed', phone: '7809988' } }),
        pkg({ size: 'bag', description: 'Second parcel', pickup: A.dhonveli, dropoff: A.rehendhi, recipient: { name: 'Nashwa Ahmed', phone: '7809988' } }),
      ],
      payment: paidOn(55, 90, 'bml', 'Aishath Shifza', 'MDM-1043'),
      events: stdEvents(70, { paidAt: 55, assignedAt: 45, driver: 'Ibrahim Shiyam', startedAt: 30, pickedAt: 9, pickedFrom: A.handhuvaree.address }),
      stops: [{ status: 'done', at: t(9) }] });

    // Business account orders (invoiced monthly)
    const kandu = { id: 'cus_kandu', name: 'Kandu Books & Stationery', phone: '7801122', email: 'orders@kandubooks.example', notify: 'viber' };
    const bizPkg = (desc, drop, recipient) => pkg({ size: 'bag', description: desc, pickup: A.kandu, pickupContact: { name: 'Ahmed Shafeeu', phone: '7801122' }, dropoff: drop, recipient });
    const biz = (code, createdMin, deliveredMin, packages) => order({ code, service: 'business', source: 'walkin', accountId: 'bacc_kandu', customer: kandu, status: 'delivered', createdMin, updatedMin: deliveredMin, driverId: 'drv_rasheed',
      payment: { method: 'invoice', status: 'invoiced' }, packages,
      events: [ev('created', 'Order created by admin (walk-in)', t(createdMin), 'admin', 'internal'), ev('assigned', 'Rider assigned: Hassan Rasheed', t(createdMin - 10), 'admin'), ev('route_started', 'Hassan Rasheed is on the way', t(createdMin - 20), 'driver'), ev('picked_up', 'Picked up from ' + A.kandu.address, t(createdMin - 30), 'driver'), ev('delivered', 'Delivered', t(deliveredMin), 'driver')],
      stops: packages.map(() => ({ status: 'done', at: t(createdMin - 30) })).concat(packages.map(() => ({ status: 'done', at: t(deliveredMin), handedTo: 'recipient' }))) });
    biz('MDM-1044', days(9, 5), days(9, 3), [bizPkg('Textbook order 1182', A.amin, { name: 'Aishath Leela', phone: '7710101' }), bizPkg('Textbook order 1183', A.rehendhi, { name: 'Moosa Rasheed', phone: '7710202' })]);
    biz('MDM-1045', days(6, 4), days(6, 2), [bizPkg('Stationery order 1190', A.ranfaru, { name: 'Ibrahim Nazeer', phone: '9910303' }), bizPkg('Stationery order 1191', A.handhuvaree, { name: 'Sara Ahmed', phone: '7710404' }), bizPkg('Stationery order 1192', A.hiyaa5, { name: 'Ahmed Naseem', phone: '7710505' })]);
    biz('MDM-1046', days(3, 6), days(3, 4), [bizPkg('Textbook order 1201', A.vinares, { name: 'Fathimath Ibrahim', phone: '7710606' }), bizPkg('Textbook order 1202', A.dhonveli, { name: 'Hussain Shareef', phone: '9910707' })]);
    biz('MDM-1047', days(1, 5), days(1, 3), [bizPkg('Art supplies order 1210', A.meerubahuru, { name: 'Aminath Zahira', phone: '7710808' }), bizPkg('Art supplies order 1211', A.amin, { name: 'Ali Shiyam', phone: '7710909' })]);

    // Keep business orders in this calendar month so the invoice is not empty: pull any that fell into last month forward.
    const monthKey = NOW.toISOString().slice(0, 7);
    orders.filter(o => o.service === 'business').forEach(o => {
      const d = (o.events.filter(e => e.type === 'delivered').pop() || {}).at || o.updatedAt;
      if (d.slice(0, 7) !== monthKey) { const shift = new Date(NOW.getTime() - 20 * 60000).toISOString(); o.events.forEach(e => { e.at = shift; }); o.updatedAt = shift; o.createdAt = shift; o.route.stops.forEach(s => { s.at = shift; }); }
    });

    // ---- customers ------------------------------------------------------------------------------------------------------
    const customers = Object.values(C).concat([kandu]).map(c => {
      const mine = orders.filter(o => o.customerId === c.id);
      const last = mine.map(o => o.createdAt).sort().pop() || null;
      const addresses = [];
      mine.forEach(o => o.packages.forEach(p => { if (p.pickup && p.pickup.address && !addresses.some(a => a.address === p.pickup.address)) addresses.push({ label: addresses.length ? 'Address ' + (addresses.length + 1) : 'Home', address: p.pickup.address, zone: p.pickup.zone, meetAt: 'door' }); }));
      return { id: c.id, name: c.name, phone: c.phone, email: c.email, notify: c.notify, addresses: addresses.slice(0, 2), createdAt: t(days(45)), updatedAt: last || t(days(45)), lastOrderAt: last, orderCount: mine.length };
    });

    // ---- business ------------------------------------------------------------------------------------------------------
    const business_accounts = [{ id: 'bacc_kandu', name: 'Kandu Books & Stationery', contactName: 'Ahmed Shafeeu', phone: '7801122', landline: '3321122', email: 'orders@kandubooks.example', tin: '', zone: 'male', pickupAddress: 'M. Kaneerumaage, Chandhanee Magu', pickupWindow: 'afternoon', ratePerPackage: 25, status: 'approved', approvedAt: t(days(40)), createdAt: t(days(42)), updatedAt: t(days(40)) }];
    const business_requests = [
      { id: 'breq_shifa', name: "Shifa's Cakes", contactName: 'Shifa Ibrahim', phone: '7556677', landline: '', email: 'shifa.cakes@example.com', zone: 'hulhumale_p1', pickupAddress: 'Rehendhi Flat 2, Apt 108', pickupWindow: 'afternoon', volume: '11-30', notes: 'Home baker, mostly cake boxes to Phase 1 and 2. Fragile.', status: 'pending', createdAt: t(days(1, 2)), updatedAt: t(days(1, 2)) },
      { id: 'breq_kandu', name: 'Kandu Books & Stationery', contactName: 'Ahmed Shafeeu', phone: '7801122', landline: '3321122', email: 'orders@kandubooks.example', zone: 'male', pickupAddress: 'M. Kaneerumaage, Chandhanee Magu', pickupWindow: 'afternoon', volume: '11-30', notes: 'School textbook season is busiest.', status: 'approved', createdAt: t(days(42)), updatedAt: t(days(40)) },
    ];
    const invLines = [];
    orders.filter(o => o.service === 'business').forEach(o => {
      const at = (o.events.filter(e => e.type === 'delivered').pop() || {}).at || o.updatedAt;
      o.packages.forEach(p => invLines.push({ date: at, orderCode: o.code, recipient: p.dropoff.recipient ? p.dropoff.recipient.name : '', description: p.description, packages: 1, rate: p.price.lineTotal, amount: p.price.lineTotal }));
    });
    const subtotal = invLines.reduce((n, l) => n + l.amount, 0);
    const invoices = [{ id: 'inv_seed_01', accountId: 'bacc_kandu', month: monthKey, number: 'INV-' + monthKey + '-001', lines: invLines, subtotal, gstPercent: 0, gst: 0, total: subtotal, status: 'draft', issuedAt: t(0), dueAt: new Date(NOW.getTime() + 14 * 86400000).toISOString(), paidAt: null, reference: '', createdAt: t(0), updatedAt: t(0) }];

    // ---- positions -----------------------------------------------------------------------------------------------------
    const live = orders.find(o => o.code === 'MDM-1038');
    const onBridge = MDM.geo.pointAtDistance(live.route.polyline, MDM.geo.distanceKm(live.route.polyline) * 0.45) || { lat: 4.1729, lng: 73.5228, heading: 65 };
    const p2 = orders.find(o => o.code === 'MDM-1040').route.stops[1];
    const positions = [
      { id: 'drv_nazim', driverId: 'drv_nazim', lat: onBridge.lat, lng: onBridge.lng, heading: onBridge.heading, speed: 38, accuracy: 8, at: t(0.1), source: 'sim', createdAt: t(0.1), updatedAt: t(0.1) },
      { id: 'drv_shiyam', driverId: 'drv_shiyam', lat: 4.1755, lng: 73.5102, heading: 90, speed: 0, accuracy: 12, at: t(0.5), source: 'sim', createdAt: t(0.5), updatedAt: t(0.5) },
      { id: 'drv_rasheed', driverId: 'drv_rasheed', lat: p2.lat, lng: p2.lng, heading: 180, speed: 0, accuracy: 15, at: t(3), source: 'sim', createdAt: t(3), updatedAt: t(3) },
    ];

    // ---- audit log -----------------------------------------------------------------------------------------------------
    const events = [];
    orders.forEach(o => o.events.forEach(e => events.push({ id: e.id, orderId: o.id, code: o.code, at: e.at, type: e.type, label: e.label, by: e.by, visibility: e.visibility, createdAt: e.at, updatedAt: e.at })));
    events.sort((a, b) => a.at < b.at ? -1 : 1);

    return { settings, customers, drivers, business_requests, business_accounts, invoices, orders, positions, events, files };
  }

  MDM.seed = { build };
  MDM.store._boot(build);
})(window.MDM);

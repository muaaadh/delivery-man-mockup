// Demo data. MDM.seed.build(now) is pure: it returns every collection with dates relative to `now`, so the demo never looks stale.
// Fixed ids and codes are part of the contract (tests and screenshots reference them): MDM-1038 is always the live order that is
// out for delivery, BLK-1001 is the bulk order being delivered by zone, Kandu Books (7801122) is the demo business account.
// This file ends with the boot call that seeds the store on first visit (and re-seeds after 12 h when nothing was changed).
(function (MDM) { 'use strict';

  function build(now) {
    const NOW = now instanceof Date ? now : new Date(now || Date.now());
    const t = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();
    const days = (d, h) => (d * 24 + (h || 0)) * 60;
    const dateOnly = (minutesAgo) => { const d = new Date(NOW.getTime() - minutesAgo * 60000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

    const settings = {
      rates: { sizes: { bag: { same: 35, cross: 45 }, box: { same: 45, cross: 60 }, xl: { same: 60, cross: 60, quoted: true } }, cargo: 20, airport: 40, shoppingPct: 10, business: 25, express: 25 },
      rules: { airportReplacesCross: true, cargoFeePer: 'package', airportFeePer: 'order', paymentTiming: 'after_delivery', upfrontOptional: true },
      sizeGuide: { bag: 'Fits in a carrier bag: documents, food, small parcels', box: 'A carton up to about 1 ft (30 cm) a side, strapped on the bike', xl: 'Bigger than a box or needs two hands; may need a vehicle, price confirmed first' },
      ops: { hours: { open: '09:00', close: '23:00' }, days: 'Every day', asapText: 'Usually within 60 to 90 minutes in Malé and Hulhumalé', reviewText: 'about 30 minutes', businessReplyText: 'within 1 working day', slotStart: '09:00', slotEnd: '23:00', slotMinutes: 120, speedCityKmh: 18, speedHighwayKmh: 40, peakBufferMin: 10, peakWindows: ['08:00-09:30', '17:00-19:30'], closedWindows: ['Fri 12:00-13:30'] },
      banks: [
        { id: 'bml', name: 'Bank of Maldives', accountName: 'Mr. Delivery Man', accountNo: '7730 0000 12345' },
        { id: 'mib', name: 'Maldives Islamic Bank', accountName: 'Mr. Delivery Man', accountNo: '9010 0000 67890' },
      ],
      contact: { phone: '7770000', whatsapp: '7770000', viber: '7770000', email: 'hello@example.com' },
      terms: "We don't carry items prohibited under Maldives law or cash. Fragile items travel at the sender's risk unless they are boxed.",
      notice: { text: 'Sinamalé Bridge closed to motorcycles during heavy rain, Hulhumalé deliveries may be delayed', active: false },
      invoiceDueDays: 14, gstPercent: 0, demo: { autopilot: true },
      notifications: { enabled: true, channel: 'customer', channels: { sms: true, whatsapp: true, viber: true, email: true }, senderName: 'MrDelivery' },
      hr: { shiftStart: '08:00', shiftEnd: '17:00', graceMinutes: 10, annualLeaveDays: 30, sickLeaveDays: 30, punchFrom: ['portal', 'driver app', 'office kiosk'] },
      store: { open: true, address: 'Mr. Delivery Man store, Majeedhee Magu', zone: 'male', note: 'Packaging and delivery bundles, delivered with your next order or on their own' },
    };

    // ---- people ----------------------------------------------------------------------------------------------------------
    const drivers = [
      { id: 'drv_nazim', staffId: 'stf_nazim', name: 'Ahmed Nazim', phone: '7701234', vehicle: 'bike', vehicleNote: 'Honda Wave', status: 'on_route', zones: ['hulhumale_p1', 'airport'], createdAt: t(days(300)), updatedAt: t(8) },
      { id: 'drv_shiyam', staffId: 'stf_shiyam', name: 'Ibrahim Shiyam', phone: '9905678', vehicle: 'bike', vehicleNote: 'Yamaha', status: 'on_route', zones: ['male'], createdAt: t(days(260)), updatedAt: t(20) },
      { id: 'drv_rasheed', staffId: 'stf_rasheed', name: 'Hassan Rasheed', phone: '7609012', vehicle: 'pickup', vehicleNote: 'Toyota Hilux', status: 'on_route', zones: ['male', 'villimale'], createdAt: t(days(220)), updatedAt: t(30) },
      { id: 'drv_faisal', staffId: 'stf_faisal', name: 'Mohamed Faisal', phone: '7745566', vehicle: 'bike', vehicleNote: 'Suzuki Access', status: 'on_route', zones: ['hulhumale_p2'], createdAt: t(days(120)), updatedAt: t(5) },
      { id: 'drv_hamid', staffId: 'stf_hamid', name: 'Abdulla Hamid', phone: '9987766', vehicle: 'bike', vehicleNote: 'Honda Dio', status: 'offline', zones: ['hulhumale_p1'], createdAt: t(days(90)), updatedAt: t(days(1)) },
    ];
    const staff = [
      { id: 'stf_admin', name: 'Aminath Shiuna', role: 'admin', title: 'Operations manager', phone: '7790001', username: 'admin', email: 'ops@example.com', status: 'active', joinedAt: dateOnly(days(700)), leaveBalance: { annual: 22, sick: 28 } },
      { id: 'stf_fayaz', name: 'Ahmed Fayaz', role: 'operator', title: 'Dispatcher', phone: '7790002', username: 'operator', email: 'dispatch@example.com', status: 'active', joinedAt: dateOnly(days(400)), leaveBalance: { annual: 18, sick: 30 } },
      { id: 'stf_lamya', name: 'Mariyam Lamya', role: 'office', title: 'Customer care and payments', phone: '7790003', username: 'lamya', email: 'care@example.com', status: 'active', joinedAt: dateOnly(days(350)), leaveBalance: { annual: 25, sick: 27 } },
    ].concat(drivers.map(d => ({ id: d.staffId, name: d.name, role: 'driver', title: d.vehicle === 'pickup' ? 'Driver (pickup truck)' : 'Rider', phone: d.phone, username: d.phone, driverId: d.id, status: d.id === 'drv_hamid' ? 'on_leave' : 'active', joinedAt: dateOnly(Math.round((NOW - new Date(d.createdAt)) / 60000)), leaveBalance: { annual: 20, sick: 30 } })));
    const SHIFTS = { stf_lamya: ['09:00', '18:00'], stf_rasheed: ['08:15', '18:00'] };
    staff.forEach(s => { s.createdAt = t(days(300)); s.updatedAt = t(days(2)); const sh = SHIFTS[s.id] || [settings.hr.shiftStart, settings.hr.shiftEnd]; s.shiftStart = sh[0]; s.shiftEnd = sh[1]; });

    const C = {
      shifza:  { id: 'cus_shifza',  name: 'Aishath Shifza',   phone: '7912345', email: 'shifza@example.com', notify: 'whatsapp' },
      nazeeha: { id: 'cus_nazeeha', name: 'Mariyam Nazeeha',  phone: '9912045', email: '',                   notify: 'viber' },
      rilwan:  { id: 'cus_rilwan',  name: 'Mohamed Rilwan',   phone: '7778901', email: 'rilwan@example.com', notify: 'whatsapp' },
      zeena:   { id: 'cus_zeena',   name: 'Fathimath Zeena',  phone: '7654321', email: '',                   notify: 'sms' },
      waheed:  { id: 'cus_waheed',  name: 'Ali Waheed',       phone: '9912345', email: 'waheed@example.com', notify: 'whatsapp' },
      afeef:   { id: 'cus_afeef',   name: 'Hussain Afeef',    phone: '7345678', email: '',                   notify: 'sms' },
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
      fonu: { address: 'Fonu Online Store, Lot 10432, Nirolhu Magu', zone: 'hulhumale_p1' },
      redbox: { address: 'Redbox collection point, Maafannu', zone: 'male' },
      pikpost: { address: 'Pikpost locker, Bus Terminal', zone: 'male' },
      postoffice: { address: 'Maldives Post, 7th floor, Boduthakurufaanu Magu', zone: 'male' },
      dhl: { address: 'DHL office, Orchid Magu', zone: 'male' },
      ministry: { address: 'Ministry of Economic Development, Velaanaage', zone: 'male' },
      agora: { address: 'Agora Mall, Ameenee Magu', zone: 'male' },
      arrivals: { address: 'Velana International Airport, Arrivals hall', zone: 'airport' },
      departures: { address: 'Velana International Airport, Departures entrance', zone: 'airport' },
    };
    const staffBy = { admin: 'admin', fayaz: 'operator:stf_fayaz', lamya: 'operator:stf_lamya' };

    // ---- files (demo images drawn as SVG) --------------------------------------------------------------------------------
    const files = [];
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h | 0; }
    function addFile(id, kind, orderId, name, svg, at) {
      const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      files.push({ id, kind, orderId, name, type: 'image/svg+xml', size: dataUrl.length, dataUrl, at, createdAt: at, updatedAt: at });
      return id;
    }
    const F = 'font-family="Inter,Arial,sans-serif"';
    function slipFile(orderId, name, amount, ref, at, payer, bank) {
      const row = (y, k, v, big) => '<text x="40" y="' + y + '" ' + F + ' font-size="14" fill="#5c5c66">' + k + '</text><text x="600" y="' + y + '" text-anchor="end" ' + F + ' font-size="' + (big ? 30 : 16) + '"' + (big ? ' font-weight="600"' : '') + ' fill="#111114">' + esc(v) + '</text>';
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900" viewBox="0 0 640 900"><rect width="640" height="900" fill="#ffffff"/>' +
        '<text x="40" y="70" ' + F + ' font-size="22" fill="#111114">Transfer successful</text><text x="40" y="100" ' + F + ' font-size="14" fill="#5c5c66">' + esc(bank) + ' · Internet banking</text><line x1="40" y1="130" x2="600" y2="130" stroke="#e5e5ea"/>' +
        row(200, 'Amount', 'MVR ' + amount.toFixed(2), true) + row(260, 'From', payer + ' · 7730 **** 4412') + row(310, 'To', 'Mr. Delivery Man · 7730 0000 12345') + row(360, 'Reference', ref) +
        row(410, 'Date', at.slice(0, 10) + ' ' + at.slice(11, 16)) + row(460, 'Transaction ID', 'TX' + String(Math.abs(hash(ref)) % 100000000).padStart(8, '0')) +
        '<line x1="40" y1="500" x2="600" y2="500" stroke="#e5e5ea"/><text x="40" y="860" ' + F + ' font-size="12" fill="#8a8a94">Demo receipt generated for the mockup</text></svg>';
      const id = addFile('file_slip_' + orderId.replace('ord_seed_', ''), 'slip', orderId, name, svg, at);
      return { fileId: id, name, type: 'image/svg+xml', size: files[files.length - 1].size };
    }
    function photo(id, kind, orderId, caption, at, tone) {
      const box = tone === 'xl' ? '<rect x="200" y="170" width="400" height="260" rx="8" fill="#8a6f52"/><rect x="200" y="170" width="400" height="30" fill="#6f5740"/><rect x="380" y="170" width="40" height="260" fill="#a3866a"/>' :
        tone === 'bag' ? '<path d="M300 230 h200 l20 200 h-240 z" fill="#f2efe9" stroke="#c9c4ba" stroke-width="3"/><path d="M350 230 q50 -70 100 0" fill="none" stroke="#c9c4ba" stroke-width="8"/>' :
        '<rect x="290" y="250" width="220" height="180" rx="6" fill="#8a6f52"/><rect x="290" y="250" width="220" height="24" fill="#6f5740"/><rect x="380" y="250" width="40" height="180" fill="#a3866a"/>';
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#d8d8dc"/><rect x="0" y="420" width="800" height="180" fill="#b9b9bf"/><rect x="60" y="60" width="140" height="360" fill="#c9c9ce"/>' + box +
        '<text x="20" y="585" ' + F + ' font-size="14" fill="#5c5c66">' + esc(caption) + ' (demo) · ' + esc(at.slice(0, 16).replace('T', ' ')) + '</text></svg>';
      return addFile(id, kind, orderId, kind === 'package' ? 'package.jpg' : kind === 'proof_collection' ? 'collected.jpg' : kind === 'failed' ? 'attempt.jpg' : 'delivered.jpg', svg, at);
    }
    function docFile(id, orderId, title, lines, at, name) {
      const body = lines.map((l, i) => '<text x="60" y="' + (220 + i * 34) + '" ' + F + ' font-size="16" fill="#33333a">' + esc(l) + '</text>').join('');
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="880" viewBox="0 0 640 880"><rect width="640" height="880" fill="#fff"/><rect x="0" y="0" width="640" height="10" fill="#D2002F"/>' +
        '<text x="60" y="110" ' + F + ' font-size="26" font-weight="600" fill="#111114">' + esc(title) + '</text><line x1="60" y1="150" x2="580" y2="150" stroke="#e5e5ea"/>' + body +
        '<text x="60" y="840" ' + F + ' font-size="12" fill="#8a8a94">Demo document generated for the mockup</text></svg>';
      return { fileId: addFile(id, 'document', orderId, name || (title + '.pdf'), svg, at), name: name || (title + '.pdf'), type: 'image/svg+xml' };
    }

    // ---- packages ---------------------------------------------------------------------------------------------------------
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
        underOneFt: o.underOneFt !== false, dims: o.dims || null, weightKg: o.weightKg || null, photoId: null, sizeSource: o.dims ? 'customer' : 'estimate',
        pickup: o.shop ? null : endpoint(o.pickup, { contact: o.pickupContact || null, cargo: o.pickupCargo || null, meetAt: o.pickupMeetAt || '', instructions: o.pickupNote || '' }),
        dropoff: endpoint(o.dropoff, { recipient: o.recipient || null, cargo: o.dropCargo || null, meetAt: o.dropCargo ? '' : (o.meetAt || 'door'), instructions: o.dropNote || '' }),
        shop: o.shop ? Object.assign({ address: '', unavailable: 'call', receiptTotal: null, receiptPhotoId: null }, o.shop, MDM.geo.geocodeZone(o.shop.zone, o.shop.name)) : null,
        notes: o.notes || '',
      };
    }

    // ---- orders -----------------------------------------------------------------------------------------------------------
    let evSeq = 1;
    function ev(type, label, at, by, visibility) { return { id: 'evt_seed_' + String(evSeq++).padStart(4, '0'), at, type, label, by: by || 'system', visibility: visibility || 'public', meta: null }; }
    const drvName = id => (drivers.find(d => d.id === id) || {}).name || 'Driver';
    const orders = [];
    // spec.steps: [[status, minutesAgo, by?, label?], …] in order; they become statusHistory and the timeline events.
    function order(spec) {
      const id = 'ord_seed_' + spec.code.slice(4);
      const service = spec.service || 'pick';
      const q = MDM.pricing.quote({ service, packages: spec.packages }, settings);
      const first = spec.packages[0];
      const cust = spec.customer;
      const created = spec.steps[0][1];
      const last = spec.steps[spec.steps.length - 1][1];
      const pick = first.shop ? { address: first.shop.name + ', ' + first.shop.address, zone: first.shop.zone, landmark: '', contact: { name: first.shop.name, phone: '' } } : first.pickup;
      const drop = first.dropoff;
      const o = {
        id, code: spec.code, createdAt: t(created), updatedAt: t(spec.updatedMin != null ? spec.updatedMin : last), source: spec.source || 'web',
        requestType: spec.type || 'home', service, serviceLevel: spec.level || 'normal', accountId: spec.accountId || null, batchId: spec.batchId || null, batchIndex: spec.batchIndex || null,
        customerId: cust.id || null, customer: { name: cust.name, phone: cust.phone, email: cust.email || '', notify: cust.notify || 'sms' },
        collection: { address: pick.address, zone: pick.zone, landmark: pick.landmark || '', contactName: (pick.contact && pick.contact.name) || cust.name, contactPhone: (pick.contact && pick.contact.phone) || cust.phone, instructions: spec.collectNote || '' },
        delivery: { address: drop.address, zone: drop.zone, landmark: drop.landmark || '', recipientName: (drop.recipient && drop.recipient.name) || cust.name, recipientPhone: (drop.recipient && drop.recipient.phone) || cust.phone, instructions: spec.deliverNote || '', meetAt: drop.meetAt || 'door' },
        details: spec.details || {}, documents: spec.documents || [], items: spec.items || null,
        packages: q.packages, fees: q.fees, totals: q.totals, estimate: MDM.pricing.estimateRange(spec.packages, settings, service),
        pricing: { status: 'estimated', history: [], needsReview: !!spec.needsReview, confirmedAt: null, confirmedBy: null, remarks: '' },
        schedule: spec.schedule || { type: 'asap' },
        payment: Object.assign({ method: 'transfer', status: 'pending', upfrontRequired: false, bank: '', payerName: '', paidAmount: null, reference: '', slip: null, invoiceNo: null, rejectReason: null, note: '', refund: null }, spec.payment || {}),
        priority: Object.assign({ level: spec.level === 'express' ? 'express' : 'normal', status: 'none', requests: [] }, spec.priority || {}),
        cancellation: spec.cancellation || { status: 'none' }, changes: spec.changes || [], statusHistory: [],
        settlement: null, status: spec.steps[spec.steps.length - 1][0], driverId: spec.driverId || null,
        route: { stops: [], polyline: [] }, events: [], notes: spec.notes || [],
      };
      // Times in a spec are minutes ago, or relative to a step: 'delivered' or 'delivered+30' (30 minutes after it was delivered).
      const stepMin = st => { const x = spec.steps.find(z => z[0] === st); return x ? x[1] : created; };
      const rt = v => typeof v === 'number' ? t(v) : (typeof v === 'string' && /^[a-z_]+(\+\d+)?$/.test(v) ? t(stepMin(v.split('+')[0]) - Number(v.split('+')[1] || 0)) : v);
      ['requestedAt', 'submittedAt', 'verifiedAt', 'paidAt'].forEach(k => { o.payment[k] = rt(o.payment[k]) || null; });
      if (o.payment.refund) o.payment.refund.at = rt(o.payment.refund.at);
      if (o.payment.verifiedAt && !o.payment.verifiedBy) o.payment.verifiedBy = staffBy.lamya;
      if (o.payment.status !== 'pending' && o.payment.status !== 'invoiced' && !o.payment.invoiceNo) o.payment.invoiceNo = 'INV-' + spec.code.slice(4);
      if (spec.adjustments) { o.fees.adjustments = spec.adjustments.map((a, i) => Object.assign({ id: 'adj_' + spec.code.slice(4) + '_' + i, at: t(a.min != null ? a.min : created - 5), by: staffBy.fayaz, remarks: '' }, a)); MDM.pricing.recalc(o, settings); }
      if (spec.receipt != null) { o.packages[0].shop.receiptTotal = spec.receipt; MDM.pricing.recalc(o, settings); }
      if (o.payment.status === 'paid' || o.payment.status === 'received') { if (o.payment.paidAmount == null) o.payment.paidAmount = o.totals.total; o.payment.reference = o.payment.reference || spec.code; }
      // Status history and the public timeline
      let prev = null;
      spec.steps.forEach(([st, min, by, label]) => {
        const at = t(min);
        const who = o.driverId ? drvName(o.driverId) : 'Our driver';
        const dby = by || ({ requested: spec.by || 'customer', confirmed: staffBy.fayaz, assigned: staffBy.fayaz, dispatched: staffBy.fayaz }[st] || (o.driverId ? 'driver:' + o.driverId : staffBy.fayaz));
        if (st === 'requested') o.events.push(ev('created', label || (spec.source && spec.source !== 'web' ? 'Order created by our team (' + spec.source + ')' : 'Order submitted, we will confirm the price shortly'), at, dby));
        else if (st === 'confirmed') {
          o.events.push(ev('price_confirmed', 'Price confirmed: ' + MDM.pricing.format(o.totals.total), at, dby));
          o.events.push(ev('confirmed', label || 'Order confirmed', at, dby));
          o.pricing = Object.assign(o.pricing, { status: 'confirmed', confirmedAt: at, confirmedBy: dby, history: [{ at, by: dby, from: o.totals.total, to: o.totals.total, note: 'Final price confirmed' }] });
        }
        else if (st === 'assigned') o.events.push(ev('assigned', label || 'Driver assigned: ' + who, at, dby));
        else if (st === 'dispatched') o.events.push(ev('dispatched', label || 'Dispatched to ' + who, at, dby));
        else if (st === 'on_the_way') o.events.push(ev('route_started', label || who + ' is on the way to collect', at, dby));
        else if (st === 'arrived') o.events.push(ev('arrived', label || who + ' arrived for collection', at, dby));
        else if (st === 'collected') o.events.push(ev('collected', label || 'Collected from ' + o.collection.address + ', proof photo added', at, dby));
        else if (st === 'out_for_delivery') o.events.push(ev('out_for_delivery', label || 'Out for delivery with ' + who, at, dby));
        else if (st === 'delivered') o.events.push(ev('delivered', label || 'Delivered to ' + o.delivery.recipientName, at, dby));
        else o.events.push(ev(st, label || MDM.STATUS[st].customer, at, dby));
        o.statusHistory.push({ at, from: prev, to: st, by: dby });
        prev = st;
      });
      // Payment timeline
      const p = o.payment;
      if (p.requestedAt) o.events.push(ev('payment_requested', (p.upfront ? 'Payment requested before delivery: ' : 'Invoice issued: ') + MDM.pricing.format(o.totals.total), p.requestedAt, 'system'));
      if (p.submittedAt) o.events.push(ev('payment_submitted', 'Transfer slip received, we are checking it', p.submittedAt, 'customer'));
      if (p.verifiedAt) o.events.push(ev('payment_verified', 'Payment verified, thank you', p.verifiedAt, p.verifiedBy));
      (spec.extra || []).forEach(x => o.events.push(ev(x[0], x[1], t(x[2]), x[3] || staffBy.fayaz, x[4] || 'public')));
      // Route: stops for anything a driver has touched
      if (spec.driverId || spec.withRoute) {
        o.route.stops = MDM.store._buildStops(o).map((s, i) => Object.assign(s, { id: 'stp_' + spec.code.slice(4) + '_' + (i + 1) }));
        (spec.stops || []).forEach((st, i) => { if (o.route.stops[i]) Object.assign(o.route.stops[i], st, { at: rt(st.at) || null, arrivedAt: rt(st.arrivedAt || st.at) || null }, st.failedAt ? { failedAt: rt(st.failedAt) } : {}); });
        const open = o.route.stops.filter(s => s.status !== 'done' && s.status !== 'failed');
        o.route.polyline = MDM.geo.routeThrough(open.length >= 2 ? open : o.route.stops);
      }
      if (spec.settle) {
        const paid = p.paidAmount != null ? p.paidAmount : o.totals.total, due = o.totals.total, balance = paid - due;
        o.settlement = { status: spec.settle === 'settled' ? 'settled' : (balance > 0 ? 'refund_due' : balance < 0 ? 'topup_due' : 'settled'), paid, due, balance, settledAt: spec.settle === 'settled' ? o.updatedAt : null, reference: spec.settle === 'settled' ? 'FAVARA 2291' : '' };
      }
      if (spec.cancelReason) { o.cancelReason = spec.cancelReason; o.cancelledBy = spec.cancelledBy || 'customer'; o.cancelledAt = o.updatedAt; }
      o.events.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
      orders.push(o);
      return o;
    }
    const paid = (requestedMin, submittedMin, verifiedMin, bank, payer, extra) => Object.assign({ status: 'paid', requestedAt: requestedMin, submittedAt: submittedMin, verifiedAt: verifiedMin, paidAt: verifiedMin, bank, payerName: payer }, extra || {});
    // A normal, completed lifecycle from submission to delivery, minutes apart.
    const full = (c, drv, ...gaps) => {
      const names = ['requested', 'confirmed', 'assigned', 'dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery', 'delivered'];
      let m = c; const steps = [[names[0], m]];
      gaps.forEach((g, i) => { m -= g; steps.push([names[i + 1], m]); });
      return steps;
    };
    const dropDone = (at, name, handed, photoId, extra) => Object.assign({ status: 'done', at, handedTo: handed || 'recipient', recipientName: name, confirmed: true, photoId: photoId || null }, extra || {});
    const pickDone = (at, photoId) => ({ status: 'done', at, proofPhotoId: photoId || null });

    // Delivered over the last week
    order({ code: 'MDM-1025', customer: C.shifza, driverId: 'drv_shiyam', steps: full(days(6, 3), 'drv_shiyam', 20, 12, 3, 8, 12, 4, 2, 25),
      packages: [pkg({ size: 'bag', description: 'Documents in an envelope', pickup: A.kaneeru, dropoff: A.handhuvaree, recipient: { name: 'Ahmed Sobah', phone: '7788123' } })],
      payment: paid('delivered', 'delivered+90', 'delivered+120', 'bml', 'Aishath Shifza'),
      stops: [pickDone('collected'), dropDone('delivered', 'Ahmed Sobah')] });

    order({ code: 'MDM-1026', type: 'shop_buy', service: 'shop', customer: C.nazeeha, driverId: 'drv_nazim', steps: full(days(5, 4), 'drv_nazim', 15, 10, 2, 5, 20, 40, 2, 30), receipt: 412, settle: 'due',
      packages: [pkg({ size: 'bag', description: 'Groceries', shop: { name: "STO People's Choice", zone: 'male', address: 'Boduthakurufaanu Magu', list: '2 kg rice, 1 L cooking oil, 12 eggs, 2 kg onions, dhal 1 kg, chilli 250 g', budget: 450, unavailable: 'closest' }, dropoff: A.ranfaru, recipient: { name: 'Mariyam Nazeeha', phone: '9912045' } })],
      payment: paid('confirmed', 'confirmed+4', 'confirmed+9', 'mib', 'Mariyam Nazeeha', { upfront: true, upfrontRequired: true, paidAmount: 540 }),
      stops: [pickDone('collected'), dropDone('delivered', 'Mariyam Nazeeha')] });

    order({ code: 'MDM-1027', customer: C.rilwan, driverId: 'drv_faisal', steps: full(days(4, 6), 'drv_faisal', 25, 10, 5, 10, 15, 3, 2, 40),
      packages: [pkg({ size: 'box', description: 'Printer cartridges (2 boxes taped together)', fragile: true, dims: { l: 32, w: 24, h: 18 }, pickup: A.meerubahuru, dropoff: A.vinares, recipient: { name: 'Ibrahim Naail', phone: '7723456' }, meetAt: 'lobby' })],
      payment: paid('confirmed', 'confirmed+3', 'confirmed+8', 'bml', 'Mohamed Rilwan', { upfront: true }),
      stops: [pickDone('collected'), dropDone('delivered', 'Ibrahim Naail')] });

    order({ code: 'MDM-1028', customer: C.waheed, steps: [['requested', days(3, 5)], ['confirmed', days(3, 4.8)], ['cancelled', days(3, 4), staffBy.fayaz, 'Cancelled at your request: recipient travelled']],
      cancelReason: 'Recipient travelled', cancellation: { status: 'approved', reason: 'Recipient travelled', requestedAt: t(days(3, 4.2)), requestedBy: 'customer', decidedAt: t(days(3, 4)), decidedBy: staffBy.fayaz, remarks: 'No charge' },
      extra: [['cancel_requested', 'Cancellation requested: Recipient travelled', days(3, 4.2), 'customer']],
      packages: [pkg({ size: 'bag', description: 'Birthday gift', pickup: A.dhonveli, dropoff: A.rehendhi, recipient: { name: 'Aminath Reesha', phone: '9955123' } })] });

    order({ code: 'MDM-1029', type: 'airport', customer: C.zeena, driverId: 'drv_nazim', steps: full(days(2, 7), 'drv_nazim', 20, 10, 2, 15, 18, 5, 2, 35),
      details: { mode: 'collect', area: 'arrivals', flight: 'EK 652', flightTime: '13:45', passengerName: 'Hawwa Leena', passengerPhone: '+61 412 345 678', bags: 1 },
      packages: [pkg({ size: 'bag', description: 'Passport and documents from a relative arriving on EK 652', pickup: A.arrivals, pickupMeetAt: 'arrivals', pickupContact: { name: 'Hawwa Leena', phone: '+61 412 345 678' }, dropoff: A.handhuvaree, recipient: { name: 'Fathimath Zeena', phone: '7654321' }, meetAt: 'reception' })],
      payment: paid('delivered', 'delivered+15', 'delivered+40', 'bml', 'Fathimath Zeena'),
      stops: [pickDone('collected'), dropDone('delivered', 'Fathimath Zeena', 'security')] });

    order({ code: 'MDM-1030', customer: C.afeef, driverId: 'drv_shiyam', steps: full(days(1, 8), 'drv_shiyam', 15, 8, 2, 6, 10, 2, 2, 20),
      packages: [pkg({ size: 'box', description: 'Spare parts for a dhoni engine, to the boat', pickup: A.ranfaru, dropoff: { address: 'Malé North Harbour', zone: 'male' }, dropCargo: { terminal: 'male_north', boat: 'Alihaa Express', time: '16:00', consignee: 'Hassan Ziyad, Thoddoo', receiptNo: 'AE-2291' }, recipient: { name: 'Boat crew, Alihaa Express', phone: '7911223' } })],
      payment: paid('delivered', 'delivered+30', 'delivered+36', 'mib', 'Hussain Afeef'),
      stops: [pickDone('collected'), dropDone('delivered', 'Alihaa Express crew')] });

    // Delivered today (with proof photos)
    const o1031 = order({ code: 'MDM-1031', customer: C.shifza, driverId: 'drv_nazim', steps: full(300, 'drv_nazim', 15, 8, 2, 10, 12, 3, 2, 40),
      packages: [pkg({ size: 'bag', description: 'Lunch tiffin', pickup: A.kaneeru, dropoff: A.amin, recipient: { name: 'Mohamed Shaffan', phone: '7700456' } })],
      payment: paid('delivered', 'delivered+18', 'delivered+38', 'bml', 'Aishath Shifza'),
      stops: [pickDone('collected'), dropDone('delivered', 'Mohamed Shaffan')] });
    o1031.route.stops[0].proofPhotoId = photo('file_col_1031', 'proof_collection', o1031.id, 'Proof of collection', o1031.route.stops[0].at, 'bag');
    o1031.route.stops[1].photoId = photo('file_proof_1031', 'proof', o1031.id, 'Proof of delivery', o1031.route.stops[1].at, 'bag');

    // Delivered, invoice sent after delivery, not paid yet (the default "pay after delivery" path)
    order({ code: 'MDM-1032', customer: C.nazeeha, driverId: 'drv_rasheed', steps: full(260, 'drv_rasheed', 10, 5, 2, 10, 8, 3, 2, 100),
      packages: [
        pkg({ size: 'bag', description: 'Keys and a charger', pickup: A.ranfaru, dropoff: A.dhonveli, recipient: { name: 'Ali Nasih', phone: '7712233' } }),
        pkg({ size: 'box', description: 'Baby clothes', pickup: A.ranfaru, dropoff: A.rehendhi, recipient: { name: 'Aminath Sana', phone: '9944556' }, meetAt: 'door' }),
      ],
      payment: { status: 'requested', requestedAt: 'delivered' },
      stops: [pickDone('collected'), dropDone('out_for_delivery+20', 'Ali Nasih'), dropDone('delivered', "Sana's mother", 'family')] });

    order({ code: 'MDM-1033', type: 'shop_buy', service: 'shop', customer: C.rilwan, driverId: 'drv_shiyam', steps: full(200, 'drv_shiyam', 12, 5, 2, 10, 50, 5, 2, 50), receipt: 300, settle: 'settled',
      packages: [pkg({ size: 'bag', description: 'Pharmacy run', shop: { name: 'Lifeline Pharmacy', zone: 'male', address: 'Majeedhee Magu', list: 'Panadol 2 strips, ORS sachets ×6, thermometer', budget: 300, unavailable: 'call' }, dropoff: A.meerubahuru, recipient: { name: 'Mohamed Rilwan', phone: '7778901' } })],
      payment: paid('confirmed', 'confirmed+2', 'confirmed+8', 'mib', 'Mohamed Rilwan', { upfront: true, upfrontRequired: true }),
      stops: [pickDone('collected'), dropDone('delivered', 'Mohamed Rilwan')] });

    // Waiting on the operator: price confirmation
    order({ code: 'MDM-1034', type: 'postal', customer: C.zeena, steps: [['requested', 50]], needsReview: true,
      details: { carrier: 'redbox_maafannu', collectionCode: 'RB-48213', collectBefore: dateOnly(-days(1)) + ' 17:00', smsNote: 'SMS from Redbox: collect before tomorrow 5 pm' },
      packages: [pkg({ size: 'bag', description: 'Redbox parcel (online order)', pickup: A.redbox, pickupContact: { name: 'Redbox Maafannu', phone: '' }, dropoff: A.villi, recipient: { name: 'Aishath Nuha', phone: '7688990' } })] });

    const o1035 = order({ code: 'MDM-1035', customer: C.waheed, steps: [['requested', 40]], needsReview: true,
      packages: [pkg({ size: 'xl', description: 'Standing fan (boxed)', fragile: true, dims: { l: 120, w: 45, h: 40 }, weightKg: 9, needsVehicle: true, pickup: A.dhonveli, dropoff: A.hiyaa5, recipient: { name: 'Hawwa Rasheedha', phone: '9922334' }, meetAt: 'lobby' })] });
    o1035.packages[0].photoId = photo('file_pkg_1035', 'package', o1035.id, 'Package photo from the customer', t(41), 'xl');

    // Paid upfront, slip waiting for verification
    const o1036 = order({ code: 'MDM-1036', type: 'office', customer: C.afeef, steps: [['requested', 35], ['confirmed', 31]],
      details: { task: 'submit', organisation: 'Ministry of Economic Development', reference: 'BR-2026-0911', details: 'Submit the signed business registration renewal and collect the stamped receipt', returnDocs: true },
      packages: [pkg({ size: 'bag', description: 'Signed renewal form and ID copy', pickup: A.rehendhi, pickupContact: { name: 'Zaha Adam', phone: '7901122' }, dropoff: A.ministry, recipient: { name: 'Front desk, Ministry of Economic Development', phone: '3323668' } })],
      adjustments: [{ preset: 'waiting', label: 'Office queue time', amount: 30, min: 31, remarks: 'Counter queue, up to 1 hour' }],
      payment: { status: 'received', upfront: true, requestedAt: 31, submittedAt: 28, bank: 'bml', payerName: 'Hussain Afeef' } });
    o1036.payment.slip = slipFile(o1036.id, 'IMG_2041.jpg', 75, 'MDM-1036', t(29), 'Hussain Afeef', 'Bank of Maldives');
    o1036.documents = [docFile('file_doc_1036', o1036.id, 'Business registration renewal', ['Applicant: Hussain Afeef', 'Registration no: BR-2026-0911', 'Form: Renewal (signed)', 'Attached: ID card copy'], t(35), 'renewal-form.pdf')];

    const o1037 = order({ code: 'MDM-1037', customer: C.shifza, steps: [['requested', 30], ['confirmed', 27]],
      packages: [
        pkg({ size: 'bag', description: 'Homemade cake box', fragile: true, pickup: A.amin, dropoff: A.vinares, recipient: { name: 'Ahmed Shan', phone: '7790011' } }),
        pkg({ size: 'bag', description: 'Second cake box', fragile: true, pickup: A.amin, dropoff: A.hiyaa5, recipient: { name: 'Aishath Rifa', phone: '9911002' } }),
      ],
      payment: { status: 'received', upfront: true, requestedAt: 27, submittedAt: 24, bank: 'mib', payerName: 'A. Shifza', paidAmount: 70, reference: 'MDM 1037' } });
    o1037.payment.slip = slipFile(o1037.id, 'Screenshot 2026-09-21.png', 70, 'MDM 1037', t(25), 'A. Shifza', 'Maldives Islamic Bank');

    // Live demo: out for delivery right now (pay after delivery)
    const o1038 = order({ code: 'MDM-1038', customer: C.nazeeha, driverId: 'drv_nazim', steps: full(45, 'drv_nazim', 8, 5, 2, 6, 7, 4, 3),
      packages: [pkg({ size: 'bag', description: 'Office keys and a laptop charger', pickup: A.kaneeru, dropoff: A.amin, recipient: { name: 'Ismail Riyaz', phone: '7755667' }, meetAt: 'lobby' })],
      stops: [pickDone('collected')] });
    o1038.route.stops[0].proofPhotoId = photo('file_col_1038', 'proof_collection', o1038.id, 'Proof of collection', o1038.route.stops[0].at, 'bag');
    o1038.packages[0].photoId = o1038.route.stops[0].proofPhotoId; o1038.packages[0].photoSource = 'driver';

    order({ code: 'MDM-1039', customer: C.rilwan, driverId: 'drv_shiyam', steps: [['requested', 38], ['confirmed', 30], ['assigned', 12]],
      packages: [pkg({ size: 'box', description: 'Photo frames', fragile: true, pickup: A.meerubahuru, dropoff: A.handhuvaree, recipient: { name: 'Mariyam Waheeda', phone: '7733445' } })] });

    // Failed delivery waiting for the operator's decision
    const o1040 = order({ code: 'MDM-1040', customer: C.zeena, driverId: 'drv_rasheed', steps: full(95, 'drv_rasheed', 10, 5, 2, 8, 10, 5, 3).concat([['failed', 18, 'driver:drv_rasheed', 'Delivery failed: recipient unavailable']]),
      packages: [pkg({ size: 'bag', description: 'Medicine from the pharmacy', pickup: A.handhuvaree, dropoff: A.hiyaa5, recipient: { name: 'Aminath Shifana', phone: '7677889' }, meetAt: 'door' })],
      extra: [['note', 'Driver remark: Called twice, no reply at 14-03', 18, 'driver:drv_rasheed', 'internal']],
      stops: [pickDone('collected'), { status: 'failed', failReason: 'recipient_unavailable', failedAt: 'failed', remarks: 'Called twice, no reply at 14-03', attempts: 1 }] });
    o1040.route.stops[1].failPhotoId = photo('file_fail_1040', 'failed', o1040.id, 'Attempted delivery', t(18), 'bag');

    // Confirmed, waiting for a driver
    const o1041 = order({ code: 'MDM-1041', type: 'shop_collect', customer: C.afeef, steps: [['requested', 25], ['confirmed', 15]],
      details: { shopName: 'Agora Mall, Electronics counter', proof: 'invoice', orderNo: 'AG-55190', paidByCustomer: true },
      packages: [pkg({ size: 'box', description: 'Wireless router (paid in store)', pickup: A.agora, pickupContact: { name: 'Agora electronics counter', phone: '3301010' }, dropoff: A.ranfaru, recipient: { name: 'Ahmed Fazeel', phone: '7811223' } })] });
    o1041.documents = [docFile('file_inv_1041', o1041.id, 'Agora Mall invoice AG-55190', ['TP-Link Archer router × 1', 'Paid: MVR 1,190.00 (card)', 'Collect from: Electronics counter'], t(25), 'agora-invoice.pdf')];
    o1041.documents[0].kind = 'invoice';

    order({ code: 'MDM-1042', type: 'postal', customer: C.waheed, driverId: 'drv_shiyam', steps: [['requested', 22], ['confirmed', 18], ['assigned', 12], ['dispatched', 10]],
      details: { carrier: 'pikpost', location: 'bus_terminal', collectionCode: 'PK-77120', collectBefore: dateOnly(0) + ' 22:00' },
      packages: [pkg({ size: 'bag', description: 'Pikpost parcel', pickup: A.pikpost, pickupContact: { name: 'Pikpost locker', phone: '' }, dropoff: A.kaneeru, recipient: { name: 'Ali Waheed', phone: '9912345' }, meetAt: 'reception' })] });

    const o1043 = order({ code: 'MDM-1043', customer: C.shifza, driverId: 'drv_shiyam', steps: full(70, 'drv_shiyam', 10, 5, 2, 10, 15, 19),
      packages: [
        pkg({ size: 'bag', description: 'Return parcel', pickup: A.handhuvaree, dropoff: A.rehendhi, recipient: { name: 'Nashwa Ahmed', phone: '7809988' } }),
        pkg({ size: 'bag', description: 'Second parcel', pickup: A.dhonveli, dropoff: A.rehendhi, recipient: { name: 'Nashwa Ahmed', phone: '7809988' } }),
      ],
      stops: [pickDone('arrived+6'), pickDone('collected')] });
    o1043.route.stops[1].proofPhotoId = photo('file_col_1043', 'proof_collection', o1043.id, 'Proof of collection', o1043.route.stops[1].at, 'bag');

    // Business account orders (invoiced monthly)
    const kandu = { id: null, name: 'Kandu Books & Stationery', phone: '7801122', email: 'orders@kandubooks.example', notify: 'whatsapp' };
    const bizPkg = (desc, drop, recipient) => pkg({ size: 'bag', description: desc, pickup: A.kandu, pickupContact: { name: 'Ahmed Shafeeu', phone: '7801122' }, dropoff: drop, recipient });
    const biz = (code, createdMin, packages) => order({ code, type: 'business', service: 'business', source: 'business', by: 'business:bacc_kandu', accountId: 'bacc_kandu', customer: kandu, driverId: 'drv_rasheed',
      steps: full(createdMin, 'drv_rasheed', 10, 10, 5, 10, 8, 4, 3, 60), payment: { method: 'invoice', status: 'invoiced' }, packages,
      stops: [pickDone('collected')].concat(packages.map((p, i) => dropDone(i === packages.length - 1 ? 'delivered' : 'out_for_delivery+' + (15 + i * 12), p.dropoff.recipient.name))) });
    biz('MDM-1044', days(9, 5), [bizPkg('Textbook order 1182', A.amin, { name: 'Aishath Leela', phone: '7710101' }), bizPkg('Textbook order 1183', A.rehendhi, { name: 'Moosa Rasheed', phone: '7710202' })]);
    biz('MDM-1045', days(6, 4), [bizPkg('Stationery order 1190', A.ranfaru, { name: 'Ibrahim Nazeer', phone: '9910303' }), bizPkg('Stationery order 1191', A.handhuvaree, { name: 'Sara Ahmed', phone: '7710404' }), bizPkg('Stationery order 1192', A.hiyaa5, { name: 'Ahmed Naseem', phone: '7710505' })]);
    biz('MDM-1046', days(3, 6), [bizPkg('Textbook order 1201', A.vinares, { name: 'Fathimath Ibrahim', phone: '7710606' }), bizPkg('Textbook order 1202', A.dhonveli, { name: 'Hussain Shareef', phone: '9910707' })]);
    biz('MDM-1047', days(1, 5), [bizPkg('Art supplies order 1210', A.meerubahuru, { name: 'Aminath Zahira', phone: '7710808' }), bizPkg('Art supplies order 1211', A.amin, { name: 'Ali Shiyam', phone: '7710909' })]);

    // Express, waiting for confirmation (priority request opened automatically)
    order({ code: 'MDM-1048', level: 'express', customer: C.rilwan, steps: [['requested', 9]], needsReview: true,
      priority: { level: 'express', status: 'requested', requests: [{ id: 'pri_1048', at: t(9), by: 'customer', reason: 'Express delivery chosen when booking', deadline: '', instructions: '', decision: 'pending', decidedAt: null, decidedBy: null, remarks: '' }] },
      packages: [pkg({ size: 'bag', description: 'Forgotten passport for a 6 pm flight', pickup: A.meerubahuru, dropoff: A.departures, meetAt: 'departures', recipient: { name: 'Mohamed Rilwan', phone: '7778901' } })] });

    // Business priority request waiting for approval
    biz('MDM-1049', 28, [bizPkg('Exam papers for Ghiyasuddin School', A.ranfaru, { name: 'School office', phone: '3322001' })]);
    const o1049 = orders[orders.length - 1];
    Object.assign(o1049, { status: 'confirmed', driverId: null, statusHistory: o1049.statusHistory.slice(0, 2), route: { stops: [], polyline: [] } });
    o1049.events = o1049.events.filter(e => ['created', 'price_confirmed', 'confirmed'].indexOf(e.type) >= 0);
    o1049.priority = { level: 'normal', status: 'requested', requests: [{ id: 'pri_1049', at: t(15), by: 'business:bacc_kandu', reason: 'Exam papers must reach the school before the 2 pm paper', deadline: dateOnly(0) + ' 13:30', instructions: 'Hand to the exam office only, signature needed', decision: 'pending', decidedAt: null, decidedBy: null, remarks: '' }] };
    o1049.events.push(ev('priority_requested', 'Priority delivery requested: Exam papers must reach the school before the 2 pm paper', t(15), 'business:bacc_kandu'));
    o1049.updatedAt = t(15);

    // Airport baggage, driver on the way to collect (Hulhumalé Phase 2 → Departures)
    order({ code: 'MDM-1050', type: 'airport', customer: C.zeena, driverId: 'drv_faisal', steps: [['requested', 60], ['confirmed', 52], ['assigned', 40], ['dispatched', 35], ['on_the_way', 6]],
      details: { mode: 'baggage', area: 'departures', flight: 'UL 104', flightTime: '21:30', passengerName: 'Fathimath Zeena', passengerPhone: '7654321', bags: 2 },
      packages: [pkg({ size: 'xl', description: '2 suitcases for check-in', dims: { l: 75, w: 50, h: 30 }, weightKg: 23, pickup: A.vinares, dropoff: A.departures, meetAt: 'departures', recipient: { name: 'Fathimath Zeena', phone: '7654321' } })],
      adjustments: [{ preset: 'size', label: 'Second suitcase', amount: 40, min: 52, remarks: '2 bags, 1 trip' }],
      payment: paid('confirmed', 'confirmed+2', 'confirmed+7', 'bml', 'Fathimath Zeena', { upfront: true }) });

    // Customer asked to cancel; waiting for the operator
    order({ code: 'MDM-1051', customer: C.afeef, steps: [['requested', 55], ['confirmed', 48]],
      cancellation: { status: 'requested', reason: 'Bought the item locally instead', requestedAt: t(7), requestedBy: 'customer', decidedAt: null, decidedBy: null, remarks: '' },
      extra: [['cancel_requested', 'Cancellation requested: Bought the item locally instead', 7, 'customer']],
      packages: [pkg({ size: 'bag', description: 'Phone case', pickup: A.agora, dropoff: A.rehendhi, recipient: { name: 'Hussain Afeef', phone: '7345678' } })] });

    // Paid upfront then cancelled: refund recorded
    order({ code: 'MDM-1052', customer: C.nazeeha, steps: [['requested', days(2, 9)], ['confirmed', days(2, 8.8)], ['cancelled', days(2, 6), staffBy.fayaz, 'Order cancelled: sender closed for the day']],
      cancelReason: 'Sender closed for the day', cancelledBy: staffBy.fayaz,
      packages: [pkg({ size: 'box', description: 'Curtains', pickup: A.handhuvaree, dropoff: A.vinares, recipient: { name: 'Mariyam Nazeeha', phone: '9912045' } })],
      payment: Object.assign(paid('confirmed', 'confirmed+12', 'confirmed+18', 'bml', 'Mariyam Nazeeha', { upfront: true }), { status: 'refunded', refund: { amount: 60, toBank: 'bml', toAccount: '7730 **** 1180', reference: 'RF-1052', at: 'cancelled+60', by: staffBy.lamya } }),
      extra: [['refund', 'Refund sent MVR 60', days(2, 5), staffBy.lamya]] });

    // Advance order for tomorrow, paid upfront
    order({ code: 'MDM-1053', level: 'advance', customer: C.shifza, steps: [['requested', 180], ['confirmed', 170]],
      schedule: { type: 'advance', collectDate: dateOnly(-days(1)), collectTime: '10:00', deliverDate: dateOnly(-days(1)), deliverTime: '12:00' },
      packages: [pkg({ size: 'box', description: 'Birthday cake (2 kg)', fragile: true, pickup: A.amin, dropoff: A.ranfaru, recipient: { name: 'Aishath Rafa', phone: '7920011' }, dropNote: 'Surprise, call the brother first: 7920012' })],
      payment: paid('confirmed', 'confirmed+10', 'confirmed+20', 'mib', 'Aishath Shifza', { upfront: true }) });

    // Post office, driver at the counter right now
    order({ code: 'MDM-1054', type: 'postal', customer: C.rilwan, driverId: 'drv_rasheed', steps: [['requested', 90], ['confirmed', 80], ['assigned', 60], ['dispatched', 55], ['on_the_way', 20], ['arrived', 4]],
      details: { carrier: 'post_office', postOffice: 'male_7th', collectionCode: '', ownerName: 'Mohamed Rilwan', shippingAddress: 'H. Meerubahuruge, Chandhanee Magu', ownerContact: '7778901', idNote: 'No collection code; the owner sent their ID details to the post collections contact' },
      packages: [pkg({ size: 'box', description: 'Registered parcel from Sri Lanka', pickup: A.postoffice, pickupContact: { name: 'Post collections counter', phone: '3315555' }, dropoff: A.meerubahuru, recipient: { name: 'Mohamed Rilwan', phone: '7778901' } })],
      stops: [{ status: 'arrived', arrivedAt: 'arrived' }] });

    // DHL import with the collection document uploaded
    const o1055 = order({ code: 'MDM-1055', type: 'postal', customer: C.waheed, steps: [['requested', 14]], needsReview: true,
      details: { carrier: 'dhl', trackingNo: '1234 5678 90', ownerName: 'Ali Waheed', ownerContact: '9912345' },
      packages: [pkg({ size: 'box', description: 'DHL import (camera lens)', fragile: true, pickup: A.dhl, pickupContact: { name: 'DHL counter', phone: '3311111' }, dropoff: A.hiyaa5, recipient: { name: 'Ali Waheed', phone: '9912345' } })] });
    o1055.documents = [docFile('file_dhl_1055', o1055.id, 'DHL collection document', ['Waybill: 1234 5678 90', 'Consignee: Ali Waheed', 'Duty: paid online', 'Authorised collector: Mr. Delivery Man'], t(14), 'dhl-collection.pdf')];
    o1055.documents[0].kind = 'collection_doc';

    // E-store order
    const products = [
      { id: 'prd_mailer', sku: 'PK-MAIL-5', name: 'Bubble mailers, pack of 5', category: 'packaging', price: 35, unit: 'pack', stock: 48, active: true, description: 'A5 padded mailers for documents, phone cases and small items.' },
      { id: 'prd_box_s', sku: 'PK-BOX-S', name: 'Shipping box, small', category: 'packaging', price: 15, unit: 'box', stock: 120, active: true, description: '25 × 20 × 10 cm. Fits a Bag delivery.' },
      { id: 'prd_box_m', sku: 'PK-BOX-M', name: 'Shipping box, medium', category: 'packaging', price: 25, unit: 'box', stock: 80, active: true, description: '30 × 30 × 20 cm. The largest Box delivery size.' },
      { id: 'prd_box_l', sku: 'PK-BOX-L', name: 'Shipping box, large', category: 'packaging', price: 40, unit: 'box', stock: 6, active: true, description: '50 × 40 × 40 cm. Travels as XL.' },
      { id: 'prd_tape', sku: 'SP-TAPE', name: 'Packing tape', category: 'supplies', price: 25, unit: 'roll', stock: 60, active: true, description: '48 mm clear tape, 100 m.' },
      { id: 'prd_fragile', sku: 'SP-FRAG', name: 'Fragile stickers', category: 'supplies', price: 10, unit: 'sheet', stock: 200, active: true, description: 'Sheet of 12 red fragile labels.' },
      { id: 'prd_cooler', sku: 'SP-COOL', name: 'Insulated food bag', category: 'supplies', price: 85, unit: 'bag', stock: 14, active: true, description: 'Keeps cakes and cold food steady across the bridge.' },
      { id: 'prd_bundle10', sku: 'BD-10', name: '10 Bag deliveries in Malé', category: 'bundles', price: 320, unit: 'bundle', stock: null, active: true, description: 'Prepaid credits, use within 60 days. Save MVR 30.' },
      { id: 'prd_bundle50', sku: 'BD-50B', name: 'Business starter, 50 packages', category: 'bundles', price: 1150, unit: 'bundle', stock: null, active: true, description: 'For online sellers. Malé and Hulhumalé, under 1 ft.' },
      { id: 'prd_labels', sku: 'SP-LBL', name: 'Shipping label roll', category: 'supplies', price: 120, unit: 'roll', stock: 0, active: true, description: '100 × 150 mm thermal labels, 250 per roll.' },
    ];
    products.forEach(p => { p.createdAt = t(days(30)); p.updatedAt = t(days(2)); });
    order({ code: 'MDM-1056', type: 'store', service: 'store', customer: C.zeena, steps: [['requested', 16, 'customer', 'E-store order placed: 2 items'], ['confirmed', 16, 'system', 'Order confirmed']],
      items: [{ productId: 'prd_mailer', name: 'Bubble mailers, pack of 5', unit: 'pack', qty: 2, price: 35, total: 70 }, { productId: 'prd_tape', name: 'Packing tape', unit: 'roll', qty: 1, price: 25, total: 25 }],
      packages: [pkg({ size: 'bag', description: '2 × Bubble mailers, 1 × Packing tape', pickup: { address: settings.store.address, zone: 'male' }, pickupContact: { name: 'Mr. Delivery Man store', phone: '7770000' }, dropoff: A.handhuvaree, recipient: { name: 'Fathimath Zeena', phone: '7654321' } })] });
    const o1056 = orders[orders.length - 1];
    o1056.totals.items = 95; o1056.totals.total += 95; o1056.estimate = { min: o1056.totals.total, max: o1056.totals.total, exact: o1056.totals.total };

    // ---- bulk business orders ---------------------------------------------------------------------------------------------
    const fonu = { id: null, name: 'Fonu Online Store', phone: '7633221', email: 'hello@fonu.example', notify: 'whatsapp' };
    const batches = [];
    function batch(spec) {
      const b = { id: spec.id, code: spec.code, accountId: spec.account, name: spec.name, serviceLevel: 'normal', source: spec.source, notes: spec.notes || '', status: spec.status,
        collection: spec.collection, orderIds: [], by: 'business:' + spec.account, createdAt: t(spec.createdMin), updatedAt: t(spec.updatedMin || spec.createdMin), collectedAt: spec.collectedMin != null ? t(spec.collectedMin) : null };
      spec.rows.forEach((r, i) => {
        const steps = [['requested', spec.createdMin, 'business:' + spec.account, 'Order submitted (bulk ' + spec.code + ', package ' + (i + 1) + ' of ' + spec.rows.length + ')'], ['confirmed', spec.createdMin - 1, 'system', 'Confirmed at the business rate']];
        if (spec.collectedMin != null) steps.push(['collected', spec.collectedMin, staffBy.fayaz, 'Collected, sorting at our hub']);
        if (r.out != null) steps.push(['out_for_delivery', r.out, 'driver:' + r.driver]);
        if (r.done != null) steps.push(['delivered', r.done, 'driver:' + r.driver]);
        const o = order({ code: r.code, type: 'bulk', service: 'business', source: spec.source, accountId: spec.account, batchId: spec.id, batchIndex: i + 1, customer: spec.customer, driverId: r.driver || null, withRoute: spec.collectedMin != null,
          details: { reference: r.reference }, payment: { method: 'invoice', status: 'invoiced' }, steps,
          packages: [pkg({ size: r.size || 'bag', description: r.description, pickup: spec.pickupAddr, pickupContact: { name: spec.collection.contactName, phone: spec.collection.contactPhone }, dropoff: r.to, recipient: { name: r.name, phone: r.phone } })],
          stops: spec.collectedMin != null ? [pickDone('collected')].concat(r.done != null ? [dropDone('delivered', r.name)] : []) : [] });
        if (r.driver) { o.events.push(ev('assigned', 'Assigned to ' + drvName(r.driver) + ' for ' + MDM.geo.zoneLabel(r.to.zone), t(spec.collectedMin - 5), staffBy.fayaz)); o.events.sort((a, b) => a.at < b.at ? -1 : 1); }
        b.orderIds.push(o.id);
      });
      batches.push(b);
    }
    batch({ id: 'blk_seed_1001', code: 'BLK-1001', account: 'bacc_kandu', name: 'Kandu Books & Stationery', customer: kandu, source: 'csv', status: 'out_for_delivery', createdMin: 240, collectedMin: 150, updatedMin: 30,
      notes: 'Term 3 textbook orders', pickupAddr: A.kandu, collection: { address: A.kandu.address, zone: 'male', landmark: '', contactName: 'Ahmed Shafeeu', contactPhone: '7801122', instructions: 'Ask for the dispatch shelf' },
      rows: [
        { code: 'MDM-1057', name: 'Aishath Nadha', phone: '7720001', to: A.amin, description: 'Grade 7 textbook set', reference: 'KB-2301', driver: 'drv_nazim', out: 100, done: 60 },
        { code: 'MDM-1058', name: 'Ibrahim Shareef', phone: '7720002', to: A.rehendhi, description: 'Grade 9 textbook set', reference: 'KB-2302', driver: 'drv_nazim', out: 100 },
        { code: 'MDM-1059', name: 'Mariyam Sama', phone: '7720003', to: A.hiyaa5, description: 'Grade 5 workbooks', reference: 'KB-2303', driver: 'drv_faisal', out: 90, done: 45 },
        { code: 'MDM-1060', name: 'Ahmed Rizwan', phone: '7720004', to: A.vinares, description: 'A-Level biology', reference: 'KB-2304', driver: 'drv_faisal', out: 90 },
        { code: 'MDM-1061', name: 'Fathimath Hana', phone: '7720005', to: A.ranfaru, description: 'Grade 3 stationery pack', reference: 'KB-2305', driver: 'drv_shiyam', out: 120, done: 95 },
        { code: 'MDM-1062', name: 'Hassan Nimal', phone: '7720006', to: A.villi, description: 'Grade 10 textbook set', reference: 'KB-2306', size: 'box', driver: 'drv_rasheed' },
      ] });
    batch({ id: 'blk_seed_1002', code: 'BLK-1002', account: 'bacc_fonu', name: 'Fonu Online Store', customer: fonu, source: 'portal', status: 'confirmed', createdMin: 35,
      notes: 'Evening drop', pickupAddr: A.fonu, collection: { address: A.fonu.address, zone: 'hulhumale_p1', landmark: 'Next to the Hulhumalé bus stop', contactName: 'Shaheem Ali', contactPhone: '7633221', instructions: 'Packages ready after 4 pm' },
      rows: [
        { code: 'MDM-1063', name: 'Aminath Raya', phone: '7730001', to: A.hiyaa5, description: 'Abaya (size M)', reference: 'FN-8801' },
        { code: 'MDM-1064', name: 'Mohamed Ahsan', phone: '7730002', to: A.kaneeru, description: 'Sneakers', reference: 'FN-8802', size: 'box' },
        { code: 'MDM-1065', name: 'Hawwa Shiza', phone: '7730003', to: A.dhonveli, description: 'Handbag', reference: 'FN-8803' },
        { code: 'MDM-1066', name: 'Ali Ahusan', phone: '7730004', to: A.vinares, description: 'Perfume set', reference: 'FN-8804' },
      ] });
    // Batch child orders that have only one stop done keep the full route so the map can draw them.
    orders.filter(o => o.batchId === 'blk_seed_1001' && o.status === 'out_for_delivery').forEach(o => { o.route.polyline = MDM.geo.routeThrough(o.route.stops); });

    // Keep business orders in this calendar month so the invoice is not empty: pull any that fell into last month forward.
    const monthKey = NOW.toISOString().slice(0, 7);
    orders.filter(o => o.service === 'business' && o.status === 'delivered').forEach(o => {
      const d = (o.events.filter(e => e.type === 'delivered').pop() || {}).at || o.updatedAt;
      if (d.slice(0, 7) !== monthKey) { const shift = new Date(NOW.getTime() - 20 * 60000).toISOString(); o.events.forEach(e => { e.at = shift; }); o.statusHistory.forEach(h => { h.at = shift; }); o.updatedAt = shift; o.createdAt = shift; o.route.stops.forEach(s => { s.at = shift; }); }
    });

    // ---- customers ------------------------------------------------------------------------------------------------------
    const customers = Object.values(C).map(c => {
      const mine = orders.filter(o => o.customerId === c.id);
      const last = mine.map(o => o.createdAt).sort().pop() || null;
      const addresses = [];
      mine.forEach(o => o.packages.forEach(p => { if (p.pickup && p.pickup.address && p.pickup.zone !== 'airport' && !addresses.some(a => a.address === p.pickup.address)) addresses.push({ label: addresses.length ? 'Address ' + (addresses.length + 1) : 'Home', address: p.pickup.address, zone: p.pickup.zone, meetAt: 'door' }); }));
      return { id: c.id, name: c.name, phone: c.phone, email: c.email, notify: c.notify, addresses: addresses.slice(0, 2), createdAt: t(days(45)), updatedAt: last || t(days(45)), lastOrderAt: last, orderCount: mine.length };
    });

    // ---- business ------------------------------------------------------------------------------------------------------
    const business_accounts = [
      { id: 'bacc_kandu', name: 'Kandu Books & Stationery', contactName: 'Ahmed Shafeeu', phone: '7801122', landline: '3321122', email: 'orders@kandubooks.example', tin: '1092231GST001', zone: 'male', pickupAddress: A.kandu.address, pickupWindow: 'afternoon', ratePerPackage: 25, priorityAllowed: true, status: 'approved', approvedAt: t(days(40)), createdAt: t(days(42)), updatedAt: t(days(40)) },
      { id: 'bacc_fonu', name: 'Fonu Online Store', contactName: 'Shaheem Ali', phone: '7633221', landline: '', email: 'hello@fonu.example', tin: '', zone: 'hulhumale_p1', pickupAddress: A.fonu.address, pickupWindow: 'evening', ratePerPackage: 25, priorityAllowed: true, status: 'approved', approvedAt: t(days(12)), createdAt: t(days(14)), updatedAt: t(days(12)) },
    ];
    const business_requests = [
      { id: 'breq_shifa', name: "Shifa's Cakes", contactName: 'Shifa Ibrahim', phone: '7556677', landline: '', email: 'shifa.cakes@example.com', zone: 'hulhumale_p1', pickupAddress: 'Rehendhi Flat 2, Apt 108', pickupWindow: 'afternoon', volume: '11-30', notes: 'Home baker, mostly cake boxes to Phase 1 and 2. Fragile.', status: 'pending', createdAt: t(days(1, 2)), updatedAt: t(days(1, 2)) },
      { id: 'breq_kandu', name: 'Kandu Books & Stationery', contactName: 'Ahmed Shafeeu', phone: '7801122', landline: '3321122', email: 'orders@kandubooks.example', zone: 'male', pickupAddress: A.kandu.address, pickupWindow: 'afternoon', volume: '11-30', notes: 'School textbook season is busiest.', status: 'approved', createdAt: t(days(42)), updatedAt: t(days(40)) },
    ];
    const invLines = [];
    orders.filter(o => o.accountId === 'bacc_kandu' && o.status === 'delivered').forEach(o => {
      const at = (o.events.filter(e => e.type === 'delivered').pop() || {}).at || o.updatedAt;
      o.packages.forEach(p => invLines.push({ date: at, orderCode: o.code, recipient: p.dropoff.recipient ? p.dropoff.recipient.name : '', description: p.description, packages: 1, rate: p.price.lineTotal, amount: p.price.lineTotal }));
    });
    const subtotal = invLines.reduce((n, l) => n + l.amount, 0);
    const invoices = [{ id: 'inv_seed_01', accountId: 'bacc_kandu', month: monthKey, number: 'INV-' + monthKey + '-001', lines: invLines, subtotal, gstPercent: 0, gst: 0, total: subtotal, status: 'draft', issuedAt: t(0), dueAt: new Date(NOW.getTime() + 14 * 86400000).toISOString(), paidAt: null, reference: '', createdAt: t(0), updatedAt: t(0) }];

    // ---- zones and airport service areas (How it works §3; requirements §16) -----------------------------------------------
    const zoneDrivers = { male: ['drv_shiyam', 'drv_rasheed'], hulhumale_p1: ['drv_nazim', 'drv_hamid'], hulhumale_p2: ['drv_faisal'], airport: ['drv_nazim'], villimale: ['drv_rasheed'] };
    const zones = MDM.geo.ZONE_LIST.map(z => ({ id: 'zon_' + z.key, key: z.key, name: z.label, short: z.short, island: z.island, center: z.center, radius: z.radius, airport: !!z.airport, active: true,
      quoteOnly: !!z.quote, driverIds: zoneDrivers[z.key] || [],
      areas: z.airport ? MDM.geo.airportPoints().map(p => ({ value: p.value, label: p.label, services: p.value === 'cargo' ? ['collect', 'deliver'] : p.value === 'baggage' ? ['baggage'] : ['collect', 'deliver', 'baggage'] })) : [],
      notes: z.ferry ? 'Ferry leg, price confirmed before collection' : z.airport ? 'Airport fee applies instead of the across-the-bridge rate' : '', createdAt: t(days(60)), updatedAt: t(days(3)) }));

    // ---- HR: attendance for the last week and leave requests -------------------------------------------------------------
    const attendance = [];
    const shiftOf = { stf_admin: [8, 0, 17, 10], stf_fayaz: [8, 5, 17, 0], stf_lamya: [9, 0, 18, 0], stf_nazim: [8, 2, 17, 30], stf_shiyam: [7, 58, 17, 5], stf_rasheed: [8, 20, 18, 10], stf_faisal: [8, 0, 16, 55], stf_hamid: [8, 0, 17, 0] };
    for (let d = 6; d >= 0; d--) {
      const base = new Date(NOW); base.setDate(base.getDate() - d);
      if (base.getDay() === 5 && d !== 0) continue;   // Friday off, except when today is Friday
      staff.forEach((s, i) => {
        const sh = shiftOf[s.id]; if (!sh) return;
        if (s.id === 'stf_hamid' && d <= 1) return;     // on leave
        const jitter = (hash(s.id + d) % 7);
        const inAt = new Date(base); inAt.setHours(sh[0], sh[1] + jitter, 0, 0);
        const outAt = new Date(base); outAt.setHours(sh[2], sh[3] + (jitter % 4), 0, 0);
        const today = d === 0;
        // Today everyone on shift is punched in whatever the hour the demo opens (an early-morning visit would show an empty board).
        if (today && inAt > NOW) { const midnight = new Date(NOW); midnight.setHours(0, 0, 0, 0); inAt.setTime(Math.max(midnight.getTime(), NOW.getTime() - (90 + jitter * 5) * 60000)); }
        if (inAt > NOW) return;
        attendance.push({ id: 'att_' + s.id.slice(4) + '_' + d, staffId: s.id, date: dateOnly(d * 1440), inAt: inAt.toISOString(), outAt: today || outAt > NOW ? null : outAt.toISOString(), source: s.role === 'driver' ? 'driver app' : 'portal', note: '', createdAt: inAt.toISOString(), updatedAt: inAt.toISOString() });
      });
    }
    const leaves = [
      { id: 'lv_seed_1', staffId: 'stf_hamid', type: 'sick', from: dateOnly(days(1)), to: dateOnly(-days(1)), days: 3, reason: 'Fever, medical certificate attached', status: 'approved', decidedBy: 'admin', decidedAt: t(days(1, 2)), remarks: 'Get well soon', createdAt: t(days(1, 4)), updatedAt: t(days(1, 2)) },
      { id: 'lv_seed_2', staffId: 'stf_shiyam', type: 'annual', from: dateOnly(-days(6)), to: dateOnly(-days(8)), days: 3, reason: 'Family trip to the island', status: 'pending', decidedBy: null, decidedAt: null, remarks: '', createdAt: t(180), updatedAt: t(180) },
      { id: 'lv_seed_3', staffId: 'stf_lamya', type: 'annual', from: dateOnly(-days(14)), to: dateOnly(-days(14)), days: 1, reason: 'Personal errand', status: 'pending', decidedBy: null, decidedAt: null, remarks: '', createdAt: t(60), updatedAt: t(60) },
      { id: 'lv_seed_4', staffId: 'stf_faisal', type: 'annual', from: dateOnly(days(10)), to: dateOnly(days(9)), days: 2, reason: 'Wedding', status: 'rejected', decidedBy: 'admin', decidedAt: t(days(12)), remarks: 'School season, please pick another week', createdAt: t(days(13)), updatedAt: t(days(12)) },
    ];

    // ---- positions -----------------------------------------------------------------------------------------------------
    const live = orders.find(o => o.code === 'MDM-1038');
    const onBridge = MDM.geo.pointAtDistance(live.route.polyline, MDM.geo.distanceKm(live.route.polyline) * 0.45) || { lat: 4.1729, lng: 73.5228, heading: 65 };
    const at1054 = orders.find(o => o.code === 'MDM-1054').route.stops[0];
    const r1050 = orders.find(o => o.code === 'MDM-1050').route.polyline;
    const p1050 = MDM.geo.pointAtDistance(r1050, MDM.geo.distanceKm(r1050) * 0.2) || { lat: 4.2280, lng: 73.5450, heading: 200 };
    const positions = [
      { id: 'drv_nazim', driverId: 'drv_nazim', lat: onBridge.lat, lng: onBridge.lng, heading: onBridge.heading, speed: 38, accuracy: 8, at: t(0.1), source: 'sim' },
      { id: 'drv_shiyam', driverId: 'drv_shiyam', lat: 4.1755, lng: 73.5102, heading: 90, speed: 12, accuracy: 12, at: t(0.5), source: 'sim' },
      { id: 'drv_rasheed', driverId: 'drv_rasheed', lat: at1054.lat, lng: at1054.lng, heading: 180, speed: 0, accuracy: 15, at: t(1), source: 'sim' },
      { id: 'drv_faisal', driverId: 'drv_faisal', lat: p1050.lat, lng: p1050.lng, heading: p1050.heading, speed: 22, accuracy: 10, at: t(0.3), source: 'sim' },
    ];
    positions.forEach(p => { p.createdAt = p.at; p.updatedAt = p.at; });

    // ---- audit log and notifications ---------------------------------------------------------------------------------------
    const events = [];
    const notifications = [];
    orders.forEach(o => o.events.forEach(e => {
      events.push({ id: e.id, orderId: o.id, code: o.code, at: e.at, type: e.type, label: e.label, by: e.by, visibility: e.visibility, createdAt: e.at, updatedAt: e.at });
      if (MDM.NOTIFY[e.type] && e.visibility !== 'internal') notifications.push({ id: 'ntf_' + e.id.slice(9), orderId: o.id, code: o.code, to: o.customer.phone, name: o.customer.name, channel: o.customer.notify || 'sms', event: e.type, title: MDM.NOTIFY[e.type], message: 'Mr. Delivery Man: ' + o.code + ' ' + MDM.NOTIFY[e.type].toLowerCase() + '. ' + e.label, status: 'sent', at: e.at, createdAt: e.at, updatedAt: e.at });
    }));
    [
      ['punch_in', 'Ahmed Nazim punched in', 'staff:stf_nazim', 600], ['leave_requested', 'Ibrahim Shiyam requested 3 days of leave', 'staff:stf_shiyam', 180],
      ['leave_approved', 'Approved leave for Abdulla Hamid', 'admin', days(1, 2)], ['settings_changed', 'Settings updated: rates', 'admin', days(3)],
      ['batch_created', 'Bulk order BLK-1001 with 6 packages', 'business:bacc_kandu', 240], ['batch_created', 'Bulk order BLK-1002 with 4 packages', 'business:bacc_fonu', 35],
      ['product_updated', 'Stock updated: Shipping label roll (0 left)', 'operator:stf_fayaz', days(2)],
    ].forEach((a, i) => events.push({ id: 'evt_audit_' + i, orderId: null, code: null, at: t(a[3]), type: a[0], label: a[1], by: a[2], visibility: 'internal', createdAt: t(a[3]), updatedAt: t(a[3]) }));
    events.sort((a, b) => a.at < b.at ? -1 : 1);
    notifications.sort((a, b) => a.at < b.at ? -1 : 1);

    return { settings, customers, drivers, staff, zones, attendance, leaves, products, notifications, batches, business_requests, business_accounts, invoices, orders, positions, events, files };
  }

  MDM.seed = { build };
  MDM.store._boot(build);
  // Admin-managed zones extend the built-in ones for every page (labels, new areas), and follow live edits.
  try { MDM.geo.registerZones(MDM.store._list('zones')); } catch (e) { /* zones are optional */ }
  MDM.store.subscribe('zones', () => { try { MDM.geo.registerZones(MDM.store._list('zones')); } catch (e) { /* same */ } });
})(window.MDM);

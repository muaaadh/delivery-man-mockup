// Request a delivery (web app updates 11/10/2026 §1 to §3): six steps in one form.
//   1 Service: "Order again" for a signed-in customer, the category (Pick & Deliver, Shop & Deliver, Business Delivery), the
//     Pick & Deliver collection type with its own fields, and normal / express / advance timing. Business Delivery shows a short
//     panel that points to the business portal instead of the form.
//   2 Collection (saved addresses or a new labelled one, contact) or, for Shop & Deliver, the shop (optional: we can choose it) and
//     the items table. No budget: our team calls to agree the items and their cost before buying (round 4, 26/10/2026).
//   3 Packages: Bag / Box / XL quantities with an optional photo per size (no measurements), the live estimate and Extra vehicle.
//   4 Delivery: home delivery, boat / ferry / speedboat, Maldivian Cargo or airport, each with the fields its handover needs.
//   5 Your details, 6 Review with the itemised estimate and when to pay, then one MDM.store.createOrder() call. The team confirms
//     the final price (after collection when there is no package photo).
// Updates 17/10/2026: a signed-in customer who has signed up skips step 5 (their account fills it); a guest ticks "I've read what we
// carry" in step 5; "Add another collection or shop" in step 2 collects or buys at more places, all packed together and delivered
// to the one delivery in step 4 (boats and Maldivian Cargo included).
// Round 4 (26/10/2026): packages are counted per stop (step 3) so the driver confirms what each stop hands over; every courier is
// listed on its own under Postal & courier (the office edits the list in Rates → Couriers).
// The draft lives in sessionStorage so a reload keeps it; uploaded photos and documents go into the `files` collection at once.
// Office mode (request/?office=1, updates 20/10/2026): the office enters a phone, WhatsApp, Viber or walk-in order through this same
// form, so the fields, rules and the createOrder payload match a customer order. Only an office session may open it. A bar above the
// form takes the customer's mobile (a known number acts like that customer signed in: saved addresses, "Order again"), the name and
// how the order came in; step 5 is always shown, for the operator; the draft has its own key; mdm:me is never written (it would sign
// the office browser in as the customer); `by` is the office user, and the new order opens in the office.
(function (MDM) { 'use strict';
  const { el, html, setError, phone } = MDM.ui;
  const OFFICE = new URLSearchParams(location.search).get('office') === '1';
  const OFFICE_ROLES = ['admin', 'operator', 'office'];
  // How an office order came in: the same values as the office's own New order (admin/orders.js SOURCES).
  const SOURCES = [{ value: 'phone', label: 'Phone' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'viber', label: 'Viber' }, { value: 'walkin', label: 'Walk-in' }];
  const DRAFT_KEY = OFFICE ? 'mdm:request:office:v3' : 'mdm:request:v3', ME_KEY = 'mdm:me';
  // Short card hints for this form; the shared lists keep their longer wording for the other pages.
  const CATEGORY_HINT = { pick: 'We collect it and deliver it', shop: 'We buy it and deliver it', business: 'Agreed rates for business accounts' };
  const TYPE_HINT = { home: 'From a home or office address', shop_collect: 'Already bought and paid for', postal: 'Redbox, Pikpost, post office, couriers', office: 'Documents at a government office' };
  const METHOD_HINT = { home: 'Malé, Hulhumalé or Villimalé', boat: 'To a vessel at the jetty', cargo: 'To another island by cargo', airport: 'Velana International Airport' };
  const CATEGORY_ICON = { pick: 'package', shop: 'shopping-bag', business: 'building' };
  const METHOD_ICON = { home: 'home', boat: 'ship', cargo: 'truck', airport: 'plane' };
  const SIZES = ['bag', 'box', 'xl'];
  const MAX_PER_SIZE = 20, MAX_ITEMS = 40;
  const MAXLEN = { text: '160', tel: '24', email: '120', textarea: '1000' };   // keeps a pasted essay out of labels and the driver's screen
  const NOTIFY = [{ value: 'whatsapp', label: 'WhatsApp' }, { value: 'sms', label: 'SMS' }, { value: 'viber', label: 'Viber' }, { value: 'email', label: 'Email' }];
  const SHOP_PROOF = [{ value: 'invoice', label: 'Invoice' }, { value: 'quotation', label: 'Quotation' }];
  const DOC_KIND = { collection_doc: 'Collection document', invoice: 'Shop invoice', quotation: 'Quotation', payment_slip: 'Payment slip', document: 'Document' };
  const CUSTOM_LABEL = 'custom';
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const trim = v => String(v == null ? '' : v).trim();
  const fmt = n => MDM.pricing.format(n);
  const normPhone = v => phone.normalize(v) || trim(v);
  const slug = v => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const dom = { steps: {} };
  let settings = {};
  let draft = emptyDraft();
  let step = 1, shownStep = 0;
  let me = null, profile = null, savedAddresses = [], reorderChoices = [], submitting = false;
  let checks = {};   // step → [{ wrap, check() → message|null, focus() }]

  // ---- Draft -----------------------------------------------------------------------------------------------------------------
  function blankItem() { return { name: '', details: '', qty: '1', instructions: '' }; }
  function blankPhoto() { return { photoId: null, photoName: '' }; }
  const blankCounts = () => ({ bag: 1, box: 0, xl: 0 });
  // id: the order's extraCollections id, made here so each package counted at the stop can point at it (package.collectionId).
  function blankExtra() { return { id: MDM.id('col'), kind: 'collect', address: '', zone: 'male', landmark: '', contactName: '', contactPhone: '', instructions: '', shopName: '', shopPhone: '', list: '', counts: blankCounts() }; }
  function emptyDraft() {
    return {
      category: 'pick', type: 'home', level: 'normal',
      schedule: { collectDate: '', collectTime: '', deliverDate: '', deliverTime: '' },
      details: { carrier: '', courierName: '', courierOther: '', courierAddress: '', courierZone: 'male', location: '', postOffice: '', collectionCode: '', collectBefore: '', trackingNo: '', ownerName: '', ownerContact: '', shippingAddress: '', idSent: false,
        shopName: '', shopAddress: '', shopZone: 'male', proof: 'invoice', orderNo: '', task: 'submit', organisation: '', reference: '', details: '', returnDocs: false },
      shop: { name: '', zone: 'male', phone: '' },
      items: [blankItem()],
      docs: [],
      collection: { address: '', zone: 'male', landmark: '', contactName: '', contactPhone: '', instructions: '', auto: false, autoContact: false, savedId: '', save: false, label: 'Home', labelCustom: '' },
      counts: { bag: 1, box: 0, xl: 0 }, photos: { bag: blankPhoto(), box: blankPhoto(), xl: blankPhoto() },
      description: '', fragile: false, extraVehicle: false,
      method: 'home',
      delivery: { address: '', zone: 'male', landmark: '', recipientName: '', recipientPhone: '', instructions: '', meetAt: 'door', self: false, savedId: '', save: false, label: 'Home', labelCustom: '' },
      boat: { vesselType: 'speedboat', name: '', departureDate: '', departureTime: '', jetty: '', island: '', address: '' },
      cargo: { island: '' },
      airport: { point: 'resort_counters', counter: '', resort: '', speedboat: '', departureTime: '', instructions: '' },
      customer: { name: '', phone: '', email: '', notify: 'whatsapp' },
      extra: [],
      pay: 'after', remember: true, termsAck: false, editDetails: false, reorderFrom: null, source: 'phone',
    };
  }
  function normalizeDraft(d) {
    if (!MDM.requestTypes().some(t => t.value === d.type)) d.type = 'home';
    if (!MDM.SERVICE_CATEGORIES.some(c => c.value === d.category)) d.category = MDM.categoryOf(d.type);
    if (d.category !== 'business' && MDM.categoryOf(d.type) !== d.category) d.type = MDM.requestTypes(d.category)[0].value;
    if (!MDM.DELIVERY_METHODS.some(m => m.value === d.method)) d.method = 'home';
    if (!MDM.VESSEL_TYPES.some(v => v.value === d.boat.vesselType)) d.boat.vesselType = 'speedboat';
    if (!MDM.geo.airportPoints().some(p => p.value === d.airport.point)) d.airport.point = 'resort_counters';
    if (!SHOP_PROOF.some(p => p.value === d.details.proof)) d.details.proof = 'invoice';
    return d;
  }
  function mergeDraft(d) {
    const base = emptyDraft();
    ['schedule', 'details', 'shop', 'collection', 'counts', 'delivery', 'boat', 'cargo', 'airport', 'customer'].forEach(k => { if (d[k] && typeof d[k] === 'object') Object.assign(base[k], d[k]); });
    SIZES.forEach(s => { base.photos[s] = Object.assign(blankPhoto(), (d.photos || {})[s] || {}); });
    ['category', 'type', 'level', 'description', 'fragile', 'extraVehicle', 'method', 'pay', 'remember', 'termsAck', 'editDetails', 'reorderFrom', 'source'].forEach(k => { if (d[k] != null) base[k] = d[k]; });
    if (!SOURCES.some(s => s.value === base.source)) base.source = 'phone';
    base.extra = Array.isArray(d.extra) ? d.extra.slice(0, MDM.MAX_EXTRA_COLLECTIONS).map(x => { const b = blankExtra(); return Object.assign(b, x, { id: (x && x.id) || b.id, kind: x && x.kind === 'shop' ? 'shop' : 'collect', counts: Object.assign({ bag: 0, box: 0, xl: 0 }, (x && x.counts) || b.counts) }); }) : [];
    base.docs = Array.isArray(d.docs) ? d.docs : [];
    base.items = Array.isArray(d.items) && d.items.length ? d.items.map(it => Object.assign(blankItem(), it)) : [blankItem()];
    return normalizeDraft(base);
  }
  function loadDraft() {
    try { const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY)); if (d && typeof d === 'object') return mergeDraft(d); } catch (e) { /* no draft or unreadable */ }
    return emptyDraft();
  }
  function saveDraft() { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (e) { /* private mode: the form still works on this page view */ } }
  function clearDraft() { try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* nothing to clear */ } }
  // In the office, "me" is the customer found from the number in the office bar, never the browser's own sign-in.
  function loadMe() { if (OFFICE) return null; try { const m = JSON.parse(localStorage.getItem(ME_KEY)); return m && m.phone ? m : null; } catch (e) { return null; } }
  // officeSession() → the signed-in office user (admin, operator or office staff) or null.
  function officeSession() {
    const s = MDM.shell && MDM.shell.session ? MDM.shell.session() : null;
    return s && s.user && OFFICE_ROLES.indexOf(s.role || 'admin') >= 0 ? s : null;
  }
  // The actor on the order, formatted as admin/admin.js by(): 'admin', or 'operator:<staffId>' for everyone else in the office.
  function officeBy() { const s = officeSession() || {}; return !s.role || s.role === 'admin' ? 'admin' : 'operator:' + (s.staffId || s.user); }
  function getPath(path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), draft); }
  function setPath(path, v) { const keys = path.split('.'); const last = keys.pop(); const obj = keys.reduce((o, k) => o[k], draft); obj[last] = v; }

  // ---- Type rules ---------------------------------------------------------------------------------------------------------------
  const typeOf = () => MDM.REQUEST_TYPES.find(t => t.value === draft.type) || MDM.REQUEST_TYPES[0];
  const categoryInfo = () => MDM.SERVICE_CATEGORIES.find(c => c.value === draft.category) || MDM.SERVICE_CATEGORIES[0];
  const isShop = () => draft.category === 'shop';
  const isBusiness = () => draft.category === 'business';
  const service = () => (isShop() ? 'shop' : 'pick');
  const rates = () => settings.rates || {};
  const rules = () => settings.rules || {};
  // Fee wording follows the pricing rules: the cargo fee is charged per package unless rules.cargoFeePer is 'order'.
  const cargoFeeText = () => fmt(rates().cargo) + (rules().cargoFeePer === 'order' ? '' : ' a package');
  const airportFeeText = () => fmt(rates().airport) + (rules().airportFeePer === 'package' ? ' a package' : '');
  const carrier = () => MDM.CARRIERS.find(c => c.value === draft.details.carrier) || null;
  const couriers = () => MDM.couriers(settings);
  const otherCourier = () => draft.details.carrier === 'courier' && draft.details.courierName === MDM.OTHER_COURIER;
  // postalKeys() → the details fields the chosen carrier asks for; fields typed for another carrier stay in the draft (so switching
  // back keeps them) but never reach the review or the order. Every carrier asks for the tracking number (§1.1); the SMS collection
  // code and collect-before time are extra fields where the carrier sends them. 'Other courier' adds the courier's name and office.
  function postalKeys() {
    const d = draft.details, noCode = !trim(d.collectionCode);
    return ({
      redbox_maafannu: ['trackingNo', 'collectionCode', 'collectBefore'],
      redbox_main: ['trackingNo', 'ownerName', 'shippingAddress', 'ownerContact'],
      pikpost: ['location', 'trackingNo', 'collectionCode', 'collectBefore'],
      post_office: ['postOffice', 'trackingNo', 'collectionCode'].concat(noCode ? ['idSent', 'ownerName', 'ownerContact', 'shippingAddress'] : []),
      courier: ['courierName'].concat(otherCourier() ? ['courierOther', 'courierAddress', 'courierZone'] : [], ['trackingNo', 'ownerName', 'ownerContact']),
      dhl: ['trackingNo'],
    })[d.carrier] || [];
  }
  const STEP_LABEL = { 1: 'Service', 3: 'Packages', 4: 'Delivery', 5: OFFICE ? 'Customer' : 'Your details', 6: 'Review' };
  const stepLabel = n => (n === 2 ? (isShop() ? 'Shop and items' : 'Collection') : STEP_LABEL[n]);
  // A signed-in customer who has signed up (name, number and "what we carry" on the account) skips step 5: the account fills it in.
  // "Edit" on the review opens it again for this request. The office always sees step 5.
  const profileReady = () => !!(me && profile && trim(profile.name) && profile.termsAcceptedAt && phone.valid(profile.phone));
  const skipDetails = () => !OFFICE && profileReady() && !draft.editDetails && (draft.customer.notify !== 'email' || !!trim(draft.customer.email));
  const visibleSteps = () => (skipDetails() ? [1, 2, 3, 4, 6] : [1, 2, 3, 4, 5, 6]);
  const nextStep = n => visibleSteps().find(k => k > n) || n;
  const prevStep = n => visibleSteps().slice().reverse().find(k => k < n) || n;
  // Guests tick "I've read what we carry" when they place an order; customers ticked it when they signed up. In the office the
  // operator ticks it for a customer whose record has no tick yet.
  const needsTerms = () => (OFFICE ? !(profile && profile.termsAcceptedAt) : !(me && profile && profile.termsAcceptedAt));
  // The collection end that the type dictates (postal carrier or the shop / godown from step 1): { address, zone, contactName } or null.
  function dictatedCollection() {
    const d = draft.details;
    if (draft.type === 'postal' && carrier()) {
      const c = carrier();
      if (c.value === 'pikpost') { const loc = MDM.PIKPOST_LOCATIONS.find(x => x.value === d.location); return loc ? { address: 'Pikpost locker, ' + loc.label, zone: loc.zone, contactName: 'Pikpost' } : null; }
      if (c.value === 'post_office') { const po = MDM.POST_OFFICES.find(x => x.value === d.postOffice); return po ? { address: po.label, zone: po.zone, contactName: 'Post collections counter' } : null; }
      if (c.value === 'courier' && otherCourier()) return trim(d.courierAddress) ? { address: [trim(d.courierOther), trim(d.courierAddress)].filter(Boolean).join(', '), zone: d.courierZone || 'male', contactName: trim(d.courierOther) || 'Courier counter' } : null;
      if (c.value === 'courier') {
        const k = couriers().find(x => x.name === d.courierName);
        return d.courierName ? { address: k && k.address ? k.name + ', ' + k.address : d.courierName + ' office, Malé', zone: (k && k.zone) || 'male', contactName: d.courierName } : null;
      }
      return { address: c.address, zone: c.zone, contactName: c.label };
    }
    if (draft.type === 'shop_collect' && !isShop() && trim(d.shopAddress)) return { address: [trim(d.shopName), trim(d.shopAddress)].filter(Boolean).join(', '), zone: d.shopZone || 'male', contactName: trim(d.shopName) };
    return null;
  }
  // Fill (or release) the collection address that the type decides, keeping whatever the customer typed for the other types.
  function applyDictated() {
    const c = dictatedCollection(), col = draft.collection;
    if (c) {
      Object.assign(col, { address: c.address, zone: c.zone, auto: true, savedId: '', save: false });
      if (!trim(col.contactName) || col.autoContact) { col.contactName = c.contactName; col.autoContact = true; }
    } else if (col.auto) {
      Object.assign(col, { address: '', zone: 'male', landmark: '', auto: false });
      if (col.autoContact) { col.contactName = ''; col.autoContact = false; }
    }
    if (col.zone === 'airport') col.zone = 'male';
    if (draft.delivery.zone === 'airport') draft.delivery.zone = 'male';
  }
  function chooseCategory(v) {
    draft.category = v;
    if (v === 'shop') draft.type = 'shop_buy';
    else if (v === 'pick' && MDM.categoryOf(draft.type) !== 'pick') draft.type = 'home';
    applyDictated();
  }

  // ---- More collections (multi collection) ------------------------------------------------------------------------------------------
  const extraShops = () => draft.extra.filter(x => x.kind === 'shop');
  // Shopping is bought with the customer's money, so a shop anywhere on the order makes it paid upfront.
  const upfrontForced = () => isShop() || extraShops().length > 0;
  const shops = () => isShop() || extraShops().length > 0;
  // A stop counts once it says where to collect, or (a shop stop) what to buy; the shop itself may be left to us.
  const stopReady = x => (x.kind === 'shop' ? !!trim(x.list) : !!trim(x.address));
  // extraData() → order.extraCollections for the stops the customer added (store.createOrder cleans and caps them).
  function extraData() {
    return draft.extra.filter(stopReady).map(x => (x.kind === 'shop'
      ? { id: x.id, kind: 'shop', address: '', zone: x.zone || 'male', landmark: '', instructions: '', shop: { name: trim(x.shopName), phone: normPhone(x.shopPhone), list: trim(x.list), budget: 0, unavailable: 'call' } }
      : { id: x.id, kind: 'collect', address: trim(x.address), zone: x.zone || 'male', landmark: trim(x.landmark), contactName: trim(x.contactName), contactPhone: normPhone(x.contactPhone), instructions: trim(x.instructions) }));
  }
  // No package photo and nothing to buy first: we collect, and the team confirms the price from the driver's photo (store rule).
  const priceAfterCollection = () => !upfrontForced() && !SIZES.some(sz => draft.counts[sz] && draft.photos[sz].photoId);

  // ---- Delivery and packages -----------------------------------------------------------------------------------------------------
  // Packages are counted per stop (round 4): draft.counts for the first collection or the shop, draft.extra[i].counts for each extra stop.
  const countOf = c => SIZES.reduce((n, s) => n + (Number((c || {})[s]) || 0), 0);
  const allCounts = () => [draft.counts].concat(draft.extra.map(x => x.counts || {}));
  const totalCount = () => allCounts().reduce((n, c) => n + countOf(c), 0);
  const countsAsPackages = () => allCounts().flatMap(c => SIZES.flatMap(s => Array.from({ length: Math.max(0, Number(c[s]) || 0) }, () => ({ size: s }))));
  const vehicleEligible = () => MDM.extraVehicleEligible(countsAsPackages());
  function itemsSummary() {
    return draft.items.filter(it => trim(it.name)).map(it => trim(it.name) + (trim(it.details) ? ' ' + trim(it.details) : '') + ' ×' + (Math.max(1, Math.round(Number(it.qty) || 1))) + (trim(it.instructions) ? ' (' + trim(it.instructions) + ')' : '')).join(', ');
  }
  function pickupEnd() {
    if (isShop()) {
      const s = draft.shop, name = MDM.shopName({ name: s.name });
      return { address: name, zone: s.zone || 'male', landmark: '', instructions: '', contact: { name, phone: normPhone(s.phone) }, meetAt: '' };
    }
    const c = draft.collection, cust = draft.customer;
    return { address: trim(c.address), zone: c.zone || 'male', landmark: trim(c.landmark), instructions: trim(c.instructions), contact: { name: trim(c.contactName) || trim(cust.name), phone: normPhone(c.contactPhone) || normPhone(cust.phone) }, meetAt: '' };
  }
  // The pickup end of an extra stop, for the packages counted there.
  function stopEnd(x) {
    const cust = draft.customer;
    if (x.kind === 'shop') { const name = MDM.shopName({ name: x.shopName }); return { address: name, zone: x.zone || 'male', landmark: '', instructions: '', contact: { name, phone: normPhone(x.shopPhone) }, meetAt: '' }; }
    return { address: trim(x.address), zone: x.zone || 'male', landmark: trim(x.landmark), instructions: trim(x.instructions), contact: { name: trim(x.contactName) || trim(cust.name), phone: normPhone(x.contactPhone) || normPhone(cust.phone) }, meetAt: '' };
  }
  // deliveryData() → the order's delivery object for the chosen method (store.createOrder points the packages at its end).
  function deliveryData() {
    const d = draft.delivery, cust = draft.customer, m = draft.method;
    const self = m === 'home' && d.self;
    const recipientName = self ? trim(cust.name) : trim(d.recipientName);
    const recipientPhone = self ? normPhone(cust.phone) : normPhone(d.recipientPhone);
    const out = { method: m, address: '', zone: 'male', landmark: '', recipientName, recipientPhone, instructions: trim(d.instructions), meetAt: '', boat: null, cargo: null, airport: null };
    if (m === 'home') Object.assign(out, { address: trim(d.address), zone: d.zone || 'male', landmark: trim(d.landmark), meetAt: d.meetAt || 'door' });
    if (m === 'boat') {
      const b = draft.boat;
      out.boat = { vesselType: b.vesselType, name: trim(b.name), departureDate: b.departureDate, departureTime: b.departureTime, jetty: b.jetty, island: trim(b.island), address: trim(b.address), contact: recipientPhone };
      out.address = trim(b.address) ? trim(b.address) + ', ' + trim(b.island) : trim(b.island);
    }
    if (m === 'cargo') {
      out.cargo = { counter: MDM.geo.cargoCounter().label, island: trim(draft.cargo.island), consignee: recipientName };
      out.address = trim(draft.cargo.island);
    }
    if (m === 'airport') {
      const a = draft.airport;
      out.airport = { point: a.point, counter: trim(a.counter), resort: trim(a.resort), speedboat: trim(a.speedboat), departureTime: a.departureTime, instructions: trim(a.instructions) };
      out.instructions = trim(a.instructions);
      out.meetAt = a.point;
    }
    return out;
  }
  // buildPackages() → one package per counted item: the first collection's (or the shop's) first, then each extra stop's, which carry
  // collectionId so the route gives them to that stop. The Shop & Deliver shop and its list ride on the first package (no budget: the
  // cost is agreed on the confirmation call).
  function buildPackages(forPricing) {
    const dd = deliveryData();
    const dropoff = Object.assign({}, MDM.deliveryEndpoint(dd), { instructions: dd.instructions });
    const out = [];
    const push = (counts, pickup, o) => SIZES.forEach(size => {
      const n = Math.max(0, Math.min(MAX_PER_SIZE, Number(counts[size]) || 0));
      const ph = (o.photos && o.photos[size]) || {};
      for (let i = 0; i < n; i++) {
        const shop = o.main && isShop() && !out.length ? { name: trim(draft.shop.name), address: '', zone: draft.shop.zone || 'male', phone: normPhone(draft.shop.phone), list: itemsSummary(), budget: 0, unavailable: 'call', receiptTotal: null, receiptPhotoId: null } : null;
        out.push(Object.assign({ id: forPricing ? 'p' + out.length : MDM.id('pkg'), size, description: trim(draft.description), fragile: !!draft.fragile, needsVehicle: false, underOneFt: size !== 'xl',
          photoId: (o.main && !isShop() && ph.photoId) || null, sizeSource: o.main && !isShop() && ph.photoId ? 'customer' : 'estimate', pickup: clone(pickup), dropoff: clone(dropoff), shop, notes: '' }, o.collectionId ? { collectionId: o.collectionId } : null));
      }
    });
    push(draft.counts, pickupEnd(), { main: true, photos: draft.photos });
    draft.extra.filter(stopReady).forEach(x => push(x.counts || {}, stopEnd(x), { collectionId: x.id }));
    if (draft.extraVehicle && MDM.extraVehicleEligible(out)) out.forEach(p => { if (p.size === 'box' || p.size === 'xl') p.needsVehicle = true; });
    return out;
  }
  // priceModel() → { delivery, fees, total, xl, vehicle, shops } with ranges { min, max }, or null when there is no package yet.
  function priceModel() {
    if (!totalCount()) return null;
    const pk = buildPackages(true), svc = service(), stops = extraData();
    const q = MDM.pricing.quote({ service: svc, packages: pk, extraCollections: stops }, settings);
    const r = MDM.pricing.estimateRange(pk, settings, svc, stops);
    const extra = q.totals.fees + (q.totals.budget || 0);
    return { delivery: { min: r.min - extra, max: r.max - extra }, fees: q.feeLines, total: { min: r.min, max: r.max },
      xl: pk.some(p => p.size === 'xl'), vehicle: !!draft.extraVehicle && vehicleEligible(), shops: shops() };
  }
  function rangeText(r, xl) {
    if (!r) return 'Add a package';
    if (xl) return 'From ' + fmt(r.min);
    return r.min === r.max ? fmt(r.min) : fmt(r.min) + '–' + fmt(r.max).replace('MVR ', '');
  }
  const FEE_TEXT = {
    cargo: () => ({ label: 'Maldivian Cargo fee', sub: rules().cargoFeePer === 'order' ? null : cargoFeeText() }),
    airport: () => ({ label: 'Airport fee', sub: rules().airportFeePer === 'package' ? airportFeeText() : null }),
  };
  const pct = () => Number(rates().shoppingPct) || 0;
  // chargeLines(model, prefix) → .summary rows: delivery range, each fee as its own line, the items to buy, extra vehicle, estimated total.
  function chargeLines(model, prefix) {
    const pk = packagesText();
    if (!model) return [el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, 'Add a package to see the estimate'))];
    const line = (key, label, sub, amount, fee) => el('div', { class: ['summary__line', fee ? 'summary__line--fee' : null], 'data-testid': prefix + '-line-' + key },
      el('span', { class: 'summary__desc' }, label, sub ? el('span', { class: 'summary__sub' }, sub) : null), el('span', { class: 'summary__amount mono' }, amount));
    const rows = [line('delivery', 'Delivery', pk, rangeText(model.delivery, model.xl))];
    model.fees.forEach(f => {
      const t = FEE_TEXT[f.key] ? FEE_TEXT[f.key]() : null;
      const times = (/ × \d+$/.exec(f.label) || [''])[0];
      if (f.key !== 'shopping') rows.push(line(f.key, t ? t.label + times : f.label, t ? t.sub : f.reason, fmt(f.amount), true));
    });
    // Shopping: the items and the shopping fee are agreed on a call before we buy, so the estimate is the delivery part only.
    if (model.shops) rows.push(line('items', 'Items' + (pct() ? ' and ' + pct() + '% shopping fee' : ''), 'Agreed on a call before we buy', 'By phone', true));
    if (model.vehicle) rows.push(line('vehicle', 'Extra vehicle', null, 'Confirmed by our team', true));
    if (draft.method === 'cargo') rows.push(line('cargo-bill', 'Maldivian Cargo charges', 'Added after delivery, with their bill', 'As billed', true));
    rows.push(el('div', { class: 'summary__rule' }), el('div', { class: 'summary__total' }, el('span', null, model.shops ? 'Estimated delivery' : 'Estimated total'), el('span', { class: 'mono', 'data-testid': prefix + '-total' }, rangeText(model.total, model.xl))));
    return rows;
  }
  const countText = c => SIZES.filter(s => Number(c[s]) > 0).map(s => c[s] + ' × ' + MDM.pricing.sizeLabel(s)).join(', ');
  function packagesText() {
    const sum = { bag: 0, box: 0, xl: 0 };
    allCounts().forEach(c => SIZES.forEach(s => { sum[s] += Number(c[s]) || 0; }));
    return countText(sum) || 'No packages yet';
  }

  // ---- Field helpers -------------------------------------------------------------------------------------------------------------
  let uid = 0;
  function reg(n, wrap, check, focusEl) { (checks[n] = checks[n] || []).push({ wrap, check, focus: () => { const f = focusEl ? focusEl() : wrap.querySelector('input:not([type="file"]), select, textarea, button'); if (f) f.focus(); } }); }
  // F(n, path, label, { type, options, required, hint, placeholder, validate, intl, landline, rows, testid, onChange, attrs, readonly }) → .field bound to draft[path]
  function F(n, path, label, o) {
    o = o || {};
    const id = 'rq-' + path.replace(/\./g, '-') + '-' + (++uid);
    const type = o.type || 'text';
    const testid = o.testid || 'request-' + path.split('.').pop().replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    const value = getPath(path);
    let ctrl;
    if (type === 'select') {
      ctrl = el('select', { class: 'select', id, 'data-testid': testid }, o.placeholder ? el('option', { value: '' }, o.placeholder) : null, (o.options || []).map(x => el('option', { value: x.value }, x.label)));
      ctrl.value = value == null ? '' : value;
    } else if (type === 'textarea') {
      ctrl = el('textarea', { class: 'textarea', id, rows: o.rows || 3, maxlength: MAXLEN.textarea, placeholder: o.placeholder || null, 'data-testid': testid, value: value == null ? '' : value });
    } else {
      const attrs = Object.assign({ class: 'input', id, type: type === 'tel' ? 'tel' : type, placeholder: o.placeholder || null, 'data-testid': testid, value: value == null ? '' : value }, MAXLEN[type] ? { maxlength: MAXLEN[type] } : null, o.attrs || {});
      if (type === 'tel') { attrs.inputmode = 'tel'; attrs.autocomplete = attrs.autocomplete || 'tel'; }
      if (type === 'number') { attrs.inputmode = attrs.inputmode || 'numeric'; attrs.min = attrs.min || '0'; }
      ctrl = el('input', attrs);
    }
    const wrap = MDM.ui.field({ name: path, control: ctrl, label, hint: o.hint || null, optional: !o.required && !o.noOptional, class: o.fieldClass || null });
    ctrl.addEventListener(type === 'select' ? 'change' : 'input', () => {
      setPath(path, ctrl.value);
      if (wrap.classList.contains('is-invalid')) setError(wrap, null);
      if (o.onChange) o.onChange(ctrl.value);
      saveDraft(); updateSummary();
    });
    if (o.disabled) ctrl.disabled = true;
    reg(n, wrap, () => {
      const v = trim(getPath(path));
      if (o.required && !v) return o.requiredMessage || 'Fill in ' + label.toLowerCase();
      if (v && type === 'tel' && !phone.valid(v, { intl: !!o.intl, landline: !!o.landline })) return 'Enter a valid ' + (o.intl ? 'phone' : 'Maldivian mobile') + ' number';
      if (v && type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Enter a valid email address';
      if (v && type === 'number' && (isNaN(Number(v)) || Number(v) < (o.min != null ? o.min : 0))) return 'Enter a number' + (o.min ? ' of at least ' + o.min : '');
      return o.validate ? o.validate(v) : null;
    });
    return wrap;
  }
  // seg(n, path, label, options, { onChange, testid, hint, stack, required }) → segmented radio group bound to draft[path]
  function seg(n, path, label, options, o) {
    o = o || {};
    const name = 'rq-' + path.replace(/\./g, '-');
    const testid = o.testid || 'request-' + path.split('.').pop();
    const fs = el('fieldset', { class: ['segmented', o.stack ? 'segmented--stack' : null], 'data-testid': testid },
      options.map(opt => el('label', { class: 'segmented__option', 'data-testid': testid + '-' + opt.value, 'data-value': opt.value },
        el('input', { class: 'sr-only', type: 'radio', name, value: opt.value, checked: String(getPath(path)) === String(opt.value) }),
        el('span', null, opt.label, opt.hint ? el('small', null, opt.hint) : null))));
    fs.addEventListener('change', e => {
      if (!e.target || !e.target.checked) return;
      setPath(path, e.target.value); saveDraft();
      if (o.onChange) o.onChange(e.target.value); else updateSummary();
    });
    const wrap = MDM.ui.field({ name: path, control: fs, label, hint: o.hint || null });
    if (o.required) reg(n, wrap, () => (trim(getPath(path)) ? null : 'Choose one'), () => fs.querySelector('input'));
    return wrap;
  }
  function check(n, path, label, o) {
    o = o || {};
    const id = 'rq-' + path.replace(/\./g, '-') + '-' + (++uid);
    const input = el('input', { type: 'checkbox', id, checked: !!getPath(path), 'data-testid': o.testid || 'request-' + path.split('.').pop() });
    input.addEventListener('change', () => { setPath(path, input.checked); saveDraft(); updateSummary(); if (o.onChange) o.onChange(input.checked); const w = input.closest('.field'); if (w) setError(w, null); });
    const wrap = el('div', { class: ['field', o.fieldClass], 'data-field': path }, el('div', null, el('label', { class: 'checkbox', for: id }, input, el('span', null, label, o.hint ? el('span', { class: 'checkbox__hint' }, o.hint) : null))), el('div', { class: 'field__error', hidden: true }));
    if (o.required) reg(n, wrap, () => (getPath(path) ? null : o.requiredMessage || 'Tick the box to continue'), () => input);
    return wrap;
  }
  // cards(n, { name, label, options: [{ value, label, hint, meta, icon }], value, testid, onChange, cols }) → a radio group of large cards
  function cards(n, o) {
    const labelId = 'rq-' + o.name + '-label';
    const group = el('div', { class: ['request-cards', 'request-cards--' + (o.cols || 2)], role: 'radiogroup', 'aria-labelledby': labelId, 'data-testid': o.testid },
      o.options.map(opt => el('label', { class: ['request-card', o.value === opt.value ? 'is-selected' : null], 'data-testid': o.testid + '-' + opt.value },
        el('input', { class: 'sr-only', type: 'radio', name: 'rq-' + o.name, value: opt.value, checked: o.value === opt.value }),
        opt.icon ? el('span', { class: 'request-card__icon', 'aria-hidden': 'true' }, html(MDM.icon(opt.icon, 20))) : null,
        el('span', { class: 'request-card__label' }, opt.label),
        opt.hint ? el('span', { class: 'request-card__hint' }, opt.hint) : null,
        opt.meta ? el('span', { class: 'request-card__meta' }, opt.meta) : null)));
    group.addEventListener('change', e => { if (e.target && e.target.checked) o.onChange(e.target.value); });
    const wrap = el('div', { class: 'field', 'data-field': o.name }, el('span', { class: o.hideLabel ? 'field__label sr-only' : 'field__label', id: labelId }, o.label), group, el('div', { class: 'field__error', hidden: true }));
    if (o.check) reg(n, wrap, o.check, () => group.querySelector('input:checked') || group.querySelector('input'));
    return wrap;
  }
  const grid = (...kids) => el('div', { class: 'grid-2' }, kids);
  // rerender(n) rebuilds a step after a choice that changes its fields, keeping focus on the control that was used.
  function rerender(n) {
    const a = document.activeElement;
    const key = a && a.closest && a.closest('[data-testid]') ? a.closest('[data-testid]').getAttribute('data-testid') : null;
    const val = a && a.value;
    const sel = a && typeof a.selectionStart === 'number' && /^(text|tel|email|search)$/.test(a.type || '') ? [a.selectionStart, a.selectionEnd] : null;
    renderStep(n);
    if (key) {
      const again = dom.steps[n].querySelector('[data-testid="' + key + '"]');
      const target = again && (again.matches('input,select,textarea,button') ? again : again.querySelector('input[value="' + CSS.escape(val || '') + '"]') || again.querySelector('input:checked') || again.querySelector('input,select,textarea,button'));
      if (target) { target.focus({ preventScroll: true }); if (sel && target === again && target.setSelectionRange) { try { target.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } } }
    }
  }

  // ---- Uploads (documents and package photos) ------------------------------------------------------------------------------------
  async function prepareFile(file) {
    const type = String(file.type || '').toLowerCase(), name = file.name || 'file';
    if (file.size > 8 * 1024 * 1024) throw new Error('Choose a file under 8 MB.');
    if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
      if (file.size > 1.5 * 1024 * 1024) throw new Error('Choose a PDF under 1.5 MB, or upload a photo of it.');
      return { name, type: 'application/pdf', size: file.size, dataUrl: await MDM.ui.fileToDataUrl(file) };
    }
    if (!/^image\//.test(type) && !/\.(jpe?g|png|webp)$/i.test(name)) throw new Error('Upload a JPG, PNG or PDF.');
    let out;
    try { out = await MDM.ui.imageToJpeg(file, { maxEdge: 1400, quality: 0.8 }); } catch (e) { throw new Error('We could not read this image. Try a JPG or PNG.'); }
    return { name, type: 'image/jpeg', size: out.size, dataUrl: out.dataUrl };
  }
  async function storeFile(file, kind) {
    const p = await prepareFile(file);
    try { return await MDM.store.insert('files', Object.assign({ kind, orderId: null, at: new Date().toISOString() }, p)); }
    catch (e) { throw new Error(e && e.code === 'quota' ? 'This browser is out of storage for the demo. Try a smaller file.' : 'Could not save the file. Try again.'); }
  }
  // docField(n, kind, label, { required, multiple, hint }) → list of uploaded documents of that kind plus a picker
  function docField(n, kind, label, o) {
    o = o || {};
    const id = 'rq-doc-' + kind + '-' + (++uid);
    const listEl = el('div', { class: 'stack-2' });
    const input = el('input', { class: 'sr-only', type: 'file', id, accept: 'image/*,application/pdf', tabindex: '-1', multiple: !!o.multiple, 'aria-labelledby': id + '-label', 'data-testid': 'request-doc-' + kind });
    const btnText = el('span', null, o.multiple ? 'Add files' : 'Choose a file');
    const btn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'aria-describedby': id + '-label', 'data-testid': 'request-doc-' + kind + '-pick', on: { click: () => input.click() } }, html(MDM.icon('upload', 16)), btnText);
    const wrap = el('div', { class: 'field', 'data-field': 'doc-' + kind },
      el('span', { class: 'field__label', id: id + '-label' }, label, o.required ? null : el('span', { class: 'optional' }, ' (optional)')),
      el('div', { class: 'dropzone request-doc' }, listEl, el('div', { class: 'request-doc__pick' }, btn, el('span', { class: 'dropzone__hint' }, 'JPG, PNG or PDF, up to 8 MB'))), input,
      o.hint ? el('div', { class: 'field__hint' }, o.hint) : null, el('div', { class: 'field__error', hidden: true }));
    function paint() {
      const mine = draft.docs.filter(d => d.kind === kind);
      listEl.replaceChildren(...mine.map(d => el('div', { class: 'dropzone__preview', 'data-testid': 'request-doc-item' },
        el('div', { class: 'dropzone__thumb dropzone__thumb--pdf', 'aria-hidden': 'true' }, d.type === 'application/pdf' ? 'PDF' : 'IMG'),
        el('div', { class: 'dropzone__file' }, el('div', { class: 'dropzone__name' }, d.name), el('div', { class: 'dropzone__size' }, DOC_KIND[kind] || 'Document')),
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => { draft.docs = draft.docs.filter(x => x.fileId !== d.fileId); MDM.store.remove('files', d.fileId).catch(() => {}); saveDraft(); paint(); updateSummary(); } } }, 'Remove', el('span', { class: 'sr-only' }, ' ' + d.name)))));
      listEl.hidden = !mine.length;
      btnText.textContent = mine.length && !o.multiple ? 'Replace file' : (o.multiple ? 'Add files' : 'Choose a file');
    }
    input.addEventListener('change', async () => {
      const filesIn = Array.from(input.files || []);
      input.value = '';
      setError(wrap, null);
      for (const f of filesIn) {
        try {
          const row = await storeFile(f, 'document');
          if (!o.multiple) draft.docs.filter(x => x.kind === kind).forEach(x => MDM.store.remove('files', x.fileId).catch(() => {}));
          if (!o.multiple) draft.docs = draft.docs.filter(x => x.kind !== kind);
          draft.docs.push({ fileId: row.id, name: row.name, type: row.type, kind });
        } catch (e) { setError(wrap, e.message); }
      }
      saveDraft(); paint(); updateSummary();
    });
    paint();
    if (o.required) reg(n, wrap, () => (draft.docs.some(d => d.kind === kind) ? null : 'Upload the ' + (DOC_KIND[kind] || 'document').toLowerCase()), () => btn);
    return wrap;
  }
  function photoPicker(size) {
    const ph = draft.photos[size];
    const label = MDM.pricing.sizeLabel(size);
    const id = 'rq-photo-' + size;
    const input = el('input', { class: 'sr-only', type: 'file', id, accept: 'image/*', capture: 'environment', tabindex: '-1', 'aria-label': 'Photo of the ' + label + ' package', 'data-testid': 'request-photo-' + size });
    const box = el('div', { class: 'request-photo' });
    const err = el('div', { class: 'field__error', hidden: true });
    async function paint() {
      box.textContent = '';
      if (ph.photoId) {
        const f = await MDM.store.get('files', ph.photoId);
        box.append(el('div', { class: 'dropzone__preview', 'data-testid': 'request-photo-preview' },
          f && f.dataUrl ? el('img', { class: 'dropzone__thumb', src: f.dataUrl, alt: 'Photo of the ' + label + ' package' }) : null,
          el('div', { class: 'dropzone__file' }, el('div', { class: 'dropzone__name' }, ph.photoName || 'Package photo'), el('div', { class: 'dropzone__size' }, 'Our team checks it before confirming the price')),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => { MDM.store.remove('files', ph.photoId).catch(() => {}); ph.photoId = null; ph.photoName = ''; saveDraft(); paint(); updateSummary(); } } }, 'Remove', el('span', { class: 'sr-only' }, ' the ' + label + ' photo'))));
      } else {
        box.append(el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'request-photo-' + size + '-pick', on: { click: () => input.click() } }, html(MDM.icon('camera', 16)), 'Add a photo', el('span', { class: 'sr-only' }, ' of the ' + label + ' package')));
      }
    }
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0]; input.value = '';
      if (!f) return;
      err.hidden = true;
      try {
        const row = await storeFile(f, 'package');
        if (ph.photoId) MDM.store.remove('files', ph.photoId).catch(() => {});
        ph.photoId = row.id; ph.photoName = row.name; saveDraft(); paint(); updateSummary();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    });
    paint();
    return el('div', { class: 'field request-photo-field' }, el('span', { class: 'field__label' }, 'Package photo', el('span', { class: 'optional' }, ' (optional)')), box, input, err);
  }

  // ---- Saved addresses (§2.1) --------------------------------------------------------------------------------------------------
  const labelOf = meta => (meta.label === CUSTOM_LABEL ? trim(meta.labelCustom) : meta.label) || 'Other';
  const savedById = id => savedAddresses.find(a => a.id === id) || null;
  // A new address is typed when the customer has no saved ones or chose "Add a new address"; with saved ones and no choice yet,
  // only the cards show until one is picked.
  const isNewAddress = target => !savedAddresses.length || draft[target].savedId === 'new';
  function chooseSaved(target, id) {
    const t = draft[target];
    if (id === 'new') {
      if (t.savedId && t.savedId !== 'new') Object.assign(t, { address: '', zone: 'male', landmark: '' });
      t.savedId = 'new';
      return;
    }
    const a = savedById(id); if (!a) return;
    Object.assign(t, { savedId: a.id, address: a.address, zone: a.zone && a.zone !== 'airport' ? a.zone : 'male', landmark: a.landmark || '', save: false, auto: false });
    if (target === 'delivery') {
      if (a.meetAt) t.meetAt = a.meetAt;
      if (a.contactName && !trim(t.recipientName)) t.recipientName = a.contactName;
      if (a.contactPhone && !trim(t.recipientPhone)) t.recipientPhone = a.contactPhone;
    }
  }
  function savedPicker(n, target) {
    if (!savedAddresses.length) return null;
    const selected = draft[target].savedId === 'new' ? 'new' : (savedById(draft[target].savedId) ? draft[target].savedId : '');
    return cards(n, {
      name: 'saved-' + target, label: target === 'collection' ? 'Collect from' : 'Deliver to', testid: 'request-' + target + '-saved', value: selected, cols: 2,
      options: savedAddresses.map(a => ({ value: a.id, label: a.label || 'Saved address', hint: a.address, meta: [a.landmark, MDM.geo.zoneLabel(a.zone || 'male')].filter(Boolean).join(' · ') }))
        .concat([{ value: 'new', label: 'Add a new address', icon: 'plus' }]),
      onChange: v => { chooseSaved(target, v); saveDraft(); rerender(n); updateSummary(); },
      check: () => (selected ? null : 'Choose a saved address or add a new one'),
    });
  }
  function labelPicker(n, target) {
    const meta = draft[target];
    const options = MDM.ADDRESS_LABELS.map(l => ({ value: l, label: l })).concat([{ value: CUSTOM_LABEL, label: 'Custom label' }]);
    const name = 'rq-label-' + target;
    const fs = el('fieldset', { class: 'request-labels', 'data-testid': 'request-' + target + '-label' },
      options.map(opt => el('label', { class: 'chip request-label', 'data-testid': 'request-' + target + '-label-' + slug(opt.value) },
        el('input', { class: 'sr-only', type: 'radio', name, value: opt.value, checked: meta.label === opt.value }), el('span', null, opt.label))));
    fs.addEventListener('change', e => { if (!e.target || !e.target.checked) return; meta.label = e.target.value; saveDraft(); rerender(n); });
    const out = [MDM.ui.field({ name: target + '.label', control: fs, label: 'Label for this address' })];
    if (meta.label === CUSTOM_LABEL) out.push(F(n, target + '.labelCustom', 'Custom label', { required: true, placeholder: "For example Mum's home", testid: 'request-' + target + '-label-text', attrs: { maxlength: '40' } }));
    return out;
  }
  function saveControls(n, target) {
    const where = OFFICE || me ? null : 'Saved under your mobile number';
    const out = [check(n, target + '.save', OFFICE ? "Save to the customer's addresses" : 'Save to my addresses', { testid: 'request-' + target + '-save', hint: where, onChange: () => rerender(n) })];
    if (draft[target].save) out.push(...labelPicker(n, target));
    return el('div', { class: 'request-save' }, out);
  }
  function zoneOptions() { return MDM.geo.zoneOptions().filter(z => z.value !== 'airport'); }
  function addressFields(n, target, label) {
    return [F(n, target + '.address', label, { required: true, placeholder: 'House or building name, street', testid: 'request-' + target + '-address', attrs: { autocomplete: 'street-address' } }),
      grid(F(n, target + '.zone', 'Area', { type: 'select', required: true, options: zoneOptions(), testid: 'request-' + target + '-zone' }),
        F(n, target + '.landmark', 'Landmark', { placeholder: 'Near a shop, mosque or school', testid: 'request-' + target + '-landmark' })),
      saveControls(n, target)];
  }

  // ---- Re-order (§2.1) ---------------------------------------------------------------------------------------------------------
  const ORDERABLE = () => MDM.requestTypes().map(t => t.value).concat(['airport']);
  const REORDER_MAX = 3;   // cards in the "Order again" block, the most frequent order included
  // Only the customer's own pick & deliver / shop & deliver orders: business and e-store orders are booked elsewhere.
  const canReorder = o => !o.accountId && o.service !== 'business' && o.service !== 'store' && o.source !== 'store' && ORDERABLE().indexOf(o.requestType || 'home') >= 0;
  // "Your most frequent order": the rule (MDM.frequentRoute and its route key) lives in store.js, shared with account/page.js.
  const reorderType = MDM.reorderType, routeOf = MDM.reorderRoute, reorderKey = MDM.reorderKey, frequentRoute = MDM.frequentRoute, routeText = MDM.reorderRouteText;
  const frequentMeta = g => 'Placed ' + g.count + ' times, last on ' + MDM.ui.fmtDate(g.latest.createdAt, { dateOnly: true }) + ' (' + g.latest.code + ')';
  // The "Order again" cards: the most frequent order first, then the latest orders on other routes (one on the frequent route would
  // repeat that card), REORDER_MAX in all.
  async function loadReorderChoices() {
    if (!me) return [];
    const ph = normPhone(me.phone);
    const mine = (await MDM.store.list('orders')).filter(o => o.customer && normPhone(o.customer.phone) === ph && canReorder(o))
      .sort((a, b) => (String(b.createdAt) > String(a.createdAt) ? 1 : String(b.createdAt) < String(a.createdAt) ? -1 : 0));
    if (!mine.length) return [];
    const pkText = o => { const c = {}; (o.packages || []).forEach(p => { c[p.size] = (c[p.size] || 0) + 1; }); return SIZES.filter(s => c[s]).map(s => c[s] + ' × ' + MDM.pricing.sizeLabel(s)).join(', '); };
    const top = frequentRoute(mine);
    const out = top ? [{ key: 'frequent', order: top.latest, label: 'Your most frequent order', hint: routeText(top.latest), meta: frequentMeta(top) }] : [];
    mine.filter(o => !top || reorderKey(o) !== top.key).slice(0, REORDER_MAX - out.length).forEach(o => {
      const r = routeOf(o);
      out.push({ key: o.id, order: o, label: o.code + ' · ' + MDM.requestTypeLabel(reorderType(o)), hint: r.from + ' to ' + r.to, meta: MDM.ui.fmtDate(o.createdAt, { dateOnly: true }) + ' · ' + pkText(o) });
    });
    return out;
  }
  // reorderRefusal(order) → null when the signed-in customer may start a new request from this order, else the message to show.
  // Only the customer's own pick & deliver / shop & deliver orders qualify: a link with someone else's order code must not fill in
  // their addresses and receivers, and business or e-store orders are booked elsewhere.
  function reorderRefusal(o) {
    if (!o) return 'We could not find that order. Start a new request below.';
    if (!canReorder(o)) return 'That order cannot be repeated here. Start a new request below.';
    if (!me) return 'Sign in to order again from one of your orders. Start a new request below.';
    if (!o.customer || normPhone(o.customer.phone) !== normPhone(me.phone)) return 'We could not find that order in your orders. Start a new request below.';
    return null;
  }
  // draftFromOrder(order) → a new draft with the order's type, details, collection, packages and delivery (no codes, files or dates).
  function draftFromOrder(o) {
    const d = emptyDraft();
    const type = reorderType(o), det = o.details || {}, col = o.collection || {}, dl = o.delivery || {};
    const pk0 = (o.packages || [])[0] || {};
    d.type = type; d.category = MDM.categoryOf(type);
    const copy = keys => keys.forEach(k => { if (det[k] != null && det[k] !== '') d.details[k] = det[k]; });
    if (type === 'postal') {
      copy(['carrier', 'courierName', 'location', 'postOffice', 'ownerName', 'ownerContact', 'shippingAddress']);
      // A courier outside the list was saved under its own name: open it again as 'Other courier' with that name and office.
      if (det.carrier === 'courier' && det.courierName && !couriers().some(k => k.name === det.courierName)) Object.assign(d.details, { courierName: MDM.OTHER_COURIER, courierOther: det.courierName, courierAddress: det.courierAddress || '', courierZone: col.zone && col.zone !== 'airport' ? col.zone : 'male' });
    }
    if (type === 'office') copy(['task', 'organisation', 'reference', 'details', 'returnDocs']);
    if (type === 'shop_collect') {
      copy(['shopName', 'proof']);
      d.details.shopAddress = det.shopAddress || String(col.address || '').replace(new RegExp('^' + String(det.shopName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ',\\s*'), '');
      d.details.shopZone = det.shopZone || col.zone || 'male';
    }
    if (type === 'shop_buy') {
      const s = det.shop || pk0.shop || {};
      const ps = pk0.shop || {};
      Object.assign(d.shop, { name: s.name || '', zone: s.zone || ps.zone || 'male', phone: s.phone || ps.phone || '' });
      const items = Array.isArray(det.items) && det.items.length ? det.items : String(ps.list || det.list || '').split(/,|\n/).map(x => x.trim()).filter(Boolean).map(x => ({ name: x, details: '', qty: 1, instructions: '' }));
      d.items = items.length ? items.map(it => ({ name: it.name || '', details: it.details || '', qty: String(it.qty || 1), instructions: it.instructions || '' })) : [blankItem()];
    }
    // Older airport orders collected at the airport; the form no longer offers that, so the customer types a new collection address
    // (re-zoning the airport address as Malé would price and route it wrongly).
    const airportCollection = col.zone === 'airport';
    if (type !== 'shop_buy' && !airportCollection) {
      Object.assign(d.collection, { address: col.address || '', zone: col.zone || 'male', landmark: col.landmark || '', contactName: col.contactName || '', contactPhone: col.contactPhone || '', instructions: col.instructions || '' });
      const hit = savedAddresses.find(a => trim(a.address).toLowerCase() === trim(col.address).toLowerCase());
      d.collection.savedId = hit ? hit.id : (savedAddresses.length ? 'new' : '');
    } else if (type !== 'shop_buy') d.collection.savedId = savedAddresses.length ? 'new' : '';
    // Packages counted at an extra stop (collectionId) go back to that stop; older orders packed everything with the first collection.
    const stopIds = (o.extraCollections || []).map(c => c.id);
    const countAt = id => { const c = { bag: 0, box: 0, xl: 0 }; (o.packages || []).forEach(p => { if ((stopIds.indexOf(p.collectionId) >= 0 ? p.collectionId : null) === id && c[p.size] != null) c[p.size] = Math.min(MAX_PER_SIZE, c[p.size] + 1); }); return c; };
    d.counts = countAt(null);
    if (!totalCountOf(d.counts)) d.counts.bag = 1;
    d.description = pk0.description || '';
    d.fragile = (o.packages || []).some(p => p.fragile);
    d.extraVehicle = !!o.extraVehicle;
    d.method = MDM.DELIVERY_METHODS.some(m => m.value === dl.method) ? dl.method : 'home';
    // Orders from before delivery methods existed dropped at the airport as a "home" delivery in the airport zone: re-order them as an
    // Airport delivery at the same point, not as a Malé address.
    const legacyAirport = d.method === 'home' && (dl.zone === 'airport' || (pk0.dropoff && pk0.dropoff.zone === 'airport'));
    if (legacyAirport) {
      const point = MDM.geo.airportPoints().find(p => p.value === (dl.meetAt || (pk0.dropoff || {}).meetAt));
      d.method = 'airport';
      Object.assign(d.airport, { point: point ? point.value : 'resort_counters', instructions: dl.instructions || '' });
    }
    Object.assign(d.delivery, { recipientName: dl.recipientName || '', recipientPhone: dl.recipientPhone || '', instructions: dl.instructions || '' });
    if (d.method === 'home') {
      Object.assign(d.delivery, { address: dl.address || '', zone: dl.zone && dl.zone !== 'airport' ? dl.zone : 'male', landmark: dl.landmark || '', meetAt: MDM.geo.meetAtOptions().some(m => m.value === dl.meetAt) ? dl.meetAt : 'door' });
      const hit = savedAddresses.find(a => trim(a.address).toLowerCase() === trim(dl.address).toLowerCase());
      d.delivery.savedId = hit ? hit.id : (savedAddresses.length ? 'new' : '');
    }
    if (d.method === 'boat' && dl.boat) Object.assign(d.boat, { vesselType: dl.boat.vesselType || 'speedboat', name: dl.boat.name || '', departureDate: '', departureTime: dl.boat.departureTime || '', jetty: dl.boat.jetty || '', island: dl.boat.island || '', address: dl.boat.address || '' });
    if (d.method === 'cargo') d.cargo.island = (dl.cargo && dl.cargo.island) || dl.address || '';
    if (d.method === 'airport' && dl.airport) Object.assign(d.airport, { point: dl.airport.point || 'resort_counters', counter: dl.airport.counter || '', resort: dl.airport.resort || '', speedboat: dl.airport.speedboat || '', departureTime: dl.airport.departureTime || '', instructions: dl.airport.instructions || dl.instructions || '' });
    d.extra = (o.extraCollections || []).slice(0, MDM.MAX_EXTRA_COLLECTIONS).map(c => {
      const sh = c.shop || {};
      return Object.assign(blankExtra(), c.kind === 'shop'
        ? { kind: 'shop', zone: c.zone || 'male', shopName: sh.name || '', shopPhone: sh.phone || '', list: sh.list || '' }
        : { kind: 'collect', address: c.address || '', zone: c.zone || 'male', landmark: c.landmark || '', contactName: c.contactName || '', contactPhone: c.contactPhone || '', instructions: c.instructions || '' },
        { counts: totalCountOf(countAt(c.id)) ? countAt(c.id) : blankCounts() });
    });
    d.reorderFrom = { id: o.id, code: o.code };
    applyDictatedTo(d);
    return normalizeDraft(d);
  }
  const totalCountOf = c => SIZES.reduce((n, s) => n + (Number(c[s]) || 0), 0);
  function applyDictatedTo(d) { const keep = draft; draft = d; applyDictated(); draft = keep; }
  function startFrom(order, o) {
    const keep = { customer: draft.customer, pay: draft.pay, remember: draft.remember, termsAck: draft.termsAck, source: draft.source };
    draft = Object.assign(draftFromOrder(order), keep);
    saveDraft();
    if (!(o && o.silent)) MDM.ui.toast('Filled in from ' + order.code + '. Check each step.', 'ok');
    if (o && o.direct) setStep(6, { initial: true }); else go(6);
  }
  function renderNotice() {
    if (!dom.notice) return;
    const r = draft.reorderFrom;
    dom.notice.hidden = !r;
    if (!r) { dom.notice.replaceChildren(); return; }
    dom.notice.replaceChildren(MDM.ui.notice('info', 'Filled in from ' + r.code + '. Check each step.', {
      action: el('button', { type: 'button', class: 'btn btn--ghost btn--sm request-notice__reset', 'data-testid': 'request-start-over', on: { click: () => { const keep = { customer: draft.customer, pay: draft.pay, remember: draft.remember, termsAck: draft.termsAck, source: draft.source }; draft = Object.assign(emptyDraft(), keep); saveDraft(); go(1); renderNotice(); } } }, 'Start over'),
    }));
  }

  // ---- Steps -------------------------------------------------------------------------------------------------------------------------
  function head(n, title, desc) { return el('div', { class: 'section-head' }, el('h2', { id: 'request-step-' + n + '-title', tabindex: '-1' }, title), desc ? el('p', { class: 'section-head__desc' }, desc) : null); }
  function actions(o) {
    const back = step > 1 ? el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'request-back', on: { click: () => go(prevStep(step)) } }, 'Back') : null;
    const next = o && o.submit
      ? el('button', { type: 'submit', class: 'btn btn--brand', 'data-testid': 'request-submit' }, o.label)
      : el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'request-next', on: { click: advance } }, (o && o.label) || 'Continue');
    return el('div', { class: 'form-actions' }, back, next);
  }
  function group(title, ...kids) { return el('div', { class: 'request-group' }, title ? el('h3', { class: 'request-group__title' }, title) : null, kids); }
  const today = () => MDM.ui.dayKey(new Date());
  const nowTime = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // One list for every carrier (round 4): post and lockers, then each courier on its own (the office's list, then "Other courier").
  // A courier is saved as carrier 'courier' with its name in details.courierName, as before.
  function carrierField(n) {
    const d = draft.details;
    const pick = d.carrier === 'courier' ? 'courier:' + (d.courierName || '') : d.carrier || '';
    const opt = (value, label) => el('option', { value }, label);
    const ctrl = el('select', { class: 'select', id: 'rq-details-carrier-' + (++uid), 'data-testid': 'request-carrier' }, opt('', 'Choose one'),
      el('optgroup', { label: 'Post and lockers' }, MDM.CARRIERS.filter(c => c.group === 'post').map(c => opt(c.value, c.label))),
      el('optgroup', { label: 'Couriers' }, MDM.CARRIERS.filter(c => c.group === 'courier' && c.value !== 'courier').map(c => opt(c.value, c.label)),
        couriers().map(c => opt('courier:' + c.name, c.name)), opt('courier:' + MDM.OTHER_COURIER, MDM.OTHER_COURIER)));
    ctrl.value = pick;
    if (ctrl.value !== pick) ctrl.value = '';   // a courier the office has since taken off the list
    const wrap = MDM.ui.field({ name: 'details.carrier', control: ctrl, label: 'Carrier or collection point' });
    ctrl.addEventListener('change', () => {
      const v = ctrl.value, courier = v.indexOf('courier:') === 0;
      d.carrier = courier ? 'courier' : v; d.courierName = courier ? v.slice(8) : '';
      setError(wrap, null); applyDictated(); saveDraft(); rerender(n); updateSummary();
    });
    reg(n, wrap, () => (ctrl.value ? null : 'Choose where to collect from'));
    return wrap;
  }
  function typeFields(n) {
    const d = draft.details, t = draft.type;
    const out = [];
    const dictate = () => { applyDictated(); };
    if (t === 'postal') {
      out.push(carrierField(n));
      const c = d.carrier;
      const tracking = label => F(n, 'details.trackingNo', label || 'Tracking number', { required: true, testid: 'request-tracking-no' });
      if (c === 'redbox_maafannu') out.push(tracking(), grid(F(n, 'details.collectionCode', 'Collection code', { required: true, placeholder: 'From the Redbox SMS' }), F(n, 'details.collectBefore', 'Collect before', { type: 'datetime-local', required: true, hint: 'The time in the SMS' })));
      if (c === 'redbox_main') out.push(grid(tracking(), F(n, 'details.ownerName', 'Owner name', { required: true })), F(n, 'details.shippingAddress', 'Shipping address on the parcel', { required: true }), F(n, 'details.ownerContact', 'Owner contact number', { type: 'tel', required: true, intl: true }));
      if (c === 'pikpost') out.push(F(n, 'details.location', 'Pikpost location', { type: 'select', placeholder: 'Choose a location', required: true, options: MDM.PIKPOST_LOCATIONS, onChange: dictate }), tracking(), grid(F(n, 'details.collectionCode', 'Collection code', { required: true }), F(n, 'details.collectBefore', 'Collect before (SMS time)', { type: 'datetime-local', required: true })));
      if (c === 'post_office') {
        out.push(F(n, 'details.postOffice', 'Post office', { type: 'select', placeholder: 'Choose a post office', required: true, options: MDM.POST_OFFICES, onChange: dictate }), tracking(),
          F(n, 'details.collectionCode', 'Collection code', { hint: 'No code? Leave it empty and add the owner.', onChange:v => { if (!trim(v) !== !!dom.steps[n].querySelector('[data-testid="request-id-sent"]')) rerender(n); } }));
        if (!trim(d.collectionCode)) out.push(check(n, 'details.idSent', OFFICE ? 'The owner gives their ID details to the post collections contact' : 'I will give my ID details to the post collections contact', { required: true, testid: 'request-id-sent' }),
          grid(F(n, 'details.ownerName', 'Owner name', { required: true }), F(n, 'details.ownerContact', 'Owner contact number', { type: 'tel', required: true, intl: true })), F(n, 'details.shippingAddress', 'Shipping address on the parcel', { required: true }));
      }
      if (c === 'courier') {
        // A courier outside the list: its name and the office our driver collects from (that office becomes the collection address).
        if (otherCourier()) out.push(F(n, 'details.courierOther', 'Courier name', { required: true, placeholder: 'For example Island Express', testid: 'request-courier-other', onChange: dictate }),
          grid(F(n, 'details.courierAddress', 'Courier office address', { required: true, placeholder: 'Building name, street', testid: 'request-courier-address', onChange: dictate }),
            F(n, 'details.courierZone', 'Area', { type: 'select', required: true, options: zoneOptions(), testid: 'request-courier-zone', onChange: dictate })));
        out.push(grid(tracking(), F(n, 'details.ownerName', 'Owner name', { required: true })), F(n, 'details.ownerContact', 'Owner contact number', { type: 'tel', required: true, intl: true }));
      }
      if (c === 'dhl') out.push(tracking('Waybill or tracking number'), docField(n, 'collection_doc', 'DHL collection document', { required: true, hint: 'The authorisation DHL asks for' }));
    }
    if (t === 'shop_collect') {
      out.push(F(n, 'details.shopName', 'Shop or godown', { required: true, placeholder: 'For example Agora Mall, electronics counter', testid: 'request-shop-name', onChange: dictate }),
        grid(F(n, 'details.shopAddress', 'Shop or godown address', { required: true, placeholder: 'Building name, street', testid: 'request-shop-address', onChange: dictate }),
          F(n, 'details.shopZone', 'Area', { type: 'select', required: true, options: zoneOptions(), testid: 'request-shop-zone', onChange: dictate })),
        seg(n, 'details.proof', 'Proof from the shop', SHOP_PROOF, { testid: 'request-proof', onChange: () => { saveDraft(); rerender(n); updateSummary(); } }),
        d.proof === 'quotation' ? docField(n, 'quotation', 'Quotation', { required: true }) : docField(n, 'invoice', 'Invoice', { required: true }),
        docField(n, 'payment_slip', 'Payment slip', { required: true }),
        F(n, 'details.orderNo', 'Order number', { placeholder: 'If the shop gave you one', testid: 'request-order-no' }));
    }
    if (t === 'office') {
      out.push(grid(F(n, 'details.organisation', 'Office or ministry', { required: true, placeholder: 'For example Ministry of Economic Development', testid: 'request-organisation' }),
        F(n, 'details.task', 'What do you need?', { type: 'select', required: true, options: MDM.OFFICE_TASKS, testid: 'request-task' })),
        F(n, 'details.reference', 'Reference numbers', { placeholder: 'Application, file or token numbers', testid: 'request-reference' }),
        F(n, 'details.details', 'Details and instructions', { type: 'textarea', required: true, rows: 3, placeholder: 'What to submit or collect, who to ask for, what to bring back', testid: 'request-office-details' }),
        docField(n, 'document', 'Documents', { multiple: true, hint: 'Upload copies. We collect the originals.' }),
        check(n, 'details.returnDocs', OFFICE ? 'Bring the receipt or documents back' : 'Bring the receipt or documents back to me'));
    }
    return out;
  }
  function scheduleFields(n) {
    const out = [seg(n, 'level', 'When', MDM.SERVICE_LEVELS.map(l => ({ value: l.value, label: l.label })), { testid: 'request-level', onChange: () => { saveDraft(); rerender(n); updateSummary(); } })];
    if (draft.level === 'express') out.push(MDM.ui.notice('info', 'Express depends on availability. We confirm it with the price.'));
    if (draft.level === 'advance') {
      const later = () => { const s = draft.schedule; if (!s.collectDate || !s.deliverDate) return null; return (s.deliverDate + 'T' + (s.deliverTime || '00:00')) < (s.collectDate + 'T' + (s.collectTime || '00:00')) ? 'Delivery must be after collection' : null; };
      out.push(grid(F(n, 'schedule.collectDate', 'Collection date', { type: 'date', required: true, attrs: { min: today() }, validate: v => (v < today() ? 'Choose today or a later date' : null) }), F(n, 'schedule.collectTime', 'Collection time', { type: 'time', required: true })),
        grid(F(n, 'schedule.deliverDate', 'Delivery date', { type: 'date', required: true, attrs: { min: today() }, validate: later }), F(n, 'schedule.deliverTime', 'Delivery time', { type: 'time', required: true, validate: later })));
    }
    return out;
  }
  function reorderGroup(n) {
    if (!reorderChoices.length) return null;
    return el('div', { class: 'request-group request-group--first', 'data-testid': 'request-reorder' },
      el('h3', { class: 'request-group__title' }, 'Order again'),
      el('div', { class: 'request-cards request-again' }, reorderChoices.map(c => el('button', { type: 'button', class: 'request-card request-card--button', 'data-testid': 'request-reorder-' + c.key, on: { click: () => startFrom(c.order) } },
        el('span', { class: 'request-card__label' }, c.label), el('span', { class: 'request-card__hint' }, c.hint), el('span', { class: 'request-card__meta' }, c.meta)))));
  }
  // The business order drawer in the office (admin/orders.js opens it from ?new=business).
  const OFFICE_BUSINESS_HREF = () => MDM.href('admin/#/orders?new=business');
  function businessPanel() {
    if (OFFICE) {
      return el('div', { class: 'request-business card', 'data-testid': 'request-business' },
        el('div', { class: 'card__body stack-4' },
          el('div', null, el('h3', { class: 'request-group__title' }, 'Business account orders'),
            el('p', { class: 'request-group__desc' }, 'Booked at the account\'s agreed rates, from its collection point.')),
          el('div', { class: 'request-business__actions' },
            el('a', { class: 'btn btn--primary', href: OFFICE_BUSINESS_HREF(), 'data-testid': 'request-business-office' }, 'Open business order'))));
    }
    const tiers = MDM.pricing.businessTiers(settings);
    return el('div', { class: 'request-business card', 'data-testid': 'request-business' },
      el('div', { class: 'card__body stack-4' },
        el('div', null, el('h3', { class: 'request-group__title' }, 'Booked in the business portal'),
          el('p', { class: 'request-group__desc' }, 'Agreed rates per package size, bulk orders, cash on delivery and one weekly invoice.')),
        el('div', { class: 'rate-table', 'data-testid': 'request-business-tiers', 'aria-label': 'Business starting rates by package size' },
          tiers.map(t => MDM.ui.rateRow(t.label + ' (' + MDM.pricing.sizeLabel(t.size) + ')', 'from ' + fmt(t.rate), { mono: true }))),
        el('p', { class: 'small muted' }, 'Starting rates. Each business agrees its own.'),
        el('div', { class: 'request-business__actions' },
          el('a', { class: 'btn btn--brand', href: MDM.href('business/'), 'data-testid': 'request-business-portal' }, 'Open the business portal'),
          el('a', { class: 'btn btn--secondary', href: MDM.href('login/?as=business'), 'data-testid': 'request-business-signin' }, 'Business sign-in'))));
  }
  function step1(n) {
    const out = [head(n, 'What do you need?'), reorderGroup(n)];
    out.push(cards(n, {
      name: 'category', label: 'Service', hideLabel: true, testid: 'request-category', value: draft.category, cols: 3,
      options: MDM.SERVICE_CATEGORIES.map(c => ({ value: c.value, label: c.label, hint: CATEGORY_HINT[c.value] || null, icon: CATEGORY_ICON[c.value] })),
      onChange: v => { chooseCategory(v); saveDraft(); rerender(n); renderStepper(); updateSummary(); },
      check: () => (isBusiness() ? (OFFICE ? 'Use Open business order for a business account' : 'Business deliveries are booked in the business portal') : null),
    }));
    if (isBusiness()) { out.push(businessPanel()); return out; }
    if (draft.category === 'pick') {
      out.push(cards(n, {
        name: 'type', label: 'What do we collect?', testid: 'request-type', value: draft.type, cols: 2,
        options: MDM.requestTypes('pick').map(t => ({ value: t.value, label: t.label, hint: TYPE_HINT[t.value] || null })),
        onChange: v => { draft.type = v; applyDictated(); saveDraft(); rerender(n); updateSummary(); },
      }));
    }
    const extra = typeFields(n);
    if (extra.length) out.push(group(typeOf().label, extra));
    out.push(group(null, scheduleFields(n)), actions());
    return out;
  }
  function step2(n) {
    if (isShop()) return shopStep(n);
    applyDictated();
    const locked = !!dictatedCollection();
    const t = draft.type;
    const title = t === 'shop_collect' ? 'Collect from the shop or godown' : t === 'postal' ? 'Collect from the carrier' : t === 'office' ? 'Where do we collect the documents?' : 'Where do we collect from?';
    const desc = locked ? 'Filled in from step 1.' : null;
    const out = [head(n, title, desc)];
    if (locked) {
      out.push(F(n, 'collection.address', 'Collection address', { required: true, testid: 'request-collection-address', attrs: { readonly: true } }),
        grid(F(n, 'collection.zone', 'Area', { type: 'select', required: true, disabled: true, options: zoneOptions(), testid: 'request-collection-zone' }),
          F(n, 'collection.landmark', 'Landmark', { placeholder: 'Floor, counter or gate', testid: 'request-collection-landmark' })));
    } else {
      out.push(savedPicker(n, 'collection'));
      if (isNewAddress('collection')) out.push(...addressFields(n, 'collection', 'Collection address'));
    }
    const contactRequired = t === 'home' || t === 'office';
    out.push(grid(F(n, 'collection.contactName', t === 'shop_collect' ? 'Shop contact' : 'Contact person', { required: contactRequired, placeholder: 'Who hands it over', onChange: () => { draft.collection.autoContact = false; } }),
        F(n, 'collection.contactPhone', 'Contact number', { type: 'tel', intl: true, landline: t !== 'home', required: contactRequired })),
      F(n, 'collection.instructions', 'Instructions for the driver', { type: 'textarea', rows: 2, placeholder: 'Floor, gate, best time to call' }),
      extraGroup(n),
      actions());
    return out;
  }
  const blankItem_ = it => !it || (!trim(it.name) && !trim(it.details) && !trim(it.instructions));
  function itemsEditor(n) {
    const rows = draft.items.map((it, i) => {
      const p = 'items.' + i + '.';
      return el('div', { class: 'request-item', 'data-testid': 'request-item' },
        el('div', { class: 'request-item__num', 'aria-hidden': 'true' }, 'Item ' + (i + 1)),
        F(n, p + 'name', 'Item', { noOptional: true, placeholder: 'For example a phone case', testid: 'request-item-name', fieldClass: 'request-item__name',
          // An untouched extra row (no name, details or instructions) is skipped instead of blocking the step.
          validate: v => (v || (blankItem_(draft.items[i]) && draft.items.some(x => trim(x.name))) ? null : 'Name the item') }),
        F(n, p + 'details', 'Details', { noOptional: true, placeholder: 'Brand, size or colour', testid: 'request-item-details', fieldClass: 'request-item__details' }),
        F(n, p + 'qty', 'Quantity', { type: 'number', required: true, min: 1, testid: 'request-item-qty', attrs: { min: '1', max: '999', step: '1' }, validate: v => (Number.isInteger(Number(v)) && Number(v) <= 999 ? null : 'Enter a whole number up to 999'), fieldClass: 'request-item__qty' }),
        F(n, p + 'instructions', 'Special instructions', { noOptional: true, placeholder: 'Anything to check', testid: 'request-item-instructions', fieldClass: 'request-item__notes' }),
        el('div', { class: 'request-item__remove' }, el('button', { type: 'button', class: 'btn btn--ghost btn--icon', 'aria-label': 'Remove item ' + (i + 1), 'data-testid': 'request-item-remove', disabled: draft.items.length < 2,
          on: { click: () => { draft.items.splice(i, 1); saveDraft(); renderStep(n); updateSummary(); const b = dom.steps[n].querySelector('[data-testid="request-item-add"]'); if (b) b.focus({ preventScroll: true }); } } }, html(MDM.icon('trash', 16)))));
    });
    const addBtn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'request-item-add', disabled: draft.items.length >= MAX_ITEMS,
      on: { click: () => { draft.items.push(blankItem()); saveDraft(); renderStep(n); updateSummary(); const all = dom.steps[n].querySelectorAll('[data-testid="request-item-name"]'); if (all.length) all[all.length - 1].focus(); } } }, html(MDM.icon('plus', 16)), 'Add an item');
    const wrap = el('div', { class: 'field request-items-field', 'data-field': 'items' },
      el('div', { class: 'request-items__head', 'aria-hidden': 'true' }, el('span', null, 'Item'), el('span', null, 'Details'), el('span', null, 'Quantity'), el('span', null, 'Special instructions'), el('span', null, '')),
      el('div', { class: 'request-items', 'data-testid': 'request-items' }, rows), el('div', { class: 'request-items__add' }, addBtn), el('div', { class: 'field__error', hidden: true }));
    reg(n, wrap, () => (draft.items.some(it => trim(it.name)) ? null : 'Add at least one item'));
    return wrap;
  }
  function shopStep(n) {
    return [head(n, 'Shop and items'),
      group('Shop or supplier',
        F(n, 'shop.name', 'Shop or supplier name', { placeholder: 'For example a phone shop', hint: 'Leave it empty and we choose the shop', testid: 'request-shop-name' }),
        grid(F(n, 'shop.zone', 'Area', { type: 'select', required: true, options: zoneOptions(), testid: 'request-shop-zone' }),
          F(n, 'shop.phone', 'Shop phone', { type: 'tel', intl: true, landline: true, testid: 'request-shop-phone' }))),
      group('Items to buy', itemsEditor(n)),
      // No budget (client, 25/10/2026): our team calls the customer to agree the items and the price before buying.
      MDM.ui.notice('info', OFFICE ? 'Call the customer to confirm the items and the price before buying. Paid upfront once confirmed.'
        : 'We call you to confirm the items and the price before we buy. You pay upfront once it is confirmed.', { testid: 'request-shop-note' }),
      extraGroup(n),
      actions()];
  }
  // "Add a stop" (updates 17/10/2026): each extra stop collects at an address or buys at a shop; everything is delivered once, by
  // whichever method step 4 sets (home, boat, Maldivian Cargo or airport). Its packages are counted in step 3.
  function extraCard(n, x, i) {
    const p = 'extra.' + i + '.', tid = k => 'request-extra-' + k + '-' + i;
    const zone = () => F(n, p + 'zone', 'Area', { type: 'select', required: true, options: zoneOptions(), testid: tid('zone') });
    const fields = x.kind === 'shop'
      ? [grid(F(n, p + 'shopName', 'Shop name', { placeholder: 'Leave empty and we choose', testid: tid('shop-name') }), zone()),
        F(n, p + 'list', 'What to buy', { type: 'textarea', required: true, rows: 2, placeholder: 'Items, brands, sizes and how many', testid: tid('list') }),
        F(n, p + 'shopPhone', 'Shop phone', { type: 'tel', intl: true, landline: true, testid: tid('shop-phone') })]
      : [grid(F(n, p + 'address', 'Collection address', { required: true, placeholder: 'House or building name, street', testid: tid('address') }), zone()),
        F(n, p + 'landmark', 'Landmark', { placeholder: 'Near a shop, mosque or school', testid: tid('landmark') }),
        grid(F(n, p + 'contactName', 'Contact person', { placeholder: 'Who hands it over', testid: tid('contact-name') }),
          F(n, p + 'contactPhone', 'Contact number', { type: 'tel', intl: true, landline: true, testid: tid('contact-phone') })),
        F(n, p + 'instructions', 'What to collect and instructions', { type: 'textarea', rows: 2, placeholder: 'What the driver picks up, floor, gate', testid: tid('instructions') })];
    const remove = () => { draft.extra.splice(i, 1); saveDraft(); renderStep(n); updateSummary(); const b = dom.steps[n].querySelector('[data-testid="request-extra-add"]'); if (b) b.focus({ preventScroll: true }); };
    return el('div', { class: 'request-extra', 'data-testid': 'request-extra' },
      el('div', { class: 'request-extra__head' }, el('h4', { class: 'request-extra__title' }, 'Stop ' + (i + 2)),
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': tid('remove'), on: { click: remove } }, 'Remove', el('span', { class: 'sr-only' }, ' stop ' + (i + 2)))),
      seg(n, p + 'kind', 'At this stop', MDM.EXTRA_COLLECTION_KINDS, { testid: tid('kind'), onChange: () => { saveDraft(); rerender(n); updateSummary(); } }),
      fields);
  }
  function extraGroup(n) {
    const max = MDM.MAX_EXTRA_COLLECTIONS, full = draft.extra.length >= max;
    const add = () => {
      draft.extra.push(blankExtra()); saveDraft(); renderStep(n); updateSummary();
      const cards = dom.steps[n].querySelectorAll('[data-testid="request-extra"]'), last = cards[cards.length - 1];
      const f = last && last.querySelector('input:checked'); if (f) { f.focus(); MDM.ui.scrollIntoViewIfNeeded(last); }
    };
    const out = [el('p', { class: 'request-group__desc' }, 'Collect or buy at more places. Everything is delivered together.')];
    draft.extra.forEach((x, i) => out.push(extraCard(n, x, i)));
    out.push(el('div', { class: 'request-items__add' }, el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'request-extra-add', disabled: full, on: { click: add } },
      html(MDM.icon('plus', 16)), 'Add a stop'), full ? el('span', { class: 'small muted' }, ' Up to ' + max + ' extra stops') : null));
    return el('div', { class: 'request-group', 'data-testid': 'request-extras' }, el('h3', { class: 'request-group__title' }, 'More stops'), out);
  }
  // Where stop 1 and each extra stop are, for the package counts in step 3 and the review.
  function stopPlace(i) {
    if (i === 0) return isShop() ? [MDM.shopName({ name: draft.shop.name }), MDM.geo.zoneLabel(draft.shop.zone || 'male')].join(', ')
      : [trim(draft.collection.address), MDM.geo.zoneLabel(draft.collection.zone || 'male')].filter(Boolean).join(', ');
    const x = draft.extra[i - 1];
    return x.kind === 'shop' ? 'Buy at ' + [MDM.shopName({ name: x.shopName }), MDM.geo.zoneLabel(x.zone || 'male')].join(', ') : [trim(x.address), MDM.geo.zoneLabel(x.zone || 'male')].filter(Boolean).join(', ');
  }
  // Bag / Box / XL steppers for one stop's counts. Stop 1 keeps the plain test ids (request-qty-bag…); stop k uses request-qty-s<k>-bag.
  function sizeRows(n, counts, key, o) {
    return SIZES.map(size => {
      const count = Number(counts[size]) || 0, tid = 'request-qty-' + (key ? key + '-' : '') + size;
      const setCount = v => { counts[size] = Math.max(0, Math.min(MAX_PER_SIZE, v)); if (!vehicleEligible()) draft.extraVehicle = false; saveDraft(); rerender(n); updateSummary(); };
      const label = MDM.pricing.sizeLabel(size), where = o.where ? ' at ' + o.where : '';
      return el('div', { class: ['request-size', count ? 'is-on' : null], 'data-size': size },
        el('div', { class: 'request-size__row' },
          el('div', { class: 'request-size__main' }, el('div', { class: 'request-size__label' }, label === 'XL' ? 'XL-size package' : label, el('span', { class: 'request-size__price mono', 'data-testid': 'request-range-' + (key ? key + '-' : '') + size }, MDM.pricing.rangeLabel(size, settings)))),
          el('div', { class: 'request-qty', role: 'group', 'aria-label': label + ' quantity' + where },
            el('button', { type: 'button', class: 'btn btn--secondary btn--icon btn--sm', 'aria-label': 'Fewer ' + label + ' packages' + where, 'data-testid': tid + '-minus', disabled: !count, on: { click: () => setCount(count - 1) } }, html(MDM.icon('minus', 16))),
            el('output', { class: 'request-qty__value mono', 'aria-live': 'polite', 'data-testid': tid }, String(count)),
            el('button', { type: 'button', class: 'btn btn--secondary btn--icon btn--sm', 'aria-label': 'More ' + label + ' packages' + where, 'data-testid': tid + '-plus', disabled: count >= MAX_PER_SIZE, on: { click: () => setCount(count + 1) } }, html(MDM.icon('plus', 16))))),
        count && o.photos ? el('div', { class: 'request-size__detail', 'data-testid': 'request-size-detail-' + size }, photoPicker(size)) : null);
    });
  }
  // Step 3: the packages. With extra stops, one block per stop (round 4, 26/10/2026), so the driver knows what each stop hands over
  // ("1 bag at stop 1, 2 boxes at stop 2") and confirms it on collection.
  function step3(n) {
    const shop = isShop(), multi = draft.extra.length > 0;
    const block = (counts, key, i) => {
      const title = multi ? 'Stop ' + (i + 1) : null, where = multi ? stopPlace(i) : '';
      const f = el('div', { class: 'field request-sizes', 'data-field': 'counts' + (key ? '-' + key : ''), 'data-testid': 'request-stop-packages' + (key ? '-' + key : '') },
        title ? el('div', { class: 'request-sizes__head' }, el('span', { class: 'request-sizes__title' }, title), where ? el('span', { class: 'request-sizes__where' }, where) : null) : null,
        sizeRows(n, counts, key, { photos: i === 0 && !shop, where: title ? 'stop ' + (i + 1) : '' }),
        el('div', { class: 'field__error', hidden: true }));
      reg(n, f, () => (countOf(counts) ? null : multi ? 'Add at least 1 package at this stop' : 'Add at least 1 package'), () => f.querySelector('[data-testid$="-bag-plus"]'));
      return f;
    };
    const m = priceModel();
    return [head(n, shop ? 'How big will the shopping be?' : 'What are we carrying?', multi ? 'Count the packages at each stop. The driver confirms them as they collect.' : null),
      el('div', { class: multi ? 'request-stops' : null }, block(draft.counts, '', 0), draft.extra.map((x, i) => block(x.counts, 's' + (i + 2), i + 1))),
      el('div', { class: 'request-estimate', 'data-testid': 'request-estimate' }, el('span', { class: 'request-estimate__label' }, 'Delivery estimate'), el('span', { class: 'request-estimate__value mono' }, m ? rangeText(m.delivery, m.xl) : 'Add a package')),
      vehicleEligible() ? el('div', { class: 'request-option', 'data-testid': 'request-extra-vehicle-box' },
        check(n, 'extraVehicle', 'Extra vehicle', { testid: 'request-extra-vehicle', hint: 'For several boxes or XL. Charge confirmed with the price.' })) : null,
      MDM.ui.notice('info', shop ? 'If it turns out bigger, we update the size before you pay.'
        : 'No photo? The driver takes one at collection and we price from it. A wrong size is corrected before you pay.'),
      F(n, 'description', shop ? 'What kind of shopping is it?' : 'What is inside?', { required: true, placeholder: shop ? 'For example a phone, a gift or home appliances' : 'For example documents, a gift box, a phone charger', testid: 'request-description' }),
      el('div', { class: 'row row--wrap request-flags' }, check(n, 'fragile', 'Fragile, handle with care')),
      actions()];
  }
  function receiverFields(n) {
    return grid(F(n, 'delivery.recipientName', 'Receiver name', { required: true, testid: 'request-recipient-name', attrs: { autocomplete: 'off' } }),
      F(n, 'delivery.recipientPhone', "Receiver's contact number", { type: 'tel', intl: true, landline: true, required: true, testid: 'request-recipient-phone' }));
  }
  function methodFields(n) {
    const m = draft.method, out = [];
    if (m === 'home') {
      out.push(savedPicker(n, 'delivery'));
      if (isNewAddress('delivery')) out.push(...addressFields(n, 'delivery', 'Delivery address'));
      out.push(seg(n, 'delivery.meetAt', 'Hand over at', MDM.geo.meetAtOptions(), { testid: 'request-meet-at' }),
        check(n, 'delivery.self', OFFICE ? 'The customer receives it' : "I'm receiving it myself", { testid: 'request-self', onChange: () => rerender(n) }),
        draft.delivery.self ? null : receiverFields(n),
        F(n, 'delivery.instructions', 'Delivery instructions', { type: 'textarea', rows: 2, placeholder: 'Floor, gate, who to ask for', testid: 'request-delivery-instructions' }));
    }
    if (m === 'boat') {
      const vessel = (MDM.VESSEL_TYPES.find(v => v.value === draft.boat.vesselType) || MDM.VESSEL_TYPES[0]).label.replace(' (dhoni)', '');
      out.push(grid(F(n, 'boat.island', 'Destination island', { required: true, placeholder: 'For example Thoddoo, Alifu Alifu', testid: 'request-boat-island' }),
          F(n, 'boat.address', 'Destination address', { placeholder: 'House name on the island', testid: 'request-boat-address' })),
        receiverFields(n),
        seg(n, 'boat.vesselType', 'Vessel', MDM.VESSEL_TYPES, { testid: 'request-boat-vessel', required: true, onChange: () => { saveDraft(); rerender(n); updateSummary(); } }),
        grid(F(n, 'boat.name', vessel + ' name', { required: true, placeholder: 'For example Alihaa Express', testid: 'request-boat-name' }),
          F(n, 'boat.jetty', 'Harbour or jetty', { type: 'select', required: true, placeholder: 'Choose the harbour or jetty', options: MDM.geo.jetties().map(j => ({ value: j.value, label: j.label })), testid: 'request-boat-jetty' })),
        grid(F(n, 'boat.departureDate', 'Departure date', { type: 'date', required: true, attrs: { min: today() }, validate: v => (v < today() ? 'Choose today or a later date' : null), testid: 'request-boat-date' }),
          F(n, 'boat.departureTime', 'Departure time', { type: 'time', required: true, testid: 'request-boat-time', validate: v => (v && draft.boat.departureDate === today() && v <= nowTime() ? 'This time has passed. Choose a later time.' : null) })),
        F(n, 'delivery.instructions', 'Instructions for the driver', { type: 'textarea', rows: 2, placeholder: 'For example ask for the captain, hand to the boat crew', testid: 'request-delivery-instructions' }));
    }
    if (m === 'cargo') {
      out.push(MDM.ui.notice('info', 'We hand it in at the Maldivian Cargo counter, main bus terminal. Fee ' + cargoFeeText() + '. Their own charges are added after delivery, with their bill.', { testid: 'request-cargo-note' }),
        F(n, 'cargo.island', 'Destination island', { required: true, placeholder: 'For example Kulhudhuffushi, Haa Dhaalu', testid: 'request-cargo-island' }),
        receiverFields(n),
        F(n, 'delivery.instructions', 'Instructions for the counter', { type: 'textarea', rows: 2, placeholder: 'Anything Maldivian Cargo needs to know', testid: 'request-delivery-instructions' }));
    }
    if (m === 'airport') {
      // Counter and resort are needed for a resort counter handover; other airport points (departures, arrivals…) only need the receiver.
      const atCounter = getPath('airport.point') === 'resort_counters';
      out.push(MDM.ui.notice('info', 'Handed over at Velana International Airport. Airport fee ' + airportFeeText() + '.', { testid: 'request-airport-note' }),
        grid(F(n, 'airport.point', 'Collection point at the airport', { type: 'select', required: true, options: MDM.geo.airportPoints().map(p => ({ value: p.value, label: p.label })), testid: 'request-airport-point',
            onChange: () => { renderStep(n); const s = dom.steps[n].querySelector('[data-testid="request-airport-point"]'); if (s) s.focus({ preventScroll: true }); } }),
          F(n, 'airport.counter', 'Resort counter or collection point', { required: atCounter, placeholder: 'For example Lagoon Point Resort counter', testid: 'request-airport-counter' })),
        receiverFields(n),
        F(n, 'airport.resort', 'Resort or destination', { required: atCounter, placeholder: 'For example Lagoon Point Resort, Baa Atoll', testid: 'request-airport-resort' }),
        grid(F(n, 'airport.speedboat', 'Resort speedboat', { placeholder: 'If the resort sends one', testid: 'request-airport-speedboat' }),
          F(n, 'airport.departureTime', 'Speedboat departure time', { type: 'time', testid: 'request-airport-time' })),
        F(n, 'airport.instructions', 'Instructions for the airport or resort handover', { type: 'textarea', rows: 2, placeholder: 'Who to hand it to, the guest\'s flight, anything the counter needs', testid: 'request-airport-instructions' }));
    }
    return out;
  }
  function step4(n) {
    const feeNote = { cargo: 'Plus ' + cargoFeeText() + ' and the cargo bill', airport: 'Plus ' + airportFeeText() };
    return [head(n, 'How do we deliver it?'),
      cards(n, {
        name: 'method', label: 'Delivery method', hideLabel: true, testid: 'request-method', value: draft.method, cols: 2,
        options: MDM.DELIVERY_METHODS.map(m => ({ value: m.value, label: m.label, hint: METHOD_HINT[m.value] || null, meta: feeNote[m.value] || null, icon: METHOD_ICON[m.value] })),
        onChange: v => { draft.method = v; saveDraft(); rerender(n); updateSummary(); },
      }),
      group(null, methodFields(n)),
      actions()];
  }
  // Step 5 is skipped for a signed-in customer (visibleSteps); a guest ticks "I've read what we carry" here. In the office it is the
  // customer's details (name and mobile shared with the office bar), and the operator ticks the box for a customer who has not yet.
  function step5(n) {
    const sync = () => { if (OFFICE) syncOfficeBar(); };
    return [head(n, OFFICE ? 'Customer details' : 'Your details'),
      !OFFICE && profileReady() ? MDM.ui.notice('info', 'Signed in as ' + profile.name + '. Changes apply to this request only.', { testid: 'request-signed-in' }) : null,
      grid(F(n, 'customer.name', OFFICE ? 'Name' : 'Your name', { required: true, attrs: { autocomplete: OFFICE ? 'off' : 'name' }, onChange: sync }),
        F(n, 'customer.phone', 'Mobile number', { type: 'tel', required: true, attrs: OFFICE ? { autocomplete: 'off' } : null, onChange: () => { sync(); if (OFFICE) lookupSoon(); } })),
      seg(n, 'customer.notify', OFFICE ? 'Notify by' : 'Send updates by', NOTIFY, { onChange: () => { saveDraft(); rerender(n); } }),
      F(n, 'customer.email', 'Email', { type: 'email', required: draft.customer.notify === 'email', attrs: { autocomplete: OFFICE ? 'off' : 'email' } }),
      needsTerms() ? el('div', { class: 'request-terms', 'data-testid': 'request-terms-box' }, el('p', { class: 'request-terms__text' }, settings.terms || ''),
        check(n, 'termsAck', OFFICE ? 'The customer agrees to what we carry' : "I've read what we carry", { required: true, testid: 'request-terms',
          requiredMessage: OFFICE ? 'Tick to confirm the customer agrees' : "Tick to confirm you've read what we carry" })) : null,
      me || OFFICE ? null : check(n, 'remember', 'Remember me on this device', { testid: 'request-remember' }),
      actions({ label: 'Review' })];
  }
  const reviewRow = (label, value) => MDM.ui.rateRow(label, value);
  function reviewGroup(title, n, rows, testid) {
    return el('div', { class: 'rate-table request-review__group', 'data-testid': testid || null },
      MDM.ui.rateRow(title, el('button', { type: 'button', class: 'btn btn--ghost btn--sm review__edit', 'data-testid': 'request-edit-' + n,
        on: { click: () => { if (n === 5 && !draft.editDetails) { draft.editDetails = true; saveDraft(); } go(n); } } }, 'Edit', el('span', { class: 'sr-only' }, ' ' + title)), { head: true }),
      rows.filter(Boolean));
  }
  function relevantDoc(kind) {
    const t = draft.type, d = draft.details;
    if (isShop()) return false;
    if (t === 'postal') return d.carrier === 'dhl' && kind === 'collection_doc';
    if (t === 'shop_collect') return kind === 'payment_slip' || kind === (d.proof === 'quotation' ? 'quotation' : 'invoice');
    if (t === 'office') return kind === 'document';
    return false;
  }
  function serviceRows() {
    const d = draft.details, t = draft.type, rows = [];
    const add = (l, v) => { if (trim(v)) rows.push(reviewRow(l, String(v))); };
    add('Service', categoryInfo().label);
    if (!isShop()) add('Collection type', typeOf().label);
    if (t === 'postal') {
      const k = postalKeys(), has = key => k.indexOf(key) >= 0;
      add('Carrier', (carrier() || {}).label);
      if (has('location')) add('Location', (MDM.PIKPOST_LOCATIONS.find(x => x.value === d.location) || {}).label);
      if (has('postOffice')) add('Post office', (MDM.POST_OFFICES.find(x => x.value === d.postOffice) || {}).label);
      if (has('courierName')) add('Courier', has('courierOther') ? d.courierOther : d.courierName);
      if (has('trackingNo')) add(d.carrier === 'dhl' ? 'Waybill or tracking number' : 'Tracking number', d.trackingNo);
      if (has('collectionCode')) add('Collection code', d.collectionCode);
      if (has('collectBefore')) add('Collect before', d.collectBefore ? d.collectBefore.replace('T', ' ') : '');
      if (has('ownerName')) add('Owner', d.ownerName);
      if (has('ownerContact')) add('Owner contact', d.ownerContact ? phone.format(d.ownerContact) : '');
      if (has('shippingAddress')) add('Shipping address', d.shippingAddress);
    }
    if (t === 'shop_collect') { add('Shop or godown', [d.shopName, d.shopAddress].filter(trim).join(', ')); add('Proof', d.proof === 'quotation' ? 'Quotation and payment slip' : 'Invoice and payment slip'); add('Order number', d.orderNo); }
    if (t === 'office') { add('Office or ministry', d.organisation); add('Task', (MDM.OFFICE_TASKS.find(x => x.value === d.task) || {}).label); add('References', d.reference); add('Details', d.details); if (d.returnDocs) add('Return', 'Bring the receipt or documents back'); }
    const docs = draft.docs.filter(x => relevantDoc(x.kind));
    if (docs.length) rows.push(reviewRow('Documents', docs.map(x => x.name).join(', ')));
    add('Timing', draft.level === 'advance' ? 'Collect ' + draft.schedule.collectDate + ' ' + draft.schedule.collectTime + ', deliver ' + draft.schedule.deliverDate + ' ' + draft.schedule.deliverTime : (MDM.SERVICE_LEVELS.find(x => x.value === draft.level) || {}).label);
    return rows;
  }
  // The extra stops (multi collection) as review rows: 'Stop 2' → what happens there.
  function extraRows() {
    return draft.extra.filter(stopReady).map((x, i) => reviewRow('Stop ' + (i + 2), x.kind === 'shop'
      ? 'Buy at ' + [MDM.shopName({ name: x.shopName }), MDM.geo.zoneLabel(x.zone)].join(', ') + ': ' + trim(x.list)
      : 'Collect from ' + [trim(x.address), MDM.geo.zoneLabel(x.zone)].join(', ') + ([trim(x.contactName), x.contactPhone ? phone.format(x.contactPhone) : ''].filter(Boolean).length ? ', ' + [trim(x.contactName), x.contactPhone ? phone.format(x.contactPhone) : ''].filter(Boolean).join(' ') : '') + (trim(x.instructions) ? ' (' + trim(x.instructions) + ')' : '')));
  }
  function collectionRows() {
    return collectionRowsMain().concat(extraRows(), draft.extra.length ? [reviewRow('Delivery', 'Every stop delivered together')] : []);
  }
  function collectionRowsMain() {
    const c = draft.collection;
    if (isShop()) {
      const s = draft.shop;
      return [reviewRow('Shop', trim(s.name) || (OFFICE ? 'Any shop, our team chooses' : 'Any shop, we choose')), reviewRow('Area', MDM.geo.zoneLabel(s.zone || 'male')), trim(s.phone) ? reviewRow('Phone', phone.format(s.phone)) : null,
        reviewRow('Items', el('ol', { class: 'request-review__items', 'data-testid': 'request-review-items' }, draft.items.filter(it => trim(it.name)).map(it => el('li', null, (Math.max(1, Math.round(Number(it.qty) || 1))) + ' × ' + trim(it.name) + (trim(it.details) ? ', ' + trim(it.details) : '') + (trim(it.instructions) ? ' (' + trim(it.instructions) + ')' : ''))))),
        reviewRow('Price', 'Agreed on a call before we buy')];
    }
    const saved = !isNewAddress('collection') ? savedById(c.savedId) : null;
    return [reviewRow('Address', (saved ? saved.label + ': ' : '') + c.address + ', ' + MDM.geo.zoneLabel(c.zone)), trim(c.landmark) ? reviewRow('Landmark', c.landmark) : null,
      trim(c.contactName) || trim(c.contactPhone) ? reviewRow('Contact', [c.contactName, c.contactPhone ? phone.format(c.contactPhone) : ''].filter(Boolean).join(', ')) : null,
      trim(c.instructions) ? reviewRow('Instructions', c.instructions) : null,
      isNewAddress('collection') && c.save && !c.auto ? reviewRow('Save address', 'Yes, as ' + labelOf(c)) : null];
  }
  function deliveryRows() {
    const d = draft.delivery, m = draft.method, dd = deliveryData(), rows = [reviewRow('Method', MDM.deliveryMethodLabel(m))];
    const add = (l, v) => { if (trim(v)) rows.push(reviewRow(l, String(v))); };
    if (m === 'home') {
      const saved = !isNewAddress('delivery') ? savedById(d.savedId) : null;
      add('Address', (saved ? saved.label + ': ' : '') + d.address + ', ' + MDM.geo.zoneLabel(d.zone)); add('Landmark', d.landmark);
      add('Hand over at', (MDM.geo.meetAtOptions().find(x => x.value === d.meetAt) || {}).label);
      if (isNewAddress('delivery') && d.save) add('Save address', 'Yes, as ' + labelOf(d));
    }
    if (m === 'boat') {
      const b = draft.boat, vessel = (MDM.VESSEL_TYPES.find(v => v.value === b.vesselType) || {}).label || 'Boat';
      add('Destination', [b.address, b.island].filter(trim).join(', ')); add('Vessel', vessel + ': ' + trim(b.name));
      add('Departure', [b.departureDate, b.departureTime].filter(Boolean).join(' at ')); add('Harbour or jetty', (MDM.geo.jetties().find(j => j.value === b.jetty) || {}).label);
    }
    if (m === 'cargo') { add('Hand over at', MDM.geo.cargoCounter().label); add('Destination island', draft.cargo.island); }
    if (m === 'airport') {
      const a = draft.airport;
      add('Collection point', (MDM.geo.airportPoints().find(p => p.value === a.point) || {}).label); add('Counter', a.counter); add('Resort or destination', a.resort);
      add('Resort speedboat', [a.speedboat, a.departureTime ? 'departs ' + a.departureTime : ''].filter(Boolean).join(', '));
    }
    add('Receiver', m === 'home' && d.self ? 'You' : [dd.recipientName, dd.recipientPhone ? phone.format(dd.recipientPhone) : ''].filter(Boolean).join(', '));
    add('Instructions', dd.instructions);
    return rows;
  }
  function step6(n) {
    const cust = draft.customer;
    const model = priceModel();
    const notifyWord = (NOTIFY.find(x => x.value === cust.notify) || NOTIFY[0]).label;
    const photos = SIZES.filter(s => draft.counts[s] && draft.photos[s].photoId);
    const upfront = upfrontForced() || draft.pay === 'upfront';
    const payNote = (OFFICE ? 'Call the customer to agree the items and the price before buying. ' : 'We call to agree the items and the price before we buy. ')
      + (isShop() ? 'Paid upfront' : 'A shop stop makes this paid upfront') + ' once confirmed; anything not spent is refunded.';
    const who = OFFICE ? 'the customer' : 'you';
    return [head(n, 'Check and send', 'Nothing is charged now.'),
      el('div', { class: 'stack-4' },
        reviewGroup(isShop() ? 'Shop & Deliver' : typeOf().label, 1, serviceRows(), 'request-review-service'),
        reviewGroup(isShop() ? 'Shop and items' : 'Collection', 2, collectionRows(), 'request-review-collection'),
        reviewGroup('Packages', 3, (draft.extra.length ? allCounts().map((c, i) => reviewRow('Stop ' + (i + 1), countText(c) || 'None')) : [reviewRow('Packages', packagesText())]).concat([reviewRow('Contents', draft.description + (draft.fragile ? ' (fragile)' : '')),
          isShop() ? null : reviewRow('Photos', photos.length ? photos.map(MDM.pricing.sizeLabel).join(', ') : 'Taken by the driver at collection'),
          vehicleEligible() ? reviewRow('Extra vehicle', draft.extraVehicle ? 'Yes, charge confirmed with the price' : 'No') : null]), 'request-review-packages'),
        reviewGroup('Delivery', 4, deliveryRows(), 'request-review-delivery'),
        reviewGroup(OFFICE ? 'Customer' : 'You', 5, [reviewRow('Name', cust.name), reviewRow('Mobile', phone.format(cust.phone)), trim(cust.email) ? reviewRow('Email', cust.email) : null, reviewRow('Updates by', notifyWord),
          OFFICE ? reviewRow('Order received by', (SOURCES.find(s => s.value === draft.source) || SOURCES[0]).label) : null], 'request-review-you'),
        el('div', { class: 'request-review__pay', 'data-testid': 'request-review-pay' }, upfrontForced() ? MDM.ui.notice('info', payNote)
          : seg(n, 'pay', 'When to pay', [{ value: 'after', label: 'After delivery' }, { value: 'upfront', label: 'Upfront' }],
            { testid: 'request-pay', hint: 'By bank transfer', onChange: () => { saveDraft(); rerender(n); } })),
        el('div', null, el('h3', { class: 'request-group__title request-review__price-title' }, 'Estimated price'),
          el('div', { class: 'summary', 'data-testid': 'request-review-price' }, chargeLines(model, 'request-review'))),
        MDM.ui.notice('info', 'We confirm the final price' + (priceAfterCollection() ? ' after collection' : settings.ops && settings.ops.reviewText ? ' within ' + settings.ops.reviewText : '') + ' and message ' + who + ' by ' + notifyWord + (upfront ? ' with the amount to transfer.' : '.'), { testid: 'request-review-note' })),
      el('div', { class: 'field__error', role: 'alert', 'data-testid': 'request-error', hidden: true }),
      actions({ submit: true, label: OFFICE ? 'Create order' : 'Send request' })];
  }
  const BUILDERS = { 1: step1, 2: step2, 3: step3, 4: step4, 5: step5, 6: step6 };
  function renderStep(n) { checks[n] = []; dom.steps[n].replaceChildren(...BUILDERS[n](n).filter(Boolean)); }

  // ---- Navigation -----------------------------------------------------------------------------------------------------------------
  function validStep(n) {
    if (!checks[n] || !checks[n].length) renderStep(n);
    return (checks[n] || []).every(c => !c.check());
  }
  function firstInvalid(max) { for (let n = 1; n < max; n++) { if (!validStep(n)) return n; } return max; }
  function showErrors(n) {
    let first = null;
    (checks[n] || []).forEach(c => { const msg = c.check(); setError(c.wrap, msg); if (msg && !first) first = c; });
    if (first) { first.focus(); MDM.ui.scrollIntoViewIfNeeded(first.wrap); return false; }
    return true;
  }
  function stepFromHash() { const m = /^#step-([1-6])$/.exec(location.hash || ''); return m ? Number(m[1]) : 0; }
  function setStep(n, o) {
    // Steps before the target must be valid; otherwise land on the first one that is not. A skipped step 5 moves on to the review.
    for (let k = 1; k <= 6; k++) renderStep(k);
    if (visibleSteps().indexOf(n) < 0) n = nextStep(n);
    n = Math.min(n, firstInvalid(n));
    step = n;
    if (stepFromHash() !== n) history.replaceState(null, '', location.pathname + location.search + '#step-' + n);
    renderStep(n);
    // Only the current step stays in the DOM; the others were rendered just to check them (their checks read the draft).
    Object.keys(dom.steps).forEach(k => { const on = Number(k) === n; dom.steps[k].hidden = !on; if (!on) dom.steps[k].replaceChildren(); });
    renderStepper(); renderNotice(); updateSummary();
    // The new step eases in once; re-renders of the same step (a choice, a lookup) do not replay it.
    if (shownStep !== n) { shownStep = n; if (MDM.motion) MDM.motion.enter(dom.steps[n]); }
    if (o && o.initial) return;
    window.scrollTo(0, 0);
    const h = dom.steps[n].querySelector('h2'); if (h) h.focus({ preventScroll: true });
  }
  function go(n) { if (stepFromHash() === n) setStep(n); else location.hash = '#step-' + n; }
  function advance() { if (!showErrors(step)) return; go(nextStep(step)); }
  // stepOf() → { at, of }: the position among the steps this customer sees ('Step 5 of 5' on the review when step 5 is skipped).
  const stepOf = () => { const v = visibleSteps(); return { at: Math.max(1, v.indexOf(step) + 1), of: v.length }; };
  function renderStepper() {
    const shown = visibleSteps();
    dom.stepper.hidden = isBusiness();
    dom.stepper.replaceChildren(...shown.map((n, i) => {
      const done = n < step, cur = n === step, label = stepLabel(n);
      const inner = done ? el('a', { class: 'stepper__link', href: '#step-' + n }, html(MDM.icon('check', 16)), el('span', { class: 'stepper__label' }, label))
        : el('span', { class: 'stepper__link' }, el('span', { class: 'stepper__num' }, (i + 1) + '.'), el('span', { class: 'stepper__label' }, label));
      return el('li', { class: ['stepper__item', done ? 'is-done' : null], 'aria-current': cur ? 'step' : null }, inner);
    }), el('li', { class: 'stepper__progress', 'aria-hidden': 'true' }, 'Step ' + stepOf().at + ' of ' + stepOf().of));
  }
  function updateSummary() {
    const model = priceModel();
    const est = dom.steps[3] && dom.steps[3].querySelector('.request-estimate__value'); if (est) est.textContent = model ? rangeText(model.delivery, model.xl) : 'Add a package';
    document.querySelectorAll('.request-step [data-live-charges]').forEach(box => box.replaceChildren(...chargeLines(model, box.dataset.liveCharges)));
    if (isBusiness()) {
      dom.panel.replaceChildren(el('div', { class: 'summary' }, el('h2', { class: 'summary__head' }, OFFICE ? 'Order' : 'Your request'),
        el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, 'Business Delivery', el('span', { class: 'summary__sub' }, OFFICE ? 'Booked from the business order' : 'Booked in the business portal')))));
      dom.bar.replaceChildren(el('div', { class: 'mobile-bar__info' }, el('div', { class: 'mobile-bar__total' }, 'Business Delivery'), el('div', { class: 'mobile-bar__meta' }, OFFICE ? 'Business order' : 'Business portal')),
        OFFICE ? el('a', { class: 'btn btn--primary', href: OFFICE_BUSINESS_HREF() }, 'Open') : el('a', { class: 'btn btn--brand', href: MDM.href('business/') }, 'Business portal'));
      return;
    }
    const c = draft.collection, d = draft.delivery, m = draft.method;
    const from = (isShop() ? MDM.shopName({ name: draft.shop.name }) : (trim(c.address) ? MDM.geo.zoneShort(c.zone) : '…')) + (draft.extra.length ? ' + ' + MDM.ui.plural(draft.extra.length, 'stop') : '');
    const to = m === 'home' ? (trim(d.address) ? MDM.geo.zoneShort(d.zone) : '…') : m === 'boat' ? (trim(draft.boat.island) || 'Boat') : m === 'cargo' ? 'Maldivian Cargo' : 'Airport';
    dom.panel.replaceChildren(el('div', { class: 'summary' },
      el('h2', { class: 'summary__head' }, OFFICE ? 'Order' : 'Your request'),
      el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, isShop() ? categoryInfo().label : typeOf().label, el('span', { class: 'summary__sub' }, (MDM.SERVICE_LEVELS.find(x => x.value === draft.level) || {}).label))),
      el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, MDM.deliveryMethodLabel(m), /^…/.test(from) && /^…/.test(to) ? null : el('span', { class: 'summary__sub' }, from + ' to ' + to))),
      el('div', { class: 'summary__rule' }),
      chargeLines(model, 'request-panel'),
      el('p', { class: 'small muted', 'data-testid': 'request-panel-note' }, priceAfterCollection() ? 'No photo: price confirmed after collection.' : 'Final price confirmed before collection.')));
    const totalEl = dom.panel.querySelector('[data-testid="request-panel-total"]'); if (totalEl) totalEl.setAttribute('data-testid', 'request-panel-estimate');
    dom.bar.replaceChildren(el('div', { class: 'mobile-bar__info' }, el('div', { class: 'mobile-bar__total mono', 'data-testid': 'request-bar-estimate' }, model ? rangeText(model.total, model.xl) : 'Add a package'), el('div', { class: 'mobile-bar__meta' }, 'Estimate · Step ' + stepOf().at + ' of ' + stepOf().of)),
      step < 6 ? el('button', { type: 'button', class: 'btn btn--primary', on: { click: advance } }, 'Continue') : el('button', { type: 'submit', form: 'request-form', class: 'btn btn--brand' }, OFFICE ? 'Create' : 'Send'));
  }

  // ---- Submit -----------------------------------------------------------------------------------------------------------------------
  function detailsFor() {
    const det = draft.details, t = draft.type;
    if (isShop()) {
      const s = draft.shop;
      // No budget or "if unavailable" choice any more (round 4): the shop, the list and the price are agreed on a call before buying.
      return { shop: { name: trim(s.name), zone: s.zone || 'male', phone: normPhone(s.phone) }, items: draft.items.filter(it => trim(it.name)).map(it => ({ name: trim(it.name), details: trim(it.details), qty: Math.max(1, Math.round(Number(it.qty) || 1)), instructions: trim(it.instructions) })) };
    }
    const keep = { postal: ['carrier'].concat(postalKeys()),
      shop_collect: ['shopName', 'shopAddress', 'shopZone', 'proof', 'orderNo'], office: ['task', 'organisation', 'reference', 'details', 'returnDocs'], home: [] }[t] || [];
    const details = {};
    keep.forEach(k => { const v = det[k]; if (v != null && v !== '' && v !== false) details[k] = typeof v === 'string' ? v.trim() : v; });
    if (t === 'postal') {
      // An 'Other courier' is saved under the name the customer typed, with its office address (also the collection address).
      if (details.courierOther) details.courierName = details.courierOther;
      delete details.courierOther; delete details.courierZone;
      if (details.ownerContact) details.ownerContact = normPhone(details.ownerContact);
      if (details.collectBefore) details.collectBefore = details.collectBefore.replace('T', ' ');
      if (det.carrier === 'post_office' && !trim(det.collectionCode)) details.idNote = 'No collection code; the owner gives their ID details to the post collections contact';
    }
    if (t === 'shop_collect') details.paidByCustomer = true;
    return details;
  }
  // Save the new addresses the customer ticked; an address already in the book only gets its label updated.
  async function saveNewAddresses(bookPhone) {
    const book = ((await MDM.store.list('customers', { where: { phone: phone.normalize(bookPhone) } }))[0] || {}).addresses || [];
    const targets = [];
    if (!isShop() && !draft.collection.auto && isNewAddress('collection') && draft.collection.save && trim(draft.collection.address)) targets.push('collection');
    if (draft.method === 'home' && isNewAddress('delivery') && draft.delivery.save && trim(draft.delivery.address)) targets.push('delivery');
    for (const target of targets) {
      const a = draft[target];
      const same = book.find(x => trim(x.address).toLowerCase() === trim(a.address).toLowerCase());
      const rec = { label: labelOf(a), address: trim(a.address), zone: a.zone || 'male', landmark: trim(a.landmark) };
      if (target === 'delivery') Object.assign(rec, { meetAt: a.meetAt || 'door', contactName: a.self ? '' : trim(a.recipientName), contactPhone: a.self ? '' : normPhone(a.recipientPhone) });
      if (same) rec.id = same.id;
      const saved = await MDM.store.saveAddress(bookPhone, rec);
      book.splice(0, book.length, ...(saved.addresses || []));
    }
  }
  async function submit(e) {
    e.preventDefault();
    if (submitting || step !== 6 || isBusiness()) return;
    const bad = firstInvalid(7);
    if (bad < 7) { go(bad); setTimeout(() => showErrors(bad), 0); return; }
    submitting = true;
    const btn = dom.steps[6].querySelector('[data-testid="request-submit"]'); MDM.ui.setLoading(btn, true);
    const errEl = dom.steps[6].querySelector('[data-testid="request-error"]');
    try {
      if (OFFICE && !officeSession()) throw new Error('Your office sign-in has ended. Sign in again, then send this order.');
      const cust = draft.customer, t = draft.type;
      const customer = { name: trim(cust.name), phone: phone.normalize(cust.phone), email: trim(cust.email), notify: cust.notify };
      // A guest's tick is recorded on the order and on their customer record, so signing in later does not ask again.
      const termsAcceptedAt = needsTerms() ? new Date().toISOString() : profile.termsAcceptedAt;
      const saved = await MDM.store.upsertCustomer({ name: customer.name, phone: customer.phone, email: customer.email, notify: customer.notify, address: null, termsAcceptedAt });
      await saveNewAddresses(me && !OFFICE ? me.phone : customer.phone);
      const pickup = pickupEnd();
      const c = draft.collection;
      const collection = isShop() ? { address: pickup.address, zone: pickup.zone, landmark: pickup.landmark, contactName: pickup.contact.name, contactPhone: pickup.contact.phone, instructions: '' }
        : { address: trim(c.address), zone: c.zone, landmark: trim(c.landmark), contactName: trim(c.contactName) || customer.name, contactPhone: normPhone(c.contactPhone) || customer.phone, instructions: trim(c.instructions) };
      const delivery = deliveryData();
      if (draft.method === 'home' && draft.delivery.self) Object.assign(delivery, { recipientName: customer.name, recipientPhone: customer.phone });
      const documents = draft.docs.filter(x => relevantDoc(x.kind));
      const packages = buildPackages(false);
      // The office records how the order came in and who entered it; everything else is the customer's order as they would send it.
      const order = await MDM.store.createOrder({
        source: OFFICE ? draft.source : 'web', requestType: isShop() ? 'shop_buy' : t, service: service(), serviceLevel: draft.level, customerId: saved.id, customer,
        collection, delivery, details: detailsFor(), documents, packages, extraCollections: extraData(), termsAcceptedAt,
        extraVehicle: !!draft.extraVehicle && MDM.extraVehicleEligible(packages),
        schedule: draft.level === 'advance' ? Object.assign({ type: 'advance' }, draft.schedule) : { type: 'asap' },
        payment: { method: 'transfer', status: 'pending', upfrontRequired: upfrontForced() || draft.pay === 'upfront' },
        by: OFFICE ? officeBy() : 'customer',
      });
      const fileIds = documents.map(x => x.fileId).concat(packages.map(p => p.photoId).filter(Boolean));
      for (const id of Array.from(new Set(fileIds))) { await MDM.store.update('files', id, { orderId: order.id }).catch(() => {}); }
      // Uploads left behind by a type or size the customer switched away from are not part of the order: drop them.
      const unused = draft.docs.map(x => x.fileId).concat(SIZES.map(sz => draft.photos[sz].photoId)).filter(id => id && fileIds.indexOf(id) < 0);
      for (const id of Array.from(new Set(unused))) { await MDM.store.remove('files', id).catch(() => {}); }
      if (!OFFICE && (draft.remember || me)) { try { localStorage.setItem(ME_KEY, JSON.stringify({ name: customer.name, phone: customer.phone, email: customer.email, notify: customer.notify, signedInAt: (me && me.signedInAt) || new Date().toISOString() })); } catch (err) { /* storage blocked */ } }
      clearDraft();
      // The office continues in the order drawer (confirm the price, assign a driver); a customer goes to tracking.
      location.href = OFFICE ? MDM.href('admin/#/orders/' + encodeURIComponent(order.id)) : MDM.href('track/?order=' + encodeURIComponent(order.id) + '&new=1');
    } catch (err) {
      submitting = false; MDM.ui.setLoading(btn, false);
      errEl.textContent = err && err.code === 'quota' ? 'This browser is out of storage for the demo. Remove a photo and try again.' : (err && err.message) || 'Could not send your request. Try again.';
      errEl.hidden = false;
    }
  }

  // ---- Office bar (office mode) -----------------------------------------------------------------------------------------------------
  // The customer's mobile, name and how the order came in. Name and mobile are the same draft fields as step 5, kept in step both ways.
  const officeEls = {};
  function buildOfficeBar() {
    const head = document.querySelector('main .page-head');
    officeEls.phone = el('input', { class: 'input', id: 'rq-office-phone', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '7XX XXXX', maxlength: MAXLEN.tel, 'data-testid': 'office-phone', value: draft.customer.phone || '' });
    officeEls.name = el('input', { class: 'input', id: 'rq-office-name', type: 'text', autocomplete: 'off', maxlength: MAXLEN.text, 'data-testid': 'office-name', value: draft.customer.name || '' });
    officeEls.status = el('div', { class: 'field__hint request-office__status', 'data-testid': 'office-customer', 'aria-live': 'polite', hidden: true });
    const source = el('fieldset', { class: 'segmented', 'data-testid': 'office-source' }, SOURCES.map(s => el('label', { class: 'segmented__option', 'data-testid': 'office-source-' + s.value },
      el('input', { class: 'sr-only', type: 'radio', name: 'rq-office-source', value: s.value, checked: draft.source === s.value }), el('span', null, s.label))));
    source.addEventListener('change', e => { if (e.target && e.target.checked) { draft.source = e.target.value; saveDraft(); } });
    officeEls.phone.addEventListener('input', () => { draft.customer.phone = officeEls.phone.value; saveDraft(); syncStep5(); lookupSoon(); });
    officeEls.name.addEventListener('input', () => { draft.customer.name = officeEls.name.value; saveDraft(); syncStep5(); });
    const phoneField = MDM.ui.field({ name: 'office.phone', control: officeEls.phone, label: "Customer's mobile" });
    phoneField.insertBefore(officeEls.status, phoneField.querySelector('.field__error'));
    const reset = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'office-reset', on: { click: async () => {
      if (!(await MDM.ui.confirm({ title: 'Start over?', message: 'This clears the order form.', okLabel: 'Start over' }))) return;
      clearDraft(); location.replace(location.pathname + location.search);
    } } }, 'Start over');
    head.classList.add('request-office');
    head.replaceChildren(
      el('a', { class: 'request-office__back', href: MDM.href('admin/#/orders'), 'data-testid': 'office-back' }, html(MDM.icon('chevron-left', 16)), 'Back to orders'),
      el('div', { class: 'request-office__title' }, el('h1', null, 'New order'), reset),
      el('div', { class: 'request-office__bar', 'data-testid': 'office-bar' },
        phoneField, MDM.ui.field({ name: 'office.name', control: officeEls.name, label: 'Name' }), MDM.ui.field({ name: 'office.source', control: source, label: 'Order received by' })));
  }
  // Copy the draft's name and mobile into whichever of the two places is not being typed in.
  function syncOfficeBar() {
    [['phone', draft.customer.phone], ['name', draft.customer.name]].forEach(([k, v]) => { const c = officeEls[k]; if (c && document.activeElement !== c && c.value !== (v || '')) c.value = v || ''; });
  }
  function syncStep5() {
    if (step !== 5 || !dom.steps[5]) return;
    [['request-phone', draft.customer.phone], ['request-name', draft.customer.name]].forEach(([id, v]) => { const c = dom.steps[5].querySelector('[data-testid="' + id + '"]'); if (c && document.activeElement !== c) c.value = v || ''; });
  }
  function paintOfficeStatus(norm) {
    const s = officeEls.status; if (!s) return;
    s.textContent = profile ? 'Existing customer · ' + MDM.ui.plural(profile.orderCount || 0, 'order') + (savedAddresses.length ? ' · ' + MDM.ui.plural(savedAddresses.length, 'saved address', 'saved addresses') : '')
      : norm ? 'New customer' : '';
    s.hidden = !s.textContent;
  }
  // A known number acts like that customer signed in (profile, saved addresses, "Order again"); a new number is a new customer.
  let lookupSeq = 0;
  async function lookupCustomer(raw, o) {
    o = o || {};
    const my = ++lookupSeq;
    const norm = phone.valid(raw) ? phone.normalize(raw) : null;
    const found = norm ? ((await MDM.store.list('customers', { where: { phone: norm } }))[0] || null) : null;
    if (my !== lookupSeq) return;
    const before = profile;
    if (!o.boot && (found ? before && before.id === found.id : !before)) { paintOfficeStatus(norm); return; }
    profile = found;
    me = found ? { name: found.name || '', phone: found.phone, email: found.email || '', notify: found.notify || 'whatsapp' } : null;
    savedAddresses = found ? (found.addresses || []).filter(a => a && a.id && trim(a.address)) : [];
    reorderChoices = found ? await loadReorderChoices() : [];
    if (my !== lookupSeq) return;
    paintOfficeStatus(norm);
    if (o.boot) return;
    const c = draft.customer;
    if (found) Object.assign(c, { name: found.name || c.name, email: found.email || '', notify: found.notify || c.notify });
    else if (before) { if (trim(c.name) === trim(before.name)) c.name = ''; if (trim(c.email) === trim(before.email)) c.email = ''; }
    // The previous customer's tick, saved addresses and "Order again" order do not carry over to another customer.
    draft.termsAck = false;
    ['collection', 'delivery'].forEach(k => { const t = draft[k]; if (t.savedId && t.savedId !== 'new' && !savedById(t.savedId)) Object.assign(t, { savedId: '', address: '', zone: 'male', landmark: '' }); });
    draft.reorderFrom = null;
    saveDraft();
    syncOfficeBar();
    rerender(step); renderStepper(); renderNotice(); updateSummary();
  }
  const lookupSoon = MDM.ui.debounce(() => { lookupCustomer(draft.customer.phone).catch(() => {}); }, 250);

  // ---- Boot -------------------------------------------------------------------------------------------------------------------------
  async function main() {
    // Office mode needs an office sign-in; anyone else is sent to it and comes back here.
    if (OFFICE && !officeSession()) { location.replace(MDM.href('login/?as=admin&next=' + encodeURIComponent('request/?office=1'))); return; }
    await MDM.store.ready;
    settings = await MDM.store.settings();
    dom.form = document.querySelector('[data-testid="request-form"]');
    dom.form.id = 'request-form';
    dom.stepper = dom.form.querySelector('[data-testid="request-stepper"]');
    dom.notice = el('div', { class: 'request-notice', 'data-testid': 'request-reorder-notice', hidden: true });
    dom.form.insertBefore(dom.notice, dom.stepper);
    for (let n = 1; n <= 6; n++) dom.steps[n] = document.getElementById('request-step-' + n);
    dom.panel = document.querySelector('[data-testid="request-panel"]');
    dom.bar = document.querySelector('[data-testid="request-mobile-bar"]');
    draft = loadDraft();
    me = loadMe();
    if (me) {
      const cust = (await MDM.store.list('customers', { where: { phone: phone.normalize(me.phone) } }))[0];
      profile = cust || null;
      // Signed in: the account fills "Your details" (step 5 is then skipped); a draft typed for another number takes the account's.
      if (profileReady() && normPhone(draft.customer.phone) !== profile.phone) Object.assign(draft.customer, { name: profile.name, phone: profile.phone, email: profile.email || '', notify: profile.notify || 'whatsapp' });
      else if (!trim(draft.customer.name) && !trim(draft.customer.phone)) Object.assign(draft.customer, { name: me.name || '', phone: me.phone || '', email: me.email || '', notify: me.notify || 'whatsapp' });
      savedAddresses = ((cust && cust.addresses) || []).filter(a => a && a.id && trim(a.address));
      reorderChoices = await loadReorderChoices();
    }
    if (OFFICE) {
      document.body.classList.add('is-office');
      document.title = 'New order · Office · Mr. Delivery Man';
      buildOfficeBar();
      if (trim(draft.customer.phone)) await lookupCustomer(draft.customer.phone, { boot: true });
    }
    const q = new URLSearchParams(location.search);
    const cat = q.get('category'), t = q.get('type'), reorderId = q.get('reorder');
    if (cat || t) draft.reorderFrom = null;   // a fresh link starts a fresh request, not the one filled from an old order
    if (cat && MDM.SERVICE_CATEGORIES.some(c => c.value === cat)) chooseCategory(cat);
    if (t) {
      const known = MDM.requestTypes().find(x => x.value === t);
      if (known) { draft.category = known.category; draft.type = known.value; }
      else if (t === 'bulk' || t === 'business') chooseCategory('business');
      else {
        draft.category = 'pick'; draft.type = 'home';
        // Old "Airport & baggage" links: airport runs are now a delivery method, so preselect Airport delivery.
        if (t === 'airport') draft.method = 'airport';
      }
      applyDictated();
    }
    saveDraft();
    dom.form.addEventListener('submit', submit);
    window.addEventListener('hashchange', () => setStep(stepFromHash() || 1));
    MDM.store.subscribe('settings', async () => { settings = await MDM.store.settings(); updateSummary(); });
    if (reorderId) {
      const order = (await MDM.store.get('orders', reorderId)) || (await MDM.store.orderByCode(reorderId));
      q.delete('reorder');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash);
      const why = reorderRefusal(order);
      if (!why) { startFrom(order, { direct: true, silent: true }); return; }
      const signIn = !me && order ? { label: 'Sign in', onClick: () => { location.href = MDM.href('login/?next=' + encodeURIComponent('request/?reorder=' + order.id)); } } : null;
      MDM.ui.toast(why, 'warn', signIn ? { action: signIn, timeout: 8000 } : undefined);
    }
    setStep(stepFromHash() || 1, { initial: true });
    if (OFFICE && !trim(draft.customer.phone)) officeEls.phone.focus({ preventScroll: true });
  }
  main();
})(window.MDM);

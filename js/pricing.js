// Pricing: one pure function turns a draft into priced packages, fees and totals; nothing else in the app does price arithmetic.
// Rule R1 (see docs/SPEC.md §1): each package is priced by size and by whether pickup and drop-off are on the same island.
// Prices are frozen onto the order when it is created; recalc() only re-derives totals from what is already on the order.
(function (MDM) { 'use strict';

  const SIZES = { bag: 'Bag', box: 'Box', xl: 'XL' };
  const BUSINESS_ISLANDS = ['male', 'hulhumale'];

  function round(n) { return Math.round(Number(n) || 0); }
  function island(zone) { return MDM.geo.island(zone); }
  function pickupZoneOf(pkg, service) { return service === 'shop' && pkg.shop ? (pkg.shop.zone || 'male') : (pkg.pickup ? (pkg.pickup.zone || 'male') : 'male'); }
  function dropZoneOf(pkg) { return pkg.dropoff ? (pkg.dropoff.zone || 'male') : 'male'; }

  function isCross(pickupZone, dropZone, rules) {
    if (rules && rules.airportReplacesCross && (pickupZone === 'airport' || dropZone === 'airport')) return false;
    const a = island(pickupZone), b = island(dropZone);
    if (a === 'other' || b === 'other') return false;   // unknown zone: estimate at the same-island figure, quote decides
    return a !== b;
  }

  // feeContext(packages, service) → which packages attract the airport and cargo fees and why. Reasons come in two forms: the
  // generic one the request panel prints while the draft is still being edited ('drop-off at the airport', 'pickup at a terminal')
  // and the named place for a saved order ('drop-off at Arrivals hall', 'drop-off at the Maldivian Cargo counter').
  // Web app updates §3.3: the cargo fee applies only when Maldivian Cargo is the delivery method (boat deliveries carry no cargo fee).
  function feeContext(packages, service) {
    const ctx = { airportCount: 0, cargoCount: 0, airportReasons: [], airportPlaces: [], cargoReasons: [], cargoPlaces: [] };
    (packages || []).forEach(pkg => {
      const pz = pickupZoneOf(pkg, service), dz = dropZoneOf(pkg);
      if (pz === 'airport' || dz === 'airport') {
        const atPickup = pz === 'airport', end = (atPickup ? pkg.pickup : pkg.dropoff) || {};
        const point = MDM.geo.airportPoints().find(p => p.value === end.meetAt);
        ctx.airportCount += 1;
        ctx.airportReasons.push(atPickup ? 'pickup at the airport' : 'drop-off at the airport');
        ctx.airportPlaces.push((atPickup ? 'pickup at ' : 'drop-off at ') + (point ? point.label : 'the airport'));
      }
      const d = pkg.dropoff || {};
      // Orders saved before delivery methods existed marked boat drops with dropoff.cargo.terminal; they keep the fee they were priced with.
      const cargoDrop = d.method ? d.method === 'cargo' : !!(d.cargo && d.cargo.terminal);
      if (cargoDrop) {
        const terminal = d.method ? MDM.geo.cargoCounter() : MDM.geo.terminals().find(t => t.value === d.cargo.terminal);
        ctx.cargoCount += 1;
        ctx.cargoReasons.push(d.method ? 'Maldivian Cargo delivery' : 'drop-off at a terminal');
        ctx.cargoPlaces.push('drop-off at ' + (terminal ? terminal.label : 'a terminal'));
      }
    });
    return ctx;
  }
  // Shops on a multi-collection order (extraCollections of kind 'shop'): the items' cost agreed on the confirmation call (shop.budget),
  // then the receipt, is bought for the customer and carries the shopping fee the same way a Shop & Deliver order does.
  function extraShops(list) { return (list || []).filter(c => c && c.kind === 'shop' && c.shop).map(c => c.shop); }
  function shopBase(sh) { return sh.receiptTotal != null && sh.receiptTotal > 0 ? round(sh.receiptTotal) : round(sh.budget); }
  function cargoLabel(count, rules) { return 'Maldivian Cargo fee' + (count > 1 && rules.cargoFeePer !== 'order' ? ' × ' + count : ''); }
  function shoppingLabel(rates) { const pct = Number(rates.shoppingPct) || 0; return 'Shopping fee' + (pct ? ' ' + pct + '%' : ''); }

  // quote(draft, settings) → { packages, fees, totals, feeLines }
  function quote(draft, settings) {
    const s = settings || {};
    const rates = s.rates || {}, sizes = rates.sizes || {}, rules = s.rules || {};
    const service = draft.service || 'pick';
    const reasons = new Set();
    const feeLines = [];
    let shopping = 0, budget = 0;
    const { airportCount, cargoCount, airportReasons, cargoReasons } = feeContext(draft.packages, service);

    const packages = (draft.packages || []).map((pkg, i) => {
      const size = SIZES[pkg.size] ? pkg.size : 'bag';
      const cell = sizes[size] || { same: 0, cross: 0 };
      const pz = pickupZoneOf(pkg, service), dz = dropZoneOf(pkg);
      const cross = isCross(pz, dz, rules);
      let lineTotal, businessRate = false;
      if (service === 'business' && pkg.tierRate != null) { lineTotal = round(pkg.tierRate); businessRate = true; }
      else if (service === 'business' && pkg.underOneFt !== false && BUSINESS_ISLANDS.indexOf(island(pz)) >= 0 && BUSINESS_ISLANDS.indexOf(island(dz)) >= 0) {
        lineTotal = round(rates.business); businessRate = true;
      } else {
        lineTotal = round(cross ? cell.cross : cell.same);
      }
      // Business packages on an agreed size rate are priced already; only a vehicle still needs a quote.
      if (!businessRate && size === 'xl' && (cell.quoted || cell.quoted == null)) reasons.add('xl');
      if (pkg.needsVehicle) reasons.add('vehicle');
      if (!businessRate && (island(pz) === 'villimale' || island(dz) === 'villimale')) reasons.add('villimale');
      if (!businessRate && (pz === 'other' || dz === 'other')) reasons.add('other_zone');
      if (service === 'shop' && pkg.shop) {
        const base = pkg.shop.receiptTotal != null && pkg.shop.receiptTotal > 0 ? round(pkg.shop.receiptTotal) : round(pkg.shop.budget);
        budget += base;
        shopping += round(base * (Number(rates.shoppingPct) || 0) / 100);
      }
      return Object.assign({}, pkg, { size, price: { same: round(cell.same), cross: round(cell.cross), crossIsland: cross, businessRate, tier: businessRate ? (pkg.tier || null) : null, lineTotal } });
    });

    extraShops(draft.extraCollections).forEach(sh => { const base = shopBase(sh); budget += base; shopping += round(base * (Number(rates.shoppingPct) || 0) / 100); });
    // Each extra collection stop is priced by the team when they confirm the price (no rate for it yet).
    if ((draft.extraCollections || []).length) reasons.add('stops');
    const airportFee = round(rates.airport) * (airportCount ? (rules.airportFeePer === 'package' ? airportCount : 1) : 0);
    const cargoFee = round(rates.cargo) * (cargoCount ? (rules.cargoFeePer === 'order' ? 1 : cargoCount) : 0);
    if (airportFee) feeLines.push({ key: 'airport', label: 'Airport fee', amount: airportFee, reason: airportReasons[0] || '' });
    if (cargoFee) feeLines.push({ key: 'cargo', label: cargoLabel(cargoCount, rules), amount: cargoFee, reason: cargoReasons[0] || '' });
    if (shopping) feeLines.push({ key: 'shopping', label: shoppingLabel(rates), amount: shopping, reason: 'of the items' });

    const fees = { cargo: cargoFee, airport: airportFee, shopping, adjustments: [] };
    const packagesTotal = packages.reduce((n, p) => n + p.price.lineTotal, 0);
    const feesTotal = cargoFee + airportFee + shopping;
    const totals = { packages: packagesTotal, fees: feesTotal, adjustments: 0, budget, total: packagesTotal + feesTotal + budget, quoteRequired: reasons.size > 0, quoteReasons: [...reasons] };
    return { packages, fees, totals, feeLines };
  }

  // recalc(order, settings) → order (mutated and returned): totals from frozen line prices + fees + adjustments; shopping fee follows the receipt when present.
  function recalc(order, settings) {
    const s = settings || {}; const rates = s.rates || {};
    order.fees = order.fees || { cargo: 0, airport: 0, shopping: 0, adjustments: [] };
    let budget = 0, shopping = 0;
    const shops = (order.service === 'shop' ? (order.packages || []).filter(p => p.shop).map(p => p.shop) : []).concat(extraShops(order.extraCollections));
    if (order.service === 'shop' || shops.length) {
      shops.forEach(sh => { const base = shopBase(sh); budget += base; shopping += round(base * (Number(rates.shoppingPct) || 10) / 100); });
      order.fees.shopping = shopping;
    }
    const packagesTotal = (order.packages || []).reduce((n, p) => n + round(p.price && p.price.lineTotal), 0);
    const feesTotal = round(order.fees.cargo) + round(order.fees.airport) + round(order.fees.shopping);
    const adjustments = (order.fees.adjustments || []).reduce((n, a) => n + round(a.amount), 0);
    const prev = order.totals || {};
    // E-store orders also carry the goods at their frozen store prices (createStoreOrder).
    const items = order.service === 'store' ? (order.items || []).reduce((n, i) => n + (Number(i.total) || 0), 0) : 0;
    order.totals = Object.assign({ packages: packagesTotal, fees: feesTotal, adjustments, budget, total: packagesTotal + feesTotal + adjustments + budget + items, quoteRequired: !!prev.quoteRequired, quoteReasons: prev.quoteReasons || [] }, order.service === 'store' ? { items } : {});
    return order;
  }

  // feeLines(order, settings?) → the fee rows to render for a stored order (same shape as quote().feeLines, plus adjustments as their
  // own rows). Amounts are the frozen order.fees, never recomputed; settings only shape the labels ('Maldivian Cargo fee × 2', 'Shopping fee 10%')
  // and the reasons name the saved meeting point or terminal ('drop-off at Arrivals hall').
  function feeLines(order, settings) {
    const s = settings || {}; const rates = s.rates || {}, rules = s.rules || {};
    const f = order.fees || {}; const out = [];
    const ctx = feeContext(order.packages, order.service);
    if (f.airport) out.push({ key: 'airport', label: 'Airport fee', amount: f.airport, reason: ctx.airportPlaces[0] || ctx.airportReasons[0] || '' });
    if (f.cargo) out.push({ key: 'cargo', label: cargoLabel(ctx.cargoCount, rules), amount: f.cargo, reason: ctx.cargoPlaces[0] || ctx.cargoReasons[0] || '' });
    if (f.shopping) {
      const receipt = (order.packages || []).some(p => p.shop && p.shop.receiptTotal > 0) || extraShops(order.extraCollections).some(sh => sh.receiptTotal > 0);
      out.push({ key: 'shopping', label: shoppingLabel(rates), amount: f.shopping, reason: receipt ? 'of the receipt' : 'of the items' });
    }
    const folded = packageAmounts(order).folded;
    // A row the office added in the price table carries what it is for (description) and, when there is more than one, how many at
    // what rate ('2 × MVR 80'); both show under the label wherever the row is listed.
    (f.adjustments || []).forEach(a => {
      if (folded[a.id]) return;
      const many = Number(a.qty) > 1 && a.rate != null ? a.qty + ' × ' + format(a.rate) : '';
      out.push({ key: 'adjustment', id: a.id, label: a.label, amount: a.amount, reason: [a.description, many].filter(Boolean).join(' · '), preset: a.preset });
    });
    return out;
  }
  // The confirmed price in the package rows (client, 12/11/2026: "display the final confirmed price directly in the first/original
  // price row, without showing additional remarks, adjustments, or separate rows"). packageAmounts(order) → { amounts, folded }:
  // amounts[i] is package i's frozen price with the difference our price confirmation recorded added in, and folded lists those
  // adjustments by id so feeLines leaves them out. A confirmation made in the price table names each package's difference (split:
  // { packageId: MVR }); one that only set a total is shared out evenly (client, 12/11/2026 evening: three bags confirmed at MVR 120
  // read 40 each, not 50, 35, 35), a cut a package cannot take carrying on to the others. An extra vehicle charge keeps its own row,
  // and a cut the packages cannot take together stays a row of its own as before.
  const confirmation = a => a && (a.preset === 'quote' || (a.confirm && a.preset !== 'vehicle'));
  function packageAmounts(order) {
    const pk = (order && order.packages) || [];
    const amounts = pk.map(p => round(p.price && p.price.lineTotal));
    const adj = (((order && order.fees) || {}).adjustments || []).filter(confirmation);
    if (!pk.length || !adj.length) return { amounts, folded: {} };
    const out = amounts.slice(), at = {};
    pk.forEach((p, i) => { at[p.id] = i; });
    let loose = 0;
    adj.forEach(a => {
      let left = round(a.amount);
      Object.keys(a.split || {}).forEach(id => { if (at[id] != null) { const d = round(a.split[id]); out[at[id]] += d; left -= d; } });
      loose += left;
    });
    if (loose) { const each = Math.trunc(loose / out.length), rest = loose - each * out.length; out.forEach((v, i) => { out[i] = v + each + (i < Math.abs(rest) ? Math.sign(rest) : 0); }); }
    let short = 0;
    out.forEach((v, i) => { if (v < 0) { short += v; out[i] = 0; } });
    for (let i = 0; i < out.length && short < 0; i++) { const cut = Math.max(short, -out[i]); out[i] += cut; short -= cut; }
    if (short < 0) return { amounts, folded: {} };
    const folded = {}; adj.forEach(a => { folded[a.id] = true; });
    return { amounts: out, folded };
  }
  // rowForm(adjustment) → how a row reads in the price table: { preset, description, qty, rate }. A row with its own wording (an
  // 'Other' row, or an older adjustment the office named by hand) keeps that wording as its description.
  function rowForm(a) {
    const qty = Number(a.qty) > 0 ? round(a.qty) : 1;
    const types = MDM.ADJUSTMENT_PRESETS || [];
    const preset = a.preset !== 'quote' && types.some(p => p.value === a.preset) ? a.preset : 'other';
    const listed = (types.find(p => p.value === preset) || {}).label;
    const named = a.label && a.label !== listed && a.label !== a.description ? a.label : '';
    return { preset, description: [named, a.description].filter(Boolean).join(', '), qty, rate: a.rate != null ? round(a.rate) : round(a.amount / qty) };
  }
  // priceRows(order, settings) → the order's price as the rows of an item table (client, 12/11/2026 evening: "editable and add row
  // style", as in their invoicing tool): item, quantity, rate, amount. Packages of one category on one route at one price are one row
  // ('Bag · Malé to Malé', 3 × MVR 40); then the e-store goods, the shopping items, the fees that follow the order by themselves
  // (airport, Maldivian Cargo, shopping) and every other row (extra vehicle, naalu, a discount, a charge billed from Charges).
  //   { kind: 'package', ids, label, sub, qty, rate, amount } | { kind: 'goods' | 'items', label, sub, qty, rate, amount }
  //   | { kind: 'fee', key, label, sub, amount } | { kind: 'row', id, preset, label, sub, qty, rate, amount, chargeId }
  function priceRows(order, settings) {
    const o = order || {}, rows = [], groups = {};
    const shown = packageAmounts(o).amounts;
    (o.items || []).forEach(it => rows.push({ kind: 'goods', label: it.name, sub: '', qty: Number(it.qty) || 1, rate: round(it.price != null ? it.price : it.total), amount: round(it.total) }));
    (o.packages || []).forEach((p, i) => {
      const label = lineLabel(p, o.service === 'store' ? 'pick' : o.service), amount = p.price ? shown[i] : 0, key = label + '|' + amount;
      if (!groups[key]) rows.push(groups[key] = { kind: 'package', ids: [], label, notes: [], qty: 0, rate: amount, amount: 0 });
      const g = groups[key];
      g.ids.push(p.id); g.qty += 1; g.amount += amount;
      if (p.description && g.notes.indexOf(p.description) < 0) g.notes.push(p.description);
    });
    rows.forEach(r => { if (r.kind === 'package') { r.sub = r.notes.join(', '); delete r.notes; } });
    const t = o.totals || {};
    if (t.budget) {
      const shops = (o.service === 'shop' ? (o.packages || []).filter(p => p.shop).map(p => p.shop) : []).concat(extraShops(o.extraCollections));
      rows.push({ kind: 'items', label: shops.some(sh => sh.receiptTotal > 0) ? 'Receipt total' : 'Items agreed', sub: '', qty: 1, rate: round(t.budget), amount: round(t.budget) });
    }
    const adjById = {}; ((o.fees || {}).adjustments || []).forEach(a => { adjById[a.id] = a; });
    feeLines(o, settings).forEach(f => {
      const a = f.id ? adjById[f.id] : null;
      if (!a) { rows.push({ kind: 'fee', key: f.key, label: f.label, sub: f.reason || '', amount: round(f.amount) }); return; }
      const form = rowForm(a);
      rows.push({ kind: 'row', id: a.id, preset: form.preset, label: a.label, sub: a.description || '', description: form.description, qty: form.qty, rate: form.rate, amount: round(a.amount), chargeId: a.chargeId || null });
    });
    return rows;
  }

  // format(n, { cents }) → 'MVR 1,250' | 'MVR 1,250.00' | '−MVR 20' (true minus sign)
  function format(n, opts) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const str = opts && opts.cents ? abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(abs).toLocaleString('en-US');
    return (v < 0 ? '−' : '') + 'MVR ' + str;
  }
  function sizeLabel(size) { return SIZES[size] || size; }
  function lineLabel(pkg, service) {
    const pz = pickupZoneOf(pkg, service), dz = dropZoneOf(pkg);
    const from = service === 'shop' && pkg.shop ? 'Shop in ' + MDM.geo.zoneLabel(pz) : MDM.geo.zoneLabel(pz);
    return sizeLabel(pkg.size) + ' · ' + from + ' to ' + MDM.geo.zoneLabel(dz);
  }
  function reasonText(reason) {
    return { xl: 'XL packages are quoted before pickup', vehicle: 'A vehicle may be needed, the charge is confirmed before dispatch', villimale: 'Villimalé is quoted before pickup', other_zone: 'We confirm the price for this area before pickup', stops: 'Extra collection stops are priced by our team' }[reason] || reason;
  }
  // Price shown on a size option for the given zones, e.g. 'MVR 35' or 'from MVR 60'
  function sizePriceLabel(size, pickupZone, dropZone, settings) {
    const s = settings || {}; const cell = ((s.rates || {}).sizes || {})[size] || { same: 0, cross: 0 };
    const cross = isCross(pickupZone || 'male', dropZone || 'male', s.rules || {});
    const v = cross ? cell.cross : cell.same;
    return (size === 'xl' ? 'from ' : '') + format(v);
  }

  // estimateRange(packages, settings, service, extraCollections?) → { min, max, exact }: the customer sees a range until the operator
  // confirms the price. min prices every package at the same-island rate, max at the across-the-bridge rate; exact uses the zones
  // already chosen. Extra shop stops add their budget and shopping fee.
  function estimateRange(packages, settings, service, extraCollections) {
    const s = settings || {};
    const pk = packages || [];
    const exact = quote({ service: service || 'pick', packages: pk, extraCollections }, s).totals.total;
    if (service === 'business') return { min: exact, max: exact, exact };
    const sizes = (s.rates || {}).sizes || {};
    const fees = quote({ service: service || 'pick', packages: pk, extraCollections }, s).totals;
    const extra = fees.fees + (fees.budget || 0);
    const min = pk.reduce((n, p) => n + round((sizes[p.size] || {}).same), 0) + extra;
    const max = pk.reduce((n, p) => n + round((sizes[p.size] || {}).cross), 0) + extra;
    return { min: Math.min(min, exact), max: Math.max(max, exact), exact };
  }
  // countsRange({ bag, box, xl }, settings) → { min, max } for the quantity steppers, before any address is known.
  function countsRange(counts, settings) {
    const sizes = ((settings || {}).rates || {}).sizes || {};
    let min = 0, max = 0;
    Object.keys(SIZES).forEach(k => { const n = Number(counts[k]) || 0; min += n * round((sizes[k] || {}).same); max += n * round((sizes[k] || {}).cross); });
    return { min, max };
  }
  // Business size categories and agreed rates (web app updates §1.3, §5.2).
  function businessTiers(settings) { const t = ((settings || {}).rates || {}).businessTiers; return (Array.isArray(t) && t.length ? t : MDM.DEFAULT_BUSINESS_TIERS).slice(); }
  function businessRate(account, tier, settings) {
    if (account && account.rates && account.rates[tier] != null) return round(account.rates[tier]);
    const t = businessTiers(settings).find(x => x.value === tier);
    return round(t ? t.rate : ((settings || {}).rates || {}).business);
  }
  // The tiers an account may use, with its agreed rate: [{ value, label, size, hint, rate }]. Accounts without rates get every tier at the default.
  function accountTiers(account, settings) {
    const all = businessTiers(settings);
    const keys = account && account.rates && Object.keys(account.rates).length ? all.filter(t => account.rates[t.value] != null) : all;
    return keys.map(t => Object.assign({}, t, { rate: businessRate(account, t.value, settings) }));
  }
  // Rates as ranges for the public rates section (§4): 'MVR 35–45', 'MVR 45–60', 'MVR 60++'.
  function rangeLabel(size, settings) {
    const cell = (((settings || {}).rates || {}).sizes || {})[size] || { same: 0, cross: 0 };
    if (size === 'xl') return 'MVR ' + round(cell.same) + '++';
    return round(cell.same) === round(cell.cross) ? format(cell.same) : 'MVR ' + round(cell.same) + '–' + round(cell.cross);
  }
  MDM.pricing = { estimateRange, countsRange, businessTiers, businessRate, accountTiers, rangeLabel, quote, recalc, feeLines, packageAmounts, priceRows, rowForm, format, sizeLabel, lineLabel, reasonText, sizePriceLabel, isCross, SIZES };
})(window.MDM);

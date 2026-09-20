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

  // quote(draft, settings) → { packages, fees, totals, feeLines }
  function quote(draft, settings) {
    const s = settings || {};
    const rates = s.rates || {}, sizes = rates.sizes || {}, rules = s.rules || {};
    const service = draft.service || 'pick';
    const reasons = new Set();
    const feeLines = [];
    let airportCount = 0, cargoCount = 0, shopping = 0, budget = 0;
    const airportReasons = [], cargoReasons = [];

    const packages = (draft.packages || []).map((pkg, i) => {
      const size = SIZES[pkg.size] ? pkg.size : 'bag';
      const cell = sizes[size] || { same: 0, cross: 0 };
      const pz = pickupZoneOf(pkg, service), dz = dropZoneOf(pkg);
      const cross = isCross(pz, dz, rules);
      let lineTotal, businessRate = false;
      if (service === 'business' && pkg.underOneFt !== false && BUSINESS_ISLANDS.indexOf(island(pz)) >= 0 && BUSINESS_ISLANDS.indexOf(island(dz)) >= 0) {
        lineTotal = round(rates.business); businessRate = true;
      } else {
        lineTotal = round(cross ? cell.cross : cell.same);
      }
      if (size === 'xl' && (cell.quoted || cell.quoted == null)) reasons.add('xl');
      if (pkg.needsVehicle) reasons.add('vehicle');
      if (island(pz) === 'villimale' || island(dz) === 'villimale') reasons.add('villimale');
      if (pz === 'other' || dz === 'other') reasons.add('other_zone');
      if (service !== 'business') {
        if (pz === 'airport' || dz === 'airport') { airportCount += 1; airportReasons.push(pz === 'airport' ? 'pickup at the airport' : 'drop-off at the airport'); }
        const cargoAt = (pkg.pickup && pkg.pickup.cargo) ? 'pickup' : null, cargoDrop = (pkg.dropoff && pkg.dropoff.cargo) ? 'drop-off' : null;
        if (cargoAt || cargoDrop) { cargoCount += 1; cargoReasons.push((cargoAt ? 'pickup' : 'drop-off') + ' at a terminal'); }
        if (service === 'shop' && pkg.shop) {
          const base = pkg.shop.receiptTotal != null && pkg.shop.receiptTotal > 0 ? round(pkg.shop.receiptTotal) : round(pkg.shop.budget);
          budget += base;
          shopping += round(base * (Number(rates.shoppingPct) || 0) / 100);
        }
      }
      return Object.assign({}, pkg, { size, price: { same: round(cell.same), cross: round(cell.cross), crossIsland: cross, businessRate, lineTotal } });
    });

    const airportFee = service === 'business' ? 0 : round(rates.airport) * (airportCount ? (rules.airportFeePer === 'package' ? airportCount : 1) : 0);
    const cargoFee = service === 'business' ? 0 : round(rates.cargo) * (cargoCount ? (rules.cargoFeePer === 'order' ? 1 : cargoCount) : 0);
    if (airportFee) feeLines.push({ key: 'airport', label: 'Airport fee', amount: airportFee, reason: airportReasons[0] || '' });
    if (cargoFee) feeLines.push({ key: 'cargo', label: 'Cargo fee' + (cargoCount > 1 && rules.cargoFeePer !== 'order' ? ' × ' + cargoCount : ''), amount: cargoFee, reason: cargoReasons[0] || '' });
    if (shopping) feeLines.push({ key: 'shopping', label: 'Shopping fee ' + (Number(rates.shoppingPct) || 0) + '%', amount: shopping, reason: 'of the shopping budget' });

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
    if (order.service === 'shop') {
      (order.packages || []).forEach(pkg => {
        if (!pkg.shop) return;
        const base = pkg.shop.receiptTotal != null && pkg.shop.receiptTotal > 0 ? round(pkg.shop.receiptTotal) : round(pkg.shop.budget);
        budget += base; shopping += round(base * (Number(rates.shoppingPct) || 10) / 100);
      });
      order.fees.shopping = shopping;
    }
    const packagesTotal = (order.packages || []).reduce((n, p) => n + round(p.price && p.price.lineTotal), 0);
    const feesTotal = round(order.fees.cargo) + round(order.fees.airport) + round(order.fees.shopping);
    const adjustments = (order.fees.adjustments || []).reduce((n, a) => n + round(a.amount), 0);
    const prev = order.totals || {};
    order.totals = { packages: packagesTotal, fees: feesTotal, adjustments, budget, total: packagesTotal + feesTotal + adjustments + budget, quoteRequired: !!prev.quoteRequired, quoteReasons: prev.quoteReasons || [] };
    return order;
  }

  // feeLines(order) → the fee rows to render for a stored order (same shape as quote().feeLines, plus adjustments as their own rows).
  function feeLines(order) {
    const f = order.fees || {}; const out = [];
    if (f.airport) out.push({ key: 'airport', label: 'Airport fee', amount: f.airport, reason: '' });
    if (f.cargo) out.push({ key: 'cargo', label: 'Cargo fee', amount: f.cargo, reason: '' });
    if (f.shopping) out.push({ key: 'shopping', label: 'Shopping fee', amount: f.shopping, reason: '' });
    (f.adjustments || []).forEach(a => out.push({ key: 'adjustment', id: a.id, label: a.label, amount: a.amount, reason: '', preset: a.preset }));
    return out;
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
    return { xl: 'XL packages are quoted before pickup', vehicle: 'A vehicle may be needed, the charge is confirmed before dispatch', villimale: 'Villimalé is quoted before pickup', other_zone: 'We confirm the price for this area before pickup' }[reason] || reason;
  }
  // Price shown on a size option for the given zones, e.g. 'MVR 35' or 'from MVR 60'
  function sizePriceLabel(size, pickupZone, dropZone, settings) {
    const s = settings || {}; const cell = ((s.rates || {}).sizes || {})[size] || { same: 0, cross: 0 };
    const cross = isCross(pickupZone || 'male', dropZone || 'male', s.rules || {});
    const v = cross ? cell.cross : cell.same;
    return (size === 'xl' ? 'from ' : '') + format(v);
  }

  MDM.pricing = { quote, recalc, feeLines, format, sizeLabel, lineLabel, reasonText, sizePriceLabel, isCross, SIZES };
})(window.MDM);

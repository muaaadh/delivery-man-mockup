// Business portal kit (web app updates 11/10/2026 §3, §5): the row model shared by the bulk rows editor and the Excel review,
// tolerant parsers for spreadsheet values, row validation, conversion to store.createBatch rows, and the SheetJS template / reader.
// Pure helpers only: no DOM except the on-demand SheetJS <script> tag. Exposed as MDM.bizKit for business/page.js.
(function (MDM) { 'use strict';

  const SHEETJS = { src: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', integrity: 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw' };
  const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const pad2 = n => (n < 10 ? '0' : '') + n;
  const METHOD_SHORT = { home: 'Home', boat: 'Boat', cargo: 'Cargo', airport: 'Airport' };

  // Spreadsheet columns, in template order. `syn` are the header spellings we also accept (compared after norm()).
  const COLUMNS = [
    { key: 'name', label: 'Receiver name', syn: ['receiver', 'recipient', 'recipient name', 'customer', 'customer name', 'name', 'consignee', 'receiver name'] },
    { key: 'phone', label: 'Contact number', syn: ['contact', 'phone', 'mobile', 'phone number', 'mobile number', 'receiver phone', 'receiver contact', 'receiver contact number', 'recipient phone', 'recipient contact', 'tel', 'telephone', 'contact no', 'number'] },
    { key: 'address', label: 'Delivery address', syn: ['address', 'delivery address', 'destination address', 'deliver to', 'address on the island'] },
    { key: 'zone', label: 'Area', syn: ['area', 'zone', 'delivery area', 'delivery zone', 'city'] },
    { key: 'landmark', label: 'Landmark', syn: ['landmark', 'near', 'nearby'] },
    { key: 'tier', label: 'Package size', syn: ['package size', 'size', 'size category', 'package size category', 'category', 'tier', 'package'] },
    { key: 'method', label: 'Delivery method', syn: ['delivery method', 'method', 'delivery type', 'delivery', 'delivery option', 'mode'] },
    { key: 'island', label: 'Destination island', syn: ['destination island', 'island', 'destination', 'atoll', 'island or atoll'] },
    { key: 'vesselType', label: 'Vessel type', syn: ['vessel type', 'boat type', 'type of boat', 'vessel'] },
    { key: 'boatName', label: 'Boat name', syn: ['boat name', 'boat', 'ferry name', 'speedboat name', 'vessel name', 'boat ferry or speedboat name'] },
    { key: 'departureDate', label: 'Departure date', syn: ['departure date', 'date', 'boat date', 'sailing date'] },
    { key: 'departureTime', label: 'Departure time', syn: ['departure time', 'departure', 'time', 'departs', 'boat time'] },
    { key: 'jetty', label: 'Jetty', syn: ['jetty', 'harbour', 'harbor', 'harbor or jetty', 'harbour or jetty', 'jetty or harbour', 'jetty or harbor', 'port'] },
    { key: 'counter', label: 'Airport counter', syn: ['airport counter', 'counter', 'resort counter', 'collection point', 'airport point', 'airport collection point'] },
    { key: 'resort', label: 'Resort', syn: ['resort', 'resort or destination', 'resort name', 'hotel'] },
    { key: 'speedboat', label: 'Resort speedboat', syn: ['resort speedboat', 'speedboat', 'resort boat', 'transfer boat'] },
    { key: 'cod', label: 'Cash to collect', syn: ['cash to collect', 'cod', 'cash on delivery', 'cod amount', 'cash', 'collect cash', 'amount to collect', 'cash amount'] },
    { key: 'instructions', label: 'Special instructions', syn: ['special instructions', 'instructions', 'delivery instructions', 'notes', 'note', 'remarks', 'comments'] },
    { key: 'reference', label: 'Reference', syn: ['reference', 'ref', 'order number', 'order no', 'order', 'invoice', 'invoice number', 'your reference'] },
    { key: 'description', label: 'Contents', syn: ['contents', 'description', 'item', 'items', 'what is it', 'product'] },
  ];
  const REQUIRED_COLUMNS = ['name', 'phone', 'tier'];

  // ---- Option lists ---------------------------------------------------------------------------------------------------------
  // Home delivery areas. The airport is not one: it is its own delivery method, and an airport-zone home drop would add the airport fee.
  const airportZone = v => !!(MDM.geo.zone(v) || {}).airport;
  const zoneOptions = () => MDM.geo.zoneOptions().filter(o => o.value !== 'other' && !airportZone(o.value));
  const jettyOptions = () => MDM.geo.jetties().map(t => ({ value: t.value, label: t.label }));
  const airportOptions = () => MDM.geo.airportPoints().map(p => ({ value: p.value, label: p.label }));
  const vesselOptions = () => MDM.VESSEL_TYPES.map(v => ({ value: v.value, label: v.label }));
  const methodOptions = () => MDM.DELIVERY_METHODS.map(m => ({ value: m.value, label: m.label }));
  const tierOptions = tiers => tiers.map(t => ({ value: t.value, label: t.label + ' · ' + MDM.pricing.format(t.rate) }));

  // Which row fields a delivery method uses (the editor shows only these; the rest are "Not needed").
  const METHOD_FIELDS = {
    home: ['address', 'zone', 'landmark'],
    boat: ['island', 'address', 'vesselType', 'boatName', 'departureDate', 'departureTime', 'jetty'],
    cargo: ['island'],
    airport: ['airportPoint', 'counter', 'resort', 'speedboat', 'departureTime'],
  };
  const METHOD_KEYS = ['address', 'zone', 'landmark', 'island', 'vesselType', 'boatName', 'departureDate', 'departureTime', 'jetty', 'airportPoint', 'counter', 'resort', 'speedboat'];
  const uses = (row, key) => METHOD_KEYS.indexOf(key) < 0 || (METHOD_FIELDS[row.method] || METHOD_FIELDS.home).indexOf(key) >= 0;

  // Field labels for a row. `address` is the delivery address for home, the address on the island for boats.
  function fieldLabel(key, method) {
    if (key === 'address') return method === 'boat' ? 'Address on the island' : 'Delivery address';
    if (key === 'departureTime') return method === 'airport' ? 'Speedboat departure' : 'Departure time';
    return ({ name: 'Receiver name', phone: 'Contact number', method: 'Delivery method', zone: 'Area', landmark: 'Landmark', tier: 'Package size', island: 'Destination island',
      vesselType: 'Vessel type', boatName: 'Boat name', departureDate: 'Departure date', jetty: 'Jetty or harbour', airportPoint: 'Airport meeting point', counter: 'Resort counter',
      resort: 'Resort or destination', speedboat: 'Resort speedboat', cod: 'Cash to collect', instructions: 'Special instructions', reference: 'Reference', description: 'Contents' })[key] || key;
  }

  // ---- Value parsers (spreadsheet cells are strings, numbers or empty) ------------------------------------------------------------
  const AIRPORT_AREA = /airport|hulhule|velana/;
  const cellText = v => v == null ? '' : (typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v)).trim();
  function parseZone(raw) {
    const n = norm(raw);
    if (!n) return '';
    const opts = zoneOptions();
    const direct = opts.find(o => norm(o.value) === n || norm(o.value.replace(/_/g, ' ')) === n || norm(o.label) === n || norm(MDM.geo.zoneShort(o.value)) === n);
    if (direct) return direct.value;
    if (/villi/.test(n)) return 'villimale';
    if (AIRPORT_AREA.test(n)) return '';   // not an area: validateRow says to choose Airport as the delivery method
    if (/(phase|ph|p) ?2\b|hm ?2\b/.test(n)) return 'hulhumale_p2';
    if (/(phase|ph|p) ?1\b|hm ?1\b/.test(n) || n === 'hulhumale' || n === 'hulhumalé' || n === 'hm') return 'hulhumale_p1';
    if (/^male\b|^male$|^mal[eé]\b/.test(n)) return 'male';
    return '';
  }
  function parseMethod(raw) {
    const n = norm(raw);
    if (!n) return { value: 'home' };
    if (/cargo/.test(n)) return { value: 'cargo' };
    if (/airport|velana|resort counter/.test(n)) return { value: 'airport' };
    if (/speed ?boat/.test(n)) return { value: 'boat', vessel: 'speedboat' };
    if (/ferry/.test(n)) return { value: 'boat', vessel: 'ferry' };
    if (/boat|dhoni|launch|vessel/.test(n)) return { value: 'boat' };
    if (/home|door|house|address|standard|normal/.test(n)) return { value: 'home' };
    return { value: '' };
  }
  function parseVessel(raw) {
    const n = norm(raw);
    if (!n) return '';
    if (/speed/.test(n)) return 'speedboat';
    if (/ferry/.test(n)) return 'ferry';
    if (/boat|dhoni|launch/.test(n)) return 'boat';
    return null;
  }
  const TIER_ALIAS = { s: 'small', sm: 'small', small: 'small', m: 'medium', med: 'medium', medium: 'medium', l: 'large', lg: 'large', large: 'large', big: 'large' };
  // parseTier(raw, allTiers) → tier value or '' (empty) or null (not a size we know)
  function parseTier(raw, allTiers) {
    const n = norm(raw);
    if (!n) return '';
    const first = n.split(' ')[0];
    const hit = allTiers.find(t => norm(t.value) === n || norm(t.label) === n || norm(t.label) === first) ||
      allTiers.find(t => TIER_ALIAS[n] === t.value || TIER_ALIAS[first] === t.value) ||
      allTiers.find(t => t.size === n || (n === 'x large' && t.size === 'xl') || (n === 'extra large' && t.size === 'xl'));
    return hit ? hit.value : null;
  }
  function parseJetty(raw) {
    const n = norm(raw);
    if (!n) return '';
    const list = MDM.geo.jetties();
    const exact = list.find(t => norm(t.value) === n || norm(t.label) === n);
    if (exact) return exact.value;
    if (/not sure|unsure|don ?t know|do not know|assist|check/.test(n)) return 'unsure';
    if (/t ?jetty/.test(n)) return 'male_tjetty';
    if (/north/.test(n)) return 'male_north';
    if (/villi/.test(n)) return 'villimale_ferry';
    if (/hulhumale|hulhumal/.test(n)) return 'hulhumale_ferry';
    if (/mpl|commercial/.test(n)) return 'mpl_harbour';
    if (/jett(y|ies)|speedboat/.test(n)) return 'male_jetties';
    const loose = list.find(t => norm(t.label).indexOf(n) >= 0);
    return loose ? loose.value : null;
  }
  function parseAirportPoint(raw) {
    const n = norm(raw);
    if (!n) return '';
    const p = MDM.geo.airportPoints().find(x => norm(x.value) === n || norm(x.label) === n);
    return p ? p.value : null;
  }
  // parseTime → 'HH:MM', '' when empty, null when it is not a time. Excel stores times as a fraction of a day.
  function parseTime(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') { if (!(v >= 0)) return null; const m = Math.round((v % 1) * 1440) % 1440; return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }
    const s = String(v).trim().toLowerCase();
    if (!s) return '';
    let m = /^(\d{1,2})[:.h](\d{2})(?::\d{2})?\s*(am|pm)?$/.exec(s) || /^(\d{1,2})\s*(am|pm)$/.exec(s);
    let h, mi, ap;
    if (m && m.length === 4) { h = Number(m[1]); mi = Number(m[2]); ap = m[3]; }
    else if (m) { h = Number(m[1]); mi = 0; ap = m[2]; }
    else if ((m = /^(\d{3,4})$/.exec(s))) { const d = m[1].padStart(4, '0'); h = Number(d.slice(0, 2)); mi = Number(d.slice(2)); }
    else return null;
    if (ap) { if (h < 1 || h > 12) return null; if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
    if (h > 23 || mi > 59) return null;
    return pad2(h) + ':' + pad2(mi);
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function validYMD(y, mo, d) { const dt = new Date(y, mo - 1, d); return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? y + '-' + pad2(mo) + '-' + pad2(d) : null; }
  // parseDate → 'YYYY-MM-DD', '' when empty, null when it is not a date. Numbers are Excel date serials.
  function parseDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') {
      if (!(v > 0)) return null;
      const ssf = window.XLSX && window.XLSX.SSF;
      if (ssf && ssf.parse_date_code) { const p = ssf.parse_date_code(v); return p ? validYMD(p.y, p.m, p.d) : null; }
      const dt = new Date(Math.round((v - 25569) * 86400000)); return validYMD(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    const s = String(v).trim().toLowerCase();
    if (!s) return '';
    if (s === 'today' || s === 'tomorrow') { const d = new Date(); if (s === 'tomorrow') d.setDate(d.getDate() + 1); return MDM.ui.dayKey(d); }
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
    if (m) return validYMD(Number(m[1]), Number(m[2]), Number(m[3]));
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);   // Maldives writes day first: 14/10/2026
    if (m) return validYMD(Number(m[3].length === 2 ? '20' + m[3] : m[3]), Number(m[2]), Number(m[1]));
    m = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(s);
    if (m && MONTHS.indexOf(m[2]) >= 0) return validYMD(Number(m[3]), MONTHS.indexOf(m[2]) + 1, Number(m[1]));
    return null;
  }
  // parseMoney → integer >= 0, 0 when empty, null when it is not an amount (negative, text).
  function parseMoney(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v >= 0 && isFinite(v) ? Math.round(v) : null;
    const s = String(v).trim().replace(/^(mvr|rf|mrf)\.?\s*/i, '').replace(/\s*(mvr|rf|mrf)$/i, '').replace(/[,\s]/g, '');
    if (!s || /^([-\u2013\u2014]+|nil|none|no|n\/?a)$/i.test(s)) return 0;   // a dash or "none" in the cash column means nothing to collect
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    return Math.round(Number(s));
  }

  // ---- Row model ----------------------------------------------------------------------------------------------------------------
  function blankRow(tiers) {
    return { id: MDM.id('row'), name: '', phone: '', method: 'home', address: '', zone: '', landmark: '', island: '', vesselType: 'speedboat', boatName: '', departureDate: MDM.ui.dayKey(),
      departureTime: '', jetty: 'male_jetties', airportPoint: 'resort_counters', counter: '', resort: '', speedboat: '', tier: (tiers[0] || {}).value || '', cod: '', instructions: '', reference: '', description: '', raw: {} };
  }
  // A row counts once it has any receiver or order detail; a row with only a size, a method or an amount is template residue.
  const filled = r => ['name', 'phone', 'address', 'island', 'landmark', 'reference', 'description', 'instructions', 'boatName', 'resort', 'counter'].some(k => String(r[k] || '').trim());

  // rowFromCells(record, tiers) → row: one spreadsheet record ({ key: cell }) parsed against the account's agreed sizes; values we cannot
  // read (or a size the account has no rate for) keep the original text in row.raw.
  function rowFromCells(rec, allTiers) {
    const r = blankRow([]);
    r.raw = {};
    r.departureDate = ''; r.vesselType = ''; r.jetty = ''; r.airportPoint = 'resort_counters';
    const txt = k => cellText(rec[k]);
    r.name = txt('name'); r.phone = txt('phone'); r.address = txt('address'); r.landmark = txt('landmark');
    r.island = txt('island'); r.boatName = txt('boatName'); r.counter = txt('counter'); r.resort = txt('resort'); r.speedboat = txt('speedboat');
    r.instructions = txt('instructions'); r.reference = txt('reference'); r.description = txt('description');
    const m = parseMethod(rec.method);
    r.method = m.value || 'home'; if (!m.value) r.raw.method = txt('method');
    const z = parseZone(rec.zone); r.zone = z; if (!z && txt('zone')) r.raw.zone = txt('zone');
    const t = parseTier(rec.tier, allTiers); r.tier = t || ''; if (t === null) r.raw.tier = txt('tier');
    const v = parseVessel(rec.vesselType); r.vesselType = v || m.vessel || (r.method === 'boat' ? (/speed/i.test(r.boatName) ? 'speedboat' : /ferry/i.test(r.boatName) ? 'ferry' : 'boat') : 'speedboat'); if (v === null) { r.vesselType = ''; r.raw.vesselType = txt('vesselType'); }
    const j = parseJetty(rec.jetty); r.jetty = j || ''; if (j === null) r.raw.jetty = txt('jetty');
    // The airport counter column holds either one of our meeting points or the resort counter's own name.
    const ap = parseAirportPoint(rec.counter); if (ap) { r.airportPoint = ap; r.counter = ''; }
    const tm = parseTime(rec.departureTime); r.departureTime = tm == null ? txt('departureTime') : tm;
    const dt = parseDate(rec.departureDate); r.departureDate = dt == null ? txt('departureDate') : dt;
    const cod = parseMoney(rec.cod); r.cod = cod == null ? txt('cod') : (cod ? String(cod) : '');
    return r;
  }

  const orList = a => a.length > 1 ? a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1] : (a[0] || '');
  // validateRow(row, ctx) → { field: message }. ctx = { tiers (the account's), allTiers }.
  function validateRow(r, ctx) {
    const e = {};
    const tiers = ctx.tiers || [], method = r.method;
    if (!String(r.name || '').trim()) e.name = 'Enter the receiver name';
    const ph = String(r.phone || '').trim();
    if (!ph) e.phone = 'Enter the contact number';
    else if (!MDM.ui.phone.valid(ph, { intl: true })) e.phone = 'Enter a 7-digit Maldives number, or + and the country code';
    if (r.raw && r.raw.method) e.method = 'Not a delivery method: ' + r.raw.method + '. Use home, boat, cargo or airport';
    else if (!METHOD_FIELDS[method]) e.method = 'Choose the delivery method';
    if (method === 'home' || !METHOD_FIELDS[method]) {
      if (!String(r.address || '').trim()) e.address = 'Enter the delivery address';
      if (r.raw && r.raw.zone && !r.zone) e.zone = AIRPORT_AREA.test(norm(r.raw.zone)) ? 'The airport is not an area: choose Airport as the delivery method' : 'Unknown area: ' + r.raw.zone + '. Choose one from the list';
      else if (!r.zone) e.zone = 'Choose the area';
      else if (!MDM.geo.zone(r.zone) || airportZone(r.zone)) e.zone = 'Choose an area from the list';
    }
    const sizes = orList(tiers.map(t => t.label));
    if (r.raw && r.raw.tier && !r.tier) e.tier = 'Not one of your agreed sizes: ' + r.raw.tier + '. Use ' + sizes;
    else if (!r.tier) e.tier = 'Choose the package size';
    else if (!tiers.some(t => t.value === r.tier)) e.tier = 'Not one of your agreed sizes. Use ' + sizes;
    if (method === 'boat' || method === 'cargo') { if (!String(r.island || '').trim()) e.island = 'Enter the destination island'; }
    if (method === 'boat') {
      if (r.raw && r.raw.vesselType && !r.vesselType) e.vesselType = 'Not a vessel type: ' + r.raw.vesselType + '. Use boat, ferry or speedboat';
      else if (!r.vesselType) e.vesselType = 'Choose boat, ferry or speedboat';
      if (!String(r.boatName || '').trim()) e.boatName = 'Enter the boat name';
      const tm = parseTime(r.departureTime);
      if (!tm) e.departureTime = tm === '' ? 'Enter the departure time' : 'Use a time like 17:00';
      // Required like on a single order, and not in the past: a missing date is a row error the business fixes in the review.
      const dd = parseDate(r.departureDate);
      if (!dd) e.departureDate = dd === '' ? 'Choose the departure date' : 'Use a date like ' + MDM.ui.dayKey();
      else if (dd < MDM.ui.dayKey()) e.departureDate = 'Choose today or a later date';
      if (r.raw && r.raw.jetty && !r.jetty) e.jetty = 'Unknown jetty: ' + r.raw.jetty + '. Choose one from the list';
      else if (!r.jetty) e.jetty = 'Choose the jetty or harbour';
    }
    if (method === 'airport' && r.departureTime && parseTime(r.departureTime) == null) e.departureTime = 'Use a time like 15:30';
    if (parseMoney(r.cod) == null) e.cod = 'Not an amount: ' + String(r.cod).trim() + '. Enter 0 or more, numbers only';
    return e;
  }

  // delivery(row) → the order `delivery` object (method + matching boat / cargo / airport details).
  function delivery(r) {
    const phone = MDM.ui.phone.normalize(r.phone) || String(r.phone || '').trim();
    const d = { method: r.method, address: r.method === 'home' || r.method === 'boat' ? String(r.address || '').trim() : '', zone: r.method === 'home' ? r.zone : '', landmark: r.method === 'home' ? String(r.landmark || '').trim() : '',
      recipientName: String(r.name || '').trim(), recipientPhone: phone, instructions: String(r.instructions || '').trim(), meetAt: 'door', boat: null, cargo: null, airport: null };
    if (r.method === 'boat') d.boat = { vesselType: r.vesselType || 'boat', name: String(r.boatName || '').trim(), departureDate: parseDate(r.departureDate) || '', departureTime: parseTime(r.departureTime) || '', jetty: r.jetty, island: String(r.island || '').trim(), address: String(r.address || '').trim(), contact: phone, history: [] };
    if (r.method === 'cargo') d.cargo = { counter: MDM.geo.cargoCounter().label, island: String(r.island || '').trim(), consignee: String(r.name || '').trim() };
    if (r.method === 'airport') d.airport = { point: r.airportPoint || 'resort_counters', counter: String(r.counter || '').trim(), resort: String(r.resort || '').trim(), speedboat: String(r.speedboat || '').trim(), departureTime: parseTime(r.departureTime) || '', instructions: String(r.instructions || '').trim() };
    return d;
  }
  // toBatchRow(row) → one row for MDM.store.createBatch.
  function toBatchRow(r) {
    const d = delivery(r);
    return { name: d.recipientName, phone: d.recipientPhone, address: d.address, zone: d.zone || 'male', landmark: d.landmark, tier: r.tier, description: String(r.description || '').trim(), fragile: false,
      instructions: d.instructions, reference: String(r.reference || '').trim(), cod: parseMoney(r.cod) || 0, method: r.method, boat: d.boat, cargo: d.cargo, airport: d.airport };
  }
  // quoteRow(row, acc, settings, pickupZone) → { rate, fees, total, feeLines } priced exactly as store.createBatch prices it.
  function quoteRow(r, acc, settings, pickupZone) {
    const tierInfo = MDM.pricing.accountTiers(acc, settings).find(t => t.value === r.tier);
    if (!tierInfo) return null;   // no size yet, or a size this account has no agreed rate for
    const rate = MDM.pricing.businessRate(acc, r.tier, settings);
    const end = MDM.deliveryEndpoint(delivery(Object.assign({}, r, { zone: r.zone || 'male' })));
    const q = MDM.pricing.quote({ service: 'business', packages: [{ id: 'q', size: tierInfo.size, tier: r.tier, tierRate: rate, underOneFt: tierInfo.size === 'bag', pickup: { zone: pickupZone || 'male' }, dropoff: end }] }, settings);
    return { rate, fees: q.totals.fees, total: q.totals.total, feeLines: q.feeLines };
  }

  // ---- Spreadsheet reading --------------------------------------------------------------------------------------------------------
  // mapHeaders(cells) → [key|null per column]: exact names and synonyms first, then the longest synonym a header contains.
  function mapHeaders(cells) {
    const heads = cells.map(norm);
    const cands = [];
    heads.forEach((h, i) => {
      if (!h) return;
      COLUMNS.forEach(c => {
        const names = [norm(c.label)].concat(c.syn.map(norm));
        let best = 0;
        names.forEach(s => { if (s === h) best = Math.max(best, 1000 + s.length); else if (s.length >= 3 && (' ' + h + ' ').indexOf(' ' + s + ' ') >= 0) best = Math.max(best, s.length); });
        if (best) cands.push({ i, key: c.key, score: best });
      });
    });
    cands.sort((a, b) => b.score - a.score);
    const out = cells.map(() => null), used = {};
    cands.forEach(c => { if (out[c.i] == null && !used[c.key]) { out[c.i] = c.key; used[c.key] = true; } });
    return out;
  }
  // recordsFromGrid(grid) → { records, headerRow, missing, unknown }: the header row is the one of the top 30 rows that names the most
  // known columns (at least 2), so title rows, notes or a merged group row above the real column names ("Receiver" over "Name | Contact")
  // are skipped.
  const HEADER_SEARCH = 30;
  function recordsFromGrid(grid) {
    const rows = (grid || []).map(r => (r || []).map(c => c == null ? '' : c));
    let hi = -1, keys = null, best = 1;
    for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH); i++) { const k = mapHeaders(rows[i].map(cellText)); const n = k.filter(Boolean).length; if (n > best) { hi = i; keys = k; best = n; } }
    if (hi < 0) return { records: [], headerRow: -1, missing: REQUIRED_COLUMNS.slice(), unknown: [] };
    const present = keys.filter(Boolean);
    const unknown = rows[hi].map(cellText).filter((h, i) => h && !keys[i]);
    const records = [];
    rows.slice(hi + 1).forEach((r, n) => {
      if (!r.some(c => cellText(c))) return;
      const rec = { _line: hi + n + 2 };
      keys.forEach((k, i) => { if (k) rec[k] = r[i] == null ? '' : r[i]; });
      records.push(rec);
    });
    return { records, headerRow: hi, missing: REQUIRED_COLUMNS.filter(k => present.indexOf(k) < 0), unknown };
  }
  // parseDelimited(text) → grid; handles quotes, commas, tabs (pasted from a spreadsheet) and semicolons.
  function parseDelimited(text) {
    const lines = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
    if (!lines.length) return [];
    const delim = lines[0].indexOf('\t') >= 0 ? '\t' : (lines[0].indexOf(';') >= 0 && lines[0].indexOf(',') < 0 ? ';' : ',');
    return lines.map(line => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else if (c === '"') q = true; else if (c === delim) { out.push(cur); cur = ''; } else cur += c;
      }
      out.push(cur);
      return out.map(x => x.trim());
    });
  }

  // SheetJS loads on demand (docs/CDN.md): one <script> tag with the pinned version and SRI hash.
  let xlsxPromise = null;
  function loadXLSX() {
    if (window.XLSX && window.XLSX.utils) return Promise.resolve(window.XLSX);
    if (xlsxPromise) return xlsxPromise;
    xlsxPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SHEETJS.src; s.integrity = SHEETJS.integrity; s.crossOrigin = 'anonymous'; s.dataset.lib = 'sheetjs';
      s.onload = () => { if (window.XLSX && window.XLSX.utils) resolve(window.XLSX); else { xlsxPromise = null; reject(new Error('xlsx_missing')); } };
      s.onerror = () => { xlsxPromise = null; s.remove(); reject(new Error('xlsx_load')); };
      document.head.appendChild(s);
    });
    return xlsxPromise;
  }
  // readFile(file) → Promise<grid>: .csv and .txt are read as text; .xlsx / .xls go through SheetJS (first sheet).
  async function readFile(file) {
    const name = String(file && file.name || '').toLowerCase();
    if (/\.(csv|txt|tsv)$/.test(name) || /^text\//.test(file.type || '')) return parseDelimited(await file.text());
    if (!/\.(xlsx|xls|xlsm)$/.test(name)) { const err = new Error('type'); err.code = 'type'; throw err; }
    const XLSX = await loadXLSX();
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    const sheetName = wb.SheetNames.find(n => norm(n) === 'orders') || wb.SheetNames[0];
    return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '', blankrows: false });
  }

  // Template: sheet "Orders" (header + two example rows) and sheet "Allowed values".
  async function downloadTemplate(acc, settings) {
    const XLSX = await loadXLSX();
    const tiers = MDM.pricing.accountTiers(acc, settings);
    const t1 = tiers[0] || { label: 'Small' }, t2 = tiers[1] || t1;
    const today = MDM.ui.dayKey();
    const example = [
      { name: 'Aishath Nadha', phone: '7720001', address: 'Amin Avenue, Block B, Apt 4-02', zone: 'Hulhumalé Phase 1', landmark: 'Opposite the mosque', tier: t1.label, method: 'Home', cod: 350, instructions: 'Call before arriving', reference: 'ORD-1001', description: 'Clothing' },
      { name: 'Hassan Nimal', phone: '7720006', address: 'Ma. Fehi Villa', tier: t2.label, method: 'Boat', island: 'Thulusdhoo, Kaafu Atoll', vesselType: 'Speedboat', boatName: 'Thulusdhoo Express', departureDate: today, departureTime: '17:00', jetty: (MDM.geo.jetties().find(j => j.value === 'male_jetties') || {}).label || 'Malé jetties 1 to 5 (speedboats)', cod: 0, instructions: 'Hand to the captain', reference: 'ORD-1002', description: 'Shoes' },
    ];
    const orders = [COLUMNS.map(c => c.label)].concat(example.map(r => COLUMNS.map(c => r[c.key] == null ? '' : r[c.key])));
    const ws = XLSX.utils.aoa_to_sheet(orders);
    ws['!cols'] = COLUMNS.map(c => ({ wch: Math.max(14, c.label.length + 4) }));
    const lists = [
      ['Package size', tiers.map(t => t.label + ' (' + t.hint + ', ' + MDM.pricing.format(t.rate) + ')')],
      ['Area', zoneOptions().map(o => o.label)],
      ['Delivery method', ['Home', 'Boat', 'Cargo', 'Airport']],
      ['Vessel type', ['Boat', 'Ferry', 'Speedboat']],
      ['Jetty', jettyOptions().map(o => o.label)],
      ['Airport counter', airportOptions().map(o => o.label).concat(['or the resort counter name'])],
    ];
    const depth = Math.max(...lists.map(l => l[1].length));
    const aoa = [lists.map(l => l[0])];
    for (let i = 0; i < depth; i++) aoa.push(lists.map(l => l[1][i] || ''));
    aoa.push([], ['Delivery method: Home needs the delivery address and area. Boat needs the destination island, boat name, departure date and time, and the jetty. Cargo needs the destination island (Maldivian Cargo fee ' + MDM.pricing.format(((settings || {}).rates || {}).cargo) + '). Airport takes the counter, resort and resort speedboat.']);
    aoa.push(['Cash to collect: the amount the driver collects from the receiver, numbers only. Leave it empty when the order is paid.']);
    const ws2 = XLSX.utils.aoa_to_sheet(aoa);
    ws2['!cols'] = lists.map(() => ({ wch: 34 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Orders');
    XLSX.utils.book_append_sheet(wb, ws2, 'Allowed values');
    XLSX.writeFile(wb, 'mr-delivery-man-bulk-orders.xlsx');
  }

  MDM.bizKit = {
    norm, COLUMNS, REQUIRED_COLUMNS, METHOD_FIELDS, METHOD_SHORT, uses, fieldLabel,
    airportZone, zoneOptions, jettyOptions, airportOptions, vesselOptions, methodOptions, tierOptions,
    parseZone, parseMethod, parseVessel, parseTier, parseJetty, parseAirportPoint, parseTime, parseDate, parseMoney,
    blankRow, filled, rowFromCells, validateRow, delivery, toBatchRow, quoteRow,
    mapHeaders, recordsFromGrid, parseDelimited, loadXLSX, readFile, downloadTemplate,
  };
})(window.MDM);

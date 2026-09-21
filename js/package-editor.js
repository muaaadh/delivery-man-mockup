// Shared package editor (SPEC §3.2 Step 1; contract at the end of docs/BUILDERS.md). Used by /request/ and the admin "New order"
// drawer, so it is self-contained: base.css components only, no page layout, no store calls. Prices on the size options come from
// MDM.pricing.sizePriceLabel and follow the chosen zones live. Segmented option test ids sit on the <label> (the radio itself is
// .sr-only and cannot be clicked by an automated pointer); the radio is its first child.
(function (MDM) { 'use strict';
  const SIZES = ['bag', 'box', 'xl'];
  const UNAVAILABLE = [{ value: 'call', label: 'Call me' }, { value: 'skip', label: 'Skip it' }, { value: 'closest', label: 'Buy the closest match' }];
  const AIRPORT_ADDRESS = 'Velana International Airport';
  let seq = 0;
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const trim = v => String(v == null ? '' : v).trim();

  // create(opts) → { el, validate(), getValue(), focus(), destroy() }; see BUILDERS.md for opts.
  function create(opts) {
    opts = opts || {};
    const { el, setError, phone } = MDM.ui;
    const settings = opts.settings || {};
    const rates = settings.rates || {};
    const service = opts.service === 'shop' ? 'shop' : opts.service === 'business' ? 'business' : 'pick';
    const value = opts.value ? clone(opts.value) : null;
    const first = opts.first && opts.first.dropoff ? clone(opts.first) : null;
    const me = opts.me && trim(opts.me.phone) ? { name: trim(opts.me.name), phone: trim(opts.me.phone) } : null;
    const savedAddresses = Array.isArray(opts.savedAddresses) ? opts.savedAddresses.filter(a => a && a.address) : [];
    const uid = 'pe' + (++seq);
    const id = k => uid + '-' + k;
    const dirty = new Set(), shown = new Set();   // pristine fields never show errors: validate on blur once edited, live once shown
    const fields = {};              // key → { wrap, control, rule() → message|null, when() → bool }
    const zoneOptions = MDM.geo.zoneOptions();
    const terminals = MDM.geo.terminals();
    const airportPoints = MDM.geo.airportPoints();
    const meetAtOptions = MDM.geo.meetAtOptions();
    const sameAsMe = v => !!me && v && trim(v.phone) === me.phone && trim(v.name) === me.name;

    // ---- control builders (base.css .field / .input / .select / .textarea / .checkbox / .segmented) ----
    function reg(key, wrap, control, rule, when) { fields[key] = { wrap, control, rule: rule || null, when: when || (() => true) }; return wrap; }
    function field(key, label, control, o) {
      o = o || {};
      const wrap = el('div', { class: 'field', 'data-field': key },
        el('label', { for: control.id }, label, o.optional ? el('span', { class: 'optional' }, ' (optional)') : null),
        control,
        o.hint ? el('div', { class: 'field__hint', id: control.id + '-hint' }, o.hint) : null);
      if (o.hint) control.setAttribute('aria-describedby', control.id + '-hint');
      return reg(key, wrap, control, o.rule, o.when);
    }
    function input(key, attrs) {
      return el('input', Object.assign({ class: 'input', id: id(key), name: id(key), type: 'text', 'data-testid': 'package-' + key, autocomplete: 'off' }, attrs || {}));
    }
    function select(key, options, attrs) {
      return el('select', Object.assign({ class: 'select', id: id(key), name: id(key), 'data-testid': 'package-' + key }, attrs || {}),
        options.map(o => el('option', { value: o.value }, o.label)));
    }
    function textarea(key, attrs) {
      return el('textarea', Object.assign({ class: 'textarea', id: id(key), name: id(key), rows: 3, 'data-testid': 'package-' + key }, attrs || {}));
    }
    function checkbox(key, label, checked, hint) {
      const c = el('input', { type: 'checkbox', id: id(key), name: id(key), 'data-testid': 'package-' + key, checked: !!checked });
      const wrap = el('label', { class: 'checkbox', for: id(key) }, c, el('span', null, label, hint ? el('span', { class: 'hint' }, hint) : null));
      fields[key] = { wrap, control: c, rule: null, when: () => true };
      return { input: c, el: wrap };
    }
    function segmented(key, label, options, current, o) {
      o = o || {};
      const name = id(key);
      const fs = el('fieldset', { class: 'segmented', id: name, 'data-testid': 'package-' + key, 'aria-labelledby': name + '-label' },
        options.map(opt => el('label', { class: 'segmented__option', 'data-testid': 'package-' + key + '-' + opt.value, 'data-value': opt.value },
          el('input', { class: 'sr-only', type: 'radio', name, value: opt.value, checked: opt.value === current }),
          el('span', { class: 'segmented__text' }, opt.label))));
      const wrap = el('div', { class: 'field', 'data-field': key },
        el('span', { class: 'field__label', id: name + '-label' }, label),
        fs,
        o.hint != null ? el('div', { class: 'field__hint' }, o.hint) : null);
      reg(key, wrap, fs, o.rule, o.when);
      return { el: wrap, fieldset: fs, value: () => { const c = fs.querySelector('input:checked'); return c ? c.value : null; },
        setLabel: (v, text) => { const l = fs.querySelector('label[data-value="' + v + '"] .segmented__text'); if (l) l.textContent = text; },
        hint: wrap.querySelector('.field__hint') };
    }
    const heading = text => el('h3', null, text);

    // ---- cargo / airport / address variants for one endpoint ("pickup" | "dropoff") ----
    function endpoint(kind, initial, o) {
      o = o || {};
      const cur = initial || {};
      const cargo0 = cur.cargo || null;
      const isPickup = kind === 'pickup';
      const zoneKey = kind + '-zone', addrKey = kind + '-address';
      const parts = {};
      const block = el('div', { class: 'stack-4', 'data-endpoint': kind });

      if (savedAddresses.length) {
        const sel = select(kind + '-saved', [{ value: '', label: 'Choose a saved address' }].concat(savedAddresses.map((a, i) => ({ value: String(i), label: (a.label ? a.label + ' · ' : '') + a.address }))));
        block.append(field(kind + '-saved', 'Use a saved address', sel, { optional: true }));
        sel.addEventListener('change', () => {
          const a = savedAddresses[Number(sel.value)];
          if (!a) return;
          parts.address.value = a.address || ''; parts.zone.value = a.zone && zoneOptions.some(z => z.value === a.zone) ? a.zone : 'male';
          if (!isPickup && a.meetAt && parts.meetAt && meetAtOptions.some(m => m.value === a.meetAt)) parts.meetAt.value = a.meetAt;
          parts.cargo.input.checked = false;
          sync(); setError(fields[addrKey].wrap, null); setError(fields[zoneKey].wrap, null); onZone();
        });
      }

      parts.cargo = checkbox(kind + '-cargo', 'Cargo boat or terminal', !!cargo0);
      block.append(parts.cargo.el);

      parts.address = input(addrKey, { autocomplete: 'street-address', value: cur.address && !cargo0 && cur.zone !== 'airport' ? cur.address : '', placeholder: isPickup ? 'M. Kaneerumaage, 2nd floor, Majeedhee Magu' : 'Hiyaa Tower 5, Apt 14-03' });
      parts.zone = select(zoneKey, zoneOptions, { value: cur.zone && zoneOptions.some(z => z.value === cur.zone) ? cur.zone : (cargo0 && cargo0.terminal ? (terminals.find(t => t.value === cargo0.terminal) || {}).zone || 'male' : 'male') });
      const addrField = field(addrKey, isPickup ? 'Pickup address' : 'Drop-off address', parts.address, { rule: () => (parts.cargo.input.checked || parts.zone.value === 'airport' || trim(parts.address.value)) ? null : ('Enter the ' + (isPickup ? 'pickup' : 'drop-off') + ' address') });
      const zoneField = field(zoneKey, 'Zone', parts.zone);
      block.append(el('div', { class: 'grid-2' }, addrField, zoneField));

      parts.landmark = input(kind + '-landmark', { value: cur.landmark || '', placeholder: 'Near the STO shop, blue gate' });
      block.append(field(kind + '-landmark', 'Landmark or instructions', parts.landmark, { optional: true }));

      // Cargo: terminal replaces the address; boat, expected time, consignee, receipt number.
      parts.terminal = select(kind + '-terminal', [{ value: '', label: 'Choose a terminal' }].concat(terminals.map(t => ({ value: t.value, label: t.label }))), { value: cargo0 ? cargo0.terminal || '' : '' });
      parts.boat = input(kind + '-boat', { value: cargo0 ? cargo0.boat || '' : '', placeholder: 'Alihaa Express' });
      parts.time = input(kind + '-time', { type: 'time', value: cargo0 ? cargo0.time || '' : '' });
      parts.consignee = input(kind + '-consignee', { value: cargo0 ? cargo0.consignee || '' : '', autocomplete: 'name', placeholder: 'Hassan Ziyad, Thoddoo' });
      parts.receiptNo = input(kind + '-receipt-no', { value: cargo0 ? cargo0.receiptNo || '' : '' });
      const cargoOn = () => parts.cargo.input.checked;
      parts.cargoBlock = el('div', { class: 'stack-4', 'data-cargo': kind },
        el('div', { class: 'grid-2' },
          field(kind + '-terminal', 'Terminal', parts.terminal, { rule: () => parts.terminal.value ? null : 'Choose a terminal', when: cargoOn }),
          field(kind + '-boat', 'Boat name', parts.boat, { rule: () => trim(parts.boat.value) ? null : 'Enter the boat name', when: cargoOn })),
        el('div', { class: 'grid-2' },
          field(kind + '-time', isPickup ? 'Expected arrival time' : 'Boat leaves at', parts.time, { optional: true }),
          field(kind + '-consignee', 'Consignee name as written on the cargo', parts.consignee, { rule: () => trim(parts.consignee.value) ? null : 'Enter the name written on the cargo', when: cargoOn })),
        field(kind + '-receipt-no', 'Cargo receipt no.', parts.receiptNo, { optional: true }));
      block.append(parts.cargoBlock);
      parts.terminal.addEventListener('change', () => {
        const t = terminals.find(x => x.value === parts.terminal.value);
        if (t && t.zone) { parts.zone.value = t.zone; onZone(); }
      });

      // Airport zone: a meeting point replaces the address.
      parts.meet = select(kind + '-meet', [{ value: '', label: 'Choose a meeting point' }].concat(airportPoints.map(p => ({ value: p.value, label: p.label }))), { value: cur.zone === 'airport' && cur.meetAt && airportPoints.some(p => p.value === cur.meetAt) ? cur.meetAt : '' });
      parts.meetField = field(kind + '-meet', 'Meeting point', parts.meet, { rule: () => parts.meet.value ? null : 'Choose a meeting point', when: () => parts.zone.value === 'airport' && !cargoOn() });
      block.append(parts.meetField);

      if (!isPickup) {
        parts.meetAt = select('dropoff-meetat', meetAtOptions, { value: cur.meetAt && meetAtOptions.some(m => m.value === cur.meetAt) ? cur.meetAt : 'door' });
        parts.meetAtField = field('dropoff-meetat', 'Meet at', parts.meetAt);
        block.append(parts.meetAtField);
      }

      // Contact (pickup) or recipient (drop-off).
      const personKey = isPickup ? 'pickup-contact' : 'dropoff-recipient';
      const person0 = isPickup ? cur.contact : cur.recipient;
      const selfChecked = initial ? (person0 == null || sameAsMe(person0)) : true;
      parts.self = checkbox(personKey + '-me', isPickup ? 'Same as me' : 'Deliver to me', selfChecked, isPickup ? 'The rider calls this number at pickup' : 'The rider calls this number at the door');
      parts.name = input(personKey + '-name', { value: person0 && !sameAsMe(person0) ? person0.name || '' : '', autocomplete: 'name' });
      parts.phone = input(personKey + '-phone', { type: 'tel', inputmode: 'numeric', autocomplete: 'tel', value: person0 && !sameAsMe(person0) ? person0.phone || '' : '', placeholder: '7XX XXXX' });
      const personOn = () => !parts.self.input.checked;
      const intl = () => parts.zone.value === 'airport';
      parts.personBlock = el('div', { class: 'grid-2', 'data-person': kind },
        field(personKey + '-name', isPickup ? 'Contact name' : 'Recipient name', parts.name, { rule: () => trim(parts.name.value) ? null : ('Enter the ' + (isPickup ? "contact's" : "recipient's") + ' name'), when: personOn }),
        field(personKey + '-phone', isPickup ? 'Contact mobile' : 'Recipient mobile', parts.phone, { rule: () => phone.valid(parts.phone.value, { intl: intl() }) ? null : (intl() ? 'Enter a mobile number, overseas numbers start with +' : 'Enter a Maldivian mobile number, 7 digits starting with 7 or 9'), when: personOn }));
      block.append(heading4(isPickup ? 'Who hands it over' : 'Who receives it'), parts.self.el, parts.personBlock);

      function sync() {
        const cargo = cargoOn(), airport = parts.zone.value === 'airport' && !cargo;
        addrField.hidden = cargo || airport;
        parts.cargoBlock.hidden = !cargo;
        parts.meetField.hidden = !airport;
        if (parts.meetAtField) parts.meetAtField.hidden = cargo || airport;
        parts.personBlock.hidden = !personOn();
      }
      function onZone() { sync(); if (o.onZone) o.onZone(); }
      parts.cargo.input.addEventListener('change', onZone);
      parts.zone.addEventListener('change', onZone);
      parts.self.input.addEventListener('change', sync);
      sync();

      function read() {
        const cargo = cargoOn();
        const zone = parts.zone.value || 'male';
        const airport = zone === 'airport' && !cargo;
        const term = terminals.find(t => t.value === parts.terminal.value);
        const meet = airportPoints.find(p => p.value === parts.meet.value);
        const address = cargo ? ((term ? term.label : '') + (trim(parts.boat.value) ? ', boat ' + trim(parts.boat.value) : ''))
          : airport ? (AIRPORT_ADDRESS + (meet ? ', ' + meet.label : '')) : trim(parts.address.value);
        const person = personOn() ? { name: trim(parts.name.value), phone: phone.normalize(parts.phone.value) || trim(parts.phone.value) } : (me ? { name: me.name, phone: me.phone } : null);
        const out = {
          address, zone, landmark: trim(parts.landmark.value),
          cargo: cargo ? { terminal: parts.terminal.value, boat: trim(parts.boat.value), time: trim(parts.time.value), consignee: trim(parts.consignee.value), receiptNo: trim(parts.receiptNo.value) } : null,
          meetAt: airport ? parts.meet.value : (!isPickup && !cargo && parts.meetAt ? parts.meetAt.value : ''),
        };
        if (isPickup) out.contact = person; else out.recipient = person;
        return out;
      }
      return { el: block, parts, read, zone: () => parts.zone.value || 'male', sync };
    }
    function heading4(text) { return el('h4', null, text); }

    // ---- assemble ----
    const root = el('div', { class: 'card', 'data-testid': 'package-editor', 'data-mode': value ? 'edit' : 'add' });
    const body = el('div', { class: 'card__body stack-4' });
    const title = value ? 'Edit package' : 'New package';
    root.append(el('div', { class: 'card__header' }, el('h3', null, title)), body);

    let shop = null, pickup = null, dropoff = null, sizeSeg = null, unavailableSeg = null;
    let descriptionEl = null, vehicle = null, fragile = null, underOneFt = null, notesEl = null, sameAsFirst = null, budgetEl = null, budgetHint = null;

    if (service === 'shop') {
      const s0 = (value && value.shop) || {};
      shop = {};
      shop.name = input('shop-name', { value: s0.name || '', placeholder: 'STO People\'s Choice' });
      shop.zone = select('shop-zone', zoneOptions, { value: s0.zone && zoneOptions.some(z => z.value === s0.zone) ? s0.zone : 'male' });
      shop.address = input('shop-address', { value: s0.address || '', autocomplete: 'street-address', placeholder: 'Boduthakurufaanu Magu' });
      shop.list = textarea('shop-list', { rows: 4, value: s0.list || '', placeholder: '2 kg rice, 12 eggs, 1 L cooking oil' });
      budgetEl = input('budget', { inputmode: 'decimal', value: s0.budget != null ? String(s0.budget) : '', placeholder: '450' });
      body.append(heading('The shop'),
        el('div', { class: 'grid-2' },
          field('shop-name', 'Shop name', shop.name, { rule: () => trim(shop.name.value) ? null : 'Enter the shop name' }),
          field('shop-zone', 'Shop zone', shop.zone)),
        field('shop-address', 'Shop address or landmark', shop.address, { optional: true }),
        field('shop-list', 'Shopping list', shop.list, { rule: () => trim(shop.list.value) ? null : 'Tell us what to buy' }));
      const budgetField = field('budget', 'Budget', el('div', { class: 'input-affix' }, el('span', { class: 'input-affix__prefix' }, 'MVR'), budgetEl), {
        rule: () => { const n = Number(trim(budgetEl.value)); return trim(budgetEl.value) === '' || isNaN(n) ? 'Enter a budget in MVR' : n <= 0 ? 'Enter an amount above 0' : null; } });
      budgetField.querySelector('label').setAttribute('for', budgetEl.id);
      fields.budget.control = budgetEl;
      budgetHint = el('div', { class: 'field__hint' }, '');
      budgetField.append(budgetHint);
      body.append(budgetField);
      unavailableSeg = segmented('unavailable', 'If something is unavailable', UNAVAILABLE, UNAVAILABLE.some(u => u.value === s0.unavailable) ? s0.unavailable : 'call');
      body.append(unavailableSeg.el);
    }

    // Size with live prices.
    sizeSeg = segmented('size', service === 'shop' ? 'Expected package size' : 'Size', SIZES.map(s => ({ value: s, label: '' })), value && SIZES.includes(value.size) ? value.size : 'bag', { hint: '' });
    body.append(sizeSeg.el);

    if (service !== 'shop') {
      descriptionEl = input('description', { value: value ? value.description || '' : '', placeholder: 'Documents in an envelope', maxlength: 120 });
      body.append(field('description', 'What is it', descriptionEl, { rule: () => trim(descriptionEl.value) ? null : 'Tell us what the package is' }));
    } else {
      descriptionEl = input('description', { value: value ? value.description || '' : '', placeholder: 'Groceries for the week', maxlength: 120 });
      body.append(field('description', 'Name this run', descriptionEl, { optional: true, hint: 'Shown on your order, for example Groceries' }));
    }

    if (service === 'business') {
      underOneFt = checkbox('under-one-ft', 'Under 1 ft', value ? value.underOneFt !== false : true, 'Business rate applies within Malé and Hulhumalé');
      body.append(underOneFt.el);
    }
    vehicle = checkbox('vehicle', 'Too big or heavy for a bike', value ? !!value.needsVehicle : false, 'We confirm the vehicle charge before dispatch');
    fragile = checkbox('fragile', 'Fragile', value ? !!value.fragile : false);
    body.append(el('div', { class: 'grid-2' }, vehicle.el, fragile.el));

    if (service !== 'shop') {
      pickup = endpoint('pickup', value ? value.pickup : null, { onZone: refreshPrices });
      body.append(heading('Pickup'), pickup.el);
    }

    // Drop-off, optionally copied from package 1.
    const dropHead = heading('Drop-off');
    body.append(dropHead);
    if (first) {
      const same0 = value ? JSON.stringify(value.dropoff || null) === JSON.stringify(first.dropoff) : true;
      sameAsFirst = checkbox('dropoff-same-as-first', 'Same drop-off and recipient as package 1', same0, first.dropoff.address || '');
      body.append(sameAsFirst.el);
    }
    dropoff = endpoint('dropoff', value && !(sameAsFirst && sameAsFirst.input.checked) ? value.dropoff : null, { onZone: refreshPrices });
    body.append(dropoff.el);
    if (sameAsFirst) {
      const syncSame = () => { dropoff.el.hidden = sameAsFirst.input.checked; refreshPrices(); };
      sameAsFirst.input.addEventListener('change', syncSame);
      syncSame();
    }

    notesEl = textarea('notes', { rows: 2, value: value ? value.notes || '' : '', placeholder: 'Ring the bell twice, the lift is slow' });
    body.append(field('notes', 'Notes for the rider', notesEl, { optional: true }));

    const saveBtn = el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'package-save' }, value ? 'Save changes' : 'Save package');
    const cancelBtn = el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'package-cancel' }, 'Cancel');
    root.append(el('div', { class: 'card__footer' }, cancelBtn, saveBtn));

    // ---- live prices and hints ----
    function pickupZone() { return service === 'shop' ? (shop.zone.value || 'male') : pickup.zone(); }
    function dropZone() { return sameAsFirst && sameAsFirst.input.checked ? (first.dropoff.zone || 'male') : dropoff.zone(); }
    function refreshPrices() {
      const pz = pickupZone(), dz = dropZone();
      SIZES.forEach(s => {
        let price = MDM.pricing.sizePriceLabel(s, pz, dz, settings);
        if (service === 'business' && underOneFt && underOneFt.input.checked && ['male', 'hulhumale'].includes(MDM.geo.island(pz)) && ['male', 'hulhumale'].includes(MDM.geo.island(dz))) price = MDM.pricing.format(rates.business);
        sizeSeg.setLabel(s, MDM.pricing.sizeLabel(s) + ' · ' + price);
      });
      const guide = (settings.sizeGuide || {})[sizeSeg.value() || 'bag'] || '';
      if (sizeSeg.hint) sizeSeg.hint.textContent = guide;
      if (budgetHint) {
        const n = Math.round(Number(trim(budgetEl.value)) || 0);
        const pct = Number(rates.shoppingPct) || 0;
        budgetHint.textContent = 'Shopping fee ' + pct + '% · ' + MDM.pricing.format(Math.round(n * pct / 100));
      }
    }
    sizeSeg.fieldset.addEventListener('change', refreshPrices);
    if (shop) shop.zone.addEventListener('change', refreshPrices);
    if (budgetEl) budgetEl.addEventListener('input', refreshPrices);
    if (underOneFt) underOneFt.input.addEventListener('change', refreshPrices);
    refreshPrices();

    // ---- validation: on blur once edited, on save for everything ----
    function check(key) {
      const f = fields[key];
      if (!f || !f.rule) return null;
      // A field inside a hidden block (cargo, meeting point, contact, a mirrored drop-off) is not part of this package.
      const msg = f.when() && !f.wrap.closest('[hidden]') ? f.rule() : null;
      setError(f.wrap, msg);
      return msg;
    }
    const fieldOf = e => (e.target && e.target.closest ? e.target.closest('.field[data-field]') : null);
    root.addEventListener('focusout', e => {
      const wrap = fieldOf(e);
      if (!wrap || !root.contains(wrap) || !dirty.has(wrap.dataset.field)) return;
      shown.add(wrap.dataset.field);
      check(wrap.dataset.field);
    });
    root.addEventListener('input', e => {
      const wrap = fieldOf(e);
      if (!wrap) return;
      dirty.add(wrap.dataset.field);
      if (shown.has(wrap.dataset.field)) check(wrap.dataset.field);
    });
    root.addEventListener('change', e => {
      const wrap = fieldOf(e);
      if (!wrap) return;
      dirty.add(wrap.dataset.field);
      if (shown.has(wrap.dataset.field)) check(wrap.dataset.field);
    });
    root.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio') { e.preventDefault(); save(); }
    });
    function validate() {
      let first_ = null;
      Object.keys(fields).forEach(k => { shown.add(k); if (check(k) && !first_) first_ = fields[k]; });
      if (first_) { MDM.ui.focusFirstInvalid(root); return false; }
      return true;
    }
    function getValue() {
      const pkg = {
        id: value && value.id ? value.id : MDM.id('pkg'),
        size: sizeSeg.value() || 'bag',
        description: trim(descriptionEl.value),
        needsVehicle: vehicle.input.checked,
        fragile: fragile.input.checked,
        pickup: service === 'shop' ? null : pickup.read(),
        dropoff: sameAsFirst && sameAsFirst.input.checked ? clone(first.dropoff) : dropoff.read(),
        shop: service === 'shop' ? { name: trim(shop.name.value), zone: shop.zone.value || 'male', address: trim(shop.address.value), list: trim(shop.list.value), budget: Math.round(Number(trim(budgetEl.value)) || 0), unavailable: unavailableSeg.value() || 'call' } : null,
        notes: trim(notesEl.value),
      };
      if (service === 'business') pkg.underOneFt = underOneFt.input.checked;
      if (service === 'shop' && !pkg.description) pkg.description = 'Shopping at ' + pkg.shop.name;
      return pkg;
    }
    function save() { if (!validate()) return; if (typeof opts.onSave === 'function') opts.onSave(getValue()); }
    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', () => { if (typeof opts.onCancel === 'function') opts.onCancel(); });
    function focus() {
      const f = service === 'shop' ? shop.name : descriptionEl;
      try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); }
    }
    function destroy() { root.remove(); }

    return { el: root, validate, getValue, focus, destroy, save };
  }

  // summary(pkg, service) → { title, description, pickupLabel ('Pickup' | 'Shop'), pickupLine, pickupZone, dropoffLine, dropoffZone, flags }
  function summary(pkg, service) {
    pkg = pkg || {};
    service = service || 'pick';
    const flags = [];
    if (pkg.fragile) flags.push('Fragile');
    if (pkg.needsVehicle) flags.push('Vehicle');
    if (service === 'business' && pkg.underOneFt === false) flags.push('Over 1 ft');
    const line = end => {
      if (!end) return '';
      if (end.cargo && end.cargo.terminal) {
        const t = MDM.geo.terminals().find(x => x.value === end.cargo.terminal);
        return (t ? t.label : end.address || '') + (end.cargo.boat ? ', boat ' + end.cargo.boat : '');
      }
      return end.address || '';
    };
    const zoneOf = end => (!end || end.zone === 'airport') ? '' : MDM.geo.zoneLabel(end.zone || 'male');   // the airport line already names it
    let pickupLine, pickupZone;
    const shop = service === 'shop' && !!pkg.shop;
    if (shop) { pickupLine = (pkg.shop.name || '') + (pkg.shop.address ? ', ' + pkg.shop.address : ''); pickupZone = MDM.geo.zoneLabel(pkg.shop.zone || 'male'); }
    else { pickupLine = line(pkg.pickup); pickupZone = zoneOf(pkg.pickup); }
    return {
      title: MDM.pricing.lineLabel(pkg, service),
      description: pkg.description || '',
      pickupLabel: shop ? 'Shop' : 'Pickup', pickupLine, pickupZone,
      dropoffLine: line(pkg.dropoff), dropoffZone: zoneOf(pkg.dropoff),
      flags,
    };
  }

  MDM.packageEditor = { create, summary };
})(window.MDM);

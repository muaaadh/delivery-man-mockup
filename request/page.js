// Request a delivery (client requirements §3, §5, §6, §12): six steps in one form.
//   1 Service: request type (home, shop, postal, airport, office) with its own fields, and normal / express / advance timing
//   2 Collection: address, zone, landmark, contact, instructions (postal and airport types fill this in for you)
//   3 Packages: quantity per size with a live estimated range, optional dimensions and a package photo per size
//   4 Delivery: address, zone (airport areas included), recipient, instructions
//   5 Your details: name, phone, how we message you, pay after delivery or upfront
//   6 Review, then one MDM.store.createOrder() call. The operator confirms the final price before collection.
// The draft lives in sessionStorage so a reload keeps it; uploaded photos and documents go into the `files` collection at once.
(function (MDM) { 'use strict';
  const { el, html, setError, phone } = MDM.ui;
  const DRAFT_KEY = 'mdm:request:v2', ME_KEY = 'mdm:me';
  const STEPS = [{ n: 1, label: 'Service' }, { n: 2, label: 'Collection' }, { n: 3, label: 'Packages' }, { n: 4, label: 'Delivery' }, { n: 5, label: 'Your details' }, { n: 6, label: 'Review' }];
  const SIZES = ['bag', 'box', 'xl'];
  const MAX_PER_SIZE = 20;
  const NOTIFY = [{ value: 'whatsapp', label: 'WhatsApp' }, { value: 'sms', label: 'SMS' }, { value: 'viber', label: 'Viber' }, { value: 'email', label: 'Email' }];
  const COURIERS = ['FedEx', 'CPEX', 'PDU', 'UPS', 'Aramex', 'Other courier'];
  const SHOP_PROOF = [{ value: 'invoice', label: 'Invoice', hint: 'Upload the shop invoice' }, { value: 'quotation', label: 'Quotation', hint: 'Quotation and your payment slip' }, { value: 'order_no', label: 'Order number', hint: 'The shop gave you a number' }];
  const UNAVAILABLE = [{ value: 'call', label: 'Call me' }, { value: 'closest', label: 'Get the closest match' }, { value: 'skip', label: 'Skip it' }];
  const DOC_KIND = { collection_doc: 'Collection document', invoice: 'Shop invoice', quotation: 'Quotation', payment_slip: 'Payment slip', document: 'Document' };
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const trim = v => String(v == null ? '' : v).trim();
  const fmt = n => MDM.pricing.format(n);

  const dom = { steps: {} };
  let settings = {};
  let draft = emptyDraft();
  let step = 1;
  let me = null, savedAddresses = [], submitting = false;
  let checks = {};   // step → [{ wrap, check() → message|null, focus() }]

  // ---- Draft -----------------------------------------------------------------------------------------------------------------
  function emptyDraft() {
    const size = () => ({ l: '', w: '', h: '', kg: '', photoId: null, photoName: '' });
    return {
      type: 'home', level: 'normal',
      schedule: { collectDate: '', collectTime: '', deliverDate: '', deliverTime: '' },
      details: { carrier: '', courierName: '', location: '', postOffice: '', mode: 'collect', area: 'arrivals', proof: 'invoice', task: 'submit', unavailable: 'call', bags: '1' },
      docs: [],
      collection: { address: '', zone: 'male', landmark: '', contactName: '', contactPhone: '', instructions: '', auto: false },
      counts: { bag: 1, box: 0, xl: 0 }, sizes: { bag: size(), box: size(), xl: size() },
      description: '', fragile: false, vehicle: false,
      delivery: { address: '', zone: 'male', landmark: '', recipientName: '', recipientPhone: '', instructions: '', meetAt: 'door', self: false, auto: false },
      customer: { name: '', phone: '', email: '', notify: 'whatsapp' },
      pay: 'after', remember: true,
    };
  }
  function loadDraft() {
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
      if (d && typeof d === 'object') {
        const base = emptyDraft();
        ['schedule', 'details', 'collection', 'counts', 'delivery', 'customer'].forEach(k => { base[k] = Object.assign(base[k], d[k] || {}); });
        SIZES.forEach(s => { base.sizes[s] = Object.assign(base.sizes[s], (d.sizes || {})[s] || {}); });
        ['type', 'level', 'description', 'fragile', 'vehicle', 'pay', 'remember'].forEach(k => { if (d[k] != null) base[k] = d[k]; });
        base.docs = Array.isArray(d.docs) ? d.docs : [];
        return base;
      }
    } catch (e) { /* no draft or unreadable */ }
    return emptyDraft();
  }
  function saveDraft() { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (e) { /* private mode: the form still works on this page view */ } }
  function clearDraft() { try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* nothing to clear */ } }
  function loadMe() { try { const m = JSON.parse(localStorage.getItem(ME_KEY)); return m && m.phone ? m : null; } catch (e) { return null; } }
  function getPath(path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), draft); }
  function setPath(path, v) { const keys = path.split('.'); const last = keys.pop(); const obj = keys.reduce((o, k) => o[k], draft); obj[last] = v; }

  // ---- Type rules ---------------------------------------------------------------------------------------------------------------
  const typeOf = () => MDM.REQUEST_TYPES.find(t => t.value === draft.type) || MDM.REQUEST_TYPES[0];
  const service = () => draft.type === 'shop_buy' ? 'shop' : 'pick';
  const carrier = () => MDM.CARRIERS.find(c => c.value === draft.details.carrier) || null;
  const airportCollect = () => draft.type === 'airport' && draft.details.mode === 'collect';
  const airportDeliver = () => draft.type === 'airport' && draft.details.mode !== 'collect';
  const areaLabel = v => ((MDM.geo.airportPoints().find(p => p.value === v) || {}).label) || 'Airport';
  // The collection end that a postal or airport type dictates: { address, zone, contactName } or null.
  function dictatedCollection() {
    const d = draft.details;
    if (draft.type === 'postal' && carrier()) {
      const c = carrier();
      if (c.value === 'pikpost') { const loc = MDM.PIKPOST_LOCATIONS.find(x => x.value === d.location); return loc ? { address: 'Pikpost locker, ' + loc.label, zone: loc.zone, contactName: 'Pikpost' } : null; }
      if (c.value === 'post_office') { const po = MDM.POST_OFFICES.find(x => x.value === d.postOffice); return po ? { address: po.label, zone: po.zone, contactName: 'Post collections counter' } : null; }
      if (c.value === 'courier') return { address: (d.courierName && d.courierName !== 'Other courier' ? d.courierName : 'Courier') + ' office, Malé', zone: 'male', contactName: d.courierName || 'Courier counter' };
      return { address: c.address, zone: c.zone, contactName: c.label };
    }
    if (airportCollect()) return { address: 'Velana International Airport, ' + areaLabel(d.area), zone: 'airport', contactName: d.passengerName || '' };
    return null;
  }
  function dictatedDelivery() {
    if (airportDeliver()) return { address: 'Velana International Airport, ' + areaLabel(draft.details.area), zone: 'airport' };
    return null;
  }
  // Fill (or release) the addresses that the type decides, keeping whatever the customer typed for the other types.
  function applyDictated() {
    const c = dictatedCollection(), dl = dictatedDelivery();
    if (c) { Object.assign(draft.collection, { address: c.address, zone: c.zone, auto: true }); if (!trim(draft.collection.contactName) || draft.collection.autoContact) { draft.collection.contactName = c.contactName; draft.collection.autoContact = true; } }
    else if (draft.collection.auto) { Object.assign(draft.collection, { address: '', zone: 'male', auto: false }); if (draft.collection.autoContact) { draft.collection.contactName = ''; draft.collection.autoContact = false; } }
    if (dl) Object.assign(draft.delivery, { address: dl.address, zone: dl.zone, auto: true });
    else if (draft.delivery.auto) Object.assign(draft.delivery, { address: '', zone: 'male', auto: false });
    if (draft.collection.zone === 'airport' && !airportCollect()) Object.assign(draft.collection, { zone: 'male' });
    if (draft.delivery.zone === 'airport' && !airportDeliver()) Object.assign(draft.delivery, { zone: 'male' });
  }

  // ---- Pricing -------------------------------------------------------------------------------------------------------------------
  const totalCount = () => SIZES.reduce((n, s) => n + (Number(draft.counts[s]) || 0), 0);
  function buildPackages(forPricing) {
    const c = draft.collection, d = draft.delivery, cust = draft.customer, det = draft.details;
    const pickup = { address: trim(c.address), zone: c.zone || 'male', landmark: trim(c.landmark), instructions: trim(c.instructions), contact: { name: trim(c.contactName) || trim(cust.name), phone: trim(c.contactPhone) || trim(cust.phone) }, meetAt: c.zone === 'airport' ? det.area : '' };
    const recipient = d.self ? { name: trim(cust.name), phone: trim(cust.phone) } : { name: trim(d.recipientName), phone: trim(d.recipientPhone) };
    const dropoff = { address: trim(d.address), zone: d.zone || 'male', landmark: trim(d.landmark), instructions: trim(d.instructions), recipient, meetAt: d.zone === 'airport' ? det.area : (d.meetAt || 'door') };
    const out = [];
    SIZES.forEach(size => {
      const n = Math.max(0, Math.min(MAX_PER_SIZE, Number(draft.counts[size]) || 0));
      const sz = draft.sizes[size] || {};
      const dims = sz.l && sz.w && sz.h ? { l: Number(sz.l), w: Number(sz.w), h: Number(sz.h) } : null;
      for (let i = 0; i < n; i++) {
        const shop = draft.type === 'shop_buy' && !out.length ? { name: trim(det.shopName), address: trim(c.address), zone: c.zone || 'male', list: trim(det.list), budget: Math.round(Number(det.budget) || 0), unavailable: det.unavailable || 'call', receiptTotal: null, receiptPhotoId: null } : null;
        out.push({ id: forPricing ? 'p' + out.length : MDM.id('pkg'), size, description: trim(draft.description), fragile: !!draft.fragile, needsVehicle: size === 'xl' && !!draft.vehicle, underOneFt: size !== 'xl',
          dims, weightKg: sz.kg ? Number(sz.kg) : null, photoId: sz.photoId || null, sizeSource: dims || sz.photoId ? 'customer' : 'estimate',
          pickup: clone(pickup), dropoff: clone(dropoff), shop, notes: '' });
      }
    });
    return out;
  }
  // estimate() → { min, max, exact, xl, budget } or null when no packages. The range comes from the rate card (same island to across the bridge).
  function estimate() {
    if (!totalCount()) return null;
    const pk = buildPackages(true);
    const r = MDM.pricing.estimateRange(pk, settings, service());
    return Object.assign(r, { xl: (Number(draft.counts.xl) || 0) > 0, zonesKnown: step >= 4 || !!trim(draft.delivery.address) });
  }
  function rangeText(r) {
    if (!r) return 'Add a package';
    if (r.xl) return 'From ' + fmt(r.min);
    return r.min === r.max ? fmt(r.min) : fmt(r.min) + ' to ' + fmt(r.max).replace('MVR ', '');
  }

  // ---- Field helpers -------------------------------------------------------------------------------------------------------------
  let uid = 0;
  function reg(n, wrap, check, focusEl) { (checks[n] = checks[n] || []).push({ wrap, check, focus: () => { const f = focusEl ? focusEl() : wrap.querySelector('input, select, textarea, button'); if (f) f.focus(); } }); }
  // F(path, label, { type, options, required, hint, placeholder, validate, intl, rows, testid, onChange, attrs }) → .field wrapper bound to draft[path]
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
      ctrl = el('textarea', { class: 'textarea', id, rows: o.rows || 3, placeholder: o.placeholder || null, 'data-testid': testid, value: value == null ? '' : value });
    } else {
      const attrs = Object.assign({ class: 'input', id, type: type === 'tel' ? 'tel' : type, placeholder: o.placeholder || null, 'data-testid': testid, value: value == null ? '' : value }, o.attrs || {});
      if (type === 'tel') { attrs.inputmode = 'tel'; attrs.autocomplete = attrs.autocomplete || 'tel'; }
      if (type === 'number') { attrs.inputmode = attrs.inputmode || 'numeric'; attrs.min = attrs.min || '0'; }
      ctrl = el('input', attrs);
    }
    const wrap = MDM.ui.field({ name: path, control: ctrl, label, hint: o.hint || null, optional: !o.required && !o.noOptional });
    const onValue = () => {
      const v = type === 'number' ? ctrl.value : ctrl.value;
      setPath(path, v);
      if (o.auto) draft[o.auto].auto = false;
      saveDraft(); updateSummary();
      if (wrap.classList.contains('is-invalid')) setError(wrap, null);
      if (o.onChange) o.onChange(v);
    };
    ctrl.addEventListener(type === 'select' ? 'change' : 'input', onValue);
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
  // seg(path, label, options, { onChange, testid, hint }) → segmented radio group bound to draft[path]
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
    const wrap = el('div', { class: 'field', 'data-field': path }, el('div', null, el('label', { class: 'checkbox', for: id }, input, el('span', null, label, o.hint ? el('span', { class: 'checkbox__hint' }, o.hint) : null))), el('div', { class: 'field__error', hidden: true }));
    if (o.required) reg(n, wrap, () => (getPath(path) ? null : o.requiredMessage || 'Tick the box to continue'), () => input);
    return wrap;
  }
  const grid = (...kids) => el('div', { class: 'grid-2' }, kids);
  // rerender(n) rebuilds a step after a choice that changes its fields, keeping focus on the control that was used.
  function rerender(n) {
    const a = document.activeElement;
    const key = a && a.closest && a.closest('[data-testid]') ? a.closest('[data-testid]').getAttribute('data-testid') : null;
    const val = a && a.value;
    renderStep(n);
    if (key) {
      const again = dom.steps[n].querySelector('[data-testid="' + key + '"]');
      const target = again && (again.matches('input,select,textarea,button') ? again : again.querySelector('input[value="' + (val || '') + '"]') || again.querySelector('input:checked') || again.querySelector('input,select,textarea,button'));
      if (target) target.focus({ preventScroll: true });
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
  // docField(kind, label, { required, multiple, hint }) → list of uploaded documents of that kind plus a picker
  function docField(n, kind, label, o) {
    o = o || {};
    const id = 'rq-doc-' + kind + '-' + (++uid);
    const listEl = el('div', { class: 'stack-2' });
    const input = el('input', { class: 'sr-only', type: 'file', id, accept: 'image/*,application/pdf', tabindex: '-1', multiple: !!o.multiple, 'data-testid': 'request-doc-' + kind });
    const btn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'request-doc-' + kind + '-pick', on: { click: () => input.click() } }, html(MDM.icon('upload', 16)), o.multiple ? 'Add files' : 'Choose a file');
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
      btn.lastChild.textContent = mine.length && !o.multiple ? 'Replace file' : (o.multiple ? 'Add files' : 'Choose a file');
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
    const sz = draft.sizes[size];
    const id = 'rq-photo-' + size;
    const input = el('input', { class: 'sr-only', type: 'file', id, accept: 'image/*', capture: 'environment', tabindex: '-1', 'data-testid': 'request-photo-' + size });
    const box = el('div', { class: 'request-photo' });
    const err = el('div', { class: 'field__error', hidden: true });
    async function paint() {
      box.textContent = '';
      if (sz.photoId) {
        const f = await MDM.store.get('files', sz.photoId);
        box.append(el('div', { class: 'dropzone__preview', 'data-testid': 'request-photo-preview' },
          f && f.dataUrl ? el('img', { class: 'dropzone__thumb', src: f.dataUrl, alt: 'Photo of the ' + MDM.pricing.sizeLabel(size) + ' package' }) : null,
          el('div', { class: 'dropzone__file' }, el('div', { class: 'dropzone__name' }, sz.photoName || 'Package photo'), el('div', { class: 'dropzone__size' }, 'Our team checks it before confirming the price')),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => { MDM.store.remove('files', sz.photoId).catch(() => {}); sz.photoId = null; sz.photoName = ''; saveDraft(); paint(); updateSummary(); } } }, 'Remove')));
      } else {
        box.append(el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'request-photo-' + size + '-pick', on: { click: () => input.click() } }, html(MDM.icon('camera', 16)), 'Add a photo'));
      }
    }
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0]; input.value = '';
      if (!f) return;
      err.hidden = true;
      try {
        const row = await storeFile(f, 'package');
        if (sz.photoId) MDM.store.remove('files', sz.photoId).catch(() => {});
        sz.photoId = row.id; sz.photoName = row.name; saveDraft(); paint(); updateSummary();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    });
    paint();
    return el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Package photo'), box, input, err);
  }

  // ---- Steps -------------------------------------------------------------------------------------------------------------------------
  function head(n, title, desc) { return el('div', { class: 'section-head' }, el('h2', { id: 'request-step-' + n + '-title', tabindex: '-1' }, title), desc ? el('p', { class: 'section-head__desc' }, desc) : null); }
  function actions(o) {
    const back = step > 1 ? el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'request-back', on: { click: () => go(step - 1) } }, 'Back') : null;
    const next = o && o.submit
      ? el('button', { type: 'submit', class: 'btn btn--brand', 'data-testid': 'request-submit' }, o.label)
      : el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'request-next', on: { click: advance } }, (o && o.label) || 'Continue');
    return el('div', { class: 'form-actions' }, back, next);
  }
  function group(title, ...kids) { return el('div', { class: 'request-group' }, el('h3', { class: 'request-group__title' }, title), kids); }

  function typeFields(n) {
    const d = draft.details, t = draft.type;
    const out = [];
    if (t === 'postal') {
      out.push(F(n, 'details.carrier', 'Carrier or collection point', { type: 'select', placeholder: 'Choose one', required: true, options: MDM.CARRIERS.map(c => ({ value: c.value, label: c.label })), testid: 'request-carrier', requiredMessage: 'Choose where to collect from', onChange: () => { applyDictated(); saveDraft(); rerender(n); updateSummary(); } }));
      const c = d.carrier;
      if (c === 'redbox_maafannu') out.push(grid(F(n, 'details.collectionCode', 'Collection code', { required: true, placeholder: 'From the Redbox SMS' }), F(n, 'details.collectBefore', 'Collect before', { type: 'datetime-local', required: true, hint: 'The time in the Redbox SMS' })));
      if (c === 'redbox_main') out.push(grid(F(n, 'details.trackingNo', 'Tracking number', { required: true }), F(n, 'details.ownerName', 'Owner name', { required: true })), F(n, 'details.shippingAddress', 'Shipping address on the parcel', { required: true }), F(n, 'details.ownerContact', 'Owner contact number', { type: 'tel', required: true, intl: true }));
      if (c === 'pikpost') out.push(F(n, 'details.location', 'Pikpost location', { type: 'select', placeholder: 'Choose a location', required: true, options: MDM.PIKPOST_LOCATIONS, onChange: () => { applyDictated(); saveDraft(); updateSummary(); } }), grid(F(n, 'details.collectionCode', 'Collection code', { required: true }), F(n, 'details.collectBefore', 'Collect before (SMS time)', { type: 'datetime-local', required: true })));
      if (c === 'post_office') {
        out.push(F(n, 'details.postOffice', 'Post office', { type: 'select', placeholder: 'Choose a post office', required: true, options: MDM.POST_OFFICES, onChange: () => { applyDictated(); saveDraft(); updateSummary(); } }),
          F(n, 'details.collectionCode', 'Collection code', { hint: 'No code? Leave it empty, then send your ID details to the post collections contact and fill in the owner details below.', onChange: v => { if (!trim(v) !== !!dom.steps[n].querySelector('[data-testid="request-id-sent"]')) rerender(n); } }));
        if (!trim(d.collectionCode)) out.push(check(n, 'details.idSent', 'I will give my ID details to the post collections contact', { required: true, testid: 'request-id-sent' }),
          grid(F(n, 'details.ownerName', 'Owner name', { required: true }), F(n, 'details.ownerContact', 'Owner contact number', { type: 'tel', required: true, intl: true })), F(n, 'details.shippingAddress', 'Shipping address on the parcel', { required: true }));
      }
      if (c === 'courier') out.push(F(n, 'details.courierName', 'Courier', { type: 'select', placeholder: 'Choose the courier', required: true, options: COURIERS.map(x => ({ value: x, label: x })), onChange: () => { applyDictated(); saveDraft(); updateSummary(); } }),
        grid(F(n, 'details.trackingNo', 'Tracking number', { required: true }), F(n, 'details.ownerName', 'Owner name', { required: true })), F(n, 'details.ownerContact', 'Owner contact number', { type: 'tel', required: true, intl: true }));
      if (c === 'dhl') out.push(F(n, 'details.trackingNo', 'Waybill or tracking number'), docField(n, 'collection_doc', 'DHL collection document', { required: true, hint: 'The authorisation document DHL asks for at the counter.' }));
    }
    if (t === 'shop_buy') out.push(F(n, 'details.shopName', 'Shop', { required: true, placeholder: 'For example STO People\'s Choice' }),
      F(n, 'details.list', 'Shopping list', { type: 'textarea', required: true, rows: 4, placeholder: 'One item per line, with quantities' }),
      grid(F(n, 'details.budget', 'Budget', { type: 'number', required: true, min: 1, hint: 'Paid upfront with the delivery fee. We refund what is left.' }), seg(n, 'details.unavailable', 'If something is not available', UNAVAILABLE)));
    if (t === 'shop_collect') {
      out.push(F(n, 'details.shopName', 'Shop', { required: true, placeholder: 'Where you bought it' }), seg(n, 'details.proof', 'What do you have from the shop?', SHOP_PROOF, { onChange: () => rerender(n) }));
      if (d.proof === 'invoice') out.push(docField(n, 'invoice', 'Shop invoice', { required: true }));
      if (d.proof === 'quotation') out.push(docField(n, 'quotation', 'Quotation', { required: true }), docField(n, 'payment_slip', 'Payment slip', { required: true }));
      if (d.proof === 'order_no') out.push(F(n, 'details.orderNo', 'Order number', { required: true }));
    }
    if (t === 'office') out.push(F(n, 'details.task', 'What do you need?', { type: 'select', required: true, options: MDM.OFFICE_TASKS }),
      grid(F(n, 'details.organisation', 'Office or organisation', { required: true, placeholder: 'For example Ministry of Economic Development' }), F(n, 'details.reference', 'Reference numbers', { placeholder: 'Application or file numbers' })),
      F(n, 'details.details', 'Details and instructions', { type: 'textarea', required: true, rows: 3, placeholder: 'What to submit or collect, who to ask for, what to bring back' }),
      docField(n, 'document', 'Documents', { multiple: true, hint: 'Forms, letters or ID copies the office needs. Originals are collected from you.' }),
      check(n, 'details.returnDocs', 'Bring the receipt or documents back to me'));
    if (t === 'airport') {
      out.push(seg(n, 'details.mode', 'Airport service', MDM.AIRPORT_MODES.map(m => ({ value: m.value, label: m.label })), { stack: true, onChange: () => { applyDictated(); saveDraft(); rerender(n); updateSummary(); } }),
        F(n, 'details.area', 'Airport area', { type: 'select', required: true, options: MDM.geo.airportPoints().map(p => ({ value: p.value, label: p.label })), onChange: () => { applyDictated(); saveDraft(); updateSummary(); } }),
        grid(F(n, 'details.flight', 'Flight number', { required: d.mode !== 'deliver', placeholder: 'For example EK 652' }), F(n, 'details.flightTime', d.mode === 'collect' ? 'Arrival time' : 'Departure time', { type: 'time', required: d.mode !== 'deliver' })),
        grid(F(n, 'details.passengerName', 'Passenger name', { required: d.mode !== 'deliver' }), F(n, 'details.passengerPhone', 'Passenger phone', { type: 'tel', intl: true })));
      if (d.mode === 'baggage') out.push(F(n, 'details.bags', 'Number of bags', { type: 'number', required: true, min: 1 }));
    }
    return out;
  }
  function scheduleFields(n) {
    const out = [seg(n, 'level', 'When', MDM.SERVICE_LEVELS, { stack: true, testid: 'request-level', onChange: () => { saveDraft(); rerender(n); updateSummary(); } })];
    if (draft.level === 'express') out.push(MDM.ui.notice('info', 'Express is subject to availability. We confirm it, and any express fee, with your final price.'));
    if (draft.level === 'advance') {
      const today = MDM.ui.dayKey(new Date());
      const later = v => { const s = draft.schedule; if (!s.collectDate || !s.deliverDate) return null; return (s.deliverDate + 'T' + (s.deliverTime || '00:00')) < (s.collectDate + 'T' + (s.collectTime || '00:00')) ? 'Delivery must be after collection' : null; };
      out.push(grid(F(n, 'schedule.collectDate', 'Collection date', { type: 'date', required: true, attrs: { min: today }, validate: v => (v < today ? 'Choose today or a later date' : null) }), F(n, 'schedule.collectTime', 'Collection time', { type: 'time', required: true })),
        grid(F(n, 'schedule.deliverDate', 'Delivery date', { type: 'date', required: true, attrs: { min: today }, validate: later }), F(n, 'schedule.deliverTime', 'Delivery time', { type: 'time', required: true, validate: later })));
    }
    return out;
  }
  function step1(n) {
    const extra = typeFields(n);
    const types = el('div', { class: 'request-types', role: 'radiogroup', 'aria-labelledby': 'rq-type-label', 'data-testid': 'request-type' },
      MDM.REQUEST_TYPES.map(t => el('label', { class: ['request-type', draft.type === t.value ? 'is-selected' : null], 'data-testid': 'request-type-' + t.value },
        el('input', { class: 'sr-only', type: 'radio', name: 'rq-type', value: t.value, checked: draft.type === t.value }),
        el('span', { class: 'request-type__label' }, t.label), el('span', { class: 'request-type__hint' }, t.hint))));
    types.addEventListener('change', e => {
      if (!e.target || !e.target.checked) return;
      draft.type = e.target.value; applyDictated(); saveDraft(); rerender(n); updateSummary();
    });
    return [head(n, 'What do you need?', 'Pick the kind of job. Each one asks only for what our driver needs.'),
      el('div', { class: 'field' }, el('span', { class: 'field__label', id: 'rq-type-label' }, 'Request type'), types),
      extra.length ? group(typeOf().label, extra) : null,
      group('Timing', scheduleFields(n)),
      actions()];
  }
  function savedChips(target) {
    if (!savedAddresses.length) return null;
    return el('div', { class: 'request-saved' }, el('span', { class: 'field__label' }, 'Saved addresses'),
      el('div', { class: 'row row--wrap' }, savedAddresses.map(a => el('button', { type: 'button', class: 'chip', 'data-testid': 'request-saved-address', on: { click: () => {
        Object.assign(draft[target], { address: a.address, zone: a.zone || 'male', landmark: a.landmark || draft[target].landmark, auto: false });
        saveDraft(); renderStep(step); updateSummary();
      } } }, (a.label ? a.label + ': ' : '') + a.address))));
  }
  function zoneOptions(allowAirport) { return MDM.geo.zoneOptions().filter(z => allowAirport || z.value !== 'airport'); }
  function step2(n) {
    applyDictated();
    const locked = !!dictatedCollection();
    const shop = draft.type === 'shop_buy' || draft.type === 'shop_collect';
    const title = shop ? 'Where is the shop?' : 'Where do we collect from?';
    const desc = locked ? 'We filled this in from your ' + (draft.type === 'airport' ? 'airport details' : 'carrier') + '. Add anything that helps the driver.' : 'The address our driver goes to first.';
    return [head(n, title, desc),
      locked ? null : savedChips('collection'),
      F(n, 'collection.address', shop ? 'Shop address' : 'Collection address', { required: true, placeholder: 'House or building name, street', auto: 'collection', attrs: { autocomplete: 'street-address', readonly: locked ? true : null } }),
      grid(F(n, 'collection.zone', 'Area', { type: 'select', required: true, disabled: locked, options: zoneOptions(airportCollect()), onChange: () => { draft.collection.auto = false; } }),
        F(n, 'collection.landmark', 'Landmark', { placeholder: 'Near a shop, mosque or school' })),
      grid(F(n, 'collection.contactName', shop ? 'Shop contact' : 'Contact person', { required: !shop && draft.type !== 'postal', placeholder: 'Who hands it over', onChange: () => { draft.collection.autoContact = false; } }),
        F(n, 'collection.contactPhone', 'Contact number', { type: 'tel', intl: true, required: !shop && draft.type !== 'postal' && draft.type !== 'airport' })),
      F(n, 'collection.instructions', 'Instructions for the driver', { type: 'textarea', rows: 2, placeholder: 'Floor, gate, best time to call' }),
      actions()];
  }
  function step3(n) {
    const sg = settings.sizeGuide || {}, sizes = (settings.rates || {}).sizes || {};
    const priceOf = s => { const c = sizes[s] || {}; return s === 'xl' ? 'from ' + fmt(c.same) : fmt(c.same) + ' to ' + fmt(c.cross).replace('MVR ', ''); };
    const rows = SIZES.map(size => {
      const count = Number(draft.counts[size]) || 0;
      const out = el('output', { class: 'request-qty__value mono', 'aria-live': 'polite', 'data-testid': 'request-qty-' + size }, String(count));
      const setCount = v => { draft.counts[size] = Math.max(0, Math.min(MAX_PER_SIZE, v)); saveDraft(); rerender(n); updateSummary(); };
      const label = MDM.pricing.sizeLabel(size);
      const detail = count ? el('div', { class: 'request-size__detail', 'data-testid': 'request-size-detail-' + size },
        el('div', { class: 'request-size__caption' }, 'Size, weight and photo help us confirm the price faster. All optional.'),
        el('div', { class: 'grid-3 request-dims' },
          F(n, 'sizes.' + size + '.l', 'Length (cm)', { type: 'number', noOptional: true, testid: 'request-dim-' + size + '-l' }), F(n, 'sizes.' + size + '.w', 'Width (cm)', { type: 'number', noOptional: true, testid: 'request-dim-' + size + '-w' }), F(n, 'sizes.' + size + '.h', 'Height (cm)', { type: 'number', noOptional: true, testid: 'request-dim-' + size + '-h' })),
        el('div', { class: 'grid-2' }, F(n, 'sizes.' + size + '.kg', 'Weight (kg)', { type: 'number', noOptional: true, testid: 'request-dim-' + size + '-kg' }), photoPicker(size))) : null;
      return el('div', { class: ['request-size', count ? 'is-on' : null], 'data-size': size },
        el('div', { class: 'request-size__row' },
          el('div', { class: 'request-size__main' }, el('div', { class: 'request-size__label' }, label, el('span', { class: 'request-size__price mono' }, priceOf(size))), el('div', { class: 'request-size__hint' }, sg[size] || '')),
          el('div', { class: 'request-qty', role: 'group', 'aria-label': label + ' quantity' },
            el('button', { type: 'button', class: 'btn btn--secondary btn--icon btn--sm', 'aria-label': 'Fewer ' + label + ' packages', 'data-testid': 'request-qty-' + size + '-minus', disabled: !count, on: { click: () => setCount(count - 1) } }, html(MDM.icon('minus', 16))),
            out,
            el('button', { type: 'button', class: 'btn btn--secondary btn--icon btn--sm', 'aria-label': 'More ' + label + ' packages', 'data-testid': 'request-qty-' + size + '-plus', disabled: count >= MAX_PER_SIZE, on: { click: () => setCount(count + 1) } }, html(MDM.icon('plus', 16))))),
        detail);
    });
    const qtyField = el('div', { class: 'field request-sizes', 'data-field': 'counts' }, rows, el('div', { class: 'field__error', hidden: true }));
    reg(n, qtyField, () => (totalCount() ? null : 'Add at least 1 package'), () => qtyField.querySelector('[data-testid="request-qty-bag-plus"]'));
    const r = estimate();
    return [head(n, 'What are we carrying?', 'Choose how many of each size. Sizes are checked at collection.'),
      qtyField,
      el('div', { class: 'request-estimate', 'data-testid': 'request-estimate' }, el('span', { class: 'request-estimate__label' }, 'Estimated price'), el('span', { class: 'request-estimate__value mono' }, rangeText(r))),
      MDM.ui.notice('info', 'Sizes and photos are optional. Without a photo, our driver photographs the package at collection and our team confirms the final price, including any vehicle fee, before you pay.'),
      F(n, 'description', 'What is inside?', { required: true, placeholder: 'For example documents, a cake box, a phone charger', testid: 'request-description' }),
      el('div', { class: 'row row--wrap request-flags' }, check(n, 'fragile', 'Fragile, handle with care'), draft.counts.xl ? check(n, 'vehicle', 'May need a car or pickup', { hint: 'We confirm the vehicle charge with the price' }) : null),
      actions()];
  }
  function step4(n) {
    applyDictated();
    const locked = !!dictatedDelivery();
    return [head(n, 'Where does it go?', locked ? 'We filled in the airport area from step 1.' : 'The address our driver delivers to.'),
      locked ? null : savedChips('delivery'),
      F(n, 'delivery.address', 'Delivery address', { required: true, placeholder: 'House or building name, street', auto: 'delivery', attrs: { autocomplete: 'street-address', readonly: locked ? true : null } }),
      grid(F(n, 'delivery.zone', 'Area', { type: 'select', required: true, disabled: locked, options: zoneOptions(airportDeliver()) }), F(n, 'delivery.landmark', 'Landmark', { placeholder: 'Near a shop, mosque or school' })),
      locked ? null : seg(n, 'delivery.meetAt', 'Hand over at', MDM.geo.meetAtOptions()),
      check(n, 'delivery.self', "I'm receiving it myself", { onChange: () => rerender(n) }),
      draft.delivery.self ? null : grid(F(n, 'delivery.recipientName', 'Recipient name', { required: true }), F(n, 'delivery.recipientPhone', 'Recipient number', { type: 'tel', intl: true, required: true })),
      F(n, 'delivery.instructions', 'Instructions for the driver', { type: 'textarea', rows: 2, placeholder: 'Floor, gate, who to ask for' }),
      actions()];
  }
  function step5(n) {
    const shop = draft.type === 'shop_buy';
    if (shop) draft.pay = 'upfront';
    return [head(n, 'Your details', 'We message you when the price is confirmed and at every step after.'),
      grid(F(n, 'customer.name', 'Your name', { required: true, attrs: { autocomplete: 'name' } }), F(n, 'customer.phone', 'Mobile number', { type: 'tel', required: true, hint: 'We send updates to this number' })),
      seg(n, 'customer.notify', 'Send updates by', NOTIFY, { onChange: () => { saveDraft(); rerender(n); } }),
      F(n, 'customer.email', 'Email', { type: 'email', required: draft.customer.notify === 'email', attrs: { autocomplete: 'email' } }),
      shop ? MDM.ui.notice('info', 'Shopping orders are paid upfront: the budget plus the delivery fee, once we confirm the price. We refund what is left.')
        : seg(n, 'pay', 'When do you want to pay?', [{ value: 'after', label: 'After delivery', hint: 'We send the invoice when it is delivered' }, { value: 'upfront', label: 'Upfront', hint: 'Pay once we confirm the price' }], { stack: true, testid: 'request-pay' }),
      check(n, 'remember', 'Remember me on this device', { testid: 'request-remember' }),
      actions({ label: 'Review request' })];
  }
  function reviewRow(label, value) { return MDM.ui.rateRow(label, value); }
  function reviewGroup(title, n, rows) {
    return el('div', { class: 'rate-table request-review__group' },
      MDM.ui.rateRow(title, el('button', { type: 'button', class: 'btn btn--ghost btn--sm review__edit', 'data-testid': 'request-edit-' + n, on: { click: () => go(n) } }, 'Edit', el('span', { class: 'sr-only' }, ' ' + title)), { head: true }),
      rows.filter(Boolean));
  }
  function detailRows() {
    const d = draft.details, t = draft.type, rows = [];
    const add = (l, v) => { if (trim(v)) rows.push(reviewRow(l, String(v))); };
    if (t === 'postal') {
      add('Carrier', (carrier() || {}).label);
      if (d.carrier === 'pikpost') add('Location', (MDM.PIKPOST_LOCATIONS.find(x => x.value === d.location) || {}).label);
      if (d.carrier === 'post_office') add('Post office', (MDM.POST_OFFICES.find(x => x.value === d.postOffice) || {}).label);
      if (d.carrier === 'courier') add('Courier', d.courierName);
      add('Collection code', d.collectionCode); add('Collect before', d.collectBefore ? d.collectBefore.replace('T', ' ') : '');
      add('Tracking number', d.trackingNo); add('Owner', d.ownerName); add('Owner contact', d.ownerContact); add('Shipping address', d.shippingAddress);
    }
    if (t === 'shop_buy') { add('Shop', d.shopName); add('List', d.list); add('Budget', d.budget ? fmt(d.budget) : ''); add('If unavailable', (UNAVAILABLE.find(x => x.value === d.unavailable) || {}).label); }
    if (t === 'shop_collect') { add('Shop', d.shopName); add('Proof', (SHOP_PROOF.find(x => x.value === d.proof) || {}).label); add('Order number', d.proof === 'order_no' ? d.orderNo : ''); }
    if (t === 'office') { add('Task', (MDM.OFFICE_TASKS.find(x => x.value === d.task) || {}).label); add('Office', d.organisation); add('References', d.reference); add('Details', d.details); if (d.returnDocs) add('Return', 'Bring the receipt or documents back'); }
    if (t === 'airport') { add('Service', (MDM.AIRPORT_MODES.find(x => x.value === d.mode) || {}).label); add('Area', areaLabel(d.area)); add('Flight', [d.flight, d.flightTime].filter(Boolean).join(' at ')); add('Passenger', [d.passengerName, d.passengerPhone].filter(Boolean).join(', ')); if (d.mode === 'baggage') add('Bags', d.bags); }
    const docs = draft.docs.filter(x => relevantDoc(x.kind));
    if (docs.length) rows.push(reviewRow('Documents', docs.map(x => x.name).join(', ')));
    add('Timing', draft.level === 'advance' ? 'Collect ' + draft.schedule.collectDate + ' ' + draft.schedule.collectTime + ', deliver ' + draft.schedule.deliverDate + ' ' + draft.schedule.deliverTime : (MDM.SERVICE_LEVELS.find(x => x.value === draft.level) || {}).label);
    return rows;
  }
  function relevantDoc(kind) {
    const t = draft.type, d = draft.details;
    if (t === 'postal') return d.carrier === 'dhl' && kind === 'collection_doc';
    if (t === 'shop_collect') return (d.proof === 'invoice' && kind === 'invoice') || (d.proof === 'quotation' && (kind === 'quotation' || kind === 'payment_slip'));
    if (t === 'office') return kind === 'document';
    return false;
  }
  function step6(n) {
    const c = draft.collection, d = draft.delivery, cust = draft.customer;
    const r = estimate();
    const pk = SIZES.filter(s => draft.counts[s]).map(s => draft.counts[s] + ' × ' + MDM.pricing.sizeLabel(s)).join(', ');
    const notifyWord = (NOTIFY.find(x => x.value === cust.notify) || NOTIFY[0]).label;
    const priceBox = el('div', { class: 'summary', 'data-testid': 'request-review-price' },
      el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, 'Delivery', el('span', { class: 'summary__sub' }, pk)), el('span', { class: 'summary__amount mono' }, r ? rangeText(r) : '')),
      draft.type === 'shop_buy' ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Shopping budget and ' + ((settings.rates || {}).shoppingPct || 10) + '% shopping fee', el('span', { class: 'summary__sub' }, 'Included in the estimate')), el('span', { class: 'summary__amount mono' }, fmt(Number(draft.details.budget) || 0))) : null,
      el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, 'Estimated total'), el('span', { class: 'mono', 'data-testid': 'request-review-total' }, rangeText(r))));
    return [head(n, 'Check and send', 'Nothing is charged now. Our team confirms the final price first.'),
      el('div', { class: 'stack-4' },
        reviewGroup(typeOf().label, 1, detailRows()),
        reviewGroup('Collection', 2, [reviewRow('Address', c.address + ', ' + MDM.geo.zoneLabel(c.zone)), trim(c.landmark) ? reviewRow('Landmark', c.landmark) : null, trim(c.contactName) || trim(c.contactPhone) ? reviewRow('Contact', [c.contactName, c.contactPhone ? phone.format(c.contactPhone) : ''].filter(Boolean).join(', ')) : null, trim(c.instructions) ? reviewRow('Instructions', c.instructions) : null]),
        reviewGroup('Packages', 3, [reviewRow('Packages', pk), reviewRow('Contents', draft.description + (draft.fragile ? ' (fragile)' : '')),
          SIZES.some(s => draft.counts[s] && draft.sizes[s].photoId) ? reviewRow('Photos', SIZES.filter(s => draft.counts[s] && draft.sizes[s].photoId).map(MDM.pricing.sizeLabel).join(', ')) : reviewRow('Photos', 'Driver photographs it at collection')]),
        reviewGroup('Delivery', 4, [reviewRow('Address', d.address + ', ' + MDM.geo.zoneLabel(d.zone)), trim(d.landmark) ? reviewRow('Landmark', d.landmark) : null, reviewRow('Recipient', d.self ? 'You' : [d.recipientName, d.recipientPhone ? phone.format(d.recipientPhone) : ''].filter(Boolean).join(', ')), trim(d.instructions) ? reviewRow('Instructions', d.instructions) : null]),
        reviewGroup('You', 5, [reviewRow('Name', cust.name), reviewRow('Mobile', phone.format(cust.phone)), trim(cust.email) ? reviewRow('Email', cust.email) : null, reviewRow('Updates by', notifyWord), reviewRow('Payment', draft.pay === 'upfront' ? 'Bank transfer, upfront once the price is confirmed' : 'Bank transfer after delivery')]),
        priceBox,
        MDM.ui.notice('info', 'Final price confirmed by our team' + (settings.ops && settings.ops.reviewText ? ', usually within ' + settings.ops.reviewText : '') + '. We message you by ' + notifyWord + (draft.pay === 'upfront' ? ' with the amount to transfer.' : ' and you pay after delivery.'))),
      el('div', { class: 'field__error', role: 'alert', 'data-testid': 'request-error', hidden: true }),
      actions({ submit: true, label: 'Send request' })];
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
    // Steps before the target must be valid; otherwise land on the first one that is not.
    for (let k = 1; k <= 6; k++) renderStep(k);
    n = Math.min(n, firstInvalid(n));
    step = n;
    if (stepFromHash() !== n) history.replaceState(null, '', '#step-' + n);
    renderStep(n);
    // Only the current step stays in the DOM; the others were rendered just to check them (their checks read the draft).
    Object.keys(dom.steps).forEach(k => { const on = Number(k) === n; dom.steps[k].hidden = !on; if (!on) dom.steps[k].replaceChildren(); });
    renderStepper(); updateSummary();
    if (o && o.initial) return;
    window.scrollTo(0, 0);
    const h = dom.steps[n].querySelector('h2'); if (h) h.focus({ preventScroll: true });
  }
  function go(n) { if (stepFromHash() === n) setStep(n); else location.hash = '#step-' + n; }
  function advance() { if (!showErrors(step)) return; go(step + 1); }
  function renderStepper() {
    dom.stepper.replaceChildren(...STEPS.map(s => {
      const done = s.n < step, cur = s.n === step;
      const inner = done ? el('a', { class: 'stepper__link', href: '#step-' + s.n }, html(MDM.icon('check', 16)), el('span', { class: 'stepper__label' }, s.label))
        : el('span', { class: 'stepper__link' }, el('span', { class: 'stepper__num' }, s.n + '.'), el('span', { class: 'stepper__label' }, s.label));
      return el('li', { class: ['stepper__item', done ? 'is-done' : null], 'aria-current': cur ? 'step' : null }, inner);
    }), el('li', { class: 'stepper__progress', 'aria-hidden': 'true' }, 'Step ' + step + ' of ' + STEPS.length));
  }
  function updateSummary() {
    const r = estimate();
    const pk = SIZES.filter(s => draft.counts[s]).map(s => draft.counts[s] + ' × ' + MDM.pricing.sizeLabel(s)).join(', ') || 'No packages yet';
    const c = draft.collection, d = draft.delivery;
    const route = (trim(c.address) ? MDM.geo.zoneShort(c.zone) : '…') + ' to ' + (trim(d.address) ? MDM.geo.zoneShort(d.zone) : '…');
    const est = dom.steps[3] && dom.steps[3].querySelector('.request-estimate__value'); if (est) est.textContent = rangeText(r);
    dom.panel.replaceChildren(el('div', { class: 'summary' },
      el('h2', { class: 'summary__head' }, 'Your request'),
      el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, typeOf().label, el('span', { class: 'summary__sub' }, (MDM.SERVICE_LEVELS.find(x => x.value === draft.level) || {}).label))),
      el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, pk, el('span', { class: 'summary__sub' }, route))),
      el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, 'Estimate'), el('span', { class: 'mono', 'data-testid': 'request-panel-estimate' }, rangeText(r))),
      el('p', { class: 'small muted' }, 'Final price confirmed by our team before collection.')));
    dom.bar.replaceChildren(el('div', { class: 'mobile-bar__info' }, el('div', { class: 'mobile-bar__total mono', 'data-testid': 'request-bar-estimate' }, rangeText(r)), el('div', { class: 'mobile-bar__meta' }, 'Estimate · Step ' + step + ' of 6')),
      step < 6 ? el('button', { type: 'button', class: 'btn btn--primary', on: { click: advance } }, 'Continue') : el('button', { type: 'submit', form: 'request-form', class: 'btn btn--brand' }, 'Send'));
  }

  // ---- Submit -----------------------------------------------------------------------------------------------------------------------
  async function submit(e) {
    e.preventDefault();
    if (submitting || step !== 6) return;
    const bad = firstInvalid(7);
    if (bad < 7) { go(bad); setTimeout(() => showErrors(bad), 0); return; }
    submitting = true;
    const btn = dom.steps[6].querySelector('[data-testid="request-submit"]'); MDM.ui.setLoading(btn, true);
    const errEl = dom.steps[6].querySelector('[data-testid="request-error"]');
    try {
      const cust = draft.customer;
      const c = draft.collection, d = draft.delivery;
      const customer = { name: trim(cust.name), phone: phone.normalize(cust.phone), email: trim(cust.email), notify: cust.notify };
      const saved = await MDM.store.upsertCustomer({ name: customer.name, phone: customer.phone, email: customer.email, notify: customer.notify, address: d.zone !== 'airport' && trim(d.address) ? { label: 'Address', address: trim(d.address), zone: d.zone, meetAt: d.meetAt || 'door' } : null });
      const det = Object.assign({}, draft.details);
      const t = draft.type;
      const keep = { postal: ['carrier', 'courierName', 'location', 'postOffice', 'collectionCode', 'collectBefore', 'trackingNo', 'ownerName', 'ownerContact', 'shippingAddress', 'idSent'], shop_buy: ['shopName', 'list', 'budget', 'unavailable'], shop_collect: ['shopName', 'proof', 'orderNo'],
        office: ['task', 'organisation', 'reference', 'details', 'returnDocs'], airport: ['mode', 'area', 'flight', 'flightTime', 'passengerName', 'passengerPhone', 'bags'], home: [] }[t] || [];
      const details = {}; keep.forEach(k => { if (det[k] != null && det[k] !== '') details[k] = typeof det[k] === 'string' ? det[k].trim() : det[k]; });
      if (t === 'postal' && details.collectBefore) details.collectBefore = details.collectBefore.replace('T', ' ');
      if (t === 'postal' && det.carrier === 'post_office' && !trim(det.collectionCode)) details.idNote = 'No collection code; the owner gives their ID details to the post collections contact';
      if (t === 'shop_collect') details.paidByCustomer = true;
      const documents = draft.docs.filter(x => relevantDoc(x.kind));
      const packages = buildPackages(false);
      const order = await MDM.store.createOrder({
        source: 'web', requestType: t, service: service(), serviceLevel: draft.level, customerId: saved.id, customer,
        collection: { address: trim(c.address), zone: c.zone, landmark: trim(c.landmark), contactName: trim(c.contactName) || customer.name, contactPhone: phone.normalize(c.contactPhone) || trim(c.contactPhone) || customer.phone, instructions: trim(c.instructions) },
        delivery: { address: trim(d.address), zone: d.zone, landmark: trim(d.landmark), recipientName: d.self ? customer.name : trim(d.recipientName), recipientPhone: d.self ? customer.phone : (phone.normalize(d.recipientPhone) || trim(d.recipientPhone)), instructions: trim(d.instructions), meetAt: d.zone === 'airport' ? det.area : d.meetAt },
        details, documents, packages,
        schedule: draft.level === 'advance' ? Object.assign({ type: 'advance' }, draft.schedule) : { type: 'asap' },
        payment: { method: 'transfer', status: 'pending', upfrontRequired: t === 'shop_buy' || draft.pay === 'upfront' },
        by: 'customer',
      });
      const fileIds = documents.map(x => x.fileId).concat(packages.map(p => p.photoId).filter(Boolean));
      for (const id of Array.from(new Set(fileIds))) { await MDM.store.update('files', id, { orderId: order.id }).catch(() => {}); }
      if (draft.remember) { try { localStorage.setItem(ME_KEY, JSON.stringify({ name: customer.name, phone: customer.phone, email: customer.email, notify: customer.notify, signedInAt: (me && me.signedInAt) || new Date().toISOString() })); } catch (err) { /* storage blocked */ } }
      clearDraft();
      location.href = MDM.href('track/?order=' + encodeURIComponent(order.id) + '&new=1');
    } catch (err) {
      submitting = false; MDM.ui.setLoading(btn, false);
      errEl.textContent = err && err.code === 'quota' ? 'This browser is out of storage for the demo. Remove a photo and try again.' : (err && err.message) || 'Could not send your request. Try again.';
      errEl.hidden = false;
    }
  }

  // ---- Boot -------------------------------------------------------------------------------------------------------------------------
  async function main() {
    await MDM.store.ready;
    settings = await MDM.store.settings();
    dom.form = document.querySelector('[data-testid="request-form"]');
    dom.form.id = 'request-form';
    dom.stepper = dom.form.querySelector('[data-testid="request-stepper"]');
    for (let n = 1; n <= 6; n++) dom.steps[n] = document.getElementById('request-step-' + n);
    dom.panel = document.querySelector('[data-testid="request-panel"]');
    dom.bar = document.querySelector('[data-testid="request-mobile-bar"]');
    draft = loadDraft();
    me = loadMe();
    const q = new URLSearchParams(location.search);
    const t = q.get('type');
    if (t && MDM.REQUEST_TYPES.some(x => x.value === t) && t !== draft.type) { draft.type = t; applyDictated(); }
    if (me) {
      if (!trim(draft.customer.name) && !trim(draft.customer.phone)) Object.assign(draft.customer, { name: me.name || '', phone: me.phone || '', email: me.email || '', notify: me.notify || 'whatsapp' });
      const cust = (await MDM.store.list('customers', { where: { phone: phone.normalize(me.phone) } }))[0];
      savedAddresses = (cust && cust.addresses) || [];
    }
    saveDraft();
    dom.form.addEventListener('submit', submit);
    window.addEventListener('hashchange', () => setStep(stepFromHash() || 1));
    MDM.store.subscribe('settings', async () => { settings = await MDM.store.settings(); updateSummary(); });
    setStep(stepFromHash() || 1, { initial: true });
  }
  main();
})(window.MDM);

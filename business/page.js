// For businesses: the public page (size categories and rates, how it works, account request with a typical package photo) and, once
// signed in, the business portal (client requirements §2 business, §8, §10, §11, §18; web app updates 11/10/2026 §1.3, §3, §5).
// Session: localStorage mdm:business = { accountId, name, phone, at }, written here (phone + one-time code) or by the sign-in page.
// Portal tabs live in the hash (#overview, #new, #bulk, #excel, #orders, #cod, #points, #priority, #invoices, #labels) so each one can
// be linked to; #orders?batch=<id> opens one bulk order. Orders: MDM.store.createOrder (single), createBatch (bulk rows and Excel),
// businessCancel (one order, also inside a bulk order), updateBoat, requestPriority; collection points: saveCollectionPoint.
// Row parsing, validation and the Excel template live in business/kit.js (MDM.bizKit).
(function (MDM) { 'use strict';
  const { el, html, setError } = MDM.ui;
  const K = MDM.bizKit;
  const SESSION = 'mdm:business';
  const BUSINESS_ISLANDS = ['male', 'hulhumale'];
  const OPEN = ['requested', 'confirmed', 'assigned', 'dispatched', 'on_the_way', 'arrived', 'collected', 'out_for_delivery', 'failed'];
  const DONE = ['delivered', 'returned', 'cancelled'];
  const TABS = [
    { key: 'overview', label: 'Overview' }, { key: 'new', label: 'New order' }, { key: 'bulk', label: 'Bulk order' }, { key: 'excel', label: 'Excel import' },
    { key: 'orders', label: 'Orders' }, { key: 'cod', label: 'Cash on delivery' }, { key: 'points', label: 'Collection points' },
    { key: 'priority', label: 'Priority' }, { key: 'invoices', label: 'Invoices' }, { key: 'labels', label: 'Labels' },
  ];
  const PICKUP_WINDOWS = [
    { value: 'morning', label: 'Morning 09:00 to 12:00' }, { value: 'afternoon', label: 'Afternoon 13:00 to 17:00' }, { value: 'evening', label: 'Evening 18:00 to 22:00' },
  ];
  const VOLUMES = [{ value: '1-10', label: '1 to 10' }, { value: '11-30', label: '11 to 30' }, { value: '31-100', label: '31 to 100' }, { value: '100+', label: 'More than 100' }];
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const LANDLINE = /^[36]\d{6}$/;
  const money = n => MDM.pricing.format(n);
  const plural = MDM.ui.plural;
  const fmtDate = (iso, o) => MDM.ui.fmtDate(iso, o);
  const fmtDay = ymd => ymd ? MDM.ui.fmtDate(ymd + 'T12:00:00', { dateOnly: true }) : '';

  const app = document.querySelector('[data-slot="app"]');
  const state = {
    acc: null, tab: 'overview', settings: {}, received: null, signin: { step: 1, phone: '' },
    filters: { q: '', status: 'all', range: '30', batch: '' }, cod: { status: 'all', range: 'all' }, done: { order: null, batch: null, excel: null }, selected: new Set(),
  };

  // ---- Session -----------------------------------------------------------------------------------------------------------
  function readSession() { try { const v = JSON.parse(localStorage.getItem(SESSION) || 'null'); return v && v.accountId ? v : null; } catch (e) { return null; } }
  function writeSession(acc) { try { localStorage.setItem(SESSION, JSON.stringify({ accountId: acc.id, name: acc.name, phone: acc.phone, at: new Date().toISOString() })); } catch (e) { /* storage blocked: signed in for this page only */ } }
  function clearSession() { try { localStorage.removeItem(SESSION); } catch (e) { /* nothing stored */ } }
  async function currentAccount() {
    const s = readSession(); if (!s) return null;
    const acc = await MDM.store.get('business_accounts', s.accountId);
    return acc && acc.status === 'approved' ? acc : null;
  }

  // ---- Small builders ----------------------------------------------------------------------------------------------------
  const input = attrs => el('input', Object.assign({ class: 'input', type: 'text' }, attrs));
  const select = (options, prompt, value) => el('select', { class: 'select', value: value == null ? '' : value }, prompt ? el('option', { value: '' }, prompt) : null, options.map(o => el('option', { value: o.value }, o.label)));
  function field(name, label, control, opts) {
    opts = opts || {};
    control.name = name;
    if (!control.id) control.id = 'biz-' + name + '-' + Math.random().toString(36).slice(2, 7);
    return MDM.ui.field({ name, label, control, hint: opts.hint, optional: opts.optional, class: opts.class });
  }
  function segmented(name, options, value, testid) {
    return el('fieldset', { class: 'segmented', 'data-testid': testid || null }, options.map(o => el('label', { class: 'segmented__option', 'data-testid': testid ? testid + '-' + o.value : null },
      el('input', { class: 'sr-only', type: 'radio', name, value: o.value, checked: o.value === value }), el('span', null, o.label, o.hint ? el('small', null, o.hint) : null))));
  }
  function section(title, desc, body, action) {
    const id = 'biz-' + title.toLowerCase().replace(/[^a-z]+/g, '-');
    return el('section', { class: 'section', 'aria-labelledby': id },
      el('div', { class: 'section-head' }, el('h2', { id }, title), desc ? el('p', { class: 'section-head__desc' }, desc) : null, action ? el('div', { class: 'section-head__action' }, action) : null),
      body);
  }
  const card = (title, aside, ...body) => el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, title), aside || null), ...body);
  const empty = (title, hint) => el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, title), hint ? el('div', { class: 'empty__hint' }, hint) : null);
  const zoneOptions = () => MDM.geo.zoneOptions();
  const pickupZones = () => MDM.geo.zoneOptions().filter(o => BUSINESS_ISLANDS.indexOf(MDM.geo.island(o.value)) >= 0);
  const trackHref = o => MDM.href('track/?code=' + encodeURIComponent(o.code));
  const labelsHref = q => MDM.href('labels/?' + q);
  const failBox = () => el('div', { class: 'alert alert--danger', role: 'alert', tabindex: '-1', hidden: true });
  function showFail(box, title, text) {
    box.replaceChildren(html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' }, title ? el('div', { class: 'alert__title' }, title) : null, el('div', null, text)));
    box.hidden = false; box.focus();
  }
  function deliveredAt(o) {
    const h = (o.statusHistory || []).filter(x => x.to === 'delivered').pop();
    if (h) return h.at;
    const e = (o.events || []).filter(x => x.type === 'delivered').pop();
    return e ? e.at : o.updatedAt;
  }
  function priorityTag(o) {
    const p = o.priority || {};
    if (p.status === 'approved') return el('span', { class: 'tag biz-tag--priority' }, (MDM.PRIORITY_LEVELS.find(x => x.value === p.level) || { label: 'Priority' }).label);
    if (p.status === 'requested') return el('span', { class: 'tag' }, 'Priority requested');
    return null;
  }
  function recipientOf(o) { const pkg = (o.packages || [])[0] || {}; const r = (pkg.dropoff && pkg.dropoff.recipient) || {}; return { name: r.name || (o.delivery || {}).recipientName || '', phone: r.phone || (o.delivery || {}).recipientPhone || '' }; }

  // ---- Business size categories, delivery methods, cash on delivery ---------------------------------------------------------
  const tiersOf = acc => MDM.pricing.accountTiers(acc, state.settings);
  const allTiers = () => MDM.pricing.businessTiers(state.settings);
  const tierInfo = v => allTiers().find(t => t.value === v) || null;
  const vesselLabel = v => ((MDM.VESSEL_TYPES.find(x => x.value === v) || {}).label || 'Boat');
  const jettyLabel = v => ((MDM.geo.terminals().find(t => t.value === v) || {}).label || '');
  const airportLabel = v => ((MDM.geo.airportPoints().find(p => p.value === v) || {}).label || '');
  function ratesLine(acc) { return tiersOf(acc).map(t => t.label + ' ' + money(t.rate)).join(' · '); }
  // "Medium · MVR 35" (or "2 × Medium · MVR 70"); older orders without a size category show the package size.
  function tierText(o) {
    const pk = o.packages || [];
    if (!pk.length) return '';
    const p0 = pk[0], t = p0.tier ? tierInfo(p0.tier) : null;
    const name = t ? t.label : MDM.pricing.sizeLabel(p0.size);
    const sum = pk.reduce((n, p) => n + ((p.price && p.price.lineTotal) || 0), 0);
    return (pk.length > 1 ? pk.length + ' × ' : '') + name + ' · ' + money(sum);
  }
  // [main, detail] lines for an order's delivery method.
  function methodLines(o) {
    const d = o.delivery || {}, m = d.method || 'home';
    if (m === 'boat') {
      const b = d.boat || {};
      return [vesselLabel(b.vesselType).replace(' (dhoni)', '') + ' ' + (b.name || ''), ['To ' + (b.island || 'island'), 'departs ' + [fmtDay(b.departureDate), b.departureTime].filter(Boolean).join(' '), jettyLabel(b.jetty)].filter(x => x && x !== 'departs ').join(' · ')];
    }
    if (m === 'cargo') return ['Maldivian Cargo', 'For ' + (((d.cargo || {}).island) || 'island') + ' · counter at the main bus terminal'];
    if (m === 'airport') { const a = d.airport || {}; return ['Airport · ' + (airportLabel(a.point) || 'Velana'), [a.counter, a.resort, a.speedboat ? 'speedboat ' + a.speedboat + (a.departureTime ? ' ' + a.departureTime : '') : ''].filter(Boolean).join(' · ')]; }
    return ['Home delivery', MDM.geo.zoneShort(d.zone) + (d.address ? ' · ' + d.address : '')];
  }
  // Cash on delivery labels as the business reads them: the shared MDM.COD_STATUS says "Paid to the business", here it is "Paid to you".
  const COD_LABELS = Object.assign({}, MDM.COD_STATUS, { remitted: Object.assign({}, MDM.COD_STATUS.remitted, { label: 'Paid to you' }) });
  function codBadge(st) { const s = COD_LABELS[st] || { label: st || 'No cash', kind: 'neutral' }; return html(MDM.ui.badge(s.kind, s.label, { 'data-cod': st })); }
  // A cancelled or returned order never collects its cash: show it as not collected even if the record still says pending.
  function codStatus(o) { if (!o.cod || !(o.cod.amount > 0)) return null; if (o.cod.status === 'pending' && DONE.indexOf(o.status) >= 0 && o.status !== 'delivered') return 'not_collected'; return o.cod.status || 'pending'; }
  // Why and by whom an order was cancelled, and what happens to the package (§5.5).
  function cancelNote(o) {
    const c = o.cancellation || {};
    if (o.status !== 'cancelled') return '';
    const reason = c.reason || o.cancelReason || '';
    const who = c.byBusiness ? 'You cancelled it' : 'Cancelled by us';
    const next = c.returnStatus === 'pending' ? 'the driver is bringing the package back' : c.returnStatus === 'done' ? 'the package was returned' + (c.returnedAt ? ' ' + fmtDate(c.returnedAt) : '') : '';
    return who + (reason ? ': ' + reason : '') + (next ? '. ' + next.charAt(0).toUpperCase() + next.slice(1) + '.' : '.');
  }
  function returnTag(o) {
    const c = o.cancellation || {};
    if (o.status !== 'cancelled' || !c.returnStatus) return null;
    return c.returnStatus === 'done' ? html(MDM.ui.badge('neutral', 'Returned', { 'data-return': 'done' })) : html(MDM.ui.badge('warn', 'Returning to you', { 'data-return': 'pending' }));
  }

  // ---- Data ----------------------------------------------------------------------------------------------------------------
  async function load() {
    const [orders, batches, invoices, settings, acc] = await Promise.all([
      MDM.store.list('orders', { where: { accountId: state.acc.id } }), MDM.store.list('batches', { where: { accountId: state.acc.id } }),
      MDM.store.list('invoices', { where: { accountId: state.acc.id } }), MDM.store.settings(), MDM.store.get('business_accounts', state.acc.id)]);
    state.settings = settings || {};
    if (acc) state.acc = acc;
    return { orders, batches, invoices, settings: state.settings };
  }

  // =========================================================================================================================
  // Public page
  // =========================================================================================================================
  function ratesBlock(s) {
    const rates = s.rates || {};
    const row = MDM.ui.rateRow;
    const tiers = MDM.pricing.businessTiers(s);
    return el('div', null,
      el('div', { class: 'rate-table', 'data-slot': 'rates', 'data-testid': 'business-tiers' },
        row('Package size categories', null, { head: true }),
        tiers.map(t => row(t.label, 'from ' + money(t.rate), { sub: t.hint + ' (' + MDM.pricing.sizeLabel(t.size) + ')', mono: true })),
        row('Your fixed rate', 'Agreed per size', { sub: 'We look at a photo of your typical package and agree a fixed rate for each size you send. Malé and Hulhumalé Phase 1 & 2.' }),
        row('Other deliveries', 'Standard rates', { sub: ['bag', 'box', 'xl'].map(k => MDM.pricing.sizeLabel(k) + ' ' + MDM.pricing.rangeLabel(k, s)).join(' · ') }),
        row('Delivery methods', 'Home, boat, cargo, airport', { sub: 'Cargo deliveries add the Maldivian Cargo fee of ' + money(rates.cargo) + ' and airport deliveries the airport fee of ' + money(rates.airport) }),
        row('Cash on delivery', 'Available', { sub: 'The driver collects the cash from your customer and we pay it to you' }),
        row('Bulk orders', 'Excel or form', { sub: 'Upload an Excel file or type the rows; each package gets its own tracking code and label' }),
        row('Priority and express', 'On request', { sub: 'Ask for a deadline on any open order; our team approves it' }),
        row('Billing', 'Monthly', { sub: 'One invoice for every package delivered that month', valueSub: 'Due in ' + plural(s.invoiceDueDays || 14, 'day') })),
      el('p', { class: 'business-note' }, 'Prices in Maldivian Rufiyaa. The "from" rates are where most accounts start; your agreed rates show in your portal.'));
  }
  function stepsBlock(s) {
    const reply = (s.ops || {}).businessReplyText || 'within 1 working day';
    const items = [
      ['Request an account', 'Fill in the form below with a photo of a typical package. We call you ' + reply + ' to confirm the details.'],
      ['Agree your rates', 'Our team uses the photo to set a fixed rate for each package size you send: small, medium or large.'],
      ['Send orders your way', 'Book one delivery at a time, or upload the day\'s orders from Excel. We collect from your saved collection points.'],
      ['Track, collect cash, get invoiced', 'Every package has a tracking code and a label. Cash on delivery comes back to you, and delivered packages go on one monthly invoice.'],
    ];
    return el('ol', { class: 'steps', 'data-slot': 'steps' }, items.map((it, i) => el('li', { class: 'steps__item' },
      el('div', { class: 'steps__head' }, el('span', { class: 'steps__num mono' }, String(i + 1)), el('h3', { class: 'steps__title' }, it[0])),
      el('p', { class: 'steps__text' }, it[1]))));
  }

  function signinCard() {
    const st = state.signin;
    const body = el('div', { class: 'card__body' });
    const box = el('div', { class: 'card biz-signin', 'data-testid': 'biz-signin' }, el('div', { class: 'card__header' }, el('h2', null, 'Business sign-in'), el('span', { class: 'small muted' }, 'For approved accounts')), body);
    if (st.step === 2) {
      const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '4', placeholder: '4 digits', 'data-testid': 'biz-signin-code' });
      const form = el('form', { class: 'form', novalidate: true, on: { submit: async e => {
        e.preventDefault();
        if (!/^\d{4}$/.test(code.value.trim())) { setError(code, 'Enter the 4-digit code'); code.focus(); return; }
        const phone = MDM.ui.phone.normalize(st.phone);
        const acc = (await MDM.store.list('business_accounts')).find(a => a.phone === phone && a.status === 'approved');
        if (!acc) { setError(code, 'No business account uses this number any more'); return; }
        writeSession(acc); st.step = 1; state.acc = acc;
        if (!location.hash) history.replaceState(null, '', '#overview');
        await render();
      } } },
        MDM.ui.notice('info', 'We sent a code to ' + MDM.ui.phone.format(st.phone) + '. In this demo any 4 digits work.'),
        field('code', 'Code', code),
        el('div', { class: 'form-actions' },
          el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => { st.step = 1; renderPublicSignin(); } } }, 'Use another number'),
          el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'biz-signin-submit' }, 'Sign in')));
      body.appendChild(form);
      setTimeout(() => code.focus(), 0);
      return box;
    }
    const phone = input({ type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '7XX XXXX', value: st.phone, 'data-testid': 'biz-signin-phone' });
    const form = el('form', { class: 'form', novalidate: true, on: { submit: async e => {
      e.preventDefault();
      if (!MDM.ui.phone.valid(phone.value)) { setError(phone, 'Enter the 7-digit mobile number on your business account'); phone.focus(); return; }
      const n = MDM.ui.phone.normalize(phone.value);
      const acc = (await MDM.store.list('business_accounts')).find(a => a.phone === n);
      if (!acc) { setError(phone, 'We have no business account for this number. Request one below.'); phone.focus(); return; }
      if (acc.status !== 'approved') { setError(phone, 'This account is not active yet. We will call you.'); return; }
      st.phone = phone.value; st.step = 2; renderPublicSignin();
    } } },
      field('phone', 'Account mobile number', phone, { hint: 'We send a one-time code to this number. Demo accounts: 780 1122 (Kandu Books), 763 3221 (Fonu Online Store)' }),
      el('div', { class: 'form-actions' }, el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'biz-signin-continue' }, 'Send code')));
    body.appendChild(form);
    return box;
  }
  function renderPublicSignin() { const old = app.querySelector('[data-testid="biz-signin"]'); if (old) old.replaceWith(signinCard()); }

  // Account request form (inserts business_requests; the office approves it under Business → Requests and agrees the rates).
  const requestRules = {
    name: v => v ? null : 'Enter your business name',
    contactName: v => v ? null : 'Enter the name of the person we should call',
    phone: v => !v ? 'Enter a mobile number we can call' : (MDM.ui.phone.valid(v) ? null : 'Enter a 7-digit Maldives mobile number'),
    landline: v => { if (!v) return null; const n = MDM.ui.phone.normalize(v); return n && LANDLINE.test(n) ? null : 'Enter a 7-digit landline number starting with 3 or 6'; },
    email: v => !v ? 'Enter an email address for invoices' : (EMAIL.test(v) ? null : 'Enter a valid email address'),
    zone: v => v ? null : 'Choose your island',
    pickupAddress: v => v ? null : 'Enter the address we pick up from',
    pickupWindow: v => v ? null : 'Choose a pickup window',
    volume: v => v ? null : 'Choose how many packages you expect',
    typicalSize: v => v ? null : 'Choose the size that fits most of your packages',
  };
  // Typical package photo: a dropzone with preview; the image is re-encoded as a JPEG (max 1200 px) before it is stored.
  function photoPicker(onChange) {
    const st = { file: null, img: null, busy: null };
    const fileInput = el('input', { type: 'file', accept: 'image/*', class: 'sr-only', tabindex: '-1', 'data-testid': 'business-photo' });
    const chooseBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'business-photo-choose', on: { click: () => fileInput.click() } }, html(MDM.icon('camera', 16)), 'Choose a photo');
    const body = el('div', { class: 'dropzone__body' });
    const zone = el('div', { class: 'dropzone biz-photo', 'data-testid': 'business-photo-zone' }, body, fileInput);
    function draw() {
      if (st.img) {
        const thumb = el('img', { class: 'dropzone__thumb', src: st.img.dataUrl, alt: 'Your typical package' });
        body.replaceChildren(el('div', { class: 'dropzone__preview' }, thumb,
          el('div', { class: 'dropzone__file' }, el('div', { class: 'dropzone__name' }, st.file.name || 'Package photo'), el('div', { class: 'dropzone__size' }, MDM.ui.formatBytes(st.img.size) + ' · ' + st.img.width + ' × ' + st.img.height)),
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'business-photo-change', on: { click: () => fileInput.click() } }, 'Change photo')));
      } else {
        body.replaceChildren(el('div', { class: 'dropzone__title' }, 'Add a photo of a typical package'),
          el('div', { class: 'dropzone__hint' }, 'The kind of package you send most. Put something next to it for scale, like a phone or an A4 sheet. JPG or PNG.'),
          el('span', { class: 'dropzone__drag dropzone__hint' }, 'You can also drop the photo here.'), chooseBtn);
      }
    }
    async function take(file) {
      if (!file) return;
      if (!/^image\//.test(file.type || '')) { setError(fileInput, 'Choose a photo (JPG or PNG)'); return; }
      st.busy = MDM.ui.imageToJpeg(file, { maxEdge: 1200, quality: 0.8 }).then(img => { st.file = file; st.img = img; setError(fileInput, null); draw(); onChange && onChange(); })
        .catch(() => { setError(fileInput, 'We could not read this photo. Choose a JPG or PNG image.'); })
        .finally(() => { st.busy = null; });
      await st.busy;
    }
    fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; take(f); fileInput.value = ''; });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('is-over'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; take(f); });
    draw();
    return { el: zone, input: fileInput, get: () => st.img ? { file: st.file, img: st.img } : null, ready: () => st.busy || Promise.resolve(), focus: () => (st.img ? body.querySelector('button') : chooseBtn).focus() };
  }
  function requestForm(s) {
    const f = el('form', { class: 'form', novalidate: true, 'data-testid': 'business-form' });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'business-submit' }, 'Request an account');
    const duplicate = MDM.ui.notice('warn', 'We already have a request for this number. We will call you about it.', { testid: 'business-duplicate' });
    duplicate.hidden = true; duplicate.setAttribute('role', 'alert'); duplicate.tabIndex = -1;
    const failure = failBox();
    const photo = photoPicker(() => { failure.hidden = true; });
    const tiers = MDM.pricing.businessTiers(s);
    const sizeSeg = segmented('typicalSize', tiers.map(t => ({ value: t.value, label: t.label, hint: t.hint + ' · from ' + money(t.rate) })), '', 'business-size');
    const photoField = MDM.ui.field({ name: 'packagePhoto', label: 'Photo of a typical package', control: el('fieldset', { class: 'biz-photo-group' }, photo.el), hint: 'Required. Our team uses it to set your fixed rate for each package size.' });
    photo.input.name = 'packagePhoto';
    photo.input.setAttribute('aria-label', 'Photo of a typical package');
    f.append(
      field('name', 'Business name', input({ autocomplete: 'organization', 'data-testid': 'business-name' })),
      field('contactName', 'Contact person', input({ autocomplete: 'name', 'data-testid': 'business-contact' })),
      el('div', { class: 'grid-2' },
        field('phone', 'Mobile', input({ type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '7XX XXXX', 'data-testid': 'business-phone' })),
        field('landline', 'Landline', input({ type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '3XX XXXX' }), { optional: true })),
      field('email', 'Email', input({ type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'name@company.mv', 'data-testid': 'business-email' }), { hint: 'Invoices are sent here' }),
      el('div', { class: 'grid-2' }, field('zone', 'Island', select(pickupZones(), 'Choose an island')), field('pickupWindow', 'Pickup window', select(PICKUP_WINDOWS, 'Choose a window'))),
      field('pickupAddress', 'Pickup address', input({ autocomplete: 'street-address', placeholder: 'M. Kaneerumaage, 2nd floor, Majeedhee Magu', 'data-testid': 'business-address' }), { hint: 'House or building name, floor and road' }),
      field('volume', 'Packages per week', select(VOLUMES, 'Choose a range'), { hint: 'A rough number is fine' }),
      el('div', { class: 'biz-typical stack-4', 'data-testid': 'business-typical' },
        el('h3', null, 'Your typical package'),
        el('p', { class: 'small muted' }, 'Business deliveries have a fixed rate for each package size. Send us a picture of the package you send most and tell us which size you think it is; we confirm the sizes and agree the rates on the call.'),
        photoField,
        MDM.ui.field({ name: 'typicalSize', label: 'Which size is it, in your view?', control: sizeSeg })),
      field('notes', 'Notes', el('textarea', { class: 'textarea', rows: 3 }), { optional: true, hint: 'Opening hours, fragile items or anything the driver should know' }),
      duplicate, failure, el('div', { class: 'form-actions' }, submit));
    f.elements.zone.setAttribute('data-testid', 'business-zone');
    f.elements.pickupWindow.setAttribute('data-testid', 'business-window');
    f.elements.volume.setAttribute('data-testid', 'business-volume');
    const dirty = new Set();
    const valueOf = c => typeof c.value === 'string' ? c.value.trim() : c.value;
    const check = n => { const c = f.elements[n]; const msg = requestRules[n](valueOf(c)); setError(c instanceof RadioNodeList ? c[0] : c, msg); return !msg; };
    const onEdit = e => { const n = e.target.name; if (!n || n === 'packagePhoto') return; dirty.add(n); if (requestRules[n] && e.target.closest('.field').classList.contains('is-invalid')) check(n); if (n === 'phone') duplicate.hidden = true; failure.hidden = true; };
    f.addEventListener('input', onEdit); f.addEventListener('change', onEdit);
    f.addEventListener('focusout', e => { const n = e.target.name; if (n && n !== 'typicalSize' && requestRules[n] && dirty.has(n)) check(n); });
    f.addEventListener('submit', async e => {
      e.preventDefault(); duplicate.hidden = true; failure.hidden = true;
      await photo.ready();
      const r = MDM.ui.validate(f, requestRules);
      const pic = photo.get();
      setError(photo.input, pic ? null : 'Add a photo of a typical package');
      if (!r.ok || !pic) { if (!r.ok) MDM.ui.focusFirstInvalid(f); else { MDM.ui.scrollIntoViewIfNeeded(photo.el); photo.focus(); } return; }
      const phone = MDM.ui.phone.normalize(r.values.phone);
      MDM.ui.setLoading(submit, true);
      let fileRow = null;
      try {
        const existing = await MDM.store.list('business_requests');
        if (existing.some(x => x.phone === phone)) { duplicate.hidden = false; duplicate.focus(); return; }
        fileRow = await MDM.store.insert('files', { kind: 'business_package', orderId: null, name: pic.file.name || 'package.jpg', type: pic.img.type, size: pic.img.size, width: pic.img.width, height: pic.img.height, dataUrl: pic.img.dataUrl, at: new Date().toISOString() });
        state.received = await MDM.store.insert('business_requests', {
          name: r.values.name, contactName: r.values.contactName, phone, landline: MDM.ui.phone.normalize(r.values.landline) || '', email: r.values.email,
          zone: r.values.zone, pickupAddress: r.values.pickupAddress, pickupWindow: r.values.pickupWindow, volume: r.values.volume, notes: valueOf(f.elements.notes),
          typicalSize: r.values.typicalSize, packagePhotoId: fileRow.id, status: 'pending' });
        state.received.photo = pic.img.dataUrl;
        await render();
      } catch (err) {
        if (fileRow && !state.received) MDM.store.remove('files', fileRow.id).catch(() => null);
        showFail(failure, null, 'We could not save your request. ' + (err && err.code === 'quota' ? 'This browser is out of storage space for the demo. Reset demo data from the admin.' : 'Please try again or call us.'));
      } finally { if (document.contains(submit)) MDM.ui.setLoading(submit, false); }
    });
    return f;
  }
  function receivedCard(s) {
    const r = state.received, reply = (s.ops || {}).businessReplyText || 'within 1 working day';
    const t = MDM.pricing.businessTiers(s).find(x => x.value === r.typicalSize);
    return el('div', { class: 'card business-received', 'data-testid': 'business-received' },
      el('div', { class: 'card__header' }, el('h2', { tabindex: '-1' }, 'Request received')),
      el('div', { class: 'card__body stack-4' },
        el('p', null, 'Thanks, ', el('strong', null, r.name), '. We will call ', el('span', { class: 'mono nowrap' }, MDM.ui.phone.format(r.phone)), ' ' + reply + '.'),
        r.photo ? el('div', { class: 'row row--start biz-received-photo' }, el('img', { class: 'thumb', src: r.photo, alt: 'Your typical package' }),
          el('p', { class: 'small muted' }, 'Your typical package' + (t ? ': ' + t.label.toLowerCase() + ' in your view' : '') + '. Our team looks at the photo to set your fixed rate for each package size.')) : null,
        el('p', { class: 'small muted' }, 'Nothing to pay now. The rates and the pickup window are confirmed on the call.'),
        el('a', { class: 'btn btn--secondary', href: MDM.href('') }, 'Back to home')));
  }
  function renderPublic(s) {
    document.title = 'For businesses · Mr. Delivery Man';
    const request = state.received ? receivedCard(s) : requestForm(s);
    app.replaceChildren(el('div', { class: 'container container--narrow' },
      el('div', { class: 'page-head' }, el('h1', null, 'Delivery for businesses'),
        el('p', { class: 'page-head__desc' }, 'Daily pickups from your shop or godown, a fixed rate for each package size, bulk orders from Excel, cash on delivery and one invoice a month.')),
      signinCard(),
      section('Sizes and rates', null, ratesBlock(s)),
      section('How it works', null, stepsBlock(s)),
      section('Request an account', 'Tell us about your business and send a photo of a typical package. We call you to set up the account, your rates and the pickup routine.', request)));
    if (state.received) { const h = app.querySelector('.business-received h2'); if (h) h.focus(); }
  }

  // =========================================================================================================================
  // Portal
  // =========================================================================================================================
  function hashParts() { const h = (location.hash || '').replace(/^#\/?/, ''); const i = h.indexOf('?'); return { key: i >= 0 ? h.slice(0, i) : h, params: new URLSearchParams(i >= 0 ? h.slice(i + 1) : '') }; }
  function tabFromHash() { const k = hashParts().key; return TABS.some(t => t.key === k) ? k : 'overview'; }
  function go(tab) { if (location.hash !== '#' + tab) location.hash = tab; else renderTab(); }
  let panel = null, tabsEl = null, headDesc = null;

  function renderPortal() {
    const acc = state.acc;
    document.title = acc.name + ' · Business · Mr. Delivery Man';
    tabsEl = el('nav', { class: 'tabs biz-tabs', 'aria-label': 'Business portal' }, TABS.map(t => el('a', { class: 'tab', href: '#' + t.key, 'data-tab': t.key, 'data-testid': 'biz-tab-' + t.key }, t.label)));
    panel = el('div', { class: 'biz-panel', 'data-testid': 'biz-panel' });
    headDesc = el('p', { class: 'page-head__desc', 'data-testid': 'biz-head-rates' }, 'Business account · ' + ratesLine(acc) + ' per package · invoiced monthly');
    app.replaceChildren(el('div', { class: 'container' },
      el('div', { class: 'page-head biz-head' },
        el('h1', null, acc.name), headDesc,
        el('div', { class: 'page-head__actions' },
          el('button', { type: 'button', class: 'btn btn--brand', 'data-testid': 'biz-head-new', on: { click: () => go('new') } }, html(MDM.icon('plus', 16)), 'New order'),
          el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'biz-signout', on: { click: () => { clearSession(); state.acc = null; history.replaceState(null, '', location.pathname); render(); } } }, 'Sign out'))),
      tabsEl, panel));
    renderTab();
  }
  let renderSeq = 0;
  async function renderTab() {
    if (!panel) return;
    state.tab = tabFromHash();
    const seq = ++renderSeq;
    tabsEl.querySelectorAll('[data-tab]').forEach(a => { if (a.dataset.tab === state.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const fn = { overview: tabOverview, new: tabNew, bulk: tabBulk, excel: tabExcel, orders: tabOrders, cod: tabCod, points: tabPoints, priority: tabPriority, invoices: tabInvoices, labels: tabLabels }[state.tab];
    const node = await fn();
    if (seq !== renderSeq) return;   // a newer render started while this one was loading
    if (headDesc && state.acc) headDesc.textContent = 'Business account · ' + ratesLine(state.acc) + ' per package · invoiced monthly';
    panel.replaceChildren(node);
  }
  // Store changes refresh the read-only tabs; tabs with a form in progress keep their inputs.
  const LIVE_TABS = ['overview', 'orders', 'cod', 'points', 'invoices', 'labels'];
  const refresh = MDM.ui.debounce(() => {
    if (!state.acc || document.querySelector('dialog[open]')) return;
    if (LIVE_TABS.indexOf(state.tab) >= 0) renderTab(); else if (state.tab === 'priority') refreshPriorityList();
  }, 150);

  // ---- Overview -------------------------------------------------------------------------------------------------------------
  function kpi(label, value, note, testid) { return el('div', { class: 'kpi', 'data-testid': testid || null }, el('div', { class: 'kpi__label' }, label), el('div', { class: 'kpi__value' }, value), note ? el('div', { class: 'kpi__note' }, note) : null); }
  function batchProgress(b) {
    const st = MDM.store._batchStatus(b);
    const pct = st.total ? Math.round((st.delivered / st.total) * 100) : 0;
    return { st, pct, bar: el('div', { class: 'biz-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(st.total), 'aria-valuenow': String(st.delivered), 'aria-label': st.delivered + ' of ' + st.total + ' delivered' }, el('span', { style: { width: pct + '%' } })) };
  }
  const batchHref = b => '#orders?batch=' + encodeURIComponent(b.id);
  // The bulk order's own status (store._batchStatus). 'partly_delivered' is a batch-only status: some packages delivered, none out.
  function batchBadge(st) {
    if (st.status === 'partly_delivered') return html(MDM.ui.badge('info', 'Partly delivered', { 'data-batch-status': st.status }));
    return html(MDM.badgeFor(st.status === 'paid' ? 'delivered' : st.status));
  }
  function batchRow(b) {
    const p = batchProgress(b);
    const parts = [plural(p.st.total, 'package'), p.st.delivered + ' delivered'];
    if (p.st.out) parts.push(p.st.out + ' out for delivery');
    if (p.st.collected) parts.push(p.st.collected + ' at the hub');
    if (p.st.failed) parts.push(p.st.failed + ' failed');
    if (p.st.cancelled) parts.push(p.st.cancelled + ' cancelled');
    return el('div', { class: 'list__item biz-batch', 'data-testid': 'biz-batch-' + b.code },
      el('div', { class: 'list__main' },
        el('div', { class: 'list__title' }, el('span', { class: 'mono--code' }, b.code), ' ', batchBadge(p.st)),
        el('div', { class: 'list__meta' }, fmtDate(b.createdAt) + ' · ' + parts.join(' · ') + (b.notes ? ' · ' + b.notes : '')),
        p.bar),
      el('div', { class: 'list__aside biz-actions' },
        el('a', { class: 'btn btn--secondary btn--sm', href: labelsHref('batch=' + encodeURIComponent(b.id)), 'data-testid': 'biz-batch-labels' }, html(MDM.icon('printer', 16)), 'Labels'),
        el('a', { class: 'btn btn--ghost btn--sm', href: batchHref(b), 'data-testid': 'biz-batch-open' }, 'Open')));
  }
  function orderRow(o) {
    const r = recipientOf(o);
    return el('a', { class: 'list__item list__item--link', href: trackHref(o), 'data-testid': 'biz-order-' + o.code },
      el('div', { class: 'list__main' },
        el('div', { class: 'list__title' }, el('span', { class: 'mono--code' }, o.code), ' · ', r.name || 'Recipient', ' ', priorityTag(o)),
        el('div', { class: 'list__meta' }, methodLines(o)[0] + ' · ' + tierText(o) + ' · ' + MDM.ui.timeAgo(o.createdAt))),
      el('div', { class: 'list__aside' }, html(MDM.badgeFor(o.status))));
  }
  async function ratesCard(acc) {
    const tiers = tiersOf(acc), s = state.settings, rates = s.rates || {};
    const photo = acc.packagePhotoId ? await MDM.store.get('files', acc.packagePhotoId) : null;
    return el('div', { class: 'card', 'data-testid': 'biz-rates' },
      el('div', { class: 'card__header' }, el('h2', null, 'Your rates'), el('span', { class: 'small muted' }, 'Fixed rate per package')),
      el('div', { class: 'card__body stack-4' },
        el('div', { class: 'rate-table' }, tiers.map(t => MDM.ui.rateRow(t.label, money(t.rate), { sub: t.hint + ' (' + MDM.pricing.sizeLabel(t.size) + ')', mono: true }))),
        photo && photo.dataUrl ? el('div', { class: 'row row--start biz-photo-note' }, el('img', { class: 'thumb', src: photo.dataUrl, alt: 'Your typical package' }),
          el('p', { class: 'small muted' }, acc.assessment ? 'Our assessment of your typical package: ' + acc.assessment + '.' : 'Rates agreed from the photo of your typical package.')) : null,
        el('p', { class: 'small muted' }, 'Cargo deliveries add the Maldivian Cargo fee of ' + money(rates.cargo) + ' and airport deliveries the airport fee of ' + money(rates.airport) + '. To add a size or change a rate, call us.')));
  }
  function pointsSummaryCard(acc) {
    const pts = acc.collectionPoints || [];
    return el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Collection points'), el('a', { class: 'btn btn--ghost btn--sm', href: '#points' }, 'Manage')),
      pts.length ? el('div', { class: 'list biz-plist' }, pts.map(p => el('div', { class: 'list__item' },
        el('div', { class: 'list__main' }, el('div', { class: 'list__title' }, p.label, ' ', p.isDefault ? html(MDM.ui.badge('info', 'Default')) : null),
          el('div', { class: 'list__meta' }, p.address + ' · ' + MDM.geo.zoneShort(p.zone) + (p.preferredTime ? ' · collect around ' + p.preferredTime : '')))))) : empty('No collection points yet', 'Add your shop, godown or warehouse under Collection points.'));
  }
  async function tabOverview() {
    const d = await load();
    const acc = state.acc;
    const month = MDM.ui.monthKey();
    const open = d.orders.filter(o => OPEN.indexOf(o.status) >= 0);
    const delivered = d.orders.filter(o => o.status === 'delivered' && MDM.ui.monthKey(deliveredAt(o)) === month);
    const amount = delivered.reduce((n, o) => n + (o.totals ? o.totals.total : 0), 0);
    const pri = d.orders.filter(o => o.priority && o.priority.status === 'requested');
    const failed = d.orders.filter(o => o.status === 'failed');
    const returning = d.orders.filter(o => o.status === 'cancelled' && o.cancellation && o.cancellation.returnStatus === 'pending');
    const codPending = d.orders.filter(o => codStatus(o) === 'pending');
    const codHeld = d.orders.filter(o => codStatus(o) === 'collected' || codStatus(o) === 'with_office');
    const recent = d.orders.slice(0, 6);
    const batches = d.batches.slice(0, 4);
    return el('div', { class: 'stack-6' },
      el('div', { class: 'kpi-row' },
        kpi('Open orders', String(open.length), open.filter(o => o.status === 'out_for_delivery').length + ' out for delivery now', 'biz-kpi-open'),
        kpi('Delivered this month', String(delivered.length), plural(delivered.reduce((n, o) => n + (o.packages || []).length, 0), 'package')),
        kpi('This month so far', money(amount), 'Invoiced at the end of the month', 'biz-kpi-amount'),
        kpi('Cash to collect', money(codPending.reduce((n, o) => n + o.cod.amount, 0)), money(codHeld.reduce((n, o) => n + (o.cod.collectedAmount || 0), 0)) + ' collected, not paid to you yet', 'biz-kpi-cod'),
        kpi('Priority requests', String(pri.length), pri.length ? 'Waiting for our team' : 'None waiting')),
      failed.length ? MDM.ui.notice('warn', el('div', null, plural(failed.length, 'delivery', 'deliveries') + ' could not be completed. We will contact you, or call us. ',
        failed.map((o, i) => [i ? ', ' : '', el('a', { href: trackHref(o) }, o.code)])), { title: 'Needs attention' }) : null,
      returning.length ? MDM.ui.notice('info', el('div', null, 'The driver is bringing ' + plural(returning.length, 'cancelled package') + ' back to you: ',
        returning.map((o, i) => [i ? ', ' : '', el('a', { href: trackHref(o) }, o.code)]), '.'), { title: 'Returning to you', testid: 'biz-returning' }) : null,
      el('div', { class: 'grid-2 biz-overview' }, await ratesCard(acc), pointsSummaryCard(acc)),
      el('div', { class: 'grid-2 biz-overview' },
        el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Bulk orders'), el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => go('bulk') } }, 'New bulk order')),
          batches.length ? el('div', { class: 'list' }, batches.map(batchRow)) : empty('No bulk orders yet', 'Upload the day\'s deliveries from Excel or type them under Bulk order.')),
        el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Recent orders'), el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => go('orders') } }, 'All orders')),
          recent.length ? el('div', { class: 'list' }, recent.map(orderRow)) : empty('No orders yet', 'Book your first delivery under New order.'))));
  }

  // ---- Collection (shared by New order, Bulk order and Excel import) --------------------------------------------------------------
  // collectionBlock(acc, { once }) → { el, value(), validate(), zone() }: a saved collection point (default preselected) or a one-off
  // address, the optional preferred collection time (prefilled from the point) and collection instructions.
  function collectionBlock(acc, opts) {
    opts = opts || {};
    const pts = acc.collectionPoints || [];
    const def = pts.find(p => p.isDefault) || pts[0] || null;
    const pointSel = select(pts.map(p => ({ value: p.id, label: p.label + ' · ' + p.address })).concat([{ value: 'once', label: opts.onceLabel || 'Another address (this order only)' }]), null, def ? def.id : 'once');
    pointSel.setAttribute('data-testid', 'biz-c-point');
    const summary = el('p', { class: 'small muted biz-point-summary', 'data-testid': 'biz-c-summary' });
    const cAddress = input({ value: '', placeholder: 'House or building, floor, road', 'data-testid': 'biz-c-address' });
    const cZone = select(zoneOptions(), null, acc.zone || 'male');
    const cLandmark = input({ placeholder: 'Near the stadium' });
    const cName = input({ value: acc.contactName || '', autocomplete: 'name' });
    const cPhone = input({ type: 'tel', inputmode: 'numeric', value: acc.phone || '' });
    const once = el('div', { class: 'stack-4', hidden: true },
      el('div', { class: 'grid-2' }, field('cAddress', 'Collection address', cAddress), field('cZone', 'Area', cZone)),
      field('cLandmark', 'Landmark', cLandmark, { optional: true }),
      el('div', { class: 'grid-2' }, field('cName', 'Contact person', cName), field('cPhone', 'Contact number', cPhone)));
    const time = input({ type: 'time', 'data-testid': 'biz-c-time' });
    const note = input({ placeholder: 'Ask for the dispatch shelf', 'data-testid': 'biz-c-note' });
    const point = () => pts.find(p => p.id === pointSel.value) || null;
    function sync(setTime) {
      const p = point();
      once.hidden = !!p;
      summary.hidden = !p;
      if (p) summary.textContent = p.address + ' · ' + MDM.geo.zoneLabel(p.zone) + (p.landmark ? ' · ' + p.landmark : '') + ' · ' + (p.contactName || acc.contactName || '') + ' ' + MDM.ui.phone.format(p.contactPhone || acc.phone);
      if (setTime) time.value = p ? (p.preferredTime || '') : '';
    }
    pointSel.addEventListener('change', () => { sync(true); if (opts.onChange) opts.onChange(); });
    sync(true);
    const pointField = field('cPoint', 'Collect from', pointSel, { hint: pts.length ? null : 'Save your shop or godown under Collection points to pick it here next time.' });
    pointField.insertBefore(summary, pointField.querySelector('.field__error'));
    const node = el('div', { class: 'stack-4' },
      pointField, once,
      el('div', { class: 'grid-2' },
        field('cTime', 'Preferred collection time', time, { optional: true, hint: 'We plan the pickup around this time' }),
        field('cNote', 'Collection instructions', note, { optional: true })));
    return {
      el: node,
      zone: () => { const p = point(); return p ? p.zone : cZone.value; },
      value() {
        const p = point(), extra = { instructions: note.value.trim(), preferredTime: time.value || '' };
        if (p) return Object.assign({ pointId: p.id, label: p.label, address: p.address, zone: p.zone, landmark: p.landmark || '', contactName: p.contactName || acc.contactName || '', contactPhone: p.contactPhone || acc.phone }, extra);
        return Object.assign({ pointId: null, label: '', address: cAddress.value.trim(), zone: cZone.value, landmark: cLandmark.value.trim(), contactName: cName.value.trim(), contactPhone: MDM.ui.phone.normalize(cPhone.value) || cPhone.value.trim() }, extra);
      },
      validate() {
        if (point()) return true;
        const a = cAddress.value.trim() ? null : 'Enter the collection address';
        const z = cZone.value ? null : 'Choose the area';
        const ph = MDM.ui.phone.valid(cPhone.value, { landline: true }) ? null : 'Enter a valid contact number';
        setError(cAddress, a); setError(cZone, z); setError(cPhone, ph);
        return !a && !z && !ph;
      },
    };
  }

  // ---- New order (single delivery, §3 delivery methods) ---------------------------------------------------------------------------
  function scheduleBlock(form) {
    const adv = el('div', { class: 'grid-2 biz-advance', hidden: true },
      field('collectDate', 'Collection date', input({ type: 'date' })), field('collectTime', 'Collection time', input({ type: 'time', value: '10:00' })),
      field('deliverDate', 'Delivery date', input({ type: 'date' })), field('deliverTime', 'Delivery time', input({ type: 'time', value: '14:00' })));
    const seg = segmented('level', MDM.SERVICE_LEVELS.map(l => ({ value: l.value, label: l.label, hint: l.value === 'normal' ? 'Same day' : l.value === 'express' ? 'Confirmed by us' : 'Pick a date' })), 'normal', 'biz-level');
    seg.addEventListener('change', () => { adv.hidden = form.elements.level.value !== 'advance'; });
    return [MDM.ui.field({ label: 'Service', control: seg, hint: 'Express is subject to availability; our team confirms it. Advance orders are collected on the date you choose.' }), adv];
  }
  function scheduleValue(v) {
    if (v.level === 'advance') return { type: 'advance', collectDate: v.collectDate, collectTime: v.collectTime, deliverDate: v.deliverDate || v.collectDate, deliverTime: v.deliverTime };
    return { type: 'asap' };
  }
  function advanceRules(v) {
    if (v.level !== 'advance') return {};
    const today = MDM.ui.dayKey();
    return { collectDate: !v.collectDate ? 'Choose the collection date' : (v.collectDate < today ? 'Choose today or a later date' : null),
      deliverDate: v.deliverDate && v.deliverDate < v.collectDate ? 'Delivery cannot be before collection' : null };
  }
  // deliveryBlock(form) → { el, method(), row(), rules() }: the §3 fields for the chosen delivery method, read into the same row shape
  // the bulk editor uses (so MDM.bizKit.delivery() builds the order's delivery object for both).
  function deliveryBlock(form, s, onMethod) {
    const methodSeg = segmented('method', MDM.DELIVERY_METHODS.map(m => ({ value: m.value, label: m.label })), 'home', 'biz-method');
    const rates = s.rates || {};
    const panels = {
      home: el('div', { class: 'stack-4', 'data-method': 'home' },
        field('dAddress', 'Delivery address', input({ placeholder: 'House or building, floor, road', 'data-testid': 'biz-d-address' })),
        el('div', { class: 'grid-2' }, field('dZone', 'Area', select(zoneOptions().filter(o => !K.airportZone(o.value)), 'Choose the area', '')), field('dLandmark', 'Landmark', input({ placeholder: 'Near the school' }), { optional: true }))),
      boat: el('div', { class: 'stack-4', 'data-method': 'boat', hidden: true },
        el('div', { class: 'grid-2' }, field('bIsland', 'Destination island', input({ placeholder: 'Thulusdhoo, Kaafu Atoll', 'data-testid': 'biz-b-island' })), field('bAddress', 'Address on the island', input({ placeholder: 'House name', 'data-testid': 'biz-b-address' }), { optional: true })),
        MDM.ui.field({ name: 'bVessel', label: 'Vessel', control: segmented('bVessel', MDM.VESSEL_TYPES.map(v => ({ value: v.value, label: v.label })), 'speedboat', 'biz-b-vessel') }),
        el('div', { class: 'grid-2' }, field('bName', 'Boat, ferry or speedboat name', input({ placeholder: 'Thulusdhoo Express', 'data-testid': 'biz-b-name' })), field('bJetty', 'Harbour or jetty', select(K.jettyOptions(), null, 'male_jetties'))),
        el('div', { class: 'grid-2' }, field('bDate', 'Departure date', input({ type: 'date', value: MDM.ui.dayKey(), 'data-testid': 'biz-b-date' })), field('bTime', 'Departure time', input({ type: 'time', 'data-testid': 'biz-b-time' }))),
        el('p', { class: 'small muted' }, 'The driver hands the package to the vessel at the jetty. The label prints the island, the vessel, the departure and the receiver\'s contact; you can update the boat later if it changes.')),
      cargo: el('div', { class: 'stack-4', 'data-method': 'cargo', hidden: true },
        field('kIsland', 'Destination island', input({ placeholder: 'Kulhudhuffushi, Haa Dhaalu', 'data-testid': 'biz-k-island' })),
        MDM.ui.notice('info', 'We hand the package in at the cargo counter at the main bus terminal. The Maldivian Cargo fee of ' + money(rates.cargo) + ' is added to this order as its own line.')),
      airport: el('div', { class: 'stack-4', 'data-method': 'airport', hidden: true },
        el('div', { class: 'grid-2' }, field('aPoint', 'Collection point at the airport', select(K.airportOptions(), null, 'resort_counters')), field('aCounter', 'Resort counter or person', input({ placeholder: 'Lagoon Point Resort counter', 'data-testid': 'biz-a-counter' }), { optional: true })),
        field('aResort', 'Resort or destination', input({ placeholder: 'Lagoon Point Resort, Baa Atoll', 'data-testid': 'biz-a-resort' })),
        el('div', { class: 'grid-2' }, field('aSpeedboat', 'Resort speedboat', input({ placeholder: 'Lagoon Express 3' }), { optional: true }), field('aTime', 'Speedboat departure', input({ type: 'time' }), { optional: true })),
        el('p', { class: 'small muted' }, 'The airport fee of ' + money(rates.airport) + ' applies. Put anything the resort host needs in the instructions.')),
    };
    const node = el('div', { class: 'stack-4' },
      MDM.ui.field({ name: 'method', label: 'Delivery method', control: methodSeg }),
      el('div', { class: 'grid-2' }, field('dName', 'Receiver name', input({ autocomplete: 'off', 'data-testid': 'biz-d-name' })), field('dPhone', 'Receiver contact number', input({ type: 'tel', inputmode: 'numeric', placeholder: '7XX XXXX', 'data-testid': 'biz-d-phone' }))),
      panels.home, panels.boat, panels.cargo, panels.airport,
      field('dNote', 'Delivery instructions', input({ placeholder: 'Call before arriving', 'data-testid': 'biz-d-note' }), { optional: true }));
    const noteField = node.querySelector('[data-field="dNote"] > label');
    const method = () => form.elements.method ? form.elements.method.value : 'home';
    methodSeg.addEventListener('change', () => {
      const m = method();
      Object.keys(panels).forEach(k => { panels[k].hidden = k !== m; });
      if (noteField) noteField.firstChild.textContent = m === 'airport' ? 'Instructions for the airport or resort handover' : 'Delivery instructions';
      if (onMethod) onMethod(m);
    });
    const val = n => form.elements[n] ? String(form.elements[n].value || '').trim() : '';
    return {
      el: node, method,
      row() {
        const m = method();
        return { method: m, name: val('dName'), phone: val('dPhone'), address: m === 'boat' ? val('bAddress') : val('dAddress'), zone: val('dZone'), landmark: val('dLandmark'),
          island: m === 'cargo' ? val('kIsland') : val('bIsland'), vesselType: val('bVessel') || 'speedboat', boatName: val('bName'), departureDate: val('bDate'), departureTime: m === 'airport' ? val('aTime') : val('bTime'), jetty: val('bJetty'),
          airportPoint: val('aPoint') || 'resort_counters', counter: val('aCounter'), resort: val('aResort'), speedboat: val('aSpeedboat'), instructions: val('dNote'), raw: {} };
      },
      rules() {
        const m = method();
        const r = {
          dName: v => v ? null : 'Enter the receiver\'s name',
          dPhone: v => !v ? 'Enter the receiver\'s contact number' : (MDM.ui.phone.valid(v, { intl: true }) ? null : 'Enter a 7-digit Maldives number, or + and the country code'),
        };
        if (m === 'home') { r.dAddress = v => v ? null : 'Enter the delivery address'; r.dZone = v => v ? null : 'Choose the area'; }
        if (m === 'boat') {
          r.bIsland = v => v ? null : 'Enter the destination island'; r.bName = v => v ? null : 'Enter the boat, ferry or speedboat name';
          r.bJetty = v => v ? null : 'Choose the harbour or jetty'; r.bTime = v => v ? null : 'Enter the departure time';
          r.bDate = v => !v ? 'Choose the departure date' : (v < MDM.ui.dayKey() ? 'Choose today or a later date' : null);
        }
        if (m === 'cargo') r.kIsland = v => v ? null : 'Enter the destination island';
        if (m === 'airport') r.aResort = v => v ? null : 'Enter the resort or destination';
        return r;
      },
    };
  }
  async function tabNew() {
    const acc = state.acc, s = await MDM.store.settings();
    state.settings = s || {};
    if (state.done.order) return newOrderDone(state.done.order);
    const tiers = tiersOf(acc);
    const form = el('form', { class: 'biz-form', novalidate: true, 'data-testid': 'biz-new-form' });
    const priceBox = el('div', { class: 'summary biz-price', 'data-testid': 'biz-new-price' });
    const failure = failBox();
    const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg', 'data-testid': 'biz-new-submit' }, 'Book delivery');
    const collection = collectionBlock(acc);
    const tierSeg = segmented('tier', tiers.map(t => ({ value: t.value, label: t.label + ' · ' + money(t.rate), hint: t.hint })), (tiers[0] || {}).value, 'biz-tier');
    const qty = input({ type: 'number', inputmode: 'numeric', min: '1', max: '20', step: '1', value: '1', 'data-testid': 'biz-qty' });
    const vehicle = el('label', { class: 'checkbox', hidden: true, 'data-testid': 'biz-vehicle' }, el('input', { type: 'checkbox', name: 'extraVehicle' }),
      el('span', null, 'Send an extra vehicle'), el('span', { class: 'checkbox__hint' }, 'More than one box or XL package. We confirm the vehicle charge before collection.'));
    const cod = input({ inputmode: 'decimal', placeholder: '0', 'data-testid': 'biz-cod' });
    const dblock = deliveryBlock(form, s, () => updatePrice());
    form.append(
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Collection')), el('div', { class: 'card__body' }, collection.el)),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Package')), el('div', { class: 'card__body stack-4' },
        MDM.ui.field({ name: 'tier', label: 'Package size', control: tierSeg, hint: 'Your agreed sizes and rates. To add a size, call us.' }),
        el('div', { class: 'grid-2' }, field('qty', 'Number of packages', qty, { hint: 'Same size, same receiver' }), field('description', 'What is it', input({ placeholder: 'Sneakers, size 42', 'data-testid': 'biz-description' }), { optional: true })),
        vehicle,
        el('div', { class: 'grid-2' }, field('reference', 'Your reference', input({ placeholder: 'Invoice or order number', 'data-testid': 'biz-reference' }), { optional: true }), el('div')),
        el('label', { class: 'checkbox' }, el('input', { type: 'checkbox', name: 'fragile' }), el('span', null, 'Fragile, handle with care')),
        scheduleBlock(form))),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Delivery')), el('div', { class: 'card__body' }, dblock.el)),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Cash on delivery')), el('div', { class: 'card__body stack-4' },
        el('div', { class: 'grid-2' }, field('cod', 'Cash to collect from the receiver (MVR)', cod, { optional: true, hint: 'Leave empty if the order is paid. The driver collects it and we pay it to you.' }), el('div')))),
      priceBox, failure,
      el('div', { class: 'form-actions' }, el('span', { class: 'small muted' }, 'Added to your monthly invoice. Nothing to pay now.'), submit));
    form.elements.dZone.setAttribute('data-testid', 'biz-d-zone');
    form.elements.bJetty.setAttribute('data-testid', 'biz-b-jetty');
    form.elements.aPoint.setAttribute('data-testid', 'biz-a-point');
    const tierNow = () => tiers.find(t => t.value === (form.elements.tier ? form.elements.tier.value : '')) || tiers[0];
    const qtyNow = () => Math.max(1, Math.min(20, Math.round(Number(qty.value) || 1)));
    function packagesFor(v, row) {
      const t = tierNow(), n = qtyNow(), c = collection.value();
      const end = MDM.deliveryEndpoint(K.delivery(Object.assign({}, row, { zone: row.zone || 'male' })));
      const out = [];
      for (let i = 0; i < n; i++) out.push({ id: MDM.id('pkg'), size: t.size, tier: t.value, description: v.description || '', fragile: !!v.fragile, underOneFt: t.size === 'bag', needsVehicle: false, notes: v.reference || '',
        pickup: { address: c.address, zone: c.zone, landmark: c.landmark || '', contact: { name: c.contactName, phone: c.contactPhone }, instructions: c.instructions || '' },
        dropoff: row.method === 'home' ? { address: row.address, zone: row.zone, landmark: row.landmark || '', recipient: { name: row.name, phone: MDM.ui.phone.normalize(row.phone) || row.phone }, instructions: row.instructions || '', meetAt: 'door' }
          : { recipient: { name: row.name, phone: MDM.ui.phone.normalize(row.phone) || row.phone }, instructions: row.instructions || '', zone: end.zone } });
      return out;
    }
    const values = () => {
      const v = {}; ['description', 'reference', 'collectDate', 'collectTime', 'deliverDate', 'deliverTime'].forEach(k => { const c = form.elements[k]; v[k] = c ? String(c.value || '').trim() : ''; });
      v.level = form.elements.level.value; v.fragile = form.elements.fragile.checked;
      return v;
    };
    function updatePrice() {
      const t = tierNow(), n = qtyNow(), row = dblock.row();
      const eligible = MDM.extraVehicleEligible(Array.from({ length: n }, () => ({ size: t.size })));
      vehicle.hidden = !eligible; if (!eligible) form.elements.extraVehicle.checked = false;
      const pk = packagesFor(values(), row).map(p => Object.assign({}, p, { tierRate: t.rate, dropoff: row.method === 'home' ? Object.assign({}, p.dropoff, { zone: row.zone || 'male' }) : MDM.deliveryEndpoint(K.delivery(row)) }));
      const q = MDM.pricing.quote({ service: 'business', packages: pk }, s);
      const codAmt = K.parseMoney(cod.value);
      priceBox.replaceChildren(...[
        el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, (n > 1 ? n + ' × ' : '') + t.label, el('small', null, 'Your rate ' + money(t.rate) + ' per package')), el('span', { class: 'summary__amount' }, money(q.totals.packages))),
        q.feeLines.map(f => el('div', { class: 'summary__line summary__line--fee', 'data-fee': f.key }, el('span', { class: 'summary__desc' }, f.label, f.reason && f.key !== 'cargo' ? el('small', null, f.reason) : null), el('span', { class: 'summary__amount' }, money(f.amount)))),
        el('div', { class: 'summary__line summary__total' }, el('span', { class: 'summary__desc' }, 'Total'), el('span', { class: 'summary__amount', 'data-testid': 'biz-new-total' }, money(q.totals.total))),
        form.elements.extraVehicle.checked ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Extra vehicle: we confirm the charge before collection.')) : null,
        codAmt > 0 ? el('div', { class: 'summary__line summary__line--fee', 'data-testid': 'biz-new-cod' }, el('span', { class: 'summary__desc' }, 'Cash to collect from the receiver', el('small', null, 'Paid to you after delivery, not part of the price')), el('span', { class: 'summary__amount' }, money(codAmt))) : null,
        v0().level === 'express' ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Express handling is confirmed by our team, any extra charge is shown before collection.')) : null].flat().filter(Boolean));
    }
    const v0 = () => ({ level: form.elements.level ? form.elements.level.value : 'normal' });
    form.addEventListener('input', updatePrice); form.addEventListener('change', updatePrice); updatePrice();
    form.addEventListener('submit', async e => {
      e.preventDefault(); failure.hidden = true;
      const rules = Object.assign({
        qty: v => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 20 ? null : 'Enter 1 to 20 packages'; },
        cod: v => K.parseMoney(v) == null ? 'Enter an amount of 0 or more, numbers only' : null,
      }, dblock.rules());
      const r = MDM.ui.validate(form, rules);
      const cOk = collection.validate();
      const v = values();
      const extra = advanceRules(v);
      Object.keys(extra).forEach(k => { if (form.elements[k]) setError(form.elements[k], extra[k]); });
      if (!r.ok || !cOk || Object.keys(extra).some(k => extra[k])) { MDM.ui.focusFirstInvalid(form); return; }
      MDM.ui.setLoading(submit, true);
      try {
        const row = dblock.row(), t = tierNow(), c = collection.value();
        const d = K.delivery(row);
        const pkgs = packagesFor(v, row);
        const extraVehicle = !vehicle.hidden && form.elements.extraVehicle.checked;
        const order = await MDM.store.createOrder({
          source: 'business', requestType: 'business', service: 'business', serviceLevel: v.level, accountId: acc.id, by: 'business:' + acc.id,
          customer: { name: acc.name, phone: acc.phone, email: acc.email || '', notify: 'whatsapp' },
          collection: { pointId: c.pointId, address: c.address, zone: c.zone, landmark: c.landmark, contactName: c.contactName, contactPhone: c.contactPhone, instructions: c.instructions, preferredTime: c.preferredTime },
          delivery: d, details: { reference: v.reference, tier: t.value }, packages: pkgs, schedule: scheduleValue(v),
          payment: { method: 'invoice', status: 'invoiced' }, cod: K.parseMoney(cod.value) || 0, extraVehicle,
          // An extra vehicle needs its charge confirmed first; everything else is priced at the agreed rate.
          status: extraVehicle ? 'requested' : 'confirmed',
        });
        state.done.order = order;
        renderTab();
        MDM.ui.toast('Delivery booked: ' + order.code, 'ok');
      } catch (err) { showFail(failure, null, (err && err.message) || 'We could not book this delivery. Please try again.'); }
      finally { if (document.contains(submit)) MDM.ui.setLoading(submit, false); }
    });
    return el('div', { class: 'biz-two' }, form, el('aside', { class: 'biz-aside' }, el('div', { class: 'card' }, el('div', { class: 'card__body stack-3 small' },
      el('h3', null, 'Many packages today?'), el('p', { class: 'muted' }, 'Use Bulk order to type the rows, or Excel import to upload your sheet. Every row becomes its own trackable delivery with a label.'),
      el('div', { class: 'row row--wrap' },
        el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => go('bulk') } }, 'Bulk order'),
        el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => go('excel') } }, 'Excel import'))))));
  }
  function newOrderDone(o) {
    const title = el('h2', { tabindex: '-1' }, 'Delivery booked');
    setTimeout(() => title.focus(), 0);
    const m = methodLines(o);
    return el('div', { class: 'card biz-done', 'data-testid': 'biz-new-done' },
      el('div', { class: 'card__header' }, title, html(MDM.badgeFor(o.status))),
      el('div', { class: 'card__body stack-4' },
        el('p', null, 'Order ', el('strong', { class: 'mono--code' }, o.code), ' to ', el('strong', null, o.delivery.recipientName), '. ',
          o.status === 'requested' ? 'We confirm the price before collection.' : 'Priced at ' + money(o.totals.total) + ', added to your monthly invoice.'),
        el('div', { class: 'rate-table' },
          MDM.ui.rateRow('Package', tierText(o)),
          MDM.ui.rateRow('Delivery', m[0], { sub: m[1] }),
          o.cod ? MDM.ui.rateRow('Cash to collect', money(o.cod.amount), { mono: true }) : null),
        el('div', { class: 'row row--wrap' },
          el('a', { class: 'btn btn--primary', href: labelsHref('order=' + encodeURIComponent(o.id)), 'data-testid': 'biz-done-label' }, html(MDM.icon('printer', 16)), 'Print ' + plural((o.packages || []).length, 'label')),
          el('a', { class: 'btn btn--secondary', href: trackHref(o) }, 'Track'),
          el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'biz-new-another', on: { click: () => { state.done.order = null; renderTab(); } } }, 'Book another'))));
  }

  // ---- Row controls (bulk rows editor and Excel review) ---------------------------------------------------------------------------
  const ROW_ORDER = ['name', 'phone', 'method', 'address', 'zone', 'landmark', 'island', 'vesselType', 'boatName', 'departureDate', 'departureTime', 'jetty', 'airportPoint', 'counter', 'resort', 'speedboat', 'tier', 'cod', 'instructions', 'reference', 'description'];
  const WIDE = { address: true, instructions: true, jetty: true, airportPoint: true };
  const ROW_METHOD_LABEL = { home: 'Home delivery', boat: 'Boat, ferry or speedboat', cargo: 'Maldivian Cargo', airport: 'Airport' };
  // rowControl(row, key, ctx) → the input or select for one row field, bound to the row object. ctx: { tiers, onInput(row, key), onChange(row, key) }.
  function rowControl(row, key, ctx, idx) {
    const label = K.fieldLabel(key, row.method) + ', row ' + (idx + 1);
    const base = { 'data-row': row.id, 'data-key': key, 'aria-label': label };
    const rawOpt = k => row.raw && row.raw[k] ? el('option', { value: '' }, 'Check: ' + row.raw[k]) : null;
    let c;
    const sel = (opts, prompt, k) => { const s = el('select', Object.assign({ class: 'select' }, base), rawOpt(k) || (prompt ? el('option', { value: '' }, prompt) : null), opts.map(o => el('option', { value: o.value }, o.label))); s.value = row[k] || ''; return s; };
    if (key === 'method') c = sel(K.methodOptions().map(o => ({ value: o.value, label: ROW_METHOD_LABEL[o.value] || o.label })), null, 'method');
    else if (key === 'zone') c = sel(K.zoneOptions(), 'Choose the area', 'zone');
    else if (key === 'tier') c = sel(K.tierOptions(ctx.tiers), 'Choose a size', 'tier');
    else if (key === 'vesselType') c = sel(K.vesselOptions(), 'Choose', 'vesselType');
    else if (key === 'jetty') c = sel(K.jettyOptions(), 'Choose the jetty', 'jetty');
    else if (key === 'airportPoint') c = sel(K.airportOptions(), null, 'airportPoint');
    else if (key === 'departureDate') c = el('input', Object.assign({ class: 'input', type: 'date', value: K.parseDate(row.departureDate) || '' }, base));
    else if (key === 'departureTime') c = el('input', Object.assign({ class: 'input', type: 'time', value: K.parseTime(row.departureTime) || '' }, base));
    else if (key === 'phone') c = el('input', Object.assign({ class: 'input', type: 'tel', inputmode: 'tel', placeholder: '7XX XXXX', value: row.phone || '' }, base));
    else if (key === 'cod') c = el('input', Object.assign({ class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0', value: row.cod || '' }, base));
    else c = el('input', Object.assign({ class: 'input', type: 'text', value: row[key] || '' }, base));
    const isSelect = c.tagName === 'SELECT';
    c.addEventListener(isSelect ? 'change' : 'input', () => {
      row[key] = c.value;
      if (row.raw && row.raw[key]) delete row.raw[key];
      if (isSelect && ctx.onChange) ctx.onChange(row, key, c); else if (ctx.onInput) ctx.onInput(row, key, c);
    });
    if (!isSelect && ctx.onChange) c.addEventListener('change', () => ctx.onChange(row, key, c));
    return c;
  }
  // Receiver and method first, then the method's own fields in their natural order, then size, cash and notes.
  const rowKeys = row => ['name', 'phone', 'method'].concat(K.METHOD_FIELDS[row.method] || K.METHOD_FIELDS.home, ['tier', 'cod', 'instructions', 'reference', 'description']);
  // "airport fee", but "Maldivian Cargo fee" keeps its capitals (a name) in the middle of a line.
  const feeName = f => /^[A-Z]\w* [A-Z]/.test(f.label) ? f.label : f.label.charAt(0).toLowerCase() + f.label.slice(1);
  function rowRateText(row, ctx) {
    const q = K.quoteRow(row, state.acc, state.settings, ctx.pickupZone());
    if (!q) return 'Choose a size';
    return money(q.rate) + (q.fees ? ' + ' + q.feeLines.map(f => feeName(f) + ' ' + money(f.amount)).join(' + ') : '');
  }
  // rowsSummary(rows, ctx) → summary lines: packages, total at the agreed rates, cash to collect, delivery methods.
  function rowsSummary(rows, ctx, testid) {
    let total = 0, cod = 0, unpriced = 0; const methods = {};
    rows.forEach(r => { const q = K.quoteRow(r, state.acc, state.settings, ctx.pickupZone()); if (q) total += q.total; else unpriced++; cod += K.parseMoney(r.cod) || 0; methods[r.method] = (methods[r.method] || 0) + 1; });
    return el('div', { class: 'summary', 'data-testid': testid },
      el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, plural(rows.length, 'package'), el('small', null, 'Each row becomes its own order with a tracking code and a label')), el('span', { class: 'summary__amount', 'data-testid': testid + '-total' }, money(total))),
      unpriced ? el('div', { class: 'summary__line summary__line--fee', 'data-testid': testid + '-unpriced' }, el('span', { class: 'summary__desc' }, plural(unpriced, 'package') + ' not in the total until ' + (unpriced === 1 ? 'its' : 'their') + ' size is chosen')) : null,
      rows.length ? el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'By delivery method: ' + Object.keys(methods).map(m => MDM.deliveryMethodLabel(m) + ' ' + methods[m]).join(' · '))) : null,
      el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Cash to collect', el('small', null, 'Collected by the drivers and paid to you')), el('span', { class: 'summary__amount', 'data-testid': testid + '-cod' }, money(cod))),
      el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, 'Priced at your agreed rate for each size, plus the Maldivian Cargo fee or the airport fee where it applies. Invoiced monthly.')));
  }
  function bulkDone(b, back) {
    const title = el('h2', { tabindex: '-1' }, 'Bulk order submitted');
    setTimeout(() => title.focus(), 0);
    const n = (b.orderIds || []).length;
    const c = b.collection || {};
    return el('div', { class: 'card biz-done', 'data-testid': 'biz-bulk-done' },
      el('div', { class: 'card__header' }, title, el('span', { class: 'mono--code' }, b.code)),
      el('div', { class: 'card__body stack-4' },
        el('p', null, plural(n, 'package') + ' confirmed at your agreed rates. We collect from ' + (c.label ? c.label + ', ' : '') + c.address + (c.preferredTime ? ' around ' + c.preferredTime : '') + ', sort them and send each one with the driver for its area, jetty or counter.'),
        el('div', { class: 'row row--wrap' },
          el('a', { class: 'btn btn--primary', href: labelsHref('batch=' + encodeURIComponent(b.id)), 'data-testid': 'biz-bulk-labels' }, html(MDM.icon('printer', 16)), 'Print ' + plural(n, 'label')),
          el('a', { class: 'btn btn--secondary', href: batchHref(b), on: { click: () => { state.done.batch = null; state.done.excel = null; } } }, 'See the packages'),
          el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => { back(); renderTab(); } } }, 'New bulk order'))));
  }

  // ---- Bulk order: rows editor (§5.1 to §5.3, §5.6) ---------------------------------------------------------------------------------
  const bulk = { rows: [], tried: false };
  async function tabBulk() {
    const acc = state.acc, s = await MDM.store.settings();
    state.settings = s || {};
    if (state.done.batch) return bulkDone(state.done.batch, () => { state.done.batch = null; });
    const tiers = tiersOf(acc);
    const ctx = { tiers, allTiers: allTiers() };
    if (!bulk.rows.length) bulk.rows = [K.blankRow(tiers), K.blankRow(tiers)];
    const form = el('form', { class: 'biz-form', novalidate: true, 'data-testid': 'biz-bulk-form' });
    const rowsEl = el('div', { class: 'bulk-items', 'data-testid': 'biz-bulk-rows' });
    const summaryHost = el('div');
    const failure = failBox();
    const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg', 'data-testid': 'biz-bulk-submit' }, 'Submit bulk order');
    const collection = collectionBlock(acc, { onceLabel: 'Another address (this bulk order only)', onChange: () => { drawSummary(); bulk.rows.forEach(updateRowHead); } });
    ctx.pickupZone = () => collection.zone();
    const errorsOf = r => K.validateRow(r, ctx);
    function updateRowHead(r) {
      const node = rowsEl.querySelector('[data-item="' + r.id + '"]'); if (!node) return;
      node.querySelector('[data-rate]').textContent = rowRateText(r, ctx);
    }
    function showRowErrors(r, node, only) {
      const errs = errorsOf(r);
      node.querySelectorAll('[data-key]').forEach(c => { const k = c.dataset.key; if (only && only !== k) return; if (!bulk.tried && !c.closest('.field').classList.contains('is-invalid')) return; setError(c, errs[k] || null); });
      const n = Object.keys(errs).length;
      const st = node.querySelector('[data-state]');
      st.replaceChildren(bulk.tried && n ? html(MDM.ui.badge('danger', plural(n, 'problem'))) : '');
    }
    function itemNode(r, i) {
      const rctx = Object.assign({}, ctx, {
        onInput: (row, key) => { const node = rowsEl.querySelector('[data-item="' + row.id + '"]'); showRowErrors(row, node, key); updateRowHead(row); drawSummary(); },
        onChange: (row, key) => { if (key === 'method') { const node = rowsEl.querySelector('[data-item="' + row.id + '"]'); const fresh = itemNode(row, bulk.rows.indexOf(row)); node.replaceWith(fresh); const sel = fresh.querySelector('[data-key="method"]'); if (sel) sel.focus(); } else { const node = rowsEl.querySelector('[data-item="' + row.id + '"]'); showRowErrors(row, node, key); } updateRowHead(row); drawSummary(); },
      });
      const fields = rowKeys(r).map(k => {
        const c = rowControl(r, k, rctx, i);
        c.removeAttribute('aria-label');
        c.id = 'bulk-' + r.id + '-' + k;
        return MDM.ui.field({ name: k, label: K.fieldLabel(k, r.method), control: c, optional: ['landmark', 'instructions', 'reference', 'description', 'cod', 'counter', 'speedboat'].indexOf(k) >= 0 || (k === 'address' && r.method === 'boat') || (k === 'departureTime' && r.method === 'airport'), class: WIDE[k] ? 'bulk-item__wide' : null });
      });
      const node = el('div', { class: 'bulk-item', 'data-item': r.id, 'data-testid': 'biz-bulk-row' },
        el('div', { class: 'bulk-item__head' },
          el('h3', { class: 'bulk-item__title' }, 'Package ' + (i + 1)),
          el('span', { class: 'bulk-item__rate small muted', 'data-rate': '' }, rowRateText(r, ctx)),
          el('span', { 'data-state': '' }),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm bulk-item__remove', 'aria-label': 'Remove package ' + (i + 1), 'data-testid': 'biz-bulk-remove', on: { click: () => { bulk.rows.splice(bulk.rows.indexOf(r), 1); if (!bulk.rows.length) bulk.rows.push(K.blankRow(tiers)); drawRows(); } } }, html(MDM.icon('trash', 16)), 'Remove')),
        el('div', { class: 'bulk-item__grid' }, fields));
      if (bulk.tried) setTimeout(() => showRowErrors(r, node), 0);
      return node;
    }
    function drawRows() { rowsEl.replaceChildren(...bulk.rows.map(itemNode)); drawSummary(); }
    function drawSummary() { summaryHost.replaceChildren(rowsSummary(bulk.rows.filter(K.filled), ctx, 'biz-bulk-summary')); }
    const level = segmented('level', [{ value: 'normal', label: 'Normal' }, { value: 'express', label: 'Express' }], 'normal', 'biz-bulk-level');
    form.append(
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Collection'), el('span', { class: 'small muted' }, 'One pickup for the whole bulk order')),
        el('div', { class: 'card__body stack-4' }, collection.el,
          el('div', { class: 'grid-2' }, MDM.ui.field({ label: 'Service', control: level }), field('notes', 'Notes for our team', input({ placeholder: 'Term 3 textbook orders' }), { optional: true })))),
      el('div', { class: 'card biz-excel-hint' }, el('div', { class: 'card__body row row--between row--wrap' },
        el('p', { class: 'small muted' }, 'Orders already in Excel? Upload the sheet instead of typing: we check every row before anything is booked.'),
        el('a', { class: 'btn btn--secondary btn--sm', href: '#excel', 'data-testid': 'biz-bulk-to-excel' }, html(MDM.icon('upload', 16)), 'Excel import'))),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Packages'),
        el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'biz-bulk-add', on: { click: () => { bulk.rows.push(K.blankRow(tiers)); drawRows(); const last = rowsEl.querySelector('.bulk-item:last-child input'); if (last) last.focus(); } } }, html(MDM.icon('plus', 16)), 'Add package')),
        el('div', { class: 'card__body' }, rowsEl)),
      summaryHost, failure,
      el('div', { class: 'form-actions' }, el('span', { class: 'small muted' }, 'We collect, sort and hand each package to the driver for its area, jetty or counter.'), submit));
    drawRows();
    form.addEventListener('submit', async e => {
      e.preventDefault(); failure.hidden = true;
      bulk.tried = true;
      const cOk = collection.validate();
      const rows = bulk.rows.filter(K.filled);
      const problems = [];
      bulk.rows.forEach((r, i) => {
        const node = rowsEl.querySelector('[data-item="' + r.id + '"]');
        if (!K.filled(r)) { node.querySelectorAll('[data-key]').forEach(c => setError(c, null)); node.querySelector('[data-state]').replaceChildren(); return; }
        showRowErrors(r, node);
        const n = Object.keys(errorsOf(r)).length;
        if (n) problems.push('Package ' + (i + 1) + ': ' + Object.keys(errorsOf(r)).map(k => K.fieldLabel(k, r.method).toLowerCase()).join(', '));
      });
      if (!rows.length) problems.push('Add at least one package');
      if (!cOk || problems.length) {
        if (problems.length) showFail(failure, 'Fix these packages', problems.slice(0, 6).join('. ') + (problems.length > 6 ? '. And ' + (problems.length - 6) + ' more.' : '.'));
        const first = form.querySelector('[aria-invalid="true"]');
        if (first) { MDM.ui.scrollIntoViewIfNeeded(first); first.focus(); }
        return;
      }
      MDM.ui.setLoading(submit, true);
      try {
        const batch = await MDM.store.createBatch({ accountId: acc.id, serviceLevel: form.elements.level.value, notes: String(form.elements.notes.value || '').trim(), source: 'portal', by: 'business:' + acc.id,
          collection: collection.value(), rows: rows.map(K.toBatchRow) });
        bulk.rows = []; bulk.tried = false;
        state.done.batch = batch;
        renderTab();
        MDM.ui.toast('Bulk order ' + batch.code + ' submitted', 'ok');
      } catch (err) { showFail(failure, null, (err && err.message) || 'We could not submit this bulk order.'); }
      finally { if (document.contains(submit)) MDM.ui.setLoading(submit, false); }
    });
    return form;
  }

  // ---- Excel import (§5.4): template, upload, validate, review, submit -------------------------------------------------------------
  const excel = { rows: [], source: 'excel', file: '', notes: [], onlyBad: false };
  async function tabExcel() {
    const acc = state.acc, s = await MDM.store.settings();
    state.settings = s || {};
    if (state.done.excel) return bulkDone(state.done.excel, () => { state.done.excel = null; });
    K.loadXLSX().catch(() => null);   // start loading SheetJS as soon as the Excel step opens
    const tiers = tiersOf(acc);
    const ctx = { tiers, allTiers: allTiers() };
    const form = el('form', { class: 'biz-form', novalidate: true, 'data-testid': 'biz-excel-form' });
    const failure = failBox();
    const msg = el('div', { class: 'biz-excel-msg', role: 'status', 'aria-live': 'polite', 'data-testid': 'biz-excel-msg' });
    const reviewHost = el('div', { 'data-testid': 'biz-excel-review' });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg', 'data-testid': 'biz-excel-submit' }, 'Submit orders');
    const gate = el('span', { class: 'small muted', 'data-testid': 'biz-excel-gate' });
    const collection = collectionBlock(acc, { onceLabel: 'Another address (this bulk order only)', onChange: () => drawReview() });
    ctx.pickupZone = () => collection.zone();
    const fileInput = el('input', { type: 'file', accept: '.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv', class: 'sr-only', tabindex: '-1', 'data-testid': 'biz-excel-file' });
    const pasteText = el('textarea', { class: 'textarea', rows: 4, placeholder: 'Copy the rows from Excel, including the header row, and paste them here', 'data-testid': 'biz-csv-text' });
    const templateBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'biz-excel-template' }, html(MDM.icon('download', 16)), 'Download the Excel template');
    const uploadBtn = el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'biz-excel-upload', on: { click: () => fileInput.click() } }, html(MDM.icon('upload', 16)), 'Upload Excel');
    function say(kind, text) { msg.replaceChildren(text ? MDM.ui.notice(kind, text) : ''); }
    templateBtn.addEventListener('click', async () => {
      MDM.ui.setLoading(templateBtn, true);
      try { await K.downloadTemplate(acc, s); say('ok', 'Template downloaded: mr-delivery-man-bulk-orders.xlsx. Fill one row per package, then upload it here.'); }
      catch (err) { say('danger', 'The Excel tools could not load. Check the connection and try again, or type the orders under Bulk order.'); }
      finally { MDM.ui.setLoading(templateBtn, false); }
    });
    // Nothing is booked here: the rows only go into the review. A second file asks whether to replace the rows already in the review or
    // add to them, so uploading a corrected sheet again does not double the orders.
    async function importGrid(grid, from, source) {
      const res = K.recordsFromGrid(grid);
      if (!res.records.length) { say('warn', res.headerRow < 0 ? 'We could not find the column names in ' + from + '. Use the template: the first row names the columns.' : 'No orders found in ' + from + '.'); return false; }
      // Sizes are read against this account's agreed sizes, so a size without a rate shows as a problem with the value from the file.
      const parsed = res.records.map(rec => Object.assign(K.rowFromCells(rec, ctx.tiers), { line: rec._line, file: from }));
      const rows = parsed.filter(K.filled), skipped = parsed.length - rows.length;
      if (!rows.length) { say('warn', 'No orders found in ' + from + ': no row has a receiver, an address or a reference.'); return false; }
      const prev = excel.rows.filter(K.filled);
      let add = false;
      if (prev.length) {
        const v = await MDM.ui.dialog({
          title: 'Replace the rows in the review?', okLabel: 'Continue',
          message: 'The review still has ' + plural(prev.length, 'row') + ' from ' + (excel.file || 'an earlier file') + '. You are adding ' + plural(rows.length, 'row') + ' from ' + from + '. Nothing has been booked yet.',
          fields: [{ name: 'mode', label: 'What to do with the ' + plural(rows.length, 'new row'), type: 'segmented', required: true, value: 'replace',
            options: [{ value: 'replace', label: 'Replace the rows in the review' }, { value: 'add', label: 'Add them to the rows in the review' }] }],
        });
        if (!v) { say('info', 'Nothing changed. The review still has the rows from ' + (excel.file || 'the earlier file') + '.'); return false; }
        add = v.mode === 'add';
      }
      excel.rows = (add ? prev : []).concat(rows);
      excel.source = add && excel.source === 'excel' ? 'excel' : source;
      excel.file = add && excel.file && excel.file !== from ? excel.file + ' and ' + from : from;
      excel.onlyBad = false;
      const bad = rows.filter(r => Object.keys(K.validateRow(r, ctx)).length).length;
      const notes = [];
      if (res.missing.length) notes.push('Columns not found: ' + res.missing.map(k => K.COLUMNS.find(c => c.key === k).label).join(', ') + '.');
      if (res.unknown.length) notes.push('Ignored columns: ' + res.unknown.join(', ') + '.');
      if (skipped) notes.push('Skipped ' + plural(skipped, 'row') + ' with no receiver details (only a size, a method or an amount).');
      if (add) notes.push('Added to the ' + plural(prev.length, 'row') + ' already in the review.');
      say(bad ? 'warn' : 'ok', 'Read ' + plural(rows.length, 'order') + ' from ' + from + '. ' + (bad ? plural(bad, 'row needs', 'rows need') + ' fixing before you can submit: the cells are highlighted below.' : 'Every row is ready. Review them and submit.') + (notes.length ? ' ' + notes.join(' ') : ''));
      drawReview();
      const first = reviewHost.querySelector('[aria-invalid="true"]') || reviewHost.querySelector('h2');
      if (first) MDM.ui.scrollIntoViewIfNeeded(first);
      return true;
    }
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0]; fileInput.value = '';
      if (!f) return;
      say('info', 'Reading ' + f.name + '…');
      let grid;
      try { grid = await K.readFile(f); }
      catch (err) {
        const msgText = err && err.code === 'type' ? 'Upload an Excel file (.xlsx or .xls) or a .csv file.'
          : err && /^xlsx_/.test(err.message || '') ? 'The Excel reader could not load, so ' + f.name + ' was not read. Check the connection and try again, or save the sheet as .csv or paste the rows below.'
          : 'We could not read ' + f.name + '. Save it as .xlsx from Excel and try again, or paste the rows below.';
        say('danger', msgText); return;
      }
      await importGrid(grid, f.name, /\.(xlsx|xls|xlsm)$/i.test(f.name) ? 'excel' : 'csv');
    });
    const dropzone = el('div', { class: 'dropzone biz-excel-drop' }, el('div', { class: 'dropzone__title' }, 'Upload your orders'),
      el('div', { class: 'dropzone__hint' }, 'Excel (.xlsx, .xls) or .csv with one row per package. Columns: ' + K.COLUMNS.slice(0, 7).map(c => c.label.toLowerCase()).join(', ') + ', plus the boat, cargo and airport details, cash to collect and special instructions.'),
      el('span', { class: 'dropzone__drag dropzone__hint' }, 'You can also drop the file here.'),
      el('div', { class: 'row row--wrap biz-excel-actions' }, uploadBtn, templateBtn), fileInput);
    dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('is-over'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
    dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.classList.remove('is-over'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (!f) return; const dt = new DataTransfer(); dt.items.add(f); fileInput.files = dt.files; fileInput.dispatchEvent(new Event('change')); });

    // The review table: one row per order, every column of the template that the order's delivery method uses, each cell editable.
    function columnsFor(rows) {
      const used = new Set(['name', 'phone', 'method', 'address', 'zone', 'landmark', 'tier', 'cod', 'instructions', 'reference', 'description']);
      rows.forEach(r => K.METHOD_FIELDS[r.method] && K.METHOD_FIELDS[r.method].forEach(k => used.add(k)));
      return ROW_ORDER.filter(k => used.has(k));
    }
    const colLabel = k => ({ address: 'Delivery address', departureTime: 'Departure time', airportPoint: 'Airport point', counter: 'Airport counter', resort: 'Resort', speedboat: 'Resort speedboat', island: 'Destination island', jetty: 'Jetty' })[k] || K.fieldLabel(k, 'home');
    function cellNode(r, k, i, errs, rctx) {
      if (!K.uses(r, k)) return el('td', { class: 'bz-na', 'data-label': colLabel(k) }, el('span', { class: 'subtle small' }, 'Not needed'));
      const c = rowControl(r, k, rctx, i);
      c.setAttribute('aria-label', K.fieldLabel(k, r.method) + ', row ' + (i + 1));
      const td = el('td', { class: 'bz-cell', 'data-label': K.fieldLabel(k, r.method), 'data-col': k }, c, el('div', { class: 'bz-cell__error', id: 'bz-err-' + r.id + '-' + k, hidden: true }));
      markCell(td, errs[k]);
      return td;
    }
    function markCell(td, message) {
      const c = td.querySelector('[data-key]'), e = td.querySelector('.bz-cell__error');
      td.classList.toggle('is-invalid', !!message);
      if (message) { c.classList.add('is-invalid'); c.setAttribute('aria-invalid', 'true'); c.setAttribute('aria-describedby', e.id); e.textContent = message; e.hidden = false; }
      else { c.classList.remove('is-invalid'); c.removeAttribute('aria-invalid'); c.removeAttribute('aria-describedby'); e.textContent = ''; e.hidden = true; }
    }
    // Possible duplicates (§5.4 validation): the same receiver, place, size, amount and reference twice, or one reference on two rows.
    // They do not block the submit (two parcels for one receiver are real), but each one is named so a row entered twice is removed.
    function dupNotes(rows) {
      const out = {}, seen = {}, refs = {};
      rows.forEach((r, i) => {
        if (!String(r.name || '').trim() && !String(r.phone || '').trim()) return;
        const key = [K.norm(r.name), MDM.ui.phone.normalize(r.phone) || K.norm(r.phone), r.method, K.norm(r.method === 'home' ? r.address : r.island), K.norm(r.boatName), r.tier, K.norm(r.reference), String(K.parseMoney(r.cod)), K.norm(r.description)].join('|');
        const ref = K.norm(r.reference);
        if (seen[key] != null) out[r.id] = 'Same receiver and details as row ' + (seen[key] + 1) + '. Remove it if it was entered twice.';
        else if (ref && refs[ref] != null) out[r.id] = 'Reference ' + String(r.reference).trim() + ' is also on row ' + (refs[ref] + 1) + '.';
        if (seen[key] == null) seen[key] = i;
        if (ref && refs[ref] == null) refs[ref] = i;
      });
      return out;
    }
    const lineText = r => r.line ? 'Line ' + r.line + (excel.file && r.file && excel.file !== r.file ? ' in ' + r.file : ' in the file') : '';
    function rowStatus(errs, dup) {
      const n = Object.keys(errs).length;
      return [n ? html(MDM.ui.badge('danger', plural(n, 'problem'))) : html(MDM.ui.badge(dup ? 'warn' : 'ok', dup ? 'Check' : 'Ready')),
        dup ? el('span', { class: 'table__sub bz-dup', 'data-testid': 'biz-excel-dup' }, dup) : null].filter(Boolean);
    }
    function counts() {
      const rows = excel.rows.filter(K.filled);
      const bad = rows.filter(r => Object.keys(K.validateRow(r, ctx)).length).length;
      return { total: rows.length, bad, ok: rows.length - bad, dup: Object.keys(dupNotes(rows)).length };
    }
    // Rows whose size has no agreed rate (missing size column, or a size the account does not have): one control fixes them all.
    function sizeFixer(rows) {
      const need = rows.filter(r => K.validateRow(r, ctx).tier);
      if (need.length < 2 || !ctx.tiers.length) return null;
      const sel = select(K.tierOptions(ctx.tiers), null, ctx.tiers[0].value);
      sel.setAttribute('data-testid', 'biz-excel-sizeall');
      const apply = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'biz-excel-sizeall-apply', on: { click: () => {
        need.forEach(r => { r.tier = sel.value; if (r.raw) delete r.raw.tier; });
        drawReview();
        MDM.ui.toast(plural(need.length, 'row') + ' set to ' + ctx.tiers.find(t => t.value === sel.value).label, 'ok');
      } } }, 'Apply to ' + plural(need.length, 'row'));
      return el('div', { class: 'bz-sizeall row row--wrap', 'data-testid': 'biz-excel-sizefix' },
        field('sizeAll', plural(need.length, 'row has', 'rows have') + ' no agreed size. Set them all to', sel, { class: 'bz-sizeall__field' }), apply);
    }
    function refreshTotals() {
      const n = counts();
      const rows = excel.rows.filter(K.filled), dups = dupNotes(rows);
      const host = reviewHost.querySelector('[data-counts]');
      if (host) host.replaceChildren(
        html(MDM.ui.badge('neutral', plural(n.total, 'row'))), ' ', html(MDM.ui.badge('ok', n.ok + ' ready', { 'data-testid': 'biz-excel-valid' })), ' ',
        html(MDM.ui.badge(n.bad ? 'danger' : 'neutral', n.bad + ' to fix', { 'data-testid': 'biz-excel-invalid' })),
        n.dup ? ' ' : '', n.dup ? html(MDM.ui.badge('warn', n.dup + ' to check', { 'data-testid': 'biz-excel-dupcount' })) : '');
      // Every row's status follows the whole sheet (an edit can create or clear a duplicate on another row).
      reviewHost.querySelectorAll('tr[data-rowid]').forEach(tr => {
        const r = rows.find(x => x.id === tr.dataset.rowid); if (!r) return;
        const errs = K.validateRow(r, ctx);
        tr.querySelector('[data-status]').replaceChildren(...rowStatus(errs, dups[r.id]));
        tr.classList.toggle('is-bad', Object.keys(errs).length > 0);
        tr.classList.toggle('is-dup', !Object.keys(errs).length && !!dups[r.id]);
      });
      // Problem list: the bad cells can be off-screen in a wide sheet, so name them here too.
      const probs = reviewHost.querySelector('[data-problems]');
      if (probs) {
        const items = [];
        rows.forEach((r, i) => { const e = K.validateRow(r, ctx); const keys = Object.keys(e); if (keys.length) items.push(el('li', null, el('strong', null, 'Row ' + (i + 1) + (r.line ? ', ' + lineText(r).charAt(0).toLowerCase() + lineText(r).slice(1) : '')), el('ul', null, keys.map(k => el('li', null, K.fieldLabel(k, r.method) + ': ' + e[k].charAt(0).toLowerCase() + e[k].slice(1)))))); });
        probs.replaceChildren(...items.slice(0, 8), items.length > 8 ? el('li', null, 'And ' + plural(items.length - 8, 'more row') + '. Tick "Show only rows to fix" to see them all.') : '');
        probs.hidden = !items.length;
      }
      const dupList = reviewHost.querySelector('[data-dupes]');
      if (dupList) {
        const items = rows.map((r, i) => dups[r.id] ? el('li', null, el('strong', null, 'Row ' + (i + 1)), ' (' + (r.name || 'no name') + '): ' + dups[r.id]) : null).filter(Boolean);
        dupList.replaceChildren(...items.slice(0, 8), items.length > 8 ? el('li', null, 'And ' + plural(items.length - 8, 'more row') + '.') : '');
        dupList.hidden = !items.length;
      }
      const sum = reviewHost.querySelector('[data-sum]');
      if (sum) sum.replaceChildren(rowsSummary(rows, ctx, 'biz-excel-summary'));
      const can = n.total > 0 && n.bad === 0;
      submit.disabled = !can;
      gate.textContent = !n.total ? 'Upload a file to review the orders.' : (n.bad ? 'Fix the ' + plural(n.bad, 'highlighted row') + ' or remove ' + (n.bad === 1 ? 'it' : 'them') + ' to submit.'
        : 'Every row is ready.' + (n.dup ? ' Check the ' + plural(n.dup, 'possible duplicate') + ' before you submit.' : ''));
      submit.textContent = n.total ? 'Submit ' + plural(n.total, 'order') : 'Submit orders';
    }
    function drawReview(focusKey) {
      const rows = excel.rows.filter(K.filled);
      excel.rows = rows;
      if (!rows.length) { reviewHost.replaceChildren(); refreshTotals(); return; }
      const cols = columnsFor(rows);
      const rctx = Object.assign({}, ctx, {
        onInput: (row, key, c) => { const errs = K.validateRow(row, ctx); markCell(c.closest('td'), errs[key]); const tr = c.closest('tr'); tr.querySelector('[data-rate]').textContent = rowRateText(row, ctx); refreshTotals(); },
        onChange: (row, key, c) => {
          // A select can change which columns apply (method) or drop its "Check: …" option: redraw and keep focus on it.
          if (c.tagName === 'SELECT') { drawReview({ row: row.id, key }); return; }
          rctx.onInput(row, key, c);
        },
      });
      const visible = excel.onlyBad ? rows.filter(r => Object.keys(K.validateRow(r, ctx)).length) : rows;
      const table = el('table', { class: 'table table--stack table--compact bz-review', 'data-testid': 'biz-excel-table' },
        el('caption', { class: 'sr-only' }, 'Imported orders. Cells with a problem are marked; fix them in place or remove the row.'),
        el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Row'), el('th', { scope: 'col' }, 'Status'), cols.map(k => el('th', { scope: 'col' }, colLabel(k))), el('th', { scope: 'col', class: 'num' }, 'Rate'), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Remove')))),
        el('tbody', null, visible.map(r => {
          const i = rows.indexOf(r), errs = K.validateRow(r, ctx);
          return el('tr', { 'data-rowid': r.id, 'data-testid': 'biz-excel-row', class: Object.keys(errs).length ? 'is-bad' : null },
            el('td', { class: 'table__primary bz-rownum' }, el('span', null, 'Row ' + (i + 1), r.line ? el('span', { class: 'table__sub' }, lineText(r)) : null)),
            el('td', { 'data-label': 'Status', 'data-status': '', class: 'bz-status' }),
            cols.map(k => cellNode(r, k, i, errs, rctx)),
            el('td', { class: 'num nowrap', 'data-label': 'Rate', 'data-rate': '' }, rowRateText(r, ctx)),
            el('td', { class: 'bz-remove' }, el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': 'Remove row ' + (i + 1), 'data-testid': 'biz-excel-remove', on: { click: () => { excel.rows.splice(excel.rows.indexOf(r), 1); drawReview(); MDM.ui.toast('Row ' + (i + 1) + ' removed', 'info'); } } }, html(MDM.icon('trash', 16)), el('span', { class: 'bz-remove__text' }, 'Remove'))));
        })));
      const onlyBad = el('label', { class: 'checkbox bz-onlybad' }, el('input', { type: 'checkbox', checked: excel.onlyBad, 'data-testid': 'biz-excel-onlybad', on: { change: e => { excel.onlyBad = e.target.checked; drawReview(); } } }), el('span', null, 'Show only rows to fix'));
      reviewHost.replaceChildren(el('div', { class: 'card' },
        el('div', { class: 'card__header bz-review-head' }, el('h2', { tabindex: '-1' }, 'Review the orders'), el('div', { class: 'row row--wrap', 'data-counts': '' })),
        el('div', { class: 'card__body stack-3' },
          el('p', { class: 'small muted' }, 'From ' + (excel.file || 'your file') + '. Nothing is booked until you submit. Fix a highlighted cell by editing it here, or remove the row and send it later.'),
          el('ul', { class: 'bz-problems small', 'data-problems': '', 'data-testid': 'biz-excel-problems', hidden: true }),
          sizeFixer(rows),
          el('ul', { class: 'bz-problems bz-problems--warn small', 'data-dupes': '', 'data-testid': 'biz-excel-dupes', 'aria-label': 'Possible duplicates', hidden: true }),
          el('div', { class: 'row row--between row--wrap' }, onlyBad,
            el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'biz-excel-clear', on: { click: async () => { if (await MDM.ui.confirm({ title: 'Clear the imported rows?', message: 'Every row in this review is removed. Nothing has been booked yet.', okLabel: 'Clear rows', danger: true })) { excel.rows = []; excel.file = ''; drawReview(); say('', ''); } } } }, 'Clear all rows'))),
        el('div', { class: 'table-wrap bz-review-wrap' }, table)),
        el('div', { 'data-sum': '' }));
      refreshTotals();
      if (focusKey) { const c = reviewHost.querySelector('[data-row="' + focusKey.row + '"][data-key="' + focusKey.key + '"]'); if (c) c.focus(); }
    }
    const level = segmented('level', [{ value: 'normal', label: 'Normal' }, { value: 'express', label: 'Express' }], 'normal', 'biz-excel-level');
    form.append(
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, '1. Collection'), el('span', { class: 'small muted' }, 'One pickup for every order in the file')),
        el('div', { class: 'card__body stack-4' }, collection.el,
          el('div', { class: 'grid-2' }, MDM.ui.field({ label: 'Service', control: level }), field('notes', 'Notes for our team', input({ placeholder: 'Evening drop' }), { optional: true })))),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, '2. Your Excel file')),
        el('div', { class: 'card__body stack-4' },
          el('p', { class: 'small muted' }, 'Start from the template: it has the exact columns, two example rows to replace, and a second sheet listing the sizes, areas, delivery methods and jetties we accept. Nothing is booked until you review the rows and submit.'),
          dropzone, msg,
          el('details', { class: 'biz-paste' }, el('summary', null, html(MDM.icon('chevron-right', 16)), 'Or paste rows copied from Excel'),
            el('div', { class: 'stack-3 biz-paste__body' }, MDM.ui.field({ name: 'paste', label: 'Rows with the header row', control: pasteText }),
              el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'biz-csv-add', on: { click: () => { const g = K.parseDelimited(pasteText.value); if (!g.length) { say('warn', 'Paste the rows first, including the header row.'); return; } importGrid(g, 'the pasted rows', 'csv').then(ok => { if (ok) pasteText.value = ''; }); } } }, 'Check pasted rows'))))),
      reviewHost, failure,
      el('div', { class: 'form-actions' }, gate, submit));
    drawReview();
    form.addEventListener('submit', async e => {
      e.preventDefault(); failure.hidden = true;
      const n = counts();
      if (!n.total) { say('warn', 'Upload a file first.'); return; }
      if (n.bad) { drawReview(); const first = reviewHost.querySelector('[aria-invalid="true"]'); if (first) { MDM.ui.scrollIntoViewIfNeeded(first); first.focus(); } return; }
      if (!collection.validate()) { MDM.ui.focusFirstInvalid(form); return; }
      MDM.ui.setLoading(submit, true);
      try {
        const batch = await MDM.store.createBatch({ accountId: acc.id, serviceLevel: form.elements.level.value, notes: String(form.elements.notes.value || '').trim() || ('Imported from ' + excel.file), source: excel.source, by: 'business:' + acc.id,
          collection: collection.value(), rows: excel.rows.map(K.toBatchRow) });
        excel.rows = []; excel.file = ''; excel.onlyBad = false;
        state.done.excel = batch;
        renderTab();
        MDM.ui.toast('Bulk order ' + batch.code + ' submitted with ' + plural((batch.orderIds || []).length, 'order'), 'ok');
      } catch (err) { showFail(failure, null, (err && err.message) || 'We could not submit these orders.'); }
      finally { if (document.contains(submit)) MDM.ui.setLoading(submit, false); }
    });
    return form;
  }

  // ---- Orders: cancel one order (§5.5), update boat details (§5.3 note) ------------------------------------------------------------
  const STATUS_FILTERS = [
    { value: 'all', label: 'All statuses' }, { value: 'open', label: 'Open' }, { value: 'out_for_delivery', label: 'Out for delivery' },
    { value: 'delivered', label: 'Delivered' }, { value: 'failed', label: 'Failed' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'returning', label: 'Returning to you' }, { value: 'requested', label: 'Waiting for price' },
  ];
  const RANGES = [{ value: 'today', label: 'Today' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: 'month', label: 'This month' }, { value: 'all', label: 'All time' }];
  function inRange(iso, range) {
    if (range === 'all') return true;
    const d = new Date(iso), now = new Date();
    if (range === 'today') return MDM.ui.dayKey(d) === MDM.ui.dayKey(now);
    if (range === 'month') return MDM.ui.monthKey(d) === MDM.ui.monthKey(now);
    return now - d <= Number(range) * 86400000;
  }
  const canCancel = o => DONE.indexOf(o.status) < 0;
  const canUpdateBoat = o => (o.delivery || {}).method === 'boat' && DONE.indexOf(o.status) < 0;
  function cancelOutcome(o, batch) {
    const cod = o.cod && o.cod.amount > 0 ? ' The cash on delivery of ' + money(o.cod.amount) + ' will not be collected.' : '';
    const others = batch ? ' The other orders in ' + batch.code + ' are not affected.' : '';
    // Same rule as store.businessCancel: a failed delivery is still with us once its pickup was done.
    const withUs = ['collected', 'out_for_delivery'].indexOf(o.status) >= 0 || (o.status === 'failed' && ((o.route && o.route.stops) || []).some(x => x.type === 'pickup' && x.status === 'done'));
    if (!withUs) return 'We have not collected this package yet, so the order is simply cancelled. Nothing else to do.' + cod + others;
    if (o.status === 'out_for_delivery') return 'This package is out for delivery. We tell the driver not to deliver it and to bring it back to you. You will see "Returning to you", then "Returned".' + cod + others;
    return 'We already have this package. The order is cancelled and the package comes back to you. You will see "Returning to you", then "Returned".' + cod + others;
  }
  async function cancelOrder(o, batch) {
    const vals = await MDM.ui.dialog({
      title: 'Cancel ' + o.code + '?', message: cancelOutcome(o, batch), okLabel: 'Cancel this order', cancelLabel: 'Keep the order', danger: true,
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', rows: 2, required: true, requiredMessage: 'Tell us why the order is cancelled', placeholder: 'Their customer cancelled the order' }],
    });
    if (!vals) return;
    try {
      const after = await MDM.store.businessCancel(o.id, { reason: vals.reason, by: 'business:' + state.acc.id });
      const back = after.cancellation && after.cancellation.returnStatus === 'pending';
      MDM.ui.toast(o.code + ' cancelled. ' + (back ? 'The driver brings the package back to you.' : 'It will not be collected.'), 'ok');
    } catch (err) { MDM.ui.toast((err && err.message) || 'Could not cancel this order', 'danger'); }
    renderTab();
  }
  async function updateBoat(o) {
    const b = (o.delivery || {}).boat || {};
    const vals = await MDM.ui.dialog({
      title: 'Update boat details for ' + o.code, message: 'Use this when the boat, ferry or speedboat changes, or the driver missed it and sends the package on the next one. The driver and our office are told.',
      okLabel: 'Save boat details',
      fields: [
        { name: 'reason', label: 'What changed', type: 'select', required: true, requiredMessage: 'Choose what changed', placeholder: 'Choose a reason', options: MDM.BOAT_CHANGE_REASONS.map(r => ({ value: r.value, label: r.label })) },
        { name: 'vesselType', label: 'Vessel', type: 'select', required: true, value: b.vesselType || 'speedboat', options: MDM.VESSEL_TYPES.map(v => ({ value: v.value, label: v.label })) },
        { name: 'name', label: 'Boat, ferry or speedboat name', required: true, requiredMessage: 'Enter the boat name', value: b.name || '' },
        { name: 'departureDate', label: 'Departure date', type: 'date', required: true, requiredMessage: 'Choose the departure date', value: b.departureDate || MDM.ui.dayKey() },
        { name: 'departureTime', label: 'Departure time', type: 'time', required: true, requiredMessage: 'Enter the departure time', value: b.departureTime || '' },
        { name: 'jetty', label: 'Harbour or jetty', type: 'select', required: true, value: b.jetty || 'male_jetties', options: K.jettyOptions() },
        { name: 'island', label: 'Destination island', required: true, requiredMessage: 'Enter the destination island', value: b.island || '' },
        { name: 'note', label: 'Note for the driver', type: 'textarea', rows: 2, placeholder: 'Huraa Speed 1 was full, now on the 15:00' },
      ],
    });
    if (!vals) return;
    try {
      const before = JSON.stringify(b);
      const after = await MDM.store.updateBoat(o.id, { vesselType: vals.vesselType, name: vals.name, departureDate: vals.departureDate, departureTime: vals.departureTime, jetty: vals.jetty, island: vals.island }, { reason: vals.reason, note: vals.note || '', by: 'business:' + state.acc.id });
      MDM.ui.toast(JSON.stringify((after.delivery || {}).boat) === before ? 'Nothing changed on ' + o.code : 'Boat details updated for ' + o.code + '. The driver is told.', 'ok');
    } catch (err) { MDM.ui.toast((err && err.message) || 'Could not update the boat details', 'danger'); }
    renderTab();
  }
  function ordersTable(rows, batchById, testid) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack biz-orders', 'data-testid': testid || 'biz-orders-table' },
      el('thead', null, el('tr', null, ['Order', 'Receiver', 'Package', 'Delivery', 'Cash on delivery', 'Status', ''].map(h => el('th', { scope: 'col' }, h)))),
      el('tbody', null, rows.map(o => {
        const r = recipientOf(o), pkg = (o.packages || [])[0] || {}, b = o.batchId ? batchById[o.batchId] : null, m = methodLines(o), cs = codStatus(o);
        const hist = ((o.delivery || {}).boat || {}).history || [];
        return el('tr', { 'data-testid': 'biz-row-' + o.code },
          el('td', { class: 'table__primary' }, el('div', null, el('a', { class: 'mono--code nowrap', href: trackHref(o) }, o.code), el('span', { class: 'table__sub nowrap' }, fmtDate(o.createdAt)), b ? el('span', { class: 'table__sub nowrap' }, b.code + ' #' + o.batchIndex) : null)),
          el('td', { 'data-label': 'Receiver' }, el('div', null, r.name, el('span', { class: 'table__sub nowrap' }, MDM.ui.phone.format(r.phone)))),
          el('td', { 'data-label': 'Package' }, el('div', null, el('span', { class: 'nowrap', 'data-tier': pkg.tier || '' }, tierText(o)), pkg.description ? el('span', { class: 'table__sub' }, pkg.description) : null,
            (o.details || {}).reference ? el('span', { class: 'table__sub' }, 'Ref ' + o.details.reference) : null,
            o.fees && (o.fees.cargo || o.fees.airport) ? el('span', { class: 'table__sub' }, 'Total ' + money(o.totals.total) + ' with the ' + (o.fees.cargo ? 'Maldivian Cargo' : 'airport') + ' fee') : null)),
          el('td', { 'data-label': 'Delivery' }, el('div', null, el('span', { 'data-method': (o.delivery || {}).method || 'home' }, m[0]), el('span', { class: 'table__sub biz-delivery-sub' }, m[1]),
            hist.length ? el('span', { class: 'table__sub' }, 'Boat updated ' + plural(hist.length, 'time') + ', last: ' + ((MDM.BOAT_CHANGE_REASONS.find(x => x.value === hist[hist.length - 1].reason) || {}).label || 'changed').toLowerCase()) : null)),
          el('td', { 'data-label': 'Cash on delivery' }, cs ? el('div', { class: 'biz-cod' }, el('span', { class: 'mono' }, money(o.cod.amount)), codBadge(cs)) : el('span', { class: 'subtle' }, 'None')),
          el('td', { 'data-label': 'Status' }, el('div', null, el('div', { class: 'biz-status' }, html(MDM.badgeFor(o.status)), returnTag(o), priorityTag(o)),
            cancelNote(o) ? el('span', { class: 'table__sub biz-cancel-note', 'data-testid': 'cancel-note' }, cancelNote(o)) : null)),
          el('td', { class: 'biz-row-actions' }, el('div', { class: 'biz-actions biz-actions--stack' },
            canCancel(o) ? el('button', { type: 'button', class: 'btn btn--secondary btn--sm biz-cancel', 'data-testid': 'biz-cancel-' + o.code, on: { click: () => cancelOrder(o, b) } }, 'Cancel this order') : null,
            canUpdateBoat(o) ? el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'biz-boat-' + o.code, on: { click: () => updateBoat(o) } }, html(MDM.icon('ship', 16)), 'Update boat details') : null,
            OPEN.indexOf(o.status) >= 0 && !(o.priority && ['requested', 'approved'].indexOf(o.priority.status) >= 0) ? el('a', { class: 'btn btn--ghost btn--sm', href: '#priority?order=' + encodeURIComponent(o.id), 'aria-label': 'Ask for priority on ' + o.code }, 'Priority') : null,
            DONE.indexOf(o.status) < 0 ? el('a', { class: 'btn btn--ghost btn--sm', href: labelsHref('order=' + encodeURIComponent(o.id)), 'aria-label': 'Label for ' + o.code }, html(MDM.icon('printer', 16)), 'Label') : null)));
      }))));
  }
  async function tabOrders() {
    const d = await load();
    const batchById = {}; d.batches.forEach(b => { batchById[b.id] = b; });
    const hp = hashParts().params;
    const openBatch = hp.get('batch') && (batchById[hp.get('batch')] || d.batches.find(b => b.code === String(hp.get('batch')).toUpperCase()));
    if (openBatch) return batchDetail(openBatch, d.orders.filter(o => o.batchId === openBatch.id).sort((a, b) => a.batchIndex - b.batchIndex), batchById);
    const f = state.filters;
    const q = K.norm(f.q);
    const rows = d.orders.filter(o => {
      if (f.status === 'open' ? OPEN.indexOf(o.status) < 0 : f.status === 'returning' ? !(o.cancellation && o.cancellation.returnStatus === 'pending') : (f.status !== 'all' && o.status !== f.status)) return false;
      if (f.batch === 'single' ? !!o.batchId : (f.batch && o.batchId !== f.batch)) return false;
      if (!inRange(o.createdAt, f.range)) return false;
      if (q) { const r = recipientOf(o); const hay = K.norm([o.code, r.name, r.phone, (o.delivery || {}).address, (o.details || {}).reference, (o.packages || []).map(p => p.description).join(' '), methodLines(o).join(' ')].join(' ')); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Code, receiver, reference, boat', value: f.q, 'aria-label': 'Search orders', 'data-testid': 'biz-orders-search' });
    search.addEventListener('input', MDM.ui.debounce(() => { f.q = search.value; redraw(); }, 200));
    const sel = (opts, key, label, testid) => { const s = el('select', { class: 'select', 'aria-label': label, 'data-testid': testid, on: { change: e => { f[key] = e.target.value; redraw(); } } }, opts.map(o => el('option', { value: o.value }, o.label))); s.value = f[key]; return s; };
    const batchOpts = [{ value: '', label: 'All orders' }, { value: 'single', label: 'Single orders' }].concat(d.batches.map(b => ({ value: b.id, label: 'Bulk ' + b.code })));
    const table = rows.length ? ordersTable(rows, batchById) : empty('No orders match', 'Change the filters or search for another code.');
    const wrap = el('div', { class: 'stack-6' },
      d.batches.length ? el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Bulk orders'), el('span', { class: 'small muted' }, 'Open one to see and manage every package in it')), el('div', { class: 'list' }, d.batches.map(batchRow))) : null,
      el('div', { class: 'stack-4' },
        el('div', { class: 'filters' }, search, sel(STATUS_FILTERS, 'status', 'Status', 'biz-orders-status'), sel(RANGES, 'range', 'Date', 'biz-orders-range'), sel(batchOpts, 'batch', 'Batch', 'biz-orders-batch')),
        el('p', { class: 'small muted', role: 'status' }, plural(rows.length, 'order') + (rows.length ? ' · ' + money(rows.filter(o => o.status !== 'cancelled').reduce((n, o) => n + (o.totals ? o.totals.total : 0), 0)) + (rows.some(o => o.status === 'cancelled') ? ' without the cancelled ones' : '') : '')),
        table));
    function redraw() { tabOrders().then(n => { const focusSearch = document.activeElement === search; panel.replaceChildren(n); if (focusSearch) { const s2 = panel.querySelector('[data-testid="biz-orders-search"]'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } } }); }
    return wrap;
  }
  function batchDetail(b, kids, batchById) {
    const p = batchProgress(b), c = b.collection || {};
    const acc = state.acc;
    const pt = (acc.collectionPoints || []).find(x => x.id === (b.collectionPointId || c.pointId));
    const codTotal = kids.reduce((n, o) => n + (codStatus(o) && codStatus(o) !== 'not_collected' ? o.cod.amount : 0), 0);
    const codPending = kids.reduce((n, o) => n + (codStatus(o) === 'pending' ? o.cod.amount : 0), 0);
    const live = kids.filter(o => o.status !== 'cancelled');
    const counts = {}; kids.forEach(o => { const k = (o.delivery || {}).method || 'home'; counts[k] = (counts[k] || 0) + 1; });
    const parts = [p.st.delivered + ' delivered'];
    if (p.st.out) parts.push(p.st.out + ' out for delivery'); if (p.st.collected) parts.push(p.st.collected + ' at the hub'); if (p.st.cancelled) parts.push(p.st.cancelled + ' cancelled'); if (p.st.failed) parts.push(p.st.failed + ' failed');
    return el('div', { class: 'stack-6', 'data-testid': 'biz-batch-detail' },
      el('div', null, el('a', { class: 'btn btn--ghost btn--sm', href: '#orders', 'data-testid': 'biz-batch-back' }, html(MDM.icon('arrow-left', 16)), 'All orders')),
      el('div', { class: 'card' },
        el('div', { class: 'card__header' }, el('h2', null, 'Bulk order ', el('span', { class: 'mono--code' }, b.code)), batchBadge(p.st)),
        el('div', { class: 'card__body stack-4' },
          el('div', { class: 'rate-table' },
            MDM.ui.rateRow('Collection point', pt ? pt.label : (c.label || 'One-off address'), { sub: [c.address, MDM.geo.zoneShort(c.zone), c.contactName ? c.contactName + ' ' + MDM.ui.phone.format(c.contactPhone) : ''].filter(Boolean).join(' · ') }),
            MDM.ui.rateRow('Preferred collection time', b.preferredTime || c.preferredTime || 'Any time'),
            MDM.ui.rateRow('Packages', plural(p.st.total, 'package'), { sub: parts.join(' · '), valueSub: Object.keys(counts).map(k => MDM.deliveryMethodLabel(k) + ' ' + counts[k]).join(' · ') }),
            MDM.ui.rateRow('Amount', money(p.st.amount), { mono: true, sub: live.length < kids.length ? 'Excluding cancelled orders' : null }),
            MDM.ui.rateRow('Cash on delivery', money(codTotal), { mono: true, sub: 'Excluding cancelled orders', valueSub: money(codPending) + ' still to collect' }),
            MDM.ui.rateRow('Submitted', fmtDate(b.createdAt), { valueSub: b.source === 'excel' ? 'Excel import' : b.source === 'csv' ? 'Spreadsheet' : 'Typed in the portal' })),
          p.bar,
          MDM.ui.notice('info', 'Cancel any single package below without touching the rest of this bulk order. Before collection it is simply cancelled; once we have it, the driver brings it back to you.'),
          live.length ? el('div', { class: 'row row--wrap' }, el('a', { class: 'btn btn--secondary', href: labelsHref('batch=' + encodeURIComponent(b.id)), 'data-testid': 'biz-batch-print' }, html(MDM.icon('printer', 16)), 'Print ' + plural(live.length, 'label')),
            live.length < kids.length ? el('span', { class: 'small muted' }, 'Cancelled packages get no label.') : null) : null)),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Packages in ' + b.code)), kids.length ? ordersTable(kids, batchById, 'biz-batch-table') : empty('No packages', '')));
  }

  // ---- Cash on delivery (§5.6) ----------------------------------------------------------------------------------------------------
  const COD_FILTERS = [{ value: 'all', label: 'All cash on delivery' }].concat(Object.keys(COD_LABELS).map(k => ({ value: k, label: COD_LABELS[k].label })));
  function codTotals(orders) {
    const t = { pending: 0, collected: 0, with_office: 0, remitted: 0, not_collected: 0, n: {} };
    orders.forEach(o => {
      const st = codStatus(o); if (!st) return;
      t.n[st] = (t.n[st] || 0) + 1;
      if (st === 'pending' || st === 'not_collected') t[st] += o.cod.amount;
      else t[st] += o.cod.collectedAmount != null ? o.cod.collectedAmount : o.cod.amount;
    });
    return t;
  }
  async function tabCod() {
    const d = await load();
    const f = state.cod;
    const all = d.orders.filter(o => codStatus(o));
    const t = codTotals(all);
    const rows = all.filter(o => (f.status === 'all' || codStatus(o) === f.status) && inRange(o.createdAt, f.range))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const batchById = {}; d.batches.forEach(b => { batchById[b.id] = b; });
    const sel = (opts, key, label, testid) => { const s = el('select', { class: 'select', 'aria-label': label, 'data-testid': testid, on: { change: e => { f[key] = e.target.value; renderTab(); } } }, opts.map(o => el('option', { value: o.value }, o.label))); s.value = f[key]; return s; };
    const n = k => plural(t.n[k] || 0, 'order');
    return el('div', { class: 'stack-6', 'data-testid': 'biz-cod' },
      el('div', { class: 'kpi-row biz-cod-kpis' },
        kpi('To collect', money(t.pending), n('pending') + ' with the receivers', 'biz-cod-pending'),
        kpi('With drivers', money(t.collected), n('collected') + ', handed to our office next', 'biz-cod-collected'),
        kpi('With the office', money(t.with_office), n('with_office') + ', paid to you next', 'biz-cod-office'),
        kpi('Paid to you', money(t.remitted), n('remitted'), 'biz-cod-remitted'),
        kpi('Not collected', money(t.not_collected), n('not_collected') + ' cancelled or refused', 'biz-cod-not')),
      MDM.ui.notice('info', 'You enter the cash to collect when you place an order. The driver records the cash received with the proof of delivery, hands it to our office, and we pay it to you with a reference.'),
      el('div', { class: 'stack-4' },
        el('div', { class: 'filters' }, sel(COD_FILTERS, 'status', 'Cash status', 'biz-cod-status'), sel(RANGES, 'range', 'Order date', 'biz-cod-range')),
        el('p', { class: 'small muted', role: 'status' }, plural(rows.length, 'order') + ' · ' + money(rows.reduce((s, o) => s + o.cod.amount, 0)) + ' cash on delivery in total'),
        rows.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack biz-cod-table', 'data-testid': 'biz-cod-table' },
          el('thead', null, el('tr', null, ['Order', 'Receiver', 'Amount', 'Status', 'Collected', 'Handed to our office', 'Paid to you'].map((h, i) => el('th', { scope: 'col', class: i === 2 ? 'num' : null }, h)))),
          el('tbody', null, rows.map(o => {
            const c = o.cod, st = codStatus(o), b = o.batchId ? batchById[o.batchId] : null, r = recipientOf(o);
            const diff = c.collectedAmount != null ? c.collectedAmount - c.amount : 0;
            const variance = diff ? money(Math.abs(diff)) + (diff < 0 ? ' less' : ' more') + ' than the amount to collect' : '';
            return el('tr', { 'data-testid': 'biz-cod-row-' + o.code },
              el('td', { class: 'table__primary' }, el('div', null, el('a', { class: 'mono--code', href: trackHref(o) }, o.code), el('span', { class: 'table__sub' }, fmtDate(o.createdAt) + (b ? ' · ' + b.code : '')))),
              el('td', { 'data-label': 'Receiver' }, el('div', null, r.name, el('span', { class: 'table__sub' }, MDM.STATUS[o.status].label))),
              el('td', { class: 'num mono nowrap', 'data-label': 'Amount' }, money(c.amount)),
              el('td', { 'data-label': 'Status' }, codBadge(st)),
              el('td', { 'data-label': 'Collected' }, c.collectedAt ? el('div', null, el('span', { class: 'mono' }, money(c.collectedAmount || 0)), el('span', { class: 'table__sub' }, fmtDate(c.collectedAt) + (variance ? ' · ' + variance : ''))) : el('span', { class: 'subtle' }, st === 'not_collected' ? 'Not collected' : 'Not yet')),
              el('td', { 'data-label': 'Handed to our office' }, c.handedAt ? fmtDate(c.handedAt) : el('span', { class: 'subtle' }, 'Not yet')),
              el('td', { 'data-label': 'Paid to you' }, c.remittedAt ? el('div', null, fmtDate(c.remittedAt, { dateOnly: true }), el('span', { class: 'table__sub' }, c.remittanceRef ? 'Ref ' + c.remittanceRef : 'No reference')) : el('span', { class: 'subtle' }, 'Not yet')));
          })))) : empty('No cash on delivery orders match', f.status === 'all' && f.range === 'all' ? 'Enter the cash to collect when you book an order.' : 'Change the filters.')));
  }

  // ---- Collection points (§5.1) ----------------------------------------------------------------------------------------------------
  async function editPoint(p) {
    const acc = state.acc;
    const vals = await MDM.ui.dialog({
      title: p ? 'Edit ' + p.label : 'Add a collection point', okLabel: p ? 'Save changes' : 'Add collection point',
      fields: [
        { name: 'label', label: 'Name', required: true, requiredMessage: 'Name this collection point', placeholder: 'Shop, Godown, Warehouse', value: p ? p.label : '' },
        { name: 'address', label: 'Address', required: true, requiredMessage: 'Enter the address', placeholder: 'House or building, floor, road', value: p ? p.address : '' },
        { name: 'zone', label: 'Area', type: 'select', required: true, requiredMessage: 'Choose the area', placeholder: 'Choose the area', options: zoneOptions().filter(o => o.value !== 'other'), value: p ? p.zone : (acc.zone || '') },
        { name: 'landmark', label: 'Landmark', placeholder: 'Behind the stadium', value: p ? p.landmark : '' },
        { name: 'contactName', label: 'Contact person', required: true, requiredMessage: 'Enter the contact person', value: p ? p.contactName : acc.contactName || '' },
        { name: 'contactPhone', label: 'Contact number', type: 'tel', landline: true, required: true, requiredMessage: 'Enter the contact number', invalidMessage: 'Enter a 7-digit Maldives number', value: p ? p.contactPhone : acc.phone || '' },
        { name: 'preferredTime', label: 'Preferred collection time', type: 'time', hint: 'We plan pickups from here around this time.', value: p ? p.preferredTime : '' },
        { name: 'isDefault', label: 'Use as the default collection point', type: 'checkbox', value: p ? !!p.isDefault : !(acc.collectionPoints || []).length },
      ],
    });
    if (!vals) return;
    try {
      await MDM.store.saveCollectionPoint(acc.id, { id: p ? p.id : undefined, label: vals.label, address: vals.address, zone: vals.zone, landmark: vals.landmark || '', contactName: vals.contactName, contactPhone: MDM.ui.phone.normalize(vals.contactPhone) || vals.contactPhone, preferredTime: vals.preferredTime || '', isDefault: !!vals.isDefault });
      MDM.ui.toast(p ? vals.label + ' saved' : vals.label + ' added', 'ok');
    } catch (err) { MDM.ui.toast((err && err.message) || 'Could not save the collection point', 'danger'); }
    renderTab();
  }
  async function tabPoints() {
    await load();
    const acc = state.acc, pts = acc.collectionPoints || [];
    const addBtn = el('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-testid': 'biz-point-add', on: { click: () => editPoint(null) } }, html(MDM.icon('plus', 16)), 'Add a collection point');
    return el('div', { class: 'stack-6' },
      el('div', { class: 'card', 'data-testid': 'biz-points' },
        el('div', { class: 'card__header' }, el('h2', null, 'Collection points'), addBtn),
        pts.length ? el('div', { class: 'list biz-plist' }, pts.map(p => el('div', { class: 'list__item list__item--top biz-point', 'data-testid': 'biz-point-' + p.id },
          el('div', { class: 'list__main' },
            el('div', { class: 'list__title' }, p.label, ' ', p.isDefault ? html(MDM.ui.badge('info', 'Default')) : null),
            el('div', { class: 'list__meta' }, p.address + ' · ' + MDM.geo.zoneLabel(p.zone) + (p.landmark ? ' · ' + p.landmark : '')),
            el('div', { class: 'list__meta' }, (p.contactName || '') + ' ' + MDM.ui.phone.format(p.contactPhone) + ' · ' + (p.preferredTime ? 'Collect around ' + p.preferredTime : 'No preferred time'))),
          el('div', { class: 'list__aside biz-actions' },
            !p.isDefault ? el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'biz-point-default', on: { click: async () => { await MDM.store.saveCollectionPoint(acc.id, Object.assign({}, p, { isDefault: true })); MDM.ui.toast(p.label + ' is now the default', 'ok'); renderTab(); } } }, 'Make default') : null,
            el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-testid': 'biz-point-edit', on: { click: () => editPoint(p) } }, html(MDM.icon('edit', 16)), 'Edit'),
            el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'biz-point-remove', on: { click: async () => {
              const ok = await MDM.ui.confirm({ title: 'Remove ' + p.label + '?', message: pts.length === 1 ? 'This is your only collection point. New orders will ask for a collection address until you add one.' : 'Orders already booked from here are not affected.' + (p.isDefault ? ' The next point becomes the default.' : ''), okLabel: 'Remove', danger: true });
              if (!ok) return;
              await MDM.store.removeCollectionPoint(acc.id, p.id); MDM.ui.toast(p.label + ' removed', 'ok'); renderTab();
            } } }, html(MDM.icon('trash', 16)), 'Remove'))))) : empty('No collection points yet', 'Add your shop, godown or warehouse. You pick one when you book an order or a bulk order.')),
      el('p', { class: 'small muted' }, 'The default collection point is preselected on new orders and bulk orders. The preferred time is a suggestion for our team; you can change it on each bulk order.'));
  }

  // ---- Priority (requirements §11) ------------------------------------------------------------------------------------------
  let priorityList = null;
  function decisionBadge(r) {
    const map = { pending: ['warn', 'Waiting'], approved: ['ok', 'Approved'], updated: ['info', 'Updated'], rejected: ['danger', 'Declined'] };
    const m = map[r.decision] || ['neutral', r.decision];
    return html(MDM.ui.badge(m[0], m[1]));
  }
  function deadlineLabel(v) { const d = new Date(String(v).replace(' ', 'T')); return isNaN(d) ? String(v) : fmtDate(d); }
  async function priorityRequests() {
    const orders = await MDM.store.list('orders', { where: { accountId: state.acc.id } });
    const out = [];
    orders.forEach(o => ((o.priority || {}).requests || []).forEach(r => out.push({ o, r })));
    return out.sort((a, b) => a.r.at < b.r.at ? 1 : -1);
  }
  async function refreshPriorityList() { if (priorityList && document.contains(priorityList)) await fillPriorityList(priorityList); }
  async function fillPriorityList(target) {
    const reqs = await priorityRequests();
    target.replaceChildren(reqs.length ? el('div', { class: 'list' }, reqs.map(({ o, r }) => el('div', { class: 'list__item list__item--top', 'data-testid': 'biz-priority-' + o.code },
      el('div', { class: 'list__main' },
        el('div', { class: 'list__title' }, el('a', { class: 'mono--code', href: trackHref(o) }, o.code), ' · ', recipientOf(o).name),
        el('div', { class: 'list__meta' }, r.reason || 'No reason given'),
        el('div', { class: 'list__meta' }, 'Asked ' + fmtDate(r.at) + (r.deadline ? ' · Needed by ' + deadlineLabel(r.deadline) : '') + (r.instructions ? ' · ' + r.instructions : '')),
        r.remarks ? el('div', { class: 'list__meta' }, 'Our team: ' + r.remarks) : null,
        r.decision !== 'pending' && r.decision !== 'rejected' && o.priority && o.priority.level ? el('div', { class: 'list__meta' }, 'Marked ' + ((MDM.PRIORITY_LEVELS.find(x => x.value === o.priority.level) || {}).label || 'Priority')) : null),
      el('div', { class: 'list__aside' }, decisionBadge(r))))) : empty('No priority requests yet', 'Ask for a deadline on any open order and our team approves it.'));
  }
  async function tabPriority() {
    const acc = state.acc;
    const orders = (await MDM.store.list('orders', { where: { accountId: acc.id } })).filter(o => OPEN.indexOf(o.status) >= 0 && !(o.priority && o.priority.status === 'requested'));
    const form = el('form', { class: 'form', novalidate: true, 'data-testid': 'biz-priority-form' });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'biz-priority-submit' }, 'Send priority request');
    const pre = hashParts().params.get('order');
    const orderSel = el('select', { class: 'select', 'data-testid': 'biz-priority-order' }, el('option', { value: '' }, orders.length ? 'Choose an open order' : 'No open orders'),
      orders.map(o => el('option', { value: o.id }, o.code + ' · ' + recipientOf(o).name + ' · ' + MDM.STATUS[o.status].label + (o.priority && o.priority.status === 'approved' ? ' · already priority' : ''))));
    if (pre) orderSel.value = pre;
    form.append(
      field('order', 'Order', orderSel),
      field('reason', 'Reason', input({ placeholder: 'Exam papers must arrive before the 2 pm paper', 'data-testid': 'biz-priority-reason' })),
      el('div', { class: 'grid-2' }, field('deadline', 'Deadline', input({ type: 'datetime-local', 'data-testid': 'biz-priority-deadline' })), el('div')),
      field('instructions', 'Instructions', el('textarea', { class: 'textarea', rows: 2, placeholder: 'Hand to the exam office only, signature needed' }), { optional: true }),
      el('div', { class: 'form-actions' }, el('span', { class: 'small muted' }, 'Our team approves or declines it; you see the decision here and on the tracking page.'), submit));
    if (acc.priorityAllowed === false) form.prepend(MDM.ui.notice('warn', 'Priority requests are not enabled on this account. Call us to turn them on.'));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const r = MDM.ui.validate(form, { order: v => v ? null : 'Choose the order', reason: v => v ? null : 'Tell us why it is urgent', deadline: v => !v ? 'Choose the deadline' : (new Date(v) < new Date() ? 'Choose a time in the future' : null) });
      if (!r.ok) { MDM.ui.focusFirstInvalid(form); return; }
      MDM.ui.setLoading(submit, true);
      try {
        const o = await MDM.store.requestPriority(r.values.order, { reason: r.values.reason, deadline: r.values.deadline.replace('T', ' '), instructions: String(form.elements.instructions.value || '').trim(), by: 'business:' + acc.id });
        MDM.ui.toast('Priority requested for ' + o.code, 'ok');
        panel.replaceChildren(await tabPriority());
      } catch (err) { MDM.ui.toast((err && err.message) || 'Could not send the request', 'danger'); }
      finally { if (document.contains(submit)) MDM.ui.setLoading(submit, false); }
    });
    priorityList = el('div', { class: 'biz-plist', 'data-testid': 'biz-priority-list' });
    const out = el('div', { class: 'grid-2 biz-overview' },
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Request priority delivery')), el('div', { class: 'card__body' }, form)),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Your requests')), priorityList));
    await fillPriorityList(priorityList);
    return out;
  }

  // ---- Invoices ----------------------------------------------------------------------------------------------------------------
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthLabel = key => { const m = /^(\d{4})-(\d{2})$/.exec(key || ''); return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : String(key || ''); };
  async function tabInvoices() {
    const d = await load();
    const month = MDM.ui.monthKey();
    const delivered = d.orders.filter(o => o.status === 'delivered' && MDM.ui.monthKey(deliveredAt(o)) === month);
    const pkgs = delivered.reduce((n, o) => n + (o.packages || []).length, 0);
    const amount = delivered.reduce((n, o) => n + (o.totals ? o.totals.total : 0), 0);
    const invoices = d.invoices.slice().sort((a, b) => a.month < b.month ? 1 : -1);
    return el('div', { class: 'stack-6' },
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, monthLabel(month) + ' so far'), el('span', { class: 'small muted' }, 'Running total, invoiced at month end')),
        el('div', { class: 'card__body' }, el('div', { class: 'rate-table' },
          MDM.ui.rateRow('Packages delivered', String(pkgs)), MDM.ui.rateRow('Orders', String(delivered.length)), MDM.ui.rateRow('Amount', money(amount), { mono: true }),
          MDM.ui.rateRow('Payment', 'Bank transfer', { valueSub: 'Due ' + plural(d.settings.invoiceDueDays || 14, 'day') + ' after the invoice' })))),
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Invoices')),
        invoices.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack', 'data-testid': 'biz-invoices' },
          el('thead', null, el('tr', null, ['Invoice', 'Month', 'Status', 'Due', 'Total', ''].map((h, i) => el('th', { class: i === 4 ? 'num' : null }, h)))),
          el('tbody', null, invoices.map(inv => el('tr', null,
            el('td', { class: 'table__primary' }, el('span', { class: 'mono--code' }, inv.number)),
            el('td', { 'data-label': 'Month' }, monthLabel(inv.month)),
            el('td', { 'data-label': 'Status' }, html(MDM.ui.invoiceBadge(inv.status))),
            el('td', { 'data-label': 'Due' }, fmtDate(inv.dueAt, { dateOnly: true })),
            el('td', { class: 'num mono', 'data-label': 'Total' }, MDM.pricing.format(inv.total, { cents: true })),
            el('td', null, el('a', { class: 'btn btn--secondary btn--sm', href: MDM.href('admin/invoice.html?id=' + encodeURIComponent(inv.id)), target: '_blank', rel: 'noopener', 'data-testid': 'biz-invoice-open' }, 'Open')))))))
          : empty('No invoices yet', 'Your first invoice is issued at the end of the month.')));
  }

  // ---- Labels (How it works §9) ------------------------------------------------------------------------------------------------
  async function tabLabels() {
    const d = await load();
    const open = d.orders.filter(o => OPEN.indexOf(o.status) >= 0 && o.status !== 'failed');
    const sel = state.selected;
    [...sel].forEach(id => { if (!open.some(o => o.id === id)) sel.delete(id); });
    const printBtn = el('a', { class: 'btn btn--primary', 'data-testid': 'biz-labels-print' });
    const sync = () => {
      const n = sel.size;
      printBtn.textContent = n ? 'Print ' + plural(n, 'label') : 'Select orders to print';
      if (n) { printBtn.href = labelsHref('orders=' + [...sel].map(encodeURIComponent).join(',')); printBtn.removeAttribute('aria-disabled'); }
      else { printBtn.removeAttribute('href'); printBtn.setAttribute('aria-disabled', 'true'); }
    };
    const all = el('input', { type: 'checkbox', 'aria-label': 'Select all', checked: open.length > 0 && open.every(o => sel.has(o.id)), on: { change: e => { open.forEach(o => { if (e.target.checked) sel.add(o.id); else sel.delete(o.id); }); panel.querySelectorAll('[data-pick]').forEach(c => { c.checked = e.target.checked; }); sync(); } } });
    sync();
    return el('div', { class: 'stack-6' },
      d.batches.length ? el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'By bulk order'), el('span', { class: 'small muted' }, 'One label per package')),
        el('div', { class: 'list' }, d.batches.map(b => {
          const n = d.orders.filter(o => o.batchId === b.id && o.status !== 'cancelled').length, x = (b.orderIds || []).length - n;
          return el('div', { class: 'list__item' },
            el('div', { class: 'list__main' }, el('div', { class: 'list__title mono--code' }, b.code), el('div', { class: 'list__meta' }, fmtDate(b.createdAt) + ' · ' + plural((b.orderIds || []).length, 'package') + (x ? ', ' + x + ' cancelled' : '') + (b.notes ? ' · ' + b.notes : ''))),
            n ? el('a', { class: 'btn btn--secondary btn--sm', href: labelsHref('batch=' + encodeURIComponent(b.id)), 'data-testid': 'biz-labels-batch-' + b.code }, html(MDM.icon('printer', 16)), 'Print ' + plural(n, 'label')) : el('span', { class: 'small muted' }, 'All cancelled'));
        }))) : null,
      el('div', { class: 'card' }, el('div', { class: 'card__header' }, el('h2', null, 'Open orders'), printBtn),
        open.length ? el('div', { class: 'list biz-pick' },
          el('label', { class: 'checkbox biz-pick__all' }, all, el('span', null, 'Select all ' + plural(open.length, 'open order'))),
          open.map(o => el('label', { class: 'checkbox biz-pick__item' },
            el('input', { type: 'checkbox', 'data-pick': o.id, checked: sel.has(o.id), on: { change: e => { if (e.target.checked) sel.add(o.id); else sel.delete(o.id); sync(); } } }),
            el('span', null, el('span', { class: 'mono--code' }, o.code), ' · ', recipientOf(o).name),
            el('span', { class: 'checkbox__hint' }, methodLines(o)[0] + ' · ' + tierText(o) + ' · ' + MDM.STATUS[o.status].label))))
          : empty('No open orders', 'Labels for delivered orders are not needed.')));
  }

  // =========================================================================================================================
  async function render() {
    const s = await MDM.store.settings();
    state.settings = s || {};
    state.acc = await currentAccount();
    if (state.acc) { if (!panel || !app.contains(panel)) renderPortal(); else renderTab(); }
    else { panel = null; if (readSession()) clearSession(); renderPublic(state.settings); }
  }
  async function main() {
    await MDM.store.ready;
    await render();
    window.addEventListener('hashchange', () => { if (state.acc) renderTab(); });
    ['orders', 'batches', 'invoices', 'business_accounts'].forEach(c => MDM.store.subscribe(c, refresh));
    MDM.store.subscribe('settings', () => { if (!state.acc) render(); });
    MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') { state.received = null; state.done = { order: null, batch: null, excel: null }; bulk.rows = []; excel.rows = []; panel = null; render(); } });
    window.addEventListener('storage', e => { if (e.key === SESSION) { panel = null; render(); } });
  }
  main();
})(window.MDM);

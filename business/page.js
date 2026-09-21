// For businesses (SPEC §3.5): the business rate and conditions, how the account works, and the account request form.
// Every figure comes from settings at render time. A request is saved to `business_requests` (status 'pending') and the admin
// approves or declines it under Business → Requests; nothing here touches orders or accounts.
(function (MDM) { 'use strict';
  const { el, html, setError } = MDM.ui;
  const BUSINESS_ISLANDS = ['male', 'hulhumale'];
  const PICKUP_WINDOWS = [
    { value: 'morning', label: 'Morning 09:00 to 12:00' },
    { value: 'afternoon', label: 'Afternoon 13:00 to 17:00' },
    { value: 'evening', label: 'Evening 18:00 to 22:00' },
  ];
  const VOLUMES = [
    { value: '1-10', label: '1 to 10' },
    { value: '11-30', label: '11 to 30' },
    { value: '31-100', label: '31 to 100' },
    { value: '100+', label: 'More than 100' },
  ];
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const LANDLINE = /^3\d{6}$/;
  const money = n => MDM.pricing.format(n);
  const plural = (n, word) => n + ' ' + word + (Number(n) === 1 ? '' : 's');

  const slots = {
    rates: document.querySelector('[data-slot="rates"]'),
    ratesNote: document.querySelector('[data-slot="rates-note"]'),
    steps: document.querySelector('[data-slot="steps"]'),
    request: document.querySelector('[data-slot="request"]'),
  };
  const state = { received: null };   // the saved request once submitted; the form shows until then
  let form = null;

  // ---- Rate and conditions -------------------------------------------------------------------------------------------
  function rateRow(label, sub, value, opts) {
    opts = opts || {};
    return el('div', { class: 'rate-table__row' },
      el('div', { class: 'rate-table__label' }, label, sub ? el('small', null, sub) : null),
      el('div', { class: opts.mono ? 'rate-table__value mono' : 'rate-table__value' }, value, opts.sub ? el('small', null, opts.sub) : null));
  }
  function sizeRange(cell) {
    cell = cell || {};
    if (cell.quoted || cell.same === cell.cross) return 'from ' + money(cell.same);
    return money(cell.same) + ' to ' + Math.round(cell.cross).toLocaleString('en-US');
  }
  function renderRates(s) {
    const rates = s.rates || {}, sizes = rates.sizes || {}, guide = s.sizeGuide || {};
    const standard = 'Bags ' + sizeRange(sizes.bag) + ' · Box ' + sizeRange(sizes.box) + ' · XL ' + sizeRange(sizes.xl);
    slots.rates.replaceChildren(
      rateRow('Rate per package', 'Malé and Hulhumalé Phase 1 & 2', money(rates.business), { mono: true }),
      rateRow('Package size', guide.box || '', 'Under 1 ft'),
      rateRow('Larger packages or other areas', standard, 'Standard rates'),
      rateRow('Pickups', 'From your shop or office, in the window you choose', 'Daily'),
      rateRow('Billing', 'One invoice for every package delivered that month', 'Monthly', { sub: 'Due in ' + plural(s.invoiceDueDays, 'day') }));
    slots.ratesNote.textContent = 'Prices in Maldivian Rufiyaa.';
  }

  // ---- How it works ----------------------------------------------------------------------------------------------------
  function renderSteps(s) {
    const rates = s.rates || {}, ops = s.ops || {};
    const reply = ops.businessReplyText || 'within 1 working day';
    const items = [
      ['Request an account', 'Fill in the form below. We call you ' + reply + ' to confirm the details and open the account.'],
      ['Daily pickups from your shop', 'Choose a pickup window. A rider collects the day\'s packages from your shop or office in Malé or Hulhumalé.'],
      ['One invoice a month', ['Every delivered package goes on one monthly invoice at ', el('span', { class: 'nowrap' }, money(rates.business)), ', due in ' + plural(s.invoiceDueDays, 'day') + '.']],
      ['Track every package', 'Each package gets a tracking code you can share with your customer, from pickup to the door.'],
    ];
    slots.steps.replaceChildren(...items.map((it, i) => el('li', { class: 'steps__item' },
      el('div', { class: 'steps__head' }, el('span', { class: 'steps__num mono' }, String(i + 1)), el('h3', { class: 'steps__title' }, it[0])),
      el('p', { class: 'steps__text' }, it[1]))));
  }

  // ---- Account request form ------------------------------------------------------------------------------------------
  const rules = {
    name: v => v ? null : 'Enter your business name',
    contactName: v => v ? null : 'Enter the name of the person we should call',
    phone: v => !v ? 'Enter a mobile number we can call' : (MDM.ui.phone.valid(v) ? null : 'Enter a 7-digit Maldives mobile number'),
    landline: v => { if (!v) return null; const n = MDM.ui.phone.normalize(v); return n && LANDLINE.test(n) ? null : 'Enter a 7-digit landline number starting with 3'; },
    email: v => !v ? 'Enter an email address for invoices' : (EMAIL.test(v) ? null : 'Enter a valid email address'),
    zone: v => v ? null : 'Choose your island',
    pickupAddress: v => v ? null : 'Enter the address we pick up from',
    pickupWindow: v => v ? null : 'Choose a pickup window',
    volume: v => v ? null : 'Choose how many packages you expect',
  };
  const zoneOptions = () => MDM.geo.zoneOptions().filter(o => BUSINESS_ISLANDS.indexOf(MDM.geo.island(o.value)) >= 0);

  function field(name, label, control, opts) {
    opts = opts || {};
    const id = 'business-' + name;
    control.id = id; control.name = name;
    return el('div', { class: 'field' },
      el('label', { for: id }, label, opts.optional ? el('span', { class: 'optional' }, ' (optional)') : null),
      control,
      opts.hint ? el('div', { class: 'field__hint' }, opts.hint) : null);
  }
  const input = attrs => el('input', Object.assign({ class: 'input', type: 'text' }, attrs));
  const select = (options, prompt) => el('select', { class: 'select' }, el('option', { value: '' }, prompt), options.map(o => el('option', { value: o.value }, o.label)));

  function buildForm() {
    const f = el('form', { class: 'form', novalidate: true, 'data-testid': 'business-form' });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'business-submit' }, 'Request an account');
    const duplicate = el('div', { class: 'alert alert--warn', role: 'alert', tabindex: '-1', hidden: true, 'data-testid': 'business-duplicate' },
      html(MDM.icon('alert-triangle', 16)), el('div', { class: 'alert__body' }, 'We already have a request for this number. We will call you about it.'));
    const failure = el('div', { class: 'alert alert--danger', role: 'alert', tabindex: '-1', hidden: true });
    f.append(
      field('name', 'Business name', input({ autocomplete: 'organization', 'data-testid': 'business-name' })),
      field('contactName', 'Contact person', input({ autocomplete: 'name', 'data-testid': 'business-contact' })),
      el('div', { class: 'grid-2' },
        field('phone', 'Mobile', input({ type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '7XX XXXX', 'data-testid': 'business-phone' })),
        field('landline', 'Landline', input({ type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '3XX XXXX' }), { optional: true })),
      field('email', 'Email', input({ type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'name@company.mv' }), { hint: 'Invoices are sent here' }),
      el('div', { class: 'grid-2' },
        field('zone', 'Island', select(zoneOptions(), 'Choose an island')),
        field('pickupWindow', 'Pickup window', select(PICKUP_WINDOWS, 'Choose a window'))),
      field('pickupAddress', 'Pickup address', input({ autocomplete: 'street-address', placeholder: 'M. Kaneerumaage, 2nd floor, Majeedhee Magu' }), { hint: 'House or building name, floor and road' }),
      field('volume', 'Packages per week', select(VOLUMES, 'Choose a range'), { hint: 'A rough number is fine' }),
      field('notes', 'Notes', el('textarea', { class: 'textarea', rows: 3 }), { optional: true, hint: 'Opening hours, fragile items or anything the rider should know' }),
      duplicate, failure,
      el('div', { class: 'form-actions' }, submit));

    // Validate on blur only once a field has been edited, on input while it shows an error, and everything on submit.
    const dirty = new Set();
    const valueOf = c => typeof c.value === 'string' ? c.value.trim() : c.value;
    const check = n => { const c = f.elements[n]; const msg = rules[n](valueOf(c)); setError(c, msg); return !msg; };
    const onEdit = e => {
      const n = e.target.name;
      if (!n) return;
      dirty.add(n);
      if (rules[n] && e.target.closest('.field').classList.contains('is-invalid')) check(n);
      if (n === 'phone') duplicate.hidden = true;
      failure.hidden = true;
    };
    f.addEventListener('input', onEdit);
    f.addEventListener('change', onEdit);
    f.addEventListener('focusout', e => { const n = e.target.name; if (n && rules[n] && dirty.has(n)) check(n); });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      duplicate.hidden = true; failure.hidden = true;
      const r = MDM.ui.validate(f, rules);
      if (!r.ok) { MDM.ui.focusFirstInvalid(f); return; }
      const phone = MDM.ui.phone.normalize(r.values.phone);
      MDM.ui.setLoading(submit, true);
      try {
        const existing = await MDM.store.list('business_requests');
        if (existing.some(x => x.phone === phone)) { duplicate.hidden = false; duplicate.focus(); return; }
        state.received = await MDM.store.insert('business_requests', {
          name: r.values.name, contactName: r.values.contactName, phone, landline: MDM.ui.phone.normalize(r.values.landline) || '',
          email: r.values.email, zone: r.values.zone, pickupAddress: r.values.pickupAddress, pickupWindow: r.values.pickupWindow,
          volume: r.values.volume, notes: valueOf(f.elements.notes), status: 'pending',
        });
        await render();
      } catch (err) {
        failure.replaceChildren(html(MDM.icon('alert-circle', 16)), el('div', { class: 'alert__body' },
          'We could not save your request. ' + (err && err.code === 'quota' ? 'This browser is out of storage space for the demo. Reset demo data from the admin.' : 'Please try again or call us.')));
        failure.hidden = false; failure.focus();
      } finally {
        if (document.contains(submit)) MDM.ui.setLoading(submit, false);
      }
    });
    return f;
  }

  // ---- Request received ------------------------------------------------------------------------------------------------
  function renderReceived(s) {
    const r = state.received, reply = (s.ops || {}).businessReplyText || 'within 1 working day';
    const title = el('h2', { tabindex: '-1' }, 'Request received');
    slots.request.replaceChildren(el('div', { class: 'card business-received', 'data-testid': 'business-received' },
      el('div', { class: 'card__header' }, title),
      el('div', { class: 'card__body stack-4' },
        el('p', null, 'Thanks, ', el('strong', null, r.name), '. We will call ', el('span', { class: 'mono nowrap' }, MDM.ui.phone.format(r.phone)), ' ' + reply + '.'),
        el('p', { class: 'small muted' }, 'Nothing to pay now. The rate and the pickup window are confirmed on the call.'),
        el('a', { class: 'btn btn--secondary', href: MDM.href('') }, 'Back to home'))));
    title.focus();
  }

  // ---- Render ----------------------------------------------------------------------------------------------------------
  async function render() {
    const s = await MDM.store.settings();
    renderRates(s);
    renderSteps(s);
    if (state.received) renderReceived(s);
    else if (!form || !slots.request.contains(form)) { form = buildForm(); slots.request.replaceChildren(form); }
  }
  async function main() {
    await MDM.store.ready;
    await render();
    MDM.store.subscribe('settings', () => { render(); });
    // A demo reset removes the saved request, so the page goes back to an empty form.
    MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') { state.received = null; form = null; render(); } });
  }
  main();
})(window.MDM);

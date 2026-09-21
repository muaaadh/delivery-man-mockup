// Request a delivery (SPEC §3.2): four steps in one form, a sessionStorage draft, the package cart with the shared inline editor,
// live totals from MDM.pricing.quote in the sticky panel / mobile bar, and one insert into `orders` on submit.
(function (MDM) { 'use strict';
  const { el, html, setError, phone } = MDM.ui;
  const DRAFT_KEY = 'mdm:draft', ME_KEY = 'mdm:me';
  const MAX_PACKAGES = 10, BOOK_AHEAD_DAYS = 14, LEAD_MIN = 30;
  const STEPS = [{ n: 1, label: 'Service' }, { n: 2, label: 'Schedule' }, { n: 3, label: 'Your details' }, { n: 4, label: 'Review' }];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const NOTIFY = [{ value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'viber', label: 'Viber' }];
  const SERVICES = [
    { value: 'pick', label: 'Pick & deliver', hint: 'We collect it and drop it off' },
    { value: 'shop', label: 'Shop & deliver', hint: 'We buy it, then deliver' },
    { value: 'business', label: 'For a business', hint: 'Invoiced monthly' },
  ];
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const trim = v => String(v == null ? '' : v).trim();

  const dom = {};
  let settings = {};
  let draft = emptyDraft();
  let step = 1;
  let editor = null;          // { mode:'add'|'edit', id, inst } while the inline package editor is open
  let me = null;              // remembered customer (mdm:me)
  let savedAddresses = [];
  let submitting = false;
  let detailFields = null;    // step 3 field wrappers, for validation on Continue
  let dirty = new Set(), shown = new Set();   // step 3: pristine fields never show errors

  // ---- draft ----
  function emptyDraft() { return { service: 'pick', packages: [], schedule: { type: 'asap' }, customer: { name: '', phone: '', email: '', notify: 'whatsapp' }, remember: null, saveHome: false }; }
  function loadDraft() {
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
      if (d && typeof d === 'object') { const base = emptyDraft(); return Object.assign(base, d, { packages: Array.isArray(d.packages) ? d.packages : [], schedule: d.schedule || base.schedule, customer: Object.assign(base.customer, d.customer || {}) }); }
    } catch (e) { /* no draft or unreadable */ }
    return emptyDraft();
  }
  function saveDraft() { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (e) { /* private mode: the form still works for this page view */ } }
  function clearDraft() { try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* nothing to clear */ } }
  function loadMe() { try { const m = JSON.parse(localStorage.getItem(ME_KEY)); return m && m.phone ? m : null; } catch (e) { return null; } }
  function applyMe() {
    if (!me) return;
    if (!trim(draft.customer.name) && !trim(draft.customer.phone)) Object.assign(draft.customer, { name: me.name || '', phone: me.phone || '', email: me.email || '', notify: me.notify || 'whatsapp' });
    if (draft.remember == null) draft.remember = true;
  }
  function quote() { return MDM.pricing.quote({ service: draft.service, packages: draft.packages }, settings); }
  const isEmpty = () => !draft.packages.length;

  // ---- steps and hash ----
  function stepFromHash() { const m = /^#step-([1-4])$/.exec(location.hash || ''); return m ? Number(m[1]) : 0; }
  function scheduleValid() { const s = draft.schedule || {}; return s.type === 'asap' ? !closedUntil(new Date()) : !!(s.date && s.window); }
  function detailsValid() { const c = draft.customer; return !!trim(c.name) && phone.valid(c.phone) && emailOk(c.email); }
  function emailOk(v) { v = trim(v); return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function clampStep(n) {
    if (n > 1 && (isEmpty() || draft.service === 'business')) return 1;
    if (n > 2 && !scheduleValid()) return 2;
    if (n > 3 && !detailsValid()) return 3;
    return n;
  }
  function setStep(n, o) {
    n = clampStep(n);
    if (stepFromHash() !== n) history.replaceState(null, '', '#step-' + n);
    step = n;
    render();
    window.scrollTo(0, 0);
    if (o && o.initial) return;   // moving focus to the heading only after a step change, not on load
    const h = dom.steps[step].querySelector('h2');
    if (h) { try { h.focus({ preventScroll: true }); } catch (e) { /* not focusable */ } }
  }
  function go(n) {
    n = clampStep(n);
    if (n === step) { render(); return; }
    if (stepFromHash() === n) { setStep(n); return; }   // the hash was already there (a clamped direct load), so no hashchange would fire
    location.hash = '#step-' + n;   // hashchange → setStep, so Back works
  }
  async function advance() {
    if (step === 1) {
      if (draft.service === 'business') return;
      if (editor) { if (!editor.inst.validate()) return; commitEditor(editor.inst.getValue(), { stay: true }); }
      if (isEmpty()) { setError(dom.packagesField, 'Add at least 1 package'); dom.addBtn.focus(); return; }
      go(2);
    } else if (step === 2) {
      if (!scheduleValid()) { if (dom.windowField) { setError(dom.windowField, 'No windows left on this day. Choose another day.'); MDM.ui.focusFirstInvalid(dom.steps[2]); } else render(); return; }
      go(3);
    } else if (step === 3) {
      if (!validateDetails()) return;
      go(4);
    } else await submit();
  }

  // ---- shared bits ----
  function segmented(o) {
    // o: { key, label, options:[{ value, label, hint, disabled }], value, hint, onChange(value) } → { el, fieldset, hint }
    const name = 'f-' + o.key;
    const fs = el('fieldset', { class: 'segmented', id: name, 'data-testid': o.key, 'aria-labelledby': name + '-label' },
      o.options.map(opt => el('label', { class: 'segmented__option', 'data-testid': o.key + '-' + opt.value, 'data-value': opt.value },
        el('input', { class: 'sr-only', type: 'radio', name, value: opt.value, checked: opt.value === o.value, disabled: !!opt.disabled }),
        el('span', null, opt.label, opt.hint ? el('small', null, opt.hint) : null))));
    fs.addEventListener('change', e => { if (e.target && e.target.checked && o.onChange) o.onChange(e.target.value); });
    const hint = o.hint != null ? el('div', { class: 'field__hint' }, o.hint) : null;
    const wrap = el('div', { class: 'field' }, el('span', { class: 'field__label', id: name + '-label' }, o.label), fs, hint);
    return { el: wrap, fieldset: fs, hint };
  }
  function sectionHead(n, title, desc) {
    return el('div', { class: 'section-head' }, el('h2', { id: 'request-step-' + n + '-title', tabindex: '-1' }, title), desc ? el('p', { class: 'section-head__desc' }, desc) : null);
  }
  function actions(o) {
    const back = step > 1 ? el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'request-back', on: { click: () => go(step - 1) } }, 'Back') : null;
    const next = o && o.submit
      ? el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'request-submit' }, o.label)
      : el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'request-next', on: { click: advance } }, o && o.label || 'Continue');
    return el('div', { class: 'form-actions' }, back, next);
  }
  function feeLabel(f) { return f.reason ? f.label + (f.reason.indexOf('of ') === 0 ? ' ' : ', ') + f.reason : f.label; }
  function summaryCard(q, o) {
    o = o || {};
    const box = el('div', { class: 'summary', 'data-testid': o.testid || 'request-summary' });
    if (o.title) box.append(el('h2', { class: 'summary__head' }, o.title));
    if (!q.packages.length) box.append(el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc muted' }, 'No packages yet')));
    q.packages.forEach(p => box.append(el('div', { class: 'summary__line' },
      el('span', { class: 'summary__desc' }, MDM.pricing.lineLabel(p, draft.service), o.detail && p.description ? el('span', { class: 'summary__sub' }, p.description) : null),
      el('span', { class: 'summary__amount mono' }, MDM.pricing.format(p.price.lineTotal)))));
    if (q.totals.budget) box.append(el('div', { class: 'summary__line' }, el('span', { class: 'summary__desc' }, 'Shopping budget (paid up front)'), el('span', { class: 'summary__amount mono' }, MDM.pricing.format(q.totals.budget))));
    q.feeLines.forEach(f => box.append(el('div', { class: 'summary__line summary__line--fee' }, el('span', { class: 'summary__desc' }, feeLabel(f)), el('span', { class: 'summary__amount mono' }, MDM.pricing.format(f.amount)))));
    box.append(el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, q.totals.quoteRequired ? 'Estimated total' : 'Total'), el('span', { class: 'mono', 'data-testid': o.totalTestid || 'request-review-total' }, MDM.pricing.format(q.totals.total))));
    return box;
  }
  function quoteAlert(q) {
    if (!q.totals.quoteRequired) return null;
    return el('div', { class: 'alert alert--warn', role: 'status', 'data-testid': 'request-quote-alert' }, html(MDM.icon('alert-triangle', 16)),
      el('div', { class: 'alert__body' }, el('div', { class: 'alert__title' }, 'We confirm the price before pickup'),
        el('ul', { class: 'stack-1' }, q.totals.quoteReasons.map(r => el('li', null, MDM.pricing.reasonText(r))))));
  }

  // ---- step 1: service and packages ----
  function renderStep1(sec) {
    const s = draft.service;
    sec.append(sectionHead(1, 'Service and packages', 'Choose a service, then add each package with its pickup and drop-off.'));
    const form = el('div', { class: 'form' });
    form.append(segmented({ key: 'request-service', label: 'Service', options: SERVICES, value: s, onChange: changeService }).el);
    if (s === 'business') {
      form.append(el('div', { class: 'alert alert--info', 'data-testid': 'request-business-alert' }, html(MDM.icon('info', 16)),
        el('div', { class: 'alert__body' }, 'Business deliveries are ' + MDM.pricing.format((settings.rates || {}).business) + ' per package and invoiced monthly. ',
          el('a', { class: 'alert__action', href: '../business/' }, 'Request a business account'))));
      sec.append(form);
      return;
    }
    const q = quote();
    const list = el('div', { class: 'pkg-list', 'data-testid': 'request-packages' });
    draft.packages.forEach((pkg, i) => {
      if (editor && editor.mode === 'edit' && editor.id === pkg.id) list.append(editor.inst.el);
      else list.append(packageRow(pkg, i, q.packages[i]));
    });
    if (editor && editor.mode === 'add') list.append(editor.inst.el);
    dom.packagesField = el('div', { class: 'field', 'data-testid': 'request-packages-field' }, el('div', { class: 'field__error', 'data-testid': 'request-packages-error' }));
    dom.addBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': 'request-add-package', hidden: !!editor || draft.packages.length >= MAX_PACKAGES, on: { click: () => openEditor('add') } },
      html(MDM.icon('plus', 16)), draft.packages.length ? 'Add another package' : 'Add a package');
    const count = draft.packages.length;
    form.append(el('div', { class: 'section-head' }, el('h3', null, 'Your packages'), el('p', { class: 'section-head__desc' }, count ? count + ' of ' + MAX_PACKAGES + ' packages' : 'Up to ' + MAX_PACKAGES + ' packages per request')),
      list, dom.packagesField, dom.addBtn, actions());
    sec.append(form);
  }
  function packageRow(pkg, i, priced) {
    const sum = MDM.packageEditor.summary(pkg, draft.service);
    const price = priced && priced.price ? priced.price.lineTotal : 0;
    const act = (label, testid, fn) => el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': testid, on: { click: fn } }, label);
    return el('div', { class: 'card pkg-row', 'data-testid': 'package-row', 'data-package-id': pkg.id },
      el('div', { class: 'card__body' },
        el('div', { class: 'pkg-row__head' },
          el('div', { class: 'pkg-row__main' },
            el('div', { class: 'pkg-row__label' }, 'Package ' + (i + 1)),
            el('div', { class: 'pkg-row__title' }, sum.title),
            sum.description ? el('div', { class: 'pkg-row__desc' }, sum.description) : null,
            el('div', { class: 'pkg-row__line' }, sum.pickupLabel + ': ' + sum.pickupLine + ' ', el('span', { class: 'muted' }, sum.pickupZone)),
            el('div', { class: 'pkg-row__line' }, 'Drop-off: ' + sum.dropoffLine + ' ', el('span', { class: 'muted' }, sum.dropoffZone)),
            sum.flags.length ? el('div', { class: 'pkg-row__flags' }, sum.flags.map(f => el('span', { class: 'tag' }, f))) : null),
          el('div', { class: 'pkg-row__price mono' }, (pkg.size === 'xl' ? 'from ' : '') + MDM.pricing.format(price))),
        el('div', { class: 'pkg-row__actions' },
          act('Edit', 'package-edit', () => openEditor('edit', pkg.id)),
          draft.packages.length < MAX_PACKAGES ? act('Duplicate', 'package-duplicate', () => duplicatePackage(pkg.id)) : null,
          act('Remove', 'package-remove', () => removePackage(pkg.id)))));
  }
  async function changeService(next) {
    if (next === draft.service) return;
    const incompatible = next !== 'business' && draft.packages.some(p => (next === 'shop') !== !!p.shop);
    if (incompatible) {
      const n = draft.packages.length;
      const ok = await MDM.ui.confirm({ title: 'Change the service?', message: (n === 1 ? 'The package you added' : 'The ' + n + ' packages you added') + ' will be removed, because ' + (next === 'shop' ? 'a shopping run starts at the shop.' : 'a pickup needs an address instead of a shop.'), okLabel: 'Change service', danger: true });
      if (!ok) { render(); return; }
      draft.packages = [];
    }
    draft.service = next;
    editor = null;
    saveDraft(); render();
  }
  function openEditor(mode, id) {
    const value = mode === 'edit' ? draft.packages.find(p => p.id === id) || null : null;
    const first = draft.packages[0] && !(mode === 'edit' && draft.packages[0].id === id) ? draft.packages[0] : null;
    const inst = MDM.packageEditor.create({
      service: draft.service, settings, value, first, me: null, savedAddresses,
      onSave: pkg => commitEditor(pkg), onCancel: () => { editor = null; render(); },
    });
    editor = { mode, id: id || null, inst };
    render();
    inst.focus();
  }
  function commitEditor(pkg, o) {
    if (editor && editor.mode === 'edit') {
      const i = draft.packages.findIndex(p => p.id === editor.id);
      if (i === 0) {   // later packages that mirrored package 1's drop-off follow the edit
        const old = JSON.stringify(draft.packages[0].dropoff);
        draft.packages.slice(1).forEach(p => { if (JSON.stringify(p.dropoff) === old) p.dropoff = clone(pkg.dropoff); });
      }
      if (i >= 0) draft.packages[i] = pkg; else draft.packages.push(pkg);
    } else if (draft.packages.length < MAX_PACKAGES) draft.packages.push(pkg);
    editor = null;
    saveDraft();
    if (!(o && o.stay)) render();
  }
  function duplicatePackage(id) {
    const src = draft.packages.find(p => p.id === id);
    if (!src || draft.packages.length >= MAX_PACKAGES) return;
    draft.packages.push(Object.assign(clone(src), { id: MDM.id('pkg') }));
    saveDraft(); render();
  }
  async function removePackage(id) {
    const i = draft.packages.findIndex(p => p.id === id);
    if (i < 0) return;
    const pkg = draft.packages[i];
    if (trim(pkg.description)) {
      const ok = await MDM.ui.confirm({ title: 'Remove package ' + (i + 1) + '?', message: pkg.description + ' will be removed from this request.', okLabel: 'Remove package', danger: true });
      if (!ok) return;
    }
    draft.packages.splice(i, 1);
    if (editor && editor.id === id) editor = null;
    saveDraft(); render();
  }

  // ---- step 2: schedule ----
  function toMin(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(trim(s)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function dateOf(key) { const p = String(key || '').split('-').map(Number); return p.length === 3 && p.every(n => !isNaN(n)) ? new Date(p[0], p[1] - 1, p[2]) : null; }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function closedWindows(ops, day) {
    return (Array.isArray(ops.closedWindows) ? ops.closedWindows : []).map(w => {
      const m = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+)?(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(trim(w));
      return m ? { day: m[1] || null, start: toMin(m[2]), end: toMin(m[3]) } : null;
    }).filter(w => w && (!w.day || w.day === day));
  }
  function slotsFor(dateKey, now) {
    const ops = settings.ops || {};
    const start = toMin(ops.slotStart) != null ? toMin(ops.slotStart) : 540, end = toMin(ops.slotEnd) != null ? toMin(ops.slotEnd) : 1380;
    const stepMin = Number(ops.slotMinutes) > 0 ? Number(ops.slotMinutes) : 120;
    const d = dateOf(dateKey);
    if (!d) return [];
    const closed = closedWindows(ops, DAYS[d.getDay()]);
    const out = [];
    for (let t = start; t + stepMin <= end; t += stepMin) out.push({ start: t, end: t + stepMin });
    const cutoff = dateKey === MDM.ui.dayKey(now) ? now.getHours() * 60 + now.getMinutes() + LEAD_MIN : -1;
    return out.filter(w => w.start >= cutoff && !closed.some(c => w.start < c.end && c.start < w.end))
      .map(w => { const v = MDM.ui.minutesToHHMM(w.start) + '-' + MDM.ui.minutesToHHMM(w.end); return { value: v, label: MDM.ui.window(v) }; });
  }
  // closedUntil(now) → 'HH:MM' when ASAP is not possible right now (outside hours, inside a closed window, or no window left today), else null.
  function closedUntil(now) {
    const ops = settings.ops || {}, hours = ops.hours || {};
    const open = hours.open || '09:00', close = hours.close || '23:00';
    const cur = now.getHours() * 60 + now.getMinutes();
    const pause = closedWindows(ops, DAYS[now.getDay()]).find(c => cur >= c.start && cur < c.end);
    if (pause) return MDM.ui.minutesToHHMM(pause.end);
    const a = toMin(open), b = toMin(close);
    const isOpen = a == null || b == null ? true : (a <= b ? cur >= a && cur < b : cur >= a || cur < b);
    if (!isOpen) return open;
    if (!slotsFor(MDM.ui.dayKey(now), now).length) return open;
    return null;
  }
  function renderStep2(sec) {
    const ops = settings.ops || {};
    const now = new Date();
    const until = closedUntil(now);
    const today = MDM.ui.dayKey(now);
    const firstDay = slotsFor(today, now).length ? today : MDM.ui.dayKey(addDays(now, 1));
    const maxDay = MDM.ui.dayKey(addDays(now, BOOK_AHEAD_DAYS));
    if (until && draft.schedule.type !== 'slot') draft.schedule = { type: 'slot', date: '', window: '' };
    const s = draft.schedule;
    if (s.type === 'slot') {
      if (!s.date || s.date < firstDay || s.date > maxDay) s.date = firstDay;
      const slots = slotsFor(s.date, now);
      if (!slots.some(x => x.value === s.window)) s.window = slots.length ? slots[0].value : '';
    }
    saveDraft();
    sec.append(sectionHead(2, 'When should we come?', 'Pickup starts as soon as a rider is free, or choose a 2-hour window.'));
    const form = el('div', { class: 'form' });
    form.append(segmented({ key: 'request-schedule', label: 'Timing', value: s.type,
      options: [{ value: 'asap', label: 'As soon as possible', disabled: !!until }, { value: 'slot', label: 'Pick a time' }],
      hint: until ? 'We are closed now. ASAP requests are picked up from ' + until + '.' : (ops.asapText || ''),
      onChange: v => { draft.schedule = v === 'asap' ? { type: 'asap' } : { type: 'slot', date: '', window: '' }; saveDraft(); render(); } }).el);
    dom.windowField = null;
    if (s.type === 'slot') {
      const date = el('input', { class: 'input', type: 'date', id: 'f-date', name: 'date', 'data-testid': 'request-date', min: firstDay, max: maxDay, value: s.date, required: true });
      const win = el('select', { class: 'select', id: 'f-window', name: 'window', 'data-testid': 'request-window' });
      const fillWindows = () => {
        const slots = slotsFor(s.date, now);
        win.replaceChildren(...slots.map(x => el('option', { value: x.value }, x.label)));
        if (!slots.length) win.append(el('option', { value: '' }, 'No windows left on this day'));
        win.value = slots.some(x => x.value === s.window) ? s.window : (slots[0] ? slots[0].value : '');
        s.window = win.value;
        win.disabled = !slots.length;
      };
      fillWindows();
      date.addEventListener('change', () => { s.date = date.value && date.value >= firstDay && date.value <= maxDay ? date.value : firstDay; if (date.value !== s.date) date.value = s.date; fillWindows(); saveDraft(); });
      win.addEventListener('change', () => { s.window = win.value; saveDraft(); });
      dom.windowField = el('div', { class: 'field' }, el('label', { for: 'f-window' }, 'Window'), win, el('div', { class: 'field__hint' }, 'Windows are ' + (Number(ops.slotMinutes) > 0 ? Number(ops.slotMinutes) / 60 : 2) + ' hours, ' + (ops.slotStart || '09:00') + ' to ' + (ops.slotEnd || '23:00')));
      date.addEventListener('change', () => setError(dom.windowField, null));
      form.append(el('div', { class: 'grid-2' }, el('div', { class: 'field' }, el('label', { for: 'f-date' }, 'Date'), date), dom.windowField));
    }
    form.append(actions());
    sec.append(form);
  }

  // ---- step 3: your details ----
  function renderStep3(sec) {
    const c = draft.customer;
    if (draft.remember == null) draft.remember = !!me;
    sec.append(sectionHead(3, 'Your details', 'We message you the payment link and every update on the channel you choose.'));
    const form = el('div', { class: 'form' });
    const textField = (key, label, attrs, o) => {
      o = o || {};
      const ctrl = el('input', Object.assign({ class: 'input', id: 'f-' + key, name: key, 'data-testid': 'request-' + key, value: c[key] || '' }, attrs));
      const wrap = el('div', { class: 'field', 'data-field': key }, el('label', { for: 'f-' + key }, label, o.optional ? el('span', { class: 'optional' }, ' (optional)') : null), ctrl, o.hint ? el('div', { class: 'field__hint' }, o.hint) : null);
      ctrl.addEventListener('input', () => { c[key] = ctrl.value; saveDraft(); dirty.add(key); if (shown.has(key)) checkDetail(key); });
      ctrl.addEventListener('blur', () => { if (!dirty.has(key)) return; shown.add(key); checkDetail(key); });
      return wrap;
    };
    detailFields = {
      name: textField('name', 'Your name', { autocomplete: 'name' }),
      phone: textField('phone', 'Mobile number', { type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '7XX XXXX' }, { hint: 'The rider and our team reach you on this number' }),
      email: textField('email', 'Email', { type: 'email', autocomplete: 'email', enterkeyhint: 'next' }, { optional: true, hint: 'For a copy of your order details' }),
    };
    form.append(detailFields.name, detailFields.phone, detailFields.email);
    form.append(segmented({ key: 'request-notify', label: 'Send updates by', options: NOTIFY, value: c.notify || 'whatsapp', onChange: v => { c.notify = v; saveDraft(); } }).el);
    const remember = el('input', { type: 'checkbox', id: 'f-remember', name: 'remember', 'data-testid': 'request-remember', checked: !!draft.remember });
    remember.addEventListener('change', () => { draft.remember = remember.checked; saveDraft(); });
    form.append(el('label', { class: 'checkbox', for: 'f-remember' }, remember, el('span', null, 'Remember me on this device', el('span', { class: 'hint' }, 'Your name and number are filled in next time on this browser'))));
    const home = homeAddress();
    if (home && !savedAddresses.some(a => a.address === home.address)) {
      const save = el('input', { type: 'checkbox', id: 'f-save-home', name: 'saveHome', 'data-testid': 'request-save-home', checked: !!draft.saveHome });
      save.addEventListener('change', () => { draft.saveHome = save.checked; saveDraft(); });
      form.append(el('label', { class: 'checkbox', for: 'f-save-home' }, save, el('span', null, 'Save this address as Home', el('span', { class: 'hint' }, home.address + ' · ' + MDM.geo.zoneLabel(home.zone)))));
    } else draft.saveHome = false;
    form.append(actions());
    sec.append(form);
  }
  // The address worth remembering: package 1's pickup (or its drop-off on a shopping run), never a terminal or the airport.
  function homeAddress() {
    const p = draft.packages[0];
    if (!p) return null;
    const end = draft.service === 'shop' ? p.dropoff : p.pickup;
    if (!end || !end.address || end.cargo || end.zone === 'airport' || end.zone === 'other') return null;
    return { label: 'Home', address: end.address, zone: end.zone, meetAt: end.meetAt || 'door' };
  }
  function detailRule(key) {
    const c = draft.customer;
    if (key === 'name') return trim(c.name) ? null : 'Enter your name';
    if (key === 'phone') return phone.valid(c.phone) ? null : 'Enter a Maldivian mobile number, 7 digits starting with 7 or 9';
    if (key === 'email') return emailOk(c.email) ? null : 'Enter a valid email address';
    return null;
  }
  function checkDetail(key) { const msg = detailRule(key); if (detailFields && detailFields[key]) setError(detailFields[key], msg); return msg; }
  function validateDetails() {
    let bad = false;
    ['name', 'phone', 'email'].forEach(k => { shown.add(k); if (checkDetail(k)) bad = true; });
    if (bad) MDM.ui.focusFirstInvalid(dom.steps[3]);
    return !bad;
  }

  // ---- step 4: review ----
  function renderStep4(sec) {
    const q = quote();
    const c = draft.customer, s = draft.schedule;
    sec.append(sectionHead(4, 'Review your request', q.totals.quoteRequired ? 'We confirm the price first, then send you the payment link.' : 'Check everything, then continue to the bank transfer.'));
    const form = el('div', { class: 'form' });
    form.append(summaryCard(q, { testid: 'request-review-summary', totalTestid: 'request-review-total', detail: true }));
    const alert = quoteAlert(q);
    if (alert) form.append(alert);
    if (draft.service === 'shop') form.append(el('p', { class: 'muted', 'data-testid': 'request-shop-note' }, 'You pay the shopping budget up front. We refund or ask for the difference after we show you the receipt.'));
    const head = (label, n, editLabel) => el('div', { class: 'rate-table__row rate-table__row--head' }, el('span', null, label),
      el('button', { type: 'button', class: 'btn btn--ghost btn--sm review__edit', 'data-testid': 'request-edit-step', 'data-step': n, on: { click: () => go(n) } }, editLabel));
    const row = (label, value, mono) => el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, label), el('div', { class: ['rate-table__value', mono ? 'mono' : ''] }, value));
    const when = s.type === 'asap' ? 'As soon as possible' : (MDM.ui.fmtDate(dateOf(s.date), { dateOnly: true }) + ', ' + MDM.ui.window(s.window));
    const serviceLabel = (SERVICES.find(x => x.value === draft.service) || {}).label || draft.service;
    form.append(el('div', { class: 'rate-table', 'data-testid': 'request-review-details' },
      head('Packages', 1, 'Edit packages'),
      row('Service', serviceLabel + ' · ' + draft.packages.length + (draft.packages.length === 1 ? ' package' : ' packages')),
      head('Timing', 2, 'Edit timing'),
      row('When', when),
      head('Your details', 3, 'Edit details'),
      row('Name', c.name),
      row('Mobile', phone.format(c.phone), true),
      row('Updates by', (NOTIFY.find(x => x.value === c.notify) || NOTIFY[1]).label + (c.email ? ' · ' + c.email : ''))));
    form.append(actions({ submit: true, label: q.totals.quoteRequired ? 'Send request for a quote' : 'Continue to payment' }));
    sec.append(form);
  }

  // ---- submit ----
  function geocode(end) {
    let p;
    if (end.cargo && end.cargo.terminal && MDM.geo.terminalPoint(end.cargo.terminal)) { const t = MDM.geo.terminalPoint(end.cargo.terminal); p = { lat: t[0], lng: t[1] }; }
    else if (end.zone === 'airport' && end.meetAt && MDM.geo.airportPoint(end.meetAt)) { const t = MDM.geo.airportPoint(end.meetAt); p = { lat: t[0], lng: t[1] }; }
    else p = MDM.geo.geocodeZone(end.zone === 'other' ? 'male' : end.zone, end.address);
    end.lat = p.lat; end.lng = p.lng;
  }
  function finalizePackage(p, customer) {
    const pkg = clone(p);
    const self = { name: customer.name, phone: customer.phone };
    if (pkg.pickup) { if (!pkg.pickup.contact || !pkg.pickup.contact.phone) pkg.pickup.contact = self; geocode(pkg.pickup); }
    if (pkg.dropoff) { if (!pkg.dropoff.recipient || !pkg.dropoff.recipient.phone) pkg.dropoff.recipient = self; geocode(pkg.dropoff); }
    if (pkg.shop) { const g = MDM.geo.geocodeZone(pkg.shop.zone === 'other' ? 'male' : pkg.shop.zone, pkg.shop.name + ' ' + (pkg.shop.address || '')); Object.assign(pkg.shop, { lat: g.lat, lng: g.lng, receiptTotal: null, receiptPhotoId: null }); }
    return pkg;
  }
  async function submit() {
    if (submitting) return;
    if (isEmpty() || !scheduleValid() || !detailsValid()) { setStep(clampStep(4)); return; }
    submitting = true;
    const btn = dom.form.querySelector('[data-testid="request-submit"]');
    MDM.ui.setLoading(btn, true);
    try {
      const c = draft.customer;
      const normalized = phone.normalize(c.phone);
      const customer = await MDM.store.upsertCustomer({ name: trim(c.name), phone: normalized, email: trim(c.email), notify: c.notify || 'whatsapp', address: draft.saveHome ? homeAddress() : null });
      const q = quote();
      const quoteRequired = !!q.totals.quoteRequired;
      const at = new Date().toISOString();
      const created = { id: MDM.id('evt'), at, type: 'created', label: quoteRequired ? 'Quote requested' : 'Order placed', by: 'customer', visibility: 'public', meta: null };
      const order = await MDM.store.insert('orders', {
        source: 'web', service: draft.service, customerId: customer.id,
        customer: { name: trim(c.name), phone: normalized, email: trim(c.email), notify: c.notify || 'whatsapp' },
        accountId: null,
        packages: q.packages.map(p => finalizePackage(p, customer)),
        fees: q.fees, totals: q.totals,
        schedule: draft.schedule.type === 'slot' ? { type: 'slot', date: draft.schedule.date, window: draft.schedule.window } : { type: 'asap' },
        payment: { method: 'transfer', status: 'unpaid', bank: '', payerName: '', paidAmount: null, reference: '', slip: null, submittedAt: null, verifiedAt: null, verifiedBy: null, rejectReason: null, note: '', refund: null },
        quote: { status: quoteRequired ? 'pending' : 'none', total: null, note: '', sentAt: null, by: null },
        settlement: null,
        status: quoteRequired ? 'quote_pending' : 'awaiting_payment', driverId: null,
        route: { stops: [], polyline: [] },
        events: [created], notes: [],
      });
      await MDM.store.insert('events', { id: created.id, orderId: order.id, code: order.code, at: created.at, type: created.type, label: created.label, by: created.by, visibility: created.visibility });
      try {
        if (draft.remember) localStorage.setItem(ME_KEY, JSON.stringify({ name: trim(c.name), phone: normalized, email: trim(c.email), notify: c.notify || 'whatsapp' }));
        else localStorage.removeItem(ME_KEY);
      } catch (e) { /* remembering is a convenience only */ }
      clearDraft();
      location.href = MDM.href('checkout/?order=' + encodeURIComponent(order.id));
    } catch (e) {
      submitting = false;
      MDM.ui.setLoading(btn, false);
      const quota = e && e.code === 'quota';
      MDM.ui.toast(quota ? 'This browser is out of storage space for the demo. Reset demo data from the admin.' : 'We could not save your request. Please try again.', 'danger');
    }
  }

  // ---- panel and mobile bar ----
  async function startOver() {
    const ok = await MDM.ui.confirm({ title: 'Start over?', message: 'This clears the packages, timing and details you entered.', okLabel: 'Start over', danger: true });
    if (!ok) return;
    draft = emptyDraft(); editor = null; dirty = new Set(); shown = new Set();
    applyMe();
    clearDraft();
    if (step === 1) render(); else go(1);
  }
  function renderPanel() {
    const q = quote();
    const card = summaryCard(q, { title: 'Your request', testid: 'request-summary', totalTestid: 'request-total' });
    if (q.totals.quoteRequired) card.append(el('p', { class: 'small muted' }, 'Estimated. We confirm the price before pickup.'));
    card.append(el('div', { class: 'request-panel__foot' }, el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'request-start-over', on: { click: startOver } }, 'Start over')));
    dom.panel.replaceChildren(card);
  }
  function renderBar() {
    const q = quote();
    const n = draft.packages.length;
    let action;
    if (draft.service === 'business') action = el('a', { class: 'btn btn--primary', href: '../business/', 'data-testid': 'request-mobile-next' }, 'Request a business account');
    else action = el('button', { type: 'button', class: 'btn btn--primary', 'data-testid': 'request-mobile-next', on: { click: advance } },
      step === 4 ? (q.totals.quoteRequired ? 'Send request for a quote' : 'Continue to payment') : 'Continue');
    dom.bar.replaceChildren(
      el('div', { class: 'mobile-bar__info' },
        el('div', { class: 'mobile-bar__total mono', 'data-testid': 'request-mobile-total' }, MDM.pricing.format(q.totals.total)),
        el('div', { class: 'mobile-bar__meta' }, (n === 1 ? '1 package' : n + ' packages') + (q.totals.quoteRequired ? ' · estimated' : ''))),
      action);
  }
  function renderStepper() {
    dom.stepper.replaceChildren(...STEPS.map(s => {
      const done = s.n < step, current = s.n === step;
      const li = el('li', { class: ['stepper__item', done ? 'is-done' : ''], 'aria-current': current ? 'step' : null, 'data-testid': 'request-step', 'data-step': s.n, 'data-state': done ? 'done' : current ? 'current' : 'upcoming' });
      if (done) li.append(el('button', { type: 'button', class: 'stepper__link', 'aria-label': 'Back to ' + s.label, on: { click: () => go(s.n) } }, html(MDM.icon('check', 16)), el('span', { class: 'stepper__label' }, s.label)));
      else li.append(el('span', { class: 'stepper__num' }, String(s.n)), el('span', { class: 'stepper__label' }, s.label));
      return li;
    }), el('li', { class: 'stepper__progress', 'aria-hidden': 'true' }, 'Step ' + step + ' of 4'));
  }
  function render() {
    renderStepper();
    Object.keys(dom.steps).forEach(k => { const sec = dom.steps[k]; sec.hidden = Number(k) !== step; sec.replaceChildren(); });
    ({ 1: renderStep1, 2: renderStep2, 3: renderStep3, 4: renderStep4 })[step](dom.steps[step]);
    renderPanel();
    renderBar();
  }

  async function main() {
    await MDM.store.ready;
    settings = await MDM.store.settings();
    dom.form = document.querySelector('[data-testid="request-form"]');
    dom.stepper = dom.form.querySelector('.stepper');
    // Section ids differ from the #step-n hashes on purpose: a matching id would make the browser scroll the step under the sticky header on load.
    dom.steps = { 1: document.getElementById('request-step-1'), 2: document.getElementById('request-step-2'), 3: document.getElementById('request-step-3'), 4: document.getElementById('request-step-4') };
    dom.panel = document.querySelector('.request-layout__panel');
    dom.bar = document.querySelector('.mobile-bar');
    draft = loadDraft();
    me = loadMe();
    if (me) {
      const found = await MDM.store.list('customers', { where: { phone: phone.normalize(me.phone) }, limit: 1 });
      savedAddresses = found[0] && Array.isArray(found[0].addresses) ? found[0].addresses : [];
      applyMe();
    }
    dom.form.addEventListener('submit', e => { e.preventDefault(); advance(); });
    window.addEventListener('hashchange', () => { const n = stepFromHash(); if (n && n !== step) setStep(n); });
    MDM.store.subscribe('settings', async () => { settings = await MDM.store.settings(); render(); });
    MDM.store.subscribe('*', async msg => { if (msg && msg.op === 'reset') { settings = await MDM.store.settings(); render(); } });
    setStep(stepFromHash() || 1, { initial: true });
  }
  main();
})(window.MDM);

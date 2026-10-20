// Sign in for every role (client requirements §2, §21): customers and businesses by mobile number and a one-time code, drivers and
// staff by name and PIN, the office (admin, operators, office staff) by username and password, with a password reset.
// The mockup has no server, so codes and PINs accept any 4 digits. A customer's first sign-in on a number is the sign-up: their name
// and "I've read what we carry", ticked once (updates 17/10/2026). The sessions it writes are the ones every other page reads:
// customers → localStorage mdm:me, businesses → localStorage mdm:business, drivers → sessionStorage mdm:driver,
// staff → localStorage mdm:staff, office → localStorage mdm:session { user, staffId, role, name }.
(function (MDM) { 'use strict';
  const { el, html } = MDM.ui;
  // The customer's mobile-number sign-in is the default; the other four are a quiet row of chips under the form ("Not a customer?").
  const ROLES = [
    { value: 'customer', label: 'Customer', title: 'Sign in', icon: 'user' },
    { value: 'business', label: 'Business', title: 'Business sign-in', icon: 'building' },
    { value: 'driver', label: 'Driver', title: 'Driver sign-in', icon: 'bike' },
    { value: 'staff', label: 'Staff', title: 'Staff sign-in', icon: 'clock' },
    { value: 'admin', label: 'Office', title: 'Office sign-in', icon: 'dashboard' },
  ];
  const params = new URLSearchParams(location.search);
  const asParam = params.get('as') === 'rider' ? 'driver' : params.get('as');
  const state = { role: ROLES.some(r => r.value === asParam) ? asParam : 'customer', phone: params.get('phone') || '', step: 1, next: params.get('next') || '', reset: null };
  if (state.role === 'admin' && params.get('reset') === '1') state.reset = { step: 1, user: '' };
  let view, drivers = [], staff = [], accounts = [], settings = {};
  const DEMO_PASSWORD = 'delivery';
  const DEMO_CODE = 'Demo: any 4 digits';

  function field(id, label, control, hint) {
    return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('div', { class: 'field__hint' }, hint) : null, el('div', { class: 'field__error' }));
  }
  function setError(input, msg) { MDM.ui.setError(input.closest('.field'), msg); }
  function go(path) { location.href = state.next && /^[a-z]+\/?(\?.*)?$/i.test(state.next) ? MDM.href(state.next) : MDM.href(path); }
  function save(store, key, value) { try { store.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ } }
  function passwordFor(username) { try { return localStorage.getItem('mdm:pw:' + username) || DEMO_PASSWORD; } catch (e) { return DEMO_PASSWORD; } }
  const actions = (...kids) => el('div', { class: 'login-actions' }, kids);
  const submit = (label) => el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'login-submit' }, label);
  const head = (title, desc) => el('div', { class: 'page-head' }, el('h1', null, title), desc ? el('p', { class: 'page-head__desc' }, desc) : null);

  // One view per role and step: the title (and a short line) in the page head, the form, then the other sign-ins.
  function render() {
    const role = ROLES.find(r => r.value === state.role);
    const forms = { customer: () => (state.step === 3 ? signupForm() : phoneForm('customer')), business: () => phoneForm('business'), driver: driverForm, staff: staffForm, admin: state.reset ? resetForm : officeForm };
    const v = forms[state.role]();
    const others = state.step === 1 && !state.reset ? el('nav', { class: 'login-other', 'aria-labelledby': 'login-other-h' },
      el('h2', { id: 'login-other-h', class: 'login-other__title' }, state.role === 'customer' ? 'Not a customer?' : 'Other sign-ins'),
      el('div', { class: 'login-roles', role: 'group', 'aria-labelledby': 'login-other-h', 'data-testid': 'login-role' },
        ROLES.map(r => el('button', { type: 'button', class: 'chip login-role', 'aria-pressed': r.value === state.role ? 'true' : 'false', hidden: r.value === state.role, 'data-testid': 'login-role-' + r.value,
          on: { click: () => { state.role = r.value; state.step = 1; state.reset = null; render(); const first = view.querySelector('.login-form input, .login-form select'); if (first) first.focus(); } } },
          html(MDM.icon(r.icon, 16)), r.label)))) : null;
    view.replaceChildren(el('div', { class: 'login' }, head(v.title || role.title, v.desc), v.form, others));
    if (MDM.motion) MDM.motion.enter(v.form);
  }

  // Customers and businesses: mobile number → one-time code. Each form returns { form, title, desc } for render().
  function phoneForm(kind) {
    if (state.step === 2) {
      const code = el('input', { class: 'input', id: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '4', placeholder: '4 digits', 'data-testid': 'login-code' });
      const form = el('form', { class: 'login-form', novalidate: true, on: { submit: async e => {
        e.preventDefault();
        if (!/^\d{4}$/.test(code.value.trim())) { setError(code, 'Enter the 4-digit code'); code.focus(); return; }
        const phone = MDM.ui.phone.normalize(state.phone);
        if (kind === 'business') {
          const acc = accounts.find(a => MDM.ui.phone.normalize(a.phone) === phone && a.status === 'approved');
          save(localStorage, 'mdm:business', { accountId: acc.id, name: acc.name, phone, at: new Date().toISOString() });
          go('business/');
          return;
        }
        const found = (await MDM.store.list('customers', { where: { phone } }))[0] || null;
        // A new number, or a customer who only ordered as a guest: sign up first (name and what we carry).
        if (!found || !found.termsAcceptedAt) { state.step = 3; state.signup = { found }; render(); return; }
        save(localStorage, 'mdm:me', { name: found.name, phone, email: found.email || '', notify: found.notify || 'whatsapp', signedInAt: new Date().toISOString() });
        go('account/');
      } } },
        field('code', 'Code', code, DEMO_CODE),
        actions(submit('Sign in'), el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => { state.step = 1; render(); } } }, 'Use another number')));
      setTimeout(() => code.focus(), 0);
      return { form, desc: 'Code sent to ' + MDM.ui.phone.format(state.phone) + '.' };
    }
    const phone = el('input', { class: 'input', id: 'phone', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '7XX XXXX', value: state.phone, 'data-testid': 'login-phone' });
    const notMember = el('div', { class: 'alert alert--warn', hidden: true }, el('div', {}, 'No business account on this number. ', el('a', { href: MDM.href('business/#apply') }, 'Apply for one')));
    const form = el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      notMember.hidden = true;
      if (!MDM.ui.phone.valid(phone.value)) { setError(phone, 'Enter a 7-digit Maldives mobile number'); phone.focus(); return; }
      if (kind === 'business' && !accounts.some(a => MDM.ui.phone.normalize(a.phone) === MDM.ui.phone.normalize(phone.value) && a.status === 'approved')) { notMember.hidden = false; return; }
      state.phone = phone.value; state.step = 2; render();
    } } },
      field('phone', kind === 'business' ? 'Account mobile number' : 'Mobile number', phone, kind === 'business' ? 'Demo: 780 1122 or 763 3221' : null),
      notMember,
      actions(el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'login-continue' }, 'Send code'),
        kind === 'business' ? el('a', { class: 'login-link', href: MDM.href('business/#apply') }, 'Open a business account') : el('a', { class: 'login-link', href: MDM.href('request/') }, 'New here? Request a delivery')));
    if (state.phone && kind === 'customer') setTimeout(() => { if (MDM.ui.phone.valid(state.phone)) form.requestSubmit(); }, 0);
    return { form, desc: kind === 'business' ? null : 'We text a code to your mobile. No password.' };
  }

  // Customer sign-up after the code: their name and the "what we carry" tick, once per number (updates 17/10/2026).
  function signupForm() {
    const found = state.signup && state.signup.found;
    const name = el('input', { class: 'input', id: 'signup-name', type: 'text', autocomplete: 'name', maxlength: '80', value: (found && found.name) || '', 'data-testid': 'login-signup-name' });
    const tick = el('input', { type: 'checkbox', id: 'signup-terms', 'aria-describedby': 'signup-terms-text', 'data-testid': 'login-terms' });
    tick.addEventListener('change', () => { if (tick.checked) setError(tick, null); });
    const terms = el('div', { class: 'field' },
      el('p', { class: 'login-terms', id: 'signup-terms-text' }, settings.terms || ''),
      // wrapped so base.css's `.field > label` (the field label rule) does not override `.checkbox`
      el('div', null, el('label', { class: 'checkbox', for: 'signup-terms' }, tick, el('span', null, "I've read what we carry"))),
      el('div', { class: 'field__error' }));
    const form = el('form', { class: 'login-form', novalidate: true, on: { submit: async e => {
      e.preventDefault();
      const n = name.value.trim();
      setError(name, n ? null : 'Enter your name');
      setError(tick, tick.checked ? null : "Tick the box to confirm you've read what we carry");
      if (!n || !tick.checked) { (n ? tick : name).focus(); return; }
      const phone = MDM.ui.phone.normalize(state.phone);
      const c = await MDM.store.upsertCustomer({ name: n, phone, termsAcceptedAt: new Date().toISOString(), touch: false });
      save(localStorage, 'mdm:me', { name: c.name, phone, email: c.email || '', notify: c.notify || 'whatsapp', signedInAt: new Date().toISOString() });
      go('account/');
    } } },
      field('signup-name', 'Your name', name),
      terms,
      actions(el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'login-signup-submit' }, found ? 'Continue' : 'Create account'),
        el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => { state.step = 1; state.signup = null; render(); } } }, 'Use another number')));
    setTimeout(() => (name.value ? tick : name).focus(), 0);
    return { form, title: found ? 'One more step' : 'Create your account', desc: 'Your name and what we carry. Only once.' };
  }

  // Drivers and staff: pick your name, enter your PIN.
  function pinForm(id, label, people, onOk, cta) {
    const sel = el('select', { class: 'select', id, 'data-testid': 'login-' + id }, el('option', { value: '' }, 'Choose your name'), people.map(p => el('option', { value: p.id }, p.name + (p.title ? ' · ' + p.title : ''))));
    const pin = el('input', { class: 'input', id: id + '-pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', maxlength: '4', placeholder: '4 digits', 'data-testid': 'login-pin' });
    const form = el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      let ok = true;
      if (!sel.value) { setError(sel, 'Choose your name'); ok = false; }
      if (!/^\d{4}$/.test(pin.value)) { setError(pin, 'Enter your 4-digit PIN'); ok = false; }
      if (ok) onOk(sel.value);
    } } },
      field(id, label, sel), field(id + '-pin', 'PIN', pin, DEMO_CODE), actions(submit(cta)));
    return { form };
  }
  function driverForm() {
    return pinForm('driver', 'Driver', drivers, driverId => { save(sessionStorage, 'mdm:driver', { driverId, online: false }); go('driver/'); }, 'Open my jobs');
  }
  function staffForm() {
    return pinForm('staff', 'Employee', staff.filter(s => s.status !== 'inactive'), staffId => {
      const s = staff.find(x => x.id === staffId);
      save(localStorage, 'mdm:staff', { staffId, name: s.name, role: s.role, at: new Date().toISOString() });
      go('staff/');
    }, 'Open staff portal');
  }

  // Office: username + password, role from the staff record (admin, operator, office).
  function officeForm() {
    const user = el('input', { class: 'input', id: 'user', type: 'text', autocomplete: 'username', autocapitalize: 'off', 'data-testid': 'login-user' });
    const pass = el('input', { class: 'input', id: 'pass', type: 'password', autocomplete: 'current-password', 'data-testid': 'login-pass' });
    const err = el('div', { class: 'alert alert--danger', hidden: true }, el('div', {}, 'Wrong username or password'));
    const form = el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      const u = user.value.trim().toLowerCase();
      const s = staff.find(x => x.username === u && ['admin', 'operator', 'office'].indexOf(x.role) >= 0);
      if (s && pass.value === passwordFor(u)) {
        save(localStorage, 'mdm:session', { user: u, staffId: s.id, role: s.role, name: s.name, at: new Date().toISOString() });
        MDM.store.audit('signed_in', s.name + ' signed in to the office portal', s.role === 'admin' ? 'admin' : 'operator:' + s.id);
        go('admin/');
      } else { err.hidden = false; pass.value = ''; pass.focus(); }
    } } },
      field('user', 'Username', user, 'Demo: admin, operator or lamya'),
      field('pass', 'Password', pass, 'Demo password: delivery'),
      err,
      actions(submit('Sign in'), el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'login-forgot', on: { click: () => { state.reset = { step: 1, user: user.value.trim() }; render(); } } }, 'Forgot password?')));
    return { form };
  }
  // Password reset: username → code sent to the phone on file → new password (requirements §21).
  function resetForm() {
    const r = state.reset;
    const back = el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => { state.reset = null; render(); } } }, 'Back to sign in');
    if (r.step === 1) {
      const user = el('input', { class: 'input', id: 'reset-user', type: 'text', autocapitalize: 'off', value: r.user || '', 'data-testid': 'reset-user' });
      const form = el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
        e.preventDefault();
        const s = staff.find(x => x.username === user.value.trim().toLowerCase() && ['admin', 'operator', 'office'].indexOf(x.role) >= 0);
        if (!s) { setError(user, 'No office account with that username'); return; }
        state.reset = { step: 2, user: s.username, phone: s.phone, name: s.name }; render();
      } } },
        field('reset-user', 'Username', user), actions(submit('Send reset code'), back));
      return { form, title: 'Reset your password', desc: 'We text a code to the number on your staff record.' };
    }
    const code = el('input', { class: 'input', id: 'reset-code', type: 'text', inputmode: 'numeric', maxlength: '4', placeholder: '4 digits', 'data-testid': 'reset-code' });
    const pw = el('input', { class: 'input', id: 'reset-pass', type: 'password', autocomplete: 'new-password', 'data-testid': 'reset-pass' });
    const pw2 = el('input', { class: 'input', id: 'reset-pass2', type: 'password', autocomplete: 'new-password', 'data-testid': 'reset-pass2' });
    const form = el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      let ok = true;
      if (!/^\d{4}$/.test(code.value.trim())) { setError(code, 'Enter the 4-digit code'); ok = false; }
      if (pw.value.length < 8) { setError(pw, 'Use at least 8 characters'); ok = false; }
      else if (pw.value !== pw2.value) { setError(pw2, 'The passwords do not match'); ok = false; }
      if (!ok) return;
      try { localStorage.setItem('mdm:pw:' + r.user, pw.value); } catch (err) { /* storage blocked */ }
      MDM.store.audit('password_reset', 'Password reset for ' + r.name, 'system');
      state.reset = null; render();
      MDM.ui.toast('Password changed. Sign in with your new password.', 'ok');
    } } },
      field('reset-code', 'Code', code, DEMO_CODE), field('reset-pass', 'New password', pw, 'At least 8 characters'), field('reset-pass2', 'Repeat new password', pw2),
      actions(submit('Change password'), back));
    return { form, title: 'Reset your password', desc: 'Code sent to ' + MDM.ui.phone.format(r.phone) + '.' };
  }

  async function main() {
    await MDM.store.ready;
    view = document.getElementById('view');
    [drivers, staff, accounts, settings] = await Promise.all([MDM.store.list('drivers', { order: 'createdAt' }), MDM.store.list('staff', { order: 'createdAt' }), MDM.store.list('business_accounts'), MDM.store.settings()]);
    render();
  }
  main();
})(window.MDM);

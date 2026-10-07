// Sign in for every role (client requirements §2, §21): customers and businesses by mobile number and a one-time code, drivers and
// staff by name and PIN, the office (admin, operators, office staff) by username and password, with a password reset.
// The mockup has no server, so codes and PINs accept any 4 digits. The sessions it writes are the ones every other page reads:
// customers → localStorage mdm:me, businesses → localStorage mdm:business, drivers → sessionStorage mdm:driver,
// staff → localStorage mdm:staff, office → localStorage mdm:session { user, staffId, role, name }.
(function (MDM) { 'use strict';
  const { el } = MDM.ui;
  const ROLES = [
    { value: 'customer', label: 'Customer', hint: 'Order and track', icon: 'user' },
    { value: 'business', label: 'Business', hint: 'Bulk orders, invoices', icon: 'building' },
    { value: 'driver', label: 'Driver', hint: 'Today’s jobs', icon: 'bike' },
    { value: 'staff', label: 'Staff', hint: 'Attendance and leave', icon: 'clock' },
    { value: 'admin', label: 'Office', hint: 'Admin and operators', icon: 'dashboard' },
  ];
  const params = new URLSearchParams(location.search);
  const asParam = params.get('as') === 'rider' ? 'driver' : params.get('as');
  const state = { role: ROLES.some(r => r.value === asParam) ? asParam : 'customer', phone: params.get('phone') || '', step: 1, next: params.get('next') || '', reset: null };
  if (state.role === 'admin' && params.get('reset') === '1') state.reset = { step: 1, user: '' };
  let view, drivers = [], staff = [], accounts = [];
  const DEMO_PASSWORD = 'delivery';

  function field(id, label, control, hint) {
    return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('div', { class: 'field__hint' }, hint) : null, el('div', { class: 'field__error' }));
  }
  function setError(input, msg) { MDM.ui.setError(input.closest('.field'), msg); }
  function go(path) { location.href = state.next && /^[a-z]+\/?(\?.*)?$/i.test(state.next) ? MDM.href(state.next) : MDM.href(path); }
  function save(store, key, value) { try { store.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ } }
  function passwordFor(username) { try { return localStorage.getItem('mdm:pw:' + username) || DEMO_PASSWORD; } catch (e) { return DEMO_PASSWORD; } }
  const actions = (...kids) => el('div', { class: 'login-actions' }, kids);
  const submit = (label) => el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'login-submit' }, label);
  const demo = (text) => el('div', { class: 'alert alert--info' }, el('div', {}, text));

  function render() {
    view.textContent = '';
    view.appendChild(el('div', { class: 'page-head' }, el('h1', {}, 'Sign in'), el('p', { class: 'page-head__desc' }, 'Choose who you are. Customers and businesses sign in with their mobile number; the team has its own sign-in.')));
    const roles = el('fieldset', { class: 'login-roles', 'data-testid': 'login-role' }, el('legend', { class: 'sr-only' }, 'Sign in as'),
      ROLES.map(r => el('label', { class: 'login-role', 'data-testid': 'login-role-' + r.value },
        el('input', { class: 'sr-only', type: 'radio', name: 'role', value: r.value, checked: state.role === r.value, on: { change: () => { state.role = r.value; state.step = 1; state.reset = null; render(); } } }),
        el('span', { class: 'login-role__icon', 'aria-hidden': 'true' }, MDM.ui.html(MDM.icon(r.icon, 18))),
        el('span', { class: 'login-role__label' }, r.label), el('span', { class: 'login-role__hint' }, r.hint))));
    view.appendChild(roles);
    const forms = { customer: () => phoneForm('customer'), business: () => phoneForm('business'), driver: driverForm, staff: staffForm, admin: state.reset ? resetForm : officeForm };
    view.appendChild(forms[state.role]());
  }

  // Customers and businesses: mobile number → one-time code.
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
        save(localStorage, 'mdm:me', { name: found ? found.name : '', phone, email: found ? found.email : '', notify: found ? found.notify : 'whatsapp', signedInAt: new Date().toISOString() });
        go('account/');
      } } },
        demo('We sent a code to ' + MDM.ui.phone.format(state.phone) + '. In this demo any 4 digits work.'),
        field('code', 'Code', code),
        actions(submit('Sign in'), el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => { state.step = 1; render(); } } }, 'Use another number')));
      setTimeout(() => code.focus(), 0);
      return form;
    }
    const phone = el('input', { class: 'input', id: 'phone', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '7XX XXXX', value: state.phone, 'data-testid': 'login-phone' });
    const notMember = el('div', { class: 'alert alert--warn', hidden: true }, el('div', {}, 'This number is not linked to a business account yet. ', el('a', { href: MDM.href('business/#apply') }, 'Apply for an account')));
    const form = el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      notMember.hidden = true;
      if (!MDM.ui.phone.valid(phone.value)) { setError(phone, 'Enter a 7-digit Maldives mobile number'); phone.focus(); return; }
      if (kind === 'business' && !accounts.some(a => MDM.ui.phone.normalize(a.phone) === MDM.ui.phone.normalize(phone.value) && a.status === 'approved')) { notMember.hidden = false; return; }
      state.phone = phone.value; state.step = 2; render();
    } } },
      kind === 'business' ? demo('Demo accounts: Kandu Books 780 1122, Fonu Online Store 763 3221') : null,
      field('phone', kind === 'business' ? 'Account mobile number' : 'Mobile number', phone, 'We send a one-time code to this number. No password needed.'),
      notMember,
      actions(el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'login-continue' }, 'Send code'),
        kind === 'business' ? el('a', { class: 'btn btn--ghost', href: MDM.href('business/#apply') }, 'Open a business account') : el('a', { class: 'btn btn--ghost', href: MDM.href('request/') }, 'New here? Request a delivery')));
    if (state.phone && kind === 'customer') setTimeout(() => { if (MDM.ui.phone.valid(state.phone)) form.requestSubmit(); }, 0);
    return form;
  }

  // Drivers and staff: pick your name, enter your PIN.
  function pinForm(id, label, people, onOk, cta, hint) {
    const sel = el('select', { class: 'select', id, 'data-testid': 'login-' + id }, el('option', { value: '' }, 'Choose your name'), people.map(p => el('option', { value: p.id }, p.name + (p.title ? ' · ' + p.title : ''))));
    const pin = el('input', { class: 'input', id: id + '-pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', maxlength: '4', placeholder: '4 digits', 'data-testid': 'login-pin' });
    return el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      let ok = true;
      if (!sel.value) { setError(sel, 'Choose your name'); ok = false; }
      if (!/^\d{4}$/.test(pin.value)) { setError(pin, 'Enter your 4-digit PIN'); ok = false; }
      if (ok) onOk(sel.value);
    } } },
      field(id, label, sel, hint), field(id + '-pin', 'PIN', pin, 'In this demo any 4 digits work.'), actions(submit(cta)));
  }
  function driverForm() {
    return pinForm('driver', 'Driver', drivers, driverId => { save(sessionStorage, 'mdm:driver', { driverId, online: false }); go('driver/'); }, 'Open my jobs', 'Punch in from the jobs screen when your shift starts.');
  }
  function staffForm() {
    return pinForm('staff', 'Employee', staff.filter(s => s.status !== 'inactive'), staffId => {
      const s = staff.find(x => x.id === staffId);
      save(localStorage, 'mdm:staff', { staffId, name: s.name, role: s.role, at: new Date().toISOString() });
      go('staff/');
    }, 'Open staff portal', 'Punch in and out, see your hours and request leave.');
  }

  // Office: username + password, role from the staff record (admin, operator, office).
  function officeForm() {
    const user = el('input', { class: 'input', id: 'user', type: 'text', autocomplete: 'username', autocapitalize: 'off', 'data-testid': 'login-user' });
    const pass = el('input', { class: 'input', id: 'pass', type: 'password', autocomplete: 'current-password', 'data-testid': 'login-pass' });
    const err = el('div', { class: 'alert alert--danger', hidden: true }, el('div', {}, 'Wrong username or password'));
    return el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      const u = user.value.trim().toLowerCase();
      const s = staff.find(x => x.username === u && ['admin', 'operator', 'office'].indexOf(x.role) >= 0);
      if (s && pass.value === passwordFor(u)) {
        save(localStorage, 'mdm:session', { user: u, staffId: s.id, role: s.role, name: s.name, at: new Date().toISOString() });
        MDM.store.audit('signed_in', s.name + ' signed in to the office portal', s.role === 'admin' ? 'admin' : 'operator:' + s.id);
        go('admin/');
      } else { err.hidden = false; pass.value = ''; pass.focus(); }
    } } },
      demo('Demo sign-ins (password delivery): admin for full access, operator for dispatch, lamya for customer care and payments.'),
      field('user', 'Username', user),
      field('pass', 'Password', pass),
      err,
      actions(submit('Sign in'), el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'login-forgot', on: { click: () => { state.reset = { step: 1, user: user.value.trim() }; render(); } } }, 'Forgot password?')));
  }
  // Password reset: username → code sent to the phone on file → new password (requirements §21).
  function resetForm() {
    const r = state.reset;
    const back = el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => { state.reset = null; render(); } } }, 'Back to sign in');
    if (r.step === 1) {
      const user = el('input', { class: 'input', id: 'reset-user', type: 'text', autocapitalize: 'off', value: r.user || '', 'data-testid': 'reset-user' });
      return el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
        e.preventDefault();
        const s = staff.find(x => x.username === user.value.trim().toLowerCase() && ['admin', 'operator', 'office'].indexOf(x.role) >= 0);
        if (!s) { setError(user, 'No office account with that username'); return; }
        state.reset = { step: 2, user: s.username, phone: s.phone, name: s.name }; render();
      } } },
        el('h2', { class: 'login-sub' }, 'Reset your password'), field('reset-user', 'Username', user, 'We send a reset code to the mobile number on your staff record.'), actions(submit('Send reset code'), back));
    }
    const code = el('input', { class: 'input', id: 'reset-code', type: 'text', inputmode: 'numeric', maxlength: '4', placeholder: '4 digits', 'data-testid': 'reset-code' });
    const pw = el('input', { class: 'input', id: 'reset-pass', type: 'password', autocomplete: 'new-password', 'data-testid': 'reset-pass' });
    const pw2 = el('input', { class: 'input', id: 'reset-pass2', type: 'password', autocomplete: 'new-password', 'data-testid': 'reset-pass2' });
    return el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
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
      el('h2', { class: 'login-sub' }, 'Reset your password'),
      demo('We sent a code to ' + MDM.ui.phone.format(r.phone) + '. In this demo any 4 digits work.'),
      field('reset-code', 'Code', code), field('reset-pass', 'New password', pw, 'At least 8 characters.'), field('reset-pass2', 'Repeat new password', pw2),
      actions(submit('Change password'), back));
  }

  async function main() {
    await MDM.store.ready;
    view = document.getElementById('view');
    [drivers, staff, accounts] = await Promise.all([MDM.store.list('drivers', { order: 'createdAt' }), MDM.store.list('staff', { order: 'createdAt' }), MDM.store.list('business_accounts')]);
    render();
  }
  main();
})(window.MDM);

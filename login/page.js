// Sign in: customers by mobile number (one-time code), riders by name and PIN, admin by username and password.
// The mockup has no server, so the code and PIN accept any 4 digits; the sessions it writes are the ones every other page reads:
// customers → localStorage mdm:me, riders → sessionStorage mdm:driver, admin → localStorage mdm:session.
(function (MDM) { 'use strict';
  const { el, esc } = MDM.ui;
  const ROLES = [{ value: 'customer', label: 'Customer' }, { value: 'rider', label: 'Rider' }, { value: 'admin', label: 'Admin' }];
  const params = new URLSearchParams(location.search);
  const state = { role: ROLES.some(r => r.value === params.get('as')) ? params.get('as') : 'customer', phone: params.get('phone') || '', step: 1, next: params.get('next') || '' };
  let view, drivers = [];

  function field(id, label, control, hint) {
    return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('div', { class: 'field__hint' }, hint) : null, el('div', { class: 'field__error' }));
  }
  function setError(input, msg) { MDM.ui.setError(input.closest('.field'), msg); }
  function go(path) { location.href = state.next && /^[a-z]+\/?(\?.*)?$/i.test(state.next) ? MDM.href(state.next) : MDM.href(path); }

  function render() {
    view.textContent = '';
    view.appendChild(el('div', { class: 'page-head' }, el('h1', {}, 'Sign in'), el('p', { class: 'page-head__desc' }, 'Customers sign in with the mobile number they order with. Riders and the office have their own sign-in.')));
    const seg = el('fieldset', { class: 'segmented', 'data-testid': 'login-role' }, el('legend', { class: 'sr-only' }, 'Sign in as'),
      ROLES.map(r => el('label', { class: 'segmented__option', 'data-testid': 'login-role-' + r.value },
        el('input', { class: 'sr-only', type: 'radio', name: 'role', value: r.value, checked: state.role === r.value, on: { change: () => { state.role = r.value; state.step = 1; render(); } } }),
        el('span', {}, r.label))));
    view.appendChild(seg);
    view.appendChild(state.role === 'customer' ? customerForm() : state.role === 'rider' ? riderForm() : adminForm());
  }

  function customerForm() {
    if (state.step === 2) {
      const code = el('input', { class: 'input', id: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '4', placeholder: '4 digits', 'data-testid': 'login-code' });
      const form = el('form', { class: 'login-form', novalidate: true, on: { submit: async e => {
        e.preventDefault();
        if (!/^\d{4}$/.test(code.value.trim())) { setError(code, 'Enter the 4-digit code'); code.focus(); return; }
        const phone = MDM.ui.phone.normalize(state.phone);
        const found = (await MDM.store.list('customers', { where: { phone } }))[0] || null;
        const me = { name: found ? found.name : '', phone, email: found ? found.email : '', notify: found ? found.notify : 'whatsapp', signedInAt: new Date().toISOString() };
        try { localStorage.setItem('mdm:me', JSON.stringify(me)); } catch (err) { /* storage blocked */ }
        go('account/');
      } } },
        el('div', { class: 'alert alert--info' }, el('div', {}, 'We sent a code to ' + MDM.ui.phone.format(state.phone) + '. In this demo any 4 digits work.')),
        el('div', { class: 'login-note' }),
        field('code', 'Code', code),
        el('div', { class: 'login-actions' }, el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'login-submit' }, 'Sign in'), el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => { state.step = 1; render(); } } }, 'Use another number')));
      setTimeout(() => code.focus(), 0);
      return form;
    }
    const phone = el('input', { class: 'input', id: 'phone', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '7XX XXXX', value: state.phone, 'data-testid': 'login-phone' });
    const form = el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      if (!MDM.ui.phone.valid(phone.value)) { setError(phone, 'Enter a 7-digit Maldives mobile number'); phone.focus(); return; }
      state.phone = phone.value; state.step = 2; render();
    } } },
      field('phone', 'Mobile number', phone, 'We send a one-time code to this number. No password needed.'),
      el('div', { class: 'login-actions' }, el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'login-continue' }, 'Send code'), el('a', { class: 'btn btn--ghost', href: MDM.href('request/') }, 'New here? Request a delivery')));
    if (state.phone) setTimeout(() => { if (MDM.ui.phone.valid(state.phone)) form.requestSubmit(); }, 0);
    return form;
  }

  function riderForm() {
    const sel = el('select', { class: 'select', id: 'rider', 'data-testid': 'login-rider' }, el('option', { value: '' }, 'Choose your name'), drivers.map(d => el('option', { value: d.id }, d.name)));
    const pin = el('input', { class: 'input', id: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', maxlength: '4', placeholder: '4 digits', 'data-testid': 'login-pin' });
    return el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      let ok = true;
      if (!sel.value) { setError(sel, 'Choose your name'); ok = false; }
      if (!/^\d{4}$/.test(pin.value)) { setError(pin, 'Enter your 4-digit PIN'); ok = false; }
      if (!ok) return;
      try { sessionStorage.setItem('mdm:driver', JSON.stringify({ driverId: sel.value, online: false })); } catch (err) { /* storage blocked */ }
      go('driver/');
    } } },
      field('rider', 'Rider', sel),
      field('pin', 'PIN', pin, 'In this demo any 4 digits work.'),
      el('div', { class: 'login-actions' }, el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'login-submit' }, 'Open my route')));
  }

  function adminForm() {
    const user = el('input', { class: 'input', id: 'user', type: 'text', autocomplete: 'username', autocapitalize: 'off', 'data-testid': 'login-user' });
    const pass = el('input', { class: 'input', id: 'pass', type: 'password', autocomplete: 'current-password', 'data-testid': 'login-pass' });
    const err = el('div', { class: 'alert alert--danger', hidden: true }, el('div', {}, 'Wrong username or password'));
    return el('form', { class: 'login-form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      if (user.value.trim() === 'admin' && pass.value === 'delivery') {
        try { localStorage.setItem('mdm:session', JSON.stringify({ user: 'admin', at: new Date().toISOString() })); } catch (err2) { /* storage blocked */ }
        go('admin/');
      } else { err.hidden = false; pass.value = ''; pass.focus(); }
    } } },
      el('div', { class: 'alert alert--info' }, el('div', {}, 'Demo sign-in: admin / delivery')),
      el('div', { class: 'login-note' }),
      field('user', 'Username', user),
      field('pass', 'Password', pass),
      err,
      el('div', { class: 'login-actions' }, el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'login-submit' }, 'Sign in')));
  }

  async function main() {
    await MDM.store.ready;
    view = document.getElementById('view');
    drivers = await MDM.store.list('drivers', { order: 'createdAt' });
    render();
  }
  main();
})(window.MDM);

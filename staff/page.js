// Staff portal (How it works §10 attendance, §11 leave; client requirements §22): every employee, drivers included, punches in and
// out here, sees their own attendance and requests leave. The office sees the same records under Admin → Team & HR.
// Session: localStorage mdm:staff = { staffId, name, role, at }. Sign-in is the employee's name and a 4-digit PIN (any PIN in the demo).
(function (MDM) { 'use strict';
  const { el, html, setError } = MDM.ui;
  const SESSION = 'mdm:staff';
  const ROLE = { admin: 'Admin', operator: 'Operator', office: 'Office staff', driver: 'Driver' };
  const app = document.querySelector('[data-slot="app"]');
  const state = { me: null, settings: {}, tick: null };
  const pad = n => String(n).padStart(2, '0');
  const hhmm = iso => MDM.ui.fmtTime(iso);
  const mins = (a, b) => Math.max(0, Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 60000));
  const dur = m => Math.floor(m / 60) + ' h ' + pad(m % 60) + ' min';
  const short = m => (m / 60).toFixed(1).replace(/\.0$/, '') + ' h';

  function readSession() { try { const v = JSON.parse(localStorage.getItem(SESSION) || 'null'); return v && v.staffId ? v : null; } catch (e) { return null; } }
  function writeSession(st) { try { localStorage.setItem(SESSION, JSON.stringify({ staffId: st.id, name: st.name, role: st.role, at: new Date().toISOString() })); } catch (e) { /* storage blocked */ } }
  function clearSession() { try { localStorage.removeItem(SESSION); } catch (e) { /* nothing stored */ } }

  // ---- Sign in ---------------------------------------------------------------------------------------------------------------
  async function renderSignin() {
    const staff = (await MDM.store.list('staff', { order: 'name' })).filter(s => s.status !== 'inactive');
    const who = el('select', { class: 'select', 'data-testid': 'staff-who' }, el('option', { value: '' }, 'Choose your name'),
      ['admin', 'operator', 'office', 'driver'].map(r => { const g = staff.filter(s => s.role === r); return g.length ? el('optgroup', { label: ROLE[r] + (r === 'driver' ? 's' : '') }, g.map(s => el('option', { value: s.id }, s.name))) : null; }));
    const pin = el('input', { class: 'input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '4', placeholder: '4 digits', 'data-testid': 'staff-pin' });
    const form = el('form', { class: 'form', novalidate: true, on: { submit: e => {
      e.preventDefault();
      const r = MDM.ui.validate(form, { who: v => v ? null : 'Choose your name', pin: v => /^\d{4}$/.test(v || '') ? null : 'Enter your 4-digit PIN' });
      if (!r.ok) { MDM.ui.focusFirstInvalid(form); return; }
      const st = staff.find(s => s.id === r.values.who);
      writeSession(st); render();
    } } },
      MDM.ui.field({ name: 'who', label: 'Your name', control: Object.assign(who, { name: 'who' }) }),
      MDM.ui.field({ name: 'pin', label: 'PIN', control: Object.assign(pin, { name: 'pin' }), hint: 'The PIN the office gave you. In this demo any 4 digits work.' }),
      el('div', { class: 'form-actions' }, el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'staff-signin' }, 'Sign in')));
    app.replaceChildren(el('div', { class: 'container container--narrow' },
      el('div', { class: 'page-head' }, el('h1', null, 'Staff portal'), el('p', { class: 'page-head__desc' }, 'Punch in and out, check your hours and request leave. For everyone on the Mr. Delivery Man team, drivers included.')),
      el('div', { class: 'card staff-signin' }, el('div', { class: 'card__body' }, form))));
  }

  // ---- Portal ----------------------------------------------------------------------------------------------------------------
  async function load(staffId) {
    const [me, att, leaves, settings] = await Promise.all([MDM.store.get('staff', staffId), MDM.store.list('attendance', { where: { staffId }, order: '-inAt' }), MDM.store.list('leaves', { where: { staffId } }), MDM.store.settings()]);
    return { me, att, leaves, settings };
  }
  // An employee's own shift (staff.shiftStart / shiftEnd) wins over the company shift in settings.hr.
  const shiftOf = (me, hr) => ({ start: (me && me.shiftStart) || hr.shiftStart || '08:00', end: (me && me.shiftEnd) || hr.shiftEnd || '17:00' });
  function shiftStatus(open, hr) {
    if (!open) return null;
    const start = MDM.ui.parseHHMM(shiftOf(state.me, hr).start), grace = Number(hr.graceMinutes) || 0;
    const end = MDM.ui.parseHHMM(shiftOf(state.me, hr).end);
    const d = new Date(open.inAt), m = d.getHours() * 60 + d.getMinutes();
    if (m < start - 120 || m >= end) return 'Outside shift hours';
    return m > start + grace ? 'Late by ' + (m - start) + ' min' : 'On time';
  }
  function leaveToday(leaves) { const t = MDM.ui.dayKey(); return leaves.find(l => l.status === 'approved' && l.from <= t && l.to >= t) || null; }
  // Late = punched in after the shift start plus the grace minutes, but still inside the shift (a night call-out is not late).
  function lateOf(a, hr) { const sh = shiftOf(state.me, hr), start = MDM.ui.parseHHMM(sh.start), end = MDM.ui.parseHHMM(sh.end), grace = Number(hr.graceMinutes) || 0; const d = new Date(a.inAt), m = d.getHours() * 60 + d.getMinutes(); return m > start + grace && m < end; }

  function punchCard(d) {
    const hr = d.settings.hr || {};
    const open = d.att.find(a => !a.outAt) || null;
    const clock = el('div', { class: 'staff-clock mono', 'aria-hidden': 'true' });
    const since = el('div', { class: 'staff-since', role: 'status' });
    const btn = el('button', { type: 'button', class: 'btn btn--xl ' + (open ? 'btn--secondary' : 'btn--brand') + ' staff-punch', 'data-testid': 'staff-punch' }, html(MDM.icon('clock', 18)), open ? 'Punch out' : 'Punch in');
    const draw = () => {
      const n = new Date();
      clock.textContent = pad(n.getHours()) + ':' + pad(n.getMinutes()) + ':' + pad(n.getSeconds());
      since.textContent = open ? 'On duty since ' + hhmm(open.inAt) + ' · ' + dur(mins(open.inAt)) : 'Off duty';
    };
    draw();
    clearInterval(state.tick); state.tick = setInterval(() => { if (document.contains(clock)) draw(); else clearInterval(state.tick); }, 1000);
    btn.addEventListener('click', async () => {
      MDM.ui.setLoading(btn, true);
      try {
        if (open) { await MDM.store.punchOut(d.me.id, { source: 'portal' }); MDM.ui.toast('Punched out at ' + hhmm(new Date().toISOString()) + '. Shift ' + dur(mins(open.inAt)), 'ok'); }
        else { await MDM.store.punchIn(d.me.id, { source: 'portal' }); MDM.ui.toast('Punched in at ' + hhmm(new Date().toISOString()), 'ok'); }
        await renderPortal();
      } catch (err) { MDM.ui.toast((err && err.message) || 'Could not save the punch', 'danger'); MDM.ui.setLoading(btn, false); }
    });
    const lv = leaveToday(d.leaves);
    const today = MDM.ui.fmtDate(new Date(), { dateOnly: true, year: false });
    return el('div', { class: 'card staff-punchcard', 'data-testid': 'staff-punchcard' },
      el('div', { class: 'card__body staff-punchcard__body' },
        el('div', { class: 'staff-punchcard__time' },
          el('div', { class: 'small muted' }, new Date().toLocaleDateString('en-GB', { weekday: 'long' }) + ', ' + today),
          clock, since,
          el('div', { class: 'small muted' }, 'Shift ' + shiftOf(d.me, hr).start + ' to ' + shiftOf(d.me, hr).end + (open ? ' · ' + shiftStatus(open, hr) : ''))),
        el('div', { class: 'staff-punchcard__action' }, btn,
          el('div', { class: 'small muted' }, open ? 'Remember to punch out before you leave.' : 'Punch in when you start your shift.'))),
      lv ? el('div', { class: 'card__body' }, MDM.ui.notice('info', 'You are on approved ' + (MDM.LEAVE_TYPES.find(t => t.value === lv.type) || { label: 'leave' }).label.toLowerCase() + ' until ' + MDM.ui.fmtDate(lv.to, { dateOnly: true }) + '.')) : null);
  }
  function kpis(d) {
    const hr = d.settings.hr || {};
    const now = new Date(), weekAgo = new Date(now - 7 * 86400000), twoWeeks = new Date(now - 14 * 86400000);
    const week = d.att.filter(a => new Date(a.inAt) >= weekAgo).reduce((n, a) => n + mins(a.inAt, a.outAt), 0);
    const recent = d.att.filter(a => new Date(a.inAt) >= twoWeeks);
    const days = new Set(recent.map(a => a.date)).size;
    const late = recent.filter(a => lateOf(a, hr)).length;
    const bal = d.me.leaveBalance || {};
    const used = t => d.leaves.filter(l => l.status === 'approved' && l.type === t).reduce((n, l) => n + (l.days || 0), 0);
    const k = (label, value, note) => el('div', { class: 'kpi' }, el('div', { class: 'kpi__label' }, label), el('div', { class: 'kpi__value' }, value), note ? el('div', { class: 'kpi__note' }, note) : null);
    return el('div', { class: 'kpi-row', 'data-testid': 'staff-kpis' },
      k('Hours, last 7 days', short(week)), k('Days worked', String(days), 'Last 14 days'), k('Late arrivals', String(late), 'After ' + shiftOf(d.me, hr).start + ' + ' + (hr.graceMinutes || 0) + ' min'),
      k('Annual leave left', String(bal.annual != null ? bal.annual : (hr.annualLeaveDays || 30) - used('annual')), 'days'), k('Sick leave left', String(bal.sick != null ? bal.sick : (hr.sickLeaveDays || 30) - used('sick')), 'days'));
  }
  function attendanceTable(d) {
    const hr = d.settings.hr || {};
    const rows = d.att.filter(a => new Date(a.inAt) >= new Date(Date.now() - 14 * 86400000));
    if (!rows.length) return el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'No punches in the last 14 days'));
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table table--compact staff-att', 'data-testid': 'staff-attendance' },
      el('thead', null, el('tr', null, ['Date', 'In', 'Out', 'Hours'].map((h, i) => el('th', { class: i === 3 ? 'num' : null }, h)))),
      el('tbody', null, rows.map(a => {
        const today = a.date === MDM.ui.dayKey();
        const note = !a.outAt ? (today ? MDM.ui.badge('info', 'On duty') : MDM.ui.badge('warn', 'No punch-out')) : (lateOf(a, hr) ? MDM.ui.badge('warn', 'Late') : '');
        return el('tr', null,
          el('td', null, el('div', { class: 'nowrap' }, new Date(a.inAt).toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + MDM.ui.fmtDate(a.inAt, { dateOnly: true })), note ? el('div', { class: 'staff-att__note' }, html(note)) : null),
          el('td', { class: 'mono' }, hhmm(a.inAt)),
          el('td', { class: 'mono' }, a.outAt ? hhmm(a.outAt) : '·'),
          el('td', { class: 'num mono nowrap' }, a.outAt || today ? short(mins(a.inAt, a.outAt)) : '·'));
      }))));
  }
  function leaveForm(d) {
    const today = MDM.ui.dayKey();
    const type = el('select', { class: 'select', name: 'type', 'data-testid': 'staff-leave-type' }, MDM.LEAVE_TYPES.map(t => el('option', { value: t.value }, t.label)));
    const from = el('input', { class: 'input', type: 'date', name: 'from', min: today, 'data-testid': 'staff-leave-from' });
    const to = el('input', { class: 'input', type: 'date', name: 'to', min: today, 'data-testid': 'staff-leave-to' });
    const reason = el('textarea', { class: 'textarea', name: 'reason', rows: 2, placeholder: 'Family trip to the island', 'data-testid': 'staff-leave-reason' });
    const days = el('div', { class: 'small muted', role: 'status' });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'staff-leave-submit' }, 'Request leave');
    const count = () => { if (from.value && to.value && to.value >= from.value) { const n = Math.round((new Date(to.value) - new Date(from.value)) / 86400000) + 1; days.textContent = MDM.ui.plural(n, 'day'); } else days.textContent = ''; };
    from.addEventListener('change', () => { if (!to.value || to.value < from.value) to.value = from.value; to.min = from.value; count(); });
    to.addEventListener('change', count);
    const form = el('form', { class: 'form', novalidate: true, 'data-testid': 'staff-leave-form' },
      MDM.ui.field({ name: 'type', label: 'Type', control: type }),
      el('div', { class: 'grid-2 grid-2--keep' }, MDM.ui.field({ name: 'from', label: 'From', control: from }), MDM.ui.field({ name: 'to', label: 'To', control: to })),
      MDM.ui.field({ name: 'reason', label: 'Reason', control: reason, optional: true }),
      el('div', { class: 'form-actions' }, days, submit));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const r = MDM.ui.validate(form, { from: v => v ? null : 'Choose the first day', to: (v, vals) => !v ? 'Choose the last day' : (v < vals.from ? 'The last day is before the first' : null) });
      if (!r.ok) { MDM.ui.focusFirstInvalid(form); return; }
      MDM.ui.setLoading(submit, true);
      try {
        await MDM.store.requestLeave({ staffId: d.me.id, type: type.value, from: from.value, to: to.value, reason: reason.value.trim() });
        MDM.ui.toast('Leave request sent to the office', 'ok');
        await renderPortal();
      } catch (err) { setError(to, (err && err.message) || 'Could not send the request'); MDM.ui.setLoading(submit, false); }
    });
    return form;
  }
  function leaveList(d) {
    const ls = d.leaves.slice().sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
    if (!ls.length) return el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'No leave requests yet'));
    const badge = { pending: ['warn', 'Waiting'], approved: ['ok', 'Approved'], rejected: ['danger', 'Declined'] };
    return el('div', { class: 'list', 'data-testid': 'staff-leaves' }, ls.map(l => el('div', { class: 'list__item staff-leave' },
      el('div', { class: 'list__main' },
        el('div', { class: 'list__title' }, (MDM.LEAVE_TYPES.find(t => t.value === l.type) || { label: l.type }).label + ' · ' + MDM.ui.plural(l.days || 1, 'day')),
        el('div', { class: 'list__meta' }, MDM.ui.fmtDate(l.from, { dateOnly: true }) + (l.to !== l.from ? ' to ' + MDM.ui.fmtDate(l.to, { dateOnly: true }) : '') + (l.reason ? ' · ' + l.reason : '')),
        l.remarks ? el('div', { class: 'list__meta' }, 'Office: ' + l.remarks) : null),
      el('div', { class: 'list__aside' }, html(MDM.ui.badge((badge[l.status] || ['neutral'])[0], (badge[l.status] || [0, l.status])[1]))))));
  }
  async function renderPortal() {
    const s = readSession();
    const d = await load(s.staffId);
    if (!d.me) { clearSession(); return renderSignin(); }
    state.me = d.me;
    document.title = 'Staff portal · ' + d.me.name + ' · Mr. Delivery Man';
    app.replaceChildren(el('div', { class: 'container' },
      el('div', { class: 'page-head' },
        el('h1', null, 'Hello, ' + d.me.name.split(' ')[0]),
        el('p', { class: 'page-head__desc' }, [d.me.title, d.me.title && d.me.title.toLowerCase().indexOf(String(ROLE[d.me.role]).toLowerCase()) >= 0 ? null : ROLE[d.me.role]].filter(Boolean).join(' · ') + (d.me.joinedAt ? ' · with us since ' + MDM.ui.fmtDate(d.me.joinedAt, { dateOnly: true, year: true }) : '')),
        el('div', { class: 'page-head__actions' },
          d.me.role === 'driver' ? el('a', { class: 'btn btn--secondary', href: MDM.href('driver/') }, html(MDM.icon('bike', 16)), 'Driver app') : null,
          ['admin', 'operator', 'office'].indexOf(d.me.role) >= 0 ? el('a', { class: 'btn btn--secondary', href: MDM.href('login/?as=admin') }, 'Office portal') : null,
          el('button', { type: 'button', class: 'btn btn--ghost', 'data-testid': 'staff-signout', on: { click: () => { clearSession(); clearInterval(state.tick); render(); } } }, 'Sign out'))),
      el('div', { class: 'stack-6 staff-main' },
        punchCard(d), kpis(d),
        el('div', { class: 'staff-grid' },
          el('section', { class: 'card', 'aria-labelledby': 'staff-att' }, el('div', { class: 'card__header' }, el('h2', { id: 'staff-att' }, 'My attendance'), el('span', { class: 'small muted' }, 'Last 14 days')), attendanceTable(d)),
          el('div', { class: 'stack-6' },
            el('section', { class: 'card', 'aria-labelledby': 'staff-leave-h' }, el('div', { class: 'card__header' }, el('h2', { id: 'staff-leave-h' }, 'Request leave')), el('div', { class: 'card__body' }, leaveForm(d))),
            el('section', { class: 'card', 'aria-labelledby': 'staff-leaves-h' }, el('div', { class: 'card__header' }, el('h2', { id: 'staff-leaves-h' }, 'My leave requests')), leaveList(d)))))));
  }
  async function render() { state.settings = await MDM.store.settings(); if (readSession()) await renderPortal(); else await renderSignin(); }
  const refresh = MDM.ui.debounce(() => { if (readSession() && !app.querySelector('[data-testid="staff-leave-form"] :focus')) renderPortal(); }, 200);
  async function main() {
    await MDM.store.ready;
    await render();
    ['attendance', 'leaves', 'staff'].forEach(c => MDM.store.subscribe(c, refresh));
    MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') render(); });
    window.addEventListener('storage', e => { if (e.key === SESSION) render(); });
  }
  main();
})(window.MDM);

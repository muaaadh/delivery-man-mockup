module.paths.push('/Users/muadhhashim/.npm/_npx/6bcb61ec6d5aea22/node_modules');
const { chromium } = require('playwright');
const assert = require('assert');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:4180/mr-delivery-man-mockup/tools/_scratch/ui-test.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.MDM && MDM.ui);
  const results = [];
  const check = (name, ok, extra) => { results.push((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' ' + JSON.stringify(extra) : '')); };

  // el / esc / html
  const elRes = await page.evaluate(() => {
    const u = MDM.ui;
    const n = u.el('div', { class: ['a', null, 'b'], id: 'x', dataset: { orderId: 'o1' }, 'aria-label': 'L', hidden: false, disabled: true }, '<b>text</b>', ['x', u.el('span', null, 'y')], null);
    const sel = u.el('select', { value: 'b' }, u.el('option', { value: 'a' }, 'A'), u.el('option', { value: 'b' }, 'B'));
    const ta = u.el('textarea', { value: 'hello' });
    const frag = u.html('<i>a</i><em>b</em>');
    return { outer: n.outerHTML, sel: sel.value, ta: ta.value, frag: frag.childNodes.length, esc: u.esc('<a href="x">&\'</a>') };
  });
  check('el builds attrs/dataset/text-only children', elRes.outer === '<div class="a b" id="x" data-order-id="o1" aria-label="L" disabled="">&lt;b&gt;text&lt;/b&gt;x<span>y</span></div>', elRes);
  check('el value on select/textarea', elRes.sel === 'b' && elRes.ta === 'hello');
  check('html() fragment', elRes.frag === 2);
  check('esc', elRes.esc === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;', elRes.esc);

  // toasts
  const t = await page.evaluate(async () => {
    const u = MDM.ui;
    u.toast('one', 'ok'); u.toast('two', 'warn'); u.toast('three', 'danger'); u.toast('four', 'info');
    await new Promise(r => setTimeout(r, 50));
    const els = [...document.querySelectorAll('[data-testid="toast"]')];
    return { count: els.length, texts: els.map(e => e.textContent), kinds: els.map(e => e.dataset.kind), role: els[0].getAttribute('role'), icon: !!els[0].querySelector('svg.icon'), isIn: els.every(e => e.classList.contains('is-in')) };
  });
  check('toast stack max 3 (oldest dropped)', t.count === 3 && t.texts.join() === 'two,three,four' && t.role === 'status' && t.icon && t.isIn, t);
  await page.waitForTimeout(4400);
  const t2 = await page.evaluate(() => [...document.querySelectorAll('[data-testid="toast"]')].map(e => e.dataset.kind));
  check('toast 4s dismiss, danger stays (8s)', t2.join() === 'danger', t2);
  await page.waitForTimeout(4200);
  const t3 = await page.evaluate(() => document.querySelectorAll('[data-testid="toast"]').length);
  check('danger toast gone at 8s', t3 === 0, t3);
  const tAct = await page.evaluate(async () => {
    let clicked = false;
    MDM.ui.toast('undo?', 'neutral', { timeout: 0, action: { label: 'Undo', onClick: () => { clicked = true; } } });
    document.querySelector('.toast__action').click();
    await new Promise(r => setTimeout(r, 250));
    return { clicked, left: document.querySelectorAll('[data-testid="toast"]').length };
  });
  check('toast action click + dismiss', tAct.clicked && tAct.left === 0, tAct);

  // drawer
  await page.click('#opener');
  const d1 = await page.evaluate(() => {
    const u = MDM.ui;
    const body = u.el('div', null, u.el('input', { class: 'input', id: 'd-in1' }), u.el('a', { href: '#', id: 'd-link' }, 'link'));
    const footer = u.el('div', null, u.el('button', { type: 'button', class: 'btn btn--primary', id: 'd-btn' }, 'Assign rider'));
    window.closedReason = null;
    u.drawer.open({ title: 'MDM-1038', badge: MDM.ui.badge('info', 'In transit', { 'data-status': 'in_transit' }), body, footer, size: 'lg', onClose: r => { window.closedReason = r; } });
    const p = document.querySelector('[data-testid="drawer"]');
    return { open: u.drawer.isOpen(), cls: p.className, hidden: p.hidden, title: p.querySelector('.drawer__title').textContent, badge: p.querySelector('.badge').dataset.status, closeSr: p.querySelector('[data-testid="drawer-close"] .sr-only').textContent, active: document.activeElement.getAttribute('data-testid'), bodyOverflow: document.body.style.overflow, modal: p.getAttribute('aria-modal') };
  });
  await page.waitForTimeout(250);
  check('drawer open state', d1.open && /drawer--lg/.test(d1.cls) && /is-open/.test(d1.cls) && d1.title === 'MDM-1038' && d1.badge === 'in_transit' && d1.closeSr === 'Close' && d1.active === 'drawer' && d1.bodyOverflow === 'hidden' && d1.modal === 'true', d1);
  // focus trap: Tab from panel → close btn → input → link → footer btn → wraps to close btn
  const seq = [];
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); seq.push(await page.evaluate(() => document.activeElement.id || document.activeElement.getAttribute('data-testid'))); }
  check('drawer focus trap forward wrap', seq.join() === 'drawer-close,d-in1,d-link,d-btn,drawer-close', seq);
  await page.keyboard.press('Shift+Tab');
  const back = await page.evaluate(() => document.activeElement.id);
  check('drawer focus trap backward wrap', back === 'd-btn', back);
  // setBody / setFooter
  const sb = await page.evaluate(() => { MDM.ui.drawer.setBody('plain text'); MDM.ui.drawer.setFooter(null); const p = document.querySelector('[data-testid="drawer"]'); return { body: p.querySelector('.drawer__body').innerHTML, footerHidden: p.querySelector('.drawer__footer').hidden }; });
  check('drawer setBody text / setFooter null hides footer', sb.body === 'plain text' && sb.footerHidden, sb);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const d2 = await page.evaluate(() => ({ open: MDM.ui.drawer.isOpen(), reason: window.closedReason, active: document.activeElement.id, hidden: document.querySelector('[data-testid="drawer"]').hidden, overflow: document.body.style.overflow }));
  check('drawer Escape closes, onClose, focus restored to opener', !d2.open && d2.reason === 'escape' && d2.active === 'opener' && d2.hidden && d2.overflow === '', d2);
  await page.evaluate(() => MDM.ui.drawer.open({ title: 'x', body: 'y' }));
  await page.waitForTimeout(250);
  await page.mouse.click(20, 400);   // backdrop (drawer is on the right)
  await page.waitForTimeout(300);
  const d3 = await page.evaluate(() => MDM.ui.drawer.isOpen());
  check('drawer backdrop click closes', d3 === false);
  await page.evaluate(() => MDM.ui.drawer.open({ title: 'x', body: 'y' }));
  await page.waitForTimeout(250);
  await page.click('[data-testid="drawer-close"]');
  await page.waitForTimeout(300);
  check('drawer close button closes', (await page.evaluate(() => MDM.ui.drawer.isOpen())) === false);

  // confirm
  const cp = page.evaluate(() => MDM.ui.confirm({ title: 'Cancel order', message: 'Sure?', okLabel: 'Cancel order', danger: true }));
  await page.waitForSelector('dialog[open] [data-testid="confirm-ok"]');
  const cInfo = await page.evaluate(() => ({ ok: document.querySelector('[data-testid="confirm-ok"]').className, cancel: document.querySelector('[data-testid="confirm-cancel"]').className, active: document.activeElement.getAttribute('data-testid'), title: document.querySelector('dialog .dialog__title').textContent }));
  check('confirm markup (danger ok, cancel secondary, focus cancel when danger)', /btn--danger/.test(cInfo.ok) && /btn--secondary/.test(cInfo.cancel) && cInfo.active === 'confirm-cancel' && cInfo.title === 'Cancel order', cInfo);
  await page.click('[data-testid="confirm-ok"]');
  check('confirm resolves true on ok', (await cp) === true);
  check('confirm dialog removed', (await page.evaluate(() => document.querySelectorAll('dialog').length)) === 0);
  const cp2 = page.evaluate(() => MDM.ui.confirm({ title: 'T', message: 'M' }));
  await page.waitForSelector('dialog[open]');
  await page.click('[data-testid="confirm-cancel"]');
  check('confirm resolves false on cancel', (await cp2) === false);
  const cp3 = page.evaluate(() => MDM.ui.confirm({ title: 'T', message: 'M' }));
  await page.waitForSelector('dialog[open]');
  await page.keyboard.press('Escape');
  check('confirm resolves false on Escape', (await cp3) === false);

  // dialog with fields
  const fields = () => [
    { name: 'reason', label: 'Reason', type: 'select', options: [{ value: 'no_answer', label: 'No answer' }, { value: 'closed', label: 'Closed' }], required: true, placeholder: 'Choose a reason' },
    { name: 'amount', label: 'Receipt total', type: 'number', required: true, min: 0, step: '1', hint: 'MVR' },
    { name: 'handed', label: 'Handed to', type: 'segmented', options: [{ value: 'recipient', label: 'Recipient' }, { value: 'security', label: 'Security' }], value: 'recipient', required: true },
    { name: 'note', label: 'Note', type: 'textarea' },
    { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'photo', label: 'Photo', type: 'file', accept: 'image/*' },
    { name: 'received', label: 'Amount received in our account', type: 'checkbox', required: true },
  ];
  const dp = page.evaluate(f => MDM.ui.dialog({ title: 'Mark delivered', fields: f, okLabel: 'Mark delivered', validate: v => v.note === 'bad' ? 'Note cannot be bad' : null }).then(v => v && Object.assign({}, v, { photo: v.photo && v.photo.constructor.name + ':' + v.photo.name })), fields());
  await page.waitForSelector('dialog[open] [data-testid="dialog-ok"]');
  const dInfo = await page.evaluate(() => ({
    active: document.activeElement.getAttribute('data-testid'), testids: [...document.querySelectorAll('dialog [data-testid]')].map(e => e.getAttribute('data-testid')),
    optional: [...document.querySelectorAll('dialog .optional')].length, seg: document.querySelector('[data-testid="dialog-handed"]').tagName + ':' + document.querySelector('[data-testid="dialog-handed-recipient"]').checked,
  }));
  check('dialog renders fields with testids, focus first', dInfo.active === 'dialog-reason' && dInfo.testids.includes('dialog-amount') && dInfo.testids.includes('dialog-photo') && dInfo.testids.includes('dialog-received') && dInfo.optional === 3 && dInfo.seg === 'FIELDSET:true', dInfo);
  await page.click('[data-testid="dialog-ok"]');
  const dErr = await page.evaluate(() => {
    const f = n => document.querySelector('[data-field="' + n + '"]');
    return { stillOpen: !!document.querySelector('dialog[open]'), reasonErr: f('reason').querySelector('.field__error').textContent, reasonInvalid: f('reason').classList.contains('is-invalid') && f('reason').querySelector('select').getAttribute('aria-invalid'), describedby: f('reason').querySelector('select').getAttribute('aria-describedby'), amountErr: f('amount').querySelector('.field__error').textContent, hintHidden: f('amount').querySelector('.field__hint').hidden, receivedErr: f('received').querySelector('.field__error').textContent, noteErr: f('note').querySelector('.field__error').hidden, active: document.activeElement.getAttribute('data-testid') };
  });
  check('dialog required-missing inline errors, stays open, focuses first invalid', dErr.stillOpen && dErr.reasonErr === 'This field is required' && dErr.reasonInvalid === 'true' && /-error$/.test(dErr.describedby) && dErr.amountErr === 'This field is required' && dErr.hintHidden && dErr.receivedErr === 'This field is required' && dErr.noteErr && dErr.active === 'dialog-reason', dErr);
  await page.selectOption('[data-testid="dialog-reason"]', 'closed');
  await page.fill('[data-testid="dialog-amount"]', '412');
  await page.fill('[data-testid="dialog-note"]', 'bad');
  await page.fill('[data-testid="dialog-phone"]', '77712');
  await page.check('[data-testid="dialog-received"]');
  const cleared = await page.evaluate(() => document.querySelector('[data-field="reason"]').classList.contains('is-invalid'));
  check('dialog error clears on change', cleared === false);
  await page.click('[data-testid="dialog-ok"]');
  const dErr2 = await page.evaluate(() => ({ phoneErr: document.querySelector('[data-field="phone"] .field__error').textContent, open: !!document.querySelector('dialog[open]') }));
  check('dialog tel validation', dErr2.open && /valid/.test(dErr2.phoneErr), dErr2);
  await page.fill('[data-testid="dialog-phone"]', '+960 777 1234');
  await page.click('[data-testid="dialog-ok"]');
  const dErr3 = await page.evaluate(() => ({ formErr: document.querySelector('dialog .dialog__error').textContent, hidden: document.querySelector('dialog .dialog__error').hidden }));
  check('dialog validate(values) form-level error', dErr3.formErr === 'Note cannot be bad' && !dErr3.hidden, dErr3);
  await page.fill('[data-testid="dialog-note"]', 'fine');
  await page.setInputFiles('[data-testid="dialog-photo"]', { name: 'proof.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
  const fileRow = await page.evaluate(() => ({ name: document.querySelector('.file-pick__name').textContent, thumb: !document.querySelector('.file-pick__thumb').hidden }));
  check('dialog file field shows name + thumbnail', /proof\.png/.test(fileRow.name) && fileRow.thumb, fileRow);
  await page.click('label:has([data-testid="dialog-handed-security"])');
  await page.click('[data-testid="dialog-ok"]');
  const dv = await dp;
  check('dialog resolves values (number, select, segmented, checkbox, tel, File)', dv && dv.reason === 'closed' && dv.amount === 412 && dv.handed === 'security' && dv.note === 'fine' && dv.phone === '+960 777 1234' && dv.received === true && dv.photo === 'File:proof.png', { ...dv });
  const dp2 = page.evaluate(() => MDM.ui.dialog({ title: 'Reject', fields: [{ name: 'why', label: 'Reason', type: 'text', required: true }] }));
  await page.waitForSelector('dialog[open]');
  await page.click('[data-testid="dialog-cancel"]');
  check('dialog resolves null on cancel', (await dp2) === null);
  const dp3 = page.evaluate(() => MDM.ui.dialog({ title: 'Enter key', fields: [{ name: 'why', label: 'Reason', type: 'text', required: true }] }));
  await page.waitForSelector('dialog[open]');
  await page.keyboard.type('because');
  await page.keyboard.press('Enter');
  check('dialog Enter submits', JSON.stringify(await dp3) === '{"why":"because"}');

  // dialog over drawer: Escape closes only the dialog
  await page.click('#opener');
  await page.evaluate(() => MDM.ui.drawer.open({ title: 'Order', body: MDM.ui.el('button', { type: 'button', id: 'in-drawer' }, 'Reject') }));
  await page.waitForTimeout(250);
  await page.focus('#in-drawer');
  const cp4 = page.evaluate(() => MDM.ui.confirm({ title: 'Reject', message: 'M' }));
  await page.waitForSelector('dialog[open]');
  await page.keyboard.press('Escape');
  await cp4;
  await page.waitForTimeout(100);
  const layered = await page.evaluate(() => ({ drawerOpen: MDM.ui.drawer.isOpen(), active: document.activeElement.id }));
  check('Escape in dialog leaves drawer open and returns focus into drawer', layered.drawerOpen && layered.active === 'in-drawer', layered);
  await page.evaluate(() => MDM.ui.drawer.close());

  // badge / statusLabel / badgeFor fallback (no store.js loaded here)
  const b = await page.evaluate(() => {
    MDM.STATUS = { in_transit: { label: 'In transit', customer: 'On the way', kind: 'info' } };
    return { badge: MDM.ui.badge('ok', 'Paid <b>', { 'data-status': 'x"y' }), bf: MDM.badgeFor('in_transit', { customer: true }), sb: MDM.ui.statusBadge('in_transit'), lbl: MDM.ui.statusLabel('in_transit', 'customer'), unknown: MDM.ui.statusLabel('zzz') };
  });
  check('badge html escaped', b.badge === '<span class="badge badge--ok" data-status="x&quot;y">Paid &lt;b&gt;</span>', b.badge);
  check('badgeFor fallback reads MDM.STATUS', b.bf === '<span class="badge badge--info" data-status="in_transit">On the way</span>' && b.sb.includes('In transit') && b.lbl === 'On the way' && b.unknown === 'zzz', b);

  // setError on a standalone field
  const se = await page.evaluate(() => {
    const u = MDM.ui;
    const f = u.el('div', { class: 'field' }, u.el('label', { for: 'nm' }, 'Name'), u.el('input', { class: 'input', id: 'nm', 'aria-describedby': 'nm-hint' }), u.el('div', { class: 'field__hint', id: 'nm-hint' }, 'hint'));
    document.body.appendChild(f);
    u.setError(f, 'Enter your name');
    const on = { err: f.querySelector('.field__error').textContent, inv: f.classList.contains('is-invalid') && f.querySelector('input').classList.contains('is-invalid'), ai: f.querySelector('input').getAttribute('aria-invalid'), db: f.querySelector('input').getAttribute('aria-describedby'), hint: f.querySelector('.field__hint').hidden };
    u.setError(f.querySelector('input'), null);
    const off = { err: f.querySelector('.field__error').hidden, inv: f.classList.contains('is-invalid'), ai: f.querySelector('input').getAttribute('aria-invalid'), db: f.querySelector('input').getAttribute('aria-describedby'), hint: f.querySelector('.field__hint').hidden };
    const ff = u.focusFirstInvalid(document.body);
    f.remove();
    return { on, off, ff: ff === null };
  });
  check('setError on/off', se.on.err === 'Enter your name' && se.on.inv && se.on.ai === 'true' && se.on.db === 'nm-hint nm-error' && se.on.hint && se.off.err && !se.off.inv && se.off.ai === null && se.off.db === 'nm-hint' && !se.off.hint && se.ff, se);

  // phone: 12 inputs
  const ph = await page.evaluate(() => {
    const p = MDM.ui.phone;
    const cases = ['7771234', '+960 777 1234', '960-9601234', '3301234', '1234567', '77712', '+44 20 7946 0958', '9607771234', '00441234567890', '', '  7771234  ', '+9601234567'];
    return cases.map(c => ({ c, n: p.normalize(c), v: p.valid(c), vl: p.valid(c, { landline: true }), vi: p.valid(c, { intl: true }), f: p.format(c) }));
  });
  const exp = {
    '7771234': ['7771234', true, true, true, '+960 777 1234'], '+960 777 1234': ['7771234', true, true, true, '+960 777 1234'], '960-9601234': ['9601234', true, true, true, '+960 960 1234'],
    '3301234': ['3301234', false, true, false, '+960 330 1234'], '1234567': [null, false, false, false, '1234567'], '77712': [null, false, false, false, '77712'],
    '+44 20 7946 0958': ['+442079460958', false, false, true, '+442 079 460 958'], '9607771234': ['7771234', true, true, true, '+960 777 1234'], '00441234567890': ['+441234567890', false, false, true, '+441 234 567 890'],
    '': [null, false, false, false, ''], '  7771234  ': ['7771234', true, true, true, '+960 777 1234'], '+9601234567': [null, false, false, false, '+9601234567'],
  };
  ph.forEach(r => { const e = exp[r.c]; check('phone ' + JSON.stringify(r.c), r.n === e[0] && r.v === e[1] && r.vl === e[2] && r.vi === e[3] && r.f === e[4], r); });
  const links = await page.evaluate(() => MDM.ui.phone.links('+960 771 2345', 'Hi there'));
  check('phone.links', links.tel === 'tel:+9607712345' && links.wa === 'https://wa.me/9607712345?text=Hi%20there' && links.viber === 'viber://chat?number=%2B9607712345' && links.sms === 'sms:+9607712345?body=Hi%20there', links);

  // dates
  const dt = await page.evaluate(() => {
    const u = MDM.ui;
    const y = new Date().getFullYear();
    const iso = new Date(y, 8, 21, 14, 32).toISOString();        // 21 Sep this year, 14:32 local
    const old = new Date(2024, 0, 5, 9, 5).toISOString();
    return { a: u.fmtDate(iso), b: u.fmtDate(iso, { dateOnly: true }), c: u.fmtDate(old), d: u.fmtDate(old, { time: false }), e: u.fmtDate(iso, { year: true }), bad: u.fmtDate('nope'), t: u.fmtTime(iso),
      ago0: u.timeAgo(new Date(Date.now() - 10000).toISOString()), ago4: u.timeAgo(new Date(Date.now() - 4 * 60000).toISOString()), agoS: u.timeAgo(new Date(Date.now() - 12000).toISOString(), { seconds: true }), agoOld: u.timeAgo(old),
      dk: u.dayKey(iso), mk: u.monthKey(old), w: u.window('09:00-11:00'), w2: u.window('14:00–16:00'), w3: u.window('Fri 12:00-13:30'), m: u.minutesToHHMM(570), p: u.parseHHMM('09:30'), pbad: u.parseHHMM('25:00'), y };
  });
  check('fmtDate', dt.a === '21 Sep, 14:32' && dt.b === '21 Sep' && dt.c === '5 Jan 2024, 09:05' && dt.d === '5 Jan 2024' && dt.e === '21 Sep ' + dt.y + ', 14:32' && dt.bad === '' && dt.t === '14:32', dt);
  check('timeAgo', dt.ago0 === 'just now' && dt.ago4 === '4 min ago' && dt.agoS === '12 s ago' && dt.agoOld === '5 Jan 2024, 09:05', dt);
  check('dayKey/monthKey/window/HHMM', dt.dk === dt.y + '-09-21' && dt.mk === '2024-01' && dt.w === '09:00 to 11:00' && dt.w2 === '14:00 to 16:00' && dt.w3 === 'Fri 12:00-13:30' && dt.m === '09:30' && dt.p === 570 && dt.pbad === null, dt);

  // money / bytes
  const mo = await page.evaluate(() => { const u = MDM.ui; return { a: u.money(1250), b: u.money(-20), c: u.money(1250, { cents: true }), d: u.formatBytes(512), e: u.formatBytes(1536), f: u.formatBytes(1300000) }; });
  check('money fallback + formatBytes', mo.a === 'MVR 1,250' && mo.b === '−MVR 20' && mo.c === 'MVR 1,250.00' && mo.d === '512 B' && mo.e === '2 KB' && mo.f === '1.2 MB', mo);

  // copy (headless: clipboard permission may be absent → execCommand fallback)
  const cp5 = await page.evaluate(() => MDM.ui.copy('MDM-1038'));
  check('copy returns boolean', typeof cp5 === 'boolean', cp5);

  // debounce / on / qs / setLoading / scrollIntoViewIfNeeded
  const misc = await page.evaluate(async () => {
    const u = MDM.ui;
    let n = 0; const d = u.debounce(() => n++, 30); d(); d(); d();
    await new Promise(r => setTimeout(r, 60));
    const host = u.el('div', null, u.el('button', { type: 'button', class: 'row', 'data-id': 'r1' }, u.el('span', null, 'inner')));
    document.body.appendChild(host);
    let got = null; const off = u.on(host, 'click', '.row', function (e, m) { got = m.dataset.id + ':' + (this === m); });
    host.querySelector('span').click(); off(); got += '|'; host.querySelector('span').click();
    const btn = u.el('button', { type: 'button', class: 'btn btn--primary' }, 'Verify payment'); document.body.appendChild(btn);
    const w0 = btn.getBoundingClientRect().width;
    u.setLoading(btn, true);
    const on = { cls: btn.classList.contains('is-loading'), busy: btn.getAttribute('aria-busy'), spinner: !!btn.querySelector('.btn__spinner.icon--spin'), minW: btn.style.minWidth, text: btn.textContent };
    u.setLoading(btn, false);
    const offS = { cls: btn.classList.contains('is-loading'), busy: btn.getAttribute('aria-busy'), spinner: !!btn.querySelector('.btn__spinner'), minW: btn.style.minWidth };
    host.remove(); btn.remove();
    return { n, got, w0, on, offS, qs: u.qs('#opener').id, qsa: Array.isArray(u.qsa('button')) };
  });
  check('debounce/on/qs/setLoading', misc.n === 1 && misc.got === 'r1:true|' && misc.on.cls && misc.on.busy === 'true' && misc.on.spinner && parseFloat(misc.on.minW) >= misc.w0 && misc.on.text === 'Verify payment' && !misc.offS.cls && misc.offS.busy === null && !misc.offS.spinner && misc.offS.minW === '' && misc.qs === 'opener' && misc.qsa, misc);

  // validate(formEl, rules)
  const val = await page.evaluate(() => {
    const u = MDM.ui;
    const form = u.el('form', null,
      u.el('div', { class: 'field' }, u.el('label', { for: 'v-name' }, 'Name'), u.el('input', { class: 'input', id: 'v-name', name: 'name', value: '' })),
      u.el('div', { class: 'field' }, u.el('label', { for: 'v-phone' }, 'Phone'), u.el('input', { class: 'input', id: 'v-phone', name: 'phone', value: '7771234' })));
    document.body.appendChild(form);
    const r = u.validate(form, { name: v => v ? null : 'Enter your name', phone: v => u.phone.valid(v) ? null : 'Enter a valid mobile number' });
    const first = u.focusFirstInvalid(form);
    const out = { ok: r.ok, errors: r.errors, firstId: r.first && r.first.id, focused: first && first.id === document.activeElement.id, values: r.values };
    form.remove();
    return out;
  });
  check('validate(formEl, rules) + focusFirstInvalid', val.ok === false && val.errors.name === 'Enter your name' && !val.errors.phone && val.firstId === 'v-name' && val.focused && val.values.phone === '7771234', val);

  // imageToJpeg on a generated 2000x1500 PNG
  const img = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 2000; c.height = 1500;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#0f6fde'; ctx.fillRect(0, 0, 2000, 1500); ctx.fillStyle = '#fff'; ctx.fillRect(100, 100, 800, 600);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'big.png', { type: 'image/png' });
    const out = await MDM.ui.imageToJpeg(file, { maxEdge: 1200, quality: 0.8 });
    const out2 = await MDM.ui.imageToJpeg(file, { maxEdge: 900, quality: 0.7 });
    const du = await MDM.ui.fileToDataUrl(new Blob(['abc'], { type: 'text/plain' }));
    let bad = null; try { await MDM.ui.imageToJpeg(new File(['nope'], 'x.heic', { type: 'image/heic' })); } catch (e) { bad = e.message; }
    return { w: out.width, h: out.height, type: out.type, size: out.size, prefix: out.dataUrl.slice(0, 23), inSize: file.size, w2: out2.width, du, bad };
  });
  check('imageToJpeg 2000x1500 → 1200x900 jpeg', img.w === 1200 && img.h === 900 && img.type === 'image/jpeg' && img.prefix === 'data:image/jpeg;base64,' && img.size > 0 && img.size < img.inSize && img.w2 === 900 && img.du === 'data:text/plain;base64,YWJj' && img.bad === 'image_decode', img);

  console.log(results.join('\n'));
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
})().catch(e => { console.error('CRASH', e); process.exit(1); });

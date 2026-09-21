// Checkout: bank-transfer payment for one order (SPEC §3.3). Reads ?order=<id> (or ?code=), prints the bank details from settings,
// takes the payer details plus the transfer slip and moves the order to payment_review. The slip goes into `files` the moment it is
// chosen and `order.payment.slip` points at it, so a reload shows the same preview. No price arithmetic happens here.
(function (MDM) { 'use strict';
  const { el } = MDM.ui;
  const MB = 1024 * 1024;
  const MAX_RAW = 8 * MB, MAX_PDF = 1 * MB, MAX_JPEG = 1.2 * MB;
  const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
  const AFTER_CONFIRMED = ['confirmed', 'assigned', 'picked_up', 'in_transit', 'on_hold', 'delivered', 'returned'];
  const CHANNEL = { sms: 'by SMS', whatsapp: 'on WhatsApp', viber: 'on Viber' };
  const QUOTA_MSG = 'This browser is out of storage space for the demo. Reset demo data from the admin or use a smaller file.';
  const HEIC_MSG = 'Upload a JPG, PNG or PDF. On iPhone, take a screenshot of the transfer receipt instead.';

  const root = document.querySelector('[data-checkout="body"]');
  const descEl = document.querySelector('[data-checkout="desc"]');
  // draft holds what the customer typed so a re-render (store event from another tab, slip saved) never loses it.
  const state = { orderId: null, draftFor: null, draft: null, slip: null, busy: false, slipError: null, formError: null, objectUrl: null, focusPanel: false, seq: 0 };
  const fields = {};

  class SlipError extends Error {}
  const trackHref = id => '../track/?order=' + encodeURIComponent(id);
  const icon = (name, size) => MDM.ui.html(MDM.icon(name, size || 16));
  const parseAmount = v => Number(String(v == null ? '' : v).replace(/[^\d.]/g, ''));
  const channelOf = c => CHANNEL[c && c.notify] || CHANNEL.whatsapp;

  const RULES = {
    bank: d => d.bank ? null : 'Choose the bank you paid from',
    payerName: d => d.payerName.trim() ? null : "Enter the account holder's name",
    paidAmount: d => parseAmount(d.paidAmount) > 0 ? null : 'Enter the amount you transferred',
    slip: () => state.slip ? null : 'Upload your transfer slip to continue',
    terms: d => d.terms ? null : "Tick the box to confirm you've read what we carry",
  };

  // ---- Data ----
  async function loadOrder() {
    const q = new URLSearchParams(location.search);
    const id = (q.get('order') || '').trim(), code = (q.get('code') || '').trim();
    let order = id ? await MDM.store.get('orders', id) : null;
    if (!order && (code || /^(mdm-?)?\d+$/i.test(id))) order = await MDM.store.orderByCode(code || id);
    return order;
  }
  function initDraft(order) {
    const p = order.payment || {};
    state.draftFor = order.id;
    state.draft = { bank: p.bank || '', payerName: p.payerName || '', paidAmount: p.paidAmount != null ? String(p.paidAmount) : String(order.totals.total), reference: p.reference || '', terms: false, touched: {} };
  }
  async function loadSlip(order) {
    const s = order.payment && order.payment.slip;
    if (!s || !s.fileId) return null;
    const row = await MDM.store.get('files', s.fileId);
    return row && row.dataUrl ? row : null;
  }

  // ---- Slip processing: 8 MB raw cap, images re-encoded to JPEG ≤ 1200px (900px/0.7 retry), PDFs ≤ 1 MB, HEIC refused ----
  async function prepareSlip(file) {
    const name = file.name || 'slip', type = String(file.type || '').toLowerCase();
    if (/hei[cf]/.test(type) || /\.hei[cf]$/i.test(name)) throw new SlipError(HEIC_MSG);
    if (file.size > MAX_RAW) throw new SlipError('Choose a file under 8 MB.');
    if (type === 'application/pdf' || (!type && /\.pdf$/i.test(name))) {
      if (file.size > MAX_PDF) throw new SlipError('Choose a PDF under 1 MB, or upload a screenshot of it.');
      return { name, type: 'application/pdf', size: file.size, dataUrl: await MDM.ui.fileToDataUrl(file) };
    }
    if (!/^image\/(jpeg|png|webp)$/.test(type) && !(!type && /\.(jpe?g|png|webp)$/i.test(name))) throw new SlipError('Upload a JPG, PNG or PDF.');
    let out;
    try {
      out = await MDM.ui.imageToJpeg(file, { maxEdge: 1200, quality: 0.8 });
      if (out.size > MAX_JPEG) out = await MDM.ui.imageToJpeg(file, { maxEdge: 900, quality: 0.7 });
    } catch (e) { throw new SlipError('We could not read this image. Try a JPG or PNG.'); }
    if (out.size > MAX_JPEG) throw new SlipError('Please choose a smaller image');
    return { name, type: 'image/jpeg', size: out.size, dataUrl: out.dataUrl, width: out.width, height: out.height };
  }
  async function saveSlip(p) {
    const id = state.orderId;
    const row = await MDM.store.insert('files', { kind: 'slip', orderId: id, name: p.name, type: p.type, size: p.size, width: p.width || null, height: p.height || null, dataUrl: p.dataUrl, at: new Date().toISOString() });
    let prev = null;
    try {
      await MDM.store.update('orders', id, cur => { prev = cur.payment && cur.payment.slip; return { payment: Object.assign({}, cur.payment, { slip: { fileId: row.id, name: p.name, type: p.type, size: p.size } }) }; });
    } catch (e) { await MDM.store.remove('files', row.id).catch(() => {}); throw e; }
    if (prev && prev.fileId && prev.fileId !== row.id) await MDM.store.remove('files', prev.fileId).catch(() => {});
  }
  async function chooseFile(file) {
    if (state.busy) return;
    state.busy = 'slip'; state.slipError = null; state.formError = null;
    await render();
    try { await saveSlip(await prepareSlip(file)); }
    catch (e) { state.slipError = e instanceof SlipError ? e.message : (e && e.code === 'quota' ? QUOTA_MSG : 'We could not read this file. Try a JPG, PNG or PDF.'); }
    state.busy = false;
    await render();
  }
  async function removeSlip() {
    if (state.busy) return;
    state.busy = 'slip'; state.slipError = null;
    try {
      let prev = null;
      await MDM.store.update('orders', state.orderId, cur => { prev = cur.payment && cur.payment.slip; return { payment: Object.assign({}, cur.payment, { slip: null }) }; });
      if (prev && prev.fileId) await MDM.store.remove('files', prev.fileId).catch(() => {});
    } catch (e) { state.slipError = e && e.code === 'quota' ? QUOTA_MSG : 'We could not remove the file. Try again.'; }
    state.busy = false;
    await render();
  }
  function dataUrlToBlob(dataUrl) {
    const i = dataUrl.indexOf(','), head = dataUrl.slice(0, i), body = dataUrl.slice(i + 1);
    const mime = (/^data:([^;,]+)/.exec(head) || [])[1] || 'application/octet-stream';
    const bin = atob(body), bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    return new Blob([bytes], { type: mime });
  }

  // ---- Validation ----
  function validateField(name) {
    const f = fields[name];
    if (!f || !RULES[name]) return true;
    const msg = state.draft.touched[name] ? RULES[name](state.draft) : null;
    MDM.ui.setError(f, name === 'slip' && state.slipError ? state.slipError : msg);
    return !msg && !(name === 'slip' && state.slipError);
  }
  function validateAll() { return Object.keys(RULES).map(validateField).every(Boolean); }

  // ---- Submit: payer details onto payment, then the status machine moves the order to payment_review ----
  async function submit(form, btn) {
    if (state.busy) return;
    Object.keys(RULES).forEach(n => { state.draft.touched[n] = true; });
    if (!validateAll()) { MDM.ui.focusFirstInvalid(form); return; }
    state.busy = 'submit'; state.formError = null; MDM.ui.setLoading(btn, true);
    const d = state.draft;
    try {
      await MDM.store.update('orders', state.orderId, cur => ({ payment: Object.assign({}, cur.payment, {
        status: 'review', bank: d.bank, payerName: d.payerName.trim(), paidAmount: parseAmount(d.paidAmount), reference: d.reference.trim(), submittedAt: new Date().toISOString(), rejectReason: null }) }));
      await MDM.store.transition(state.orderId, 'payment_review', { by: 'customer' });
      state.busy = false; state.focusPanel = true;
      await render();
    } catch (e) {
      state.busy = false; MDM.ui.setLoading(btn, false);
      state.formError = e && e.code === 'quota' ? QUOTA_MSG : e && e.code === 'transition' ? 'This order can no longer be paid here. Check its status on the tracking page.' : 'We could not save your details. Try again.';
      await render();
    }
  }

  // ---- Building blocks ----
  function copyButton(text, testid, what) {
    let timer = null;
    const label = el('span', null, 'Copy');
    const btn = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': testid }, icon('copy'), label, el('span', { class: 'sr-only' }, ' ' + what));
    btn.addEventListener('click', async () => {
      const ok = await MDM.ui.copy(text);
      if (!ok) { selectText(btn.parentElement); return; }
      label.textContent = 'Copied';
      clearTimeout(timer); timer = setTimeout(() => { label.textContent = 'Copy'; }, 1500);
    });
    return btn;
  }
  function selectText(host) {
    const target = host && host.querySelector('.mono');
    if (!target || !window.getSelection) return;
    const range = document.createRange(); range.selectNodeContents(target);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
  function notice(kind, iconName, body, action) {
    return el('div', { class: 'alert alert--' + kind, role: kind === 'danger' ? 'alert' : 'status' }, icon(iconName), el('div', { class: 'alert__body' }, el('div', null, body), action || null));
  }
  function trackAction(order) { return el('a', { class: 'alert__action', href: trackHref(order.id) }, 'Track this order'); }
  function row(label, value, opts) {
    opts = opts || {};
    return el('div', { class: 'rate-table__row' },
      el('div', { class: 'rate-table__label' }, label, opts.sub ? el('small', null, opts.sub) : null),
      el('div', { class: 'rate-table__value' + (opts.mono ? ' mono' : '') }, value));
  }
  function line(label, sub, amount, fee) {
    return el('div', { class: 'summary__line' + (fee ? ' summary__line--fee' : '') },
      el('span', { class: 'summary__desc' }, label, sub ? el('span', { class: 'summary__sub' }, sub) : null),
      el('span', { class: 'summary__amount mono' }, MDM.pricing.format(amount)));
  }
  function summary(order) {
    const lines = (order.packages || []).map(p => line(MDM.pricing.lineLabel(p, order.service), p.description, p.price ? p.price.lineTotal : 0));
    if (order.totals.budget) lines.push(line('Shopping budget (paid up front)', null, order.totals.budget, true));
    MDM.pricing.feeLines(order).forEach(f => lines.push(line(f.label, f.reason, f.amount, true)));
    return el('div', { class: 'summary checkout-summary' }, lines, el('div', { class: 'summary__rule' }),
      el('div', { class: 'summary__total' }, el('span', null, 'Amount due'), el('span', { class: 'mono', 'data-testid': 'checkout-amount' }, MDM.pricing.format(order.totals.total))));
  }
  function scheduleText(order) {
    const s = order.schedule || {};
    if (s.type === 'slot' && s.date) return [MDM.ui.fmtDate(s.date, { dateOnly: true }), el('small', null, MDM.ui.window(s.window))];
    return 'As soon as possible';
  }
  function field(name, id, label, control, opts) {
    opts = opts || {};
    const wrap = el('div', { class: 'field', 'data-field': name },
      el('label', { for: id }, label, opts.optional ? el('span', { class: 'optional' }, ' (optional)') : null),
      control,
      opts.hint ? el('div', { class: 'field__hint', id: id + '-hint' }, opts.hint) : null,
      el('div', { class: 'field__error', id: id + '-error', hidden: true }));
    fields[name] = wrap;
    return wrap;
  }
  function textInput(name, id, attrs) {
    const d = state.draft;
    return el('input', Object.assign({ class: 'input', id, name, type: 'text', value: d[name], 'data-testid': 'checkout-' + attrs.testid, on: {
      input: e => { d[name] = e.target.value; if (fields[name].classList.contains('is-invalid')) validateField(name); },
      blur: () => { d.touched[name] = true; validateField(name); },
    } }, attrs.attrs || {}));
  }

  // ---- Sections ----
  function orderSection(order) {
    const c = order.customer || {};
    return el('section', { class: 'section', 'aria-labelledby': 'co-order' },
      el('div', { class: 'section-head' }, el('h2', { id: 'co-order' }, 'Your order')),
      el('div', { class: 'rate-table' },
        row('Order code', el('span', { class: 'checkout-copy checkout-copy--end' }, el('span', { class: 'checkout-code mono', 'data-testid': 'checkout-code' }, order.code), copyButton(order.code, 'checkout-copy-code', 'order code'))),
        row('Customer', [c.name || '', el('small', { class: 'mono' }, MDM.ui.phone.format(c.phone))]),
        row('Pickup', scheduleText(order))),
      summary(order));
  }
  function bankSection(order, settings) {
    const banks = settings.banks || [];
    return el('section', { class: 'section', 'aria-labelledby': 'co-bank' },
      el('div', { class: 'section-head' }, el('h2', { id: 'co-bank' }, 'Transfer to one of our accounts')),
      el('div', { class: 'stack-4' },
        notice('info', 'info', 'Demo bank details, replace before launch.'),
        el('div', { class: 'rate-table' }, banks.map(b => row(b.name, el('span', { class: 'checkout-copy checkout-copy--end' },
          el('span', { class: 'checkout-account mono' }, b.accountNo), copyButton(b.accountNo, 'checkout-copy-account', 'account number')), { sub: 'Account name: ' + b.accountName }))),
        el('p', { class: 'checkout-ref' }, 'Use the order code ', el('span', { class: 'mono' }, order.code), ' as the transfer reference.')));
  }
  function dropzone(slip) {
    const input = el('input', { class: 'sr-only', type: 'file', id: 'co-slip', name: 'slip', accept: ACCEPT, 'data-testid': 'checkout-slip-input', 'aria-labelledby': 'co-slip-label', 'aria-describedby': 'co-slip-hint',
      disabled: state.busy === 'slip', on: { change: () => { const f = input.files && input.files[0]; if (f) chooseFile(f); } } });
    const zone = el('div', { class: 'dropzone', 'data-testid': 'checkout-dropzone' });
    if (state.busy === 'slip') {
      zone.append(el('div', { class: 'dropzone__title' }, 'Preparing your slip'), el('div', { class: 'dropzone__hint' }, 'Large photos take a moment.'));
    } else if (slip) {
      zone.append(preview(slip));
    } else {
      zone.append(el('div', { class: 'dropzone__title' }, 'Upload your transfer slip'),
        el('div', { class: 'dropzone__hint' }, 'JPG, PNG or PDF, up to 8 MB', el('span', { class: 'dropzone__drag' }, ', or drag it here')),
        el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => input.click() } }, icon('upload'), el('span', { class: 'hide-mobile' }, 'Choose a file'), el('span', { class: 'show-mobile' }, 'Choose a file or take a photo')));
    }
    zone.append(input);
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('is-over'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) chooseFile(f); });
    return zone;
  }
  function preview(slip) {
    const isPdf = slip.type === 'application/pdf';
    const actions = [];
    if (isPdf) {
      state.objectUrl = URL.createObjectURL(dataUrlToBlob(slip.dataUrl));
      actions.push(el('a', { class: 'btn btn--ghost btn--sm', href: state.objectUrl, target: '_blank', rel: 'noopener', 'data-testid': 'checkout-slip-open' }, 'Open'));
    }
    actions.push(el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'checkout-slip-remove', on: { click: removeSlip } }, 'Remove'));
    return el('div', { class: 'dropzone__preview', 'data-testid': 'checkout-slip-preview', 'data-type': slip.type },
      isPdf ? el('div', { class: 'dropzone__thumb dropzone__thumb--pdf', 'aria-hidden': 'true' }, 'PDF') : el('img', { class: 'dropzone__thumb', src: slip.dataUrl, alt: 'Your transfer slip' }),
      el('div', { class: 'dropzone__file' }, el('div', { class: 'dropzone__name' }, slip.name), el('div', { class: 'dropzone__size' }, MDM.ui.formatBytes(slip.size))),
      actions);
  }
  function formSection(order, settings, slip) {
    const d = state.draft;
    const banks = settings.banks || [];
    const bankSelect = el('select', { class: 'select', id: 'co-bank-select', name: 'bank', 'data-testid': 'checkout-bank', on: {
      change: e => { d.bank = e.target.value; d.touched.bank = true; validateField('bank'); },
      blur: () => { d.touched.bank = true; validateField('bank'); } } },
      el('option', { value: '' }, 'Choose a bank'),
      banks.map(b => el('option', { value: b.id }, b.name)),
      el('option', { value: 'other' }, 'Other bank'));
    bankSelect.value = d.bank;
    const amount = textInput('paidAmount', 'co-amount', { testid: 'paid-amount', attrs: { inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'next' } });
    const terms = el('input', { type: 'checkbox', id: 'co-terms', name: 'terms', 'data-testid': 'checkout-terms', checked: d.terms, 'aria-describedby': 'co-terms-text',
      on: { change: e => { d.terms = e.target.checked; d.touched.terms = true; validateField('terms'); } } });
    const submitBtn = el('button', { type: 'submit', class: 'btn btn--primary', 'data-testid': 'checkout-submit', disabled: state.busy === 'slip' }, 'Submit for verification');
    const slipField = el('div', { class: 'field', 'data-field': 'slip' },
      el('span', { class: 'field__label', id: 'co-slip-label' }, 'Transfer slip'),
      dropzone(slip),
      el('div', { class: 'field__hint', id: 'co-slip-hint' }, 'Your slip is seen only by our admin and used to match your transfer.'),
      el('div', { class: 'field__error', id: 'co-slip-error', hidden: true }));
    fields.slip = slipField;
    const termsField = el('div', { class: 'field', 'data-field': 'terms' },
      el('p', { class: 'checkout-terms', id: 'co-terms-text' }, settings.terms || ''),
      // wrapped so base.css's `.field > label` (the 13px field label rule) does not override `.checkbox`
      el('div', null, el('label', { class: 'checkbox', for: 'co-terms' }, terms, el('span', null, "I've read what we carry"))),
      el('div', { class: 'field__error', id: 'co-terms-error', hidden: true }));
    fields.terms = termsField;
    const form = el('form', { class: 'form checkout-form', novalidate: true, 'data-testid': 'checkout-form', on: { submit: e => { e.preventDefault(); submit(form, submitBtn); } } },
      field('bank', 'co-bank-select', 'Paid from', bankSelect),
      el('div', { class: 'grid-2' },
        field('payerName', 'co-payer', 'Account holder name', textInput('payerName', 'co-payer', { testid: 'payer-name', attrs: { autocomplete: 'name', enterkeyhint: 'next' } })),
        field('paidAmount', 'co-amount', 'Amount transferred', el('div', { class: 'input-affix' }, el('span', { class: 'input-affix__prefix', 'aria-hidden': 'true' }, 'MVR'), amount),
          { hint: 'Amount due ' + MDM.pricing.format(order.totals.total) + '. Enter what your bank shows if it differs.' })),
      field('reference', 'co-ref', 'Transfer reference or transaction ID', textInput('reference', 'co-ref', { testid: 'reference', attrs: { autocomplete: 'off', enterkeyhint: 'done' } }), { optional: true }),
      slipField,
      termsField,
      el('div', { class: 'field__error', role: 'alert', 'data-testid': 'checkout-form-error', hidden: !state.formError }, state.formError || ''),
      el('div', { class: 'form-actions' }, submitBtn));
    return el('section', { class: 'section', 'aria-labelledby': 'co-details' },
      el('div', { class: 'section-head' }, el('h2', { id: 'co-details' }, 'Your transfer details')),
      form);
  }
  function rejectedNotice(order) {
    const reason = String(order.payment.rejectReason || '').trim().replace(/\.$/, '');
    const c = MDM.shell.contactLinks({ text: 'Order ' + order.code + ': about my transfer' });
    const contact = c.whatsapp ? el('a', { href: c.whatsapp, target: '_blank', rel: 'noopener' }, 'contact us') : (c.tel ? el('a', { href: c.tel }, 'contact us') : 'contact us');
    return el('div', { class: 'checkout-notice' }, notice('danger', 'alert-circle',
      ['We could not match your transfer' + (reason ? ': ' + reason : '') + '. Upload the slip again or ', contact, '.']));
  }
  function renderForm(order, settings, slip) {
    const frag = document.createDocumentFragment();
    if (order.payment && order.payment.status === 'rejected') frag.append(rejectedNotice(order));
    frag.append(orderSection(order), bankSection(order, settings), formSection(order, settings, slip));
    return frag;
  }
  function renderConfirmation(order, settings) {
    const c = order.customer || {};
    const channel = channelOf(c);
    const review = (settings.ops && settings.ops.reviewText) || 'about 30 minutes';
    return el('section', { class: 'card checkout-panel', 'aria-labelledby': 'co-done', 'data-testid': 'checkout-confirmation' },
      el('div', { class: 'card__body' },
        el('h2', { id: 'co-done', tabindex: '-1' }, 'Payment submitted'),
        el('div', { class: 'checkout-copy' }, el('span', { class: 'checkout-code mono', 'data-testid': 'checkout-code' }, order.code), copyButton(order.code, 'checkout-copy-code', 'order code')),
        el('p', null, 'We will message you ' + channel + ' at ' + MDM.ui.phone.format(c.phone) + '.'),
        el('h3', null, 'What happens next'),
        el('ol', { class: 'checkout-next' },
          el('li', null, 'We match your transfer to order ' + order.code + ', usually within ' + review + '.'),
          el('li', null, 'We message you ' + channel + ' once it is confirmed and a rider is assigned.'),
          el('li', null, 'Track the pickup and delivery with your order code.')),
        el('a', { class: 'btn btn--primary', href: trackHref(order.id), 'data-testid': 'checkout-track-link' }, 'Track this order')));
  }
  function renderInvalid() {
    return el('div', { class: 'empty', 'data-testid': 'checkout-invalid' },
      el('p', { class: 'empty__title' }, 'This payment link is not valid'),
      el('p', { class: 'empty__hint' }, 'Check the link in your message, or start a new request.'),
      el('a', { class: 'btn btn--secondary btn--sm', href: '../request/' }, 'Request a delivery'));
  }

  // ---- Render (one entry point; the store subscription and every local action come back through here) ----
  // A re-render replaces the DOM, so focus is handed back to the element with the same id (a field mid-edit, the panel heading).
  function show(node, desc) {
    const active = document.activeElement;
    const keepId = active && active.id && root.contains(active) ? active.id : null;
    root.replaceChildren(node);
    descEl.textContent = desc || '';
    descEl.hidden = !desc;
    if (keepId) { const again = root.querySelector('#' + keepId); if (again) again.focus({ preventScroll: true }); }
  }
  async function render() {
    const seq = ++state.seq;
    const order = await loadOrder();
    const settings = await MDM.store.settings();
    const slip = order ? await loadSlip(order) : null;
    if (seq !== state.seq) return;
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
    Object.keys(fields).forEach(k => { delete fields[k]; });
    state.slip = slip;
    state.orderId = order ? order.id : null;
    const review = (settings.ops && settings.ops.reviewText) || 'about 30 minutes';
    if (!order || order.status === 'draft') { show(renderInvalid(), ''); return; }
    if (order.status === 'cancelled') { show(notice('danger', 'alert-circle', 'This order was cancelled.', trackAction(order)), ''); return; }
    // Business orders are invoiced monthly and never pass through payment, so the note wins over the status redirect.
    if (order.service === 'business') { show(notice('info', 'info', 'No payment needed now. This order goes on your monthly invoice.', trackAction(order)), ''); return; }
    if (AFTER_CONFIRMED.indexOf(order.status) >= 0) { location.replace(trackHref(order.id)); return; }
    if (order.status === 'quote_pending') {
      show(notice('info', 'info', "We're confirming your price. We'll message you the payment link " + channelOf(order.customer) + '.', trackAction(order)), '');
      return;
    }
    if (order.status === 'payment_review') {
      show(renderConfirmation(order, settings), 'Your slip is with us. We check it, usually within ' + review + '.');
      if (state.focusPanel) { state.focusPanel = false; window.scrollTo(0, 0); const h = root.querySelector('#co-done'); if (h) h.focus({ preventScroll: true }); }
      return;
    }
    if (!state.draft || state.draftFor !== order.id) initDraft(order);
    show(renderForm(order, settings, slip), 'Transfer the amount due to one of our accounts, then upload your slip. We confirm it, usually within ' + review + '.');
    validateAll();
  }

  async function main() {
    await MDM.store.ready;
    await render();
    MDM.store.subscribe('orders', msg => { if (!msg.ids || !msg.ids.length || msg.ids.indexOf(state.orderId) >= 0) render(); });
    MDM.store.subscribe('settings', () => { render(); });
  }
  main();
})(window.MDM);

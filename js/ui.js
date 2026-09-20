// UI primitives shared by every page: DOM builder, toasts, the single right-hand drawer, native <dialog> confirm/dialog forms,
// badges, field errors, phone/date/money formatting and small helpers. Class names follow SPEC §2.5 (css/base.css).
// Strings passed to el() are always text; only html() turns a trusted template string into nodes.
// Production note: nothing here touches the store; the same file ships unchanged when Supabase replaces localStorage.
(function (MDM) { 'use strict';
  const KINDS = ['neutral', 'ok', 'warn', 'danger', 'info'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  let seq = 0;
  const uid = p => (p || 'ui') + '-' + (++seq);
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const kindOf = k => KINDS.includes(k) ? k : 'neutral';

  // ---- DOM ----
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]); }
  function append(parent, child) {
    if (child == null || child === false || child === true) return;
    if (Array.isArray(child)) { child.forEach(c => append(parent, c)); return; }
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  // el(tag, attrs?, ...children). attrs: class (string|array), id, dataset:{}, on:{ event: fn }, style (string|object), value, aria-*/data-*/any
  // attribute; `true` sets a boolean attribute, null/false skip it. Children: Node | string (text) | number | array | null.
  function el(tag, attrs, ...children) {
    if (attrs != null && (attrs instanceof Node || typeof attrs !== 'object' || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
    const node = document.createElement(tag);
    let value;
    if (attrs) Object.keys(attrs).forEach(k => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class' || k === 'className') node.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      else if (k === 'dataset') Object.keys(v).forEach(d => { if (v[d] != null) node.dataset[d] = v[d]; });
      else if (k === 'on') Object.keys(v).forEach(ev => { if (typeof v[ev] === 'function') node.addEventListener(ev, v[ev]); });
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'value') value = v;
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    });
    append(node, children);
    // value is applied after children so <select> can pick one of its options; textarea/input take it as a property too.
    if (value !== undefined) { if ('value' in node) node.value = value; else node.setAttribute('value', value); }
    return node;
  }
  // html(str) → DocumentFragment from a TRUSTED string (icons, badge markup, template literals whose values went through esc()).
  function html(str) { const t = document.createElement('template'); t.innerHTML = String(str == null ? '' : str).trim(); return t.content; }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  // on(el, event, selector?, handler) → off(). With a selector the handler runs as handler.call(match, event, match).
  function on(target, event, selector, handler) {
    if (typeof selector === 'function') { handler = selector; selector = null; }
    const fn = selector ? e => { const m = e.target && e.target.closest ? e.target.closest(selector) : null; if (m && target.contains(m)) handler.call(m, e, m); } : handler;
    target.addEventListener(event, fn);
    return () => target.removeEventListener(event, fn);
  }
  function debounce(fn, ms) {
    let t = null;
    const d = function () { const args = arguments, self = this; clearTimeout(t); t = setTimeout(() => { t = null; fn.apply(self, args); }, ms); };
    d.cancel = () => { clearTimeout(t); t = null; };
    return d;
  }
  const visible = n => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
  const focusables = root => qsa(FOCUSABLE, root).filter(visible);
  function scrollParent(node) {
    for (let p = node.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }
  function scrollIntoViewIfNeeded(node, block) {
    if (!node || !node.getBoundingClientRect) return;
    const r = node.getBoundingClientRect();
    const sp = scrollParent(node);
    const box = sp ? sp.getBoundingClientRect() : { top: 0, bottom: window.innerHeight || document.documentElement.clientHeight };
    if (r.top >= box.top && r.bottom <= box.bottom) return;
    node.scrollIntoView({ block: block || 'center', behavior: reduced() ? 'auto' : 'smooth' });
  }

  // ---- Badges ----
  function badge(kind, label, attrs) {
    let a = '';
    if (attrs) Object.keys(attrs).forEach(k => { if (attrs[k] != null && attrs[k] !== false) a += ' ' + k + '="' + esc(attrs[k]) + '"'; });
    return '<span class="badge badge--' + kindOf(kind) + '"' + a + '>' + esc(label) + '</span>';
  }
  function statusLabel(status, audience) {
    const s = MDM.STATUS && MDM.STATUS[status];
    if (!s) return String(status == null ? '' : status);
    return audience === 'customer' ? s.customer : s.label;
  }
  // store.js owns the canonical MDM.badgeFor; this fallback only fills the gap when it is missing.
  if (!MDM.badgeFor) MDM.badgeFor = function (status, opts) {
    const s = MDM.STATUS && MDM.STATUS[status];
    return badge(s ? s.kind : 'neutral', statusLabel(status, opts && opts.customer ? 'customer' : 'admin'), { 'data-status': status });
  };
  const statusBadge = (status, opts) => MDM.badgeFor(status, opts);

  // ---- Fields ----
  const CONTROL = '.input, .select, .textarea, fieldset, input, select, textarea';
  function fieldParts(target) {
    if (!target) return null;
    const field = target.classList && target.classList.contains('field') ? target : target.closest('.field');
    const control = field ? (target !== field && target.matches(CONTROL) ? target : field.querySelector(CONTROL)) : (target.matches(CONTROL) ? target : null);
    return { field, control };
  }
  function addDescribedBy(control, id, add) {
    const ids = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).filter(x => x !== id);
    if (add) ids.push(id);
    if (ids.length) control.setAttribute('aria-describedby', ids.join(' ')); else control.removeAttribute('aria-describedby');
  }
  // setError(fieldEl|control, message|null): toggles .field__error text, .is-invalid on wrapper + control, aria-invalid, aria-describedby.
  function setError(target, message) {
    const p = fieldParts(target);
    if (!p || (!p.field && !p.control)) return;
    const host = p.field || p.control.parentElement;
    let err = host.querySelector(':scope > .field__error');
    const hint = host.querySelector(':scope > .field__hint');
    if (message) {
      if (!err) { err = el('div', { class: 'field__error' }); host.appendChild(err); }
      if (!err.id) err.id = (p.control && p.control.id ? p.control.id + '-error' : uid('err'));
      err.textContent = message; err.hidden = false;
      if (hint) hint.hidden = true;
      if (p.field) p.field.classList.add('is-invalid');
      if (p.control) { p.control.classList.add('is-invalid'); p.control.setAttribute('aria-invalid', 'true'); addDescribedBy(p.control, err.id, true); }
    } else {
      if (err) { err.textContent = ''; err.hidden = true; if (p.control) addDescribedBy(p.control, err.id, false); }
      if (hint) hint.hidden = false;
      if (p.field) p.field.classList.remove('is-invalid');
      if (p.control) { p.control.classList.remove('is-invalid'); p.control.removeAttribute('aria-invalid'); }
    }
  }
  function controlValue(c) {
    if (!c) return undefined;
    if (typeof RadioNodeList !== 'undefined' && c instanceof RadioNodeList) return c.value;
    if (c.type === 'checkbox') return c.checked;
    if (c.type === 'file') return c.files && c.files[0] || null;
    return typeof c.value === 'string' ? c.value.trim() : c.value;
  }
  // validate(formEl, { name: (value, values, control) → message|null }) → { ok, errors, first, values }; sets errors on each field.
  function validate(form, rules) {
    const names = Object.keys(rules || {}), values = {}, errors = {};
    let first = null;
    names.forEach(n => { values[n] = controlValue(form.elements[n]); });
    names.forEach(n => {
      const c = form.elements[n];
      const target = (typeof RadioNodeList !== 'undefined' && c instanceof RadioNodeList) ? c[0] : c;
      if (!target) return;
      const msg = rules[n](values[n], values, c) || null;
      setError(target, msg);
      if (msg) { errors[n] = msg; first = first || target; }
    });
    return { ok: !first, errors, first, values };
  }
  function focusFirstInvalid(form) {
    const c = (form || document).querySelector('.is-invalid .input, .is-invalid .select, .is-invalid .textarea, .is-invalid input, .is-invalid select, .is-invalid textarea, [aria-invalid="true"]');
    if (!c) return null;
    const target = c.tagName === 'FIELDSET' ? (c.querySelector('input, select, textarea, button') || c) : c;
    scrollIntoViewIfNeeded(target);
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    return target;
  }
  function setLoading(btn, on) {
    if (!btn) return;
    if (on) {
      if (btn.classList.contains('is-loading')) return;
      btn.dataset.loadingWidth = btn.style.minWidth || '';
      btn.style.minWidth = Math.ceil(btn.getBoundingClientRect().width) + 'px';
      btn.classList.add('is-loading'); btn.setAttribute('aria-busy', 'true');
      btn.insertAdjacentHTML('afterbegin', MDM.icon('loader', 16, 'icon--spin btn__spinner'));
    } else {
      if (!btn.classList.contains('is-loading')) return;
      const s = btn.querySelector(':scope > .btn__spinner'); if (s) s.remove();
      btn.classList.remove('is-loading'); btn.removeAttribute('aria-busy');
      btn.style.minWidth = btn.dataset.loadingWidth || ''; delete btn.dataset.loadingWidth;
    }
  }

  // ---- Toasts (max 3, 4 s / 8 s for danger, role=status) ----
  const TOAST_ICON = { ok: 'check-circle', warn: 'alert-triangle', danger: 'alert-circle', info: 'info', neutral: null };
  const toasts = { host: null, items: [] };
  function dismissToast(item, immediate) {
    const i = toasts.items.indexOf(item);
    if (i < 0) return;
    toasts.items.splice(i, 1);
    clearTimeout(item.timer);
    if (immediate || reduced()) { item.el.remove(); return; }
    item.el.classList.remove('is-in');
    setTimeout(() => item.el.remove(), 200);
  }
  function toast(msg, kind, opts) {
    opts = opts || {}; kind = kindOf(kind);
    if (!toasts.host) { toasts.host = el('div', { class: 'toasts' }); document.body.appendChild(toasts.host); }
    while (toasts.items.length >= 3) dismissToast(toasts.items[0], true);
    const item = { el: null, timer: null, left: opts.timeout != null ? opts.timeout : (kind === 'danger' ? 8000 : 4000), started: 0 };
    const action = opts.action && opts.action.label ? el('button', { type: 'button', class: 'btn btn--ghost btn--sm toast__action',
      on: { click: () => { dismissToast(item); if (typeof opts.action.onClick === 'function') opts.action.onClick(); } } }, opts.action.label) : null;
    item.el = el('div', { class: 'toast toast--' + kind, role: 'status', 'data-testid': 'toast', 'data-kind': kind },
      TOAST_ICON[kind] ? html(MDM.icon(TOAST_ICON[kind], 16)) : null, el('span', { class: 'toast__text' }, msg), action);
    // Hovering or focusing a toast pauses its timer so an action button stays reachable.
    const start = () => { if (item.left > 0 && !item.timer) { item.started = Date.now(); item.timer = setTimeout(() => dismissToast(item), item.left); } };
    const pause = () => { if (item.timer) { clearTimeout(item.timer); item.timer = null; item.left = Math.max(1000, item.left - (Date.now() - item.started)); } };
    item.el.addEventListener('mouseenter', pause); item.el.addEventListener('focusin', pause);
    item.el.addEventListener('mouseleave', start); item.el.addEventListener('focusout', start);
    toasts.host.appendChild(item.el); toasts.items.push(item);
    if (reduced()) item.el.classList.add('is-in'); else requestAnimationFrame(() => item.el.classList.add('is-in'));
    start();
    return { el: item.el, dismiss: () => dismissToast(item) };
  }

  // ---- Drawer (one instance; right side; focus trap; Escape; backdrop; focus restore) ----
  const drawer = (function () {
    const st = { built: false, open: false, opener: null, onClose: null, timer: null, prevOverflow: '' };
    let backdrop, panel, titleEl, badgeEl, bodyEl, footerEl;
    function build() {
      if (st.built) return;
      st.built = true;
      backdrop = el('div', { class: 'drawer-backdrop', hidden: true, on: { click: () => close('backdrop') } });
      titleEl = el('h2', { class: 'drawer__title', id: 'mdm-drawer-title' });
      badgeEl = el('span', { class: 'drawer__badge', hidden: true });
      bodyEl = el('div', { class: 'drawer__body' });
      footerEl = el('div', { class: 'drawer__footer', hidden: true });
      panel = el('aside', { class: 'drawer drawer--md', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mdm-drawer-title', tabindex: '-1', hidden: true, 'data-testid': 'drawer' },
        el('div', { class: 'drawer__header' },
          el('div', { class: 'drawer__heading' }, titleEl, badgeEl),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm drawer__close', 'data-testid': 'drawer-close', on: { click: () => close('button') } },
            html(MDM.icon('x', 16)), el('span', { class: 'sr-only' }, 'Close'))),
        bodyEl, footerEl);
      document.body.appendChild(backdrop); document.body.appendChild(panel);
    }
    const dialogOpen = () => !!document.querySelector('dialog[open]');
    function onKey(e) {
      if (!st.open || dialogOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); close('escape'); return; }
      if (e.key !== 'Tab') return;
      const f = focusables(panel);
      if (!f.length) { e.preventDefault(); panel.focus(); return; }
      const first = f[0], last = f[f.length - 1], active = document.activeElement, inside = panel.contains(active);
      if (e.shiftKey && (active === first || active === panel || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
    }
    function onFocusIn(e) {
      const t = e.target;
      if (!st.open || !t || !t.closest || panel.contains(t) || t.closest('dialog[open], .toasts')) return;
      (focusables(panel)[0] || panel).focus();
    }
    function setTitle(text) { titleEl.textContent = text == null ? '' : String(text); }
    function setBadge(markup) { badgeEl.innerHTML = markup || ''; badgeEl.hidden = !markup; }
    function setBody(node) { bodyEl.replaceChildren(); append(bodyEl, node); bodyEl.scrollTop = 0; }
    function setFooter(node) { footerEl.replaceChildren(); append(footerEl, node); footerEl.hidden = !footerEl.childNodes.length; }
    // open({ title, badge (HTML string), body (Node|string text|array), footer (Node), size:'md'|'lg', onClose(reason) }) → panel.
    // Calling open() while open replaces the content in place (no re-animation; the original opener keeps focus restore).
    function open(opts) {
      opts = opts || {}; build();
      const wasOpen = st.open;
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      if (!wasOpen) { const a = document.activeElement; st.opener = a && a !== document.body && !panel.contains(a) ? a : null; }
      st.onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
      const size = opts.size === 'lg' ? 'lg' : 'md';
      panel.classList.toggle('drawer--lg', size === 'lg'); panel.classList.toggle('drawer--md', size === 'md'); panel.dataset.size = size;
      setTitle(opts.title); setBadge(opts.badge); setBody(opts.body); setFooter(opts.footer);
      if (!wasOpen) {
        backdrop.hidden = false; panel.hidden = false;
        st.prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; document.body.classList.add('has-drawer');
        document.addEventListener('keydown', onKey); document.addEventListener('focusin', onFocusIn);
        void panel.offsetWidth;   // commit the hidden → shown state so the transform transition runs
        backdrop.classList.add('is-open'); panel.classList.add('is-open');
        st.open = true;
        try { panel.focus({ preventScroll: true }); } catch (e) { panel.focus(); }
      }
      return panel;
    }
    function close(reason) {
      if (!st.open) return;
      st.open = false;
      document.removeEventListener('keydown', onKey); document.removeEventListener('focusin', onFocusIn);
      backdrop.classList.remove('is-open'); panel.classList.remove('is-open');
      document.body.style.overflow = st.prevOverflow; document.body.classList.remove('has-drawer');
      const onClose = st.onClose, opener = st.opener;
      st.onClose = null; st.opener = null;
      if (opener && document.contains(opener) && !dialogOpen()) { try { opener.focus({ preventScroll: true }); } catch (e) { /* opener not focusable any more */ } }
      const finish = () => { st.timer = null; backdrop.hidden = true; panel.hidden = true; bodyEl.replaceChildren(); footerEl.replaceChildren(); footerEl.hidden = true; };
      st.timer = setTimeout(finish, reduced() ? 0 : 200);
      if (onClose) onClose(reason || 'api');
    }
    return { open, close, isOpen: () => st.open, setBody, setFooter, setTitle, setBadge, el: () => { build(); return panel; }, bodyEl: () => { build(); return bodyEl; } };
  })();

  // ---- Native <dialog>: confirm() and dialog() ----
  // mount({ title, message, content, okLabel, cancelLabel, danger, testid, focus, onOk() → false keeps it open, onDone() }) → Promise<'ok'|''>
  function mountDialog(o) {
    return new Promise(resolve => {
      const titleId = uid('dlg-title');
      const okBtn = el('button', { type: 'submit', class: 'btn ' + (o.danger ? 'btn--danger' : 'btn--primary'), 'data-testid': o.testid + '-ok' }, o.okLabel || 'Confirm');
      const cancelBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'data-testid': o.testid + '-cancel', on: { click: () => dlg.close('') } }, o.cancelLabel || 'Cancel');
      const form = el('form', { method: 'dialog', class: 'dialog__form', novalidate: true },
        el('h2', { class: 'dialog__title', id: titleId }, o.title || ''),
        o.message ? el('p', { class: 'dialog__message' }, o.message) : null,
        o.content || null,
        el('div', { class: 'dialog__actions' }, cancelBtn, okBtn));
      const dlg = el('dialog', { class: 'dialog', 'aria-labelledby': titleId, 'data-testid': o.testid }, form);
      form.addEventListener('submit', e => { e.preventDefault(); if (!o.onOk || o.onOk() !== false) dlg.close('ok'); });
      // A click outside the dialog box (on the ::backdrop) cancels; clicks on the box's own padding hit the dialog element too, so test by rect.
      dlg.addEventListener('click', e => {
        if (e.target !== dlg) return;
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close('');
      });
      dlg.addEventListener('close', () => { const v = dlg.returnValue === 'ok' ? 'ok' : ''; dlg.remove(); if (o.onDone) o.onDone(); resolve(v); });
      document.body.appendChild(dlg);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      const f = o.focus || (o.danger ? cancelBtn : okBtn);
      try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); }
    });
  }
  function confirm(opts) {
    opts = opts || {};
    return mountDialog({ title: opts.title, message: opts.message, okLabel: opts.okLabel, cancelLabel: opts.cancelLabel, danger: !!opts.danger, testid: 'confirm' }).then(v => v === 'ok');
  }

  function fieldValue(f, ctrl) {
    switch (f.type) {
      case 'number': { const s = String(ctrl.value || '').trim(); return s === '' ? null : Number(s); }
      case 'checkbox': return !!ctrl.checked;
      case 'segmented': { const c = ctrl.querySelector('input:checked'); return c ? c.value : null; }
      case 'file': return ctrl.files && ctrl.files[0] || null;
      case 'select': return ctrl.value;
      default: return String(ctrl.value == null ? '' : ctrl.value).trim();
    }
  }
  const isBlank = v => v == null || v === '' || v === false || (typeof v === 'number' && isNaN(v));
  // Builds one .field for dialog(); returns { wrap, ctrl (the element read by fieldValue), focusEl, urls }.
  function buildField(f, prefix, urls) {
    const id = prefix + '-' + f.name, testid = 'dialog-' + f.name, type = f.type || 'text';
    const optional = !f.required && type !== 'checkbox' ? el('span', { class: 'optional' }, ' (optional)') : null;
    const hint = f.hint ? el('div', { class: 'field__hint', id: id + '-hint' }, f.hint) : null;
    const describe = hint ? id + '-hint' : null;
    const wrap = el('div', { class: 'field field--' + type, 'data-field': f.name });
    let ctrl, focusEl;
    if (type === 'select') {
      ctrl = el('select', { class: 'select', id, name: f.name, 'data-testid': testid, 'aria-describedby': describe },
        f.placeholder ? el('option', { value: '' }, f.placeholder) : null,
        (f.options || []).map(o => el('option', { value: o.value, disabled: !!o.disabled }, o.label)));
      if (f.value != null) ctrl.value = f.value;
      wrap.append(el('label', { for: id }, f.label, optional), ctrl);
    } else if (type === 'textarea') {
      ctrl = el('textarea', { class: 'textarea', id, name: f.name, 'data-testid': testid, rows: f.rows || 3, placeholder: f.placeholder, maxlength: f.maxlength, 'aria-describedby': describe, value: f.value == null ? '' : f.value });
      wrap.append(el('label', { for: id }, f.label, optional), ctrl);
    } else if (type === 'segmented') {
      ctrl = el('fieldset', { class: 'segmented', id, 'data-testid': testid, 'aria-labelledby': id + '-label', 'aria-describedby': describe },
        (f.options || []).map(o => el('label', { class: 'segmented__option' },
          el('input', { class: 'sr-only', type: 'radio', name: f.name, value: o.value, checked: f.value != null && String(f.value) === String(o.value), 'data-testid': testid + '-' + o.value }),
          el('span', null, o.label, o.hint ? el('small', null, o.hint) : null))));
      wrap.append(el('span', { class: 'field__label', id: id + '-label' }, f.label, optional), ctrl);
      focusEl = () => ctrl.querySelector('input:checked') || ctrl.querySelector('input');
    } else if (type === 'file') {
      const nameEl = el('span', { class: 'file-pick__name' }, f.emptyLabel || 'No file chosen');
      const thumb = el('img', { class: 'file-pick__thumb', alt: '', hidden: true });
      ctrl = el('input', { class: 'sr-only', type: 'file', id, name: f.name, 'data-testid': testid, accept: f.accept, capture: f.capture, 'aria-labelledby': id + '-label', 'aria-describedby': describe });
      const btn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => ctrl.click() } }, html(MDM.icon('upload', 16)), f.buttonLabel || 'Choose a file');
      ctrl.addEventListener('change', () => {
        const file = ctrl.files && ctrl.files[0];
        nameEl.textContent = file ? file.name + ' · ' + formatBytes(file.size) : (f.emptyLabel || 'No file chosen');
        if (thumb.src) { URL.revokeObjectURL(thumb.src); thumb.removeAttribute('src'); }
        if (file && /^image\//.test(file.type)) { const u = URL.createObjectURL(file); urls.push(u); thumb.src = u; thumb.hidden = false; } else thumb.hidden = true;
      });
      wrap.append(el('span', { class: 'field__label', id: id + '-label' }, f.label, optional), el('div', { class: 'file-pick' }, thumb, btn, nameEl), ctrl);
      focusEl = () => btn;
    } else if (type === 'checkbox') {
      ctrl = el('input', { type: 'checkbox', id, name: f.name, 'data-testid': testid, checked: !!f.value, 'aria-describedby': describe });
      wrap.append(el('label', { class: 'checkbox', for: id }, ctrl, el('span', null, f.label, hint)));
      if (hint) hint.classList.add('hint');
    } else {
      const attrs = { class: 'input', id, name: f.name, type: type === 'tel' ? 'tel' : type, 'data-testid': testid, placeholder: f.placeholder, value: f.value == null ? '' : f.value,
        min: f.min, max: f.max, step: f.step, maxlength: f.maxlength, autocomplete: f.autocomplete, inputmode: f.inputmode, 'aria-describedby': describe };
      if (type === 'tel') { attrs.inputmode = attrs.inputmode || 'numeric'; attrs.autocomplete = attrs.autocomplete || 'tel'; }
      if (type === 'number') { attrs.inputmode = attrs.inputmode || (f.step && String(f.step).indexOf('.') >= 0 ? 'decimal' : 'numeric'); }
      ctrl = el('input', attrs);
      wrap.append(el('label', { for: id }, f.label, optional), ctrl);
    }
    if (hint && type !== 'checkbox') wrap.append(hint);
    wrap.append(el('div', { class: 'field__error', id: id + '-error', hidden: true }));
    return { wrap, ctrl, focusEl: focusEl || (() => ctrl) };
  }
  // dialog({ title, message, fields, okLabel, cancelLabel, danger, validate(values) → string | { field: msg } | null }) → Promise<values|null>
  function dialog(opts) {
    opts = opts || {};
    const prefix = uid('dlg'), urls = [], fields = opts.fields || [], parts = {};
    const formError = el('div', { class: 'field__error dialog__error', role: 'alert', hidden: true });
    const body = el('div', { class: 'dialog__fields' });
    fields.forEach(f => {
      const p = buildField(f, prefix, urls);
      parts[f.name] = p; body.appendChild(p.wrap);
      p.wrap.addEventListener('input', () => { setError(p.wrap, null); formError.hidden = true; formError.textContent = ''; });
      p.wrap.addEventListener('change', () => { setError(p.wrap, null); formError.hidden = true; formError.textContent = ''; });
    });
    body.appendChild(formError);
    let values = null;
    function check() {
      values = {};
      let first = null;
      const fail = (name, msg) => { const p = parts[name]; if (!p) return; setError(p.wrap, msg); if (!first) first = p.focusEl(); };
      fields.forEach(f => {
        const v = fieldValue(f, parts[f.name].ctrl);
        values[f.name] = v;
        let msg = null;
        if (f.required && isBlank(v)) msg = f.requiredMessage || 'This field is required';
        else if (f.type === 'number' && v != null && isNaN(v)) msg = 'Enter a number';
        else if (f.type === 'number' && v != null && f.min != null && v < Number(f.min)) msg = 'Enter at least ' + f.min;
        else if (f.type === 'number' && v != null && f.max != null && v > Number(f.max)) msg = 'Enter at most ' + f.max;
        else if (f.type === 'tel' && v && !phone.valid(v, { landline: !!f.landline, intl: !!f.intl })) msg = f.invalidMessage || 'Enter a valid Maldivian mobile number';
        else if (typeof f.validate === 'function') msg = f.validate(v, values) || null;
        if (msg) fail(f.name, msg);
      });
      if (!first && typeof opts.validate === 'function') {
        const r = opts.validate(values);
        if (typeof r === 'string' && r) { formError.textContent = r; formError.hidden = false; first = (fields[0] && parts[fields[0].name].focusEl()) || null; }
        else if (r && typeof r === 'object') Object.keys(r).forEach(n => { if (r[n]) fail(n, r[n]); });
      }
      if (first) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } return false; }
      return true;
    }
    const firstFocus = fields.length ? parts[fields[0].name].focusEl() : null;
    return mountDialog({ title: opts.title, message: opts.message, content: body, okLabel: opts.okLabel, cancelLabel: opts.cancelLabel, danger: !!opts.danger, testid: 'dialog',
      focus: firstFocus, onOk: check, onDone: () => urls.forEach(u => URL.revokeObjectURL(u)) }).then(v => v === 'ok' ? values : null);
  }

  // ---- Phone (Maldives: mobile 7xxxxxx | 9xxxxxx, landline 3xxxxxx; international as +digits) ----
  const phone = {
    // normalize('+960 777 1234') → '7771234'; '+44 20 7946 0958' → '+442079460958'; anything else → null
    normalize(raw) {
      const s = String(raw == null ? '' : raw).trim();
      if (!s) return null;
      let digits = s.replace(/\D/g, '');
      const plus = s.charAt(0) === '+' || /^00\d/.test(digits);
      if (/^00\d/.test(digits)) digits = digits.slice(2);
      const local = digits.length === 10 && digits.slice(0, 3) === '960' ? digits.slice(3) : (digits.length === 7 ? digits : null);
      if (local && /^[379]\d{6}$/.test(local)) return local;
      if (local && !plus) return null;
      if (digits.length >= 8 && digits.length <= 15 && !(digits.length === 10 && digits.slice(0, 3) === '960')) return '+' + digits;
      return null;
    },
    valid(raw, opts) {
      const n = phone.normalize(raw);
      if (!n) return false;
      if (n.charAt(0) === '+') return !!(opts && opts.intl);
      if (/^[79]\d{6}$/.test(n)) return true;
      return /^3\d{6}$/.test(n) && !!(opts && opts.landline);
    },
    format(raw) {
      const n = phone.normalize(raw);
      if (!n) return String(raw == null ? '' : raw).trim();
      if (n.charAt(0) !== '+') return '+960 ' + n.slice(0, 3) + ' ' + n.slice(3);
      const d = n.slice(1), groups = [];
      let i = 0;
      while (d.length - i > 4) { groups.push(d.slice(i, i + 3)); i += 3; }
      groups.push(d.slice(i));
      return '+' + groups.join(' ');
    },
    // links(raw, text?) → { tel, wa, viber, sms } or null when no digits at all. `sms:` uses ?body= (Android and current iOS).
    links(raw, text) {
      const n = phone.normalize(raw);
      const digits = n ? (n.charAt(0) === '+' ? n.slice(1) : '960' + n) : String(raw == null ? '' : raw).replace(/\D/g, '');
      if (!digits) return null;
      const q = text ? encodeURIComponent(text) : '';
      return { tel: 'tel:+' + digits, wa: 'https://wa.me/' + digits + (q ? '?text=' + q : ''), viber: 'viber://chat?number=%2B' + digits, sms: 'sms:+' + digits + (q ? '?body=' + q : '') };
    },
  };

  // ---- Dates (display only; all stored timestamps are ISO UTC strings) ----
  const pad2 = n => (n < 10 ? '0' : '') + n;
  function toDate(v) { if (v instanceof Date) return isNaN(v) ? null : v; if (v == null || v === '') return null; const d = new Date(v); return isNaN(d) ? null : d; }
  const hhmm = d => pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  // fmtDate(iso, { time=true, dateOnly, year }) → '21 Sep, 14:32' · '21 Sep' · '21 Sep 2025, 14:32' (year only when not the current year, or year:true)
  function fmtDate(iso, opts) {
    opts = opts || {};
    const d = toDate(iso);
    if (!d) return '';
    const withYear = opts.year != null ? !!opts.year : d.getFullYear() !== new Date().getFullYear();
    const date = d.getDate() + ' ' + MONTHS[d.getMonth()] + (withYear ? ' ' + d.getFullYear() : '');
    return (opts.dateOnly || opts.time === false) ? date : date + ', ' + hhmm(d);
  }
  function fmtTime(iso) { const d = toDate(iso); return d ? hhmm(d) : ''; }
  // timeAgo(iso, { seconds }) → 'just now' | '12 s ago' (seconds:true) | '4 min ago' (< 60 min) | fmtDate(iso)
  function timeAgo(iso, opts) {
    const d = toDate(iso);
    if (!d) return '';
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 0) return fmtDate(d);
    if (opts && opts.seconds && s < 60) return s + ' s ago';
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return Math.max(1, m) + ' min ago';
    return fmtDate(d);
  }
  function dayKey(v) { const d = toDate(v == null ? new Date() : v); return d ? d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) : ''; }
  function monthKey(v) { const d = toDate(v == null ? new Date() : v); return d ? d.getFullYear() + '-' + pad2(d.getMonth() + 1) : ''; }
  function windowLabel(str) {
    const m = String(str == null ? '' : str).match(/^\s*(\d{1,2}:\d{2})\s*(?:-|–|to)\s*(\d{1,2}:\d{2})\s*$/);
    return m ? m[1] + ' to ' + m[2] : String(str == null ? '' : str);
  }
  function minutesToHHMM(n) { n = ((Math.round(Number(n) || 0) % 1440) + 1440) % 1440; return pad2(Math.floor(n / 60)) + ':' + pad2(n % 60); }
  function parseHHMM(str) { const m = String(str == null ? '' : str).trim().match(/^(\d{1,2}):(\d{2})$/); if (!m) return null; const h = Number(m[1]), mi = Number(m[2]); return h > 23 || mi > 59 ? null : h * 60 + mi; }

  // ---- Money and bytes ----
  function fmtMoney(n, opts) {
    const v = Number(n) || 0, abs = Math.abs(v);
    const s = opts && opts.cents ? abs.toFixed(2) : String(Math.round(abs));
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 ? '−' : '') + 'MVR ' + parts.join('.');
  }
  function money(n, opts) { return MDM.pricing && typeof MDM.pricing.format === 'function' ? MDM.pricing.format(n, opts) : fmtMoney(n, opts); }
  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB';
  }

  // ---- Clipboard and files ----
  async function copy(text) {
    text = String(text == null ? '' : text);
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall back to execCommand */ }
    try {
      const ta = el('textarea', { class: 'sr-only', 'aria-hidden': 'true', readonly: true, value: text });
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error || new Error('file_read'));
      r.readAsDataURL(file);
    });
  }
  function loadImageEl(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image_decode')); };
      img.src = url;
    });
  }
  const loadImage = file => (typeof createImageBitmap === 'function' ? createImageBitmap(file).catch(() => loadImageEl(file)) : loadImageEl(file));
  // imageToJpeg(file, { maxEdge=1200, quality=0.8 }) → { dataUrl, size, type:'image/jpeg', width, height, blob }. Rejects with Error('image_decode') on bad input.
  async function imageToJpeg(file, opts) {
    opts = opts || {};
    const maxEdge = opts.maxEdge || 1200, quality = opts.quality == null ? 0.8 : opts.quality;
    const img = await loadImage(file);
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) throw new Error('image_decode');
    const scale = Math.min(1, maxEdge / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);   // JPEG has no alpha; transparent PNG areas become white, not black
    ctx.drawImage(img, 0, 0, w, h);
    if (typeof img.close === 'function') img.close();
    const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('image_encode')), 'image/jpeg', quality));
    const dataUrl = await fileToDataUrl(blob);
    return { dataUrl, size: blob.size, type: 'image/jpeg', width: w, height: h, blob };
  }

  MDM.ui = {
    el, html, esc, qs, qsa, on, debounce, scrollIntoViewIfNeeded,
    toast, drawer, confirm, dialog,
    badge, statusBadge, statusLabel, setError, validate, focusFirstInvalid, setLoading,
    phone, fmtDate, fmtTime, timeAgo, dayKey, monthKey, window: windowLabel, minutesToHHMM, parseHHMM,
    money, formatBytes, copy, fileToDataUrl, imageToJpeg,
  };
})(window.MDM);

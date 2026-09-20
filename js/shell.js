// Site chrome shared by every page: the public header (brand, nav, CTA, mobile menu), the notice bar, the footer (contact and hours
// from settings) and the admin sidebar/topbar. Everything is built with DOM APIs; text from settings is never injected as HTML.
// mount() runs once at load, fills the static markup right away and completes the settings-dependent parts after MDM.store.ready.
(function (MDM) { 'use strict';
  const BRAND = 'Mr. Delivery Man';
  const PUBLIC_NAV = [
    { label: 'Services', href: '#services', page: null },
    { label: 'Rates', href: '#rates', page: null },
    { label: 'Business', href: 'business/', page: 'business' },
    { label: 'Track an order', href: 'track/', page: 'track' },
  ];
  const FOOTER_LINKS = [
    { label: 'Request a delivery', href: 'request/' },
    { label: 'Track an order', href: 'track/' },
    { label: 'For businesses', href: 'business/' },
    { label: 'Rates', href: '#rates' },
    { label: 'Rider console', href: 'driver/' },
    { label: 'Admin', href: 'admin/' },
  ];
  const ADMIN_NAV = [
    { view: 'overview', label: 'Overview', icon: 'dashboard' },
    { view: 'orders', label: 'Orders', icon: 'package' },
    { view: 'live', label: 'Live map', icon: 'map' },
    { view: 'drivers', label: 'Riders', icon: 'bike' },
    { view: 'customers', label: 'Customers', icon: 'users' },
    { view: 'business', label: 'Business', icon: 'building' },
    { view: 'rates', label: 'Rates', icon: 'banknote' },
    { view: 'settings', label: 'Settings', icon: 'settings' },
  ];
  // Keys that are not sidebar views but count towards one: payment reviews and quotes are orders needing action, requests are business.
  const COUNT_ALIAS = { reviews: 'orders', quotes: 'orders', unassigned: 'orders', onHold: 'orders', requests: 'business', riders: 'live', online: 'live' };
  const HOT_VIEWS = { orders: true, business: true };

  // Minimal DOM builder: el(tag, { class, id, dataset, on:{ event: fn }, any attribute }, ...children) where children are Node | string | array | null.
  function el(tag, attrs) {
    const node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(k => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.keys(v).forEach(d => { node.dataset[d] = v[d]; });
      else if (k === 'on') Object.keys(v).forEach(ev => node.addEventListener(ev, v[ev]));
      else if (k === 'html') node.innerHTML = v;                       // only ever fed by MDM.icon()
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    for (let i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(c => append(node, c)); return; }
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  function iconNode(name, size) { const s = el('span', { class: 'icon-wrap', html: MDM.icon(name, size || 16) }); return s.firstChild; }
  function logo() { return '<span class="brand__word">' + BRAND + '</span>'; }
  function brandLink(href) { return el('a', { class: 'brand', href }, el('span', { class: 'brand__word' }, BRAND)); }

  // ---- Settings helpers ---------------------------------------------------------------------------------------------------
  let settingsCache = null;
  async function settings() {
    try { if (MDM.store && MDM.store.ready) { await MDM.store.ready; settingsCache = (await MDM.store.settings()) || {}; } }
    catch (e) { settingsCache = settingsCache || {}; }
    return settingsCache || {};
  }
  function digitsOf(raw) {
    let s = String(raw || '').replace(/[\s-]/g, '');
    s = s.replace(/^\+?960/, '');
    return s;
  }
  function phoneDisplay(raw) {
    const d = digitsOf(raw);
    if (!d) return '';
    return d.length === 7 ? '+960 ' + d.slice(0, 3) + ' ' + d.slice(3) : (String(raw).indexOf('+') === 0 ? String(raw) : '+960 ' + d);
  }
  function ownLinks(raw, text) {
    const d = digitsOf(raw);
    if (!d) return { tel: '', wa: '', viber: '', sms: '' };
    return {
      tel: 'tel:+960' + d,
      wa: 'https://wa.me/960' + d + (text ? '?text=' + encodeURIComponent(text) : ''),
      viber: 'viber://chat?number=%2B960' + d,
      sms: 'sms:+960' + d,
    };
  }
  function phoneLinks(raw, text) {
    const own = ownLinks(raw, text);
    const ui = MDM.ui && MDM.ui.phone && typeof MDM.ui.phone.links === 'function' ? MDM.ui.phone.links(raw, text) : null;
    if (!ui) return own;
    return { tel: ui.tel || own.tel, wa: ui.wa || own.wa, viber: ui.viber || own.viber, sms: ui.sms || own.sms };
  }
  // contactLinks({ text }) → { phone, display, tel, sms, whatsapp, whatsappDisplay, viber, viberDisplay, email, mailto } from settings.contact.
  // Reads the cached settings; call after MDM.store.ready (mount() has already done so on every page).
  function contactLinks(opts) {
    opts = opts || {};
    const c = (settingsCache && settingsCache.contact) || {};
    const phone = c.phone || '', wa = c.whatsapp || c.phone || '', vb = c.viber || c.phone || '';
    const main = phoneLinks(phone, opts.text), waL = phoneLinks(wa, opts.text), vbL = phoneLinks(vb, opts.text);
    return {
      phone, display: phoneDisplay(phone), tel: main.tel, sms: main.sms,
      whatsapp: waL.wa, whatsappDisplay: phoneDisplay(wa), viber: vbL.viber, viberDisplay: phoneDisplay(vb),
      email: c.email || '', mailto: c.email ? 'mailto:' + c.email : '',
    };
  }

  // ---- Opening hours ------------------------------------------------------------------------------------------------------
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function toMin(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function closedWindowEnd(ops, d) {
    const cur = d.getHours() * 60 + d.getMinutes();
    const wins = Array.isArray(ops.closedWindows) ? ops.closedWindows : [];
    for (const w of wins) {
      const m = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+)?(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(String(w).trim());
      if (!m) continue;
      if (m[1] && m[1] !== DAYS[d.getDay()]) continue;
      const a = toMin(m[2]), b = toMin(m[3]);
      if (a != null && b != null && cur >= a && cur < b) return m[3];
    }
    return null;
  }
  // hoursLine(settings?, date?) → 'Open today 09:00 to 23:00 · Malé and Hulhumalé' or 'Closed now, open from 09:00' in local time.
  function hoursLine(s, date) {
    s = s || settingsCache || {};
    const ops = s.ops || {}, hours = ops.hours || {};
    const open = hours.open || '09:00', close = hours.close || '23:00';
    const d = date || new Date();
    const cur = d.getHours() * 60 + d.getMinutes();
    const a = toMin(open), b = toMin(close);
    const isOpen = a == null || b == null ? true : (a <= b ? cur >= a && cur < b : cur >= a || cur < b);
    const pause = closedWindowEnd(ops, d);
    if (pause) return 'Closed now, open from ' + pause;
    if (!isOpen) return 'Closed now, open from ' + open;
    return 'Open today ' + open + ' to ' + close + ' · Malé and Hulhumalé';
  }

  // ---- Public header ------------------------------------------------------------------------------------------------------
  function renderHeader(header) {
    header.classList.add('site-header');
    header.textContent = '';
    const page = document.body.dataset.page || '';
    const nav = el('nav', { class: 'site-nav', id: 'site-nav', 'aria-label': 'Main' });
    PUBLIC_NAV.forEach(item => {
      const a = el('a', { href: MDM.href(item.href) }, item.label);
      if (item.page && item.page === page) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    });
    nav.appendChild(el('a', { class: 'btn btn--primary site-nav__cta', href: MDM.href('request/') }, 'Request a delivery'));
    const toggle = el('button', { type: 'button', class: 'btn btn--ghost btn--icon site-header__toggle', 'aria-expanded': 'false', 'aria-controls': 'site-nav', 'aria-label': 'Menu' }, iconNode('menu', 20));
    const actions = el('div', { class: 'site-header__actions' },
      el('a', { class: 'btn btn--primary', href: MDM.href('request/') }, 'Request a delivery'), toggle);
    header.appendChild(el('div', { class: 'container' }, brandLink(MDM.href('')), nav, actions));

    let open = false;
    function setOpen(v) {
      open = !!v;
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.innerHTML = MDM.icon(open ? 'x' : 'menu', 20);
      if (open) { const first = nav.querySelector('a'); if (first) first.focus(); }
    }
    toggle.addEventListener('click', () => setOpen(!open));
    nav.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) { setOpen(false); toggle.focus(); } });
    document.addEventListener('click', e => { if (open && !header.contains(e.target)) setOpen(false); });
    const mq = window.matchMedia('(min-width: 861px)');
    const onMq = () => { if (mq.matches && open) setOpen(false); };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
  }

  function renderNotice(header, s) {
    let bar = document.querySelector('[data-shell="notice"]');
    const n = (s && s.notice) || {};
    const text = String(n.text || '').trim();
    if (!n.active || !text) { if (bar) bar.remove(); return; }
    if (!bar) { bar = el('div', { class: 'notice-bar', 'data-shell': 'notice', role: 'status' }); header.insertAdjacentElement('afterend', bar); }
    bar.textContent = '';
    bar.appendChild(el('div', { class: 'container' }, text));
  }

  // ---- Footer -------------------------------------------------------------------------------------------------------------
  function renderFooter(footer, s) {
    footer.classList.add('site-footer');
    footer.textContent = '';
    const c = contactLinks();
    const contact = el('p', { class: 'site-footer__contact' });
    const parts = [];
    if (c.tel) parts.push(el('a', { href: c.tel, class: 'mono' }, c.display));
    if (c.whatsapp) parts.push(el('a', { href: c.whatsapp, target: '_blank', rel: 'noopener' }, 'WhatsApp'));
    if (c.viber) parts.push(el('a', { href: c.viber }, 'Viber'));
    if (c.mailto) parts.push(el('a', { href: c.mailto }, c.email));
    parts.forEach((p, i) => { if (i) contact.appendChild(document.createTextNode(' · ')); contact.appendChild(p); });
    const hours = el('p', { class: 'site-footer__hours', 'data-shell': 'hours' }, hoursLine(s));
    const links = el('nav', { class: 'site-footer__links', 'aria-label': 'Site' });
    FOOTER_LINKS.forEach((l, i) => { if (i) links.appendChild(document.createTextNode(' · ')); links.appendChild(el('a', { href: MDM.href(l.href) }, l.label)); });
    footer.appendChild(el('div', { class: 'container' },
      el('div', { class: 'site-footer__main' }, el('div', { class: 'site-footer__left' }, contact, hours), links),
      el('p', { class: 'site-footer__bottom' }, BRAND + ' · Greater Malé · Prices in MVR')));
  }

  // ---- Admin shell --------------------------------------------------------------------------------------------------------
  const admin = { root: null, sidebar: null, topbar: null, title: null, menu: null, backdrop: null, open: false };
  function currentView() { const m = /^#\/([a-z_-]+)/i.exec(location.hash || ''); return m ? m[1].toLowerCase() : 'overview'; }
  function setActive(view) {
    if (!admin.sidebar) return;
    view = view || currentView();
    admin.sidebar.querySelectorAll('.sidebar__nav a[data-view]').forEach(a => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    const item = ADMIN_NAV.find(n => n.view === view);
    if (item && admin.title && !admin.title.dataset.custom) admin.title.textContent = item.label;
  }
  function setTitle(t) { if (admin.title) { admin.title.textContent = t == null ? '' : String(t); admin.title.dataset.custom = t == null ? '' : '1'; } }
  // setCounts({ orders, live, drivers, customers, business, reviews, quotes, requests, … }): a number fills the chip (hidden at 0);
  // { value, hot } controls the warn tint; alias keys (reviews, quotes, requests…) add to their view and mark it hot.
  function setCounts(counts) {
    if (!admin.sidebar) return;
    const sum = {}, hot = {};
    Object.keys(counts || {}).forEach(k => {
      const raw = counts[k];
      const v = raw && typeof raw === 'object' ? Number(raw.value) || 0 : Number(raw) || 0;
      const view = COUNT_ALIAS[k] || k;
      sum[view] = (sum[view] || 0) + v;
      if ((raw && typeof raw === 'object' && raw.hot) || (COUNT_ALIAS[k] && HOT_VIEWS[view] && v > 0)) hot[view] = true;
    });
    admin.sidebar.querySelectorAll('.count[data-count]').forEach(chip => {
      const v = sum[chip.dataset.count] || 0;
      chip.textContent = v ? String(v) : '';
      chip.hidden = !v;
      chip.classList.toggle('is-hot', !!hot[chip.dataset.count] && v > 0);
    });
  }
  function setSidebarOpen(v) {
    admin.open = !!v;
    admin.sidebar.classList.toggle('is-open', admin.open);
    admin.menu.setAttribute('aria-expanded', admin.open ? 'true' : 'false');
    if (admin.open) {
      if (!admin.backdrop) { admin.backdrop = el('div', { class: 'sidebar-backdrop', on: { click: () => setSidebarOpen(false) } }); admin.root.appendChild(admin.backdrop); }
      const first = admin.sidebar.querySelector('.sidebar__nav a'); if (first) first.focus();
    } else if (admin.backdrop) { admin.backdrop.remove(); admin.backdrop = null; }
  }
  // setChrome(false) hides the sidebar and topbar (admin login state) and drops the two-column grid so <main> spans the page.
  function setChrome(visible) {
    if (!admin.root) return;
    admin.sidebar.hidden = !visible; admin.topbar.hidden = !visible;
    admin.root.classList.toggle('admin', !!visible);
    admin.root.dataset.chrome = visible ? 'on' : 'off';
    if (!visible) setSidebarOpen(false);
  }
  function renderAdmin(root) {
    if (root.dataset.shellMounted) return;
    root.dataset.shellMounted = '1';
    root.classList.add('admin');
    admin.root = root;
    const main = root.querySelector('main') || el('main', { id: 'main' });
    const nav = el('nav', { class: 'sidebar__nav', 'aria-label': 'Admin' });
    ADMIN_NAV.forEach(item => {
      nav.appendChild(el('a', { href: MDM.href('admin/#/' + item.view), 'data-view': item.view },
        iconNode(item.icon, 16), el('span', { class: 'sidebar__label' }, item.label), el('span', { class: 'count', 'data-count': item.view, hidden: true })));
    });
    const signout = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'admin-signout',
      on: { click: e => { e.currentTarget.dispatchEvent(new CustomEvent('mdm:signout', { bubbles: true })); } } }, iconNode('log-out', 16), 'Sign out');
    admin.sidebar = el('aside', { class: 'sidebar', id: 'admin-sidebar' },
      el('div', { class: 'sidebar__brand' }, brandLink(MDM.href('admin/#/overview'))),
      nav,
      el('div', { class: 'sidebar__foot' }, el('span', {}, 'Signed in as Admin'), signout));
    admin.menu = el('button', { type: 'button', class: 'btn btn--ghost btn--icon topbar__menu', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'admin-sidebar',
      on: { click: () => setSidebarOpen(!admin.open) } }, iconNode('menu', 20));
    admin.title = el('span', { class: 'topbar__title' }, 'Overview');
    admin.topbar = el('div', { class: 'topbar' }, admin.menu, admin.title);
    const mainWrap = el('div', { class: 'admin__main' }, admin.topbar, main);
    root.textContent = '';
    root.appendChild(admin.sidebar);
    root.appendChild(mainWrap);
    nav.addEventListener('click', e => { if (e.target.closest('a')) setSidebarOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && admin.open) { setSidebarOpen(false); admin.menu.focus(); } });
    window.addEventListener('hashchange', () => { if (admin.title) delete admin.title.dataset.custom; setActive(); });
    const mq = window.matchMedia('(min-width: 961px)');
    const onMq = () => { if (mq.matches && admin.open) setSidebarOpen(false); };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    setActive();
  }

  // ---- Mount --------------------------------------------------------------------------------------------------------------
  let mounted = null, hoursTimer = null;
  function startAutopilot(s) {
    if (!(s && s.demo && s.demo.autopilot)) return;
    if (MDM.live && typeof MDM.live.autopilot === 'function') { try { MDM.live.autopilot(); } catch (e) { /* the shell must render even if the demo autopilot cannot start */ } }
  }
  function mount() {
    if (mounted) return mounted;
    const header = document.querySelector('header[data-shell="public"]');
    const footer = document.querySelector('footer[data-shell="public-footer"]');
    const adminRoot = document.querySelector('[data-shell="admin"]');
    if (header) renderHeader(header);
    if (adminRoot) renderAdmin(adminRoot);
    mounted = (async () => {
      const s = await settings();
      if (header) renderNotice(header, s);
      if (footer) renderFooter(footer, s);
      startAutopilot(s);
      if (MDM.store && typeof MDM.store.subscribe === 'function') {
        try {
          MDM.store.subscribe('settings', () => { refresh().catch(() => {}); });
          MDM.store.subscribe('*', msg => { if (msg && msg.op === 'reset') refresh().catch(() => {}); });
        } catch (e) { /* a store without a settings channel still renders once */ }
      }
      if (footer && !hoursTimer) hoursTimer = setInterval(() => { const h = footer.querySelector('[data-shell="hours"]'); if (h) h.textContent = hoursLine(); }, 60000);
    })();
    return mounted;
  }
  async function refresh() {
    const s = await settings();
    const header = document.querySelector('header[data-shell="public"]');
    const footer = document.querySelector('footer[data-shell="public-footer"]');
    if (header) renderNotice(header, s);
    if (footer) renderFooter(footer, s);
    startAutopilot(s);
  }

  MDM.logo = logo;
  MDM.shell = { mount, refresh, contactLinks, hoursLine, phoneDisplay, phoneLinks, setTitle, setCounts, setActive, setChrome, setSidebarOpen, el, BRAND };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mount(); });
  else mount();
})(window.MDM);

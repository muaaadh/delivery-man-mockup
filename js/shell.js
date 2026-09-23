// Site chrome shared by every page: the public header (brand, nav, CTA, mobile menu), the notice bar, the footer (contact and hours
// from settings) and the admin sidebar/topbar. Everything is built with DOM APIs; text from settings is never injected as HTML.
// mount() runs once at load, fills the static markup right away and completes the settings-dependent parts after MDM.store.ready.
(function (MDM) { 'use strict';
  const BRAND = 'Mr. Delivery Man';
  const PUBLIC_NAV = [
    { label: 'Services', href: '#services', page: null },
    { label: 'How it works', href: '#how', page: null },
    { label: 'Rates', href: '#rates', page: null },
    { label: 'Business', href: 'business/', page: 'business' },
    { label: 'Track an order', href: 'track/', page: 'track' },
  ];
  const FOOTER_COLUMNS = [
    { title: 'Services', links: [{ label: 'Pick & deliver', href: 'request/' }, { label: 'Shop & deliver', href: 'request/' }, { label: 'For businesses', href: 'business/' }, { label: 'Rates', href: '#rates' }] },
    { title: 'Your orders', links: [{ label: 'Request a delivery', href: 'request/' }, { label: 'Track an order', href: 'track/' }, { label: 'My orders', href: 'account/' }, { label: 'Questions', href: '#faq' }] },
    { title: 'Team', links: [{ label: 'Customer sign-in', href: 'login/' }, { label: 'Rider sign-in', href: 'login/?as=rider' }, { label: 'Admin sign-in', href: 'login/?as=admin' }] },
  ];
  const ADMIN_NAV = [
    { view: 'overview', label: 'Overview', icon: 'dashboard', group: 'Operations' },
    { view: 'orders', label: 'Orders', icon: 'package', group: 'Operations' },
    { view: 'live', label: 'Live map', icon: 'map', group: 'Operations' },
    { view: 'drivers', label: 'Riders', icon: 'bike', group: 'Operations' },
    { view: 'customers', label: 'Customers', icon: 'users', group: 'Accounts' },
    { view: 'business', label: 'Business', icon: 'building', group: 'Accounts' },
    { view: 'rates', label: 'Rates', icon: 'banknote', group: 'Setup' },
    { view: 'settings', label: 'Settings', icon: 'settings', group: 'Setup' },
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
  // The mark: the client's rider (traced from their logo) in white on a brand-red tile.
  const RIDER = '<svg viewBox="226 99 640 520" aria-hidden="true" focusable="false"><g transform="translate(0,1080) scale(0.1,-0.1)" fill="currentColor"><path d="M5057 9556 c-239 -69 -387 -285 -349 -508 19 -107 94 -239 160 -279 28 -18 701 -199 763 -207 34 -4 38 -1 69 48 43 66 78 155 82 205 l3 40 -50 -3 c-119 -8 -301 62 -403 153 -54 49 -92 109 -77 124 8 8 409 51 470 51 23 0 18 35 -14 98 -58 114 -166 208 -299 259 -83 32 -275 42 -355 19z M3803 9365 c-90 -38 -243 -245 -243 -329 0 -18 2 -17 19 9 50 82 130 109 175 60 29 -31 38 -28 71 25 20 31 26 58 31 132 8 110 0 125 -53 103z M3832 9069 c-122 -170 -150 -215 -140 -224 24 -22 827 -565 835 -565 12 1 278 397 278 414 0 15 -773 575 -805 583 -10 3 -65 -66 -168 -208z M6300 8791 l-65 -6 -38 -75 c-64 -127 -97 -367 -68 -493 13 -53 13 -53 83 -22 433 190 461 200 540 185 177 -34 229 -229 85 -314 -44 -27 -67 -21 -67 16 0 36 -54 78 -100 78 -107 0 -161 -83 -108 -168 l22 -35 -27 -21 c-15 -12 -142 -77 -281 -145 l-255 -124 -377 113 -376 113 -90 -7 c-49 -4 -102 -9 -118 -12 -23 -5 -150 -104 -158 -124 -2 -6 42 -24 375 -150 223 -85 317 -179 316 -316 -1 -92 -31 -145 -206 -362 -86 -106 -159 -198 -163 -204 -10 -15 -32 -23 561 192 292 105 559 202 595 214 l65 23 17 72 c9 40 18 75 21 77 2 2 40 -14 84 -36 l81 -40 271 98 c149 53 271 100 271 104 0 3 -48 32 -107 64 -246 130 -393 217 -393 231 0 111 349 308 760 428 69 20 131 39 138 41 50 15 -124 226 -275 333 -289 206 -652 304 -1013 272z M3320 8694 c-129 -53 -390 -158 -580 -235 -190 -76 -345 -142 -344 -146 0 -5 34 -17 75 -28 89 -25 95 -38 44 -101 -21 -25 -35 -47 -32 -50 2 -3 161 68 353 157 192 89 400 184 461 212 l113 50 80 113 c79 111 87 125 73 123 -5 0 -114 -43 -243 -95z M3355 8408 l-139 -191 32 -27 c50 -42 810 -580 819 -580 4 0 24 24 44 53 19 28 79 116 133 194 53 79 95 147 92 152 -3 5 -104 78 -223 162 -120 84 -305 215 -412 291 -107 76 -197 138 -201 138 -4 0 -69 -86 -145 -192z M7465 7809 c-88 -13 -191 -46 -266 -85 -67 -35 -180 -120 -186 -140 -2 -5 81 -57 184 -113 l187 -104 66 16 c144 36 220 30 336 -28 375 -184 313 -734 -93 -840 -243 -63 -507 103 -552 347 -11 65 -13 66 -158 137 -70 34 -135 67 -143 72 -8 5 -31 18 -51 29 l-37 19 -7 -26 c-3 -14 -6 -71 -6 -127 -1 -625 657 -1034 1216 -757 524 259 637 938 227 1358 -176 179 -471 279 -717 242z M3920 7500 c-113 -20 -775 -128 -1008 -165 -160 -25 -192 -42 -192 -99 0 -74 -43 -55 999 -450 91 -35 169 -70 175 -78 9 -15 -103 -294 -195 -486 -17 -35 -29 -66 -26 -68 2 -3 47 11 98 30 52 19 202 74 334 121 132 47 260 93 285 102 53 19 70 37 70 73 0 94 35 147 299 450 l153 175 -234 6 c-128 3 -247 10 -263 16 -140 48 -237 149 -301 317 -33 89 -22 85 -194 56z M7218 7167 c-141 -51 -259 -95 -263 -98 -3 -4 127 -73 289 -155 329 -166 352 -172 444 -125 116 59 137 235 39 328 -36 35 -219 143 -239 142 -7 0 -129 -42 -270 -92z M6370 6865 c-36 -13 -263 -94 -505 -180 -615 -218 -719 -256 -728 -265 -5 -4 18 -44 51 -89 78 -105 88 -133 66 -197 -20 -60 -79 -154 -96 -154 -7 0 -121 61 -253 135 -132 74 -246 135 -253 135 -18 0 -1068 -371 -1100 -389 -26 -15 -111 -219 -112 -269 -1 -118 110 -215 247 -216 94 -1 119 24 223 224 l85 163 235 88 c129 49 245 88 257 89 12 0 105 -45 206 -100 100 -55 193 -100 205 -100 20 0 234 74 842 290 157 55 408 145 558 198 249 88 273 98 268 117 -2 11 -21 64 -40 118 -33 90 -64 228 -83 368 l-8 57 -65 -23z M3454 6440 c-541 -142 -814 -720 -574 -1216 195 -403 673 -589 1095 -425 271 105 475 354 531 649 25 131 6 368 -34 438 -6 10 -272 -78 -378 -125 -20 -9 -20 -11 -6 -82 37 -185 -61 -376 -237 -462 -98 -47 -263 -48 -361 -1 -298 143 -337 535 -71 734 29 22 70 45 92 51 21 7 45 19 52 28 15 17 187 406 187 421 0 18 -219 10 -296 -10z"/></g></svg>';
  const MARK = '<span class="brand__mark">' + RIDER + '</span>';
  function logo() { return MARK + '<span class="brand__word">' + BRAND + '</span>'; }
  function brandLink(href) { return el('a', { class: 'brand', href, 'aria-label': BRAND + ', home', html: logo() }); }

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

  // ---- Theme: light / dark, remembered per device; the inline <head> snippet applies it before first paint ----------
  const THEME_KEY = 'mdm:theme';
  function storedTheme() { try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; } }
  function systemTheme() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  function currentTheme() { return document.documentElement.dataset.theme || storedTheme() || systemTheme(); }
  function applyTheme(t, persist) {
    document.documentElement.dataset.theme = t;
    if (persist) { try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* private mode: applies for this page only */ } }
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = t === 'dark' ? '#000000' : '#ffffff';
    document.querySelectorAll('[data-theme-toggle]').forEach(syncToggle);
    window.dispatchEvent(new CustomEvent('mdm:theme', { detail: { theme: t } }));
  }
  function syncToggle(btn) {
    const dark = currentTheme() === 'dark';
    btn.innerHTML = MDM.icon(dark ? 'sun' : 'moon', 18);
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btn.title = dark ? 'Light mode' : 'Dark mode';
  }
  function themeToggle(extraClass) {
    const btn = el('button', { type: 'button', class: 'btn btn--ghost btn--icon theme-toggle' + (extraClass ? ' ' + extraClass : ''), 'data-theme-toggle': '', 'data-testid': 'theme-toggle',
      on: { click: () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true) } });
    syncToggle(btn);
    return btn;
  }
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => { if (!storedTheme()) applyTheme(systemTheme(), false); };
    if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
  }
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = currentTheme();

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
    // Signed-in customers (localStorage mdm:me) get "My orders" where visitors get "Sign in".
    let me = null; try { me = JSON.parse(localStorage.getItem('mdm:me') || 'null'); } catch (e) { me = null; }
    const account = () => me && me.phone
      ? el('a', { class: 'btn btn--ghost site-header__account', href: MDM.href('account/'), 'aria-current': page === 'account' ? 'page' : null }, 'My orders')
      : el('a', { class: 'btn btn--ghost site-header__account', href: MDM.href('login/'), 'aria-current': page === 'login' ? 'page' : null }, 'Sign in');
    nav.appendChild(account());
    nav.appendChild(el('a', { class: 'btn btn--brand site-nav__cta', href: MDM.href('request/') }, 'Request a delivery'));
    const toggle = el('button', { type: 'button', class: 'btn btn--ghost btn--icon site-header__toggle', 'aria-expanded': 'false', 'aria-controls': 'site-nav', 'aria-label': 'Menu' }, iconNode('menu', 20));
    const actions = el('div', { class: 'site-header__actions' },
      themeToggle(), account(), el('a', { class: 'btn btn--brand', href: MDM.href('request/') }, 'Request a delivery'), toggle);
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
    // The toggle swaps its icon on click, which detaches e.target; composedPath() still resolves the click to the header.
    document.addEventListener('click', e => { if (open && !e.composedPath().includes(header)) setOpen(false); });
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
    const reach = el('div', { class: 'site-footer__reach' });
    if (c.whatsapp) reach.appendChild(el('a', { class: 'btn btn--brand btn--sm', href: c.whatsapp, target: '_blank', rel: 'noopener' }, iconNode('message-circle', 16), 'WhatsApp'));
    if (c.viber) reach.appendChild(el('a', { class: 'btn btn--on-dark btn--sm', href: c.viber }, 'Viber'));
    if (c.tel) reach.appendChild(el('a', { class: 'btn btn--on-dark btn--sm', href: c.tel }, iconNode('phone', 16), c.display));
    const about = el('div', { class: 'site-footer__about' },
      el('a', { class: 'site-footer__logo', href: MDM.href(''), 'aria-label': BRAND + ', home' }, el('img', { src: MDM.href('assets/logo-full.svg'), alt: BRAND, width: '88', height: '88' })),
      el('p', { class: 'site-footer__tagline' }, 'We pick & deliver, we shop & deliver, and we deliver for businesses across Malé, Hulhumalé and the airport.'),
      reach,
      el('p', { class: 'site-footer__hours', 'data-shell': 'hours' }, hoursLine(s)),
      c.mailto ? el('p', { class: 'site-footer__mail' }, el('a', { href: c.mailto }, c.email)) : null);
    const cols = el('div', { class: 'site-footer__cols' }, FOOTER_COLUMNS.map(col => el('nav', { class: 'site-footer__col', 'aria-label': col.title },
      el('h2', { class: 'site-footer__title' }, col.title), el('ul', null, col.links.map(l => el('li', null, el('a', { href: MDM.href(l.href) }, l.label)))))));
    footer.appendChild(el('div', { class: 'container' },
      el('div', { class: 'site-footer__main' }, about, cols),
      el('div', { class: 'site-footer__bottom' }, el('span', null, BRAND + ' · Greater Malé'), el('span', null, 'Prices in Maldivian Rufiyaa · Pay by bank transfer'))));
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
    if (admin.root) admin.root.dataset.view = view;
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
  // "New order" lives in the orders view; from anywhere else, go there first and press its button once it has mounted.
  function openNewOrder() {
    if (!/^#\/orders(\?|$)/.test(location.hash)) location.hash = '#/orders';
    const t0 = Date.now();
    (function tryClick() { const b = document.querySelector('[data-testid="orders-new"]'); if (b) b.click(); else if (Date.now() - t0 < 4000) setTimeout(tryClick, 100); })();
  }
  async function updateRidersPill() {
    if (!admin.riders || !MDM.store) return;
    try {
      const [drivers, positions] = await Promise.all([MDM.store.list('drivers'), MDM.store.list('positions')]);
      const now = Date.now();
      const online = drivers.filter(d => d.status !== 'offline' && positions.some(p => p.driverId === d.id && now - new Date(p.at).getTime() < 10 * 60000)).length;
      admin.riders.querySelector('.topbar__live-text').textContent = online === 1 ? '1 rider online' : online + ' riders online';
      admin.riders.classList.toggle('is-idle', !online);
    } catch (e) { /* the pill is decorative; the live map has the real list */ }
  }
  function renderAdmin(root) {
    if (root.dataset.shellMounted) return;
    root.dataset.shellMounted = '1';
    root.classList.add('admin');
    admin.root = root;
    const main = root.querySelector('main') || el('main', { id: 'main' });
    const nav = el('nav', { class: 'sidebar__nav', 'aria-label': 'Admin' });
    let group = null;
    ADMIN_NAV.forEach(item => {
      if (item.group !== group) { group = item.group; nav.appendChild(el('div', { class: 'sidebar__group' }, group)); }
      nav.appendChild(el('a', { href: MDM.href('admin/#/' + item.view), 'data-view': item.view },
        iconNode(item.icon, 16), el('span', { class: 'sidebar__label' }, item.label), el('span', { class: 'count', 'data-count': item.view, hidden: true })));
    });
    const signout = el('button', { type: 'button', class: 'btn btn--icon btn--sm sidebar__signout', 'data-testid': 'admin-signout', 'aria-label': 'Sign out', title: 'Sign out',
      on: { click: e => { e.currentTarget.dispatchEvent(new CustomEvent('mdm:signout', { bubbles: true })); } } }, iconNode('log-out', 16));
    admin.sidebar = el('aside', { class: 'sidebar', id: 'admin-sidebar' },
      el('div', { class: 'sidebar__brand' }, brandLink(MDM.href('admin/#/overview'))),
      nav,
      el('div', { class: 'sidebar__foot' },
        el('span', { class: 'sidebar__avatar', 'aria-hidden': 'true' }, 'A'),
        el('span', { class: 'sidebar__who' }, el('span', { class: 'sidebar__name' }, 'Admin'), el('span', { class: 'sidebar__role' }, 'Office')),
        signout));
    admin.menu = el('button', { type: 'button', class: 'btn btn--ghost btn--icon topbar__menu', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'admin-sidebar',
      on: { click: () => setSidebarOpen(!admin.open) } }, iconNode('menu', 20));
    admin.title = el('span', { class: 'topbar__title' }, 'Overview');
    const search = el('input', { class: 'input topbar__search-input', type: 'search', placeholder: 'Search orders, names or phones', 'aria-label': 'Search orders', 'data-testid': 'topbar-search' });
    const searchForm = el('form', { class: 'topbar__search', role: 'search', on: { submit: e => { e.preventDefault(); const q = search.value.trim(); location.hash = '#/orders' + (q ? '?q=' + encodeURIComponent(q) : ''); search.blur(); } } },
      iconNode('search', 16), search);
    admin.riders = el('a', { class: 'topbar__live', href: MDM.href('admin/#/live'), 'data-testid': 'topbar-riders' }, el('span', { class: 'topbar__dot', 'aria-hidden': 'true' }), el('span', { class: 'topbar__live-text' }, 'Riders'));
    const newOrder = el('button', { type: 'button', class: 'btn btn--primary topbar__new', 'data-testid': 'topbar-new-order', on: { click: openNewOrder } }, iconNode('plus', 16), el('span', { class: 'topbar__new-label' }, 'New order'));
    admin.topbar = el('div', { class: 'topbar' }, admin.menu, admin.title, searchForm, el('div', { class: 'topbar__actions' }, admin.riders, themeToggle(), newOrder));
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
    if (MDM.store && MDM.store.ready) MDM.store.ready.then(() => { updateRidersPill(); setInterval(updateRidersPill, 15000); });
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
  MDM.theme = { get: currentTheme, set: t => applyTheme(t, true), toggle: () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true), toggleButton: themeToggle };
  MDM.shell = { mount, refresh, contactLinks, hoursLine, phoneDisplay, phoneLinks, setTitle, setCounts, setActive, setChrome, setSidebarOpen, el, BRAND };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mount(); });
  else mount();
})(window.MDM);

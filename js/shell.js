// Site chrome shared by every page: the public header (brand, nav, CTA, mobile menu), the notice bar, the footer (contact and hours
// from settings) and the admin sidebar/topbar. Everything is built with DOM APIs; text from settings is never injected as HTML.
// mount() runs once at load, fills the static markup right away and completes the settings-dependent parts after MDM.store.ready.
(function (MDM) { 'use strict';
  const BRAND = 'Mr. Delivery Man';
  // Four main links left of the centred logo; the phone menu adds Questions and the account link. Section links point at the home
  // page's sections. Delivery rates are not on the public pages (client, 24 Oct): they show when an order is placed.
  const PUBLIC_NAV = [
    { label: 'Services', href: '#services', page: null },
    { label: 'Track', href: 'track/', page: 'track' },
    { label: 'Store', href: 'store/', page: 'store' },
    { label: 'Business', href: 'business/', page: 'business' },
  ];
  const MENU_MORE = [{ label: 'Questions', href: '#faq', page: null }];
  // Public links only: drivers, staff and the office have their own addresses (login/?as=…, admin/).
  const FOOTER_COLUMNS = [
    { title: 'Services', links: [{ label: 'Pick & Deliver', href: 'request/?category=pick' }, { label: 'Shop & Deliver', href: 'request/?type=shop_buy' }, { label: 'Business Delivery', href: 'business/' }, { label: 'E-store', href: 'store/' }] },
    { title: 'Orders', links: [{ label: 'Request a delivery', href: 'request/' }, { label: 'Track an order', href: 'track/' }, { label: 'My orders', href: 'account/' }, { label: 'Questions', href: '#faq' }] },
    { title: 'Sign in', links: [{ label: 'Customers', href: 'login/' }, { label: 'Businesses', href: 'login/?as=business' }] },
  ];
  const ADMIN_NAV = [
    { view: 'overview', label: 'Overview', icon: 'dashboard', group: 'Operations' },
    { view: 'orders', label: 'Orders', icon: 'package', group: 'Operations' },
    { view: 'bulk', label: 'Bulk orders', icon: 'list', group: 'Operations' },
    { view: 'live', label: 'Live map', icon: 'map', group: 'Operations' },
    { view: 'drivers', label: 'Drivers', icon: 'bike', group: 'Operations' },
    { view: 'customers', label: 'Customers', icon: 'users', group: 'Accounts' },
    { view: 'business', label: 'Business', icon: 'building', group: 'Accounts' },
    { view: 'cash', label: 'Cash & COD', icon: 'wallet', group: 'Accounts' },
    { view: 'store', label: 'E-store', icon: 'store', group: 'Accounts' },
    { view: 'team', label: 'Team & HR', icon: 'clock', group: 'Team and insights' },
    { view: 'reports', label: 'Reports', icon: 'sliders', group: 'Team and insights' },
    { view: 'notifications', label: 'Notifications', icon: 'bell', group: 'Team and insights' },
    { view: 'activity', label: 'Activity log', icon: 'history', group: 'Team and insights' },
    { view: 'zones', label: 'Zones', icon: 'route', group: 'Setup' },
    { view: 'rates', label: 'Rates', icon: 'banknote', group: 'Setup' },
    { view: 'settings', label: 'Settings', icon: 'settings', group: 'Setup' },
  ];
  // Role permissions (client requirements §21): operators run the day, office staff handle customers and payments, admin sees everything.
  const ROLE_VIEWS = {
    admin: ADMIN_NAV.map(n => n.view),
    operator: ['overview', 'orders', 'bulk', 'live', 'drivers', 'customers', 'business', 'cash', 'store', 'reports', 'notifications', 'zones'],
    office: ['overview', 'orders', 'customers', 'business', 'cash', 'store', 'notifications'],
  };
  function session() { try { return JSON.parse(localStorage.getItem('mdm:session') || 'null'); } catch (e) { return null; } }
  function allowedViews() { const s = session(); return ROLE_VIEWS[(s && s.role) || 'admin'] || ROLE_VIEWS.admin; }
  // Keys that are not sidebar views but count towards one: payment reviews and quotes are orders needing action, requests are business.
  const COUNT_ALIAS = { reviews: 'orders', quotes: 'orders', unassigned: 'orders', onHold: 'orders', failed: 'orders', cancels: 'orders', priority: 'orders', requests: 'business', riders: 'live', online: 'live', leaves: 'team', batches: 'bulk', returns: 'orders', cod: 'cash' };
  const HOT_VIEWS = { orders: true, business: true, team: true, bulk: true, cash: true };

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
  // It comes in parts (streaks, two boxes, body, frame, two wheels) so each can move: css/base.css animates .rider, the wheels
  // turn about their own centres. Paths are the traced logo with its transform folded in, in the logo's 1080 square.
  const RIDER_PARTS = '<g class="rider__all"><g class="rider__streaks"><path class="rider__streak" d="M380.3 143.5c-9 3.8-24.3 24.5-24.3 32.9 0 1.8 0.2 1.7 1.9-0.9 5-8.2 13-10.9 17.5-6 2.9 3.1 3.8 2.8 7.1-2.5 2-3.1 2.6-5.8 3.1-13.2 0.8-11 0-12.5-5.3-10.3z"/><path class="rider__streak rider__streak--b" d="M332 210.6c-12.9 5.3-39 15.8-58 23.5-19 7.6-34.5 14.2-34.4 14.6 0 0.5 3.4 1.7 7.5 2.8 8.9 2.5 9.5 3.8 4.4 10.1-2.1 2.5-3.5 4.7-3.2 5 0.2 0.3 16.1-6.8 35.3-15.7 19.2-8.9 40-18.4 46.1-21.2l11.3-5 8-11.3c7.9-11.1 8.7-12.5 7.3-12.3-0.5 0-11.4 4.3-24.3 9.5z"/></g><g class="rider__box rider__box--b"><path d="M335.5 239.2l-13.9 19.1 3.2 2.7c5 4.2 81 58 81.9 58 0.4 0 2.4-2.4 4.4-5.3 1.9-2.8 7.9-11.6 13.3-19.4 5.3-7.9 9.5-14.7 9.2-15.2-0.3-0.5-10.4-7.8-22.3-16.2-12-8.4-30.5-21.5-41.2-29.1-10.7-7.6-19.7-13.8-20.1-13.8-0.4 0-6.9 8.6-14.5 19.2z"/></g><g class="rider__box rider__box--a"><path d="M383.2 173.1c-12.2 17-15 21.5-14 22.4 2.4 2.2 82.7 56.5 83.5 56.5 1.2-0.1 27.8-39.7 27.8-41.4 0-1.5-77.3-57.5-80.5-58.3-1-0.3-6.5 6.6-16.8 20.8z"/></g><g class="rider__body"><path d="M630 200.9l-6.5 0.6-3.8 7.5c-6.4 12.7-9.7 36.7-6.8 49.3 1.3 5.3 1.3 5.3 8.3 2.2 43.3-19 46.1-20 54-18.5 17.7 3.4 22.9 22.9 8.5 31.4-4.4 2.7-6.7 2.1-6.7-1.6 0-3.6-5.4-7.8-10-7.8-10.7 0-16.1 8.3-10.8 16.8l2.2 3.5-2.7 2.1c-1.5 1.2-14.2 7.7-28.1 14.5l-25.5 12.4-37.7-11.3-37.6-11.3-9 0.7c-4.9 0.4-10.2 0.9-11.8 1.2-2.3 0.5-15 10.4-15.8 12.4-0.2 0.6 4.2 2.4 37.5 15 22.3 8.5 31.7 17.9 31.6 31.6-0.1 9.2-3.1 14.5-20.6 36.2-8.6 10.6-15.9 19.8-16.3 20.4-1 1.5-3.2 2.3 56.1-19.2 29.2-10.5 55.9-20.2 59.5-21.4l6.5-2.3 1.7-7.2c0.9-4 1.8-7.5 2.1-7.7 0.2-0.2 4 1.4 8.4 3.6l8.1 4 27.1-9.8c14.9-5.3 27.1-10 27.1-10.4 0-0.3-4.8-3.2-10.7-6.4-24.6-13-39.3-21.7-39.3-23.1 0-11.1 34.9-30.8 76-42.8 6.9-2 13.1-3.9 13.8-4.1 5-1.5-12.4-22.6-27.5-33.3-28.9-20.6-65.2-30.4-101.3-27.2z"/><path class="rider__helmet" d="M505.7 124.4c-23.9 6.9-38.7 28.5-34.9 50.8 1.9 10.7 9.4 23.9 16 27.9 2.8 1.8 70.1 19.9 76.3 20.7 3.4 0.4 3.8 0.1 6.9-4.8 4.3-6.6 7.8-15.5 8.2-20.5l0.3-4-5 0.3c-11.9 0.8-30.1-6.2-40.3-15.3-5.4-4.9-9.2-10.9-7.7-12.4 0.8-0.8 40.9-5.1 47-5.1 2.3 0 1.8-3.5-1.4-9.8-5.8-11.4-16.6-20.8-29.9-25.9-8.3-3.2-27.5-4.2-35.5-1.9z"/></g><g class="rider__frame"><path d="M392 330c-11.3 2-77.5 12.8-100.8 16.5-16 2.5-19.2 4.2-19.2 9.9 0 7.4-4.3 5.5 99.9 45 9.1 3.5 16.9 7 17.5 7.8 0.9 1.5-10.3 29.4-19.5 48.6-1.7 3.5-2.9 6.6-2.6 6.8 0.2 0.3 4.7-1.1 9.8-3 5.2-1.9 20.2-7.4 33.4-12.1 13.2-4.7 26-9.3 28.5-10.2 5.3-1.9 7-3.7 7-7.3 0-9.4 3.5-14.7 29.9-45l15.3-17.5-23.4-0.6c-12.8-0.3-24.7-1-26.3-1.6-14-4.8-23.7-14.9-30.1-31.7-3.3-8.9-2.2-8.5-19.4-5.6z"/><path d="M637 393.5c-3.6 1.3-26.3 9.4-50.5 18-61.5 21.8-71.9 25.6-72.8 26.5-0.5 0.4 1.8 4.4 5.1 8.9 7.8 10.5 8.8 13.3 6.6 19.7-2 6-7.9 15.4-9.6 15.4-0.7 0-12.1-6.1-25.3-13.5-13.2-7.4-24.6-13.5-25.3-13.5-1.8 0-106.8 37.1-110 38.9-2.6 1.5-11.1 21.9-11.2 26.9-0.1 11.8 11 21.5 24.7 21.6 9.4 0.1 11.9-2.4 22.3-22.4l8.5-16.3 23.5-8.8c12.9-4.9 24.5-8.8 25.7-8.9 1.2 0 10.5 4.5 20.6 10 10 5.5 19.3 10 20.5 10 2 0 23.4-7.4 84.2-29 15.7-5.5 40.8-14.5 55.8-19.8 24.9-8.8 27.3-9.8 26.8-11.7-0.2-1.1-2.1-6.4-4-11.8-3.3-9-6.4-22.8-8.3-36.8l-0.8-5.7-6.5 2.3z"/><path d="M721.8 363.3c-14.1 5.1-25.9 9.5-26.3 9.8-0.3 0.4 12.7 7.3 28.9 15.5 32.9 16.6 35.2 17.2 44.4 12.5 11.6-5.9 13.7-23.5 3.9-32.8-3.6-3.5-21.9-14.3-23.9-14.2-0.7 0-12.9 4.2-27 9.2z"/></g><g class="rider__wheel rider__wheel--back"><path d="M345.4 436c-54.1 14.2-81.4 72-57.4 121.6 19.5 40.3 67.3 58.9 109.5 42.5 27.1-10.5 47.5-35.4 53.1-64.9 2.5-13.1 0.6-36.8-3.4-43.8-0.6-1-27.2 7.8-37.8 12.5-2 0.9-2 1.1-0.6 8.2 3.7 18.5-6.1 37.6-23.7 46.2-9.8 4.7-26.3 4.8-36.1 0.1-29.8-14.3-33.7-53.5-7.1-73.4 2.9-2.2 7-4.5 9.2-5.1 2.1-0.7 4.5-1.9 5.2-2.8 1.5-1.7 18.7-40.6 18.7-42.1 0-1.8-21.9-1-29.6 1z"/></g><g class="rider__wheel rider__wheel--front"><path d="M746.5 299.1c-8.8 1.3-19.1 4.6-26.6 8.5-6.7 3.5-18 12-18.6 14-0.2 0.5 8.1 5.7 18.4 11.3l18.7 10.4 6.6-1.6c14.4-3.6 22-3 33.6 2.8 37.5 18.4 31.3 73.4-9.3 84-24.3 6.3-50.7-10.3-55.2-34.7-1.1-6.5-1.3-6.6-15.8-13.7-7-3.4-13.5-6.7-14.3-7.2-0.8-0.5-3.1-1.8-5.1-2.9l-3.7-1.9-0.7 2.6c-0.3 1.4-0.6 7.1-0.6 12.7-0.1 62.5 65.7 103.4 121.6 75.7 52.4-25.9 63.7-93.8 22.7-135.8-17.6-17.9-47.1-27.9-71.7-24.2z"/></g></g>';
  const RIDER = '<svg class="rider" viewBox="226 99 640 520" fill="currentColor" aria-hidden="true" focusable="false">' + RIDER_PARTS + '</svg>';
  // The full logo (rider over the lettering on the red square), drawn inline so the footer's rider can ride too.
  const LOGO_FULL = '<svg class="rider rider--full" viewBox="0 0 1080 1080" aria-hidden="true" focusable="false"><rect width="1080" height="1080" fill="#D2002F"/><g fill="#fff">' + RIDER_PARTS + '<path d="M1038.1 477c-11 2.7-19.7 5.3-20.2 6.1-0.4 0.8-8.2 12.4-17.3 25.8l-16.5 24.4-6.7-13.9c-3.6-7.6-7.7-16.3-9-19.2-1.3-2.8-2.8-5.2-3.4-5.2-2.4 0-38 9.3-38 10 0 0.3 7.7 15.4 17.1 33.5l17.1 32.8-4.4 25.6c-3.8 22.2-4.2 25.6-2.9 25.9 1.6 0.3 32.8-7.2 33.7-8 0.2-0.3 2.5-12.2 5-26.4l4.6-25.9 5.7-8c11.1-15.4 54.8-77 56.5-79.8 2.4-3.6 2.6-3.6-21.3 2.3zM884 514.7c-2.6 0.5-56.8 13.7-63.1 15.3l-3.6 1-2.1 12.2c-1.3 6.8-4.7 26.5-7.7 43.8-8.8 50.6-9.6 55-11.4 65.3-1.7 9.2-1.7 9.8-0.2 9.4 1-0.2 9-2.1 17.9-4.3 13.9-3.2 16.3-4.1 16.7-5.8 0.3-1.2 1.9-10.4 3.6-20.6 1.7-10.2 3.5-19 4-19.6 0.7-0.9 10.2-3.4 12.9-3.4 0.4 0 5.5 7.9 11.5 17.5 6 9.7 11.3 17.4 11.9 17.2 0.6-0.2 9.1-2.3 18.9-4.7 14.2-3.3 17.7-4.5 17.7-5.8 0-1-5.4-9.5-12.1-19.1-6.6-9.6-11.6-17.7-11.2-18.1 0.4-0.4 3.8-2.7 7.4-5.3 13.4-9.3 21.4-21 24.5-35.7 5.7-27-9.7-44-35.6-39.3zm-1.3 31.8c7.2 5-0.6 25-11.5 29.4-4.1 1.6-27.5 7.1-28 6.6-0.6-0.6 4.4-29.4 5.2-30.2 0.9-0.9 26-7.1 29.1-7.2 1.7-0.1 4 0.6 5.2 1.4zM780.5 539.7c-5.5 1.4-26.4 6.5-46.4 11.4-20 4.9-36.5 9-36.6 9.1-0.5 0.8-22.7 130-22.3 130.4 0.3 0.2 23-5.1 50.5-11.8l50-12.1 2.3-14.1c1.2-7.8 2.5-14.7 2.7-15.4 0.8-1.9-0.9-1.6-33.6 6.3-17.1 4.1-31.2 7.5-31.4 7.5-0.5 0 2.8-18.8 3.4-19.3 0.2-0.3 13.1-3.5 28.6-7.2l28.1-6.8 2.2-11.6c1.1-6.4 2.3-13.1 2.6-14.9 0.8-4.2 2.4-4.4-29.1 3.3-14.8 3.6-26.9 6.4-27 6.3-0.5-0.6 2.7-17.3 3.3-17.9 0.4-0.4 13.9-3.8 30.1-7.7 16.1-3.9 29.5-7.3 29.8-7.5 0.5-0.6 5.3-26.6 5.3-29 0-2.1-0.2-2.1-12.5 1zM665.4 567.6l-18.1 4.5-11.3 22.7c-6.2 12.5-16.4 33.7-22.7 47.2-6.3 13.5-11.6 24.6-11.7 24.8-0.2 0.1-1.7-8.7-3.5-19.5-2.8-17.4-10.9-59.4-11.5-60.1-0.2-0.2-38.7 8.9-39.3 9.3-0.2 0.1 2.6 11.8 6.1 26.1 3.5 14.2 10.1 40.9 14.6 59.1 6.7 27.1 8.5 33.3 9.8 33.3 2.1-0.1 33.1-7.5 33.6-8.1 0.1-0.2 4-7.6 8.6-16.4 4.5-8.8 10.9-21 14-27 31-59.2 52-99.6 52-100 0-0.9-2.1-0.5-20.6 4.1zM518.5 603.4l-16.9 4.1-11.3 64.5c-6.2 35.5-11.2 65-11 65.6 0.3 1.6 33.7-6.7 34.8-8.6 0.5-0.8 2.5-11 4.4-22.5 1.9-11.6 5.1-29.8 6.9-40.5 8.8-50.1 11.6-66.1 11.6-66.5 0-0.7 0.5-0.8-18.5 3.9zM211 608.6c-5.8 1.5-10.9 3-11.4 3.4-0.9 0.9-8.8 44.1-8.1 44.8 0.2 0.2 3-0.2 6.1-1l5.8-1.4 1.2-6.7c2.1-11.1 4.4-11.8 10-3 2 3.2 3.7 5.9 3.8 6 0.6 0.7 12.6-3.2 12.6-4.1 0-0.6-1.8-3.6-3.9-6.6l-3.9-5.4 4.3-3.8c5.2-4.6 8-11.1 7.2-16.5-1.4-8.3-7.4-9.7-23.7-5.7zm11.4 9.9c1.5 4-2.1 8-9 10.1-5.8 1.7-5.7 1.8-4.7-4.2 0.8-4.6 1.1-4.9 4.8-6 5.5-1.7 8.2-1.7 8.9 0.1zM185.5 615c-1.6 0.4-4.2 1.1-5.7 1.4-1.8 0.4-4.9 3.5-9.8 9.7l-7.1 9-4.1-5.8c-2.2-3.2-4.2-5.9-4.3-6.1-0.6-0.7-12.8 2.3-13.1 3.3-1.5 3.9-7.8 44.5-7 44.5 0.6 0 3.4-0.6 6.1-1.3l5-1.3 1.1-6c0.6-3.2 1.7-9.4 2.4-13.6l1.3-7.7 4 5.5c2.2 2.9 4.6 5.4 5.4 5.4 0.7 0 4-3.4 7.4-7.5 3.4-4.1 6.4-7.3 6.6-7.1 0.2 0.2-0.5 5.7-1.6 12.2-1.1 6.5-1.9 12-1.7 12.2 1.4 1.3 11.7-2.3 12.1-4.2 0.6-2.7 7.5-42.4 7.5-43.1 0-0.6-0.7-0.5-4.5 0.5zM407.6 630.4c-9.3 2.3-17.1 4.6-17.3 5.1-0.8 2.8-22.3 128.1-22.1 129.1 0.3 0.9 50.4-10.6 90.3-20.8l5-1.3 2.8-15.4c1.5-8.4 2.6-15.5 2.4-15.7-0.2-0.2-13.5 2.8-29.5 6.8-16 3.9-29.4 6.9-29.7 6.7-0.2-0.3 3.4-22.3 8-49 4.7-26.6 8.5-48.7 8.5-49.2 0-0.9 1-1.1-18.4 3.7zM243.3 633.8c-2.9 0.4-7.5 5.9-7.1 8.5 0.8 5.1 8.5 4.1 11.4-1.5 2.5-4.8 0.6-7.8-4.3-7zM345.5 645.5c-9.3 2.4-29.7 7.4-45.3 11.1-15.5 3.7-28.6 7.1-29 7.4-0.5 0.3-4.1 19.4-8.1 42.5-4 23.1-9.1 52.3-11.3 64.8-2.2 12.5-3.9 23-3.7 23.2 0.5 0.5 99.3-23.5 100.1-24.3 0.6-0.7 6-30.3 5.5-30.8-0.1-0.1-14.8 3.3-32.6 7.7-17.7 4.3-32.4 7.9-32.5 7.9-0.4 0 3.1-19 3.5-19.4 0.2-0.2 13-3.4 28.4-7.2 15.4-3.7 28.1-6.8 28.3-7 0.6-0.4 5.2-27.8 5-29-0.3-0.9-8.8 1-54.4 12-2 0.5-2 0.5-0.5-8.8l1.4-9.3 9.6-2.2c46.2-10.8 51.1-12.2 51.6-14.4 1.1-4.9 4.5-25.2 4.5-26.9 0-2.4-0.7-2.3-20.5 2.7zM190 683.6c-15.3 3.2-57.6 13.7-58.3 14.4-0.4 0.4-3.3 14.8-6.3 32.1-3 17.3-8 46.5-11.2 64.9-3.3 18.4-5.8 33.6-5.8 33.7 0.5 0.7 63.2-15.4 69.3-17.8 35.8-14.2 60.9-47.7 63.1-84.2 2-33.4-17.8-50.2-50.8-43.1zm7.7 33.6c4.7 2.8 7.3 9 7.3 17.4-0.1 20.2-10 37.3-26.7 45.7-4.2 2.2-28.2 9.1-29 8.4-0.1-0.1 2.5-15.3 5.8-33.7 3.2-18.4 5.9-33.8 5.9-34.1 0-0.7 18.9-5.5 24-6.2 4.2-0.5 9.3 0.5 12.7 2.5zM784.2 697.5c-9.5 2.3-17.5 4.4-17.7 4.7-0.8 0.8-8.2 43.9-10 58.3-0.9 7.1-1.8 13.1-2 13.3-0.3 0.3-27.3-39.2-36.6-53.5-1.9-2.9-4.1-5.3-4.9-5.3-2.6 0.1-28.2 6.8-28.9 7.7-0.4 0.4-4.5 22.2-9 48.3-4.5 26.1-9.6 55.1-11.2 64.4-1.6 9.3-2.8 17-2.6 17.2 0.3 0.3 34.7-7.5 35.4-8 0.3-0.3 8.1-45.3 9.9-57.9 1-6.4 2-11.7 2.3-11.7 0.3 0.1 2.4 2.6 4.5 5.8 12.6 18.4 33.1 47.9 34.3 49.3 1.2 1.4 2.7 1.3 16.1-1.9 8.1-1.9 14.9-3.6 15-3.8 0.2-0.1 2.4-11.4 4.7-25.1 2.4-13.6 7.6-43 11.4-65.2 3.9-22.2 7-40.5 6.9-40.6-0.2-0.1-8.1 1.7-17.6 4zM599.2 742.5c-9.5 2.3-17.7 4.6-18.1 5.1-0.5 0.5-9.4 16.6-19.9 35.9-10.5 19.2-28.1 51.4-39.1 71.5-11 20-19.9 36.5-19.8 36.6 0.1 0.2 8.8-1.9 19.3-4.4l19.1-4.7 6-11.5c3.3-6.2 6.6-11.7 7.4-12.2 3.7-2 54.4-13.4 55-12.4 0.4 0.6 1.5 4.8 2.4 9.3 2.1 9.6 0.9 9.1 15.3 5.8 24.6-5.8 24.3-5.7 23.7-7.4-0.2-0.9-7.7-27-16.6-58.1-8.8-31.1-16.4-56.8-16.7-57.1-0.4-0.4-8.5 1.3-18 3.6zm-0.7 56.7c2.1 9.2 3.6 17.1 3.2 17.4-0.6 0.7-27.3 7.3-29.5 7.4-1.1 0 3-8.4 18-36.7 1.8-3.4 3.6-5.9 3.9-5.5 0.3 0.4 2.3 8.2 4.4 17.4zM495.2 767.8l-18.2 4.4-20.1 25.6c-11.1 14.1-20.4 25.8-20.8 26-0.4 0.1-6.3-7.8-13-17.6l-12.3-17.9-18.1 4.5c-10 2.4-18.5 4.8-18.8 5.3-0.3 0.5-1.6 6.9-2.8 14.2-1.3 7.3-6.3 36.1-11.2 64.1-4.9 28-8.7 51.2-8.4 51.4 0.7 0.7 32.5-7 34-8.3 0.6-0.5 4-18.1 7.6-39.8 3.5-21.3 6.6-38.7 6.9-38.7 0.3 0 1.8 2.1 3.5 4.8 1.6 2.6 6.9 10 11.8 16.5 11.8 15.7 10.8 15.9 29-6.3 6.1-7.4 14.2-17.7 18-22.8 3.8-5.1 7.1-9.1 7.3-8.9 0.2 0.1-2.8 17.8-6.6 39.2-3.7 21.5-6.8 39.1-6.7 39.2 0.2 0.1 8.1-1.7 17.7-4l17.5-4.2 0.6-4c0.4-2.2 2.6-14.6 4.9-27.5 12.2-69.9 17.1-98.3 16.8-98.9-0.2-0.4-8.5 1.3-18.6 3.7z"/></g></svg>';
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
  // '09:00' → '9am', '23:00' → '11pm', '13:30' → '1:30pm'.
  function clock12(t) {
    const m = toMin(t); if (m == null) return String(t || '');
    const h = Math.floor(m / 60) % 24, min = m % 60;
    return ((h % 12) || 12) + (min ? ':' + String(min).padStart(2, '0') : '') + (h < 12 ? 'am' : 'pm');
  }
  // hoursLine(settings?, date?) → 'Open 9am to 11pm' or 'Closed now · opens 9am' in local time.
  function hoursLine(s, date) {
    s = s || settingsCache || {};
    const ops = s.ops || {}, hours = ops.hours || {};
    const open = hours.open || '09:00', close = hours.close || '23:00';
    const d = date || new Date();
    const cur = d.getHours() * 60 + d.getMinutes();
    const a = toMin(open), b = toMin(close);
    const isOpen = a == null || b == null ? true : (a <= b ? cur >= a && cur < b : cur >= a || cur < b);
    const pause = closedWindowEnd(ops, d);
    if (pause) return 'Closed now · opens ' + clock12(pause);
    if (!isOpen) return 'Closed now · opens ' + clock12(open);
    return 'Open ' + clock12(open) + ' to ' + clock12(close);
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
  // The logo rides in on every page: the tile pops, the bike rolls in on its back wheel, the boxes drop onto the rack and the name
  // slides in. On the home page's first visit the bridge intro (index.html) plays first, so the header waits for it to lift. After
  // that, scrolling turns the wheels (--roll) and jolts the boxes (--jig). Reduced motion keeps the logo still.
  const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function rideIn(node, cls, ms) {
    node.classList.add(...cls);
    setTimeout(() => node.classList.remove(...cls), ms);   // so a later hover can play its own move
  }
  function rideLogo(brand) {
    if (REDUCED) return;
    const go = () => rideIn(brand, ['brand--enter', 'rider-enter'], 2000);
    if (document.documentElement.classList.contains('is-intro')) document.addEventListener('mdm:intro-leave', go, { once: true }); else go();
    const mark = brand.querySelector('.brand__mark');
    let last = window.scrollY, jig = 0, raf = 0;
    const tick = () => {
      raf = 0;
      const y = window.scrollY, dy = y - last; last = y;
      jig = Math.max(-1, Math.min(1, jig * 0.72 + dy / 60));
      mark.style.setProperty('--roll', (y * 0.6 % 360).toFixed(1) + 'deg');
      mark.style.setProperty('--jig', (-Math.abs(jig) * 60).toFixed(1) + 'px');
      if (Math.abs(jig) > 0.02) raf = requestAnimationFrame(tick); else mark.style.setProperty('--jig', '0px');
    };
    window.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(tick); }, { passive: true });
  }
  // The account link follows a signed-in customer (their orders) or business (its portal); everyone else gets "Sign in". The team's
  // own pages (office, drivers, staff) are never advertised on the public site.
  function accountLink(page) {
    const read = (store, key) => { try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; } };
    const me = read(localStorage, 'mdm:me'), biz = read(localStorage, 'mdm:business');
    const pick = me && me.phone ? ['My orders', 'account/', 'account'] : biz && biz.accountId ? ['Business portal', 'business/', 'business'] : ['Sign in', 'login/', 'login'];
    return el('a', { class: 'btn btn--ghost site-header__account', href: MDM.href(pick[1]), 'aria-current': page === pick[2] ? 'page' : null }, pick[0]);
  }
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
    MENU_MORE.forEach(item => nav.appendChild(el('a', { class: 'site-nav__more', href: MDM.href(item.href), 'aria-current': item.page && item.page === page ? 'page' : null }, item.label)));
    nav.appendChild(accountLink(page));
    nav.appendChild(el('a', { class: 'btn btn--brand site-nav__cta', href: MDM.href('request/') }, 'Request a delivery'));
    // Small phones have no room for the theme switch in the bar, so the menu carries a second one.
    const menuTheme = themeToggle('site-nav__theme'); menuTheme.setAttribute('data-testid', 'theme-toggle-menu');
    nav.appendChild(menuTheme);
    Array.from(nav.children).forEach((n, i) => n.style.setProperty('--i', String(i)));
    const toggle = el('button', { type: 'button', class: 'btn btn--ghost btn--icon site-header__toggle', 'aria-expanded': 'false', 'aria-controls': 'site-nav', 'aria-label': 'Menu' }, iconNode('menu', 20));
    const cta = el('a', { class: 'btn btn--brand', href: MDM.href('request/') }, el('span', { class: 'site-header__cta-long' }, 'Request a delivery'), el('span', { class: 'site-header__cta-short' }, 'Request'));
    const actions = el('div', { class: 'site-header__actions' }, themeToggle(), accountLink(page), cta);
    // Links left, the logo in the middle, account and CTA right (phones: menu left, logo middle, CTA right).
    const brand = brandLink(MDM.href(''));
    header.appendChild(el('div', { class: 'container' }, toggle, nav, brand, actions));
    rideLogo(brand);
    // The hairline under the bar shows once the page has scrolled.
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

    let open = false;
    function setOpen(v) {
      open = !!v;
      nav.classList.toggle('is-open', open);
      header.classList.toggle('is-menu', open);
      document.documentElement.classList.toggle('menu-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
      toggle.innerHTML = MDM.icon(open ? 'x' : 'menu', 20);
      if (open) { const first = nav.querySelector('a'); if (first) first.focus(); }
    }
    toggle.addEventListener('click', () => setOpen(!open));
    nav.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) { setOpen(false); toggle.focus(); } });
    // The toggle swaps its icon on click, which detaches e.target; composedPath() still resolves the click to the header.
    document.addEventListener('click', e => { if (open && !e.composedPath().includes(header)) setOpen(false); });
    const mq = window.matchMedia('(min-width: 961px)');
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
  // The full logo, inline: its rider rides in the first time the footer comes into view, and pops a wheelie on hover.
  function footerLogo() {
    const a = el('a', { class: 'site-footer__logo', href: MDM.href(''), 'aria-label': BRAND + ', home', html: LOGO_FULL });
    if (!REDUCED && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { io.disconnect(); rideIn(a, ['rider-enter'], 2000); } }), { threshold: 0.6 });
      io.observe(a);
    }
    return a;
  }
  function renderFooter(footer, s) {
    footer.classList.add('site-footer');
    footer.textContent = '';
    const c = contactLinks();
    const reach = el('div', { class: 'site-footer__reach' });
    if (c.whatsapp) reach.appendChild(el('a', { class: 'btn btn--brand btn--sm', href: c.whatsapp, target: '_blank', rel: 'noopener' }, iconNode('message-circle', 16), 'WhatsApp'));
    if (c.viber) reach.appendChild(el('a', { class: 'btn btn--secondary btn--sm', href: c.viber }, 'Viber'));
    if (c.tel) reach.appendChild(el('a', { class: 'btn btn--secondary btn--sm', href: c.tel }, iconNode('phone', 16), c.display));
    const about = el('div', { class: 'site-footer__about' },
      footerLogo(),
      el('p', { class: 'site-footer__tagline' }, 'Pick up, shop and deliver across Greater Malé.'),
      reach,
      el('p', { class: 'site-footer__hours', 'data-shell': 'hours' }, hoursLine(s)),
      c.mailto ? el('p', { class: 'site-footer__mail' }, el('a', { href: c.mailto }, c.email)) : null);
    const cols = el('div', { class: 'site-footer__cols' }, FOOTER_COLUMNS.map(col => el('nav', { class: 'site-footer__col', 'aria-label': col.title },
      el('h2', { class: 'site-footer__title' }, col.title), el('ul', null, col.links.map(l => el('li', null, el('a', { href: MDM.href(l.href) }, l.label)))))));
    footer.appendChild(el('div', { class: 'container' },
      el('div', { class: 'site-footer__main' }, about, cols),
      el('div', { class: 'site-footer__bottom' }, el('span', null, BRAND + ' · Greater Malé'), el('span', null, 'Prices in MVR · Pay by bank transfer'))));
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
  // ---- Go-to palette: the top bar search suggests pages, actions and matching orders as you type --------------------------------
  // Arrow keys move, Enter opens the highlighted suggestion (with none highlighted, Enter searches the orders list as before),
  // Escape closes. ⌘K / Ctrl+K or "/" focuses it from anywhere; on phones the search button opens it over the top bar.
  function gotoPalette(input, form, topbar) {
    const list = el('div', { class: 'goto', id: 'goto-list', role: 'listbox', 'aria-label': 'Suggestions', 'data-testid': 'goto-list', hidden: true });
    form.appendChild(list);
    let items = [], active = -1, seq = 0, closeTimer = null;
    const norm = v => String(v || '').toLowerCase();
    const digits = v => String(v || '').replace(/\D/g, '');
    function actions() {
      const out = [];
      if (allowedViews().indexOf('orders') >= 0) out.push({ group: 'Actions', label: 'New order', icon: 'plus', run: openNewOrder });
      out.push({ group: 'Actions', label: (MDM.theme && MDM.theme.get() === 'dark') ? 'Light mode' : 'Dark mode', icon: 'moon', run: () => MDM.theme.toggle() });
      return out;
    }
    async function build(q) {
      const my = ++seq, term = norm(q).trim();
      const views = ADMIN_NAV.filter(n => allowedViews().indexOf(n.view) >= 0 && (!term || norm(n.label).indexOf(term) >= 0 || n.view.indexOf(term) >= 0))
        .map(n => ({ group: 'Go to', label: n.label, icon: n.icon, href: MDM.href('admin/#/' + n.view) }));
      const acts = actions().filter(a => !term || norm(a.label).indexOf(term) >= 0);
      let orders = [];
      if (term.length >= 2 && MDM.store && allowedViews().indexOf('orders') >= 0) {
        try {
          const all = await MDM.store.list('orders');
          if (my !== seq) return;
          const d = digits(term);
          orders = all.filter(o => norm(o.code).indexOf(term) >= 0 || norm(o.customer && o.customer.name).indexOf(term) >= 0
            || (d.length >= 3 && digits(o.customer && o.customer.phone).indexOf(d) >= 0))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 6)
            .map(o => ({ group: 'Orders', label: o.code + ' · ' + ((o.customer && o.customer.name) || ''), icon: 'package', meta: MDM.ui && MDM.ui.statusLabel ? MDM.ui.statusLabel(o.status) : o.status, href: MDM.href('admin/#/orders/' + encodeURIComponent(o.id)) }));
        } catch (e) { orders = []; }
      }
      if (my !== seq) return;
      // With a query, the first (highlighted) row is the plain orders search, so Enter keeps doing what it always did.
      const plain = term ? [{ group: 'Search', label: 'Search orders for "' + String(q).trim() + '"', icon: 'search', href: MDM.href('admin/#/orders?q=' + encodeURIComponent(String(q).trim())) }] : [];
      items = plain.concat(orders, views, acts);
      active = term ? 0 : -1;
      render(term);
    }
    function render(term) {
      list.replaceChildren();
      let group = null;
      items.forEach((it, i) => {
        if (it.group !== group) { group = it.group; list.appendChild(el('div', { class: 'goto__group', role: 'presentation' }, group)); }
        const opt = el('div', { class: 'goto__item', role: 'option', id: 'goto-opt-' + i, 'aria-selected': i === active ? 'true' : 'false', 'data-testid': 'goto-item', 'data-group': it.group,
          on: { mousedown: e => { e.preventDefault(); active = i; choose(); }, mousemove: () => { if (active !== i) { active = i; mark(); } } } },
          iconNode(it.icon || 'arrow-right', 16), el('span', { class: 'goto__main' }, it.label), it.meta ? el('span', { class: 'goto__meta' }, it.meta) : null);
        list.appendChild(opt);
      });
      if (!items.length) list.appendChild(el('div', { class: 'goto__empty' }, 'Nothing to show'));
      list.hidden = false; input.setAttribute('aria-expanded', 'true');
      mark();
    }
    function mark() {
      list.querySelectorAll('.goto__item').forEach((n, i) => n.setAttribute('aria-selected', i === active ? 'true' : 'false'));
      if (active >= 0) { input.setAttribute('aria-activedescendant', 'goto-opt-' + active); const n = list.querySelector('#goto-opt-' + active); if (n && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    }
    function close() {
      seq++; list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1;
      topbar.classList.remove('is-searching');
    }
    function choose() {
      if (active < 0 || !items[active]) return false;
      const it = items[active];
      close(); input.value = ''; input.blur();
      if (it.run) it.run(); else if (it.href) location.href = it.href;
      return true;
    }
    function focus() { topbar.classList.add('is-searching'); input.focus(); input.select(); build(input.value); }
    input.addEventListener('focus', () => { clearTimeout(closeTimer); build(input.value); });
    input.addEventListener('input', () => build(input.value));
    input.addEventListener('blur', () => { closeTimer = setTimeout(close, 120); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        active = e.key === 'ArrowDown' ? (active + 1) % items.length : (active <= 0 ? items.length - 1 : active - 1);
        mark();
      } else if (e.key === 'Escape') { e.stopPropagation(); close(); input.blur(); }
    });
    document.addEventListener('keydown', e => {
      const typing = e.target && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); focus(); }
      else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !document.querySelector('dialog[open], .drawer.is-open')) { e.preventDefault(); focus(); }
    });
    return { choose, close, focus };
  }
  function renderAdmin(root) {
    if (root.dataset.shellMounted) return;
    root.dataset.shellMounted = '1';
    root.classList.add('admin');
    admin.root = root;
    const main = root.querySelector('main') || el('main', { id: 'main' });
    const nav = el('nav', { class: 'sidebar__nav', 'aria-label': 'Admin' });
    let group = null;
    const allowed = allowedViews();
    ADMIN_NAV.filter(item => allowed.indexOf(item.view) >= 0).forEach(item => {
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
        el('span', { class: 'sidebar__avatar', 'aria-hidden': 'true' }, ((session() || {}).name || 'Admin').charAt(0)),
        el('span', { class: 'sidebar__who' }, el('span', { class: 'sidebar__name' }, (session() || {}).name || 'Admin'), el('span', { class: 'sidebar__role' }, { admin: 'Admin', operator: 'Operator', office: 'Office staff' }[(session() || {}).role] || 'Admin')),
        signout));
    admin.menu = el('button', { type: 'button', class: 'btn btn--ghost btn--icon topbar__menu', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'admin-sidebar',
      on: { click: () => setSidebarOpen(!admin.open) } }, iconNode('menu', 20));
    admin.title = el('span', { class: 'topbar__title' }, 'Overview');
    const search = el('input', { class: 'input topbar__search-input', type: 'search', placeholder: 'Search or go to…', 'aria-label': 'Search orders or go to a page', 'data-testid': 'topbar-search',
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'goto-list', autocomplete: 'off' });
    const kbd = el('kbd', { class: 'topbar__kbd', 'aria-hidden': 'true' }, /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K');
    const searchForm = el('form', { class: 'topbar__search', role: 'search', on: { submit: e => {
      e.preventDefault();
      if (goto.choose()) return;
      const q = search.value.trim(); location.hash = '#/orders' + (q ? '?q=' + encodeURIComponent(q) : ''); goto.close(); search.blur();
    } } }, iconNode('search', 16), search, kbd);
    admin.riders = el('a', { class: 'topbar__live', href: MDM.href('admin/#/live'), 'data-testid': 'topbar-riders' }, el('span', { class: 'topbar__dot', 'aria-hidden': 'true' }), el('span', { class: 'topbar__live-text' }, 'Riders'));
    const newOrder = el('button', { type: 'button', class: 'btn btn--primary topbar__new', 'data-testid': 'topbar-new-order', on: { click: openNewOrder } }, iconNode('plus', 16), el('span', { class: 'topbar__new-label' }, 'New order'));
    const searchBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--icon topbar__search-btn', 'aria-label': 'Search or go to', 'data-testid': 'topbar-search-open', on: { click: () => goto.focus() } }, iconNode('search', 18));
    admin.topbar = el('div', { class: 'topbar' }, admin.menu, admin.title, searchForm, el('div', { class: 'topbar__actions' }, searchBtn, admin.riders, themeToggle(), newOrder));
    const goto = gotoPalette(search, searchForm, admin.topbar);
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
  MDM.shell = { ADMIN_NAV, ROLE_VIEWS, session, allowedViews, mount, refresh, contactLinks, hoursLine, phoneDisplay, phoneLinks, setTitle, setCounts, setActive, setChrome, setSidebarOpen, el, BRAND, RIDER };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mount(); });
  else mount();
})(window.MDM);

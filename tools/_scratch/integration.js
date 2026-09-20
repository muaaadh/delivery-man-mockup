(function (MDM) { 'use strict';
  async function main() {
    await MDM.store.ready;
    const { el } = MDM.ui;
    const g = document.getElementById('gallery');
    const s = await MDM.store.settings();
    const orders = await MDM.store.list('orders', { limit: 6 });
    // badges
    g.appendChild(el('div', { class: 'row row--wrap' }, Object.keys(MDM.STATUS).map(k => MDM.ui.html(MDM.badgeFor(k)))));
    // alerts
    g.appendChild(el('div', { class: 'stack-3' }, ['info', 'warn', 'danger', 'ok'].map(k => el('div', { class: 'alert alert--' + k }, MDM.ui.html(MDM.icon('info', 16)), el('div', {}, el('div', { class: 'alert__title' }, 'Alert ' + k), 'Villimalé is quoted before pickup. We confirm the price and send the payment link.')))));
    // stepper
    g.appendChild(el('ol', { class: 'stepper' }, el('li', { class: 'stepper__item is-done' }, el('button', { type: 'button' }, MDM.ui.html(MDM.icon('check', 16)), ' Service')), el('li', { class: 'stepper__item', 'aria-current': 'step' }, el('span', { class: 'stepper__num' }, '2'), ' Schedule'), el('li', { class: 'stepper__item' }, el('span', { class: 'stepper__num' }, '3'), ' Your details'), el('li', { class: 'stepper__item' }, el('span', { class: 'stepper__num' }, '4'), ' Review'), el('li', { class: 'stepper__progress' }, 'Step 2 of 4')));
    // segmented + form
    const form = el('form', { class: 'stack-4' },
      el('fieldset', { class: 'segmented' }, el('legend', { class: 'sr-only' }, 'Service'), ['Pick & deliver', 'Shop & deliver', 'For a business'].map((t, i) => el('label', {}, el('input', { type: 'radio', name: 'svc', class: 'sr-only', checked: i === 0 ? '' : null }), el('span', {}, t)))),
      el('div', { class: 'grid-2' }, el('div', { class: 'field' }, el('label', { for: 'f1' }, 'Pickup address'), el('input', { id: 'f1', class: 'input', placeholder: 'H. Sunny Villa, Majeedhee Magu' }), el('div', { class: 'field__hint' }, 'House name, floor and road')), el('div', { class: 'field is-invalid' }, el('label', { for: 'f2' }, 'Phone'), el('input', { id: 'f2', class: 'input', value: '12345' }), el('div', { class: 'field__error' }, 'Enter a 7-digit Maldives mobile number'))),
      el('div', { class: 'field' }, el('label', { for: 'f3' }, 'Zone'), el('select', { id: 'f3', class: 'select' }, MDM.geo.zoneOptions().map(o => el('option', { value: o.value }, o.label)))),
      el('label', { class: 'checkbox' }, el('input', { type: 'checkbox' }), el('span', {}, 'Too big or heavy for a bike', el('span', { class: 'hint' }, 'A vehicle charge is confirmed before dispatch'))),
      el('div', { class: 'form-actions form-actions--between' }, el('button', { type: 'button', class: 'btn btn--ghost' }, 'Back'), el('button', { type: 'button', class: 'btn btn--primary' }, 'Continue')));
    g.appendChild(form);
    // kpi row
    g.appendChild(el('div', { class: 'card kpi-row' }, [['Orders today', '9'], ['Awaiting verification', '2'], ['Quotes to send', '1'], ['In transit', '4'], ['Delivered today', '3']].map(([l, v]) => el('div', { class: 'kpi' }, el('div', { class: 'kpi__label' }, l), el('div', { class: 'kpi__value' }, v), el('div', { class: 'kpi__note' }, '7 yesterday')))));
    // table
    g.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack' }, el('thead', {}, el('tr', {}, ['Code', 'Customer', 'Total', 'Status'].map(h => el('th', { scope: 'col', class: h === 'Total' ? 'num' : '' }, h)))), el('tbody', {}, orders.map(o => el('tr', { class: 'is-clickable' }, el('td', { 'data-label': 'Code', class: 'table__primary mono' }, el('a', { href: '#' }, o.code)), el('td', { 'data-label': 'Customer' }, o.customer.name, el('div', { class: 'cell-secondary' }, MDM.ui.phone.format(o.customer.phone))), el('td', { 'data-label': 'Total', class: 'num mono' }, MDM.pricing.format(o.totals.total)), el('td', { 'data-label': 'Status', class: 'table__primary' }, MDM.ui.html(MDM.badgeFor(o.status)))))))));
    // summary + rate-table
    const o = orders[0];
    g.appendChild(el('div', { class: 'grid-2' },
      el('div', { class: 'card summary' }, el('div', { class: 'card__body' }, o.packages.map(p => el('div', { class: 'summary__line' }, el('span', {}, MDM.pricing.lineLabel(p, o.service), el('small', {}, p.description)), el('span', { class: 'mono' }, MDM.pricing.format(p.price.lineTotal)))), MDM.pricing.feeLines(o).map(f => el('div', { class: 'summary__line summary__line--fee' }, el('span', {}, f.label), el('span', { class: 'mono' }, MDM.pricing.format(f.amount)))), el('div', { class: 'summary__total' }, el('span', {}, 'Total'), el('span', { class: 'mono' }, MDM.pricing.format(o.totals.total))))),
      el('div', { class: 'rate-table' }, el('div', { class: 'rate-table__row rate-table__row--head' }, 'Within Malé and Hulhumalé'), [['Bags', 'MVR 35 to 45'], ['Box', 'MVR 45 to 60'], ['XL packages', 'from MVR 60']].map(([l, v]) => el('div', { class: 'rate-table__row' }, el('div', { class: 'rate-table__label' }, l, el('small', {}, s.sizeGuide[l === 'Bags' ? 'bag' : l === 'Box' ? 'box' : 'xl'])), el('div', { class: 'rate-table__value' }, v))))));
    // timeline + stops
    g.appendChild(el('div', { class: 'grid-2' },
      el('ol', { class: 'timeline' }, o.events.slice(-4).map((e, i, a) => el('li', { class: 'timeline__item ' + (i < a.length - 1 ? 'is-done' : 'is-current') }, el('div', { class: 'timeline__title' }, e.label), el('div', { class: 'timeline__meta' }, MDM.ui.fmtDate(e.at))))),
      el('div', { class: 'stops' }, (o.route.stops || []).map((st, i) => el('div', { class: 'stop stop--' + st.type + (st.status === 'done' ? ' is-done' : i === 1 ? ' is-current' : '') }, el('div', { class: 'stop__marker' }, String(i + 1)), el('div', {}, el('div', { class: 'stop__title' }, st.label), el('div', { class: 'stop__meta' }, st.address)), el('div', { class: 'stop__aside' }, st.at ? MDM.ui.fmtDate(st.at) : 'Pending'))))));
    // dropzone + empty
    g.appendChild(el('div', { class: 'grid-2' }, el('div', { class: 'dropzone' }, el('div', { class: 'dropzone__title' }, 'Upload your transfer slip'), el('div', { class: 'dropzone__hint' }, 'JPG, PNG or PDF, up to 8 MB'), el('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, 'Choose a file')), el('div', { class: 'empty' }, el('div', { class: 'empty__title' }, 'No orders match these filters.'), el('div', { class: 'empty__hint' }, 'Try a wider date range.'), el('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, 'Clear filters'))));
    // map
    const mapWrap = el('div', { class: 'map' }); g.appendChild(mapWrap);
    try {
      const map = await MDM.map.create(mapWrap, {});
      const live = await MDM.store.orderByCode('MDM-1038');
      MDM.map.route(map, 'r', live.route.polyline, {});
      MDM.map.stopMarkers(map, live.route.stops);
      const pos = MDM.live.last('drv_nazim') || (await MDM.store.get('positions', 'drv_nazim'));
      const dm = MDM.map.driverMarker(map, pos, await MDM.store.get('drivers', 'drv_nazim'));
      MDM.live.onPosition('drv_nazim', p => dm.moveTo(p, 1000));
      MDM.map.fit(map, live.route.polyline);
      window.__mapOk = true;
    } catch (e) { mapWrap.innerHTML = '<div class="map__fallback"><div class="alert alert--warn">Map unavailable right now. Stops and status are still updated below.</div></div>'; window.__mapErr = String(e); }
    // toast + drawer test hooks
    MDM.ui.toast('Payment verified', 'ok');
    window.__ready = true;
  }
  main();
})(window.MDM);

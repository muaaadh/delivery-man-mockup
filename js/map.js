// Map helpers: MapLibre GL + OpenFreeMap "positron" (free vector tiles, no API key). Pages never call maplibregl directly.
// Internal coordinates are [lat, lng]; MapLibre wants [lng, lat], so conversion happens only inside this file.
// Production note: nothing here depends on the store; swap the style URL or the routing source without touching pages.
(function (MDM) { 'use strict';
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
  const ll = p => Array.isArray(p) ? [p[1], p[0]] : [p.lng, p.lat];

  // create(el, { interactive=true, center=[lat,lng], zoom=12.4 }) → Promise<map>; rejects if MapLibre is missing, the style errors, or 6 s pass.
  function create(el, opts) {
    opts = opts || {};
    const node = typeof el === 'string' ? document.getElementById(el) : el;
    return new Promise((resolve, reject) => {
      if (typeof maplibregl === 'undefined' || !node) return reject(new Error('map_unavailable'));
      let map;
      try {
        map = new maplibregl.Map({
          container: node, style: STYLE_URL, center: ll(opts.center || MDM.geo.CENTER), zoom: opts.zoom == null ? 12.4 : opts.zoom,
          interactive: opts.interactive !== false, attributionControl: false, scrollZoom: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
        });
      } catch (e) { return reject(e); }
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      if (opts.interactive !== false) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.touchZoomRotate.disableRotation();
      const timer = setTimeout(() => reject(new Error('map_timeout')), 6000);
      map.once('load', () => { clearTimeout(timer); resolve(map); });
      map.on('error', e => { if (!map.loaded()) { clearTimeout(timer); reject(e && e.error ? e.error : new Error('map_error')); } });
    });
  }

  // marker(map, kind, [lat,lng], { label, done, failed, heading, testid, driverId, stopId, initials })
  // kind: 'pickup' | 'dropoff' | 'return' | 'driver' | 'point'
  function marker(map, kind, pos, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'marker marker--' + kind + (opts.done ? ' marker--done' : '') + (opts.failed ? ' marker--failed' : '');
    el.setAttribute('data-testid', opts.testid || ('marker-' + kind));
    if (opts.driverId) el.setAttribute('data-driver-id', opts.driverId);
    if (opts.stopId) el.setAttribute('data-stop-id', opts.stopId);
    if (kind === 'driver') el.innerHTML = MDM.icon('navigation', 16);
    if (opts.label || opts.initials) { const s = document.createElement('span'); s.className = 'marker__label'; s.textContent = opts.label || opts.initials; el.appendChild(s); }
    if (opts.heading != null) el.style.setProperty('--heading', Math.round(opts.heading) + 'deg');
    const m = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(ll(pos)).addTo(map);
    return {
      el, marker: m,
      getLatLng() { const p = m.getLngLat(); return { lat: p.lat, lng: p.lng }; },
      setLatLng(p) { m.setLngLat(ll(p)); },
      setHeading(h) { el.style.setProperty('--heading', Math.round(h) + 'deg'); },
      setDone(d) { el.classList.toggle('marker--done', !!d); },
      setFailed(f) { el.classList.toggle('marker--failed', !!f); },
      setStale(s) { el.classList.toggle('is-stale', !!s); },
      setLabel(t) { let s = el.querySelector('.marker__label'); if (!t) { if (s) s.remove(); return; } if (!s) { s = document.createElement('span'); s.className = 'marker__label'; el.appendChild(s); } s.textContent = t; },
      remove() { m.remove(); },
    };
  }

  // stopMarkers(map, stops) — stops: [{ id, type, lat, lng, status, label }]
  function stopMarkers(map, stops) {
    let ms = [];
    const draw = list => {
      ms.forEach(x => x.remove()); ms = [];
      (list || []).forEach((s, i) => {
        if (s.lat == null || s.lng == null) return;
        ms.push(marker(map, s.type === 'pickup' ? 'pickup' : s.type === 'return' ? 'return' : 'dropoff', [s.lat, s.lng], { label: s.label || String(i + 1), done: s.status === 'done', failed: s.status === 'failed', stopId: s.id }));
      });
    };
    draw(stops);
    return { update: draw, remove() { ms.forEach(x => x.remove()); ms = []; }, markers: () => ms };
  }

  // route(map, id, polyline, { active=true, dashed }) → { update(polyline), setActive(bool), remove() }
  function route(map, id, polyline, opts) {
    opts = opts || {};
    let pl = polyline || [];
    const data = () => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: pl.map(ll) } });
    const opacity = a => a === false ? 0.35 : 0.9;
    if (map.getSource(id)) map.getSource(id).setData(data());
    else {
      map.addSource(id, { type: 'geojson', data: data() });
      map.addLayer({ id, type: 'line', source: id, layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: Object.assign({ 'line-color': opts.color || '#0f6fde', 'line-width': opts.width || 3, 'line-opacity': opacity(opts.active) }, opts.dashed ? { 'line-dasharray': [1.5, 2] } : {}) });
    }
    return {
      update(p) { pl = p || []; if (map.getSource(id)) map.getSource(id).setData(data()); },
      setActive(a) { if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', opacity(a)); },
      remove() { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); },
    };
  }

  // driverMarker(map, pos, driver) → { moveTo(pos, ms), setStale, remove }. Smooth rAF lerp only while visible; jumps when > 500 m; never extrapolates.
  function driverMarker(map, pos, driver) {
    const initials = driver && driver.name ? driver.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() : '';
    const mk = marker(map, 'driver', [pos.lat, pos.lng], { heading: pos.heading, initials, driverId: driver && driver.id });
    let raf = null, cur = { lat: pos.lat, lng: pos.lng, heading: pos.heading || 0 };
    function moveTo(p, ms) {
      if (raf) cancelAnimationFrame(raf);
      const from = Object.assign({}, cur), to = { lat: p.lat, lng: p.lng, heading: p.heading == null ? cur.heading : p.heading };
      const jump = document.visibilityState !== 'visible' || MDM.geo.haversine([from.lat, from.lng], [to.lat, to.lng]) > 0.5 || !ms;
      if (jump) { cur = to; mk.setLatLng(to); mk.setHeading(to.heading); return; }
      const start = performance.now();
      let dh = ((to.heading - from.heading + 540) % 360) - 180;
      const step = now => {
        const t = Math.min(1, (now - start) / ms);
        cur = { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t, heading: (from.heading + dh * t + 360) % 360 };
        mk.setLatLng(cur); mk.setHeading(cur.heading);
        if (t < 1) raf = requestAnimationFrame(step); else raf = null;
      };
      raf = requestAnimationFrame(step);
    }
    return { moveTo, setStale: mk.setStale, remove() { if (raf) cancelAnimationFrame(raf); mk.remove(); }, el: mk.el, position: () => cur };
  }

  function fit(map, points, opts) {
    opts = opts || {};
    const pts = (points || []).filter(p => p && (Array.isArray(p) ? p[0] != null : p.lat != null)).map(ll);
    if (!pts.length) return;
    if (pts.length === 1) { map.jumpTo({ center: pts[0], zoom: opts.maxZoom || 15 }); return; }
    const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: opts.padding == null ? 48 : opts.padding, maxZoom: opts.maxZoom || 16, duration: opts.animate ? 400 : 0 });
  }
  function panTo(map, p, zoom) { map.easeTo({ center: ll(p), zoom: zoom || Math.max(map.getZoom(), 15), duration: 400 }); }
  function refresh(map) { if (map && map.resize) requestAnimationFrame(() => map.resize()); }
  function destroy(map) { try { map && map.remove(); } catch (e) { /* already removed */ } }
  function available() { return typeof maplibregl !== 'undefined'; }

  MDM.map = { STYLE_URL, create, marker, stopMarkers, route, driverMarker, fit, panTo, refresh, destroy, available };
})(window.MDM);

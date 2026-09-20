// Geography for the Greater Malé area: service zones, real-road routing over MDM.roads (a small graph built from OpenStreetMap
// vector tiles), distance / ETA helpers, and the option lists forms use. Coordinates are [lat, lng] everywhere in this codebase.
// Production note: routeBetween() can be replaced by a routing API (OSRM/Mapbox Directions) that returns the same [[lat,lng],…] shape.
(function (MDM) { 'use strict';

  // Zones. `island` groups zones that are reachable without the bridge (same-island trips use the "same" rate).
  const ZONES = {
    male:         { key: 'male',         label: 'Malé',                       short: 'Malé',      island: 'male',      center: [4.1750, 73.5100], radius: 0.0035 },
    hulhumale_p1: { key: 'hulhumale_p1', label: 'Hulhumalé Phase 1',          short: 'HM Ph. 1',  island: 'hulhumale', center: [4.2146, 73.5421], radius: 0.0050 },
    hulhumale_p2: { key: 'hulhumale_p2', label: 'Hulhumalé Phase 2',          short: 'HM Ph. 2',  island: 'hulhumale', center: [4.2294, 73.5457], radius: 0.0045 },
    airport:      { key: 'airport',      label: 'Velana International Airport', short: 'Airport', island: 'hulhule',   center: [4.1915, 73.5285], radius: 0.0015, airport: true },
    villimale:    { key: 'villimale',    label: 'Villimalé',                  short: 'Villimalé', island: 'villimale', center: [4.1736, 73.4845], radius: 0.0015, ferry: true, quote: true },
  };
  const ZONE_LIST = Object.values(ZONES);
  const CENTER = [4.1990, 73.5270];
  // Bridge + Hulhulé link road: fast segments for ETA and simulation.
  const HIGHWAY_BBOX = { minLat: 4.1690, maxLat: 4.2060, minLng: 73.5160, maxLng: 73.5420 };

  const TERMINALS = [
    { value: 'male_north', label: 'Malé North Harbour', zone: 'male', point: [4.1790, 73.5090] },
    { value: 'male_tjetty', label: 'Malé T-Jetty', zone: 'male', point: [4.1785, 73.5115] },
    { value: 'hulhumale_ferry', label: 'Hulhumalé ferry terminal', zone: 'hulhumale_p1', point: [4.2105, 73.5372] },
    { value: 'villimale_ferry', label: 'Villimalé ferry terminal', zone: 'villimale', point: [4.1745, 73.4870] },
    { value: 'mpl_harbour', label: 'MPL commercial harbour', zone: 'male', point: [4.1710, 73.5060] },
  ];
  const AIRPORT_POINTS = [
    { value: 'arrivals', label: 'Arrivals hall', point: [4.1915, 73.5280] },
    { value: 'departures', label: 'Departures entrance', point: [4.1925, 73.5282] },
    { value: 'cargo', label: 'MACL cargo terminal', point: [4.1880, 73.5300] },
    { value: 'seaplane', label: 'Seaplane terminal', point: [4.1965, 73.5290] },
    { value: 'hotel', label: 'Hulhulé Island Hotel', point: [4.1855, 73.5290] },
  ];
  const MEET_AT = [
    { value: 'door', label: 'Door' },
    { value: 'lobby', label: "Lobby, I'll come down" },
    { value: 'reception', label: 'Reception or security' },
  ];

  function toRad(d) { return d * Math.PI / 180; }
  function haversine(a, b) {
    const R = 6371;
    const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function distanceKm(polyline) { let d = 0; for (let i = 1; i < polyline.length; i++) d += haversine(polyline[i - 1], polyline[i]); return d; }
  function bearing(a, b) {
    const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
    const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function inHighway(lat, lng) { return lat >= HIGHWAY_BBOX.minLat && lat <= HIGHWAY_BBOX.maxLat && lng >= HIGHWAY_BBOX.minLng && lng <= HIGHWAY_BBOX.maxLng; }

  // Deterministic jitter (mulberry32 seeded by a string hash) so the same address always lands on the same point.
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function geocodeZone(zoneKey, key) {
    const z = ZONES[zoneKey] || ZONES.male;
    const rnd = mulberry(hash(zoneKey + '|' + (key || '')));
    const p = [z.center[0] + (rnd() - 0.5) * z.radius * 1.6, z.center[1] + (rnd() - 0.5) * z.radius * 1.6];
    // Pull the point onto the nearest street intersection (within 250 m) so pins sit on real corners.
    const n = nearestNode(p, 3);
    return n && n.km < 0.25 ? { lat: n.lat, lng: n.lng } : { lat: p[0], lng: p[1] };
  }

  // ---- Road graph routing (Dijkstra over MDM.roads) ----
  let G = null;
  function graph() {
    if (G || !MDM.roads) return G;
    const q = MDM.roads.q;
    const nodes = MDM.roads.nodes.map(n => [n[0] * q, n[1] * q]);
    const adj = nodes.map(() => []);
    MDM.roads.edges.forEach(([a, b, c]) => {
      const d = haversine(nodes[a], nodes[b]);
      // Class weights: prefer bigger roads slightly so routes use the main streets.
      const w = d * (c <= 1 ? 1 : c === 2 ? 1.05 : c === 3 ? 1.1 : 1.2);
      adj[a].push([b, w, d]); adj[b].push([a, w, d]);
    });
    G = { nodes, adj, degree: adj.map(a => a.length) };
    return G;
  }
  function nearestNode(p, minDegree) {
    const g = graph(); if (!g) return null;
    let best = -1, bd = Infinity;
    for (let i = 0; i < g.nodes.length; i++) { if (minDegree && g.degree[i] < minDegree) continue; const d = (g.nodes[i][0] - p[0]) ** 2 + (g.nodes[i][1] - p[1]) ** 2; if (d < bd) { bd = d; best = i; } }
    return best < 0 ? null : { index: best, lat: g.nodes[best][0], lng: g.nodes[best][1], km: haversine(g.nodes[best], p) };
  }
  function shortestPath(from, to) {
    const g = graph(); if (!g) return null;
    const n = g.nodes.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    dist[from] = 0;
    const heap = [[0, from]];
    const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    while (heap.length) {
      const [d, u] = pop(); if (done[u]) continue; done[u] = 1; if (u === to) break;
      for (const [v, w] of g.adj[u]) { const nd = d + w; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push([nd, v]); } }
    }
    if (!isFinite(dist[to])) return null;
    const path = []; for (let u = to; u !== -1; u = prev[u]) path.push(g.nodes[u]); path.reverse();
    return path;
  }

  // routeBetween(a, b): a/b are { lat, lng, zone }. Returns [[lat,lng],…] following roads; villimalé legs return { ferry:true, points:[a,b] }.
  function routeBetween(a, b) {
    const za = ZONES[a.zone] || null, zb = ZONES[b.zone] || null;
    const pa = [a.lat, a.lng], pb = [b.lat, b.lng];
    const fa = !!(za && za.ferry), fb = !!(zb && zb.ferry);
    if (fa !== fb) return { ferry: true, points: [pa, pb] };
    const na = nearestNode(pa), nb = nearestNode(pb);
    if (!na || !nb) return [pa, pb];
    const path = shortestPath(na.index, nb.index);
    if (!path) return [pa, pb];
    const line = [pa];
    path.forEach(pt => line.push(pt));
    line.push(pb);
    return line;
  }
  // routeThrough(stops): chain stops into one polyline (ferry legs are skipped; callers draw both pins).
  function routeThrough(stops) {
    const out = [];
    for (let i = 1; i < stops.length; i++) {
      const seg = routeBetween(stops[i - 1], stops[i]);
      if (seg.ferry) continue;
      const pts = seg.slice();
      if (out.length) pts.shift();
      out.push(...pts);
    }
    return out.length ? out : (stops[0] ? [[stops[0].lat, stops[0].lng]] : []);
  }

  function pointAtDistance(polyline, km) {
    if (!polyline || !polyline.length) return null;
    if (polyline.length === 1) return { lat: polyline[0][0], lng: polyline[0][1], heading: 0, index: 0, done: true };
    let acc = 0;
    for (let i = 1; i < polyline.length; i++) {
      const seg = haversine(polyline[i - 1], polyline[i]);
      if (acc + seg >= km) {
        const f = seg ? Math.max(0, Math.min(1, (km - acc) / seg)) : 1;
        return { lat: polyline[i - 1][0] + (polyline[i][0] - polyline[i - 1][0]) * f, lng: polyline[i - 1][1] + (polyline[i][1] - polyline[i - 1][1]) * f, heading: bearing(polyline[i - 1], polyline[i]), index: i - 1, done: false };
      }
      acc += seg;
    }
    const last = polyline[polyline.length - 1];
    return { lat: last[0], lng: last[1], heading: bearing(polyline[polyline.length - 2], last), index: polyline.length - 2, done: true };
  }
  function pointAt(polyline, t) { return pointAtDistance(polyline, Math.max(0, Math.min(1, t)) * distanceKm(polyline)); }
  // Nearest position on the polyline: { index, t, kmFromStart, lat, lng, d }
  function projectOnto(polyline, p) {
    let best = null, acc = 0;
    for (let i = 1; i < polyline.length; i++) {
      const a = polyline[i - 1], b = polyline[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((p.lat - a[0]) * dx + (p.lng - a[1]) * dy) / len2)) : 0;
      const q = [a[0] + dx * t, a[1] + dy * t];
      const d = haversine(q, [p.lat, p.lng]);
      if (!best || d < best.d) best = { d, index: i - 1, t, kmFromStart: acc + haversine(a, q), lat: q[0], lng: q[1] };
      acc += haversine(a, b);
    }
    return best || { d: 0, index: 0, t: 0, kmFromStart: 0, lat: p.lat, lng: p.lng };
  }
  function remainingKm(polyline, p) { if (!polyline || polyline.length < 2) return 0; return Math.max(0, distanceKm(polyline) - projectOnto(polyline, p).kmFromStart); }

  function hhmmToMin(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function inPeak(settings, when) {
    const ops = settings && settings.ops; if (!ops || !ops.peakWindows) return false;
    const d = when || new Date(); const cur = d.getHours() * 60 + d.getMinutes();
    return ops.peakWindows.some(w => { const [a, b] = String(w).split('-'); const s = hhmmToMin(a), e = hhmmToMin(b); return s != null && e != null && cur >= s && cur <= e; });
  }
  // ETA in minutes for the remaining distance; crossIsland trips are mostly highway. Adds the peak buffer when crossing during a peak.
  function etaMinutes(km, crossIsland, settings) {
    const ops = (settings && settings.ops) || {};
    const city = ops.speedCityKmh || 18, hwy = ops.speedHighwayKmh || 40;
    const speed = crossIsland ? (city + hwy) / 2 : city;
    let min = (km / speed) * 60 + 2;
    if (crossIsland && inPeak(settings)) min += ops.peakBufferMin || 0;
    return Math.max(2, Math.round(min));
  }

  MDM.geo = {
    ZONES, ZONE_LIST, CENTER, HIGHWAY_BBOX, TERMINALS, AIRPORT_POINTS, MEET_AT,
    zone: k => ZONES[k] || null,
    zoneLabel: k => k === 'other' ? "Other (we'll confirm)" : ((ZONES[k] || {}).label || k),
    zoneShort: k => k === 'other' ? 'Other' : ((ZONES[k] || {}).short || k),
    island: k => (ZONES[k] || {}).island || 'other',
    zoneOptions: () => ZONE_LIST.map(z => ({ value: z.key, label: z.label })).concat([{ value: 'other', label: "Other (we'll confirm)" }]),
    isCrossIsland: (a, b) => { const ia = (ZONES[a] || {}).island, ib = (ZONES[b] || {}).island; return !!ia && !!ib && ia !== ib; },
    terminals: () => TERMINALS.slice(), airportPoints: () => AIRPORT_POINTS.slice(), meetAtOptions: () => MEET_AT.slice(),
    terminalPoint: v => (TERMINALS.find(t => t.value === v) || {}).point || null,
    airportPoint: v => (AIRPORT_POINTS.find(t => t.value === v) || {}).point || null,
    haversine, distanceKm, bearing, inHighway, geocodeZone, nearestNode, routeBetween, routeThrough,
    pointAt, pointAtDistance, projectOnto, remainingKm, etaMinutes, inPeak,
  };
})(window.MDM);

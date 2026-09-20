// Build a compact road graph for Greater Malé from OpenFreeMap vector tiles → js/roads.js (MDM.roads).
// Usage: node tools/geo-build-graph.js   (needs the dev server on :4180)
module.paths.push('/Users/muadhhashim/.npm/_npx/6bcb61ec6d5aea22/node_modules');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'];
const Q = 1e-5;               // coordinate quantum (~1.1 m)
const SNAP = 4e-5;            // node merge tolerance (~4.4 m): joins tile-boundary splits without merging parallel streets
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 1400 } });
  await p.goto('http://localhost:4180/mr-delivery-man-mockup/tools/geo-preview.html?fit=all', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.__map && window.__map.loaded());
  // Views covering Malé, Villimalé, Hulhulé, Hulhumalé Phase 1 and Phase 2 at z15 (tile geometry is ~1 m at this zoom).
  const views = [[4.1745, 73.5060], [4.1745, 73.5180], [4.1700, 73.4890], [4.1860, 73.5300], [4.2000, 73.5380], [4.2130, 73.5410], [4.2260, 73.5430], [4.2400, 73.5420]];
  const lines = [];
  for (const [lat, lng] of views) {
    await p.evaluate(([lat, lng]) => window.__map.jumpTo({ center: [lng, lat], zoom: 15.2 }), [lat, lng]);
    await p.waitForFunction(() => window.__map.areTilesLoaded() && window.__map.loaded());
    await p.waitForTimeout(1200);
    const feats = await p.evaluate((CLASSES) => {
      const m = window.__map;
      const src = Object.keys(m.getStyle().sources).find(k => m.getSource(k).type === 'vector');
      return m.querySourceFeatures(src, { sourceLayer: 'transportation' })
        .filter(f => CLASSES.includes(f.properties.class) && f.properties.subclass !== 'pedestrian' && f.properties.subclass !== 'footway')
        .map(f => ({ cls: f.properties.class, brunnel: f.properties.brunnel || '', geom: f.geometry }));
    }, CLASSES);
    feats.forEach(f => {
      const cs = f.geom.type === 'LineString' ? [f.geom.coordinates] : f.geom.type === 'MultiLineString' ? f.geom.coordinates : [];
      cs.forEach(c => lines.push({ cls: f.cls, brunnel: f.brunnel, pts: c.map(([lng, lat]) => [lat, lng]) }));
    });
  }
  await b.close();
  // Bounding box of interest (drop far-away ferry endpoints etc.)
  const inBox = ([la, lo]) => la > 4.160 && la < 4.250 && lo > 73.480 && lo < 73.560;
  // Node index with snapping
  const nodes = [], index = new Map();
  const key = ([la, lo]) => Math.round(la / SNAP) + ',' + Math.round(lo / SNAP);
  const nodeFor = (pt) => {
    const k = key(pt);
    if (index.has(k)) return index.get(k);
    // also check neighbours in the snap grid to merge near-coincident points
    const [ga, go] = k.split(',').map(Number);
    for (let da = -1; da <= 1; da++) for (let dO = -1; dO <= 1; dO++) {
      const kk = (ga + da) + ',' + (go + dO);
      if (index.has(kk)) { const id = index.get(kk); const n = nodes[id]; if (Math.hypot((n[0] - pt[0]) / SNAP, (n[1] - pt[1]) / SNAP) < 1.2) return id; }
    }
    const id = nodes.length; nodes.push([Math.round(pt[0] / Q), Math.round(pt[1] / Q)]); index.set(k, id); return id;
  };
  const edges = new Map();
  const CLASS_ID = { motorway: 0, trunk: 0, primary: 1, secondary: 2, tertiary: 3, minor: 4 };
  let kept = 0;
  lines.forEach(l => {
    const pts = l.pts.filter(inBox); if (pts.length < 2) return; kept++;
    for (let i = 1; i < pts.length; i++) {
      const a = nodeFor(pts[i - 1]), b = nodeFor(pts[i]); if (a === b) continue;
      const k = a < b ? a + '-' + b : b + '-' + a;
      const c = CLASS_ID[l.cls];
      if (!edges.has(k) || edges.get(k) > c) edges.set(k, c);
    }
  });
  let E = [...edges.entries()].map(([k, c]) => { const [a, b] = k.split('-').map(Number); return [a, b, c]; });
  // Tile simplification drops intersection vertices on straight roads, so crossing streets end ON a segment rather than at a shared
  // node. Split every edge at nodes that lie within SPLIT_M metres of it (interior of the segment).
  const SPLIT_M = 4;
  const mLat = Q * 111000, mLng = Q * 111000 * Math.cos(4.2 * Math.PI / 180);
  const xy = n => [nodes[n][1] * mLng, nodes[n][0] * mLat];
  const cell = 60; // metres
  const grid = new Map();
  nodes.forEach((_, i) => { const [x, y] = xy(i); const k = Math.floor(x / cell) + ':' + Math.floor(y / cell); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  let splits = 0;
  const E3 = [];
  E.forEach(([a, b, c]) => {
    const [ax, ay] = xy(a), [bx, by] = xy(b);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const hits = [];
    const cx0 = Math.floor(Math.min(ax, bx) / cell) - 1, cx1 = Math.floor(Math.max(ax, bx) / cell) + 1, cy0 = Math.floor(Math.min(ay, by) / cell) - 1, cy1 = Math.floor(Math.max(ay, by) / cell) + 1;
    for (let gx = cx0; gx <= cx1; gx++) for (let gy = cy0; gy <= cy1; gy++) {
      const list = grid.get(gx + ':' + gy); if (!list) continue;
      for (const n of list) {
        if (n === a || n === b) continue;
        const [px, py] = xy(n);
        const t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : -1;
        if (t <= 0.001 || t >= 0.999) continue;
        const qx = ax + dx * t, qy = ay + dy * t;
        if (Math.hypot(px - qx, py - qy) <= SPLIT_M) hits.push([t, n]);
      }
    }
    if (!hits.length) { E3.push([a, b, c]); return; }
    hits.sort((p, q) => p[0] - q[0]);
    let prev = a; hits.forEach(([, n]) => { if (n !== prev) { E3.push([prev, n, c]); prev = n; } }); if (prev !== b) E3.push([prev, b, c]);
    splits += hits.length;
  });
  E = E3;
  console.log('split edges at', splits, 'interior nodes');
  // Tile clipping and simplification leave junctions slightly apart; stitch components by joining their closest nodes when within JOIN_M metres.
  const JOIN_M = 45;
  const metres = (a, b) => Math.hypot((nodes[a][0] - nodes[b][0]) * Q * 111000, (nodes[a][1] - nodes[b][1]) * Q * 111000 * Math.cos(4.2 * Math.PI / 180));
  function components() {
    const adj = new Map(); E.forEach(([a, b]) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); });
    const seen = new Set(); const comps = [];
    for (const n of adj.keys()) { if (seen.has(n)) continue; const comp = []; const st = [n]; seen.add(n); while (st.length) { const x = st.pop(); comp.push(x); for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); st.push(y); } } comps.push(comp); }
    return comps.sort((a, b) => b.length - a.length);
  }
  let comps = components(), joined = 0;
  for (let round = 0; round < 20 && comps.length > 1; round++) {
    let merged = false;
    for (let i = 1; i < comps.length; i++) {
      let best = null;
      for (const a of comps[i]) for (let j = 0; j < i; j++) for (const b of comps[j]) { const d = metres(a, b); if (d <= JOIN_M && (!best || d < best.d)) best = { a, b, d }; }
      if (best) { E.push([best.a, best.b, 4]); joined++; merged = true; }
    }
    if (!merged) break;
    comps = components();
  }
  console.log('joined', joined, 'components after stitching', comps.length, 'sizes', comps.slice(0, 6).map(c => c.length).join(','));
  // Keep every component with at least 20 nodes (Villimalé is an island of its own, reached by ferry).
  const best = comps.filter(c => c.length >= 20).flat();
  const keep = new Set(best);
  const remap = new Map(); const N2 = []; best.forEach(n => { remap.set(n, N2.length); N2.push(nodes[n]); });
  const E2 = E.filter(([a, b]) => keep.has(a) && keep.has(b)).map(([a, b, c]) => [remap.get(a), remap.get(b), c]);
  // Delta-encode node coords for size
  const out = { q: Q, nodes: N2, edges: E2 };
  const js = '// Road graph for Greater Malé built from OpenFreeMap (OpenStreetMap) vector tiles by tools/geo-build-graph.js.\n' +
    '// nodes: [lat, lng] in units of q degrees; edges: [a, b, class] with class 0 motorway/trunk, 1 primary, 2 secondary, 3 tertiary, 4 minor.\n' +
    '// Data © OpenStreetMap contributors (ODbL). Regenerate with the tool; do not edit by hand.\n' +
    '(function (MDM) { \'use strict\';\n  MDM.roads = ' + JSON.stringify(out) + ';\n})(window.MDM);\n';
  fs.writeFileSync(path.join(__dirname, '..', 'js', 'roads.js'), js);
  console.log('lines', lines.length, 'kept', kept, 'nodes', N2.length, 'edges', E2.length, 'bytes', js.length);
})();

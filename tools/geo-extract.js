// Dump named road geometry from the OpenFreeMap vector tiles around Greater Malé (for corridor calibration).
// Usage: node tools/geo-extract.js > /tmp/roads.json
module.paths.push('/Users/muadhhashim/.npm/_npx/6bcb61ec6d5aea22/node_modules');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 1200 } });
  await p.goto('http://localhost:4180/mr-delivery-man-mockup/tools/geo-preview.html?fit=all', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.__map && window.__map.loaded());
  const views = [[4.176, 73.515, 15], [4.190, 73.532, 15], [4.212, 73.540, 15], [4.232, 73.541, 15], [4.200, 73.530, 14]];
  const all = {};
  for (const [lat, lng, z] of views) {
    await p.evaluate(([lat, lng, z]) => window.__map.jumpTo({ center: [lng, lat], zoom: z }), [lat, lng, z]);
    await p.waitForFunction(() => window.__map.areTilesLoaded() && window.__map.loaded());
    await p.waitForTimeout(1500);
    const feats = await p.evaluate(() => {
      const m = window.__map;
      const src = Object.keys(m.getStyle().sources).find(k => m.getSource(k).type === 'vector');
      const fs = m.querySourceFeatures(src, { sourceLayer: 'transportation' });
      const names = m.querySourceFeatures(src, { sourceLayer: 'transportation_name' });
      const take = f => ({ cls: f.properties.class, sub: f.properties.subclass, name: f.properties.name || f.properties['name:latin'] || '', bridge: f.properties.brunnel, geom: f.geometry });
      return { roads: fs.filter(f => ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(f.properties.class)).map(take), names: names.map(take) };
    });
    feats.roads.concat(feats.names).forEach(f => {
      const coords = f.geom.type === 'LineString' ? [f.geom.coordinates] : f.geom.type === 'MultiLineString' ? f.geom.coordinates : [];
      coords.forEach(line => { const key = (f.name || '?') + '|' + f.cls + (f.bridge ? '|' + f.bridge : ''); (all[key] = all[key] || []).push(line.map(c => [Number(c[1].toFixed(5)), Number(c[0].toFixed(5))])); });
    });
  }
  await b.close();
  const summary = Object.entries(all).map(([k, lines]) => ({ key: k, lines: lines.length, points: lines.reduce((n, l) => n + l.length, 0), bbox: lines.flat().reduce((bb, [la, lo]) => [Math.min(bb[0], la), Math.min(bb[1], lo), Math.max(bb[2], la), Math.max(bb[3], lo)], [99, 999, -99, -999]) }));
  console.error(JSON.stringify(summary.sort((a, b) => b.points - a.points).slice(0, 40), null, 0));
  console.log(JSON.stringify(all));
})();

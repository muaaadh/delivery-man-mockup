// Live rider location. In the demo, positions travel through MDM.store's 'positions' collection (one doc per driver, id = driverId,
// localStorage plus the store's cross-tab channel), so every open tab sees the same rider dots. Three producers feed
// publishPosition(): the driver page's real GPS (watchGPS), the driver page's route simulation (simulate) and the demo autopilot
// that keeps the seeded in-transit order moving on every page so the tracking demo is never static.
//
// Production: publishPosition()/onPosition() are rewritten over a Supabase Realtime channel (a `positions` table with replication,
// or broadcast) and autopilot() is deleted outright. simulate(), watchGPS() and every page keep working unchanged because they only
// ever talk to those two functions; the simulation stays useful for driver training and QA.
(function (MDM) { 'use strict';
  // 900 ms rather than 1000 so a 1 s ticker never lands a few milliseconds inside its own window (rate stays about 1 per second).
  const PUBLISH_WINDOW_MS = 900;
  const GPS_HEARTBEAT_MS = 15000;      // re-publish an unchanged GPS fix so "Updated n s ago" stays under the 15 s staleness mark
  const LEASE_KEY = 'mdm:simlease', LEASE_REFRESH_MS = 2000, LEASE_STALE_MS = 6000;
  const HIGHWAY_KMH = 40, SIM_STEP_S = 5, CATCHUP_MAX_S = 60;
  const AUTOPILOT_CODE = 'MDM-1038', AUTOPILOT_KMH = 25;

  const lastPos = Object.create(null);     // driverId → last known position (published here or received through the store)
  const gates = Object.create(null);       // driverId → { at, last, pending, timer } publish throttle
  const listeners = [];                    // { driverId, cb }
  let feed = null;                         // store unsubscribe once the positions feed is attached
  let tabId = null;

  function tab() { return tabId || (tabId = MDM.id('tab')); }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function rethrow(e) { setTimeout(() => { throw e; }, 0); }   // surfaces listener bugs without breaking the feed

  // ---- Publish / subscribe ------------------------------------------------------------------------------------------------
  function sameFix(a, b) { return !!a && !!b && a.lat === b.lat && a.lng === b.lng && Math.round(a.heading) === Math.round(b.heading) && a.source === b.source; }

  // publishPosition({ driverId, lat, lng, heading, speed, accuracy, source }) → Promise<position|null>
  // At most one stored fix per driver per window: a newer fix inside the window is kept and written when the window ends; a fix
  // identical to the last one inside the window is dropped (null). Identical fixes outside the window are written (heartbeat).
  function publishPosition(p) {
    if (!p || !p.driverId || !isFinite(p.lat) || !isFinite(p.lng)) return Promise.reject(new Error('publishPosition: driverId, lat and lng are required'));
    const id = String(p.driverId);
    const g = gates[id] || (gates[id] = { at: 0, last: null, pending: null, timer: null });
    const fix = { id, driverId: id, lat: Number(p.lat), lng: Number(p.lng), heading: (num(p.heading, 0) % 360 + 360) % 360, speed: Math.max(0, num(p.speed, 0)), accuracy: Math.max(0, num(p.accuracy, 0)), source: p.source === 'gps' ? 'gps' : 'sim' };
    const wait = PUBLISH_WINDOW_MS - (Date.now() - g.at);
    if (wait > 0) {
      if (sameFix(fix, g.last)) return Promise.resolve(null);
      g.pending = fix;
      if (!g.timer) g.timer = setTimeout(() => { g.timer = null; const f = g.pending; g.pending = null; if (f) write(g, f).catch(rethrow); }, wait);
      return Promise.resolve(null);
    }
    return write(g, fix);
  }
  async function write(g, fix) {
    g.at = Date.now(); g.last = fix;
    const doc = Object.assign({}, fix, { at: new Date(g.at).toISOString() });
    lastPos[doc.id] = doc;
    await MDM.store.ready;
    const cur = await MDM.store.get('positions', doc.id);
    return cur ? MDM.store.update('positions', doc.id, doc) : MDM.store.insert('positions', doc);
  }

  function ensureFeed() {
    if (feed || !MDM.store || typeof MDM.store.subscribe !== 'function') return;
    feed = MDM.store.subscribe('positions', onStoreChange);
    MDM.store.ready.then(reloadAll).catch(rethrow);
  }
  async function reloadAll(dispatchAll) {
    const all = await MDM.store.list('positions');
    const seen = Object.create(null);
    all.forEach(p => { if (p && p.id) { seen[p.id] = true; if (!lastPos[p.id] || String(p.at) >= String(lastPos[p.id].at)) lastPos[p.id] = p; } });
    Object.keys(lastPos).forEach(k => { if (!seen[k]) delete lastPos[k]; });
    if (dispatchAll) all.forEach(dispatch);
  }
  async function onStoreChange(msg) {
    if (!msg || msg.collection !== 'positions') return;
    if (msg.op === 'remove' && msg.id) { delete lastPos[msg.id]; return; }
    const ids = msg.ids && msg.ids.length ? msg.ids : (msg.id ? [msg.id] : null);
    if (!ids) { await reloadAll(true); return; }
    for (const id of ids) {
      const doc = await MDM.store.get('positions', id);
      if (!doc) { delete lastPos[id]; continue; }
      lastPos[doc.id] = doc;
      dispatch(doc);
    }
  }
  function dispatch(doc) {
    listeners.slice().forEach(l => {
      if (l.driverId !== '*' && l.driverId !== doc.driverId) return;
      try { l.cb(doc); } catch (e) { rethrow(e); }
    });
  }
  // onPosition(driverId|'*', cb) → unsubscribe. cb(position) for every stored change, local or from another tab.
  function onPosition(driverId, cb) {
    if (typeof cb !== 'function') throw new Error('onPosition: callback required');
    ensureFeed();
    const l = { driverId: driverId ? String(driverId) : '*', cb };
    listeners.push(l);
    return function () { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
  }
  function last(driverId) { ensureFeed(); return lastPos[driverId] ? Object.assign({}, lastPos[driverId]) : null; }

  // ---- Simulation lease (one tab drives the demo rider) -------------------------------------------------------------------
  function readLease() {
    try { const v = JSON.parse(localStorage.getItem(LEASE_KEY) || 'null'); return v && v.tabId && typeof v.at === 'number' ? v : null; }
    catch (e) { return null; }
  }
  function leaseFresh(l) { return !!l && Date.now() - l.at < LEASE_STALE_MS; }
  function writeLease(owner) {
    try { localStorage.setItem(LEASE_KEY, JSON.stringify({ tabId: tab(), at: Date.now(), owner: owner || 'autopilot' })); return true; }
    catch (e) { return false; }
  }
  // takeLease(owner): 'driver' (the driver page's Simulate or GPS) may take over a live autopilot lease from any tab; nothing takes
  // over a fresh 'driver' lease held elsewhere. Returns true when this tab now holds it.
  function takeLease(owner) {
    owner = owner === 'driver' ? 'driver' : 'autopilot';
    const l = readLease();
    if (l && l.tabId === tab()) return writeLease(owner === 'driver' || l.owner === 'driver' ? 'driver' : 'autopilot');
    if (leaseFresh(l) && !(owner === 'driver' && l.owner !== 'driver')) return false;
    return writeLease(owner);
  }
  function releaseLease() {
    const l = readLease();
    if (l && l.tabId === tab()) { try { localStorage.removeItem(LEASE_KEY); } catch (e) { /* storage blocked; the lease goes stale in 6 s */ } }
    return true;
  }
  function holdsLease() { const l = readLease(); return !!l && l.tabId === tab() && leaseFresh(l); }

  // Driver-side holders (simulate and watchGPS) keep the 'driver' lease refreshed while they run.
  let driverHolds = 0, driverLeaseTimer = null;
  function holdDriverLease() {
    driverHolds += 1;
    takeLease('driver');
    if (auto && auto.sim) autoYield();
    if (!driverLeaseTimer) driverLeaseTimer = setInterval(() => { takeLease('driver'); }, LEASE_REFRESH_MS);
  }
  function dropDriverLease() {
    driverHolds = Math.max(0, driverHolds - 1);
    if (driverHolds) return;
    clearInterval(driverLeaseTimer); driverLeaseTimer = null;
    const l = readLease();
    if (l && l.tabId === tab() && l.owner === 'driver') releaseLease();
  }

  // ---- Route simulation ---------------------------------------------------------------------------------------------------
  function storedTimeScale() {
    try { const v = parseFloat(localStorage.getItem('mdm:timeScale')); return v > 0 ? v : 1; } catch (e) { return 1; }
  }
  // Nearest point of the polyline to pt, considering only the part at or after fromKm, so stops are matched in route order even
  // when the route passes the same street twice. Returns { km, d } (km along the line, d = distance from pt in km).
  function projectAfter(line, pt, fromKm) {
    let acc = 0, best = null;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], seg = MDM.geo.haversine(a, b);
      if (acc + seg >= fromKm - 1e-9) {
        const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
        let t = len2 ? ((pt.lat - a[0]) * dx + (pt.lng - a[1]) * dy) / len2 : 0;
        const tMin = seg ? Math.max(0, Math.min(1, (fromKm - acc) / seg)) : 0;
        t = Math.max(tMin, Math.min(1, t));
        const q = [a[0] + dx * t, a[1] + dy * t], d = MDM.geo.haversine(q, [pt.lat, pt.lng]);
        if (!best || d < best.d) best = { d, km: acc + seg * t };
      }
      acc += seg;
    }
    return best || { d: 0, km: Math.min(fromKm, acc) };
  }

  // simulate(driverId, polyline, { speedKmh=25, timeScale, stops=[], dwellMs=0, autoStops=false, onStop(stop, i), onEnd(), loop=false,
  //   source='sim', startKm=0 }) → { stop(), pause(), resume(), get state }
  // Time-based: each tick advances by elapsed real time × timeScale at 40 km/h inside the highway box, else speedKmh, so a tab that
  // was in the background catches up on visibilitychange. Pauses at each stop in order (the nearest route point to the stop) and
  // calls onStop once; with autoStops it records arrived → (dwellMs) → done through the store and continues; otherwise it waits for
  // resume(). The position is published through publishPosition once a second, including while waiting at a stop.
  function simulate(driverId, polyline, opts) {
    opts = opts || {};
    const line = (polyline || []).filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]));
    if (!driverId || line.length < 2) throw new Error('simulate: driverId and a polyline with at least 2 points are required');
    const speedKmh = opts.speedKmh > 0 ? Number(opts.speedKmh) : 25;
    const timeScale = opts.timeScale > 0 ? Number(opts.timeScale) : storedTimeScale();
    const source = opts.source === 'gps' ? 'gps' : 'sim';
    const by = 'driver:' + driverId;
    const kmTotal = MDM.geo.distanceKm(line);
    const stops = (opts.stops || []).filter(s => s && isFinite(s.lat) && isFinite(s.lng));
    const stopKm = [];
    { let from = 0; stops.forEach(s => { const pr = projectAfter(line, s, from); stopKm.push(pr.km); from = pr.km; }); }
    const st = { running: true, paused: false, atStop: false, kmDone: Math.max(0, Math.min(kmTotal, num(opts.startKm, 0))), kmTotal, stopIndex: 0, position: null, speedKmh, timeScale, loops: 0, error: null };
    while (st.stopIndex < stopKm.length && stopKm[st.stopIndex] < st.kmDone - 1e-6) st.stopIndex += 1;   // stops before startKm count as passed
    const fired = new Set();
    let timer = null, dwellTimer = null, lastAt = Date.now();

    function place() {
      const p = MDM.geo.pointAtDistance(line, st.kmDone);
      const moving = !st.paused && !st.atStop;
      st.position = { lat: p.lat, lng: p.lng, heading: p.heading, speed: moving ? (MDM.geo.inHighway(p.lat, p.lng) ? HIGHWAY_KMH : speedKmh) : 0 };
      return st.position;
    }
    function publish() {
      const p = place();
      publishPosition({ driverId, lat: p.lat, lng: p.lng, heading: p.heading, speed: p.speed, accuracy: 5, source }).catch(e => { st.error = e; });
    }
    function arrive(i) {
      st.atStop = true;
      if (fired.has(i)) return;
      fired.add(i);
      const stop = stops[i];
      if (typeof opts.onStop === 'function') { try { opts.onStop(stop, i); } catch (e) { rethrow(e); } }
      if (opts.autoStops) autoStop(stop).catch(rethrow);
    }
    async function autoStop(stop) {
      const canWrite = stop && stop.orderId && stop.id && MDM.store && typeof MDM.store.setStop === 'function';
      // A stop that is already arrived/done (second loop, or the driver tapped first) throws a transition error: keep driving.
      if (canWrite) { try { await MDM.store.setStop(stop.orderId, stop.id, { status: 'arrived', by }); } catch (e) { st.error = e; } }
      if (!st.running) return;
      await new Promise(r => { dwellTimer = setTimeout(r, Math.max(0, num(opts.dwellMs, 0))); });
      if (!st.running) return;
      if (canWrite) { try { await MDM.store.setStop(stop.orderId, stop.id, { status: 'done', by }); } catch (e) { st.error = e; } }
      if (st.running && st.atStop) ctl.resume();
    }
    function finish() {
      st.running = false; st.paused = false; st.atStop = false;
      teardown();
      if (typeof opts.onEnd === 'function') { try { opts.onEnd(); } catch (e) { rethrow(e); } }
    }
    function tick() {
      const t = Date.now();
      const dtReal = Math.min(CATCHUP_MAX_S, Math.max(0, (t - lastAt) / 1000));
      lastAt = t;
      if (!st.running) return;
      if (st.paused || st.atStop) { publish(); return; }
      if (st.stopIndex < stopKm.length && st.kmDone >= stopKm[st.stopIndex] - 1e-9) { arrive(st.stopIndex); publish(); return; }
      let simSec = dtReal * st.timeScale;
      while (simSec > 0 && st.running && !st.atStop) {
        const step = Math.min(simSec, SIM_STEP_S); simSec -= step;   // short steps keep the city/highway speed change and stop checks exact
        const p = MDM.geo.pointAtDistance(line, st.kmDone);
        const kmh = MDM.geo.inHighway(p.lat, p.lng) ? HIGHWAY_KMH : speedKmh;
        const next = st.kmDone + kmh * step / 3600;
        if (st.stopIndex < stopKm.length && next >= stopKm[st.stopIndex] - 1e-9) { st.kmDone = stopKm[st.stopIndex]; arrive(st.stopIndex); break; }
        st.kmDone = next;
        if (st.kmDone >= kmTotal - 1e-9) {
          if (opts.loop) { st.kmDone = 0; st.stopIndex = 0; st.loops += 1; fired.clear(); }
          else { st.kmDone = kmTotal; publish(); finish(); return; }
        }
      }
      publish();
    }
    function onVis() { tick(); }
    function teardown() {
      clearInterval(timer); timer = null;
      clearTimeout(dwellTimer); dwellTimer = null;
      document.removeEventListener('visibilitychange', onVis);
      if (!opts._autopilot) dropDriverLease();
    }
    const ctl = {
      stop() { if (!st.running) return; st.running = false; st.atStop = false; st.paused = false; teardown(); },
      pause() { if (!st.running || st.paused) return; st.paused = true; lastAt = Date.now(); publish(); },
      resume() {
        if (!st.running) return;
        if (st.atStop) { st.atStop = false; st.stopIndex += 1; clearTimeout(dwellTimer); dwellTimer = null; }
        st.paused = false; lastAt = Date.now();
        tick();
      },
      get state() {
        return { running: st.running, paused: st.paused || st.atStop, atStop: st.atStop, kmDone: st.kmDone, kmTotal: st.kmTotal, stopIndex: st.stopIndex,
          stop: st.atStop ? (stops[st.stopIndex] || null) : null, stops: stops.length, position: st.position ? Object.assign({}, st.position) : null,
          speedKmh: st.speedKmh, timeScale: st.timeScale, loops: st.loops, error: st.error };
      },
    };
    if (!opts._autopilot) holdDriverLease();
    document.addEventListener('visibilitychange', onVis);
    timer = setInterval(tick, 1000);
    tick();
    return ctl;
  }

  // ---- Real GPS (driver page) ---------------------------------------------------------------------------------------------
  let gps = null;             // { driverId, watchId, lastFix, lastPub, heartbeat, settled }
  let gpsStateValue = 'off';  // 'off' | 'on' | 'denied' | 'unavailable'
  function gpsError(code, message) { const e = new Error(message); e.code = code; return e; }

  // watchGPS(driverId, { onFix, onError }) → Promise<void> that settles on the first fix or the first error. navigator.geolocation
  // .watchPosition is called synchronously so the browser ties the permission prompt to the user's tap. Rejections carry .code:
  // 'insecure' (not https), 'unsupported', or the GeolocationPositionError code 1 (denied) / 2 / 3.
  function watchGPS(driverId, opts) {
    opts = opts || {};
    if (!driverId) return Promise.reject(gpsError('driver', 'watchGPS: driverId is required'));
    if (!window.isSecureContext) { gpsStateValue = 'unavailable'; return Promise.reject(gpsError('insecure', 'Location sharing needs an https address')); }
    if (!navigator.geolocation || typeof navigator.geolocation.watchPosition !== 'function') { gpsStateValue = 'unavailable'; return Promise.reject(gpsError('unsupported', 'This browser cannot share location')); }
    stopGPS();
    const g = gps = { driverId: String(driverId), watchId: null, lastFix: null, lastPub: null, heartbeat: null, settled: false };
    holdDriverLease();
    gpsStateValue = 'on';
    return new Promise((resolve, reject) => {
      g.watchId = navigator.geolocation.watchPosition(
        pos => onGpsFix(g, pos, opts, resolve),
        err => onGpsError(g, err, opts, reject),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
      g.heartbeat = setInterval(() => {
        if (gps !== g || !g.lastPub) return;
        if (Date.now() - g.lastPub.at >= GPS_HEARTBEAT_MS) { g.lastPub = Object.assign({}, g.lastPub, { at: Date.now() }); publishFix(g, g.lastPub); }
      }, GPS_HEARTBEAT_MS);
    });
  }
  function publishFix(g, f) {
    publishPosition({ driverId: g.driverId, lat: f.lat, lng: f.lng, heading: f.heading, speed: f.speed, accuracy: f.accuracy, source: 'gps' }).catch(rethrow);
  }
  function onGpsFix(g, pos, opts, resolve) {
    if (gps !== g) return;
    const c = pos.coords;
    const fix = { lat: c.latitude, lng: c.longitude, accuracy: num(c.accuracy, 0), speed: num(c.speed, NaN) * 3.6, heading: num(c.heading, NaN), at: Date.now() };
    const prev = g.lastPub;
    const movedKm = prev ? MDM.geo.haversine([prev.lat, prev.lng], [fix.lat, fix.lng]) : Infinity;
    // Phones report heading only while moving; fall back to the bearing from the last published point, else keep the old heading.
    if (isNaN(fix.heading)) fix.heading = prev ? (movedKm >= 0.003 ? MDM.geo.bearing([prev.lat, prev.lng], [fix.lat, fix.lng]) : prev.heading) : 0;
    if (isNaN(fix.speed)) fix.speed = prev ? Math.min(120, movedKm / Math.max(0.001, (fix.at - prev.at) / 3600000)) : 0;
    gpsStateValue = 'on'; g.lastFix = fix;
    if (typeof opts.onFix === 'function') { try { opts.onFix(fix); } catch (e) { rethrow(e); } }
    const turned = prev ? Math.abs(((fix.heading - prev.heading + 540) % 360) - 180) : 360;
    if (prev && movedKm < 0.003 && turned < 10) { if (!g.settled) { g.settled = true; resolve(); } return; }   // moved < 3 m and turned < 10°
    g.lastPub = fix;
    publishFix(g, fix);
    if (!g.settled) { g.settled = true; resolve(); }
  }
  function onGpsError(g, err, opts, reject) {
    if (gps !== g) return;
    const code = err && err.code;
    if (code === 1) { gpsStateValue = 'denied'; clearGps(g); }
    else gpsStateValue = g.lastFix ? 'on' : 'unavailable';
    if (typeof opts.onError === 'function') { try { opts.onError(err); } catch (e) { rethrow(e); } }
    if (!g.settled) { g.settled = true; reject(err); }
  }
  function clearGps(g) {
    if (g.watchId != null && navigator.geolocation) { try { navigator.geolocation.clearWatch(g.watchId); } catch (e) { /* already cleared */ } }
    g.watchId = null;
    clearInterval(g.heartbeat); g.heartbeat = null;
    if (gps === g) { gps = null; dropDriverLease(); }
  }
  function stopGPS() {
    if (gps) clearGps(gps);
    if (gpsStateValue !== 'denied') gpsStateValue = 'off';
  }
  function gpsState() { return gpsStateValue; }

  // ---- Demo autopilot (delete in production) -------------------------------------------------------------------------------
  // Keeps the seeded in-transit order (MDM-1038) moving along its polyline at 25 km/h, looping, in exactly one tab: the tab holds
  // `mdm:simlease` refreshed every 2 s, another tab takes over when the lease is missing or older than 6 s, and the lease is released
  // on pagehide. Positions only, source 'sim', never a status change. Yields as soon as a driver page simulates or shares GPS.
  let auto = null;
  function autopilot() {
    if (auto) return auto.promise;
    auto = { timer: null, sim: null, orderId: null, code: null, driverId: null, enabled: false, busy: false, idle: 0 };
    auto.promise = (async () => {
      await MDM.store.ready;
      ensureFeed();
      window.addEventListener('pagehide', () => { autoYield(); });
      auto.timer = setInterval(() => { autoTick().catch(rethrow); }, LEASE_REFRESH_MS);
      await autoTick();
    })();
    return auto.promise;
  }
  async function autoTick() {
    if (auto.busy) return;
    auto.busy = true;
    try {
      const s = await MDM.store.settings();
      auto.enabled = !!(s && s.demo && s.demo.autopilot);
      const l = readLease();
      if (!auto.enabled || (l && l.tabId === tab() && l.owner === 'driver') || (l && l.tabId !== tab() && leaseFresh(l))) { autoYield(); return; }
      if (!writeLease('autopilot')) { autoYield(); return; }
      if (auto.sim) {
        const o = await MDM.store.get('orders', auto.orderId);
        if (!o || o.status !== 'in_transit' || o.driverId !== auto.driverId) autoStopSim();
        return;
      }
      // While idle, look for a drivable order every 5th tick (10 s) rather than on every lease refresh.
      if (auto.idle++ % 5 === 0) await autoStart();
    } finally { auto.busy = false; }
  }
  async function autoStart() {
    const list = await MDM.store.list('orders', { where: { status: 'in_transit' } });
    const ok = list.filter(o => o && o.driverId && o.route && Array.isArray(o.route.polyline) && o.route.polyline.length >= 2);
    const order = ok.find(o => o.code === AUTOPILOT_CODE) || ok[0];
    if (!order) return;
    const line = order.route.polyline;
    // Start from where the rider was last seen so the marker does not jump back to the pickup on every reload.
    let startKm = 0;
    const seen = lastPos[order.driverId] || await MDM.store.get('positions', order.driverId);
    if (seen && isFinite(seen.lat) && isFinite(seen.lng)) { const pr = MDM.geo.projectOnto(line, seen); if (pr.d < 0.3) startKm = pr.kmFromStart; }
    auto.orderId = order.id; auto.code = order.code; auto.driverId = order.driverId;
    auto.sim = simulate(order.driverId, line, { speedKmh: AUTOPILOT_KMH, timeScale: 1, loop: true, stops: [], source: 'sim', startKm, _autopilot: true });
  }
  function autoStopSim() {
    if (auto && auto.sim) { auto.sim.stop(); auto.sim = null; }
    if (auto) { auto.orderId = null; auto.code = null; auto.driverId = null; auto.idle = 0; }
  }
  function autoYield() {
    autoStopSim();
    const l = readLease();
    if (l && l.tabId === tab() && l.owner === 'autopilot') releaseLease();
  }
  function autopilotState() {
    const l = readLease();
    return { started: !!auto, enabled: !!(auto && auto.enabled), tabId: tab(), lease: l, holdsLease: !!l && l.tabId === tab() && leaseFresh(l),
      running: !!(auto && auto.sim), orderId: auto ? auto.orderId : null, code: auto ? auto.code : null, driverId: auto ? auto.driverId : null,
      sim: auto && auto.sim ? auto.sim.state : null };
  }

  MDM.live = {
    publishPosition, onPosition, last, simulate, watchGPS, stopGPS, gpsState, autopilot, autopilotState,
    lease: { take: takeLease, release: releaseLease, read: readLease, holds: holdsLease, KEY: LEASE_KEY, STALE_MS: LEASE_STALE_MS },
    timeScale: storedTimeScale,
  };
})(window.MDM);

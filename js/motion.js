// Motion: scroll reveals, word-split headlines, binary word-fill statements, count-ups and a single rAF scroll driver.
// Markup hooks (all optional, any page):
//   [data-reveal]            fades up 20px when it enters the viewport; ="fade" (no movement) or ="scale"; delay via style="--d:200ms"
//   [data-reveal-group]      children with [data-reveal] get a 90ms stagger unless they set --d themselves
//   [data-split]             splits the text into masked words that rise in when the element enters (headlines)
//   [data-fill]              words fill from grey to ink as the paragraph scrolls through the viewport (binary per word)
//   [data-count]             every number in the text counts up from 0 when it enters
// MDM.motion.addScene({ measure(vh), update(scrollY, vh) }) registers a scrubbed effect on the same rAF loop.
// Nothing is hidden unless this script runs (the CSS keys off html.motion), and prefers-reduced-motion shows everything at rest.
(function (MDM) { 'use strict';
  const root = document.documentElement;
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const scenes = [];
  let vh = window.innerHeight, ticking = false;

  // ---- Word splitting (mask per word, so any line wrap works without measuring) ----
  function splitWords(el) {
    if (el.dataset.splitDone) return;
    el.dataset.splitDone = '1';
    let i = 0;
    const walk = node => {
      Array.from(node.childNodes).forEach(child => {
        if (child.nodeType === 3) {
          const parts = child.textContent.split(/(\s+)/);
          const frag = document.createDocumentFragment();
          parts.forEach(p => {
            if (!p) return;
            if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(' ')); return; }
            const w = document.createElement('span'); w.className = 'w';
            const wi = document.createElement('span'); wi.className = 'wi'; wi.style.setProperty('--i', String(i++)); wi.textContent = p;
            w.appendChild(wi); frag.appendChild(w);
          });
          child.replaceWith(frag);
        } else if (child.nodeType === 1 && child.tagName !== 'BR') walk(child);
      });
    };
    walk(el);
  }
  function splitFill(el) {
    if (el.dataset.fillDone) return [];
    el.dataset.fillDone = '1';
    const words = [];
    const walk = node => {
      Array.from(node.childNodes).forEach(child => {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach(p => {
            if (!p) return;
            if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(' ')); return; }
            const s = document.createElement('span'); s.className = 'fw'; s.textContent = p; words.push(s); frag.appendChild(s);
          });
          child.replaceWith(frag);
        } else if (child.nodeType === 1) walk(child);
      });
    };
    walk(el);
    return words;
  }

  // ---- Count-up: every number in the element's text animates from 0 to its value ----
  function countUp(el) {
    if (el.dataset.counted) return;
    el.dataset.counted = '1';
    const final = el.textContent;
    const nums = final.match(/\d[\d,]*/g);
    if (!nums || reduced) return;
    const dur = 1100, t0 = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    const step = now => {
      const t = Math.min(1, (now - t0) / dur), e = ease(t);
      if (t >= 1) { el.textContent = el.dataset.countFinal || final; return; }
      let k = 0;
      el.textContent = final.replace(/\d[\d,]*/g, m => { k++; return Math.round(Number(m.replace(/,/g, '')) * e).toLocaleString('en-US'); });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---- Reveal observer ----
  let io = null;
  function reveal(el) {
    el.classList.add('is-in');
    if (el.hasAttribute('data-count')) countUp(el);
    el.querySelectorAll('[data-count]').forEach(countUp);
  }
  function observe(scope) {
    scope = scope || document;
    scope.querySelectorAll('[data-reveal-group]').forEach(g => {
      Array.from(g.querySelectorAll('[data-reveal]')).forEach((c, i) => { if (!c.style.getPropertyValue('--d')) c.style.setProperty('--d', (i * 90) + 'ms'); });
    });
    scope.querySelectorAll('[data-split]').forEach(splitWords);
    const targets = scope.querySelectorAll('[data-reveal], [data-split], [data-count]');
    if (reduced || !('IntersectionObserver' in window)) { targets.forEach(reveal); return; }
    if (!io) io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { reveal(e.target); io.unobserve(e.target); } }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    targets.forEach(t => { if (!t.classList.contains('is-in')) io.observe(t); });
  }

  // ---- One rAF scroll driver ----
  function measureAll() { vh = window.innerHeight; scenes.forEach(s => { if (s.measure) s.measure(vh); }); frame(); }
  function frame() { ticking = false; const y = window.scrollY; scenes.forEach(s => s.update(y, vh)); }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }
  function addScene(scene) {
    if (reduced) return;
    scenes.push(scene);
    if (scene.measure) scene.measure(vh);
    scene.update(window.scrollY, vh);
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  // Page-absolute top of an element (measured once, not in the scroll handler).
  function pageTop(el) { let y = 0; for (let n = el; n; n = n.offsetParent) y += n.offsetTop; return y; }

  // Word-fill scene for every [data-fill]: word i is on once progress passes i / n.
  function fillScene(el) {
    const words = splitFill(el);
    if (!words.length) return;
    if (reduced) { words.forEach(w => w.classList.add('is-on')); return; }
    let top = 0, h = 0, lastOn = -1;
    addScene({
      measure() { top = pageTop(el); h = el.offsetHeight; },
      update(y, vh) {
        const p = clamp((y + vh * 0.82 - top) / (h + vh * 0.28), 0, 1);
        const on = Math.round(p * words.length);
        if (on === lastOn) return;
        words.forEach((w, i) => { const v = i < on; if (w.classList.contains('is-on') !== v) w.classList.toggle('is-on', v); });
        lastOn = on;
      },
    });
  }

  function init() {
    root.classList.add('motion');
    if (reduced) root.classList.add('reduce-motion');
    observe(document);
    document.querySelectorAll('[data-fill]').forEach(fillScene);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => measureAll());
    window.addEventListener('load', () => measureAll());
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureAll);
  }

  MDM.motion = { observe, reveal, splitWords, countUp, addScene, measure: measureAll, pageTop, clamp, reduced };
  init();
})(window.MDM);

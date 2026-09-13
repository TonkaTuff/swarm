/*! swarm 0.1.0 — living things, drawn as dots. Canvas 2D, no dependencies. MIT. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Swarm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ helpers */
  const TAU = Math.PI * 2;
  const E = (n, s) => { const t = Math.sin(n * 12.9898 + s * 78.233) * 43758.5453; return t - Math.floor(t); };
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const frac = v => v - Math.floor(v);
  const smooth = v => { v = clamp01(v); return v * v * (3 - 2 * v); };
  // 2-d value noise, smooth
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y); let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = E(xi, yi), b = E(xi + 1, yi), c = E(xi, yi + 1), d = E(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  // camera: yaw about y, pitch about x. Returns [x, y, z], z toward the viewer.
  const makeProj = (yaw, pitch) => {
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    return (x, y, z) => { const x1 = x * cy + z * sy, z1 = -x * sy + z * cy; return [x1, y * cp - z1 * sp, y * sp + z1 * cp]; };
  };
  // dot-size rule shared with ephemeris and coriolis, so the libraries match on a page
  const radiusScale = size => (size / 300) ** 0.6;
  const countScale = (size, pow, cap) => Math.min(cap, Math.max(0.25, (size / 64) ** pow));

  /* ------------------------------------------------------------------ colour */
  // Four base colours make a palette. Read off CSS custom properties (--swarm-cold … --swarm-glow) or
  // passed as opts.palette = { cold, mid, hot, glow } as [r, g, b].
  const KEYS = ['cold', 'mid', 'hot', 'glow'];
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const buildPal = q => ({ ramp: [q.cold, q.mid, q.hot], glow: q.glow });
  const ramp = (r, h) => {
    const [a, b, k] = h < 0.5 ? [r[0], r[1], h * 2] : [r[1], r[2], h * 2 - 1];
    return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
  };
  const parseCol = v => {
    v = (v || '').trim(); let m;
    if ((m = /^#([0-9a-f]{3})$/i.exec(v))) return [...m[1]].map(h => parseInt(h + h, 16));
    if ((m = /^#([0-9a-f]{6})$/i.exec(v))) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    if ((m = /^rgba?\(([^)]+)\)$/i.exec(v))) return m[1].split(/[\s,\/]+/).slice(0, 3).map(Number);
    return null;
  };
  const readPalette = (el, defaults) => {
    const cs = getComputedStyle(el), q = {}; let any = false;
    for (const k of KEYS) { const c = parseCol(cs.getPropertyValue('--swarm-' + k)); q[k] = c || defaults[k]; if (c) any = true; }
    return any ? q : null;
  };

  /* ------------------------------------------------------------------ shared painters */
  const dotPainter = (ctx, ink, dark) => (x, y, r, col, a, white) => {
    if (a < 0.02) return;
    if (a > 1) a = 1;
    if (ink) { const v = Math.round((dark ? 1 - white : white) * 255); ctx.fillStyle = `rgba(${v},${v},${v},${a.toFixed(3)})`; }
    else ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a.toFixed(3)})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  };
  // Every mode paints its soft glow only when !ink and opts.glow !== false.
  // Optional ground: a pill of sky, top colour to bottom colour. Leaves the clip set.
  function paintPill(ctx, W, size, top, bottom) {
    const half = size / 2, cx = W / 2, R = half * 0.98;
    ctx.beginPath(); ctx.roundRect(cx - W / 2 + half - R, half - R, W - 2 * (half - R), 2 * R, R); ctx.clip();
    const bg = ctx.createLinearGradient(0, 0, 0, size);
    bg.addColorStop(0, top); bg.addColorStop(1, bottom);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, size);
  }
  function paintRim(ctx, W, size) {
    const half = size / 2, cx = W / 2, R = half * 0.98;
    ctx.strokeStyle = 'rgba(150,175,220,0.18)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(cx - W / 2 + half - R + 0.5, half - R + 0.5, W - 2 * (half - R) - 1, 2 * R - 1, R - 0.5); ctx.stroke();
  }
  const DUSK = ['#2a1e3a', '#0e0a18'];

  /* ================================================================== flock */
  // A murmuration: thousands of birds moving as one shape. Every bird has a fixed place in a ball;
  // the ball wanders, its axes turn, it stretches along one and squashes along another, and density
  // waves roll through it, so the flock folds, thins and thickens the way starlings do at dusk.
  // Depth sets dot size and weight, so the near side reads as heavier. Nothing is remembered
  // between frames: it is all a function of time.
  const STARLING = { cold: [90, 100, 130], mid: [170, 180, 205], hot: [240, 244, 255], glow: [120, 130, 170] };
  function drawFlock(ctx, size, t, dark, o = {}) {
    const W = o.w ?? size, half = size / 2, cx = W / 2;
    const ink = !!o.ink, pal = buildPal(o.palette || STARLING);
    const M = radiusScale(size), lite = o.lite ? 0.5 : 1, rMin = 0.3;
    const dot = dotPainter(ctx, ink, dark);
    const N = Math.round((o.n ?? 1000) * countScale(size, 1.3, 20) * Math.sqrt(W / size) * lite * (ink ? 0.6 : 1));
    const R = size * (o.reach ?? 0.3), wave = o.wave ?? 1, T = t * (o.tempo ?? 1);
    // the flock's centre wanders; its axes turn; it stretches along one and squashes along another
    const cxf = (noise(T * 0.05, 1.7) - 0.5) * 0.5 * W, cyf = (noise(2.9, T * 0.045) - 0.5) * 0.4 * size;
    const yaw = T * 0.11 + Math.sin(T * 0.07) * 1.5, pitch = Math.sin(T * 0.09) * 0.7;
    const sx = 1.5 + 0.9 * Math.sin(T * 0.13), sy = 0.42 + 0.3 * Math.sin(T * 0.17 + 1), sz = 0.9 + 0.35 * Math.sin(T * 0.1 + 2);
    const shear = 0.35 * Math.sin(T * 0.21), proj = makeProj(yaw, pitch);

    ctx.save();
    if (o.ground) paintPill(ctx, W, size, (o.sky || DUSK)[0], (o.sky || DUSK)[1]);
    ctx.translate(cx + cxf, half + cyf);
    ctx.globalCompositeOperation = ink ? 'source-over' : 'lighter';
    if (!ink && o.glow !== false) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.6);
      g.addColorStop(0, rgba(pal.glow, 0.18)); g.addColorStop(1, rgba(pal.glow, 0));
      ctx.fillStyle = g; ctx.fillRect(-W, -size, 2 * W, 2 * size);
    }
    for (let i = 0; i < N; i++) {
      // a fixed place in a ball, denser toward the middle
      const a = E(i, 1.1) * TAU, b = Math.acos(E(i, 2.2) * 2 - 1), r = 0.15 + 0.85 * E(i, 3.3) ** 0.45;   // a hollow-ish shell, not a lump
      let x = r * Math.sin(b) * Math.cos(a) * sx, y = r * Math.cos(b) * sy, z = r * Math.sin(b) * Math.sin(a) * sz;
      // density waves rolling through the flock, a shear that folds it, and each bird's own jitter
      const w1 = Math.sin(x * 2.5 + y * 2 + T * 1.6) * 0.22 * wave, w2 = Math.sin(y * 3 - z * 2.5 - T * 1.3 + 1) * 0.18 * wave;
      x += w1 + shear * y; y += w2 + 0.25 * Math.sin(x * 1.5 + T * 0.5) * wave; z += w1 * 0.5;
      x += (noise(i * 0.13, T * 0.9) - 0.5) * 0.06; y += (noise(i * 0.17 + 5, T * 0.9) - 0.5) * 0.06;
      const [px, py, pz] = proj(x, y, z);
      const depth = clamp01(0.5 + 0.5 * pz), heat = 0.3 + 0.6 * depth;
      const patch = 0.45 + 0.55 * noise(x * 2.2 + T * 0.3, y * 2.2 - T * 0.2);   // thick here, thin there
      dot(px * R, -py * R, Math.max(rMin, (0.35 + 0.55 * depth) * M), ink ? null : ramp(pal.ramp, heat), (0.3 + 0.5 * depth) * patch, ink ? 0.05 + 0.3 * (1 - depth) : 0);
    }
    ctx.restore();
    if (o.ground) paintRim(ctx, W, size);
  }

  /* ================================================================== registry + driver */
  const MODES = {
    flock: { draw: drawFlock, defaults: STARLING, state: 'wheeling' }
  };
  const STATE_TO_MODE = Object.fromEntries(Object.entries(MODES).map(([m, v]) => [v.state, m]));

  // Named things: a mode plus the options and palette that make it that particular one.
  // <canvas class=swarm data-swarm-body=starlings>. Data attributes still override the body's options.
  const P = (cold, mid, hot, glow) => ({ cold, mid, hot, glow });
  const BODIES = {
    // murmurations
    'starlings': { mode: 'flock' },
    'rome':      { mode: 'flock', opts: { n: 2600, reach: 0.34, wave: 1.1, sky: ['#3a2440', '#140c1c'] } },
    'gretna':    { mode: 'flock', opts: { wave: 1.5, tempo: 1.15, sky: ['#26203a', '#0c0a16'] } },
    'brighton':  { mode: 'flock', opts: { reach: 0.26, tempo: 1.25, sky: ['#2a3050', '#0c1020'] }, palette: P([100, 110, 140], [190, 200, 220], [250, 250, 255], [140, 160, 210]) }
  };
  // named things by family, in display order
  const GROUPS = {
    'Murmurations': ['starlings', 'rome', 'gretna', 'brighton']
  };

  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isDark = () => {
    const st = document.documentElement.getAttribute('data-theme');
    if (st === 'dark') return true;
    if (st === 'light') return false;
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const FLAGS = new Set(['swarmBody', 'swarmMode', 'swarmState', 'swarmReady', 'swarmInk', 'swarmLite', 'swarmGround', 'swarmGlow']);

  // Markup contract: <canvas class=swarm width=200 height=200 data-swarm-body=starlings> (or data-swarm-mode=flock).
  // Height is the preset; width lets wide things stretch. Flags: data-swarm-ink, -lite, -ground (=1), -glow (=0).
  // Any other data-swarm-<knob> reaches the mode as opts.knob, numbers parsed. Colours via --swarm-* custom properties.
  function mount(canvas) {
    if (canvas.dataset.swarmReady === '1') return;
    canvas.dataset.swarmReady = '1';
    const body = BODIES[canvas.dataset.swarmBody] || null;
    const modeName = canvas.dataset.swarmMode || (body && body.mode) || STATE_TO_MODE[canvas.dataset.swarmState] || 'flock';
    const mode = MODES[modeName] || MODES.flock;
    const defaults = (body && body.palette) || mode.defaults;
    const w = parseInt(canvas.getAttribute('width') || '', 10) || 64;
    const size = parseInt(canvas.getAttribute('height') || '', 10) || w;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(size * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = size + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ds = canvas.dataset, own = {};
    for (const k in ds) {
      if (!k.startsWith('swarm') || FLAGS.has(k) || ds[k] === '') continue;
      own[k[5].toLowerCase() + k.slice(6)] = isNaN(ds[k]) ? ds[k] : Number(ds[k]);
    }
    const opts = { ...(body ? body.opts : null), ...own, w, ink: ds.swarmInk === '1', lite: ds.swarmLite === '1', ground: ds.swarmGround === '1', glow: ds.swarmGlow !== '0' };
    const paint = t => {
      opts.palette = readPalette(canvas, defaults) || (body && body.palette) || null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, size);
      mode.draw(ctx, size, t, isDark(), opts);
    };
    if (reduced()) {   // one still frame, repainted on theme change
      paint(0.6);
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => paint(0.6));
      new MutationObserver(() => paint(0.6)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return;
    }
    let raf = 0, running = false, visible = true;
    const tick = () => { paint(performance.now() / 1000); if (running) raf = requestAnimationFrame(tick); };
    const start = () => { if (!running) { running = true; raf = requestAnimationFrame(tick); } };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    paint(0);
    if (typeof IntersectionObserver !== 'undefined') {   // no rAF for canvases scrolled off or on hidden tabs
      new IntersectionObserver(([e]) => {
        visible = e.isIntersecting;
        (visible && document.visibilityState !== 'hidden') ? start() : stop();
      }).observe(canvas);
    } else start();
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? stop() : visible && start()));
  }
  const register = root => (root || document).querySelectorAll('canvas.swarm').forEach(mount);

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => register());
    else register();
  }

  return {
    version: '0.1.0',
    register, mount, MODES, STATE_TO_MODE, BODIES, GROUPS,
    draw: (mode, ctx, size, t, dark, opts) => MODES[mode].draw(ctx, size, t, dark, opts),
    // draw a named thing: Swarm.body('starlings', ctx, 64, t, dark, { lite: true })
    body: (name, ctx, size, t, dark, opts) => {
      const b = BODIES[name]; if (!b) throw new Error('swarm: unknown body ' + name);
      return MODES[b.mode].draw(ctx, size, t, dark, { ...b.opts, palette: b.palette || null, ...opts });
    },
    palette: { keys: KEYS, build: buildPal, read: readPalette, parse: parseCol, ramp },
    _: { E, noise, makeProj, paintPill, paintRim, dotPainter }
  };
});

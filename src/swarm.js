/*! swarm 0.2.0 — living things, drawn as dots. Canvas 2D, no dependencies. MIT. */
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

  /* ================================================================== school */
  // A bait ball: fish packed into a spinning sphere, each keeping its place in the shell, the whole
  // ball turning about a tilted axis and breathing. Now and then a predator passes through and the
  // fish flash outward from it, then close the hole behind it. All a function of time.
  const SARDINE = { cold: [40, 60, 95], mid: [150, 175, 205], hot: [235, 242, 250], glow: [50, 90, 140] };
  const SEA = ['#0b2a42', '#03101d'];
  function drawSchool(ctx, size, t, dark, o = {}) {
    const W = o.w ?? size, half = size / 2, cx = W / 2;
    const ink = !!o.ink, pal = buildPal(o.palette || SARDINE);
    const M = radiusScale(size), lite = o.lite ? 0.5 : 1, rMin = 0.3;
    const dot = dotPainter(ctx, ink, dark);
    const N = Math.round((o.n ?? 1400) * countScale(size, 1.3, 20) * lite * (ink ? 0.6 : 1));
    const R = size * (o.reach ?? 0.3), T = t * (o.tempo ?? 1), spin = o.spin ?? 0.5, passes = o.passes ?? 1;
    const cxf = (noise(T * 0.04, 3.1) - 0.5) * 0.3 * W, cyf = (noise(4.2, T * 0.05) - 0.5) * 0.25 * size;
    const proj = makeProj(T * spin, 0.5 + 0.3 * Math.sin(T * 0.13));
    const sx = 1 + 0.15 * Math.sin(T * 0.4), sy = 1 - 0.12 * Math.sin(T * 0.4 + 1);
    // the predator: a point that sweeps through now and then
    const pp = frac(T * 0.09), pass = pp < 0.35 * passes ? pp / (0.35 * passes) : -1;
    const px = (pass * 2 - 1) * 1.6, py = 0.4 * Math.sin(T * 0.09 * TAU);
    ctx.save();
    if (o.ground) paintPill(ctx, W, size, (o.sky || SEA)[0], (o.sky || SEA)[1]);
    ctx.translate(cx + cxf, half + cyf);
    ctx.globalCompositeOperation = ink ? 'source-over' : 'lighter';
    if (!ink && o.glow !== false) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.5);
      g.addColorStop(0, rgba(pal.glow, 0.2)); g.addColorStop(1, rgba(pal.glow, 0));
      ctx.fillStyle = g; ctx.fillRect(-W, -size, 2 * W, 2 * size);
    }
    for (let i = 0; i < N; i++) {
      const a = E(i, 1.1) * TAU, b = Math.acos(E(i, 2.2) * 2 - 1), r = 0.35 + 0.65 * E(i, 3.3) ** 0.5;   // a thick shell
      let x = r * Math.sin(b) * Math.cos(a) * sx, y = r * Math.cos(b) * sy, z = r * Math.sin(b) * Math.sin(a);
      // each fish jinks a little; the whole shell ripples
      x += (noise(i * 0.11, T * 1.4) - 0.5) * 0.08; y += (noise(i * 0.13 + 7, T * 1.4) - 0.5) * 0.08 + 0.05 * Math.sin(x * 4 + T * 2);
      let [qx, qy, qz] = proj(x, y, z);
      if (pass >= 0) {   // flash expansion away from the predator
        const dx = qx - px, dy = qy - py, d = Math.hypot(dx, dy), push = Math.max(0, 1 - d / 0.7) * 0.45 * Math.sin(pass * Math.PI);
        if (d > 1e-4) { qx += dx / d * push; qy += dy / d * push; }
      }
      const depth = clamp01(0.5 + 0.5 * qz), flash = 0.5 + 0.5 * Math.sin(T * 6 + i * 0.7 + qx * 3) ** 6;   // silver flanks catching the light
      dot(qx * R, -qy * R, Math.max(rMin, (0.4 + 0.6 * depth) * M), ink ? null : ramp(pal.ramp, 0.25 + 0.5 * depth + 0.25 * flash), (0.3 + 0.5 * depth) * (0.7 + 0.3 * flash), ink ? 0.05 + 0.3 * (1 - depth) : 0);
    }
    ctx.restore();
    if (o.ground) paintRim(ctx, W, size);
  }

  /* ================================================================== fireflies */
  // Fireflies over a dark meadow: each drifts on its own noisy path and blinks on its own clock,
  // or, for the synchronous kinds, on a shared one with a wave passing through. Blue ghosts glow
  // steadily instead of blinking, and stay low.
  const FIREFLY = { cold: [30, 50, 25], mid: [170, 225, 60], hot: [240, 255, 190], glow: [110, 190, 60] };
  const MEADOW = ['#0a140a', '#030603'];
  function drawFireflies(ctx, size, t, dark, o = {}) {
    const W = o.w ?? size, half = size / 2, cx = W / 2;
    const ink = !!o.ink, pal = buildPal(o.palette || FIREFLY);
    const M = radiusScale(size), lite = o.lite ? 0.5 : 1, rMin = 0.3;
    const dot = dotPainter(ctx, ink, dark);
    const N = Math.round((o.n ?? 80) * countScale(size, 1.2, 20) * Math.sqrt(W / size) * lite);
    const T = t * (o.tempo ?? 1), sync = o.sync ?? 0, ghost = o.form === 'ghost', period = o.period ?? 2.2, duty = o.duty ?? 0.3;
    ctx.save();
    if (o.ground) paintPill(ctx, W, size, (o.sky || MEADOW)[0], (o.sky || MEADOW)[1]);
    ctx.translate(cx, half);
    ctx.globalCompositeOperation = ink ? 'source-over' : 'lighter';
    for (let i = 0; i < N; i++) {
      // a slow wander, low over the grass
      const x = (noise(i * 0.31, T * 0.07 + i) - 0.5) * W * 1.1, y = (noise(i * 0.37 + 9, T * 0.06) - 0.5) * size * 0.8 + size * 0.1 + (ghost ? size * 0.2 : 0);
      let lit;
      if (ghost) lit = 0.6 + 0.4 * noise(T * 0.5, i * 0.2);
      else {
        const ph = sync ? frac(T / period + (x / W + 0.5) * 1.1 * sync + E(i, 4.4) * 0.04) : frac(T / (period * (0.85 + 0.3 * E(i, 5.5))) + E(i, 4.4));   // a wave crossing the field, or every clock its own
        lit = ph < duty ? Math.sin(ph / duty * Math.PI) ** 0.7 : 0;
      }
      if (lit < 0.03) { dot(x, y, Math.max(rMin, M * 0.45), ink ? null : pal.ramp[0], 0.25, ink ? 0.7 : 0); continue; }   // dark between blinks, just a speck
      const col = ink ? null : ramp(pal.ramp, 0.5 + 0.5 * lit);
      if (!ink && o.glow !== false) dot(x, y, M * (2.4 + 2.4 * lit), pal.glow, 0.28 * lit, 0);
      dot(x, y, Math.max(rMin, M * (0.7 + 0.6 * lit)), col, 0.45 + 0.55 * lit, ink ? 0.05 : 0);
    }
    ctx.restore();
    if (o.ground) paintRim(ctx, W, size);
  }

  /* ================================================================== bees */
  // Bees: a hanging swarm is a dense cluster with a cloud of flyers looping round it; a hive
  // entrance is traffic in and out along a few lanes. Every bee flies a hashed loop, fast and jittery.
  const BEE = { cold: [90, 60, 20], mid: [225, 175, 45], hot: [255, 235, 140], glow: [200, 150, 40] };
  const ORCHARD = ['#1a1e12', '#070805'];
  function drawBees(ctx, size, t, dark, o = {}) {
    const W = o.w ?? size, half = size / 2, cx = W / 2;
    const ink = !!o.ink, pal = buildPal(o.palette || BEE), hive = o.form === 'hive';
    const M = radiusScale(size), lite = o.lite ? 0.5 : 1, rMin = 0.3;
    const dot = dotPainter(ctx, ink, dark);
    const N = Math.round((o.n ?? 500) * countScale(size, 1.3, 20) * lite * (ink ? 0.6 : 1));
    const T = t * (o.tempo ?? 1), R = size * (o.reach ?? 0.2), jit = size * 0.012;
    ctx.save();
    if (o.ground) paintPill(ctx, W, size, (o.sky || ORCHARD)[0], (o.sky || ORCHARD)[1]);
    ctx.translate(cx, half);
    ctx.globalCompositeOperation = ink ? 'source-over' : 'lighter';
    if (!ink && o.glow !== false && !hive) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.8);
      g.addColorStop(0, rgba(pal.glow, 0.14)); g.addColorStop(1, rgba(pal.glow, 0));
      ctx.fillStyle = g; ctx.fillRect(-W, -size, 2 * W, 2 * size);
    }
    for (let i = 0; i < N; i++) {
      let x, y, bright;
      if (!hive && E(i, 1.1) < 0.7) {   // hanging in the cluster, a teardrop under a branch, barely moving
        const a = E(i, 2.2) * TAU, r = Math.sqrt(E(i, 3.3)), d = E(i, 4.4) * 2 - 1;
        x = Math.cos(a) * r * R * 0.8 + (noise(i * 0.2, T * 3) - 0.5) * jit;
        y = -R * 0.3 + (d + 1) * R * 0.75 * (1 - r * r * 0.5) + (noise(i * 0.2 + 5, T * 3) - 0.5) * jit;
        bright = 0.35 + 0.25 * E(i, 5.5);
      } else if (hive) {   // a lane in or out of the entrance at the bottom middle
        const out = E(i, 6.6) < 0.5, lane = (E(i, 7.7) - 0.5) * 1.2, sp = 0.35 + 0.25 * E(i, 8.8), q = frac(T * sp + E(i, 9.9)), qq = out ? q : 1 - q;
        x = lane * W * 0.45 * qq + (noise(i * 0.17, T * 2.5) - 0.5) * size * 0.05 * qq;
        y = size * 0.42 - qq * size * (0.6 + 0.3 * E(i, 1.3)) + (noise(i * 0.19 + 3, T * 2.5) - 0.5) * size * 0.05 * qq;
        bright = 0.5 + 0.4 * (1 - qq);
      } else {   // looping round the cluster, fast
        const a0 = E(i, 2.4) * TAU, ra = R * (1.1 + 0.9 * E(i, 3.5)), rb = ra * (0.4 + 0.6 * E(i, 4.6)), w = (1.5 + 2 * E(i, 5.7)) * (E(i, 6.8) < 0.5 ? 1 : -1), tilt = E(i, 7.9) * Math.PI;
        const th = w * T + a0, ex = Math.cos(th) * ra, ey = Math.sin(th) * rb;
        x = ex * Math.cos(tilt) - ey * Math.sin(tilt) + (noise(i * 0.23, T * 4) - 0.5) * jit * 3;
        y = ex * Math.sin(tilt) + ey * Math.cos(tilt) + R * 0.3 + (noise(i * 0.23 + 8, T * 4) - 0.5) * jit * 3;
        bright = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(th));
      }
      dot(x, y, Math.max(rMin, M * (0.55 + 0.35 * bright)), ink ? null : ramp(pal.ramp, 0.3 + 0.6 * bright), 0.35 + 0.6 * bright, ink ? 0.1 + 0.4 * (1 - bright) : 0);
    }
    ctx.restore();
    if (o.ground) paintRim(ctx, W, size);
  }

  /* ================================================================== registry + driver */
  const MODES = {
    flock: { draw: drawFlock, defaults: STARLING, state: 'wheeling' },
    school: { draw: drawSchool, defaults: SARDINE, state: 'schooling' },
    fireflies: { draw: drawFireflies, defaults: FIREFLY, state: 'blinking' },
    bees: { draw: drawBees, defaults: BEE, state: 'buzzing' }
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
    'brighton':  { mode: 'flock', opts: { reach: 0.26, tempo: 1.25, sky: ['#2a3050', '#0c1020'] }, palette: P([100, 110, 140], [190, 200, 220], [250, 250, 255], [140, 160, 210]) },
    // bait balls
    'bait-ball':   { mode: 'school' },
    'sardine-run': { mode: 'school', opts: { n: 2200, reach: 0.34, passes: 2, tempo: 1.2 } },
    'anchovies':   { mode: 'school', opts: { n: 1600, reach: 0.24, tempo: 1.4, spin: 0.8 }, palette: P([30, 70, 110], [130, 180, 220], [225, 245, 255], [40, 110, 170]) },
    // fireflies
    'fireflies':   { mode: 'fireflies' },
    'synchronous': { mode: 'fireflies', opts: { sync: 1, period: 3, duty: 0.25, n: 110 } },
    'blue-ghosts': { mode: 'fireflies', opts: { form: 'ghost', n: 40 }, palette: P([30, 50, 60], [120, 200, 190], [200, 240, 230], [90, 170, 160]) },
    // bees
    'bee-swarm':   { mode: 'bees' },
    'hive':        { mode: 'bees', opts: { form: 'hive', n: 400 } },
    'hornets':     { mode: 'bees', opts: { n: 140, reach: 0.26, tempo: 1.5 }, palette: P([60, 40, 15], [200, 120, 30], [240, 200, 90], [160, 100, 30]) }
  };
  // named things by family, in display order
  const GROUPS = {
    'Murmurations': ['starlings', 'rome', 'gretna', 'brighton'],
    'Bait balls': ['bait-ball', 'sardine-run', 'anchovies'],
    'Fireflies': ['fireflies', 'synchronous', 'blue-ghosts'],
    'Bees': ['bee-swarm', 'hive', 'hornets']
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
    version: '0.2.0',
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

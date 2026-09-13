/*! swarm 0.3.0 — living things, drawn as dots. Canvas 2D, no dependencies. MIT. */
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

  /* ================================================================== jellies */
  // A bloom of jellyfish drifting up through dark water: each bell pulses on its own clock,
  // squeezing narrow and rounding out, tentacles trailing and swaying below. Farther ones are
  // smaller and dimmer. All of it a function of time.
  const JELLY = { cold: [40, 30, 90], mid: [150, 110, 220], hot: [240, 225, 255], glow: [120, 90, 200] };
  const DEEP = ['#0a1430', '#03060f'];
  function drawJellies(ctx, size, t, dark, o = {}) {
    const W = o.w ?? size, half = size / 2, cx = W / 2;
    const ink = !!o.ink, pal = buildPal(o.palette || JELLY);
    const M = radiusScale(size), lite = o.lite ? 0.5 : 1, rMin = 0.3;
    const dot = dotPainter(ctx, ink, dark);
    const T = t * (o.tempo ?? 1), count = o.count ?? 9, det = countScale(size, 0.9, 6) * lite;
    ctx.save();
    if (o.ground) paintPill(ctx, W, size, (o.sky || DEEP)[0], (o.sky || DEEP)[1]);
    ctx.translate(cx, 0);
    ctx.globalCompositeOperation = ink ? 'source-over' : 'lighter';
    for (let j = 0; j < count; j++) {
      const depth = 0.45 + 0.55 * E(j, 1.1), sp = 0.7 + 0.6 * E(j, 2.2);   // near ones big and bright
      const y = size * (1.25 - frac(T * 0.025 * sp + E(j, 3.3)) * 1.5), x = (E(j, 4.4) - 0.5) * W * 0.9 + (noise(j * 0.7, T * 0.08) - 0.5) * size * 0.2;
      const ph = frac(T * 0.45 * sp + E(j, 5.5)), pulse = Math.sin(ph * Math.PI) ** 2;   // one squeeze per beat
      const r = size * (0.045 + 0.06 * E(j, 6.6)) * depth, rw = r * (1.05 - 0.3 * pulse), rh = r * (0.55 + 0.35 * pulse);
      const col = h => ink ? null : ramp(pal.ramp, h);
      if (!ink && o.glow !== false) { const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.8); g.addColorStop(0, rgba(pal.glow, 0.25 * depth)); g.addColorStop(1, rgba(pal.glow, 0)); ctx.fillStyle = g; ctx.fillRect(-W, -size, 2 * W, 3 * size); }
      // the bell: a dome of dots, denser at the rim
      const NB = Math.round(60 * det * depth);
      for (let i = 0; i < NB; i++) {
        const a = Math.PI + E(i, 7.7 + j) * Math.PI, rr = 0.6 + 0.4 * E(i, 8.8 + j) ** 0.4;
        dot(x + Math.cos(a) * rw * rr, y + Math.sin(a) * rh * rr, Math.max(rMin, M * 0.7 * depth), col(0.5 + 0.4 * rr), (0.3 + 0.5 * rr) * depth, ink ? 0.4 - 0.3 * rr : 0);
      }
      // the tentacles: wavy lines of dots hanging below, drawn up a little on the squeeze
      const NT = 7, len = r * (3.2 - 0.8 * pulse), NL = Math.round(14 * det);
      for (let k = 0; k < NT; k++) {
        const x0 = x + ((k + 0.5) / NT - 0.5) * rw * 1.6;
        for (let i = 1; i <= NL; i++) {
          const q = i / NL, sway = Math.sin(q * 4 - T * 1.5 * sp + k) * r * 0.25 * q + (noise(k * 0.9 + j, T * 0.3 + q) - 0.5) * r * 0.5 * q;
          dot(x0 + sway, y + rh * 0.3 + q * len, Math.max(rMin, M * (0.55 - 0.2 * q) * depth), col(0.35 + 0.3 * (1 - q)), (0.5 - 0.35 * q) * depth, ink ? 0.5 : 0);
        }
      }
    }
    ctx.restore();
    if (o.ground) paintRim(ctx, W, size);
  }

  /* ================================================================== bay */
  // A bioluminescent bay at night: the water is full of plankton that light up when something moves
  // through them. A paddle wanders across on a noisy path, and everything it stirred in the last few
  // seconds glows and fades behind it; little waves flash along the shore.
  const BIOLUM = { cold: [5, 30, 50], mid: [40, 180, 200], hot: [180, 255, 250], glow: [30, 160, 190] };
  const BAY = ['#04101c', '#02060c'];
  function drawBay(ctx, size, t, dark, o = {}) {
    const W = o.w ?? size, half = size / 2, cx = W / 2;
    const ink = !!o.ink, pal = buildPal(o.palette || BIOLUM);
    const M = radiusScale(size), lite = o.lite ? 0.5 : 1, rMin = 0.3;
    const dot = dotPainter(ctx, ink, dark);
    const T = t * (o.tempo ?? 1), N = Math.round((o.n ?? 900) * countScale(size, 1.3, 20) * Math.sqrt(W / size) * lite * (ink ? 0.6 : 1));
    const bright = o.bright ?? 1, K = 16, wake = size * 0.07;
    const at = tt => [(noise(tt * 0.06, 3.7) - 0.5) * W * 0.95, half + (noise(8.1, tt * 0.05) - 0.5) * size * 0.7];   // where the paddle is
    const past = []; for (let k = 0; k < K; k++) past.push(at(T - k * 0.18));
    ctx.save();
    if (o.ground) paintPill(ctx, W, size, (o.sky || BAY)[0], (o.sky || BAY)[1]);
    ctx.translate(cx, 0);
    ctx.globalCompositeOperation = ink ? 'source-over' : 'lighter';
    for (let i = 0; i < N; i++) {
      const x = (E(i, 1.1) - 0.5) * W, y = half + (E(i, 2.2) - 0.5) * size * 0.9;
      let lit = 0;
      for (let k = 0; k < K; k++) { const dx = x - past[k][0], dy = y - past[k][1], r = wake * (1 + k * 0.12); lit = Math.max(lit, Math.exp(-(dx * dx + dy * dy) / (r * r)) * (1 - k / K)); }
      lit = Math.min(1, lit * 1.4 * bright + 0.25 * bright * smooth((Math.sin(y / size * 26 - T * 2.2 + noise(x / size * 2, T * 0.3) * 3) - 0.9) / 0.1) * smooth((y - half) / (size * 0.35)));   // waves flashing near the shore
      if (lit < 0.03) { dot(x, y, Math.max(rMin, M * 0.4), ink ? null : pal.ramp[0], 0.08 + 0.05 * E(i, 3.3), ink ? 0.8 : 0); continue; }
      dot(x, y, Math.max(rMin, M * (0.45 + 0.9 * lit)), ink ? null : ramp(pal.ramp, 0.35 + 0.65 * lit), 0.15 + 0.85 * lit, ink ? 0.6 - 0.55 * lit : 0);
    }
    if (!ink && o.glow !== false) { const [px, py] = past[0], g = ctx.createRadialGradient(px, py, 0, px, py, wake * 3); g.addColorStop(0, rgba(pal.glow, 0.3 * bright)); g.addColorStop(1, rgba(pal.glow, 0)); ctx.fillStyle = g; ctx.fillRect(-W, -size, 2 * W, 3 * size); }
    ctx.restore();
    if (o.ground) paintRim(ctx, W, size);
  }

  /* ================================================================== ants */
  // An ant trail: a wavy line between the nest and the food, ants as two dots each, head and body,
  // going both ways with a wobble; the ends are crowded. Leafcutters carry a bright leaf. Army ants
  // march in a wide column.
  const ANT = { cold: [50, 30, 15], mid: [140, 80, 30], hot: [230, 190, 120], glow: [120, 80, 30] };
  const SOIL = ['#1a1610', '#070503'];
  function drawAnts(ctx, size, t, dark, o = {}) {
    const W = o.w ?? size, half = size / 2, cx = W / 2;
    const ink = !!o.ink, pal = buildPal(o.palette || ANT);
    const M = radiusScale(size), lite = o.lite ? 0.5 : 1, rMin = 0.3;
    const dot = dotPainter(ctx, ink, dark);
    const T = t * (o.tempo ?? 1), N = Math.round((o.n ?? 90) * countScale(size, 1.2, 16) * Math.sqrt(W / size) * lite);
    const width = size * (o.width ?? 0.02), leaf = !!o.leaf, speed = o.speed ?? 0.07;
    const path = u => [-W * 0.42 + u * W * 0.84, half + size * 0.06 * Math.sin(u * 7 + 1) + size * 0.1 * (noise(u * 2.5, 2.3) - 0.5)];
    const col = h => ink ? null : ramp(pal.ramp, h);
    ctx.save();
    if (o.ground) paintPill(ctx, W, size, (o.sky || SOIL)[0], (o.sky || SOIL)[1]);
    ctx.translate(cx, 0);
    ctx.globalCompositeOperation = ink ? 'source-over' : 'lighter';
    // the nest mound and the food
    const [nx, ny] = path(0), [fx, fy] = path(1);
    for (let i = 0; i < Math.round(40 * countScale(size, 1, 8)); i++) { const a = E(i, 1.1) * TAU, r = Math.sqrt(E(i, 2.2)) * size * 0.07; dot(nx + Math.cos(a) * r, ny + size * 0.02 + Math.sin(a) * r * 0.5, Math.max(rMin, M * 0.6), col(0.25), 0.35, ink ? 0.7 : 0); }
    for (let i = 0; i < Math.round(12 * countScale(size, 1, 8)); i++) { const a = E(i, 3.3) * TAU, r = Math.sqrt(E(i, 4.4)) * size * 0.03; dot(fx + Math.cos(a) * r, fy + Math.sin(a) * r * 0.6, Math.max(rMin, M * 0.7), col(leaf ? 0.9 : 0.8), 0.6, ink ? 0.2 : 0); }
    if (!ink && o.glow !== false) { const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, size * 0.12); g.addColorStop(0, rgba(pal.glow, 0.2)); g.addColorStop(1, rgba(pal.glow, 0)); ctx.fillStyle = g; ctx.fillRect(-W, -size, 2 * W, 3 * size); }
    // the ants
    for (let i = 0; i < N; i++) {
      const out = E(i, 5.5) < 0.5, sp = 0.7 + 0.6 * E(i, 6.6), raw = frac(T * speed * sp + E(i, 7.7)), u = out ? raw : 1 - raw;
      const busy = raw < 0.08 || raw > 0.92;   // milling about at the ends
      const uu = busy ? clamp01(u + (noise(i * 0.3, T * 0.8) - 0.5) * 0.06) : u;
      const [x, y] = path(uu), [x2, y2] = path(Math.min(1, uu + 0.004)), dx = x2 - x, dy = y2 - y, L = Math.hypot(dx, dy) || 1;
      const tx = dx / L * (out ? 1 : -1), ty = dy / L * (out ? 1 : -1), side = (E(i, 8.8) - 0.5) * 2 * width + (noise(i * 0.2, T * 2) - 0.5) * width * 0.8;
      const px = x - ty * side, py = y + tx * side, r = Math.max(rMin, M * 0.5 * (0.8 + 0.4 * E(i, 9.9)));
      dot(px, py, r, col(0.5), 0.85, ink ? 0.15 : 0);
      dot(px - tx * r * 2.2, py - ty * r * 2.2, r * 1.15, col(0.4), 0.85, ink ? 0.2 : 0);
      if (leaf && !out) dot(px + tx * r * 1.5, py + ty * r * 1.5 - r * 1.5, r * 1.6, ink ? null : [120, 210, 90], 0.8, ink ? 0.1 : 0);   // a leaf, carried home
    }
    ctx.restore();
    if (o.ground) paintRim(ctx, W, size);
  }

  /* ================================================================== crowd */
  // People from above. A concourse: streams crossing a hall on a few lanes, walking in twos and
  // threes. A scramble crossing: cars run on the two roads while people pile up on the corners,
  // then the lights change and everyone crosses at once, every way. A marathon: a river of runners
  // down a road, each at their own pace.
  const CROWD = { cold: [60, 55, 70], mid: [170, 165, 180], hot: [245, 240, 250], glow: [120, 120, 150] };
  const PLAZA = ['#171820', '#06070a'];
  function drawCrowd(ctx, size, t, dark, o = {}) {
    const W = o.w ?? size, half = size / 2, cx = W / 2;
    const ink = !!o.ink, pal = buildPal(o.palette || CROWD);
    const M = radiusScale(size), lite = o.lite ? 0.5 : 1, rMin = 0.3;
    const dot = dotPainter(ctx, ink, dark);
    const T = t * (o.tempo ?? 1), form = o.form || 'concourse';
    const N = Math.round((o.n ?? 160) * countScale(size, 1.2, 16) * Math.sqrt(W / size) * lite), col = h => ink ? null : ramp(pal.ramp, h);
    const person = (x, y, i, a) => dot(x, y, Math.max(rMin, M * (0.6 + 0.25 * E(i, 0.7))), col(0.45 + 0.4 * E(i, 0.9)), a, ink ? 0.1 + 0.3 * E(i, 0.9) : 0);
    ctx.save();
    if (o.ground) paintPill(ctx, W, size, (o.sky || PLAZA)[0], (o.sky || PLAZA)[1]);
    ctx.translate(cx, half);
    ctx.globalCompositeOperation = ink ? 'source-over' : 'lighter';
    if (!ink && o.glow !== false) { const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(W, size) * 0.5); g.addColorStop(0, rgba(pal.glow, 0.1)); g.addColorStop(1, rgba(pal.glow, 0)); ctx.fillStyle = g; ctx.fillRect(-W, -size, 2 * W, 2 * size); }
    if (form === 'scramble') {
      const P = o.period ?? 14, p = frac(T / P), walk = smooth((p - 0.5) / 0.08) * (1 - smooth((p - 0.96) / 0.04)), road = size * 0.16;
      // the roads, as faint kerb lines
      for (const s of [-1, 1]) { for (let j = 0; j < 40; j++) { const q = j / 40 - 0.5; dot(q * W * 1.1, s * road, Math.max(rMin, M * 0.35), col(0.3), 0.3, ink ? 0.7 : 0); dot(s * road, q * size * 1.1, Math.max(rMin, M * 0.35), col(0.3), 0.3, ink ? 0.7 : 0); } }
      // cars: run while people wait, stop at the lines while they cross
      const go = 1 - walk, NC = Math.round(N * 0.12), carT = Math.floor(T / P) * P * 0.5 + Math.min(frac(T / P), 0.5) * P;   // cars only move while people wait
      for (let i = 0; i < NC; i++) {
        const horiz = E(i, 1.1) < 0.5, dir = E(i, 2.2) < 0.5 ? -1 : 1, sp = 0.05 + 0.04 * E(i, 3.3);
        let along = (frac(carT * sp + E(i, 4.4)) * 2.4 - 1.2) * size * dir;
        if (go < 1 && Math.abs(along) < road * 1.25) along = -dir * road * 1.25;   // held at the line
        const across = dir * road * 0.5, x = horiz ? along : across, y = horiz ? across : along;
        dot(x, y, Math.max(rMin, M * 1.5), col(0.85), 0.85, ink ? 0.05 : 0);
      }
      // people: a corner to wait at and a corner to head for
      for (let i = 0; i < N; i++) {
        const c0 = Math.floor(E(i, 5.5) * 4), c1 = (c0 + 1 + Math.floor(E(i, 6.6) * 3)) % 4, sp = 0.8 + 0.5 * E(i, 7.7);
        const corner = c => [((c & 1) ? 1 : -1) * (road + size * 0.08 + E(i, 8.8) * size * 0.12), ((c & 2) ? 1 : -1) * (road + size * 0.08 + E(i, 9.9) * size * 0.12)];
        const [ax, ay] = corner(c0), [bx, by] = corner(c1), q = clamp01(walk * sp * 1.15), jig = (noise(i * 0.4, T * 3) - 0.5) * size * 0.012;
        person(ax + (bx - ax) * q + jig, ay + (by - ay) * q + jig, i, 0.85);
      }
    } else if (form === 'marathon') {
      const lanes = 7;
      for (let i = 0; i < N * 1.5; i++) {
        const pace = 0.05 + 0.05 * E(i, 1.1), u = frac(T * pace + E(i, 2.2)), lane = (E(i, 3.3) - 0.5) * lanes, bob = Math.sin(T * 6 + i) * size * 0.003;
        person(-W * 0.55 + u * W * 1.1 + (noise(i * 0.2, T * 0.5) - 0.5) * size * 0.02, lane * size * 0.06 + bob, i, 0.8);
      }
    } else {
      const lanes = o.lanes ?? 5;
      for (let i = 0; i < N; i++) {
        const k = Math.floor(E(i, 1.1) * lanes), ax = (E(k, 2.2) - 0.5) * W * 1.05, ay = (E(k, 3.3) < 0.5 ? -1 : 1) * size * 0.52, bx = (E(k, 4.4) - 0.5) * W * 1.05, by = -ay;
        const back = E(i, 5.5) < 0.5, sp = 0.05 + 0.04 * E(i, 6.6), raw = frac(T * sp + E(i, 7.7)), u = back ? 1 - raw : raw;
        const side = (E(i, 8.8) - 0.5) * size * 0.14 + (E(i, 9.1) < 0.4 ? 0 : (noise(i * 0.3, T * 0.4) - 0.5) * size * 0.05);   // some walk together
        const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
        person(ax + dx * u - dy / L * side, ay + dy * u + dx / L * side, i, 0.8);
      }
    }
    ctx.restore();
    if (o.ground) paintRim(ctx, W, size);
  }

  /* ================================================================== registry + driver */
  const MODES = {
    flock: { draw: drawFlock, defaults: STARLING, state: 'wheeling' },
    school: { draw: drawSchool, defaults: SARDINE, state: 'schooling' },
    fireflies: { draw: drawFireflies, defaults: FIREFLY, state: 'blinking' },
    bees: { draw: drawBees, defaults: BEE, state: 'buzzing' },
    jellies: { draw: drawJellies, defaults: JELLY, state: 'pulsing' },
    bay: { draw: drawBay, defaults: BIOLUM, state: 'glowing' },
    ants: { draw: drawAnts, defaults: ANT, state: 'marching' },
    crowd: { draw: drawCrowd, defaults: CROWD, state: 'milling' }
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
    'hornets':     { mode: 'bees', opts: { n: 140, reach: 0.26, tempo: 1.5 }, palette: P([60, 40, 15], [200, 120, 30], [240, 200, 90], [160, 100, 30]) },
    // jellyfish
    'jellyfish-bloom': { mode: 'jellies' },
    'moon-jellies':    { mode: 'jellies', opts: { count: 14 }, palette: P([50, 60, 100], [170, 190, 230], [245, 248, 255], [140, 170, 220]) },
    // bioluminescence
    'bioluminescent-bay': { mode: 'bay' },
    'mosquito-bay':       { mode: 'bay', opts: { n: 1300, bright: 1.3 } },
    // ants
    'ant-trail':   { mode: 'ants' },
    'leafcutters': { mode: 'ants', opts: { leaf: 1, n: 70, speed: 0.05 } },
    'army-ants':   { mode: 'ants', opts: { n: 260, width: 0.05, speed: 0.1 }, palette: P([40, 25, 15], [110, 60, 30], [200, 150, 90], [100, 60, 30]) },
    // crowds
    'concourse': { mode: 'crowd' },
    'shibuya':   { mode: 'crowd', opts: { form: 'scramble', n: 220 } },
    'marathon':  { mode: 'crowd', opts: { form: 'marathon' }, palette: P([70, 50, 60], [220, 120, 110], [255, 235, 230], [200, 100, 100]) }
  };
  // named things by family, in display order
  const GROUPS = {
    'Murmurations': ['starlings', 'rome', 'gretna', 'brighton'],
    'Bait balls': ['bait-ball', 'sardine-run', 'anchovies'],
    'Fireflies': ['fireflies', 'synchronous', 'blue-ghosts'],
    'Bees': ['bee-swarm', 'hive', 'hornets'],
    'Jellyfish': ['jellyfish-bloom', 'moon-jellies'],
    'Bioluminescence': ['bioluminescent-bay', 'mosquito-bay'],
    'Ants': ['ant-trail', 'leafcutters', 'army-ants'],
    'Crowds': ['concourse', 'shibuya', 'marathon']
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
    version: '0.3.0',
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

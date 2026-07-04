/* ============================================================
   art.js — shared "Evolve a Picture" core (main thread AND worker).
   A genome is a stack of semi-transparent shapes; each shape is either
   a polygon (pts[]) or an ellipse (cx,cy,rx,ry,rot). We render it,
   compare pixels to a target (perceptually luma-weighted), and run a
   (1+1) evolution strategy: mutate a copy of the best, keep it ONLY if
   it matches better. Best error is monotonically non-increasing, so
   Match% never goes down within a run.

   Exposes (window / worker self / globalThis):
     Art = { ArtEvolver, mutate, randomShape, renderGenome, pickWeightedIndex }
   ============================================================ */
(function () {
  'use strict';

  // ---- perception + tuning constants ----
  const LUMA_R = 0.2126, LUMA_G = 0.7152, LUMA_B = 0.0722; // Rec.709
  const GRID = 32;          // error-map resolution (32x32 -> ~6px cells, finer than an eye)
  const MAP_REFRESH = 15;   // recompute the error map every N accepted improvements
  const ANNEAL_WINDOW = 250;   // attempts per 1/5-rule mutation-size update
  const STALL_ATTEMPTS = 3000; // grow the shape budget after this many attempts w/o improvement
  const GROW_BATCH = 8;        // shapes appended per grow-on-stall event

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const randInt = (n) => (Math.random() * n) | 0;
  const randByte = () => (Math.random() * 256) | 0;
  const rnd = () => Math.random() * 2 - 1; // [-1, 1)
  const PI = Math.PI;
  const wrapPi = (a) => { a %= PI; return a < 0 ? a + PI : a; };

  // Works on the main thread and inside a worker (no document there).
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function polyArea(s) {
    const p = s.pts; let a = 0;
    for (let i = 0, n = p.length; i < n; i++) {
      const j = (i + 1) % n;
      a += p[i].x * p[j].y - p[j].x * p[i].y;
    }
    return Math.abs(a) / 2;
  }

  // Sample an index from a cumulative-weight array (weights ∝ cell error).
  function pickWeightedIndex(cum, total) {
    if (!(total > 0)) return -1;
    const r = Math.random() * total;
    const n = cum.length;
    for (let k = 0; k < n; k++) { if (cum[k] >= r) return k; }
    return n - 1;
  }

  function randomShape(cfg) {
    let kind, nVerts;
    if (cfg.shapeKind === 'ellipse') {
      kind = 'ellipse';
    } else if (cfg.shapeKind === 'mixed') {
      // Truly mixed: each shape is independently one of ~three balanced kinds
      // — ellipse, triangle, or a higher-vertex polygon — so all three show up.
      const r = Math.random();
      if (r < 0.34) { kind = 'ellipse'; }
      else if (r < 0.67) { kind = 'poly'; nVerts = 3; }                 // triangle
      else { kind = 'poly'; nVerts = 5 + ((Math.random() * 4) | 0); }   // 5..8 polygon
    } else {
      kind = 'poly';
    }

    if (kind === 'ellipse') {
      return {
        type: 'ellipse',
        cx: Math.random(), cy: Math.random(),
        rx: 0.03 + Math.random() * 0.20, ry: 0.03 + Math.random() * 0.20,
        rot: Math.random() * PI,
        r: randByte(), g: randByte(), b: randByte(), a: 0.1 + Math.random() * 0.4
      };
    }
    if (nVerts === undefined) nVerts = cfg.vertices || 3;
    const cx = Math.random(), cy = Math.random(), spread = 0.28, pts = [];
    for (let i = 0; i < nVerts; i++) {
      pts.push({ x: clamp01(cx + rnd() * spread), y: clamp01(cy + rnd() * spread) });
    }
    return { type: 'poly', pts, r: randByte(), g: randByte(), b: randByte(), a: 0.1 + Math.random() * 0.4 };
  }

  function cloneShape(s) {
    if (s.type === 'ellipse') {
      return { type: 'ellipse', cx: s.cx, cy: s.cy, rx: s.rx, ry: s.ry, rot: s.rot, r: s.r, g: s.g, b: s.b, a: s.a };
    }
    const pts = new Array(s.pts.length);
    for (let i = 0; i < s.pts.length; i++) pts[i] = { x: s.pts[i].x, y: s.pts[i].y };
    return { type: 'poly', pts, r: s.r, g: s.g, b: s.b, a: s.a };
  }

  // Move a shape so its centre sits at (p.x, p.y) — used to place new / relocated
  // shapes onto high-error regions.
  function placeAt(s, p) {
    const x = clamp01(p.x), y = clamp01(p.y);
    if (s.type === 'ellipse') { s.cx = x; s.cy = y; return; }
    let cx = 0, cy = 0; const n = s.pts.length;
    for (let i = 0; i < n; i++) { cx += s.pts[i].x; cy += s.pts[i].y; }
    cx /= n; cy /= n;
    const dx = x - cx, dy = y - cy;
    for (let i = 0; i < n; i++) {
      s.pts[i].x = clamp01(s.pts[i].x + dx);
      s.pts[i].y = clamp01(s.pts[i].y + dy);
    }
  }

  // Scale a shape to roughly `size` (fraction of canvas) about its centre — lets
  // shapes placed on a hot cell match the feature's scale (tiny for eyes/edges,
  // bigger for flat areas).
  function sizeShape(s, size) {
    if (s.type === 'ellipse') {
      s.rx = clamp(size * (0.7 + Math.random() * 0.6), 0.01, 0.7);
      s.ry = clamp(size * (0.7 + Math.random() * 0.6), 0.01, 0.7);
      return;
    }
    const p = s.pts, n = p.length;
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += p[i].x; cy += p[i].y; }
    cx /= n; cy /= n;
    let rad = 0;
    for (let i = 0; i < n; i++) rad += Math.hypot(p[i].x - cx, p[i].y - cy);
    rad /= n;
    const scale = rad > 1e-6 ? (size / rad) : 1;
    for (let i = 0; i < n; i++) {
      p[i].x = clamp01(cx + (p[i].x - cx) * scale);
      p[i].y = clamp01(cy + (p[i].y - cy) * scale);
    }
  }

  function tweakColor(s, amt) {
    const key = ['r', 'g', 'b'][randInt(3)];
    s[key] = clampByte(s[key] + rnd() * amt * 255);
  }

  function mutateShape(s, amt) {
    const t = Math.random();
    if (s.type === 'ellipse') {
      if (t < 0.35) {
        s.cx = clamp01(s.cx + rnd() * amt);
        s.cy = clamp01(s.cy + rnd() * amt);
      } else if (t < 0.60) {
        s.rx = clamp(s.rx + rnd() * amt * 0.6, 0.01, 0.7);
        s.ry = clamp(s.ry + rnd() * amt * 0.6, 0.01, 0.7);
      } else if (t < 0.72) {
        s.rot = wrapPi(s.rot + rnd() * amt * PI);
      } else if (t < 0.90) {
        tweakColor(s, amt);
      } else {
        s.a = clamp(s.a + rnd() * amt * 0.6, 0.02, 1);
      }
    } else {
      if (t < 0.5) {
        const v = s.pts[randInt(s.pts.length)];
        v.x = clamp01(v.x + rnd() * amt);
        v.y = clamp01(v.y + rnd() * amt);
      } else if (t < 0.85) {
        tweakColor(s, amt);
      } else {
        s.a = clamp(s.a + rnd() * amt * 0.6, 0.02, 1);
      }
    }
  }

  // Produce a mutated copy of `genome` (copy-on-write: only the touched
  // shape is deep-cloned). `hotspot`, when supplied, returns {x,y,size} biased
  // toward high-error regions; `amt` is the effective (annealed) mutation size,
  // defaulting to cfg.mutationAmount. Both change only the PROPOSAL, never the
  // accept/reject rule, so monotonicity is preserved.
  function mutate(genome, cfg, hotspot, amt) {
    const shapes = genome.shapes.slice();
    if (amt === undefined) amt = cfg.mutationAmount;
    const roll = Math.random();

    if (roll < 0.08 && shapes.length < cfg.maxShapes) {
      const s = randomShape(cfg);
      if (hotspot) { const hp = hotspot(); placeAt(s, hp); if (hp.size) sizeShape(s, hp.size); }
      shapes.splice(randInt(shapes.length + 1), 0, s);
    } else if (roll < 0.14 && shapes.length > cfg.minShapes) {
      shapes.splice(randInt(shapes.length), 1);
    } else if (roll < 0.20 && shapes.length > 1) {
      const i = randInt(shapes.length);
      const s = shapes.splice(i, 1)[0];
      shapes.splice(randInt(shapes.length + 1), 0, s);
    } else if (roll < 0.26 && hotspot) {
      const i = randInt(shapes.length);          // relocate a shape onto a hot region
      const s = cloneShape(shapes[i]);
      const hp = hotspot();
      placeAt(s, hp);
      if (hp.size) sizeShape(s, hp.size);
      shapes[i] = s;
    } else {
      const i = randInt(shapes.length);
      const s = cloneShape(shapes[i]);
      mutateShape(s, amt);
      shapes[i] = s;
    }
    return { shapes };
  }

  // Render any genome into a 2D context sized w x h (display / fitness / export).
  function renderGenome(ctx, w, h, genome) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const shapes = genome.shapes;
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      ctx.fillStyle = 'rgba(' + (s.r | 0) + ',' + (s.g | 0) + ',' + (s.b | 0) + ',' + s.a + ')';
      ctx.beginPath();
      if (s.type === 'ellipse') {
        ctx.ellipse(s.cx * w, s.cy * h, Math.max(0.5, s.rx * w), Math.max(0.5, s.ry * h), s.rot, 0, PI * 2);
      } else {
        const p = s.pts;
        ctx.moveTo(p[0].x * w, p[0].y * h);
        for (let k = 1; k < p.length; k++) ctx.lineTo(p[k].x * w, p[k].y * h);
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  class ArtEvolver {
    // target: { data: Uint8ClampedArray (RGBA), w, h }
    constructor(target, cfg) {
      this.target = target;
      this.cfg = cfg;
      this.evalCanvas = makeCanvas(target.w, target.h);
      this.ectx = this.evalCanvas.getContext('2d', { willReadFrequently: true });
      this.GRID = GRID;
      this._errMap = new Float64Array(GRID * GRID);
      this._errCum = new Float64Array(GRID * GRID);
      this._errTotal = 0;
      this._hotspot = this._sampleHotspot.bind(this);
      this._computeBaseline(); // depends only on the target -> once per target
      this.reset();
    }

    // Baseline = error of a solid "average colour" fill vs the target. That is a
    // fair "0% = no better than a blank guess" reference and stays fixed per run,
    // so Match% (rebased against it) is monotonic under keep-if-better.
    _computeBaseline() {
      const tgt = this.target.data;
      const N = tgt.length / 4;
      let sr = 0, sg = 0, sb = 0;
      for (let i = 0; i < tgt.length; i += 4) { sr += tgt[i]; sg += tgt[i + 1]; sb += tgt[i + 2]; }
      const ar = sr / N, ag = sg / N, ab = sb / N;
      this._avg = { r: ar, g: ag, b: ab };  // reused to seed the background layer
      let base = 0;
      for (let i = 0; i < tgt.length; i += 4) {
        const dr = ar - tgt[i], dg = ag - tgt[i + 1], db = ab - tgt[i + 2];
        base += LUMA_R * dr * dr + LUMA_G * dg * dg + LUMA_B * db * db;
      }
      this.baselineError = Math.max(base, 1e-6);
    }

    // Sample the target's colour at a normalized (x,y) point.
    _sampleTargetColor(x, y) {
      const w = this.target.w, h = this.target.h, d = this.target.data;
      const px = clamp((x * w) | 0, 0, w - 1), py = clamp((y * h) | 0, 0, h - 1);
      const i = (py * w + px) * 4;
      return { r: d[i], g: d[i + 1], b: d[i + 2] };
    }

    // Full-canvas polygon painted with the target's average colour — a base
    // layer whose error equals the baseline, so seeding stays honest.
    _bgShape() {
      return {
        type: 'poly',
        pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
        r: this._avg.r, g: this._avg.g, b: this._avg.b, a: 1
      };
    }

    reset() {
      this.best = this._randomGenome();
      this.bestError = this._error(this.best);
      this.attempts = 0;
      this.improvements = 0;
      this._lastMapImp = 0;
      this._effAmt = this.cfg.mutationAmount; // annealer starts at the ceiling
      this._winAtt = 0; this._winAcc = 0;     // 1/5-rule window counters
      this._lastImpAtt = 0;                    // grow-on-stall tracking
      this.history = [this.bestMatch];
      this._computeErrorMap();
    }

    _randomGenome() {
      const n = clamp(this.cfg.numShapes | 0, this.cfg.minShapes, this.cfg.maxShapes);
      // Seeded start (default): average-colour background + shapes coloured from
      // the target at their own location. Gives a big head start over random.
      if (this.cfg.seed !== false && this._avg) {
        const shapes = [this._bgShape()];
        for (let i = 1; i < n; i++) {
          const s = randomShape(this.cfg);
          const x = Math.random(), y = Math.random();
          placeAt(s, { x, y });
          const c = this._sampleTargetColor(x, y);
          s.r = c.r; s.g = c.g; s.b = c.b;
          s.a = 0.35 + Math.random() * 0.3;
          shapes.push(s);
        }
        return { shapes };
      }
      const shapes = new Array(n);
      for (let i = 0; i < n; i++) shapes[i] = randomShape(this.cfg);
      return { shapes };
    }

    // Luma-weighted sum of squared per-channel differences (lower = better).
    _error(genome) {
      const w = this.target.w, h = this.target.h;
      renderGenome(this.ectx, w, h, genome);
      const cur = this.ectx.getImageData(0, 0, w, h).data;
      const tgt = this.target.data;
      let sse = 0;
      for (let i = 0; i < cur.length; i += 4) {
        const dr = cur[i] - tgt[i];
        const dg = cur[i + 1] - tgt[i + 1];
        const db = cur[i + 2] - tgt[i + 2];
        sse += LUMA_R * dr * dr + LUMA_G * dg * dg + LUMA_B * db * db;
      }
      return sse;
    }

    // Coarse GRID x GRID map of where the best genome differs most from the
    // target, plus a cumulative array for proportional hotspot sampling.
    _computeErrorMap() {
      const G = this.GRID, w = this.target.w, h = this.target.h;
      renderGenome(this.ectx, w, h, this.best);
      const cur = this.ectx.getImageData(0, 0, w, h).data;
      const tgt = this.target.data;
      const map = this._errMap; map.fill(0);
      for (let y = 0; y < h; y++) {
        const gy = (y * G / h) | 0;
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = (row + x) * 4;
          const dr = cur[i] - tgt[i], dg = cur[i + 1] - tgt[i + 1], db = cur[i + 2] - tgt[i + 2];
          const e = LUMA_R * dr * dr + LUMA_G * dg * dg + LUMA_B * db * db;
          map[gy * G + ((x * G / w) | 0)] += e;
        }
      }
      let total = 0; const cum = this._errCum;
      for (let k = 0; k < G * G; k++) { total += map[k]; cum[k] = total; }
      this._errTotal = total;
    }

    _sampleHotspot() {
      const G = this.GRID;
      const k = pickWeightedIndex(this._errCum, this._errTotal);
      if (k < 0) return { x: Math.random(), y: Math.random(), size: 0.12 };
      const gx = k % G, gy = (k / G) | 0;
      // Estimate the hot region's extent from contiguous hot neighbours so the
      // caller can size the shape: isolated hot cell -> tiny; broad area -> big.
      const map = this._errMap, thr = map[k] * 0.4;
      let hot = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
          if (map[ny * G + nx] >= thr) hot++;
        }
      }
      const cell = 1 / G;
      return {
        x: (gx + Math.random()) / G,
        y: (gy + Math.random()) / G,
        size: cell * (0.6 + hot * 0.5)  // ~0.6..4.6 cells
      };
    }

    // Rebased, honest Match%: 0 = no better than a blank average-colour guess,
    // 100 = perfect. Clamped at 0 for the (rare) case where the random start is
    // worse than the baseline. Monotonic because baselineError is fixed and
    // bestError only decreases.
    matchPct(sse) {
      return Math.max(0, 1 - sse / this.baselineError) * 100;
    }

    get bestMatch() { return this.matchPct(this.bestError); }
    get shapeCount() { return this.best.shapes.length; }
    get effectiveMutation() { return this._effAmt; }

    draw(ctx, w, h) { renderGenome(ctx, w, h, this.best); }

    // Append a batch of invisible (alpha 0) shapes at hot regions to add detail
    // capacity. Error is unchanged (alpha 0) -> Match% stays monotonic.
    _growBatch() {
      const room = this.cfg.maxShapes - this.best.shapes.length;
      const k = Math.min(GROW_BATCH, room);
      if (k <= 0) return;
      const shapes = this.best.shapes.slice();
      for (let i = 0; i < k; i++) {
        const s = randomShape(this.cfg);
        const hp = this._sampleHotspot();
        placeAt(s, hp);
        if (hp.size) sizeShape(s, hp.size);
        s.a = 0;
        shapes.push(s);
      }
      this.best = { shapes };
    }

    // Run `nAttempts` mutate/keep-if-better trials. Returns true if improved.
    step(nAttempts) {
      let improved = false;
      const hs = this._hotspot;
      for (let i = 0; i < nAttempts; i++) {
        const cand = mutate(this.best, this.cfg, hs, this._effAmt);
        const err = this._error(cand);
        this.attempts++;
        this._winAtt++;
        if (err < this.bestError) {
          this.best = cand;
          this.bestError = err;
          this.improvements++;
          this._winAcc++;
          this._lastImpAtt = this.attempts;
          improved = true;
        }
        // 1/5-success-rule annealing: grow effective sigma when accepts are
        // frequent (early), shrink it when they're rare (converging). The
        // slider (cfg.mutationAmount) is the CEILING.
        if (this._winAtt >= ANNEAL_WINDOW) {
          const rate = this._winAcc / this._winAtt;
          const ceil = this.cfg.mutationAmount;
          const floor = Math.max(0.01, ceil * 0.08);
          if (rate > 0.2) this._effAmt = Math.min(ceil, this._effAmt * 1.3);
          else this._effAmt = Math.max(floor, this._effAmt * 0.85);
          this._winAtt = 0; this._winAcc = 0;
        }
        // Grow-on-stall: only add shape capacity once progress plateaus.
        if (this.attempts - this._lastImpAtt >= STALL_ATTEMPTS &&
            this.best.shapes.length < this.cfg.maxShapes) {
          this._growBatch();
          this._lastImpAtt = this.attempts;
        }
      }
      if (improved) {
        this.history.push(this.bestMatch);
        if (this.history.length > 600) this.history.shift();
        if (this.improvements - this._lastMapImp >= MAP_REFRESH) {
          this._computeErrorMap();
          this._lastMapImp = this.improvements;
        }
      }
      return improved;
    }

    // ---- progress-preserving settings changes (no wipe, no baseline change) ----

    // Change the shape budget WITHOUT throwing away the evolved picture:
    //  • grow  -> append invisible (alpha 0) shapes at hot regions; error is
    //             unchanged, so Match% doesn't drop; they evolve in over time.
    //  • shrink -> remove only the lowest-impact shapes whose removal does NOT
    //             raise error; anything left is trimmed later by evolution.
    // Either way bestError never increases -> Match% stays monotonic.
    setShapeCount(n, minShapes, maxShapes) {
      this.cfg.numShapes = n;
      this.cfg.minShapes = minShapes;
      this.cfg.maxShapes = maxShapes;
      let shapes = this.best.shapes.slice();

      if (shapes.length < n) {
        while (shapes.length < n) {
          const s = randomShape(this.cfg);
          const hp = this._sampleHotspot();
          placeAt(s, hp);
          if (hp.size) sizeShape(s, hp.size);
          s.a = 0; // invisible -> zero pixel contribution -> error unchanged
          shapes.push(s);
        }
        this.best = { shapes };
      } else if (shapes.length > n) {
        const impact = (s) => s.a * (s.type === 'ellipse'
          ? Math.max(1e-4, s.rx * s.ry)
          : Math.max(1e-4, polyArea(s)));
        const order = shapes.map((_, i) => i).sort((a, b) => impact(shapes[a]) - impact(shapes[b]));
        const removed = new Set();
        for (const i of order) {
          if (shapes.length - removed.size <= n) break;
          const trial = { shapes: shapes.filter((_, j) => j !== i && !removed.has(j)) };
          const e = this._error(trial);
          if (e <= this.bestError + 1e-9) { removed.add(i); this.bestError = e; }
        }
        this.best = { shapes: shapes.filter((_, j) => !removed.has(j)) };
      }

      this.bestError = this._error(this.best); // exact resync (<= previous)
      this._computeErrorMap();
      this._lastMapImp = this.improvements;
    }

    // Change the shape style WITHOUT touching existing shapes — only newly
    // created shapes (growth / add-mutations) adopt the new style, so the mix
    // shifts gradually and no progress is lost.
    setStyle(shapeKind, vertices) {
      this.cfg.shapeKind = shapeKind;
      if (vertices) this.cfg.vertices = vertices;
    }
  }

  const api = { ArtEvolver, mutate, randomShape, renderGenome, pickWeightedIndex };
  const root = (typeof self !== 'undefined') ? self
             : (typeof window !== 'undefined') ? window
             : (typeof globalThis !== 'undefined') ? globalThis : this;
  root.Art = api;
})();

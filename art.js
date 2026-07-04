/* ============================================================
   art.js — "Evolve a Picture" engine.
   A genome is a stack of semi-transparent colored polygons. We render
   it, compare pixels to a target image, and run a (1+1) evolution
   strategy: mutate a copy of the best, keep it ONLY if it matches the
   target better. Best error is therefore monotonically non-increasing,
   so Match% never goes down.
   Exposes: window.Art = { ArtEvolver, mutate, randomShape }
   ============================================================ */
(function () {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const randInt = (n) => (Math.random() * n) | 0;
  const randByte = () => (Math.random() * 256) | 0;
  const rnd = () => Math.random() * 2 - 1; // [-1, 1)

  function randomShape(nVerts) {
    const cx = Math.random(), cy = Math.random();
    const spread = 0.28;
    const pts = [];
    for (let i = 0; i < nVerts; i++) {
      pts.push({ x: clamp01(cx + rnd() * spread), y: clamp01(cy + rnd() * spread) });
    }
    return { pts, r: randByte(), g: randByte(), b: randByte(), a: 0.1 + Math.random() * 0.4 };
  }

  function cloneShape(s) {
    const pts = new Array(s.pts.length);
    for (let i = 0; i < s.pts.length; i++) pts[i] = { x: s.pts[i].x, y: s.pts[i].y };
    return { pts, r: s.r, g: s.g, b: s.b, a: s.a };
  }

  // Produce a mutated copy of `genome` (copy-on-write: only the touched
  // shape is deep-cloned). cfg: mutationAmount, vertices, minShapes, maxShapes.
  function mutate(genome, cfg) {
    const shapes = genome.shapes.slice();
    const amt = cfg.mutationAmount;
    const roll = Math.random();

    if (roll < 0.08 && shapes.length < cfg.maxShapes) {
      shapes.splice(randInt(shapes.length + 1), 0, randomShape(cfg.vertices));
    } else if (roll < 0.14 && shapes.length > cfg.minShapes) {
      shapes.splice(randInt(shapes.length), 1);
    } else if (roll < 0.20 && shapes.length > 1) {
      const i = randInt(shapes.length);
      const s = shapes.splice(i, 1)[0];
      shapes.splice(randInt(shapes.length + 1), 0, s);
    } else {
      const i = randInt(shapes.length);
      const s = cloneShape(shapes[i]);
      const t = Math.random();
      if (t < 0.5) {
        const v = s.pts[randInt(s.pts.length)];
        v.x = clamp01(v.x + rnd() * amt);
        v.y = clamp01(v.y + rnd() * amt);
      } else if (t < 0.85) {
        const key = ['r', 'g', 'b'][randInt(3)];
        s[key] = clampByte(s[key] + rnd() * amt * 255);
      } else {
        s.a = clamp(s.a + rnd() * amt * 0.6, 0.02, 1);
      }
      shapes[i] = s;
    }
    return { shapes };
  }

  class ArtEvolver {
    // target: { data: Uint8ClampedArray (RGBA), w, h }
    constructor(target, cfg) {
      this.target = target;
      this.cfg = cfg;
      this.evalCanvas = document.createElement('canvas');
      this.evalCanvas.width = target.w;
      this.evalCanvas.height = target.h;
      this.ectx = this.evalCanvas.getContext('2d', { willReadFrequently: true });
      this._maxErr = target.w * target.h * 3 * 255 * 255; // for reference
      this.reset();
    }

    reset() {
      this.best = this._randomGenome();
      this.bestError = this._error(this.best);
      this.attempts = 0;
      this.improvements = 0;
      this.history = [];
      this.history.push(this.bestMatch);
    }

    _randomGenome() {
      const n = clamp(this.cfg.numShapes | 0, this.cfg.minShapes, this.cfg.maxShapes);
      const shapes = new Array(n);
      for (let i = 0; i < n; i++) shapes[i] = randomShape(this.cfg.vertices);
      return { shapes };
    }

    _renderTo(ctx, w, h, genome) {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      const shapes = genome.shapes;
      for (let i = 0; i < shapes.length; i++) {
        const s = shapes[i], p = s.pts;
        ctx.beginPath();
        ctx.moveTo(p[0].x * w, p[0].y * h);
        for (let k = 1; k < p.length; k++) ctx.lineTo(p[k].x * w, p[k].y * h);
        ctx.closePath();
        ctx.fillStyle = 'rgba(' + (s.r | 0) + ',' + (s.g | 0) + ',' + (s.b | 0) + ',' + s.a + ')';
        ctx.fill();
      }
    }

    // Sum of squared per-channel differences vs the target (lower = better).
    _error(genome) {
      const w = this.target.w, h = this.target.h;
      this._renderTo(this.ectx, w, h, genome);
      const cur = this.ectx.getImageData(0, 0, w, h).data;
      const tgt = this.target.data;
      let sse = 0;
      for (let i = 0; i < cur.length; i += 4) {
        const dr = cur[i] - tgt[i];
        const dg = cur[i + 1] - tgt[i + 1];
        const db = cur[i + 2] - tgt[i + 2];
        sse += dr * dr + dg * dg + db * db;
      }
      return sse;
    }

    matchPct(sse) {
      const n = this.target.w * this.target.h * 3;
      const rms = Math.sqrt(sse / n); // 0 (perfect) .. 255 (worst)
      return Math.max(0, (1 - rms / 255)) * 100;
    }

    get bestMatch() { return this.matchPct(this.bestError); }
    get shapeCount() { return this.best.shapes.length; }

    // Paint the current best genome into any 2D context (for the big display).
    draw(ctx, w, h) { this._renderTo(ctx, w, h, this.best); }

    // Run `nAttempts` mutate/keep-if-better trials. Returns true if the best
    // improved (so the caller knows to repaint the big display).
    step(nAttempts) {
      let improved = false;
      for (let i = 0; i < nAttempts; i++) {
        const cand = mutate(this.best, this.cfg);
        const err = this._error(cand);
        this.attempts++;
        if (err < this.bestError) {
          this.best = cand;
          this.bestError = err;
          this.improvements++;
          improved = true;
        }
      }
      if (improved) {
        this.history.push(this.bestMatch);
        if (this.history.length > 600) this.history.shift();
      }
      return improved;
    }
  }

  window.Art = { ArtEvolver, mutate, randomShape };
})();

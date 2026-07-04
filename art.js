/* ============================================================
   art.js — shared "Evolve a Picture" core (main thread AND worker).
   A genome is a stack of semi-transparent shapes; each shape is either
   a polygon (pts[]) or an ellipse (cx,cy,rx,ry,rot). We render it,
   compare pixels to a target, and run a (1+1) evolution strategy:
   mutate a copy of the best, keep it ONLY if it matches better. Best
   error is monotonically non-increasing, so Match% never goes down.

   Exposes (on window OR worker self OR globalThis):
     Art = { ArtEvolver, mutate, randomShape, renderGenome }
   ============================================================ */
(function () {
  'use strict';

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

  function randomShape(cfg) {
    // Decide this shape's kind (and, for polygons, its vertex count).
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
  // shape is deep-cloned). cfg: mutationAmount, shapeKind, vertices, min/maxShapes.
  function mutate(genome, cfg) {
    const shapes = genome.shapes.slice();
    const amt = cfg.mutationAmount;
    const roll = Math.random();

    if (roll < 0.08 && shapes.length < cfg.maxShapes) {
      shapes.splice(randInt(shapes.length + 1), 0, randomShape(cfg));
    } else if (roll < 0.14 && shapes.length > cfg.minShapes) {
      shapes.splice(randInt(shapes.length), 1);
    } else if (roll < 0.20 && shapes.length > 1) {
      const i = randInt(shapes.length);
      const s = shapes.splice(i, 1)[0];
      shapes.splice(randInt(shapes.length + 1), 0, s);
    } else {
      const i = randInt(shapes.length);
      const s = cloneShape(shapes[i]);
      mutateShape(s, amt);
      shapes[i] = s;
    }
    return { shapes };
  }

  // Render any genome into a 2D context sized w x h (shared by display,
  // fitness eval, and PNG export).
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
      this.reset();
    }

    reset() {
      this.best = this._randomGenome();
      this.bestError = this._error(this.best);
      this.attempts = 0;
      this.improvements = 0;
      this.history = [this.bestMatch];
    }

    _randomGenome() {
      const n = clamp(this.cfg.numShapes | 0, this.cfg.minShapes, this.cfg.maxShapes);
      const shapes = new Array(n);
      for (let i = 0; i < n; i++) shapes[i] = randomShape(this.cfg);
      return { shapes };
    }

    // Sum of squared per-channel differences vs the target (lower = better).
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
    draw(ctx, w, h) { renderGenome(ctx, w, h, this.best); }

    // Run `nAttempts` mutate/keep-if-better trials. Returns true if improved.
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

  const api = { ArtEvolver, mutate, randomShape, renderGenome };
  const root = (typeof self !== 'undefined') ? self
             : (typeof window !== 'undefined') ? window
             : (typeof globalThis !== 'undefined') ? globalThis : this;
  root.Art = api;
})();

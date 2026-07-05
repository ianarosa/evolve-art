/* ============================================================
   art.js — shared "Evolve a Picture" core (main thread AND worker).
   A genome is a stack of semi-transparent shapes (polygon pts[] or an
   ellipse cx,cy,rx,ry,rot). We render it, compare pixels to a target
   (perceptually luma-weighted), and run a (1+1) evolution strategy:
   mutate a copy of the best, keep it ONLY if it matches better.

   PASS 2 performance:
    • Incremental "dirty-rectangle" fitness: a single-shape mutation only
      changes pixels inside the union of the shape's old+new bounding box.
      We re-render ONLY that box from the full genome (absolute coords, read
      just the box) and update total = bestError - oldBoxError + newBoxError,
      which equals a full rescore exactly (a cached per-pixel error array
      makes oldBoxError exact). Big/whole-image boxes fall back to full.
    • Multi-scale coarse->fine eval: evolve at a small resolution first
      (cheap, places big shapes fast), stepping up on stall/age. The metric
      changes at a step-up, so displayed Match% is a running max (never
      appears to drop).

   Best-of-run Match% is monotonic within a run except on reset/target change.

   Exposes (window / worker self / globalThis):
     Art = { ArtEvolver, mutate, randomShape, renderGenome, pickWeightedIndex }
   ============================================================ */
(function () {
  'use strict';

  // ---- perception + tuning constants ----
  const LUMA_R = 0.2126, LUMA_G = 0.7152, LUMA_B = 0.0722; // Rec.709
  const GRID = 32;             // error-map resolution (32x32 -> fine features)
  const MAP_REFRESH = 15;      // recompute the error map every N improvements
  const ANNEAL_WINDOW = 250;   // attempts per 1/5-rule mutation-size update
  const STALL_ATTEMPTS = 2500; // step-up / grow after this many attempts w/o improvement
  const SCALE_MAX_ATT = 20000; // force a step-up if a scale runs this long
  const GROW_BATCH = 8;        // shapes appended per grow-on-stall event
  const SCALE_FACTORS = [0.32, 0.64, 1.0]; // coarse -> fine (of the target long side)
  const BOX_FULL_FRAC = 0.5;   // a dirty box >= this fraction of the image => just do full
  const EDGE_K = 3;            // edge weight: w = 1 + EDGE_K * normalizedEdgeStrength
  const REHEAT_BEFORE_GROW = 1;// stall re-heats to try before adding shape capacity

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const randInt = (n) => (Math.random() * n) | 0;
  const randByte = () => (Math.random() * 256) | 0;
  const rnd = () => Math.random() * 2 - 1; // [-1, 1)
  const PI = Math.PI;
  const wrapPi = (a) => { a %= PI; return a < 0 ? a + PI : a; };

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

  // Axis-aligned bounding box of a shape in normalized [0,1] coords.
  function shapeBBox(s) {
    if (s.type === 'ellipse') {
      const c = Math.cos(s.rot), si = Math.sin(s.rot);
      const ex = Math.sqrt(s.rx * s.rx * c * c + s.ry * s.ry * si * si);
      const ey = Math.sqrt(s.rx * s.rx * si * si + s.ry * s.ry * c * c);
      return { x0: s.cx - ex, y0: s.cy - ey, x1: s.cx + ex, y1: s.cy + ey };
    }
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of s.pts) {
      if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1 };
  }
  function boxUnion(a, b) {
    return {
      x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1)
    };
  }

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
      const r = Math.random();
      if (r < 0.34) { kind = 'ellipse'; }
      else if (r < 0.67) { kind = 'poly'; nVerts = 3; }
      else { kind = 'poly'; nVerts = 5 + ((Math.random() * 4) | 0); }
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

  // Scale a shape to roughly `size` (fraction of canvas) about its centre.
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
      if (t < 0.35) { s.cx = clamp01(s.cx + rnd() * amt); s.cy = clamp01(s.cy + rnd() * amt); }
      else if (t < 0.60) { s.rx = clamp(s.rx + rnd() * amt * 0.6, 0.01, 0.7); s.ry = clamp(s.ry + rnd() * amt * 0.6, 0.01, 0.7); }
      else if (t < 0.72) { s.rot = wrapPi(s.rot + rnd() * amt * PI); }
      else if (t < 0.90) { tweakColor(s, amt); }
      else { s.a = clamp(s.a + rnd() * amt * 0.6, 0.02, 1); }
    } else {
      if (t < 0.5) { const v = s.pts[randInt(s.pts.length)]; v.x = clamp01(v.x + rnd() * amt); v.y = clamp01(v.y + rnd() * amt); }
      else if (t < 0.85) { tweakColor(s, amt); }
      else { s.a = clamp(s.a + rnd() * amt * 0.6, 0.02, 1); }
    }
  }

  // Core proposal: returns { genome, box } where `box` is the normalized
  // affected region (union of old+new extents of the touched shape). Every
  // mutation type here is localizable; the evolver decides box-vs-full eval.
  function proposeMutation(genome, cfg, hotspot, amt) {
    const shapes = genome.shapes.slice();
    if (amt === undefined) amt = cfg.mutationAmount;
    const roll = Math.random();
    let box;

    if (roll < 0.08 && shapes.length < cfg.maxShapes) {
      const s = randomShape(cfg);
      if (hotspot) { const hp = hotspot(); placeAt(s, hp); if (hp.size) sizeShape(s, hp.size); }
      shapes.splice(randInt(shapes.length + 1), 0, s);
      box = shapeBBox(s);
    } else if (roll < 0.14 && shapes.length > cfg.minShapes) {
      const i = randInt(shapes.length);
      box = shapeBBox(shapes[i]);
      shapes.splice(i, 1);
    } else if (roll < 0.20 && shapes.length > 1) {
      const i = randInt(shapes.length);        // reorder (z-order): affects only this shape's box
      const s = shapes.splice(i, 1)[0];
      shapes.splice(randInt(shapes.length + 1), 0, s);
      box = shapeBBox(s);
    } else if (roll < 0.26 && hotspot) {
      const i = randInt(shapes.length);         // relocate onto a hot region
      const old = shapes[i];
      const s = cloneShape(old);
      const hp = hotspot(); placeAt(s, hp); if (hp.size) sizeShape(s, hp.size);
      shapes[i] = s;
      box = boxUnion(shapeBBox(old), shapeBBox(s));
    } else {
      const i = randInt(shapes.length);         // local tweak (move/resize/recolor/alpha)
      const old = shapes[i];
      const s = cloneShape(old);
      mutateShape(s, amt);
      shapes[i] = s;
      box = boxUnion(shapeBBox(old), shapeBBox(s));
    }
    return { genome: { shapes }, box };
  }

  // Backwards-compatible pure mutate (returns just the genome).
  function mutate(genome, cfg, hotspot, amt) {
    return proposeMutation(genome, cfg, hotspot, amt).genome;
  }

  function drawShape(ctx, w, h, s) {
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

  // Render a whole genome into a 2D context sized w x h (display / fitness / export).
  function renderGenome(ctx, w, h, genome) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const shapes = genome.shapes;
    for (let i = 0; i < shapes.length; i++) drawShape(ctx, w, h, shapes[i]);
  }

  class ArtEvolver {
    // target: { data: Uint8ClampedArray (RGBA), w, h }
    constructor(target, cfg) {
      this.cfg = cfg;
      this._maxW = target.w; this._maxH = target.h;
      this.evalCanvas = makeCanvas(this._maxW, this._maxH);
      this.ectx = this.evalCanvas.getContext('2d', { willReadFrequently: true });
      this.GRID = GRID;
      this._errMap = new Float64Array(GRID * GRID);
      this._errCum = new Float64Array(GRID * GRID);
      this._errTotal = 0;
      const N = this._maxW * this._maxH;
      this._bestErrArr = new Float32Array(N); // exact per-pixel error of the best (current scale)
      this._fullBuf = new Float32Array(N);    // scratch for a full rescore
      this._boxBuf = new Float32Array(N);     // scratch for a dirty-box rescore
      this._hotspot = this._sampleHotspot.bind(this);
      this._buildScales(target);
      this.reset();
    }

    // ---------- multi-scale target pyramid ----------
    _buildScales(full) {
      const factors = (this.cfg.multiScale === false) ? [1.0] : SCALE_FACTORS;
      this._scales = [];
      for (const f of factors) {
        const w = Math.max(8, Math.round(full.w * f));
        const h = Math.max(8, Math.round(full.h * f));
        const data = (f >= 1.0) ? full.data : this._downsample(full, w, h);
        const wmap = this._edgeWeights(data, w, h); // edge/gradient weight per pixel
        const bl = this._baselineFor(data, wmap);   // baseline weighted the SAME way
        this._scales.push({ w, h, data, wmap, baseline: bl.baseline, avg: bl.avg });
      }
    }

    // Per-pixel error weight w = 1 + EDGE_K * (normalized Sobel edge strength of
    // the target). Edges (a few % of pixels) get up to ~(1+EDGE_K)x weight so the
    // metric stops washing them out; flats keep weight ~1. Precomputed per scale.
    _edgeWeights(data, w, h) {
      const wt = new Float32Array(w * h);
      if (this.cfg.edgeWeight === false) { wt.fill(1); return wt; }
      const lum = new Float32Array(w * h);
      for (let p = 0, i = 0; i < data.length; i += 4, p++) {
        lum[p] = LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2];
      }
      let mx = 1e-6;
      const mag = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const ym = y > 0 ? y - 1 : y, yp = y < h - 1 ? y + 1 : y;
        for (let x = 0; x < w; x++) {
          const xm = x > 0 ? x - 1 : x, xp = x < w - 1 ? x + 1 : x;
          const a00 = lum[ym * w + xm], a01 = lum[ym * w + x], a02 = lum[ym * w + xp];
          const a10 = lum[y * w + xm], a12 = lum[y * w + xp];
          const a20 = lum[yp * w + xm], a21 = lum[yp * w + x], a22 = lum[yp * w + xp];
          const gx = (a02 + 2 * a12 + a22) - (a00 + 2 * a10 + a20);
          const gy = (a20 + 2 * a21 + a22) - (a00 + 2 * a01 + a02);
          const m = Math.sqrt(gx * gx + gy * gy);
          mag[y * w + x] = m; if (m > mx) mx = m;
        }
      }
      for (let p = 0; p < w * h; p++) wt[p] = 1 + EDGE_K * (mag[p] / mx);
      return wt;
    }
    _downsample(full, w, h) {
      const src = makeCanvas(full.w, full.h);
      const sctx = src.getContext('2d');
      const id = sctx.createImageData(full.w, full.h);
      id.data.set(full.data);
      sctx.putImageData(id, 0, 0);
      const dst = makeCanvas(w, h);
      const dctx = dst.getContext('2d', { willReadFrequently: true });
      dctx.imageSmoothingEnabled = true;
      dctx.clearRect(0, 0, w, h);
      dctx.drawImage(src, 0, 0, full.w, full.h, 0, 0, w, h);
      return dctx.getImageData(0, 0, w, h).data;
    }
    _baselineFor(data, wmap) {
      const N = data.length / 4;
      let sr = 0, sg = 0, sb = 0;
      for (let i = 0; i < data.length; i += 4) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; }
      const ar = sr / N, ag = sg / N, ab = sb / N;
      let base = 0;
      for (let p = 0, i = 0; i < data.length; i += 4, p++) {
        const dr = ar - data[i], dg = ag - data[i + 1], db = ab - data[i + 2];
        base += wmap[p] * (LUMA_R * dr * dr + LUMA_G * dg * dg + LUMA_B * db * db);
      }
      return { baseline: Math.max(base, 1e-6), avg: { r: ar, g: ag, b: ab } };
    }
    _applyScaleTarget(idx) {
      const sc = this._scales[idx];
      this.target = { data: sc.data, w: sc.w, h: sc.h };
      this.w = sc.w; this.h = sc.h;
      this.baselineError = sc.baseline;
      this._wArr = sc.wmap;
      this._avg = sc.avg;
    }

    _sampleTargetColor(x, y) {
      const w = this.w, h = this.h, d = this.target.data;
      const px = clamp((x * w) | 0, 0, w - 1), py = clamp((y * h) | 0, 0, h - 1);
      const i = (py * w + px) * 4;
      return { r: d[i], g: d[i + 1], b: d[i + 2] };
    }
    _bgShape() {
      return {
        type: 'poly',
        pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
        r: this._avg.r, g: this._avg.g, b: this._avg.b, a: 1
      };
    }

    reset() {
      this._scaleIdx = 0;
      this._applyScaleTarget(0);
      this.best = this._randomGenome();
      this._fullRescore();                 // fills _bestErrArr + bestError at current scale
      this.attempts = 0;
      this.improvements = 0;
      this._lastMapImp = 0;
      this._effAmt = this.cfg.mutationAmount;
      this._winAtt = 0; this._winAcc = 0;
      this._lastImpAtt = 0;
      this._scaleStartAtt = 0;
      this._reheatCount = 0;   // re-heats since last improvement
      this._reheats = 0;       // total re-heats (telemetry)
      this._rawAnchor = this.matchPct(this.bestError); // raw match at scale-0 start
      this._dispAnchor = this._rawAnchor;              // display begins at the honest value
      this._maxMatch = this._rawAnchor;
      this.history = [this._maxMatch];
      this._computeErrorMap();
    }

    _randomGenome() {
      const n = clamp(this.cfg.numShapes | 0, this.cfg.minShapes, this.cfg.maxShapes);
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

    // Full render + rescore of the current best at the current scale. Rebuilds
    // the exact per-pixel error cache and the scalar total.
    _fullRescore() {
      const w = this.w, h = this.h, ctx = this.ectx;
      renderGenome(ctx, w, h, this.best);
      const cur = ctx.getImageData(0, 0, w, h).data;
      const tgt = this.target.data, arr = this._bestErrArr, wArr = this._wArr;
      let total = 0;
      for (let p = 0, i = 0; i < cur.length; i += 4, p++) {
        const dr = cur[i] - tgt[i], dg = cur[i + 1] - tgt[i + 1], db = cur[i + 2] - tgt[i + 2];
        const e = wArr[p] * (LUMA_R * dr * dr + LUMA_G * dg * dg + LUMA_B * db * db);
        arr[p] = e; total += e;
      }
      this.bestError = total;
    }

    // Full error of an arbitrary genome (used by shape-count shrink trials).
    _errorOf(shapes) {
      const w = this.w, h = this.h, ctx = this.ectx;
      renderGenome(ctx, w, h, { shapes });
      const cur = ctx.getImageData(0, 0, w, h).data, tgt = this.target.data, wArr = this._wArr;
      let t = 0;
      for (let p = 0, i = 0; i < cur.length; i += 4, p++) {
        const dr = cur[i] - tgt[i], dg = cur[i + 1] - tgt[i + 1], db = cur[i + 2] - tgt[i + 2];
        t += wArr[p] * (LUMA_R * dr * dr + LUMA_G * dg * dg + LUMA_B * db * db);
      }
      return t;
    }
    _error(genome) { return this._errorOf(genome.shapes); }

    // Render the affected box from the FULL genome at absolute coords (drawing
    // only shapes whose bbox intersects the box; others contribute nothing
    // there). No clip is used, so box pixels are bit-identical to a full render.
    _renderBox(shapes, bx0, by0, bw, bh) {
      const ctx = this.ectx, w = this.w, h = this.h;
      ctx.clearRect(bx0, by0, bw, bh);
      ctx.fillStyle = '#000';
      ctx.fillRect(bx0, by0, bw, bh);
      const px0 = bx0 - 1, py0 = by0 - 1, px1 = bx0 + bw + 1, py1 = by0 + bh + 1;
      for (let i = 0; i < shapes.length; i++) {
        const s = shapes[i], bb = shapeBBox(s);
        if (bb.x1 * w < px0 || bb.x0 * w > px1 || bb.y1 * h < py0 || bb.y0 * h > py1) continue;
        drawShape(ctx, w, h, s);
      }
    }

    // Incremental evaluation of a candidate whose change is bounded by `boxN`
    // (normalized). Returns { total, kind:'box', bx0,by0,bw,bh } or null to
    // signal the caller should fall back to a full rescore.
    _evalBox(shapes, boxN) {
      const w = this.w, h = this.h;
      let bx0 = (Math.floor(boxN.x0 * w) - 1) | 0;
      let by0 = (Math.floor(boxN.y0 * h) - 1) | 0;
      let bx1 = (Math.ceil(boxN.x1 * w) + 1) | 0;
      let by1 = (Math.ceil(boxN.y1 * h) + 1) | 0;
      if (bx0 < 0) bx0 = 0; if (by0 < 0) by0 = 0;
      if (bx1 > w) bx1 = w; if (by1 > h) by1 = h;
      const bw = bx1 - bx0, bh = by1 - by0;
      if (bw <= 0 || bh <= 0) return { total: this.bestError, kind: 'noop' };
      if (bw * bh >= BOX_FULL_FRAC * w * h) return null; // not worth localizing
      this._renderBox(shapes, bx0, by0, bw, bh);
      const cur = this.ectx.getImageData(bx0, by0, bw, bh).data;
      const tgt = this.target.data, arr = this._bestErrArr, buf = this._boxBuf, wArr = this._wArr;
      let oldB = 0, newB = 0, bi = 0;
      for (let yy = 0; yy < bh; yy++) {
        const trow = (by0 + yy) * w;
        for (let xx = 0; xx < bw; xx++) {
          const tx = bx0 + xx, idx = trow + tx;
          const ti = idx * 4, ci = bi * 4;
          const dr = cur[ci] - tgt[ti], dg = cur[ci + 1] - tgt[ti + 1], db = cur[ci + 2] - tgt[ti + 2];
          const e = wArr[idx] * (LUMA_R * dr * dr + LUMA_G * dg * dg + LUMA_B * db * db);
          buf[bi] = e; newB += e; oldB += arr[idx]; bi++;
        }
      }
      return { total: this.bestError - oldB + newB, kind: 'box', bx0, by0, bw, bh };
    }

    _evalFull(shapes) {
      const w = this.w, h = this.h, ctx = this.ectx;
      renderGenome(ctx, w, h, { shapes });
      const cur = ctx.getImageData(0, 0, w, h).data, tgt = this.target.data, buf = this._fullBuf, wArr = this._wArr;
      let total = 0;
      for (let p = 0, i = 0; i < cur.length; i += 4, p++) {
        const dr = cur[i] - tgt[i], dg = cur[i + 1] - tgt[i + 1], db = cur[i + 2] - tgt[i + 2];
        const e = wArr[p] * (LUMA_R * dr * dr + LUMA_G * dg * dg + LUMA_B * db * db);
        buf[p] = e; total += e;
      }
      return { total, kind: 'full' };
    }

    // Commit an accepted evaluation into the per-pixel error cache + total.
    _commit(ev) {
      const arr = this._bestErrArr, w = this.w;
      if (ev.kind === 'box') {
        const buf = this._boxBuf; let bi = 0;
        for (let yy = 0; yy < ev.bh; yy++) {
          const base = (ev.by0 + yy) * w + ev.bx0;
          for (let xx = 0; xx < ev.bw; xx++) arr[base + xx] = buf[bi++];
        }
      } else if (ev.kind === 'full') {
        const buf = this._fullBuf, n = this.w * this.h;
        for (let p = 0; p < n; p++) arr[p] = buf[p];
      }
      this.bestError = ev.total;
    }

    // Error map is derived from the cached per-pixel error (no render).
    _computeErrorMap() {
      const G = this.GRID, w = this.w, h = this.h, arr = this._bestErrArr;
      const map = this._errMap; map.fill(0);
      for (let y = 0; y < h; y++) {
        const gy = (y * G / h) | 0, row = y * w;
        for (let x = 0; x < w; x++) map[gy * G + ((x * G / w) | 0)] += arr[row + x];
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
      return { x: (gx + Math.random()) / G, y: (gy + Math.random()) / G, size: cell * (0.6 + hot * 0.5) };
    }

    matchPct(sse) { return Math.max(0, 1 - sse / this.baselineError) * 100; }

    // Monotonic display value: a running max of the raw current-scale match, so
    // a resolution step-up (metric change) never reads as a regression.
    get bestMatch() {
      // Progress made AT THE CURRENT SCALE, added on top of the display value
      // locked in from coarser scales. This unfreezes real fine-scale gains that
      // score below a blurry coarse peak, while never letting the number drop.
      const disp = this._dispAnchor + (this.matchPct(this.bestError) - this._rawAnchor);
      if (disp > this._maxMatch) this._maxMatch = disp;
      return Math.min(this._maxMatch, 99.9);
    }
    get shapeCount() { return this.best.shapes.length; }
    get effectiveMutation() { return this._effAmt; }
    get scaleLevel() { return this.w; }

    draw(ctx, w, h) { renderGenome(ctx, w, h, this.best); }

    // Propose one mutation of the current best (genome + affected box).
    _propose() { return proposeMutation(this.best, this.cfg, this._hotspot, this._effAmt); }

    _stepUpScale() {
      if (this._scaleIdx >= this._scales.length - 1) return;
      this._scaleIdx++;
      this._applyScaleTarget(this._scaleIdx);
      this._fullRescore();          // exact cache rebuild at the new scale
      this._computeErrorMap();
      this._scaleStartAtt = this.attempts;
      // Carry the achieved display forward, then measure the new (harder) scale's
      // progress relative to its own starting point. bestMatch stays continuous at
      // the step-up (disp == _maxMatch) and climbs as fine detail resolves.
      this._dispAnchor = this._maxMatch;
      this._rawAnchor = this.matchPct(this.bestError);
    }

    // Re-heat the effective mutation size back to the ceiling and restart the
    // annealing window, so a stalled run can make the big moves needed to fix
    // hard edges. Proposal-only -> monotonicity is unaffected.
    _reheat() {
      this._effAmt = this.cfg.mutationAmount;
      this._winAtt = 0; this._winAcc = 0;
      this._reheats++;
    }

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
        s.a = 0; // invisible -> error unchanged -> monotonic
        shapes.push(s);
      }
      this.best = { shapes };
    }

    step(nAttempts) {
      let improved = false;
      const fast = this.cfg.fastEval !== false;
      for (let i = 0; i < nAttempts; i++) {
        const prop = this._propose();
        let ev = fast ? this._evalBox(prop.genome.shapes, prop.box) : null;
        if (!ev) ev = this._evalFull(prop.genome.shapes);
        this.attempts++;
        this._winAtt++;
        if (ev.total < this.bestError) {
          this.best = prop.genome;
          this._commit(ev);
          this.improvements++;
          this._winAcc++;
          this._lastImpAtt = this.attempts;
          this._reheatCount = 0; // escaped the stall
          improved = true;
        }
        // 1/5-success-rule annealing (slider is the ceiling)
        if (this._winAtt >= ANNEAL_WINDOW) {
          const rate = this._winAcc / this._winAtt;
          const ceil = this.cfg.mutationAmount;
          const floor = Math.max(0.01, ceil * 0.08);
          if (rate > 0.2) this._effAmt = Math.min(ceil, this._effAmt * 1.3);
          else this._effAmt = Math.max(floor, this._effAmt * 0.85);
          this._winAtt = 0; this._winAcc = 0;
        }
        // On stall (or a scale running too long): step up resolution first; then
        // at the finest scale, RE-HEAT the mutation size to escape a local optimum
        // (its big moves fix hard edges); if a re-heat cycle still stalls, add
        // shape capacity. All of these are proposal-only -> Match% stays monotonic.
        const stalled = this.attempts - this._lastImpAtt >= STALL_ATTEMPTS;
        const aged = this.attempts - this._scaleStartAtt >= SCALE_MAX_ATT;
        if (this._scaleIdx < this._scales.length - 1 && (stalled || aged)) {
          this._stepUpScale();
          this._reheatCount = 0;
          this._lastImpAtt = this.attempts;
        } else if (stalled) {
          const canGrow = this.best.shapes.length < this.cfg.maxShapes;
          if (this.cfg.reheat !== false && this._reheatCount < REHEAT_BEFORE_GROW) {
            this._reheat();
            this._reheatCount++;
          } else if (canGrow) {
            this._growBatch();
            this._reheatCount = 0;
          } else if (this.cfg.reheat !== false) {
            this._reheat(); // maxed out on shapes: keep re-heating, never give up
          }
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

    // ---- progress-preserving settings changes ----
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
          s.a = 0;
          shapes.push(s);
        }
        this.best = { shapes };
      } else if (shapes.length > n) {
        const impact = (s) => s.a * (s.type === 'ellipse'
          ? Math.max(1e-4, s.rx * s.ry) : Math.max(1e-4, polyArea(s)));
        const order = shapes.map((_, i) => i).sort((a, b) => impact(shapes[a]) - impact(shapes[b]));
        const removed = new Set();
        for (const i of order) {
          if (shapes.length - removed.size <= n) break;
          const trial = shapes.filter((_, j) => j !== i && !removed.has(j));
          const e = this._errorOf(trial);
          if (e <= this.bestError + 1e-9) { removed.add(i); this.bestError = e; }
        }
        this.best = { shapes: shapes.filter((_, j) => !removed.has(j)) };
      }
      this._fullRescore();          // exact cache resync (<= previous error)
      this._computeErrorMap();
      this._lastMapImp = this.improvements;
    }

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

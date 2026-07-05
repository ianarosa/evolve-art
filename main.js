/* ============================================================
   main.js — "Evolve a Picture" UI + orchestration.
   The evolution core lives in art.js and runs either in a Web Worker
   (WorkerDriver) or on the main thread (MainDriver fallback). Both
   drivers share art.js and expose the same interface, so all the UI /
   readout / export code below is driver-agnostic.
   ============================================================ */
(function () {
  'use strict';

  const EVAL = 200;        // fitness is measured on a 200x200 downscaled copy (captures edges/eyes)
  const EXPORT_LONG = 1100; // high-res PNG long side

  // ---------------- config (single source of truth) ----------------
  const cfg = {
    numShapes: 90,         // modest default; the engine grows on stall (benchmark: 50≈100≈200 at equal attempts)
    shapeKind: 'mixed',    // 'tri' | 'poly' | 'ellipse' | 'mixed'
    vertices: 3,           // used by 'tri'(3) / 'poly'(6)
    mutationAmount: 0.18,  // CEILING for the auto-annealer (starts here, shrinks as it converges)
    speed: 60,             // mutation attempts per frame/tick
    seed: false,           // start from true noise; the "Smart start" toggle enables the seeded head-start
    minShapes: 36,
    maxShapes: 198         // grow-on-stall cap (~200 for crisp features)
  };
  function applyShapeBounds() {
    // Cap ~200 so grow-on-stall has room to add crisp detail (Pass 3).
    cfg.maxShapes = Math.min(240, Math.round(cfg.numShapes * 2.2));
    cfg.minShapes = Math.max(3, Math.round(cfg.numShapes * 0.4));
  }
  function cfgCopy() { return JSON.parse(JSON.stringify(cfg)); }

  // ---------------- built-in procedural targets ----------------
  function drawSmiley(ctx, w, h) {
    ctx.fillStyle = '#2b3450'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffd34d';
    ctx.beginPath(); ctx.arc(w * 0.5, h * 0.5, w * 0.36, 0, 7); ctx.fill();
    ctx.fillStyle = '#20242e';
    ctx.beginPath(); ctx.arc(w * 0.38, h * 0.42, w * 0.05, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(w * 0.62, h * 0.42, w * 0.05, 0, 7); ctx.fill();
    ctx.strokeStyle = '#20242e'; ctx.lineWidth = w * 0.05; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(w * 0.5, h * 0.52, w * 0.20, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  }
  function drawHeart(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2a1030'); g.addColorStop(1, '#120a1e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const cx = w * 0.5, cy = h * 0.46, s = w * 0.30;
    ctx.fillStyle = '#ff3b6b';
    ctx.beginPath();
    ctx.moveTo(cx, cy + s * 0.95);
    ctx.bezierCurveTo(cx + s * 1.35, cy - s * 0.35, cx + s * 0.45, cy - s * 1.15, cx, cy - s * 0.25);
    ctx.bezierCurveTo(cx - s * 0.45, cy - s * 1.15, cx - s * 1.35, cy - s * 0.35, cx, cy + s * 0.95);
    ctx.fill();
  }
  function drawSunset(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2a1a5e'); g.addColorStop(0.45, '#ff6b6b');
    g.addColorStop(0.7, '#ffb15e'); g.addColorStop(1, '#ffe08a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff2c2';
    ctx.beginPath(); ctx.arc(w * 0.5, h * 0.6, w * 0.16, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(38,18,66,0.55)';
    ctx.fillRect(0, h * 0.72, w, h * 0.28);
  }
  function drawComposition(ctx, w, h) {
    ctx.fillStyle = '#12161f'; ctx.fillRect(0, 0, w, h);
    const blobs = [
      ['#ef4444', 0.32, 0.36, 0.22], ['#3b82f6', 0.64, 0.40, 0.24],
      ['#22c55e', 0.44, 0.66, 0.26], ['#f59e0b', 0.68, 0.68, 0.15]
    ];
    ctx.globalAlpha = 0.85;
    for (const [c, x, y, r] of blobs) {
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(w * x, h * y, w * r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  const TARGETS = [
    { key: 'smiley', label: '🙂 Smiley', draw: drawSmiley },
    { key: 'heart',  label: '❤️ Heart',  draw: drawHeart },
    { key: 'sunset', label: '🌅 Sunset', draw: drawSunset },
    { key: 'shapes', label: '🎯 Shapes', draw: drawComposition }
  ];

  // ---------------- DOM ----------------
  const $ = (id) => document.getElementById(id);
  const targetCanvas = $('target');
  const evolveCanvas = $('evolve');
  const tctx = targetCanvas.getContext('2d');
  const vctx = evolveCanvas.getContext('2d');
  const chart = $('chart');
  const cctx = chart.getContext('2d');

  const el = {
    play: $('playBtn'), reset: $('resetBtn'), save: $('saveBtn'),
    roMatch: $('roMatch'), roAttempts: $('roAttempts'), roImprove: $('roImprove'),
    roShapes: $('roShapes'), roRate: $('roRate'),
    status: $('status'), statusText: $('statusText'),
    targetGrid: $('targetGrid'), uploadBtn: $('uploadBtn'), fileInput: $('fileInput'),
    numShapes: $('numShapes'), shapesVal: $('shapesVal'),
    shapeStyle: $('shapeStyle'),
    mutAmount: $('mutAmount'), mutVal: $('mutVal'),
    speed: $('speed'), speedVal: $('speedVal'),
    seedToggle: $('seedToggle'),
    intro: $('intro'), introClose: $('introClose'), helpBtn: $('helpBtn')
  };

  // ---------------- state ----------------
  let currentTargetDraw = TARGETS[0].draw;
  let targetData = null;               // { data, w, h }
  let running = true;
  let version = 0;                     // bumped ONLY on reset / target change (full wipes)
  let latestStats = { match: 0, attempts: 0, improvements: 0, shapes: 0 };
  let matchHistory = [];
  let lastImprovements = -1;
  let rate = 0, rateT = 0, rateAttempts = 0;

  const sampler = document.createElement('canvas');
  sampler.width = EVAL; sampler.height = EVAL;
  const sctx = sampler.getContext('2d', { willReadFrequently: true });

  function bumpVersion() { return ++version; }
  function renderSize() { return evolveCanvas.width || 320; }

  // ==================================================================
  //  DRIVERS  (both expose: init/setTarget/setShapeCount/setStyle/reset/
  //  setConfig/setPlaying/setRenderSize/paintInto/getStats/requestGenome
  //  + onframe). Progress-preserving ops (setShapeCount/setStyle) keep the
  //  version; only reset/setTarget bump it so stale frames are discarded.
  // ==================================================================

  // ---- main-thread fallback ----
  function MainDriver() {
    this.evolver = null; this.target = null; this.cfg = null;
    this.running = false; this.onframe = null; this._raf = null;
    const self = this;
    this._loop = function () {
      if (self.running && self.evolver) {
        const imp = self.evolver.step(self.cfg.speed);
        if (self.onframe) self.onframe(imp);
      } else if (self.onframe) {
        self.onframe(false);
      }
      self._raf = requestAnimationFrame(self._loop);
    };
  }
  MainDriver.prototype.init = function (target, config, _rs, run) {
    this.target = target; this.cfg = config; this.running = run;
    this.evolver = new window.Art.ArtEvolver(target, config);
    if (!this._raf) this._raf = requestAnimationFrame(this._loop);
  };
  MainDriver.prototype.setTarget = function (target) {
    this.target = target;
    this.evolver = new window.Art.ArtEvolver(target, this.cfg);
  };
  MainDriver.prototype.setShapeCount = function (config) {
    this.cfg.numShapes = config.numShapes;
    this.cfg.minShapes = config.minShapes;
    this.cfg.maxShapes = config.maxShapes;
    this.evolver.setShapeCount(config.numShapes, config.minShapes, config.maxShapes);
  };
  MainDriver.prototype.setStyle = function (config) {
    this.cfg.shapeKind = config.shapeKind;
    this.cfg.vertices = config.vertices;
    this.evolver.setStyle(config.shapeKind, config.vertices);
  };
  MainDriver.prototype.reset = function () { this.evolver.reset(); };
  MainDriver.prototype.setConfig = function (config) {
    this.cfg.mutationAmount = config.mutationAmount;
    this.cfg.speed = config.speed;
    this.cfg.seed = config.seed;                 // so a subsequent reset() honours the Smart-start toggle
    if (this.evolver) this.evolver.cfg.seed = config.seed;
  };
  MainDriver.prototype.setPlaying = function (on) { this.running = on; };
  MainDriver.prototype.setRenderSize = function () { /* draws vector at display size */ };
  MainDriver.prototype.paintInto = function (ctx, w, h) { if (this.evolver) this.evolver.draw(ctx, w, h); };
  MainDriver.prototype.getStats = function () {
    const e = this.evolver;
    return { match: e.bestMatch, attempts: e.attempts, improvements: e.improvements, shapes: e.shapeCount };
  };
  MainDriver.prototype.requestGenome = function (cb) { cb(this.evolver.best, this.target.w, this.target.h); };

  // ---- Web Worker driver ----
  function WorkerDriver(worker) {
    this.w = worker;
    this.stats = { match: 0, attempts: 0, improvements: 0, shapes: 0 };
    this.bitmap = null;
    this.onframe = null;
    this._reqId = 0;
    this._reqs = {};
    const self = this;
    this.w.onmessage = function (e) { self._recv(e.data); };
    this.w.onerror = function (err) { console.error('worker error', err.message || err); };
  }
  WorkerDriver.prototype._recv = function (m) {
    if (m.type === 'genome') {
      const cb = this._reqs[m.reqId];
      if (cb) { delete this._reqs[m.reqId]; cb(m.genome, m.w, m.h); }
      return;
    }
    if (m.version !== version) {           // stale (a reset/target-change superseded it)
      if (m.bitmap) m.bitmap.close();
      return;
    }
    if (m.type === 'frame') {
      if (this.bitmap) this.bitmap.close();
      this.bitmap = m.bitmap;
    }
    this.stats = { match: m.match, attempts: m.attempts, improvements: m.improvements, shapes: m.shapes };
    if (this.onframe) this.onframe(m.type === 'frame');
  };
  // NOTE: target buffers are cloned (not transferred) so the main thread keeps its copy.
  WorkerDriver.prototype.init = function (target, config, rs, run) {
    this.w.postMessage({ type: 'init', target: target, cfg: config, renderSize: rs, version: version, running: run });
  };
  WorkerDriver.prototype.setTarget = function (target) {
    // carry the authoritative play state so the worker can't keep stepping a paused run
    this.w.postMessage({ type: 'setTarget', target: target, version: version, running: running });
  };
  WorkerDriver.prototype.setShapeCount = function (config) {
    // same version on purpose: this preserves the genome, so in-flight frames stay valid
    this.w.postMessage({ type: 'setShapeCount', n: config.numShapes, minShapes: config.minShapes, maxShapes: config.maxShapes });
  };
  WorkerDriver.prototype.setStyle = function (config) {
    this.w.postMessage({ type: 'setStyle', shapeKind: config.shapeKind, vertices: config.vertices });
  };
  WorkerDriver.prototype.reset = function () {
    // carry the authoritative play state: a Reset while paused must STAY paused
    this.w.postMessage({ type: 'reset', version: version, running: running });
  };
  WorkerDriver.prototype.setConfig = function (config) {
    this.w.postMessage({ type: 'config', cfg: { mutationAmount: config.mutationAmount, speed: config.speed, seed: config.seed } });
  };
  WorkerDriver.prototype.setPlaying = function (on) { this.w.postMessage({ type: 'play', running: on }); };
  WorkerDriver.prototype.setRenderSize = function (size) { this.w.postMessage({ type: 'renderSize', size: size }); };
  WorkerDriver.prototype.paintInto = function (ctx, w, h) {
    if (this.bitmap) ctx.drawImage(this.bitmap, 0, 0, w, h);
  };
  WorkerDriver.prototype.getStats = function () { return this.stats; };
  WorkerDriver.prototype.requestGenome = function (cb) {
    const id = ++this._reqId;
    this._reqs[id] = cb;
    this.w.postMessage({ type: 'requestGenome', reqId: id });
  };

  // ---------------- pick a driver (feature-detect + fallback) ----------------
  function detectWorker() {
    try {
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
      if (location.protocol === 'file:') return false; // workers are blocked on file:// in most browsers
      const oc = new OffscreenCanvas(2, 2);
      if (!oc.getContext('2d')) return false;
      if (typeof oc.transferToImageBitmap !== 'function') return false;
      return true;
    } catch (e) { return false; }
  }

  let driver, usingWorker = false;
  if (detectWorker()) {
    try { driver = new WorkerDriver(new Worker('worker.js')); usingWorker = true; }
    catch (e) { driver = new MainDriver(); usingWorker = false; }
  } else {
    driver = new MainDriver();
  }
  driver.onframe = onEngineUpdate;

  // ==================================================================
  //  UI: targets, rendering, readouts
  // ==================================================================
  function buildTargetData() {
    sctx.clearRect(0, 0, EVAL, EVAL);
    currentTargetDraw(sctx, EVAL, EVAL);
    const img = sctx.getImageData(0, 0, EVAL, EVAL);
    // Worker path clones the buffer; keep our own copy intact either way.
    targetData = { data: img.data, w: EVAL, h: EVAL };
  }
  function targetForDriver() {
    // fresh copy so a transfer/clone can never disturb our master copy
    return { data: new Uint8ClampedArray(targetData.data), w: targetData.w, h: targetData.h };
  }

  function renderTarget() {
    tctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    currentTargetDraw(tctx, targetCanvas.width, targetCanvas.height);
  }
  function paintEvolve() {
    driver.paintInto(vctx, evolveCanvas.width, evolveCanvas.height);
  }

  function changeTarget(drawFn) {
    currentTargetDraw = drawFn;
    buildTargetData();
    renderTarget();
    matchHistory = []; lastImprovements = -1;
    bumpVersion();
    driver.setTarget(targetForDriver());
  }

  function drawChart() {
    const dpr = window.devicePixelRatio || 1;
    const W = chart.clientWidth, Hc = chart.clientHeight;
    if (chart.width !== Math.round(W * dpr) || chart.height !== Math.round(Hc * dpr)) {
      chart.width = Math.round(W * dpr); chart.height = Math.round(Hc * dpr);
    }
    const w = chart.width, h = chart.height;
    cctx.clearRect(0, 0, w, h);
    const n = matchHistory.length;
    if (n < 2) return;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = matchHistory[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 0.5) { hi += 0.5; lo -= 0.5; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const pL = 4, pR = 4, pT = 6, pB = 6;
    const plotW = w - pL - pR, plotH = h - pT - pB;
    cctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = pL + (i / (n - 1)) * plotW;
      const py = pT + (1 - (matchHistory[i] - lo) / (hi - lo)) * plotH;
      if (i === 0) cctx.moveTo(px, py); else cctx.lineTo(px, py);
    }
    cctx.strokeStyle = '#22d3ee';
    cctx.lineWidth = 1.8 * dpr;
    cctx.lineJoin = 'round';
    cctx.stroke();
  }

  function renderReadouts(s) {
    el.roMatch.textContent = s.match.toFixed(1) + '%';
    el.roAttempts.textContent = s.attempts.toLocaleString();
    el.roImprove.textContent = s.improvements.toLocaleString();
    el.roShapes.textContent = s.shapes;
    el.roRate.textContent = rate.toLocaleString() + '/s';
    updateStatus(s.match);
  }
  function updateStatus(m) {
    let cls, text;
    if (latestStats.attempts < 80) {
      cls = 'explore'; text = '🎨 Starting from random shapes…';
    } else if (m < 92) {
      cls = 'climb'; text = '📈 Refining — the picture is taking shape (' + m.toFixed(1) + '% match).';
    } else {
      cls = 'solved'; text = '✨ Looking sharp! (' + m.toFixed(1) + '% match)';
    }
    if (el.status.dataset.cls !== cls) { el.status.className = 'status ' + cls; el.status.dataset.cls = cls; }
    el.statusText.textContent = text;
  }

  // Single update entry point used by BOTH drivers.
  function onEngineUpdate(hasFrame) {
    const s = driver.getStats();
    latestStats = s;
    if (hasFrame) paintEvolve();
    if (s.improvements > lastImprovements) {
      lastImprovements = s.improvements;
      matchHistory.push(s.match);
      if (matchHistory.length > 600) matchHistory.shift();
      drawChart();
    }
    const t = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (!rateT) { rateT = t; rateAttempts = s.attempts; }
    if (t - rateT >= 500) {
      rate = Math.round((s.attempts - rateAttempts) * 1000 / (t - rateT));
      rateAttempts = s.attempts; rateT = t;
    }
    renderReadouts(s);
  }

  // ---------------- PNG export (high-res, off the downscaled display) ----------------
  function exportPNG() {
    driver.requestGenome(function (genome, tw, th) {
      const ar = tw / th;
      let ew, eh;
      if (ar >= 1) { ew = EXPORT_LONG; eh = Math.round(EXPORT_LONG / ar); }
      else { eh = EXPORT_LONG; ew = Math.round(EXPORT_LONG * ar); }
      let oc;
      if (typeof OffscreenCanvas !== 'undefined') oc = new OffscreenCanvas(ew, eh);
      else { oc = document.createElement('canvas'); oc.width = ew; oc.height = eh; }
      const octx = oc.getContext('2d');
      window.Art.renderGenome(octx, ew, eh, genome);
      const pct = Math.round(latestStats.match);
      const finish = function (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'evolve-art-' + pct + 'pct.png';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      };
      if (oc.convertToBlob) oc.convertToBlob({ type: 'image/png' }).then(finish);
      else oc.toBlob(finish, 'image/png');
    });
  }

  // ---------------- resize ----------------
  function resize() {
    const boards = $('boards');
    const dpr = window.devicePixelRatio || 1;
    const stacked = window.matchMedia('(max-width: 820px)').matches;
    const gap = 16;
    let size;
    if (stacked) size = Math.min(boards.clientWidth, 420);
    else size = Math.min((boards.clientWidth - gap) / 2, $('stage').clientHeight - 70);
    size = Math.max(120, Math.floor(size));
    for (const c of [targetCanvas, evolveCanvas]) {
      c.style.width = size + 'px'; c.style.height = size + 'px';
      c.width = Math.round(size * dpr); c.height = Math.round(size * dpr);
    }
    renderTarget();
    driver.setRenderSize(renderSize());
    paintEvolve();
  }
  window.addEventListener('resize', resize);

  // ---------------- controls ----------------
  function setRunning(on) {
    running = on;
    el.play.textContent = on ? '⏸ Pause' : '▶ Play';
    el.play.classList.toggle('running', on);
    driver.setPlaying(on);
  }
  el.play.addEventListener('click', () => setRunning(!running));
  el.reset.addEventListener('click', () => {
    matchHistory = []; lastImprovements = -1;
    bumpVersion();
    driver.reset();
  });
  el.save.addEventListener('click', exportPNG);

  const targetButtons = {};
  TARGETS.forEach((tgt) => {
    const b = document.createElement('button');
    b.className = 'target-btn';
    b.textContent = tgt.label;
    b.addEventListener('click', () => { selectTargetButton(tgt.key); changeTarget(tgt.draw); });
    el.targetGrid.appendChild(b);
    targetButtons[tgt.key] = b;
  });
  function selectTargetButton(key) {
    Object.keys(targetButtons).forEach((k) => targetButtons[k].classList.toggle('active', k === key));
  }

  el.uploadBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { selectTargetButton('__upload'); changeTarget(coverDrawer(img)); URL.revokeObjectURL(url); };
    img.onerror = () => { URL.revokeObjectURL(url); };
    img.src = url;
  });
  function coverDrawer(img) {
    return function (ctx, w, h) {
      const ir = img.width / img.height;
      let dw, dh;
      if (ir > w / h) { dh = h; dw = h * ir; } else { dw = w; dh = w / ir; }
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    };
  }

  el.numShapes.addEventListener('input', () => { el.shapesVal.textContent = el.numShapes.value; });
  el.numShapes.addEventListener('change', () => {
    // progress-preserving: grow/shrink the current genome, keep history + version
    cfg.numShapes = parseInt(el.numShapes.value, 10);
    applyShapeBounds();
    driver.setShapeCount(cfgCopy());
    paintEvolve();
  });
  el.shapeStyle.addEventListener('change', () => {
    // progress-preserving: existing shapes stay; only new shapes adopt the style
    const v = el.shapeStyle.value;
    cfg.shapeKind = v;
    cfg.vertices = v === 'poly' ? 6 : 3;
    driver.setStyle(cfgCopy());
  });
  el.mutAmount.addEventListener('input', () => {
    cfg.mutationAmount = parseFloat(el.mutAmount.value);
    el.mutVal.textContent = cfg.mutationAmount.toFixed(2);
    driver.setConfig(cfgCopy());
  });
  el.speed.addEventListener('input', () => {
    cfg.speed = parseInt(el.speed.value, 10);
    el.speedVal.textContent = cfg.speed;
    driver.setConfig(cfgCopy());
  });
  el.seedToggle.addEventListener('change', () => {
    // Switching the start mode changes how the first genome is built, so the run
    // must restart — same side-effects as the Reset button.
    cfg.seed = el.seedToggle.checked;
    driver.setConfig(cfgCopy());   // push new seed flag to worker/evolver
    matchHistory = []; lastImprovements = -1;
    bumpVersion();
    driver.reset();
  });

  // ---------------- intro overlay ----------------
  function showIntro(on) { el.intro.hidden = !on; }
  let seenIntro = false;
  try { seenIntro = localStorage.getItem('art_seen_intro') === '1'; } catch (e) { /* private mode */ }
  showIntro(!seenIntro);
  el.introClose.addEventListener('click', () => {
    showIntro(false);
    try { localStorage.setItem('art_seen_intro', '1'); } catch (e) { /* ignore */ }
  });
  el.helpBtn.addEventListener('click', () => showIntro(true));

  // ---------------- boot ----------------
  applyShapeBounds();
  resize();
  selectTargetButton(TARGETS[0].key);
  buildTargetData();
  renderTarget();
  el.seedToggle.checked = cfg.seed;   // reflect the default start mode (noise = unchecked)
  driver.init(targetForDriver(), cfgCopy(), renderSize(), running);
  setRunning(true);
})();

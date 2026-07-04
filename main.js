/* ============================================================
   main.js — "Evolve a Picture" wiring: targets, controls, loop.
   Depends on window.Art (art.js).
   ============================================================ */
(function () {
  'use strict';

  const EVAL = 128; // fitness is measured on a 128x128 downscaled copy

  // ---------------- config (single source of truth) ----------------
  const cfg = {
    numShapes: 60,
    vertices: 3,
    mutationAmount: 0.08,
    speed: 60,          // mutation attempts per animation frame
    minShapes: 24,
    maxShapes: 84
  };
  function applyShapeBounds() {
    cfg.maxShapes = Math.min(240, Math.round(cfg.numShapes * 1.4));
    cfg.minShapes = Math.max(3, Math.round(cfg.numShapes * 0.4));
  }

  // ---------------- built-in procedural targets (drawn in-canvas) ----------------
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
    play: $('playBtn'), reset: $('resetBtn'),
    roMatch: $('roMatch'), roAttempts: $('roAttempts'), roImprove: $('roImprove'),
    roShapes: $('roShapes'), roRate: $('roRate'),
    status: $('status'), statusText: $('statusText'),
    targetGrid: $('targetGrid'), uploadBtn: $('uploadBtn'), fileInput: $('fileInput'),
    numShapes: $('numShapes'), shapesVal: $('shapesVal'),
    shapeStyle: $('shapeStyle'),
    mutAmount: $('mutAmount'), mutVal: $('mutVal'),
    speed: $('speed'), speedVal: $('speedVal'),
    intro: $('intro'), introClose: $('introClose'), helpBtn: $('helpBtn')
  };

  // ---------------- state ----------------
  let evolver = null;
  let currentTargetDraw = TARGETS[0].draw; // drawFn(ctx, w, h)
  let targetData = null;                    // { data, w, h }
  let running = false;
  let lastImprovements = -1;

  // offscreen used to sample the target at eval resolution
  const sampler = document.createElement('canvas');
  sampler.width = EVAL; sampler.height = EVAL;
  const sctx = sampler.getContext('2d', { willReadFrequently: true });

  // ---------------- target handling ----------------
  function buildTargetData() {
    sctx.clearRect(0, 0, EVAL, EVAL);
    currentTargetDraw(sctx, EVAL, EVAL);
    const img = sctx.getImageData(0, 0, EVAL, EVAL);
    targetData = { data: img.data, w: EVAL, h: EVAL };
  }

  function setTarget(drawFn) {
    currentTargetDraw = drawFn;
    buildTargetData();
    evolver = new window.Art.ArtEvolver(targetData, cfg);
    lastImprovements = -1;
    renderTarget();
    renderEvolve();
    updateReadouts(true);
  }

  function rebuildEvolver() {
    if (!targetData) return;
    evolver = new window.Art.ArtEvolver(targetData, cfg);
    lastImprovements = -1;
    renderEvolve();
    updateReadouts(true);
  }

  // ---------------- rendering ----------------
  function renderTarget() {
    tctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    currentTargetDraw(tctx, targetCanvas.width, targetCanvas.height);
  }
  function renderEvolve() {
    if (evolver) evolver.draw(vctx, evolveCanvas.width, evolveCanvas.height);
  }

  function drawChart() {
    const dpr = window.devicePixelRatio || 1;
    const W = chart.clientWidth, Hc = chart.clientHeight;
    if (chart.width !== Math.round(W * dpr) || chart.height !== Math.round(Hc * dpr)) {
      chart.width = Math.round(W * dpr);
      chart.height = Math.round(Hc * dpr);
    }
    const w = chart.width, h = chart.height;
    cctx.clearRect(0, 0, w, h);
    const hist = evolver ? evolver.history : [];
    const n = hist.length;
    if (n < 2) return;

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = hist[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 0.5) { hi += 0.5; lo -= 0.5; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;

    const pL = 4, pR = 4, pT = 6, pB = 6;
    const plotW = w - pL - pR, plotH = h - pT - pB;
    cctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = pL + (i / (n - 1)) * plotW;
      const py = pT + (1 - (hist[i] - lo) / (hi - lo)) * plotH;
      if (i === 0) cctx.moveTo(px, py); else cctx.lineTo(px, py);
    }
    cctx.strokeStyle = '#22d3ee';
    cctx.lineWidth = 1.8 * dpr;
    cctx.lineJoin = 'round';
    cctx.stroke();
  }

  // ---------------- readouts + status ----------------
  function updateReadouts(force) {
    if (!evolver) return;
    el.roMatch.textContent = evolver.bestMatch.toFixed(1) + '%';
    el.roAttempts.textContent = evolver.attempts.toLocaleString();
    el.roImprove.textContent = evolver.improvements.toLocaleString();
    el.roShapes.textContent = evolver.shapeCount;
    el.roRate.textContent = rate.toLocaleString() + '/s';

    if (force || evolver.improvements !== lastImprovements) {
      lastImprovements = evolver.improvements;
      drawChart();
    }
    updateStatus();
  }

  function updateStatus() {
    const m = evolver.bestMatch;
    let cls, text;
    if (evolver.attempts < 80) {
      cls = 'explore';
      text = '🎨 Starting from random shapes…';
    } else if (m < 92) {
      cls = 'climb';
      text = '📈 Refining — the picture is taking shape (' + m.toFixed(1) + '% match).';
    } else {
      cls = 'solved';
      text = '✨ Looking sharp! (' + m.toFixed(1) + '% match)';
    }
    if (el.status.dataset.cls !== cls) {
      el.status.className = 'status ' + cls;
      el.status.dataset.cls = cls;
    }
    el.statusText.textContent = text;
  }

  // ---------------- animation loop ----------------
  let rate = 0, rateT = 0, rateAttempts = 0;
  function frame(t) {
    if (running && evolver) {
      const improved = evolver.step(cfg.speed);
      if (improved) renderEvolve();
    }
    if (!rateT) { rateT = t; rateAttempts = evolver ? evolver.attempts : 0; }
    if (t - rateT >= 500) {
      const a = evolver ? evolver.attempts : 0;
      rate = Math.round((a - rateAttempts) * 1000 / (t - rateT));
      rateAttempts = a; rateT = t;
    }
    updateReadouts(false);
    requestAnimationFrame(frame);
  }

  // ---------------- resize (square canvases, crisp) ----------------
  function resize() {
    const boards = $('boards');
    const dpr = window.devicePixelRatio || 1;
    const stacked = window.matchMedia('(max-width: 820px)').matches;
    const gap = 16;
    let size;
    if (stacked) {
      size = Math.min(boards.clientWidth, 420);
    } else {
      const perBoard = (boards.clientWidth - gap) / 2;
      const heightCap = $('stage').clientHeight - 70;
      size = Math.min(perBoard, heightCap);
    }
    size = Math.max(120, Math.floor(size));
    for (const c of [targetCanvas, evolveCanvas]) {
      c.style.width = size + 'px';
      c.style.height = size + 'px';
      c.width = Math.round(size * dpr);
      c.height = Math.round(size * dpr);
    }
    renderTarget();
    renderEvolve();
  }
  window.addEventListener('resize', resize);

  // ---------------- controls ----------------
  function setRunning(on) {
    running = on;
    el.play.textContent = on ? '⏸ Pause' : '▶ Play';
    el.play.classList.toggle('running', on);
  }
  el.play.addEventListener('click', () => setRunning(!running));
  el.reset.addEventListener('click', () => {
    evolver.reset();
    lastImprovements = -1;
    renderEvolve();
    updateReadouts(true);
  });

  // target buttons
  const targetButtons = {};
  TARGETS.forEach((tgt) => {
    const b = document.createElement('button');
    b.className = 'target-btn';
    b.textContent = tgt.label;
    b.addEventListener('click', () => { selectTargetButton(tgt.key); setTarget(tgt.draw); });
    el.targetGrid.appendChild(b);
    targetButtons[tgt.key] = b;
  });
  function selectTargetButton(key) {
    Object.keys(targetButtons).forEach((k) => targetButtons[k].classList.toggle('active', k === key));
  }

  // upload (fully local: object URL -> Image -> draw cover)
  el.uploadBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const drawFn = coverDrawer(img);
      selectTargetButton('__upload');
      setTarget(drawFn);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); };
    img.src = url;
  });
  // draw an image "cover" (fill the square, cropping any overflow)
  function coverDrawer(img) {
    return function (ctx, w, h) {
      const ir = img.width / img.height;
      let dw, dh;
      if (ir > w / h) { dh = h; dw = h * ir; } else { dw = w; dh = w / ir; }
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    };
  }

  // sliders / selects
  el.numShapes.addEventListener('input', () => { el.shapesVal.textContent = el.numShapes.value; });
  el.numShapes.addEventListener('change', () => {
    cfg.numShapes = parseInt(el.numShapes.value, 10);
    applyShapeBounds();
    rebuildEvolver();
  });
  el.shapeStyle.addEventListener('change', () => {
    cfg.vertices = parseInt(el.shapeStyle.value, 10);
    rebuildEvolver();
  });
  el.mutAmount.addEventListener('input', () => {
    cfg.mutationAmount = parseFloat(el.mutAmount.value);
    el.mutVal.textContent = cfg.mutationAmount.toFixed(2);
  });
  el.speed.addEventListener('input', () => {
    cfg.speed = parseInt(el.speed.value, 10);
    el.speedVal.textContent = cfg.speed;
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
  setTarget(TARGETS[0].draw);
  setRunning(true); // feel alive immediately (evolves behind the intro)
  requestAnimationFrame(frame);
})();

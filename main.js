/* ============================================================
   main.js — wiring: DOM controls, rendering, animation loop.
   Depends on window.Landscapes (landscape.js) and window.GA (ga.js).
   ============================================================ */
(function () {
  'use strict';

  // ---------------- config (single source of truth) ----------------
  const cfg = {
    popSize: 150,
    mutationRate: 0.15,
    mutationSigma: 0.30,
    selection: 'tournament',
    tournamentSize: 3,
    elitism: 2,
    crossover: true,
    landscape: 'multi',
    gps: 8
  };

  // ---------------- viridis-ish colormap ----------------
  const VIRIDIS = [
    [68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]
  ];
  function colormap(t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const s = t * (VIRIDIS.length - 1);
    const i = Math.floor(s);
    const f = s - i;
    const a = VIRIDIS[i];
    const b = VIRIDIS[Math.min(i + 1, VIRIDIS.length - 1)];
    return [
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f
    ];
  }

  // ---------------- DOM ----------------
  const $ = (id) => document.getElementById(id);
  const canvas = $('landscape');
  const ctx = canvas.getContext('2d');
  const chart = $('chart');
  const cctx = chart.getContext('2d');

  const el = {
    play: $('playBtn'), step: $('stepBtn'), reset: $('resetBtn'),
    landscapeSel: $('landscapeSel'),
    popSize: $('popSize'), popVal: $('popVal'),
    mutRate: $('mutRate'), mrVal: $('mrVal'),
    mutSigma: $('mutSigma'), msVal: $('msVal'),
    selSel: $('selSel'), tournRow: $('tournRow'),
    tournSize: $('tournSize'), tsVal: $('tsVal'),
    elitism: $('elitism'), elVal: $('elVal'),
    crossover: $('crossover'),
    gps: $('gps'), gpsVal: $('gpsVal'),
    roGen: $('roGen'), roBest: $('roBest'), roMean: $('roMean'),
    roDist: $('roDist'), roDiv: $('roDiv'),
    divBar: $('divBar'), divHint: $('divHint'),
    status: $('status'), statusText: $('statusText'),
    intro: $('intro'), introClose: $('introClose'), helpBtn: $('helpBtn')
  };

  // ---------------- state ----------------
  let ga = null;
  let landscape = null;
  let heightmap = null;     // offscreen canvas with the colored field
  let maxSpread = 1;        // normalizer for the diversity meter
  let running = false;

  // ---------------- landscape select population ----------------
  Object.keys(window.Landscapes).forEach((key) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = window.Landscapes[key].label;
    if (key === cfg.landscape) opt.selected = true;
    el.landscapeSel.appendChild(opt);
  });

  // Build the cached heightmap for a landscape at fixed internal resolution;
  // it is upscaled (smoothed) onto the main canvas each frame.
  function buildHeightmap(ls) {
    const S = 256;
    const off = document.createElement('canvas');
    off.width = S; off.height = S;
    const octx = off.getContext('2d');
    const img = octx.createImageData(S, S);
    const d = img.data;
    const { min, max } = ls.domain;
    const span = (ls.fmax - ls.fmin) || 1;
    for (let j = 0; j < S; j++) {
      const y = min + ((S - 1 - j) / (S - 1)) * (max - min); // top row = high y
      for (let i = 0; i < S; i++) {
        const x = min + (i / (S - 1)) * (max - min);
        const v = (ls.f(x, y) - ls.fmin) / span;
        const c = colormap(v);
        const k = (j * S + i) * 4;
        d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return off;
  }

  function rebuild() {
    landscape = window.Landscapes[cfg.landscape];
    heightmap = buildHeightmap(landscape);
    const range = landscape.domain.max - landscape.domain.min;
    // Max spread of a uniform cloud over the square ~ range/sqrt(6).
    maxSpread = range / Math.sqrt(6);
    ga = new window.GA(landscape, cfg);
    render();
    updateReadouts();
  }

  // ---------------- coordinate transforms (device px) ----------------
  function toPx(x) {
    const { min, max } = landscape.domain;
    return ((x - min) / (max - min)) * canvas.width;
  }
  function toPy(y) {
    const { min, max } = landscape.domain;
    return canvas.height - ((y - min) / (max - min)) * canvas.height;
  }

  // ---------------- rendering ----------------
  function render() {
    const W = canvas.width, H = canvas.height;
    const dpr = W / (canvas.clientWidth || 1);

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(heightmap, 0, 0, W, H);

    // population dots
    const r = Math.max(1.5, 2.4 * dpr);
    ctx.lineWidth = Math.max(0.5, dpr * 0.6);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.fillStyle = 'rgba(244,246,251,0.82)';
    const pop = ga.pop;
    for (let i = 0; i < pop.length; i++) {
      const px = toPx(pop[i].x), py = toPy(pop[i].y);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // global optimum marker (rose crosshair + ring)
    const ox = toPx(landscape.optimum.x), oy = toPy(landscape.optimum.y);
    const R = 9 * dpr;
    ctx.strokeStyle = '#ff4d6d';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.arc(ox, oy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox - R - 3 * dpr, oy); ctx.lineTo(ox + R + 3 * dpr, oy);
    ctx.moveTo(ox, oy - R - 3 * dpr); ctx.lineTo(ox, oy + R + 3 * dpr);
    ctx.stroke();

    // faint "BEST" tag so newcomers know what the crosshair marks
    ctx.font = `700 ${11 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const label = 'BEST';
    const ly = oy - R - 5 * dpr;
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(label, ox, ly);
    ctx.fillStyle = '#ffd7de';
    ctx.fillText(label, ox, ly);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // current best (cyan, on top)
    const b = ga.bestOfGen;
    const bx = toPx(b.x), by = toPy(b.y);
    ctx.beginPath();
    ctx.arc(bx, by, 5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#22d3ee';
    ctx.fill();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    drawChart();
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

    const hist = ga.history;
    const n = hist.best.length;
    if (n < 2) return;

    // y-scale from combined best+mean range
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const bv = hist.best[i], mv = hist.mean[i];
      if (bv < lo) lo = bv; if (bv > hi) hi = bv;
      if (mv < lo) lo = mv; if (mv > hi) hi = mv;
    }
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;

    const pL = 4, pR = 4, pT = 6, pB = 6;
    const plotW = w - pL - pR, plotH = h - pT - pB;
    const X = (i) => pL + (i / (n - 1)) * plotW;
    const Y = (v) => pT + (1 - (v - lo) / (hi - lo)) * plotH;

    function line(arr, color, width) {
      cctx.beginPath();
      for (let i = 0; i < n; i++) {
        const px = X(i), py = Y(arr[i]);
        if (i === 0) cctx.moveTo(px, py); else cctx.lineTo(px, py);
      }
      cctx.strokeStyle = color;
      cctx.lineWidth = width * dpr;
      cctx.lineJoin = 'round';
      cctx.stroke();
    }
    line(hist.mean, '#a3a3a3', 1.4);
    line(hist.best, '#22d3ee', 1.8);
  }

  // ---------------- readouts ----------------
  function fmt(v) {
    if (!isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1000 || (a < 0.01 && a > 0)) return v.toExponential(1);
    return v.toFixed(a < 10 ? 3 : 1);
  }

  function updateReadouts() {
    el.roGen.textContent = ga.generation;
    el.roBest.textContent = fmt(ga.bestOfGen.fitness);
    el.roMean.textContent = fmt(ga.meanFitness);

    const dx = ga.bestOfGen.x - landscape.optimum.x;
    const dy = ga.bestOfGen.y - landscape.optimum.y;
    el.roDist.textContent = fmt(Math.sqrt(dx * dx + dy * dy));

    const div = ga.diversity;
    el.roDiv.textContent = fmt(div);
    const frac = Math.max(0, Math.min(1, div / maxSpread));
    el.divBar.style.width = (frac * 100).toFixed(1) + '%';
    el.divHint.textContent = frac < 0.06
      ? 'Converged — the population has collapsed onto one point.'
      : 'How spread out the population is — low means everyone\'s clustered on one spot.';

    updateStatus(frac);
  }

  // Plain-English narration of the current state.
  // Uses distance-from-the-true-optimum (in domain units), which behaves
  // consistently across landscapes with wildly different fitness scales.
  function updateStatus(frac) {
    const range = landscape.domain.max - landscape.domain.min;
    const dx = ga.bestOfGen.x - landscape.optimum.x;
    const dy = ga.bestOfGen.y - landscape.optimum.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const converged = frac < 0.08;

    let cls, text;
    if (dist < range * 0.035 && frac < 0.14) {
      cls = 'solved';
      text = '✅ Solved! The swarm reached the best possible peak.';
    } else if (converged && dist > range * 0.06) {
      cls = 'stuck';
      text = '⚠️ Stuck on a lower hill — evolution converged on a trap, not the true best. Try raising mutation, or hit Reset.';
    } else if (frac > 0.45) {
      cls = 'explore';
      text = '🔍 Exploring — the population is spread out, searching for high ground.';
    } else {
      cls = 'climb';
      text = '⛰️ Climbing — the dots have found a hill and are heading up it.';
    }

    if (el.status.dataset.cls !== cls) {
      el.status.className = 'status ' + cls;
      el.status.dataset.cls = cls;
    }
    el.statusText.textContent = text;
  }

  // ---------------- animation loop ----------------
  let lastT = 0, acc = 0;
  function frame(t) {
    if (!lastT) lastT = t;
    const dt = (t - lastT) / 1000;
    lastT = t;
    if (running) {
      acc += dt;
      const interval = 1 / cfg.gps;
      let steps = 0;
      while (acc >= interval && steps < 12) {
        ga.step();
        acc -= interval;
        steps++;
      }
      if (steps >= 12) acc = 0; // shed backlog if we can't keep up
      if (steps > 0) updateReadouts();
    }
    render();
    requestAnimationFrame(frame);
  }

  // ---------------- resize (keep canvas square & crisp) ----------------
  function resize() {
    const wrap = $('canvas-wrap');
    const dpr = window.devicePixelRatio || 1;
    const size = Math.max(120, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight)));
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    if (ga) render();
  }
  window.addEventListener('resize', resize);

  // ---------------- controls wiring ----------------
  function setRunning(on) {
    running = on;
    el.play.textContent = on ? '⏸ Pause' : '▶ Play';
    el.play.classList.toggle('running', on);
    if (on) { lastT = 0; acc = 0; }
  }

  el.play.addEventListener('click', () => setRunning(!running));
  el.step.addEventListener('click', () => {
    if (running) setRunning(false);
    ga.step();
    updateReadouts();
    render();
  });
  el.reset.addEventListener('click', () => { rebuild(); });

  el.landscapeSel.addEventListener('change', (e) => {
    cfg.landscape = e.target.value;
    rebuild();
  });

  // Live sliders (no rebuild)
  function bindSlider(input, valEl, key, parse, fmtLabel) {
    input.addEventListener('input', () => {
      const v = parse(input.value);
      cfg[key] = v;
      valEl.textContent = fmtLabel ? fmtLabel(v) : v;
    });
  }
  bindSlider(el.mutRate, el.mrVal, 'mutationRate', parseFloat, (v) => v.toFixed(2));
  bindSlider(el.mutSigma, el.msVal, 'mutationSigma', parseFloat, (v) => v.toFixed(2));
  bindSlider(el.tournSize, el.tsVal, 'tournamentSize', (v) => parseInt(v, 10));
  bindSlider(el.elitism, el.elVal, 'elitism', (v) => parseInt(v, 10));
  bindSlider(el.gps, el.gpsVal, 'gps', (v) => parseInt(v, 10));

  // Pop size requires a rebuild — apply on release for smoothness.
  el.popSize.addEventListener('input', () => {
    el.popVal.textContent = el.popSize.value;
  });
  el.popSize.addEventListener('change', () => {
    cfg.popSize = parseInt(el.popSize.value, 10);
    rebuild();
  });

  el.selSel.addEventListener('change', () => {
    cfg.selection = el.selSel.value;
    el.tournRow.style.display = cfg.selection === 'tournament' ? '' : 'none';
  });
  el.crossover.addEventListener('change', () => { cfg.crossover = el.crossover.checked; });

  // ---------------- intro overlay ----------------
  function showIntro(on) { el.intro.hidden = !on; }
  let seenIntro = false;
  try { seenIntro = localStorage.getItem('ga_seen_intro') === '1'; } catch (e) { /* private mode */ }
  showIntro(!seenIntro);
  el.introClose.addEventListener('click', () => {
    showIntro(false);
    try { localStorage.setItem('ga_seen_intro', '1'); } catch (e) { /* ignore */ }
  });
  el.helpBtn.addEventListener('click', () => showIntro(true));

  // ---------------- boot ----------------
  resize();
  rebuild();
  requestAnimationFrame(frame);
})();

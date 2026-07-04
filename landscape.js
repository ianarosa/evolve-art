/* ============================================================
   landscape.js — 2D fitness landscapes.
   Every landscape maps (x, y) -> fitness (HIGHER is better; the GA
   maximizes). Domain is a square; fmin/fmax and the global optimum
   are precomputed once for color-normalization and the marker.
   Exposes: window.Landscapes, window.GA_DOMAIN
   ============================================================ */
(function () {
  'use strict';

  const DOMAIN = { min: -5.12, max: 5.12 };

  function gaussian(x, y, cx, cy, amp, sigma) {
    const dx = x - cx, dy = y - cy;
    return amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
  }

  // Raw fitness functions -------------------------------------------------
  const defs = {
    single: {
      label: 'Single peak (easy)',
      f: (x, y) => gaussian(x, y, 0, 0, 1, 1.6)
    },
    multi: {
      label: 'Multi-peak (traps)',
      f: (x, y) =>
        gaussian(x, y, -2.2, -1.8, 1.00, 1.15) +  // tallest -> global
        gaussian(x, y,  2.4,  1.6, 0.78, 1.00) +
        gaussian(x, y,  1.9, -2.6, 0.62, 0.90) +
        gaussian(x, y, -2.7,  2.5, 0.55, 0.85)
    },
    rastrigin: {
      label: 'Rastrigin (hard)',
      f: (x, y) => {
        const A = 10;
        const r = 2 * A +
          (x * x - A * Math.cos(2 * Math.PI * x)) +
          (y * y - A * Math.cos(2 * Math.PI * y));
        return -r; // maximize: global max 0 at the origin
      }
    }
  };

  // Grid-sample to find fmin/fmax (color scale) and the best point (marker).
  function analyze(f) {
    const N = 256;
    let fmin = Infinity, fmax = -Infinity, bx = 0, by = 0;
    for (let i = 0; i < N; i++) {
      const x = DOMAIN.min + (DOMAIN.max - DOMAIN.min) * (i / (N - 1));
      for (let j = 0; j < N; j++) {
        const y = DOMAIN.min + (DOMAIN.max - DOMAIN.min) * (j / (N - 1));
        const v = f(x, y);
        if (v < fmin) fmin = v;
        if (v > fmax) { fmax = v; bx = x; by = y; }
      }
    }
    return { fmin, fmax, optimum: { x: bx, y: by } };
  }

  const Landscapes = {};
  Object.keys(defs).forEach((key) => {
    const d = defs[key];
    const a = analyze(d.f);
    Landscapes[key] = {
      key,
      label: d.label,
      f: d.f,
      fmin: a.fmin,
      fmax: a.fmax,
      optimum: a.optimum,
      domain: DOMAIN
    };
  });

  // Analytic optimum for Rastrigin is exactly the origin.
  Landscapes.rastrigin.optimum = { x: 0, y: 0 };

  window.Landscapes = Landscapes;
  window.GA_DOMAIN = DOMAIN;
})();

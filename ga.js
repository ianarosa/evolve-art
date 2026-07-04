/* ============================================================
   ga.js — the genetic algorithm engine.
   A genome is a point {x, y}. One step() runs a full generation:
   evaluate -> (elitism) -> select -> crossover -> mutate -> replace.
   Config is read live each step so UI sliders take effect immediately.
   Exposes: window.GA
   ============================================================ */
(function () {
  'use strict';

  // Standard normal via Box-Muller.
  function gaussRand() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  class GA {
    constructor(landscape, cfg) {
      this.landscape = landscape;
      this.cfg = cfg;                 // shared, mutated live by the UI
      this.generation = 0;
      this.history = { best: [], mean: [], diversity: [] };
      this.best = null;               // best-ever {x, y, fitness}
      this._initPopulation();
      this._evaluate();
      this._recordStats();
    }

    _initPopulation() {
      const { min, max } = this.landscape.domain;
      const n = Math.max(2, this.cfg.popSize | 0);
      this.pop = new Array(n);
      for (let i = 0; i < n; i++) {
        this.pop[i] = {
          x: min + Math.random() * (max - min),
          y: min + Math.random() * (max - min),
          fitness: 0
        };
      }
    }

    _evaluate() {
      const f = this.landscape.f;
      for (let i = 0; i < this.pop.length; i++) {
        const ind = this.pop[i];
        ind.fitness = f(ind.x, ind.y);
      }
    }

    _recordStats() {
      const pop = this.pop;
      const n = pop.length;
      let sum = 0, best = pop[0], cx = 0, cy = 0;
      for (let i = 0; i < n; i++) {
        sum += pop[i].fitness;
        cx += pop[i].x; cy += pop[i].y;
        if (pop[i].fitness > best.fitness) best = pop[i];
      }
      cx /= n; cy /= n;

      // Diversity = RMS spread of the cloud around its centroid (O(n)).
      let varSum = 0;
      for (let i = 0; i < n; i++) {
        const dx = pop[i].x - cx, dy = pop[i].y - cy;
        varSum += dx * dx + dy * dy;
      }
      const diversity = Math.sqrt(varSum / n);

      this.meanFitness = sum / n;
      this.diversity = diversity;
      this.bestOfGen = { x: best.x, y: best.y, fitness: best.fitness };
      if (!this.best || best.fitness > this.best.fitness) {
        this.best = { x: best.x, y: best.y, fitness: best.fitness };
      }

      const h = this.history;
      h.best.push(this.bestOfGen.fitness);
      h.mean.push(this.meanFitness);
      h.diversity.push(diversity);
      const CAP = 600;
      if (h.best.length > CAP) { h.best.shift(); h.mean.shift(); h.diversity.shift(); }
    }

    // --- selection ---------------------------------------------------------
    _tournament() {
      const pop = this.pop;
      const k = Math.max(2, this.cfg.tournamentSize | 0);
      let best = pop[(Math.random() * pop.length) | 0];
      for (let i = 1; i < k; i++) {
        const c = pop[(Math.random() * pop.length) | 0];
        if (c.fitness > best.fitness) best = c;
      }
      return best;
    }

    _prepRoulette() {
      // Shift fitness so all weights are positive (fitness may be negative,
      // e.g. Rastrigin), then build a cumulative total.
      const pop = this.pop;
      let min = Infinity;
      for (let i = 0; i < pop.length; i++) if (pop[i].fitness < min) min = pop[i].fitness;
      const eps = 1e-6;
      let total = 0;
      const w = new Array(pop.length);
      for (let i = 0; i < pop.length; i++) {
        const wi = (pop[i].fitness - min) + eps;
        w[i] = wi;
        total += wi;
      }
      this._weights = w;
      this._weightTotal = total;
    }

    _roulette() {
      const pop = this.pop;
      let r = Math.random() * this._weightTotal;
      for (let i = 0; i < pop.length; i++) {
        r -= this._weights[i];
        if (r <= 0) return pop[i];
      }
      return pop[pop.length - 1];
    }

    _select() {
      return this.cfg.selection === 'roulette' ? this._roulette() : this._tournament();
    }

    // --- variation ---------------------------------------------------------
    _crossover(p1, p2) {
      if (!this.cfg.crossover) return { x: p1.x, y: p1.y, fitness: 0 };
      // Blend/arithmetic crossover: per-gene convex mix of the two parents.
      const ax = Math.random(), ay = Math.random();
      return {
        x: ax * p1.x + (1 - ax) * p2.x,
        y: ay * p1.y + (1 - ay) * p2.y,
        fitness: 0
      };
    }

    _mutate(ind) {
      const { min, max } = this.landscape.domain;
      const rate = this.cfg.mutationRate;
      const sigma = this.cfg.mutationSigma;
      if (Math.random() < rate) ind.x += gaussRand() * sigma;
      if (Math.random() < rate) ind.y += gaussRand() * sigma;
      ind.x = clamp(ind.x, min, max);   // keep genomes inside the domain
      ind.y = clamp(ind.y, min, max);
    }

    // --- one generation ----------------------------------------------------
    step() {
      const n = this.pop.length;
      const next = [];

      const elite = clampInt(this.cfg.elitism, 0, n);
      if (elite > 0) {
        const sorted = this.pop.slice().sort((a, b) => b.fitness - a.fitness);
        for (let i = 0; i < elite; i++) {
          next.push({ x: sorted[i].x, y: sorted[i].y, fitness: sorted[i].fitness });
        }
      }

      if (this.cfg.selection === 'roulette') this._prepRoulette();

      while (next.length < n) {
        const p1 = this._select();
        const p2 = this._select();
        const child = this._crossover(p1, p2);
        this._mutate(child);
        next.push(child);
      }

      this.pop = next;
      this._evaluate();
      this.generation++;
      this._recordStats();
    }
  }

  function clampInt(v, lo, hi) {
    v = v | 0;
    return v < lo ? lo : v > hi ? hi : v;
  }

  window.GA = GA;
})();

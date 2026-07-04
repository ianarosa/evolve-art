# 🧬 Genetic Algorithm Sandbox

A mesmerizing, single-page toy where you watch a population of individuals
**evolve up a 2D fitness landscape**. Each dot is a genome `(x, y)`; the colored
map is the fitness field (brighter = fitter). Every generation the GA
**evaluates → selects → crosses over → mutates** the population, and you watch
the cloud migrate toward the peaks.

It's built to make evolutionary dynamics *visible* — especially **premature
convergence**: pick the hard Rastrigin landscape, drop the mutation rate, and
watch the diversity meter collapse as the swarm gets trapped on a local peak.

## Features

- **3 switchable landscapes** — single Gaussian peak (easy), multi-peak (traps),
  and Rastrigin (many local optima, one global).
- **Live GA controls** — population size, mutation rate & strength (σ),
  selection method (tournament / roulette), tournament size, elitism count,
  blend crossover toggle, and speed (generations/second).
- **Live readouts** — generation, best & mean fitness with a sparkline chart,
  a **diversity meter** (population spread), and distance from the best
  individual to the true global optimum.
- **Markers** — the current best (cyan) and the global optimum (rose crosshair).
- Pure **vanilla JS + Canvas**, dark theme, emoji favicon, **no build step, no
  frameworks, no CDNs** — fully self-contained and offline-capable.

## Run it

Just open the page — no server needed:

```
sim/index.html      # double-click, or drag into a browser
```

Or serve it locally:

```
cd sim && python3 -m http.server 8000   # then visit http://localhost:8000
```

## Deploy (Vercel, static)

```
cd sim
vercel            # or `vercel --prod`
```

Since it's plain static files, any static host works (Vercel, Netlify, GitHub
Pages, Cloudflare Pages) — just serve the `sim/` folder.

## Files

```
sim/
  index.html    # markup + panel
  style.css     # dark GitHub-ish theme, responsive layout
  landscape.js  # the fitness landscapes + color/optimum precompute
  ga.js         # the genetic algorithm engine (selection/crossover/mutation)
  main.js       # DOM wiring, canvas rendering, animation loop
```

The code is split so features can be added without stepping on each other:
`landscape.js` owns the fitness functions, `ga.js` owns the evolution, and
`main.js` owns the UI/rendering.

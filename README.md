# 🎨 Evolve a Picture

A mesmerizing, single-page toy that recreates an image **out of colored glass
shapes using evolution**. Two pictures sit side by side: the **target** (left)
and an **evolving copy** (right) that starts as random noise and slowly sharpens
into a near-perfect match — the classic "evolve the Mona Lisa" effect.

## How it works

The evolving picture's "genome" is a stack of semi-transparent colored polygons.
The engine runs a **(1+1) evolution strategy / hill-climber**:

1. Copy the current best genome.
2. Apply one small random **mutation** — nudge a vertex, tweak a color or alpha,
   or occasionally add / remove / reorder a shape.
3. Render it and measure **fitness** = pixel similarity to the target (sum of
   squared per-channel differences, evaluated on a fast 128px downscale).
4. **Keep the mutant only if it matches better; otherwise discard it.**

Because only improvements survive, the **Match %** climbs monotonically toward
100 and never drops. Thousands of these tiny accepted tweaks per second turn
random shapes into a copy of the image.

## Features

- **Target picker** — 4 built-in procedural targets (smiley, heart, sunset, a
  colored composition) drawn in-canvas, plus **upload your own image** (stays
  100% local — nothing is sent anywhere).
- **Live controls** — number of shapes, shape style (triangles / quads /
  polygons), mutation amount, speed (attempts per frame), Play/Pause, Reset.
- **Live readouts** — headline **Match %**, attempts tried, improvements
  accepted, current shape count, tweaks-per-second, a Match% sparkline, and a
  plain-English status line that narrates the run.
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
  index.html    # markup + control panel + intro overlay
  style.css     # dark theme, responsive two-canvas layout
  art.js        # genome, render, mutate, fitness, the (1+1) ArtEvolver engine
  main.js       # DOM wiring, built-in targets, upload, animation loop
```

`art.js` owns the evolution/rendering engine (exposes `window.Art`), and
`main.js` owns the UI, the procedural targets, and the animation loop — so
features can be added without the two stepping on each other.

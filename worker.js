/* ============================================================
   worker.js — runs the whole evolution loop off the main thread.
   Owns an ArtEvolver + an OffscreenCanvas for the display frame.
   Posts back to the main thread ONLY when the best improves (throttled
   to ~60fps) plus a lightweight numbers-only "stats" tick 4x/sec.
   Every outgoing message carries the current `version`; the main thread
   ignores any message whose version is stale (after reset/target change).
   ============================================================ */
'use strict';
importScripts('art.js');

const FRAME_MS = 1000 / 60;

let evolver = null;
let cfg = null;
let target = null;
let running = false;
let version = 0;
let renderSize = 320;

let display = null, dctx = null;
let dirty = false, lastFrameT = 0, lastStatsT = 0, scheduled = false;

function now() { return (typeof performance !== 'undefined') ? performance.now() : Date.now(); }

function ensureDisplay() {
  if (!display || display.width !== renderSize) {
    display = new OffscreenCanvas(renderSize, renderSize);
    dctx = display.getContext('2d');
  }
}

function stats() {
  return {
    version: version,
    match: evolver.bestMatch,
    attempts: evolver.attempts,
    improvements: evolver.improvements,
    shapes: evolver.shapeCount
  };
}

function postFrame() {
  ensureDisplay();
  evolver.draw(dctx, renderSize, renderSize);
  const bmp = display.transferToImageBitmap();
  const msg = stats();
  msg.type = 'frame';
  msg.bitmap = bmp;
  self.postMessage(msg, [bmp]);
}

function postStats() {
  const msg = stats();
  msg.type = 'stats';
  self.postMessage(msg);
}

function schedule() {
  if (!scheduled) { scheduled = true; setTimeout(tick, 0); }
}

function tick() {
  scheduled = false;
  if (!running || !evolver) return;
  if (evolver.step(cfg.speed)) dirty = true;
  const t = now();
  if (dirty && t - lastFrameT >= FRAME_MS) { postFrame(); dirty = false; lastFrameT = t; }
  if (t - lastStatsT >= 250) { postStats(); lastStatsT = t; }
  schedule();
}

function rebuild() {
  evolver = new self.Art.ArtEvolver(target, cfg);
  dirty = true; lastFrameT = 0; lastStatsT = 0;
  postFrame();
  postStats();
  if (running) schedule();
}

self.onmessage = function (e) {
  const m = e.data;
  switch (m.type) {
    case 'init':
      cfg = m.cfg;
      target = m.target;
      renderSize = m.renderSize || renderSize;
      version = m.version;
      running = !!m.running;
      rebuild();
      break;

    case 'setTarget':          // new picture -> fresh evolver, new version
      target = m.target;
      version = m.version;
      if (typeof m.running === 'boolean') running = m.running;  // adopt main's authoritative play state
      rebuild();
      break;

    case 'setShapeCount':      // change budget, KEEP the evolved picture (same version)
      evolver.setShapeCount(m.n, m.minShapes, m.maxShapes);
      dirty = true;
      postFrame();
      postStats();
      if (running) schedule();
      break;

    case 'setStyle':           // change style, KEEP existing shapes (same version)
      evolver.setStyle(m.shapeKind, m.vertices);
      break;

    case 'reset':              // re-randomize on the same target
      version = m.version;
      if (typeof m.running === 'boolean') running = m.running;  // adopt main's authoritative play state
      evolver.reset();
      dirty = true;
      postFrame();
      postStats();
      if (running) schedule();  // paused -> stays paused (attempts stay at 0); running -> resumes
      break;

    case 'config':             // live tweaks that need no rebuild
      cfg.mutationAmount = m.cfg.mutationAmount;
      cfg.speed = m.cfg.speed;
      cfg.seed = m.cfg.seed;   // next 'reset' rebuilds honouring the new start mode
      break;

    case 'renderSize':
      renderSize = m.size;
      ensureDisplay();
      dirty = true;
      break;

    case 'play':
      running = !!m.running;
      if (running) schedule();
      break;

    case 'requestGenome':      // for high-res PNG export on the main thread
      self.postMessage({
        type: 'genome', reqId: m.reqId, version: version,
        genome: evolver.best, w: target.w, h: target.h
      });
      break;
  }
};

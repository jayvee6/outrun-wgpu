// sj-hud.js — shared, modular prototype instrumentation.
//
// The locked Studio Joe workflow: every prototype is instrumented from frame
// one. This module is that instrumentation in one place — drop in a script
// tag, call createHud(), call hud.tick(now) per frame. Done.
//
// Provides:
//   * Windowed-stats perf HUD — 120-frame ring-buffer TRUE average
//     (fps = 1000/avg), p99 low1%, drops/s, colour-coded sparkline.
//     NEVER EMA-smoothed (an EMA low-passes the number and lies about drops).
//     Logic is verbatim from musicplayer-viz/app.js `_hud`.
//   * A BUILD id row so a perf screenshot maps to exact code state.
//   * Modular extra rows (opts.lines) for viz-specific readouts.
//   * A self-diagnosing failure overlay (hud.report) + global error /
//     unhandledrejection hooks, so a screenshot alone diagnoses any failure.
//
// Classic script (matches the repo's viz/*.js convention) — exposes
// window.SJHud. No ES-module MIME dependency.
//
// VISUAL NOTE: this is the approved blackhole debug-UI look, lifted as-is.
// The Apple Metal Performance HUD layout + sj-design token restyle is a
// separate pass (pending the sj-design token answers) and lands here.

(() => {
  if (window.SJHud) return;

  const CSS = `
  .sjhud, .sjhud-help, .sjhud-nogpu {
    /* sj-design tokens — values from studiojoe/index.html :root (Nocturne).
       Inlined because a shared module cannot rely on a host-page :root. */
    --sj-label-1: rgba(255,255,255,0.92);
    --sj-label-2: rgba(255,255,255,0.55);
    --sj-label-3: rgba(255,255,255,0.28);
    --sj-accent:  #2DD4BF;
    --sj-glass-bdr: rgba(255,255,255,0.10);
    --sj-glass-shd: 0 8px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08);
  }
  .sjhud {
    --sjhud-fps-color: var(--sj-accent);
    position: fixed; top: 14px; left: 14px; z-index: 2147483646;
    color: var(--sj-label-2);
    font: 11px/1.5 ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    min-width: 158px; padding: 11px 13px 10px;
    /* An instrument must not perturb what it measures. backdrop-filter:blur
       over a fullscreen ANIMATING canvas is re-evaluated by the compositor
       EVERY frame -> a real per-frame GPU cost AND an observer-effect
       confound. Deliberately dropped: a near-opaque dark scrim (sj --bg
       #060608 @ 0.82) is equally legible over the bright disk at ~zero
       per-frame cost. Border + shadow are paint-once (static layer). */
    background: rgba(6,6,8,0.82);
    border: 1px solid var(--sj-glass-bdr);
    border-radius: 13px;
    box-shadow: var(--sj-glass-shd);
    pointer-events: none; user-select: none;
  }
  .sjhud .hdr  { display: flex; justify-content: space-between;
                 align-items: baseline; margin-bottom: 6px; }
  .sjhud .ttl  { color: var(--sj-label-1); font-weight: 600;
                 letter-spacing: 0.02em; }
  .sjhud .bld  { color: var(--sj-label-3); font-size: 10px; }
  .sjhud .big  { font-size: 23px; font-weight: 650; line-height: 1.05;
                 color: var(--sjhud-fps-color); }
  .sjhud .unit { color: var(--sj-label-3); font-size: 10px;
                 letter-spacing: 0.07em; text-transform: uppercase; }
  .sjhud .dim  { color: var(--sj-label-2); }
  .sjhud .ter  { color: var(--sj-label-3); }
  .sjhud canvas { display: block; width: 150px; height: 28px;
                  margin: 8px 0 4px; border-radius: 5px; }
  .sjhud-help {
    position: fixed; right: 14px; bottom: 14px; z-index: 2147483646;
    color: var(--sj-label-3);
    font: 11px/1.55 ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
    text-align: right; pointer-events: none; user-select: none;
  }
  .sjhud-nogpu {
    position: fixed; inset: 0; display: none;
    align-items: center; justify-content: center;
    color: var(--sj-label-1);
    font: 14px/1.6 ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
    text-align: center; padding: 24px; background: #060608;
    z-index: 2147483647;
  }`;

  function injectCSSOnce() {
    if (document.getElementById('sjhud-css')) return;
    const s = document.createElement('style');
    s.id = 'sjhud-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // Windowed-stats core — DO NOT replace with an EMA. (app.js _hud, verbatim.)
  function createHud(opts = {}) {
    injectCSSOnce();

    const title  = opts.title  || 'Viz';
    const build  = opts.build  || 'dev';
    const canvas = opts.canvas || null;
    const lines  = opts.lines  || [];        // [{ id, init }] modular rows
    const help   = opts.help   || null;      // string | string[]

    // ── Panel DOM ────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.className = 'sjhud';
    panel.setAttribute('aria-hidden', 'true');

    const mkRow = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };
    const hdr = document.createElement('div');
    hdr.className = 'hdr';
    hdr.innerHTML = '<span class="ttl"></span><span class="bld" id="sjhud-build"></span>';
    panel.appendChild(hdr);
    panel.querySelector('.ttl').textContent = title;
    panel.querySelector('#sjhud-build').textContent = build;

    panel.appendChild(mkRow('<span class="big" id="sjhud-fps">--</span><span class="unit"> fps</span>'));
    panel.appendChild(mkRow('<span class="dim"><span id="sjhud-ft">--</span> ms/f &middot; <span id="sjhud-low">-- low1%</span></span>'));
    panel.appendChild(mkRow('<span class="dim"><span id="sjhud-drops">--</span> drops/s</span>'));

    // Frame-delivery graph. Logical size GWxGH. DPR pinned to 1: a 150x28
    // debug sparkline does not need retina, and 1x quarters the per-redraw
    // raster vs 2x — the instrument stays cheap. (Was the chunky-bars bug a
    // sizing fault, not DPR; thin AA lines read clean at 1x.)
    const GW = 150, GH = 28;
    const DPR = 1;
    const spark = document.createElement('canvas');
    spark.width  = Math.round(GW * DPR);
    spark.height = Math.round(GH * DPR);
    panel.appendChild(spark);

    if (canvas) {
      const r = mkRow('<span class="ter" id="sjhud-res">--</span>');
      panel.appendChild(r);
    }
    for (const ln of lines) {
      const d = document.createElement('div');
      d.className = 'ter';
      d.id = 'sjhud-' + ln.id;
      d.textContent = ln.init || '';
      panel.appendChild(d);
    }
    document.body.appendChild(panel);

    // ── Help line ────────────────────────────────────────────────────────
    if (help) {
      const h = document.createElement('div');
      h.className = 'sjhud-help';
      h.innerHTML = (Array.isArray(help) ? help : [help]).join('<br>');
      document.body.appendChild(h);
    }

    // ── Failure overlay ──────────────────────────────────────────────────
    const nogpu = document.createElement('div');
    nogpu.className = 'sjhud-nogpu';
    const box = document.createElement('div');
    nogpu.appendChild(box);
    document.body.appendChild(nogpu);

    function report(rTitle, detail) {
      nogpu.style.display = 'flex';
      box.textContent = '';
      const b = document.createElement('b'); b.textContent = rTitle; box.appendChild(b);
      const pre = document.createElement('div');
      pre.style.cssText = 'margin-top:10px;font-size:12px;opacity:.74;white-space:pre-wrap;text-align:left;max-width:720px';
      pre.textContent = Array.isArray(detail) ? detail.join('\n') : String(detail);
      box.appendChild(pre);
      const f = document.createElement('div');
      f.style.cssText = 'margin-top:10px;font-size:11px;opacity:.5';
      f.textContent = 'BUILD ' + build + ' · full log in DevTools console';
      box.appendChild(f);
    }
    window.addEventListener('error', (e) =>
      report('Uncaught error', (e.error && e.error.stack) || e.message));
    window.addEventListener('unhandledrejection', (e) =>
      report('Unhandled promise rejection', (e.reason && e.reason.stack) || String(e.reason)));

    // ── Stats state ──────────────────────────────────────────────────────
    const RING = 120;
    const buf  = new Float32Array(RING);
    const sortBuf = new Float32Array(RING);   // reused scratch — zero per-update alloc
    let head = 0, count = 0, prevTs = 0, lastUpdate = 0;
    const UPDATE_MS = 250;
    const DROP_RING = 60;
    const dropBuf = new Uint8Array(DROP_RING);
    let dropHead = 0;
    const sparkCtx = spark.getContext('2d');
    sparkCtx.scale(DPR, DPR);   // draw in logical GWxGH units

    const el = {
      build: panel.querySelector('#sjhud-build'),
      fps:   panel.querySelector('#sjhud-fps'),
      ft:    panel.querySelector('#sjhud-ft'),
      low:   panel.querySelector('#sjhud-low'),
      drops: panel.querySelector('#sjhud-drops'),
      res:   panel.querySelector('#sjhud-res'),
    };
    const _lc = { fps:'', ft:'', low:'', drops:'', res:'', col:'' };  // last-rendered cache

    function tick(ts) {
      if (!prevTs) { prevTs = ts; return; }
      const dt = ts - prevTs; prevTs = ts;
      buf[head] = dt; head = (head + 1) % RING; if (count < RING) count++;
      dropBuf[dropHead] = dt > 33.3 ? 1 : 0; dropHead = (dropHead + 1) % DROP_RING;
      if (ts - lastUpdate < UPDATE_MS) return;
      lastUpdate = ts;

      const n = count;
      let sum = 0;
      for (let i = 0; i < n; i++) { const v = buf[(head - n + i + RING) % RING]; sortBuf[i] = v; sum += v; }
      const srt = sortBuf.subarray(0, n);   // view, not a buffer copy
      srt.sort();                            // TypedArray.sort is numeric
      const avg = sum / n, fps = 1000 / avg;
      const p99 = srt[Math.min(n - 1, Math.floor(n * 0.99))];
      const fpsLow = 1000 / p99;
      let dropSum = 0; for (let i = 0; i < DROP_RING; i++) dropSum += dropBuf[i];
      const dropsPerSec = (dropSum / ((DROP_RING * avg) / 1000)).toFixed(1);

      // Only touch the DOM when the rendered string actually changes — skips
      // ~4x/s of needless style/layout recalc when fps is pinned (the common
      // case). The instrument stays cheap and doesn't perturb its own number.
      const sFps = '' + Math.round(fps);
      if (sFps !== _lc.fps)   { el.fps.textContent = sFps; _lc.fps = sFps; }
      const sFt = avg.toFixed(1);
      if (sFt !== _lc.ft)     { el.ft.textContent = sFt; _lc.ft = sFt; }
      const sLow = Math.round(fpsLow) + ' low1%';
      if (sLow !== _lc.low)   { el.low.textContent = sLow; _lc.low = sLow; }
      if (dropsPerSec !== _lc.drops) { el.drops.textContent = dropsPerSec; _lc.drops = dropsPerSec; }
      if (el.res && canvas) {
        const sRes = canvas.width + '×' + canvas.height;
        if (sRes !== _lc.res) { el.res.textContent = sRes; _lc.res = sRes; }
      }
      // Nominal = sj-design accent (Nocturne teal); warn/bad stay functional
      // amber/red (sj-design has no warn token; perf legibility > brand here).
      // Set only on state change — avoids a custom-prop invalidation 4x/s.
      const col = fps >= 55 ? '#2DD4BF' : fps >= 30 ? '#ffd040' : '#ff5252';
      if (col !== _lc.col) { panel.style.setProperty('--sjhud-fps-color', col); _lc.col = col; }

      // ── Frame-delivery graph (Apple-Metal-style: single-accent area +
      //    crisp line + faint budget guides). Spikes rise = worse frames.
      const MAXMS = 50;                                  // vertical full-scale
      const yOf = (ms) => GH - Math.min(1, ms / MAXMS) * GH;
      sparkCtx.clearRect(0, 0, GW, GH);
      sparkCtx.fillStyle = 'rgba(255,255,255,0.035)';    // inset field
      sparkCtx.fillRect(0, 0, GW, GH);

      // 60fps (16.7ms) and 30fps (33.3ms) budget guides.
      sparkCtx.strokeStyle = 'rgba(255,255,255,0.16)';
      sparkCtx.lineWidth = 1;
      sparkCtx.beginPath();
      sparkCtx.moveTo(0, yOf(16.7) + 0.5); sparkCtx.lineTo(GW, yOf(16.7) + 0.5);
      sparkCtx.stroke();
      sparkCtx.strokeStyle = 'rgba(255,255,255,0.08)';
      sparkCtx.beginPath();
      sparkCtx.moveTo(0, yOf(33.3) + 0.5); sparkCtx.lineTo(GW, yOf(33.3) + 0.5);
      sparkCtx.stroke();

      // State accent — one colour, not a rainbow of bars.
      const rgb = fps >= 55 ? '45,212,191' : fps >= 30 ? '255,208,64' : '255,82,82';
      const xOf = (i) => (i / (RING - 1)) * GW;

      // Filled area under the trace.
      sparkCtx.beginPath();
      sparkCtx.moveTo(0, GH);
      for (let i = 0; i < RING; i++) {
        sparkCtx.lineTo(xOf(i), yOf(buf[(head - RING + i + RING) % RING]));
      }
      sparkCtx.lineTo(GW, GH);
      sparkCtx.closePath();
      const grad = sparkCtx.createLinearGradient(0, 0, 0, GH);
      grad.addColorStop(0, 'rgba(' + rgb + ',0.30)');
      grad.addColorStop(1, 'rgba(' + rgb + ',0)');
      sparkCtx.fillStyle = grad;
      sparkCtx.fill();

      // Crisp trace line on top.
      sparkCtx.beginPath();
      for (let i = 0; i < RING; i++) {
        const x = xOf(i), y = yOf(buf[(head - RING + i + RING) % RING]);
        if (i === 0) sparkCtx.moveTo(x, y); else sparkCtx.lineTo(x, y);
      }
      sparkCtx.strokeStyle = 'rgba(' + rgb + ',0.95)';
      sparkCtx.lineWidth = 1.25;
      sparkCtx.lineJoin = 'round';
      sparkCtx.stroke();
    }

    // Set a modular extra row (or the build id) by id.
    function set(id, text) {
      const node = panel.querySelector('#sjhud-' + id);
      if (node) node.textContent = text;
    }

    return { tick, set, report, panel, nogpu };
  }

  window.SJHud = { createHud };
})();

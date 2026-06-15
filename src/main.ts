import { initGpu, resize, type Gpu } from './gpu/device';
import { PolyRenderer } from './gpu/polyRenderer';
import { SpriteRenderer, type SpriteTexture } from './gpu/spriteRenderer';
import { Track } from './game/track';
import { Player } from './game/player';
import { Input } from './game/input';
import { parseMap, type SpritePlacement, SpritePos } from './game/mapParser';
import { loadSpriteAtlas, loadCarFrames, loadTexture, loadTrafficAtlas, type Atlas, type TrafficAtlas } from './game/assets';
import { TrafficManager } from './game/traffic';
import { Race, type GameMode } from './game/race';
import { HUD_SPEED_FACTOR, MAX_OFFROAD_SPEED } from './game/constants';
import type { MapColors } from './game/mapParser';
import type { RGBA } from './gpu/polyRenderer';
import { AudioManager } from './game/audio';
import { DebugPanel, type DebugFlags } from './game/debugPanel';

type AppState = 'title' | 'modeselect' | 'playing';

function lerpRGBA(a: RGBA, b: RGBA, t: number): RGBA {
  return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t, a[3]+(b[3]-a[3])*t];
}
function lerpColors(a: MapColors, b: MapColors, t: number): MapColors {
  const L = (ca: RGBA, cb: RGBA) => lerpRGBA(ca, cb, t);
  return {
    sky: L(a.sky, b.sky),
    sand1: L(a.sand1, b.sand1), sand2: L(a.sand2, b.sand2),
    road1: L(a.road1, b.road1), road2: L(a.road2, b.road2),
    rumble1: L(a.rumble1, b.rumble1), rumble2: L(a.rumble2, b.rumble2),
    lane1: L(a.lane1, b.lane1), lane2: L(a.lane2, b.lane2),
    rumbleLane1: L(a.rumbleLane1, b.rumbleLane1), rumbleLane2: L(a.rumbleLane2, b.rumbleLane2),
  };
}
function smoothstep(x: number): number { return x * x * (3 - 2 * x); }

const STEP = 1 / 60;
// build stamp so a perf screenshot maps to a moment in code state
const BUILD_ID = new Date().toISOString().slice(5, 16).replace('T', ' ');
const CAR_BASE = '/assets/cars/Ferrari1';
const TRAFFIC_BASE = '/assets/cars/traffic';
const TRAFFIC_COUNT = 16;

// The journey: distinct biomes chained together. atlasOffset 45 only for Map1
// (the start biome composes [MapStartGoal 1..45, Map1 1..26]); others use 1..N.
const STAGES = [
  { name: 'Map1', sprites: 26, atlasOffset: 45 }, // beach (sand)
  { name: 'Map2', sprites: 36, atlasOffset: 0 },  // grass
  { name: 'Map5', sprites: 53, atlasOffset: 0 },  // snow
  { name: 'Map7', sprites: 38, atlasOffset: 0 },  // mud
];

interface Stage { track: Track; scenery: Atlas; startAtlas: Atlas | null; bgBack: SpriteTexture; bgFront: SpriteTexture; time: number; }

function range(a: number, b: number) { const r: number[] = []; for (let i = a; i <= b; i++) r.push(i); return r; }

async function main() {
  const canvas = document.getElementById('gfx') as HTMLCanvasElement;
  const hudMsg = document.getElementById('hud-msg')!;
  const elTime = document.getElementById('hud-time')!;
  const elScore = document.getElementById('hud-score')!;
  const elSpeed = document.getElementById('hud-speed-n')!;
  const elStage = document.getElementById('hud-stage-n')!;
  const elHud = document.getElementById('hud')!;

  // --- Menu DOM refs ---
  const menuOverlay = document.getElementById('menu-overlay')!;
  const menuPrompt = document.getElementById('menu-prompt')!;
  const menuModes = document.getElementById('menu-modes')!;
  const menuModeDesc = document.getElementById('menu-mode-desc')!;
  const modeItems = Array.from(document.querySelectorAll<HTMLElement>('.menu-mode'));

  const MODE_DESCS: Record<GameMode, string> = {
    original:   'RACE TO THE GOAL — CRASH RECOVERABLE',
    continuous: 'ENDLESS RUN — CRASH RECOVERABLE',
    survival:   'ONE CRASH ENDS YOUR RUN — GOOD LUCK',
  };
  const MODES: GameMode[] = ['original', 'continuous', 'survival'];

  let appState: AppState = 'title';
  let selectedMode = 0; // index into MODES

  // --- Snow weather overlay (Canvas2D, driven by terrain type) ---
  const weatherCanvas = document.createElement('canvas');
  weatherCanvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:4;width:100%;height:100%';
  document.getElementById('app')!.appendChild(weatherCanvas);
  const weatherCtx = weatherCanvas.getContext('2d')!;
  const snowFlakes = Array.from({ length: 200 }, () => ({
    x: Math.random(), y: Math.random(),
    r: 0.8 + Math.random() * 2.0,
    vy: 0.00028 + Math.random() * 0.00055,
    vx: (Math.random() - 0.5) * 0.00018,
    alpha: 0.35 + Math.random() * 0.55,
  }));
  function tickWeather(active: boolean, fadeOut = 0) {
    const W = window.innerWidth, H = window.innerHeight;
    if (weatherCanvas.width !== W || weatherCanvas.height !== H) { weatherCanvas.width = W; weatherCanvas.height = H; }
    weatherCtx.clearRect(0, 0, W, H);
    if (!active) return;
    const opacity = Math.max(0, 1 - fadeOut);
    for (const f of snowFlakes) {
      f.y += f.vy; f.x += f.vx;
      if (f.y > 1.04) { f.y = -0.02; f.x = Math.random(); }
      if (f.x < 0) f.x += 1; if (f.x > 1) f.x -= 1;
      weatherCtx.globalAlpha = f.alpha * opacity;
      weatherCtx.beginPath();
      weatherCtx.arc(f.x * W, f.y * H, f.r, 0, Math.PI * 2);
      weatherCtx.fillStyle = '#ddeeff';
      weatherCtx.fill();
    }
    weatherCtx.globalAlpha = 1;
  }

  const gpu = await initGpu(canvas);
  const poly = new PolyRenderer(gpu);
  const sprite = new SpriteRenderer(gpu, 8192);

  // --- load assets ---
  hudMsg.textContent = 'LOADING'; hudMsg.className = 'show';
  const car: Atlas = await loadCarFrames(sprite, CAR_BASE, range(1, 148)); // incl. crash frames
  const trafficAtlas: TrafficAtlas = await loadTrafficAtlas(sprite, TRAFFIC_BASE, range(1, 8));

  // Sprite IDs in the MapStartGoal atlas (1-based PNG filename = object index + 1):
  //   38 = START flag/banner (472×61, wide horizontal gantry)
  //   39 = left  traffic-light panel (74×128)
  //   43 = right traffic-light panel (62×128)
  const START_ATLAS_IDS = [38, 39, 43];

  async function loadStage(cfg: typeof STAGES[number], isStart = false): Promise<Stage> {
    const base = `/assets/maps/${cfg.name}`;
    const mapData = parseMap(await (await fetch(`${base}/map.txt`)).text(), 0);
    const scenery = await loadSpriteAtlas(sprite, base, range(1, cfg.sprites), cfg.atlasOffset);
    const bgBack = await loadTexture(sprite, `${base}/back.png`, true);
    const bgFront = await loadTexture(sprite, `${base}/front.png`, true);

    let startAtlas: Atlas | null = null;
    if (isStart) {
      startAtlas = await loadSpriteAtlas(sprite, '/assets/maps/MapStartGoal', START_ATLAS_IDS, 0);
      // Patch banner (id 38) pivot to center-bottom so it spans the road centered on offsetX=0.
      const bannerProps = startAtlas.items.get(38);
      if (bannerProps) {
        bannerProps.pivotLeft = [0.5, 1];
        bannerProps.pivotRight = [0.5, 1];
      }
      // Inject start-line scenery into the map:
      //   Line 3 — overhead START banner (id 38), centered, raised above road
      //   Line 4 — left traffic-light (id 39), right of road center (positive offsetX = right)
      //   Line 4 — right traffic-light (id 43), left of road center
      // offsetY < 0 raises the sprite (spriteY = p.y + offsetY * scale * 1000 * w/2;
      // p.y is the road surface Y; smaller screen-Y = higher on screen).
      // Line positions: player starts at world-Z 0. Line n is at world-Z = n*SEGMENT_LENGTH (150).
      // At line 8 (1200 world units), the banner projects at ~1300px wide — filling the screen
      // in an iconic "driving under the gantry" shot. Traffic lights 2 lines beyond.
      const startPlacements: SpritePlacement[] = [
        // Overhead START gantry banner (id 38, 472×61) — centered, raised above road surface
        { line: 8,  pos: SpritePos.CENTER,    id: 38, offsetX:  0,     offsetY: -1.2, collider: false, side: false },
        // Traffic light panels flanking the road
        { line: 10, pos: SpritePos.NEAR_LEFT, id: 39, offsetX: -0.85,  offsetY: 0,   collider: false, side: false },
        { line: 10, pos: SpritePos.FAR_RIGHT, id: 43, offsetX:  0.85,  offsetY: 0,   collider: false, side: true  },
      ];
      mapData.sprites.push(...startPlacements);
    }

    // Map1's right-side "SLOW DOWN" sign (id 59) is mirrored in the source art
    // ("MWOD WOLS") — flip it back so it reads correctly.
    const flipIds = isStart ? new Set([59]) : new Set<number>();
    return { track: new Track(mapData, scenery, startAtlas, flipIds), scenery, startAtlas, bgBack, bgFront, time: mapData.time };
  }
  const stages: Stage[] = [];
  for (let si = 0; si < STAGES.length; si++) stages.push(await loadStage(STAGES[si], si === 0));

  // --- audio ---
  const audio = new AudioManager();
  audio.init(); // fire-and-forget; resumes on first keydown below

  const player = new Player();
  const input = new Input();
  let stageIdx = 0;
  let stage = stages[0];
  let track = stage.track, scenery = stage.scenery, startAtlas = stage.startAtlas, bgBack = stage.bgBack, bgFront = stage.bgFront;
  let traffic = new TrafficManager(trafficAtlas.carIds, TRAFFIC_COUNT, track.length);
  let race = new Race(stage.time, MODES[selectedMode]);

  let last = performance.now();
  let acc = 0, fpsT = 0, frames = 0, fps = 0;
  let bgScroll = 0;
  let score = 0;
  const debugFlags: DebugFlags = { noCollision: false, freezeTraffic: false };

  // Audio edge-detect state
  let prevCrashing = false;
  let prevCountdownDigit: string | null = null;
  let prevGoFlash = 0;
  let prevCheckpointFlash = 0;

  function activateStage(i: number) {
    stageIdx = i % stages.length;
    stage = stages[stageIdx];
    track = stage.track; scenery = stage.scenery; startAtlas = stage.startAtlas; bgBack = stage.bgBack; bgFront = stage.bgFront;
    traffic = new TrafficManager(trafficAtlas.carIds, TRAFFIC_COUNT, track.length);
    race.stage = stageIdx + 1;
  }

  // --- Drivable fork state ---
  // While in the current track's fork zone, forkActive is true. forkChoice is the
  // branch the player is currently on (sign of posX); it locks once past the split.
  let forkActive = false;
  let forkChoice: 'left' | 'right' | null = null;
  let forkLocked = false;

  // Guide the player onto a branch during the fork: bias posX toward the chosen
  // branch center so they smoothly lock on (instead of drifting onto the median).
  function updateFork() {
    const inZone = track.inForkZone(player.position);
    forkActive = inZone;
    // Before the fork zone: nothing chosen. Note we do NOT clear the choice once
    // we've driven PAST the end of the zone (position >= length) — checkStageEnd
    // must still see it to pick the branch. activateStage resets it afterward.
    if (!inZone) {
      if (player.position < track.forkStartZ) { forkChoice = null; forkLocked = false; }
      return;
    }
    const progress = track.forkProgress(player.position);
    // current side from steering / position (until locked)
    if (!forkLocked) forkChoice = player.posX < 0 ? 'left' : 'right';
    const targetSign = forkChoice === 'left' ? -1 : 1;
    // branch center grows with progress (mirrors Track.forkOffsetAt easing)
    const center = targetSign * 1.55 * progress * progress;
    // pull the player toward the chosen branch center, more strongly as we near
    // the split, so they end up planted on one road.
    const pull = 0.15 + 0.6 * progress;
    player.posX += (center - player.posX) * pull;
    if (progress >= 1) forkLocked = true; // choice is final at the split
  }

  // Advance to the next biome when the player reaches the end of the current one.
  // The fork branch they chose selects WHICH biome: left → next, right → the one
  // after that (so the linear chain becomes a branching choice).
  function checkStageEnd() {
    if (player.position >= track.length) {
      player.position -= track.length;       // carry overflow into the new biome
      const choice = forkChoice ?? 'left';
      const nextIdx = choice === 'right' ? stageIdx + 2 : stageIdx + 1;
      player.posX = 0;                        // re-center on the new biome's road
      forkActive = false; forkChoice = null; forkLocked = false;
      activateStage(nextIdx);
      race.stageFlash();
    }
  }

  function startRun(modeIndex = selectedMode) {
    selectedMode = Math.max(0, Math.min(MODES.length - 1, modeIndex));
    player.position = 0; player.posX = 0; player.speed = 0; player.crashing = false;
    activateStage(0);
    race = new Race(stage.time, MODES[selectedMode]);
    score = 0;
    prevCrashing = false;
    prevCountdownDigit = null;
    prevGoFlash = 0;
    prevCheckpointFlash = 0;
    appState = 'playing';
    // Play music immediately (audio context may already be resumed)
    if (audioStarted) audio.playMusic('Magical_Sound_Shower');
  }

  let audioStarted = false;
  function resumeAudio() {
    if (audioStarted) return;
    audioStarted = true;
    audio.resume();
    audio.startEngine();
  }

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyM') { audio.toggleMute(); return; }

    resumeAudio(); // browser autoplay policy — resume on first gesture

    if (appState === 'title') {
      if (e.code === 'Enter' || e.code === 'Space') {
        appState = 'modeselect';
      }
      return;
    }

    if (appState === 'modeselect') {
      if (e.code === 'ArrowUp' || e.code === 'KeyW') {
        selectedMode = (selectedMode - 1 + MODES.length) % MODES.length;
      } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        selectedMode = (selectedMode + 1) % MODES.length;
      } else if (e.code === 'Enter' || e.code === 'Space') {
        startRun(selectedMode);
      } else if (e.code === 'Escape') {
        appState = 'title';
      }
      return;
    }

    // appState === 'playing'
    if (race.state === 'gameover' && (e.code === 'Enter' || e.code === 'Space')) {
      // Return to title after gameover
      appState = 'title';
    }
  });

  // Render the full scene into an offscreen texture and read back the given
  // normalized sample points — headless verification without a visible canvas.
  async function probe(W = 320, H = 200, samples: [number, number][] = [], wantImage: boolean | string = false) {
    const { device } = gpu;
    const tex = device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const sw = gpu.width, sh = gpu.height; gpu.width = W; gpu.height = H;
    poly.begin(); sprite.begin();
    const horizon = track.render(poly, sprite, player.posX, player.position, player.posY, W, H, traffic.byLine(track), trafficAtlas);
    drawBackground(gpu, horizon);
    drawCar(gpu);
    sprite.upload();
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    const startTex = startAtlas ? [startAtlas.texture] : [];
    poly.flush(pass); sprite.flush(pass, [bgBack, bgFront]); sprite.flush(pass, [...startTex, scenery.texture, trafficAtlas.texture, car.texture]);
    pass.end();
    const bpr = Math.ceil((W * 4) / 256) * 256;
    const buf = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [W, H]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buf.getMappedRange());
    const bgra = gpu.format.startsWith('bgra');
    const out = samples.map(([nx, ny]) => {
      const x = Math.min(W - 1, Math.floor(nx * W)), y = Math.min(H - 1, Math.floor(ny * H));
      const o = y * bpr + x * 4;
      return { at: [nx, ny], rgba: bgra ? [px[o + 2], px[o + 1], px[o], px[o + 3]] : [px[o], px[o + 1], px[o + 2], px[o + 3]] };
    });
    let posted: string | undefined;
    if (wantImage) {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d')!; const img = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = y * bpr + x * 4, d = (y * W + x) * 4;
        if (bgra) { img.data[d] = px[o + 2]; img.data[d + 1] = px[o + 1]; img.data[d + 2] = px[o]; }
        else { img.data[d] = px[o]; img.data[d + 1] = px[o + 1]; img.data[d + 2] = px[o + 2]; }
        img.data[d + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      // POST to the dev-server shot sink (writes /tmp/outrun_<name>.png)
      const name = typeof wantImage === 'string' ? wantImage : 'shot';
      const blob: Blob = await new Promise((r) => cv.toBlob((b) => r(b!), 'image/png'));
      await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
      posted = `/tmp/outrun_${name}.png`;
    }
    buf.unmap(); tex.destroy(); buf.destroy(); gpu.width = sw; gpu.height = sh;
    return wantImage ? { samples: out, posted } : out;
  }

  // ---------------------------------------------------------------------------
  // Automation helpers — synchronous headless simulation for e2e testing
  // ---------------------------------------------------------------------------

  function autopilotInput(p: typeof player, seg: { curve: number }) {
    // Primary goal: return posX to 0 (center). Curve feed-forward is intentionally
    // weak — a large curve term fights recovery when the car is already off-road.
    const signal = p.posX * 3.0 - seg.curve * 0.4;
    return { accel: !p.crashing, brake: false, left: signal > 0.08, right: signal < -0.08 };
  }

  interface SimResult {
    steps: number; crashes: number; checkpoints: number;
    stagesAdvanced: number; finalStageIdx: number;
    finalSpeed: number; finalPosX: number; raceState: string; timeLeft: number;
  }

  function stepSim(
    steps: number,
    inputFn?: (p: typeof player, seg: { curve: number }) => { accel: boolean; brake: boolean; left: boolean; right: boolean },
  ): SimResult {
    let crashes = 0, checkpoints = 0;
    const startStageIdx = stageIdx;
    let prevCrash = player.crashing, prevCp = race.checkpointFlash;
    for (let i = 0; i < steps; i++) {
      const seg = track.segmentAt(player.position);
      const inp = inputFn ? inputFn(player, seg) : autopilotInput(player, seg);
      if (race.canDrive) {
        player.update(STEP, inp as any, track);
        updateFork();
        checkStageEnd();
        score += traffic.update(STEP, player.position, player.posX, track);
        if (!player.crashing && player.invuln <= 0) {
          if (traffic.collision(player.position, player.posX, track) || track.colliderAt(player.position, player.posX)) {
            player.crash(); race.onCrash();
          }
        }
      }
      race.update(STEP, player);
      if (player.crashing && !prevCrash) crashes++;
      if (race.checkpointFlash > 0 && prevCp <= 0) checkpoints++;
      prevCrash = player.crashing;
      prevCp = race.checkpointFlash;
      if (race.state === 'gameover') break;
    }
    return { steps, crashes, checkpoints, stagesAdvanced: stageIdx - startStageIdx,
      finalStageIdx: stageIdx, finalSpeed: player.speed, finalPosX: player.posX,
      raceState: race.state, timeLeft: race.timeLeft };
  }

  function runScenario(name: string): Record<string, unknown> {
    const resetRacing = () => {
      startRun(0);
      race.state = 'racing'; race.timeLeft = 99999; race.countdownT = 999;
      player.crashing = false; player.invuln = 0;
    };

    switch (name) {
      case 'title_to_playing': {
        startRun(0);
        return { pass: appState === 'playing', appState };
      }
      case 'drive_10s': {
        resetRacing();
        const r = stepSim(600);
        return { pass: r.crashes === 0 && r.finalSpeed > 80, ...r };
      }
      case 'checkpoint': {
        resetRacing();
        player.speed = 180;
        const r = stepSim(3600);
        return { pass: r.checkpoints >= 1, ...r };
      }
      case 'stage_advance': {
        resetRacing();
        player.speed = 180; player.invuln = 99999; // isolate geometry, not traffic
        // Budget for worst-case: car spends the whole stage at offroad speed (75 u/step)
        const stepsNeeded = Math.ceil(track.length / MAX_OFFROAD_SPEED) + 500;
        // Fork-aware driver: block rightward steer in the fork zone so forkChoice
        // stays 'left' (stage+1). Without this the autopilot drifts right, locks
        // forkChoice='right' (+2), and the delta wraps back to 0.
        const r = stepSim(stepsNeeded, (p, seg) => {
          const signal = p.posX * 3.0 - seg.curve * 0.4;
          return { accel: true, brake: false, left: signal > 0.08 || forkActive, right: !forkActive && signal < -0.08 };
        });
        return { pass: r.stagesAdvanced >= 1, ...r };
      }
      case 'gameover_flow': {
        startRun(0);
        race.state = 'racing'; race.timeLeft = 1.5;
        const r = stepSim(180);
        const wasGameover = r.raceState === 'gameover';
        if (wasGameover) appState = 'title';
        return { pass: wasGameover && appState === 'title', ...r };
      }
      case 'fork_left': {
        const r = (window as any).__outrun.forkSelfTest('left');
        return { pass: r.advanced === true, ...r };
      }
      case 'fork_right': {
        const r = (window as any).__outrun.forkSelfTest('right');
        return { pass: r.advanced === true, ...r };
      }
      case 'all_stages_clean': {
        const results: SimResult[] = [];
        for (let i = 0; i < STAGES.length; i++) {
          activateStage(i);
          race = new Race(9999, 'original'); race.state = 'racing';
          // invuln=99999: isolates road geometry collisions from traffic collisions
          player.position = 1000; player.posX = 0; player.speed = 180; player.crashing = false; player.invuln = 99999;
          const stepsNeeded = Math.ceil(track.length / (180 * 60 * STEP)) + 200;
          results.push(stepSim(stepsNeeded));
        }
        const totalCrashes = results.reduce((s, r) => s + r.crashes, 0);
        return { pass: totalCrashes === 0, totalCrashes, stages: results };
      }
      case 'snow_weather': {
        resetRacing(); activateStage(2);
        const canvases = document.querySelectorAll('canvas').length;
        return { pass: track.map.terrain === 3 && canvases >= 2, terrain: track.map.terrain, canvases };
      }
      case 'shoulder_no_cliff': {
        resetRacing(); activateStage(0);
        player.speed = 180; player.posX = 1.15;
        const r = stepSim(120);
        return { pass: r.crashes === 0 && r.finalSpeed > 70, ...r };
      }
      default:
        return { pass: false, error: `unknown scenario: ${name}` };
    }
  }

  // ---------------------------------------------------------------------------

  (window as any).__outrun = {
    player, gpu, car, trafficAtlas, probe, audio,
    get track() { return track; },
    get scenery() { return scenery; },
    get traffic() { return traffic; },
    get race() { return race; },
    get stageIdx() { return stageIdx; },
    get score() { return score; },
    get fps() { return fps; },
    get appState() { return appState; },
    get selectedMode() { return MODES[selectedMode]; },
    /** Headless: jump straight into a run. modeIndex: 0=original, 1=continuous, 2=survival */
    startRun: (modeIndex = 0) => startRun(modeIndex),
    /** Headless: advance menu from title → modeselect → playing */
    advanceMenu: () => {
      if (appState === 'title') appState = 'modeselect';
      else if (appState === 'modeselect') startRun(selectedMode);
    },
    setStage: (i: number) => { activateStage(i); player.position = 1000; player.posX = 0; },
    checkStageEnd,
    stageCount: STAGES.length,
    press: (code: string, down: boolean) =>
      dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code })),

    // --- Drivable-fork verification hooks ---
    get forkActive() { return forkActive; },
    get forkChoice() { return forkChoice; },
    get forkStartZ() { return track.forkStartZ; },
    /** Jump the player to the start of the current biome's fork zone. */
    gotoFork: () => {
      if (appState !== 'playing') startRun(selectedMode);
      player.position = track.forkStartZ + 1;
      player.posX = 0; player.speed = 120; player.crashing = false;
      updateFork();
      return { forkActive, forkStartZ: track.forkStartZ, position: player.position };
    },
    /**
     * Headless self-test: drive synchronously through the fork steering a given
     * way and report which biome results. side: 'left' | 'right'.
     * Returns { from, choice, toStage, advanced }.
     */
    forkSelfTest: (side: 'left' | 'right' = 'left') => {
      if (appState !== 'playing') startRun(selectedMode);
      const from = stageIdx;
      // place just inside the fork zone, full speed, centered
      player.position = track.forkStartZ + 1;
      player.posX = 0; player.speed = 180; player.crashing = false;
      player.invuln = 999; // ignore traffic/collisions for a clean test
      forkActive = true; forkChoice = null; forkLocked = false;
      // drive forward, steering to the requested side, until the stage flips
      let steps = 0;
      const want = side === 'left' ? -1 : 1;
      while (steps < 2000) {
        // emulate steering input by nudging posX toward the side (input not wired
        // in headless step); updateFork's pull does the rest near the split.
        player.posX += want * 0.06;
        if (player.posX > 2.2) player.posX = 2.2;
        if (player.posX < -2.2) player.posX = -2.2;
        player.update(STEP, { left: side === 'left', right: side === 'right', accel: true, brake: false } as any, track);
        updateFork();
        const before = stageIdx;
        checkStageEnd();
        steps++;
        if (stageIdx !== before) break;
      }
      return { from, choice: side, toStage: stageIdx, advanced: stageIdx !== from, steps };
    },

    // --- Automation API ---
    /** Synchronous headless simulation. inputFn overrides autopilot if provided. */
    stepSim,
    /** Run a named scenario and return structured pass/fail results. */
    scenario: runScenario,
    /** Run the full E2E test suite. Returns { total, passed, failed, results }. */
    runE2E: () => {
      const names = [
        'title_to_playing',
        'drive_10s',
        'checkpoint',
        'stage_advance',
        'gameover_flow',
        'fork_left',
        'fork_right',
        'all_stages_clean',
        'snow_weather',
        'shoulder_no_cliff',
      ];
      const results: { name: string; pass: boolean; details: Record<string, unknown> }[] = [];
      for (const name of names) {
        let details: Record<string, unknown>;
        try {
          details = runScenario(name);
        } catch (e) {
          details = { pass: false, error: String(e) };
        }
        results.push({ name, pass: !!details.pass, details });
      }
      const passed = results.filter(r => r.pass).length;
      return { total: names.length, passed, failed: names.length - passed, results };
    },
    /** Snapshot current game state (useful for quick assertions). */
    state: () => ({
      appState,
      stageIdx,
      raceState: race.state,
      speed: Math.round(player.speed * HUD_SPEED_FACTOR),
      posX: player.posX,
      crashing: player.crashing,
      timeLeft: race.timeLeft,
      score,
      terrain: track?.map?.terrain,
    }),
  };

  function drawBackground(g: Gpu, horizon: number, nextSt?: Stage | null, transitionT = 0) {
    // Transparent horizon strips (clouds / sea), bottom anchored at the ACTUAL
    // road horizon (returned by track.render) so they meet the road on hills,
    // not float over it. Alpha-blended over the sky; scroll with curve.
    const seg = track.segmentAt(player.position);
    bgScroll += seg.curve * (player.speed / 200) * 0.0015;
    // back clouds: distant, taller, slower
    sprite.quad(bgBack, 0, horizon - g.height * 0.30, g.width, g.height * 0.30, bgScroll * 0.4, 0, bgScroll * 0.4 + 1, 1);
    // front sea + islands: nearer, shorter, faster
    sprite.quad(bgFront, 0, horizon - g.height * 0.12, g.width, g.height * 0.12, bgScroll * 0.8, 0, bgScroll * 0.8 + 1, 1);
    // Cross-fade in next stage's background during zone transition
    if (nextSt && transitionT > 0) {
      sprite.quad(nextSt.bgBack,  0, horizon - g.height * 0.30, g.width, g.height * 0.30, bgScroll * 0.4, 0, bgScroll * 0.4 + 1, 1, false, transitionT);
      sprite.quad(nextSt.bgFront, 0, horizon - g.height * 0.12, g.width, g.height * 0.12, bgScroll * 0.8, 0, bgScroll * 0.8 + 1, 1, false, transitionT);
    }
  }

  function drawCar(g: Gpu) {
    const props = car.items.get(player.frameId());
    if (!props) return;
    const scale = (g.width / 1280) * 2.2;
    const w = props.w * scale, h = props.h * scale;
    const x = g.width / 2 - w / 2;
    const y = g.height * 0.9 - h;
    sprite.quad(car.texture, x, y, w, h, props.uv[0], props.uv[1], props.uv[2], props.uv[3]);
  }

  function updateMenu() {
    // Sync the menu overlay visibility and content with appState
    if (appState === 'playing') {
      menuOverlay.classList.add('hidden');
      elHud.style.visibility = '';
      return;
    }
    menuOverlay.classList.remove('hidden');
    elHud.style.visibility = 'hidden'; // hide in-race HUD during title/modeselect

    if (appState === 'title') {
      menuPrompt.textContent = 'PRESS ENTER / SPACE TO START';
      menuPrompt.classList.add('blink');
      menuModes.classList.remove('visible');
      menuModeDesc.textContent = '';
    } else {
      // modeselect
      menuPrompt.textContent = 'SELECT MODE  [ ↑↓ / W·S ]  THEN ENTER';
      menuPrompt.classList.remove('blink');
      menuModes.classList.add('visible');
      modeItems.forEach((el, i) => {
        el.classList.toggle('selected', i === selectedMode);
      });
      menuModeDesc.textContent = MODE_DESCS[MODES[selectedMode]];
    }
  }

  function updateHud() {
    elTime.textContent = String(race.displayTime);
    elScore.textContent = String(score);
    elSpeed.textContent = String(Math.round(player.speed * HUD_SPEED_FACTOR));
    elStage.textContent = String(race.stage);

    const digit = race.countdownDigit;
    if (race.state === 'gameover') {
      hudMsg.innerHTML = 'GAME OVER<div style="font-size:22px;color:#cfe9ff">press enter to return</div>';
      hudMsg.className = 'show over blink';
    } else if (digit) {
      hudMsg.textContent = digit; hudMsg.className = 'show';
    } else if (race.goFlash > 0) {
      hudMsg.textContent = 'GO!'; hudMsg.className = 'show';
    } else if (race.stageBanner > 0) {
      hudMsg.textContent = `STAGE ${race.stage}`; hudMsg.className = 'show cp';
    } else if (race.checkpointFlash > 0) {
      hudMsg.textContent = 'CHECKPOINT'; hudMsg.className = 'show cp blink';
    } else {
      hudMsg.className = '';
    }
  }

  // --- debug panel (` toggles) ---
  const panel = new DebugPanel({
    tune: player.tune,
    flags: debugFlags,
    stageCount: STAGES.length,
    state: () => ({
      fps,
      speed: `${Math.round(player.speed * HUD_SPEED_FACTOR)} km/h`,
      posX: player.posX.toFixed(2),
      posZ: Math.round(player.position),
      stage: `${race.stage} (${STAGES[stageIdx].name})`,
      app: appState,
      race: race.state,
      time: race.displayTime,
      fork: forkActive ? (forkChoice ?? '…') : 'no',
      crash: player.crashing ? 'SPIN' : (player.invuln > 0 ? `inv ${player.invuln.toFixed(1)}` : 'no'),
    }),
    actions: {
      restart: () => startRun(selectedMode),
      setStage: (i) => { activateStage(i); player.position = 1000; player.posX = 0; player.speed = 0; },
      gotoFork: () => { if (appState === 'playing') { player.position = track.forkStartZ + 1; player.posX = 0; } },
      toggleMute: () => audio.toggleMute(),
    },
  });

  // Studio Joe perf-instrumentation HUD: true windowed-avg fps, p99 low1%,
  // drops/s, frame-delivery sparkline, BUILD id, + a self-diagnosing failure
  // overlay (global error hooks). Shown alongside the tuning panel in debug mode.
  const SJHud = (window as { SJHud?: { createHud: (o: unknown) => { tick: (t: number) => void; set: (id: string, t: string) => void; panel: HTMLElement } } }).SJHud;
  const perf = SJHud?.createHud({ title: 'OutRun', build: BUILD_ID, canvas, lines: [{ id: 'game', init: '' }] });
  if (perf) perf.panel.style.display = 'none';
  addEventListener('keydown', (e) => {
    if (e.code === 'Backquote' && perf) perf.panel.style.display = perf.panel.style.display === 'none' ? '' : 'none';
  });

  function frame(now: number) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now; acc += dt;
    while (acc >= STEP) {
      if (appState === 'playing' && race.canDrive) {
        player.update(STEP, input, track);
        updateFork();
        checkStageEnd();
        if (!debugFlags.freezeTraffic) score += traffic.update(STEP, player.position, player.posX, track);
        if (!player.crashing && player.invuln <= 0 && !debugFlags.noCollision) {
          if (traffic.collision(player.position, player.posX, track) || track.colliderAt(player.position, player.posX)) {
            player.crash();
            race.onCrash(); // Survival mode: ends the run immediately
          }
        }
      }
      race.update(STEP, player);
      acc -= STEP;
    }

    // --- audio events (edge detection, once per frame is fine) ---
    audio.setEngine(player.speed, input.accel, input.brake);

    // crash rising edge
    if (player.crashing && !prevCrashing) audio.playSfx('crash');
    prevCrashing = player.crashing;

    // countdown beeps: fire on digit change
    const digit = race.countdownDigit;
    if (digit !== prevCountdownDigit && digit !== null) audio.playSfx('countdownBeep', 0.8);
    prevCountdownDigit = digit;

    // GO! rising edge
    if (race.goFlash > 0 && prevGoFlash <= 0) audio.playSfx('go', 0.9);
    prevGoFlash = race.goFlash;

    // checkpoint rising edge
    if (race.checkpointFlash > 0 && prevCheckpointFlash <= 0) {
      audio.playSfx('checkpoint');
      audio.playSfx('checkpointVoice', 0.7);
    }
    prevCheckpointFlash = race.checkpointFlash;

    if (resize(gpu)) gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });

    // Zone transition: lerp colors + cross-fade backgrounds starting at 70% of stage
    const stageProgress = track.length > 0 ? player.position / track.length : 0;
    const rawT = Math.max(0, Math.min(1, (stageProgress - 0.7) / 0.3));
    const transitionT = smoothstep(rawT);
    const nextStageForTransition = transitionT > 0
      ? ((forkChoice === 'right' ? stageIdx + 2 : stageIdx + 1) % stages.length)
      : -1;
    const nextSt = nextStageForTransition >= 0 ? stages[nextStageForTransition] : null;
    const blendedColors = nextSt ? lerpColors(stage.track.map.colors, nextSt.track.map.colors, transitionT) : undefined;

    poly.begin();
    sprite.begin();
    const horizon = track.render(poly, sprite, player.posX, player.position, player.posY, gpu.width, gpu.height, traffic.byLine(track), trafficAtlas, blendedColors);
    drawBackground(gpu, horizon, nextSt, transitionT);
    drawCar(gpu);
    sprite.upload();

    const encoder = gpu.device.createCommandEncoder();
    const view = gpu.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    });
    const startTexArr = startAtlas ? [startAtlas.texture] : [];
    poly.flush(pass);                       // sky + road (lerped colors applied)
    // Backgrounds: current at full alpha, next stage fading in during transition
    const bgTextures: typeof bgBack[] = [bgBack, bgFront];
    if (nextSt) bgTextures.push(nextSt.bgBack, nextSt.bgFront);
    sprite.flush(pass, bgTextures);
    sprite.flush(pass, [...startTexArr, scenery.texture, trafficAtlas.texture, car.texture]); // start gantry, scenery, traffic, player
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);

    frames++; fpsT += dt;
    if (fpsT >= 0.5) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
    updateHud();
    updateMenu();
    tickWeather(appState === 'playing' && track.map.terrain === 3, transitionT);
    panel.update();
    if (perf) {
      perf.tick(now);
      perf.set('game', `S${race.stage} · ${Math.round(player.speed * HUD_SPEED_FACTOR)}km/h · ${appState}`);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((e) => {
  const err = document.getElementById('err')!;
  err.style.display = 'grid';
  err.textContent = String(e?.stack || e);
  console.error(e);
});

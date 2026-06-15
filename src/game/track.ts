// Faithful pseudo-3D track renderer driven by parsed map data. Replicates
// Map::renderMap: x/dx curve accumulation, dual road bands offset by mapDistance,
// the exact layered quad sequence (grass/road/rumble/rumbleLane/lane), and
// projected roadside sprites (Line::renderSpriteInfo).

import { PolyRenderer, type RGBA } from '../gpu/polyRenderer';
import { SpriteRenderer, type SpriteTexture } from '../gpu/spriteRenderer';
import type { Atlas, TrafficAtlas } from './assets';
import type { TrafficCar } from './traffic';
import { MapData, SpritePlacement } from './mapParser';
import { ROAD_WIDTH, CAMERA_DISTANCE, CAMERA_HEIGHT, SCREEN_Y_OFFSET, SEGMENT_LENGTH, DRAW_DISTANCE } from './constants';

interface Proj { x: number; y: number; w: number; scale: number; cz: number; }

// --- Drivable fork (synthesized at the end of every biome) ---
// The last FORK_SEGMENTS segments before the end of the track are a fork zone:
// the road un-merges into two diverging branches (left curves left, right curves
// right) with grass widening between them. The player steers onto a branch; the
// branch they're on at the split point chooses the next biome. This is fully
// additive — outside the fork zone render() behaves exactly as before.
const FORK_SEGMENTS = 60;          // depth of the fork zone, in segments
const FORK_MAX_OFFSET = 1.55;      // peak half-separation of branch centers (road units)

export class Track {
  private byLine = new Map<number, SpritePlacement[]>();
  // sprite draws collected near->far, flushed far->near for correct overlap
  private spriteQueue: { tex: SpriteTexture; x: number; y: number; w: number; h: number; uv: [number, number, number, number]; flip: boolean }[] = [];

  // fork-zone world-Z window [forkStartZ, length); computed from FORK_SEGMENTS.
  readonly forkStartZ: number;
  readonly forkSplitZ: number; // Z at which the branch choice locks in

  /**
   * Optional supplementary atlas for start-line scenery (MapStartGoal sprites).
   * Looked up after `scenery` for sprite IDs not found in the primary atlas.
   * Null for all stages except stage 0.
   */
  readonly startAtlas: Atlas | null;

  /** Sprite ids whose source art is horizontally mirrored (e.g. the Map1
   *  "SLOW DOWN" right-side sign reads "MWOD WOLS") — flip them back on draw. */
  private flipIds: Set<number>;

  constructor(public map: MapData, private scenery: Atlas, startAtlas: Atlas | null = null, flipIds: Set<number> = new Set()) {
    this.flipIds = flipIds;
    for (const s of map.sprites) {
      const a = this.byLine.get(s.line) ?? [];
      a.push(s); this.byLine.set(s.line, a);
    }
    this.forkStartZ = Math.max(0, this.map.length - FORK_SEGMENTS * SEGMENT_LENGTH);
    this.forkSplitZ = this.map.length - SEGMENT_LENGTH * 2; // lock just before the end
    this.startAtlas = startAtlas;
  }

  /** 0 (fork start) .. 1 (split point) for a given world Z, else <=0 outside. */
  forkProgress(z: number): number {
    if (z < this.forkStartZ) return 0;
    const t = (z - this.forkStartZ) / Math.max(1, this.forkSplitZ - this.forkStartZ);
    return Math.max(0, Math.min(1, t));
  }
  inForkZone(z: number): boolean { return z >= this.forkStartZ && z < this.map.length; }

  /** Branch-center offset (road units) at a given fork progress for left/right. */
  private forkOffsetAt(progress: number): number {
    // ease-in so the split opens gently then widens
    const e = progress * progress;
    return FORK_MAX_OFFSET * e;
  }

  get length() { return this.map.length; }
  segmentAt(z: number) { const n = this.map.segments.length; return this.map.segments[Math.floor(z / SEGMENT_LENGTH) % n]; }

  /** True if a collider scenery sprite on the player's line overlaps posX (road units). */
  colliderAt(z: number, posX: number): boolean {
    const n = this.map.segments.length;
    const line = Math.floor(z / SEGMENT_LENGTH) % n;
    const placements = this.byLine.get(line);
    if (!placements) return false;
    const PLAYER_HALF = 0.07; // player car half-width in road units
    for (const s of placements) {
      if (!s.collider) continue;
      // Right-band sprites (side=true) live on the visually separate right road that
      // the player never drives on. Their collider flag is meaningful for traffic cars,
      // not the player. Skip them here to avoid false collisions in the median.
      if (s.side) continue;
      const props = this.scenery.items.get(s.id);
      const halfW = props ? (props.widthCollision * props.scale) / 2400 : 0.05;
      if (Math.abs(posX - s.offsetX) < halfW + PLAYER_HALF) return true;
    }
    return false;
  }
  groundY(z: number) {
    const s = this.segmentAt(z);
    const pct = (z % SEGMENT_LENGTH) / SEGMENT_LENGTH;
    return s.nearY + (s.farY - s.nearY) * pct;
  }

  private project(worldY: number, worldZ: number, cameraX: number, camHeight: number, camZ: number, w: number, h: number): Proj {
    const cz = worldZ - camZ;
    const scale = CAMERA_DISTANCE / cz;
    return {
      cz, scale,
      x: w / 2 + (scale * (0 - cameraX) * w) / 2,
      y: h / 2 - (scale * (worldY - camHeight) * h) / 2,
      w: (scale * ROAD_WIDTH * w) / 2,
    };
  }

  /** Render road + scenery (+ optional traffic). Returns the horizon screen-Y. */
  render(poly: PolyRenderer, sprite: SpriteRenderer, playerX: number, position: number, posY: number, w: number, h: number,
         trafficByLine?: Map<number, TrafficCar[]>, trafficAtlas?: TrafficAtlas): number {
    const segs = this.map.segments;
    const N = segs.length;
    const base = this.segmentAt(position);
    const basePct = (position % SEGMENT_LENGTH) / SEGMENT_LENGTH;
    const camHeight = CAMERA_HEIGHT + posY;
    const mapDistance = base.distance;
    const C = this.map.colors;
    this.spriteQueue.length = 0;

    // sky
    poly.rect(0, 0, w, h, C.sky);

    let difX = -(base.curve * basePct);
    let sumX = 0;
    let maxY = h;
    const camZ = position;
    const px = playerX * ROAD_WIDTH;
    // The original shifts every projected Y down by SCREEN_Y_OFFSET (road quads
    // AND sprites). Scale it by resolution so road + sprites stay planted at any
    // canvas size (reference art was authored at ~720p).
    const sy = SCREEN_Y_OFFSET * (h / 720);

    for (let n = 0; n < DRAW_DISTANCE; n++) {
      const idx = (base.index + n) % N;
      const l = segs[idx];
      const looped = idx < base.index;
      const cz = looped ? camZ - this.length : camZ;
      const zNear = l.index * SEGMENT_LENGTH;
      const zFar = (l.index + 1) * SEGMENT_LENGTH;

      // Fork divergence (road units) at this segment's near/far Z. 0 outside the
      // fork zone, so everything below collapses to the original single road.
      const fNear = this.forkProgress(zNear);
      const fFar = this.forkProgress(zFar);
      const offNear = this.forkOffsetAt(fNear) * ROAD_WIDTH;
      const offFar = this.forkOffsetAt(fFar) * ROAD_WIDTH;
      const forking = offFar > 1;

      // lower road band (near = left point, far = right point)
      const p1 = this.project(l.nearY, zNear, px - sumX, camHeight, cz, w, h); p1.y += sy;
      const p2 = this.project(l.farY, zFar, px - sumX - difX, camHeight, cz, w, h); p2.y += sy;
      // upper road band (offset by mapDistance; non-mirror only for M2)
      const u1 = this.project(l.nearY, zNear, px - sumX - mapDistance, camHeight, cz, w, h); u1.y += sy;
      const u2 = this.project(l.farY, zFar, px - sumX - difX - mapDistance, camHeight, cz, w, h); u2.y += sy;

      sumX += difX;
      difX += l.curve;

      if (p1.cz <= CAMERA_DISTANCE || p2.y >= maxY) continue;

      const light = l.light;
      const sand = light ? C.sand1 : C.sand2;
      const road = light ? C.road1 : C.road2;
      const rumble = light ? C.rumble1 : C.rumble2;
      const lane = light ? C.lane1 : C.lane2;
      const rumbleLane = light ? C.rumbleLane1 : C.rumbleLane2;

      // Grass fills down to the previous band's top (maxY) so hill-crest gaps
      // never reveal the sky behind the road — they show ground instead.
      const gB = Math.max(p1.y, maxY);
      poly.quad(0, gB, w, gB, w, p2.y, 0, p2.y, sand);

      if (forking) {
        // FORK: render TWO diverging branches with grass (already drawn) between.
        // Left branch shifts toward -offset, right toward +offset; the gap widens
        // with progress. We deliberately do NOT draw the continuous union quad,
        // so a real sand/grass median appears between the two roads.
        const lL1 = this.project(l.nearY, zNear, px - sumX + offNear, camHeight, cz, w, h); lL1.y += sy;
        const lL2 = this.project(l.farY, zFar, px - sumX - difX + offFar, camHeight, cz, w, h); lL2.y += sy;
        const rR1 = this.project(l.nearY, zNear, px - sumX - offNear, camHeight, cz, w, h); rR1.y += sy;
        const rR2 = this.project(l.farY, zFar, px - sumX - difX - offFar, camHeight, cz, w, h); rR2.y += sy;
        // each branch is a normal road band (road base + rumble + lanes)
        poly.quad(lL1.x - lL1.w, lL1.y, lL1.x + lL1.w, lL1.y, lL2.x + lL2.w, lL2.y, lL2.x - lL2.w, lL2.y, road);
        poly.quad(rR1.x - rR1.w, rR1.y, rR1.x + rR1.w, rR1.y, rR2.x + rR2.w, rR2.y, rR2.x - rR2.w, rR2.y, road);
        this.drawBands(poly, lL1, lL2, road, rumble, rumbleLane, lane, sand, w, -1);
        this.drawBands(poly, rR1, rR2, road, rumble, rumbleLane, lane, sand, w, -1);

        const placements = this.byLine.get(l.index);
        if (placements) for (const s of placements) this.queueSprite(s, s.side ? rR1 : lL1, maxY, w);
        if (trafficByLine && trafficAtlas) {
          const cars = trafficByLine.get(l.index);
          if (cars) for (const c of cars) this.queueTraffic(c, p1, p2, maxY, w, trafficAtlas);
        }
        maxY = p2.y;
        continue;
      }

      // Draw each road band separately — median between bands shows sand color
      // (matches reference which draws two distinct bands, not a continuous span).
      this.drawBands(poly, p1, p2, road, rumble, rumbleLane, lane, sand, w, -1);
      this.drawBands(poly, u1, u2, road, rumble, rumbleLane, lane, sand, w, -1);

      // collect sprites on this line (project against the lower/near reference)
      const placements = this.byLine.get(l.index);
      if (placements) for (const s of placements) this.queueSprite(s, s.side ? u1 : p1, maxY, w);

      // collect traffic cars on this line (interpolated within the segment)
      if (trafficByLine && trafficAtlas) {
        const cars = trafficByLine.get(l.index);
        if (cars) for (const c of cars) this.queueTraffic(c, p1, p2, maxY, w, trafficAtlas);
      }

      maxY = p2.y;
    }

    // flush sprites far -> near (queue was filled near -> far)
    for (let k = this.spriteQueue.length - 1; k >= 0; k--) {
      const q = this.spriteQueue[k];
      sprite.quad(q.tex, q.x, q.y, q.w, q.h, q.uv[0], q.uv[1], q.uv[2], q.uv[3], q.flip);
    }
    return maxY; // horizon line (topmost drawn road point)
  }

  // The original's layered draw: grass full-width, road, rumble (wider), rumbleLane
  // band, inset road, two lane stripes. `drawGrass` only on the first (lower) band.
  private drawBands(poly: PolyRenderer, p1: Proj, p2: Proj, road: RGBA, rumble: RGBA, rumbleLane: RGBA, lane: RGBA, sand: RGBA, w: number, grassBottom: number) {
    const x1 = p1.x, y1 = p1.y, w1 = p1.w;
    const x2 = p2.x, y2 = p2.y, w2 = p2.w;
    const q = (xa: number, xb: number, xc: number, xd: number, c: RGBA) =>
      poly.quad(xa, y1, xb, y1, xc, y2, xd, y2, c);

    // grass spans full width from the (gap-filling) bottom up to this band's top
    if (grassBottom >= 0) poly.quad(0, grassBottom, w, grassBottom, w, y2, 0, y2, sand);

    // road
    q(x1 - w1, x1 + w1, x2 + w2, x2 - w2, road);
    // rumble strips (wider than road)
    const r1 = w1 / 7, r2 = w2 / 7;
    q(x1 - w1 - r1, x1 + w1 + r1, x2 + w2 + r2, x2 - w2 - r2, rumble);
    // rumble-lane band over road width
    q(x1 - w1, x1 + w1, x2 + w2, x2 - w2, rumbleLane);
    // inset road (leaves a thin rumble strip at the very edge)
    const i1 = w1 / 18, i2 = w2 / 18;
    q(x1 - w1 + i1, x1 + w1 - i1, x2 + w2 - i2, x2 - w2 + i2, road);
    // lane stripes
    const t1 = (w1 * 16) / 27, t2 = (w2 * 16) / 27;
    q(x1 - w1 + i1 + t1, x1 + w1 - i1 - t1, x2 + w2 - i2 - t2, x2 - w2 + i2 + t2, lane);
    q(x1 - w1 + i1 * 2 + t1, x1 + w1 - i1 * 2 - t1, x2 + w2 - i2 * 2 - t2, x2 - w2 + i2 * 2 + t2, road);
  }

  // Traffic car: interpolate position within the segment (near p1 -> far p2),
  // size like a scenery sprite but pivot center-bottom and use the car's scale.
  private queueTraffic(c: TrafficCar, p1: Proj, p2: Proj, clip: number, w: number, atlas: TrafficAtlas) {
    const props = atlas.frames.get(c.frameKey());
    if (!props) return;
    const perc = ((c.posZ % SEGMENT_LENGTH) + SEGMENT_LENGTH) % SEGMENT_LENGTH / SEGMENT_LENGTH;
    const scale = p1.scale + (p2.scale - p1.scale) * perc;
    const xOff = p1.x + (p2.x - p1.x) * perc;
    const yOff = p1.y + (p2.y - p1.y) * perc;
    if (scale <= 0) return;
    const cScale = atlas.scale.get(c.carId) ?? 1;
    const spriteX = xOff + c.offset * scale * ROAD_WIDTH * w / 2;
    const k = (0.3 * (1 / 170)) * ROAD_WIDTH;
    const destW = props.w * scale * (w / 2) * k;
    let destH = props.h * scale * (w / 2) * k;

    let cropPerc = 1;
    let spriteY = yOff;
    if (clip < spriteY) {
      const full = destH * 3.43 * cScale;
      cropPerc = Math.max(5, clip - (spriteY - full)) / full;
      spriteY = clip; destH *= cropPerc;
    }
    if (cropPerc <= 0) return;
    const FW = destW * 3.2 * cScale, FH = destH * 3.43 * cScale;
    const [u0, v0, u1v, v1] = props.uv;
    this.spriteQueue.push({
      tex: atlas.texture, x: spriteX - FW * 0.5, y: spriteY - FH,
      w: FW, h: FH, uv: [u0, v0, u1v, v0 + (v1 - v0) * cropPerc], flip: false,
    });
  }

  private queueSprite(s: SpritePlacement, p: Proj, clip: number, w: number) {
    // Primary atlas lookup; fall back to supplementary start atlas for IDs not in main scenery.
    let props = this.scenery.items.get(s.id);
    let atlas = this.scenery;
    if (!props && this.startAtlas) {
      props = this.startAtlas.items.get(s.id);
      atlas = this.startAtlas;
    }
    if (!props) return;
    const texW = props.w, texH = props.h, sScale = props.scale;
    const spriteX = p.x + s.offsetX * p.scale * ROAD_WIDTH * w / 2;
    let spriteY = p.y + s.offsetY * p.scale * 1000 * w / 2;

    const k = (0.3 * (1 / 170)) * ROAD_WIDTH;
    const destW = texW * p.scale * (w / 2) * k;
    let destH = texH * p.scale * (w / 2) * k;

    // elevation clip: crop the bottom of the sprite that dips below the horizon
    let cropPerc = 1;
    if (clip < spriteY) {
      const full = destH * 3.43 * sScale;
      const clipH = Math.max(5, clip - (spriteY - full));
      cropPerc = clipH / full;
      spriteY = clip;
      destH *= cropPerc;
    }
    if (cropPerc <= 0) return;

    const FW = destW * 3.2 * sScale;
    const FH = destH * 3.43 * sScale;
    const pivot = s.offsetX >= 0 ? props.pivotRight : props.pivotLeft;
    const topX = spriteX - FW * pivot[0];
    // p.y already includes the screen-Y offset (added in render), so the sprite
    // base sits exactly on the road point — planting it to the surface.
    const topY = spriteY - FH * pivot[1];

    // crop keeps the TOP of the texture (bottom hidden behind terrain)
    const [u0, v0, u1, v1] = props.uv;
    const uv: [number, number, number, number] = [u0, v0, u1, v0 + (v1 - v0) * cropPerc];
    this.spriteQueue.push({ tex: atlas.texture, x: topX, y: topY, w: FW, h: FH, uv, flip: this.flipIds.has(s.id) });
  }
}

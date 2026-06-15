// Traffic cars: spawn ahead, drive, despawn behind (scoring on overtake), with
// three AI behaviours from the reference (PACIFIC / EVASIVE / OBSTACLE). Uses
// wrapped Z-distance rather than raw line indices so it's correct on the looping
// track. See OutRun-reference TrafficCar.cpp + Map::updateCars.

import type { Track } from './track';
import { SEGMENT_LENGTH, SCORE_TRAFFIC_BONUS } from './constants';

const DRAW_DISTANCE = 200;
const MIN_DIST_Y_SEG = 20;          // "near" threshold in segments (MINIMUM_DISTANCE_Y)
const VISIBLE_Z = DRAW_DISTANCE * SEGMENT_LENGTH; // how far ahead cars activate
// lateral overlap threshold in road units (player ~0.15 half + car ~0.2 half + margin)
const COLLISION_X = 0.38;

export const enum Ai { PACIFIC = 1, EVASIVE = 2, OBSTACLE = 3 }

// deterministic-ish RNG seeded per index (no Math.random in this codebase's spirit)
let rngState = 0x2545f491;
function rnd() { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; }
const randInt = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

export class TrafficCar {
  posZ = 0;
  offset = 0;        // road units, -0.9..0.9
  speed = 0;         // units/frame@60
  active = false;
  ai: Ai = Ai.PACIFIC;
  carId: number;     // which art (1..8)
  dirRight = true;   // facing: true=TURNRIGHT
  elevation: -1 | 0 | 1 = 0; // down/flat/up
  playerClosed = false;
  private pathSelected = -1;
  private offsetDest = -1000;
  private timeToReturn = 0;
  animPhase = 0;     // 0/1 two-frame cycle
  private animT = 0;

  constructor(carId: number) { this.carId = carId; }

  /** Worldspace X (road units == offset here; forks would add mapDistance). */
  get posX() { return this.offset; }

  tickAnim(dt: number) {
    this.animT += dt;
    if (this.animT >= 2 / 60) { this.animT = 0; if (this.speed > 0) this.animPhase ^= 1; }
  }

  /** Atlas frame key (carId*100 + frame 1..16) from elevation/direction/proximity. */
  frameKey(): number {
    const a = this.animPhase;
    let base: number;
    if (this.elevation === 1) base = this.dirRight ? 5 : 7;        // UP
    else if (this.elevation === -1) base = this.dirRight ? 9 : 11; // DOWN
    else if (this.playerClosed) base = this.dirRight ? 1 : 3;      // FLAT near
    else base = this.dirRight ? 13 : 15;                           // FLAT far
    return this.carId * 100 + base + a;
  }

  // EVASIVE / OBSTACLE lateral movement toward an edge / the player's lane.
  ai_move(playerOffsetX: number, near: boolean, step: number) {
    if (this.ai === Ai.EVASIVE && near) {
      if (this.pathSelected === -1) {
        const distLeft = this.offset + 0.9, distRight = 0.9 - this.offset;
        this.pathSelected = distLeft > distRight ? 0 : distLeft < distRight ? 1 : randInt(0, 1);
        this.offsetDest = this.pathSelected === 0 ? Math.max(-0.9, this.offset - 0.5) : Math.min(0.9, this.offset + 0.5);
      } else if (this.pathSelected === 0) {
        if (this.offset > this.offsetDest) { this.offset -= step; if (this.offset <= this.offsetDest) this.reachedDest(); }
      } else {
        if (this.offset < this.offsetDest) { this.offset += step; if (this.offset >= this.offsetDest) this.reachedDest(); }
      }
    } else if (this.ai === Ai.OBSTACLE && near) {
      // drift toward the player's lane to block
      if (this.offset < playerOffsetX) this.offset = Math.min(0.9, this.offset + step);
      else if (this.offset > playerOffsetX) this.offset = Math.max(-0.9, this.offset - step);
    }
  }
  private reachedDest() {
    this.offset = this.offsetDest; this.offsetDest = -1000;
    if (this.timeToReturn < 200) this.timeToReturn++;
    else { this.timeToReturn = 0; this.pathSelected = -1; }
  }
}

export class TrafficManager {
  cars: TrafficCar[] = [];
  private startAi = 0;

  constructor(carIds: number[], count: number, trackLen: number) {
    for (let i = 0; i < count; i++) {
      const c = new TrafficCar(carIds[i % carIds.length]);
      c.active = false;
      c.offset = randInt(-6, 6) * 0.15;
      // spread initial positions ahead of the start
      c.posZ = ((150 + i * 7) * SEGMENT_LENGTH) % trackLen;
      this.cars.push(c);
    }
  }

  /** Advance traffic; returns score gained from overtakes this step. */
  update(dt: number, playerZ: number, playerOffsetX: number, track: Track): number {
    const L = track.length;
    const step60 = dt * 60;
    const wrap = (dz: number) => { dz %= L; if (dz > L / 2) dz -= L; if (dz < -L / 2) dz += L; return dz; };
    let score = 0;

    for (const c of this.cars) {
      let dz = wrap(c.posZ - playerZ);
      // advance only while reasonably near the player (matches drawDistance*8)
      if (Math.abs(dz) <= VISIBLE_Z * 8) c.posZ = (c.posZ + c.speed * step60) % L;
      dz = wrap(c.posZ - playerZ);

      const seg = track.segmentAt(((c.posZ % L) + L) % L);
      c.elevation = seg.farY > seg.nearY + 1 ? 1 : seg.farY < seg.nearY - 1 ? -1 : 0;

      if (!c.active) {
        if (dz > 0 && dz < VISIBLE_Z) {            // entered the visible zone ahead
          c.active = true;
          c.speed = randInt(10, 16) * 10;          // 100..160, same units/frame@60 scale as the player
          this.startAi = this.startAi >= 3 ? 1 : this.startAi + 1; // cycle 1,2,3
          c.ai = this.startAi as Ai;
        }
      } else {
        if (dz <= 0 || dz > VISIBLE_Z) {            // fell behind or out of range
          if (dz <= 0) score += SCORE_TRAFFIC_BONUS; // overtaken
          c.active = false; c.speed = 0;
          c.offset = randInt(-6, 6) * 0.15;
          c.posZ = (c.posZ + randInt(5, 11) * 100 * SEGMENT_LENGTH) % L; // respawn far ahead
        }
      }

      const near = Math.abs(dz) <= MIN_DIST_Y_SEG * SEGMENT_LENGTH;
      c.playerClosed = dz > 0 && dz < MIN_DIST_Y_SEG * SEGMENT_LENGTH;
      c.dirRight = !(c.offset > playerOffsetX); // posX>player → TURNLEFT else TURNRIGHT
      if (c.active) c.ai_move(playerOffsetX, near, 0.005 * step60);
      c.tickAnim(dt);
    }
    return score;
  }

  /** Active cars indexed by their current line for the renderer. */
  byLine(track: Track): Map<number, TrafficCar[]> {
    const L = track.length, m = new Map<number, TrafficCar[]>();
    for (const c of this.cars) {
      if (!c.active) continue;
      const line = Math.floor((((c.posZ % L) + L) % L) / SEGMENT_LENGTH);
      const a = m.get(line) ?? []; a.push(c); m.set(line, a);
    }
    return m;
  }

  /** First active car colliding with the player (same segment, overlapping X). */
  collision(playerZ: number, playerOffsetX: number, track: Track): TrafficCar | null {
    const L = track.length;
    for (const c of this.cars) {
      if (!c.active) continue;
      let dz = (c.posZ - playerZ) % L; if (dz > L / 2) dz -= L; if (dz < -L / 2) dz += L;
      if (Math.abs(dz) < SEGMENT_LENGTH && Math.abs(playerOffsetX - c.offset) < COLLISION_X) return c;
    }
    return null;
  }
}


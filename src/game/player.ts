// Player car state + handling. Speed/accel constants are the reference's; the
// steering/centrifugal feel is exposed on window.__tune for live tuning, then
// baked once it feels right (per the project's tuning-controls workflow).

import type { Input } from './input';
import {
  LOW_ACCEL, BRAKE_ACCEL, COAST_FACTOR, MAX_HIGH_SPEED, MAX_OFFROAD_SPEED,
} from './constants';

/** Minimal road surface the player queries (satisfied by both Road and Track). */
export interface RoadLike {
  length: number;
  segmentAt(z: number): { curve: number };
  groundY(z: number): number;
}

export interface Tune {
  steer: number;        // road-units/sec of lateral movement at full speed
  centrifugal: number;  // how hard curves push the car outward
  offroadDecel: number; // extra decel multiplier off the asphalt
  accelScale: number;   // multiplier on acceleration
  brakeScale: number;   // multiplier on braking
}

declare global { interface Window { __tune: Tune; } }

export class Player {
  posX = 0;     // road units; 0 = centerline, |x|>1 = off the asphalt
  posY = 0;     // ground height under the car (for rendering)
  position = 0; // world Z along the track
  speed = 0;    // units/frame@60 (matches reference scale; *60 = units/sec)
  dir = 0;      // -1 left, 0 straight, 1 right (for sprite selection)
  crashing = false;
  invuln = 0;   // post-crash grace (seconds) — ignore collisions so you can drive off
  private animT = 0;
  private crashT = 0;
  private crashDur = 0;
  private crashSpin = 1; // spin direction

  // steer MUST be able to beat centrifugal (peak curve 3.5 × speedFactor 1.67 ×
  // centrifugal) or the player gets flung off curves and can't hold a line.
  readonly tune: Tune = { steer: 3.6, centrifugal: 0.5, offroadDecel: 2.5, accelScale: 1, brakeScale: 1 };

  constructor() { window.__tune = this.tune; }

  get offRoad() { return Math.abs(this.posX) > 1; }

  /** Trigger a crash/spin-out (no-op if already crashing). */
  crash() {
    if (this.crashing) return;
    this.crashing = true;
    this.crashT = 0;
    // faster = longer spin (reference scales collision laps by speed)
    const laps = this.speed <= 20 ? 1 : this.speed <= 60 ? 2 : this.speed <= 120 ? 3 : 4;
    this.crashDur = 0.5 + laps * 0.28;
    this.crashSpin = this.posX >= 0 ? 1 : -1;
  }

  update(dt: number, input: Input, road: RoadLike) {
    // --- crash / spin-out: lose control, bleed speed, wobble, then recover ---
    if (this.crashing) {
      this.crashT += dt;
      this.animT += dt;
      this.speed = Math.max(0, this.speed - BRAKE_ACCEL * 1.3 * dt);
      this.position += this.speed * 60 * dt; // unbounded; stage manager handles end-of-track
      this.posX += this.crashSpin * Math.sin(this.crashT * 22) * 0.5 * dt;
      this.posX = Math.max(-2.2, Math.min(2.2, this.posX));
      this.posY = road.groundY(this.position);
      if (this.crashT >= this.crashDur) { this.crashing = false; this.invuln = 1.6; }
      return;
    }

    if (this.invuln > 0) this.invuln -= dt;

    // Soft shoulder: speed cap eases in from full→off-road across posX [1.0, 1.3].
    // Hard cliff at 1.0 felt unfair — this gives a noticeable but gentler warning zone.
    const absX = Math.abs(this.posX);
    const t = Math.max(0, Math.min(1, (absX - 1.0) / 0.3));
    const maxSpeed = MAX_HIGH_SPEED - (MAX_HIGH_SPEED - MAX_OFFROAD_SPEED) * t * t;

    // longitudinal
    if (input.accel) this.speed += LOW_ACCEL * this.tune.accelScale * dt;
    else if (input.brake) this.speed -= BRAKE_ACCEL * this.tune.brakeScale * dt;
    else this.speed -= LOW_ACCEL * COAST_FACTOR * dt;

    if (this.offRoad && this.speed > maxSpeed) {
      this.speed -= LOW_ACCEL * this.tune.offroadDecel * dt;
    }
    this.speed = Math.max(0, Math.min(this.speed, maxSpeed));

    // advance along track (speed is per-frame@60, so *60 for per-second).
    // Position is unbounded; the stage manager wraps it on stage transitions.
    const speedPct = this.speed / MAX_HIGH_SPEED;
    this.position += this.speed * 60 * dt;

    // steering — only effective while moving
    const dir = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    this.dir = dir;
    this.animT += dt;
    this.posX += dir * speedPct * this.tune.steer * dt;

    // centrifugal force from the current curve
    const seg = road.segmentAt(this.position);
    const centri = this.speed >= 100 ? (this.speed - 50) / 90 : (this.speed > 26 ? 0.5 : 0);
    this.posX -= seg.curve * Math.min(speedPct, 1) * centri * this.tune.centrifugal * dt;

    this.posX = Math.max(-2.2, Math.min(2.2, this.posX));
    this.posY = road.groundY(this.position);
  }

  /**
   * Player car sprite id (1-based, accelerating flat frames).
   * 1-4 front, 5-12 left, 13-20 right (reference frame layout). 2-frame anim.
   */
  frameId(): number {
    if (this.crashing) {
      // spin frames: 121-128 (L->R) cycle, then 129-133 (recover/anger)
      const t = this.crashT / this.crashDur;
      if (t < 0.7) return 121 + (Math.floor(this.crashT * 16) % 8); // spinning
      return 129 + Math.min(4, Math.floor((t - 0.7) / 0.3 * 5));    // settle
    }
    const a = Math.floor(this.animT * 8) % 2; // 0/1 alternation
    if (this.dir < 0) return 9 + a;   // left hold
    if (this.dir > 0) return 17 + a;  // right hold
    return 1 + a;                     // front
  }
}

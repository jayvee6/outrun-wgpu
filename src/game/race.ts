// Race loop: start countdown → racing (timer counts down, checkpoints extend it)
// → game over when the clock hits zero. Models the OutRun checkpoint mechanic on
// the looping track via accumulated distance (a checkpoint every interval).

import type { Player } from './player';

export type RaceState = 'countdown' | 'racing' | 'gameover';
/** Game mode: Original and Continuous share current behavior; Survival ends the run on any crash. */
export type GameMode = 'original' | 'continuous' | 'survival';

const COUNTDOWN = 3.5;                 // 3 · 2 · 1 · GO!
const CONTINUOUS_FACTOR = 0.52;        // time added per checkpoint (MULTI_FACTOR_CONTINUOUS_MODE)
const CHECKPOINT_INTERVAL = 120_000;   // world units between checkpoints (~12s at top speed)

export class Race {
  state: RaceState = 'countdown';
  timeLeft: number;
  stage = 1;
  countdownT = 0;
  goFlash = 0;          // "GO!" banner timer
  checkpointFlash = 0;  // "CHECKPOINT" banner timer
  stageBanner = 0;      // "STAGE N" banner timer (set on biome transition)
  readonly mode: GameMode;
  private dist = 0;     // accumulated distance travelled
  private nextCp = CHECKPOINT_INTERVAL;

  stageFlash() { this.stageBanner = 2.0; }

  constructor(private mapTime: number, mode: GameMode = 'original') {
    this.timeLeft = mapTime;
    this.mode = mode;
  }

  /** Call from the crash handler in main; in Survival mode, ends the run immediately. */
  onCrash() {
    if (this.mode === 'survival' && this.state === 'racing') {
      this.state = 'gameover';
    }
  }

  get canDrive() { return this.state === 'racing'; }
  /** Whole-seconds digit shown on the clock. */
  get displayTime() { return Math.max(0, Math.ceil(this.timeLeft)); }

  update(dt: number, player: Player) {
    if (this.goFlash > 0) this.goFlash -= dt;
    if (this.checkpointFlash > 0) this.checkpointFlash -= dt;
    if (this.stageBanner > 0) this.stageBanner -= dt;

    if (this.state === 'countdown') {
      this.countdownT += dt;
      if (this.countdownT >= COUNTDOWN) { this.state = 'racing'; this.goFlash = 1.2; }
      return;
    }
    if (this.state !== 'racing') return;

    // tick the clock
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; this.state = 'gameover'; return; }

    // checkpoint: extend time when enough distance has been covered
    this.dist += player.speed * 60 * dt;
    if (this.dist >= this.nextCp) {
      this.nextCp += CHECKPOINT_INTERVAL;
      this.timeLeft += Math.round(this.mapTime * CONTINUOUS_FACTOR);
      this.checkpointFlash = 2.0; // extends time; stage advances on biome change
    }
  }

  /** Countdown digit ("3"/"2"/"1") or null once racing. */
  get countdownDigit(): string | null {
    if (this.state !== 'countdown') return null;
    const remaining = COUNTDOWN - 0.5 - this.countdownT; // last 0.5s reserved for the flip to GO
    if (remaining > 2) return '3';
    if (remaining > 1) return '2';
    if (remaining > 0) return '1';
    return null;
  }
}

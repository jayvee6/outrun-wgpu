// Web Audio sound system for the OutRun reimplementation.
// Mirrors the Sfx enum from the reference Audio.cpp:
//   engine loop + pitch modulation, one-shot SFX, looping OST.
// Gracefully no-ops if AudioContext / decode fails.

const SFX_BASE = '/assets/audio/sfx/';
const MUSIC_BASE = '/assets/audio/music/';

const SFX_FILES: Record<string, string> = {
  engineRun:       'Ferrari_Engine_Run.ogg',
  engineBrake:     'Ferrari_Engine_Brake.ogg',
  gearUp:          'Ferrari_Engine_Up_Gear.ogg',
  gearDown:        'Ferrari_Engine_Down_Gear.ogg',
  skid:            'Ferrari_Engine_Skidding.ogg',
  crash:           'Ferrari_Crash.ogg',
  checkpoint:      'Checkpoint_Alarm.ogg',
  checkpointVoice: 'Checkpoint_Voice_First.ogg',
  countdownBeep:   'Race_Semaphore_Prepare.ogg',
  go:              'Race_Semaphore_Start.ogg',
  claxon0:         'Traffic_First_Claxon.ogg',
  claxon1:         'Traffic_Second_Claxon.ogg',
  claxon2:         'Traffic_Third_Claxon.ogg',
  claxon3:         'Traffic_Fourth_Claxon.ogg',
};

const MUSIC_TRACKS: Record<string, string> = {
  Magical_Sound_Shower: 'Magical_Sound_Shower.ogg',
  Passing_Breeze:       'Passing_Breeze.ogg',
  Splash_Wave:          'Splash_Wave.ogg',
};

export class AudioManager {
  ctx: AudioContext | null = null;
  loaded = false;

  private masterGain: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();

  // engine loop nodes
  private engineNode: AudioBufferSourceNode | null = null;
  private engineGain: GainNode | null = null;

  // music nodes
  private musicNode: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;
  private currentTrack = '';

  private muted = false;
  private volume = 1;

  /** Call on page load (fire-and-forget). Silently fails if AudioContext unavailable. */
  async init(): Promise<void> {
    try {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.ctx.destination);

      // Decode all SFX and OST buffers up front.
      const entries: [string, string][] = [
        ...Object.entries(SFX_FILES).map<[string, string]>(([k, f]) => [k, SFX_BASE + f]),
        ...Object.entries(MUSIC_TRACKS).map<[string, string]>(([k, f]) => [k, MUSIC_BASE + f]),
      ];
      await Promise.all(entries.map(([key, url]) => this._load(key, url)));

      this.loaded = true;
    } catch (e) {
      console.warn('[audio] init failed — running silently', e);
    }
  }

  private async _load(key: string, url: string): Promise<void> {
    try {
      const resp = await fetch(url);
      const ab = await resp.arrayBuffer();
      const buf = await this.ctx!.decodeAudioData(ab);
      this.buffers.set(key, buf);
    } catch (e) {
      console.warn(`[audio] failed to decode ${url}`, e);
    }
  }

  /** Resume AudioContext — MUST be called from a user gesture (first keydown). */
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Engine loop
  // ---------------------------------------------------------------------------

  /** Start the looping engine sound. Safe to call multiple times (idempotent). */
  startEngine(): void {
    if (!this.ctx || !this.loaded || this.engineNode) return;
    const buf = this.buffers.get('engineRun');
    if (!buf) return;

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.4;
    this.engineGain.connect(this.masterGain!);

    this.engineNode = this.ctx.createBufferSource();
    this.engineNode.buffer = buf;
    this.engineNode.loop = true;
    this.engineNode.connect(this.engineGain);
    this.engineNode.start();
  }

  /**
   * Call every frame. Modulates engine pitch/volume by speed/accel/brake.
   * speed: 0..200 (player.speed units), accel/brake: booleans from input.
   */
  setEngine(speed: number, _accel: boolean, braking: boolean): void {
    if (!this.ctx || !this.engineNode || !this.engineGain) return;
    // pitch: idle at 0.6, full speed at 2.0
    const t = Math.max(0, Math.min(1, speed / 200));
    const rate = braking ? 0.55 + t * 0.6 : 0.6 + t * 1.4;
    this.engineNode.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.05);

    // volume: quiet at standstill, full when moving
    const vol = speed < 5 ? 0.18 : 0.35 + t * 0.25;
    this.engineGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.08);
  }

  stopEngine(): void {
    if (this.engineNode) {
      try { this.engineNode.stop(); } catch (_) { /* already stopped */ }
      this.engineNode.disconnect();
      this.engineNode = null;
    }
    if (this.engineGain) { this.engineGain.disconnect(); this.engineGain = null; }
  }

  // ---------------------------------------------------------------------------
  // One-shot SFX
  // ---------------------------------------------------------------------------

  /** Play a named one-shot sound (crash, gearUp, gearDown, skid, claxon, checkpoint, countdownBeep, go). */
  playSfx(name: string, volume = 1): void {
    if (!this.ctx || !this.loaded) return;
    const buf = this.buffers.get(name);
    if (!buf) return;
    try {
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      gain.connect(this.masterGain!);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      src.onended = () => { gain.disconnect(); };
      src.start();
    } catch (e) {
      console.warn(`[audio] playSfx(${name}) failed`, e);
    }
  }

  /** Play one of the 4 traffic claxon sounds, cycling through them. */
  private _claxonIdx = 0;
  playClaxon(): void {
    this.playSfx(`claxon${this._claxonIdx % 4}`, 0.7);
    this._claxonIdx++;
  }

  // ---------------------------------------------------------------------------
  // Music
  // ---------------------------------------------------------------------------

  /** Start looping an OST track (key = Magical_Sound_Shower | Passing_Breeze | Splash_Wave). */
  playMusic(trackKey: string): void {
    if (!this.ctx || !this.loaded) return;
    if (trackKey === this.currentTrack && this.musicNode) return; // already playing
    this._stopMusic();

    const buf = this.buffers.get(trackKey);
    if (!buf) return;

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.35;
    this.musicGain.connect(this.masterGain!);

    this.musicNode = this.ctx.createBufferSource();
    this.musicNode.buffer = buf;
    this.musicNode.loop = true;
    this.musicNode.connect(this.musicGain);
    this.musicNode.start();
    this.currentTrack = trackKey;
  }

  private _stopMusic(): void {
    if (this.musicNode) {
      try { this.musicNode.stop(); } catch (_) { /* already stopped */ }
      this.musicNode.disconnect();
      this.musicNode = null;
    }
    if (this.musicGain) { this.musicGain.disconnect(); this.musicGain = null; }
    this.currentTrack = '';
  }

  // ---------------------------------------------------------------------------
  // Volume / mute
  // ---------------------------------------------------------------------------

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain) {
      this.masterGain.gain.value = muted ? 0 : this.volume;
    }
  }

  toggleMute(): void { this.setMuted(!this.muted); }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && !this.muted) this.masterGain.gain.value = this.volume;
  }
}

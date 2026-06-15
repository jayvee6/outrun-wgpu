// In-game debug UI: live handling sliders, state readouts, toggles, and
// stage/fork jump buttons. Toggle with the backtick (`) key. Pure DOM, built at
// runtime so it adds no markup to index.html.

import type { Tune } from './player';

export interface DebugFlags { noCollision: boolean; freezeTraffic: boolean; }

export interface DebugHooks {
  tune: Tune;
  flags: DebugFlags;
  state: () => Record<string, string | number>;
  actions: { restart: () => void; setStage: (i: number) => void; gotoFork: () => void; toggleMute: () => void };
  stageCount: number;
}

interface SliderCfg { key: keyof Tune; label: string; min: number; max: number; step: number; }
const SLIDERS: SliderCfg[] = [
  { key: 'steer', label: 'Steer', min: 0, max: 8, step: 0.1 },
  { key: 'centrifugal', label: 'Centrifugal', min: 0, max: 2, step: 0.05 },
  { key: 'offroadDecel', label: 'Off-road decel', min: 0, max: 6, step: 0.1 },
  { key: 'accelScale', label: 'Accel ×', min: 0.2, max: 4, step: 0.1 },
  { key: 'brakeScale', label: 'Brake ×', min: 0.2, max: 4, step: 0.1 },
];

const CSS = `
#dbg { position: fixed; top: 10px; right: 10px; width: 250px; z-index: 50;
  font: 11px/1.5 ui-monospace, Menlo, monospace; color: #d8f5ff; pointer-events: auto;
  background: rgba(8,14,22,.86); border: 1px solid #2a4a63; border-radius: 8px;
  padding: 10px 12px; backdrop-filter: blur(6px); box-shadow: 0 8px 30px rgba(0,0,0,.5);
  user-select: none; display: none; }
#dbg.open { display: block; }
#dbg h4 { margin: 0 0 8px; font-size: 11px; letter-spacing: 1px; color: #6fd3ff; text-transform: uppercase; }
#dbg .row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
#dbg .row label { flex: 0 0 88px; color: #9fc4d8; }
#dbg .row input[type=range] { flex: 1; min-width: 0; accent-color: #6fd3ff; }
#dbg .row .val { flex: 0 0 36px; text-align: right; color: #ffe14d; }
#dbg .readout { margin: 8px 0; padding: 7px 8px; background: rgba(0,0,0,.3); border-radius: 5px;
  white-space: pre; color: #b9e6c4; font-size: 10.5px; }
#dbg .toggles { display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0; }
#dbg .toggles label { color: #ffb0a0; display: flex; align-items: center; gap: 4px; }
#dbg .btns { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
#dbg button { font: inherit; background: #163349; color: #cfe9ff; border: 1px solid #2a4a63;
  border-radius: 4px; padding: 3px 7px; cursor: pointer; }
#dbg button:hover { background: #1e4663; }
#dbg .hint { margin-top: 7px; color: #5a7a8e; font-size: 10px; }
`;

export class DebugPanel {
  private el: HTMLDivElement;
  private readout: HTMLPreElement;
  private valSpans = new Map<keyof Tune, HTMLSpanElement>();
  open = false;

  constructor(private hooks: DebugHooks) {
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    this.el = document.createElement('div'); this.el.id = 'dbg';
    this.el.innerHTML = '<h4>Debug · Handling</h4>';

    for (const s of SLIDERS) {
      const row = document.createElement('div'); row.className = 'row';
      const lab = document.createElement('label'); lab.textContent = s.label;
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = String(s.min); inp.max = String(s.max); inp.step = String(s.step);
      inp.value = String(hooks.tune[s.key]);
      const val = document.createElement('span'); val.className = 'val'; val.textContent = (hooks.tune[s.key] as number).toFixed(2);
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value); (hooks.tune as unknown as Record<string, number>)[s.key as string] = v;
        val.textContent = v.toFixed(2);
      });
      this.valSpans.set(s.key, val);
      row.append(lab, inp, val); this.el.appendChild(row);
    }

    // toggles
    const toggles = document.createElement('div'); toggles.className = 'toggles';
    toggles.appendChild(this.checkbox('God (no crash)', (on) => { hooks.flags.noCollision = on; }));
    toggles.appendChild(this.checkbox('Freeze traffic', (on) => { hooks.flags.freezeTraffic = on; }));
    this.el.appendChild(toggles);

    // readouts
    this.readout = document.createElement('pre'); this.readout.className = 'readout'; this.el.appendChild(this.readout);

    // action buttons
    const btns = document.createElement('div'); btns.className = 'btns';
    btns.appendChild(this.button('Restart', () => hooks.actions.restart()));
    for (let i = 0; i < hooks.stageCount; i++) btns.appendChild(this.button(`Stage ${i + 1}`, () => hooks.actions.setStage(i)));
    btns.appendChild(this.button('→ Fork', () => hooks.actions.gotoFork()));
    btns.appendChild(this.button('Mute', () => hooks.actions.toggleMute()));
    this.el.appendChild(btns);

    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = '` to toggle this panel';
    this.el.appendChild(hint);

    document.body.appendChild(this.el);
    addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') { this.open = !this.open; this.el.classList.toggle('open', this.open); }
    });
  }

  private checkbox(label: string, on: (checked: boolean) => void): HTMLLabelElement {
    const l = document.createElement('label'); const cb = document.createElement('input'); cb.type = 'checkbox';
    cb.addEventListener('change', () => on(cb.checked)); l.append(cb, document.createTextNode(label)); return l;
  }
  private button(label: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button'); b.textContent = label;
    b.addEventListener('click', () => { fn(); (document.activeElement as HTMLElement)?.blur(); }); return b;
  }

  /** Refresh live readouts + slider values (cheap; call each frame while open). */
  update() {
    if (!this.open) return;
    const s = this.hooks.state();
    this.readout.textContent = Object.entries(s).map(([k, v]) => `${k.padEnd(9)} ${v}`).join('\n');
    for (const [key, span] of this.valSpans) {
      const v = this.hooks.tune[key] as number; span.textContent = v.toFixed(2);
    }
  }
}

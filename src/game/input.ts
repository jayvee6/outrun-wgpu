// Keyboard input. Default bindings mirror the original where sensible but use
// arrows + Z/X here for accel/brake (Ctrl/Alt are awkward in a browser).

export class Input {
  private down = new Set<string>();

  constructor() {
    addEventListener('keydown', (e) => { this.down.add(e.code); if (this.handled(e.code)) e.preventDefault(); });
    addEventListener('keyup', (e) => { this.down.delete(e.code); });
    addEventListener('blur', () => this.down.clear());
  }
  private handled(code: string) {
    return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyZ', 'KeyX', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code);
  }
  get accel() { return this.down.has('ArrowUp') || this.down.has('KeyW') || this.down.has('Space'); }
  get brake() { return this.down.has('ArrowDown') || this.down.has('KeyS'); }
  get left() { return this.down.has('ArrowLeft') || this.down.has('KeyA'); }
  get right() { return this.down.has('ArrowRight') || this.down.has('KeyD'); }
}

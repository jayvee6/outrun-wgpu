// Immediate-mode flat-color polygon batcher. The pseudo-3D road is drawn as a
// stack of colored trapezoids (grass / rumble / road / lane lines), painter's
// order back-to-front. Coordinates are in screen PIXELS (origin top-left,
// x right, y down); the shader converts to NDC using the viewport uniform.

import type { Gpu } from './device';

const FLOATS_PER_VERT = 6; // x, y, r, g, b, a
const MAX_VERTS = 1 << 17; // 131072 verts (~21k triangles) — ample for the road

const WGSL = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4f, @location(0) color: vec4f };
@group(0) @binding(0) var<uniform> viewport: vec2f;

@vertex fn vs(@location(0) p: vec2f, @location(1) color: vec4f) -> VSOut {
  var out: VSOut;
  // pixel -> NDC: x in [0,w] -> [-1,1]; y in [0,h] -> [1,-1] (flip)
  let ndc = vec2f(p.x / viewport.x * 2.0 - 1.0, 1.0 - p.y / viewport.y * 2.0);
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.color = color;
  return out;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f { return in.color; }
`;

export type RGBA = [number, number, number, number];

export class PolyRenderer {
  private data = new Float32Array(MAX_VERTS * FLOATS_PER_VERT);
  private count = 0; // vertices used this frame
  private vbuf: GPUBuffer;
  private ubuf: GPUBuffer;
  private pipeline: GPURenderPipeline;
  private bind: GPUBindGroup;

  constructor(private gpu: Gpu) {
    const { device, format } = gpu;
    this.vbuf = device.createBuffer({
      size: this.data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.ubuf = device.createBuffer({
      size: 16, // vec2f padded
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{
          arrayStride: FLOATS_PER_VERT * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x4' },
          ],
        }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bind = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.ubuf } }],
    });
  }

  begin() { this.count = 0; }

  private vert(x: number, y: number, c: RGBA) {
    const o = this.count * FLOATS_PER_VERT;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = c[0]; d[o + 3] = c[1]; d[o + 4] = c[2]; d[o + 5] = c[3];
    this.count++;
  }

  /** A full-screen rect (e.g. sky / background fill). */
  rect(x0: number, y0: number, x1: number, y1: number, c: RGBA) {
    this.quad(x0, y0, x1, y0, x1, y1, x0, y1, c);
  }

  /**
   * Arbitrary quad from 4 points in order (used for road trapezoids).
   * Two triangles: (0,1,2) (0,2,3).
   */
  quad(
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, x3: number, y3: number, c: RGBA,
  ) {
    if (this.count + 6 > MAX_VERTS) return;
    this.vert(x0, y0, c); this.vert(x1, y1, c); this.vert(x2, y2, c);
    this.vert(x0, y0, c); this.vert(x2, y2, c); this.vert(x3, y3, c);
  }

  /** Encode the batch into the given render pass. Call between begin() and frame end. */
  flush(pass: GPURenderPassEncoder) {
    if (this.count === 0) return;
    const { device } = this.gpu;
    device.queue.writeBuffer(this.ubuf, 0, new Float32Array([this.gpu.width, this.gpu.height]));
    device.queue.writeBuffer(this.vbuf, 0, this.data, 0, this.count * FLOATS_PER_VERT);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.setVertexBuffer(0, this.vbuf);
    pass.draw(this.count);
  }
}

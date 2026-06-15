// Textured-quad batcher for the pseudo-3D scenery: roadside sprites, traffic,
// the player car, and the parallax backgrounds. Screen-pixel coords (top-left
// origin); alpha-blended; painter's order preserved by uploading every quad once
// and issuing per-texture draws over slices of that single buffer.

import type { Gpu } from './device';

const FLOATS_PER_VERT = 4; // x, y, u, v
const VERTS_PER_QUAD = 6;

const WGSL = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@group(0) @binding(0) var<uniform> viewport: vec2f;
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var tex: texture_2d<f32>;

@vertex fn vs(@location(0) p: vec2f, @location(1) uv: vec2f) -> VSOut {
  var out: VSOut;
  out.pos = vec4f(p.x / viewport.x * 2.0 - 1.0, 1.0 - p.y / viewport.y * 2.0, 0.0, 1.0);
  out.uv = uv;
  return out;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  if (c.a < 0.01) { discard; }
  return c;
}
`;

export interface SpriteTexture {
  id: number;
  texture: GPUTexture;
  bind: GPUBindGroup;
  width: number;
  height: number;
}

export class SpriteRenderer {
  private pipeline: GPURenderPipeline;
  private ubuf: GPUBuffer;
  private viewBind: GPUBindGroup;
  private texLayout: GPUBindGroupLayout;
  private sampler: GPUSampler;
  private samplerRepeat: GPUSampler;
  private vbuf: GPUBuffer;
  private nextId = 1;

  // per-frame batches keyed by texture id
  private batches = new Map<number, number[]>();
  private uploaded: { id: number; offset: number; count: number }[] = [];

  constructor(private gpu: Gpu, maxQuads = 4096) {
    const { device, format } = gpu;
    this.ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.vbuf = device.createBuffer({
      size: maxQuads * VERTS_PER_QUAD * FLOATS_PER_VERT * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.samplerRepeat = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
    const module = device.createShaderModule({ code: WGSL });

    const viewLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.texLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [viewLayout, this.texLayout] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{
          arrayStride: FLOATS_PER_VERT * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
          ],
        }],
      },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.viewBind = device.createBindGroup({ layout: viewLayout, entries: [{ binding: 0, resource: { buffer: this.ubuf } }] });
  }

  /** Upload an ImageBitmap/Canvas as a sampled texture; returns a handle. */
  createTexture(src: ImageBitmap | HTMLCanvasElement, width: number, height: number, repeat = false): SpriteTexture {
    const { device } = this.gpu;
    const texture = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: src }, { texture }, [width, height]);
    const bind = device.createBindGroup({
      layout: this.texLayout,
      entries: [{ binding: 0, resource: repeat ? this.samplerRepeat : this.sampler }, { binding: 1, resource: texture.createView() }],
    });
    return { id: this.nextId++, texture, bind, width, height };
  }

  /** Empty texture to pack sub-images into (atlas). */
  createEmptyTexture(width: number, height: number): SpriteTexture {
    const { device } = this.gpu;
    const texture = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const bind = device.createBindGroup({
      layout: this.texLayout,
      entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: texture.createView() }],
    });
    return { id: this.nextId++, texture, bind, width, height };
  }

  /** Copy a sub-image into an atlas texture at pixel origin (x,y). */
  copyInto(t: SpriteTexture, src: ImageBitmap, x: number, y: number, w: number, h: number) {
    this.gpu.device.queue.copyExternalImageToTexture(
      { source: src }, { texture: t.texture, origin: [x, y] }, [w, h]);
  }

  begin() { this.batches.clear(); this.uploaded = []; }

  /** Queue a quad. x,y = top-left in pixels; uv rect in [0,1]; flipX mirrors U. */
  quad(t: SpriteTexture, x: number, y: number, w: number, h: number,
       u0 = 0, v0 = 0, u1 = 1, v1 = 1, flipX = false) {
    if (flipX) { const tmp = u0; u0 = u1; u1 = tmp; }
    let arr = this.batches.get(t.id);
    if (!arr) { arr = []; this.batches.set(t.id, arr); }
    const x1 = x + w, y1 = y + h;
    arr.push(
      x, y, u0, v0,  x1, y, u1, v0,  x1, y1, u1, v1,
      x, y, u0, v0,  x1, y1, u1, v1,  x, y1, u0, v1,
    );
  }

  /** Concatenate all batches into the vertex buffer (call once before flushes). */
  upload() {
    const all: number[] = [];
    for (const [id, arr] of this.batches) {
      const offset = all.length / FLOATS_PER_VERT;
      for (let i = 0; i < arr.length; i++) all.push(arr[i]);
      this.uploaded.push({ id, offset, count: arr.length / FLOATS_PER_VERT });
    }
    if (all.length) this.gpu.device.queue.writeBuffer(this.vbuf, 0, new Float32Array(all));
    this.gpu.device.queue.writeBuffer(this.ubuf, 0, new Float32Array([this.gpu.width, this.gpu.height]));
  }

  /** Draw the given textures' slices, in the order provided. */
  flush(pass: GPURenderPassEncoder, textures: SpriteTexture[]) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.viewBind);
    pass.setVertexBuffer(0, this.vbuf);
    for (const t of textures) {
      const region = this.uploaded.find((r) => r.id === t.id);
      if (!region || region.count === 0) continue;
      pass.setBindGroup(1, t.bind);
      pass.draw(region.count, 1, region.offset);
    }
  }
}

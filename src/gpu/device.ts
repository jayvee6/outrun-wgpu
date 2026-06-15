// WebGPU bring-up: adapter/device/context. Keeps the canvas sized to the
// drawing buffer at devicePixelRatio so the pseudo-3D projection (which uses
// pixel dimensions) stays crisp.

export interface Gpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
  width: number;  // drawing-buffer pixels
  height: number;
}

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!navigator.gpu) throw new Error('WebGPU not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter found.');
  const device = await adapter.requestDevice();

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Failed to get WebGPU canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const gpu: Gpu = { device, context, format, canvas, width: 0, height: 0 };
  resize(gpu);
  return gpu;
}

export function resize(gpu: Gpu): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(gpu.canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(gpu.canvas.clientHeight * dpr));
  if (w === gpu.width && h === gpu.height) return false;
  gpu.canvas.width = w;
  gpu.canvas.height = h;
  gpu.width = w;
  gpu.height = h;
  return true;
}

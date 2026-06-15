// Asset loading: fetch PNGs, pack them into atlas textures, and parse the
// per-sprite `.txt` property files (scale / pivots / collision) that the
// original uses to place and size scenery.

import type { SpriteRenderer, SpriteTexture } from '../gpu/spriteRenderer';

export interface SpriteProps {
  uv: [number, number, number, number]; // u0,v0,u1,v1 in the atlas
  w: number; h: number;                 // source pixel size
  scale: number;
  pivotLeft: [number, number];
  pivotRight: [number, number];
  collision: boolean;
  widthCollision: number;
}

export interface Atlas {
  texture: SpriteTexture;
  items: Map<number, SpriteProps>; // keyed by 1-based sprite id
}

async function loadImage(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`asset ${url} -> ${res.status}`);
  return createImageBitmap(await res.blob());
}

function parseProps(text: string, defWidth: number): Partial<SpriteProps> {
  const p: Partial<SpriteProps> = {};
  const toks = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i];
    if (k === 'SCALE:') p.scale = parseFloat(toks[++i]);
    else if (k === 'COLLISION:') p.collision = toks[++i] === '1';
    else if (k === 'WIDTH_COLLISION:') p.widthCollision = parseFloat(toks[++i]);
    else if (k === 'PIVOT_LEFT:') p.pivotLeft = [parseFloat(toks[++i]), parseFloat(toks[++i])];
    else if (k === 'PIVOT_RIGHT:') p.pivotRight = [parseFloat(toks[++i]), parseFloat(toks[++i])];
  }
  void defWidth;
  return p;
}

const PAD = 1;
const ATLAS_W = 2048;

interface Packed { img: ImageBitmap; x: number; y: number; }

/** Shelf-pack a set of images into one atlas texture. */
function pack(renderer: SpriteRenderer, imgs: ImageBitmap[]): { tex: SpriteTexture; placed: Packed[] } {
  let cx = 0, cy = 0, rowH = 0;
  const placed: Packed[] = [];
  for (const img of imgs) {
    if (cx + img.width + PAD > ATLAS_W) { cx = 0; cy += rowH + PAD; rowH = 0; }
    placed.push({ img, x: cx, y: cy });
    cx += img.width + PAD;
    rowH = Math.max(rowH, img.height);
  }
  const totalH = cy + rowH;
  const H = Math.min(8192, Math.max(1, totalH));
  const tex = renderer.createEmptyTexture(ATLAS_W, H);
  for (const pl of placed) renderer.copyInto(tex, pl.img, pl.x, pl.y, pl.img.width, pl.img.height);
  return { tex, placed };
}

/**
 * Load `ids` from `${base}/<id>.png` (+ optional `<id>.txt`) into one atlas.
 * `idOffset` shifts the keys in the returned map — the start biome composes its
 * objects as [MapStartGoal 1..45, Map<N> 1..k], so Map1 sprites live at 46..71.
 */
export async function loadSpriteAtlas(renderer: SpriteRenderer, base: string, ids: number[], idOffset = 0): Promise<Atlas> {
  const imgs = await Promise.all(ids.map((id) => loadImage(`${base}/${id}.png`)));
  const texts = await Promise.all(ids.map((id) =>
    fetch(`${base}/${id}.txt`).then((r) => (r.ok ? r.text() : '')).catch(() => '')));
  const { tex, placed } = pack(renderer, imgs);
  const items = new Map<number, SpriteProps>();
  ids.forEach((id, i) => {
    const pl = placed[i];
    const w = pl.img.width, h = pl.img.height;
    const d = parseProps(texts[i], w);
    items.set(id + idOffset, {
      uv: [pl.x / tex.width, pl.y / tex.height, (pl.x + w) / tex.width, (pl.y + h) / tex.height],
      w, h,
      scale: d.scale ?? 1,
      pivotLeft: d.pivotLeft ?? [1, 1],
      pivotRight: d.pivotRight ?? [0, 1],
      collision: d.collision ?? true,
      widthCollision: d.widthCollision ?? w,
    });
  });
  return { texture: tex, items };
}

/** Load player car frames `${base}/c<n>.png` for n in [1..count] into one atlas. */
export async function loadCarFrames(renderer: SpriteRenderer, base: string, frames: number[]): Promise<Atlas> {
  const imgs = await Promise.all(frames.map((n) => loadImage(`${base}/c${n}.png`)));
  const { tex, placed } = pack(renderer, imgs);
  const items = new Map<number, SpriteProps>();
  frames.forEach((n, i) => {
    const pl = placed[i];
    const w = pl.img.width, h = pl.img.height;
    items.set(n, {
      uv: [pl.x / tex.width, pl.y / tex.height, (pl.x + w) / tex.width, (pl.y + h) / tex.height],
      w, h, scale: 1, pivotLeft: [0.5, 1], pivotRight: [0.5, 1], collision: false, widthCollision: w,
    });
  });
  return { texture: tex, items };
}

export interface TrafficAtlas {
  texture: SpriteTexture;
  frames: Map<number, SpriteProps>; // key = carId*100 + frame(1..16)
  scale: Map<number, number>;       // per-car SCALE
  carIds: number[];
}

/** Load traffic cars `${base}/Car<id>/c<1..16>.png` (+ Car<id>.txt scale) into one atlas. */
export async function loadTrafficAtlas(renderer: SpriteRenderer, base: string, carIds: number[], framesPerCar = 16): Promise<TrafficAtlas> {
  const urls: { car: number; frame: number; url: string }[] = [];
  for (const car of carIds) for (let f = 1; f <= framesPerCar; f++) urls.push({ car, frame: f, url: `${base}/Car${car}/c${f}.png` });
  const imgs = await Promise.all(urls.map((u) => loadImage(u.url)));
  const scaleTexts = await Promise.all(carIds.map((car) =>
    fetch(`${base}/Car${car}/Car${car}.txt`).then((r) => (r.ok ? r.text() : '')).catch(() => '')));
  const { tex, placed } = pack(renderer, imgs);
  const frames = new Map<number, SpriteProps>();
  urls.forEach((u, i) => {
    const pl = placed[i], w = pl.img.width, h = pl.img.height;
    frames.set(u.car * 100 + u.frame, {
      uv: [pl.x / tex.width, pl.y / tex.height, (pl.x + w) / tex.width, (pl.y + h) / tex.height],
      w, h, scale: 1, pivotLeft: [0.5, 1], pivotRight: [0.5, 1], collision: true, widthCollision: w,
    });
  });
  const scale = new Map<number, number>();
  carIds.forEach((car, i) => { scale.set(car, parseProps(scaleTexts[i], 0).scale ?? 1); });
  return { texture: tex, frames, scale, carIds };
}

/** Load a single standalone texture (e.g. a background strip). */
export async function loadTexture(renderer: SpriteRenderer, url: string, repeat = false): Promise<SpriteTexture> {
  const img = await loadImage(url);
  return renderer.createTexture(img, img.width, img.height, repeat);
}

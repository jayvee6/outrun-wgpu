// Parser for the original `map.txt` track format. Faithfully replicates the
// reference's addBiome() segment expansion (Logger.cpp + Biome.cpp) so curves,
// hills, road width (tracks) and sprite placement match the original.

import { ROAD_WIDTH, SEGMENT_LENGTH, RUMBLE_LENGTH } from './constants';
import type { RGBA } from '../gpu/polyRenderer';

export enum SpritePos { FAR_LEFT = 0, NEAR_LEFT = 1, CENTER = 2, FAR_RIGHT = 3, NEAR_RIGHT = 4 }

export interface MapSegment {
  index: number;
  curve: number;
  nearY: number; // world Y at z = index*SEGMENT_LENGTH
  farY: number;  // world Y at z = (index+1)*SEGMENT_LENGTH
  distance: number; // road-width / multi-lane offset (mapDistance)
  light: boolean;
  mirror: boolean;
}

export interface SpritePlacement {
  line: number;
  pos: SpritePos;
  id: number;       // atlas id (already offset for Map1)
  offsetX: number;
  offsetY: number;
  collider: boolean;
  side: boolean;    // right road reference
}

export interface MapColors {
  sky: RGBA; sand1: RGBA; sand2: RGBA; road1: RGBA; road2: RGBA;
  rumble1: RGBA; rumble2: RGBA; lane1: RGBA; lane2: RGBA;
  rumbleLane1: RGBA; rumbleLane2: RGBA;
}

export interface MapData {
  time: number; terrain: number; roadTerrain: number;
  colors: MapColors;
  segments: MapSegment[];
  sprites: SpritePlacement[];
  length: number; // world units
}

// --- track-width table (Biome.cpp ctor, integer math preserved) ---
function trackDistances() {
  const inc = Math.trunc(ROAD_WIDTH * 16 / 27) + Math.trunc(ROAD_WIDTH / 18); // 948 + 88 = 1036
  const d: Record<number, number> = {};
  d[3] = 0;
  d[4] = d[3] + inc; d[5] = d[4] + inc; d[6] = d[5] + inc; d[7] = d[6] + inc; d[8] = d[7] + inc;
  d[2] = d[8] + Math.trunc(ROAD_WIDTH * 16 / 27) * 20 + Math.trunc(ROAD_WIDTH / 18) * 7;
  return d;
}
const TRACK_DIST = trackDistances();
function computeRoadTracks(n: number) { return TRACK_DIST[n] ?? 0; }

const easeIn = (a: number, b: number, p: number) => a + (b - a) * p * p;
const easeInOut = (a: number, b: number, p: number) => a + (b - a) * ((-Math.cos(p * Math.PI) / 2) + 0.5);

class Builder {
  segments: MapSegment[] = [];
  private addSegment(curve: number, farY: number, mirror: boolean, dist: number) {
    const n = this.segments.length;
    const nearY = n === 0 ? 0 : this.segments[n - 1].farY;
    this.segments.push({
      index: n, curve, nearY, farY, distance: dist, mirror,
      light: Math.floor(n / RUMBLE_LENGTH) % 2 === 1,
    });
  }
  addBiome(enter: number, hold: number, leave: number, curve: number, y: number, mirror: boolean, distance: number) {
    const total = enter + hold + leave;
    const last = this.segments[this.segments.length - 1];
    let firstY: number, dist: number, distPerc: number;
    if (this.segments.length === 0) { firstY = 0; dist = distance; distPerc = 0; }
    else { firstY = last.farY; dist = last.distance; distPerc = (distance - dist) / total; }
    const endY = firstY + y * SEGMENT_LENGTH;
    for (let n = 0; n < enter; n++) { dist += Math.trunc(distPerc); this.addSegment(easeIn(0, curve, n / enter), easeInOut(firstY, endY, n / total), mirror, dist); }
    for (let n = 0; n < hold; n++) { dist += Math.trunc(distPerc); this.addSegment(curve, easeInOut(firstY, endY, (enter + n) / total), mirror, dist); }
    for (let n = 0; n < leave; n++) { dist += Math.trunc(distPerc); this.addSegment(easeInOut(curve, 0, n / leave), easeInOut(firstY, endY, (enter + hold + n) / total), mirror, dist); }
  }
}

const rgba = (r: number, g: number, b: number, a: number): RGBA => [r / 255, g / 255, b / 255, a / 255];

/** Parse map.txt text. `spriteIdOffset` is added to every sprite id (45 for Map1). */
export function parseMap(text: string, spriteIdOffset = 0): MapData {
  const t = text.split(/\s+/).filter(Boolean);
  let i = 0;
  const next = () => t[i++];
  const num = () => parseFloat(t[i++]);
  const expect = (tok: string) => { const got = next(); if (got !== tok) throw new Error(`map parse: expected ${tok}, got ${got}`); };
  const color = (label: string): RGBA => { expect(label); return rgba(num(), num(), num(), num()); };

  // GLOBAL_CONF
  while (t[i] !== 'TIME:') i++;
  expect('TIME:'); const time = num();
  expect('TERRAIN:'); const terrain = num();
  expect('ROAD_TERRAIN:'); const roadTerrain = num();

  // COLORS
  while (t[i] !== 'COLORS') i++; i++;
  const colors: MapColors = {
    sky: color('COLOR_BACKGROUND:'),
    sand1: color('COLOR_OUTSIDE_ROAD_1:'), sand2: color('COLOR_OUTSIDE_ROAD_2:'),
    road1: color('COLOR_ROAD_1:'), road2: color('COLOR_ROAD_2:'),
    rumble1: color('COLOR_RUMBLE_1:'), rumble2: color('COLOR_RUMBLE_2:'),
    lane1: color('COLOR_LANE_1:'), lane2: color('COLOR_LANE_2:'),
    rumbleLane1: color('COLOR_RUMBLE_LANE_1:'), rumbleLane2: color('COLOR_RUMBLE_LANE_2:'),
  };

  // START_RELIEF
  expect('START_RELIEF');
  const b = new Builder();
  while (t[i] !== 'SPRITES') {
    const cmd = next();
    if (cmd === 'STRAIGHT:') {
      const enter = num(), hold = num(), leave = num(), mirror = num(), tracks = num();
      b.addBiome(enter, hold, leave, 0, 0, mirror === 1, computeRoadTracks(tracks));
    } else if (cmd === 'CURVE_LEFT:' || cmd === 'CURVE_RIGHT:') {
      const enter = num(), hold = num(), leave = num(), dir = num(), mirror = num(), tracks = num(), factor = num();
      b.addBiome(enter, hold * factor, leave, dir, 0, mirror === 1, computeRoadTracks(tracks));
    } else if (cmd === 'HILL_STRAIGHT:') {
      const enter = num(), hold = num(), leave = num(), slope = num(), tracks = num(), factor = num();
      b.addBiome(enter, hold * factor, leave, 0, slope, false, computeRoadTracks(tracks));
    } else if (cmd === 'HILL_LEFT:' || cmd === 'HILL_RIGHT:') {
      const enter = num(), hold = num(), leave = num(), slope = num(), dir = num(), mirror = num(), tracks = num();
      void leave;
      b.addBiome(enter, hold, enter, dir, slope, mirror === 1, computeRoadTracks(tracks)); // leave := enter (reference)
    } else {
      throw new Error(`map parse: unknown relief command "${cmd}"`);
    }
  }
  expect('SPRITES');

  // SPRITES
  const sprites: SpritePlacement[] = [];
  let grp = { start: 0, end: -1, incr: 1, freq: 1 };
  const posMap: Record<string, SpritePos> = {
    'SPRITE_FAR_LEFT:': SpritePos.FAR_LEFT, 'SPRITE_NEAR_LEFT:': SpritePos.NEAR_LEFT,
    'SPRITE_CENTER:': SpritePos.CENTER, 'SPRITE_FAR_RIGHT:': SpritePos.FAR_RIGHT,
    'SPRITE_NEAR_RIGHT:': SpritePos.NEAR_RIGHT,
  };
  while (i < t.length && t[i] !== 'END_FILE') {
    const tok = next();
    if (tok === 'GROUP_LINES:') {
      grp = { start: num(), end: num(), incr: num(), freq: num() };
    } else if (tok === 'LINE:') {
      grp = { start: num(), end: -1, incr: 1, freq: 1 };
    } else if (tok in posMap) {
      const pos = posMap[tok];
      const id = num() + spriteIdOffset, offsetX = num(), offsetY = num(), collider = num() === 1;
      const side = pos === SpritePos.FAR_RIGHT || pos === SpritePos.NEAR_RIGHT;
      const add = (line: number) => sprites.push({ line, pos, id, offsetX, offsetY, collider, side });
      if (grp.end === -1) add(grp.start);
      else for (let k = grp.start; k < grp.end; k += grp.incr) if (k % grp.freq === 0) add(k);
    }
    // ignore LINE_CHECKPOINT: and any unknown tokens for M2
  }

  return { time, terrain, roadTerrain, colors, segments: b.segments, sprites, length: b.segments.length * SEGMENT_LENGTH };
}

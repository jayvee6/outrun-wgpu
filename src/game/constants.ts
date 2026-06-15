// Constants extracted verbatim from ZgzInfinity/OutRun (src/Globals.h) so the
// WebGPU reimplementation matches the original's feel. See OutRun-reference.

export const FPS = 60;
export const PI = Math.PI;

// --- Road geometry ---
export const SEGMENT_LENGTH = 150;     // depth of one road segment (world units)
export const ROAD_WIDTH = 1600;        // half-ish road width factor used in projection
export const RUMBLE_LENGTH = 3;        // segments per color band (light/dark alternation)
export const RUMBLE_WIDTH = 1.08;      // rumble strip width as fraction of road edge

// --- Camera (pseudo-3D projection) ---
export const FOV = 120;
export const CAMERA_DISTANCE = 1 / Math.tan((FOV / 2) * PI / 180); // ~0.5774
export const CAMERA_HEIGHT = 800;
export const SCREEN_Y_OFFSET = 130;    // pixels added to every projected Y
export const DRAW_DISTANCE = 200;      // segments rendered ahead of the camera

// --- Player physics (src/Car/PlayerCar/PlayerCar.cpp) ---
export const MAX_LOW_SPEED = 100;      // low-gear cap
export const MAX_HIGH_SPEED = 200;     // high-gear cap
export const MAX_OFFROAD_SPEED = 75;   // cap when off the asphalt
export const LOW_ACCEL = MAX_LOW_SPEED / 6.5;   // ~15.38
export const BRAKE_ACCEL = MAX_LOW_SPEED / 2.0; // 50
export const COAST_FACTOR = 0.75;      // coast decel = LOW_ACCEL * this
export const PLAYER_X_CLAMP = 1.5;     // |posX| clamp on a single road (units of road)

// --- HUD ---
export const HUD_SPEED_FACTOR = 1.65;  // displayed km/h = speed * this

// --- Misc gameplay ---
export const SCORE_TRAFFIC_BONUS = 20000;
export const SCORE_BONIFICATION = 1000000;

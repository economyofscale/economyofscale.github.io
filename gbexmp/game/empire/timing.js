/**
 * The main loop's rhythm: how many VBlanks a step takes.
 *
 * The game does not run a step every N VBlanks. $044d, at the end of every
 * iteration ($0764), halts until at least two VBlanks have passed since it
 * last returned ($da8a, $da90); a step whose work took longer is not held
 * back -- the halt returns at once, the interrupt being pending. So the
 * next step begins at the later of the work's end and the second VBlank
 * after this step began, and RESUME scanlines after it. Checked against
 * the game's own measured work: web/test/timingparity.mjs.
 *
 * The work is CPU time, which the port does not count; it is estimated
 * (in scanlines, 154 a frame) from what the step did, by a cost model
 * fitted to the game's iterations (emu/src/timelog.mjs, all levels): a
 * constant per level -- its own mix of object handlers, animated tiles,
 * vehicle code, the spawner's walk over the level's list -- and, per step,
 * the sprite tiles DrawAllObjects copies, the active objects, the player's
 * shots (types 1--3, the blaster's) and the others apart -- a player's
 * shot is tested against the objects, so also shots x objects (HANDOVER
 * §9.38) -- the map columns and rows streamed, the tile attribute lookups
 * ($39e4) and a walker drawn into the BG ($148c);
 * each level's constant then set for the rhythm, not the work (the length
 * is a step function of it). `node web/test/timingparity.mjs --fit`
 * refits it.
 */

/** Scanlines a frame; the clock's 0 is the VBlank handler's. */
export const LINES = 154;

/** Scanlines, by the cost model (timingparity --fit). */
export const COST = {
  tiles: 5.8, objs: 12.4, pshots: 23.4, eshots: 5.7, pobjs: 1.8, vshots: 23.4, streams: 49.6, lookups: 5.2, walkers: 316.7,
  level: [0, 170.2, 46.1, 195.1, 163.7, 205.2, 48, 86.2, 133.6, 73.6, 152.6, 124.2],
};

/** The vehicle levels: the speeder (2) and the Falcon (6, 7, 9). */
const VEHICLE = new Set([2, 6, 7, 9]);

/**
 * The model's terms from a step's counts ({ tiles, objs, shots, pshots,
 * streams, lookups, walkers }; `pshots`, the player's among the shots).
 * In a vehicle the player's shots are of other types: there every shot
 * is `vshots`.
 */
export function costTerms(level, c) {
  const v = VEHICLE.has(level);
  return {
    tiles: c.tiles, objs: c.objs, pshots: v ? 0 : c.pshots, eshots: v ? 0 : c.shots - c.pshots,
    pobjs: v ? 0 : c.pshots * c.objs, vshots: v ? c.shots : 0,
    streams: c.streams, lookups: c.lookups, walkers: c.walkers,
  };
}

/** The work of a step, in scanlines, from its counts. */
export function stepWork(level, c, cost = COST) {
  let w = cost.level[level] ?? 0;
  for (const [k, v] of Object.entries(costTerms(level, c))) w += cost[k] * v;
  return w;
}

/**
 * Scanlines from the frame wait's return to the next step's start: the
 * VBlank handler, when the wait ended at a VBlank (11 in 3,912 of 6,000
 * such steps); about as many, spread 4..19, when the work ran longer.
 */
export const RESUME = 11;

/**
 * $044d: a step that began at scanline `start` (on the clock) and worked
 * `work` scanlines -- when the next one begins. `fresh`: the first step
 * after a vehicle's START wait ($0843), whose $da90 is from before it --
 * no two VBlanks to wait for, only the work.
 */
export function nextStart(start, work, fresh = false) {
  const vb = Math.floor(start / LINES);
  return Math.max(start + work, fresh ? 0 : (vb + 2) * LINES) + RESUME;
}

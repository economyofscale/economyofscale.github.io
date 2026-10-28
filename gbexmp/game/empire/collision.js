/**
 * Tile collision, ported from the game's lookup chain.
 *
 * $39e4 GetTileAttributes takes a position in 8 px tile units (HL = Y,
 * DE = X), first lets $382f SelectMapRow point the map row cache at metatile
 * row Y / 4, then swaps the registers and hands over to 01:53e3:
 *
 *   map byte  = row[X / 4]
 *   metatile  = 16 bytes at $cb40 + byte * 16 ($c820 for bytes $e0..$ff)
 *   BG tile   = metatile[(Y & 3) * 4 + (X & 3)]
 *   attribute = $ca40[BG tile]
 *
 * SelectMapRow ignores rows that are negative or past the map, and the lookup
 * then reads whatever row was selected last. That is reproduced: `world.row`
 * is $d9c3 and survives between calls.
 *
 * The row cache is the game's own: 8 slots of $d1 bytes at $d300, a tag
 * (the row held, $ff none) and 208 map bytes, filled as a ring from both
 * ends ($d9bf..$d9c2). A row only ever writes its width, so a column past
 * the end reads what was in the slot before: zeros from LevelStart's clear
 * ($01e0), or the script $330d unpacks over $ca20..$d8fe for every screen.
 * Which slot a row lands in depends on every selection since the last
 * ResetSceneState ($0b20) -- the camera's streaming and RedrawView's
 * included (selectRowAt, streamColumnRows, redrawViewRows), so play.js
 * makes those too. A read outside the cache (a column past slot 7, or the
 * pointer still $0000 before any row was selected) returns 0 and sets
 * `world.offMap`; real play never gets there.
 *
 * The same leftover bytes show on screen when the view reaches past a
 * row's end (a camera InitCamera put there, after a teleport: it does
 * not hold X inside the map). RedrawView and the streaming read the map
 * bytes through the cache pointer with no width check and write the
 * metatiles' tiles into VRAM as they are then: `world.bg` is that BG map
 * ($9800, the 32 x 32 ring), kept by redrawViewRows, streamColumnRows and
 * streamRow when given the position.
 */

import { hudUpdate } from './hud.js';

/**
 * @param {ReturnType<import('./assets.js').sceneCollision>} map
 * @param {(p: object) => void} [onTrigger] $1d6a (hurt.js `trigger`), supplied by the caller
 */
export function createWorld(map, onTrigger = null) {
  // `c` is register C as the last scan left it (undefined: not known). The
  // jump fall's climb check ($1a21) tests C, which can come all the way from
  // here through CheckObjectLanding and ClimbCheck's early returns.
  // The metatiles are the world's own: crumbling rewrites them in RAM.
  const own = { ...map, metatiles: Uint8Array.from(map.metatiles), metatilesHigh: Uint8Array.from(map.metatilesHigh ?? []) };
  const world = {
    map: own, pristine: map, row: 0xff, offMap: false, pastRow: false, lastAddr: 0, triggered: false, onTrigger,
    c: undefined, probeHit: null, lostWrite: false,
    // $d300..$d987, cleared by LevelStart ($01e0: $c300..$da86); `at` is
    // $d9c4, the selected row's first byte ($0000 until a row is).
    cache: new Uint8Array(CACHE_SLOTS * CACHE_SLOT), at: 0,
    // The RAM between the metatiles' end and $d300, met by a metatile
    // number past the level's own (a byte read past a row's end).
    gap: new Uint8Array(Math.max(0, CACHE_AT - METATILES_AT - own.metatiles.length)),
    d9bf: 0, d9c0: 0, d9c1: 0, d9c2: 0,
    // $9800..$9bff as RedrawView and the streaming wrote it.
    bg: new Uint8Array(0x400),
  };
  // LoadSceneDescriptor ($0a63) runs on into $0b16 and ResetSceneState.
  resetSceneState(world);
  return world;
}

/** The row cache: 8 slots at $d300 of a tag and 208 map bytes. */
export const CACHE_AT = 0xd300, CACHE_SLOT = 0xd1, CACHE_SLOTS = 8;
/** The script, unpacked at $ca20 ($330d), ends at $d8fe. */
const SCRIPT_AT = 0xca20;

/** $0b20 -- every slot's tag $ff, no row selected, both ring ends at 0. */
export function resetSceneState(world) {
  for (let s = 0; s < CACHE_SLOTS; s++) world.cache[s * CACHE_SLOT] = 0xff;
  world.row = 0xff;
  world.d9bf = world.d9c0 = world.d9c1 = world.d9c2 = 0;
}

/** $330d -- the script unpacked over $ca20: as far as it reaches into the cache. */
export function unpackScriptOver(world, script) {
  for (const [arr, at] of [[world.gap, CACHE_AT - world.gap.length], [world.cache, CACHE_AT]]) {
    const from = at - SCRIPT_AT, n = Math.min(arr.length, script.length - from);
    if (n > 0) arr.set(script.subarray(from, from + n));
  }
}

/**
 * The RAM the lookup reads a metatile byte from: the metatiles, the gap
 * after them, the row cache. Elsewhere undefined (not modelled).
 */
function ramArea(world, addr) {
  const { metatiles, metatilesHigh } = world.map;
  const areas = [[METATILES_AT, metatiles], [METATILES_HIGH_AT, metatilesHigh],
    [CACHE_AT - world.gap.length, world.gap], [CACHE_AT, world.cache]];
  for (const [at, arr] of areas) if (addr >= at && addr < at + arr.length) return [arr, addr - at];
  return null;
}

/** RAM of the metatiles: $cb40 + byte * 16, and $c820 for bytes $e0.. */
export const METATILES_AT = 0xcb40, METATILES_HIGH_AT = 0xc820;

/** Write one byte of the metatile RAM; elsewhere: noted, not modelled. */
export function setMetatileByte(world, addr, v) {
  const area = ramArea(world, addr);
  if (area) area[0][area[1]] = v;
  else world.lostWrite = true;
}

/**
 * $24b1 -- a crumbling tile breaks: the 2 x 2 quarter of its metatile
 * that holds the tile byte at `addr` (BC, where the lookup last read)
 * becomes `tile` ($da30, descriptor byte 20) -- every place in the level
 * that uses the metatile. Returns the metatile's start (DE), which $3981
 * copies to VRAM.
 */
export function crumble(world, addr, tile) {
  for (const k of [0, 1, 5, 4]) setMetatileByte(world, (addr & 0xff00) | ((addr & 0xff) ^ k), tile);
  return (addr & 0xff00) | (addr & 0xf0);
}

/** $0b43 reloads the metatiles from the ROM: crumbled tiles are whole again. */
export function restoreMetatiles(world) {
  world.map.metatiles.set(world.pristine.metatiles);
  if (world.pristine.metatilesHigh) world.map.metatilesHigh.set(world.pristine.metatilesHigh);
}

/** $382f -- A = metatile row. Updates the cached row only when it may. */
export function selectMapRow(world, a) {
  if (a & 0x80) return;
  if (a === world.row) return;
  const limit = (world.map.heightPx >> 5) & 0xff;
  if (a >= limit) return;
  world.row = a;
  const { cache } = world;
  for (let s = 0; s < CACHE_SLOTS; s++) {
    if (cache[s * CACHE_SLOT] === a) {
      world.at = CACHE_AT + s * CACHE_SLOT + 1;
      return;
    }
  }
  // A miss: rows above the lowest held fill the ring backwards from $d9c0,
  // the others forwards from $d9c2.
  let slot;
  if (world.d9bf >= a) {
    world.d9bf = a;
    slot = world.d9c0 = (world.d9c0 - 1) & 7;
  } else {
    world.d9c1 = a;
    slot = world.d9c2 = (world.d9c2 + 1) & 7;
  }
  cache[slot * CACHE_SLOT] = a;
  cache.set(world.map.rows[a], slot * CACHE_SLOT + 1);
  world.at = CACHE_AT + slot * CACHE_SLOT + 1;
}

/** $37ca's selection: the row of the pixel Y at $d988. */
export function selectRowAt(world, y) {
  selectMapRow(world, ((y & 0xffff) >> 5) & 0xff);
}

/**
 * The map byte at column `col` of the selected row, through the cache
 * pointer ($d9c4). A drawing read outside the RAM modelled gives 0 and
 * sets `world.bgOff` (the lookups' `offMap` is theirs alone).
 */
function cachedByte(world, col) {
  const at = (world.at + col) & 0xffff;
  if (at < CACHE_AT || at >= CACHE_AT + world.cache.length) { world.bgOff = true; return 0; }
  return world.cache[at - CACHE_AT];
}

/**
 * $3981 -- a metatile's 16 tile numbers into the BG map at metatile (mx,
 * my), wrapping in the ring: from $cb40 + byte * 16 ($ba20.. for bytes
 * $e0..$ff), whatever RAM that is.
 */
function drawMetatile(world, byte, mx, my) {
  const base = ((byte & 0xe0) === 0xe0 ? 0xba20 : 0xcb40) + byte * 16;
  for (let sub = 0; sub < 16; sub++) {
    const area = ramArea(world, (base + sub) & 0xffff);
    if (!area) world.bgOff = true;
    world.bg[(((my * 4) + (sub >> 2)) & 31) * 32 + (((mx * 4) + (sub & 3)) & 31)] = area ? area[0][area[1]] : 0;
  }
}

/**
 * $3921 -- a column of 6 metatiles from the row $37ca selected, at pixel
 * (x, y) ($d98a, $d988): each from the cache, then the row below ($d9c3 +
 * 1; a row past the map keeps the last). Without x, the selections only.
 */
export function streamColumnRows(world, x, y) {
  for (let i = 0; i < 6; i++) {
    if (x !== undefined) drawMetatile(world, cachedByte(world, (x & 0xffff) >> 5), (x & 0xffff) >> 5, ((y & 0xffff) >> 5) + i);
    selectMapRow(world, (world.row + 1) & 0xff);
  }
}

/** $38ec -- a row of 6 metatiles from the row $37ca selected, from pixel (x, y). */
export function streamRow(world, x, y) {
  const col = (x & 0xffff) >> 5;
  for (let k = 0; k < 6; k++) drawMetatile(world, cachedByte(world, col + k), col + k, (y & 0xffff) >> 5);
}

/**
 * $3756 RedrawView: 6 rows of the view from the camera's Y ($d9b1) down,
 * each 6 metatiles from its X ($d9af) -- $37ca, $38ec. Without camX, the
 * selections only.
 */
export function redrawViewRows(world, camY, camX) {
  for (let i = 0; i < 6; i++) {
    selectRowAt(world, camY + i * 0x20);
    if (camX !== undefined) streamRow(world, camX, camY + i * 0x20);
  }
}

/** $39e4 -- attribute byte of the tile at (x, y), in 8 px tile units. */
export function getTileAttributes(world, x, y) {
  // Counted for the step's cost (timing.js).
  world.lookups = (world.lookups ?? 0) + 1;
  selectMapRow(world, ((y & 0xffff) >> 2) & 0xff);
  const { map } = world;
  const col = (x & 0xffff) >> 2;
  // Past the row's width: on into what the slot held before. Noted, for
  // the tests whose recordings do not hold the cache.
  if (col >= map.width) world.pastRow = true;
  const at = (world.at + col) & 0xffff;
  if (at < CACHE_AT || at >= CACHE_AT + world.cache.length) {
    world.offMap = true;
    return 0;
  }
  const byte = world.cache[at - CACHE_AT];
  const sub = (y & 3) * 4 + (x & 3);
  // The RAM address of the metatile byte read: 01:53e3 hands it back in BC,
  // and ProbeGround keeps it in $d98c.
  world.lastAddr = (((byte & 0xe0) === 0xe0 ? 0xba20 : 0xcb40) + byte * 16 + sub) & 0xffff;
  const area = ramArea(world, world.lastAddr);
  if (!area) {
    world.offMap = true;
    return 0;
  }
  return map.attrs[area[0][area[1]]];
}

// Attribute bits, as the scans test them.
export const ATTR = {
  SOLID: 0x01,      // bit 0: a move into it is undone
  PLATFORM: 0x04,   // bit 2: undone only by the downward gravity probe
  SOLID2: 0x08,     // bit 3: like bit 0 in the scan; in gravity only with $da42
  CLIMB: 0x10,      // bit 4: sets $da1a, which lets UP climb
  TRIGGER: 0x20,    // bit 5: hands over to $1d6a (world.onTrigger)
};

/**
 * $0d41 -- undo the move: restore the position SavePrevPosition saved at
 * $d9b3. In state $15 touching such a tile also advances the state to $16
 * (its meaning is not known yet).
 */
export function undoMove(p) {
  if (p.state === 0x15) {
    p.state = 0x16;
    p.c309 = 0x08;
  }
  p.x = p.px;
  p.y = p.py;
  return 'blocked';
}

/** X tile of the probe: 8 px ahead of the position, 16 when mounted. */
const probeX = (p) => ((p.x + (p.ff8f ? 16 : 8)) & 0xffff) >> 3;

/**
 * $1cd7 -- after a move, scan the box from the feet up for what was hit.
 * Returns 'ok', 'blocked' (move undone), 'trigger' or 'skipped'.
 *
 * A trigger tile (bit 5) makes the game jump to $1d6a (hurt.js `trigger`):
 * the caller supplies it as world.onTrigger, and world.triggered records that it
 * happened. Its `ret` goes back to whoever called the scan, so callers carry
 * on afterwards exactly as with any other result.
 */
export function postMoveCollisionScan(p, world) {
  if (p.da35 === 2) return 'skipped';
  p.da1a = 0;
  let xt = probeX(p);
  let y = p.y >> 3;
  let columns = p.ff8f ? 2 : (p.c304 - 1) & 0xff;
  // Rows per column, re-read every column: a climbable tile can change $c305.
  const rowCount = () => (!p.da42 && p.ff8f ? (p.c305 + 2) & 0xff : p.c305);
  do {
    // n is register C, the rows left in the column.
    for (let n = rowCount(); n > 0; n--) {
      const a = getTileAttributes(world, xt, y);
      if (a & (ATTR.SOLID | ATTR.SOLID2)) {
        world.c = n;
        return undoMove(p);
      }
      if (a & ATTR.TRIGGER) {
        world.triggered = true;
        const known = triggerEndsInHud(p);
        world.onTrigger?.(p);
        // C is what $1144 (01:5c90) leaves, redrawing the bar as it now is.
        world.c = known ? hudUpdate(new Uint8Array(0x20), p) : undefined;
        return 'trigger';
      }
      if (a & ATTR.CLIMB) onClimbableTile(p);
      y = (y - 1) & 0xffff;
    }
    // $1d3f: back down by the height as it is *now*, not as it was. If
    // onClimbableTile resized the box mid-column, the next column starts
    // lower; the game does exactly this.
    y = (y + rowCount()) & 0xffff;
    xt = (xt + 1) & 0xffff;
    columns = (columns - 1) & 0xff;
  } while (columns);
  // $1d4a: C ends at 0, or 2 when mounted; $39c2 then loads X's low byte.
  world.c = !p.da42 && p.ff8f ? 2 : 0;
  return checkMapBoundsX(p, world);
}

/**
 * Does $1d6a return through $1144? Riding, $0f25 does, but for level 2's
 * vehicle ($0f3e, which this scan never meets: $da35 = 2 skips it). On
 * foot Hurt does, unless it returns at once in states $15, $16, $12 --
 * then C is the sound driver's (07:$638c), not known here.
 */
function triggerEndsInHud(p) {
  if (p.ff8f) return !!p.da42 || p.ff8b !== 0x02;
  return p.state !== 0x15 && p.state !== 0x16 && p.state !== 0x12;
}

/** $1d5d -- standing in a climbable tile; also ends the UP power ($da43). */
function onClimbableTile(p) {
  if (p.da42) return;
  p.da1a = 1;
  endUpPower(p);
}

/** $1d75 -- if the UP power is on, end it: box back to 3 x 4. */
export function endUpPower(p) {
  if (!p.da43) return;
  p.c304 = 3;
  p.c305 = 4;
  p.da43 = 0;
  p.da2b = 0;
}

/** $39c2 -- undo a move that left the map: X < 0 or X > width - 24. */
function checkMapBoundsX(p, world) {
  if (p.x & 0x8000) return undoMove(p);
  world.c = p.x & 0xff;
  if ((p.widthPx - 24 - p.x) & 0x8000) return undoMove(p);
  return 'ok';
}

/**
 * $1bd2 -- one pixel of fall. Saves the position, moves down one pixel and
 * probes the single row at the feet. Floors are bits 0 and 2 (and 3 with
 * $da42): landing is simply this move being undone.
 */
export function gravityPixelStep(p, world) {
  world.c = undefined;
  p.px = p.x;
  p.py = p.y;
  let xt = probeX(p);
  p.y = (p.y + 1) & 0xffff;
  const yt = p.y >> 3;
  let columns = p.ff8f ? 2 : (p.c304 - 1) & 0xff;
  do {
    const a = getTileAttributes(world, xt, yt);
    if (a & (ATTR.SOLID | ATTR.PLATFORM)) return undoMove(p);
    if ((a & ATTR.SOLID2) && p.da42) return undoMove(p);
    xt = (xt + 1) & 0xffff;
    columns = (columns - 1) & 0xff;
  } while (columns);
  return 'ok';
}

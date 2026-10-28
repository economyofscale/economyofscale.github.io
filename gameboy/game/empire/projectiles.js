/**
 * Projectiles -- the player's shots and the enemies' -- ported from the game.
 *
 * Ten $20-byte records at $c6e0, the last ten slots of object RAM (31..40),
 * laid out like objects: +0 type (bit 6 = an enemy's shot), +1 attr,
 * +2/+3 screen position, +4..+b size and animation, +c..+f world position,
 * +10/+11 velocity, +16 counter.
 *
 *   SpawnProjectileFrom  01:501f  relative to a shooter; $233a sets bit 6
 *   SpawnProjectile      01:5057  first free slot; definitions at 01:$6095
 *   UpdateProjectiles    $1d8b    each step: move, delete off screen, walls,
 *                                 then hits on objects ($1fdf) or on the
 *                                 player ($22b0)
 *   KillObject           $234a    what a destroyed object turns into
 *
 * The routines read and write many globals; they live in `s.v` under their
 * addresses (`da2b` is $da2b; 16-bit ones as one number), and the box
 * scratch $ff90..$ff9f the overlap test works on is `s.box`.
 *
 * Callees from systems not ported yet go through `s.io.oracle(name, a)`:
 * tileAddr ($37f1), redraw ($3981), hurt ($0d73), hud
 * ($1144), dialog ($2546, the dialog screen; A, then the text address), hudForce ($113e), runFrames ($2473), sound
 * (07:$638c). Paths that end the level never return in the game; here they
 * throw LevelEnd after their last oracle, and updateProjectiles returns it.
 */

import { slot, OBJ_SIZE, initObject, spawnFromTemplate, boxOverlap } from './objects.js';
import { advanceAnimation } from './sprites.js';
import { getTileAttributes, crumble } from './collision.js';

export const PROJ_FIRST = 31;
export const PROJ_SLOTS = 10;
export const PROJ_RAM = 0xc6e0;

const w16 = (o, i) => o[i] | (o[i + 1] << 8);
const set16 = (o, i, v) => { o[i] = v & 0xff; o[i + 1] = (v >> 8) & 0xff; };
const s8 = (v) => (v & 0x80 ? v - 0x100 : v);
const neg16 = (v) => (v & 0x8000) !== 0;
const rot3 = (v) => ((v << 3) | (v >> 5)) & 0xff;

/** A path the game leaves through a level transition: it never returns. */
export class LevelEnd extends Error {
  constructor(where) { super(`level ends at ${where}`); this.where = where; }
}

/** The record at a RAM address in object RAM ($da9e and $daa0 hold such). */
const at = (s, ptr) => {
  const off = ptr - 0xc300;
  if (off < 0 || off + OBJ_SIZE > s.objs.length) throw new Error(`pointer $${ptr.toString(16)} outside object RAM`);
  return s.objs.subarray(off, off + OBJ_SIZE);
};
const addrOf = (s, o) => 0xc300 + o.byteOffset - s.objs.byteOffset;

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/**
 * 01:501f -- a shot from `shooter`: position + (dx, dy), velocity $d98e
 * mirrored when the shooter moves left, $d98f as it is.
 */
export function spawnProjectileFrom(s, shooter, type, dx, dy) {
  s.v.d988 = (w16(shooter, 0x0c) + dx) & 0xffff;
  s.v.d98a = (w16(shooter, 0x0e) + dy) & 0xffff;
  if (shooter[0x10] & 0x80) s.v.d98e = (-s.v.d98e) & 0xff;
  return spawnProjectile(s, type);
}

/**
 * 01:5057 -- the first free of the ten slots, at $d988/$d98a with velocity
 * $d98e/$d98f; facing from the velocity's signs. Returns the slot, or -1.
 */
export function spawnProjectile(s, type) {
  const { v } = s;
  for (let i = 0; i < PROJ_SLOTS; i++) {
    const p = slot(s.objs, PROJ_FIRST + i);
    if (p[0]) continue;
    p[0x00] = type;
    set16(p, 0x0c, v.d988);
    set16(p, 0x0e, v.d98a);
    p[0x10] = v.d98e;
    p[0x11] = v.d98f;
    p[0x01] = ((v.d98e & 0x80) >> 2) | (((v.d98f & 0x80) ^ 0x80) >> 1) | 0x05;
    const def = 0x6095 + (type & 0x3f) * 8;
    for (let k = 0; k < 8; k++) p[0x04 + k] = s.rom.byte(1, def + k);
    p[0x16] = 0;
    return PROJ_FIRST + i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

const boxW = (b, i) => b[i] | (b[i + 1] << 8);
const setBox = (b, i, v) => { b[i] = v & 0xff; b[i + 1] = (v >> 8) & 0xff; };
/** $ff90.. view and $ff98.. box, as 01:4efc reads them. */
const plainOverlap = (b) => boxOverlap(
  { x: boxW(b, 0), y: boxW(b, 2), w: b[4], h: b[6] },
  { x: boxW(b, 8), y: boxW(b, 10), w: b[12], h: b[14] });

/**
 * 01:4e80 -- does the box at $ff98 overlap the one at $ff90? In vehicle
 * modes ($da35 other than 0 and 2) the world wraps every $1000 px: a pair
 * straddling the seam is tested shifted, then the scratch is restored.
 */
export function overlap(s) {
  const b = s.box, m = s.v.da35;
  if (m === 0 || m === 2) return plainOverlap(b);
  const a = b[1] & 0x0c;
  if (a && a !== 0x0c) return plainOverlap(b);
  const want = a ^ 0x0c;
  if ((b[9] & 0x0c) !== want) return plainOverlap(b);
  const v0 = boxW(b, 0), b0 = boxW(b, 8);
  if (want) {
    setBox(b, 0, v0 + 0x1000);
    setBox(b, 8, (b0 | 0xf000) + 0x1000);
  } else {
    setBox(b, 0, (v0 | 0xf000) + 0x1000);
    setBox(b, 8, b0 + 0x1000);
  }
  const hit = plainOverlap(b);
  setBox(b, 8, b0);
  setBox(b, 0, v0);
  return hit;
}

/** 01:4fab -- the player's box into $ff90..$ff97. */
export function playerBox(s, player) {
  const { v, box: b } = s;
  if (v.da35) {
    for (let k = 0; k < 4; k++) b[k] = player[0x0c + k];
    if (v.da3e) { b[4] = 0x08; b[6] = 0x10; return; }
    if (v.ff8f) { b[4] = 0x18; b[6] = 0x10; return; }
  } else {
    setBox(b, 0, w16(player, 0x0c) + (player[0x01] & 0x20 ? 10 : 2));
    setBox(b, 2, w16(player, 0x0e) - 2);
  }
  b[4] = 0x0c;
  b[6] = 0x1c;
  if (v.ff8f) { b[6] = 0x1c; b[4] = 0x14; return; }
  if (v.ffa0 === 3) b[6] = 0x0c;
}

/**
 * $0fdc -- spend up to `n` of the Force meter $da95. Carry (true) when
 * there was any; the HUD is redrawn then.
 */
export function spendForce(s, n) {
  if (!s.v.da95) return false;
  for (let b = n; ;) {
    s.v.da95 = (s.v.da95 - 1) & 0xff;
    if (!s.v.da95) break;
    b = (b - 1) & 0xff;
    if (!b) break;
  }
  s.io.oracle('hud');
  return true;
}

// ---------------------------------------------------------------------------
// Destroying objects
// ---------------------------------------------------------------------------

/** $248b: types that leave a $0c behind when destroyed. */
const LEAVES_0C = new Set([0x09, 0x0a, 0x0b, 0x20, 0x21, 0x22, 0x23, 0x2e, 0x32, 0x33, 0x3a, 0x5d]);

/** Copy a record into the spawn template ($ca20), as `rst $30` does. */
const toTemplate = (s, o) => s.template.set(o.subarray(0, OBJ_SIZE));
const spawn = (s) => spawnFromTemplate(s.rom, s.objs, s.template);
const reinit = (s, o) => initObject(s.rom, Uint8Array.from(o), o);

/** $2434: the "destroyed" picture ($ab), as the probe droids get it. */
function becomeAb(s, o) {
  o[0x00] = 0xab; o[0x01] = 0x03;
  reinit(s, o);
}

/** $234a -- an object destroyed by a shot turns into what its type says. */
export function killObject(s, o) {
  const { v } = s;
  const t = o[0] & 0x7f;
  if (t === 0x0d || t === 0x0e) { o[0] = 0x8f; reinit(s, o); return; }
  if (t >= 0x10 && t <= 0x14) {
    o[0] = 0xa4; o[1] = 0x03;
    if (v.ff8b === 1) s.io.oracle('dialog', 3, 0xcaf0);
    reinit(s, o);
    return;
  }
  if (t === 0x29 || t === 0x2a || t === 0x3f || t === 0x40) {
    v.da39 = (v.da39 - 1) & 0xff;
    v.da3a = (v.da3a - 1) & 0xff;
    if (!v.da3a) {
      // $243f: the last one -- the next level, or at level 7 a vehicle mode.
      v.ff8b = (v.ff8b + 1) & 0xff;
      if (v.ff8b !== 7) {
        becomeAb(s, o);
        s.io.oracle('runFrames');
        v.da8d = 0x81;
        throw new LevelEnd('$243f');
      }
      v.da35 = 7;
      v.da3a = 0x0a;
      v.da3b = 0;
    }
    s.io.oracle('hud');
    becomeAb(s, o);
    return;
  }
  if (t === 0x2c) return killPair(s, o);
  // $2389: a short-lived effect ($02), centred on the object.
  o[0x00] = 0x02; o[0x01] = 0x04;
  o[0x10] = t; o[0x11] = t;
  const c = (o[0x04] << 2) & 0xff, b = (o[0x05] << 2) & 0xff;
  set16(o, 0x0c, w16(o, 0x0c) + c - 8);
  set16(o, 0x0e, w16(o, 0x0e) - b + 8);
  reinit(s, o);
  if (!LEAVES_0C.has(t)) return;
  toTemplate(s, o);
  s.template[0x00] = 0x0c;
  s.template[0x10] = 0; s.template[0x11] = 0;
  set16(s.template, 0x0e, w16(s.template, 0x0e) - 8);
  spawn(s);
}

/** $2498 -- type $2c and its partner in the next slot. */
function killPair(s, o) {
  o[0x00] = 0xd1;
  o[0x04] = 0x08;
  at(s, addrOf(s, o) + OBJ_SIZE)[0] = 0;
  s.io.oracle('sound', 1);
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

/** $1fdf skips these: effects, markers, and others shots pass through. */
const UNHITTABLE = new Set([0x00, 0x02, 0x08, 0x25, 0x2b, 0x52, 0x68]);
/** $2096: immune to ordinary shots. */
const IMMUNE = new Set([0x5d, 0x5e, 0x60, 0x61, 0x62]);

/** 01:7f6b, $ff-terminated: types a fatal shot destroys through $234a. */
const killList = (rom) => {
  const out = new Set();
  for (let a = 0x7f6b; rom.byte(1, a) !== 0xff; a++) out.add(rom.byte(1, a));
  return out;
};
let KILL = null;

/** $1f51 -- the shot is spent: a small burst ($82) where it was. */
function burst(s, p) {
  toTemplate(s, p);
  const t = s.template;
  t[0x00] = 0x82; t[0x01] = 0x04;
  t[0x0c] = (t[0x0c] - 4) & 0xff;
  t[0x0e] = (t[0x0e] + 4) & 0xff;
  t[0x10] = 0; t[0x11] = 0;
  spawn(s);
  p[0] = 0;
}

/** $1f10 -- the shot hits a wall: a burst snapped to the tile. */
function wallBurst(s, p) {
  s.io.oracle('sound', 0);
  toTemplate(s, p);
  const t = s.template;
  t[0x00] = 0x82; t[0x01] = 0x04;
  t[0x0c] = (((t[0x0c] + 4) & 0xf0) + 0x04) & 0xff;
  t[0x0e] = (((t[0x0e] + 4) & 0xf0) + 0x0a) & 0xff;
  t[0x10] = 0; t[0x11] = 0;
  spawn(s);
  p[0] = 0;
}

/**
 * $1fdf -- a player's shot against the objects from $c340. The first one
 * whose box it touches takes the damage; the shot is used up.
 */
function shotHitsObjects(s, p) {
  const { v, box: b } = s;
  v.da9e = 0xc340;
  for (let n = 0; n < 29; n++, v.da9e = (v.da9e + OBJ_SIZE) & 0xffff) {
    let o = at(s, v.da9e);
    if (UNHITTABLE.has(o[0] & 0x7f)) continue;
    setBox(b, 0, w16(o, 0x0c) + 2);
    setBox(b, 2, w16(o, 0x0e) - 2);
    b[4] = (o[0x18] - 4) & 0xff;
    b[6] = (o[0x19] - 4) & 0xff;
    if (!overlap(s)) continue;
    // $2040: hit.
    const d = p[0] & 0x7f;
    p[0] = 0;
    let t = o[0] & 0x7f;
    if (t === 0x0d || t === 0x0e) o[0x16] = 0x20;
    else if (t === 0x2d) {
      // The rear half: the front, one slot back, takes it.
      v.da9e = (v.da9e - OBJ_SIZE) & 0xffff;
      o = at(s, v.da9e);
      t = 0x2c;
    }
    if (t === 0x2c) {
      if (d === 0x10) return pairHitByLightsaber(s, p, o);
      if (d < 0x07) return;
    }
    let c = 5;
    if (d === 0x06) {
      if (v.da2b === 3 && v.da95) c = 0x0a;
    } else if (d !== 0x14) {
      if (IMMUNE.has(t)) return;
      c = 1;
      if (!v.da35 && v.da2b === 7 && spendForce(s, 1)) c = 0x0a;
    }
    const hp = o[0x17];
    o[0x17] = (hp - c) & 0xff;
    if (hp > c) return burst(s, p);
    // $20d0: destroyed.
    if (o[0x1b]) { o[0x1b] = 0; v.da81 = 0; }
    return destroyed(s, p, o, t);
  }
}

/** $2157 -- the lightsaber ($10) against the $2c pair, at the right height. */
function pairHitByLightsaber(s, p, o) {
  p[0] = 0x10;
  const y = s.box[10];
  if (y < 0x38 || y >= 0x50) return;
  toTemplate(s, at(s, addrOf(s, o) + OBJ_SIZE));
  const t = s.template;
  t[0x00] = 0x48;
  t[0x0e] = (t[0x0e] - 8) & 0xff;
  set16(t, 0x12, addrOf(s, o));
  spawn(s);
  p[0] = 0;
}

/** $20e1 -- what destroying a type does. */
function destroyed(s, p, o, t) {
  const { v } = s;
  switch (t) {
    case 0x2c: return killPair(s, o);
    case 0x39: case 0x3b:
      o[0] = (o[0] + 1) & 0xff;
      return reinit(s, o);
    case 0x57: case 0x58:
      toTemplate(s, o);
      s.template[0x00] = 0x59;
      s.template[0x10] = 0; s.template[0x11] = 1;
      spawn(s);
      return killObject(s, o);
    case 0x5a:
      // $21e7: the level's goal.
      o[0] = 0;
      s.io.oracle('runFrames');
      v.ff8b = (v.ff8b + 1) & 0xff;
      v.da8d = 0x81;
      throw new LevelEnd('$21e7');
    case 0x5e:
      s.io.oracle('dialog', 4, 0xcd70);
      v.da93 = 0x20; v.da95 = 0x20;
      s.io.oracle('hudForce');
      toTemplate(s, o);
      s.template[0x00] = 0x5f;
      spawn(s);
      return becomePickup(s, o);
    case 0x60: case 0x61:
      o[0] = 0x5f;
      return reinit(s, o);
    case 0x62:
      throw new LevelEnd('$2244');
    case 0x65: case 0x6e: case 0x6f:
      return becomePickup(s, o);
    default:
      KILL ??= killList(s.rom);
      if (KILL.has(t)) return killObject(s, o);
      return burst(s, p);
  }
}

/** $2291 -- the object becomes a pickup ($70) on a 32 px grid. */
function becomePickup(s, o) {
  o[0x00] = 0x70;
  o[0x0c] &= 0xe0;
  o[0x0e] &= 0xe0;
  reinit(s, o);
}

/** $22b0 -- an enemy's shot against the player. */
function shotHitsPlayer(s, p) {
  const { v } = s;
  if (v.da3e) return;
  const player = slot(s.objs, 0);
  playerBox(s, player);
  if (!overlap(s)) return;
  if (v.da2b === 6 && spendForce(s, 1)) {
    // Deflected: it flies back, as the player's ($3f).
    p[0x00] = 0x3f;
    p[0x10] = (-p[0x10]) & 0xff;
    p[0x11] = p[0x10] & 0x80 ? 0xfc : 0x04;
    return;
  }
  const type = p[0];
  p[0] = 0;
  let b = 2;
  if (type !== 0x53) {
    b = 1;
    if (!v.da35 && v.ff8f) s.io.oracle('sound', 0);
  }
  s.io.oracle('hurt', b);
  if (v.da43) {
    v.ffa0 = 0xff;
    player[0x04] = 0x03;
    player[0x05] = 0x04;
    v.da43 = 0;
    v.da2b = 0;
  }
}

/** $1e6f -- screen position of a live shot; some types animate. */
function position(s, p) {
  if (!p[0]) return;
  if (p[0] === 0x06) { p[0] = 0; return; }
  p[0x02] = ((w16(p, 0x0c) - s.cam.x) + 8) & 0xff;
  const dy = (w16(p, 0x0e) - s.cam.y) & 0xff;
  p[0x03] = (dy - rot3((p[0x05] - 1) & 0xff) + 0x12) & 0xff;
  if (p[0] === 0x53 || p[0] === 0x51 || p[0] === 0x14) advanceAnimation(p, s.rom);
}

/** $1e1b onwards: the shot's box, then what its type does. */
function collide(s, p) {
  const b = s.box;
  setBox(b, 8, w16(p, 0x0c) + 2);
  setBox(b, 10, w16(p, 0x0e) + 2);
  b[12] = 0x04;
  b[14] = 0x04;
  let t = p[0];
  if (t === 0x3f) return;
  if (t === 0x4c) {
    // A timed shot: it bursts into a $31 when its counter runs out.
    p[0x16] = (p[0x16] - 1) & 0xff;
    if (p[0x16]) return shotHitsPlayer(s, p);
    p[0] = 0;
    toTemplate(s, p);
    s.template[0x00] = 0x31; s.template[0x01] = 0x84;
    spawn(s);
    s.io.oracle('sound', 0);
    return;
  }
  if (t === 0x51 || t === 0x53 || t === 0x14) {
    // $1fb3: a beam, $20 tall, that lasts 12 steps.
    let owner = p;
    if (t === 0x51) {
      // $1fa4: lower box, and the counter of the object $da9e last pointed
      // at -- with B the low byte of that pointer, not the type.
      setBox(b, 10, boxW(b, 10) + 8);
      owner = at(s, s.v.da9e);
      t = s.v.da9e & 0xff;
    }
    b[14] = 0x20;
    owner[0x16] = (owner[0x16] + 1) & 0xff;
    if (owner[0x16] === 0x0c) { p[0] = 0; return; }
    return (t & 0x40) ? shotHitsPlayer(s, p) : shotHitsObjects(s, p);
  }
  if (t === 0x55) {
    p[0x16] = (p[0x16] + 1) & 0xff;
    if (p[0x16] === 8) p[0x11] = 0x01;
    return shotHitsPlayer(s, p);
  }
  return (t & 0x40) ? shotHitsPlayer(s, p) : shotHitsObjects(s, p);
}

/** One shot: $1d98..$1ed5. */
function updateOne(s, p) {
  const { cam, v } = s;
  objMoveProjectile(p);
  const x = w16(p, 0x0c), y = w16(p, 0x0e);
  // Off screen: gone.
  if (!neg16((cam.x - x) & 0xffff) || neg16((cam.x + 0xa0 - x) & 0xffff)
    || !neg16((cam.y - y) & 0xffff) || neg16((cam.y + 0x90 - y) & 0xffff)) {
    p[0] = 0;
    return;
  }
  if (!v.da35) {
    const a = getTileAttributes(s.world, ((x + 4) & 0xffff) >> 3, ((y + 4) & 0xffff) >> 3);
    if (a === 0xfd && !(p[0] & 0x40)) {
      // $1eec: a crumbling tile: the player's shot breaks it ($24b1).
      crumble(s.world, s.world.lastAddr, v.da30);
      v.d98a = (v.d98a & 0xff00) | ((p[0x0c] + 4) & 0xff);
      v.d988 = (v.d988 & 0xff00) | ((p[0x0e] + 4) & 0xff);
      s.io.oracle('tileAddr');
      s.io.oracle('redraw');
      wallBurst(s, p);
      return position(s, p);
    }
    if (a === 0xfd || (a & 0x01)) { wallBurst(s, p); return position(s, p); }
  }
  collide(s, p);
  position(s, p);
}

/** 01:4cc6, as $2344 calls it for shots. */
function objMoveProjectile(p) {
  const dx = p[0x10] === 0x80 ? 0 : s8(p[0x10]);
  set16(p, 0x0c, w16(p, 0x0c) + dx);
  set16(p, 0x0e, w16(p, 0x0e) + s8(p[0x11]));
}

/**
 * $1d8b -- every live shot, in slot order. s: { rom, objs, template,
 * world, cam, v, box, io }. Returns null, or the LevelEnd a hit led to.
 */
export function updateProjectiles(s) {
  try {
    for (let i = 0; i < PROJ_SLOTS; i++) {
      s.v.daa0 = PROJ_RAM + i * OBJ_SIZE;
      const p = slot(s.objs, PROJ_FIRST + i);
      if (p[0]) updateOne(s, p);
    }
    s.v.daa0 = PROJ_RAM + PROJ_SLOTS * OBJ_SIZE;
    return null;
  } catch (e) {
    if (e instanceof LevelEnd) return e;
    throw e;
  }
}

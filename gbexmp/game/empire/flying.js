/**
 * The flying levels, ported from the game. $da35 says which: 2 the
 * snowspeeder (level 2), 6, 7, 9 the Falcon (levels 6, 7, 9).
 *
 * Levels 6, 7, 9 -- $07c3, the player's half of the main loop:
 *
 *   FlyControls   01:5d42  UP/DOWN 2 px; LEFT/RIGHT speed up to 8 (every
 *                          16 steps) or turn round; without them the speed
 *                          falls back to 4 every 8 steps; B fires; move,
 *                          X wrapping at $1000
 *   FlyPriority   $1392    flying left, the sprite goes behind the tile at
 *                          its nose ($c301 bit 7)
 *   camera        $35ad    Y as on foot (01:4d9b passes)
 *                 $35c2    X by the speed, wrapping at $1000
 *   screen pos    $0a52    as on foot (sprites.js)
 *   FlyPictures   $123c    straight, climbing, diving; the 13-step turn
 *   animation     $04c3
 *   Escorts       $13d6    a pair of $29 ($3f on level 7), up to 10 in all
 *
 * Level 2 -- $076a: in the speeder FlyControls, FlyPriority, its camera
 * ($35f0), $1443, and the crash ($11c8) near the ground; on foot after it
 * the on-foot input, ForceCharge, the state machine, the camera, the saber
 * swing ($24ca, weapons.js) and $32f9; then both: screen position, the
 * speeder's pictures ($12db), animation, the spawner (01:54f0) and the
 * radar ($33b1).
 *
 * Then the shared main loop from $06ed. `p` is the physics state; `rider`
 * the player record; ctx: { rom, objs, template, world, cam (camera.js),
 * v (the shared scratch), io: { oracle(name, a) }, spawn(type) }.
 * Oracles: sound, hud (01:5c90 / $1144), the map streaming.
 */

import { slot, spawnFromTemplate } from './objects.js';
import { spawnProjectile } from './projectiles.js';
import { undoMove } from './collision.js';
import { forceCharge, playerStateMachine } from './states.js';
import { stepInput } from './player.js';
import { setPlayerAnimation, hurt } from './hurt.js';
import { advanceAnimation, playerScreenPosition } from './sprites.js';
import { getTileAttributes } from './collision.js';
import { updateCameraY, scrollStep } from './camera.js';
import { JOY } from './physics.js';
import { saberSwing } from './weapons.js';
import { grappleStart, grappleState } from './grapple.js';
import { touchObjects } from './touch.js';

const s8 = (v) => (v & 0x80 ? v - 0x100 : v);
const neg = (v) => (-v) & 0xff;
const TURNING = (s) => s === 0x0c || s === 0x0d || s === 0x12;

// ---------------------------------------------------------------------------
// Moving up and down
// ---------------------------------------------------------------------------

/** $116b -- 2 px up, not into the top 16 px (level 2: not above Y $26). */
export function flyUp(p, v) {
  const y = (p.y - 2) & 0xffff;
  if (!(y >> 8)) {
    if (!(y & 0xf0)) return;
    if (v.da35 === 0x02 && !(y & 0x80) && (y & 0xff) < 0x26) return;
  }
  p.y = y;
}

/**
 * $1193 -- 2 px down, while 32 px or more above the map's bottom. At the
 * bottom: on level 2 the snowspeeder crashes ($11c8 when already down,
 * state $12) or is hurt; elsewhere nothing.
 */
export function flyDown(p, ctx) {
  const y = (p.y + 2) & 0xffff;
  if (((y - ctx.cam.h + 0x20) & 0xffff) & 0x8000) { p.y = y; return null; }
  if (p.state === 0x12) { speederCrash(p, ctx); return null; }
  if (ctx.v.da35 !== 0x02) return null;
  return hurt(p, ctx, 1);
}

// ---------------------------------------------------------------------------
// The controls: 01:5d42
// ---------------------------------------------------------------------------

/** 01:5e8c -- a shot's start from a table entry: X, Y offsets (words). */
function shotOffset(rom, p, v, table, e) {
  const at = table + (e & 0xff);
  v.d988 = (p.x + rom.word(1, at)) & 0xffff;
  v.d98a = (p.y + rom.word(1, at + 2)) & 0xffff;
  return at + 4;
}

/** 01:5e20 -- B on the Falcon: shot 7 (8 climbing or diving), every 8 steps. */
function fireFalcon(p, ctx) {
  const { v, rom } = ctx;
  const b = p.da1b;
  p.da1b = (b + 1) & 0x07;
  if (b) return;
  p.da38 = (p.da38 + 1) & 0xff;
  let e = ((p.da38 & 1) << 2) + ((p.c310 & 0x80) >> 4);
  let type = 0x07, d = 0x10, vy = 0x00;
  if (p.da37) {
    type = 0x08; d = 0x20; vy = 0x06;
    if (p.da37 !== 0x11) { d = 0x00; vy = 0xfa; }
  }
  v.d98f = vy;
  v.d990 = type;
  e = (e + d) & 0xff;
  shotOffset(rom, p, v, 0x6145, e);
  v.d98e = (p.c310 + (p.c310 & 0x80 ? neg(0x0a) : 0x0a)) & 0xff;
  ctx.spawn(v.d990);
  ctx.io.oracle('sound', 0x0a);
  ctx.io.oracle('sound', 0x0b);
}

/** 01:5eeb -- B on the snowspeeder: a shot every 8 steps, 5 apart at least. */
function fireSpeeder(p, ctx) {
  const b = p.da1b;
  p.da1b = (b + 1) & 0x07;
  if (b) return;
  if (p.da82) return;
  p.da82 = 0x05;
  // 42 bytes per picture state from $0c, 7 per frame pair; +7 climbing or
  // diving to the left (all `rlca`, 8-bit).
  const s1 = rotl((p.state - 0x0c) & 0xff), s3 = rotl(rotl(s1)), s5 = rotl(rotl(s3));
  const d = (s5 + s1 + s3) & 0xff;
  const half = p.c308 >> 1;
  let e = (rotl(rotl(rotl(half))) - half) & 0xff;
  if (p.da37 && (p.c310 & 0x80)) e = (e + 7) & 0xff;
  speederShot(p, ctx, d, e);
}

const rotl = (v) => ((v << 1) | (v >> 7)) & 0xff;

/**
 * 01:5f2c -- a snowspeeder shot from 01:$6175, entry D + E (8-bit, as
 * 01:5e8c adds them): X, Y offsets, then speed (mirrored with the
 * ship's), Y speed, type.
 */
function speederShot(p, ctx, dHigh, e) {
  const { v, rom } = ctx;
  let at = shotOffset(rom, p, v, 0x6175, (e + dHigh) & 0xff);
  let b = p.c310 & 0x80 ? neg(p.c310) : p.c310;
  let a = rom.byte(1, at);
  if (a & 0x80) b = neg(b);
  v.d98e = (a + b) & 0xff;
  v.d98f = rom.byte(1, at + 1);
  ctx.spawn(rom.byte(1, at + 2));
  ctx.io.oracle('sound', 0x0a);
  ctx.io.oracle('sound', 0x0b);
}

/** 01:5ec3 -- SELECT on the snowspeeder: the harpoon, while any are left. */
function harpoon(p, ctx) {
  if (p.da40) return;
  if (ctx.v.da35 !== 0x02) return;
  p.da40 = 0x02;
  if (!p.da3a) return;
  p.da3a = (p.da3a - 1) & 0xff;
  ctx.io.oracle('hud');
  speederShot(p, ctx, p.c310 & 0x80 ? 0x07 : 0x00, 0x5b);
}

/** 01:5d42 */
export function flyControls(p, ctx) {
  const { v } = ctx;
  if (v.da35 === 0x02) {
    if (p.state === 0x12) {
      // $5de4: down, going down.
      const r = flyDown(p, ctx);
      p.c311 = 0;
      moveShip(p, ctx);
      return r;
    }
    const xh = p.x >> 8;
    if (!xh) p.joy = 0x01;
    else if (xh === 0x34) p.joy = 0x02;
  }
  p.da37 = 0;
  if (p.da82) p.da82 = (p.da82 - 1) & 0xff;
  let r = null;
  if (p.joy & JOY.UP && !TURNING(p.state)) { flyUp(p, v); p.da37 = 0x10; }
  if (p.joy & JOY.DOWN && !TURNING(p.state)) { r = flyDown(p, ctx) ?? r; p.da37 = 0x11; }
  if (p.joy & JOY.B) (v.da35 === 0x02 ? fireSpeeder : fireFalcon)(p, ctx);
  else p.da1b = 0;
  if (p.joy & JOY.SELECT) harpoon(p, ctx);
  else p.da40 = 0;
  const joy = p.joy;
  if (joy & JOY.LEFT && !TURNING(p.state)) {
    if (p.c310 & 0x80) {
      if (p.c310 !== 0xf8 && !(p.tick & 0x0f)) p.c310 = (p.c310 - 1) & 0xff;
    } else { p.state = 0x0c; p.da36 = 1; }
  }
  if (joy & JOY.RIGHT && !TURNING(p.state)) {
    if (!(p.c310 & 0x80)) {
      if (p.c310 !== 0x08 && !(p.tick & 0x0f)) p.c310 = (p.c310 + 1) & 0xff;
    } else { p.state = 0x0d; p.da36 = 1; }
  }
  // Without LEFT/RIGHT the speed falls back, every 8 steps: to 4 (2 on
  // level 2), either way.
  const min = v.da35 === 0x02 ? 1 : 3;
  if (!(joy & 0x03) && !(p.tick & 0x07)) {
    if (!(p.c310 & 0x80)) {
      const a = (p.c310 - 1) & 0xff;
      if (a !== min) p.c310 = a;
    } else {
      const a = (p.c310 + 1) & 0xff;
      if (a !== neg(min)) p.c310 = a;
    }
  }
  moveShip(p, ctx);
  return r;
}

/** 01:4cc6 on the player, then (not level 2) X kept within $1000. */
function moveShip(p, ctx) {
  p.x = (p.x + (p.c310 === 0x80 ? 0 : s8(p.c310))) & 0xffff;
  p.y = (p.y + s8(p.c311)) & 0xffff;
  if (ctx.v.da35 !== 0x02) p.x &= 0x0fff;
}

// ---------------------------------------------------------------------------
// The rest of the step
// ---------------------------------------------------------------------------

/** $1392 */
export function flyPriority(p, ctx) {
  if (ctx.v.da35 === 0x02) {
    p.c301 = (p.c301 & 0x7f) | (p.c310 & 0x80);
    return;
  }
  if (!(p.c310 & 0x80)) return;
  const x = ((p.x >> 3) + 1) & 0xffff, y = ((p.y >> 3) - 1) & 0xffff;
  const a = (getTileAttributes(ctx.world, x, y) & 0x80) ^ 0x80;
  p.c301 = (p.c301 & 0x7f) | a;
}

/** $35c2 -- the camera X by the speed, a pixel at a time, wrapping. */
export function flyCameraX(p, c, v, io, scroll) {
  const n = p.c310 & 0x80 ? neg(p.c310) : p.c310;
  for (let i = 0; i < (n || 256); i++) {
    c.x = ((c.x + (p.c310 & 0x80 ? -1 : 1)) & 0xffff) & 0x0fff;
    scroll(c, v, io);
  }
}

const PICTURES = {
  right: { 0x10: 0x5be2, 0x11: 0x5be4, other: 0x5be0, state: 0x0e },
  left: { 0x10: 0x5bea, 0x11: 0x5be8, other: 0x5be6, state: 0x0f },
};

/** $124d / $126f -- straight, climbing or diving, set when it changes. */
function picture(p, rider, side) {
  if (p.da37 === p.state) return;
  const t = PICTURES[side];
  const table = t[p.da37] ?? t.other;
  p.state = t[p.da37] ? p.da37 : t.state;
  setPlayerAnimation(p, rider, table, 0x02);
}

/** $123c */
export function flyPictures(p, ctx) {
  const rider = slot(ctx.objs, 0);
  if (p.state === 0x0c || p.state === 0x0d) {
    let r = null;
    if (p.state === 0x0c) flyUp(p, ctx.v);
    else r = flyDown(p, ctx);
    p.da36 = (p.da36 + 1) & 0xff;
    if (p.da36 === 0x0d) {
      p.state = p.state === 0x0c ? 0x0f : 0x0e;
      p.c310 = neg(p.c310);
    } else {
      if (p.da36 === 0x02) setPlayerAnimation(p, rider, p.state === 0x0c ? 0x5bec : 0x5bf8, 0x0c);
      return r;
    }
    picture(p, rider, p.state === 0x0f ? 'left' : 'right');
    return r;
  }
  picture(p, rider, p.c310 & 0x80 ? 'left' : 'right');
  return null;
}

/**
 * $13d6 -- two escorts round the Falcon, while fewer than two are about.
 * The counts ($da39 about, $da3b made) are the projectiles' globals, `v`:
 * a shot that downs an escort counts it off there (projectiles.js).
 */
export function escorts(p, ctx) {
  const { v, template: t } = ctx;
  if (v.da35 === 0x09) return;
  if (v.da39 >= 0x02) return;
  t[0x0c] = 0x20;
  t[0x0d] = (p.x >> 8) ^ 0x01;
  t[0x0e] = ((p.y & 0xff) - 0x3c) & 0xff;
  t[0x0f] = p.y >> 8;
  for (let n = 0; n < 2; n++) {
    if (v.da3b === 0x0a) continue;
    v.da3b = (v.da3b + 1) & 0xff;
    v.da39 = (v.da39 + 1) & 0xff;
    t[0x00] = v.da35 === 0x07 ? 0x3f : 0x29;
    t[0x01] = 0x03;
    t[0x17] = 0x01;
    t[0x10] = p.c310;
    t[0x11] = 0x00;
    spawnFromTemplate(ctx.rom, ctx.objs, t);
    t[0x0c] = (t[0x0c] + 0x80) & 0xff;
    t[0x0e] = (t[0x0e] + 0x80) & 0xff;
  }
}

/**
 * $07c3..$07de -- the player's half of a step on levels 6, 7, 9. ctx also
 * carries the optional toRider/fromRider hooks (see mount.js).
 */
export function flyStep(p, ctx) {
  const rider = slot(ctx.objs, 0), mount = slot(ctx.objs, 1);
  flyControls(p, ctx);
  flyPriority(p, ctx);
  updateCameraY(ctx.cam, p, ctx.v, ctx.io);
  flyCameraX(p, ctx.cam, ctx.v, ctx.io, scrollStep);
  ctx.toRider?.(p, rider);
  playerScreenPosition(p, rider, mount, ctx.cam, ctx.rom);
  ctx.fromRider?.(p, rider);
  flyPictures(p, ctx);
  ctx.toRider?.(p, rider);
  advanceAnimation(rider, ctx.rom);
  ctx.fromRider?.(p, rider);
  escorts(p, ctx);
}

// ---------------------------------------------------------------------------
// Level 2: the snowspeeder, $076a
// ---------------------------------------------------------------------------

const swap = (v) => ((v << 4) | (v >> 4)) & 0xff;

/**
 * $35f0 -- the speeder's camera. 39c2 first: a player outside 0 .. width -
 * 24 is put back (UndoMove) and nothing else happens. Then camera X +=
 * the speed; the ground scrolls with it ($d9a3), the mountains at an
 * eighth ($d99f, SCX).
 */
export function speederCamera(p, ctx) {
  const { cam, v } = ctx;
  if ((p.x & 0x8000) || (((cam.w - 0x18) - p.x) & 0x8000)) { undoMove(p); return; }
  v.da3c = 0x48;
  cam.x = (cam.x + s8(p.c310)) & 0xffff;
  v.d9a3 = cam.x & 0xff;
  cam.scx = (cam.x >> 3) & 0xff;
}

/**
 * $1443 -- near the start (camera X < 256), once: the hangar's column
 * cleared ($3813 finds it from $d98e/$d98f; seven tiles of the BG map).
 * ctx.clearColumn, if given, does the clearing.
 */
export function speederColumn(p, ctx) {
  const { cam, v } = ctx;
  if (cam.x >> 8) { v.da3d = cam.x >> 8; return; }
  if (v.da3d) return;
  v.da3c = cam.x & 0xff;
  v.d98e = (v.da3c - 0x10) & 0xff;
  v.d98f = 0x20;
  ctx.io.oracle('tileAddr3');
  ctx.clearColumn?.(v.d98e >> 3, v.d98f >> 3);
}

/**
 * $11c8 -- the crash: Luke on foot (02:$7bf6) at Y $78 where the speeder
 * was, the wreck (02:$7c56 as template): two bursts, a smoke, and a $30
 * 1,536 px on.
 */
export function speederCrash(p, ctx) {
  const { rom, objs, template: t } = ctx;
  p.ff8f = 0;
  ctx.io.oracle('hud');
  for (let i = 0; i < 0x20; i++) t[i] = rom.byte(2, 0x7c56 + i);
  const x = p.x;
  t[0x0c] = x & 0xff; t[0x0d] = x >> 8;
  const rider = slot(objs, 0);
  for (let i = 0; i < 0x20; i++) rider[i] = rom.byte(2, 0x7bf6 + i);
  rider[0x0c] = x & 0xff; rider[0x0d] = x >> 8;
  rider[0x0e] = 0x78;
  ctx.fromRider?.(p, rider);
  // The position too: fromRider copies only the shared flag bytes.
  p.y = rider[0x0e] | (rider[0x0f] << 8);
  t[0x00] = 0x02; t[0x01] = 0x04; t[0x0e] = 0x78;
  spawnFromTemplate(rom, objs, t);
  let w = (t[0x0c] | (t[0x0d] << 8)) + 0x18;
  t[0x0c] = w & 0xff; t[0x0d] = (w >> 8) & 0xff;
  spawnFromTemplate(rom, objs, t);
  w = (t[0x0c] | (t[0x0d] << 8)) - 0x0c;
  t[0x0c] = w & 0xff; t[0x0d] = (w >> 8) & 0xff;
  t[0x0e] = 0x5c;
  spawnFromTemplate(rom, objs, t);
  t[0x0d] = (t[0x0d] + 6) & 0xff;
  t[0x00] = 0x30; t[0x01] = 0x03;
  spawnFromTemplate(rom, objs, t);
}

const SPEEDER = { 0x10: 0x5c22, 0x11: 0x5c24, other: 0x5c20 };

/** $12fc / $131e -- straight, climbing, diving; left with $c301 bit 5. */
function speederPicture(p, rider, left) {
  if (left) p.c301 |= 0x20;
  if (p.da37 === p.state) return;
  const table = SPEEDER[p.da37] ?? SPEEDER.other;
  p.state = SPEEDER[p.da37] ? p.da37 : (left ? 0x0f : 0x0e);
  setPlayerAnimation(p, rider, table, 0x02);
}

/** $12db */
export function speederPictures(p, ctx) {
  if (!p.ff8f) return null;
  const rider = slot(ctx.objs, 0);
  p.c301 &= 0xdf;
  if (p.state === 0x12) return null;
  if (p.state === 0x0c || p.state === 0x0d) {
    let r = null;
    if (p.state === 0x0c) flyUp(p, ctx.v);
    else r = flyDown(p, ctx);
    p.da36 = (p.da36 + 1) & 0xff;
    if (p.da36 === 0x0d) {
      const left = p.state === 0x0c;
      p.state = left ? 0x0f : 0x0e;
      p.c310 = neg(p.c310);
      speederPicture(p, rider, left);
    } else if (p.da36 === 0x02) {
      setPlayerAnimation(p, rider, p.state === 0x0c ? 0x5c26 : 0x5c32, 0x0c);
    }
    return r;
  }
  speederPicture(p, rider, !!(p.c310 & 0x80));
  return null;
}

/**
 * 01:54f0 -- now and then (a random draw ($1599) with its low 5 bits 0):
 * in the speeder a shot from the left edge (7) or a $4c from the right;
 * on foot (bits 0-5 clear) a trooper ($32) 128 px ahead.
 */
export function speederSpawner(p, ctx) {
  const { v, objs, template: t } = ctx;
  if (v.da3e) return;
  const c = ctx.random();
  if (c & 0x1f) return;
  if (!p.ff8f) {
    if (c & 0x3f) return;
    t.set(slot(objs, 0));
    const x = ((t[0x0c] | (t[0x0d] << 8)) + 0x80) & 0xffff;
    t[0x0c] = x & 0xff; t[0x0d] = x >> 8;
    t[0x0e] = 0x78;
    t[0x11] = 0x00;
    t[0x00] = 0x32; t[0x01] = 0x04;
    t[0x14] = 0xff; t[0x15] = 0x7f;
    spawnFromTemplate(ctx.rom, objs, t);
    return;
  }
  const shots = { rom: ctx.rom, objs, v };
  if (!(c & 0x80)) {
    v.d988 = ctx.cam.x;
    v.d98a = ((ctx.random() & 0x3f) + 0x20) & 0xff;
    v.d98f = 0x00;
    v.d98e = 0x10;
    spawnProjectile(shots, 0x07);
    return;
  }
  v.d988 = (ctx.cam.x + 0x98) & 0xffff;
  // $1599 leaves its result in C too: the counter comes from this draw.
  const c2 = ctx.random();
  v.d98a = ((c2 & 0x1f) + 0x30) & 0xff;
  v.d98f = 0xff;
  v.d98e = 0xf6;
  const s = spawnProjectile(shots, 0x4c);
  if (s >= 0) slot(objs, s)[0x16] = (swap(c2) + 4) & 0x0f;
}

/**
 * $33b1 -- the radar: sprite entries at $c100 (shown below line $7f), one
 * per other object slot from $c340: a blinking walker ($7d..$7f) for each
 * AT-AT ($2c) by its X, else just tile $7b; then the player's ($7c).
 */
export function radar(p, ctx) {
  const { v, objs } = ctx;
  const oam = ctx.radar;
  v.d98e = swap(p.tick);
  let de = 0;
  for (let i = 0; i < 9; i++) {
    const o = slot(objs, 2 + 2 * i);
    if ((o[0] & 0x7f) === 0x2c) {
      oam[de] = 0x96;
      oam[de + 1] = ((o[0x0d] << 1) + 8) & 0xff;
      v.d98e = (v.d98e + 1) & 0x03;
      let a = (v.d98e + 0x7d) & 0xff;
      if (a === 0x80) a = 0x7e;
      oam[de + 2] = a;
    } else {
      oam[de + 2] = 0x7b;
    }
    de += 4;
  }
  oam[de] = 0x96;
  oam[de + 1] = (((p.x >> 8) << 1) + 9) & 0xff;
  oam[de + 2] = 0x7c;
}

/** What grapple.js needs, from the speeder step's context. */
function grappleContext(p, ctx, rider) {
  const to = ctx.toRider ?? (() => {}), from = ctx.fromRider ?? (() => {});
  const tctx = {
    rom: ctx.rom, objs: ctx.objs, world: ctx.world, template: ctx.template, v: ctx.v, box: ctx.box,
    io: ctx.io, cam: ctx.cam, toRider: ctx.toRider, fromRider: ctx.fromRider,
  };
  const g = {
    rom: ctx.rom, objs: ctx.objs, template: ctx.template, rider, io: ctx.io, box: ctx.box,
    toRider: to, fromRider: from,
    touch: () => touchObjects(p, tctx),
    touched: () => tctx.touched,
    // $1089, as the grapple's end calls it.
    stateMachine: () => { to(p, rider); playerStateMachine(p, rider, ctx.rom, g.psm); from(p, rider); },
  };
  g.psm = { grapple: (pl) => grappleState(pl, g), objs: ctx.objs };
  return g;
}

/** $076a..$07c0 */
export function speederStep(p, ctx) {
  const rider = slot(ctx.objs, 0);
  let r = null;
  if (p.ff8f) {
    r = flyControls(p, ctx);
    flyPriority(p, ctx);
    speederCamera(p, ctx);
    speederColumn(p, ctx);
    // $077b: down to 30 px above the map's bottom -- the crash.
    if (p.ff8f && !(((p.y - ctx.cam.h + 0x1e) & 0xffff) & 0x8000)) speederCrash(p, ctx);
  } else {
    // On foot after the crash: the grapple (grapple.js) and its knockback.
    const g = grappleContext(p, ctx, rider);
    const io = {
      ...ctx.step.io,
      grapple: (pl) => grappleStart(pl, g),
      cameraBy: (dx) => { ctx.cam.x = (ctx.cam.x + dx) & 0xffff; },
    };
    stepInput(p, { ...ctx.step, io });
    ctx.toRider?.(p, rider);
    forceCharge(p, rider);
    playerStateMachine(p, rider, ctx.rom, g.psm);
    ctx.fromRider?.(p, rider);
    speederCamera(p, ctx);
    if (p.ff8d) saberSwing(p, ctx);
    if (p.da80) {
      // $32f9
      p.da80 = (p.da80 - 1) & 0xff;
      if (!p.da80) { ctx.io.oracle('sound', 0x11); ctx.io.oracle('sound', 0x12); }
    }
  }
  ctx.toRider?.(p, rider);
  playerScreenPosition(p, rider, slot(ctx.objs, 1), ctx.cam, ctx.rom);
  ctx.fromRider?.(p, rider);
  r = speederPictures(p, ctx) ?? r;
  ctx.toRider?.(p, rider);
  advanceAnimation(rider, ctx.rom);
  ctx.fromRider?.(p, rider);
  speederSpawner(p, ctx);
  radar(p, ctx);
  return r;
}

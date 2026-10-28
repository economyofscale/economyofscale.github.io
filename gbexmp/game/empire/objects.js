/**
 * Objects -- enemies, platforms, pickups -- ported from the game.
 *
 * Object RAM is one byte array mirroring $c300..$c81f: 41 records of $20
 * bytes (layout in sprites.js). $c300 is the player, $c320 the mount; level
 * objects live from $c340.
 *
 *   LevelSpawner      $3db0  each step: spawn list entries as they come into
 *                            view (list per level at 03:$605e)
 *   UpdateObjects     $261d  each step: dispatch every active object to its
 *                            type's handler (table at $2654)
 *   InitObject        $3ef1  a record from its type's definition (03:$5c76)
 *   TimedSpawner   01:5148  every 128 steps: drop far-off objects of the
 *                            level's kinds, top them up to two
 *
 * Handlers not ported yet are reported through `handlers.unported(type)`;
 * the play mode falls back to the shared tail for them (animate and draw),
 * the parity test leaves them out.
 */

import { advanceAnimation } from './sprites.js';
import { killObject } from './projectiles.js';
import { probeGround } from './physics.js';

export const OBJ_RAM = 0xc300;
export const OBJ_SIZE = 0x20;
export const OBJ_SLOTS = 41;

/** A fresh object RAM image, $c300..$c81f. */
export function createObjects() {
  return new Uint8Array(OBJ_SLOTS * OBJ_SIZE);
}

/** One record as a view into object RAM. */
export const slot = (objs, i) => objs.subarray(i * OBJ_SIZE, (i + 1) * OBJ_SIZE);

const w16 = (o, i) => o[i] | (o[i + 1] << 8);
const set16 = (o, i, v) => { o[i] = v & 0xff; o[i + 1] = (v >> 8) & 0xff; };
const s8 = (v) => (v & 0x80 ? v - 0x100 : v);
/** `rlca` three times: *8 for sizes below 32, as the game computes it. */
const rot3 = (v) => ((v << 3) | (v >> 5)) & 0xff;

// ---------------------------------------------------------------------------
// Type definitions and creation
// ---------------------------------------------------------------------------

/** 03:$5c76: 8 bytes per type -- w, h (cells), anim length, anim table, ?, box w, h. */
export function typeDef(rom, type) {
  const ptr = rom.word(3, 0x5c76 + ((type - 1) & 0x7f) * 2);
  return Array.from({ length: 8 }, (_, i) => rom.byte(3, ptr + i));
}

/**
 * $3ef1 -- copy a source record into `dst` and fill in the type's
 * definition: size, first metasprite, animation, hit box. Hidden (bit 7)
 * until the screen position says otherwise.
 */
export function initObject(rom, src, dst) {
  dst.set(src.subarray(0, OBJ_SIZE));
  const d = typeDef(rom, src[0]);
  const table = d[3] | (d[4] << 8);
  dst[0x00] |= 0x80;
  dst[0x02] = 0; dst[0x03] = 0;
  dst[0x04] = d[0]; dst[0x05] = d[1];
  // Read with bank 3 switched in, like the definition itself.
  dst[0x06] = rom.byte(3, table); dst[0x07] = rom.byte(3, table + 1);
  dst[0x08] = 0; dst[0x09] = d[2];
  dst[0x0a] = d[3]; dst[0x0b] = d[4];
  dst[0x16] = 0;
  dst[0x18] = d[6]; dst[0x19] = d[7];
  dst[0x1a] = 0;
}

/** $3ed9 -- first free slot from $c340; returns its index, or -1. */
export function spawnFromTemplate(rom, objs, template) {
  for (let i = 2; i < 2 + 29; i++) {
    const o = slot(objs, i);
    if (o[0]) continue;
    initObject(rom, template, o);
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Views and visibility
// ---------------------------------------------------------------------------

/**
 * $4efc -- does the box (x, y = bottom, w, h) overlap the view (x, y =
 * bottom, w, h)? All 16-bit, wrapping and signed as the game computes.
 */
export function boxOverlap(view, box) {
  const neg = (v) => (v & 0x8000) !== 0;
  if (neg((view.x + view.w - box.x) & 0xffff)) return false;
  if (neg((box.x + box.w - view.x) & 0xffff)) return false;
  if (!neg((view.y - view.h - box.y) & 0xffff)) return false;
  if (!neg((box.y - box.h - view.y) & 0xffff)) return false;
  return true;
}

/**
 * 01:4e80 -- boxOverlap, but in vehicle modes ($da35 other than 0 and 2)
 * the world wraps every $1000 px: a view and a box on either side of the
 * seam are tested with one of them moved across it. (projectiles.js
 * `overlap` is the same on the $ff90 scratch.)
 */
export function boxOverlapWrapped(view, box, da35) {
  if (da35 === 0 || da35 === 2) return boxOverlap(view, box);
  const a = (view.x >> 8) & 0x0c;
  if (a && a !== 0x0c) return boxOverlap(view, box);
  const want = a ^ 0x0c;
  if (((box.x >> 8) & 0x0c) !== want) return boxOverlap(view, box);
  const across = (x) => ((x | 0xf000) + 0x1000) & 0xffff;
  const on = (x) => (x + 0x1000) & 0xffff;
  return want
    ? boxOverlap({ ...view, x: on(view.x) }, { ...box, x: across(box.x) })
    : boxOverlap({ ...view, x: across(view.x) }, { ...box, x: on(box.x) });
}

/** 01:4bc8 -- the screen, as UpdateObjects tests against it. */
export const screenView = (cam) => ({ x: cam.x, y: (cam.y + 0x90) & 0xffff, w: 0xa0, h: 0x90 });
/** $3db0 -- the spawn view: 16 px wider each side, a little taller. */
export const spawnView = (cam) => ({ x: (cam.x - 16) & 0xffff, y: (cam.y + 0x98) & 0xffff, w: 0xc0, h: 0xa0 });

// ---------------------------------------------------------------------------
// The level spawner
// ---------------------------------------------------------------------------

/** Spawned at once, whatever the view ($3e23..$3e39). */
const ALWAYS = new Set([0x07, 0x28, 0x2c, 0x2d, 0x6d, 0x37]);

/** 03:$605e -- the object list of a level: 11-byte entries, $ff-terminated. */
export function levelList(rom, level) {
  let p = rom.word(3, 0x605e + (level - 1) * 2);
  const entries = [];
  while (rom.byte(3, p) !== 0xff && entries.length < 255) {
    entries.push(Uint8Array.from({ length: 11 }, (_, i) => rom.byte(3, p + i)));
    p += 11;
  }
  return entries;
}

/**
 * The spawn template at $ca20. It shares RAM with the in-game script, which
 * is unpacked there, and the spawner fills only its first $18 bytes: the
 * rest is whatever was there -- script text at first -- and is copied into
 * every object it spawns. Kept persistent, as RAM is.
 */
export function createTemplate(script) {
  return Uint8Array.from({ length: OBJ_SIZE }, (_, i) => script[i] ?? 0);
}

/**
 * $3db0 -- spawn every list entry whose box comes into the spawn view, once
 * each ($d9c6 + i is its flag). Records the entry index at +$1a. The view
 * and each entry's box go through the scratch at $ff90 (`state.box`, when
 * there is one), and each entry's definition byte 5 through $d98e, as the
 * game leaves them.
 */
export function levelSpawner(state) {
  const { rom, objs, list, spawned, cam, template, box: b } = state;
  const view = spawnView(cam);
  if (b) {
    b[0] = view.x & 0xff; b[1] = view.x >> 8; b[2] = view.y & 0xff; b[3] = view.y >> 8;
    b[4] = view.w; b[6] = view.h;
  }
  for (let i = 0; i < list.length; i++) {
    if (spawned[i]) continue;
    const e = list[i];
    const type = e[0] & 0x7f;
    const d = typeDef(rom, type);
    if (b) b.set(e.subarray(1, 5), 8);
    if (state.v) state.v.d98e = d[5];
    if (!ALWAYS.has(type)) {
      if (type === 0x1f && state.da92) continue;
      if (type !== 0x1f) {
        const box = { x: e[1] | (e[2] << 8), y: e[3] | (e[4] << 8), w: (d[6] + 8) & 0xff, h: (d[7] + 8) & 0xff };
        if (b) { b[12] = box.w; b[14] = box.h; }
        if (!boxOverlap(view, box)) continue;
      }
    }
    template[0x00] = type;
    template[0x01] = 0x0c;
    template.set(e.subarray(1, 11), 0x0c);
    template[0x16] = 0;
    template[0x17] = d[5];
    if (DA32_TYPES.has(type)) {
      // $3e7a: a boss -- music 7, $da83 = 1, the driver's $dfef = 0. The
      // driver's start (07:$656d) clears $ff90 too: the low byte of the
      // view's X, for every entry after this one.
      state.io?.oracle('bossMusic');
      state.da83 = 1;
      view.x &= 0xff00;
      if (b) b[0] = 0;
    }
    const s = spawnFromTemplate(rom, objs, template);
    spawned[i] = 1;
    // No free slot: $3ed9 leaves HL at $c6e0, and the index goes there.
    const o = s < 0 ? objs.subarray(0x3e0 - 0x1a, 0x3e0 - 0x1a + OBJ_SIZE) : slot(objs, s);
    o[0x1a] = i & 0xff;
    o[0x1b] = 0;
    // $3ebd: a marked entry's byte in +$1b (and $da81).
    if (e[0] & 0x80) { o[0x1b] = e[0]; state.da81 = e[0]; }
  }
}

// ---------------------------------------------------------------------------
// The timed spawner
// ---------------------------------------------------------------------------

const boxW = (b, i) => b[i] | (b[i + 1] << 8);
const setBox = (b, i, v) => { b[i] = v & 0xff; b[i + 1] = (v >> 8) & 0xff; };
const neg16 = (v) => (v & 0x8000) !== 0;

/**
 * 01:5257 -- is the point at $ff98/$ff9a within the wide box round the
 * camera ($ff90 = camX - 256, $ff92 = camY + $d0): X up to 672 px on, Y
 * from 272 px above $ff92 up to it?
 */
function inTimedRange(b) {
  const x = boxW(b, 8), y = boxW(b, 10), bx = boxW(b, 0), by = boxW(b, 2);
  if (neg16((bx + 0x2a0 - x) & 0xffff)) return false;
  if (neg16((x - bx) & 0xffff)) return false;
  if (!neg16((by - 0x110 - y) & 0xffff)) return false;
  if (!neg16((y - by) & 0xffff)) return false;
  return true;
}

/**
 * 01:5148 (main loop $06e7, when $d99e & $7f = $2f) -- objects of the
 * level's kinds ($39f8 + level * 2, $ff-terminated) far from the camera
 * are deleted, and may spawn again ($d9c6 + their +$1a cleared). With
 * fewer than two left, entries of the level's list (01:$7b79, 11 bytes:
 * type, then the record from +$0c) in range but not within 40 px of the
 * player spawn, until there are two. Counts in $d98e, the list address in
 * $d988, boxes in $ff90.. -- all scratch the game leaves there.
 * state: { rom, objs, template, spawned, cam, v, box, level }.
 */
export function timedSpawner(state) {
  const { rom, objs, template: t, v, box: b } = state;
  v.d98e = 0;
  setBox(b, 0, state.cam.x - 0x100);
  setBox(b, 2, state.cam.y + 0xd0);
  const kinds = rom.word(0, 0x39f8 + ((state.level << 1) & 0xff));
  v.d988 = kinds;
  const counted = new Set();
  for (let a = kinds; rom.byte(0, a) !== 0xff; a++) counted.add(rom.byte(0, a));
  v.da9e = 0xc340;
  for (let n = 0; n < 29; n++, v.da9e = (v.da9e + OBJ_SIZE) & 0xffff) {
    const o = slot(objs, 2 + n);
    if (!counted.has(o[0] & 0x7f)) continue;
    for (let k = 0; k < 4; k++) b[8 + k] = o[0x0c + k];
    if (inTimedRange(b)) { v.d98e = (v.d98e + 1) & 0xff; continue; }
    // $523a: gone, and free to spawn again.
    o[0] = 0;
    if (o[0x1a]) state.spawned[o[0x1a]] = 0;
  }
  if (v.d98e >= 2) return;
  const px = w16(slot(objs, 0), 0x0c);
  for (let e = rom.word(1, 0x7b79 + ((state.level << 1) & 0xff)); ; e += 11) {
    const type = rom.byte(1, e);
    if (type === 0xff) return;
    t[0x00] = type;
    for (let k = 0; k < 4; k++) b[8 + k] = rom.byte(1, e + 1 + k);
    if (inTimedRange(b)) {
      const d = (px + 0x28 - boxW(b, 8)) & 0xffff;
      if (neg16(d) || !neg16((d - 0x50) & 0xffff)) {
        t[0x01] = 0x04;
        for (let k = 0; k < 10; k++) t[0x0c + k] = rom.byte(1, e + 1 + k);
        t[0x16] = 0;
        t[0x17] = typeDef(rom, type)[5];
        spawnFromTemplate(rom, objs, t);
        v.d98e = (v.d98e + 1) & 0xff;
      }
    }
    if (v.d98e >= 2) return;
  }
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

/** 01:4cc6 -- X += velocity +$10 ($80 counts as 0), Y += +$11. */
export function objMove(o) {
  const dx = o[0x10] === 0x80 ? 0 : s8(o[0x10]);
  set16(o, 0x0c, w16(o, 0x0c) + dx);
  set16(o, 0x0e, w16(o, 0x0e) + s8(o[0x11]));
}

/**
 * 01:4d0d -- reverse the velocity at the ends of the patrol range
 * (+$12 min, +$14 max): signed for X, unsigned (carry) for Y. $d98f (in
 * `v`) is cleared, or the new X velocity; returns it, or 1 for a Y turn.
 */
export function objPatrolBounds(o, v) {
  v.d98f = 0;
  const dx = o[0x10];
  if (dx) {
    const x = w16(o, 0x0c);
    const reverse = dx & 0x80
      ? !((w16(o, 0x12) - x) & 0x8000)
      : !!((w16(o, 0x14) - x) & 0x8000);
    if (!reverse) return 0;
    o[0x10] = (-dx) & 0xff;
    v.d98f = o[0x10];
    return o[0x10];
  }
  const dy = o[0x11];
  if (!dy) return 0;
  const y = w16(o, 0x0e);
  const reverse = dy & 0x80 ? w16(o, 0x12) >= y : w16(o, 0x14) < y;
  if (!reverse) return 0;
  o[0x11] = (-dy) & 0xff;
  return 1;
}

/** Item types drawn into the background ($32ba), not as sprites. */
const isBgItem = (t) => (t >= 0x15 && t < 0x20) || t === 0x70;
/** $56f2: types whose +$17 is copied to $da32 when on screen. */
const DA32_TYPES = new Set([0x0d, 0x0e, 0x10, 0x11, 0x12, 0x13, 0x14, 0x2c, 0x3b, 0x5a, 0x5d, 0x62, 0x65, 0x66, 0x67, 0x69, 0x6a]);

/**
 * 01:5639 -- on screen: clear bit 7 and set the screen position; off
 * screen: stay hidden. Background items are queued in state.bgItems
 * instead (their drawing, $32ba, writes the BG map). The box goes into
 * the scratch at $ff98 first (`state.box`, when there is one), as the
 * game leaves it.
 */
export function objScreenPosition(state, o) {
  const x = w16(o, 0x0c), y = w16(o, 0x0e);
  const box = { x, y, w: rot3(o[0x04]), h: rot3(o[0x05]) };
  if (state.box) {
    state.box.set(o.subarray(0x0c, 0x10), 8);
    state.box[12] = box.w;
    state.box[14] = box.h;
  }
  if (!boxOverlapWrapped(screenView(state.cam), box, state.v?.da35 ?? 0)) {
    // $1478: a falling walker goes on falling off screen too.
    if (o[0x00] === 0xd1) walkerPicture(state, o);
    return;
  }
  const t = o[0x00] & 0x7f;
  if (t === 0x2d || t === 0x51) {
    // $148c: the walker, drawn into the BG; the band's SCX puts it there.
    state.v.da86 = o[0x00];
    state.v.da3c = (-(x - state.cam.x)) & 0xff;
    // The step's cost counts these calls (timing.js `walkers`), not pictures.
    state.walkers = (state.walkers ?? 0) + 1;
    return walkerPicture(state, o);
  }
  if (t === 0x52) {
    // $147b: the wreck on screen -- its address in $da84.
    state.v.da84 = 0xc300 + o.byteOffset - state.objs.byteOffset;
    return;
  }
  if (isBgItem(t)) {
    // $32ba draws it into the BG map (play.js render), its position passed
    // to $37f1 in the low bytes of $d98a (X) and $d988 (Y - 8).
    state.v.d98a = (state.v.d98a & 0xff00) | o[0x0c];
    state.v.d988 = (state.v.d988 & 0xff00) | ((o[0x0e] - 8) & 0xff);
    state.bgItems.push(o);
    return;
  }
  o[0x00] &= 0x7f;
  o[0x02] = ((x - state.cam.x) + 8) & 0xff;
  o[0x03] = (((y - state.cam.y) & 0xff) - rot3(o[0x05]) + 0x12) & 0xff;
  if (o[0x00] === 0x49) { o[0x02] = (o[0x02] + o[0x12]) & 0xff; return; }
  if (DA32_TYPES.has(o[0x00])) state.da32 = o[0x17];
}

/**
 * $2736 -- animate, face by velocity, position on screen, and mirror the
 * hidden bit into attribute bit 3.
 */
export function objectCommonTail(state, o) {
  advanceAnimation(o, state.rom);
  const t = o[0x00] & 0x7f;
  if (t !== 0x2c && t !== 0x4f && t !== 0x50) {
    o[0x01] = (o[0x01] & 0xdf) | (o[0x10] & 0x80 ? 0x20 : 0);
    if ((t === 0x66 || t === 0x6a || t === 0x0a) && o[0x08] >= 4) o[0x01] ^= 0x60;
  }
  objScreenPosition(state, o);
  o[0x01] = (o[0x01] & 0xf7) | ((o[0x00] & 0x80) >> 4);
}

/** Type -> handler, as the table at $2654 says. Only the ported ones. */
const HANDLERS = {
  0x2736: (state, o) => objectCommonTail(state, o),
  0x2796: () => {},                                     // NextObject: nothing
  0x27ad: (state, o) => {                               // the mount
    if (state.p.da34) return;
    if (!state.p.ff8f) return objectCommonTail(state, o);
    o[0x00] &= 0x7f;
  },
  0x27bd: (state, o) => {                               // short-lived effect
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] === 8) { o[0x00] = 0; return; }
    objectCommonTail(state, o);
  },
  0x27ca: (state, o) => {                               // type $03: bob, then turn
    objMove(o);
    objPatrolBounds(o, state.v);
    o[0x16] = (o[0x16] + 1) & 0x1f;
    if (!o[0x16]) {
      // $27eb: stop, then $3199: become the next type, re-initialised.
      o[0x10] = 0; o[0x11] = 0;
      o[0x00] = (o[0x00] + 1) & 0xff;
      initObject(state.rom, Uint8Array.from(o), o);
    } else if (!(o[0x16] & 0x0f)) {
      o[0x11] = (-o[0x11]) & 0xff;
    }
    objectCommonTail(state, o);
  },
  0x28a4: (state, o) => {                               // patrol
    objMove(o);
    objPatrolBounds(o, state.v);
    objectCommonTail(state, o);
  },
  0x30a6: (state, o) => {                               // $61: Vader beaten, falls
    o[0x01] = 0x07;
    HANDLERS[0x28a4](state, o);
  },
  0x27f5: (state, o) => {                               // type $04: fires, turns
    const f = o[0x08];
    if (f === 0x06) {
      shoot(state, o, 0x04, 0x00, 0x08, 0x0c, -0x14);
    } else if (f === 0x0a) {
      o[0x10] = 0;
      shoot(state, o, 0x05, 0x08, 0x08, 0x04, -0x10);
      shoot(state, o, 0x05, 0xf8, null, 0x04, -0x10);
    } else if (f === 0x13) {
      // Back to $03, walking towards the player.
      o[0x00] = 0x83;
      o[0x10] = (facePlayer(state, o) << 1) & 0xff;
      o[0x11] = 0x02;
      initObject(state.rom, Uint8Array.from(o), o);
    }
    objectCommonTail(state, o);
  },
  0x2cdb: (state, o) => {                               // type $2e: chaser, fires
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] & 0x1f) return chase(state, o);
    shoot(state, o, 0x15, 0x02, 0xff, 0x08, -0x14);
    objectCommonTail(state, o);
  },
  0x2d12: (state, o) => {                               // types $32 $34: aim, fire
    o[0x10] = (facePlayer(state, o) << 1) & 0xff;
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] === 0x10) return nextType(state, o);
    if (!(o[0x16] & 0x03)) {
      shoot(state, o, 0x49, 0x0c, 0x00, 0x08, -0x17);
      if (!(o[0x01] & 0x08)) { state.io.oracle('sound', 0x0c); state.io.oracle('sound', 0x0d); }
    }
    objectCommonTail(state, o);
  },
  0x2d5f: (state, o) => {                               // types $33 $35: patrol, then back
    objMove(o);
    objPatrolBounds(o, state.v);
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] === 0x38) return prevType(state, o);
    objectCommonTail(state, o);
  },
  0x2d73: (state, o) => {                               // type $39: turret
    if ((state.p.tick & 0x07) === 0x06) {
      shoot(state, o, 0x12, 0xf0, 0x00, -0x10, -0x19);
      if (!(o[0x01] & 0x08)) state.io.oracle('sound', 0x0e);
    }
    objectCommonTail(state, o);
  },
  0x2b19: (state, o) => escortA(state, o),             // $29: the Falcon's escort (6)
  0x2dd6: (state, o) => escortB(state, o),             // $3f: the TIE escort (7)
  0x2bcf: (state, o) => {                               // $2a $40: turned away
    if (o[0x08] === 0x09) {
      // $2bf7: back round, the previous type.
      o[0x11] = 0;
      o[0x10] = (-o[0x10]) & 0xff;
      return prevType(state, o);
    }
    flyMove(o);
    objectCommonTail(state, o);
  },
  0x2c04: (state, o) => {                               // $2b: an effect, gone at frame $0f
    if (o[0x08] === 0x0f) { o[0] = 0; return; }
    objectCommonTail(state, o);
  },
  0x28ed: (state, o) => {                               // $0a $5c: patrol, then the previous type
    objMove(o);
    objPatrolBounds(o, state.v);
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] === 0x48) return prevType(state, o);
    objectCommonTail(state, o);
  },
  0x300b: (state, o) => {                               // $5a: the Star Destroyer (9)
    o[0x01] = 0x01;
    const t = state.p.tick;
    if (!(t & 0x70) && (t & 0x01)) {
      // $3037 -> $2e53: fire as the TIEs do, then move.
      escortShot(state, o, 0x0b, 0x0c, -0x0c);
      return escortMove(state, o);
    }
    if (!t) {
      // $304a: launch a $5c from where it is.
      state.template.set(o.subarray(0, OBJ_SIZE));
      state.template[0x10] = 0; state.template[0x11] = 0;
      state.template[0x01] = 0x01;
      state.template[0x00] = 0x5c;
      spawnFromTemplate(state.rom, state.objs, state.template);
    } else if (!((t + 0x26) & 0x7f)) {
      // $3024: speed 3, whatever the facing (the facing found is unused).
      facePlayer(state, o);
      o[0x10] = 0x03;
    }
    escortMove(state, o);
  },
  0x2c11: (state, o) => atat(state, o),                // $2c: the AT-AT
  0x2f11: (state, o) => {                               // $48: the tow cable
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] !== 0x20) {
      o[0x10] = (state.p.tick & 0x02) << 6;
      return objectCommonTail(state, o);
    }
    // Round the legs: the walker falls ($2498), the cable goes.
    const walker = at(state, w16(o, 0x12));
    walker[0x00] = 0xd1;
    walker[0x04] = 0x08;
    at(state, w16(o, 0x12) + OBJ_SIZE)[0x00] = 0;
    state.io.oracle('sound', 0x01);
    o[0x00] = 0;
    objectCommonTail(state, o);
  },
  0x2f48: (state, o) => {                               // $4c: down, then two types back
    o[0x11] = 0xff;
    objMove(o);
    if (!objPatrolBounds(o, state.v)) return objectCommonTail(state, o);
    o[0x00] = (o[0x00] - 1) & 0xff;
    o[0x11] = 0x04;
    prevType(state, o);
  },
  0x2cd0: (state, o) => {                               // $2d: its rear half
    if (!(state.p.tick & 0x07)) objMove(o);
    objectCommonTail(state, o);
  },
  0x3187: (state, o) => {                               // type $6d: wakes when seen
    if (!(o[0x01] & 0x08)) o[0x00] = 0x36;
    objectCommonTail(state, o);
  },
  0x2874: (state, o) => {                               // type $05: drops, then lands
    const fell = dropOnto(state, o, 2);
    if (fell) {
      if (o[0x08] === 0x0d) o[0x08] = 0x0c;
      return objectCommonTail(state, o);
    }
    if (o[0x08] === 0x0d) return nextType(state, o);
    objectCommonTail(state, o);
  },
  0x28ad: (state, o) => {                               // type $09: walks at the player
    const a = facePlayer(state, o);
    o[0x10] = (a << 1) & 0xff;
    // 01:55e2 leaves player X - X in BC.
    const bc = (w16(state.objs, 0x0c) - w16(o, 0x0c)) & 0xffff;
    objMove(o);
    if (objPatrolBounds(o, state.v)) return nextType(state, o);
    if (state.p.da1e === 0x0e) {
      // $28e9: one more on top of $3199's.
      o[0x00] = (o[0x00] + 1) & 0xff;
      return nextType(state, o);
    }
    let b = bc >> 8, c = bc & 0xff;
    if (b & 0x80) { c = (-c) & 0xff; b ^= 0xff; }
    if (!b && !(c & 0xe0)) return nextType(state, o);
    objectCommonTail(state, o);
  },
  0x2913: (state, o) => {                               // type $0c: falls, breaks on landing
    objMove(o);
    if (state.p.tick & 0x03) return objectCommonTail(state, o);
    if (dropOnto(state, o, 1)) return objectCommonTail(state, o);
    killObject(state, o);
  },
  0x2933: (state, o) => {                               // type $0d: runs at the player, blinking
    blink(o);
    o[0x10] = (facePlayer(state, o) * 3) & 0xff;
    objMove(o);
    if (!objPatrolBounds(o, state.v)) return objectCommonTail(state, o);
    nextType(state, o);
  },
  0x2971: (state, o) => {                               // type $0e: blinking, its sound
    blink(o);
    objMove(o);
    if (o[0x08] === 0x0f) return prevType(state, o);
    if (!(o[0x01] & 0x08)) { state.io.oracle('sound', 0x07); state.io.oracle('sound', 0x08); }
    objectCommonTail(state, o);
  },
  0x299a: (state, o) => {                               // type $0f: sparks, then gone
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] === 0x20) { killObject(state, o); return; }
    spark(state, o, o[0x16]);
  },
  0x29e5: (state, o) => {                               // type $10: bobs, rises or turns
    objMove(o);
    objPatrolBounds(o, state.v);
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] & 0x0f) return objectCommonTail(state, o);
    o[0x11] = (-o[0x11]) & 0xff;
    if (!(o[0x11] & 0x80)) {
      if (state.p.tick & 0x40) return nextType(state, o);
      return objectCommonTail(state, o);
    }
    // $2a10: 16 px lower, as $14.
    set16(o, 0x0e, w16(o, 0x0e) + 0x10);
    o[0x00] = 0x94;
    initObject(state.rom, Uint8Array.from(o), o);
    objectCommonTail(state, o);
  },
  0x2a30: (state, o) => {                               // type $11: to frame 5
    if (o[0x08] === 0x05) return nextType(state, o);
    objectCommonTail(state, o);
  },
  0x2a3d: (state, o) => {                               // type $12: fires by its count
    o[0x16] = (o[0x16] + 1) & 0xff;
    const n = o[0x16];
    if (n === 0x02 || n === 0x04) shoot(state, o, 0x09, 0x08, 0x00, 0x20, -0x20);
    else if (n === 0x08 || n === 0x0e) shoot(state, o, 0x04, 0x00, 0x08, 0x0c, -0x14);
    else if (n === 0x0a) {
      // $2840, as type $04 at frame $0a.
      o[0x10] = 0;
      shoot(state, o, 0x05, 0x08, 0x08, 0x04, -0x10);
      shoot(state, o, 0x05, 0xf8, null, 0x04, -0x10);
    } else if (n === 0x14) return nextType(state, o);
    objectCommonTail(state, o);
  },
  0x2a86: (state, o) => {                               // type $13: at frame 5, $10 again
    if (o[0x08] !== 0x05) return objectCommonTail(state, o);
    o[0x00] = 0x90;
    o[0x10] = (facePlayer(state, o) << 1) & 0xff;
    o[0x11] = 0x03;
    initObject(state.rom, Uint8Array.from(o), o);
    objectCommonTail(state, o);
  },
  0x2aad: (state, o) => {                               // type $14: 16 px up, $10 again
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] !== 0x04) return objectCommonTail(state, o);
    set16(o, 0x0e, w16(o, 0x0e) - 0x10);
    o[0x00] = 0x90;
    initObject(state.rom, Uint8Array.from(o), o);
    objectCommonTail(state, o);
  },
  0x2ad8: (state, o) => {                               // patrol, the next type at a turn
    objMove(o);
    if (objPatrolBounds(o, state.v)) return nextType(state, o);
    objectCommonTail(state, o);
  },
  0x2ae5: (state, o) => {                               // type $21: three steps
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] === 0x03) return nextType(state, o);
    objectCommonTail(state, o);
  },
  0x2af3: (state, o) => {                               // type $23: back to $20
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] !== 0x18) return objectCommonTail(state, o);
    o[0x00] = 0xa0;
    initObject(state.rom, Uint8Array.from(o), o);
    objectCommonTail(state, o);
  },
  0x2b0c: (state, o) => {                               // type $24: sparks by its frame
    if (o[0x08] === 0x0f) { o[0x00] = 0; return; }
    spark(state, o, o[0x08]);
  },
  0x2da8: (state, o) => {                               // type $3a: destroyed at $1e
    o[0x16] = (o[0x16] + 1) & 0xff;
    // The shared tail runs on what KillObject made of it.
    if (o[0x16] === 0x1e) killObject(state, o);
    objectCommonTail(state, o);
  },
  0x2db8: (state, o) => {                               // type $3b: patrols, fires (01:5d1b)
    o[0x01] = 0x01;
    objMove(o);
    objPatrolBounds(o, state.v);
    if ((state.p.tick & 0x0f) === 0x0c) shoot(state, o, 0x13, 0x08, 0x02, 0x18, -0x20);
    objectCommonTail(state, o);
  },
  0x2dc1: (state, o) => counted(state, o, 0x16, nextType), // type $3c
  0x2dcf: (state, o) => {                               // type $3e
    o[0x01] = 0x01;
    objectCommonTail(state, o);
  },
  0x2e94: (state, o) => {                               // type $46: at the player, turns at an end
    o[0x10] = (facePlayer(state, o) << 1) & 0xff;
    if (!objPatrolBounds(o, state.v)) {
      objMove(o);
      if (!objPatrolBounds(o, state.v)) return objectCommonTail(state, o);
    }
    o[0x10] = (-o[0x10]) & 0xff;
    nextType(state, o);
  },
  0x2ebd: (state, o) => {                               // type $47: fires at frame 4
    const f = o[0x08];
    if (f === 0x09) {
      o[0x10] = (-o[0x10]) & 0xff;
      return prevType(state, o);
    }
    if (f === 0x04) {
      const dx = o[0x10] & 0x80 ? 0x08 : 0x20;
      // Lower when Y / 16 is $bc.
      const dy = ((w16(o, 0x0e) >> 4) & 0xff) === 0xbc ? -0x10 : -0x28;
      shoot(state, o, 0x11, 0x08, 0xff, dx, dy);
    }
    objectCommonTail(state, o);
  },
  0x2f3f: (state, o) => {                               // type $49: swings (03:7ea8)
    const t = state.p.tick;
    const ptr = 0x7edd + ((t >> 2) & 0x0f) * 3;
    o[0x0a] = state.rom.byte(3, ptr);
    o[0x0b] = state.rom.byte(3, ptr + 1);
    o[0x10] = ((t + 0x10) & 0x20) ? 0x00 : 0x80;
    o[0x12] = state.rom.byte(3, ptr + 2);
    objectCommonTail(state, o);
  },
  0x2f64: (state, o) => {                               // types $4d $53
    o[0x01] = 0x02;
    objectCommonTail(state, o);
  },
  0x2f87: (state, o) => {
    o[0x01] = 0x02;
    objectCommonTail(state, o);
  },
  0x2f6a: (state, o) => counted(state, o, 0x06, nextType), // type $4f
  0x2f78: (state, o) => {                               // type $50: three types back at a turn
    objMove(o);
    if (!objPatrolBounds(o, state.v)) return objectCommonTail(state, o);
    o[0x00] = (o[0x00] - 2) & 0xff;
    prevType(state, o);
  },
  0x2f8d: (state, o) => {                               // type $54: a sound, then at the player
    o[0x08] = (o[0x08] + 1) & 0xff;
    if (o[0x08] === 0x01) { state.io.oracle('sound', 0x03); return objectCommonTail(state, o); }
    if (o[0x08] !== 0x0b) return objectCommonTail(state, o);
    o[0x10] = facePlayer(state, o);
    nextType(state, o);
  },
  0x2fb7: (state, o) => {                               // type $55: to frame $0e
    o[0x08] = (o[0x08] + 1) & 0xff;
    if (o[0x08] === 0x0e) return nextType(state, o);
    objectCommonTail(state, o);
  },
  0x2fc5: (state, o) => {                               // type $56: three types back at frame $0c
    o[0x08] = (o[0x08] + 1) & 0xff;
    if (o[0x08] !== 0x0c) return objectCommonTail(state, o);
    o[0x00] = (o[0x00] - 2) & 0xff;
    prevType(state, o);
  },
  0x2fd7: (state, o) => counted(state, o, 0x3c, nextType), // type $57
  0x2fe5: (state, o) => {                               // type $58: back after two turns
    objMove(o);
    if (!objPatrolBounds(o, state.v)) return objectCommonTail(state, o);
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] === 0x02) return prevType(state, o);
    objectCommonTail(state, o);
  },
  0x2ffd: (state, o) => {                               // types $59 $63 $64: 256 steps, gone
    objMove(o);
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (!o[0x16]) { o[0x00] = 0; return; }
    objectCommonTail(state, o);
  },
  0x306a: (state, o) => chase(state, o),               // $5d $5e $60 $62
  0x3096: (state, o) => {                               // type $5f: gone at frame $13
    o[0x01] = 0x07;
    if (o[0x08] === 0x13) { o[0x00] = 0; return; }
    objectCommonTail(state, o);
  },
  0x30ad: (state, o) => {                               // type $65: patrols, fires, launches $5c
    o[0x01] = (o[0x01] & 0xf8) | 0x01;
    objMove(o);
    objPatrolBounds(o, state.v);
    const t = state.p.tick;
    if (!(t & 0x1f)) {
      // $30fa: a $5c from where it is, its +$16 at $3f.
      const tp = state.template;
      tp.set(o.subarray(0, OBJ_SIZE));
      tp[0x00] = 0x5c; tp[0x10] = 0x00; tp[0x01] = 0x01; tp[0x11] = 0x04;
      const i = spawnFromTemplate(state.rom, state.objs, tp);
      // No free slot: HL is $c6e0 and the byte at $c6dc takes it.
      state.objs[i < 0 ? 0x3dc : i * OBJ_SIZE + 0x16] = 0x3f;
      return objectCommonTail(state, o);
    }
    if (t & 0x07) return objectCommonTail(state, o);
    shoot(state, o, 0x49, 0x0c, 0x00, 0x08, -0x20);
    if (!(o[0x01] & 0x08)) { state.io.oracle('sound', 0x0c); state.io.oracle('sound', 0x0d); }
    objectCommonTail(state, o);
  },
  0x311c: (state, o) => {                               // types $67 $6f: three shots, back
    o[0x16] = (o[0x16] + 1) & 0xff;
    const dy = { 0x04: -0x18, 0x08: -0x12, 0x0c: -0x0c }[o[0x16]];
    if (dy !== undefined) shoot(state, o, 0x09, 0x08, 0x00, 0x10, dy);
    else if (o[0x16] === 0x10) return prevType(state, o);
    objectCommonTail(state, o);
  },
  0x3157: (state, o) => {                               // type $69: aims and fires (01:55a6)
    o[0x01] &= 0x1f;
    o[0x10] = (facePlayer(state, o) << 2) & 0xff;
    o[0x16] = (o[0x16] + 1) & 0xff;
    const n = o[0x16];
    if (n === 0x04 || n === 0x0c) {
      // 01:501f without $233a: type $52, bit 6 clear.
      state.v.d98e = 0x08;
      state.v.d98f = 0x00;
      state.shoot(o, 0x52, 0x0008, 0xffe4);
    } else if (n === 0x10) return nextType(state, o);
    objectCommonTail(state, o);
  },
  0x3165: (state, o) => {                               // type $6a: patrols $14 steps
    objMove(o);
    objPatrolBounds(o, state.v);
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] === 0x14) return prevType(state, o);
    objectCommonTail(state, o);
  },
  0x2d02: (state, o) => {                               // type $2f: the grapple's rope
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] === 0x04) objMove(o);
    objectCommonTail(state, o);
  },
  0x3179: (state, o) => {                               // type $6b: gone at $13
    o[0x16] = (o[0x16] + 1) & 0xff;
    if (o[0x16] === 0x13) { o[0x00] = 0; return; }
    objectCommonTail(state, o);
  },
};

/** Count +$16; at `n`, `then` (nextType or prevType), else the shared tail. */
function counted(state, o, n, then) {
  o[0x16] = (o[0x16] + 1) & 0xff;
  if (o[0x16] === n) return then(state, o);
  objectCommonTail(state, o);
}

/**
 * $31c9 -- fall `e` px unless on the ground: 0 on the ground, $ff when it
 * fell. ProbeGround ($1c6d, 2 columns) from the object's X and Y, with
 * the player's mount flag; it leaves $d98c. In the speeder ($da35 = 2): Y
 * += e, and 0 when bit 7 of Y's low byte is set.
 */
function dropOnto(state, o, e) {
  if (state.p.da35 === 0x02) {
    set16(o, 0x0e, w16(o, 0x0e) + e);
    return o[0x0e] & 0x80 ? 0 : 0xff;
  }
  const probe = { d988: w16(o, 0x0c), d98a: w16(o, 0x0e), ff8f: state.p.ff8f };
  const [a] = probeGround(probe, state.world, 2);
  state.v.d98c = probe.d98c;
  if (!a) return 0;
  set16(o, 0x0e, w16(o, 0x0e) + e);
  return 0xff;
}

/** $2954 -- count +$16 down; its bit 1 is attribute bit 4 (the palette). */
function blink(o) {
  let a = o[0x16];
  if (a) o[0x16] = --a;
  o[0x01] = (o[0x01] & 0xef) | (((a >> 1) & 0x01) << 4);
}

/**
 * $29af -- on even `n`, a spark ($0c) from 16 px above, drifting left or
 * right by bit 1 of `n`.
 */
function spark(state, o, n) {
  if (n & 0x01) return objectCommonTail(state, o);
  const t = state.template;
  t.set(o.subarray(0, OBJ_SIZE));
  t[0x00] = 0x8c;
  t[0x01] = 0x04;
  t[0x10] = (n >> 1) & 0x01 ? 0xfc : 0x04;
  set16(t, 0x0e, w16(t, 0x0e) - 0x10);
  spawnFromTemplate(state.rom, state.objs, t);
  objectCommonTail(state, o);
}

/** 01:55e2 -- $ff when the player is to the left of the object, else 1. */
function facePlayer(state, o) {
  return w16(state.objs, 0x0c) < w16(o, 0x0c) ? 0xff : 0x01;
}

/**
 * $233a -- an enemy's shot (type bit 6 set) from `o`, offset (dx, dy), with
 * velocity $d98e/$d98f (`vy` null: $d98f as it is).
 */
function shoot(state, o, type, vx, vy, dx, dy) {
  state.v.d98e = vx;
  if (vy !== null) state.v.d98f = vy;
  state.shoot(o, type | 0x40, dx & 0xffff, dy & 0xffff);
}

/**
 * $3215 -- $ff when the player is left of the object, else 1, in a world
 * that wraps every $1000 px (the Falcon's): positions into $d988 (object)
 * and $d98a (player), shifted across the seam as 01:4e80 does.
 */
export function facePlayerWrapped(state, o) {
  const { v } = state;
  v.d988 = w16(o, 0x0c);
  v.d98a = w16(state.objs, 0x0c);
  const a = (v.d988 >> 8) & 0x0c;
  if (!a || a === 0x0c) {
    const want = a ^ 0x0c;
    if (((v.d98a >> 8) & 0x0c) === want) {
      if (want) {
        v.d988 = (v.d988 + 0x1000) & 0xffff;
        v.d98a = ((v.d98a | 0xf000) + 0x1000) & 0xffff;
      } else {
        v.d988 = ((v.d988 | 0xf000) + 0x1000) & 0xffff;
        v.d98a = (v.d98a + 0x1000) & 0xffff;
      }
    }
  }
  return v.d98a < v.d988 ? 0xff : 0x01;
}

/** 01:4cc6, then X kept within $1000 (the Falcon's world). */
function flyMove(o) {
  objMove(o);
  o[0x0d] &= 0x0f;
}

/**
 * 01:7f3f -- turn away: up or down at 6 (by the X speed's sign), a move,
 * and the next type ($29 -> $2a, $3f -> $40).
 */
export function turnAway(state, o) {
  o[0x11] = o[0x10] & 0x80 ? 0xfa : 0x06;
  flyMove(o);
  o[0x00] = ((o[0x00] & 0x7f) + 1) & 0xff;
  initObject(state.rom, Uint8Array.from(o), o);
}

/** The Y speed towards the player: (player Y - object Y) / 8, then >> n. */
function towardsY(state, o, n) {
  let d = (w16(state.objs, 0x0e) - w16(o, 0x0e)) & 0xffff;
  d = (d & 0x8000 ? d - 0x10000 : d) >> 3;
  let l = d & 0xff;
  for (let i = 0; i < n; i++) l = ((l & 0x80) | (l >> 1)) & 0xff;
  return l;
}

/**
 * $2b6d / $2e2b -- match the Falcon's speed, signed towards the player;
 * an escort that would have to reverse turns away instead. True if it did.
 */
function matchFalcon(state, o) {
  const toward = facePlayerWrapped(state, o) & 0x80;
  let c = state.objs[0x10];
  if ((c & 0x80) !== toward) c = (-c) & 0xff;
  if ((o[0x10] ^ c) & 0x80) {
    turnAway(state, o);
    objectCommonTail(state, o);
    return true;
  }
  o[0x10] = c;
  return false;
}

/** $2e3f -- move, X wrapped, and the shared tail. */
function escortMove(state, o) {
  flyMove(o);
  objectCommonTail(state, o);
}

/** $2b8e / $2e53 -- an escort's shot, at twice its speed; sound if visible. */
function escortShot(state, o, type, dx, dy) {
  const vx = (o[0x10] << 1) & 0xff;
  state.v.d98e = vx;
  if (type === 0x0a) state.v.d98f = 0;
  else state.v.d98f = (o[0x11] ^ vx) & 0x80 ? (-vx) & 0xff : vx;
  state.shoot(o, type | 0x40, dx & 0xffff, dy & 0xffff);
  if (!(o[0x01] & 0x08)) state.io.oracle('sound', 0x0e);
}

/** $2b19 -- type $29. */
function escortA(state, o) {
  const t = state.p.tick & 0x3f;
  if (t === 0x1b || t === 0x13) escortShot(state, o, 0x0a, 0x10, -0x10);
  else if (!(t & 1)) o[0x11] = towardsY(state, o, 1);
  // $2b53: every 32 steps, the Falcon's speed.
  if (!(state.p.tick & 0x1f) && matchFalcon(state, o)) return;
  escortMove(state, o);
}

/** $2dd6 -- type $3f, on its own counter (+$16). */
function escortB(state, o) {
  o[0x16] = (o[0x16] + 1) & 0xff;
  const c = o[0x16];
  if ((c & 0x1f) === 0x1b) {
    escortShot(state, o, 0x0b, 0x0c, -0x0c);
    return escortMove(state, o);
  }
  if (!(c & 0x0f)) {
    if (!(c & 0x10)) o[0x11] = towardsY(state, o, 2);
    else if (matchFalcon(state, o)) return;
  }
  escortMove(state, o);
}

/** $31a8 -- the previous type, re-initialised (sound 1 for a $5c). */
function prevType(state, o) {
  const t = o[0x00];
  o[0x00] = (t - 1) & 0xff;
  initObject(state.rom, Uint8Array.from(o), o);
  if ((t & 0x7f) === 0x5c) state.io.oracle('sound', 0x01);
  objectCommonTail(state, o);
}

/**
 * $14a7 -- the AT-AT's pictures, into the BG map (Bank 1 images, `01:`
 * [map, tiles] records): legs at $9880 (6 x 3, $724c + step / 16 phase,
 * tiles $8870), body at $98e0 (9 x 4, $725c, tiles $89a0 or $8b00 by step
 * bit 3); a falling one ($d1) counts +$16 to $20 through 01:$7b6b at $9860
 * (9 x 8), then is a wreck ($d2, 01:$7b77), one walker fewer ($da39) --
 * the last ends the level. The pictures go to state.pictures for the
 * renderer; $d98a is left as the game leaves it.
 */
function walkerPicture(state, o) {
  const { v } = state;
  const t = state.p.tick;
  const draw = (record, tiles, map, w, h) => {
    v.d98a = map;
    state.pictures?.push({ record, tiles, map, w, h });
  };
  v.d98a = 0x9860;
  if (o[0x00] === 0xd1) {
    o[0x16] = (o[0x16] + 1) & 0xff;
    const n = o[0x16];
    if (n !== 0x20) {
      return draw(0x7b6b + ((n & 0x18) >> 1), n & 0x08 ? 0x8b40 : 0x8870, 0x9860, 9, 8);
    }
    // $155e: down.
    o[0x00] = (o[0x00] + 1) & 0xff;
    state.p.da39 = (state.p.da39 - 1) & 0xff;
    state.io.oracle('hud');
    if (state.p.da39) return draw(0x7b77, 0x8b40, 0x9860, 9, 8);
    state.p.ff8b = (state.p.ff8b + 1) & 0xff;
    v.da8d = 0x81;
    state.io.oracle('music');
    throw new WalkersDown();
  }
  if (o[0x00] === 0xd2) return draw(0x7b77, 0x8b40, 0x9860, 9, 8);
  draw(0x724c + ((t & 0x30) >> 2), 0x8870, 0x9880, 6, 3);
  draw(0x725c + ((t & 0x38) >> 1), t & 0x08 ? 0x8b00 : 0x89a0, 0x98e0, 9, 4);
}

/** The last walker is down ($1580): the next level, at once. */
export class WalkersDown extends Error {
  constructor() { super('the last AT-AT is down'); }
}

/** An AT-AT has reached the base ($2cc5): the game goes to the lives screen. */
export class WalkerArrived extends Error {
  constructor() { super('an AT-AT reached the base'); }
}

/** The record at a RAM address in object RAM. */
const at = (state, ptr) => state.objs.subarray(ptr - 0xc300, ptr - 0xc300 + OBJ_SIZE);

const sra8 = (v, n) => { let x = v & 0xff; for (let i = 0; i < n; i++) x = (x & 0x80) | (x >> 1); return x; };

/**
 * $2c11 -- the AT-AT: a step every 8 game steps, a bob (Y low $42 $40
 * $3e $40 by step / 16), and every 16 steps -- with the player up to 256 px
 * to its left -- it turns its head to them and fires: picture and shot
 * type from 04:$7d7c (the picture at 04:$7dbc + offset), from (+3, -10),
 * at -(dX / 8) and dY / 8; sounds $11 $12; palette OBP1 ever after. At X
 * $300 it has reached the base: a dialog, then the lives screen.
 */
function atat(state, o) {
  const { rom, v } = state;
  const t = state.p.tick;
  if (!(t & 0x07)) objMove(o);
  if (!(t & 0x0f)) {
    // 01:55e2 leaves player X - X in BC.
    const bc = (w16(state.objs, 0x0c) - w16(o, 0x0c)) & 0xffff;
    if ((bc >> 8) === 0xff) {
      const c = sra8((bc >> 1) & 0xff, 2);
      v.d98e = (-c) & 0xff;
      o[0x01] |= 0x10;
      const dy = (w16(state.objs, 0x0e) - w16(o, 0x0e)) & 0xff;
      v.d98f = sra8(dy, 3);
      const row = (((v.d98f + 8) & 0x0c) << 1) & 0xff;
      const col = (((((-v.d98e) & 0xff) + 0x20) & 0xff) >> 2) & 0xff;
      const at = 0x7d7c + ((col + row) & 0xff) * 2;
      const pic = 0x7dbc + rom.byte(4, at);
      o[0x0a] = pic & 0xff;
      o[0x0b] = pic >> 8;
      state.shoot(o, rom.byte(4, at + 1) | 0x40, 0x0003, (-0x0a) & 0xffff);
      state.io.oracle('sound', 0x11);
      state.io.oracle('sound', 0x12);
    }
  }
  const phase = (t >> 4) & 0x03;
  let b = 0;
  if (!(phase & 1)) b = ((((((phase >> 1) ^ 1) << 1) - 1) << 1) & 0xff);
  o[0x0e] = (b + 0x40) & 0xff;
  if (o[0x0d] === 0x03) {
    state.io.oracle('dialog', 0x84, 0xcd25);
    throw new WalkerArrived();
  }
  objectCommonTail(state, o);
}

/** $3199 -- become the next type, re-initialised. */
function nextType(state, o) {
  o[0x00] = (o[0x00] + 1) & 0xff;
  initObject(state.rom, Uint8Array.from(o), o);
  objectCommonTail(state, o);
}

/**
 * $306a -- walk at the player: type $2e turns towards them every step,
 * others only every 32nd ($d99e) and set attr 7. Moves again when it
 * turns at the end of its range.
 */
function chase(state, o) {
  let turn = true;
  if ((o[0x00] & 0x7f) !== 0x2e) {
    o[0x01] = 0x07;
    turn = !(state.p.tick & 0x1f);
  }
  if (turn) o[0x10] = (facePlayer(state, o) << 1) & 0xff;
  objMove(o);
  if (objPatrolBounds(o, state.v)) objMove(o);
  objectCommonTail(state, o);
}

/** The handler address the game would jump to for a type. */
export const handlerOf = (rom, type) => rom.word(0, 0x2654 + type * 2);

/** Whether a handler address has a port. */
export const isPorted = (addr) => addr in HANDLERS;

/**
 * $261d -- every active object from $c320, 30 slots: set the hidden bit,
 * then its type's handler. state: { rom, objs, cam, p (da34, ff8f, tick),
 * v (d98e, d98f), shoot(o, type, dx, dy) (projectiles.js
 * spawnProjectileFrom), io: { oracle('sound', a) }, handlers, bgItems }.
 */
export function updateObjects(state) {
  state.da32 = 0;
  // $2621: the walker's variables too.
  if (state.v) { state.v.da84 = 0; state.v.da86 = 0; }
  // $262a -> 01:4bc8: the screen view into the scratch at $ff90.
  if (state.box && state.cam) {
    const view = screenView(state.cam), b = state.box;
    b[0] = view.x & 0xff; b[1] = view.x >> 8; b[2] = view.y & 0xff; b[3] = view.y >> 8;
    b[4] = view.w; b[6] = view.h;
  }
  state.bgItems = [];
  for (let i = 1; i < 1 + 30; i++) {
    const o = slot(state.objs, i);
    const t = o[0] & 0x7f;
    if (!t) continue;
    o[0] |= 0x80;
    const addr = handlerOf(state.rom, t);
    const h = HANDLERS[addr];
    if (h) h(state, o);
    else state.handlers.unported(t, `$${addr.toString(16)}`, o);
  }
  // $279c: the slot pointer as the loop leaves it, past its 30 slots.
  if (state.v) state.v.da9e = 0xc320 + 30 * OBJ_SIZE;
}

/**
 * Smaller pieces of the main loop, ported from the game.
 *
 *   AnimateTiles   $340f    every step ($068b): levels 8 and 10 scroll a
 *                           tile a pixel ($da50 -> $9410), levels 3, 8, 10
 *                           swap two tiles every other step ($da60/$da70)
 *   BeltPush       $3399    on foot ($06ea): $da1f, set on a conveyor
 *                           tile ($41), pushes the player along
 *   WakeObjects    01:5bd9  ($3a63, $06ed) levels 4 and 5: objects $4a,
 *                           $4d, $53 near the player turn into the next type
 *   ForceDrain     $1583    every 16 steps ($072c): the UP power while UP
 *                           is held, and power 4, spend one of the meter
 *   HideMount      $072f    riding, a hidden rider hides the mount
 */

import { JOY } from './physics.js';
import { postMoveCollisionScan } from './collision.js';
import { slot, initObject } from './objects.js';
import { spendForce } from './projectiles.js';

const w16 = (o, i) => o[i] | (o[i + 1] << 8);
const s8 = (v) => (v & 0x80 ? v - 0x100 : v);

/**
 * $340f -- `ram` is $da50..$da7f (48 bytes, filled from VRAM at level
 * start, $0bf4); `vram(addr, bytes)` writes 16 bytes of tile data.
 */
export function animateTiles(level, tick, ram, vram) {
  let a = 0x9230, b = 0x9250;
  if (level === 0x03) {
    a = 0x9590;
    b = 0x95a0;
  } else if (level === 0x08 || level === 0x0a) {
    for (let i = 0; i < 16; i++) ram[i] = ((ram[i] >> 1) | (ram[i] << 7)) & 0xff;
    vram(0x9410, ram.subarray(0, 16));
  } else {
    return;
  }
  // $da60 and $da70 trade places every other step.
  const swap = !(((tick + 6) & 0xff) & 0x02);
  vram(swap ? b : a, ram.subarray(16, 32));
  vram(swap ? a : b, ram.subarray(32, 48));
}

/** $3399 -- $da1f into $c310, ObjMove on the player, the collision scan. */
export function beltPush(p, world) {
  if (!p.da1f) return;
  p.c310 = p.da1f;
  p.c311 = 0;
  p.px = p.x;
  p.py = p.y;
  p.x = (p.x + (p.c310 === 0x80 ? 0 : s8(p.c310))) & 0xffff;
  postMoveCollisionScan(p, world);
}

/**
 * 01:5bd9 -- the first object of type $4a, $4d or $53 within 48 px of the
 * player (by the low byte of each distance, as the game compares) becomes
 * type + 1 and is set up afresh ($3ef1). A $4a while power 4 is on stops
 * the search. Only levels 4 and 5.
 */
export function wakeObjects(p, rom, objs) {
  if (p.ff8b !== 0x04 && p.ff8b !== 0x05) return;
  for (let i = 2; i < 31; i++) {
    const o = slot(objs, i);
    const t = o[0x00];
    if (t & 0x80) continue;
    if (t !== 0x4a && t !== 0x4d && t !== 0x53) continue;
    if (lowDistance(w16(o, 0x0c), p.x) >= 0x30) continue;
    if (lowDistance(w16(o, 0x0e), p.y) >= 0x30) continue;
    if (t === 0x4a && p.da2b === 0x04) return;
    o[0x00] = (t + 1) & 0xff;
    initObject(rom, Uint8Array.from(o), o);
    return;
  }
}

/** `rst $08` then |L|: the low byte of the difference, negated if it is negative. */
function lowDistance(a, b) {
  const d = (a - b) & 0xffff;
  return d & 0x8000 ? (-(d & 0xff)) & 0xff : d & 0xff;
}

/** $1583 -- s: { v (the globals), io: { oracle } } for SpendForce ($0fdc). */
export function forceDrain(p, s) {
  if (p.da2b === 0x02) {
    if (!(p.joy & JOY.UP)) return;
  } else if (p.da2b !== 0x04) {
    return;
  }
  spendForce(s, 1);
}

/** $072f..$0742 -- riding, a hidden rider ($c300 bit 7) hides the mount ($c320) too. */
export function hideMount(p, rider, mount) {
  if (!p.ff8f) return;
  if (mount[0x00] & 0x80) return;
  if (!(rider[0x00] & 0x80)) return;
  mount[0x00] |= 0x80;
}

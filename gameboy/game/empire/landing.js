/**
 * Standing on objects, ported from the game: $3d80 CheckObjectLanding
 * (01:52a3), called for every pixel of a jump's fall and of gravity.
 *
 * The player's feet -- a box 6 px wide (14 mounted) and 2 high, from X + 6
 * (+ 12 mounted), Y - 2 -- are tested against the top of every platform
 * object (types $28, $37, $07) in slots $c340..: a box the object's width
 * (+$18) and 1 high, from X + 6, Y - 8. On the first one touched:
 *
 *   still rising ($ff8c = 1)  nothing; returns 1
 *   otherwise                 back to the position before the pixel
 *                             ($da2c), the jump over, and the player rides
 *                             the platform: its velocity (+$10, +$11) into
 *                             $c310/$c311, moved by it (ObjMove), the
 *                             collision scan; $da4c set; returns $ff
 *
 * Otherwise returns 0. Register C is carried in world.c (collision.js):
 * the jump fall's climb check can test it.
 *
 * `p` is the player's state (physics.js names, the rest by address);
 * ctx: { world, objs (object RAM from $c300), box ($ff90..$ff9f) }.
 */

import { slot, objMove } from './objects.js';
import { overlap } from './projectiles.js';
import { postMoveCollisionScan } from './collision.js';

const w16 = (o, i) => o[i] | (o[i + 1] << 8);
const set16 = (o, i, v) => { o[i] = v & 0xff; o[i + 1] = (v >> 8) & 0xff; };

/** Platform object types. */
const PLATFORMS = new Set([0x28, 0x37, 0x07]);

/** 01:4fab PlayerHitBox, from the physics state. In state $03 on foot the box is 12 high. */
function playerHitBox(p, b) {
  if (p.da35) {
    set16(b, 0, p.x);
    set16(b, 2, p.y);
    if (p.da3e) { b[4] = 0x08; b[6] = 0x10; return; }
    if (p.ff8f) { b[4] = 0x18; b[6] = 0x10; return; }
  } else {
    set16(b, 0, p.x + (p.c301 & 0x20 ? 10 : 2));
    set16(b, 2, p.y - 2);
  }
  b[4] = 0x0c;
  b[6] = 0x1c;
  if (p.ff8f) { b[6] = 0x1c; b[4] = 0x14; return; }
  if (p.state === 0x03) b[6] = 0x0c;
}

/** $3d80 / 01:52a3 */
export function checkObjectLanding(p, ctx) {
  const { world, objs, box: b } = ctx;
  p.da4c = 0;
  playerHitBox(p, b);
  let dx = 6;
  if (p.ff8f) {
    b[4] = (b[4] - 6) & 0xff;
    dx = 12;
  }
  set16(b, 0, p.x + dx);
  b[6] = 2;
  p.da9e = 0xc340;
  for (let i = 2; i < 31; i++) {
    const o = slot(objs, i);
    if (PLATFORMS.has(o[0x00])) {
      p.dir = o[0x00];
      set16(b, 8, w16(o, 0x0c) + 6);
      set16(b, 10, w16(o, 0x0e) - 8);
      b[12] = o[0x18];
      b[14] = 1;
      if (overlap({ box: b, v: p })) return landOn(p, ctx, o);
    }
    p.da9e = (p.da9e + 0x20) & 0xffff;
  }
  return 0;
}

/** 01:5329 */
function landOn(p, ctx, o) {
  if (p.ff8c === 1) return 1;
  p.x = p.sx;
  p.y = p.sy;
  if (p.ff8c === 2 || p.da21 || p.ff8e) p.vx = 0;
  p.ff8e = 0;
  p.ff8c = 0;
  p.da43 = 0;
  p.px = p.x;
  p.py = p.y;
  p.da4c = ((p.da9e & 0xff) + 0x10) & 0xff;
  p.c310 = o[0x10];
  p.c311 = o[0x11];
  // 01:4cc6 on the player record: X and Y moved with the platform.
  const rec = new Uint8Array(0x20);
  set16(rec, 0x0c, p.x);
  set16(rec, 0x0e, p.y);
  rec[0x10] = p.c310;
  rec[0x11] = p.c311;
  objMove(rec);
  p.x = w16(rec, 0x0c);
  p.y = w16(rec, 0x0e);
  postMoveCollisionScan(p, ctx.world);
  return 0xff;
}

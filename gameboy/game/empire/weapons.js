/**
 * The player's B button, ported from the game: $17ae OnBPressed.
 *
 * B fires once when pressed and then every 16th step while held ($da1b
 * counts). What it fires:
 *
 *   $da42 set     a $14 beam straight ahead ($17c6)
 *   $da91 set     the lightsaber: no shot, $ff8d starts the swing ($18f4)
 *   otherwise     the blaster: velocity, offset, type and the player's
 *                 shooting picture from a 7-byte entry in bank 6 ($181d)
 *
 * `p` is the physics state (physics.js), with $d98e as `dir` -- the walking
 * controller's direction flags, which a shot overwrites with its velocity,
 * as in the game. ctx: { rom, rider (the player record, $c300), spawn(type)
 * (SpawnProjectile, 01:5057), io: { oracle(name, a) } } -- the oracles are
 * sound (07:$638c) and hud ($1144, through SpendForce).
 */

import { JOY } from './physics.js';
import { spendForce } from './projectiles.js';

const s8 = (v) => (v & 0x80 ? v - 0x100 : v);
const rot3 = (v) => ((v << 3) | (v >> 5)) & 0xff;

/** $17ae */
export function onBPressed(p, ctx) {
  const b = p.da1b;
  p.da1b = (b + 1) & 0x0f;
  if (b) return;
  if (p.state === 0x04) return;
  if (p.da42) return beam(p, ctx);
  if (p.da91) return lightsaber(p, ctx);
  return blaster(p, ctx);
}

/** $17c6 -- a $14 beam from the chest, faster in the facing direction. */
function beam(p, ctx) {
  const { rider } = ctx;
  const left = p.c301 & 0x20;
  p.dir = (rider[0x10] + (left ? 0xfa : 0x06)) & 0xff;
  p.d98f = 0x02;
  p.d988 = (p.x + (left ? 0x14 : 0x10)) & 0xffff;
  p.d98a = (p.y + (p.state === 0x03 ? -0x10 : -0x1c)) & 0xffff;
  if (!p.da80) p.da80 = 0x03;
  ctx.spawn(0x14);
}

/** $18f4 -- start a swing, unless one is under way or the player is busy. */
function lightsaber(p, ctx) {
  if (p.ff8d || p.ff8e) return;
  if (p.da43 && p.ff8c === 2) return;
  if (p.da21) return;
  p.ff8d = 1;
  ctx.io.oracle('sound', 6);
  if (p.da2b === 3) spendForce({ v: p, io: ctx.io }, 1);
}

/**
 * $181d -- the blaster. Entry = $da25 (aim), one less when it is a
 * multiple of 4 and the player faces right; 7 bytes each. On foot the
 * table is 06:$7df2, and with LEFT or RIGHT held entries $23 and $2a
 * (offsets 5 and 6) use the running ones $2a further on; riding, 06:$7e46.
 */
function blaster(p, ctx) {
  const { rom, rider } = ctx;
  let aim = p.da25;
  if (!(aim & 0x03) && !(p.c301 & 0x20)) aim = (aim - 1) & 0xff;
  let off = (rot3(aim) - aim) & 0xff;
  let base = 0x7e46;
  if (!p.ff8f) {
    if ((p.joy & (JOY.RIGHT | JOY.LEFT)) && (off === 0x23 || off === 0x2a)) off = (off + 0x2a) & 0xff;
    base = 0x7df2;
  }
  const e = (i) => rom.byte(6, base + off + i);
  p.dir = e(0);
  p.d98f = e(1);
  let x = p.x;
  // Climbing: from the middle of the 32 px ladder column (low byte only).
  if (p.state === 0x06) x = (x & 0xff00) | ((((x + 8) & 0xe0) + 8) & 0xff);
  p.d988 = (x + s8(e(2))) & 0xffff;
  let y = (p.y + s8(e(3))) & 0xffff;
  if (p.state === 0x00 && !p.ff8f) y = (y + 2) & 0xffff;
  p.d98a = y;
  const type = e(4);
  // The shooting picture, unless walking: the old one is kept to restore.
  if (p.ff8f || (p.state !== 0x02 && !p.vx)) {
    p.da44 = rider[0x0a];
    p.da45 = rider[0x0b];
    rider[0x0a] = e(5);
    rider[0x0b] = e(6);
    p.da26 = 1;
  }
  if (!p.da80) p.da80 = 0x03;
  ctx.spawn(type);
}

const rlca = (v) => ((v << 1) | (v >> 7)) & 0xff;

/**
 * $24ca -- the swing under way ($ff8d, main loop $06da; level 2 $07a4): on
 * odd frames of the player's animation ($c308) the blade's hit, a type 6
 * shot, at a point that follows the swing. X: the sprite offset $0a58 by
 * pose ($da24) and facing, less 256, plus an X step; Y less a Y step --
 * both from 06:$7e93, 18 bytes a pose, 3 per frame pair (Y, X right, X
 * left). The steps are counted out a pixel at a time, as the game does.
 */
export function saberSwing(p, ctx) {
  if (!(p.c308 & 1)) return;
  const left = p.c301 & 0x20 ? 1 : 0;
  const pose = rlca(p.da24);
  let x = (p.x + (0xff00 | ctx.rom.byte(0, 0x0a58 + pose + left))) & 0xffff;
  const b = (rlca(rlca(rlca(pose))) + pose) & 0xff;
  const half = p.c308 >> 1;
  const at = 0x7e93 + ((((half << 1) & 0xff) + half + b) & 0xff);
  const dy = ctx.rom.byte(6, at);
  const dx = ctx.rom.byte(6, at + 1 + left);
  // `inc c / dec de / (inc de, dec c)*`: X + dx, with dx = $ff counting 256.
  x = (x - 1 + (((dx + 1) & 0xff) || 0x100)) & 0xffff;
  const y = (p.y + 1 - (((dy + 1) & 0xff) || 0x100)) & 0xffff;
  p.d98a = y;
  p.d988 = x;
  p.dir = 0;
  p.d98f = 0;
  ctx.spawn(0x06);
}

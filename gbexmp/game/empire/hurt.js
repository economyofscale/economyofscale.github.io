/**
 * Getting hurt, ported from the game: $0d73 Hurt and the main loop's
 * blink ($0744).
 *
 * Hurt (A = damage: 1 for most shots, 2 for $53, $20 for a pit) plays
 * sound 2, then -- unless the player is already dying ($15, $16) or in
 * state $12 -- starts the blink ($da41 = 8) and takes A from the health of
 * whoever is hit: the player's $da93 on foot, the tauntaun's $da94 when
 * riding. At zero:
 *
 *   riding         $0f25: the tauntaun dies ($05) and the player is thrown
 *                  off; the game goes on
 *   on foot        $0dd0: the dying picture, state $15 -- then the death
 *                  loop ($0de9), which never returns
 *   vehicles       $0e39: the vehicle bursts into three pieces, then the
 *                  death loop
 *
 * `p` is the physics state (physics.js): x, y, state ($ffa0), c301, c304,
 * c305, c308, c309 and the variables by address. ctx: { rom, objs (object
 * RAM from $c300), template ($ca20), io: { oracle(name, a) } } with the
 * oracles sound (07:$638c) and hud ($1144). Returns 'died' when the death
 * loop is next, else null.
 */

import { slot, initObject, spawnFromTemplate } from './objects.js';

const w16 = (o, i) => o[i] | (o[i + 1] << 8);
const set16 = (o, i, v) => { o[i] = v & 0xff; o[i + 1] = (v >> 8) & 0xff; };

/** $10d7 -- the player's animation: length A, table HL, from frame 0. */
export function setPlayerAnimation(p, rider, table, length) {
  p.c309 = length;
  rider[0x0a] = table & 0xff;
  rider[0x0b] = table >> 8;
  p.c308 = 0;
}

/** $0d73 */
export function hurt(p, ctx, a) {
  ctx.io.oracle('sound', 2);
  if (p.state === 0x15 || p.state === 0x16 || p.state === 0x12) return null;
  p.da41 = 0x08;
  const key = p.ff8f ? 'da94' : 'da93';
  for (let b = a; ;) {
    p[key] = (p[key] - 1) & 0xff;
    if (!p[key]) break;
    b = (b - 1) & 0xff;
    if (!b) { ctx.io.oracle('hud'); return null; }
  }
  // $0dbd: none left.
  ctx.io.oracle('hud');
  if (p.ff8f) { mountDies(p, ctx); return null; }
  const rider = slot(ctx.objs, 0);
  if (p.da35 === 0x02 || p.da35 === 0x00) {
    // $0da2 / $0dd0: the dying picture, falling in state $15.
    p.da43 = 0;
    p.ff8c = 0;
    setPlayerAnimation(p, rider, 0x7b74, p.da35 === 0x02 ? 0x08 : 0x02);
    p.c304 = 0x04;
    p.state = 0x15;
    return 'died';
  }
  vehicleBursts(p, ctx, rider);
  return 'died';
}

/**
 * $0e39 -- the vehicle hides and leaves a $2b, then two $02 effects
 * mirrored around it.
 */
function vehicleBursts(p, ctx, rider) {
  const { rom, objs, template: t } = ctx;
  p.c300 = (p.c300 | 0x80) & 0xff;
  rider[0x00] = p.c300;
  t.set(rider);
  t[0x00] = 0x2b; t[0x01] = 0x03;
  spawnFromTemplate(rom, objs, t);
  t[0x0c] ^= 0x08;
  t[0x00] = 0x02; t[0x01] = 0x04;
  spawnFromTemplate(rom, objs, t);
  t[0x0c] ^= 0x0c;
  t[0x0e] ^= 0x0c;
  spawnFromTemplate(rom, objs, t);
}

/**
 * $0f25 -- the mount is out of health. Level 2's vehicle becomes the
 * player on foot (02:$7c36, state $12); otherwise the tauntaun becomes a
 * $05 (unless $da42) and the player is thrown off: on foot, 3 x 4, 8 px
 * ahead on level 1 or 16 px up elsewhere, with a $2b left where they were.
 */
function mountDies(p, ctx) {
  const { rom, objs, template: t } = ctx;
  const rider = slot(objs, 0);
  if (!p.da42) {
    if (p.ff8b === 0x02) {
      p.state = 0x12;
      // The position survives in $d988/$d98a while the record is replaced.
      p.d988 = p.x; p.d98a = p.y;
      for (let i = 0; i < 0x20; i++) rider[i] = rom.byte(2, 0x7c36 + i);
      set16(rider, 0x0c, p.d988);
      set16(rider, 0x0e, p.d98a);
      fromRider(p, rider);
      return;
    }
    const mount = slot(objs, 1);
    mount[0x00] = 0x05;
    initObject(rom, Uint8Array.from(mount), mount);
  }
  thrownOff(p, ctx);
}

/**
 * $0f62 -- off the mount, on foot: thrown off, or SELECT ($16e3). 3 x 4,
 * facing kept, the mount's +$10 from it; 8 px ahead on level 1, else 16 px
 * up with a $2b left where the player was. State $ff.
 */
export function thrownOff(p, ctx) {
  const { rom, objs, template: t } = ctx;
  const rider = slot(objs, 0);
  p.ff8f = 0;
  p.ff8d = 0;
  p.da42 = 0;
  p.c301 = (p.c301 & 0xf0) | 0x02;
  const m = slot(objs, 1);
  m[0x10] = ((p.c301 << 2) | (p.c301 >> 6)) & 0xff;
  p.c304 = 0x03;
  p.c305 = 0x04;
  if (p.ff8b === 0x01) {
    p.x = (p.x + 8) & 0xffff;
  } else {
    p.y = (p.y - 0x10) & 0xffff;
    ctx.io.oracle('sound', 0);
  }
  toRider(p, rider);
  t.set(rider);
  t[0x00] = 0x2b; t[0x01] = 0x03;
  if (p.ff8b !== 0x01) spawnFromTemplate(rom, objs, t);
  p.state = 0xff;
  ctx.io.oracle('hud');
}

// The record bytes the physics state keeps (play.js SHARED, and x, y).
const SHARED = [[0x00, 'c300'], [0x01, 'c301'], [0x04, 'c304'], [0x05, 'c305'], [0x08, 'c308'], [0x09, 'c309'],
  [0x10, 'c310'], [0x11, 'c311']];
export function toRider(p, rider) {
  for (const [i, k] of SHARED) rider[i] = p[k];
  set16(rider, 0x0c, p.x);
  set16(rider, 0x0e, p.y);
}
export function fromRider(p, rider) {
  for (const [i, k] of SHARED) p[k] = rider[i];
  p.x = w16(rider, 0x0c);
  p.y = w16(rider, 0x0e);
}

/**
 * $1d6a -- a trigger tile (attribute bit 5) touched by the collision scan:
 * riding, the mount is lost ($0f25); on foot, Hurt with A = 1.
 */
export function trigger(p, ctx) {
  if (p.ff8f) { mountDies(p, ctx); return null; }
  return hurt(p, ctx, 1);
}

/** $0744 -- while $da41 counts down, c301 bit 4 (palette) flips each step. */
export function blink(p) {
  if (!p.da41) return;
  p.da41 = (p.da41 - 1) & 0xff;
  p.c301 = (p.c301 & 0xef) | ((p.da41 & 1) << 4);
}

/**
 * Mounting and dismounting, ported from the game.
 *
 *   MountTauntaun  01:5fd8  touching the tauntaun ($01) while falling onto
 *                           it: the player takes its place, riding
 *   MountVehicle   $3c7b    touching a mount ($3d $3e) while falling onto
 *                           it: the same, with $da42 set; not on level 10,
 *                           nor past X $1000 on level 3
 *   OnSelect       $16e3    on foot (or riding with B held): switch blaster
 *                           and lightsaber once the saber ($da92) is had;
 *                           riding: off ($0f62)
 *   RiderState     01:5b43  levels 3 and 8, while mounted: the rider's
 *                           stand, run, crouch and jump pictures
 *
 * `p` is the physics state; `rider` the player record ($c300). ctx as in
 * touch.js, plus { cam, spawn } for what OnSelect and MountVehicle call,
 * and optional { toRider, fromRider } hooks where the record and the
 * physics state are kept apart (play.js). Results for touch.js: 'continue'
 * when the scan goes on ($513a), else null.
 */

import { slot } from './objects.js';
import { setPlayerAnimation, thrownOff } from './hurt.js';
import { advanceAnimation, playerScreenPosition } from './sprites.js';
import { onBPressed } from './weapons.js';
import { JOY } from './physics.js';

const w16 = (o, i) => o[i] | (o[i + 1] << 8);
const GO_ON = 'continue';

/** 01:5fd8 */
export function mountTauntaun(p, ctx) {
  if (p.ff8f) return GO_ON;
  if (p.ff8c !== 0x02) return GO_ON;
  if (ctx.v.da35) return null;
  const mount = slot(ctx.objs, 1);
  p.x = w16(mount, 0x0c);
  p.y = w16(mount, 0x0e);
  p.ff8c = 0;
  p.ff8f = 1;
  p.c304 = 0x05;
  p.c305 = 0x03;
  p.state = 0xff;
  ctx.io.oracle('hud');
  return null;
}

/** $3c7b -- `o` the mount touched. */
export function mountVehicle(p, ctx, o) {
  if (p.ff8b === 0x0a) return GO_ON;
  if (p.ff8b === 0x03 && (p.x >> 8) >= 0x10) return GO_ON;
  if (p.ff8f) return GO_ON;
  if (p.ff8c !== 0x02) return GO_ON;
  o[0] = 0;
  p.x = w16(o, 0x0c);
  p.y = w16(o, 0x0e);
  p.ff8c = 0;
  p.ff8e = 0;
  p.ff8f = 1;
  p.da42 = 1;
  p.c301 = (p.c301 & 0xf0) | 0x01;
  p.da94 = 0x20;
  p.state = 0xff;
  const rider = slot(ctx.objs, 0);
  riderState(p, rider);
  // $04c3 and $0a52 work on the record.
  ctx.toRider?.(p, rider);
  advanceAnimation(rider, ctx.rom);
  playerScreenPosition(p, rider, slot(ctx.objs, 1), ctx.cam, ctx.rom);
  ctx.fromRider?.(p, rider);
  ctx.io.oracle('hud');
  return null;
}

/** 01:5b43 */
export function riderState(p, rider) {
  if (!p.ff8f) return;
  const pose = (state, h, table, length) => {
    if (p.state === state) return;
    p.c304 = 0x05;
    p.c305 = h;
    setPlayerAnimation(p, rider, table, length);
    p.state = state;
  };
  if (!p.da1f) {
    if (p.da21) {
      p.da21 = (p.da21 - 1) & 0xff;
      return pose(0x03, 0x07, 0x4ba6, 0x02);
    }
    if (p.ff8e) { standing(p, rider); return; }
    if (p.ff8c) return pose(0x01, 0x07, 0x4ba6, 0x0c);
  }
  if (p.joy & JOY.DOWN) return pose(0x03, 0x07, 0x4ba6, 0x02);
  if (p.joy & (JOY.RIGHT | JOY.LEFT)) return pose(0x02, 0x06, 0x4b96, 0x0c);
  standing(p, rider);
}

/** 01:5b86 -- standing, set every time. */
function standing(p, rider) {
  p.c304 = 0x05;
  p.c305 = 0x07;
  setPlayerAnimation(p, rider, 0x4bb2, 0x02);
  p.state = 0x00;
}

/** $16e3 */
export function onSelect(p, ctx) {
  if (p.ff8f) {
    if (p.da42) return thrownOff(p, ctx);
    if (!(p.joy & JOY.B)) {
      if (p.ff8c || p.ff8e || p.da4c) return undefined;
      return thrownOff(p, ctx);
    }
  }
  // $16e8: the weapon switch, once per press ($da31 bit 6 is SELECT held).
  if (p.ff8d || p.ff8c) return undefined;
  if (!p.da92) return undefined;
  if (p.da31 & 0x40) return undefined;
  p.da91 ^= 1;
  p.da31 = (p.da91 + 1) & 0xff;
  return onBPressed(p, { rom: ctx.rom, rider: slot(ctx.objs, 0), io: ctx.io, spawn: ctx.spawn });
}

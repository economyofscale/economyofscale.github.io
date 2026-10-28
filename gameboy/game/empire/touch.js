/**
 * The player touching objects, ported from the game: 01:50b8 TouchObjects
 * (main loop $0724) and its handlers.
 *
 * The player's box (01:4fab) against each object from $c320 (from $c340
 * when riding: not the mount). The first one touched gets its type's
 * handler from the table at $3a73, entered by `ret` with D = the side it
 * is on (bit 0: right of the player, bit 1: below); the handler's own
 * `ret` ends the whole scan, and only a few go back into it ($513a).
 *
 * What the handlers do: pickups heal ($0fbf), refill the Force, give a
 * power ($da96..) or a life, and are wiped from the BG map; enemies hurt
 * (1 or 2, most with a knockback, $3d8c); some types do nothing at all.
 *
 * `p` is the physics state (physics.js). ctx: { rom, objs, world,
 * template, v (the globals as projectiles.js has them), box ($ff90..),
 * io: { oracle(name, a) } }. Oracles: hud, sound, tileAddr2 ($37ca),
 * redraw ($3981), dialog ($2546), music ($15ae), and the handlers not
 * ported -- grab ($3ce3); after it the scan is over. Mounting (mount.js) also wants ctx.cam, and the toRider/fromRider
 * hooks where the record is kept apart. Returns 'died'
 * when a touch killed the player, { ended } when a level marker teleports
 * or ends the level (the game does not come back), else null.
 */

import { OBJ_SIZE, initObject, turnAway } from './objects.js';
import { playerBox, overlap } from './projectiles.js';
import { hurt } from './hurt.js';
import { stepInput } from './player.js';
import { onAPressed, JOY } from './physics.js';
import { mountTauntaun, mountVehicle } from './mount.js';
import { playerStateMachine } from './states.js';
import { advanceAnimation } from './sprites.js';

const w16 = (o, i) => o[i] | (o[i + 1] << 8);
const boxW = (b, i) => b[i] | (b[i + 1] << 8);
const setBox = (b, i, v) => { b[i] = v & 0xff; b[i + 1] = (v >> 8) & 0xff; };
const neg16 = (v) => (v & 0x8000) !== 0;
const rot3 = (v) => ((v << 3) | (v >> 5)) & 0xff;

const at = (ctx, ptr) => ctx.objs.subarray(ptr - 0xc300, ptr - 0xc300 + OBJ_SIZE);

/** 01:4f58 -- bit 0: the object's centre is right of the player's; bit 1: below. */
function sideOf(b) {
  const pc = (boxW(b, 0) + (b[4] >> 1)) & 0xffff, oc = (boxW(b, 8) + (b[12] >> 1)) & 0xffff;
  const py = (boxW(b, 2) - (b[6] >> 1)) & 0xffff, oy = (boxW(b, 10) - (b[14] >> 1)) & 0xffff;
  return (neg16((oc - pc) & 0xffff) ? 0 : 1) | (neg16((oy - py) & 0xffff) ? 0 : 2);
}

/** $0fbf -- A more health, up to $20 (the tauntaun's when riding). */
export function heal(p, ctx, a) {
  const key = p.ff8f ? 'da94' : 'da93';
  let h = p[key];
  for (let b = a; ;) {
    if (h === 0x20) break;
    h = (h + 1) & 0xff;
    if (h === 0x20) break;
    b = (b - 1) & 0xff;
    if (!b) break;
  }
  p[key] = h;
  ctx.io.oracle('hud');
}

/**
 * $3d8c -- pushed away from the object (D bit 0) for 8 steps: the first
 * step at once ($1662), then a hop (OnAPressed) unless already rising.
 */
function knockback(p, ctx, d) {
  if (p.ff8b === 0x02) return;
  p.da17 = d & 1 ? 1 : 0;
  p.da16 = 0x08;
  const step = { world: ctx.world, rom: ctx.rom, io: { hud: () => ctx.io.oracle('hud'), unported: () => {} } };
  stepInput(p, step);
  if (p.ff8c !== 1) onAPressed(p, step);
  else p.ff8c = 2;
}

/**
 * $3ce3 -- the swinging $49 caught, unless rising: hang from it ($da48,
 * its address in $da49), the UP power ended, then the state machine
 * ($1089, which hangs at once) and the frame ($04c3).
 */
function grab(p, ctx, o) {
  if (p.ff8c === 1 || p.da48) return STOP;
  p.da48 = 1;
  p.ff8e = 0;
  if (p.da2b === 2) p.da2b = 0;
  const addr = 0xc300 + o.byteOffset - ctx.objs.byteOffset;
  p.da49 = addr & 0xff;
  p.da4a = addr >> 8;
  const rider = ctx.objs.subarray(0, OBJ_SIZE);
  ctx.toRider?.(p, rider);
  playerStateMachine(p, rider, ctx.rom, { objs: ctx.objs });
  advanceAnimation(rider, ctx.rom);
  ctx.fromRider?.(p, rider);
  return STOP;
}

/** $3ba4 -- a pickup taken: wiped from the BG map at its position. */
function wipe(p, ctx, o) {
  p.d98a = w16(o, 0x0c);
  p.d988 = (w16(o, 0x0e) - 8) & 0xffff;
  ctx.io.oracle('tileAddr2');
  ctx.io.oracle('redraw');
  ctx.io.oracle('sound', 2);
}

const STOP = null, GO_ON = 'continue';
/** Handlers that return with HL still on the object. */
const KEEPS_HL = new Set([0x3b68, 0x3c6b, 0x3c6e]);

/** 01:607c: levels that open with a story screen, and its text. */
export const CUTSCENES = { 2: 0xd6d6, 4: 0xd752, 5: 0xd797, 6: 0xd7f0 };

/**
 * 01:600c -- a level marker ($08), used up when touched. +$10 says what
 * it is: $ff a teleport to +$12/+$14 (then $0b43 redraws the view); $80
 * the level's exit -- re-armed as $88 while $da81 is set, else the next
 * level, through a story screen ($25dc) or straight in ($01e0); anything
 * else a dialog ($2546) with A = +$10 and the text at +$12.
 */
function marker(p, ctx, o) {
  o[0] = 0;
  const k = o[0x10];
  if (k === 0xff) {
    p.x = w16(o, 0x12);
    p.y = w16(o, 0x14);
    return { ended: 'teleport' };
  }
  if (k === 0x80) {
    if (ctx.v.da81) { o[0] = 0x88; return STOP; }
    ctx.v.da8d = 0x81;
    ctx.io.oracle('music');
    p.ff8b = (p.ff8b + 1) & 0xff;
    const text = CUTSCENES[p.ff8b];
    return text ? { ended: 'cutscene', text } : { ended: 'levelStart' };
  }
  ctx.io.oracle('dialog', k, w16(o, 0x12));
  return STOP;
}

/** The handlers of the $3a73 table, by address. */
const HANDLERS = {
  0x3b65: (p, ctx, o, d) => { knockback(p, ctx, d); return STOP; },
  0x3b68: () => STOP,
  0x3b69: (p, ctx) => mountTauntaun(p, ctx),
  0x3b6f: (p, ctx, o) => marker(p, ctx, o),
  0x3b75: (p, ctx, o) => {                               // $0c: a little health
    if (p.da42 || p.ff8d) return STOP;
    heal(p, ctx, 4);
    o[0] = 0;
    return STOP;
  },
  0x3b8c: (p, ctx, o) => {                               // $15..$1c: a Force power
    const t = o[0] & 0x7f;
    o[0] = 0;
    p[(0xda96 + t - 0x15).toString(16)] = 1;
    p.da95 = 0x20;
    ctx.io.oracle('hud');
    wipe(p, ctx, o);
    return STOP;
  },
  0x3bea: (p, ctx, o) => { o[0] = 0; heal(p, ctx, 0x20); wipe(p, ctx, o); return STOP; },
  0x3bf4: (p, ctx, o) => { o[0] = 0; p.da95 = 0x20; heal(p, ctx, 0x20); wipe(p, ctx, o); return STOP; },
  0x3c01: (p, ctx, o) => { o[0] = 0; p.da95 = 0x20; ctx.io.oracle('hud'); wipe(p, ctx, o); return STOP; },
  0x3c0e: (p, ctx, o) => { p.da92 = 1; o[0] = 0; wipe(p, ctx, o); return STOP; },
  0x3c18: (p, ctx, o, d) => {                            // $26 $27: the tauntaun feeds
    if (!p.ff8f || p.state !== 0x03 || p.ff8e || p.ff8c || !(p.joy & JOY.DOWN)) return GO_ON;
    // Facing the object: c301 bit 5 (left) against its side.
    if (!((rot3(p.c301 & 0x20) ^ d) & 1)) return GO_ON;
    p.da34 = 1;
    const t = o[0] & 0x7f;
    o[0] = 0;
    heal(p, ctx, (rot3(((t - 0x26) ^ 1) & 0xff) + 8) & 0xff);
    return STOP;
  },
  0x3c6b: (p, ctx) => { ctx.touched.b = 0x2d; return STOP; },   // the walker's rear: B = $2d
  0x3c6e: (p, ctx) => { ctx.touched.b = 0x30; return STOP; },   // a speeder to board: B = $30
  0x3c71: (p) => (p.ff8b === 0x03 ? GO_ON : STOP),
  0x3c7b: (p, ctx, o) => mountVehicle(p, ctx, o),
  0x3cd6: (p, ctx, o, d) => {                            // $29 $3f $5a: probe droids
    if ((p.tick & 0x07) === 0x07) return HANDLERS[0x3d37](p, ctx, o, d);
    if ((o[0] & 0x7f) === 0x5a) return STOP;
    // $3c5c -> 01:7f3f: it turns away.
    turnAway(ctx, o);
    return STOP;
  },
  0x3ce3: (p, ctx, o) => grab(p, ctx, o),
  0x3d10: (p, ctx, o) => {                               // $5c: the previous type
    o[0] = (o[0] - 1) & 0xff;
    initObject(ctx.rom, Uint8Array.from(o), o);
    return STOP;
  },
  0x3d16: (p, ctx) => (p.da42 ? STOP : hurt(p, ctx, 0x20)),
  0x3d20: (p, ctx, o) => {                               // $6c: an extra life
    const lives = (p.da89 + 1) & 0xff;
    if (lives !== 0x0a) {
      p.da89 = lives;
      ctx.io.oracle('sound', 2);
    }
    o[0] = 0;
    return STOP;
  },
  0x3d37: (p, ctx, o, d) => { if (!p.ff8f) knockback(p, ctx, d); return hurt(p, ctx, 1); },
  0x3d3d: (p, ctx) => hurt(p, ctx, 1),
  0x3d42: (p, ctx, o, d) => { if (!p.ff8f) knockback(p, ctx, d); return hurt(p, ctx, 2); },
  0x3d4d: (p, ctx) => hurt(p, ctx, 2),
};

/** 01:50b8 */
export function touchObjects(p, ctx) {
  const { v, box: b } = ctx;
  playerBox({ v, box: b }, ctx.objs.subarray(0, OBJ_SIZE));
  let n = 30;
  v.da9e = 0xc320;
  if (p.ff8f) { n--; v.da9e = 0xc340; }
  for (; n > 0; n--, v.da9e = (v.da9e + OBJ_SIZE) & 0xffff) {
    const o = at(ctx, v.da9e);
    const t = o[0] & 0x7f;
    if (!t || t === 0x06) continue;
    v.d98e = t;
    setBox(b, 8, w16(o, 0x0c) + 2);
    setBox(b, 10, w16(o, 0x0e) - 2);
    b[12] = (o[0x18] - 4) & 0xff;
    b[14] = (o[0x19] - 4) & 0xff;
    if (!overlap({ v, box: b })) continue;
    const addr = ctx.rom.word(0, 0x3a73 + t * 2);
    const h = HANDLERS[addr];
    if (!h) throw new Error(`no touch handler $${addr.toString(16)} for type $${t.toString(16)}`);
    // What the caller finds in B and HL afterwards (the grapple, $1b5d):
    // the loop count, and the object -- unless the handler moved HL.
    ctx.touched = { b: n, addr: KEEPS_HL.has(addr) ? v.da9e : null };
    const r = h(p, ctx, o, sideOf(b));
    if (r === 'died' || r?.ended) return r;
    if (r !== GO_ON) return null;
  }
  // Nothing touched: B = 0, HL = $da9e past the last slot.
  ctx.touched = { b: 0, addr: v.da9e };
  return null;
}

/**
 * Player physics, ported instruction for instruction from the game.
 *
 * Each function here is one routine of the original, with its RAM variables
 * as fields of a plain state object. Nothing is tuned by eye: every constant
 * is an immediate operand in the ROM, and web/test/physparity.mjs replays
 * steps recorded from the real game through these functions and demands
 * identical results.
 *
 * Units are the game's own: positions in pixels, velocities in pixels per
 * game step, all 8-bit values stored unsigned exactly as in RAM. The game
 * runs one logic step every 3-4 VBlanks, not one per frame.
 */

import {
  postMoveCollisionScan, gravityPixelStep, getTileAttributes, endUpPower, crumble,
} from './collision.js';
import { fallClimbCheck } from './states.js';

// $ff8a as built by ReadJoypad ($1623): d-pad low, buttons high.
export const JOY = {
  RIGHT: 0x01, LEFT: 0x02, UP: 0x04, DOWN: 0x08,
  A: 0x10, B: 0x20, SELECT: 0x40, START: 0x80,
};

// $d98e bit 5: facing left. Velocity targets are negated when set.
const FACING_LEFT = 0x20;

const neg = (b) => (-b) & 0xff;

/**
 * The state the walking step reads and writes. Field names follow the RAM
 * address where the role is not yet known.
 */
export function createPlayer() {
  return {
    joy: 0,      // $ff8a joypad
    state: 0,    // $ffa0 game state
    ff8b: 0, ff8c: 0, ff8f: 0,
    vx: 0,       // $da18 X velocity, signed
    dir: 0,      // $d98e direction flags
    c301: 0,     // persistent copy of the direction flags
    c308: 0, da21: 0, da2b: 0, da42: 0, da4c: 0,
    da95: 0,     // counter spent while walking with $da2b = 5
    tick: 0,     // $d99e logic-step counter
    x: 0,        // $c30c world X, 16-bit
  };
}

/**
 * 01:4ca0 -- move vx one unit towards the target b. `sub b / bit 7` decides
 * the direction on the 8-bit difference, so this wraps exactly as the
 * hardware does.
 */
export function approachTargetSpeed(p, b) {
  const diff = (p.vx - b) & 0xff;
  if (diff === 0) return;
  p.vx = (p.vx + (diff & 0x80 ? 1 : -1)) & 0xff;
}

/**
 * $4cae -- set the velocity outright, signed by facing.
 * Same direction-flag bookkeeping as $4c6a, but no easing.
 */
function setSpeedDirect(p, b) {
  if (p.state !== 0x06) p.c301 = p.dir;
  p.vx = p.dir & FACING_LEFT ? neg(b) : b;
}

/**
 * 01:4bed -- the walking controller. Chooses a target speed from the d-pad
 * and the game state, then eases towards it or sets it outright.
 */
export function walkController(p) {
  p.dir = p.c301;
  if (p.joy & JOY.LEFT) p.dir |= FACING_LEFT;
  else if (p.joy & JOY.RIGHT) p.dir &= ~FACING_LEFT & 0xff;
  else return easeTo(p, 0);

  if (p.da21) return setSpeedDirect(p, 0);
  if (p.ff8c) {
    if (p.ff8f) return setSpeedDirect(p, 8);
    return setSpeedDirect(p, p.c308 >= 1 ? 6 : 0);
  }

  // $4c30: target speed by game state.
  if (p.state === 0x03) return easeTo(p, 0);
  if (p.state === 0x07 && !p.ff8f) return easeTo(p, 0);
  if (p.state === 0x04) return easeTo(p, 1);
  if (p.ff8f) return easeTo(p, 5);
  if (p.da2b === 0x05 && p.da95) {
    // $0fdc with A=1: spend one unit of the $da95 counter every 16 steps.
    // (It then calls $1144, not modelled here.)
    if (!(p.tick & 0x0f)) p.da95 = (p.da95 - 1) & 0xff;
    return easeTo(p, 5);
  }
  return easeTo(p, 3);
}

/** $4c6a -- sign the target by facing, then ease, possibly 1 step in 4. */
function easeTo(p, b) {
  if (p.da42) return setSpeedDirect(p, b);
  if (p.state !== 0x06) p.c301 = p.dir;
  if (p.dir & FACING_LEFT) b = neg(b);
  const everyStep = p.ff8b !== 1 || p.state !== 0 || p.da4c || p.ff8f;
  if (!everyStep && (p.tick & 0x03)) return;
  approachTargetSpeed(p, b);
}

/**
 * $1a3d up to $1a59 -- run the controller, then add the sign-extended
 * velocity to X through rst AddDEToVarAtHL. Leaves out SavePrevPosition and
 * the scan, so it matches what physparity.mjs records at $1a59; the full
 * routine is stepPlayerX.
 */
export function stepX(p) {
  walkController(p);
  savePrevPosition(p);
  // $1a4c: the speed is also the player record's +$10.
  p.c310 = p.vx;
  const dx = p.vx & 0x80 ? p.vx - 0x100 : p.vx;
  p.x = (p.x + dx) & 0xffff;
}

/** $1a3d StepPlayerX, all of it: stepX, then the collision scan. */
export function stepPlayerX(p, ctx) {
  stepX(p);
  return postMoveCollisionScan(p, ctx.world);
}

// ---------------------------------------------------------------------------
// Jumping. `$ff8c` is the phase: 0 none, 1 rising, 2 falling along the arc.
//
// These take a context { world, rom, io }: world for the collision scans
// (collision.js), rom for the arc tables, and io for the callees ported
// elsewhere or not at all -- io.objectLanding() ($3d80, returns A and leaves
// register C in world.c; landing.js) and io.hud() ($1144). The parity tests
// supply recorded answers for those. The fall's climb check ($1a21 ->
// 01:5825, tested on register C) is fallClimbCheck in states.js.
// ---------------------------------------------------------------------------

// Arc tables in bank 0: signed per-step Y deltas, $80-terminated, indexed
// from the base by $da1e (rise: $da1e + 1). See JumpRiseStep in empire.sym.
const ARC_LOW = 0x0d51, ARC_HIGH = 0x0d57, ARC_FORCE = 0x0d5d;

/** $0d36 */
function savePrevPosition(p) {
  p.px = p.x;
  p.py = p.y;
}

/** $112a -- cleared on every jump start. */
function resetAnimation(p) {
  p.da22 = 0;
  p.da23 = 0;
  p.c300 = 1;
}

/**
 * $1a8f -- A pressed. Starts a jump unless one is already under way or
 * something else is busy. With $da35 = 2 and UP: the grapple ($1aed,
 * grapple.js, through io.grapple); 'over' when it ends the climb, which
 * skips the rest of the caller.
 */
export function onAPressed(p, ctx) {
  if (p.da48) {
    enterForceJump(p);
    p.da48 = 0;
    p.ff8e = 0;
    return startJump(p, ctx);
  }
  if (p.da43 || p.ff8c || p.da1d || p.ff8e || p.ff8d) return 'ok';
  if (p.da35 === 2 && (p.joy & JOY.UP)) return ctx.io.grapple ? ctx.io.grapple(p) : 'unported';
  return startJump(p, ctx);
}

/** $1ab8 */
function startJump(p, ctx) {
  p.da19 = 0;
  p.ff8c = 1;
  p.da1d = 1;
  p.da1e = 0x0a;
  if (p.da22 === 0x0b) {
    enterForceJump(p);
    return 'ok';
  }
  resetAnimation(p);
  if (p.da2b !== 1) return 'ok';
  // $0fdc SpendForce with A = 1: no fuel, no Force jump.
  if (!p.da95) return 'ok';
  p.da95 = (p.da95 - 1) & 0xff;
  ctx.io.hud(p);
  enterForceJump(p);
  return 'ok';
}

/** $1adb -- state 9 selects the -8 x 10 arc. */
function enterForceJump(p) {
  p.state = 0x09;
  resetAnimation(p);
}

/** $1927 -- A not held: a rising jump starts falling now (variable height). */
export function aReleased(p) {
  p.da1d = 0;
  if (p.da16) return;
  if (p.ff8c !== 1) return;
  if (p.da1c) return;
  p.ff8c = 2;
}

/** $193f -- once per step: count $da1c down, then rise or fall. */
export function verticalStep(p, ctx) {
  if (p.da1c) p.da1c = (p.da1c - 1) & 0xff;
  if (p.ff8c === 1) return jumpRiseStep(p, ctx);
  if (p.ff8c === 2) return jumpFallStep(p, ctx);
  return 'ok';
}

const arcEntry = (rom, base, index) => rom.byte(0, base + (index & 0xff));

/** $1957 */
function jumpRiseStep(p, ctx) {
  if (p.da35 !== 2) savePrevPosition(p);
  let base;
  if (p.state === 0x08 || p.state === 0x09) base = ARC_FORCE;
  else if (p.ff8f && p.ff8b === 1) base = ARC_HIGH;
  else base = ARC_LOW;
  const v = arcEntry(ctx.rom, base, p.da1e + 1);
  if (v === 0x80) {
    p.ff8c = 2;
    return 'ok';
  }
  // `ld d,$ff / ld e,a`: always extended as negative, whatever the entry.
  p.y = (p.y + (0xff00 | v)) & 0xffff;
  postMoveCollisionScan(p, ctx.world);
  if (p.da35 === 2) p.py = p.y;
  p.da1e = (p.da1e + 1) & 0xff;
  return 'ok';
}

/**
 * $19b2 -- walk the arc back down, one pixel at a time. Each pixel is a full
 * collision scan; landing on a floor undoes the pixel but does not end the
 * phase -- only the table's $80 does (JumpLanded).
 */
function jumpFallStep(p, ctx) {
  let base;
  if (p.state === 0x08) base = ARC_FORCE;
  else if (p.ff8f === 1 && p.ff8b === 1) base = ARC_HIGH;
  else base = ARC_LOW;
  const v = arcEntry(ctx.rom, base, p.da1e);
  if (v === 0x80) return jumpLanded(p);
  let n = (-v) & 0xff;
  do {
    if (!p.da35) {
      savePrevPosition(p);
      p.sx = p.x;
      p.sy = p.y;
    }
    p.y = (p.y + 1) & 0xffff;
    if (p.da35 === 2) p.py = p.y;
    postMoveCollisionScan(p, ctx.world);
    if (!p.da35) {
      if (ctx.io.objectLanding(p) === 0xff) return 'ok';
      if (!(n & 3) && fallClimbCheck(p, ctx.world) === 4) return 'ok';
    }
    n = (n - 1) & 0xff;
  } while (n);
  p.da1e = (p.da1e - 1) & 0xff;
  return 'ok';
}

/** $1a34 -- arc exhausted: phase 0, and six steps of zero walk speed. */
function jumpLanded(p) {
  p.ff8c = 0;
  p.da21 = 0x06;
  return 'ok';
}

// ---------------------------------------------------------------------------
// Free fall: 01:5704 FreeFallStep, run from the main loop ($06a5) every step
// before the input handlers. It asks ProbeGround what is under the feet and
// lands, climbs, drops into a pit or falls up to 4 px. Further callees for
// the io context: io.pit() ($0d73, reached with A = $20 after the pit drop)
// and io.objectLanding() as in the jump.
// ---------------------------------------------------------------------------

/**
 * $1c6d -- classify the row under the probe point (Y + 1), column by column.
 * Returns [A, C]: A = 0 floor (C = attribute), 1 nothing, 2 bit 3 underfoot
 * while on foot, or the attribute itself for bit 6, and for bits 4/5 on foot.
 * Mounted, bits 4/5 move on to the next column. $d98c keeps the address of
 * the metatile byte last read.
 */
export function probeGround(p, world, columns) {
  let xt = p.d988 >> 3;
  const yt = ((p.d98a + 1) & 0xffff) >> 3;
  do {
    const a = getTileAttributes(world, xt, yt);
    p.d98c = world.lastAddr;
    // DE and HL as the caller finds them: the column and row of the hit.
    world.probeHit = { xt, yt };
    if (a & 0x04) return [0, a];
    if (a & 0x08) return p.ff8f ? [0, a] : [2, 0];
    if (a & 0x40) return [a, a];
    if (a & 0x01) return [0, a];
    if ((a & 0x30) && !p.ff8f) return [a, a];
    xt = (xt + 1) & 0xffff;
    columns = (columns - 1) & 0xff;
  } while (columns);
  return [1, 0];
}

/** $1c44 -- up to four pixels of fall; then $ff8e = 1. */
export function gravityFall4(p, ctx) {
  for (let i = 0; i < 4; i++) {
    gravityPixelStep(p, ctx.world);
    if (ctx.io.objectLanding(p) === 0xff) return 'ok';
  }
  p.ff8e = 1;
  return 'ok';
}

/** 01:5704 */
export function freeFallStep(p, ctx) {
  p.ff8e = 0;
  p.da1f = 0;
  if (p.da43 && (p.joy & JOY.UP)) return 'ok';
  p.sx = p.x;
  p.sy = p.y;
  if (p.ff8c === 1) return 'ok';
  p.da19 = 0;
  // The probe point goes through RAM: $d988 = X ahead, $d98a = Y.
  p.d988 = (p.x + (p.ff8f ? 16 : 8)) & 0xffff;
  p.d98a = p.y;
  const [a, c] = probeGround(p, ctx.world, p.ff8f ? 2 : (p.c304 - 1) & 0xff);
  if (a === 0) return landed(p, c, ctx);
  if (a === 0x02) {
    // $5819: drop 16 px into the pit, then $0d73 with A = $20.
    p.y = (p.y + 16) & 0xffff;
    ctx.io.pit(p);
    return 'ok';
  }
  if (a === 0x10) return onClimbable(p, ctx);
  if (a === 0x41) {
    if (p.state === 0x15) return landed(p, c, ctx);
    p.da1f = 2;
    p.ff8c = 0;
    p.ff8e = 0;
    return finishLanding(p);
  }
  if (p.ff8c) return 'ok';
  return gravityFall4(p, ctx);
}

/** $57bf -- on a floor. C is its attribute. */
function landed(p, c, ctx) {
  if (p.state === 0x15) {
    p.c309 = 0x08;
    p.state = 0x16;
  }
  endUpPower(p);
  if (c === 0xfd && p.ff8f) {
    // $57c8: riding onto a crumbling tile breaks it ($24b1, at $d98c), and
    // $1c33 redraws its metatile: $d988/$d98a's low bytes from the probe's
    // row and column, as pixels.
    crumble(ctx.world, p.d98c, p.da30);
    const { xt, yt } = ctx.world.probeHit;
    p.d988 = (p.d988 & 0xff00) | ((yt << 3) & 0xff);
    p.d98a = (p.d98a & 0xff00) | ((xt << 3) & 0xff);
    ctx.io.redraw?.(p);
  }
  p.da1f = 0;
  return finishLanding(p);
}

/** $57fc */
function finishLanding(p) {
  p.da43 = 0;
  if (p.ff8c === 2) {
    p.ff8c = 0;
    p.da21 = 0x06;
  }
  if (p.state === 0x04) p.da21 = 0x06;
  return 'ok';
}

/** $578d -- a climbable tile under the feet: hold on to it. */
function onClimbable(p, ctx) {
  if (p.state === 0x15) return gravityFall4(p, ctx);
  if (p.da43) {
    endUpPower(p);
    return 'ok';
  }
  if (p.ff8d) return 'ok';
  if (p.ff8c === 1) return 'ok';
  p.da19 = 1;
  p.da1f = 0;
  if (p.ff8c === 2) p.ff8c = 0;
  return 'ok';
}

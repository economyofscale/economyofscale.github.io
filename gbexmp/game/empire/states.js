/**
 * The player's state and on-foot animation, ported from the game.
 *
 * After the player step the main loop runs, in order: ClimbCheck (01:5825),
 * ForceCharge ($10e7) and PlayerStateMachine (01:5886, via $1089). Together
 * they pick the state $ffa0 -- 0 idle, 1 jumping, 2 walking, 3 crouching or
 * landing, 4 falling, 6 climbing, 7 attacking, 8 Force jump, $13 the UP
 * power -- and the animation of the player record $c300.
 *
 * `rider` is the $c300 record (see sprites.js for the layout); the physics
 * state p holds the rest. Two branches reach outside the player: $da48
 * ($3f3e, hanging from an object: `ctx.objs`, object RAM) and $da3e
 * ($5a6a, the grapple's, grapple.js: `ctx.grapple(p, rider)`). Without
 * them in `ctx` they return 'unported'.
 */

import { JOY, probeGround } from './physics.js';
import { setAnimation, advanceAnimation } from './sprites.js';

/**
 * 01:5825 -- standing on a climbable tile ($10 from ProbeGround) sets
 * $da19, which hands the next step to the climbing code.
 */
export function climbCheck(p, rider, world) {
  climbCheckC(p, world, (rider[0x04] - 1) & 0xff);
}

/**
 * 01:5825 as the jump fall calls it ($1a21), which then tests register C
 * for 4: returns C. On the early returns, and when ProbeGround meets a
 * bit-3 tile on foot, C is what it was on entry (world.c, as
 * CheckObjectLanding left it); otherwise ProbeGround's.
 */
export function fallClimbCheck(p, world) {
  return climbCheckC(p, world, (p.c304 - 1) & 0xff);
}

function climbCheckC(p, world, columns) {
  const c = world.c;
  if (p.da35) return c;
  if (p.da43 && (p.joy & JOY.UP)) return c;
  if (p.ff8c === 1) return c;
  if (p.ff8f) return c;
  p.da19 = 0;
  p.d988 = (p.x + 8) & 0xffff;
  p.d98a = p.y;
  const [a, probeC] = probeGround(p, world, columns);
  const cOut = a === 2 ? c : probeC;
  if (a !== 0x10) return cOut;
  if (p.state === 0x15 || p.da43 || p.ff8d || p.ff8c === 1) return cOut;
  p.da19 = 1;
  return cOut;
}

/**
 * $3f3e -> 03:$7f0d -- hanging from the object at $da49 (the swinging
 * $49): at its position plus a swing offset (03:$7f5e, 6 bytes by
 * $d99e / 2 & $1e: X, Y, animation), facing right, state $14, box 4 high.
 */
function hanging(p, rider, rom, objs) {
  rider[0x01] &= 0xdf;
  const addr = (p.da49 | (p.da4a << 8)) - 0xc300;
  const word = (a) => rom.byte(3, a) | (rom.byte(3, a + 1) << 8);
  const at = 0x7f5e + ((p.tick >> 1) & 0x1e) * 3;
  p.x = (objs[addr + 0x0c] | (objs[addr + 0x0d] << 8)) + word(at);
  p.y = (objs[addr + 0x0e] | (objs[addr + 0x0f] << 8)) + word(at + 2);
  p.x &= 0xffff;
  p.y &= 0xffff;
  p.state = 0x14;
  rider[0x04] = 0x04;
  setAnimation(rider, word(at + 4), 0x02);
  return 'ok';
}

/** $112a */
function resetCharge(p, rider) {
  p.da22 = 0;
  p.da23 = 0;
  rider[0x00] = 1;
}

/**
 * $10e7 -- holding DOWN counts $da22 up to $0b; a jump at $0b is a Force
 * jump (StartJump). While charged the player blinks: $c300 bit 7, the
 * "hidden" bit, toggles every step. Released, the charge holds for $40 steps.
 */
export function forceCharge(p, rider) {
  if (p.da42 || p.ff8c) return;
  if (!p.da19 && !p.ff8e && (p.joy & JOY.DOWN)) {
    const a = (p.da22 + 1) & 0xff;
    if (a === 0x0c) { rider[0x00] ^= 0x80; return; }
    p.da22 = a;
    return;
  }
  if (p.da22 !== 0x0b) { resetCharge(p, rider); return; }
  p.da23 = (p.da23 + 1) & 0xff;
  if (p.da23 === 0x40) { resetCharge(p, rider); return; }
  rider[0x00] ^= 0x80;
}

/** $10be -- animate the player, facing taken from frame bit 2 (climbing). */
function animateFacingByFrame(p, rider, rom) {
  advanceAnimation(rider, rom);
  rider[0x01] = (rider[0x01] & 0xdf) | ((rider[0x08] & 0x04) << 3);
}

const savedAnimation = (p, rider) => {
  rider[0x0a] = p.da44;
  rider[0x0b] = p.da45;
};

/** 01:5886 */
export function playerStateMachine(p, rider, rom, ctx = null) {
  if (p.da48) return ctx?.objs ? hanging(p, rider, rom, ctx.objs) : 'unported';   // $3f3e
  if (p.da42) return 'ok';
  if (p.da3e) return ctx?.grapple ? ctx.grapple(p, rider) : 'unported';   // $5a6a
  if (p.da34) return timedPose(p, rider, rom);
  if (p.da26) return animationCycle(p, rider, rom);
  if (p.da21) return landingPause(p, rider, rom);
  if (p.ff8d) return attack(p, rider, rom);
  if (p.da19) return climbing(p, rider, rom);
  if (p.da43) return upPower(p, rider);
  if (p.ff8e) return falling(p, rider);
  if (p.ff8c) return jumping(p, rider);
  if (p.joy & JOY.DOWN) return crouch(p, rider);
  if (p.joy & (JOY.LEFT | JOY.RIGHT)) {          // $58d3
    if (p.state === 0x02) return 'ok';
    rider[0x04] = 3;
    setAnimation(rider, 0x7ad2, 0x14);
    p.state = 0x02;
    return 'ok';
  }
  setAnimation(rider, 0x7ae6, 0x02);              // $58f0
  p.state = 0x00;
  return 'ok';
}

/** $58fd */
function upPower(p, rider) {
  let table = 0x7aec;
  if (p.da91) {
    table = 0x7af2;
    rider[0x04] = 4;
    rider[0x05] = 4;
  }
  setAnimation(rider, table, 0x02);
  p.state = 0x13;
  return 'ok';
}

/** $591d */
function animationCycle(p, rider, rom) {
  p.da26 = (p.da26 + 1) & 0x03;
  rider[0x08] = 0;
  if (!p.da26) {
    savedAnimation(p, rider);
    if (p.state === 0x06) {
      setAnimation(rider, 0x7ba4, 0x08);
      animateFacingByFrame(p, rider, rom);       // `jp $10be`
      return 'ok';
    }
  }
  // $594d: facing from $da25.
  if (p.da25 & 0x02) rider[0x01] |= 0x20;
  else if (p.da25 & 0x01) rider[0x01] &= 0xdf;
  if (!p.da21) return 'ok';
  return landingPause(p, rider, rom);
}

/** $5966 */
function landingPause(p, rider, rom) {
  p.da21 = (p.da21 - 1) & 0xff;
  if (!p.da21) { p.state = 0x00; return 'ok'; }
  if (p.ff8d) {
    const r = endAttack(p, rider, rom);
    if (r !== 'ok') return r;
  }
  return crouch(p, rider);
}

/** $5975 */
function crouch(p, rider) {
  if (p.state === 0x03) return 'ok';
  p.state = 0x03;
  if (p.ff8f) return 'ok';
  setAnimation(rider, 0x7af4, 0x02);
  return 'ok';
}

/** $5990: $ff8d counts the attack; 2 starts it, frame $0b ends it. */
function attack(p, rider, rom) {
  p.ff8d = (p.ff8d + 1) & 0xff;
  if (p.ff8d === 2) return startAttack(p, rider, rom);
  if (rider[0x08] !== 0x0b) return 'ok';
  return endAttack(p, rider, rom);
}

/**
 * $599e -- box back to the normal size, restore the saved animation when
 * jumping, else rerun the state machine from the top.
 */
function endAttack(p, rider, rom) {
  let b = 3, c = 4;
  if (p.da43 && p.da91) { b = 6; c = 4; }
  else if (p.ff8f) { b = 5; c = 3; }
  rider[0x04] = b;
  rider[0x05] = c;
  p.ff8d = 0;
  if (p.state === 0x08 || p.state === 0x01) {
    savedAnimation(p, rider);
    rider[0x08] = (p.da46 + 4) & 0xff;
    return 'ok';
  }
  return playerStateMachine(p, rider, rom);
}

/** $59e3 -- pick the attack pose from 01:$6089 by situation. */
function startAttack(p, rider, rom) {
  if (p.da19) {
    // On a ladder: snap X to the ladder's 32 px column.
    const x = (p.x + 8) & 0xffff;
    p.x = (((x & 0xff00) | (x & 0xe0)) + 8) & 0xffff;
  }
  p.da44 = rider[0x0a];
  p.da45 = rider[0x0b];
  p.da46 = rider[0x08];
  let l;
  if (p.ff8f) l = 0;
  else if (p.ff8c || p.da43) l = 4;
  else if (p.joy & JOY.UP) l = 3;
  else if (p.joy & (JOY.LEFT | JOY.RIGHT)) l = 2;
  else l = 1;
  p.da24 = l;
  const at = 0x6089 + l * 4;
  rider[0x04] = rom.byte(1, at);
  rider[0x05] = rom.byte(1, at + 1);
  setAnimation(rider, rom.word(1, at + 2), 0x0c);
  if (p.ff8c || p.da43) {
    p.ff8d = 7;
    rider[0x08] = 7;
    return 'ok';
  }
  p.state = 0x07;
  return 'ok';
}

/** $108f -- on a climbable tile. */
function climbing(p, rider, rom) {
  if (p.da2b === 2) p.da2b = 0;
  if (p.state !== 0x06) {
    setAnimation(rider, 0x7ba4, 0x08);
    rider[0x04] = 3;
    p.state = 0x06;
    animateFacingByFrame(p, rider, rom);
    return 'ok';
  }
  if (!(p.joy & (JOY.UP | JOY.DOWN))) return 'ok';
  if (!p.da4f) return 'ok';
  animateFacingByFrame(p, rider, rom);
  return 'ok';
}

/** $5ab9 -- a timed pose, $18 steps, then back to normal. */
function timedPose(p, rider, rom) {
  p.da34 = (p.da34 + 1) & 0xff;
  if (p.da34 === 0x19) {
    p.da34 = 0;
    p.state = 0xff;
    rider[0x05] = 3;
    rider[0x04] = 5;
    return playerStateMachine(p, rider, rom);
  }
  if (p.da34 !== 0x02) return 'ok';
  rider[0x05] = 4;
  rider[0x04] = 6;
  setAnimation(rider, 0x7b8c, 0x0c);
  return 'ok';
}

/** $5aea */
function falling(p, rider) {
  if (p.state === 0x04 || p.state === 0x13 || p.da43) return 'ok';
  rider[0x04] = 3;
  setAnimation(rider, 0x7b20, 0x02);
  p.state = 0x04;
  return 'ok';
}

/** $5b09 */
function jumping(p, rider) {
  if (p.state === 0x01) return 'ok';
  if (p.state === 0x09 || p.state === 0x08) {
    if (p.state === 0x08) return 'ok';
    rider[0x04] = 3;
    setAnimation(rider, 0x7b06, 0x18);
    p.state = 0x08;
    p.da22 = 0;
    return 'ok';
  }
  rider[0x04] = 3;
  setAnimation(rider, 0x7af6, 0x10);
  p.state = 0x01;
  return 'ok';
}

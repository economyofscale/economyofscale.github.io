/**
 * One game step of the player, in the game's own order.
 *
 * The main loop's player update is $06a5..$06af: FreeFallStep, then $1662,
 * which either applies a knockback or runs GameplayInputDispatch ($1683).
 * Routines the port does not model yet are called through ctx.io; the
 * closed-loop test answers them from a recording.
 */

import {
  JOY, freeFallStep, stepPlayerX, onAPressed, aReleased, verticalStep,
} from './physics.js';
import { postMoveCollisionScan } from './collision.js';

/** $06a5..$06af */
export function playerStep(p, ctx) {
  freeFallStep(p, ctx);
  if (p.da34) return;
  stepInput(p, ctx);
}

/** $1662 */
export function stepInput(p, ctx) {
  if (p.da3e) return;
  if (p.da16) {
    p.da16 = (p.da16 - 1) & 0xff;
    p.vx = 0;
    knockback(p, ctx, p.da17 ? -4 : 4);
    return;
  }
  gameplayInputDispatch(p, ctx);
}

/** $1a5c / $1a70 -- pushed 4 px back while $da16 counts down. */
function knockback(p, ctx, dx) {
  p.px = p.x;
  p.py = p.y;
  // $1a84: with $da35 = 2 the camera moves too, and nothing is scanned.
  if (p.da35 === 2) {
    if (!ctx.io.cameraBy) { ctx.io.unported(p, 'knockback with $da35 = 2'); return; }
    p.x = (p.x + dx) & 0xffff;
    ctx.io.cameraBy(dx);
    return;
  }
  p.x = (p.x + dx) & 0xffff;
  postMoveCollisionScan(p, ctx.world);
}

/** $1683 -- each test reads the joypad afresh, as the game does. */
function gameplayInputDispatch(p, ctx) {
  // The branch is decided on $da19 as it was before either call.
  if (p.da19) ctx.io.climbInput(p);
  else ctx.io.upFromGround(p);
  if (p.joy & JOY.UP) ctx.io.onUp(p);
  stepPlayerX(p, ctx);
  if (p.joy & JOY.SELECT) ctx.io.onSelect(p);
  p.da31 = p.joy;
  if (p.joy & JOY.B) ctx.io.onB(p);
  else p.da1b = 0;            // $1922 BReleased
  if (p.joy & JOY.A) {
    // The grapple's end pops this return ($1b4a): the rest is skipped.
    if (onAPressed(p, ctx) === 'over') return;
  } else aReleased(p);
  verticalStep(p, ctx);
}

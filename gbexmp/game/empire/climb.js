/**
 * Climbing and the UP power, ported from the game.
 *
 * GameplayInputDispatch ($1683) starts every step with one of two calls,
 * decided on $da19 (on a climbable, set by ClimbCheck 01:5825):
 *
 *   ClimbInput   $1727  on a climbable: UP climbs if a climbable tile is
 *                       above the box, DOWN climbs down
 *   UpFromGround $176a  otherwise: UP climbs when the last scan met a
 *                       climbable tile ($da1a)
 *
 * then OnUpPressed ($16be) while UP is held: with the UP power selected
 * ($da2b = 2) and meter left ($da95), the player rises 4 px a step ($da43).
 *
 * Every climb step is 2 px, through SavePrevPosition and the post-move
 * collision scan; $da4f says a climb step was taken (PlayerStateMachine
 * animates only then).
 */

import { JOY } from './physics.js';
import { getTileAttributes, undoMove, postMoveCollisionScan, ATTR } from './collision.js';

/** $0d36 */
function savePrevPosition(p) {
  p.px = p.x;
  p.py = p.y;
}

/** $1785 -- 2 px up; above the top of the map the move is undone. */
export function climbUpStep(p, world) {
  p.da4f = 1;
  savePrevPosition(p);
  p.y = (p.y - 2) & 0xffff;
  if (p.y & 0x8000) return undoMove(p);
  return postMoveCollisionScan(p, world);
}

/** $179c -- 2 px down. */
function climbDownStep(p, world) {
  p.da4f = 1;
  savePrevPosition(p);
  p.y = (p.y + 2) & 0xffff;
  return postMoveCollisionScan(p, world);
}

/**
 * $173a -- the tile row 3 above the position's, columns from one right of
 * it, $c304 - 1 of them: the first climbable one lets the player climb.
 */
function climbUpIfClimbableAbove(p, world) {
  let xt = ((p.x >> 3) + 1) & 0xffff;
  const yt = ((p.y >> 3) - 3) & 0xffff;
  let b = (p.c304 - 1) & 0xff;
  do {
    if (getTileAttributes(world, xt, yt) & ATTR.CLIMB) return climbUpStep(p, world);
    xt = (xt + 1) & 0xffff;
    b = (b - 1) & 0xff;
  } while (b);
  return 'ok';
}

/** $1727 -- each test reads the joypad afresh, as the game does. */
export function climbInput(p, world) {
  p.da4f = 0;
  if (p.joy & JOY.UP) climbUpIfClimbableAbove(p, world);
  if (p.joy & JOY.DOWN) climbDownStep(p, world);
}

/** $176a -- touching a climbable ends the UP power; UP climbs. */
export function upFromGround(p, world) {
  if (!p.da1a) return;
  if (p.da2b === 2) {
    p.da2b = 0;
    p.da43 = 0;
  }
  if (p.joy & JOY.UP) climbUpStep(p, world);
}

/** $16be -- UP held: the UP power lifts the player while there is meter. */
export function onUpPressed(p, world) {
  if (p.ff8f) return;
  if (p.da2b !== 2) return;
  if (!p.da95) {
    p.da43 = 0;
    return;
  }
  p.da43 = 1;
  p.ff8c = 0;
  p.ff8e = 0;
  climbUpStep(p, world);
  climbUpStep(p, world);
}

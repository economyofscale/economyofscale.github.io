/**
 * The grapple -- level 2 on foot, after the snowspeeder is down ($da35 = 2,
 * $ff8f = 0): A with UP fires the line up at a walker, and Luke climbs
 * ($da3e counts the stages). Ported from the game:
 *
 *   $1aed  A + UP: the move undone ($0d41), a 3 x 3 box, the next stage
 *   $1af8  next stage: $da3e + 1, its timer $da3f, Y speed and animation
 *          from 03:$5c49 (5 bytes a stage); at 9 over -- the state
 *          machine ($1089) runs, and the caller's rest is skipped
 *            2  what the player touches (01:50b8): a speeder ($30) to
 *               board ($1b88); a walker's rear ($2d, $da92 set) within
 *               20 px holds the stage; anything else: on to stage 8
 *            3  the line's pieces ($32, $33) go
 *            7  the rope ($2f) goes, and the walker before the touched
 *               record falls ($2498)
 *  01:5a6a  in the state machine while $da3e: the timer, the move; in
 *          stage 3 a piece of rope ($2f) every other step
 *   $1a84  the knockback while $da35 = 2: camera and player X by 4
 *
 * `g`: { rom, objs, template, rider (the player record), touch() (runs
 * 01:50b8, leaves ctx.touched {b, addr}), stateMachine(), io }. The player
 * state `p` holds the record's shared fields (play.js SHARED); +$0a/+$0b
 * live only in `rider`.
 */

import { OBJ_SIZE, spawnFromTemplate } from './objects.js';

const STAGES = 0x5c49;
const w16 = (o, i) => o[i] | (o[i + 1] << 8);
const set16 = (o, i, v) => { o[i] = v & 0xff; o[i + 1] = (v >> 8) & 0xff; };
const s8 = (v) => (v & 0x80 ? v - 0x100 : v);
const at = (g, addr) => g.objs.subarray(addr - 0xc300, addr - 0xc300 + OBJ_SIZE);

/** $2608 -- every object of type `t` (from $c320, 30 slots) gone. */
function removeType(g, t) {
  for (let i = 1; i < 31; i++) if ((g.objs[i * OBJ_SIZE] & 0x7f) === t) g.objs[i * OBJ_SIZE] = 0;
}

/** $1aed -- returns 'over' when the climb ended (the caller's rest skipped). */
export function grappleStart(p, g) {
  // $0d41
  if (p.state === 0x15) { p.state = 0x16; p.c309 = 0x08; }
  p.x = p.px;
  p.y = p.py;
  // $1af0: the box, 3 x 3.
  p.c305 = 0x03;
  p.c304 = 0x03;
  return nextStage(p, g);
}

/** $1af8 */
function nextStage(p, g) {
  p.c310 = 0x00;
  p.state = 0xff;
  p.da3e = (p.da3e + 1) & 0xff;
  if (p.da3e === 0x09) {
    // $1b41
    p.c305 = 0x04;
    p.da3e = 0;
    g.stateMachine();
    return 'over';
  }
  const e = STAGES + p.da3e * 5;
  p.da3f = g.rom.byte(3, e);
  p.c311 = g.rom.byte(3, e + 1);
  // $10d7: the animation.
  p.c309 = g.rom.byte(3, e + 2);
  g.rider[0x0a] = g.rom.byte(3, e + 3);
  g.rider[0x0b] = g.rom.byte(3, e + 4);
  p.c308 = 0;
  if (p.da3e === 0x02) return stageTwo(p, g);
  if (p.da3e === 0x07) {
    // $1b4e
    removeType(g, 0x2f);
    g.touch();
    const addr = g.touched().addr;
    if (addr === null) { g.io.unported?.(p, 'grapple: KillPair after a touch handler that moved HL'); return 'ok'; }
    killPair(g, (addr - OBJ_SIZE) & 0xffff);
    return 'ok';
  }
  if (p.da3e === 0x03) {
    removeType(g, 0x32);
    removeType(g, 0x33);
  }
  return 'ok';
}

/** $1b5d */
function stageTwo(p, g) {
  g.touch();
  const { b, addr } = g.touched();
  if (b === 0x30) return board(p, g, addr);
  if (b === 0x2d && p.da92) {
    // Close to the walker's rear ($ff98: its X + 2): the stage holds.
    const d = (p.x - w16(g.box, 8)) & 0xff;
    if (d < 0x14) return 'ok';
  }
  // $1b80
  p.da3e = 0x07;
  return nextStage(p, g);
}

/** $1b88 -- into the speeder that was touched. */
function board(p, g, addr) {
  at(g, addr)[0] = 0;
  for (const t of [0x01, 0x32, 0x33, 0x30]) removeType(g, t);
  p.da94 = 0x20;
  // The speeder's record (02:$7c96) as the player, at the same X.
  const x = p.x;
  for (let i = 0; i < OBJ_SIZE; i++) g.rider[i] = g.rom.byte(2, 0x7c96 + i);
  set16(g.rider, 0x0c, x);
  g.fromRider(p, g.rider);
  p.x = x;
  p.y = w16(g.rider, 0x0e);
  p.da3e = 0;
  p.ff8f = 1;
  p.state = 0x0e;
  g.io.oracle('hud');
  return 'ok';
}

/** $2498 -- the walker at `addr` falls; its partner after it goes. */
function killPair(g, addr) {
  const o = at(g, addr);
  o[0x00] = 0xd1;
  o[0x04] = 0x08;
  at(g, (addr + OBJ_SIZE) & 0xffff)[0] = 0;
  g.io.oracle('sound', 0x01);
}

/** 01:5a6a -- the state machine's branch while $da3e. */
export function grappleState(p, g) {
  p.da3f = (p.da3f - 1) & 0xff;
  if (!p.da3f) nextStage(p, g);
  // $2344 on the player: X by +$10 ($80 none), Y by +$11.
  const dx = p.c310 === 0x80 ? 0 : s8(p.c310);
  p.x = (p.x + dx) & 0xffff;
  p.y = (p.y + s8(p.c311)) & 0xffff;
  if (p.da3e !== 0x03 || (p.da3f & 0x01)) return 'ok';
  // A piece of rope ($2f) under the player: Y's low byte $38 + 4 x the
  // timer, X's low byte + 8 (no carry), attribute 2.
  g.toRider(p, g.rider);
  const t = g.template;
  t.set(g.rider.subarray(0, OBJ_SIZE));
  t[0x0e] = (0x38 + ((p.da3f << 2) & 0xff)) & 0xff;
  t[0x10] = 0x00;
  t[0x11] = 0x00;
  t[0x0c] = (t[0x0c] + 0x08) & 0xff;
  t[0x01] = 0x02;
  t[0x00] = 0x2f;
  spawnFromTemplate(g.rom, g.objs, t);
  return 'ok';
}

/** $1a84 -- the knockback while $da35 = 2: the camera ($d9af) and X by `dx`. */
export function grappleKnockback(p, cam, dx) {
  cam.x = (cam.x + dx) & 0xffff;
  p.x = (p.x + dx) & 0xffff;
}

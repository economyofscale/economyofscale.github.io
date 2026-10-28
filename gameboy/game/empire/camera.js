/**
 * The camera, ported from the game: $3621 UpdateCamera (main loop $06f6,
 * on foot only) and its start, 01:538a.
 *
 * One pass (01:4d98) moves the camera at most a pixel each way, towards a
 * dead zone round the player: X while the player is not within camX + 61
 * .. camX + 70, Y while not within camY + 89 .. camY + 104; never below 0,
 * nor past the map's width - 1 - 160 and height - 144. After each pass
 * that moved, $363b steps SCX/SCY ($d99f/$d9a7) a pixel after it,
 * streaming in a 16 px column or row of the map when the camera crosses
 * one -- with the position in $d988/$d98a. The passes repeat until the
 * camera rests, so it catches up within the step.
 *
 * `c`: { x ($d9af), y ($d9b1), scx ($d99f), scy ($d9a7), w ($d9b7, the X
 * limit), h ($d9b9, the map height) }. `v`: the shared scratch $d988,
 * $d98a, $d98e (left at 0) and $da35. io.oracle: tileAddr2 ($37ca),
 * streamCol ($3921), streamRow ($38ec) -- the map streaming, which the
 * browser does by redrawing the view instead.
 */

/** `a < b` as 16-bit unsigned -- the carry of $335b's HL - BC. */
const below = (a, b) => (a & 0xffff) < (b & 0xffff);

/** 01:538a -- where a level starts the camera. */
export function initCamera(c, p, v) {
  if (v.da35 === 0x02) return;
  c.x = p.x >= 0x48 ? p.x - 0x48 : 0;
  c.y = p.y >= 0x48 ? p.y - 0x48 : 0;
  if (!(((c.y + 0x90 - c.h) & 0xffff) & 0x8000)) c.y = (c.h - 0x90) & 0xffff;
}

/** 01:4e0b -- the X half of a pass; true when the camera moved. */
function passX(c, p) {
  if (!below((c.x + 0x3c) & 0xffff, p.x)) {
    if (!c.x) return false;
    c.x = (c.x - 1) & 0xffff;
    return true;
  }
  if (!below((c.x + 0x46) & 0xffff, p.x)) return false;
  if (below((c.w - 1 - 0xa0) & 0xffff, c.x)) return false;
  c.x = (c.x + 1) & 0xffff;
  return true;
}

/** 01:4d9b -- the Y half. */
function passY(c, p) {
  if (!below((c.y + 0x58) & 0xffff, p.y)) {
    if (!c.y) return false;
    c.y = (c.y - 1) & 0xffff;
    return true;
  }
  if (!below((c.y + 0x68) & 0xffff, p.y)) return false;
  if (below((c.h - 0x90) & 0xffff, c.y)) return false;
  c.y = (c.y + 1) & 0xffff;
  return true;
}

/** 01:4d98 -- one pass; true when the camera moved. */
function cameraPass(c, p) {
  const x = passX(c, p);
  const y = passY(c, p);
  return x || y;
}

/** $363b -- SCX, then SCY, a pixel towards the camera; streaming. */
export function scrollStep(c, v, io) {
  const stream = (y, x, which) => {
    if (v.da35 === 0x02) return;
    v.d988 = y & 0xffff;
    v.d98a = x & 0xffff;
    io.oracle('tileAddr2');
    io.oracle(which);
  };
  const dx = (c.scx - (c.x & 0xff)) & 0xff;
  if (dx) {
    if (dx & 0x80) {
      if ((c.x & 0x0f) === 0x01) stream(c.y, c.x + 0xa0, 'streamCol');
      c.scx = (c.scx + 1) & 0xff;
    } else {
      if ((c.x & 0x0f) === 0x0f) stream(c.y, c.x - 0x0f, 'streamCol');
      c.scx = (c.scx - 1) & 0xff;
    }
  }
  const dy = (c.scy - (c.y & 0xff)) & 0xff;
  if (!dy) return;
  if (dy & 0x80) {
    if ((c.y & 0x0f) === 0x01) stream(c.y + 0x90, c.x, 'streamRow');
    c.scy = (c.scy + 1) & 0xff;
  } else {
    if ((c.y & 0x0f) === 0x0f) stream(c.y - 0x0f, c.x, 'streamRow');
    c.scy = (c.scy - 1) & 0xff;
  }
}

/** $3621 */
export function updateCamera(c, p, v, io) {
  for (;;) {
    v.d98e = 0;
    if (!cameraPass(c, p)) return;
    v.d98e = 1;
    scrollStep(c, v, io);
  }
}

/** $35ad -- the flying levels' camera Y: Y-only passes (01:4d9b). */
export function updateCameraY(c, p, v, io) {
  for (;;) {
    v.d98e = 0;
    if (!passY(c, p)) return;
    v.d98e = 1;
    scrollStep(c, v, io);
  }
}

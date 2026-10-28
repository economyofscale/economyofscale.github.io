/**
 * Sprites: object animation and drawing, ported from the game.
 *
 * Objects are $20-byte records from $c300 (41 slots; $c300 is the player,
 * $c320 the mount while riding). Here an object is a Uint8Array view of its
 * record, indexed by offset, so the layout reads across from the disassembly:
 *
 *   +0  flags (0 = unused, bit 7 = hidden)    +6/+7  metasprite pointer
 *   +1  attributes; bits 0-2 = ROM bank       +8     animation frame
 *   +2  screen X   +3 screen Y (OAM space)    +9     animation length
 *   +4  width in cells (collision box too)    +a/+b  animation table
 *   +5  height in cells                       +c..+f world X, Y
 *
 * A metasprite is: graphics set (index into the word table at $047f),
 * columns, rows, X offset, Y offset, then one byte per cell. A nonzero cell n
 * draws the 16 bytes at set base + n * 16 -- raw 2bpp in ROM. The game copies
 * them into a rotating sprite tile slot ($d993) and points an OAM entry at it.
 * Some sets live in RAM: set 27's base is $dac1, where the level's setup
 * ($0c3c) unpacks its enemies' graphics -- drawObject's `ram` reads those.
 */

const GRAPHICS_SETS = 0x047f;

const word = (o, i) => o[i] | (o[i + 1] << 8);

/** $10d7, for any object: start an animation. */
export function setAnimation(o, table, length) {
  o[0x09] = length;
  o[0x0a] = table & 0xff;
  o[0x0b] = table >> 8;
  o[0x08] = 0;
}

/**
 * $04c3 -- step the frame, wrapping at the length, and fetch the metasprite
 * pointer for it. Each table entry is a word and holds for two frames.
 */
export function advanceAnimation(o, rom) {
  const bank = o[0x01] & 7;
  let frame = (o[0x08] + 1) & 0xff;
  if (frame === o[0x09]) frame = 0;
  o[0x08] = frame;
  const at = word(o, 0x0a) + (frame & 0x7e);
  o[0x06] = rom.byte(bank, at);
  o[0x07] = rom.byte(bank, at + 1);
}

/**
 * 01:5427 -- the player's screen position from world position and camera,
 * and while riding the mount object's. p is the player state (physics.js),
 * rider and mount the $c300 and $c320 records.
 */
export function playerScreenPosition(p, rider, mount, cam, rom) {
  let x = p.x;
  if (p.state === 0x06) x = (((x + 8) & 0xe0) + 8) & 0xffff;
  rider[0x02] = (x - cam.x + 8) & 0xff;
  const dy = (p.y - cam.y) & 0xffff;
  rider[0x03] = ((dy & 0xff) - ((rider[0x05] * 8) & 0xff) + 0x13) & 0xff;
  if (!p.ff8f) {
    // $54d2: on foot, a per-frame X offset while $ff8d is set.
    if (!p.ff8d) return;
    const i = ((p.da24 * 2) & 0xff) + (rider[0x01] & 0x20 ? 1 : 0);
    rider[0x02] = (rider[0x02] + rom.byte(0, 0x0a58 + i)) & 0xff;
    return;
  }
  if (p.ff8b !== 1) return;
  if ((mount[0x00] & 0x7f) !== 1) return;
  if (p.da34) return;
  mount[0x01] = rider[0x01];
  mount[0x02] = rider[0x02];
  mount[0x03] = (rider[0x03] + 8) & 0xff;
  const lifted = (rider[0x03] + 8 - 0x18) & 0xff;
  rider[0x03] = lifted;
  if (p.state === 0x03) rider[0x03] = (rider[0x03] + 5) & 0xff;
  else if (p.state === 0x02 && !(p.tick & 0x04)) rider[0x03] = (rider[0x03] + 1) & 0xff;
  if (!p.ff8d) return;
  mount[0x03] = (lifted + 0x28) & 0xff;
  if (rider[0x01] & 0x20) rider[0x02] = (rider[0x02] - 16) & 0xff;
}

/**
 * $0ffb..$107f, the riding branch -- runs each step while $ff8b = 1 and
 * mounted: the mount follows the player, the rider holds the riding pose,
 * and the mount stands, runs or crouches. Sets $ff8f to 1 or 2 on the way,
 * which is where those two values come from.
 */
export function mountUpdate(p, rider, mount, rom) {
  if (p.ff8b !== 1) return;                    // the caller's test, $06c2
  if ((mount[0x00] & 0x7f) !== 1) return;      // no mount object
  if (!p.ff8f) {
    // $106f: the mount without its rider.
    mount[0x05] = 5;
    setAnimation(mount, 0x7b46, 2);
    return;
  }
  if (p.da34) return;
  mount[0x0c] = p.x & 0xff; mount[0x0d] = p.x >> 8;
  mount[0x0e] = p.y & 0xff; mount[0x0f] = p.y >> 8;
  if (!p.ff8d && !p.da26) {
    rider[0x04] = 5;
    setAnimation(rider, 0x7b5c, 2);
    advanceAnimation(rider, rom);
  }
  mount[0x05] = 2;
  if (p.state === 0x03) {
    p.ff8f = 1;
    setAnimation(mount, 0x7b5a, 2);
  } else if (!(p.joy & 0x03)) {
    p.ff8f = 1;
    setAnimation(mount, 0x7b48, 2);
  } else if (p.ff8f !== 2) {
    p.ff8f = 2;
    setAnimation(mount, 0x7b4a, 0x10);
  }
}

/**
 * $030c DrawObject. Appends OAM entries to `oam` (an array of
 * {y, x, tile, flags}) and writes each cell's tile into `tiles` (sprite tile
 * slot -> 16 bytes of 2bpp), starting at slot `next.slot`; advances it as the
 * game advances $d993. Returns false when OAM is full, as the game stops.
 */
export function drawObject(o, rom, oam, tiles, next, ram = null) {
  const attr = o[0x01];
  const bank = attr & 7;
  let ms = word(o, 0x06);
  const set = rom.byte(bank, ms++);
  const base = rom.word(0, GRAPHICS_SETS + set * 2);
  const columns = rom.byte(bank, ms++);
  const rows = rom.byte(bank, ms++);
  const xOff = rom.byte(bank, ms);
  let baseX = (o[0x02] + xOff) & 0xff;
  ms++;
  const baseY = (o[0x03] + rom.byte(bank, ms++)) & 0xff;
  const flipX = !!(attr & 0x20), flipY = !!(attr & 0x40);
  let dy = flipY ? (((rows - 1) * 8) & 0xff) : 0;
  const firstX = flipX ? (((o[0x04] - 1) * 8) & 0xff) : 0;
  if (flipX) baseX = (baseX - 2 * xOff) & 0xff;

  let dx = firstX;
  for (let r = rows; r > 0; r = (r - 1) & 0xff) {
    // $037e: rows whose top is off screen are skipped whole.
    if ((((baseY + dy - 0x0a) & 0xff) & 0xc0) === 0xc0) {
      ms += columns;
    } else {
      for (let c = columns; c > 0; c--) {
        const cell = rom.byte(bank, ms++);
        if (cell) {
          const src = (base + cell * 16) & 0xffff;
          const slot = next.slot;
          // $03b9: the source steps with `inc c` -- within its 256-byte page.
          const at = (i) => (src & 0xff00) | ((src + i) & 0xff);
          tiles[slot] = Uint8Array.from({ length: 16 }, (_, i) => (src >= 0x8000 && ram
            ? ram(at(i)) : rom.byte(bank, at(i))));
          next.slot = (slot + 1) & 0xff;
          oam.push({ y: (baseY + dy) & 0xff, x: (baseX + dx) & 0xff, tile: slot, flags: attr });
          if (oam.length === 40) return false;
        }
        dx = flipX ? (dx - 8) & 0xff : (dx + 8) & 0xff;
      }
    }
    dx = firstX;
    dy = flipY ? (dy - 8) & 0xff : (dy + 8) & 0xff;
  }
  return true;
}

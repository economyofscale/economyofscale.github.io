/**
 * The status bar, ported from the game: the first row of the window map
 * ($9c00), shown from line $87 (WY), sprites off below it ($0292).
 *
 *   RestoreView  $0bcc  the heart ($f6) at column 0, $f7 at column 6;
 *                       the bar's tiles $ea..$ff from 02:$7edb
 *   UpdateHUD    01:5c90  ($1144, on hits and pickups) health in four
 *                       tiles from column 1 -- the tauntaun's while riding;
 *                       on foot the Force meter from column 7; flying the
 *                       counter $da3a in two digits from column 7, after
 *                       an "H" ($eb) at column 6 (none on level 2; nothing
 *                       at all on level 9)
 *   BossBar      01:5c54  (each step) while $da32 holds a boss's hit
 *                       points, $f6 and a bar from column 12; cleared after
 *
 * Bars ($5cb0): 8 units a tile -- 0 empty, $f8..$fe partly full, $ff full.
 * `s` holds the variables by address (da93, da94, da95, da35, da3a,
 * da32, da33, ff8f).
 */

import { decompress, decodeTiles } from './assets.js';
import { uploadTiles } from './ppu.js';

export const HUD_TILES = { bank: 2, addr: 0x7edb, vram: 0x8ea0 };
export const HUD_LINE = 0x87;

/** $0be8: the bar's tiles into VRAM. */
export function loadHudTiles(rom, video) {
  const { data } = decompress(rom, HUD_TILES.bank, HUD_TILES.addr, HUD_TILES.vram);
  uploadTiles(video, HUD_TILES.vram, decodeTiles(data));
}

/** $5cb0 -- a four-tile bar of `value` at column `at`. Returns C: what is left of it. */
function bar(map, at, value) {
  let c = value & 0xff;
  for (let i = 0; i < 4; i++) {
    let d;
    if (!c) d = 0;
    else if (c < 8) { d = (c + 0xf7) & 0xff; c = 0; } else { c -= 8; d = 0xff; }
    map[at + i] = d;
  }
  return c;
}

/** $0bcc..$0be0 */
export function hudInit(map) {
  map[0] = 0xf6;
  map[6] = 0xf7;
}

/**
 * 01:5c90 -- returns register C as it is left: what the last bar had over
 * its 32 units, or the tens tile. The collision scan's caller can read it
 * after a trigger tile (collision.js).
 */
export function hudUpdate(map, s) {
  const c = bar(map, 1, s.ff8f ? s.da94 : s.da93);
  if (!s.da35) return bar(map, 7, s.da95);
  if (s.da35 === 0x09) return c;
  map[6] = s.da35 === 0x02 ? 0x00 : 0xeb;
  // $5cef: tens by subtraction, at most three, then the units.
  let a = s.da3a, tens = 0;
  for (let i = 0; i < 3 && a >= 10; i++) { a -= 10; tens++; }
  map[7] = (tens + 0xec) & 0xff;
  map[8] = (a + 0xec) & 0xff;
  return map[7];
}

/** 01:5c54 */
export function bossBar(map, s) {
  if (s.da32) {
    const b = ((s.da32 >> 3) + 1) & 0xff;
    map[12] = 0xf6;
    s.da33 = b;
    bar(map, 13, b);
    return;
  }
  if (!s.da33) return;
  s.da33 = 0;
  for (let i = 12; i < 17; i++) map[i] = 0;
}

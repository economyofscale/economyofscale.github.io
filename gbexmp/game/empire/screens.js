/**
 * The game's full-screen pictures between play: dialogs and story screens,
 * drawn from the ROM the way the game draws them.
 *
 *   dialog $2566  a framed portrait (03:$6f51, by A & $3f) and a framed
 *                 text below; the lives digit ($da89 + '1') is written
 *                 into the script at $d1bc first -- the continue prompt
 *                 shows it
 *   story  $25dc  one frame round the whole screen, with text
 *   text   $007a  a stream: $00 col row moves the cursor, other bytes are
 *                 characters (tile = char & $7f + $a5); bit 7 ends it
 *   box    $09f2  tiles $bf..$c4 round a w x h inside
 *   fades  $15ae  three BGP values, 8 frames apart: in $3f66, out $3f7b
 *
 * Texts live in the script, unpacked at $ca20; the prompt's letters in
 * bank 0. Not reproduced: the music each screen starts.
 */

import { fontBlock, readImages, loadImage, charToTile } from './assets.js';
import { createVideo, createRegisters, uploadTiles } from './ppu.js';

const SCRIPT_AT = 0xca20;
const PORTRAITS = { bank: 3, table: 0x6f51, count: 6, w: 6, h: 6 };
export const FADE_IN = 0x3f66;
export const FADE_OUT = 0x3f7b;

/**
 * A byte of text: the script for RAM addresses; for ROM ones, `bank`
 * (whichever bank the game had switched in -- 0 below $4000).
 */
const textByte = (rom, script, ptr, bank) => (ptr >= SCRIPT_AT ? script[ptr - SCRIPT_AT] ?? 0
  : rom.byte(ptr < 0x4000 ? 0 : bank, ptr));

/**
 * $007a -- draw a text stream into a BG map, from the cursor `at` ($d999).
 * Returns the address of the stream's last byte.
 */
export function drawStream(map, rom, script, ptr, bank = 0, at = 0x9800) {
  let addr = at;
  for (let i = ptr, n = 0; n < 1024; i++, n++) {
    const c = textByte(rom, script, i, bank);
    if (c === 0) {
      const col = textByte(rom, script, i + 1, bank), row = textByte(rom, script, i + 2, bank);
      const off = ((row * 8) & 0xff) * 4;
      addr = (((0x98 + (off >> 8)) << 8) | (((off & 0xff) + col) & 0xff)) & 0xffff;
      i += 2;
      continue;
    }
    map[(addr - 0x9800) & 0x3ff] = charToTile(c);
    // $00a4 steps only the low byte of the cursor.
    addr = (addr & 0xff00) | ((addr + 1) & 0xff);
    if (c & 0x80) return i;
  }
  return ptr;
}

/** $09f2 -- a frame whose inside is w x h, top left corner at VRAM `at`. */
export function drawBox(map, at, w, h) {
  const put = (a, t) => { map[(a - 0x9800) & 0x3ff] = t; };
  put(at, 0xbf);
  for (let i = 1; i <= w; i++) put(at + i, 0xc0);
  put(at + w + 1, 0xc1);
  let a = at + w + 1;
  for (let r = 0; r < h; r++) { a += 32; put(a, 0xc2); }
  put(a + 32, 0xc4);
  a = at;
  for (let r = 0; r < h; r++) { a += 32; put(a, 0xc2); }
  a += 32;
  put(a, 0xc3);
  for (let i = 1; i <= w; i++) put(a + i, 0xc0);
}

/**
 * A blank screen with the font loaded, as $330d leaves it: every caller
 * passes A = $a0, so it ends in $15fc -- tile $9000 blanked, the BG map
 * filled with tile 0 (which a dialog's portrait then loads over).
 */
function blankScreen(rom) {
  const video = createVideo();
  const fb = fontBlock(rom);
  uploadTiles(video, fb.vramBase, fb.pixels);
  video.tiles.fill(0, 0x100 * 64, 0x101 * 64);
  video.bgMap.fill(0);
  video.oam = [];
  const regs = createRegisters();
  regs.LCDC = 0x81;
  regs.BGP = 0xff;
  regs.WY = 0xa0;
  return { video, regs };
}

/** $2566 -- a dialog: portrait A & $3f, text at `ptr`, lives `da89`. */
export function dialogScreen(rom, script, a, ptr, da89) {
  const sc = blankScreen(rom);
  const text = Uint8Array.from(script);
  text[0xd1bc - SCRIPT_AT] = (da89 + 0x31) & 0xff;
  const map = sc.video.bgMap;
  drawBox(map, 0x9826, 6, 6);
  const img = loadImage(rom, readImages(rom, PORTRAITS)[(a & 0x3f) % PORTRAITS.count]);
  uploadTiles(sc.video, 0x9000, img.pixels);
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) map[(2 + r) * 32 + 7 + c] = img.map[r * 6 + c];
  drawBox(map, 0x9940, 0x12, 6);
  drawStream(map, rom, text, ptr);
  return { ...sc, text };
}

/** $25dc -- a story screen: text in one frame round the screen. */
export function storyScreen(rom, script, ptr, bank = 0) {
  const sc = blankScreen(rom);
  drawBox(sc.video.bgMap, 0x9800, 0x12, 0x10);
  drawStream(sc.video.bgMap, rom, script, ptr, bank);
  return sc;
}

/**
 * The BGP of a fade `f` frames in ($15ae): `from` until the first step,
 * then the table's three values, 8 frames apart; done after 24.
 */
export const fadeAt = (rom, table, f, from) => (f < 8 ? from : rom.byte(0, table + Math.min(2, (f >> 3) - 1)));

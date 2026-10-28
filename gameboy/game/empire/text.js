/**
 * Text layer, reproducing the game's own rules.
 *
 * The whole subsystem was recovered in Phase 1 and is small enough to state
 * completely: strings are ASCII, a character with bit 7 set is the last one,
 * and the tile for a character is (char & $7f) + $a5. There is no custom
 * character map anywhere in the game.
 */

import { charToTile } from './assets.js';
import { MAP } from './rom.js';

const MAP_W = 32;

/**
 * Write a string into a background map, exactly as PrintChar would: one tile
 * per character, advancing a cursor. Characters outside the font's range are
 * skipped rather than drawn as the wrong glyph.
 *
 * @param {Uint8Array} map background map to write into
 * @param {number} col column 0..31
 * @param {number} row row 0..31
 */
export function drawText(map, text, col, row) {
  let x = col;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < MAP.font.firstChar || code > MAP.font.lastChar) {
      x++;
      continue;
    }
    if (x >= MAP_W) break;
    map[(row & 31) * MAP_W + (x & 31)] = charToTile(code);
    x++;
  }
  return x - col;
}

/** Clear a rectangle of map to the font's blank tile (space). */
export function clearText(map, col, row, w, h) {
  const blank = charToTile(0x20);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      map[((row + r) & 31) * MAP_W + ((col + c) & 31)] = blank;
    }
  }
}

/**
 * Break text into lines that fit a given width, on word boundaries.
 * The game does its own layout from the script's embedded metadata; this is
 * for the engine's own UI, not for reproducing the game's text placement.
 */
export function wrap(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line.length) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line.length) lines.push(line);
  return lines;
}

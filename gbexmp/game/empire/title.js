/**
 * The title sequence, ported from the game: $04eb TitleScreen, which
 * NewGame ($01ae) runs before every new game.
 *
 *   1. "A LONG TIME AGO, IN A GALAXY FAR, FAR AWAY..." (script $d1ca)
 *   2. the crawl ($058e): $20 lines of 20 characters from $d1fe, written
 *      into the BG map two rows apart while SCY climbs a pixel every two
 *      game frames; a new line every 16 pixels, blank ones ($d226) once
 *      they run out; over after $2a lines' worth
 *   3. the logo: a 14 x 8 map from 04:$7e40 at $98a3, its 78 tiles from
 *      05:$7d7d at $9000
 *
 * Each fades in and out ($15ae: three BGP steps, 8 VBlanks apart). The
 * first and last hold for 90 game frames ($0539); any key cuts a hold or
 * the crawl short (the crawl looks every 16 pixels). The ending ($2244)
 * runs the same crawl with its own text: `crawlSequence`.
 *
 * Both are generators: they yield once per VBlank with the screen as it
 * then stands ({ video, regs }), so Play can show them frame by frame and
 * the parity test can compare them with the game. Timing: a game frame
 * ($044d) ends two VBlanks after the last one did, or at the next VBlank if
 * that time has passed; the game itself also wakes on other interrupts and
 * draws over several VBlanks, which this does not model. Music goes to
 * `from.sound` when there is one.
 *
 * Also here, as it is a screen of the same kind: the START screen ($07e1,
 * `forceSequence`), where the Force powers are chosen.
 */

import { fontBlock, decompress, decodeTiles, readImages, loadImage } from './assets.js';
import { createVideo, createRegisters, uploadTiles } from './ppu.js';
import { drawStream, drawBox, FADE_IN, FADE_OUT } from './screens.js';

/** $15fc -- tile $9000 blanked, the BG map filled with tile 0. */
function clearScreen(video) {
  video.tiles.fill(0, 0x100 * 64, 0x101 * 64);
  video.bgMap.fill(0);
}

/**
 * A screen and the game's ways of waiting on it. `from.tiles`: the tile
 * data ($8800..$97ff, decoded) the sequence starts with; none: the font.
 * `from.video` and `from.regs`: a whole screen to start from instead (the
 * ending begins on the level).
 */
function runner(rom, joy, from) {
  const video = createVideo();
  if (from.video) {
    video.tiles.set(from.video.tiles);
    video.bgMap.set(from.video.bgMap);
    video.windowMap.set(from.video.windowMap);
    video.oam = from.video.oam ? [...from.video.oam] : [];
  } else if (from.tiles) {
    video.tiles.set(from.tiles.subarray(0, 0x100 * 64), 0x80 * 64);
  } else {
    const fb = fontBlock(rom);
    uploadTiles(video, fb.vramBase, fb.pixels);
  }
  const regs = createRegisters();
  if (from.regs) {
    Object.assign(regs, from.regs);
  } else {
    regs.LCDC = 0x81;
    regs.BGP = from.bgp ?? 0xff;
    regs.SCY = from.scy ?? 0;
    regs.WY = 0xa0;
  }
  const sc = { video, regs, waiting: false };
  const t = { vb: 0, da90: -2 };
  const r = {
    sc, video, regs, joy,
    // 07:$638f, when a sound is attached (`from.sound`).
    music(a) { from.sound?.music(a); },
    *vblank() { t.vb++; yield sc; },
    // $044d: halts until two VBlanks since it last returned. After play
    // (`from.statWake`) LYC is still 135, the status bar's split: a wait
    // with nothing left to wait for returns at that line's STAT interrupt,
    // before the next VBlank -- after power-on (LYC 0) only after it.
    *frame() {
      const n = Math.max(from.statWake ? 0 : 1, t.da90 + 2 - t.vb);
      for (let i = 0; i < n; i++) yield* r.vblank();
      t.da90 = t.vb;
    },
    // $15ae
    *fade(table) {
      for (let k = 0; k < 3; k++) {
        for (let i = 0; i < 8; i++) yield* r.vblank();
        regs.BGP = rom.byte(0, table + k);
      }
    },
    // $0539: 90 game frames, or until a key.
    *hold() {
      for (let b = 0x5a; b > 0; b--) {
        yield* r.frame();
        if (joy()) return;
      }
    },
  };
  return r;
}

/** $330d -- scroll 0, LCDC $81, a frame, the font, a clear screen. */
function* screenSetup(r, rom) {
  const { video, regs } = r;
  regs.SCX = 0;
  regs.SCY = 0;
  regs.LCDC = 0x81;
  yield* r.frame();
  const fb = fontBlock(rom);
  uploadTiles(video, fb.vramBase, fb.pixels);
  clearScreen(video);
}

/** $058e -- the crawl, `lines` lines of text from `ptr`. */
function* crawl(r, rom, script, joy, lines, ptr) {
  const { video, regs } = r;
  let timer = (lines + 0x0a) & 0xff, row = 0x0240, scy = 0;
  yield* screenSetup(r, rom);
  yield* r.fade(FADE_IN);
  for (;;) {
    if (!(scy & 0x0f)) {
      timer = (timer - 1) & 0xff;
      if (!timer || joy()) break;
      const at = 0x9800 + row;
      if (lines) {
        lines--;
        ptr = drawStream(video.bgMap, rom, script, ptr, 0, at) + 1;
      } else {
        drawStream(video.bgMap, rom, script, 0xd226, 0, at);
      }
      row = (row + 0x40) & 0x3ff;
    }
    yield* r.frame();
    yield* r.frame();
    scy = (scy + 1) & 0xff;
    regs.SCY = scy;
  }
  yield* r.fade(FADE_OUT);
}

/**
 * @param {() => number} joy the joypad as $1623 reads it (0: nothing held)
 * @param {{ scy?: number, bgp?: number, tiles?: Uint8Array }} from the
 *   screen the title follows. Screen 1 draws with whatever font is in VRAM
 *   (the game reloads it only for the crawl): `tiles` is that tile data
 *   ($8800..$97ff, decoded); without it the font is loaded fresh.
 */
export function* titleSequence(rom, script, joy, from = {}) {
  yield* title(runner(rom, joy, from), rom, script, joy);
}

/** $04eb */
function* title(r, rom, script, joy) {
  const { video, regs } = r;
  // $04ef: the title music.
  r.music(0x00);

  // 1. $04f2..$0504
  clearScreen(video);
  drawStream(video.bgMap, rom, script, 0xd1ca);
  yield* r.fade(FADE_IN);
  yield* r.hold();
  yield* r.fade(FADE_OUT);

  // 2. $0507: $058e with HL = $d1fe, A = $20
  yield* crawl(r, rom, script, joy, 0x20, 0xd1fe);

  // 3. $050f..$0536
  clearScreen(video);
  regs.SCY = 0;
  for (let row = 0; row < 8; row++) {
    for (let c = 0; c < 0x0e; c++) video.bgMap[0xa3 + row * 32 + c] = rom.byte(4, 0x7e40 + row * 0x0e + c);
  }
  uploadTiles(video, 0x9000, decodeTiles(decompress(rom, 5, 0x7d7d, 0x9000).data));
  yield* r.fade(FADE_IN);
  yield* r.hold();
  yield* r.fade(FADE_OUT);
}

/** $058e on its own: the ending's crawl ($2283: $1e lines from $d47e). */
export function* crawlSequence(rom, script, joy, lines, ptr, from = {}) {
  yield* crawl(runner(rom, joy, from), rom, script, joy, lines, ptr);
}

const PORTRAITS = { bank: 3, table: 0x6f51, count: 0x40, w: 6, h: 6 };

/**
 * $2546 -- a dialog after play: the screen fades out with the level's own
 * table ($da29, `fadeOut`), then $2566: WY $a0, $330d, the lives digit
 * into the script ($d1bc), a frame round the portrait (A & $3f, 03:$6f51:
 * map at $9847, tiles at $9000), a frame round the text, the text (`bank`
 * for text in ROM), the fade in. Unless A bit 6: wait for any key ($164e,
 * no frame waits -- `sc.waiting` says so), the fade out.
 */
function* dialog(r, rom, script, { a, ptr, bank = 0, da89 = 0, fadeOut }) {
  const { video, regs, sc } = r;
  yield* r.fade(fadeOut);
  regs.WY = 0xa0;
  yield* screenSetup(r, rom);
  // $2579: the dialog's music. (The level's comes back at the end only
  // without A bits 6 and 7, $25d0; the ending's dialogs have bit 7.)
  r.music(0x04);
  const text = Uint8Array.from(script);
  text[0xd1bc - 0xca20] = (da89 + 0x31) & 0xff;
  const map = video.bgMap;
  drawBox(map, 0x9826, 6, 6);
  const img = loadImage(rom, readImages(rom, PORTRAITS)[a & 0x3f]);
  uploadTiles(video, 0x9000, img.pixels);
  for (let row = 0; row < 6; row++) for (let c = 0; c < 6; c++) map[0x47 + row * 32 + c] = img.map[row * 6 + c];
  drawBox(map, 0x9940, 0x12, 6);
  drawStream(map, rom, text, ptr, bank);
  yield* r.fade(FADE_IN);
  if (a & 0x40) return;
  sc.waiting = true;
  while (!r.joy()) yield* r.vblank();
  sc.waiting = false;
  yield* r.fade(FADE_OUT);
}

/**
 * $226f..$228e -- the ending's screens, after Vader's 128 frames: dialog
 * $84 ($cd80), the crawl ($1e lines from $d47e), dialog $85 (07:$6326).
 * `from`: the level's screen ({ video, regs }); `fadeOut`: its fade-out
 * table ($da29); `da89`: lives.
 */
export function* endingSequence(rom, script, joy, { from, fadeOut, da89, sound }) {
  const r = runner(rom, joy, { ...from, sound });
  yield* dialog(r, rom, script, { a: 0x84, ptr: 0xcd80, da89, fadeOut });
  // $227b: the title music for the crawl.
  r.music(0x00);
  yield* crawl(r, rom, script, joy, 0x1e, 0xd47e);
  yield* dialog(r, rom, script, { a: 0x85, ptr: 0x6326, bank: 7, da89, fadeOut });
}

/**
 * The boot's busy-wait ($0561: D x 60,000 turns of a 28-cycle loop). It
 * counts CPU time, not frames: measured, a unit lasts 25.8 VBlanks (10
 * units 258, 5 units 129) -- the loop's 23.9 frames of cycles plus what
 * the interrupts take.
 */
function* busyWait(r, units) {
  for (let i = Math.round(units * 25.8); i > 0; i--) yield* r.vblank();
}

/**
 * Power-on: $0555, two text screens ($61ce, then $62de; bank 7, as $330d
 * leaves it), each faded in, held by a busy-wait and faded out; then
 * NewGame's title on the same screen -- its first page draws with the
 * font the boot loaded.
 */
export function* bootSequence(rom, script, joy, sound = null) {
  const r = runner(rom, joy, { tiles: new Uint8Array(0x100 * 64), sound });
  const { video } = r;
  yield* screenSetup(r, rom);
  drawStream(video.bgMap, rom, script, 0x61ce, 7);
  yield* r.fade(FADE_IN);
  yield* busyWait(r, 10);
  yield* r.fade(FADE_OUT);
  clearScreen(video);
  drawStream(video.bgMap, rom, script, 0x62de, 7);
  yield* r.fade(FADE_IN);
  yield* busyWait(r, 5);
  yield* r.fade(FADE_OUT);
  yield* title(r, rom, script, joy);
}

/** 07:$599c: per power, its icon's first tile and its place in the BG map. */
const POWER_ICONS = 0x599c;

/**
 * $07e1..$081d -- START on foot: the Force powers. The level fades out
 * ($da29, `fadeOut`), then a screen of its own ($084c): tiles 04:$4e10
 * at $9000, a frame at $9860, music 2, the text at $ca20, and a 2 x 2
 * icon for each power owned ($da96..$da9d, 07:$599c); none: the text at
 * $ca35 too, and any key closes it. Else the choice ($08c2): a cursor
 * frame round the power ($0983); then each key, once released and
 * pressed again ($165b, $164e), plays sound 9 and acts -- LEFT/RIGHT the
 * previous/next power owned, UP/DOWN four on (the other row), A or B
 * chooses ($da2b = power + 1; the eighth heals: the meter $da95 into
 * health, $0fbf), START or SELECT none ($da2b = 0). The UP power ends
 * ($da43 = 0); a choice of power 2 while $da1a ends it there too
 * ($1d7a). Then the fade out and sound 4. RestoreView ($0b43) is the
 * caller's.
 *
 * `state`: { owned[8], da2b, da95, da93, da94, ff8f, da43, da1a, c304,
 * c305 }, changed in place. `sc.waiting` says which key wait the screen
 * is in: 'release', 'press' (or null).
 */
export function* forceSequence(rom, script, joy, { from, fadeOut, state, sound, hud }) {
  const r = runner(rom, joy, { ...from, sound });
  const { video, regs, sc } = r;
  const map = video.bgMap;
  const put = (addr, t) => { map[(addr - 0x9800) & 0x3ff] = t; };
  yield* r.fade(fadeOut);
  regs.WY = 0xa0;
  yield* screenSetup(r, rom);
  // $084c
  uploadTiles(video, 0x9000, decodeTiles(Uint8Array.from({ length: 0x2a0 }, (_, i) => rom.byte(4, 0x4e10 + i))));
  drawBox(map, 0x9860, 0x12, 0x0a);
  r.music(0x02);
  drawStream(map, rom, script, 0xca20);
  const icon = (i) => ({ tile: rom.byte(7, POWER_ICONS + i * 4), at: rom.word(7, POWER_ICONS + i * 4 + 2) });
  let any = false;
  for (let i = 0; i < 8; i++) {
    if (!state.owned[i]) continue;
    any = true;
    const { tile, at } = icon(i);
    put(at, tile); put(at + 1, tile + 1);
    put(at + 0x20, tile + 2); put(at + 0x21, tile + 3);
  }
  if (!any) drawStream(map, rom, script, 0xca35);
  yield* r.fade(FADE_IN);

  const waitRelease = function* () {
    sc.waiting = 'release';
    while (r.joy()) yield* r.vblank();
    sc.waiting = null;
  };
  const waitPress = function* () {
    sc.waiting = 'press';
    while (!r.joy()) yield* r.vblank();
    const k = r.joy();
    sc.waiting = null;
    return k;
  };

  if (!any) {
    // $083e: any key.
    yield* waitPress();
  } else {
    // $08c2
    state.da43 = 0;
    const owned = (c) => state.owned[c & 7];
    const step = (c, d) => { do c = (c + d) & 7; while (!owned(c)); return c; };
    let c = step(((state.da2b ? state.da2b - 1 : 0) - 1) & 7, 1);
    let cursor = 0x98c2;
    for (;;) {
      // $0983: the old frame cleared, a new one round icon C.
      for (let i = 0; i < 4; i++) put(cursor + i, 0);
      for (const row of [0x20, 0x40]) { put(cursor + row, 0); put(cursor + row + 3, 0); }
      for (let i = 0; i < 4; i++) put(cursor + 0x60 + i, 0);
      cursor = (icon(c).at - 0x21) & 0xffff;
      drawBox(map, cursor, 2, 2);
      sc.cursor = c;
      yield* waitRelease();
      const k = yield* waitPress();
      sound?.effect(0x09);
      if (k & 0xc0) { state.da2b = 0; break; }
      if (k & 0x02) c = step(c, -1);
      if (k & 0x01) c = step(c, 1);
      if (k & 0x0c) c = step(c, 4);
      if (!(k & 0x30)) continue;
      if (c + 1 !== 8) { state.da2b = c + 1; break; }
      // $093b: the eighth heals.
      if (state.da95) heal(state, state.da95);
      state.da95 = 0;
      hud?.();
      state.da2b = 0;
      break;
    }
    // $080f
    if (state.da2b === 2 && state.da1a) {
      state.c304 = 0x03; state.c305 = 0x04; state.da43 = 0; state.da2b = 0;
    }
  }
  yield* r.fade(FADE_OUT);
  sound?.effect(0x04);
}

/** $0fbf -- up to `n` health ($da94 when riding), to $20 at most. */
function heal(state, n) {
  const k = state.ff8f ? 'da94' : 'da93';
  let v = state[k];
  if (v !== 0x20) {
    do { v++; } while (v !== 0x20 && --n);
  }
  state[k] = v;
}

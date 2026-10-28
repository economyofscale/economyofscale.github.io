/**
 * Asset extraction: runs the game's own decompressor over a user-supplied ROM.
 *
 * Everything here returns plain byte arrays and small descriptor objects. No
 * game data is baked into the source; it is all read out of the ROM at load
 * time, which is what makes the engine distributable on its own.
 */

import { callRoutine } from './sm83.js';
import { MAP, fileOffset } from './rom.js';

/** Where decompressed output is staged. Any free RAM address works. */
const SCRATCH = 0xc000;

/**
 * Decompress one stream by executing the original routine.
 * @returns {{data: Uint8Array, consumed: number}}
 */
export function decompress(rom, bank, src, dest = SCRATCH) {
  const cpu = callRoutine(rom.bytes, MAP.decompress, { bank, hl: src, de: dest });
  const outLen = (cpu.de - dest) & 0xffff;
  return {
    data: cpu.mem.slice(dest, dest + outLen),
    consumed: (cpu.hl - src) & 0xffff,
  };
}

/** Decode 2bpp planar tile data into one byte per pixel (values 0..3). */
export function decodeTiles(data) {
  const count = Math.floor(data.length / 16);
  const out = new Uint8Array(count * 64);
  for (let t = 0; t < count; t++) {
    for (let y = 0; y < 8; y++) {
      const lo = data[t * 16 + y * 2], hi = data[t * 16 + y * 2 + 1];
      for (let x = 0; x < 8; x++) {
        const bit = 7 - x;
        out[t * 64 + y * 8 + x] = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
      }
    }
  }
  return out;
}

/**
 * Read the scene table. The table is self-terminating: its first entry points
 * at the descriptor block that follows it, so the entry count is derivable
 * rather than guessed. Scanning for an out-of-range pointer reads one entry
 * too many -- descriptor 0's first bytes look like a valid pointer.
 */
export function readScenes(rom) {
  const { bank, addr, recordSize } = MAP.sceneTable;
  const first = rom.word(bank, addr);
  const count = (first - addr) / 2;
  const F = MAP.sceneFields;
  const scenes = [];
  for (let i = 0; i < count; i++) {
    const ptr = rom.word(bank, addr + i * 2);
    const d = rom.slice(bank, ptr, recordSize);
    scenes.push({
      index: i,
      descriptor: ptr,
      params: [d[F.param1], d[F.param2], d[F.param3]],
      cameraX: d[F.cameraBlock] | (d[F.cameraBlock + 1] << 8),
      cameraY: d[F.cameraBlock + 2] | (d[F.cameraBlock + 3] << 8),
      tilePtr: d[F.tilePtr] | (d[F.tilePtr + 1] << 8),
      tileBank: d[F.tileBank],
      sound: d[F.sound],
      subTable: d[F.subTable],
      flag: d[F.flag],
      stream2: d[F.stream2Ptr] | (d[F.stream2Ptr + 1] << 8),
    });
  }
  return scenes;
}

/** A scene's 256-tile set, decompressed and decoded. */
export function sceneTiles(rom, scene) {
  const { data } = decompress(rom, scene.tileBank, scene.tilePtr, 0x8800);
  return { raw: data, pixels: decodeTiles(data), tileCount: data.length / 16 };
}

/**
 * A scene's second stream (descriptor +21), at $c820, if it has one. Only two
 * scenes do. Phase 1 read it as a 32-wide background map because both sizes
 * are multiples of 32; it is in fact 32 (scene 0) and 28 (scene 2) more
 * metatile definitions of 16 bytes, used for map bytes $e0..$ff (see
 * sceneCollision, which is where it belongs). The shape below is kept only
 * because the browser harness still displays it; drawing it as a map is wrong.
 */
export function sceneMap(rom, scene) {
  if (!scene.stream2) return null;
  const { data } = decompress(rom, scene.tileBank, scene.stream2, 0xc820);
  if (data.length % 32 !== 0) {
    return { data, width: data.length, height: 1, irregular: true };
  }
  return { data, width: 32, height: data.length / 32, irregular: false };
}

/** The shared VRAM block: 7 picture tiles, then the font. */
export function fontBlock(rom) {
  const fb = MAP.fontBlock;
  const { data } = decompress(rom, fb.bank, fb.addr, fb.vram);
  const pixels = decodeTiles(data);
  return {
    raw: data,
    pixels,
    tileCount: data.length / 16,
    /** VRAM tile index -> offset into `pixels`, for $8800 signed addressing. */
    vramBase: fb.vram,
    firstTileIndex: 0x80 + (fb.vram - 0x8800) / 16,
  };
}

/**
 * Map a character to its tile index exactly as PrintChar does:
 * strip the terminator flag, then add the bias.
 */
export function charToTile(code) {
  return ((code & 0x7f) + MAP.font.charBias) & 0xff;
}

/**
 * Parse the script into records. Each is `$00 $01 <id>` then ASCII, with
 * bit 7 set on the final character as the terminator.
 */
export function readScript(rom) {
  const { bank, addr, dest } = MAP.script;
  const { data } = decompress(rom, bank, addr, dest);
  const records = [];
  let i = 0;
  while (i < data.length) {
    // Skip the record header bytes; a record starts after $00 $01 <id>.
    if (data[i] === 0x00 && i + 2 < data.length) {
      const id = data[i + 2];
      i += 3;
      const start = i;
      while (i < data.length && !(data[i] & 0x80)) i++;
      if (i < data.length) i++; // include the flagged final character
      records.push({ id, start, end: i, length: i - start });
    } else {
      i++;
    }
  }
  return { data, records };
}

/** Decode one script record to text, clearing the terminator flag. */
export function recordText(script, record) {
  let s = '';
  for (let i = record.start; i < record.end; i++) {
    s += String.fromCharCode(script.data[i] & 0x7f);
  }
  return s;
}

/**
 * Read an indexed-image table. Both subsystems use the same 4-byte record:
 * [raw tilemap pointer, compressed tile stream pointer].
 */
export function readImages(rom, spec) {
  const out = [];
  for (let i = 0; i < spec.count; i++) {
    const a = spec.table + i * 4;
    out.push({
      index: i,
      mapPtr: rom.word(spec.bank, a),
      tilePtr: rom.word(spec.bank, a + 2),
      bank: spec.bank,
      w: spec.w,
      h: spec.h,
    });
  }
  return out;
}

/** Decompress an indexed image's tiles and read its raw tilemap. */
export function loadImage(rom, img) {
  const { data } = decompress(rom, img.bank, img.tilePtr, 0x9000);
  return {
    pixels: decodeTiles(data),
    tileCount: data.length / 16,
    map: rom.slice(img.bank, img.mapPtr, img.w * img.h),
    w: img.w,
    h: img.h,
  };
}

/** The uncompressed 32x16 background map. */
export function rawMap(rom) {
  const m = MAP.rawMap32x16;
  return { data: rom.slice(m.bank, m.addr, m.w * m.h), width: m.w, height: m.h };
}

/**
 * A scene's collision world, read the way the game reads it.
 *
 *  - rows: the metatile map, one Uint8Array per 32 px row. The descriptor's
 *    first three bytes are the row-pointer table (pointers relative to the
 *    table itself) and the row width; rows are run-length coded, as
 *    unpacked by SelectMapRow at $382f: bit 7 set = repeat the next byte
 *    (n & $7f) times, clear = copy the next n bytes.
 *  - metatiles: 16 bytes each (4 x 4 BG tile numbers), the $d9bb stream that
 *    the loader at $0b66 decompresses to $cb40. Map bytes $e0..$ff instead
 *    index metatilesHigh, the descriptor's second stream at $c820: the
 *    lookup's base $ba20 + byte * 16 lands there.
 *  - attrs: one attribute byte per BG tile number, the $d9bd stream at
 *    $ca40, zero-filled to 256 first.
 */
export function sceneCollision(rom, scene) {
  const F = MAP.sceneFields;
  const d = rom.slice(MAP.sceneTable.bank, scene.descriptor, MAP.sceneTable.recordSize);
  const block = d.subarray(F.block8, F.block8 + 8);
  const word = (a, i) => a[i] | (a[i + 1] << 8);
  const bank = scene.tileBank;
  const rowTable = word(d, F.param1);
  const width = d[F.param3];
  const heightPx = word(block, 2);
  const rowCount = heightPx >> 5;

  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    let p = rowTable + rom.word(bank, rowTable + r * 2);
    const row = new Uint8Array(width);
    let out = 0;
    while (out < width) {
      const n = rom.byte(bank, p++);
      if (n & 0x80) {
        const v = rom.byte(bank, p++);
        for (let i = 0; i < (n & 0x7f); i++) row[out++] = v;
      } else {
        for (let i = 0; i < n; i++) row[out++] = rom.byte(bank, p++);
      }
    }
    rows.push(row);
  }

  const stream = (ptr, dest) => (ptr ? decompress(rom, bank, ptr, dest).data : new Uint8Array(0));
  const attrs = new Uint8Array(256);
  attrs.set(stream(word(block, 6), 0xca40).subarray(0, 256));
  return {
    width, heightPx, rows,
    // $d9b7: the X limit CheckMapBoundsX tests against. From the descriptor,
    // not derived from the width (scene 0: 6584, not 206 * 32).
    xLimitPx: word(block, 0),
    // Descriptor +11..+14, copied to $c30c: the player's start position.
    startX: scene.cameraX, startY: scene.cameraY,
    metatiles: stream(word(block, 4), 0xcb40),
    metatilesHigh: stream(scene.stream2, 0xc820),
    attrs,
  };
}

/**
 * ROM container: validation, bank arithmetic, and the asset catalogue.
 *
 * No game data is stored here, only *addresses* -- the offsets discovered in
 * Phase 1. The bytes come from a ROM the user supplies at runtime, which is
 * what keeps this engine distributable without shipping anything copyrighted.
 */

export const BANK_SIZE = 0x4000;

/** Expected dump. A different ROM will mostly work but is not what was mapped. */
export const EXPECTED = {
  title: 'EMPIRE STRIKES',
  size: 131072,
  banks: 8,
  cartType: 0x01,   // MBC1
  md5: '05f7b63c25b4871440968fd4ce25440a',
};

/**
 * ROM file offset for a (bank, cpu address) pair. Addresses below $4000 are
 * always bank 0, whatever bank is switched in -- as on the hardware. MBC1
 * cannot map bank 0 at $4000: selecting it ($3fff = 0) maps bank 1, which
 * the game meets when an object's bank bits (+$01) are 0 ($04c3).
 */
export function fileOffset(bank, addr) {
  if (addr < BANK_SIZE) return addr;
  return (bank || 1) * BANK_SIZE + (addr - BANK_SIZE);
}

export class Rom {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
  }

  byte(bank, addr) { return this.bytes[fileOffset(bank, addr)]; }

  /** Little-endian word at (bank, addr). */
  word(bank, addr) {
    const o = fileOffset(bank, addr);
    return this.bytes[o] | (this.bytes[o + 1] << 8);
  }

  slice(bank, addr, length) {
    const o = fileOffset(bank, addr);
    return this.bytes.subarray(o, o + length);
  }

  get title() {
    let s = '';
    for (let i = 0x134; i < 0x144; i++) {
      const b = this.bytes[i];
      if (b === 0) break;
      s += String.fromCharCode(b);
    }
    return s;
  }

  /**
   * Check the dump looks like what Phase 1 mapped. Returns a list of
   * complaints; empty means it matches. Deliberately returns warnings rather
   * than throwing, so an unexpected-but-plausible ROM can still be tried.
   */
  validate() {
    const problems = [];
    if (this.bytes.length !== EXPECTED.size) {
      problems.push(`expected ${EXPECTED.size} bytes, got ${this.bytes.length}`);
    }
    if (this.title !== EXPECTED.title) {
      problems.push(`header title is "${this.title}", expected "${EXPECTED.title}"`);
    }
    if (this.bytes[0x147] !== EXPECTED.cartType) {
      problems.push(`cartridge type $${this.bytes[0x147].toString(16)}, expected $01 (MBC1)`);
    }
    // Header checksum is cheap and catches a truncated or edited dump.
    let hc = 0;
    for (let i = 0x134; i <= 0x14c; i++) hc = (hc - this.bytes[i] - 1) & 0xff;
    if (hc !== this.bytes[0x14d]) problems.push('header checksum mismatch');
    return problems;
  }
}

/**
 * Addresses recovered in Phase 1. Every entry here was confirmed by a
 * boundary meeting another known boundary -- see docs/notes.md.
 */
export const MAP = {
  /** The asset decompressor. In: HL = source, DE = destination. */
  decompress: 0x34a5,

  /** Scene/level table. 11 entries -> 9 distinct 23-byte descriptors. */
  sceneTable: { bank: 6, addr: 0x7d14, entries: 11, recordSize: 23 },

  /** Descriptor field offsets, from the parse at $0a72..$0ac8. */
  sceneFields: {
    param1: 0, param2: 1, param3: 2,
    block8: 3,        // 8 bytes -> $d9b7, holds two more stream pointers
    cameraBlock: 11,  // 4 bytes -> $c30c: camera origin words
    tilePtr: 15, tileBank: 17,
    sound: 18, subTable: 19, flag: 20,
    stream2Ptr: 21,
  },

  /** Shared VRAM block: 7 picture tiles then 59 font glyphs. */
  fontBlock: { bank: 7, addr: 0x470d, vram: 0x8be0, tiles: 66, fontFirstTile: 7 },

  /** Font mapping, from PrintChar at $00a4: tile = (char & $7f) + $a5. */
  font: { charBias: 0xa5, firstChar: 0x20, lastChar: 0x5a },

  /** The in-game script. */
  script: { bank: 7, addr: 0x59bc, dest: 0xca20 },

  /** Indexed image subsystems. Same 4-byte record in both banks. */
  images: [
    { name: 'bank03', bank: 3, table: 0x6f51, count: 6, w: 6, h: 6, tileDest: 0x9000, mapDest: 0x9847 },
    { name: 'bank01', bank: 1, table: 0x725c, count: 8, w: 9, h: 4, tileDest: 0x89a0, mapDest: 0x98e0 },
  ],

  /** Uncompressed 32x16 tilemap loaded straight to the BG map. */
  rawMap32x16: { bank: 6, addr: 0x7b14, w: 32, h: 16 },
};

/**
 * Scanline renderer reproducing the Game Boy PPU's *observable rules*.
 *
 * This is not an emulator. It does not run the PPU's state machine or count
 * cycles. It reproduces what the hardware puts on screen given the register
 * state, one scanline at a time.
 *
 * Scanline-at-a-time is deliberate rather than incidental. The game populates
 * the LCD STAT interrupt ($0048 -> $0292), which on real hardware fires
 * mid-frame to change registers partway down the screen -- a status bar split
 * or parallax. A whole-frame renderer cannot express that, and retrofitting
 * one is painful, so the per-scanline register hook is built in from the
 * start via `onScanline`.
 */

export const SCREEN_W = 160;
export const SCREEN_H = 144;
const MAP_W = 32;

/** DMG shades, index 0 lightest. Chosen to read well on a white page. */
export const PALETTE_GREY = [0xe8e8e8, 0xa0a0a0, 0x585858, 0x101010];
/** The classic green LCD look, offered as a toggle. */
export const PALETTE_GREEN = [0xe0f8d0, 0x88c070, 0x346856, 0x081820];

/** Expand a packed GB palette register (2 bits per entry) to 4 shade indices. */
export function unpackPalette(reg) {
  return [reg & 3, (reg >> 2) & 3, (reg >> 4) & 3, (reg >> 6) & 3];
}

/**
 * Mutable register state, named as the hardware names them so the
 * disassembly reads across directly.
 */
export function createRegisters() {
  return {
    LCDC: 0x91,  // bit7 on, bit4 unsigned tile data, bit0 BG on
    SCX: 0, SCY: 0,
    WX: 7, WY: 0,
    BGP: 0xe4, OBP0: 0xe4, OBP1: 0xe4,
  };
}

/**
 * Video memory as the renderer needs it, rather than as raw VRAM:
 * a flat tile pixel array plus the two background maps.
 */
export function createVideo() {
  return {
    // 384 tiles x 64 pixels. Index by absolute tile number 0..383.
    tiles: new Uint8Array(384 * 64),
    bgMap: new Uint8Array(MAP_W * MAP_W),
    windowMap: new Uint8Array(MAP_W * MAP_W),
    oam: [], // {y, x, tile, flags}
  };
}

/**
 * Write decoded tile pixels into video memory at a VRAM address.
 * `pixels` is one byte per pixel as produced by decodeTiles.
 */
export function uploadTiles(video, vramAddr, pixels) {
  const firstTile = (vramAddr - 0x8000) / 16;
  const count = pixels.length / 64;
  for (let t = 0; t < count; t++) {
    const dst = (firstTile + t) * 64;
    if (dst + 64 > video.tiles.length) break;
    video.tiles.set(pixels.subarray(t * 64, t * 64 + 64), dst);
  }
}

/** Copy a w*h block of tile indices into a background map, as CopyVramRect does. */
export function blitMap(map, src, destAddr, w, h) {
  const base = (destAddr - 0x9800) & 0x3ff;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const d = (base + row * MAP_W + col) & 0x3ff;
      map[d] = src[row * w + col];
    }
  }
}

/**
 * Resolve a background tile index to its absolute tile number.
 * LCDC bit 4 selects the addressing mode: unsigned from $8000, or signed from
 * $9000 where indices 128..255 live at $8800. Getting this backwards is the
 * classic way to render a screen of garbage, so it is isolated here.
 */
function bgTileNumber(index, unsigned) {
  if (unsigned) return index;
  return index < 128 ? 256 + index : index;
}

/**
 * Render one scanline into an RGB framebuffer.
 * @param {Uint32Array} fb SCREEN_W * SCREEN_H pixels
 */
export function renderScanline(fb, video, regs, ly, palette, windowState = null) {
  const bgp = unpackPalette(regs.BGP);
  const lcdcBgOn = (regs.LCDC & 0x01) !== 0;
  const unsigned = (regs.LCDC & 0x10) !== 0;
  const bgMapSel = (regs.LCDC & 0x08) !== 0 ? video.windowMap : video.bgMap;
  const winEnabled = (regs.LCDC & 0x20) !== 0;
  const winMap = (regs.LCDC & 0x40) !== 0 ? video.windowMap : video.bgMap;
  const rowBase = ly * SCREEN_W;

  // Background. When BG is off the hardware shows shade 0, not garbage.
  for (let x = 0; x < SCREEN_W; x++) {
    let shade = 0;
    if (lcdcBgOn) {
      const bgY = (ly + regs.SCY) & 0xff;
      const bgX = (x + regs.SCX) & 0xff;
      const tile = bgMapSel[(bgY >> 3) * MAP_W + (bgX >> 3)];
      const n = bgTileNumber(tile, unsigned);
      shade = bgp[video.tiles[n * 64 + (bgY & 7) * 8 + (bgX & 7)]];
    }
    fb[rowBase + x] = palette[shade];
  }

  // Window: an opaque layer anchored at WX-7, WY. It does not scroll with SCX.
  //
  // The row it reads is its OWN internal line counter, not `ly - WY`. On
  // hardware that counter advances only on scanlines where the window is
  // actually drawn, so the two diverge as soon as the window is switched off
  // for part of a frame -- which this game does, toggling LCDC between $e1 and
  // $e3 mid-frame. `windowState.line` carries it across scanlines.
  const winX = regs.WX - 7;
  if (winEnabled && ly >= regs.WY && winX < SCREEN_W) {
    const wy = windowState ? windowState.line : ly - regs.WY;
    for (let x = Math.max(0, winX); x < SCREEN_W; x++) {
      const wx = x - winX;
      const tile = winMap[((wy >> 3) & 31) * MAP_W + ((wx >> 3) & 31)];
      const n = bgTileNumber(tile, unsigned);
      fb[rowBase + x] = palette[bgp[video.tiles[n * 64 + (wy & 7) * 8 + (wx & 7)]]];
    }
    if (windowState) windowState.line++;
  }

  // Sprites.
  if ((regs.LCDC & 0x02) !== 0) renderSprites(fb, video, regs, ly, palette, bgp);
}

/**
 * Sprite layer for one scanline, including the hardware's selection rules:
 * at most 10 sprites per line, chosen by OAM order, and drawn so that the
 * lower X wins. That 10-per-line cap is what produces the flicker visible in
 * real games -- it is reproduced rather than silently ignored, because
 * removing it changes how the game looks.
 */
function renderSprites(fb, video, regs, ly, palette, bgp) {
  const tall = (regs.LCDC & 0x04) !== 0;
  const height = tall ? 16 : 8;
  const obp = [unpackPalette(regs.OBP0), unpackPalette(regs.OBP1)];
  const rowBase = ly * SCREEN_W;

  const line = [];
  for (const s of video.oam) {
    const top = s.y - 16;
    if (ly < top || ly >= top + height) continue;
    line.push(s);
    if (line.length === 10) break; // hardware limit, OAM order decides
  }
  // Lower X draws on top; equal X falls back to OAM order. Painting in
  // reverse priority order lets later writes win.
  line.sort((a, b) => (b.x - a.x) || (video.oam.indexOf(b) - video.oam.indexOf(a)));

  for (const s of line) {
    const top = s.y - 16, left = s.x - 8;
    let row = ly - top;
    if (s.flags & 0x40) row = height - 1 - row;      // Y flip
    let tile = tall ? (s.tile & 0xfe) : s.tile;
    if (tall && row >= 8) { tile += 1; row -= 8; }
    const pal = obp[(s.flags & 0x10) ? 1 : 0];
    const behind = (s.flags & 0x80) !== 0;

    for (let px = 0; px < 8; px++) {
      const x = left + px;
      if (x < 0 || x >= SCREEN_W) continue;
      const sx = (s.flags & 0x20) ? 7 - px : px;    // X flip
      const v = video.tiles[tile * 64 + row * 8 + sx];
      if (v === 0) continue;                         // colour 0 is transparent
      // Priority bit: sprite hides behind non-zero background pixels.
      if (behind && fb[rowBase + x] !== palette[bgp[0]]) continue;
      fb[rowBase + x] = palette[pal[v]];
    }
  }
}

/**
 * Render a full frame.
 *
 * `onScanline(ly, regs)` runs before each line, which is where a caller
 * reproduces mid-frame register changes -- the same thing the game's LCD STAT
 * interrupt does on hardware.
 */
export function renderFrame(fb, video, regs, { palette = PALETTE_GREY, onScanline = null } = {}) {
  // LCD off: hardware blanks the panel to white rather than showing stale data.
  if ((regs.LCDC & 0x80) === 0) {
    fb.fill(palette[0]);
    return;
  }
  // The window's line counter is per-frame state: it resets at the top of the
  // frame and advances only on lines the window is drawn on.
  const windowState = { line: 0 };
  for (let ly = 0; ly < SCREEN_H; ly++) {
    if (onScanline) onScanline(ly, regs);
    renderScanline(fb, video, regs, ly, palette, windowState);
  }
}

/** Blit the RGB framebuffer into a canvas ImageData (adds opaque alpha). */
export function toImageData(fb, imageData) {
  const out = new Uint32Array(imageData.data.buffer);
  const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  for (let i = 0; i < fb.length; i++) {
    const c = fb[i];
    const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
    out[i] = littleEndian
      ? (0xff << 24) | (b << 16) | (g << 8) | r
      : (r << 24) | (g << 16) | (b << 8) | 0xff;
  }
}

/**
 * Browser harness: load a ROM the user supplies, extract assets from it, and
 * drive the scanline renderer.
 *
 * The ROM is never shipped with this engine and never leaves the browser --
 * it is read with FileReader and parsed in memory. That is what makes the
 * engine itself distributable.
 */

import { Rom } from './rom.js';
import {
  readScenes, sceneTiles, fontBlock, readScript, recordText,
} from './assets.js';
import {
  createVideo, createRegisters, uploadTiles, renderFrame,
  toImageData, SCREEN_W, SCREEN_H, PALETTE_GREY, PALETTE_GREEN,
} from './ppu.js';
import { drawText, clearText } from './text.js';
import { createGame, tick, render, powerOn, KEYS } from './play.js';
import { GameSound } from './audio.js';
import { AudioOut } from './audioout.js';
import { createPacer, ticksDue } from './pace.js';

const $ = (id) => document.getElementById(id);

const state = {
  rom: null,
  scenes: [],
  video: createVideo(),
  regs: createRegisters(),
  frame: new Uint32Array(SCREEN_W * SCREEN_H),
  palette: PALETTE_GREY,
  scene: 0,
  split: false,
  scrollX: 0,
  animating: false,
  view: null,      // the level being viewed (a game, not run), and its start X
  viewX: 0,
  game: null,      // playable mode, when running
  ticks: 0,        // VBlanks ticked since Play
  frames: 0,       // animation frames since Play
  dropped: 0,      // VBlanks dropped after long gaps (pace.js)
  clock: 0,        // when the pacer last ran (performance.now())
  audio: null,     // AudioOut, made on the first Play (a user gesture)
};

let ctx, imageData;

function log(msg, kind = '') {
  const el = $('log');
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function draw() {
  const { frame, palette, view } = state;
  // The level as Play draws it (render: the metatiles around the camera),
  // the camera moved by the Scroll demo.
  if (view) {
    view.cam.x = (state.viewX + (state.scrollX | 0)) & 0xffff;
    view.cam.scx = view.cam.x & 0xff;
    render(view, frame, palette);
    if (!state.split) {
      toImageData(frame, imageData);
      ctx.putImageData(imageData, 0, 0);
      return;
    }
  }
  const { video, regs } = state;
  const baseScx = view ? view.cam.scx : state.scrollX | 0;
  renderFrame(frame, video, regs, {
    palette,
    onScanline: (ly, r) => {
      // Demonstrates the mid-frame register change the game's LCD STAT
      // interrupt performs on hardware: the lower part of the screen scrolls
      // at a different rate from the upper part.
      r.SCX = state.split && ly >= 72 ? (baseScx * 2) & 0xff : baseScx & 0xff;
    },
  });
  toImageData(frame, imageData);
  ctx.putImageData(imageData, 0, 0);
}

function loadScene(i) {
  stopPlay();
  const { rom } = state;
  const scene = state.scenes[i];
  state.scene = i;
  state.scrollX = 0;

  // The level as Play shows it at its start: the game created, its fade in
  // run (no keys, no sound), then drawn by play.js's render -- the map's
  // metatiles ($c820) as the game expands them, not the raw map bytes.
  const view = createGame(rom, scene);
  for (let n = 0; n < 200 && (view.fadeIn || view.loading || view.screen); n++) tick(view);
  state.view = view;
  state.viewX = view.cam.x;
  state.video = view.video;
  state.regs = view.regs;
  log(`level ${i + 1}: ${sceneTiles(rom, scene).tileCount} tiles, ${view.map.xLimitPx} x ${view.map.heightPx} px, `
    + `its start view (Scroll moves the camera)`);
  draw();
}

function showText() {
  const { rom } = state;
  const fb = fontBlock(rom);
  uploadTiles(state.video, fb.vramBase, fb.pixels);

  // Use the window layer as a text panel, which is what the hardware layer is
  // for and what the game itself uses it for.
  const r = state.regs;
  r.LCDC |= 0x20 | 0x40;  // window on, window uses the second map
  r.WX = 7;
  r.WY = 96;
  clearText(state.video.windowMap, 0, 0, 32, 6);
  drawText(state.video.windowMap, 'EMPIRE STRIKES BACK', 0, 0);
  drawText(state.video.windowMap, 'ENGINE PHASE 2', 0, 1);
  drawText(state.video.windowMap, 'TEXT FROM YOUR ROM', 0, 2);
  log('window text layer enabled (font loaded from the ROM)');
  draw();
}

function animate() {
  state.animating = !state.animating;
  $('btn-scroll').textContent = state.animating ? 'Stop' : 'Scroll';
  const tick = () => {
    if (!state.animating) return;
    state.scrollX = (state.scrollX + 0.5) % 256;
    draw();
    requestAnimationFrame(tick);
  };
  tick();
}

/**
 * Playable mode. Steps the ported player code with the keyboard; see
 * play.js for what is verified and what is a stand-in.
 */
async function startPlay() {
  const scene = state.scenes[state.scene];
  const game = createGame(state.rom, scene);
  // Sound: the game's own driver (audio.js) into the page's audio output.
  // Without Web Audio the game plays silent.
  try {
    state.audio ??= await AudioOut.create();
  } catch (e) {
    log(`no sound: ${e.message}`, 'warn');
  }
  if (state.audio) {
    const out = state.audio;
    game.sound = new GameSound(state.rom.bytes, out.rate);
    game.onSamples = (samples) => out.push(samples);
  }
  // Every level starts as the cartridge does: the boot screens and the
  // title, then the level chosen -- NewGame's level ($01c1), which the
  // game itself always sets to 1 (HANDOVER §9.34).
  powerOn(game);
  state.game = game;
  state.animating = false;
  $('btn-play').textContent = 'Stop';
  $('screen').focus();
  log(`playing level ${game.level}: W A S D move, O jumps (A), P shoots (B), S crouches, Enter is START, Backspace SELECT, M mutes`, 'ok');
  let level = game.level;
  // At the Game Boy's rate, not the display's (pace.js).
  const pacer = createPacer(performance.now());
  const loop = () => {
    const g = state.game;
    if (!g) return;
    // The clock itself, not the frame's timestamp (which a browser may hold back).
    const n = ticksDue(pacer, performance.now());
    for (let i = 0; i < n; i++) tick(g);
    state.ticks += n;
    state.frames++;
    state.dropped = pacer.dropped;
    state.clock = pacer.last;
    if (!n) { requestAnimationFrame(loop); return; }
    // A level change (exit, continue, new game) replaces the game's state.
    if (g.notice) { log(g.notice, 'warn'); g.notice = null; }
    if (g.level !== level) { level = g.level; log(`level ${level}`, 'ok'); }
    render(g, state.frame, state.palette);
    toImageData(state.frame, imageData);
    ctx.putImageData(imageData, 0, 0);
    const p = g.p;
    $('status').textContent = `level ${g.level}  health ${p.da93}${p.ff8f ? `  tauntaun ${p.da94}` : ''}`
      + `  lives ${p.da89}  force ${p.da95}  x ${p.x}  y ${p.y}  state ${p.state}  step ${g.steps}`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function stopPlay() {
  if (!state.game) return;
  state.game = null;
  $('btn-play').textContent = 'Play';
  $('status').textContent = '';
}

function onRomLoaded(bytes) {
  const rom = new Rom(bytes);
  const problems = rom.validate();
  if (problems.length) {
    for (const p of problems) log(`warning: ${p}`, 'warn');
    log('Continuing anyway; addresses were mapped against the US retail dump.', 'warn');
  } else {
    log(`loaded "${rom.title}" - matches the mapped dump`, 'ok');
  }

  state.rom = rom;
  state.scenes = readScenes(rom);
  log(`${state.scenes.length} scene slots, ` +
      `${new Set(state.scenes.map((s) => s.descriptor)).size} distinct descriptors`);

  const script = readScript(rom);
  log(`script: ${script.data.length} bytes, ${script.records.length} records`);

  const sel = $('scene');
  sel.innerHTML = '';
  state.scenes.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    // Scene i is level i + 1 ($0a62).
    o.textContent = `Level ${i + 1}`;
    sel.appendChild(o);
  });
  sel.disabled = false;
  for (const b of ['btn-play', 'btn-text', 'btn-scroll', 'btn-split', 'btn-palette']) $(b).disabled = false;

  // Scene 0 has a background map, so it is the useful default.
  loadScene(0);
}

export function init() {
  // For a test driving the page in a browser (HANDOVER §9.33): its state.
  globalThis.empirePage = state;
  const canvas = $('screen');
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;
  ctx = canvas.getContext('2d');
  imageData = ctx.createImageData(SCREEN_W, SCREEN_H);

  $('rom').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        onRomLoaded(new Uint8Array(reader.result));
      } catch (err) {
        log(`failed: ${err.message}`, 'warn');
      }
    };
    reader.readAsArrayBuffer(file);
  });

  $('scene').addEventListener('change', (e) => loadScene(Number(e.target.value)));
  $('btn-play').addEventListener('click', () => (state.game ? stopPlay() : startPlay()));
  // The joypad byte is rebuilt from the held keys; the game samples it once
  // per step, exactly as it reads $ff8a.
  const held = new Set();
  const update = () => {
    if (state.game) state.game.joy = [...held].reduce((j, k) => j | (KEYS[k] ?? 0), 0);
  };
  window.addEventListener('keydown', (e) => {
    if (state.game && e.code === 'KeyM' && state.audio) {
      state.audio.muted = !state.audio.muted;
      log(state.audio.muted ? 'sound off' : 'sound on');
      return;
    }
    if (!state.game || !(e.code in KEYS)) return;
    e.preventDefault();
    held.add(e.code);
    update();
  });
  window.addEventListener('keyup', (e) => { held.delete(e.code); update(); });
  window.addEventListener('blur', () => { held.clear(); update(); });
  $('btn-text').addEventListener('click', showText);
  $('btn-scroll').addEventListener('click', animate);
  $('btn-split').addEventListener('click', () => {
    state.split = !state.split;
    $('btn-split').textContent = state.split ? 'Split: on' : 'Split: off';
    draw();
  });
  $('btn-palette').addEventListener('click', () => {
    state.palette = state.palette === PALETTE_GREY ? PALETTE_GREEN : PALETTE_GREY;
    $('btn-palette').textContent = state.palette === PALETTE_GREY ? 'Palette: grey' : 'Palette: green';
    draw();
  });

  log('Select your own ROM file to begin. Nothing is uploaded; it is read in your browser.');
}

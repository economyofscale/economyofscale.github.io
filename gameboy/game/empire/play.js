/**
 * Playable mode: the ported player code, driven by the keyboard.
 *
 * Verified parts: everything the player does inside a step (player.js and
 * below; web/test/closedloop.mjs), the state logic after it (states.js;
 * web/test/stateparity.mjs), and the player's sprites (sprites.js;
 * web/test/spriteparity.mjs). Each level starts with the game's own setup
 * for it. What is still not ported is reported through `handlers.unported`
 * (objects) and `io.unported` (the player).
 *
 * Between play, the game's own screens (screens.js) and flow (flow.js):
 * dialogs, story screens, the death message and the continue prompt with
 * the lives counter, game over. A `session` carries what survives a level
 * start ($da87 and up, and the level).
 *
 * Sound: `game.sound` (audio.js GameSound), when the page attaches one --
 * the game's own driver, called where the game calls it: effects and the
 * boss's music from the ported code (io.oracle 'sound', 'bossMusic'), the
 * level's music, the screens' (title.js, show), and its update once per
 * displayed frame. Without it everything runs silent.
 */

import {
  sceneTiles, sceneCollision, decodeTiles, readScript, readScenes, rawMap, decompress,
} from './assets.js';
import { createVideo, createRegisters, uploadTiles, renderFrame } from './ppu.js';
import {
  createWorld, restoreMetatiles, resetSceneState, unpackScriptOver, selectRowAt, streamColumnRows, streamRow, redrawViewRows,
} from './collision.js';
import { createPlayer, freeFallStep, JOY } from './physics.js';
import { playerStep } from './player.js';
import { initCamera, updateCamera } from './camera.js';
import { onSelect, riderState } from './mount.js';
import { flyStep, speederStep } from './flying.js';
import { WalkerArrived, WalkersDown } from './objects.js';
import { loadHudTiles, hudInit, hudUpdate, bossBar, HUD_LINE } from './hud.js';
import { mountUpdate, playerScreenPosition, advanceAnimation, drawObject } from './sprites.js';
import { climbCheck, forceCharge, playerStateMachine } from './states.js';
import {
  createObjects, createTemplate, levelList, levelSpawner, timedSpawner, updateObjects, objectCommonTail, initObject,
  OBJ_SLOTS, OBJ_SIZE,
} from './objects.js';
import { updateProjectiles, spawnProjectile, spawnProjectileFrom } from './projectiles.js';
import { onBPressed, saberSwing } from './weapons.js';
import { climbInput, upFromGround, onUpPressed } from './climb.js';
import { checkObjectLanding } from './landing.js';
import { animateTiles, beltPush, wakeObjects, forceDrain, hideMount } from './mainloop.js';
import { hurt, blink, trigger } from './hurt.js';
import { touchObjects } from './touch.js';
import { newGame, afterDeath, promptStep } from './flow.js';
import { titleSequence, endingSequence, bootSequence, forceSequence } from './title.js';
import { dialogScreen, storyScreen, drawStream, fadeAt, FADE_IN, FADE_OUT } from './screens.js';
import { LINES, RESUME, stepWork, nextStart } from './timing.js';


export const KEYS = {
  KeyW: JOY.UP, KeyS: JOY.DOWN, KeyA: JOY.LEFT, KeyD: JOY.RIGHT,
  Enter: JOY.START, Backspace: JOY.SELECT, KeyO: JOY.A, KeyP: JOY.B,
};

/**
 * Levels whose player is a vehicle ($0c3c sets $da35 to 2, 6, 7 or 9,
 * flying.js): 6, 7, 9 the Falcon, 2 the snowspeeder.
 */
export const FALCON_LEVELS = new Set([6, 7, 9]);
export const SPEEDER_LEVEL = 2;

/**
 * $0c3c: the levels whose setup unpacks sprite graphics to $dac1 (graphics
 * set 27), and from where. Levels 3, 6, 7, 10 leave $dac1 as it was.
 */
const DAC1 = {
  1: [4, 0x7104], 2: [3, 0x7b70], 4: [4, 0x6df0], 5: [4, 0x6df0], 8: [1, 0x6271], 9: [1, 0x6271], 11: [2, 0x7cd6],
};

/**
 * LevelStart's own time ($01e0 to the fade in's call at $0c30): the
 * scene's streams unpacked and the view drawn with the LCD on, every VRAM
 * access waiting on STAT. Measured, whole VBlanks from $01e0 -- the same
 * on two routes in (HANDOVER §9.35): `music`, the level's music started
 * ($0aa4, inside $0a62); `fade`, the fade in begun.
 */
export const LEVEL_LOAD = {
  1: { music: 7, fade: 47 }, 2: { music: 7, fade: 40 }, 3: { music: 4, fade: 42 }, 4: { music: 7, fade: 46 },
  5: { music: 7, fade: 46 }, 6: { music: 4, fade: 40 }, 7: { music: 4, fade: 40 }, 8: { music: 8, fade: 45 },
  9: { music: 8, fade: 43 }, 10: { music: 4, fade: 41 }, 11: { music: 6, fade: 42 },
};

/**
 * Level 2's RedrawView is SpeederScreen ($3790), which ends in `jp $638f`
 * with $da4b, the level's music again; LevelStart's tail ($0bb9, $0be5)
 * calls it twice. Whole VBlanks from $01e0, measured after power-on
 * (titlelog --boot --level 2); after level 1's exit they come at 37 and
 * 39 (the route's start line, as RestoreView's time).
 */
const SPEEDER_MUSIC = [38, 39];
/**
 * The same in RestoreView after a dialog ($0bb9, $0be5): VBlanks from its
 * entry, measured on a dialog planted on level 2 (titlelog --dialog
 * --plant 4) -- level 2 has none of its own, nor a marker or a type that
 * makes one (HANDOVER §9.50).
 */
const SPEEDER_MUSIC_RESTORE = [29, 30];

/**
 * RestoreView's own time after a teleport ($0b43 to its fade in, $0c30):
 * whole VBlanks with the screen white, measured per level (titlelog
 * --teleport).
 */
export const RESTORE_TIME = { 1: 36, 3: 34, 4: 37, 5: 37, 8: 36, 10: 35, 11: 34 };

/**
 * The same after a dialog ($25d0 to $0c30; titlelog --dialog). RestoreView
 * waits on the LCD as it writes VRAM, so its time is in whole frames and
 * hangs on the line it starts at: LY 2 after a dialog, 6--10 after a
 * teleport. The same but on level 10, whose teleport ends 13 lines short
 * of a VBlank.
 */
export const RESTORE_TIME_DIALOG = { ...RESTORE_TIME, 10: 36, 2: 32 };

/**
 * The same after the START screen ($0828 to $0c30; startlog `restore`,
 * from LY 4). Here its work varies by some 25 lines from one screen to
 * the next, and where it ends close to a VBlank (levels 4 and 5) one in
 * a dozen takes one VBlank more: the most common.
 */
export const RESTORE_TIME_START = { 1: 35, 3: 34, 4: 36, 5: 36, 8: 35, 10: 35, 11: 34 };

/** What survives a level start ($01e0 clears up to $da86): see flow.js. */
const SESSION_KEYS = ['ff8b', 'da88', 'da89', 'da91', 'da92', 'da95',
  'da96', 'da97', 'da98', 'da99', 'da9a', 'da9b', 'da9c', 'da9d'];

/** A new game's session ($01ae). */
export function freshSession() {
  const s = Object.fromEntries(SESSION_KEYS.map((k) => [k, 0]));
  newGame(s);
  return s;
}
const sessionOf = (p) => Object.fromEntries(SESSION_KEYS.map((k) => [k, p[k] ?? 0]));

/**
 * $01e0 clears RAM up to $da86: every global from $da16 there starts at 0,
 * named or not (a routine that counts in one must not start from undefined).
 */
const CLEARED = Object.fromEntries(Array.from({ length: 0xda87 - 0xda16 }, (_, i) => [(0xda16 + i).toString(16), 0]));

/** The physics state a level starts in, as the game sets it up. */
function startState(map, level, session) {
  return Object.assign(createPlayer(), CLEARED, {
    x: map.startX, y: map.startY, px: map.startX, py: map.startY, sx: 0, sy: 0,
    ff8b: level, ff8c: 0, ff8d: 0, ff8e: 0, ff8f: level === 1 ? 1 : 0,
    da16: 0, da17: 0, da19: 0, da1a: 0, da1b: 0, da1c: 0, da1d: 0, da1e: 0, da1f: 0,
    da21: 0, da22: 0, da23: 0, da24: 0, da25: 1, da26: 0, da2b: 0, da31: 0, da34: 0,
    da35: 0, da3e: 0, da42: 0, da43: 0, da44: 0, da45: 0, da46: 0, da48: 0, da4c: 0,
    da4f: 0, da91: 0, da95: 0,
    // $01f1: full health for the player and the tauntaun; $0203: state $ff.
    da41: 0, da93: 0x20, da94: 0x20, state: 0xff,
    d988: 0, d98a: 0, d98c: 0, d98f: 0, da80: 0, widthPx: map.xLimitPx,
  }, session, { ff8b: level });
}

/**
 * $0c3c, for the on-foot levels and level 1: the player record from the
 * template at 02:$7bf6 (on foot, standing); level 1 replaces it with the
 * rider ($7c16) and adds the tauntaun ($7cb6) at $c320.
 */
function levelObjects(rom, level) {
  const template = (addr) => Uint8Array.from({ length: 0x20 }, (_, i) => rom.byte(2, addr + i));
  const objs = createObjects();
  if (FALCON_LEVELS.has(level)) {
    // $0d1c: the Falcon.
    objs.set(template(0x7c76), 0x00);
  } else if (level === SPEEDER_LEVEL) {
    // $0ce9: the snowspeeder.
    objs.set(template(0x7c96), 0x00);
  } else if (level === 1) {
    objs.set(template(0x7c16), 0x00);
    objs.set(template(0x7cb6), 0x20);
  } else {
    objs.set(template(0x7bf6), 0x00);
  }
  return objs;
}

/** Start a level. Scene = level - 1, as $0a62 loads it. */
export function createGame(rom, scene, session = freshSession()) {
  const level = scene.index + 1;
  const map = sceneCollision(rom, scene);
  const video = createVideo();
  uploadTiles(video, 0x8800, sceneTiles(rom, scene).pixels);
  const regs = createRegisters();
  // Gameplay registers, from the snapshots: BG and sprites on, signed BG
  // tile data from $8800, and the sprite palettes.
  // LCDC $e3: the window on, from map $9c00, at WX 7 / WY $87 ($0bb1) --
  // once the fade in is done ($0c33); $81 while it runs.
  regs.LCDC = 0x81;
  regs.WX = 0x07;
  regs.WY = HUD_LINE;
  loadHudTiles(rom, video);
  hudInit(video.windowMap);
  // The level fades in from white ($0aab: descriptor byte 19 picks a pair
  // of fade tables at $3f44; $15ae ends on the third), then play begins.
  const fadeInTable = rom.word(0, 0x3f44 + ((scene.subTable - 1) & 0xff) * 4);
  regs.BGP = 0xff;
  regs.OBP0 = 0xc6;
  regs.OBP1 = 0xe4;
  const objs = levelObjects(rom, level);
  const p = startState(map, level, session);
  // $0ac1: $da30, the tile a crumbled quarter becomes (descriptor byte 20).
  p.da30 = scene.flag;
  if (FALCON_LEVELS.has(level)) {
    // $0cfc / $0d14: $da35 = the level; $da3a = 10 (1 on level 9).
    p.da35 = level;
    p.da3a = level === 9 ? 1 : 0x0a;
  }
  if (level === SPEEDER_LEVEL) {
    // $0cc4: in the speeder, 3 harpoons, 6 walkers, state $0e.
    Object.assign(p, { ff8f: 1, da35: 2, da3a: 3, da39: 6, state: 0x0e });
  }
  fromRecord(p, objs.subarray(0, 0x20));
  const tileRam = animatedTiles(video, level);
  const list = levelList(rom, level);
  const game = {
    rom, map, video, regs, objs, level, p, scene, dying: null, screen: null, queued: [], notice: null, tileRam,
    fadeIn: { table: fadeInTable, f: 0, lcdc: 0xe3 }, levelFade: null, lcdcNext: null, paused: null, afterShot: null,
    // $0aa4: the level's music ($da4b), descriptor byte 18. Started when
    // play begins (a level can be created behind the title).
    levelMusic: scene.sound, musicDue: true,
    // Level 2: the radar's sprite entries ($c100), the walkers' pictures
    // waiting to be drawn, and the stand-in timer for $1599.
    radar: new Uint8Array(0x30), pictures: [], timer: 0,
    // $dac1..: the level's own sprite graphics.
    dac1: DAC1[level] ? decompress(rom, DAC1[level][0], DAC1[level][1], 0xdac1).data : session.dac1 ?? new Uint8Array(0),
    world: createWorld(map),
    joy: 0, frame: 0, nextStep: 0, steps: 0, stepAt: null, streams: 0, walkers: 0,
    // The object system's state (objects.js). The spawn template is seeded
    // with the script, as it is once the level's intro text has run.
    objState: {
      rom, objs, list, spawned: new Uint8Array(list.length),
      template: createTemplate(readScript(rom).data), cam: null, p,
      bgItems: [], da32: 0, da81: 0, da92: 0,
      // Every type the levels' lists hold is ported (test/unported.mjs);
      // any other just animates and is drawn where it is.
      handlers: { unported: (type, where, o) => { if (o) objectCommonTail(game.objState, o); } },
    },
  };
  game.projState = {
    rom, objs, template: game.objState.template, world: game.world, cam: null,
    v: projectileGlobals(game), box: new Uint8Array(16),
    // Hurt, dialogs, sound; the HUD is redrawn after every step (refreshHud).
    // tileAddr/redraw ($37f1, $3981, after a crumble) need nothing: the
    // level is drawn from the metatiles every frame.
    io: {
      oracle: (name, a, hl) => {
        // The map streaming the camera asks for: counted for the step's cost.
        // Its row selections (the row cache) and what it writes past a
        // row's end matter: within the map the level is drawn from the
        // metatiles every frame.
        if (name === 'tileAddr2') { selectRowAt(game.world, game.projState.v.d988); return; }
        if (name === 'streamCol' || name === 'streamRow') {
          const { d988: y, d98a: x } = game.projState.v;
          if (name === 'streamCol') streamColumnRows(game.world, x, y);
          else streamRow(game.world, x, y);
          game.streams = (game.streams ?? 0) + 1;
          return;
        }
        if (soundCall(game, name, a)) return;
        if (name === 'dialog') { game.queued.push(() => showDialog(game, a, hl)); return; }
        if (name !== 'hurt') return;
        // Inside afterStep the player record is current: hand it to the
        // physics state and back.
        const rider = objs.subarray(0, 0x20);
        fromRecord(game.p, rider);
        try { hurtPlayer(game, a); } finally { toRecord(game.p, rider); }
      },
    },
  };
  // The shooting handlers fire through the projectile system; both share
  // $d988..$d98f, so the object system uses the same globals.
  Object.assign(game.objState, {
    world: game.world,
    v: game.projState.v,
    box: game.projState.box,
    shoot: (o, type, dx, dy) => spawnProjectileFrom(game.projState, o, type, dx, dy),
    io: game.projState.io,
  });
  // The camera ($d9af.., camera.js): placed by 01:538a, then caught up by
  // $3621 as LevelStart does ($0214).
  game.cam = { x: 0, y: 0, scx: 0, scy: 0, w: map.xLimitPx, h: map.heightPx };
  initCamera(game.cam, p, game.projState.v);
  game.cam.scx = game.cam.x & 0xff;
  game.cam.scy = game.cam.y & 0xff;
  if (!p.da35) updateCamera(game.cam, p, game.projState.v, game.projState.io);
  // $0217: the mount at the player's position; $022f: the level spawner
  // once -- on the flying levels the only time it runs.
  objs.copyWithin(0x2c, 0x0c, 0x10);
  game.objState.cam = { x: game.cam.x, y: game.cam.y };
  // The spawner's boss music ($3e7a) comes after the level's ($0aa4):
  // held until that is played (startLevelMusic).
  game.bossAtStart = 0;
  game.spawningAtStart = true;
  levelSpawner(game.objState);
  game.spawningAtStart = false;
  // $0b90 ClearScreen: tile $9000 blank, the BG map (and $0b93, the
  // window's) cleared. Then $0232 -> $0bb9 RedrawView: the view's rows,
  // through the row cache -- on level 2 SpeederScreen, the picture.
  clearScreen(game);
  if (p.da35 !== 2) redrawView(game);
  else speederScreen(game);
  game.da33 = 0;
  refreshHud(game);
  // $1d6a: trigger tiles hurt, or cost the mount.
  game.world.onTrigger = () => {
    const ctx = { rom, objs, template: game.objState.template, io: { oracle: (n, a) => soundCall(game, n, a) } };
    if (trigger(game.p, ctx) === 'died') throw new Died();
  };
  game.io = {
    // $1144: the bar is redrawn after every step instead (refreshHud).
    hud: () => {},
    unported: () => {},
    pit: () => hurtPlayer(game, 0x20),
    // $1727, $176a, $16be: climbing and the UP power.
    climbInput: (pl) => climbInput(pl, game.world),
    upFromGround: (pl) => upFromGround(pl, game.world),
    onUp: (pl) => onUpPressed(pl, game.world),
    // $3d80: standing on platforms; the player's globals as projectiles see them.
    objectLanding: () => checkObjectLanding(game.projState.v, {
      world: game.world, objs, box: game.projState.box,
    }),
    // $16e3: dismount, or switch blaster and lightsaber.
    onSelect: (pl) => onSelect(pl, {
      rom, objs, template: game.objState.template, io: game.projState.io,
      spawn: (type) => spawnProjectile(game.projState, type),
    }),
    onB: (p) => onBPressed(p, {
      rom, rider: objs.subarray(0, 0x20), io: game.projState.io,
      spawn: (type) => spawnProjectile(game.projState, type),
    }),
  };
  return game;
}

/**
 * The globals projectiles.js reads and writes, as one object: the player's
 * where the physics state has them ($ffa0 is its `state`, $d98e its `dir`
 * -- the walking direction flags, which a shot's velocity overwrites, as in
 * the game), $da81 the object system's, the rest its own.
 */
const RENAMED = { ffa0: 'state', d98e: 'dir', da18: 'vx' };
function projectileGlobals(game) {
  const own = { daa0: 0, da9e: 0, da39: 0, da3a: 0, da3b: 0, da8d: 0, da93: 0 };
  const where = (k) => (k in RENAMED ? [game.p, RENAMED[k]] : k === 'da81' ? [game.objState, 'da81']
    : k in game.p ? [game.p, k] : [own, k]);
  return new Proxy(own, {
    get: (_, k) => { const [o, f] = where(k); return o[f] ?? 0; },
    set: (_, k, v) => { const [o, f] = where(k); o[f] = v; return true; },
  });
}

/**
 * The status bar (hud.js): UpdateHUD and BossBar. The game redraws the
 * bar only when something calls $1144; here it is redrawn every step,
 * which shows the same.
 */
function refreshHud(game) {
  const { p } = game;
  const s = {
    da93: p.da93, da94: p.da94, da95: p.da95, da35: p.da35, da3a: p.da3a ?? 0, ff8f: p.ff8f,
    da32: game.objState.da32, da33: game.da33,
  };
  hudUpdate(game.video.windowMap, s);
  bossBar(game.video.windowMap, s);
  game.da33 = s.da33;
}

/**
 * $0bf4: the animated tiles' bytes, copied from VRAM into $da50..$da7f
 * (level 3: $9590..$95af into $da60..).
 */
function animatedTiles(video, level) {
  const tileRam = new Uint8Array(0x30);
  tileRam.set(tileBytes(video, 0x9410), 0x00);
  tileRam.set(tileBytes(video, level === 3 ? 0x9590 : 0x9230), 0x10);
  tileRam.set(tileBytes(video, level === 3 ? 0x95a0 : 0x9250), 0x20);
  return tileRam;
}

/** 16 bytes of 2bpp tile data at a VRAM address, encoded from the decoded pixels. */
function tileBytes(video, addr) {
  const base = ((addr - 0x8000) / 16) * 64;
  const out = new Uint8Array(16);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const px = video.tiles[base + y * 8 + x];
      out[y * 2] |= (px & 1) << (7 - x);
      out[y * 2 + 1] |= ((px >> 1) & 1) << (7 - x);
    }
  }
  return out;
}

/** Hurt never returns when it kills: the step is abandoned for the death loop. */
export class Died extends Error {}

/**
 * The death loop's count once the body is down: $1e after a vehicle's
 * bursts ($0e71), else $28 ($0de7, and $0db9 in the speeder level).
 */
export function deathCount(p) {
  return p.da35 && p.da35 !== 0x02 ? 0x1e : 0x28;
}

/** $0d73 on the physics state; throws Died when the death loop is next. */
function hurtPlayer(game, a) {
  const ctx = { rom: game.rom, objs: game.objs, template: game.objState.template, io: { oracle: (n, a) => soundCall(game, n, a) } };
  if (hurt(game.p, ctx, a) === 'died') throw new Died();
}

/**
 * The driver's entries as the ported code reports them: 'sound' (07:$638c,
 * an effect), 'bossMusic' ($3e7a: music 7, and the driver's $dfef = 0).
 * True when it was one of them.
 */
function soundCall(game, name, a) {
  if (name === 'sound') { game.sound?.effect(a); return true; }
  if (name === 'bossMusic') {
    game.objState.da83 = 1;
    if (game.spawningAtStart) game.bossAtStart++;
    else if (game.sound) { game.sound.music(0x07); game.sound.tuneEnded = 0; }
    game.projState.box[0] = 0;
    return true;
  }
  return false;
}

/**
 * 07:$638f -- music, when a sound is attached. The driver's start
 * (07:$656d) also clears $ff90, the low byte of the box scratch's X.
 */
function playMusic(game, a) {
  game.sound?.music(a);
  game.projState.box[0] = 0;
}

/**
 * $0aa4: the level's music as LevelStart starts it; then music 7 for
 * each boss the level spawner ($022f) met in view, as it spawned them
 * (createGame ran the spawner before any sound was attached).
 */
function startLevelMusic(game) {
  playMusic(game, game.levelMusic);
  for (; game.bossAtStart > 0; game.bossAtStart--) {
    if (game.sound) { game.sound.music(0x07); game.sound.tuneEnded = 0; }
  }
}

// The player record shares bytes with the physics state: in the game they
// are simply the same RAM. Copied across around the sprite phase.
const SHARED = [[0x00, 'c300'], [0x01, 'c301'], [0x04, 'c304'], [0x05, 'c305'], [0x08, 'c308'], [0x09, 'c309'],
  [0x10, 'c310'], [0x11, 'c311']];
function toRecord(p, rider) {
  for (const [i, k] of SHARED) rider[i] = p[k];
  rider[0x0c] = p.x & 0xff; rider[0x0d] = p.x >> 8;
  rider[0x0e] = p.y & 0xff; rider[0x0f] = p.y >> 8;
}
function fromRecord(p, rider) {
  for (const [i, k] of SHARED) p[k] = rider[i];
}

/**
 * The main loop after the player step, in the game's order: ClimbCheck
 * ($06b2), ForceCharge ($06b5), PlayerStateMachine ($06bf), the riding
 * update in level 1 ($06c7 -> $0ffb), LevelSpawner ($06dd, with the
 * camera as it was), the camera ($06f6, on foot), the screen position
 * ($06f9), animation of rider and mount ($070b, $0714), then objects,
 * shots and touches. Drawing is per frame.
 */
export function afterStep(game) {
  const { p, objs, rom } = game;
  const rider = objs.subarray(0x00, 0x20), mount = objs.subarray(0x20, 0x40);
  toRecord(p, rider);
  climbCheck(p, rider, game.world);
  forceCharge(p, rider);
  // $06bc -> $32f9: after a shot, the blaster's second sound.
  if (p.da80) {
    p.da80 = (p.da80 - 1) & 0xff;
    if (!p.da80) { soundCall(game, 'sound', 0x11); soundCall(game, 'sound', 0x12); }
  }
  playerStateMachine(p, rider, rom, { objs });
  if (p.ff8b === 1) mountUpdate(p, rider, mount, rom);
  // $06ce / $06d4: levels 3 and 8, the rider's state while mounted.
  if (p.ff8b === 3 || p.ff8b === 8) {
    fromRecord(p, rider);
    riderState(p, rider);
    toRecord(p, rider);
  }
  // $06da: the lightsaber's swing, from the frame the state machine set.
  if (p.ff8d) {
    fromRecord(p, rider);
    saberSwing(p, { rom, spawn: (type) => spawnProjectile(game.projState, type) });
  }
  const os = game.objState;
  os.cam = { x: game.cam.x, y: game.cam.y };
  levelSpawner(os);
  // $06e7: the timed spawner, every 128 steps.
  if ((p.tick & 0x7f) === 0x2f) {
    timedSpawner({ ...os, v: game.projState.v, box: game.projState.box, level: p.ff8b });
  }
  // $06ea: a conveyor pushes; $06ed (01:5bd9): levels 4 and 5 wake objects.
  fromRecord(p, rider);
  beltPush(p, game.world);
  wakeObjects(p, rom, objs);
  toRecord(p, rider);
  if (!p.da35) updateCamera(game.cam, p, game.projState.v, game.projState.io);
  os.cam = { x: game.cam.x, y: game.cam.y };
  playerScreenPosition(p, rider, mount, os.cam, rom);
  if (p.da26 || p.state !== 0x06) advanceAnimation(rider, rom);
  if (p.ff8f) advanceAnimation(mount, rom);
  sharedTail(game);
}

/**
 * $0717 onwards, every level alike: objects, shots, touches, the blink.
 * The player record is current on entry.
 */
function sharedTail(game) {
  const { p, objs, rom } = game;
  const rider = objs.subarray(0x00, 0x20);
  const os = game.objState;
  // $148c's calls, as timelog counts them: one a walker on screen, its two
  // pictures or one (and on foot, should one ever be there).
  os.walkers = 0;
  updateObjects(os);
  game.walkers = (game.walkers ?? 0) + os.walkers;
  // $0721 UpdateProjectiles: the player's shots (weapons.js) and the
  // enemies' (objects.js).
  game.projState.cam = os.cam;
  // A shot that ends the level ($243f, $21e7, $2244): play goes no further.
  const end = updateProjectiles(game.projState);
  if (end) { game.queued.push(() => levelEndByShot(game, end.where)); return; }
  fromRecord(p, rider);
  // $0724 TouchObjects: enemies hurt, pickups are taken.
  const touched = touchObjects(p, {
    rom, objs, world: game.world, template: os.template, v: game.projState.v, box: game.projState.box,
    io: game.projState.io, cam: os.cam, toRider: toRecord, fromRider: fromRecord,
  });
  toRecord(p, rider);
  if (touched === 'died') throw new Died();
  // $0727 on: what the step does after TouchObjects.
  const rest = () => {
    // $072c: every 16 steps the UP power and power 4 cost a unit of Force.
    if (!(p.tick & 0x0f)) forceDrain(p, game.projState);
    // $072f: riding, a hidden rider hides the mount.
    hideMount(p, rider, objs.subarray(0x20, 0x40));
    // $0744: the blink after a hit.
    blink(p);
    rider[0x01] = p.c301;
  };
  // A level marker that teleports: RestoreView returns into this step,
  // which goes on after it (teleport).
  if (touched?.ended === 'teleport') { teleport(game, rest); return; }
  if (touched?.ended) { game.queued.push(() => endLevel(game, touched)); return; }
  rest();
}

/**
 * 01:6030..$6044 -- a level marker's teleport, the player already at its
 * target: $da8d = $e1 (sprites off from the next VBlank), the level's fade
 * out ($da29, $15ae), the camera put on the player (01:538a), every
 * object but the player gone ($0470: +0 of slots 1..30), then RestoreView
 * ($0b43) -- its work with the screen white (RESTORE_TIME), its fade in --
 * and RestoreView's `ret` takes the step on at $0727 (`then`).
 */
export function teleport(game, then = null) {
  const tables = 0x3f44 + ((game.scene.subTable - 1) & 0xff) * 4;
  game.levelFade = {
    table: game.rom.word(0, tables + 2), f: 0, lcdc: 0xe1,
    then: () => {
      initCamera(game.cam, game.p, game.projState.v);
      for (let i = 0; i < 30; i++) game.objs[0x20 + i * 0x20] = 0;
      restoreView(game, game.regs.BGP, game.rom.word(0, tables), then);
      game.loading = { f: 0, fade: RESTORE_TIME[game.level], music: -1 };
    },
  };
}

/**
 * $07c3..$07de, then $06ed: a step on levels 6, 7, 9 -- the Falcon's own
 * half (flying.js), then the shared tail. The level spawners do not run.
 */
/**
 * $076a..$07c0, then $06ed: a step on level 2 -- the speeder or, after the
 * crash, on foot (flying.js) -- then the shared tail. The walkers' BG
 * pictures are collected for the renderer.
 */
export function speederPlayStep(game) {
  const { p, objs, rom } = game;
  const rider = objs.subarray(0x00, 0x20);
  toRecord(p, rider);
  const os = game.objState;
  game.timer = (game.timer + 0x3b) & 0xff;
  const r = speederStep(p, {
    rom, objs, template: os.template, world: game.world, cam: game.cam,
    v: game.projState.v, io: game.projState.io,
    spawn: (type) => spawnProjectile(game.projState, type),
    random: () => random(game),
    radar: game.radar,
    // $1443: one column of the walkers' band cleared a step, while the
    // camera is in its first 256 px -- the pre-drawn walkers wiped.
    clearColumn: (col, row) => {
      for (let r = 0; r < 7; r++) game.video.bgMap[((row + r) * 32 + col) & 0x3ff] = 0;
    },
    step: { world: game.world, rom, io: game.io },
    box: game.projState.box,
    toRider: toRecord, fromRider: fromRecord,
  });
  toRecord(p, rider);
  if (r === 'died') throw new Died();
  os.cam = { x: game.cam.x, y: game.cam.y };
  os.pictures = [];
  sharedTail(game);
  game.pictures.push(...os.pictures);
}

/**
 * $1599's mixing of a timer value: swap, rla (carry clear after swap),
 * ccf, rla -- the bit shifted out comes back inverted -- xor the value.
 * The game's whole draw, for TIMA = `c` (test/check.mjs runs the ROM's).
 */
export function randomFrom(c) {
  const s = ((c << 4) | (c >> 4)) & 0xff;
  const a = (((s << 1) & 0xff) << 1 | ((s >> 7) ^ 1)) & 0xff;
  return (a ^ c) & 0xff;
}

/**
 * $1599 -- the game's random number: built from the timer ($ff05), which
 * the browser does not have; a counter stands in for it. (It also writes
 * TAC from the result -- the timer's next rate -- and $da8b, which nothing
 * reads. Only level 2's spawner draws, about once a step: HANDOVER §9.37.)
 */
function random(game) {
  // A test plays the game's own answers back (test/stepparity.mjs).
  if (game.random) return game.random();
  game.timer = (game.timer + 0x17) & 0xff;
  return randomFrom(game.timer);
}

export function falconStep(game) {
  const { p, objs, rom } = game;
  const rider = objs.subarray(0x00, 0x20);
  toRecord(p, rider);
  const os = game.objState;
  flyStep(p, {
    rom, objs, template: os.template, world: game.world, cam: game.cam,
    v: game.projState.v, io: game.projState.io,
    spawn: (type) => spawnProjectile(game.projState, type),
    toRider: toRecord, fromRider: fromRecord,
  });
  toRecord(p, rider);
  os.cam = { x: game.cam.x, y: game.cam.y };
  sharedTail(game);
}

/**
 * $0de9 -- the death loop, every 2 VBlanks: the body falls (state $15)
 * until it lands ($16), then 40 more steps ($1e after a vehicle's bursts)
 * while the level goes on around it. On level 2 ($0e33) the body does not
 * fall: state $16 at once, no mount, no fall, no camera. Then $0e76
 * (livesScreen): the death message, the continue prompt.
 */
export function deathStep(game) {
  const { p, objs, rom } = game;
  const rider = objs.subarray(0x00, 0x20), mount = objs.subarray(0x20, 0x40);
  toRecord(p, rider);
  if (p.ff8b === 2) {
    p.state = 0x16;
  } else {
    if (p.ff8b === 1) mountUpdate(p, rider, mount, rom);
    fromRecord(p, rider);
    freeFallStep(p, { world: game.world, rom, io: game.io });
    toRecord(p, rider);
    // $0df8: the camera follows the falling body.
    updateCamera(game.cam, p, game.projState.v, game.projState.io);
  }
  const cam = { x: game.cam.x, y: game.cam.y };
  playerScreenPosition(p, rider, mount, cam, rom);
  if (p.c308 !== 0x07) advanceAnimation(rider, rom);
  const os = game.objState;
  os.cam = cam;
  updateObjects(os);
  game.projState.cam = cam;
  updateProjectiles(game.projState);
  fromRecord(p, rider);
  if (p.state === 0x15) return;
  game.dying.b--;
  // $0e22: $da8d = $81 -- the LCDC the VBlank handler applies, from the
  // next VBlank: the window and the sprites off -- then the level's fade
  // out (deathFade) before the lives screen.
  if (!game.dying.b) {
    game.projState.v.da8d = 0x81;
    game.dying.fade = 0;
  }
}

/** $0e27 -> $15ae: the level's fade out ($da29), 24 VBlanks; then $0e76, livesScreen. */
function deathFade(game) {
  const { rom } = game;
  const table = rom.word(0, 0x3f44 + ((game.scene.subTable - 1) & 0xff) * 4 + 2);
  if (game.dying.fade === 1) game.regs.LCDC = game.projState.v.da8d;
  // The last value at 24, and the lives screen begins in the same VBlank.
  game.regs.BGP = fadeAt(rom, table, game.dying.fade, game.regs.BGP);
  if (game.dying.fade++ < 24) return;
  game.dying = null;
  livesScreen(game);
}

// ---------------------------------------------------------------------------
// Between play: screens and the flow (flow.js, screens.js)
// ---------------------------------------------------------------------------

const scriptOf = (game) => (game.script ??= readScript(game.rom).data);

/** Start level `level` with this session. */
function startLevel(game, level, session) {
  const scenes = readScenes(game.rom);
  const past = level > scenes.length;
  if (past) { session = freshSession(); level = 1; }
  const next = createGame(game.rom, scenes[level - 1], { ...session, ff8b: level });
  Object.assign(game, next);
  beginLoad(game);
  if (past) game.notice = 'the end: a new game';
}

/** $01e0 entered: LevelStart's time (LEVEL_LOAD) before the fade in. */
function beginLoad(game) {
  game.loading = { f: 0, ...LEVEL_LOAD[game.level], ...(game.level === SPEEDER_LEVEL ? { speeder: SPEEDER_MUSIC } : {}) };
  game.musicDue = false;
}

/**
 * Show a screen: fade in, then wait for any button (unless `wait` is
 * false), fade out, then `then`. $330d also unpacks the script over $ca20,
 * the spawn template.
 */
function show(game, sc, { wait = true, prompt = null, then = null, music = null } = {}) {
  game.objState.template.set(scriptOf(game).subarray(0, 0x20));
  // A dialog's script carries the lives digit $2574 writes at $d1bc.
  unpackScriptOver(game.world, sc.text ?? scriptOf(game));
  // $330d: $da8d = $81 -- what the level's LCDC is when play comes back.
  game.regs.LCDC = 0x81;
  if (music !== null) playMusic(game, music);
  game.screen = { ...sc, f: 0, phase: 'in', wait, prompt, then, next: 0 };
}

/**
 * $2566's music: 4 as the dialog is drawn ($2579); at its end, unless A
 * bit 6 or 7, the level's back ($25d0..$25d9).
 */
function dialogMusic(game, a, then) {
  if (a & 0xc0) return then;
  // $25d0: RestoreView ($0b43: the level's graphics, metatiles and view
  // again -- the script was unpacked over them -- its time with the screen
  // white, and its fade in from where the dialog left BGP), then the
  // level's music ($25d9, after RestoreView's `ret`).
  return (answer) => {
    const tables = 0x3f44 + ((game.scene.subTable - 1) & 0xff) * 4;
    restoreView(game, 0xff, game.rom.word(0, tables), () => {
      playMusic(game, game.levelMusic);
      then?.(answer);
    });
    game.loading = { f: 0, fade: RESTORE_TIME_DIALOG[game.level] ?? 0, music: -1,
      ...(game.p.da35 === 2 ? { speeder: SPEEDER_MUSIC_RESTORE } : {}) };
  };
}

/**
 * $04eb -- the title, as NewGame runs it before a new game: frame by frame
 * from title.js. `from` is the screen it follows (its font is what the
 * title's first screen draws with); none: a fresh font.
 */
function showTitle(game, from, then) {
  const tiles = from ? from.video.tiles.subarray(0x80 * 64, 0x180 * 64) : undefined;
  // After play: LYC is still the status bar's split (title.js `statWake`).
  const seq = titleSequence(game.rom, scriptOf(game), () => game.joy, { tiles, sound: game.sound, statWake: true });
  const { value } = seq.next();
  game.screen = { seq, cur: value, video: value.video, regs: value.regs, then };
}

/**
 * Power-on: the boot screens ($0555) and the first title, then the game
 * as created (a new session -- what NewGame sets up -- on level 1, or on
 * the level the page chose, as if NewGame's $01c1 had set it).
 */
export function powerOn(game) {
  const seq = bootSequence(game.rom, scriptOf(game), () => game.joy, game.sound);
  const { value } = seq.next();
  game.screen = { seq, cur: value, video: value.video, regs: value.regs, then: () => beginLoad(game) };
}

/** $2566 -- a dialog (A bit 6: no wait). Play goes on afterwards. */
export function showDialog(game, a, hl, then = null) {
  // $2546: the sprites off from the next VBlank ($da8d), the level's fade
  // out ($da29), then the dialog ($2566).
  const tables = 0x3f44 + ((game.scene.subTable - 1) & 0xff) * 4;
  game.levelFade = {
    table: game.rom.word(0, tables + 2), f: 0, lcdc: game.regs.LCDC & 0xfd,
    then: () => {
      const sc = dialogScreen(game.rom, scriptOf(game), a, hl, game.p.da89);
      show(game, sc, { wait: !(a & 0x40), then: dialogMusic(game, a, then), music: 0x04 });
    },
  };
}

/** $15ae on the level's own screen, one VBlank a call: the last value at 24, then `then`. */
function levelFadeStep(game) {
  const lf = game.levelFade;
  if (lf.f === 1) game.regs.LCDC = lf.lcdc;
  game.regs.BGP = fadeAt(game.rom, lf.table, lf.f, game.regs.BGP);
  if (lf.f++ < 24) return;
  game.levelFade = null;
  lf.then();
}

/** 01:6024..$607f -- the level's exit: a story screen first for some. */
export function endLevel(game, { ended, text }) {
  const session = sessionOf(game.p);
  const go = () => startLevel(game, session.ff8b, session);
  // 01:604d: $da8d = $81 (from the next VBlank), the level's fade out
  // ($da29, $15ae); then the story screen, its music 9 ($25e6), or the
  // next level straight away ($01e0).
  const tables = 0x3f44 + ((game.scene.subTable - 1) & 0xff) * 4;
  game.levelFade = {
    table: game.rom.word(0, tables + 2), f: 0, lcdc: 0x81,
    then: () => {
      if (ended === 'cutscene') show(game, storyScreen(game.rom, scriptOf(game), text), { then: go, music: 0x09 });
      else go();
    },
  };
}

/**
 * A level won by a shot. $243f: the last of the counted enemies -- a story
 * screen (07:$62f9, Cloud City) and the next level (from level 6 the game
 * goes on in place as level 7, and does not get here). $21e7: level 9's
 * Star Destroyer -- the story at $d889. $2244: Vader -- the end.
 * The first two run $2473 first: the level goes on without the player for
 * $28 ($243f) or $14 ($21e7) turns, then LCDC $81 and the level's fade out
 * ($da29), then the story screen (afterShotStep).
 */
function levelEndByShot(game, where) {
  if (where === '$2244') { startEnding(game); return; }
  game.afterShot = { where, left: where === '$243f' ? 0x28 : 0x14, fade: -1 };
  // The first turn at once (the kill calls $2473 in the middle of
  // UpdateProjectiles), the next 4 VBlanks on.
  afterShotStep(game);
  game.nextStep = game.frame - 1 + 4;
}

/**
 * $2473 -- one turn: the player's screen position ($0a52), UpdateObjects,
 * UpdateProjectiles, the drawing ($02d3), then two game frames ($044d
 * twice: 4 VBlanks; the game's first gap can be 5, by where the step was
 * in its frame). A shot can still kill the player: Hurt never returns,
 * and the death loop takes over from the level's end. Then $2452: LCDC
 * $81, the fade out, one table step every 8 VBlanks; the story screen.
 * Timing checked against the game (emu/src/endlog.mjs).
 */
function afterShotStep(game) {
  const a = game.afterShot;
  const { p, objs, rom } = game;
  if (a.left) {
    a.left--;
    game.nextStep += 4;
    const rider = objs.subarray(0x00, 0x20), mount = objs.subarray(0x20, 0x40);
    const cam = { x: game.cam.x, y: game.cam.y };
    toRecord(p, rider);
    playerScreenPosition(p, rider, mount, cam, rom);
    fromRecord(p, rider);
    const os = game.objState;
    os.cam = cam;
    try {
      updateObjects(os);
      game.projState.cam = cam;
      updateProjectiles(game.projState);
    } catch (e) {
      if (!(e instanceof Died)) throw e;
      game.afterShot = null;
      game.dying = { b: deathCount(game.p) };
    }
    return;
  }
  game.nextStep += 1;
  if (a.fade < 0) {
    game.regs.LCDC = 0x81;
    a.fade = 0;
  }
  // 24 VBlanks of fading ($15ae), then the story screen ($25dc) in the
  // VBlank of the last value.
  if (a.fade <= 24) {
    const table = rom.word(0, 0x3f44 + ((game.scene.subTable - 1) & 0xff) * 4 + 2);
    game.regs.BGP = fadeAt(rom, table, a.fade, game.regs.BGP);
    if (a.fade++ < 24) return;
  }
  game.afterShot = null;
  const session = sessionOf(p);
  const go = () => startLevel(game, session.ff8b, session);
  if (a.where === '$243f') show(game, storyScreen(rom, scriptOf(game), 0x62f9, 7), { then: go, music: 0x09 });
  else show(game, storyScreen(rom, scriptOf(game), 0xd889), { then: go, music: 0x09 });
}

/**
 * $2244 -- Vader beaten: the object that was hit becomes $61 (InitObject,
 * then falling: +$10 = 0, +$11 = 1) and for 128 game frames only the
 * objects, the shots and the drawing go on ($225e). Then the ending's
 * screens (title.js), and $01ae: a new game, through the title.
 */
export function startEnding(game) {
  const { rom, objs } = game;
  const o = objs.subarray(game.projState.v.da9e - 0xc300, game.projState.v.da9e - 0xc300 + 0x20);
  o[0x00] = 0x61;
  initObject(rom, Uint8Array.from(o), o);
  o[0x10] = 0x00;
  o[0x11] = 0x01;
  game.ending = { steps: 0x80 };
}

/** One of the ending's 128 game frames; then its screens. */
function endingStep(game) {
  const os = game.objState;
  updateObjects(os);
  game.projState.cam = os.cam;
  updateProjectiles(game.projState);
  if (--game.ending.steps) return;
  game.ending = null;
  endingScreens(game);
}

/**
 * $226f on: the ending's screens (title.js endingSequence), then NewGame
 * ($01ae): the title, and level 1 with a new session.
 */
export function endingScreens(game) {
  const session = sessionOf(game.p);
  // $0aab: the level's fade tables; $da29 is its fade-out.
  const fadeOut = game.rom.word(0, 0x3f44 + ((game.scene.subTable - 1) & 0xff) * 4 + 2);
  const seq = endingSequence(game.rom, scriptOf(game), () => game.joy, {
    from: { video: game.video, regs: { ...game.regs } }, fadeOut, da89: session.da89, sound: game.sound,
  });
  const { value } = seq.next();
  game.screen = {
    seq, cur: value, video: value.video, regs: value.regs,
    then: () => { newGame(session); showTitle(game, value, () => startLevel(game, 1, session)); },
  };
}

/**
 * $07e1 -- START on foot: the Force powers' screen (title.js
 * forceSequence), then RestoreView ($0b43, RESTORE_TIME_START) and the
 * level's music again;
 * with $da19, the player's facing bit from its frame ($10be).
 */
function startScreen(game) {
  const { rom, p } = game;
  const tables = 0x3f44 + ((game.scene.subTable - 1) & 0xff) * 4;
  const state = {
    owned: Array.from({ length: 8 }, (_, i) => p[`da${(0x96 + i).toString(16)}`] ?? 0),
    da2b: p.da2b, da95: p.da95, da93: p.da93, da94: p.da94, ff8f: p.ff8f,
    da43: p.da43, da1a: p.da1a, c304: p.c304, c305: p.c305,
  };
  const seq = forceSequence(rom, scriptOf(game), () => game.joy, {
    from: { video: game.video, regs: { ...game.regs } }, fadeOut: rom.word(0, tables + 2), state,
    sound: game.sound,
  });
  // $330d unpacks the script over $ca20, the spawn template (and the row cache).
  game.objState.template.set(scriptOf(game).subarray(0, 0x20));
  unpackScriptOver(game.world, scriptOf(game));
  const { value } = seq.next();
  game.screen = {
    seq, cur: value, video: value.video, regs: value.regs,
    then: () => {
      for (const k of ['da2b', 'da95', 'da93', 'da94', 'da43', 'c304', 'c305']) p[k] = state[k];
      // $0828: RestoreView, its time with the screen white, its fade in;
      // after its `ret`, the music ($0831) and the facing ($0838).
      restoreView(game, value.regs.BGP, rom.word(0, tables), () => {
        playMusic(game, game.levelMusic);
        if (p.da19) {
          const rider = game.objs.subarray(0x00, 0x20);
          toRecord(p, rider);
          advanceAnimation(rider, rom);
          rider[0x01] = (rider[0x01] & 0xdf) | ((rider[0x08] & 0x04) << 3);
          fromRecord(p, rider);
        }
      });
      game.loading = { f: 0, fade: RESTORE_TIME_START[game.level] ?? 0, music: -1 };
    },
  };
}

/**
 * $3756 RedrawView on foot: the view's 6 rows through the row cache, and
 * the scratch it leaves -- $d988 the last row's Y, $d98a the camera's X,
 * $d98e its count run down to 0, which is the player's `dir`.
 */
function redrawView(game) {
  redrawViewRows(game.world, game.cam.y, game.cam.x);
  const v = game.projState.v;
  v.d988 = (game.cam.y + 5 * 0x20) & 0xffff;
  v.d98a = game.cam.x & 0xffff;
  v.d98e = 0;
}

/**
 * $3790 SpeederScreen, level 2's RedrawView: the picture -- mountains, the
 * walkers' band, the ground -- from 06:$7b14, the radar's tiles from
 * 05:$7d5d, WY $7f; its `jp $638f` with $da4b comes on the caller's
 * timeline (`loading.speeder`).
 */
function speederScreen(game) {
  const { rom, video, regs } = game;
  video.bgMap.set(rawMap(rom).data);
  uploadTiles(video, 0x87b0, decodeTiles(decompress(rom, 5, 0x7d5d, 0x87b0).data));
  regs.WY = 0x7f;
}

/**
 * $15fc ClearScreen, as RestoreView's body ($0b90) runs it: tile $9000
 * blanked -- tile $00, which only the view past a row's end shows -- and
 * the BG map cleared (the window map too, $0b93; hudInit redraws it).
 */
function clearScreen(game) {
  game.video.tiles.fill(0, 0x100 * 64, 0x101 * 64);
  game.world.bg.fill(0);
}

/**
 * $0b43 RestoreView after a screen of its own: the level's tiles again
 * ($8800, and the bar's at $8ea0) -- so the animated tiles start over
 * from them ($0bf4) -- the bar's ends, the player's state ($1089), screen
 * position ($0a52) and frame ($04c3), the bar ($1144), then the level's
 * fade in ($da27, from `bgp`, where the screen left it); `then` as it
 * returns, the fade in done.
 */
function restoreView(game, bgp, fadeIn, then = null) {
  const { rom, video, p, objs } = game;
  uploadTiles(video, 0x8800, sceneTiles(rom, game.scene).pixels);
  // $0b20: the row cache emptied. The metatiles from the ROM again:
  // crumbled walls are whole.
  resetSceneState(game.world);
  restoreMetatiles(game.world);
  loadHudTiles(rom, video);
  hudInit(video.windowMap);
  // $0ba1..$0baf: SCX and SCY put on the camera.
  game.cam.scx = game.cam.x & 0xff;
  game.cam.scy = game.cam.y & 0xff;
  // $0b90 ClearScreen, $0bb9 RedrawView: the view's rows, through the row cache.
  clearScreen(game);
  if (p.da35 !== 2) redrawView(game);
  else speederScreen(game);
  game.tileRam = animatedTiles(video, game.level);
  const rider = objs.subarray(0x00, 0x20), mount = objs.subarray(0x20, 0x40);
  toRecord(p, rider);
  if (!p.da35) playerStateMachine(p, rider, rom, { objs });
  playerScreenPosition(p, rider, mount, { x: game.cam.x, y: game.cam.y }, rom);
  advanceAnimation(rider, rom);
  fromRecord(p, rider);
  refreshHud(game);
  // $0be5: RedrawView again, after the bar -- the lookups since may have
  // moved a row to another slot, and past a row's end it shows that one's.
  if (p.da35 !== 2) redrawView(game);
  else speederScreen(game);
  game.regs.BGP = bgp;
  // $0c30: the fade in, then $da8d |= $e3 (the window and sprites back).
  game.fadeIn = { table: fadeIn, f: 0, lcdc: game.regs.LCDC | 0xe3, then };
}

/** $0e76 -- the death message, then the continue prompt or a new game. */
function livesScreen(game) {
  const session = sessionOf(game.p);
  const [message, next] = afterDeath(session, game.rom);
  const restartLevel = () => startLevel(game, session.ff8b, session);
  // $01ae: a new game, through the title, which follows the last screen.
  const restartGame = (from) => { newGame(session); showTitle(game, from, () => startLevel(game, 1, session)); };
  const sc = dialogScreen(game.rom, scriptOf(game), message.a, message.hl, session.da89);
  // Both dialogs ($84, $c5) start music 4 and leave it playing.
  if (next.ev === 'newGame') {
    show(game, sc, { then: () => restartGame(sc), music: 0x04 });
    return;
  }
  show(game, sc, {
    music: 0x04,
    then: () => {
      const prompt = dialogScreen(game.rom, scriptOf(game), next.a, next.hl, session.da89);
      show(game, prompt, {
        music: 0x04,
        wait: false,
        prompt: { d98e: 0 },
        then: (answer) => (answer === 'newGame' ? restartGame(prompt) : restartLevel()),
      });
    },
  });
}

/** One frame of a screen: the fades, the wait, the continue prompt. */
function screenFrame(game) {
  const sc = game.screen;
  const { rom } = game;
  // A sequence (the title, the ending): one VBlank per displayed frame. A
  // dialog in it waits for a key while `cur.waiting`.
  if (sc.seq) {
    if (sc.seq.next().done) {
      game.screen = null;
      sc.then?.();
    }
    return;
  }
  // The fades ($15ae): the last value at f = 24, and what follows begins
  // in that same VBlank.
  if (sc.phase === 'in') {
    sc.regs.BGP = fadeAt(rom, FADE_IN, sc.f, 0xff);
    if (sc.f++ < 24) return;
    sc.phase = sc.prompt ? 'prompt' : sc.wait ? 'wait' : 'done';
    sc.f = 0;
  }
  if (sc.phase === 'wait') {
    // $164e: any button, held or not.
    if (!game.joy) return;
    sc.phase = 'out';
    return;
  }
  if (sc.phase === 'prompt') {
    // $0eb1: a pass every 10 VBlanks; the first reads no key.
    if (sc.next-- > 0) return;
    sc.next = 9;
    const { draw, answer } = promptStep(sc.prompt, game.joy, !sc.passed);
    sc.passed = true;
    for (const ptr of draw) drawStream(sc.video.bgMap, rom, sc.text, ptr);
    if (!answer) return;
    sc.answer = answer;
    sc.phase = 'out';
    return;
  }
  if (sc.phase === 'out') {
    sc.regs.BGP = fadeAt(rom, FADE_OUT, sc.f, sc.regs.BGP);
    if (sc.f++ < 24) return;
    sc.phase = 'done';
  }
  if (sc.phase === 'done') {
    game.screen = null;
    sc.then?.(sc.answer);
  }
}

/** Called once per displayed frame; runs a game step when one is due. */
export function tick(game) {
  const stepped = step(game);
  // The VBlank handler's driver update ($0254, $0257), every frame.
  if (game.sound) game.onSamples?.(game.sound.frame());
  return stepped;
}

function step(game) {
  // $da8d, as the VBlank handler applies it: a VBlank after it was set.
  if (game.lcdcNext !== null && game.lcdcNext !== undefined) {
    game.regs.LCDC = game.lcdcNext;
    game.lcdcNext = null;
  }
  if (game.musicDue && !game.screen) {
    game.musicDue = false;
    startLevelMusic(game);
  }
  if (game.screen) {
    screenFrame(game);
    return true;
  }
  if (game.levelFade) {
    levelFadeStep(game);
    return true;
  }
  if (game.loading) {
    // LevelStart's time: the screen white (BGP $ff, as the last fade left it).
    const ld = game.loading;
    if (++ld.f === ld.music) startLevelMusic(game);
    // Level 2's RedrawView, SpeederScreen: the level's music again.
    if (ld.speeder?.includes(ld.f)) playMusic(game, game.levelMusic);
    if (ld.f < ld.fade) return true;
    game.loading = null;
  }
  if (game.fadeIn) {
    // $0c30: the level's own fade in ($da27).
    const f = game.fadeIn;
    game.regs.BGP = fadeAt(game.rom, f.table, f.f, game.regs.BGP);
    if (f.f++ < 24) return true;
    // The last value at 24; play goes on in the same VBlank, and the
    // VBlank handler applies the new LCDC at the next ($0c33).
    game.fadeIn = null;
    game.lcdcNext = f.lcdc;
    f.then?.();
  }
  if (game.paused) {
    // $0843: in a vehicle, START only waits -- all keys up ($165b), then
    // any key ($164e) -- spinning on the joypad, no frame wait: the next
    // step begins the moment a key is seen, and its own wait has nothing
    // to wait for ($da90 is from before).
    if (game.paused === 'release' && !game.joy) game.paused = 'press';
    else if (game.paused === 'press' && game.joy) {
      game.paused = null;
      game.nextStep = game.frame;
      game.stepAt = game.frame * LINES;
      game.freshWait = true;
    }
    if (game.paused) return true;
  }
  if (game.frame++ < game.nextStep) return false;
  if (game.dying) {
    if (game.dying.fade !== undefined) {
      game.nextStep += 1;
      deathFade(game);
    } else {
      game.nextStep += 2;
      deathStep(game);
    }
    return true;
  }
  if (game.afterShot) {
    afterShotStep(game);
    return true;
  }
  if (game.ending) {
    game.nextStep += 2;
    endingStep(game);
    return true;
  }
  // The step's start on the scanline clock (timing.js); the next step's
  // VBlank is set once its work is known (timeStep) -- two on, if it ends
  // some other way.
  const start = game.stepAt ?? game.nextStep * LINES + RESUME;
  game.stepAt = null;
  game.nextStep += 2;
  game.steps++;
  game.world.lookups = 0;
  game.streams = 0;
  game.walkers = 0;
  if (loopHead(game)) return true;
  const { p } = game;
  try {
    if (FALCON_LEVELS.has(p.da35)) falconStep(game);
    else if (p.da35 === 0x02) speederPlayStep(game);
    else {
      playerStep(p, { world: game.world, rom: game.rom, io: game.io });
      afterStep(game);
    }
  } catch (e) {
    if (e instanceof WalkerArrived) {
      // $2cc5: a walker at the base -- the dialog, then the lives screen.
      game.queued.push(() => showDialog(game, 0x84, 0xcd25, () => livesScreen(game)));
      return true;
    }
    if (e instanceof WalkersDown) {
      // $1580: all walkers down -- the next level, at once.
      const session = sessionOf(p);
      game.queued.push(() => startLevel(game, session.ff8b, session));
      for (const run of game.queued.splice(0)) if (!game.screen && !game.levelFade) run();
      return true;
    }
    if (!(e instanceof Died)) throw e;
    game.dying = { b: deathCount(p) };
  }
  if (!game.dying) timeStep(game, start);
  refreshHud(game);
  // Dialogs and level ends met during the step, in order.
  for (const run of game.queued.splice(0)) if (!game.screen && !game.levelFade) run();
  return true;
}

/**
 * $044d -- when the next step begins: this one's work by the cost model
 * (timing.js) from what it did -- the sprite tiles DrawAllObjects will copy,
 * the active objects and shots, the map streaming, the tile lookups, the
 * walkers drawn -- and the rule.
 */
function timeStep(game, start) {
  let objs = 0, shots = 0, pshots = 0;
  for (let i = 1; i <= 30; i++) if (game.objs[i * OBJ_SIZE]) objs++;
  for (let i = 31; i < OBJ_SLOTS; i++) {
    const t = game.objs[i * OBJ_SIZE];
    // The player's shots (the blaster's types 1--3) cost more: timing.js.
    if (t) { shots++; if (t <= 3) pshots++; }
  }
  const tiles = drawAllObjects(game).oam.length;
  const work = stepWork(game.level, { tiles, objs, shots, pshots, streams: game.streams, lookups: game.world.lookups, walkers: game.walkers });
  const t = nextStart(start, work, game.freshWait);
  game.freshWait = false;
  game.nextStep = Math.floor(t / LINES);
  game.stepAt = t;
}

/**
 * $065a..$068e -- the main loop's head: the level's music again when the
 * boss's tune has ended, the joypad ($1623: `game.joy`), the aim, START,
 * the step counter, the animated tiles. True when START took the step
 * (its screen, or in a vehicle the wait).
 */
export function loopHead(game) {
  // $065a: when the boss's tune has ended, the level's again.
  if (game.objState.da83 && game.sound?.tuneEnded) {
    playMusic(game, game.levelMusic);
    game.sound.tuneEnded = 0;
  }
  const { p } = game;
  p.joy = game.joy;
  // $0676: the last d-pad direction held is the aim ($da25).
  if (p.joy & 0x0f) p.da25 = p.joy & 0x0f;
  // $067f: START, held, leaves the step for its screen (then $065a).
  if (p.joy & JOY.START) {
    if (p.da35) game.paused = 'release';
    else startScreen(game);
    return true;
  }
  p.tick = (p.tick + 1) & 0xff;              // $0688, before the player update
  // $068b: the animated tiles.
  animateTiles(p.ff8b, p.tick, game.tileRam, (addr, bytes) => uploadTiles(game.video, addr, decodeTiles(bytes)));
  return false;
}

/**
 * $02d3 DrawAllObjects: every active, visible record from $c300, in order;
 * tiles streamed into sprite slots from `slot` (the game's $d993).
 * Returns { oam, tiles } (drawObject's).
 */
export function drawAllObjects(game, slot = 0) {
  const { objs, rom } = game;
  const oam = [], tiles = {}, next = { slot };
  for (let i = 0; i < OBJ_SLOTS; i++) {
    const o = objs.subarray(i * OBJ_SIZE, (i + 1) * OBJ_SIZE);
    if (!o[0] || (o[0] & 0x80) || (!o[0x06] && !o[0x07])) continue;
    if (!drawObject(o, rom, oam, tiles, next, (a) => game.dac1[a - 0xdac1] ?? 0)) break;
  }
  return { oam, tiles };
}

/** BG tile number at a tile position, through the metatile map. */
function bgTileAt(map, tx, ty) {
  const row = map.rows[ty >> 2];
  if (!row || tx < 0 || (tx >> 2) >= row.length) return 0;
  const byte = row[tx >> 2];
  const sub = (ty & 3) * 4 + (tx & 3);
  const t = (byte & 0xe0) === 0xe0 ? map.metatilesHigh[(byte - 0xe0) * 16 + sub] : map.metatiles[byte * 16 + sub];
  return t ?? 0;
}

/** Draw the level around the camera, then the player's sprites. */
export function render(game, fb, palette) {
  if (game.screen) {
    renderFrame(fb, game.screen.video, game.screen.regs, { palette });
    return;
  }
  const { map, video, regs, rom } = game;
  const { cam } = game;
  const speeder = game.level === SPEEDER_LEVEL;
  if (speeder) {
    // Level 2's picture stays where it is; the walkers are drawn into it
    // ($14a7: Bank 1 images, their tiles where the game puts them).
    for (const pic of game.pictures.splice(0)) {
      const rec = { mapPtr: rom.word(1, pic.record), tilePtr: rom.word(1, pic.record + 2) };
      uploadTiles(video, pic.tiles, decodeTiles(decompress(rom, 1, rec.tilePtr, pic.tiles).data));
      const at = pic.map - 0x9800;
      for (let r = 0; r < pic.h; r++) {
        for (let c = 0; c < pic.w; c++) video.bgMap[(at + r * 32 + c) & 0x3ff] = rom.byte(1, rec.mapPtr + r * pic.w + c);
      }
    }
  } else {
    // Refill the 32 x 32 background ring around the camera, as the game's
    // streaming does when it scrolls, then let SCX/SCY pick the view.
    const tx0 = cam.x >> 3, ty0 = cam.y >> 3;
    for (let ty = ty0; ty < ty0 + 19; ty++) {
      for (let tx = tx0; tx < tx0 + 21; tx++) {
        // Past a row's end: what RedrawView or the streaming wrote there.
        const cell = (ty & 31) * 32 + (tx & 31);
        video.bgMap[cell] = (tx >> 2) >= map.width ? game.world.bg[cell] : bgTileAt(map, tx, ty);
      }
    }
  }
  regs.SCX = cam.scx;
  regs.SCY = speeder ? 0 : cam.scy;
  // Pickups ($32ba): drawn into the background, 2 x 2 tiles $f2..$f5,
  // whose graphics each item reloads from its animation table -- so all
  // visible items share the last-loaded picture, as in the game.
  for (const o of game.objState.bgItems) {
    const src = o[0x0a] | (o[0x0b] << 8);
    const gfx = Uint8Array.from({ length: 64 }, (_, i) => rom.byte(4, src + i));
    uploadTiles(video, 0x8f20, decodeTiles(gfx));
    const tx = (o[0x0c] >> 3) & 31, ty = (((o[0x0e] - 8) & 0xff) >> 3) & 31;
    video.bgMap[ty * 32 + tx] = 0xf2;
    video.bgMap[ty * 32 + ((tx + 1) & 31)] = 0xf3;
    video.bgMap[((ty + 1) & 31) * 32 + tx] = 0xf4;
    video.bgMap[((ty + 1) & 31) * 32 + ((tx + 1) & 31)] = 0xf5;
  }
  const { oam, tiles } = drawAllObjects(game);
  for (const [slot, bytes] of Object.entries(tiles)) uploadTiles(video, 0x8000 + slot * 16, decodeTiles(bytes));
  video.oam = oam;
  if (speeder) {
    // $0238 / $0292 with level 2's table ($02cc): the mountains at camera
    // / 8, from line $18 the walkers' band at $da3c ($044d copies it to
    // $d9a1), from $5f the ground at the camera, from $7f the window and
    // the radar's sprites ($c100).
    const radar = [];
    for (let i = 0; i < 10; i++) {
      const e = game.radar.subarray(i * 4, i * 4 + 4);
      radar.push({ y: e[0], x: e[1], tile: e[2], flags: e[3] });
    }
    const v = game.projState.v;
    renderFrame(fb, video, regs, {
      palette,
      onScanline: (ly, r) => {
        if (ly === 0) { r.SCX = cam.scx; video.oam = oam; } else if (ly === 0x18) r.SCX = v.da3c ?? 0;
        else if (ly === 0x5f) r.SCX = v.d9a3 ?? 0;
        else if (ly === 0x7f) { r.SCX = 0; video.oam = radar; }
      },
    });
    video.oam = oam;
    return;
  }
  // $0292: sprites off from line $87, under the status bar.
  renderFrame(fb, video, regs, {
    palette,
    onScanline: (ly, r) => {
      if (ly === 0) r.LCDC |= 0x02;
      else if (ly === HUD_LINE) r.LCDC &= ~0x02;
    },
  });
  regs.LCDC |= 0x02;
}

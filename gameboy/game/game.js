/*
 * game.js -- Star Wars: The Empire Strikes Back as a handheld-player
 * cartridge (handheld-player's README §4, "The game contract").
 *
 * The port runs as it does on the page (web/src/main.js): play.js from
 * power-on -- the boot screens, the title, level 1, on through every level
 * and the ending into the title again -- one tick per Game Boy VBlank at
 * the Game Boy's rate (pace.js), whatever the display's, and the game's own
 * sound driver into Web Audio. The handheld owns the keys and passes its
 * buttons in: W A S D the pad, Enter START, Backspace SELECT, O the A
 * button, P the B button (its KEYMAP).
 *
 * A classic script, as the handheld wants: attachGame is there at once, the
 * port's modules come by import() from ./empire/, the ROM from the player's
 * own file: chosen once, kept in this browser's IndexedDB, never uploaded
 * and never part of the site.
 *
 * Installed by empire-gb/tools/handheld.mjs; edit it in empire-gb.
 */
(function () {
  const here = document.currentScript ? document.currentScript.src : location.href;
  const at = (path) => new URL(path, here).href;

  /** The player's own ROM, kept in this browser only (IndexedDB). */
  const cartridge = {
    open() {
      return new Promise((ok, no) => {
        const q = indexedDB.open('gameboy-cartridge', 1);
        q.onupgradeneeded = () => q.result.createObjectStore('rom');
        q.onsuccess = () => ok(q.result);
        q.onerror = () => no(q.error);
      });
    },
    async get() {
      try {
        const db = await this.open();
        return await new Promise((ok) => {
          const q = db.transaction('rom').objectStore('rom').get('current');
          q.onsuccess = () => ok(q.result ? new Uint8Array(q.result) : null);
          q.onerror = () => ok(null);
        });
      } catch (e) { return null; }
    },
    async put(bytes) {
      try {
        const db = await this.open();
        await new Promise((ok, no) => {
          const t = db.transaction('rom', 'readwrite');
          t.objectStore('rom').put(bytes.buffer.slice(0), 'current');
          t.oncomplete = ok; t.onerror = () => no(t.error);
        });
      } catch (e) { console.warn('cartridge not kept:', e.message); }
    },
  };

  // INSERT CARTRIDGE: one hidden file input. The desktop panel has its own
  // button (window.gameboyInsert); where there is none (phones) and while
  // there is no ROM, a pill button over the page opens it.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.gb,.gbc';
  fileInput.hidden = true;
  window.gameboyInsert = () => fileInput.click();
  const picker = document.createElement('button');
  picker.type = 'button';
  picker.textContent = 'INSERT CARTRIDGE';
  picker.style.cssText = 'position:fixed;left:50%;top:max(16px,env(safe-area-inset-top));transform:translateX(-50%);z-index:50;display:none;min-height:40px;padding:0 18px;border:0;border-radius:999px;background:#2b2b2e;color:#fff;font:600 13px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3)';
  picker.addEventListener('click', window.gameboyInsert);
  document.addEventListener('DOMContentLoaded', () => document.body.append(fileInput, picker));
  const showPicker = (on) => { picker.style.display = on ? 'block' : 'none'; };

  window.attachGame = function ({ canvas }) {
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(160, 144);
    const fb = new Uint32Array(160 * 144);
    // What the modules and the ROM give, once loaded; an error to show.
    let port = null, failed = null;
    let game = null, pacer = null, audio = null, joy = 0, playing = false;

    const load = async () => {
      const [play, rom, assets, ppu, pace, sound, out, physics] = await Promise.all(
        ['play.js', 'rom.js', 'assets.js', 'ppu.js', 'pace.js', 'audio.js', 'audioout.js', 'physics.js']
          .map((f) => import(at('empire/' + f))));
      const bytes = await cartridge.get();
      if (!bytes) { showPicker(true); throw new Error('No cartridge. Use INSERT CARTRIDGE and choose your own .gb file.'); }
      const r = new rom.Rom(bytes);
      const problems = r.validate();
      if (problems.length) console.warn('ROM:', problems.join('; '));
      showPicker(false);
      port = { play, ppu, pace, sound, out, JOY: physics.JOY, rom: r, scenes: assets.readScenes(r) };
    };
    // Loaded with the page; if that failed, again at the next power-on.
    const attempt = () => load().catch((e) => { failed = e.message; console.error(e); });
    let loaded = attempt();

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      await cartridge.put(bytes);
      failed = null;
      loaded = attempt();
      if (playing) begin();
    });

    // For a test driving the player in a browser (web/test/handheldcheck.mjs).
    window.empireCartridge = { canvas, updates: 0, get game() { return game; }, get audio() { return audio; }, get failed() { return failed; } };

    const BUTTONS = { up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', a: 'A', b: 'B', select: 'SELECT', start: 'START' };

    /** A line of text on the screen, for a ROM missing or still loading. */
    function message(text) {
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(0, 0, 160, 144);
      ctx.fillStyle = '#101010';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      const words = text.split(' '), lines = [''];
      for (const w of words) {
        if ((lines[lines.length - 1] + ' ' + w).trim().length > 24) lines.push(w);
        else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + w).trim();
      }
      lines.forEach((l, i) => ctx.fillText(l, 80, 72 - (lines.length - 1) * 5 + i * 10));
    }

    /** Power on: a new game from the boot screens, as the cartridge does. */
    async function begin() {
      await loaded;
      if (!port || !playing) return;
      const { play, sound, out, pace } = port;
      // Built whole before it is set: update() runs every frame meanwhile.
      const g = play.createGame(port.rom, port.scenes[0]);
      // The handheld's PRESS START is the gesture that lets audio start.
      try {
        audio = audio || await out.AudioOut.create();
        await audio.ctx.resume();
      } catch (e) {
        console.warn('no sound:', e.message);
      }
      if (!playing) return;
      if (audio) {
        g.sound = new sound.GameSound(port.rom.bytes, audio.rate);
        g.onSamples = (s) => audio.push(s);
      }
      play.powerOn(g);
      g.joy = joy;
      pacer = pace.createPacer(performance.now());
      game = g;
    }

    return {
      start() {
        playing = true;
        joy = 0;
        if (failed) { failed = null; loaded = attempt(); }
        begin();
      },
      update() {
        window.empireCartridge.updates++;
        if (failed) return message(failed);
        if (!game) return message('loading...');
        const n = port.pace.ticksDue(pacer, performance.now());
        // The handheld's sound switch mutes the game too.
        if (audio) audio.muted = !!(window.handheld && window.handheld.state && window.handheld.state.soundOn === false);
        for (let i = 0; i < n; i++) port.play.tick(game);
        port.play.render(game, fb, port.ppu.PALETTE_GREY);
        port.ppu.toImageData(fb, image);
        ctx.putImageData(image, 0, 0);
      },
      onInput(button, isDown) {
        const bit = port ? port.JOY[BUTTONS[button]] : 0;
        if (!bit) return;
        joy = isDown ? joy | bit : joy & ~bit;
        if (game) game.joy = joy;
      },
      stop() {
        // Powered off: the game is gone, as with a real cartridge.
        playing = false;
        game = null;
        if (audio) audio.ctx.suspend();
      },
    };
  };
})();

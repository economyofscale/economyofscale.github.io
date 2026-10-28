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
 * port's modules come by import() from ./empire/, the ROM from ../rom.gb
 * (gbexmp/rom.gb), loaded by itself when PRESS START is pressed.
 *
 * Installed by empire-gb/tools/handheld.mjs; edit it in empire-gb.
 */
(function () {
  const here = document.currentScript ? document.currentScript.src : location.href;
  const at = (path) => new URL(path, here).href;

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
      const res = await fetch(at('../rom.gb'));
      if (!res.ok) throw new Error('No cartridge: put a ROM at gbexmp/rom.gb');
      const r = new rom.Rom(new Uint8Array(await res.arrayBuffer()));
      const problems = r.validate();
      if (problems.length) { console.warn('ROM:', problems.join('; ')); throw new Error('Unsupported cartridge'); }
      port = { play, ppu, pace, sound, out, JOY: physics.JOY, rom: r, scenes: assets.readScenes(r) };
    };
    // Loaded with the page; if that failed, again at the next power-on.
    const attempt = () => load().catch((e) => { failed = e.message; console.error(e); });
    let loaded = attempt();

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

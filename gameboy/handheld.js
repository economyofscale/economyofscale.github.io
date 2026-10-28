/*
 * handheld.js — 3D handheld game player (Three.js r128, classic script, no build step)
 * Core logic exported from the "Handheld Game Player" design canvas.
 * Your game plugs in through window.attachGame (see game/game.js and README.md).
 */
class MiniLogic {
  constructor(props) { this.props = props || {}; this.state = {}; }
  setState(update) {
    const patch = typeof update === 'function' ? update(this.state, this.props) : update;
    this.state = Object.assign({}, this.state, patch);
    if (typeof this.render === 'function') this.render();
  }
}

class HandheldCore extends MiniLogic {
  constructor(...args) {
    super(...args);
    this.state = { mode: 'IDLE', pressingStart: false, freeView: false, pressed: {}, soundOn: true, lcdFx: true, focused: false };
    this.mode = 'IDLE';
    this.held = {};
    this.BUTTONS = ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start'];
    this.KEYMAP = {
      KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
      KeyO: 'a', KeyP: 'b', Backspace: 'select', Enter: 'start'
    };
    this.ROWS = [
      { id: 'up', label: 'Up', k1: 'W', k2: '', kind: 'dir', rot: 0, aria: 'Up: W' },
      { id: 'down', label: 'Down', k1: 'S', k2: '', kind: 'dir', rot: 180, aria: 'Down: S' },
      { id: 'left', label: 'Left', k1: 'A', k2: '', kind: 'dir', rot: 270, aria: 'Left: A' },
      { id: 'right', label: 'Right', k1: 'D', k2: '', kind: 'dir', rot: 90, aria: 'Right: D' },
      { id: 'a', label: 'A', k1: 'O', k2: '', kind: 'round', letter: 'A', aria: 'A button: O' },
      { id: 'b', label: 'B', k1: 'P', k2: '', kind: 'round', letter: 'B', aria: 'B button: P' },
      { id: 'select', label: 'Select', k1: 'Bksp', k2: '', kind: 'pill', aria: 'Select: Backspace' },
      { id: 'start', label: 'Start', k1: 'Enter', k2: '', kind: 'pill', aria: 'Start: Enter' }
    ];
    this.setRoot = (el) => { this.rootEl = el; };
    this.setStage = (el) => { this.stageEl = el; };
    this.setCanvas = (el) => { this.canvasEl = el; };
    this.rowDown = {};
    this.rowUp = {};
    this.BUTTONS.forEach((b) => {
      this.rowDown[b] = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this.focusRoot();
        this.ensureAudio();
        this.setHeld(b, 'legend' + (e && e.pointerId != null ? e.pointerId : ''), true);
      };
      this.rowUp[b] = (e) => this.setHeld(b, 'legend' + (e && e.pointerId != null ? e.pointerId : ''), false);
    });
    this.onKeyDown = (e) => this.handleKey(e, true);
    this.onKeyUp = (e) => this.handleKey(e, false);
    this.onFocus = () => { if (!this.state.focused) this.setState({ focused: true }); };
    this.onBlur = (e) => {
      const rt = e && e.relatedTarget;
      if (rt && this.rootEl && this.rootEl.contains(rt)) return;
      this.releaseAll();
      this.setState({ focused: false });
    };
    this.powerOn = () => this.startPowerOn();
    this.toggleSound = () => this.setState((s) => ({ soundOn: !s.soundOn }));
    this.toggleFx = () => this.setState((s) => ({ lcdFx: !s.lcdFx }));
    this.toggleView = () => this.setView(!this.state.freeView);
    this.powerOff = () => this.doPowerOff();
  }

  // taps on the 3D device itself: power switch and sound wheel
  deviceAction(a) {
    if (a === 'power') {
      if (this.mode === 'IDLE') this.startPowerOn();
      else if (this.mode === 'PLAYING') this.doPowerOff();
    } else if (a === 'sound') {
      this.setState((s) => ({ soundOn: !s.soundOn }));
      if (this.three) this.three.spinWheel();
      if (this.props.haptics && navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
      this.playClick(1500, 0.08, 0.03);
    }
  }

  doPowerOff() {
    if (this.mode !== 'PLAYING' || !this.three) return;
    this.releaseAll();
    if (this.game && typeof this.game.stop === 'function') this.game.stop();
    this.mode = 'IDLE';
    this.three.powerOff();
    this.setState({ mode: 'IDLE', freeView: false });
  }

  componentDidMount() { this.initScene(); }

  componentDidUpdate(prev) {
    if (this.three && prev.gameTitle !== this.props.gameTitle) this.three.drawTitles();
  }

  componentWillUnmount() {
    clearTimeout(this.initTimer);
    clearTimeout(this.pressTimer);
    if (this.three) this.three.dispose();
    if (this.actx) { try { this.actx.close(); } catch (err) {} }
  }

  title() {
    const t = this.props.gameTitle ?? '[GAME TITLE]';
    return String(t).trim() || '[GAME TITLE]';
  }

  focusRoot() {
    const r = this.rootEl;
    if (r && !r.contains(document.activeElement)) { try { r.focus({ preventScroll: true }); } catch (err) {} }
  }

  handleKey(e, down) {
    const t = e.target;
    const isNative = t && t.getAttribute && t.getAttribute('data-native');
    if (isNative && (e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter')) return;
    const b = this.KEYMAP[e.code];
    if (!b) return;
    e.preventDefault();
    if (down && e.repeat) return;
    if (down) this.ensureAudio();
    this.setHeld(b, 'key:' + e.code, down);
  }

  setHeld(b, src, down) {
    const s = this.held[b] || (this.held[b] = new Set());
    const was = s.size > 0;
    if (down) s.add(src); else s.delete(src);
    const is = s.size > 0;
    if (was !== is) this.applyButton(b, is);
  }

  applyButton(b, is) {
    if (is) this.playClick(b === 'a' || b === 'b' ? 2300 : (b === 'select' || b === 'start') ? 3000 : 1900, 0.045, 0.025);
    if (is && this.props.haptics && navigator.vibrate) { try { navigator.vibrate(8); } catch (err) {} }
    if (this.mode === 'PLAYING' && this.game) this.game.onInput(b, is);
    this.setState((s) => ({ pressed: Object.assign({}, s.pressed, { [b]: is }) }));
  }

  isHeld(b) { const s = this.held[b]; return !!(s && s.size); }

  releaseAll() {
    this.BUTTONS.forEach((b) => {
      const s = this.held[b];
      if (s && s.size) { s.clear(); this.applyButton(b, false); }
    });
  }

  ensureAudio() {
    if (!this.actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { try { this.actx = new AC(); } catch (err) {} }
    }
    if (this.actx && this.actx.state === 'suspended') this.actx.resume();
  }

  playClick(freq, vol, dur) {
    const ctx = this.actx;
    if (!this.state.soundOn || !ctx) return;
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(bp); bp.connect(g); g.connect(ctx.destination);
    src.start();
  }

  startPowerOn() {
    if (this.mode !== 'IDLE' || !this.three) return;
    this.ensureAudio();
    this.focusRoot();
    this.mode = 'POWERING_ON';
    this.three.beginPowerOn();
    this.setState({ mode: 'POWERING_ON', pressingStart: true });
    this.pressTimer = setTimeout(() => this.setState({ pressingStart: false }), 300);
  }

  setView(free) {
    this.setState({ freeView: free });
    if (this.three) this.three.setFreeView(free);
  }

  // ------------------------------------------------------------------
  // GAME HOOK. Replace this method's body with your own game.
  // Contract: draw into `canvas` (160x144) and return
  //   { start(), update(dt), onInput(button, isDown) }
  // button is one of: up, down, left, right, a, b, select, start
  // ------------------------------------------------------------------
  attachGame(opts) {
    if (typeof window.attachGame === 'function') {
      return window.attachGame(Object.assign({ title: this.title(), click: (f, v, d) => this.playClick(f, v, d) }, opts));
    }
    return this.demoGame(opts);
  }

  // Built-in fallback demo (used only when game/game.js does not define window.attachGame)
  demoGame({ canvas }) {
    const self = this;
    const g = canvas.getContext('2d');
    const W = 160, H = 144, GY = 120;
    const C = ['#EEEEEE', '#A8A8A8', '#585858', '#181818'];
    const BLOB = [
      '....3333....',
      '..33000033..',
      '.3000000003.',
      '.3003003003.',
      '300030030003',
      '301000000103',
      '300000000003',
      '300003300003',
      '.3000000003.',
      '.3000000003.',
      '..33000033..',
      '....3333....'
    ];
    const st = { phase: 'title', t: 0, scroll: 0, py: 0, vy: 0, held: {}, got: new Set(), score: 0, paused: false, face: 1 };
    function sprite(map, x, y, flip) {
      for (let r = 0; r < map.length; r++) {
        const row = map[r];
        for (let c = 0; c < row.length; c++) {
          const ch = row[flip ? row.length - 1 - c : c];
          if (ch === '.') continue;
          g.fillStyle = C[+ch];
          g.fillRect(x + c, y + r, 1, 1);
        }
      }
    }
    function text(s, x, y, col, align) {
      g.fillStyle = col;
      g.font = '8px "Press Start 2P", monospace';
      g.textBaseline = 'top';
      g.textAlign = align || 'center';
      g.fillText(s, x, y);
    }
    function wrap(s, max) {
      const words = s.toUpperCase().split(/\s+/);
      const lines = [];
      let cur = '';
      words.forEach((w) => {
        if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; }
        else cur = (cur + ' ' + w).trim();
      });
      if (cur) lines.push(cur);
      return lines.slice(0, 4);
    }
    function coinAt(k) { return { x: k * 44 + 30, h: 14 + ((k * 37) % 3) * 9 }; }
    function draw() {
      g.fillStyle = C[0];
      g.fillRect(0, 0, W, H);
      const s = st.scroll;
      g.fillStyle = C[1];
      for (let x = 0; x < W; x++) {
        const u = x + s * 0.3;
        const h = 16 + 7 * Math.sin(u * 0.045) + 5 * Math.sin(u * 0.12 + 1.3);
        g.fillRect(x, GY - h, 1, h);
      }
      g.fillStyle = C[1];
      g.fillRect(0, GY, W, H - GY);
      g.fillStyle = C[3];
      g.fillRect(0, GY, W, 1);
      g.fillStyle = C[2];
      for (let row = 0; row < 3; row++) {
        const y = GY + 1 + row * 8;
        g.fillRect(0, y + 7, W, 1);
        const off = ((-s) % 16 + 16) % 16 + (row % 2 ? 8 : 0);
        for (let x = off - 16; x < W; x += 16) g.fillRect(x, y, 1, 7);
      }
      if (st.phase === 'play') {
        const k0 = Math.floor((s - 20) / 44), k1 = Math.ceil((s + W) / 44);
        for (let k = k0; k <= k1; k++) {
          if (st.got.has(k)) continue;
          const c = coinAt(k);
          const cx = Math.round(c.x - s), cy = GY - c.h - 6;
          g.fillStyle = C[3]; g.fillRect(cx + 1, cy, 4, 6); g.fillRect(cx, cy + 1, 6, 4);
          g.fillStyle = C[0]; g.fillRect(cx + 2, cy + 1, 2, 4);
        }
      }
      const px = st.phase === 'title' ? 74 : 52;
      sprite(BLOB, px, Math.round(GY - 12 - st.py), st.face < 0);
      if (st.phase === 'title') {
        const lines = wrap(self.title(), 17);
        const y0 = 30 - (lines.length - 1) * 6;
        lines.forEach((ln, i) => text(ln, 80, y0 + i * 12, C[3]));
        if (Math.floor(st.t * 2) % 2 === 0) text('PRESS START', 80, 72, C[2]);
      } else {
        text('SCORE ' + String(st.score).padStart(4, '0'), 6, 6, C[3], 'left');
        if (st.paused) {
          g.fillStyle = C[0]; g.fillRect(44, 54, 72, 20);
          g.fillStyle = C[3]; g.fillRect(44, 54, 72, 1); g.fillRect(44, 73, 72, 1);
          text('PAUSE', 80, 60, C[3]);
        }
      }
    }
    return {
      start() { st.phase = 'title'; st.t = 0; st.scroll = 0; st.py = 0; st.vy = 0; },
      onInput(b, down) {
        st.held[b] = down;
        if (!down) return;
        if (st.phase === 'title') {
          if (b === 'start' || b === 'a') { st.phase = 'play'; st.score = 0; st.got = new Set(); st.py = 0; st.vy = 0; }
          return;
        }
        if (b === 'start') st.paused = !st.paused;
        if (!st.paused && (b === 'a' || b === 'up') && st.py === 0) st.vy = 165;
      },
      update(dt) {
        st.t += dt;
        if (st.phase === 'title') {
          st.scroll += 18 * dt;
          st.py = Math.abs(Math.sin(st.t * 3.2)) * 22;
        } else if (!st.paused) {
          const sp = st.held.b ? 90 : 55;
          if (st.held.right) { st.scroll += sp * dt; st.face = 1; }
          if (st.held.left) { st.scroll -= sp * dt; st.face = -1; }
          st.vy -= 430 * dt;
          st.py = Math.max(0, st.py + st.vy * dt);
          if (st.py === 0 && st.vy < 0) st.vy = 0;
          const k0 = Math.floor((st.scroll + 40) / 44), k1 = k0 + 2;
          for (let k = k0 - 1; k <= k1; k++) {
            if (st.got.has(k)) continue;
            const c = coinAt(k);
            const cx = c.x - st.scroll, cy = c.h + 6;
            if (cx > 46 && cx < 64 && st.py + 12 > c.h && st.py < cy) { st.got.add(k); st.score += 10; self.playClick(4200, 0.03, 0.04); }
          }
        }
        draw();
      }
    };
  }

  initScene() {
    const T = window.THREE;
    if (!T || !this.canvasEl || !this.stageEl) { this.initTimer = setTimeout(() => this.initScene(), 80); return; }
    const self = this;
    const canvas = this.canvasEl;
    const stage = this.stageEl;
    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const accent = this.props.accent ?? '#7A3E6E';

    const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputEncoding = T.sRGBEncoding;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(30, 1, 1, 120);
    camera.layers.enable(1);

    // studio environment for metal reflections
    const pmrem = new T.PMREMGenerator(renderer);
    const envScene = new T.Scene();
    const box = new T.BoxGeometry(1, 1, 1);
    const room = new T.Mesh(box, new T.MeshBasicMaterial({ color: 0x5c5c60, side: T.BackSide }));
    room.scale.set(30, 20, 30);
    envScene.add(room);
    function softbox(x, y, z, sx, sy, sz, k) {
      const m = new T.MeshBasicMaterial({ color: 0xffffff });
      m.color.setScalar(k);
      const o = new T.Mesh(box, m);
      o.position.set(x, y, z); o.scale.set(sx, sy, sz);
      envScene.add(o);
    }
    softbox(0, 9.6, 0, 14, 0.2, 7, 4.5);
    softbox(-14.6, 2, 5, 0.2, 9, 7, 3.2);
    softbox(14.6, 3, -4, 0.2, 7, 9, 2.2);
    softbox(0, 2, 14.6, 12, 6, 0.2, 1.6);
    softbox(0, -9.8, 0, 26, 0.2, 26, 0.5);
    const envRT = pmrem.fromScene(envScene, 0.04);
    scene.environment = envRT.texture;

    scene.add(new T.HemisphereLight(0xffffff, 0x8a8a8a, 0.35));
    const key = new T.DirectionalLight(0xffffff, 1.15);
    key.position.set(-5, 15, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -9; key.shadow.camera.right = 9;
    key.shadow.camera.top = 9; key.shadow.camera.bottom = -9;
    key.shadow.camera.near = 1; key.shadow.camera.far = 45;
    key.shadow.bias = -0.0006;
    scene.add(key);
    const rim = new T.DirectionalLight(0xffffff, 0.35);
    rim.position.set(8, 3, -8);
    scene.add(rim);

    const GROUND = -6.6;
    const ground = new T.Mesh(new T.PlaneGeometry(60, 60), new T.ShadowMaterial({ opacity: 0.14 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = GROUND; ground.receiveShadow = true;
    scene.add(ground);

    // helpers
    function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    function texFrom(c, srgb) {
      const t = new T.CanvasTexture(c);
      if (srgb !== false) t.encoding = T.sRGBEncoding;
      t.anisotropy = maxAniso;
      return t;
    }
    const blobC = mkCanvas(256, 128);
    (function () {
      const g = blobC.getContext('2d');
      const gr = g.createRadialGradient(128, 64, 4, 128, 64, 120);
      gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.setTransform(1, 0, 0, 0.5, 0, 32);
      g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    })();
    const blob = new T.Mesh(new T.PlaneGeometry(13, 6.5), new T.MeshBasicMaterial({ map: texFrom(blobC), transparent: true, depthWrite: false, opacity: 0.55 }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = GROUND + 0.01;
    scene.add(blob);

    function rr(w, h, r) {
      r = Math.max(0.0005, Math.min(r, w / 2 - 0.0001, h / 2 - 0.0001));
      const s = new T.Shape(), x = -w / 2, y = -h / 2;
      s.moveTo(x + r, y);
      s.lineTo(x + w - r, y);
      s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
      s.lineTo(x + w, y + h - r);
      s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
      s.lineTo(x + r, y + h);
      s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
      s.lineTo(x, y + r);
      s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
      return s;
    }
    function slab(w, h, r, t, b) {
      const geo = new T.ExtrudeGeometry(rr(w - 2 * b, h - 2 * b, r - b), {
        depth: Math.max(0.001, t - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 4, curveSegments: 24
      });
      geo.translate(0, 0, b);
      return geo;
    }
    function add(parent, geo, mat, name) {
      const o = new T.Mesh(geo, mat);
      o.castShadow = true;
      if (name) o.name = name;
      parent.add(o);
      return o;
    }
    function decal(parent, c, w, h, x, y, z, opts) {
      const m = new T.MeshStandardMaterial({ map: texFrom(c), transparent: true, depthWrite: false, roughness: 0.55, metalness: 0.2 });
      const o = new T.Mesh(new T.PlaneGeometry(w, h), m);
      o.position.set(x, y, z);
      if (opts && opts.rx) o.rotation.x = opts.rx;
      if (opts && opts.ry) o.rotation.y = opts.ry;
      parent.add(o);
      return o;
    }
    function labelCanvas(txt, w, h, font, color, align) {
      const c = mkCanvas(w, h);
      const g = c.getContext('2d');
      g.font = font; g.fillStyle = color; g.textAlign = align || 'center'; g.textBaseline = 'middle';
      g.fillText(txt, align === 'left' ? 8 : w / 2, h / 2 + 2);
      return c;
    }

    // materials
    const brushedC = mkCanvas(512, 512);
    (function () {
      const g = brushedC.getContext('2d');
      g.fillStyle = '#ececec'; g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 2400; i++) {
        const y = Math.random() * 512, x = Math.random() * 512, len = 40 + Math.random() * 280;
        const v = (185 + Math.random() * 70) | 0;
        g.strokeStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.5)';
        g.lineWidth = Math.random() < 0.5 ? 1 : 0.6;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y); g.stroke();
      }
      for (let i = 0; i < 160; i++) {
        const x = Math.random() * 512, y = Math.random() * 512, a = Math.random() * Math.PI, l = 3 + Math.random() * 24;
        const v = Math.random() < 0.55 ? 140 : 255;
        g.strokeStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.55)';
        g.lineWidth = 0.7;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
      }
    })();
    const brushed = texFrom(brushedC);
    brushed.wrapS = brushed.wrapT = T.RepeatWrapping;
    brushed.repeat.set(0.16, 0.16);
    const smudgeC = mkCanvas(256, 256);
    (function () {
      const g = smudgeC.getContext('2d');
      g.fillStyle = 'rgb(150,150,150)'; g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 28; i++) {
        const x = Math.random() * 256, y = Math.random() * 256, r = 10 + Math.random() * 42;
        const v = Math.random() < 0.5 ? 110 : 215;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(' + v + ',' + v + ',' + v + ',0.45)'); gr.addColorStop(1, 'rgba(' + v + ',' + v + ',' + v + ',0)');
        g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    })();
    const smudge = texFrom(smudgeC, false);
    smudge.wrapS = smudge.wrapT = T.RepeatWrapping;
    smudge.repeat.set(0.13, 0.13);
    const silver = new T.MeshStandardMaterial({ color: 0xe0e2e6, metalness: 0.8, roughness: 0.5, map: brushed, roughnessMap: smudge, bumpMap: brushed, bumpScale: 0.006 });
    const silverDark = new T.MeshStandardMaterial({ color: 0xb8bac0, metalness: 0.78, roughness: 0.6, map: brushed, roughnessMap: smudge, bumpMap: brushed, bumpScale: 0.006 });
    const seamMat = new T.MeshStandardMaterial({ color: 0x3b3c40, metalness: 0.3, roughness: 0.6 });
    const graphite = new T.MeshStandardMaterial({ color: 0x2a2b2f, metalness: 0.2, roughness: 0.32 });
    const charcoal = new T.MeshStandardMaterial({ color: 0x050506, metalness: 0.0, roughness: 0.5, envMapIntensity: 0.55 });
    const black = new T.MeshStandardMaterial({ color: 0x141416, metalness: 0.1, roughness: 0.6 });
    const engrave = new T.MeshStandardMaterial({ color: 0x1e1f22, metalness: 0.1, roughness: 0.7 });
    const hidden = new T.MeshBasicMaterial({ visible: false });

    // device
    const device = new T.Group();
    scene.add(device);
    const FZ = 0.75;
    // original silhouette: equal corners, softly bowed bottom edge
    const TH = 0;
    // bottom edge: square 90° lower-left corner, soft slope up into the rounded lower-right corner
    function bottomCurve(w, h, r, th) {
      const x0 = -w / 2, y0 = -h / 2, cxR = x0 + w - r, cy = y0 + r;
      const ex = cxR + r * Math.sin(th), ey = cy - r * Math.cos(th);
      const s = 0, k = w * 0.3;
      return [new T.Vector2(x0, y0 - s), new T.Vector2(x0 + w * 0.35, y0 - s), new T.Vector2(ex - k * Math.cos(th), ey - k * Math.sin(th)), new T.Vector2(ex, ey)];
    }
    function bodyShape(w, h, r, th) {
      const s = new T.Shape(), x0 = -w / 2, y0 = -h / 2;
      const cxR = x0 + w - r, cxL = x0 + r, cy = y0 + r;
      s.moveTo(x0, y0);
      s.lineTo(cxR, y0);
      s.absarc(cxR, cy, r, -Math.PI / 2, 0, false);
      s.lineTo(x0 + w, y0 + h - r);
      s.absarc(cxR, y0 + h - r, r, 0, Math.PI / 2, false);
      s.lineTo(x0 + r, y0 + h);
      s.absarc(cxL, y0 + h - r, r, Math.PI / 2, Math.PI, false);
      s.lineTo(x0, y0);
      return s;
    }
    const BC = bottomCurve(6, 10, 0.72, TH);
    const bez = (t, a, b, c, d) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
    const bx = (t) => bez(t, BC[0].x, BC[1].x, BC[2].x, BC[3].x), by = (t) => bez(t, BC[0].y, BC[1].y, BC[2].y, BC[3].y);
    function bottomT(x) { let best = 0, bd = 1e9; for (let i = 0; i <= 400; i++) { const t = i / 400, d = Math.abs(bx(t) - x); if (d < bd) { bd = d; best = t; } } return best; }
    function bottomY(x) { return by(bottomT(x)); }
    function bottomSlope(x) { const t = bottomT(x), t1 = Math.max(0, t - 0.003), t2 = Math.min(1, t + 0.003); return (by(t2) - by(t1)) / (bx(t2) - bx(t1)); }
    const shellGeo = new T.ExtrudeGeometry(bodyShape(6 - 0.18, 10 - 0.18, 0.72 - 0.09, TH), { depth: 0.71 - 0.18, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.09, bevelSegments: 5, curveSegments: 28 });
    shellGeo.translate(0, 0, 0.09);
    add(device, shellGeo, silver).position.z = 0.04;
    add(device, shellGeo, silver).position.z = -0.75;
    add(device, new T.ExtrudeGeometry(bodyShape(5.9, 9.9, 0.66, TH), { depth: 0.12, bevelEnabled: false, curveSegments: 28 }), seamMat).position.z = -0.06;

    // bezel + screen
    add(device, slab(5.4, 4.9, 0.36, 0.06, 0.025), graphite).position.set(0, 2.3, FZ - 0.03);
    const lcdWell = new T.Mesh(new T.PlaneGeometry(4.18, 3.78), black);
    lcdWell.position.set(0.15, 2.6, FZ + 0.031);
    device.add(lcdWell);
    const disp = mkCanvas(640, 576);
    const dctx = disp.getContext('2d');
    dctx.imageSmoothingEnabled = false;
    const screenTex = new T.CanvasTexture(disp);
    screenTex.encoding = T.sRGBEncoding;
    screenTex.magFilter = T.NearestFilter;
    screenTex.minFilter = T.LinearFilter;
    screenTex.generateMipmaps = false;
    const screen = new T.Mesh(new T.PlaneGeometry(4.0, 3.6), new T.MeshBasicMaterial({ map: screenTex, toneMapped: false }));
    screen.name = 'screen';
    screen.position.set(0.15, 2.6, FZ + 0.033);
    device.add(screen);
    const glass = new T.Mesh(new T.ShapeGeometry(rr(5.36, 4.86, 0.35), 16), new T.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.06, transparent: true, opacity: 0.09, depthWrite: false }));
    glass.position.set(0, 2.3, FZ + 0.046);
    device.add(glass);

    const titleC = mkCanvas(1024, 112);
    const titleTex = texFrom(titleC);
    const titleMesh = new T.Mesh(new T.PlaneGeometry(4.0, 0.4375), new T.MeshBasicMaterial({ map: titleTex, transparent: true, depthWrite: false }));
    titleMesh.visible = false; // no text on the front of the console
    titleMesh.position.set(0.15, 0.34, FZ + 0.034);
    device.add(titleMesh);

    // power LED
    const ledMat = new T.MeshStandardMaterial({ color: 0x4a0d0d, emissive: 0xff2a2a, emissiveIntensity: 0, roughness: 0.3 });
    const led = new T.Mesh(new T.CylinderGeometry(0.075, 0.075, 0.03, 20), ledMat);
    led.name = 'power_led';
    led.rotation.x = Math.PI / 2;
    led.position.set(-2.28, 3.95, FZ + 0.035);
    device.add(led);
    const glowC = mkCanvas(128, 128);
    (function () {
      const g = glowC.getContext('2d');
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,90,80,1)'); gr.addColorStop(0.25, 'rgba(255,40,40,0.55)'); gr.addColorStop(1, 'rgba(255,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    })();
    const glow = new T.Sprite(new T.SpriteMaterial({ map: texFrom(glowC), blending: T.AdditiveBlending, transparent: true, opacity: 0, depthWrite: false }));
    glow.scale.set(0.7, 0.7, 1);
    glow.position.set(-2.28, 3.95, FZ + 0.08);
    glow.layers.set(1);
    device.add(glow);
    decal(device, labelCanvas('POWER', 256, 64, '600 34px Inter, sans-serif', '#8f9095'), 0.5, 0.125, -2.3, 3.72, FZ + 0.034);

    // D-pad
    const well = (r, x, y) => { const o = new T.Mesh(new T.CircleGeometry(r, 48), silverDark); o.position.set(x, y, FZ + 0.002); device.add(o); return o; };
    well(0.86, -1.65, -1.55);
    const dpad = new T.Group();
    dpad.position.set(-1.65, -1.55, FZ - 0.02);
    device.add(dpad);
    const a0 = 0.22, L = 0.66;
    const cross = new T.Shape();
    [[-a0, L], [a0, L], [a0, a0], [L, a0], [L, -a0], [a0, -a0], [a0, -L], [-a0, -L], [-a0, -a0], [-L, -a0], [-L, a0], [-a0, a0]].forEach((p, i) => { if (i) cross.lineTo(p[0], p[1]); else cross.moveTo(p[0], p[1]); });
    const crossGeo = new T.ExtrudeGeometry(cross, { depth: 0.18, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.045, bevelSegments: 3 });
    crossGeo.translate(0, 0, 0.05);
    const dpadMat = charcoal.clone();
    const crossMesh = add(dpad, crossGeo, dpadMat, 'dpad');
    crossMesh.userData.dpad = true;
    const dimple = new T.Mesh(new T.CircleGeometry(0.15, 32), engrave);
    dimple.position.z = 0.282; dpad.add(dimple);
    const tri = new T.Shape(); tri.moveTo(-0.07, 0); tri.lineTo(0.07, 0); tri.lineTo(0, 0.1); tri.lineTo(-0.07, 0);
    const triGeo = new T.ShapeGeometry(tri);
    const arrowMat = new T.MeshStandardMaterial({ color: 0x2e2f33, roughness: 0.6 });
    [0, Math.PI / 2, Math.PI, -Math.PI / 2].forEach((ang) => {
      const o = new T.Mesh(triGeo, arrowMat);
      o.position.set(-Math.sin(ang) * 0.44, Math.cos(ang) * 0.44, 0.282);
      o.rotation.z = ang;
      dpad.add(o);
    });
    const hitGeoV = new T.BoxGeometry(0.46, 0.48, 0.34), hitGeoH = new T.BoxGeometry(0.48, 0.46, 0.34);
    [['dpad_up', 0, 0.42, hitGeoV, 'up'], ['dpad_down', 0, -0.42, hitGeoV, 'down'], ['dpad_left', -0.42, 0, hitGeoH, 'left'], ['dpad_right', 0.42, 0, hitGeoH, 'right']].forEach((d) => {
      const o = new T.Mesh(d[3], hidden);
      o.name = d[0]; o.position.set(d[1], d[2], 0.14); o.userData.button = d[4];
      dpad.add(o);
    });

    // A / B
    const prof = [[0, 0.3], [0.16, 0.297], [0.28, 0.285], [0.36, 0.262], [0.405, 0.225], [0.42, 0.18], [0.42, 0]].reverse().map((p) => new T.Vector2(p[0], p[1]));
    const roundGeo = new T.LatheGeometry(prof, 48);
    roundGeo.rotateX(Math.PI / 2);
    const BTN = {};
    const abMat = new T.MeshStandardMaterial({ color: 0x050506, metalness: 0.0, roughness: 0.5, envMapIntensity: 0.55, side: T.DoubleSide });
    function pressable(id, geo, x, y, name, mat) {
      const m = add(device, geo, (mat || charcoal).clone(), name);
      m.position.set(x, y, FZ - 0.02);
      m.userData.button = id;
      BTN[id] = { mesh: m, z0: m.position.z, base: m.material.color.clone() };
      return m;
    }
    well(0.5, 0.9, -1.45); well(0.5, 2.0, -1.45);
    pressable('b', roundGeo, 0.9, -1.45, 'btn_b', abMat);
    pressable('a', roundGeo, 2.0, -1.45, 'btn_a', abMat);
    const engr = '#5f6166';
    decal(device, labelCanvas('B', 128, 128, '700 84px Inter, sans-serif', engr), 0.34, 0.34, 0.9, -2.17, FZ + 0.003);
    decal(device, labelCanvas('A', 128, 128, '700 84px Inter, sans-serif', engr), 0.34, 0.34, 2.0, -2.17, FZ + 0.003);

    // Select / Start
    const pillGeo = slab(0.8, 0.24, 0.12, 0.13, 0.045);
    [-0.4, 0.6].forEach((x) => { const o = new T.Mesh(new T.ShapeGeometry(rr(0.94, 0.38, 0.19), 16), silverDark); o.position.set(x, -3.7, FZ + 0.002); device.add(o); });
    pressable('select', pillGeo, -0.4, -3.7, 'btn_select');
    pressable('start', pillGeo, 0.6, -3.7, 'btn_start');
    decal(device, labelCanvas('SELECT', 512, 96, '700 58px Inter, sans-serif', engr), 1.1, 0.206, -0.4, -4.08, FZ + 0.003);
    decal(device, labelCanvas('START', 512, 96, '700 58px Inter, sans-serif', engr), 1.1, 0.206, 0.6, -4.08, FZ + 0.003);

    // speaker slots
    // speaker: round cluster of drilled dots, lower right
    const dotGeo = new T.CircleGeometry(0.05, 18);
    for (let iy = -3; iy <= 3; iy++) {
      for (let ix = -3; ix <= 3; ix++) {
        const x = ix * 0.165, y = iy * 0.165;
        if (x * x + y * y > 0.52 * 0.52) continue;
        const o = new T.Mesh(dotGeo, engrave);
        o.position.set(2.1 + x, -4.05 + y, FZ + 0.002);
        device.add(o);
      }
    }

    // top edge: power slider
    const plate = add(device, new T.BoxGeometry(1.08, 0.04, 0.3), black);
    plate.position.set(-1.25, 5.0, 0.36);
    const OFFX = -1.58, ONX = -0.92;
    const slider = add(device, slab(0.34, 0.24, 0.05, 0.16, 0.03), black, 'power_slider');
    slider.geometry.rotateX(-Math.PI / 2);
    slider.position.set(OFFX, 5.0, 0.36);
    // tap / click the power switch to turn the device on or off (large invisible touch target)
    slider.userData.action = 'power'; plate.userData.action = 'power';
    const powerHit = new T.Mesh(new T.BoxGeometry(1.7, 0.75, 1.15), hidden);
    powerHit.position.set(-1.25, 5.22, 0.18); powerHit.userData.action = 'power';
    device.add(powerHit);
    decal(device, labelCanvas('OFF  •  ON', 512, 96, '600 54px Inter, sans-serif', '#b9bbc0'), 1.1, 0.206, -1.25, 4.615, FZ + 0.034);

    // right edge: ribbed wheel
    const wheel = new T.Group();
    wheel.position.set(2.79, 1.4, 0);
    // tap / click the side wheel to toggle sound
    wheel.userData.action = 'sound';
    const soundHit = new T.Mesh(new T.BoxGeometry(0.75, 1.5, 0.8), hidden);
    soundHit.position.set(3.05, 1.4, 0); soundHit.userData.action = 'sound';
    device.add(soundHit);
    device.add(wheel);
    add(device, new T.BoxGeometry(0.03, 1.12, 0.36), black).position.set(3.0, 1.4, 0);
    const wcore = add(wheel, new T.CylinderGeometry(0.44, 0.44, 0.24, 48), new T.MeshStandardMaterial({ color: 0x050506, roughness: 0.5, metalness: 0.0, envMapIntensity: 0.55 }));
    wcore.rotation.x = Math.PI / 2;
    const ribGeo = new T.BoxGeometry(0.06, 0.045, 0.24);
    const ribMat = new T.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.45, envMapIntensity: 0.6 });
    for (let i = 0; i < 40; i++) {
      const ang = (i / 40) * Math.PI * 2;
      const o = new T.Mesh(ribGeo, ribMat);
      o.position.set(Math.cos(ang) * 0.46, Math.sin(ang) * 0.46, 0);
      o.rotation.z = ang;
      wheel.add(o);
    }

    // bottom edge: headphone jack + DC-in
    function port(x, rOuter, rInner, pin) {
      const pg = new T.Group();
      pg.position.set(x, bottomY(x), 0.38);
      pg.rotation.z = Math.atan(bottomSlope(x));
      device.add(pg);
      const ring = add(pg, new T.CylinderGeometry(rOuter, rOuter, 0.02, 28), seamMat);
      ring.position.y = -0.004;
      const hole = new T.Mesh(new T.CylinderGeometry(rInner, rInner, 0.02, 28), black);
      hole.position.y = -0.012; pg.add(hole);
      if (pin) { const p = new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 0.02, 12), silver); p.position.y = -0.02; pg.add(p); }
    }
    port(0.9, 0.16, 0.1, false);
    port(-0.7, 0.19, 0.13, true);

    // back
    const coverMat = silver.clone(); coverMat.color.set(0xc2c4c8);
    const outline = new T.Mesh(new T.ShapeGeometry(rr(4.08, 2.78, 0.26), 16), seamMat);
    outline.rotation.y = Math.PI; outline.position.set(0, -2.4, -1.651); device.add(outline);
    add(device, slab(4.0, 2.7, 0.22, 0.05, 0.02), coverMat).position.set(0, -2.4, -1.7);
    for (let i = 0; i < 4; i++) { const o = new T.Mesh(new T.BoxGeometry(0.9, 0.03, 0.01), seamMat); o.position.set(0, -3.35 + i * 0.09, -1.706); device.add(o); }
    const screwMat = new T.MeshStandardMaterial({ color: 0x8c8e93, metalness: 0.85, roughness: 0.35 });
    [[-2.35, 4.3], [2.35, 4.3], [-2.35, -4.3], [2.35, -4.3]].forEach((p) => {
      const s = add(device, new T.CylinderGeometry(0.14, 0.14, 0.04, 24), screwMat);
      const dz = p[1] < 0 ? -0.9 : 0;
      s.rotation.x = Math.PI / 2; s.position.set(p[0], p[1], -0.765 + dz);
      const s1 = new T.Mesh(new T.BoxGeometry(0.18, 0.035, 0.01), black); s1.position.set(p[0], p[1], -0.787 + dz); device.add(s1);
      const s2 = new T.Mesh(new T.BoxGeometry(0.035, 0.18, 0.01), black); s2.position.set(p[0], p[1], -0.787 + dz); device.add(s2);
    });
    // cartridge slot: flat cartridge panel sitting in a bay, dark slot mouth below it
    const bayMat = new T.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.15, metalness: 0.3 });
    // empty slot floor (visible while no cartridge is inserted)
    const slotFloor = new T.Mesh(new T.PlaneGeometry(4.06, 2.92), new T.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.8, metalness: 0.1 }));
    slotFloor.rotation.y = Math.PI; slotFloor.position.set(0, 3.55, -0.752); device.add(slotFloor);
    // the cartridge: slides in from above during start-up, then stays inserted
    const CART_T = 1.6, CART_Y = 2.475, CART_LIFT = 6.5; // CART_Y: inserted height (lower = deeper in the slot)
    let cartIn = false;
    const cartG = new T.Group();
    cartG.position.set(0, CART_Y + CART_LIFT, 0);
    cartG.visible = false;
    device.add(cartG);
    const cartPlastic = new T.MeshStandardMaterial({ color: 0x3c3d42, roughness: 0.62, metalness: 0.05 });
    add(cartG, slab(4.0, 3.45, 0.14, 0.8, 0.03), cartPlastic).position.z = -1.555;
    const ridgeMat = new T.MeshStandardMaterial({ color: 0x2c2d31, roughness: 0.7 });
    for (let i = 0; i < 6; i++) { const r = new T.Mesh(new T.BoxGeometry(3.3, 0.05, 0.03), ridgeMat); r.position.set(0, 1.05 + i * 0.1, -1.568); cartG.add(r); }
    const cartLabelC = mkCanvas(768, 432);
    const cartLabelTex = texFrom(cartLabelC);
    const cartLabel = new T.Mesh(new T.PlaneGeometry(3.2, 1.8), new T.MeshStandardMaterial({ map: cartLabelTex, roughness: 0.7, metalness: 0 }));
    cartLabel.rotation.y = Math.PI; cartLabel.position.set(0, 0.25, -1.558); cartG.add(cartLabel);
    // CARTRIDGE LABEL IMAGE: the game's own label, in place of the plain one
    const labelImg = new Image();
    labelImg.onload = () => {
      const lt = new T.Texture(labelImg); lt.encoding = T.sRGBEncoding; lt.anisotropy = maxAniso; lt.needsUpdate = true;
      cartLabel.geometry.dispose();
      cartLabel.geometry = new T.PlaneGeometry(2.2 * labelImg.naturalWidth / labelImg.naturalHeight, 2.2);
      cartLabel.position.y = -0.1;
      cartLabel.material.map = lt; cartLabel.material.needsUpdate = true;
    };
    labelImg.src = 'cartridge-label.png';
    function drawCartLabel(t) {
      const g = cartLabelC.getContext('2d');
      g.fillStyle = '#ecebe6'; g.fillRect(0, 0, 768, 432);
      g.fillStyle = accent; g.fillRect(0, 0, 768, 70);
      // plain label (no text)
      g.strokeStyle = '#d2d1cb'; g.lineWidth = 6; g.strokeRect(24, 94, 720, 314);
      cartLabelTex.needsUpdate = true;
    }
    // raised lower back: the cartridge area sits inset above its top ledge
    const RAISE = 0.9;
    const backPanel = add(device, slab(5.5, 6.7, 0.35, RAISE + 0.005, 0.04), silver);
    backPanel.position.set(0, -1.25, -0.75 - RAISE);
    const gripMat = new T.MeshStandardMaterial({ color: 0x8e9095, metalness: 0.6, roughness: 0.45 });
    const mouth = new T.Mesh(new T.PlaneGeometry(4.1, RAISE * 0.6), bayMat);
    mouth.rotation.x = -Math.PI / 2; mouth.position.set(0, 2.102, -0.75 - RAISE * 0.5); device.add(mouth);
    const topSlot = new T.Mesh(new T.PlaneGeometry(4.1, 0.1), bayMat);
    topSlot.rotation.x = -Math.PI / 2; topSlot.position.set(0, 5.003, -0.6); device.add(topSlot);
    const recess = new T.Mesh(new T.ShapeGeometry(rr(4.56, 2.16, 0.14), 12), silverDark);
    recess.rotation.y = Math.PI; recess.position.set(0, 0.35, -1.651); device.add(recess);
    const backC = mkCanvas(1024, 464);
    const backTex = texFrom(backC);
    const backLabel = new T.Mesh(new T.PlaneGeometry(4.4, 2.0), new T.MeshStandardMaterial({ map: backTex, roughness: 0.75, metalness: 0 }));
    backLabel.rotation.y = Math.PI; backLabel.position.set(0, 0.35, -1.653); device.add(backLabel);

    function fitFont(g, txt, weight, style, size, maxW) {
      let s = size;
      do { g.font = style + ' ' + weight + ' ' + s + 'px Inter, sans-serif'; s -= 2; } while (g.measureText(txt).width > maxW && s > 12);
    }
    function drawTitles() {
      const t = self.title();
      let g = titleC.getContext('2d');
      g.clearRect(0, 0, 1024, 112);
      g.fillStyle = '#c9cace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      // front of the console: no title under the screen
      titleTex.needsUpdate = true;
      g = backC.getContext('2d');
      g.fillStyle = '#e6e6e3'; g.fillRect(0, 0, 1024, 464);
      g.strokeStyle = '#9fa1a6'; g.lineWidth = 4; g.strokeRect(18, 18, 988, 428);
      g.fillStyle = '#2b2b2e'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      fitFont(g, t, '700', 'italic', 76, 900);
      g.fillText(t, 56, 170);
      g.font = '500 44px Inter, sans-serif';
      g.fillText('— Handheld Edition', 56, 250);
      g.fillStyle = '#2b2b2e'; g.fillRect(56, 300, 912, 3);
      g.font = '500 28px Inter, sans-serif'; g.fillStyle = '#55555a';
      g.fillText('Battery: 2 × AAA', 56, 360);
      g.textAlign = 'right';
      g.fillText('Model HH-01', 968, 360);
      backTex.needsUpdate = true;
      drawCartLabel(t);
    }
    drawTitles();
    if (document.fonts && document.fonts.load) {
      Promise.all([document.fonts.load('italic 600 40px Inter'), document.fonts.load('700 40px Inter'), document.fonts.load('8px "Press Start 2P"')]).then(() => { if (self.three) drawTitles(); }).catch(() => {});
    }

    // power-on pointer (sprites)
    function spriteC(w, h, draw) { const c = mkCanvas(w, h); draw(c.getContext('2d'), w, h); return c; }
    const ringS = new T.Sprite(new T.SpriteMaterial({ map: texFrom(spriteC(256, 256, (g) => { g.strokeStyle = accent; g.lineWidth = 14; g.beginPath(); g.arc(128, 128, 104, 0, Math.PI * 2); g.stroke(); })), transparent: true, depthTest: false, opacity: 0 }));
    const arrowS = new T.Sprite(new T.SpriteMaterial({ map: texFrom(spriteC(128, 160, (g) => { g.fillStyle = accent; g.fillRect(48, 0, 32, 84); g.beginPath(); g.moveTo(10, 78); g.lineTo(118, 78); g.lineTo(64, 156); g.closePath(); g.fill(); })), transparent: true, depthTest: false, opacity: 0 }));
    const tagS = new T.Sprite(new T.SpriteMaterial({ map: texFrom(spriteC(320, 104, (g) => { g.fillStyle = accent; const r = 40; g.beginPath(); g.moveTo(r, 8); g.arcTo(312, 8, 312, 96, r); g.arcTo(312, 96, 8, 96, r); g.arcTo(8, 96, 8, 8, r); g.arcTo(8, 8, 312, 8, r); g.fill(); g.fillStyle = '#ffffff'; g.font = '700 48px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('Power', 160, 54); })), transparent: true, depthTest: false, opacity: 0 }));
    ringS.scale.set(1.1, 1.1, 1); arrowS.scale.set(0.56, 0.7, 1); tagS.scale.set(1.5, 0.49, 1);
    [ringS, arrowS, tagS].forEach((s) => { s.layers.set(1); s.renderOrder = 10; device.add(s); });
    function setPointer(op, t) {
      const b = Math.abs(Math.sin(t * 7)) * 0.22;
      const sx = slider.position.x;
      ringS.position.set(sx, 5.1, 0.36);
      ringS.scale.setScalar(1.0 + 0.15 * Math.sin(t * 8));
      arrowS.position.set(sx, 6.0 + b, 0.36);
      tagS.position.set(sx, 6.85 + b, 0.36);
      ringS.material.opacity = arrowS.material.opacity = tagS.material.opacity = op;
    }

    // screen pipeline
    const gameCanvas = mkCanvas(160, 144);
    const fxCanvas = mkCanvas(160, 144);
    const fxCtx = fxCanvas.getContext('2d');
    const gridC = mkCanvas(640, 576);
    (function () {
      const g = gridC.getContext('2d');
      g.fillStyle = 'rgba(0,0,0,0.11)';
      for (let x = 0; x < 640; x += 4) g.fillRect(x, 0, 1, 576);
      for (let y = 0; y < 576; y += 4) g.fillRect(0, y, 640, 1);
    })();
    const PAL = [[198, 208, 160], [140, 152, 108], [78, 88, 60], [30, 34, 26]];
    self.game = self.attachGame({ canvas: gameCanvas });
    let screenMode = 'off', bootP = 0, lastOff = false;
    function paintScreen() {
      if (screenMode === 'off') {
        if (!lastOff) { dctx.globalAlpha = 1; dctx.fillStyle = '#3c4135'; dctx.fillRect(0, 0, 640, 576); screenTex.needsUpdate = true; lastOff = true; }
        return;
      }
      lastOff = false;
      const fx = self.state.lcdFx;
      if (screenMode === 'boot') {
        const col = fx ? [198, 208, 160] : [236, 236, 232];
        const p = bootP * bootP;
        dctx.globalAlpha = 1;
        dctx.fillStyle = 'rgb(' + ((col[0] * p) | 0) + ',' + ((col[1] * p) | 0) + ',' + ((col[2] * p) | 0) + ')';
        dctx.fillRect(0, 0, 640, 576);
        screenTex.needsUpdate = true;
        return;
      }
      dctx.imageSmoothingEnabled = false;
      if (fx) {
        const gctx = gameCanvas.getContext('2d');
        const id = gctx.getImageData(0, 0, 160, 144);
        const d = id.data;
        for (let i = 0; i < d.length; i += 4) {
          const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
          const c = PAL[l > 0.78 ? 0 : l > 0.5 ? 1 : l > 0.22 ? 2 : 3];
          d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
        }
        fxCtx.putImageData(id, 0, 0);
        dctx.globalAlpha = 0.85;
        dctx.drawImage(fxCanvas, 0, 0, 640, 576);
        dctx.globalAlpha = 1;
        dctx.drawImage(gridC, 0, 0);
      } else {
        dctx.globalAlpha = 1;
        dctx.drawImage(gameCanvas, 0, 0, 640, 576);
      }
      screenTex.needsUpdate = true;
    }

    // orientation + interaction state
    const Q = (x, y, z) => new T.Quaternion().setFromEuler(new T.Euler(x, y, z, 'XYZ'));
    const qFront = new T.Quaternion();
    const qBack = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), 0.42).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.PI - 0.4));
    const qTop = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), -0.5).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), 0.72));
    device.quaternion.copy(self.props.mobile ? Q(0.42, -0.18, 0) : Q(0.12, -0.55, 0));
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const SPEED = reduced ? 0.5 : 1;
    let zoom = 1, zoomTarget = 1;
    let dragging = null, omega = 0, lastInteraction = -1e9;
    const omegaAxis = new T.Vector3(0, 1, 0);
    let seq = null, viewTween = null, freeView = false, ledLevel = 0, playT0 = 0, offAnim = null, wheelSpinT = 0, wheelRot0 = 0;
    const pointers = new Map();
    let pinch = null;
    const ptrButtons = new Map();
    const raycaster = new T.Raycaster();
    const ndc = new T.Vector2();
    const tmpQ = new T.Quaternion(), tmpV = new T.Vector3(), Y = new T.Vector3(0, 1, 0);
    const anim = {};
    self.BUTTONS.forEach((b) => { anim[b] = { x: 0, v: 0 }; });
    const canRotate = () => self.mode === 'IDLE' || (self.mode === 'PLAYING' && freeView);

    function pick(e) {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(device, true);
      if (!hits.length) return null;
      const h = hits[0];
      for (let o = h.object; o; o = o.parent) { if (o.userData && o.userData.action) return 'act:' + o.userData.action; }
      if (h.object.userData.button) return h.object.userData.button;
      if (h.object.userData.dpad) {
        const p = dpad.worldToLocal(h.point.clone());
        if (Math.abs(p.x) < 0.1 && Math.abs(p.y) < 0.1) return null;
        return Math.abs(p.x) > Math.abs(p.y) ? (p.x > 0 ? 'right' : 'left') : (p.y > 0 ? 'up' : 'down');
      }
      return null;
    }
    function onDown(e) {
      self.focusRoot();
      self.ensureAudio();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      const b = pick(e);
      if (b && b.indexOf('act:') === 0) { self.deviceAction(b.slice(4)); return; }
      if (b) { ptrButtons.set(e.pointerId, b); self.setHeld(b, 'ptr' + e.pointerId, true); return; }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && self.mode !== 'POWERING_ON') {
        const ps = Array.from(pointers.values());
        pinch = { d: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), z: zoomTarget };
        dragging = null;
        return;
      }
      if (canRotate()) {
        dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
        omega = 0;
        lastInteraction = performance.now();
        canvas.style.cursor = 'grabbing';
      }
    }
    function onMove(e) {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const ps = Array.from(pointers.values());
        const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
        zoomTarget = Math.max(0.7, Math.min(1.6, pinch.z * d / Math.max(1, pinch.d)));
        lastInteraction = performance.now();
        return;
      }
      if (dragging && dragging.id === e.pointerId) {
        const now = performance.now();
        const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
        const len = Math.hypot(dx, dy);
        if (len > 0 && canRotate()) {
          tmpV.set(dy, dx, 0).normalize();
          const ang = len * 0.0085;
          tmpQ.setFromAxisAngle(tmpV, ang);
          device.quaternion.premultiply(tmpQ);
          const dt = Math.max(0.008, (now - dragging.t) / 1000);
          omegaAxis.copy(tmpV);
          omega = 0.5 * omega + 0.5 * (ang / dt);
        }
        dragging.x = e.clientX; dragging.y = e.clientY; dragging.t = now;
        lastInteraction = now;
        return;
      }
      if (!pointers.size) {
        const b = pick(e);
        canvas.style.cursor = b ? 'pointer' : canRotate() ? 'grab' : 'default';
      }
    }
    function onUp(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      const b = ptrButtons.get(e.pointerId);
      if (b) { ptrButtons.delete(e.pointerId); self.setHeld(b, 'ptr' + e.pointerId, false); }
      if (dragging && dragging.id === e.pointerId) {
        if (performance.now() - dragging.t > 90) omega = 0;
        dragging = null;
        lastInteraction = performance.now();
        canvas.style.cursor = canRotate() ? 'grab' : 'default';
      }
    }
    function onWheel(e) {
      if (self.mode === 'POWERING_ON') return;
      e.preventDefault();
      zoomTarget = Math.max(0.7, Math.min(1.6, zoomTarget * Math.exp(-e.deltaY * 0.0012)));
      lastInteraction = performance.now();
    }
    function onVis() { if (document.hidden) self.releaseAll(); }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('visibilitychange', onVis);

    function resize() {
      const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    resize();

    function stepButtons(dt, now) {
      self.BUTTONS.forEach((b) => {
        const s = anim[b];
        if (self.isHeld(b)) {
          // press: sink in over 40 ms
          s.rel = 0;
          s.x = Math.min(1, s.x + dt / 0.04);
        } else if (s.x !== 0) {
          // release: one short, time-based bounce (~150 ms), then rest exactly at 0
          if (!s.rel) { s.rel = now; s.x0 = s.x; }
          const t = (now - s.rel) / 1000;
          if (t >= 0.15) { s.x = 0; s.rel = 0; }
          else s.x = s.x0 * Math.exp(-24 * t) * Math.cos(32 * t);
        }
      });
      ['a', 'b', 'select', 'start'].forEach((b) => {
        const o = BTN[b], x = anim[b].x;
        o.mesh.position.z = o.z0 - 0.12 * x;
        o.mesh.material.color.copy(o.base).multiplyScalar(1 - 0.28 * clamp01(x));
      });
      const tilt = 6 * Math.PI / 180;
      dpad.rotation.x = (anim.down.x - anim.up.x) * tilt;
      dpad.rotation.y = (anim.right.x - anim.left.x) * tilt;
      const any = Math.max(anim.up.x, anim.down.x, anim.left.x, anim.right.x);
      dpadMat.color.copy(charcoal.color).multiplyScalar(1 - 0.2 * clamp01(any));
    }

    function setLed(v) {
      ledLevel = v;
      ledMat.emissiveIntensity = 2.6 * v;
      ledMat.color.setRGB(lerp(0.07, 1.0, v), lerp(0.008, 0.2, v), lerp(0.008, 0.2, v));
      glow.material.opacity = 0.9 * v;
    }

    let raf = 0, last = performance.now();
    function loop(now) {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (document.hidden) return;

      if (self.mode === 'IDLE' || (self.mode === 'PLAYING' && freeView)) {
        if (!dragging && omega > 0.01) {
          tmpQ.setFromAxisAngle(omegaAxis, omega * dt);
          device.quaternion.premultiply(tmpQ);
          omega *= Math.exp(-dt * 3.5);
        }
        if (self.mode === 'IDLE' && self.props.mobile) setPointer(1, now / 1000);
        if (self.mode === 'IDLE' && !self.props.mobile && !dragging && !reduced && omega < 0.05 && now - lastInteraction > 4000) {
          tmpQ.setFromAxisAngle(Y, 0.38 * dt);
          device.quaternion.premultiply(tmpQ);
        }
      } else if (self.mode === 'POWERING_ON' && seq && (now - seq.t0) / 1000 / SPEED < CART_T) {
        // phase 0: turn to the back and push the cartridge into the slot
        const tc = (now - seq.t0) / 1000 / SPEED;
        const k = ease(clamp01(tc / 0.8));
        device.quaternion.copy(seq.qFrom).slerp(qBack, k);
        zoom = zoomTarget = lerp(seq.zFrom, 1.0, k);
        const ci = clamp01((tc - 0.35) / 1.0);
        cartG.visible = tc >= 0.3;
        cartG.position.y = CART_Y + CART_LIFT * Math.pow(1 - ci, 3);
        if (ci >= 1 && !seq.cartClick) {
          seq.cartClick = true; cartIn = true;
          self.playClick(500, 0.22, 0.06);
          setTimeout(() => self.playClick(1100, 0.1, 0.03), 50);
        }
        setPointer(0, 0);
      } else if (self.mode === 'POWERING_ON' && seq) {
        const t = (now - seq.t0) / 1000 / SPEED - CART_T;
        if (t <= 1.0) {
          const k = ease(clamp01(t));
          device.quaternion.copy(seq.q1 || qBack).slerp(qTop, k);
          zoom = zoomTarget = lerp(seq.q1 ? seq.zFrom : 1.0, 1.12, k);
        } else if (t < 1.7) {
          device.quaternion.copy(qTop);
        } else {
          const k = ease(clamp01((t - 1.7) / 0.8));
          device.quaternion.copy(qTop).slerp(qFront, k);
          zoom = zoomTarget = lerp(1.12, 1.3, k);
        }
        let po = 0;
        if (t >= 0.6 && t < 1.7) po = clamp01((t - 0.6) / 0.2);
        else if (t >= 1.7) po = 1 - clamp01((t - 1.7) / 0.2);
        slider.position.x = lerp(OFFX, ONX, ease(clamp01((t - 1.4) / 0.3)));
        setPointer(po, t);
        if (t >= 1.4 && !seq.clicked) {
          seq.clicked = true;
          self.playClick(900, 0.2, 0.05);
          setTimeout(() => self.playClick(1700, 0.1, 0.03), 60);
        }
        setLed(clamp01((t - 1.45) / 0.3));
        if (t >= 2.0) { screenMode = 'boot'; bootP = clamp01((t - 2.0) / 0.5); }
        if (t >= 2.5) {
          seq = null;
          setPointer(0, 0);
          screenMode = 'on';
          self.mode = 'PLAYING';
          playT0 = now;
          self.game.start();
          self.setState({ mode: 'PLAYING' });
        }
      }
      if (self.mode === 'PLAYING' && !freeView) {
        const ft = (now - playT0) / 1000, f = reduced ? 0 : 0.0175;
        const target = tmpQ.copy(qFront).multiply(Q(Math.sin(ft * 0.55) * f, Math.cos(ft * 0.4) * f, 0));
        if (viewTween) {
          const k = ease(clamp01((now - viewTween.t0) / viewTween.dur));
          device.quaternion.copy(viewTween.from).slerp(target, k);
          zoom = zoomTarget = lerp(viewTween.zFrom, 1.3, k);
          if (k >= 1) viewTween = null;
        } else device.quaternion.copy(target);
      }

      if (offAnim) {
        const k = clamp01((now - offAnim.t0) / 250);
        slider.position.x = lerp(ONX, OFFX, ease(k));
        setLed(1 - k);
        if (k >= 1) offAnim = null;
      }
      stepButtons(dt, now);
      if (self.mode === 'PLAYING') self.game.update(dt);
      paintScreen();

      if (self.mode !== 'POWERING_ON' && !viewTween) zoom += (zoomTarget - zoom) * Math.min(1, dt * 10);
      if (wheelSpinT) {
        const k = clamp01((now - wheelSpinT) / 320);
        wheel.rotation.z = wheelRot0 - 0.9 * ease(k);
        if (k >= 1) { wheelRot0 = wheel.rotation.z; wheelSpinT = 0; }
      }
      // never zoom so far that the device is cut off on narrow (portrait phone) screens
      const zEff = Math.min(zoom, Math.max(0.5, 14.47 * camera.aspect / 6.9));
      const d = 27 / zEff;
      camera.position.set(0, 0.9 * d / 27, d);
      camera.lookAt(0, -0.2, 0);
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(loop);

    this.three = {
      drawTitles,
      beginPowerOn() {
        // cartridge already inserted (after a power-off): skip the insert phase
        const skip = cartIn ? CART_T * 1000 * SPEED : 0;
        seq = { t0: performance.now() - skip, qFrom: device.quaternion.clone(), zFrom: zoom, clicked: false };
        if (cartIn) seq.q1 = device.quaternion.clone();
        dragging = null; omega = 0; pinch = null;
        canvas.style.cursor = 'default';
      },
      spinWheel() { wheelSpinT = performance.now(); },
      powerOff() {
        offAnim = { t0: performance.now() };
        screenMode = 'off'; lastOff = false;
        freeView = false; viewTween = null; omega = 0; dragging = null;
        lastInteraction = performance.now() - 2500;
        zoomTarget = 1;
        self.playClick(900, 0.15, 0.04);
        canvas.style.cursor = 'grab';
      },
      setFreeView(free) {
        freeView = free;
        omega = 0;
        if (!free) viewTween = { from: device.quaternion.clone(), t0: performance.now(), dur: reduced ? 250 : 600, zFrom: zoom };
        else viewTween = null;
        canvas.style.cursor = canRotate() ? 'grab' : 'default';
      },
      dispose() {
        cancelAnimationFrame(raf);
        ro.disconnect();
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('wheel', onWheel);
        document.removeEventListener('visibilitychange', onVis);
        pmrem.dispose();
        renderer.dispose();
      }
    };
  }

  renderVals() {
    const s = this.state;
    const accent = this.props.accent ?? '#7A3E6E';
    const rows = this.ROWS.map((r) => {
      const on = !!s.pressed[r.id];
      return {
        id: r.id, label: r.label, k1: r.k1, k2: r.k2, aria: r.aria, rot: r.rot || 0, letter: r.letter || '',
        isDir: r.kind === 'dir', isRound: r.kind === 'round', isPill: r.kind === 'pill',
        rowBg: on ? 'rgba(122, 62, 110, 0.08)' : 'transparent',
        chipBg: on ? accent : '#FFFFFF', chipFg: on ? '#FFFFFF' : '#2B2B2E',
        chipBg2: on ? accent : '#F9F9F7', chipFg2: on ? '#FFFFFF' : '#5A5A5F',
        chipBorder: on ? accent : '#CFCFCB',
        down: this.rowDown[r.id], up: this.rowUp[r.id]
      };
    });
    let hint;
    if (s.mode === 'IDLE') hint = s.focused ? 'Drag to rotate · Scroll to zoom · Keys press the buttons' : 'Drag to rotate · Scroll to zoom · Click here to use the keyboard';
    else if (s.mode === 'POWERING_ON') hint = 'Powering on…';
    else if (s.freeView) hint = 'Free view · Drag to rotate · The game keeps running';
    else hint = s.focused ? 'Playing · Use the keyboard or click the buttons' : 'Click here to use the keyboard';
    if (this.props.mobile) hint = s.mode === 'IDLE' ? 'Tap the power switch on top to start' : s.mode === 'POWERING_ON' ? 'Powering on…' : 'Tap the switch to turn off · Tap the wheel for sound';
    return {
      accent,
      rows,
      hint,
      setRoot: this.setRoot, setStage: this.setStage, setCanvas: this.setCanvas,
      onKeyDown: this.onKeyDown, onKeyUp: this.onKeyUp, onFocus: this.onFocus, onBlur: this.onBlur,
      powerOn: this.powerOn, powerOff: this.powerOff, toggleSound: this.toggleSound, toggleFx: this.toggleFx, toggleView: this.toggleView,
      soundLabel: s.soundOn ? 'On' : 'Off', soundPressed: s.soundOn ? 'true' : 'false',
      fxLabel: s.lcdFx ? 'On' : 'Off', fxPressed: s.lcdFx ? 'true' : 'false',
      showStart: s.mode === 'IDLE',
      showPressed: s.pressingStart,
      showPowering: s.mode === 'POWERING_ON' && !s.pressingStart,
      showPlaying: s.mode === 'PLAYING',
      viewLabel: s.freeView ? 'Front view' : 'Free view',
      viewStatus: s.freeView ? 'Rotation unlocked' : 'Locked to front view'
    };
  }
}

window.HandheldCore = HandheldCore;

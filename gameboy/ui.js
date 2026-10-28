/*
 * ui.js — wires the side panel and keyboard to HandheldCore (handheld.js).
 */
(function () {
  const cfg = window.HANDHELD_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  if (cfg.accent) document.documentElement.style.setProperty('--accent', cfg.accent);

  const core = new window.HandheldCore({ gameTitle: cfg.title, accent: cfg.accent });
  core.setRoot(document.body);
  core.setStage($('stage'));
  core.setCanvas($('view'));
  core.state.focused = true; // keys are captured page-wide here

  // legend rows
  const ICONS = {
    dir: (rot) => '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" style="transform:rotate(' + rot + 'deg)"><path d="M9.5 2h7v7.5H24v7h-7.5V24h-7v-7.5H2v-7h7.5z" fill="#C4C4C0"/><path d="M9.5 2h7v7.5h-7z" fill="#2B2B2E"/></svg>',
    round: (l) => '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11" fill="#2E2F33"/><text x="13" y="17.5" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" font-weight="700" fill="#FFFFFF">' + l + '</text></svg>',
    pill: () => '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="2" y="9.5" width="22" height="7" rx="3.5" fill="#2E2F33" transform="rotate(-20 13 13)"/></svg>'
  };
  const rowEls = {};
  core.ROWS.forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hh-row';
    b.setAttribute('aria-label', r.aria);
    const icon = r.kind === 'dir' ? ICONS.dir(r.rot || 0) : r.kind === 'round' ? ICONS.round(r.letter) : ICONS.pill();
    b.innerHTML = '<span class="ico">' + icon + '</span><span class="lbl"></span><span class="chips"><span class="chip k1"></span><span class="chip k2"></span></span>';
    b.querySelector('.lbl').textContent = r.label;
    b.querySelector('.k1').textContent = r.k1;
    b.querySelector('.k2').textContent = r.k2;
    b.addEventListener('pointerdown', core.rowDown[r.id]);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, core.rowUp[r.id]));
    $('rows').appendChild(b);
    rowEls[r.id] = b;
  });

  // panel buttons
  $('startBtn').addEventListener('click', core.powerOn);
  $('soundBtn').addEventListener('click', core.toggleSound);
  $('fxBtn').addEventListener('click', core.toggleFx);
  $('viewBtn').addEventListener('click', core.toggleView);
  $('cartBtn').addEventListener('click', () => window.gameboyInsert && window.gameboyInsert());
  $('offBtn').addEventListener('click', core.powerOff);

  // keyboard (page-wide)
  window.addEventListener('keydown', core.onKeyDown);
  window.addEventListener('keyup', core.onKeyUp);
  window.addEventListener('blur', () => core.releaseAll());

  // render: state -> DOM
  core.render = function () {
    const v = core.renderVals();
    const s = core.state;
    core.ROWS.forEach((r) => rowEls[r.id].classList.toggle('on', !!s.pressed[r.id]));
    $('hint').textContent = v.hint;
    $('soundBtn').textContent = 'Click sound: ' + v.soundLabel;
    $('soundBtn').setAttribute('aria-pressed', v.soundPressed);
    $('fxBtn').textContent = 'LCD effect: ' + v.fxLabel;
    $('fxBtn').setAttribute('aria-pressed', v.fxPressed);
    $('startBtn').hidden = !(v.showStart || v.showPressed);
    $('startBtn').classList.toggle('pressed', v.showPressed);
    $('startBtn').disabled = v.showPressed;
    $('poweringBtn').hidden = !v.showPowering;
    $('playingBox').hidden = !v.showPlaying;
    $('viewStatus').textContent = v.viewStatus;
    $('viewBtn').textContent = v.viewLabel;
  };

  core.render();
  core.componentDidMount();
  window.handheld = core; // handy for debugging in the browser console
})();

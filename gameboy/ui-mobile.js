/*
 * ui-mobile.js — phone / app version: only the 3D device, no side panel.
 *   - tap the power switch on the top edge  -> power on (and again -> power off)
 *   - tap the buttons on the device         -> same as keys (multi-touch works)
 *   - tap the wheel on the right edge       -> sound on / off
 *   - drag to rotate while off, pinch to zoom
 * A paired Bluetooth keyboard / controller keyboard mapping still works.
 */
(function () {
  const cfg = window.HANDHELD_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  const core = new window.HandheldCore({ gameTitle: cfg.title, accent: cfg.accent, mobile: true, haptics: true });
  core.setRoot(document.body);
  core.setStage($('stage'));
  core.setCanvas($('view'));
  core.state.focused = true;

  window.addEventListener('keydown', core.onKeyDown);
  window.addEventListener('keyup', core.onKeyUp);
  window.addEventListener('blur', () => core.releaseAll());

  // block iOS page zoom / double-tap zoom / long-press menu
  ['gesturestart', 'gesturechange', 'dblclick', 'contextmenu'].forEach((ev) =>
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

  let toastTimer = 0;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1200);
  }

  let lastSound = core.state.soundOn;
  core.render = function () {
    const v = core.renderVals();
    $('hint').textContent = v.hint;
    if (core.state.soundOn !== lastSound) {
      lastSound = core.state.soundOn;
      toast(lastSound ? 'SOUND ON' : 'SOUND OFF');
    }
  };

  core.render();
  core.componentDidMount();
  window.handheld = core;

})();

// Easter egg: Game Boy. Opens from the footer in a pop-up; the handheld
// (gbexmp/) runs in an iframe that is unloaded again on close.

(function () {
  "use strict";

  var openBtn = document.getElementById("gameboy-open");
  var modal = document.getElementById("gameboy-modal");
  var closeBtn = document.getElementById("gameboy-close");
  var frame = document.getElementById("gameboy-frame");
  if (!openBtn || !modal || !frame) return;

  function onKeyDown(e) {
    if (e.key === "Escape") close();
  }

  function open() {
    modal.hidden = false;
    // Load the handheld only once the pop-up has a size: a frame inside a
    // hidden pop-up gets a 0 x 0 viewport, which phone browsers handle badly.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!modal.hidden) frame.src = "gbexmp/";
      });
    });
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    closeBtn.focus();
  }

  function close() {
    modal.hidden = true;
    frame.src = "about:blank";
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKeyDown);
    openBtn.focus();
  }

  // Keys go to the handheld once it has loaded.
  frame.addEventListener("load", function () {
    if (!modal.hidden && frame.contentWindow) frame.contentWindow.focus();
  });

  // The handheld page asks to be closed with Esc, which it never sees here.
  window.addEventListener("message", function (e) {
    if (e.origin === location.origin && e.data === "gameboy-close") close();
  });

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", function (e) {
    if (e.target === modal) close();
  });
})();

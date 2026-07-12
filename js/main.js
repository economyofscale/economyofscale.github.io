// Daniel Fixemer — resume site

(function () {
  "use strict";

  // ----- Hero video: play once, hold the last frame -----
  // If playback can't happen (autoplay blocked, decode/network error, or the
  // user prefers reduced motion), swap in the last-frame image so the hero
  // never looks empty.
  var heroVideo = document.querySelector(".hero__media video");
  if (heroVideo) {
    var heroFallback = function () {
      if (!heroVideo.parentNode) return;
      var img = document.createElement("img");
      img.src = heroVideo.getAttribute("poster");
      img.alt = "";
      heroVideo.replaceWith(img);
    };

    heroVideo.addEventListener("error", heroFallback);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      heroFallback();
    } else {
      heroVideo.muted = true; // some browsers ignore the attribute for autoplay policy
      var playAttempt = heroVideo.play();
      if (playAttempt && typeof playAttempt.catch === "function") {
        playAttempt.catch(heroFallback);
      }
    }
  }

  // ----- Mobile nav toggle -----
  var toggle = document.querySelector(".nav__toggle");
  var menu = document.getElementById("nav-menu");

  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      var open = menu.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // Close the menu after choosing a section
    menu.addEventListener("click", function (event) {
      if (event.target.tagName === "A") {
        menu.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // ----- Reveal-on-scroll -----
  var revealables = document.querySelectorAll(".reveal");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealables.forEach(function (el) { el.classList.add("is-visible"); });
    return;
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -5% 0px" }
  );

  revealables.forEach(function (el) { observer.observe(el); });
})();

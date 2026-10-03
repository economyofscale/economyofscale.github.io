// Daniel Fixemer — resume site
// Renders the blog card overview on the homepage from window.BLOG_POSTS.

(function () {
  "use strict";

  var grid = document.getElementById("blog-grid");
  if (!grid || !Array.isArray(window.BLOG_POSTS)) return;

  // Show the most recent few on the homepage; the rest still have pages.
  var MAX_CARDS = 6;

  var fmtDate = function (iso) {
    var d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  };

  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  var cards = window.BLOG_POSTS.slice(0, MAX_CARDS).map(function (post) {
    var href = "blog/post.html?slug=" + encodeURIComponent(post.slug);
    var meta = fmtDate(post.date) + (post.readingTime ? " · " + esc(post.readingTime) : "");
    return (
      '<a class="blog-card" href="' + href + '">' +
        '<span class="blog-card__media">' +
          '<img src="' + esc(post.image) + '" alt="' + esc(post.imageAlt || "") + '" loading="lazy">' +
        '</span>' +
        '<span class="blog-card__body">' +
          '<span class="blog-card__meta">' + meta + '</span>' +
          '<span class="blog-card__title">' + esc(post.title) + '</span>' +
          '<span class="blog-card__intro">' + esc(post.intro) + '</span>' +
          '<span class="blog-card__more">Read article <span aria-hidden="true">&rarr;</span></span>' +
        '</span>' +
      '</a>'
    );
  });

  grid.innerHTML = cards.join("");
})();

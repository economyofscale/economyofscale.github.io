#!/usr/bin/env node
/* ============================================================
   add-post.js — add a LinkedIn article to the blog in one command
   ------------------------------------------------------------
   WHAT IT DOES (automatically):
     • fetches the LinkedIn article page
     • reads the title, publish date, cover image, and intro
     • downloads the cover into assets/blog/<slug>.jpg
     • inserts a new, ready-to-edit entry at the TOP of blog/posts.js

   WHAT YOU DO AFTER:
     • paste the full article text into the new entry's `body`
       (the one thing that can't be auto-extracted)

   USAGE (run from the project root):
     node blog/add-post.js "<linkedin-article-url>"
     node blog/add-post.js "<url>" --slug my-custom-slug

   Needs Node 18+ (uses built-in fetch). No npm install required.
   ============================================================ */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const POSTS_FILE = path.join(__dirname, "posts.js");
const IMG_DIR = path.join(ROOT, "assets", "blog");

// LinkedIn serves clean Open Graph tags to crawler user-agents.
const UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

function fail(msg) {
  console.error("\n✖ " + msg + "\n");
  process.exit(1);
}

// ---- tiny HTML-entity decoder (enough for titles / descriptions) ----
function decodeEntities(s) {
  if (!s) return "";
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
    rdquo: "”", ldquo: "“", eacute: "é"
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in named ? named[n] : m));
}

function metaContent(html, prop) {
  // handle both attribute orders: property=.. content=.. and the reverse
  let m = html.match(new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', "i"));
  if (!m) m = html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*property=["\']' + prop + '["\']', "i"));
  return m ? decodeEntities(m[1]) : "";
}

function slugify(s) {
  return s.toLowerCase()
    .replace(/[’'"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-").slice(0, 7).join("-");
}

// ---- JS string literal (double-quoted) ----
function jsStr(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith("--"));
  if (!url) fail('No URL given.\n  Usage: node blog/add-post.js "<linkedin-url>" [--slug my-slug]');

  const slugFlag = args.indexOf("--slug");
  let slug = slugFlag !== -1 ? args[slugFlag + 1] : "";

  console.log("→ Fetching article…");
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!res.ok) fail("Fetch failed (HTTP " + res.status + "). Is the URL public and correct?");
  const html = await res.text();

  const title = metaContent(html, "og:title");
  const image = metaContent(html, "og:image");
  const intro = metaContent(html, "og:description");
  const dateMatch = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  const date = dateMatch ? dateMatch[1].slice(0, 10) : "";

  if (!title) fail("Couldn't read the article title — the page may be login-walled or not an article.");
  if (!slug) slug = slugify(title);

  // guard against duplicates
  let source = fs.readFileSync(POSTS_FILE, "utf8");
  if (new RegExp('slug:\\s*["\']' + slug + '["\']').test(source)) {
    fail('A post with slug "' + slug + '" already exists in posts.js. Pass a different --slug, or edit it by hand.');
  }

  // download cover
  let imagePath = "";
  if (image) {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    const imgRes = await fetch(image, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (imgRes.ok) {
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const file = path.join(IMG_DIR, slug + ".jpg");
      fs.writeFileSync(file, buf);
      imagePath = "assets/blog/" + slug + ".jpg";
      console.log("→ Saved cover: " + path.relative(ROOT, file) + " (" + Math.round(buf.length / 1024) + " KB)");
    } else {
      console.warn("! Couldn't download cover image (HTTP " + imgRes.status + ") — set `image` manually.");
    }
  }

  // build the new entry
  const entry =
`  {
    slug: ${jsStr(slug)},
    title: ${jsStr(title)},
    date: ${jsStr(date || "YYYY-MM-DD")},
    readingTime: "",
    image: ${jsStr(imagePath)},
    imageAlt: ${jsStr(title)},
    intro: ${jsStr(intro)},
    linkedInUrl: ${jsStr(url.split("?")[0])},
    // TODO: paste your full article text here as <p>…</p> paragraphs.
    body: [
      "<p>${intro ? intro.replace(/"/g, '\\"') : ""}</p>",
      "<p><strong>Read the full article on LinkedIn for the complete take.</strong></p>"
    ].join("\\n")
  },
`;

  // insert at the top of the array (newest first)
  const anchor = source.match(/window\.BLOG_POSTS\s*=\s*\[\r?\n/);
  if (!anchor) fail("Couldn't find `window.BLOG_POSTS = [` in posts.js.");
  const at = anchor.index + anchor[0].length;
  source = source.slice(0, at) + entry + source.slice(at);
  fs.writeFileSync(POSTS_FILE, source);

  console.log("\n✔ Added post to blog/posts.js\n");
  console.log("  title : " + title);
  console.log("  slug  : " + slug);
  console.log("  date  : " + (date || "(not found — set it manually)"));
  console.log("  page  : blog/post.html?slug=" + slug);
  console.log("\nNext steps:");
  console.log("  1. Open blog/posts.js and replace the `body` with your full article text.");
  if (!date) console.log("  2. Set the `date` (YYYY-MM-DD) — it wasn't found automatically.");
  console.log("  " + (date ? "2" : "3") + ". Optionally set `readingTime` (e.g. \"4 min read\").");
  console.log("");
}

main().catch(e => fail(e.message));

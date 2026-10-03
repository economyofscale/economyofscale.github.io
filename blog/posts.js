/* ============================================================
   Blog posts — single source of truth
   ------------------------------------------------------------
   This one file powers BOTH the card overview on the homepage
   (#blog section) AND the full reading pages (blog/post.html).

   ★ EASIEST WAY TO ADD A POST — run the helper from the project root:
         node blog/add-post.js "<linkedin-article-url>"
     It auto-fills title/date/cover/intro and downloads the image.
     Then you just paste the article body into the new entry below.

   …or add one by hand:

   TO ADD A NEW POST:
   1. Copy an entry below and put it at the TOP of the array
      (newest first — order here = order on the site).
   2. Fill in the fields:
        slug        unique, url-safe id (lowercase, hyphens).
                    Becomes blog/post.html?slug=YOUR-SLUG
        title       article title
        date        "YYYY-MM-DD" (publication date)
        readingTime optional, e.g. "4 min read" (shown on the card)
        image       cover image path, relative to the SITE ROOT,
                    e.g. "assets/blog/your-image.jpg"
                    (download the LinkedIn cover into assets/blog/)
        imageAlt    short description of the cover for accessibility
        intro       1–2 sentence teaser (shown on card + top of post)
        linkedInUrl the original LinkedIn article URL
        body        the full article as an HTML string (see below)
   3. Drop the cover image into /assets/blog/.

   BODY FORMATTING:
     Wrap each paragraph in <p>…</p>. Use <h3> for subheadings,
     <ul><li>…</li></ul> for bullets, <blockquote><p>…</p></blockquote>
     for pull quotes. Paste your own article text here from LinkedIn.
   ============================================================ */

window.BLOG_POSTS = [
  {
    slug: "claude-codex-promotion",
    title: "Claude Got a Promotion, and Nobody Asked Codex How It Feels About That",
    date: "2026-08-24",
    readingTime: "4 min read",
    image: "assets/blog/claude-codex-promotion.jpg",
    imageAlt: "Illustration for the article on Claude delegating coding tasks to Codex",
    intro: "OpenAI’s new Codex plugin lets Claude hand off coding work to another model — splitting architectural planning from execution. A wry look at what inter-model delegation actually feels like.",
    linkedInUrl: "https://www.linkedin.com/pulse/claude-got-promotion-nobody-asked-codex-how-feels-daniel-fixemer-m5cze/",
    // NOTE: placeholder lede — replace with your full article text from LinkedIn.
    body: [
      "<p>Picture a normal Tuesday in a normal office. Someone gets an email titled “quick favor,” opens it, reads exactly one line — “can you just handle this, I don’t have time” — and forwards it on in under four seconds. Delegation, in its purest form.</p>",
      "<p>That’s roughly what happens now that OpenAI’s Codex plugin lets Claude hand coding tasks off to Codex. Suddenly there’s an inter-model workflow with distinct roles: one model does the architectural thinking and planning, the other does the execution.</p>",
      "<p>It’s funny, but it’s also a genuine glimpse of where things are heading — models orchestrating other models, each playing to its strengths, with humans setting direction rather than writing every line.</p>",
      "<p><strong>Read the full article on LinkedIn for the complete take.</strong></p>"
    ].join("\n")
  },
  {
    slug: "hallucination-neurons",
    title: "When AI Gets Confidently Wrong: The Curious Case of the “Hallucination Neurons”",
    date: "2026-03-04",
    readingTime: "4 min read",
    image: "assets/blog/hallucination-neurons.jpg",
    imageAlt: "Abstract neural-network illustration for the article on AI hallucinations",
    intro: "How AI can sound completely convincing while being completely wrong — and what new research on “hallucination neurons” reveals about the mechanism behind it.",
    linkedInUrl: "https://www.linkedin.com/pulse/when-ai-gets-confidently-wrong-curious-case-neurons-daniel-fixemer-bfa0e/",
    // NOTE: paste your full article text from LinkedIn here, as HTML
    // paragraphs. The lede below is a placeholder so the page isn't empty —
    // replace it with the complete article when you're ready.
    body: [
      "<p>We’ve all asked someone for directions who, rather than admit they don’t know, confidently sends us the wrong way. Large language models do something strikingly similar — a behaviour we call <em>hallucination</em>: when a model invents facts that sound convincing but simply aren’t true.</p>",
      "<p>A recent research paper looked inside large language models to understand why. The finding: fewer than 0.1% of neurons seem strongly linked to hallucinations. Rather than storing false facts, these neurons push the model toward over-compliance — making it more eager to give an answer than to admit uncertainty.</p>",
      "<p>These hallucination-prone circuits appear to emerge during pre-training, when the model learns to predict the next word — optimised to sound correct, not necessarily to be correct. The promising part: isolating these specific circuits could let us detect, monitor, or dampen hallucinations before a response is ever generated.</p>",
      "<p><strong>Read the full article on LinkedIn for the complete discussion.</strong></p>"
    ].join("\n")
  }
];

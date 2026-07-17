# Daniel Fixemer — Resume Website

Personal resume and portfolio site for **Daniel Fixemer**, Managing EPM Consultant / AI Transformation Manager.

**Live site:** [economyofscale.github.io](https://economyofscale.github.io)

## About

A single-page, responsive resume site covering background, professional experience, skills, certifications, and selected client engagements in OneStream EPM and finance transformation consulting.

## Built with

- HTML5, CSS3, vanilla JavaScript — no framework, no build step
- Hosted for free on [GitHub Pages](https://pages.github.com/)
- [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/) for privacy-friendly visitor stats (no cookies, no consent banner)

## Structure

```
.
├── index.html                  # main page
├── css/
│   └── styles.css
├── js/
│   ├── main.js                 # nav, scroll-reveal
│   └── pong.js                 # footer easter egg
└── assets/
    ├── headshot-web.jpg
    ├── cv-daniel-fixemer.pdf
    ├── FoxTransition.mp4       # hero name animation
    └── certifications/         # certification badge images
```

## Local development

This is a static site — no build process required.

```bash
git clone https://github.com/economyofscale/economyofscale.github.io.git
cd economyofscale.github.io
```

Open `index.html` directly in a browser, or serve it locally:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Deployment

Pushes to `main` deploy automatically via GitHub Pages.

```bash
git add .
git commit -m "Update site"
git push
```

## License

© 2026 Daniel Fixemer. All rights reserved. Site content, copy, and design are not licensed for reuse.

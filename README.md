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
│   ├── blog.js                 # blog section
│   ├── pong.js                 # footer easter egg: Pong
│   └── gameboy.js              # footer easter egg: Game Boy pop-up
├── blog/                       # blog posts
├── gbexmp/                     # 3D handheld shown in the Game Boy pop-up
├── gameboy/                    # handheld variant with a cartridge picker
└── assets/
    ├── headshot-web.jpg
    ├── cv-daniel-fixemer.pdf
    ├── FoxTransition.mp4       # hero name animation
    └── certifications/         # certification badge images
```

## Easter eggs

Two small games are tucked into the footer:

- **Pong** — a canvas game against a simple AI. Move with the mouse, touch or ↑ ↓; Space or tap to start and pause.
- **Game Boy** — a 3D handheld (Three.js) that opens in a closable pop-up. Press START on the device or the panel to play. Keys: W A S D (pad), O (A), P (B), Enter (START), Backspace (SELECT), Esc closes the pop-up. It also works by touch on phones.

The handheld lives in `gbexmp/`, which loads its cartridge automatically on power-on. `gameboy/` is the same handheld with an "Insert cartridge" button for choosing a cartridge yourself; it is not linked from the footer yet and is intended for a future *Private Projects* section.

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

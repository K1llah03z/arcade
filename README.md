# NEON//GRID — Retro Arcade Hub (PWA)

A fully offline, installable retro-synthwave arcade in a single HTML file:
FreeCell Neon (5000 classic deals), Neon Solitaire, Gridfall, Maze Runner,
Neon Mahjong, Mine Sweeper, Word Grid 10K and more.

## Files
```
index.html      the entire arcade (all games embedded)
manifest.json   PWA manifest (name, icons, theme)
sw.js           service worker — caches everything for full offline use
3DPinballSpaceCadet.htm / .js / .wasm   3D Pinball: Space Cadet (WASM port)
icons/          app icons (192/512/1024, maskable, apple-touch, favicons)
```

## Deploy on GitHub Pages
1. Create a new repository and upload all the files (keep the `icons/` folder).
2. Repo → **Settings → Pages → Source: Deploy from a branch**, pick `main` and `/ (root)`, save.
3. Open `https://<your-username>.github.io/<repo-name>/` — first visit caches everything.

## Install as an app
- **Desktop Chrome/Edge:** click the install icon in the address bar.
- **Android:** menu → *Add to Home screen* / *Install app*.
- **iOS Safari:** Share → *Add to Home Screen*.

After the first visit it works with no internet at all. Scores and saves are
stored locally on the device (localStorage).

## Updating
When you change `index.html`, bump `CACHE` in `sw.js` (e.g. `neon-grid-v2`)
so installed apps fetch the new version.

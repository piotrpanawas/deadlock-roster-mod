# Roster Tools storage bridge

A static page used by the [Roster Tools](https://github.com/piotrpanawas/deadlock-roster-mod) Deadlock mod to keep saved roster presets between game sessions.

Deadlock's Panorama UI has no persistent storage. The mod loads this page in a tiny hidden browser panel (`CitadelHTMLPanel`), and the page stores the mod's data in its own `localStorage`. That storage lives in the game's embedded browser profile **on the player's own disk**.

- No data leaves the computer. Requests arrive in the URL fragment, which browsers never send to the server, and answers go back through `document.title`.
- The page makes no network requests and loads no third-party code (see the Content-Security-Policy in `bridge.html`).
- `sw.js` caches the page, so presets keep working offline after the first load.
- Only keys starting with `rostertools.` are accepted.

Served by GitHub Pages at `https://piotrpanawas.github.io/deadlock-roster-tools-bridge/bridge.html`.

The source lives in the mod repository under `bridge/` and is copied here on release. Licensed under MIT.

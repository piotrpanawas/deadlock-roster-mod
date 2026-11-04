'use strict';
// Runs the real bridge/bridge.html script inside a fake CitadelHTMLPanel.
// The page gets window/document/location/localStorage doubles; document.title
// writes reach Panorama as HTMLTitle events (delivered twice, like CEF can).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = path.resolve(__dirname, '../../bridge/bridge.html');

function pageScript() {
    const html = fs.readFileSync(PAGE, 'utf8');
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    if (!match) { throw new Error('no script in bridge.html'); }
    return match[1];
}

// storage: a Map shared across "game sessions" (the browser profile on disk).
function createBridgeHost(env, storage, options = {}) {
    const o = Object.assign({ loadDelay: 0.3, titleDelay: 0.02, duplicateTitles: true, offline: false }, options);
    const script = pageScript();
    const stats = { loads: 0, requests: 0, titles: [] };

    function attach(panel) {
        let page = null;
        const deliver = (title) => {
            stats.titles.push(title);
            const send = () => { if (panel.handlers && panel.handlers.HTMLTitle && !panel.deleted) { panel.handlers.HTMLTitle(panel, title); } };
            env.schedule(o.titleDelay, send);
            if (o.duplicateTitles) { env.schedule(o.titleDelay * 2, send); }
        };
        const load = (base) => {
            stats.loads++;
            const listeners = {};
            const localStorage = {
                getItem: (k) => (storage.has(k) ? storage.get(k) : null),
                setItem: (k, v) => { storage.set(k, String(v)); },
                removeItem: (k) => { storage.delete(k); },
            };
            const document = {};
            Object.defineProperty(document, 'title', { set: deliver, get: () => '' });
            const context = {
                window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
                document, localStorage, navigator: {}, location: { hash: '' },
                JSON, Object, Array, Math, String, decodeURIComponent, encodeURIComponent,
            };
            vm.createContext(context);
            page = { base, listeners, context };
            vm.runInContext(script, context, { filename: 'bridge.html' });
        };
        panel.SetURL = (url) => {
            const at = url.indexOf('#');
            const base = at < 0 ? url : url.slice(0, at);
            const hash = at < 0 ? '' : url.slice(at);
            if (o.offline) { return; }
            if (!page || page.base !== base) {
                env.schedule(o.loadDelay, () => { if (!panel.deleted) { load(base); } });
                return;
            }
            if (hash && hash !== page.context.location.hash) {
                stats.requests++;
                page.context.location.hash = hash;
                if (page.listeners.hashchange) { page.listeners.hashchange(); }
            }
        };
    }

    env.html = attach;
    return stats;
}

module.exports = { createBridgeHost };

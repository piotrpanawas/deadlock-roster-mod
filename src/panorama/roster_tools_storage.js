// Persistent preset storage for Roster Tools.
//
// Panorama has no persistent storage, so presets are kept in the localStorage
// of a small static page (bridge/bridge.html) loaded in a tiny CitadelHTMLPanel.
// That storage lives in the game's browser profile on the player's disk. The
// bundler defines BRIDGE_URL ahead of this file; an empty URL keeps presets in
// memory for the game session only.
//
// Uplink: SetURL(url + '#' + request); the fragment change does not reload the page.
// Downlink: the page writes "RTB_RES:{...}" to document.title -> HTMLTitle event.

var STORAGE_KEY = 'rostertools.presets.v1';
var MAX_PRESETS = 30;
var MAX_NAME = 24;

var BRIDGE = {
    readyTimeout: 20,      // s to wait for the page to load
    requestTimeout: 6,     // s per request
    maxAttempts: 3         // page loads per game session
};

function createBridge(host, url, events) {
    var panel = null;
    var ready = false;
    var queue = [];
    var active = null;
    var counter = 0;
    var readyTimer = null;
    var closed = false;

    function emit(name, detail) { try { events[name](detail); } catch (e) { log('ERROR in bridge ' + name + ': ' + e); } }

    function send(request) {
        var message = { q: request.id, f: request.f, a: request.a };
        panel.SetURL(url + '#' + encodeURIComponent(JSON.stringify(message)));
    }

    function pump() {
        if (!ready || active || !queue.length || closed) { return; }
        active = queue.shift();
        active.lastSeq = 0;
        active.parts = [];
        armTimeout(active);
        try { send(active); } catch (e) { complete(active, 'send failed: ' + e); }
    }

    function armTimeout(request) {
        if (request.timer) { try { $.CancelScheduled(request.timer); } catch (e) { /* ran */ } }
        request.timer = $.Schedule(BRIDGE.requestTimeout, function () {
            request.timer = null;
            if (active === request) { complete(request, 'timeout'); }
        });
    }

    function complete(request, error, data) {
        if (request.timer) { try { $.CancelScheduled(request.timer); } catch (e) { /* ran */ } request.timer = null; }
        if (active === request) { active = null; }
        try { request.done(error || null, data); } catch (e) { log('ERROR in bridge callback: ' + e); }
        if (error === 'timeout') { emit('lost', error); }
        pump();
    }

    function onResponse(message) {
        var request = active;
        if (!request || message.q !== request.id) { return; }
        if (typeof message.seq === 'number') {
            if (message.seq <= request.lastSeq) { return; } // CEF may deliver a title twice
            request.lastSeq = message.seq;
        }
        if (!message.ok) { complete(request, message.error || 'bridge error'); return; }
        if (typeof message.total === 'number' && message.total > 1) {
            if (message.part !== request.parts.length || message.total > 1000) { complete(request, 'bad chunk'); return; }
            request.parts.push(message.data);
            if (request.parts.length < message.total) {
                armTimeout(request);
                send({ id: request.id, f: 'next', a: [request.parts.length] });
                return;
            }
            complete(request, null, request.parts.join(''));
            return;
        }
        complete(request, null, message.data === undefined ? null : message.data);
    }

    function onTitle(source, title) {
        if (closed || typeof title !== 'string') { return; }
        if (title.indexOf('RTB_READY:') === 0) {
            if (ready) { return; }
            ready = true;
            if (readyTimer) { try { $.CancelScheduled(readyTimer); } catch (e) { /* ran */ } readyTimer = null; }
            emit('ready');
            pump();
        } else if (title.indexOf('RTB_ERROR:') === 0) {
            emit('failed', title.slice(10));
        } else if (title.indexOf('RTB_RES:') === 0) {
            var message;
            try { message = JSON.parse(title.slice(8)); } catch (e) { return; }
            onResponse(message);
        }
    }

    function open() {
        try {
            panel = $.CreatePanel('CitadelHTMLPanel', host, 'RosterToolsBridge');
        } catch (e) {
            emit('failed', 'CitadelHTMLPanel unavailable: ' + e);
            return;
        }
        // A hidden or fully transparent HTML panel is never loaded, so keep it tiny instead.
        panel.style.width = '2px';
        panel.style.height = '2px';
        panel.style.opacity = '0.01';
        panel.style.visibility = 'visible';
        panel.style.position = '0px 0px 0px';
        panel.hittest = false;
        $.RegisterEventHandler('HTMLTitle', panel, guard('bridge title', onTitle));
        readyTimer = $.Schedule(BRIDGE.readyTimeout, function () {
            readyTimer = null;
            if (!ready) { emit('failed', 'page did not load'); }
        });
        panel.SetURL(url);
    }

    open();
    return {
        request: function (f, a, done) {
            queue.push({ id: 'r' + (++counter) + '_' + Date.now(), f: f, a: a, done: done });
            pump();
        },
        isReady: function () { return ready; },
        close: function () {
            closed = true;
            if (readyTimer) { try { $.CancelScheduled(readyTimer); } catch (e) { /* ran */ } }
            if (active) { complete(active, 'closed'); }
            queue.splice(0).forEach(function (r) { try { r.done('closed'); } catch (e) { /* ignore */ } });
            if (valid(panel)) { try { panel.DeleteAsync(0); } catch (e) { /* gone */ } }
        }
    };
}

// ---------------------------------------------------------------- presets

function titleCase(name) {
    return /[a-z]/.test(name) ? name : name.toLowerCase().replace(/(^|[\s&-])([a-z])/g, function (m, sep, c) {
        return sep + c.toUpperCase();
    });
}

// "12 heroes · High prio: Abrams, Haze · 3 mid prio"
function describePreset(heroes, names) {
    var keys = Object.keys(heroes);
    var high = keys.filter(function (k) { return heroes[k] === 'high'; }).map(function (k) { return names[k] || k; });
    var priority = keys.filter(function (k) { return heroes[k] === 'priority'; }).length;
    var parts = [keys.length + (keys.length === 1 ? ' hero' : ' heroes')];
    if (high.length) {
        parts.push('High prio: ' + high.slice(0, 3).join(', ') + (high.length > 3 ? ' +' + (high.length - 3) : ''));
    }
    if (priority) { parts.push(priority + ' mid prio'); }
    return parts.join(' · ');
}

function validPreset(p) {
    return p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string' &&
        p.heroes && typeof p.heroes === 'object' &&
        Object.keys(p.heroes).every(function (k) { return STATES.indexOf(p.heroes[k]) > 0; });
}

function validLayout(l) {
    return !!l && typeof l === 'object' && isFinite(l.x) && isFinite(l.y);
}

// Stored document: { v: 1, presets: [...], layout: { x, y } | null }.
function parseStored(text) {
    if (text === null || text === undefined || text === '') { return { presets: [], layout: null }; }
    var doc = JSON.parse(text);
    if (!doc || doc.v !== 1 || !Array.isArray(doc.presets)) { throw new Error('unsupported data version'); }
    return {
        presets: doc.presets.filter(validPreset).map(function (p) {
            return { id: p.id, name: p.name, heroes: p.heroes, summary: String(p.summary || ''), updated: Number(p.updated) || 0 };
        }),
        layout: validLayout(doc.layout) ? { x: Number(doc.layout.x), y: Number(doc.layout.y) } : null
    };
}

// Presets live in session memory and are mirrored to the bridge when it is available.
// status: 'idle' | 'connecting' | 'ready' | 'offline' | 'disabled'
// cache: optional { read() -> { known, layout }, write(layout) } that outlives the
// session, so the panel position is known before the stored document arrives.
function createPresetStore(session, onChange, cache) {
    var store = session.store;
    if (!store) {
        store = session.store = {
            presets: [], layout: null, layoutSet: false, layoutKnown: false, status: BRIDGE_URL ? 'idle' : 'disabled',
            loaded: false, dirty: false, attempts: 0, error: ''
        };
        var cached = cache ? cache.read() : { known: false };
        if (cached.known) { store.layout = cached.layout; store.layoutKnown = true; }
    }

    function remember(layout) { if (cache) { cache.write(layout); } }
    var bridge = null;
    var saving = false;

    function changed() { try { onChange(); } catch (e) { log('ERROR in preset view: ' + e); } }

    function setStatus(status, error) {
        store.status = status;
        store.error = error || '';
        changed();
    }

    // Drops the bridge; the next popup open reconnects (up to BRIDGE.maxAttempts).
    function drop(why) {
        log('storage unavailable: ' + why);
        if (bridge) { bridge.close(); bridge = null; }
        saving = false;
        setStatus('offline', why);
    }

    function persist() {
        if (!bridge || store.status !== 'ready' || !store.loaded) { store.dirty = true; return; }
        if (saving) { store.dirty = true; return; }
        saving = true;
        store.dirty = false;
        var text = JSON.stringify({ v: 1, presets: store.presets, layout: store.layout });
        bridge.request('set', [STORAGE_KEY, text], function (error) {
            saving = false;
            if (error) {
                store.dirty = true;
                drop('save failed: ' + error);
                return;
            }
            if (store.dirty) { persist(); }
        });
    }

    // Presets saved before the stored list arrived win over stored ones of the same name.
    function merge(stored) {
        var local = store.presets;
        var result = stored.slice();
        local.forEach(function (p) {
            var i = indexOfName(result, p.name);
            if (i >= 0) { result[i] = p; } else { result.push(p); }
        });
        store.presets = result.slice(0, MAX_PRESETS);
        return local.length > 0;
    }

    function load() {
        bridge.request('get', [STORAGE_KEY], function (error, text) {
            if (error) { drop('load failed: ' + error); return; }
            var stored;
            try { stored = parseStored(text); } catch (e) {
                // Never overwrite data this version cannot read.
                store.attempts = BRIDGE.maxAttempts;
                drop('stored presets unreadable (' + e.message + '); left untouched');
                return;
            }
            var needsSave = merge(stored.presets);
            // A position chosen in this session before loading wins over the stored one.
            if (store.layoutSet) { needsSave = true; } else { store.layout = stored.layout; }
            remember(store.layout);
            store.loaded = true;
            store.attempts = 0;
            setStatus('ready');
            log('presets loaded: ' + stored.presets.length + ' stored' + (needsSave ? ', merged session changes' : ''));
            if (needsSave || store.dirty) { persist(); }
        });
    }

    function indexOfName(list, name) {
        var wanted = name.toLowerCase();
        for (var i = 0; i < list.length; i++) { if (list[i].name.toLowerCase() === wanted) { return i; } }
        return -1;
    }

    return {
        // Called when the popup is visible: HTML panels only load while shown.
        connect: function (host) {
            if (bridge || store.status === 'disabled') { return; }
            if (store.attempts >= BRIDGE.maxAttempts) { return; }
            store.attempts++;
            setStatus('connecting');
            bridge = createBridge(host, BRIDGE_URL, {
                ready: function () {
                    if (!store.loaded) { load(); return; }
                    // Reconnected after a reload or an outage: this session's list is current.
                    setStatus('ready');
                    if (store.dirty) { persist(); }
                },
                failed: drop,
                lost: function () { /* the failing request drops the bridge */ }
            });
        },
        list: function () { return store.presets.slice(); },
        layout: function () { return store.layout; },
        // True once the panel position is known: cached, loaded, or no storage to wait for.
        placed: function () {
            return store.layoutKnown || store.layoutSet || store.loaded || store.status === 'offline' || store.status === 'disabled';
        },
        setLayout: function (layout) {
            store.layout = layout;
            store.layoutSet = true;
            remember(layout);
            persist();
        },
        status: function () { return store.status; },
        save: function (name, heroes, summary) {
            name = String(name || '').trim().slice(0, MAX_NAME);
            var i = indexOfName(store.presets, name);
            if (i < 0 && store.presets.length >= MAX_PRESETS) { return { ok: false, message: 'Preset limit reached (' + MAX_PRESETS + ')' }; }
            var preset = { id: i >= 0 ? store.presets[i].id : 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
                name: name, heroes: heroes, summary: summary, updated: Date.now() };
            if (i >= 0) { store.presets[i] = preset; } else { store.presets.push(preset); }
            persist();
            changed();
            return { ok: true, updated: i >= 0, message: (i >= 0 ? 'Updated "' : 'Saved "') + name + '"' };
        },
        remove: function (id) {
            var before = store.presets.length;
            store.presets = store.presets.filter(function (p) { return p.id !== id; });
            if (store.presets.length !== before) { persist(); changed(); }
        },
        nextName: function () {
            for (var n = store.presets.length + 1; ; n++) {
                if (indexOfName(store.presets, 'Preset ' + n) < 0) { return 'Preset ' + n; }
            }
        },
        close: function () {
            if (bridge) { bridge.close(); bridge = null; }
            if (store.status === 'ready' || store.status === 'connecting') { store.status = 'idle'; }
        }
    };
}

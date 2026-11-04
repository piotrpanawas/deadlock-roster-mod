// Roster Tools: one-click roster management for Deadlock's hero roster popup.
//
// Runs inside CitadelPopupRosterSelect. Every roster change is a replayed card
// click started by a button press of the user. The script never presses
// Confirm/Play, never avoids (bans) a hero, never touches the priority token,
// and never moves, reparents or recreates native panels.
//
// The bundler wraps this file in an IIFE after roster_tools_storage.js and
// defines VERSION, BUILD_ID and BRIDGE_URL ahead of both.

var TAG = '[RosterTools]';

var CFG = {
    skipBanned: true,          // never touch Avoid Hero cards
    skipToken: true,           // never touch the card holding the priority token
    burst: 8,                  // replayed clicks handled within one frame when the game reacts at once
    pollInterval: 0.02,        // how often to look for a delayed native state change (s)
    settleTimeout: 0.5,        // give up waiting for a change after this long (s)
    discoverTimeout: 0.8,      // longer wait while a dispatch method is unproven (s)
    maxStepsPerCard: 6,
    undoDepth: 10,
    tickVisible: 0.3,
    tickHidden: 1.0,
    placeWait: 1.5,            // longest wait for the saved panel position before showing the bar (s)
    fadeIn: 0.15,              // fade-in when the bar appears (s)
    diagOnFirstOpen: true,     // one summary line per game session in the console log
    barWidth: 248
};

var STATES = ['none', 'selected', 'priority', 'high'];

// Ways to replay a click on a native CitadelHeroCard, tried in order until one
// visibly changes a card. "Activated"+"mouse" is the contract other mods use for
// C++-bound panels; the rest are fallbacks. No variant may emulate middle click.
var VARIANTS = {
    primary: [['Activated', 'mouse'], ['HeroCardActivated'], ['Activated']],
    secondary: [['ContextMenu', 'mouse'], ['ContextMenu'], ['HeroCardContextMenu']]
};

// Starting rules for what a left (primary) and right (secondary) click does in
// each state. What the game actually does overrides them, so a wrong rule costs
// one retry.
var SEED = {
    primary: { none: 'selected', selected: 'none', priority: 'none', high: 'none' },
    secondary: { none: 'none', selected: 'priority', priority: 'high', high: 'selected' }
};

// States where a click is sure to change the card. Only a failure here proves
// that a dispatch form is ignored; elsewhere the click may simply be a no-op.
var CERTAIN = {
    primary: { none: true, selected: true },
    secondary: { selected: true }
};

var POPUP_CLASSES = ['SelectingSingleHero', 'SingleHeroRequiresConfirm', 'HasValidRoster', 'RandomActive',
    'ShowPriorityToken', 'QuickSearchActive'];

// ---------------------------------------------------------------- utilities

function log(message) { $.Msg(TAG + ' ' + message); }

function valid(panel) {
    try { return !!panel && (typeof panel.IsValid !== 'function' || panel.IsValid()); } catch (e) { return false; }
}

function has(panel, name) {
    try { return valid(panel) && panel.BHasClass(name); } catch (e) { return false; }
}

function child(panel, id) {
    try { return valid(panel) ? panel.FindChildTraverse(id) : null; } catch (e) { return null; }
}

function textOf(panel) {
    try { return valid(panel) && typeof panel.text === 'string' ? panel.text : ''; } catch (e) { return ''; }
}

function firstWithClass(root, name) {
    try {
        var found = valid(root) ? root.FindChildrenWithClassTraverse(name) : [];
        return found && found.length ? found[0] : null;
    } catch (e) { return null; }
}

// "Lady Geist" -> "ladygeist", "The Doorman" -> "doorman", "Mo & Krill" -> "mokrill".
function slug(name) {
    var text = String(name || '');
    try { text = text.normalize('NFD'); } catch (e) { /* no ICU: keep as is */ }
    text = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    return text.indexOf('the') === 0 && text.length > 6 ? text.slice(3) : text;
}

function guard(name, fn) {
    return function () {
        try { return fn.apply(null, arguments); } catch (e) { log('ERROR in ' + name + ': ' + (e && e.stack || e)); }
    };
}

// ---------------------------------------------------------------- reading state

function isHeroCard(panel) {
    if (!valid(panel)) { return false; }
    if (panel.paneltype) { return panel.paneltype === 'CitadelHeroCard'; }
    return !!child(panel, 'HeroName'); // #HeroBadgeIcon also carries class "HeroCard"
}

function findCards(popup) {
    var grid = child(popup, 'RosterHeroes');
    if (!grid) { return []; }
    var found;
    try { found = grid.FindChildrenWithClassTraverse('HeroCard') || []; } catch (e) { found = []; }
    return found.filter(isHeroCard);
}

function heroIdOf(card) {
    var ids = ['HeroBadgeIcon', 'HeroImage'];
    for (var i = 0; i < ids.length; i++) {
        var panel = child(card, ids[i]);
        try {
            var id = panel && panel.heroid;
            if (id !== undefined && id !== null && id !== '' && Number(id) > 0) { return String(id); }
        } catch (e) { /* property missing on this build */ }
    }
    return '';
}

function stateOf(card) {
    if (has(card, 'isHighPriority')) { return 'high'; }
    if (has(card, 'isPriority')) { return 'priority'; }
    if (has(card, 'inRoster')) { return 'selected'; }
    return 'none';
}

function readCard(card, index) {
    var name = textOf(child(card, 'HeroName')).trim();
    var id = heroIdOf(card);
    var enabled = true;
    try { enabled = card.enabled !== false; } catch (e) { /* keep default */ }
    return {
        panel: card,
        index: index,
        name: name,
        id: id,
        key: slug(name) || (id ? 'id' + id : 'idx' + index),
        state: stateOf(card),
        banned: has(card, 'isBanned'),
        token: has(card, 'isPriorityToken'),
        locked: has(card, 'rankedLocked') || has(card, 'prereleaseOnly') || has(card, 'disabled') || !enabled
    };
}

function readAll(popup) {
    return findCards(popup).map(readCard);
}

// Classes only: cheap enough for the periodic counter refresh.
function readStates(popup) {
    return findCards(popup).map(function (card) {
        return { state: stateOf(card), banned: has(card, 'isBanned'),
            token: has(card, 'isPriorityToken'), name: '', key: '' };
    });
}

function summarize(cards) {
    var s = { total: cards.length, selected: 0, priority: 0, high: 0, banned: '', token: '' };
    cards.forEach(function (c) {
        if (c.banned) { s.banned = c.name || c.key; }
        if (c.token) { s.token = c.name || c.key; }
        if (c.state === 'none') { return; }
        s.selected++;
        if (c.state === 'priority') { s.priority++; }
        if (c.state === 'high') { s.high++; }
    });
    return s;
}

// Hints only; the native RosterError label stays the authority and nothing is blocked.
function hints(s) {
    var out = [];
    if (s.selected > 0 && s.selected < 3) { out.push('Roster needs at least 3 heroes'); }
    return out;
}

// ---------------------------------------------------------------- session (survives popup close/reopen)

function newSession() {
    return {
        learned: { primary: {}, secondary: {} },  // action -> from -> observed to
        noopVotes: { primary: {}, secondary: {} }, // action -> from -> cards where a click did nothing
        variant: {
            primary: { index: 0, proven: false, dead: false },
            secondary: { index: 0, proven: false, dead: false }
        },
        undo: [],
        diagDone: false,
        store: null              // preset store state, see createPresetStore
    };
}

function edge(session, action, from) {
    var learned = session.learned[action];
    if (Object.prototype.hasOwnProperty.call(learned, from)) { return learned[from]; }
    return SEED[action][from];
}

// Shortest sequence of clicks from -> to over known edges; returns the first action.
// `blocked` holds "action:state" edges that did nothing on the current card.
function plan(session, from, to, blocked) {
    if (from === to) { return null; }
    var queue = [[from, null]];
    var seen = {};
    seen[from] = true;
    while (queue.length) {
        var item = queue.shift();
        var actions = ['primary', 'secondary'];
        for (var i = 0; i < actions.length; i++) {
            if (session.variant[actions[i]].dead) { continue; }
            if (blocked && blocked[actions[i] + ':' + item[0]]) { continue; }
            var next = edge(session, actions[i], item[0]);
            if (!next || next === item[0] || seen[next]) { continue; }
            var first = item[1] || actions[i];
            if (next === to) { return first; }
            seen[next] = true;
            queue.push([next, first]);
        }
    }
    return null;
}

function describeLearned(session) {
    return ['primary', 'secondary'].map(function (action) {
        var v = session.variant[action];
        var method = v.dead ? 'unavailable' : VARIANTS[action][v.index].join('/') + (v.proven ? '' : '?');
        var edges = STATES.map(function (s) {
            return Object.prototype.hasOwnProperty.call(session.learned[action], s) ? s + '>' + session.learned[action][s] : null;
        }).filter(Boolean).join(' ');
        return action + '[' + method + '] ' + (edges || '-');
    }).join(' | ');
}

// ---------------------------------------------------------------- controller

function createController(popup, session) {
    var bar = null;
    var ui = {};
    var job = null;
    var op = null;              // running operation
    var stopped = false;
    var lastPosition = '';
    var lastStatus = '';
    var wasShown = false;
    var pendingDelete = null;   // { id, timer }: first click on a preset's delete button
    var moving = null;          // { mode, dx, dy, layout, job }: the bar follows the mouse until dropped
    var dragDisplay = null;     // transparent panel handed to a native drag
    var dragGuard = null;       // timer: ignore the header click that may follow a drag
    var headerHover = false;
    var typing = null;          // native quick search input state saved while the name field has the keyboard
    var openedAt = null;        // when the popup was last seen opening (ms)
    var store = createPresetStore(session, guard('renderPresets', function () { renderPresets(); refreshUi(); }), layoutCache());

    // The popup and this script may be created anew for each opening, while the
    // top-level panel lives for the whole game session: the last known position
    // is kept there as well, so the bar opens in place before storage answers.
    function layoutCache() {
        var KEY = 'RosterToolsLayout';
        function top() {
            var p = popup;
            try { while (valid(p.GetParent())) { p = p.GetParent(); } } catch (e) { /* stop here */ }
            return p;
        }
        return {
            read: function () {
                try {
                    var text = top().GetAttributeString(KEY, '');
                    if (!text) { return { known: false }; }
                    var l = JSON.parse(text);
                    return { known: true, layout: validLayout(l) ? { x: Number(l.x), y: Number(l.y) } : null };
                } catch (e) { return { known: false }; }
            },
            write: function (layout) {
                try { top().SetAttributeString(KEY, JSON.stringify(layout || null)); } catch (e) { /* no cache */ }
            }
        };
    }

    function shown() { return valid(popup) && !has(popup, 'Hidden'); }

    function rosterMode() {
        return !has(popup, 'SelectingSingleHero') && !has(popup, 'RandomActive') && !has(popup, 'gRosterScreenshotMode');
    }

    function setStatus(text) {
        lastStatus = text;
        if (valid(ui.status)) { ui.status.text = text; }
    }

    // ------------------------------------------------------------ operations

    function schedule(delay, fn) {
        var handle = $.Schedule(delay, guard('step', function () {
            if (op) {
                op.handles = op.handles.filter(function (h) { return h !== handle; });
                op.burst = 0; // a new frame
            }
            fn();
        }));
        if (op) { op.handles.push(handle); }
        return handle;
    }

    // targetFor(card) returns the wanted state, or null to leave the card alone.
    function run(name, targetFor, options) {
        options = options || {};
        if (op) { setStatus('Busy: ' + op.name); return false; }
        if (!shown() || !rosterMode()) { setStatus('Not available in this mode'); return false; }
        var cards = readAll(popup);
        if (!cards.length) { setStatus('No hero cards found'); log(name + ': no hero cards found'); return false; }
        var snapshot = {};
        cards.forEach(function (c) { snapshot[c.key] = c.state; });
        var work = [];
        var skipped = { banned: 0, token: 0, locked: 0 };
        cards.forEach(function (c) {
            var target = targetFor(c);
            if (!target || target === c.state) { return; }
            if (c.banned && CFG.skipBanned) { skipped.banned++; return; }
            if (c.token && CFG.skipToken) { skipped.token++; return; }
            if (c.locked && target !== 'none') { skipped.locked++; return; }
            work.push({ key: c.key, name: c.name || c.key, target: target, steps: 0, blocked: {}, from: c.state });
        });
        // Cards in plain states first: they prove the dispatch form quickly.
        work.sort(function (a, b) { return certainRank(a) - certainRank(b); });
        if (!work.length) {
            setStatus(name + ': nothing to change');
            return true;
        }
        if (!options.noUndo) {
            session.undo.push({ name: name, snapshot: snapshot });
            if (session.undo.length > CFG.undoDepth) { session.undo.shift(); }
        }
        op = { name: name, work: work, done: 0, failed: [], handles: [], skipped: skipped, cancelled: false,
            burst: 0, cache: {}, started: Date.now() };
        log(name + ': ' + work.length + ' card(s) to change');
        refreshUi();
        schedule(0, nextCard);
        return true;
    }

    function certainRank(item) { return CERTAIN.primary[item.from] ? 0 : 1; }

    function finish(reason) {
        if (!op) { return; }
        var o = op;
        op = null;
        o.handles.forEach(function (h) { try { $.CancelScheduled(h); } catch (e) { /* already ran */ } });
        var skippedText = ['banned', 'token', 'locked'].filter(function (k) { return o.skipped[k]; })
            .map(function (k) { return o.skipped[k] + ' ' + k; }).join(', ');
        var text = o.name + ': ' + (reason || 'done') + ', ' + o.done + '/' + o.work.length + ' changed' +
            (o.failed.length ? ', failed: ' + o.failed.join(', ') : '') + (skippedText ? ', skipped ' + skippedText : '');
        setStatus(text);
        log(text + ' in ' + ((Date.now() - o.started) / 1000).toFixed(2) + 's');
        log('transitions ' + describeLearned(session));
        refreshUi();
    }

    function cancel(reason) {
        if (op) { op.cancelled = true; finish(reason || 'stopped'); }
    }

    // Card by hero key; re-reads the cached panel and falls back to a full scan
    // if the native grid rebound it to another hero.
    function locate(key) {
        var cached = op && op.cache[key];
        if (cached && valid(cached.panel)) {
            var again = readCard(cached.panel, cached.index);
            if (again.key === key) { return again; }
        }
        var found = null;
        readAll(popup).forEach(function (c) {
            if (op) { op.cache[c.key] = c; }
            if (c.key === key) { found = c; }
        });
        return found;
    }

    // Continues in the same frame while the burst budget lasts, else next frame.
    function soon(fn) {
        if (!op) { return; }
        if (op.burst < CFG.burst) { op.burst++; fn(); } else { schedule(0, fn); }
    }

    function nextCard() {
        if (!op) { return; }
        if (!shown() || !rosterMode()) { finish('aborted (popup closed or mode changed)'); return; }
        var item = op.work[op.done + op.failed.length];
        if (!item) { finish(); return; }
        step(item);
    }

    function advance(item, ok) {
        if (ok) { op.done++; } else { op.failed.push(item.name); }
        soon(nextCard);
    }

    function step(item) {
        var card = locate(item.key);
        if (!card) { log('card ' + item.name + ' disappeared'); advance(item, false); return; }
        if (card.state === item.target) { advance(item, true); return; }
        if (item.steps++ >= CFG.maxStepsPerCard) {
            log(item.name + ': gave up at ' + card.state + ' (wanted ' + item.target + ')');
            advance(item, false);
            return;
        }
        var action = plan(session, card.state, item.target, item.blocked);
        if (!action) {
            log(item.name + ': no known way from ' + card.state + ' to ' + item.target);
            advance(item, false);
            return;
        }
        perform(card, action, item, function (after) {
            if (!op) { return; }
            if (after && (after.banned !== card.banned || after.token !== card.token)) {
                log('SAFETY: ' + item.name + ' changed avoid/token state after ' + action + '; stopping');
                finish('stopped for safety');
                return;
            }
            soon(function () { step(item); });
        });
    }

    function dispatch(action, card) {
        var v = session.variant[action];
        var variant = VARIANTS[action][v.index];
        var args = [variant[0], card.panel].concat(variant.slice(1));
        $.DispatchEvent.apply($, args);
    }

    // Replays one click and waits for the card to change; learns the transition.
    function perform(card, action, item, done) {
        var v = session.variant[action];
        var before = card.state;
        try { dispatch(action, card); } catch (e) {
            log(action + ' via ' + VARIANTS[action][v.index].join('/') + ' threw: ' + e);
            return noChange();
        }
        var immediate = locate(card.key);
        if (immediate && immediate.state !== before) { return changed(immediate); }
        var budget = v.proven ? CFG.settleTimeout : CFG.discoverTimeout;
        var polls = Math.max(1, Math.ceil(budget / CFG.pollInterval));
        (function poll() {
            schedule(CFG.pollInterval, function () {
                var now = locate(card.key);
                if (now && now.state !== before) {
                    changed(now);
                } else if (--polls > 0) {
                    poll();
                } else {
                    noChange();
                }
            });
        })();

        function changed(now) {
            if (!v.proven) { log(action + ' works via ' + VARIANTS[action][v.index].join('/')); }
            v.proven = true;
            session.learned[action][before] = now.state;
            delete session.noopVotes[action][before];
            done(now);
        }

        function noChange() {
            // With a proven method, no effect means this click does nothing here: avoid
            // it for this card, and for all cards once two different cards agree (one
            // stuck card must not teach the engine a wrong rule).
            // An unproven form failing in an uncertain state proves nothing either way.
            if (v.proven || !CERTAIN[action][before]) {
                item.blocked[action + ':' + before] = true;
                if (v.proven) {
                    var votes = session.noopVotes[action];
                    votes[before] = votes[before] || {};
                    votes[before][card.key] = true;
                    if (Object.keys(votes[before]).length >= 2) { session.learned[action][before] = before; }
                }
            } else if (v.index + 1 < VARIANTS[action].length) {
                v.index++;
                log(action + ': no effect, trying ' + VARIANTS[action][v.index].join('/'));
            } else {
                v.dead = true;
                log(action + ': no dispatch method changed a card; replayed ' + action + ' clicks are unavailable');
            }
            done(locate(card.key));
        }
    }

    // ------------------------------------------------------------ commands

    var commands = {
        clear: function () { return run('Clear', function () { return 'none'; }); },
        clearPriorities: function () {
            return run('Clear priorities', function (c) { return c.state === 'priority' || c.state === 'high' ? 'selected' : null; });
        },
        selectAll: function () {
            return run('Select all', function (c) { return c.state === 'none' && !c.locked && !c.banned ? 'selected' : null; });
        },
        invert: function () {
            return run('Invert', function (c) { return c.state === 'none' ? (c.locked || c.banned ? null : 'selected') : 'none'; });
        },
        undo: function () {
            var entry = session.undo.pop();
            if (!entry) { setStatus('Nothing to undo'); return false; }
            var started = run('Undo ' + entry.name, function (c) {
                return Object.prototype.hasOwnProperty.call(entry.snapshot, c.key) ? entry.snapshot[c.key] : null;
            }, { noUndo: true });
            if (!started) { session.undo.push(entry); }
            return started;
        },
        apply: function (name, map) {
            var cards = readAll(popup);
            var known = {};
            cards.forEach(function (c) { known[c.key] = true; });
            var unknown = Object.keys(map).filter(function (k) { return !known[k]; });
            if (unknown.length) { log(name + ': unknown heroes ignored: ' + unknown.join(', ')); }
            return run(name, function (c) { return map[c.key] || 'none'; });
        },
        savePreset: function () {
            var heroes = {};
            readAll(popup).forEach(function (c) {
                if (c.state !== 'none') { heroes[c.key] = c.state; }
            });
            if (!Object.keys(heroes).length) { setStatus('Select heroes first'); return false; }
            var name = textOf(ui.presetName).trim() || store.nextName();
            var result = store.save(name, heroes, describePreset(heroes, heroNames()));
            setStatus(result.message);
            if (result.ok && valid(ui.presetName)) { ui.presetName.text = ''; }
            if (typing) { typing.field = textOf(ui.presetName); } // our change, not the game typing
            return result.ok;
        },
        applyPreset: function (id) {
            var preset = store.list().filter(function (p) { return p.id === id; })[0];
            return preset ? commands.apply('"' + preset.name + '"', preset.heroes) : false;
        },
        // Two clicks within 3 s delete a preset.
        deletePreset: function (id) {
            var preset = store.list().filter(function (p) { return p.id === id; })[0];
            if (!preset) { return false; }
            if (pendingDelete && pendingDelete.id === id) {
                clearPendingDelete();
                store.remove(id);
                setStatus('Deleted "' + preset.name + '"');
                return true;
            }
            clearPendingDelete();
            pendingDelete = { id: id, timer: $.Schedule(3, guard('deleteTimeout', function () {
                pendingDelete = null;
                renderPresets();
            })) };
            setStatus('Click again to delete "' + preset.name + '"');
            renderPresets();
            return false;
        },
        move: function () { headerClick(); },
        resetPosition: function () {
            endMove(true);
            store.setLayout(null);
            lastPosition = '';
            setStatus('Panel position reset');
        },
        stop: function () { cancel('stopped by user'); }
    };

    // ------------------------------------------------------------ diagnostics

    function diagnostics() {
        var cards = readAll(popup);
        log('diag popup=' + POPUP_CLASSES.filter(function (c) { return has(popup, c); }).join(',') +
            ' mode="' + textOf(firstWithClass(popup, 'ModeTitle')) + '" cards=' + cards.length +
            ' ids=' + cards.filter(function (c) { return c.id; }).length + ' ' + JSON.stringify(summarize(cards)) +
            ' storage=' + store.status());
    }

    // ------------------------------------------------------------ moving the panel

    // The header is the grip. Holding the left button on it and dragging uses
    // Panorama's native drag (DragStart/DragEnd). A plain click on it toggles
    // follow mode instead (click, move the mouse, click again), which also covers
    // builds where native drag events never arrive. In both modes the bar is
    // placed from the mouse position every frame and the result is saved on drop.

    // $.MousePosition() may return [x, y] or {x, y}, in window pixels.
    function mouse() {
        try {
            var m = $.MousePosition();
            var x = Array.isArray(m) ? m[0] : m && m.x;
            var y = Array.isArray(m) ? m[1] : m && m.y;
            return isFinite(x) && isFinite(y) ? { x: Number(x), y: Number(y) } : null;
        } catch (e) { return null; }
    }

    // The mouse, or the drag display panel (it follows the cursor) when
    // $.MousePosition() is unavailable during a native drag.
    function pointer() {
        var m = mouse();
        if (m || !moving || !valid(moving.display)) { return m; }
        try {
            var d = moving.display.GetPositionWithinWindow();
            return isFinite(d.x) && isFinite(d.y) ? { x: Number(d.x), y: Number(d.y) } : null;
        } catch (e) { return null; }
    }

    function scale() {
        var sx = popup.actualuiscale_x || 1;
        return { x: sx, y: popup.actualuiscale_y || sx };
    }

    // Keeps the whole bar inside the popup.
    function clampLayout(l) {
        var sc = scale();
        var maxX = (popup.actuallayoutwidth || 0) / sc.x - ((bar && bar.actuallayoutwidth) || 0) / sc.x;
        var maxY = (popup.actuallayoutheight || 0) / sc.y - ((bar && bar.actuallayoutheight) || 0) / sc.y;
        return {
            x: Math.round(Math.max(0, maxX > 0 ? Math.min(l.x, maxX) : l.x)),
            y: Math.round(Math.max(0, maxY > 0 ? Math.min(l.y, maxY) : l.y))
        };
    }

    function placeAt(l) {
        var value = l.x + 'px ' + l.y + 'px 0px';
        if (value !== lastPosition) { bar.style.position = value; lastPosition = value; }
    }

    // mode: 'drag' (native drag, ends on DragEnd) or 'click' (ends on the next click).
    function startMove(mode, display) {
        endMove(true);
        if (mode === 'click' && !mouse()) { setStatus('Moving is not available (no mouse position)'); return; }
        moving = { mode: mode, display: display || null, dx: null, dy: null, layout: null, job: null };
        if (mode === 'click') { setStatus('Move the mouse, then click to drop the panel'); }
        styleHeader();
        follow();
    }

    function follow() {
        if (!moving) { return; }
        if (!shown() || !rosterMode()) { endMove(); return; }
        var m = pointer();
        if (m) {
            if (moving.dx === null) {
                // Grab offset, taken from the first known pointer position.
                var b = bar.GetPositionWithinWindow();
                moving.dx = m.x - b.x;
                moving.dy = m.y - b.y;
            }
            var p = popup.GetPositionWithinWindow();
            var sc = scale();
            moving.layout = clampLayout({ x: (m.x - moving.dx - p.x) / sc.x, y: (m.y - moving.dy - p.y) / sc.y });
            placeAt(moving.layout);
        }
        moving.job = $.Schedule(0, guard('follow', follow));
    }

    function endMove(discard) {
        if (!moving) { return; }
        var m = moving;
        moving = null;
        if (m.job) { try { $.CancelScheduled(m.job); } catch (e) { /* ran */ } }
        styleHeader();
        if (!discard && m.layout) {
            store.setLayout(m.layout);
            setStatus('Panel position saved');
        }
    }

    // Native drag: the engine draws callbacks.displayPanel under the cursor, so
    // it gets a tiny transparent panel; the bar itself is moved by follow().
    function onDragStart(source, callbacks) {
        deleteDragDisplay();
        dragDisplay = $.CreatePanel('Panel', popup, '');
        dragDisplay.style.width = '1px';
        dragDisplay.style.height = '1px';
        dragDisplay.style.backgroundColor = '#00000000';
        if (callbacks) {
            callbacks.displayPanel = dragDisplay;
            callbacks.offsetX = 0;
            callbacks.offsetY = 0;
        }
        startMove('drag', dragDisplay);
        return true;
    }

    function onDragEnd(source, dragged) {
        if (moving && moving.mode === 'drag') { endMove(); }
        // The release that ends a drag may also count as a click on the header.
        if (dragGuard) { try { $.CancelScheduled(dragGuard); } catch (e) { /* ran */ } }
        dragGuard = $.Schedule(0.3, function () { dragGuard = null; });
        if (dragged && dragged !== dragDisplay && valid(dragged)) { try { dragged.DeleteAsync(0); } catch (e) { /* gone */ } }
        deleteDragDisplay();
        refreshUi();
        return true;
    }

    function deleteDragDisplay() {
        if (valid(dragDisplay)) { try { dragDisplay.DeleteAsync(0); } catch (e) { /* gone */ } }
        dragDisplay = null;
    }

    // Click on the header: pick the panel up, or drop it.
    function headerClick() {
        if (dragGuard || (moving && moving.mode === 'drag')) { return; }
        if (moving) { endMove(); } else { startMove('click'); }
    }

    // ------------------------------------------------------------ typing

    // The roster popup sends every key to its native hero quick search,
    // whatever has the keyboard focus, and a mod cannot stop that. The search reports each key as CitadelQuickSearchStringChanged(panel,
    // text), where text is the whole search string, upper-cased; a backspace on
    // an empty search reports "" again, while its reset ~1 s after the last key
    // reports nothing (only its label empties). Enter on a non-empty search
    // raises CitadelQuickSearchActivated; on an empty one it reaches the focused
    // field as oninputsubmit. So while the name field is in use, those events
    // are its keyboard. The real case is lost, so names are written in Title
    // Case. The hero highlighting is suppressed by removing QuickSearchActive,
    // which only drives that dimming.
    var UNHIGHLIGHT_AFTER = 2; // s to keep suppressing the highlight after typing ends
    var SUBMIT_GUARD = 1.5;    // s after a save in which another Enter is ignored
    var searchHooked = false;

    function unhighlight() {
        if (has(popup, 'QuickSearchActive')) { popup.RemoveClass('QuickSearchActive'); }
        var marked = [];
        try { marked = popup.FindChildrenWithClassTraverse('QuickSearchActive') || []; } catch (e) { /* none */ }
        marked.forEach(function (panel) { try { panel.RemoveClass('QuickSearchActive'); } catch (e) { /* gone */ } });
    }

    function hookSearch(qs) {
        if (searchHooked || !valid(qs)) { return; }
        searchHooked = true;
        try {
            $.RegisterEventHandler('CitadelQuickSearchStringChanged', qs, guard('search key', onSearchKey));
            $.RegisterEventHandler('CitadelQuickSearchActivated', qs, guard('search enter', onSearchEnter));
        } catch (e) { log('typing: quick search events unavailable: ' + e); }
    }

    function holdKeyboard() {
        if (!typing) {
            var qs = child(popup, 'QuickSearch');
            hookSearch(qs);
            typing = { qs: qs, saved: {}, mode: '', job: null, field: textOf(ui.presetName),
                search: textOf(child(qs, 'QuickSearchLabel')) };
            // Hides the giant search text; input still arrives (see above).
            if (valid(qs)) { typing.saved.visible = qs.visible; qs.visible = false; }
            typing.job = $.Schedule(0, guard('typing watch', watchTyping));
        }
        try { ui.presetName.SetFocus(); } catch (e) { /* not focusable */ }
    }

    function setMode(mode) {
        if (!typing || typing.mode) { return; }
        typing.mode = mode;
        log('typing: ' + (mode === 'native' ? 'characters reach the name field' : 'following the quick search'));
    }

    function setField(text) {
        text = text.slice(0, MAX_NAME);
        if (textOf(ui.presetName) !== text) { ui.presetName.text = text; }
        typing.field = textOf(ui.presetName);
    }

    function following() {
        if (stopped || !typing || typing.mode === 'native') { return false; }
        setMode('follow');
        return true;
    }

    // One key, judged against the previous search string. A search that no
    // longer extends the previous one was reset in between: all of it is new.
    function onSearchKey(panel, text) {
        if (!following()) { return; }
        var t = typing;
        var search = String(text || '');
        var field = textOf(ui.presetName);
        if (!search || (search.length === t.search.length - 1 && t.search.indexOf(search) === 0)) {
            field = field.slice(0, -1);
        } else if (search.indexOf(t.search) === 0) {
            field += search.slice(t.search.length);
        } else {
            field += search;
        }
        t.search = search;
        setField(titleCase(field.toUpperCase())); // "MY PRESET" -> "My Preset"
        unhighlight();
    }

    function onSearchEnter() {
        if (following()) { onEnter(); }
    }

    // Each frame: a field changed by the game itself means keys reach it (no
    // workaround needed); an emptied search label means the search reset.
    function watchTyping() {
        if (!typing) { return; }
        var t = typing;
        if (t.mode !== 'follow' && textOf(ui.presetName) !== t.field) { setMode('native'); }
        if (t.search && !textOf(child(t.qs, 'QuickSearchLabel'))) { t.search = ''; }
        if (t.mode === 'follow') { unhighlight(); }
        t.field = textOf(ui.presetName);
        t.job = $.Schedule(0, guard('typing watch', watchTyping));
    }

    var lastSubmit = 0;

    // One Enter may arrive twice (the search confirm and the field's submit):
    // the second one right after a save, with the field already cleared, is ignored.
    function onEnter() {
        var now = Date.now();
        if (!textOf(ui.presetName).trim() && now - lastSubmit < SUBMIT_GUARD * 1000) { return; }
        lastSubmit = now;
        commands.savePreset();
        refreshUi();
    }

    function releaseKeyboard() {
        if (!typing) { return; }
        var t = typing;
        typing = null;
        if (t.job) { try { $.CancelScheduled(t.job); } catch (e) { /* ran */ } }
        if (valid(t.qs)) { try { t.qs.visible = t.saved.visible !== false; } catch (e) { /* gone */ } }
        if (t.mode === 'follow') {
            // The search keeps its text (and highlight) until its own idle reset.
            var steps = Math.ceil(UNHIGHLIGHT_AFTER / 0.05);
            (function fade() {
                unhighlight();
                if (--steps > 0 && !typing) { $.Schedule(0.05, guard('unhighlight', fade)); }
            })();
        }
    }

    function nameFieldBusy() {
        try { return valid(ui.presetName) && (ui.presetName.BHasKeyFocus() || ui.presetName.BHasHoverStyle()); } catch (e) { return false; }
    }

    // Styles not yet seen working in Deadlock: a rejected value must not break the panel.
    function optionalStyle(panel, name, value) {
        try { panel.style[name] = value; } catch (e) { /* unsupported here */ }
    }

    function clearPendingDelete() {
        if (pendingDelete) { try { $.CancelScheduled(pendingDelete.timer); } catch (e) { /* ran */ } }
        pendingDelete = null;
    }

    // ------------------------------------------------------------ UI

    // Deep teal glass in the game's palette; #74ddb3 is the roster's own
    // selection green. The header band is the one loud element: it is the grip.
    var COLORS = {
        panel: '#081311eb', edge: '#74ddb338', line: '#74ddb326',
        band: '#74ddb31a', bandHover: '#74ddb333', bandActive: '#74ddb352',
        field: '#02080799', fieldEdge: '#74ddb333',
        text: '#e2ece9', dim: '#93aca6', faint: '#647f79', accent: '#74ddb3',
        warn: '#ebb860', error: '#f07c5c'
    };

    // Button looks: fill, hover fill, border, hover border, label colour.
    var KINDS = {
        normal: { bg: '#132c27d9', hover: '#1d433bff', border: '#74ddb31c', hoverBorder: '#74ddb366', text: COLORS.text },
        primary: { bg: '#1a3f36e6', hover: '#245446ff', border: '#74ddb366', hoverBorder: '#74ddb3cc', text: '#f2fbf8' },
        danger: { bg: '#7e2a22f0', hover: '#a03629ff', border: '#f07c5c66', hoverBorder: '#f07c5ccc', text: '#ffe2db' },
        quiet: { bg: '#00000000', hover: '#74ddb31f', border: '#00000000', hoverBorder: '#00000000', text: COLORS.faint },
        preset: { bg: '#ffffff08', hover: '#1d433bff', border: '#74ddb314', hoverBorder: '#74ddb359', text: COLORS.text }
    };

    var STORAGE_DOT = { ready: COLORS.accent, idle: COLORS.warn, connecting: COLORS.warn, offline: COLORS.error,
        disabled: COLORS.faint };

    function label(parent, id, text, color, size) {
        var l = $.CreatePanel('Label', parent, id);
        l.text = text;
        l.style.color = color || COLORS.text;
        l.style.fontSize = (size || 15) + 'px';
        l.style.width = '100%';
        return l;
    }

    // Uppercase heading in the game's UI caps font.
    function heading(parent, id, text, color, size) {
        var l = label(parent, id, text, color || COLORS.dim, size || 13);
        optionalStyle(l, 'fontFamily', 'block');
        optionalStyle(l, 'letterSpacing', '1px');
        return l;
    }

    function box(parent, id, width, height, color) {
        var p = $.CreatePanel('Panel', parent, id || '');
        p.style.width = width;
        p.style.height = height;
        p.style.backgroundColor = color;
        return p;
    }

    function rule(parent, top) {
        var r = box(parent, '', '100%', '1px', COLORS.line);
        r.style.marginTop = top + 'px';
        return r;
    }

    function paint(b, hover) {
        var k = b.__kind;
        b.style.backgroundColor = hover ? k.hover : k.bg;
        b.style.border = '1px solid ' + (hover ? k.hoverBorder : k.border);
    }

    function setKind(b, kind) {
        b.__kind = kind;
        paint(b, false);
        if (b.__label) { b.__label.style.color = kind.text; }
    }

    function baseButton(parent, id, onClick, kind) {
        var b = $.CreatePanel('Button', parent, id);
        b.__kind = kind || KINDS.normal;
        b.style.width = '100%';
        b.style.marginTop = '4px';
        b.style.padding = '6px 10px';
        b.style.borderRadius = '2px';
        optionalStyle(b, 'transitionProperty', 'background-color');
        optionalStyle(b, 'transitionDuration', '0.1s');
        paint(b, false);
        b.SetPanelEvent('onmouseover', function () { if (b.enabled !== false) { paint(b, true); } });
        b.SetPanelEvent('onmouseout', function () { paint(b, false); });
        b.SetPanelEvent('onactivate', guard('button ' + id, function () {
            if (b.enabled === false) { return; }
            onClick();
            refreshUi();
        }));
        return b;
    }

    function button(parent, id, text, onClick, kind) {
        var b = baseButton(parent, id, onClick, kind);
        var l = $.CreatePanel('Label', b, '');
        l.text = text;
        l.style.color = b.__kind.text;
        l.style.fontSize = '14px';
        l.style.fontWeight = 'bold';
        l.style.horizontalAlign = 'center';
        b.__label = l;
        return b;
    }

    function textEntry(parent, id, placeholder, maxchars) {
        var entry;
        try {
            entry = $.CreatePanelWithProperties('TextEntry', parent, id, { maxchars: String(maxchars), placeholder: placeholder });
        } catch (e) {
            entry = $.CreatePanel('TextEntry', parent, id);
        }
        entry.style.height = '30px';
        entry.style.marginTop = '4px';
        // Explicit vertical padding: the default put the text and caret on the bottom edge.
        entry.style.padding = '4px 8px 4px 8px';
        entry.style.fontSize = '14px';
        entry.style.color = COLORS.text;
        entry.style.backgroundColor = COLORS.field;
        entry.style.border = '1px solid ' + COLORS.fieldEdge;
        entry.style.borderRadius = '2px';
        return entry;
    }

    var STORAGE_TEXT = {
        ready: 'Saved on this PC',
        idle: 'Connecting to preset storage...',
        connecting: 'Connecting to preset storage...',
        offline: 'Storage offline: new presets last until restart',
        disabled: 'Presets last until the game restarts'
    };

    // Each preset is a row: an apply button (name over summary) and a delete
    // button. The first delete click arms it: the row edge and the button turn
    // red and show "?"; a second click within 3 s deletes.
    // Display names by hero key, from the grid.
    function heroNames() {
        var names = {};
        readAll(popup).forEach(function (c) { names[c.key] = titleCase(c.name || c.key); });
        return names;
    }

    function renderPresets() {
        if (!valid(ui.presetList)) { return; }
        var names = heroNames();
        try { ui.presetList.RemoveAndDeleteChildren(); } catch (e) { /* older API: rebuilt below anyway */ }
        ui.presetButtons = [];
        var presets = store.list();
        presets.forEach(function (p, i) {
            var confirming = !!(pendingDelete && pendingDelete.id === p.id);
            var r = row(ui.presetList);
            r.style.marginTop = i ? '3px' : '0px';
            var apply = baseButton(r, 'RosterToolsPreset' + i, function () { commands.applyPreset(p.id); }, KINDS.preset);
            apply.style.width = 'fill-parent-flow(1.0)';
            apply.style.marginTop = '0px';
            apply.style.padding = '5px 8px 6px 8px';
            apply.style.flowChildren = 'down';
            apply.style.borderLeft = '2px solid ' + (confirming ? COLORS.error : COLORS.accent + '80');
            var name = label(apply, '', p.name, confirming ? '#ffd0c4' : COLORS.text, 14);
            name.style.fontWeight = 'bold';
            // Described from the heroes on every render, so all presets use the same wording.
            var summary = describePreset(p.heroes, names);
            label(apply, '', summary, COLORS.dim, 11).style.marginTop = '1px';
            var del = button(r, 'RosterToolsPresetDelete' + i, confirming ? '?' : '×',
                function () { commands.deletePreset(p.id); }, confirming ? KINDS.danger : KINDS.quiet);
            del.style.width = '26px';
            del.style.marginTop = '0px';
            del.style.marginLeft = '3px';
            del.style.padding = '5px 0px';
            del.__label.style.fontSize = confirming ? '14px' : '16px';
            del.__label.style.verticalAlign = 'center';
            if (!confirming) {
                // Quiet until hovered, then a warning red.
                del.SetPanelEvent('onmouseover', function () { paint(del, true); del.__label.style.color = COLORS.error; });
                del.SetPanelEvent('onmouseout', function () { paint(del, false); del.__label.style.color = KINDS.quiet.text; });
            }
            ui.presetButtons.push(apply);
        });
        if (!presets.length) {
            var empty = label(ui.presetList, 'RosterToolsNoPresets', 'No presets yet. Pick heroes, name the roster, press Save.',
                COLORS.faint, 12);
            empty.style.marginTop = '2px';
        }
        var status = store.status();
        if (valid(ui.storage)) { ui.storage.text = STORAGE_TEXT[status] || ''; }
        if (valid(ui.storageDot)) { ui.storageDot.style.backgroundColor = STORAGE_DOT[status] || COLORS.faint; }
    }

    function row(parent) {
        var r = $.CreatePanel('Panel', parent, '');
        r.style.width = '100%';
        r.style.flowChildren = 'right';
        return r;
    }

    function half(b, left) {
        b.style.width = 'fill-parent-flow(1.0)';
        if (left) { b.style.marginRight = '2px'; } else { b.style.marginLeft = '2px'; }
        return b;
    }

    // Header band: hover and the moving state show that it can be grabbed.
    function styleHeader() {
        if (!valid(ui.head)) { return; }
        ui.head.style.backgroundColor = moving ? COLORS.bandActive : headerHover ? COLORS.bandHover : COLORS.band;
        var dot = moving || headerHover ? COLORS.accent : COLORS.accent + '73';
        (ui.gripDots || []).forEach(function (d) { d.style.backgroundColor = dot; });
    }

    // Two columns of three dots: the usual "grab here" mark, drawn with panels.
    function grip(parent) {
        var g = $.CreatePanel('Panel', parent, '');
        g.style.flowChildren = 'down';
        g.style.verticalAlign = 'center';
        ui.gripDots = [];
        for (var i = 0; i < 3; i++) {
            var line = row(g);
            line.style.width = 'fit-children';
            for (var j = 0; j < 2; j++) {
                var d = box(line, '', '3px', '3px', COLORS.accent);
                d.style.margin = '1px';
                d.style.borderRadius = '1px';
                ui.gripDots.push(d);
            }
        }
        return g;
    }

    function buildHeader() {
        ui.head = row(bar);
        ui.head.style.borderBottom = '1px solid ' + COLORS.edge;
        ui.headGrip = $.CreatePanel('Button', ui.head, 'RosterToolsHeader');
        var h = ui.headGrip;
        h.style.width = 'fill-parent-flow(1.0)';
        h.style.flowChildren = 'right';
        h.style.padding = '8px 10px 7px 9px';
        grip(h);
        var title = heading(h, 'RosterToolsTitle', 'ROSTER TOOLS', COLORS.accent, 16);
        title.style.width = 'fill-parent-flow(1.0)';
        title.style.marginLeft = '8px';
        title.style.verticalAlign = 'center';
        h.SetPanelEvent('onmouseover', function () { headerHover = true; styleHeader(); });
        h.SetPanelEvent('onmouseout', function () { headerHover = false; styleHeader(); });
        h.SetPanelEvent('onactivate', guard('header click', function () { headerClick(); refreshUi(); }));
        try {
            h.SetDraggable(true);
            $.RegisterEventHandler('DragStart', h, guard('drag start', onDragStart));
            $.RegisterEventHandler('DragEnd', h, guard('drag end', onDragEnd));
        } catch (e) { log('native drag unavailable, click the header to move the panel: ' + e); }

        // Shown only while a custom position is saved.
        ui.reset = button(ui.head, 'RosterToolsReset', 'Reset', commands.resetPosition, KINDS.quiet);
        ui.reset.style.width = 'fit-children';
        ui.reset.style.marginTop = '0px';
        ui.reset.style.marginRight = '6px';
        ui.reset.style.padding = '2px 6px';
        ui.reset.style.verticalAlign = 'center';
        ui.reset.__label.style.fontSize = '11px';
        ui.reset.__label.style.fontWeight = 'normal';
        ui.reset.SetPanelEvent('onmouseover', function () { paint(ui.reset, true); ui.reset.__label.style.color = COLORS.accent; });
        ui.reset.SetPanelEvent('onmouseout', function () { paint(ui.reset, false); ui.reset.__label.style.color = KINDS.quiet.text; });
        styleHeader();
    }

    function buildUi() {
        var old = child(popup, 'RosterToolsBar');
        if (old) { try { old.DeleteAsync(0); } catch (e) { /* gone */ } }
        bar = $.CreatePanel('Panel', popup, 'RosterToolsBar');
        bar.style.width = CFG.barWidth + 'px';
        bar.style.flowChildren = 'down';
        bar.style.backgroundColor = COLORS.panel;
        bar.style.border = '1px solid ' + COLORS.edge;
        bar.style.borderRadius = '3px';
        optionalStyle(bar, 'boxShadow', '0px 8px 24px 0px #000000b3');
        bar.style.zIndex = '50';
        bar.style.position = '900px 160px 0px';
        bar.style.visibility = 'collapse';
        optionalStyle(bar, 'transitionProperty', 'opacity');
        optionalStyle(bar, 'transitionDuration', CFG.fadeIn + 's');

        buildHeader();
        var body = $.CreatePanel('Panel', bar, '');
        body.style.width = '100%';
        body.style.flowChildren = 'down';
        body.style.padding = '9px 11px 10px 11px';

        // Roster: live counter, hints, then the actions.
        ui.counter = label(body, 'RosterToolsCounter', '', COLORS.text, 15);
        ui.hint = label(body, 'RosterToolsHint', '', COLORS.warn, 12);
        ui.hint.style.marginTop = '3px';

        var r0 = row(body);
        r0.style.marginTop = '6px';
        ui.clear = button(r0, 'RosterToolsClear', 'Clear roster', commands.clear, KINDS.primary);
        ui.clear.style.width = 'fill-parent-flow(1.0)';
        ui.undo = button(r0, 'RosterToolsUndo', 'Undo', commands.undo);
        ui.undo.style.width = '70px';
        ui.undo.style.marginLeft = '4px';
        ui.stop = button(body, 'RosterToolsStop', 'Stop', commands.stop, KINDS.danger);
        var r1 = row(body);
        ui.selectAll = half(button(r1, 'RosterToolsSelectAll', 'Select all', commands.selectAll), true);
        ui.invert = half(button(r1, 'RosterToolsInvert', 'Invert', commands.invert), false);
        ui.clearPriorities = button(body, 'RosterToolsClearPriorities', 'Clear priorities', commands.clearPriorities);

        // Presets.
        rule(body, 12);
        heading(body, 'RosterToolsPresetsTitle', 'PRESETS').style.marginTop = '9px';
        var r2 = row(body);
        ui.presetName = textEntry(r2, 'RosterToolsPresetName', 'Preset name', MAX_NAME);
        ui.presetName.style.width = 'fill-parent-flow(1.0)';
        ui.presetName.SetPanelEvent('onmouseover', guard('name hover', holdKeyboard));
        ui.presetName.SetPanelEvent('onactivate', guard('name click', holdKeyboard));
        ui.presetName.SetPanelEvent('onfocus', guard('name focus', holdKeyboard));
        ui.presetName.SetPanelEvent('oninputsubmit', guard('name submit', onEnter));
        ui.savePreset = button(r2, 'RosterToolsSavePreset', 'Save', commands.savePreset, KINDS.primary);
        ui.savePreset.style.width = '60px';
        ui.savePreset.style.height = '30px';
        ui.savePreset.style.padding = '0px';
        ui.savePreset.style.marginLeft = '4px';
        ui.savePreset.__label.style.verticalAlign = 'center';

        // Storage state: a coloured dot and one short line.
        var r3 = row(body);
        r3.style.marginTop = '5px';
        r3.style.marginBottom = '6px';
        ui.storageDot = box(r3, 'RosterToolsStorageDot', '6px', '6px', COLORS.faint);
        ui.storageDot.style.borderRadius = '3px';
        ui.storageDot.style.verticalAlign = 'center';
        ui.storageDot.style.marginRight = '6px';
        ui.storage = label(r3, 'RosterToolsStorage', '', COLORS.dim, 11);
        ui.storage.style.width = 'fill-parent-flow(1.0)';

        ui.presetList = $.CreatePanel('Panel', body, 'RosterToolsPresetList');
        ui.presetList.style.width = '100%';
        ui.presetList.style.flowChildren = 'down';
        ui.presetList.style.maxHeight = '300px';
        ui.presetList.style.overflow = 'squish scroll';
        renderPresets();

        // Result of the last action.
        rule(body, 10);
        ui.status = label(body, 'RosterToolsStatus', lastStatus, COLORS.dim, 12);
        ui.status.style.marginTop = '6px';
    }

    // Starts transparent; the opacity transition runs from the next frame.
    function fadeIn() {
        bar.style.opacity = '0';
        $.Schedule(0, function () { if (valid(bar)) { bar.style.opacity = '1'; } });
    }

    function setVisible(panel, visible) {
        if (!valid(panel)) { return; }
        var wanted = visible ? 'visible' : 'collapse';
        if (panel.style.visibility !== wanted) { panel.style.visibility = wanted; }
    }

    function setEnabled(b, enabled) {
        if (!valid(b)) { return; }
        b.enabled = enabled;
        b.style.opacity = enabled ? '1' : '0.35';
    }

    // A saved position wins; otherwise the bar sits just right of the hero grid.
    // Native layout is never touched.
    function position() {
        if (moving) { return; }
        var saved = store.layout();
        if (saved) { placeAt(clampLayout(saved)); return; }
        var grid = child(popup, 'GridContainer');
        try {
            var g = grid.GetPositionWithinWindow();
            var p = popup.GetPositionWithinWindow();
            var sx = popup.actualuiscale_x || 1;
            var sy = popup.actualuiscale_y || sx;
            if (!(grid.actuallayoutwidth > 0) || !isFinite(g.x) || !isFinite(p.x)) { return; }
            var x = Math.round((g.x - p.x + grid.actuallayoutwidth) / sx + 24);
            var y = Math.round((g.y - p.y) / sy);
            placeAt({ x: x, y: y });
        } catch (e) { /* keep fallback position */ }
    }

    function refreshUi() {
        if (!valid(bar)) { return; }
        // Hidden until the saved position is known, so the bar never jumps there.
        if (!shown()) { openedAt = null; } else if (openedAt === null) { openedAt = Date.now(); }
        var waiting = !store.placed() && openedAt !== null && Date.now() - openedAt < CFG.placeWait * 1000;
        var visible = shown() && rosterMode() && !waiting;
        var appearing = visible && bar.style.visibility !== 'visible';
        setVisible(bar, visible);
        if (appearing) { fadeIn(); }
        if (!visible) { return; }
        position();
        var s = summarize(readStates(popup));
        ui.counter.text = 'Selected ' + s.selected + '\nMid prio ' + s.priority + ' · High prio ' + s.high;
        var notes = hints(s);
        var nativeError = textOf(firstWithClass(popup, 'RosterError')).trim();
        if (nativeError) { notes.unshift(nativeError); }
        ui.hint.text = notes.join('\n');
        setVisible(ui.hint, notes.length > 0);
        var busy = !!op;
        var dead = session.variant.primary.dead;
        ['clear', 'clearPriorities', 'selectAll', 'invert'].forEach(function (k) { setEnabled(ui[k], !busy && !dead); });
        (ui.presetButtons || []).forEach(function (b) { setEnabled(b, !busy && !dead); });
        setEnabled(ui.undo, !busy && !dead && session.undo.length > 0);
        setEnabled(ui.savePreset, !busy && s.selected > 0);
        setVisible(ui.stop, busy);
        setVisible(ui.reset, !!store.layout() && !moving);
        if (typing && !nameFieldBusy()) { releaseKeyboard(); }
        if (valid(ui.status) && ui.status.text !== lastStatus) { ui.status.text = lastStatus; }
    }

    function tick() {
        if (stopped || !valid(popup)) { return; }
        var isShown = shown();
        if (op && (!isShown || !rosterMode())) { cancel('aborted (popup closed or mode changed)'); }
        if (!isShown) { releaseKeyboard(); endMove(); }
        if (isShown && !wasShown && CFG.diagOnFirstOpen && !session.diagDone) {
            session.diagDone = true;
            diagnostics();
        }
        // (Re)connect preset storage each time the popup opens; HTML panels load only while shown.
        if (isShown && !wasShown && rosterMode()) { store.connect(popup); }
        wasShown = isShown;
        refreshUi();
        job = $.Schedule(isShown ? CFG.tickVisible : CFG.tickHidden, guard('tick', tick));
    }

    function start() {
        buildUi();
        job = $.Schedule(0.1, guard('tick', tick));
    }

    return {
        start: start,
        commands: commands,
        busy: function () { return !!op; },
        status: function () { return lastStatus; },
        dispose: function () {
            stopped = true;
            cancel('script reloaded');
            clearPendingDelete();
            endMove(true);
            deleteDragDisplay();
            if (dragGuard) { try { $.CancelScheduled(dragGuard); } catch (e) { /* ran */ } }
            releaseKeyboard();
            store.close();
            if (job !== null) { try { $.CancelScheduled(job); } catch (e) { /* ran */ } }
            if (valid(bar)) { try { bar.DeleteAsync(0); } catch (e) { /* gone */ } }
        }
    };
}

function boot(popup) {
    if (!valid(popup)) { return null; }
    if (popup.__rosterTools) { popup.__rosterTools.dispose(); }
    var session = popup.__rosterToolsSession || (popup.__rosterToolsSession = newSession());
    var controller = createController(popup, session);
    popup.__rosterTools = controller;
    controller.start();
    log('loaded build ' + BUILD_ID + ' v' + VERSION + (BRIDGE_URL ? '' : ' (no preset storage)'));
    return controller;
}

if (typeof globalThis !== 'undefined' && globalThis.__ROSTER_TOOLS_TEST__) {
    globalThis.__ROSTER_TOOLS_TEST__.api = { boot: boot, slug: slug, plan: plan, newSession: newSession,
        readAll: readAll, summarize: summarize, describePreset: describePreset, parseStored: parseStored,
        CFG: CFG, BRIDGE: BRIDGE };
}
if (typeof $ !== 'undefined' && typeof $.GetContextPanel === 'function') {
    guard('boot', boot)($.GetContextPanel());
}

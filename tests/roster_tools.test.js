'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoster } = require('./harness/fake_roster');

const OPERATION_TIME = 30; // virtual seconds, far more than any operation needs

function heroes(states) {
    return Object.entries(states).map(([name, spec], i) => Object.assign({ name, id: i + 1 },
        typeof spec === 'string' ? { state: spec } : spec));
}

function loaded(options) {
    const fake = createRoster(options).load();
    fake.env.run(0.5);
    return fake;
}

// Objects created inside the vm context have foreign prototypes.
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function selectedCount(fake) {
    return Object.values(fake.state()).filter((s) => s !== 'none').length;
}

test('loads, logs build id and runs a one-time diagnostics dump', () => {
    const fake = loaded();
    assert.match(fake.logs(), /\[RosterTools\] loaded build \d+\.\d+\.\d+(-\w+)?\+[0-9a-f]{8}/);
    assert.match(fake.logs(), /diag popup=.* cards=22 ids=22/);
    assert.equal(fake.logs().match(/diag popup=/g).length, 1);
    fake.hide(); fake.env.run(2); fake.show(); fake.env.run(1);
    assert.equal(fake.logs().match(/diag popup=/g).length, 1, 'summary runs once per session');
});

test('the badge icon (class HeroCard) is not mistaken for a card', () => {
    const fake = loaded();
    assert.equal(fake.api.readAll(fake.root).length, 22);
});

test('Clear empties the roster, keeping Avoid and priority token cards', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'high', Bebop: 'priority', Haze: 'selected', Seven: 'selected',
        Shiv: { state: 'selected', token: true }, Wraith: { banned: true }, Ivy: 'none' }) });
    fake.press('Clear');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), { Abrams: 'none', Bebop: 'none', Haze: 'none', Seven: 'none', Shiv: 'selected', Wraith: 'none', Ivy: 'none' });
    const touched = new Set(fake.env.dispatched.map((d) => d.target.hero && d.target.hero.name));
    assert.ok(!touched.has('Shiv') && !touched.has('Wraith'), 'token and banned cards never receive clicks');
    assert.ok(!fake.confirmed, 'Confirm is never activated');
    assert.match(fake.controller.status(), /Clear: done, 4\/4 changed, skipped 1 token/);
});

test('learns transitions that differ from the starting rules', () => {
    // Real-game style: left click on a priority card only drops the priority.
    const fake = loaded({ heroes: heroes({ Abrams: 'high', Bebop: 'priority' }) });
    fake.press('Clear');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), { Abrams: 'none', Bebop: 'none' });
    assert.match(fake.logs(), /primary\[Activated\/mouse\] .*high>selected/);
});

test('finds a working dispatch form when Activated is ignored', () => {
    const fake = loaded({ accepts: { primary: ['HeroCardActivated'], secondary: ['HeroCardContextMenu'] },
        heroes: heroes({ Abrams: 'selected', Bebop: 'selected', Haze: 'none' }) });
    fake.press('Clear');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), { Abrams: 'none', Bebop: 'none', Haze: 'none' });
    assert.match(fake.logs(), /primary works via HeroCardActivated/);
});

test('stops cleanly when no dispatch form works and disables actions', () => {
    const fake = loaded({ accepts: { primary: [], secondary: [] }, heroes: heroes({ Abrams: 'selected', Bebop: 'selected', Haze: 'selected' }) });
    fake.press('Clear');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), { Abrams: 'selected', Bebop: 'selected', Haze: 'selected' });
    assert.match(fake.logs(), /replayed primary clicks are unavailable/);
    assert.equal(fake.controller.busy(), false);
    assert.equal(fake.button('Clear').enabled, false);
    assert.ok(fake.env.dispatched.length <= 12, 'bounded number of attempts: ' + fake.env.dispatched.length);
});

test('works when the native state change arrives late', () => {
    const fake = loaded({ delay: 0.2, heroes: heroes({ Abrams: 'high', Bebop: 'selected', Haze: 'priority' }) });
    fake.press('Clear');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), { Abrams: 'none', Bebop: 'none', Haze: 'none' });
});

test('an unresponsive card is given up on without looping; others still change', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'selected', Bebop: { state: 'selected', unresponsive: true }, Haze: 'selected' }) });
    fake.press('Clear');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), { Abrams: 'none', Bebop: 'selected', Haze: 'none' });
    assert.match(fake.controller.status(), /failed: BEBOP/);
    assert.equal(fake.controller.busy(), false);
});

test('a card removed during the operation is reported, not crashed on', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'selected', Bebop: 'selected', Haze: 'selected' }) });
    fake.press('Clear');
    fake.cards[2].parent.deleted = true;
    fake.cards[2].deleted = true;
    fake.grid.children = fake.grid.children.slice(0, 2);
    fake.env.run(OPERATION_TIME);
    assert.match(fake.logs(), /disappeared/);
    assert.equal(fake.controller.busy(), false);
    assert.doesNotMatch(fake.logs(), /ERROR/);
});

test('a second command while busy is refused', () => {
    const fake = loaded({ delay: 0.2, heroes: heroes({ Abrams: 'selected', Bebop: 'selected', Haze: 'selected' }) });
    assert.equal(fake.controller.commands.clear(), true);
    assert.equal(fake.controller.commands.selectAll(), false);
    assert.match(fake.controller.status(), /Busy/);
    fake.env.run(OPERATION_TIME);
    assert.equal(selectedCount(fake), 0);
});

test('Undo restores the exact snapshot including priorities', () => {
    const start = { Abrams: 'high', Bebop: 'priority', Haze: 'selected', Ivy: 'none', Seven: 'selected' };
    const fake = loaded({ heroes: heroes(start) });
    fake.press('Clear');
    fake.env.run(OPERATION_TIME);
    assert.equal(selectedCount(fake), 0);
    fake.press('Undo');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), start);
    assert.equal(fake.button('Undo').enabled, false, 'undo stack is empty again');
});

test('Clear priorities keeps the selection; Select all skips locked and banned; Invert flips', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'high', Bebop: 'priority', Haze: 'selected', Ivy: 'none',
        Kelvin: { locked: true }, Lash: { banned: true } }) });
    fake.press('ClearPriorities');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), { Abrams: 'selected', Bebop: 'selected', Haze: 'selected', Ivy: 'none', Kelvin: 'none', Lash: 'none' });
    fake.press('SelectAll');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), { Abrams: 'selected', Bebop: 'selected', Haze: 'selected', Ivy: 'selected', Kelvin: 'none', Lash: 'none' });
    fake.setState('Ivy', 'none');
    fake.press('Invert');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), { Abrams: 'none', Bebop: 'none', Haze: 'none', Ivy: 'selected', Kelvin: 'none', Lash: 'none' });
});

test('hidden in single-hero mode and commands refuse to run', () => {
    const fake = loaded({ singleHero: true, heroes: heroes({ Abrams: 'selected', Bebop: 'selected', Haze: 'selected' }) });
    assert.equal(fake.bar().style.visibility, 'collapse');
    assert.equal(fake.controller.commands.clear(), false);
    fake.env.run(OPERATION_TIME);
    assert.equal(fake.env.dispatched.length, 0);
});

test('closing the popup mid-operation aborts it', () => {
    const fake = loaded({ delay: 0.2, heroes: heroes({ Abrams: 'selected', Bebop: 'selected', Haze: 'selected', Ivy: 'selected' }) });
    fake.press('Clear');
    fake.env.run(0.3);
    fake.hide();
    fake.env.run(OPERATION_TIME);
    assert.equal(fake.controller.busy(), false);
    assert.match(fake.controller.status(), /aborted/);
    assert.ok(selectedCount(fake) > 0);
});

test('safety stop when a click changes the avoid state', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'selected', Bebop: 'selected' }) });
    fake.cards[0].native.Activated = () => { fake.cards[0].AddClass('isBanned'); fake.cards[0].RemoveClass('inRoster'); };
    fake.press('Clear');
    fake.env.run(OPERATION_TIME);
    assert.match(fake.logs(), /SAFETY/);
    assert.equal(fake.state().Bebop, 'selected', 'nothing after the safety stop is touched');
});

test('native structure is untouched: bar lives outside the grid, grid order unchanged', () => {
    const fake = createRoster();
    const before = fake.grid.Children();
    const rowBefore = fake.root.FindChildTraverse('HeroRowContainer').Children();
    fake.load();
    fake.env.run(1);
    fake.press('SelectAll');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.grid.Children(), before);
    assert.deepEqual(fake.root.FindChildTraverse('HeroRowContainer').Children(), rowBefore);
    assert.equal(fake.bar().GetParent(), fake.root);
    assert.equal(fake.bar().style.position, (800 + 50 + 24) + 'px ' + (50 + 110) + 'px 0px');
});

test('counter and hints follow the roster and the native RosterError', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'high', Bebop: 'priority', Haze: 'none' }) });
    assert.equal(fake.root.FindChildTraverse('RosterToolsCounter').text, 'Selected 2\nMid prio 1 · High prio 1');
    const hint = fake.root.FindChildTraverse('RosterToolsHint').text;
    assert.match(hint, /SELECT AT LEAST 3 HEROES/);
    assert.match(hint, /at least 3 heroes/);
    assert.doesNotMatch(hint, /new/i, 'no hints about new heroes');
});

test('reloading the script disposes the previous controller and keeps session memory', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'selected', Bebop: 'selected', Haze: 'selected' }) });
    fake.press('Clear');
    fake.env.run(OPERATION_TIME);
    const session = fake.root.__rosterToolsSession;
    fake.load();
    fake.env.run(1);
    assert.equal(fake.root.__rosterToolsSession, session);
    assert.equal(fake.root.FindChildrenWithClassTraverse('x').length, 3);
    assert.equal(fake.root.Children().filter((c) => c.id === 'RosterToolsBar').length, 1);
    fake.press('Undo');
    fake.env.run(OPERATION_TIME);
    assert.equal(selectedCount(fake), 3);
});


test('routes around a click that does nothing in some state (learned after two cards agree)', () => {
    const transitions = {
        primary: { none: 'selected', selected: 'none', priority: 'none', high: 'high' },
        secondary: { none: 'none', selected: 'priority', priority: 'high', high: 'selected' },
    };
    const fake = loaded({ transitions, heroes: heroes({ Abrams: 'high', Bebop: 'high', Haze: 'high', Ivy: 'high' }) });
    fake.press('Clear');
    fake.env.run(OPERATION_TIME);
    assert.deepEqual(fake.state(), { Abrams: 'none', Bebop: 'none', Haze: 'none', Ivy: 'none' });
    assert.doesNotMatch(fake.logs(), /unavailable|trying/, 'no-op in an uncertain state does not reject the dispatch form');
    assert.match(fake.logs(), /primary\[Activated\/mouse\] .*high>high/);
    // Bebop and Haze (proven method) vote the no-op in; Ivy then skips it.
    const onIvy = fake.env.dispatched.filter((d) => d.target.hero && d.target.hero.name === 'Ivy').length;
    assert.equal(onIvy, 2, 'last card goes straight via secondary then primary');
});

test('a synchronous game reaction lets a whole operation finish within a few frames', () => {
    const fake = loaded();
    fake.press('SelectAll');
    fake.env.run(0.05);
    assert.equal(selectedCount(fake), 22);
    assert.equal(fake.controller.busy(), false);
    assert.match(fake.logs(), /Select all: done, 22\/22 changed in \d+\.\d\ds/);
});

// ---------------------------------------------------------------- saved presets

const KEY = 'rostertools.presets.v1';

test('saves the current roster as a named preset with a summary, persisted through the bridge', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'high', Haze: 'high', Bebop: 'priority', Ivy: 'selected', Seven: 'none' }) });
    fake.env.run(1);
    assert.equal(fake.text('Storage'), 'Saved on this PC');
    fake.typeName('Main');
    fake.press('SavePreset');
    fake.env.run(1);
    assert.deepEqual(plain(fake.presetNames()), ['Main']);
    const stored = fake.stored();
    assert.equal(stored.v, 1);
    assert.deepEqual(stored.presets[0].heroes, { abrams: 'high', haze: 'high', bebop: 'priority', ivy: 'selected' });
    assert.equal(stored.presets[0].summary, '4 heroes · High prio: Abrams, Haze · 1 mid prio');
    assert.equal(fake.text('PresetName'), '', 'name field is cleared');
});

test('presets survive a game restart and apply to the roster', () => {
    const storage = new Map();
    const first = loaded({ storage, heroes: heroes({ Abrams: 'high', Bebop: 'selected', Haze: 'none', Ivy: 'none' }) });
    first.env.run(1);
    first.typeName('Main');
    first.press('SavePreset');
    first.env.run(1);

    const second = loaded({ storage, heroes: heroes({ Abrams: 'none', Bebop: 'none', Haze: 'selected', Ivy: 'priority' }) });
    second.env.run(1);
    assert.deepEqual(plain(second.presetNames()), ['Main']);
    second.press('Preset0');
    second.env.run(OPERATION_TIME);
    assert.deepEqual(second.state(), { Abrams: 'high', Bebop: 'selected', Haze: 'none', Ivy: 'none' });
});

test('saving under an existing name updates it; empty name gets a default', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'selected', Bebop: 'selected', Haze: 'none' }) });
    fake.env.run(1);
    fake.typeName('main');
    fake.press('SavePreset');
    fake.setState('Haze', 'high');
    fake.typeName('MAIN');
    fake.press('SavePreset');
    assert.match(fake.controller.status(), /Updated "MAIN"/);
    fake.press('SavePreset');
    fake.env.run(1);
    assert.deepEqual(plain(fake.presetNames()), ['MAIN', 'Preset 2']);
    assert.equal(fake.stored().presets[0].summary, '3 heroes · High prio: Haze');
});

test('save needs a selection', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'none' }) });
    fake.env.run(1);
    assert.equal(fake.button('SavePreset').enabled, false);
    fake.controller.commands.savePreset();
    assert.match(fake.controller.status(), /Select heroes first/);
});

test('delete needs a second click within 3 seconds', () => {
    const fake = loaded({ heroes: heroes({ Abrams: 'selected', Bebop: 'none' }) });
    fake.env.run(1);
    fake.press('SavePreset');
    fake.env.run(1);
    fake.press('PresetDelete0');
    assert.match(fake.controller.status(), /Click again/);
    fake.env.run(3.5);
    fake.press('PresetDelete0');
    assert.equal(fake.presetNames().length, 1, 'confirmation expired');
    fake.press('PresetDelete0');
    fake.env.run(1);
    assert.equal(fake.presetNames().length, 0);
    assert.equal(fake.stored().presets.length, 0);
});

test('large preset lists load in chunks', () => {
    const storage = new Map();
    const many = [];
    for (let i = 0; i < 30; i++) {
        many.push({ id: 'p' + i, name: 'Preset number ' + i, heroes: { abrams: 'high', bebop: 'priority', haze: 'selected', ivy: 'selected' },
            summary: '4 heroes · High: Abrams · 1 priority', updated: i });
    }
    storage.set(KEY, JSON.stringify({ v: 1, presets: many }));
    assert.ok(storage.get(KEY).length > 3000, 'needs more than one chunk');
    const fake = loaded({ storage });
    fake.env.run(3);
    assert.equal(fake.presetNames().length, 30);
    assert.match(fake.logs(), /presets loaded: 30 stored/);
});

test('presets saved with the old wording are shown with today\'s labels', () => {
    const storage = new Map();
    storage.set(KEY, JSON.stringify({ v: 1, presets: [{ id: 'p1', name: 'Old', updated: 1,
        heroes: { abrams: 'high', bebop: 'priority', haze: 'selected' }, summary: '3 heroes · High: Abrams · 1 priority' }] }));
    const fake = loaded({ storage, heroes: heroes({ Abrams: 'none', Bebop: 'none', Haze: 'none' }) });
    fake.env.run(3);
    const row = fake.root.FindChildTraverse('RosterToolsPreset0');
    assert.equal(row.Children()[1].text, '3 heroes · High prio: Abrams · 1 mid prio');
});

test('presets saved before storage connects are merged, not lost', () => {
    const storage = new Map([[KEY, JSON.stringify({ v: 1, presets: [{ id: 'old', name: 'Old', heroes: { abrams: 'selected' }, summary: '1 hero' }] })]]);
    const fake = createRoster({ storage, bridge: { loadDelay: 2 }, heroes: heroes({ Abrams: 'selected', Bebop: 'high' }) }).load();
    fake.env.run(0.5);
    assert.equal(fake.text('Storage'), 'Connecting to preset storage...');
    fake.typeName('Early');
    fake.press('SavePreset');
    fake.env.run(5);
    assert.deepEqual(plain(fake.presetNames()), ['Old', 'Early']);
    assert.deepEqual(plain(fake.stored().presets.map((p) => p.name)), ['Old', 'Early']);
});

test('offline storage: presets still work for the session and the status says so', () => {
    const fake = createRoster({ bridge: { offline: true }, heroes: heroes({ Abrams: 'selected', Bebop: 'none' }) }).load();
    fake.env.run(25);
    assert.equal(fake.text('Storage'), 'Storage offline: new presets last until restart');
    fake.typeName('Session');
    fake.press('SavePreset');
    fake.setState('Abrams', 'none');
    fake.press('Preset0');
    fake.env.run(OPERATION_TIME);
    assert.equal(fake.state().Abrams, 'selected');
    assert.equal(fake.stored(), null);
});

test('missing CitadelHTMLPanel or disabled storage degrade to session presets', () => {
    const noPanel = createRoster({ bridge: null }).load();
    noPanel.env.run(1);
    assert.match(noPanel.logs(), /storage unavailable: CitadelHTMLPanel unavailable/);
    const disabled = createRoster({ bridgeUrl: '' }).load();
    disabled.env.run(1);
    assert.equal(disabled.text('Storage'), 'Presets last until the game restarts');
    assert.match(disabled.logs(), /no preset storage/);
});

test('unreadable stored data is never overwritten', () => {
    const storage = new Map([[KEY, '{"v":2,"presets":[]}']]);
    const fake = loaded({ storage, heroes: heroes({ Abrams: 'selected' }) });
    fake.env.run(1);
    fake.press('SavePreset');
    fake.env.run(1);
    assert.equal(storage.get(KEY), '{"v":2,"presets":[]}');
    assert.match(fake.logs(), /unreadable/);
});

test('the storage page only accepts rostertools keys', () => {
    const fake = loaded();
    fake.env.run(1);
    const panel = fake.root.FindChildTraverse('RosterToolsBridge');
    const url = 'https://piotrpanawas.github.io/deadlock-roster-tools-bridge/bridge.html';
    panel.SetURL(url + '#' + encodeURIComponent(JSON.stringify({ q: 'x1', f: 'set', a: ['other.key', 'v'] })));
    fake.env.run(1);
    assert.ok(!fake.storage.has('other.key'));
    assert.ok(fake.bridgeStats.titles.some((t) => /"q":"x1".*"ok":false.*bad key/.test(t)));
});

test('describePreset keeps summaries short', () => {
    const { describePreset } = loaded().api;
    assert.equal(describePreset({ a: 'high', b: 'high', c: 'high', d: 'high', e: 'selected' }, { a: 'A', b: 'B', c: 'C', d: 'D' }),
        '5 heroes · High prio: A, B, C +1');
    assert.equal(describePreset({ a: 'selected' }, {}), '1 hero');
});

// ---------------------------------------------------------------- typing and moving

function typeName(fake, text) {
    const field = fake.button('PresetName');
    field.hover(true);
    field.events.onactivate();
    fake.env.run(0.1);
    for (const ch of text) { fake.env.typeText(ch); fake.env.run(0.02); }
    return field;
}

// What the game does: every key goes to the quick search, the focus stays on the field.
const GAME = { typing: 'alwaysQuickSearch', quickSearchGrabsFocus: false };

function typeKeys(fake, text) {
    for (const ch of text) { fake.env.typeText(ch); fake.env.run(0.02); }
}

// 'focus' covers a build that lets keys reach the field: the real case is kept there.
for (const [mode, options, expected, expectLog] of [
    ['focus', { quickSearchGrabsFocus: false }, 'Main rOSTER', /typing: characters reach the name field/],
    ['the quick search', GAME, 'Main Roster', /typing: following the quick search/]]) {
    test('preset names with backspaces when keys reach ' + mode, () => {
        const fake = loaded(Object.assign({ heroes: heroes({ Abrams: 'selected', Bebop: 'none' }) }, options));
        fake.env.run(1);
        const field = typeName(fake, 'Main rOSTERx\b');
        assert.equal(field.text, expected);
        assert.match(fake.logs(), expectLog);
        fake.env.run(2);
        assert.equal(field.text, expected, 'the name stays after the quick search resets itself');
        assert.equal(fake.ime.parent.visible, false, 'search text hidden while typing');
        fake.press('SavePreset');
        assert.match(fake.controller.status(), new RegExp('Saved "' + expected + '"'));
        field.hover(false);
        fake.env.focus = null;
        fake.env.run(1);
        assert.equal(fake.ime.parent.visible, true);
    });
}

test('quick search keys: backspace works after the search resets, down to an empty field', () => {
    const fake = loaded(Object.assign({ heroes: heroes({ Abrams: 'selected' }) }, GAME));
    fake.env.run(1);
    const field = typeName(fake, 'abc');
    fake.env.run(2);
    typeKeys(fake, '\b');
    assert.equal(field.text, 'Ab', 'a backspace on the emptied search still deletes');
    fake.env.run(2);
    typeKeys(fake, '\b\b\b');
    assert.equal(field.text, '', 'extra backspaces stop at empty');
    typeKeys(fake, 'cd\b');
    assert.equal(field.text, 'C');
});

test('quick search keys: idle resets, new words and a reset search that starts like the old one', () => {
    const fake = loaded(Object.assign({ heroes: heroes({ Abrams: 'selected' }) }, GAME));
    fake.env.run(1);
    const field = typeName(fake, 'main');
    fake.env.run(1.5);
    assert.equal(field.text, 'Main', 'idle reset keeps the name');
    typeKeys(fake, ' set\b');
    assert.equal(field.text, 'Main Se');
    fake.env.run(1.5);
    typeKeys(fake, ' s'); // the search went " SE" -> reset -> " S": new text, not a backspace
    assert.equal(field.text, 'Main Se S', 'a key after a reset is new text, not a backspace');
    fake.env.run(1.5);
    typeKeys(fake, ' 2-v');
    assert.equal(field.text, 'Main Se S 2-V');
});

test('hero highlighting is suppressed while typing and after leaving the field', () => {
    const fake = loaded(Object.assign({ heroes: heroes({ Abrams: 'selected' }) }, GAME));
    fake.env.run(1);
    const field = typeName(fake, 'ab');
    assert.ok(!fake.root.BHasClass('QuickSearchActive'), 'no hero highlight while typing');
    field.hover(false);
    fake.env.focus = null;
    fake.env.run(0.5);
    assert.ok(!fake.root.BHasClass('QuickSearchActive'));
});

test('Enter in the field saves when the field receives keys', () => {
    const fake = loaded({ quickSearchGrabsFocus: false, heroes: heroes({ Abrams: 'selected' }) });
    fake.env.run(1);
    typeName(fake, 'quick\n');
    assert.match(fake.controller.status(), /Saved "quick"/);
    assert.equal(fake.presetNames().length, 1);
});

test('one Enter saves, with the quick search still active or already reset; a second one adds nothing', () => {
    const fake = loaded(Object.assign({ heroes: heroes({ Abrams: 'selected' }) }, GAME));
    fake.env.run(1);
    const field = typeName(fake, 'main\n');
    assert.match(fake.controller.status(), /Saved "Main"/, 'Enter right after typing');
    assert.equal(field.text, '');
    typeKeys(fake, '\n');
    assert.equal(fake.presetNames().length, 1, 'a second Enter right after a save is ignored');
    fake.env.run(2);
    typeKeys(fake, 'next');
    fake.env.run(2);
    typeKeys(fake, '\n');
    assert.match(fake.controller.status(), /Saved "Next"/, 'Enter after the search reset');
    assert.deepEqual(plain(fake.presetNames()).sort(), ['Main', 'Next']);
});

const DEFAULT_POSITION = (800 + 50 + 24) + 'px ' + (50 + 110) + 'px 0px';

// Holds the left button on the header and drags through `points` (window
// pixels), one point per few frames. Returns the drag callbacks object.
function drag(fake, from, points, options) {
    const header = fake.button('Header');
    fake.env.mouse = from.slice();
    const callbacks = header.dragStart();
    assert.ok(callbacks, 'DragStart accepted');
    for (const p of points) { fake.env.mouse = p.slice(); fake.env.run(0.05); }
    if (!(options && options.keep)) { header.dragEnd(); }
    return callbacks;
}

test('dragging the header moves the panel and saves the position', () => {
    const storage = new Map();
    const fake = loaded({ storage });
    fake.env.run(1);
    const header = fake.button('Header');
    assert.equal(header.IsDraggable(), true);
    assert.equal(fake.button('Move'), null, 'no MOVE button');
    const start = fake.bar().GetPositionWithinWindow();
    const callbacks = drag(fake, [start.x + 10, start.y + 5], [[200, 150], [300 + 10, 200 + 5]], { keep: true });
    assert.equal(fake.bar().style.position, '300px 200px 0px', 'follows the mouse while dragging');
    const display = callbacks.displayPanel;
    assert.ok(display && display.style.width === '1px', 'a tiny display panel stands in for the drag image');
    header.dragEnd();
    fake.env.run(1);
    assert.ok(display.deleted, 'display panel deleted on DragEnd');
    assert.deepEqual(fake.stored().layout, { x: 300, y: 200 });
    assert.match(fake.controller.status(), /Panel position saved/);

    // The release that ended the drag may arrive as a click: it must not pick the panel up.
    fake.env.mouse = [900, 900];
    header.dragStart();
    fake.env.mouse = [600, 400];
    fake.env.run(0.05);
    header.dragEnd();
    header.click();
    fake.env.mouse = [50, 50];
    fake.env.run(1);
    assert.equal(fake.bar().style.position, fake.stored().layout.x + 'px ' + fake.stored().layout.y + 'px 0px',
        'no follow mode after a drag');

    const next = loaded({ storage });
    next.env.run(1);
    assert.equal(next.bar().style.position, fake.bar().style.position, 'restored on the next load');
});

test('a click on the header picks the panel up and the next click drops it', () => {
    const fake = loaded();
    fake.env.run(1);
    const start = fake.bar().GetPositionWithinWindow();
    fake.env.mouse = [start.x + 10, start.y + 5];
    fake.press('Header');
    assert.match(fake.controller.status(), /click to drop/);
    fake.env.mouse = [400 + 10, 250 + 5];
    fake.env.run(0.1);
    assert.equal(fake.bar().style.position, '400px 250px 0px');
    fake.press('Header');
    fake.env.mouse = [10, 10];
    fake.env.run(1);
    assert.equal(fake.bar().style.position, '400px 250px 0px', 'dropped');
    assert.deepEqual(fake.stored().layout, { x: 400, y: 250 });
});

test('Reset is shown only with a saved position and restores the default', () => {
    const fake = loaded();
    fake.env.run(1);
    assert.equal(fake.bar().style.position, DEFAULT_POSITION);
    assert.equal(fake.button('Reset').style.visibility, 'collapse');
    const start = fake.bar().GetPositionWithinWindow();
    drag(fake, [start.x, start.y], [[300, 200]]);
    fake.env.run(1);
    assert.equal(fake.button('Reset').style.visibility, 'visible');
    fake.press('Reset');
    fake.env.run(1);
    assert.equal(fake.bar().style.position, DEFAULT_POSITION);
    assert.equal(fake.stored().layout, null);
    assert.equal(fake.button('Reset').style.visibility, 'collapse');
});

test('the panel cannot be dragged outside the popup', () => {
    const fake = loaded();
    fake.env.run(1);
    fake.bar().layout.width = 248;
    fake.bar().layout.height = 500;
    const start = fake.bar().GetPositionWithinWindow();
    drag(fake, [start.x, start.y], [[5000, -300]]);
    assert.equal(fake.bar().style.position, (1920 - 248) + 'px 0px 0px');
    drag(fake, [1920 - 248, 0], [[-400, 4000]]);
    assert.equal(fake.bar().style.position, '0px ' + (1080 - 500) + 'px 0px');
});

test('closing the popup during a drag ends it', () => {
    const fake = loaded();
    fake.env.run(1);
    const start = fake.bar().GetPositionWithinWindow();
    const callbacks = drag(fake, [start.x, start.y], [[300, 200]], { keep: true });
    fake.hide();
    fake.env.run(2);
    fake.env.mouse = [700, 700];
    fake.env.run(0.5);
    assert.equal(fake.bar().style.position, '300px 200px 0px', 'no longer follows the mouse');
    assert.deepEqual(fake.stored().layout, { x: 300, y: 200 });
    fake.button('Header').dragEnd(); // arrives late: harmless
    fake.env.run(1);
    assert.ok(callbacks.displayPanel.deleted);
    fake.show();
    fake.env.run(1);
    assert.equal(fake.bar().style.position, '300px 200px 0px');
});

// Every frame while the bar is visible: its position. The bar must never show elsewhere first.
function watchPositions(fake, seconds) {
    const seen = [];
    for (let t = 0; t < seconds; t += 0.01) {
        fake.env.run(0.01);
        const bar = fake.bar();
        if (bar && bar.style.visibility === 'visible') { seen.push(bar.style.position); }
    }
    return seen;
}

test('the bar waits hidden for the saved position and then fades in there, without a jump', () => {
    const storage = new Map([[KEY, JSON.stringify({ v: 1, presets: [], layout: { x: 300, y: 200 } })]]);
    const fake = createRoster({ storage, bridge: { loadDelay: 0.5 } }).load();
    const seen = watchPositions(fake, 2);
    assert.ok(seen.length > 0, 'the bar appears');
    assert.deepEqual([...new Set(seen)], ['300px 200px 0px'], 'only ever shown at the saved position');
    assert.equal(fake.bar().style.opacity, '1', 'fade-in finished');
    assert.equal(fake.window.attributes.RosterToolsLayout, '{"x":300,"y":200}', 'position cached for the next opening');
});

test('a position cached for the game session shows the bar in place before storage answers', () => {
    const fake = createRoster({ bridge: { loadDelay: 3 }, windowAttributes: { RosterToolsLayout: '{"x":300,"y":200}' } }).load();
    const seen = watchPositions(fake, 0.5);
    assert.ok(seen.length > 0, 'shown without waiting for storage');
    assert.deepEqual([...new Set(seen)], ['300px 200px 0px']);
    fake.press('Reset');
    assert.equal(fake.window.attributes.RosterToolsLayout, 'null', 'a reset is cached too');
});

test('when storage never answers, the bar still appears at the default position after a short wait', () => {
    const fake = createRoster({ bridge: { offline: true } }).load();
    assert.deepEqual(watchPositions(fake, 1.2), [], 'hidden while the position may still arrive');
    const seen = watchPositions(fake, 1);
    assert.ok(seen.length > 0);
    assert.deepEqual([...new Set(seen)], [DEFAULT_POSITION]);
});

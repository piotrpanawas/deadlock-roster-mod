'use strict';
// Fake CitadelPopupRosterSelect built like the stock layout, with fake native
// click handling. Transition rules and which dispatch forms the "engine"
// accepts are parameters, so tests cover every behaviour the script handles.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { createEnv } = require('./panorama');
const { createBridgeHost } = require('./fake_bridge');

const ROOT = path.resolve(__dirname, '../..');

// Default rules: a left click on a prioritised card drops it to plain
// "selected", which differs from the script's starting rules on purpose.
const DEFAULT_TRANSITIONS = {
    primary: { none: 'selected', selected: 'none', priority: 'selected', high: 'selected' },
    secondary: { none: 'none', selected: 'priority', priority: 'high', high: 'selected' },
};

const HEROES = ['Abrams', 'Bebop', 'Dynamo', 'Grey Talon', 'Haze', 'Infernus', 'Ivy', 'Kelvin', 'Lady Geist',
    'Lash', 'McGinnis', 'Mo & Krill', 'Paradox', 'Pocket', 'Seven', 'Shiv', 'The Doorman', 'Vindicta', 'Viscous',
    'Warden', 'Wraith', 'Yamato'];

function bundleText(bridgeUrl) {
    const args = ['-I', path.join(ROOT, 'tools/bundle.py')];
    if (bridgeUrl !== undefined) { args.push('--bridge-url', bridgeUrl); }
    return execFileSync('python3', args, { encoding: 'utf8' });
}

const bundles = new Map();

function createRoster(options = {}) {
    const env = createEnv();
    const o = Object.assign({
        heroes: HEROES.map((name, i) => ({ name, id: i + 1 })),
        transitions: DEFAULT_TRANSITIONS,
        // Dispatch forms the fake engine reacts to: "Event" or "Event/arg".
        accepts: { primary: ['Activated/mouse', 'Activated', 'HeroCardActivated'], secondary: ['ContextMenu/mouse', 'ContextMenu', 'HeroCardContextMenu'] },
        delay: 0,                 // seconds before the native state change shows
        hidden: false,
        singleHero: false,
        heroIdProperty: true,
        storage: new Map(),       // the embedded browser's localStorage, shared across "game sessions"
        bridge: {},               // fake_bridge options, or null: CitadelHTMLPanel unavailable
        bridgeUrl: undefined,     // undefined = data/bridge.json; '' = storage disabled
        windowAttributes: {},     // attributes already on the top-level panel (kept for the game session)
    }, options);

    // The top-level panel outlives the popup, which the game may create anew for each opening.
    const window = env.panel('Panel', null, 'Window');
    window.attributes = Object.assign({}, o.windowAttributes);
    const root = env.panel('CitadelPopupRosterSelect', window, '');
    root.AddClass('PopupPanel');
    if (o.hidden) { root.AddClass('Hidden'); }
    if (o.singleHero) { root.AddClass('SelectingSingleHero'); }
    root.layout = { x: 0, y: 0, width: 1920, height: 1080 };
    env.root = root;
    const clamp = env.panel('Panel', root, '');
    clamp.AddClass('clampwidth');
    const rowContainer = env.panel('Panel', clamp, 'HeroRowContainer');
    rowContainer.layout = { x: 50, y: 50, width: 860, height: 980 };
    const header = env.panel('Panel', rowContainer, '');
    header.AddClass('GridHeader');
    const title = env.panel('Panel', header, 'TitleArea');
    const modeTitle = env.panel('Label', title, '');
    modeTitle.AddClass('ModeTitle');
    modeTitle.text = 'STANDARD MATCH';
    env.panel('Panel', header, 'PriorityToken');
    const gridContainer = env.panel('Panel', rowContainer, 'GridContainer');
    gridContainer.layout = { x: 0, y: 110, width: 800, height: 710 };
    const grid = env.panel('Panel', gridContainer, 'RosterHeroes');
    const confirmContainer = env.panel('Panel', rowContainer, 'ConfirmButtonContainer');
    const rosterError = env.panel('Label', confirmContainer, '');
    rosterError.AddClass('RosterError');
    const confirm = env.panel('Panel', confirmContainer, 'ConfirmButton');
    // Native quick search: its hidden entry may grab the keyboard focus.
    const quickSearch = env.panel('CitadelQuickSearch', root, 'QuickSearch');
    const ime = env.panel('TextEntry', quickSearch, 'QuickSearchIME');
    // The search string lives in #QuickSearchLabel, upper-cased; while it matches a
    // hero the popup has QuickSearchActive, which dims non-matching cards.
    const searchLabel = env.panel('Label', quickSearch, 'QuickSearchLabel');
    const grabFocus = () => {
        if (ime.acceptsFocus && env.focus !== ime) { env.focus = ime; }
        env.schedule(0.05, grabFocus);
    };
    if (o.quickSearchGrabsFocus !== false) { grabFocus(); }
    // typing: 'focus' = characters follow the keyboard focus;
    // 'alwaysQuickSearch' = the popup always sends them to the quick search (what the game does).
    const focusRoute = env.route;
    env.route = () => {
        if (o.typing === 'alwaysQuickSearch') { return ime; }
        return focusRoute();
    };
    // Key handling of the game's quick search: every key, a backspace on an
    // empty search included, reports the whole upper-cased string with
    // CitadelQuickSearchStringChanged(panel, text). The search resets 1 s after
    // the last key without that event; only its label empties. Enter on a
    // non-empty search raises CitadelQuickSearchActivated and clears it; on an
    // empty one it reaches the focused field as oninputsubmit. The highlight
    // class follows a match a couple of frames later.
    let search = '';
    let typedSeq = 0;
    const raise = (name, ...args) => {
        const handler = quickSearch.handlers && quickSearch.handlers[name];
        if (handler) { handler(quickSearch, ...args); }
    };
    const matches = () => search.length > 0 &&
        o.heroes.some((h) => h.name.toUpperCase().includes(search));
    const reset = () => {
        search = '';
        searchLabel.text = '';
        root.RemoveClass('QuickSearchActive');
    };
    ime.onKey = (ch) => {
        if (ch === '\n') {
            if (search) { raise('CitadelQuickSearchActivated', search); reset(); return; }
            const focused = env.focus;
            if (focused && focused !== ime && focused.events.oninputsubmit) { focused.events.oninputsubmit(); }
            return;
        }
        search = ch === '\b' ? search.slice(0, -1) : search + ch.toUpperCase();
        searchLabel.text = search;
        raise('CitadelQuickSearchStringChanged', search);
        env.schedule(0.03, () => { root.SetHasClass('QuickSearchActive', matches()); });
        const seq = ++typedSeq;
        env.schedule(1, () => { if (seq === typedSeq) { reset(); } });
    };

    const fake = { env, root, window, grid, confirm, rosterError, cards: [], options: o, nativeCalls: 0, storage: o.storage, ime };
    fake.bridgeStats = o.bridge ? createBridgeHost(env, o.storage, o.bridge) : null;
    confirm.native.Activated = () => { fake.confirmed = true; };

    const updateError = () => {
        const selected = fake.cards.filter((c) => c.BHasClass('inRoster')).length;
        rosterError.text = selected > 0 && selected < 3 ? 'SELECT AT LEAST 3 HEROES' : '';
        root.SetHasClass('HasHeroesInRoster', selected > 0);
    };

    const setState = (card, state) => {
        card.SetHasClass('inRoster', state !== 'none');
        card.SetHasClass('isPriority', state === 'priority');
        card.SetHasClass('isHighPriority', state === 'high');
        updateError();
    };
    const getState = (card) => (card.BHasClass('isHighPriority') ? 'high' : card.BHasClass('isPriority') ? 'priority'
        : card.BHasClass('inRoster') ? 'selected' : 'none');

    o.heroes.forEach((h) => {
        const wrapper = env.panel('Panel', grid, '');
        const card = env.panel('CitadelHeroCard', wrapper, '');
        card.AddClass('HeroCard');
        card.AddClass('RosterSelect');
        const backer = env.panel('Panel', card, 'CardBacker');
        backer.AddClass('x');
        const image = env.panel('CitadelHeroImage', card, 'HeroImage');
        const plate = env.panel('Panel', card, 'NamePlate');
        const info = env.panel('Panel', plate, 'HeroInfo');
        const label = env.panel('Label', info, 'HeroName');
        label.text = h.name.toUpperCase();
        const badge = env.panel('CitadelHeroBadgeIcon', card, 'HeroBadgeIcon');
        badge.AddClass('HeroCard'); // as in stock layout: must not be mistaken for a card
        if (o.heroIdProperty) { badge.heroid = h.id; image.heroid = h.id; }
        if (h.banned) { card.AddClass('isBanned'); }
        if (h.token) { card.AddClass('isPriorityToken'); }
        if (h.locked) { card.AddClass('rankedLocked'); }
        card.hero = h;
        setState(card, h.state || 'none');

        const react = (action) => () => {
            fake.nativeCalls++;
            if (h.unresponsive || card.BHasClass('isBanned') || card.BHasClass('rankedLocked')) { return; }
            const apply = () => setState(card, o.transitions[action][getState(card)]);
            if (o.delay > 0) { env.schedule(o.delay, apply); } else { apply(); }
        };
        ['primary', 'secondary'].forEach((action) => {
            const forms = o.accepts[action];
            const handler = react(action);
            card.native[action === 'primary' ? 'Activated' : 'ContextMenu'] = (...args) => {
                const name = action === 'primary' ? 'Activated' : 'ContextMenu';
                if (forms.includes(name + '/' + args[0]) || (!args.length && forms.includes(name))) { handler(); }
            };
            const direct = action === 'primary' ? 'HeroCardActivated' : 'HeroCardContextMenu';
            card.native[direct] = () => { if (forms.includes(direct)) { handler(); } };
        });
        fake.cards.push(card);
    });
    updateError();

    fake.state = () => Object.fromEntries(fake.cards.map((c) => [c.hero.name, getState(c)]));
    fake.setState = (name, state) => setState(fake.cards.find((c) => c.hero.name === name), state);
    fake.show = () => root.RemoveClass('Hidden');
    fake.hide = () => root.AddClass('Hidden');
    fake.bar = () => root.FindChildTraverse('RosterToolsBar');
    fake.button = (id) => root.FindChildTraverse('RosterTools' + id);
    fake.press = (id) => { fake.button(id).click(); };
    fake.logs = () => env.logs.join('\n');
    fake.text = (id) => root.FindChildTraverse('RosterTools' + id).text;
    fake.typeName = (name) => { root.FindChildTraverse('RosterToolsPresetName').text = name; };
    fake.presetNames = () => root.FindChildTraverse('RosterToolsPresetList').Children()
        .map((r) => r.children[0] && r.children[0].children[0] && r.children[0].children[0].text).filter(Boolean);
    fake.stored = () => (o.storage.has('rostertools.presets.v1') ? JSON.parse(o.storage.get('rostertools.presets.v1')) : null);

    fake.load = () => {
        const cacheKey = String(o.bridgeUrl);
        if (!bundles.has(cacheKey)) { bundles.set(cacheKey, bundleText(o.bridgeUrl)); }
        // Date.now() follows the virtual clock, like real time does in game.
        const FakeDate = class extends Date {};
        FakeDate.now = () => 1.8e12 + Math.round(env.time * 1000);
        const context = { $: env.$, __ROSTER_TOOLS_TEST__: {}, Date: FakeDate };
        context.globalThis = context;
        vm.createContext(context);
        vm.runInContext(bundles.get(cacheKey), context, { filename: 'roster_tools.bundle.js' });
        fake.api = context.__ROSTER_TOOLS_TEST__.api;
        fake.controller = root.__rosterTools;
        return fake;
    };
    return fake;
}

module.exports = { createRoster, bundleText, HEROES, DEFAULT_TRANSITIONS, ROOT };

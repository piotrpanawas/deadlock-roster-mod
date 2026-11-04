'use strict';
// Minimal fake of Deadlock's Panorama JS environment: panels, classes, a
// virtual-clock $.Schedule, $.DispatchEvent routed to fake native handlers.
// Only behaviour the mod relies on is modelled.

class Panel {
    constructor(env, paneltype, parent, id) {
        this.env = env;
        this.paneltype = paneltype;
        this.id = id || '';
        this.children = [];
        this.parent = null;
        this.classes = new Set();
        this.style = {};
        this.text = '';
        this.enabled = true;
        this.visible = true;
        this.events = {};
        this.native = {};        // event name -> fn(...args): fake C++ handlers
        this.deleted = false;
        this.acceptsFocus = true;
        this.acceptsInput = true;
        this.hovered = false;
        this.layout = { x: 0, y: 0, width: 0, height: 0 };
        this.actualuiscale_x = 1;
        this.actualuiscale_y = 1;
        if (parent) { parent.addChild(this); }
    }
    addChild(panel) { panel.parent = this; this.children.push(panel); }
    IsValid() { return !this.deleted; }
    BHasClass(name) { return this.classes.has(name); }
    AddClass(name) { this.classes.add(name); }
    RemoveClass(name) { this.classes.delete(name); }
    SetHasClass(name, on) { if (on) { this.AddClass(name); } else { this.RemoveClass(name); } }
    Children() { return this.children.slice(); }
    GetParent() { return this.parent; }
    GetAttributeString(name, fallback) {
        if (name === 'class') { return [...this.classes].join(' '); }
        return this.attributes && name in this.attributes ? this.attributes[name] : fallback;
    }
    SetAttributeString(name, value) { (this.attributes = this.attributes || {})[name] = String(value); }
    SetPanelEvent(name, fn) { this.events[name] = fn; }
    RemoveAndDeleteChildren() {
        this.children.forEach((c) => { c.deleted = true; });
        this.children = [];
    }
    DeleteAsync(delay) {
        this.env.schedule(delay, () => {
            this.deleted = true;
            if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); }
        });
    }
    FindChildTraverse(id) {
        for (const c of this.children) {
            if (c.id === id) { return c; }
            const found = c.FindChildTraverse(id);
            if (found) { return found; }
        }
        return null;
    }
    FindChildrenWithClassTraverse(name) {
        const out = [];
        const walk = (p) => p.children.forEach((c) => { if (c.classes.has(name)) { out.push(c); } walk(c); });
        walk(this);
        return out;
    }
    // style.position ("Xpx Ypx 0px") offsets a panel like it does in game.
    GetPositionWithinWindow() {
        let x = 0; let y = 0;
        for (let p = this; p; p = p.parent) {
            const m = /^(-?[\d.]+)px (-?[\d.]+)px/.exec(p.style.position || '');
            x += p.layout.x + (m ? Number(m[1]) : 0);
            y += p.layout.y + (m ? Number(m[2]) : 0);
        }
        return { x, y };
    }
    BAcceptsFocus() { return this.acceptsFocus; }
    BAcceptsInput() { return this.acceptsInput; }
    SetAcceptsFocus(on) { this.acceptsFocus = !!on; }
    SetAcceptsInput(on) { this.acceptsInput = !!on; }
    SetFocus() { if (this.acceptsFocus) { this.env.focus = this; } }
    BHasKeyFocus() { return this.env.focus === this; }
    BHasHoverStyle() { return this.hovered; }
    // Test helpers: hover and typing as the engine routes them.
    hover(on) { this.hovered = on; const e = this.events[on ? 'onmouseover' : 'onmouseout']; if (e) { e(); } }
    type(text) { this.env.typeText(text); }
    get actuallayoutwidth() { return this.layout.width; }
    get actuallayoutheight() { return this.layout.height; }
    // Test helper: what a real mouse click on this panel would do.
    click() { if (this.enabled !== false && this.events.onactivate) { this.events.onactivate(); } }
    SetDraggable(on) { this.draggable = !!on; }
    IsDraggable() { return !!this.draggable; }
    // Test helpers: a native drag as Dota-style Panorama runs it. dragStart()
    // fires DragStart with a callbacks object and returns it (null if the panel
    // is not draggable or the handler refused); dragEnd() fires DragEnd with the
    // display panel the handler supplied.
    dragStart() {
        const handler = this.handlers && this.handlers.DragStart;
        if (!this.draggable || !handler) { return null; }
        const callbacks = {};
        if (!handler(this.id, callbacks)) { return null; }
        this.env.dragging = { source: this, callbacks };
        return callbacks;
    }
    dragEnd() {
        const drag = this.env.dragging;
        this.env.dragging = null;
        const handler = this.handlers && this.handlers.DragEnd;
        if (drag && handler) { handler(this.id, drag.callbacks.displayPanel); }
    }
}

function createEnv() {
    const env = {
        time: 0,
        queue: [],
        nextHandle: 1,
        logs: [],
        dispatched: [],
        html: null,          // fn(panel) wiring a fake CitadelHTMLPanel; null = panel type unavailable
        focus: null,         // panel with keyboard focus
        mouse: [0, 0],
        dragging: null,      // { source, callbacks } while a native drag runs
        root: null,
    };
    env.schedule = (delay, fn) => {
        const handle = env.nextHandle++;
        // A zero delay means "next frame" in game; a 1 ms step keeps per-frame loops finite.
        env.queue.push({ at: env.time + Math.max(0.001, Number(delay) || 0), seq: handle, handle, fn });
        return handle;
    };
    env.run = (seconds) => {
        const end = env.time + seconds;
        for (;;) {
            env.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
            const next = env.queue[0];
            if (!next || next.at > end) { break; }
            env.queue.shift();
            env.time = next.at;
            next.fn();
        }
        env.time = end;
    };
    env.$ = {
        Msg: (...parts) => { env.logs.push(parts.join(' ')); },
        Warning: (...parts) => { env.logs.push('WARNING ' + parts.join(' ')); },
        Schedule: (delay, fn) => env.schedule(delay, fn),
        CancelScheduled: (handle) => { env.queue = env.queue.filter((q) => q.handle !== handle); },
        DispatchEvent: (name, target, ...args) => {
            env.dispatched.push({ name, target, args });
            const handler = target && target.native && target.native[name];
            if (handler) { handler(...args); }
        },
        CreatePanel: (type, parent, id) => {
            const panel = new Panel(env, type, parent, id);
            if (type === 'CitadelHTMLPanel') {
                if (!env.html) { throw new Error('CitadelHTMLPanel unavailable'); }
                env.html(panel);
            }
            return panel;
        },
        RegisterEventHandler: (name, panel, fn) => { panel.handlers = panel.handlers || {}; panel.handlers[name] = fn; },
        CreatePanelWithProperties: (type, parent, id, props) => {
            const panel = new Panel(env, type, parent, id);
            panel.properties = Object.assign({}, props);
            return panel;
        },
        GetContextPanel: () => env.root,
        MousePosition: () => env.mouse.slice(),
        RegisterKeyBind: (panel, key, fn) => { panel.keybinds = panel.keybinds || {}; panel.keybinds[key] = fn; },
        Localize: (token) => token,
    };
    env.panel = (type, parent, id) => new Panel(env, type, parent, id);
    // Typed characters go to env.route(), by default the focused text entry
    // if it accepts input. "\b" is a backspace.
    env.route = () => {
        const target = env.focus;
        return target && target.acceptsInput && !target.deleted ? target : null;
    };
    // "\n" is Enter. Key binds of the focused panel fire first; then the routed
    // entry edits its text (through its `transform`, if any) or submits.
    env.typeText = (text) => {
        for (const ch of text) {
            const focus = env.focus;
            const bind = { '\b': 'key_backspace', '\n': 'key_enter' }[ch];
            if (bind && focus && focus.keybinds && focus.keybinds[bind]) { focus.keybinds[bind](); }
            const target = env.route();
            if (!target) { continue; }
            if (target.onKey) { target.onKey(ch); continue; } // a native entry with its own key handling
            if (ch === '\n') {
                if (target.events.oninputsubmit) { target.events.oninputsubmit(); }
            } else {
                target.text = ch === '\b' ? target.text.slice(0, -1) : target.text + (target.transform ? target.transform(ch) : ch);
            }
            if (target.onTyped) { target.onTyped(); }
        }
    };
    return env;
}

module.exports = { Panel, createEnv };

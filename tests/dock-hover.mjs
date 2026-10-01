import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Signals {
    handlers = new Map();
    nextId = 1;
    connect(name, callback) {
        const id = this.nextId++;
        this.handlers.set(id, {name, callback});
        return id;
    }
    disconnect(id) {
        assert.ok(this.handlers.delete(id), `Unknown signal ${id}`);
    }
    connectObject(name, callback, owner) {
        const id = this.connect(name, callback);
        (owner.ownedConnections ??= []).push([this, id]);
    }
    emit(name, ...args) {
        for (const handler of [...this.handlers.values()]) {
            if (handler.name === name)
                handler.callback(this, ...args);
        }
    }
}

class Actor extends Signals {
    children = [];
    visible = true;
    constructor(properties = {}) {
        super();
        Object.assign(this, properties);
    }
    set_child(child) { this.add_child(child); }
    add_child(child) {
        assert.ok(!child.parent);
        this.children.push(child);
        child.parent = this;
    }
    remove_child(child) {
        assert.equal(child.parent, this);
        this.children.splice(this.children.indexOf(child), 1);
        child.parent = null;
    }
    get_children() { return this.children; }
    set_size(width, height) { Object.assign(this, {width, height}); }
    set_position(x, y) { Object.assign(this, {x, y}); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    remove_all_transitions() { animations.delete(this); }
    ease(options) {
        animations.set(this, {options, at: now + options.duration * 1000});
    }
    contains(actor) { return this === actor || this.children.some(c => c.contains(actor)); }
    destroy() {
        this.remove_all_transitions();
        for (const [object, id] of this.ownedConnections ?? [])
            object.disconnect(id);
        this.parent?.remove_child(this);
        for (const child of [...this.children])
            child.destroy();
        this.handlers.clear();
        this.destroyed = true;
    }
}

class Dash extends Actor {
    showAppsButton = new Actor({checked: false});
    _box = new Actor();
    add_style_class_name() {}
    get_preferred_height() { return [80, 80]; }
    get_preferred_width() { return [100, 600]; }
    setMaxSize() {}
}

let now = 0;
let pointer = [0, 0];
let focus = null;
let nextSourceId = 1;
const sources = new Map();
const animations = new Map();
const GLib = {
    PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 1,
    SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
    get_monotonic_time: () => now,
    timeout_add(_priority, delay, callback) {
        const id = nextSourceId++;
        sources.set(id, {delay, callback, at: now + delay * 1000});
        return id;
    },
    idle_add(priority, callback) { return this.timeout_add(priority, 0, callback); },
    source_remove(id) { assert.ok(sources.delete(id), `Unknown source ${id}`); },
};
function advance(ms) {
    now += ms * 1000;
    for (const [actor, animation] of [...animations]) {
        if (animation.at > now)
            continue;
        animations.delete(actor);
        const {opacity, translation_y, onComplete} = animation.options;
        Object.assign(actor, {opacity, translation_y});
        onComplete?.();
    }
    for (const [id, source] of [...sources]) {
        if (source.at > now)
            continue;
        if (!source.callback())
            sources.delete(id);
        else
            source.at = now + source.delay * 1000;
    }
}

const monitor = {x: -1920, y: 120, width: 1920, height: 1080};
const chrome = new Actor();
const tracked = new Set();
const chromeOptions = new Map();
const settings = new Signals();
settings.enabled = true;
settings.get_boolean = key => {
    assert.equal(key, 'reveal-dock-on-hover');
    return settings.enabled;
};
const Main = {
    overview: Object.assign(new Signals(), {visible: false}),
    sessionMode: Object.assign(new Signals(), {currentMode: 'user', isLocked: false}),
    layoutManager: Object.assign(new Signals(), {
        monitors: [monitor],
        overviewGroup: new Actor(),
        addChrome(actor, options) {
            assert.equal(options.affectsStruts, false);
            chrome.add_child(actor);
            tracked.add(actor);
            chromeOptions.set(actor, options);
            this._updateVisibility();
        },
        removeChrome(actor) {
            assert.ok(tracked.delete(actor));
            chromeOptions.delete(actor);
            chrome.remove_child(actor);
        },
        _updateVisibility() {
            // GNOME sets visible=true for tracked chrome on a non-fullscreen
            // monitor, even if the extension previously called hide().
            for (const actor of tracked) {
                if (chromeOptions.get(actor).trackFullscreen)
                    actor.visible = !monitor.inFullscreen;
            }
        },
    }),
};
const display = new Signals();
const source = readFileSync(new URL('../mmdock.js', import.meta.url), 'utf8');
const context = vm.createContext({
    St: {Bin: Actor, Widget: Actor}, GLib, Main,
    Clutter: {ActorAlign: {CENTER: 1, END: 2}, EVENT_PROPAGATE: false,
        AnimationMode: {EASE_OUT_CUBIC: 1, EASE_IN_OUT_CUBIC: 2}},
    DashModule: {Dash}, OverviewControls: {},
    global: {display, get_pointer: () => pointer, stage: {get_key_focus: () => focus}},
});
const Dock = vm.runInContext(source.replace(/^import .*;\n/gm, '')
    .replace('export class MultiMonitorsDock', 'class MultiMonitorsDock') +
    '\nMultiMonitorsDock;', context);
const dock = new Dock(monitor, settings);
advance(0);
assert.equal(dock._bin.visible, false);
assert.equal(dock._edge.visible, true);
assert.equal(dock._edge.y, 1198);
assert.equal(dock._edge.x, -1260);
assert.equal(dock._edge.width, 600);
assert.equal(sources.size, 0, 'No polling while hidden');
Main.layoutManager._updateVisibility();
assert.equal(dock._bin.visible, false, 'Shell layout refresh must not reveal a hidden dock');

function reveal() {
    pointer = [dock._edge.x + 100, dock._edge.y];
    dock._edge.emit('enter-event');
    assert.equal(dock._bin.visible, true);
}
function leave() {
    pointer = [0, 0];
    advance(100);
    advance(300);
    advance(280);
}
reveal();
pointer[1] -= 40;
advance(100);
assert.equal(dock._bin.visible, true, 'Moving onto icons keeps dock visible');
leave();
assert.equal(dock._bin.visible, false);
assert.equal(sources.size, 0);

reveal();
const menu = {isOpen: true};
dock._dash._box.children = [{child: {menu}}];
leave();
assert.equal(dock._bin.visible, true, 'App menus keep the dock visible');
menu.isOpen = false;
leave();
assert.equal(dock._bin.visible, false);

reveal();
focus = dock._dash;
leave();
assert.equal(dock._bin.visible, true, 'Keyboard focus keeps the dock visible');
focus = null;
leave();
assert.equal(dock._bin.visible, false);

// A click must dismiss even when the same app remains focused, and the
// pointer stays on the newly uncovered trigger throughout the animation.
const icon = new Actor({_delegate: {app: {}}});
dock._dash._box.emit('child-added', {child: icon});
reveal();
assert.equal(dock._slide.opacity, 0);
assert.equal(dock._slide.translation_y, dock._bin.height);
assert.equal(dock._bin.clip_to_allocation, true);
advance(350);
assert.equal(dock._slide.opacity, 255);
assert.equal(dock._slide.translation_y, 0);
icon.emit('clicked');
assert.equal(dock._hiding, true);
advance(280);
assert.equal(dock._bin.visible, false);
dock._edge.emit('enter-event');
assert.equal(dock._bin.visible, false, 'Uncovering the edge must not reopen the dock');
leave();
reveal();
focus = dock._dash;
display.focus_window = {};
display.emit('notify::focus-window');
advance(280);
assert.equal(dock._bin.visible, false, 'App activation overrides pointer and stale icon focus');
Main.layoutManager._updateVisibility();
assert.equal(dock._bin.visible, false, 'Restacking the newly opened app must not reopen the dock');
leave();
reveal();
leave();
assert.equal(dock._bin.visible, false, 'Stale icon focus cannot keep dock open over an app');
focus = null;
display.focus_window = null;

// An overview transition must cancel a pending hide completion.
reveal();
dock._hideDesktopDock(true);
Main.overview.visible = true;
Main.overview.emit('showing');
advance(350);
assert.equal(dock._bin.visible, true);
assert.equal(dock._slide.opacity, 255);
assert.equal(dock._slide.translation_y, 0);
Main.overview.visible = false;
Main.overview.emit('hidden');
advance(0);

reveal();
Main.overview.visible = true;
Main.overview.emit('showing');
assert.equal(dock._bin.parent, Main.layoutManager.overviewGroup);
assert.equal(dock._bin.visible, true);
assert.equal(dock._edge.visible, false);
advance(500);
assert.equal(dock._bin.visible, true, 'Old timeout cannot hide overview dock');
Main.overview.emit('hiding');
Main.overview.visible = false;
Main.overview.emit('hidden');
advance(0);
assert.equal(dock._bin.parent, chrome);
assert.equal(dock._bin.visible, false);
assert.equal(dock._edge.visible, true);

reveal();
settings.enabled = false;
settings.emit('changed::reveal-dock-on-hover');
assert.equal(dock._edge.visible, false);
assert.equal(dock._bin.visible, false);
Main.layoutManager._updateVisibility();
assert.equal(dock._edge.visible, false, 'Shell refresh must respect disabled hover');
dock._edge.emit('enter-event');
assert.equal(dock._bin.visible, false);
settings.enabled = true;
settings.emit('changed::reveal-dock-on-hover');

for (const state of ['lock', 'fullscreen']) {
    reveal();
    if (state === 'lock') {
        Main.sessionMode.isLocked = true;
        Main.sessionMode.emit('updated');
    } else {
        monitor.inFullscreen = true;
        display.emit('in-fullscreen-changed');
    }
    assert.equal(dock._bin.visible, false, state);
    assert.equal(dock._edge.visible, false, state);
    Main.sessionMode.isLocked = false;
    monitor.inFullscreen = false;
    Main.sessionMode.emit('updated');
}

reveal();
dock.updateMonitor({x: 100, y: -1080, width: 1280, height: 720});
assert.equal(dock._bin.visible, false);
assert.equal(dock._edge.x, 440);
assert.equal(dock._edge.y, -362);
reveal();
dock._dash.emit('notify::width');
dock.destroy();
assert.equal(sources.size, 0, 'Destroy cancels hover and layout sources');
assert.equal(tracked.size, 0);
assert.equal(settings.handlers.size, 0);
assert.equal(Main.overview.handlers.size, 0);
assert.equal(Main.sessionMode.handlers.size, 0);
assert.equal(display.handlers.size, 0);
assert.equal(icon.handlers.size, 0);
assert.equal(animations.size, 0);
assert.equal(Main.layoutManager.handlers.size, 0);

Main.layoutManager._startingUp = true;
const startupDock = new Dock(monitor, settings, {showInOverview: false});
assert.equal(startupDock._edge.visible, false);
startupDock._edge.emit('enter-event');
assert.equal(startupDock._bin.visible, false, 'Startup must not accept hover activation');
Main.layoutManager._updateVisibility();
assert.equal(startupDock._bin.visible, false);
Main.layoutManager._startingUp = false;
Main.layoutManager.emit('startup-complete');
assert.equal(startupDock._edge.visible, true);
assert.equal(startupDock._bin.visible, false, 'Startup completion only enables the trigger');
startupDock.destroy();
assert.equal(Main.layoutManager.handlers.size, 0);

Main.overview.visible = true;
const overviewDock = new Dock(monitor, settings);
assert.equal(overviewDock._bin.parent, Main.layoutManager.overviewGroup);
overviewDock.destroy();
assert.equal(Main.layoutManager.overviewGroup.children.length, 0);
assert.equal(tracked.size, 0);
assert.equal(sources.size, 0);

// Exercise the actual extension entry point with a single primary monitor.
// A dock-only unit test would miss a factory that skips primary displays.
const extensionSource = readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
Object.assign(context, {Extension: class {}, MMDock: {MultiMonitorsDock: Dock}, log() {}});
const ExtensionClass = vm.runInContext(extensionSource.slice(
    extensionSource.indexOf('export default class MultiMonitorsExtension'))
    .replace('export default class', 'class') + '\nMultiMonitorsExtension;', context);
const extension = new ExtensionClass({});
extension._settings = settings;
extension._hideThumbnailsSlider = () => {};
extension._showThumbnailsSlider = () => {};
Main.overview.visible = false;
Main.layoutManager.primaryIndex = 0;
Main.layoutManager.monitors = [monitor];
extension._relayout();
const primaryDock = extension._primaryDock;
assert.ok(primaryDock, 'Single-display setup creates a desktop hover dock');
pointer = [primaryDock._edge.x + 100, primaryDock._edge.y];
primaryDock._edge.emit('enter-event');
assert.equal(primaryDock._bin.visible, true);
Main.overview.visible = true;
Main.overview.emit('showing');
assert.equal(primaryDock._bin.visible, false, 'Primary overview keeps only the built-in dash');
Main.overview.visible = false;
Main.overview.emit('hidden');
assert.equal(primaryDock._edge.visible, true);
Main.layoutManager.monitors = [monitor, {x: 0, y: 0, width: 1280, height: 720}];
Main.layoutManager.primaryIndex = 1;
extension._relayout();
assert.equal(extension._primaryDock, primaryDock);
assert.equal(primaryDock._edge.y, 718, 'Primary reassignment moves the hover trigger');
Main.layoutManager.monitors = [];
Main.layoutManager.primaryIndex = -1;
extension._relayout();
assert.equal(extension._primaryDock, null);
assert.equal(sources.size, 0);
assert.equal(tracked.size, 0);
console.log('Dock hover lifecycle tests passed');

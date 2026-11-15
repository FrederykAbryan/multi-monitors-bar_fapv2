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
    scale_x = 1;
    scale_y = 1;
    translation_x = 0;
    pivot = [0, 0];
    get_pivot_point() { return this.pivot; }
    set_pivot_point(x, y) { this.pivot = [x, y]; }
    get_transformed_position() {
        return [this.x + this.translation_x - this.width * (this.scale_x - 1) * this.pivot[0], this.y];
    }
    get_transformed_size() { return [this.width * this.scale_x, this.height * this.scale_y]; }
    remove_transition() { animations.delete(this); }
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
    get_parent() { return this.parent; }
    insert_child_at_index(child, index) {
        this.add_child(child);
        this.children.pop();
        this.children.splice(index, 0, child);
    }
    queue_relayout() {}
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
    _background = Object.assign(new Actor({width: 600}), {
        add_effect_with_name(name, effect) { this.effect = effect; },
        remove_effect(effect) { assert.equal(this.effect, effect); this.effect = null; },
    });
    populated = false;
    _redisplay() { this.populated = true; }
    showAppsButton = new Actor({checked: false});
    _box = new Actor({clip_to_allocation: true});
    styleClasses = new Set();
    has_style_class_name(name) { return this.styleClasses.has(name); }
    add_style_class_name(name) { this.styleClasses.add(name); }
    remove_style_class_name(name) { this.styleClasses.delete(name); }
    get_preferred_height() { return [80, 80]; }
    get_preferred_width() { return [100, this.populated ? 600 : 1]; }
    setMaxSize() {}
}

let now = 0;
let pointer = [0, 0];
let focus = null;
let nextSourceId = 1;
const sources = new Map();
const animations = new Map();
const timelines = new Set();
class Timeline extends Signals {
    start() { timelines.add(this); }
    stop() { timelines.delete(this); }
    get_delta() { return this.delta; }
}

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
    for (let elapsed = 0; elapsed < ms; elapsed += 16) {
        for (const timeline of [...timelines]) {
            timeline.delta = Math.min(16, ms - elapsed);
            timeline.emit('new-frame');
        }
    }
    for (const [actor, animation] of [...animations]) {
        if (animation.at > now)
            continue;
        animations.delete(actor);
        const {duration, mode, onComplete, ...properties} = animation.options;
        Object.assign(actor, properties);
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
    if (key === 'dock-magnification')
        return settings.magnification ?? false;
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
const stage = Object.assign(new Signals(), {get_key_focus: () => focus});
const liveIsolations = new Set();
const source = readFileSync(new URL('../mmdock.js', import.meta.url), 'utf8');
const context = vm.createContext({
    Gio: {Settings: class extends Signals {
        scheme = 'default';
        get_string() { return this.scheme; }
    }},
    Shell: {BlurMode: {BACKGROUND: 1}, BlurEffect: class {
        radius = 0;
        constructor(properties) { Object.assign(this, properties); }
    }},
    St: {Bin: Actor, Widget: Actor}, GLib, Main,
    Clutter: {Timeline, EventType: {MOTION: 1}, ActorAlign: {CENTER: 1, END: 2}, EVENT_PROPAGATE: false,
        AnimationMode: {EASE_OUT_CUBIC: 1, EASE_IN_OUT_CUBIC: 2}},
    DashModule: {Dash}, OverviewControls: {},
    // Per-monitor isolation has no hover side effects; only lifecycle matters.
    DashIsolation: {DashMonitorIsolation: class {
        constructor(dash) { liveIsolations.add(this); this.dash = dash; }
        destroy() { assert.ok(liveIsolations.delete(this)); }
    }},
    Meta: {LaterType: {BEFORE_REDRAW: 0}},
    global: {display, get_pointer: () => pointer, stage,
        // Laters run before the next frame; model them as immediate sources.
        compositor: {get_laters: () => ({
            add: (_type, callback) => GLib.timeout_add(0, 0, callback),
            remove: id => GLib.source_remove(id),
        })}},
});
const Dock = vm.runInContext(source.replace(/^import .*;\n/gm, '')
    .replace('export class MultiMonitorsDock', 'class MultiMonitorsDock') +
    '\nMultiMonitorsDock;', context);
const dock = new Dock(monitor, settings);
assert.ok(dock._dash.styleClasses.has('mm-dock-light'));
dock._interfaceSettings.scheme = 'prefer-dark';
dock._interfaceSettings.emit('changed::color-scheme');
assert.ok(!dock._dash.styleClasses.has('mm-dock-light'));
assert.equal(dock._dash._background.effect.brightness, 0.8);
dock._interfaceSettings.scheme = 'prefer-light';
dock._interfaceSettings.emit('changed::color-scheme');
assert.ok(dock._dash.styleClasses.has('mm-dock-light'));
assert.equal(dock._dash._background.effect.brightness, 1);
assert.equal(dock._edge.width, 600, 'First hover target spans populated icons before deferred work');
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

// Exercise intermediate frames, spacing, crossing events and transform cleanup.
reveal();
const magnifyButtons = [0, 1, 2, 3, 4].map(index => new Actor({
    x: dock._bin.x + 80 + index * 64, y: dock._bin.y,
    width: 64, height: 64, icon: new Actor(),
}));
dock._dash._box.children = magnifyButtons.map(child => ({child}));
pointer = [magnifyButtons[2].x + 32, dock._edge.y - 30];
dock._bin.emit('motion-event', {get_coords: () => pointer});
assert.equal(timelines.size, 0, 'Magnification is off by default');
settings.magnification = true;
settings.emit('changed::dock-magnification');
assert.equal(dock._dash._box.clip_to_allocation, false,
    'Inner row must let enlarged icons paint outside their original allocation');
assert.equal(dock._bin.clip_to_allocation, true, 'Monitor boundary remains clipped');
advance(16);
assert.ok(magnifyButtons[2].scale_x > 1 && magnifyButtons[2].scale_x < 1.4,
    'First frame smoothly approaches the peak');
function assertNoOverlap() {
    for (let i = 1; i < magnifyButtons.length; i++) {
        const left = magnifyButtons[i - 1];
        const right = magnifyButtons[i];
        assert.ok(left.get_transformed_position()[0] + left.get_transformed_size()[0] <=
            right.get_transformed_position()[0] + 0.001, 'Buttons never overlap');
    }
}
for (let frame = 0; frame < 30; frame++) {
    advance(16);
    assertNoOverlap();
}
assert.equal(magnifyButtons[2].scale_x, 1.4);
assert.ok(magnifyButtons[1].scale_x > 1 && magnifyButtons[1].scale_x < 1.4);
assert.equal(magnifyButtons[0].scale_x, 1);
assert.ok(dock._dash._background.scale_x > 1, 'Dock background expands with the row');
assert.equal(timelines.size, 0, 'No animation clock while settled');
assert.equal(dock._bin.height, 120, 'Reserve headroom inside the monitor clip');
// Bubbling child crossings must not collapse the effect.
dock._bin.emit('leave-event');
advance(160);
assert.equal(magnifyButtons[2].scale_x, 1.4);
// Repeated motion at identical coordinates must not feed back animated bounds.
for (let i = 0; i < 10; i++) {
    dock._bin.emit('motion-event', {get_coords: () => pointer});
    advance(16);
}
assert.equal(magnifyButtons[2].scale_x, 1.4);
// A sweep retargets the same clock and preserves spacing on every frame.
for (let frame = 0; frame < 30; frame++) {
    pointer[0] = magnifyButtons[0].x + 32 + frame * 8;
    dock._bin.emit('motion-event', {get_coords: () => pointer});
    assert.equal(timelines.size, 1);
    advance(16);
    assertNoOverlap();
}
// Shell keeps Show Apps' icon on its wrapper, not on the toggle button.
const showAppsButton = dock._dash.showAppsButton;
Object.assign(showAppsButton, {x: magnifyButtons[4].x + 64, y: dock._bin.y,
    width: 64, height: 64});
assert.equal(showAppsButton.icon, undefined);
pointer[0] = showAppsButton.x + 32;
dock._bin.emit('motion-event', {get_coords: () => pointer});
advance(480);
assert.equal(showAppsButton.scale_x, 1.4, 'Show Apps participates in the wave');
assert.ok(magnifyButtons[4].get_transformed_position()[0] +
    magnifyButtons[4].get_transformed_size()[0] <=
    showAppsButton.get_transformed_position()[0], 'Last app stays clear of Show Apps');
const savedPointer = [...pointer];
pointer = [0, 0];
dock._bin.emit('leave-event');
advance(320);
for (const button of magnifyButtons) {
    assert.equal(button.scale_x, 1);
    assert.equal(button.translation_x, 0);
}
pointer = savedPointer;
dock._bin.emit('motion-event', {get_coords: () => pointer});
advance(150);
settings.magnification = false;
settings.emit('changed::dock-magnification');
assert.equal(magnifyButtons[2].scale_x, 1, 'Disabling resets immediately');
assert.deepEqual(magnifyButtons[2].pivot, [0, 0]);
assert.equal(timelines.size, 0);
assert.equal(dock._dash._background.scale_x, 1, 'Background restored when disabled');
assert.deepEqual(dock._dash._background.pivot, [0, 0]);
assert.equal(dock._bin.height, 80);
assert.equal(dock._dash._box.clip_to_allocation, true, 'Disabling restores row clipping');
settings.magnification = true;
settings.emit('changed::dock-magnification');
advance(150);
dock._hideDesktopDock();
assert.equal(magnifyButtons[2].scale_x, 1, 'Hide restores the buttons');
assert.equal(dock._magnifiedIcons.size, 0);
assert.equal(timelines.size, 0, 'Hide releases the animation clock');
assert.equal(dock._dash._box.clip_to_allocation, true, 'Hide restores native clipping');
settings.magnification = false;
settings.emit('changed::dock-magnification');
dock._dash._box.children = [];

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
assert.equal(dock._slide.opacity, 255, 'Hover is visible immediately');
assert.equal(dock._slide.translation_y, 0);
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

// Rapid re-entry lands on the still-visible bin, not the edge underneath it.
for (let attempt = 0; attempt < 20; attempt++) {
    reveal();
    pointer = [0, 0];
    advance(100);
    advance(300);
    assert.equal(dock._hiding, true);
    pointer = [dock._edge.x + 100, dock._edge.y - 10];
    dock._bin.emit('enter-event');
    assert.equal(dock._hiding, false, 'Re-entering the dock cancels its hide');
    advance(280);
    assert.equal(dock._bin.visible, true, 'Old animation cannot hide the re-entered dock');
    leave();
}

// A departure and return between two 100 ms polls must rearm after a click.
reveal();
icon.emit('clicked');
pointer = [0, 0];
stage.emit('captured-event', {type: () => 1, get_coords: () => pointer});
pointer = [dock._edge.x + 100, dock._edge.y];
dock._bin.emit('enter-event');
assert.equal(dock._hiding, false, 'Fast real departure rearms without waiting for a poll');
advance(280);
assert.equal(dock._bin.visible, true);
assert.equal(stage.handlers.size, 0, 'Temporary motion watcher is released after rearming');
leave();

// If a crossing event is lost during unmapping, check the final pointer position.
reveal();
pointer = [0, 0];
advance(100);
advance(300);
pointer = [dock._edge.x + 100, dock._edge.y];
advance(280);
assert.equal(dock._bin.visible, true, 'Pointer at the edge cannot be stranded after hiding');
leave();

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
assert.equal(dock._interfaceSettings.handlers.size, 0, 'Theme listener is released');
assert.equal(sources.size, 0, 'Destroy cancels hover and layout sources');
assert.equal(tracked.size, 0);
assert.equal(settings.handlers.size, 0);
assert.equal(Main.overview.handlers.size, 0);
assert.equal(Main.sessionMode.handlers.size, 0);
assert.equal(display.handlers.size, 0);
assert.equal(icon.handlers.size, 0);
assert.equal(animations.size, 0);
assert.equal(Main.layoutManager.handlers.size, 0);
assert.equal(stage.handlers.size, 0);

// Disabling with click dismissal pending must release the global motion hook.
const dismissedDock = new Dock(monitor, settings);
pointer = [dismissedDock._edge.x + 100, dismissedDock._edge.y];
dismissedDock._edge.emit('enter-event');
dismissedDock._dismissDock();
assert.equal(stage.handlers.size, 1);
dismissedDock.destroy();
assert.equal(stage.handlers.size, 0);
assert.equal(sources.size, 0);
assert.equal(animations.size, 0);

Main.layoutManager._startingUp = true;
const startupDock = new Dock(monitor, settings, {showInOverview: false});
assert.equal(startupDock._edge.visible, false);
startupDock._edge.emit('enter-event');
assert.equal(startupDock._bin.visible, false, 'Startup must not accept hover activation');
Main.layoutManager._updateVisibility();
assert.equal(startupDock._bin.visible, false);
Main.layoutManager._startingUp = false;
startupDock._dash.populated = false;
Main.layoutManager.emit('startup-complete');
assert.equal(startupDock._edge.width, 600, 'Startup refreshes icons before enabling hover');
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
Object.assign(context, {Extension: class {}, MMDock: {MultiMonitorsDock: Dock}, log() {},
    migrateMonitorSettings() {}, refreshMonitorConnectors() {}, clearMonitorConnectors() {}});
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
const nativeParent = new Actor();
const nativeDash = new Dash({opacity: 128});
nativeDash._redisplay();
nativeParent.add_child(new Actor());
nativeParent.add_child(nativeDash);
nativeParent.add_child(new Actor());
Main.overview.dash = nativeDash;
Main.layoutManager._startingUp = true;
extension._relayout();
assert.equal(extension._primaryDock, null, 'No primary dock constructed during login');
Main.layoutManager._startingUp = false;
extension._relayout();
const primaryDock = extension._primaryDock;
assert.ok(primaryDock, 'Single-display setup creates a desktop hover dock');
assert.equal(primaryDock._dash, nativeDash, 'Reuse the actual Shell dash');
assert.equal(nativeDash.parent, nativeParent, 'Leave native ownership intact until hover');
assert.equal(nativeDash.styleClasses.size, 0, 'Keep native styling');
assert.equal(liveIsolations.size, 0, 'Do not duplicate primary monitor isolation');
// Opening Overview before the first hover must not move any actors or do
// desktop geometry work on each frame of Shell's native dash animation.
let nativeMeasurements = 0;
const nativeHeight = nativeDash.get_preferred_height.bind(nativeDash);
nativeDash.get_preferred_height = (...args) => {
    nativeMeasurements++;
    return nativeHeight(...args);
};
nativeDash.emit('queue-relayout');
assert.ok(primaryDock._positionIdleId, 'Desktop changes queue a measurement');
Main.overview.visible = true;
Main.overview.animationInProgress = true;
Main.overview.emit('showing');
assert.equal(primaryDock._positionIdleId, 0, 'Cancel work queued before Overview opens');
assert.equal(primaryDock._bin.parent, chrome, 'Desktop wrapper stays out of Overview');
assert.equal(nativeDash.parent, nativeParent);
for (let frame = 0; frame < 20; frame++) {
    nativeDash.emit('queue-relayout');
    nativeDash.emit('notify::width');
    nativeDash.emit('notify::height');
    advance(16);
}
assert.equal(nativeMeasurements, 0, 'No hover layout work during native animation');
Main.overview.animationInProgress = false;
// The primary Overview dash is not a descendant of the desktop bin, and can
// occupy a different stage position. Hover must use its own event/geometry.
// Shell allocates the native dash across the monitor, centering the actual
// icon row inside it. Empty allocation is available for magnification.
Object.assign(nativeDash, {x: monitor.x, y: monitor.y + 600,
    width: monitor.width, height: 80});
const overviewIcon = new Actor({x: monitor.x + 760, y: nativeDash.y,
    width: 64, height: 64, icon: new Actor()});
nativeDash._box.children = [{child: overviewIcon}];
settings.magnification = true;
pointer = [overviewIcon.x + 32, overviewIcon.y + 32];
assert.equal(primaryDock._containsPointer(...pointer), false);
Main.overview.emit('shown');
advance(480);
assert.equal(overviewIcon.scale_x, 1.4, 'Primary Overview magnifies on shown');
assert.equal(primaryDock._bin.visible, false, 'Desktop wrapper remains hidden');
assert.equal(nativeDash.parent, nativeParent, 'Overview keeps ownership of its dash');
assert.equal(nativeMeasurements, 0, 'Magnification never measures native layout');
nativeDash.emit('leave-event');
advance(16);
assert.equal(overviewIcon.scale_x, 1.4, 'Child crossings preserve Overview magnification');
pointer = [0, 0];
nativeDash.emit('leave-event');
advance(480);
assert.equal(overviewIcon.scale_x, 1, 'Leaving the native dash resets magnification');
pointer = [overviewIcon.x + 32, overviewIcon.y + 32];
nativeDash.emit('motion-event');
advance(480);
assert.equal(overviewIcon.scale_x, 1.4, 'Native motion events restart magnification');
Main.overview.emit('hiding');
assert.equal(overviewIcon.scale_x, 1, 'Overview exit restores native transforms');
assert.equal(nativeDash._box.clip_to_allocation, true);
assert.equal(timelines.size, 0);
settings.magnification = false;
nativeDash._box.children = [];
Main.overview.visible = false;
Main.overview.emit('hidden');
assert.equal(nativeMeasurements, 1, 'Refresh the desktop trigger after Overview closes');

settings.magnification = true;
settings.emit('changed::dock-magnification');
const primaryIcon = new Actor({width: 0, height: 64, icon: new Actor()});
nativeDash._box.children = [{child: primaryIcon}];
pointer = [primaryDock._edge.x + 100, primaryDock._edge.y];
primaryDock._edge.emit('enter-event');
// Reparenting allocates the native icons after the edge-enter event. There
// must be no need for another motion event once those allocations are ready.
Object.assign(primaryIcon, {x: pointer[0] - 32, y: primaryDock._bin.y, width: 64});
advance(0);
assert.equal(timelines.size, 1, 'Primary reveal starts magnification without mouse motion');
advance(16);
assert.ok(primaryIcon.scale_x > 1 && primaryIcon.scale_x < 1.4,
    'Primary magnification responds on its first animation frame');
settings.magnification = false;
settings.emit('changed::dock-magnification');
nativeDash._box.children = [];
assert.equal(primaryDock._bin.visible, true);
assert.equal(nativeDash.parent, primaryDock._slide);
assert.equal(nativeDash.opacity, 255);
assert.equal(primaryDock._slide.opacity, 255);
assert.ok(nativeDash.styleClasses.has('multimonitor-dock'), 'Primary reveal uses shared dock CSS');
assert.ok(nativeDash.styleClasses.has('mm-dock-light'));
assert.equal(nativeDash._background.effect.brightness, 1);
primaryDock._interfaceSettings.scheme = 'prefer-dark';
primaryDock._interfaceSettings.emit('changed::color-scheme');
assert.ok(!nativeDash.styleClasses.has('mm-dock-light'));
assert.equal(nativeDash._background.effect.brightness, 0.8);
Main.overview.show = state => {
    assert.equal(state, 2);
    assert.equal(nativeDash.parent, nativeParent, 'Return dash before opening app grid');
    Main.overview.visible = true;
    Main.overview.emit('showing');
};
nativeDash.showAppsButton.checked = true;
nativeDash.showAppsButton.emit('notify::checked');
assert.equal(Main.overview.visible, true, 'Native Show Apps opens overview from desktop');
assert.equal(primaryDock._bin.visible, false, 'Primary overview keeps only the built-in dash');
assert.equal(nativeDash.parent, nativeParent);
assert.equal(nativeParent.children[1], nativeDash, 'Restore original sibling order');
assert.equal(nativeDash.opacity, 128);
assert.equal(nativeDash.styleClasses.size, 0, 'Overview restores native styling');
assert.equal(nativeDash._background.effect, null, 'Overview removes desktop blur');
primaryDock._interfaceSettings.scheme = 'prefer-light';
primaryDock._interfaceSettings.emit('changed::color-scheme');
assert.equal(nativeDash.styleClasses.size, 0, 'Theme changes leave native Overview alone');
Main.overview.visible = false;
Main.overview.emit('hidden');
assert.equal(primaryDock._edge.visible, true);
Main.layoutManager.monitors = [monitor, {x: 0, y: 0, width: 1280, height: 720}];
Main.layoutManager.primaryIndex = 1;
extension._relayout();
assert.equal(extension._primaryDock, primaryDock);
assert.equal(primaryDock._edge.y, 718, 'Primary reassignment moves the hover trigger');
primaryDock._edge.emit('enter-event');
assert.equal(nativeDash.parent, primaryDock._slide);
settings.enabled = false;
settings.emit('changed::reveal-dock-on-hover');
assert.equal(nativeDash.parent, nativeParent, 'Disabling hover returns the native dash');
settings.enabled = true;
settings.emit('changed::reveal-dock-on-hover');
primaryDock._edge.emit('enter-event');
assert.equal(nativeDash.parent, primaryDock._slide);
Main.layoutManager.monitors = [];
Main.layoutManager.primaryIndex = -1;
extension._relayout();
assert.equal(extension._primaryDock, null);
assert.equal(nativeDash.parent, nativeParent, 'Destroy returns a borrowed dash');
assert.equal(nativeDash.destroyed, undefined, 'Never destroy Shell actors');
assert.equal(nativeDash.styleClasses.size, 0, 'Destroy restores native styling');
assert.equal(nativeDash._background.effect, null);
assert.equal(primaryDock._interfaceSettings.handlers.size, 0);
assert.equal(nativeDash.handlers.size, 0);
assert.equal(nativeDash._box.handlers.size, 0);
assert.equal(nativeDash.showAppsButton.handlers.size, 0);
assert.equal(sources.size, 0);
assert.equal(tracked.size, 0);
assert.equal(liveIsolations.size, 0, 'Every dock releases its monitor isolation');
Main.overview.visible = true;
const nativeOverviewDock = new Dock(monitor, settings,
    {showInOverview: false, nativeDash});
assert.equal(nativeOverviewDock._bin.parent, chrome);
nativeOverviewDock.destroy();
assert.equal(nativeDash.parent, nativeParent);
assert.equal(nativeDash.destroyed, undefined);
assert.equal(tracked.size, 0, 'Destroy during Overview removes desktop chrome');
assert.equal(sources.size, 0);

console.log('Dock hover lifecycle tests passed');

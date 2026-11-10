import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const removed = [];
const context = vm.createContext({
    GLib: { source_remove: id => removed.push(id) },
    Main: { ctrlAltTabManager: { removeGroup() {} } },
});
function methods(file, className, names) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('class ' + className));
    return vm.runInContext('({' + names.map(name => {
        const start = body.indexOf('        ' + name + '(');
        assert.ok(start >= 0, name);
        const end = body.indexOf('\n        }', start) + 10;
        return body.slice(start, end);
    }).join(',') + '})', context);
}
const released = [];
const live = {
    disconnect(id) { released.push(id); },
    disconnectObject() {},
    unbind() {},
    destroy() { released.push('destroy'); },
    get_first_child() { assert.fail('cleanup must not traverse source children'); },
};
const mirror = methods('mirroredIndicatorButton.js', 'MirroredIndicatorButton', [
    '_cleanup', '_disconnectMirroredClockDisplay', '_disconnectLabelCopyBindings',
    '_disconnectIconSyncSource', '_disconnectWorkspaceWindowSignals',
]);
const sourceOwners = [];
const sourceIndicator = { ...live, disconnectObject(owner) { sourceOwners.push(owner); } };
Object.assign(mirror, {
    _sourceIndicator: sourceIndicator, _sourcePresenceChild: live,
    _clockBinding: live, _labelCopyBindings: [live],
    _quickSettingsSource: live, _sourceSizeChangedId: 11,
    _allocationCloneSignals: [{ source: live, id: 12 }],
    _workspacePreviewWindowSignalIds: [{ object: live, id: 13 }],
    _forwardClickTimeoutId: 14, _allocationCloneTimeouts: [15],
    _genericMenuPendingRestore() { released.push('restore'); },
});
mirror._cleanup();
assert.deepEqual(sourceOwners, [mirror], 'source handlers (incl. destroy) released via disconnectObject');
assert.equal(mirror._sourceIndicator, null);
assert.equal(mirror._sourcePresenceChild, null);
assert.equal(mirror._quickSettingsSource, null);
assert.equal(mirror._genericMenuPendingRestore, null);
assert.deepEqual(removed, [14, 15]);
mirror._cleanup();
assert.deepEqual(removed, [14, 15], 'cleanup must be idempotent');

const panel = methods('mmpanel.js', 'MultiMonitorsPanel', [
    '_cleanup', '_schedulePanelRefresh', '_disconnectIndicatorSignals', '_destroyIndicator',
]);
Object.assign(panel, {
    _settings: live, _primaryPanelBoxes: [live], _initialCheckTimeouts: [16],
    _panelRefreshTimeouts: [17], statusArea: {
        tray: { ...live, _mmDestroyId: 18, _mmMenuSetId: 19 },
    },
});
panel._cleanup();
assert.equal(panel._leftBox, null);
assert.equal(Object.keys(panel.statusArea).length, 0);
assert.deepEqual(removed, [14, 15, 16, 17]);
panel._schedulePanelRefresh([50]); // Must not call timeout_add after destruction.
panel._cleanup();
assert.deepEqual(removed, [14, 15, 16, 17]);
panel.statusArea.tray = { ...live };
panel._destroyIndicator('tray');
assert.equal(panel.statusArea.tray, undefined);
assert.ok(released.indexOf(18) < released.indexOf('destroy'), 'disconnect before destroying owned indicator');
assert.ok(released.includes(12));

// The button's cleanup must hang off its destroy signal, not a destroy()
// override: Clutter destroys children of a torn-down panel without calling
// the JS override, which left the source 'destroy' handler pointing at a
// disposed button (journal log on issue #59).
{
    const source = readFileSync(new URL('../mirroredIndicatorButton.js', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('class MirroredIndicatorButton'));
    assert.ok(!/\n {8}destroy\(\) \{/.test(body), 'no destroy() override on MirroredIndicatorButton');
    assert.ok(body.includes("this.connect('destroy', () => this._cleanup())"));
    assert.ok(!body.includes('_sourceDestroyId'), 'source destroy handler uses connectObject');
}
// Issue #40: repeated refreshes must destroy every retired copy while JS can
// still run its destroy handlers, and release bindings before destruction.
class Label {
    constructor() { this.text = ''; this.destroyed = false; }
    get_style_class_name() { return ''; }
    bind_property(_source, target) {
        target.text = this.text;
        target.bound = true;
        return { unbind() { target.bound = false; } };
    }
    destroy() {
        assert.equal(this.bound, false, 'unbind before destroying the label');
        this.destroyed = true;
    }
}
class Container {
    children = [];
    add_child(child) { this.children.push(child); }
    destroy_all_children() {
        this.children.forEach(child => child.destroy());
        this.children = [];
    }
    remove_all_children() { this.children = []; }
}
context.St = { Label, Icon: class {}, BoxLayout: class {} };
context.Clutter = { ActorAlign: { CENTER: 0 } };
context.GObject = { BindingFlags: { SYNC_CREATE: 1 } };
const refresh = methods('mirroredIndicatorButton.js', 'MirroredIndicatorButton', [
    '_copyIconsFromSource', '_createLabelCopy', '_disconnectLabelCopyBindings',
]);
const sourceLabel = new Label();
refresh._isClipboardIndicator = () => false;
refresh._findAllDisplayWidgets = () => [sourceLabel];
const container = new Container();
for (let i = 0; i < 20; i++) {
    const previous = [...container.children];
    sourceLabel.text = String(i);
    refresh._copyIconsFromSource(container, sourceLabel);
    assert.ok(previous.every(child => child.destroyed), 'retired labels must be destroyed');
    assert.equal(container.children.length, 1);
    assert.equal(container.children[0].text, String(i));
    assert.equal(refresh._labelCopyBindings.length, 1);
    assert.equal(sourceLabel.destroyed, false, 'the primary panel label is borrowed');
}
refresh._disconnectLabelCopyBindings();
container.destroy_all_children();
console.log('Actor lifecycle regression checks passed (including 20 label refreshes)');

// Issue #60: static icon copies are built inside MirroredIndicatorButton._init
// before the button is added to a panel box on the stage. Measuring preferred
// size while off-stage triggers "st_widget_get_theme_node called on the widget
// [...] which is not in the stage". Defer measurement until mapped on stage.
const staticSize = methods('mirroredIndicatorButton.js', 'MirroredIndicatorButton', [
    '_syncStaticCopyContainerSize', '_getActorAllocationSize',
]);
let onStage = false;
let mappedHandler = null;
let allocHandler = null;
const sizedContainer = {
    mapped: false,
    size: null,
    get_stage() { return onStage ? {} : null; },
    get_preferred_width() {
        assert.ok(onStage, 'must not measure preferred width while off-stage');
        return [20, 24];
    },
    get_preferred_height() {
        assert.ok(onStage, 'must not measure preferred height while off-stage');
        return [18, 20];
    },
    set_size(w, h) { this.size = [w, h]; },
    connectObject(sig, cb, owner) {
        assert.equal(owner, staticSize, 'mapped handler must be owned by the button');
        if (sig === 'notify::mapped')
            mappedHandler = cb;
    },
    disconnectObject(owner) {
        assert.equal(owner, staticSize);
        mappedHandler = null;
    },
};
const iconSource = new context.St.Icon();
iconSource.connect = (_sig, cb) => { allocHandler = cb; return 42; };
staticSize._isClipboardIndicator = () => false;
staticSize._allocationCloneSignals = [];
// Icon-only copies (Tiling Shell) and Clipboard Indicator copies keep their
// natural size: a frozen size squeezed the icon to zero width on side bars.
onStage = true;
staticSize._syncStaticCopyContainerSize(sizedContainer, iconSource);
assert.equal(sizedContainer.size, null, 'icon-only copy is never given a fixed size');
assert.equal(mappedHandler, null, 'icon-only copy does not wait for a map');
assert.equal(allocHandler, null, 'icon-only copy does not follow the source allocation');
staticSize._isClipboardIndicator = () => true;
staticSize._syncStaticCopyContainerSize(sizedContainer, new context.St.BoxLayout());
assert.equal(sizedContainer.size, null, 'clipboard copy is never given a fixed size');
staticSize._isClipboardIndicator = () => false;

// Container sources still mirror the source allocation, once on stage.
onStage = false;
const boxSource = new context.St.BoxLayout();
boxSource.get_stage = () => ({});
boxSource.get_allocation_box = () => ({ get_width: () => 24, get_height: () => 20 });
boxSource.connect = (_sig, cb) => { allocHandler = cb; return 43; };
boxSource.mapped = true;
let sourceMappedHandler = null;
boxSource.connectObject = (sig, cb, owner) => {
    assert.equal(owner, sizedContainer, 'source map handler goes away with the copy');
    if (sig === 'notify::mapped')
        sourceMappedHandler = cb;
};
staticSize._syncStaticCopyContainerSize(sizedContainer, boxSource);
assert.equal(sizedContainer.size, null, 'off-stage container waits for stage attachment');
onStage = true;
sizedContainer.mapped = true;
mappedHandler();
assert.deepEqual(sizedContainer.size, [24, 20], 'size synced once mapped on stage');
assert.equal(mappedHandler, null, 'mapped handler disconnects after the first sync');

// Issue #63: an unmapped source (primary panel hidden by a fullscreen window)
// keeps a stale allocation; after unlock it predates the labels' text. The
// copy must size to its own content until the source is shown again.
boxSource.mapped = false;
sourceMappedHandler();
assert.deepEqual(sizedContainer.size, [-1, -1], 'unmapped source releases the pinned size');
allocHandler();
assert.deepEqual(sizedContainer.size, [-1, -1], 'stale allocation is not pinned while unmapped');
boxSource.mapped = true;
sourceMappedHandler();
assert.deepEqual(sizedContainer.size, [24, 20], 'size pinned again once the source is shown');

// Issue #59: mirrored tray icons follow the source live, including while a
// fullscreen window leaves the primary panel's AppIndicator icon unmapped.
{
    class Emitter {
        handlers = [];
        connectObject(...args) {
            const owner = args.pop();
            for (let i = 0; i < args.length; i += 2)
                this.handlers.push({ signal: args[i], cb: args[i + 1], owner });
        }
        emit(signal) {
            this.handlers.filter(h => h.signal === signal).forEach(h => h.cb());
        }
    }
    class Icon extends Emitter {
        constructor(props = {}) {
            super();
            this._gicon = null;
            this._iconName = null;
            Object.assign(this, props);
        }
        get gicon() { return this._gicon; }
        set gicon(v) { this._gicon = v; this.emit('notify::gicon'); }
        get icon_name() { return this._iconName; }
        set icon_name(v) { this._iconName = v; this._gicon = null; this.emit('notify::icon-name'); }
        get_style_class_name() { return 'system-status-icon'; }
    }
    context.St = { Icon, Label: class {}, BoxLayout: class {} };
    const copier = methods('mirroredIndicatorButton.js', 'MirroredIndicatorButton', [
        '_createDisplayWidgetCopy', '_refreshUnmappedAppIndicatorIcon',
    ]);
    copier._getSourceIconSize = () => 16;

    const indicator = new Emitter();
    const pixmapA = { name: 'normal' }, pixmapB = { name: 'unread' };
    let mapped = false, updates = 0;
    const sourceIcon = new Icon();
    sourceIcon._gicon = pixmapA;
    sourceIcon._indicator = indicator;
    sourceIcon.is_mapped = () => mapped;
    sourceIcon._updateIcon = async () => { updates++; sourceIcon.gicon = pixmapB; };

    const copy = copier._createDisplayWidgetCopy(sourceIcon);
    assert.equal(copy.gicon, pixmapA, 'copy starts with the source pixmap');
    assert.ok(sourceIcon.handlers.every(h => h.owner === copy), 'source handlers owned by the copy');
    assert.ok(indicator.handlers.every(h => h.owner === copy), 'indicator handlers owned by the copy');

    sourceIcon.gicon = pixmapA;
    sourceIcon.gicon = { name: 'other' };
    assert.equal(copy.gicon.name, 'other', 'copy follows gicon swaps');

    indicator.emit('icon');
    assert.equal(updates, 1, 'unmapped source is refreshed for the mirrors');
    assert.equal(copy.gicon, pixmapB);

    mapped = true;
    indicator.emit('overlay-icon');
    assert.equal(updates, 1, 'a mapped source refreshes itself');

    const plainIcon = new Icon();
    plainIcon._iconName = 'audio-volume-high';
    const plainCopy = copier._createDisplayWidgetCopy(plainIcon);
    assert.equal(plainCopy.icon_name, 'audio-volume-high', 'themed icons copy by name');
    console.log('Mirrored tray icon sync checks passed (live gicon + unmapped AppIndicator refresh)');
}

const dateMenu = methods('mmcalendar.js', 'MultiMonitorsDateMenuButton', [
    '_mmTrackClockConnections', '_cleanupClock',
]);
class Clock {
    signals = new Map();
    binding = null;
    connect(name, callback) {
        const id = this.signals.size + 1;
        this.signals.set(id, callback);
        return id;
    }
    disconnect(id) { assert.ok(this.signals.delete(id)); }
    bind_property() {
        this.binding = { unbind: () => { this.binding = null; } };
        return this.binding;
    }
}
for (let i = 0; i < 20; i++) {
    const clock = new Clock();
    dateMenu._mmTrackClockConnections(() => {
        dateMenu._clock = clock;
        clock.bind_property('clock', {}, 'text', 1);
        clock.connect('notify::timezone', () => assert.fail('retired callback'));
    });
    assert.equal(Object.hasOwn(clock, 'connect'), false);
    assert.equal(Object.hasOwn(clock, 'bind_property'), false);
    dateMenu._cleanupClock();
    assert.equal(clock.binding, null);
    assert.equal(clock.signals.size, 0);
    assert.equal(dateMenu._clock, null);
    dateMenu._cleanupClock();
}
const fallbackClock = new Clock();
dateMenu._clock = fallbackClock;
dateMenu._clockBinding = fallbackClock.bind_property();
dateMenu._clockNotifyTimezoneId = fallbackClock.connect('notify::timezone', () => {});
dateMenu._cleanupClock();
assert.equal(fallbackClock.signals.size, 0);
assert.equal(fallbackClock.binding, null);
const failedClock = new Clock();
assert.throws(() => dateMenu._mmTrackClockConnections(() => {
    dateMenu._clock = failedClock;
    throw Error('initialization failed');
}), /initialization failed/);
assert.equal(Object.hasOwn(failedClock, 'connect'), false);
assert.equal(Object.hasOwn(failedClock, 'bind_property'), false);
dateMenu._cleanupClock();
console.log('Date menu clock cleanup checks passed (upstream, fallback, and failed initialization)');

// Removing a monitor must clean up the panel before its parent disposes children.
const layoutSource = readFileSync(new URL('../mmlayout.js', import.meta.url), 'utf8');
const popPanel = layoutSource.match(/\t_popPanel\(\) \{[\s\S]*?\n\t\}/)[0];
const teardown = [];
context.getMMPanelArray = () => [{ destroy() { teardown.push('panel'); } }];
const layout = vm.runInContext('({' + popPanel + '})', context);
layout.statusIndicatorsController = { transferBack() { teardown.push('transfer'); } };
layout.mmPanelBox = [{ destroy() { teardown.push('container'); } }];
layout._popDock = () => teardown.push('dock');
layout._popPanel();
assert.deepEqual(teardown, ['transfer', 'panel', 'container', 'dock']);
console.log('Monitor removal destroys panel before its container');

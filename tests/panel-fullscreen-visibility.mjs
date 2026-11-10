// Regression test for issue #63: the secondary bar vanished after unlocking
// while a window was fullscreen on the primary monitor.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

import * as PanelPolicy from '../monitorPanelPolicy.js';

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
    connectObject(...args) {
        const owner = args.pop();
        for (let i = 0; i < args.length; i += 2) {
            const id = this.connect(args[i], args[i + 1]);
            (owner.ownedConnections ??= []).push([this, id]);
        }
    }
    disconnectObject(owner) {
        owner.ownedConnections = (owner.ownedConnections ?? []).filter(([object, id]) => {
            if (object !== this)
                return true;
            this.disconnect(id);
            return false;
        });
    }
    emit(name, ...args) {
        for (const handler of [...this.handlers.values()]) {
            if (handler.name === name)
                handler.callback(this, ...args);
        }
    }
}

class Actor extends Signals {
    visible = true;
    // Clutter only allocates visible actors; until then the transformed
    // rect GNOME uses to find the actor's monitor is 0x0 at the origin.
    allocated = false;
    constructor(properties = {}) {
        super();
        Object.assign(this, properties);
    }
    set_size(width, height) { Object.assign(this, {width, height}); }
    set_position(x, y) { Object.assign(this, {x, y}); }
    destroy() {
        for (const [object, id] of this.ownedConnections ?? [])
            object.disconnect(id);
        this.ownedConnections = [];
        this.destroyed = true;
    }
}

const windowGroup = new Actor();
const display = new Signals();
const primary = {index: 0, x: 0, y: 0, width: 2560, height: 1440, inFullscreen: false};
const secondary = {index: 1, x: 2560, y: 0, width: 1440, height: 2560, inFullscreen: false};
const tracked = [];

const layoutManager = {
    monitors: [primary, secondary],
    panelBox: new Actor({height: 32}),
    addChrome(actor, params = {}) {
        tracked.push({actor, ...params});
        this._updateVisibility();
    },
    removeChrome(actor) {
        const i = tracked.findIndex(data => data.actor === actor);
        assert.ok(i >= 0, 'removing untracked chrome');
        tracked.splice(i, 1);
    },
    // Mirrors GNOME 50 layout.js _updateActorVisibility/findIndexForActor.
    _findMonitorForActor(actor) {
        if (!actor.allocated)
            return primary; // 0x0 rect at the origin
        return this.monitors.find(m => actor.x >= m.x && actor.x < m.x + m.width);
    },
    _updateVisibility() {
        for (const data of tracked) {
            if (!data.trackFullscreen)
                continue;
            const monitor = this._findMonitorForActor(data.actor);
            data.actor.visible = !(windowGroup.visible && monitor?.inFullscreen);
        }
    },
};
// GNOME connects to in-fullscreen-changed at startup, before any extension.
display.connect('in-fullscreen-changed', () => layoutManager._updateVisibility());

const Main = {
    layoutManager,
    panel: {get_preferred_height: () => [32, 32]},
    uiGroup: {set_child_below_sibling() {}},
};
const GLib = {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    idle_add: () => 1,
    source_remove() {},
    timeout_add: () => 1,
};

const source = readFileSync(new URL('../mmlayout.js', import.meta.url), 'utf8');
const context = vm.createContext({
    St: {BoxLayout: Actor}, GLib, Gio: {}, Main, Layout: {}, MMPanel: {}, MMDock: {},
    Common: {verticalBoxProps: () => ({})},
    monitorKey: () => '',
    ...PanelPolicy,
    global: {display, window_group: windowGroup},
    log() {},
});
const PanelBox = vm.runInContext(source.replace(/^import [\s\S]*?;\n/gm, '')
    .replace(/^export /gm, '') + '\nMultiMonitorsPanelBox;', context);

function setFullscreen(monitor, value) {
    monitor.inFullscreen = value;
    display.emit('in-fullscreen-changed');
}

function setWindowsVisible(value) {
    windowGroup.visible = value;
    windowGroup.emit('notify::visible');
}

// Unlock re-enables the extension while the primary monitor is fullscreen.
setFullscreen(primary, true);
const box = new PanelBox(secondary, 'top');
assert.equal(box.panelBox.visible, true,
    'secondary bar stays visible when only the primary monitor is fullscreen');
assert.equal(box.panelBox.x, secondary.x, 'bar sits on its own monitor');

layoutManager._updateVisibility();
assert.equal(box.panelBox.visible, true, 'a shell visibility refresh keeps it visible');

setFullscreen(secondary, true);
assert.equal(box.panelBox.visible, false, 'hidden under a fullscreen window on its monitor');

setWindowsVisible(false);
assert.equal(box.panelBox.visible, true, 'shown in the overview even over fullscreen');
setWindowsVisible(true);
assert.equal(box.panelBox.visible, false, 'hidden again after the overview closes');

setFullscreen(secondary, false);
assert.equal(box.panelBox.visible, true, 'shown once fullscreen ends');

box.updatePanel({...secondary, x: 3000});
assert.equal(box.panelBox.visible, true, 'monitor update keeps visibility in sync');

box.destroy();
assert.equal(display.handlers.size, 1, 'only the shell handler remains after destroy');
assert.equal(windowGroup.handlers.size, 0, 'window_group handler removed on destroy');
assert.equal(tracked.length, 0, 'chrome untracked on destroy');

console.log('Panel fullscreen visibility checks passed');

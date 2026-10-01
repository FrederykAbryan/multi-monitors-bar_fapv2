import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../mmoverview.js', import.meta.url), 'utf8');
const start = source.indexOf('        _createAppButton(app) {');
assert.ok(start >= 0, 'find the app button implementation');
const end = source.indexOf('\n        _setFocusedApp(', start);
assert.ok(end > start, 'find the end of the app button implementation');

class Actor {
    constructor(properties = {}) {
        Object.assign(this, properties);
        this.children = [];
    }

    set_child(child) { this.child = child; }
    add_child(child) { this.children.push(child); }
    connect() {}
}

class Label extends Actor {
    constructor(properties) {
        super(properties);
        this.clutter_text = {
            set_ellipsize() {},
            set_line_wrap() {},
        };
    }
}

const context = vm.createContext({
    St: { Button: Actor, BoxLayout: Actor, Icon: Actor, Label, ButtonMask: { ONE: 1 } },
    Clutter: { ActorAlign: { CENTER: 1 } },
    console: { debug() {} },
});
const manager = vm.runInContext(`({${source.slice(start, end)}})`, context);
const app = overrides => ({ get_icon: () => null, get_name: () => 'Example', ...overrides });
const iconFor = info => manager._createAppButton(info).child.children[0];

assert.equal(iconFor(app({})).icon_name, 'application-x-executable',
    'GNOME 46 app without an icon uses the generic fallback');

const legacyIcon = new Actor();
assert.equal(iconFor(app({ create_icon_texture: () => legacyIcon })), legacyIcon,
    'older shells can still use the legacy texture method');

assert.equal(iconFor(app({ create_icon_texture: () => { throw new Error('unavailable'); } }))
    .icon_name, 'application-x-executable',
    'a failed legacy texture call uses the generic fallback');

const gicon = {};
assert.equal(iconFor(app({ get_icon: () => gicon })).gicon, gicon,
    'a GIcon remains the preferred icon');

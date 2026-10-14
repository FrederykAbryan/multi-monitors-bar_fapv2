import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const actors = [];
class Actor {
    constructor(props = {}) {
        Object.assign(this, { visible: true, width: 24, height: 24 }, props);
        this.children = [];
        this.handlers = [];
        actors.push(this);
    }
    get_children() { return this.children.slice(); }
    get_n_children() { return this.children.length; }
    get_parent() { return this.parent; }
    has_style_class_name(name) { return (this.style_class || '').split(' ').includes(name); }
    get_size() { return [this.width, this.height]; }
    get_allocation_box() {
        return { get_width: () => this.width, get_height: () => this.height };
    }
    set_size(width, height) { Object.assign(this, { width, height }); }
    add_child(child) { this.children.push(child); child.parent = this; }
    insert_child_below(child, sibling) {
        this.children.splice(this.children.indexOf(sibling), 0, child);
        child.parent = this;
    }
    connect(signal, callback) { this.handlers.push({ signal, callback }); }
    connectObject(...args) {
        const owner = args.pop();
        for (let i = 0; i < args.length; i += 2)
            this.handlers.push({ signal: args[i], callback: args[i + 1], owner });
    }
    emit(signal) {
        for (const handler of this.handlers.slice())
            if (handler.signal === signal) handler.callback(this);
    }
    destroy() {
        this.emit('destroy');
        for (const actor of actors)
            actor.handlers = actor.handlers.filter(handler => handler.owner !== this);
        for (const child of this.get_children()) child.destroy();
        if (this.parent)
            this.parent.children.splice(this.parent.children.indexOf(this), 1);
    }
}
class Icon extends Actor {}
class Label extends Actor {}
class Text extends Actor {}
class Button extends Actor {}
class PanelButton extends Button {}
class BinLayout {}
const pending = new Map();
let nextId = 0;
let themeScale = 1;
const context = vm.createContext({
    St: { Icon, Label, Button, BoxLayout: Actor,
        ThemeContext: {get_for_stage: () => ({scale_factor: themeScale})} },
    global: {stage: {}},
    Clutter: { Text, Clone: Actor, BinLayout, ActorAlign: { CENTER: 1 } },
    PanelMenu: { Button: PanelButton },
    verticalBoxProps: () => ({ vertical: true }),
    GLib: {
        idle_add(_priority, callback) { pending.set(++nextId, callback); return nextId; },
        source_remove(id) { pending.delete(id); },
    },
});
const source = readFileSync(new URL('../verticalRemap.js', import.meta.url), 'utf8');
vm.runInContext(source.replace(/^import .*;\n/gm, '').replace('export function', 'function'), context);
const remap = context.remapClone;

const proxy = new Button({ layout_manager: new BinLayout() });
const wrapper = new Actor({ layout_manager: new BinLayout(), width: 80 });
const icon = new Icon();
const clone = new Actor({ source: icon });
wrapper.add_child(clone);
proxy.add_child(wrapper);
remap(clone, true);
assert.equal(proxy.visible, true, 'component button stays visible and interactive');
assert.equal(wrapper.visible, false, 'horizontal dimensions are removed even for one icon');
assert.equal(proxy.children[0], clone._mmRemapStack, 'remapped content is the first child');
const iconClone = clone._mmRemapStack.children[0].children[0];
assert.equal(iconClone.width, 24);
icon.set_size(0, 0);
icon.emit('notify::allocation');
assert.equal(iconClone.width, 24, 'fullscreen zero allocation keeps the painted size');
remap(clone, false);
assert.equal(wrapper.visible, true, 'horizontal content restored');
assert.equal(clone._mmRemapStack, null);
assert.equal(pending.size, 0, 'pending rebuild removed during cleanup');

const row = new Actor({ width: 0, height: 0 });
row.add_child(new Icon());
row.add_child(new Label());
const button = new PanelButton();
const rowClone = new Actor({ source: row });
button.add_child(rowClone);
remap(rowClone, true);
row.set_size(80, 24);
row.emit('notify::allocation');
for (const [id, callback] of pending) { pending.delete(id); callback(); }
assert.equal(rowClone._mmRemapStack.children[0].children.length, 2,
    'a source first allocated after remapping is split into centered pieces');
rowClone.destroy();
assert.equal(button.children.length, 0, 'destroying the clone removes its replacement');

const tray = new Actor({ width: 100, height: 24 });
const wifi = new Icon();
const vpn = new Icon({ visible: false });
tray.add_child(wifi);
tray.add_child(vpn);
const trayButton = new PanelButton();
const trayClone = new Actor({ source: tray });
trayButton.add_child(trayClone);
remap(trayClone, true);
const trayLeaves = () => trayClone._mmRemapStack.children[0].children;
assert.equal(trayLeaves().length, 1);
vpn.visible = true;
vpn.emit('notify::visible');
for (const [id, callback] of pending) { pending.delete(id); callback(); }
assert.equal(trayLeaves().length, 2, 'activating a previously hidden system icon adds it to the tray');
wifi.visible = false;
wifi.emit('notify::visible');
vpn.visible = false;
vpn.emit('notify::visible');
for (const [id, callback] of pending) { pending.delete(id); callback(); }
assert.equal(trayLeaves().length, 0, 'an empty group does not paint a stale source clone');
vpn.visible = true;
vpn.emit('notify::visible');
for (const [id, callback] of pending) { pending.delete(id); callback(); }
assert.equal(trayLeaves().length, 1, 'an empty tray group can become visible again');
trayClone.destroy();
assert.equal(vpn.handlers.length, 0, 'tray visibility watchers are released');

const astra = new PanelButton({style_class: 'mm-astra-monitor'});
const component = new Button();
astra.add_child(component);
const metrics = new Actor({width: 110, height: 24});
const astraIcon = new Icon({width: 32, height: 32});
const graph = new Actor({width: 40, height: 20});
const value = new Label({width: 24, height: 18});
metrics.add_child(astraIcon);
metrics.add_child(graph);
metrics.add_child(value);
const astraClone = new Actor({source: metrics});
component.add_child(astraClone);
remap(astraClone, true);
const astraLeaves = astraClone._mmRemapStack.children[0].children;
assert.equal(astraLeaves[0].width, 18, 'Astra side bar icons are capped at 18 logical pixels');
assert.equal(astraLeaves[0].height, 18);
assert.equal(astraLeaves[1].width, 40, 'graphs retain their source dimensions');
assert.equal(astraLeaves[2].width, 24, 'labels retain their source dimensions');
assert.equal(astraIcon.width, 32, 'primary panel icon is untouched');
astraIcon.set_size(16, 16);
astraIcon.emit('notify::allocation');
assert.equal(astraLeaves[0].width, 16, 'small icons are never enlarged');
themeScale = 2;
astraIcon.set_size(64, 64);
astraIcon.emit('notify::allocation');
assert.equal(astraLeaves[0].width, 36, 'icon cap follows display scaling');
astraIcon.set_size(0, 0);
astraIcon.emit('notify::allocation');
assert.equal(astraLeaves[0].width, 36, 'fullscreen preserves the compact icon size');
remap(astraClone, false);
assert.equal(astraClone.visible, true, 'horizontal Astra content is restored at its original size');
assert.equal(astraClone._mmRemapStack, null);
assert.equal(astraIcon.handlers.length, 0, 'compact icon watchers are released on orientation change');
console.log('Vertical remap alignment and lifecycle checks passed');

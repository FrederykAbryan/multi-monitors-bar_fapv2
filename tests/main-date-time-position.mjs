import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
const start = source.indexOf('\t_moveMainDateMenu(');
const end = source.indexOf('\n\t_showThumbnailsSlider(', start);
assert.ok(start >= 0 && end > start, 'find main date menu methods');

class Actor {
    constructor() {
        this.children = [];
        this.parent = null;
    }

    get_parent() { return this.parent; }
    get_children() { return [...this.children]; }
    get_n_children() { return this.children.length; }
    remove_child(child) {
        this.children.splice(this.children.indexOf(child), 1);
        child.parent = null;
    }
    insert_child_at_index(child, index) {
        this.children.splice(index, 0, child);
        child.parent = this;
    }
    add_child(child) { this.insert_child_at_index(child, this.children.length); }
}

const left = new Actor();
const center = new Actor();
const right = new Actor();
const appMenu = new Actor();
const dateMenu = new Actor();
const network = new Actor();
const tray = new Actor();
left.add_child(appMenu);
center.add_child(dateMenu);
right.add_child(network);
right.add_child(tray);

const panel = {
    _leftBox: left,
    _centerBox: center,
    _rightBox: right,
    statusArea: { dateMenu: { container: dateMenu }, quickSettings: { container: tray } },
};
const context = vm.createContext({ Main: { panel }, DATE_TIME_POSITION_ID: 'date-time-position' });
const methods = source.slice(start, end).replace(
    /\n\t(?=_(?:apply|restore)MainDateTimePosition\()/g, ',\n\t');
const manager = vm.runInContext(`({${methods}})`, context);
let position = 'center';
manager._settings = {
    get_string(key) {
        assert.equal(key, 'date-time-position');
        return position;
    },
};

manager._applyMainDateTimePosition();
assert.deepEqual(center.get_children(), [dateMenu]);

position = 'left';
manager._applyMainDateTimePosition();
manager._applyMainDateTimePosition();
assert.deepEqual(left.get_children(), [appMenu, dateMenu]);

position = 'right-before-tray';
manager._applyMainDateTimePosition();
manager._applyMainDateTimePosition();
assert.deepEqual(right.get_children(), [network, dateMenu, tray]);

position = 'right-after-tray';
manager._applyMainDateTimePosition();
manager._applyMainDateTimePosition();
assert.deepEqual(right.get_children(), [network, tray, dateMenu]);

position = 'center';
manager._applyMainDateTimePosition();
assert.deepEqual(center.get_children(), [dateMenu]);

position = 'right-before-tray';
manager._applyMainDateTimePosition();
manager._restoreMainDateTimePosition();
assert.deepEqual(center.get_children(), [dateMenu], 'disable restores the original parent');
assert.deepEqual(right.get_children(), [network, tray]);
assert.equal(manager._mainDateMenuPlacement, null);

console.log('Main monitor date and time position checks passed');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../mmpanel.js', import.meta.url), 'utf8');
const method = (name, next) => {
    const start = source.indexOf(`        ${name}(`);
    const end = source.indexOf(`\n        ${next}(`, start);
    assert.ok(start >= 0 && end > start, `find ${name}`);
    return source.slice(start, end);
};
const updateBoxStart = source.indexOf('        _updateBox(elements, box) {');
const updateBoxEnd = source.indexOf('\n    });', updateBoxStart);
assert.ok(updateBoxStart >= 0 && updateBoxEnd > updateBoxStart, 'find _updateBox');

let moves = 0;
let hides = 0;

class Actor {
    constructor(name) {
        this.name = name;
        this.children = [];
        this.parent = null;
        this.visible = true;
    }

    get_parent() { return this.parent; }
    get_children() { return [...this.children]; }
    get_n_children() { return this.children.length; }
    connect() { return 1; }
    show() { this.visible = true; }
    hide() { this.visible = false; hides++; }
    contains(actor) { return actor === this || this.children.some(child => child.contains?.(actor)); }
    remove_child(child) {
        this.children.splice(this.children.indexOf(child), 1);
        child.parent = null;
        moves++;
    }
    insert_child_at_index(child, index) {
        this.children.splice(index, 0, child);
        child.parent = this;
    }
    add_child(child) { this.insert_child_at_index(child, this.children.length); }
}

const mainCenter = new Actor('mainCenter');
const mainWeather = new Actor('mainWeather');
mainCenter.add_child(mainWeather);
const context = vm.createContext({
    Clutter: { ActorAlign: { CENTER: 1, FILL: 2 } },
    Main: {
        layoutManager: { primaryIndex: 0 },
        panel: { _centerBox: mainCenter, statusArea: { weather: mainWeather } },
    },
});
const panel = vm.runInContext(`({
${method('_hideIndicators', '_disconnectIndicatorSignals')},
${method('_getMainCenterRank', '_getCenterInsertIndex')},
${method('_getCenterInsertIndex', '_addToPanelBox')},
${method('_addToPanelBox', '_updatePanel')},
${method('_updatePanel', '_cloneAllMainPanelIndicators')},
${source.slice(updateBoxStart, updateBoxEnd)}
})`, context);

const left = new Actor('left');
const center = new Actor('center');
const centerBin = new Actor('centerBin');
const right = new Actor('right');
center.add_child(centerBin);
const items = {};
for (const role of ['other', 'workspaces', 'weather', 'network', 'quickSettings', 'stale'])
    items[role] = new Actor(role);
// An item managed outside the refresh, before the mirrored ones
left.add_child(items.other);

Object.assign(panel, {
    monitorIndex: 1,
    _settings: {},
    _leftBox: left,
    _centerBox: center,
    _centerBin: centerBin,
    _rightBox: right,
    statusArea: { stale: items.stale },
    menuManager: { addMenu() {} },
    _ensureIndicator(role) {
        if (!this.statusArea[role])
            this.statusArea[role] = items[role];
        this.statusArea[role].show();
        this._shownInRefresh?.add(this.statusArea[role]);
        return this.statusArea[role];
    },
    _cloneAllMainPanelIndicators() {
        this._updateBox(['workspaces'], this._leftBox);
        this._updateBox(['weather'], this._centerBox);
        this._updateBox(['network'], this._rightBox);
    },
    _ensureQuickSettingsRightmost() {
        this.statusArea.quickSettings ??= items.quickSettings;
        this._addToPanelBox('quickSettings', items.quickSettings, this._rightBox.get_n_children(), this._rightBox);
    },
});

panel._updatePanel();
assert.deepEqual(left.get_children(), [items.other, items.workspaces]);
assert.deepEqual(centerBin.get_children(), [items.weather]);
assert.deepEqual(right.get_children(), [items.network, items.quickSettings]);
assert.equal(items.stale.visible, false, 'a refresh still hides indicators it does not show');

// Refreshes run on many routine changes in the main panel. Once everything is
// in place, they must not move or hide items: that reset their hover state
// (flicker) and closed open menus such as the calendar.
moves = 0;
hides = 0;
panel._updatePanel();
panel._updatePanel();
assert.equal(moves, 0, 'repeated refreshes leave placed items where they are');
assert.equal(hides, 2, 'repeated refreshes only hide the unused indicator');
for (const role of ['other', 'workspaces', 'weather', 'network', 'quickSettings'])
    assert.equal(items[role].visible, true, `${role} stays visible`);

// A real change is still applied.
right.remove_child(items.quickSettings);
right.insert_child_at_index(items.quickSettings, 0);
panel._updatePanel();
assert.deepEqual(right.get_children(), [items.network, items.quickSettings], 'misplaced tray moves back');

console.log('Panel refresh stability checks passed');

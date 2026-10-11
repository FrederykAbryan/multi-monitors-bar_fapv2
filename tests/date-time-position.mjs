import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../mmpanel.js', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../schemas/org.gnome.shell.extensions.multi-monitors-bar.gschema.xml',
    import.meta.url), 'utf8');
assert.match(schema, /<key name="date-time-position"[\s\S]*?<default>'center'<\/default>/,
    'new installations default to the centered clock');
const method = (name, next) => {
    const start = source.indexOf(`        ${name}(`);
    const end = source.indexOf(`\n        ${next}(`, start);
    assert.ok(start >= 0 && end > start, `find ${name}`);
    return source.slice(start, end);
};
const quickSettingsStart = source.indexOf('MultiMonitorsPanel.prototype._ensureQuickSettingsRightmost = function () {');
const quickSettingsEnd = source.indexOf('\n};', quickSettingsStart);
assert.ok(quickSettingsStart >= 0 && quickSettingsEnd > quickSettingsStart,
    'find Quick Settings placement');
const quickSettingsMethod = source.slice(quickSettingsStart, quickSettingsEnd + 2)
    .replace('MultiMonitorsPanel.prototype._ensureQuickSettingsRightmost = ', '');

class Actor {
    constructor() {
        this.children = [];
        this.parent = null;
        this.visible = true;
    }

    get_parent() { return this.parent; }
    get_children() { return [...this.children]; }
    get_n_children() { return this.children.length; }
    connect() { return 1; }
    show() { this.visible = true; }
    remove_child(child) {
        this.children.splice(this.children.indexOf(child), 1);
        child.parent = null;
    }
    insert_child_at_index(child, index) {
        this.children.splice(index, 0, child);
        child.parent = this;
    }
    add_child(child) { this.insert_child_at_index(child, this.children.length); }
    remove_all_children() {
        for (const child of this.get_children())
            this.remove_child(child);
    }
}

const context = vm.createContext({
    SHOW_DATE_TIME_ID: 'show-date-time',
    DATE_TIME_POSITION_ID: 'date-time-position',
    Clutter: { ActorAlign: { CENTER: 1, FILL: 2 } },
    Main: { panel: { statusArea: {} } },
});
const manager = vm.runInContext(`({
${method('_showDateTime', '_showAppMenu')},
${method('_getMainCenterRank', '_getCenterInsertIndex')},
${method('_getCenterInsertIndex', '_addToPanelBox')},
${method('_addToPanelBox', '_updatePanel')},
${method('_updatePanel', '_cloneAllMainPanelIndicators')}
})`, context);

let enabled = true;
let position = 'center';
const clock = new Actor();
const appMenu = new Actor();
const network = new Actor();
const tray = new Actor();
context.Main.panel.statusArea.quickSettings = tray;
const left = new Actor();
const center = new Actor();
const centerBin = new Actor();
const right = new Actor();
left.add_child(appMenu);
center.add_child(centerBin);
right.add_child(network);
right.add_child(tray);
Object.assign(manager, {
    _settings: {
        get_boolean(key) { assert.equal(key, 'show-date-time'); return enabled; },
        get_string(key) { assert.equal(key, 'date-time-position'); return position; },
    },
    _leftBox: left,
    _centerBox: center,
    _centerBin: centerBin,
    _rightBox: right,
    statusArea: { quickSettings: tray },
    menuManager: { addMenu() {} },
    _roleIsEnabled(_role, fallback = true) { return fallback; },
    _ensureIndicator() { return clock; },
    _destroyIndicator(role) {
        const indicator = this.statusArea[role];
        if (indicator?.get_parent())
            indicator.get_parent().remove_child(indicator);
        delete this.statusArea[role];
    },
});

manager._showDateTime();
assert.deepEqual(centerBin.get_children(), [clock], 'default clock stays centered');

position = 'left';
manager._showDateTime();
assert.deepEqual(left.get_children(), [appMenu, clock], 'left clock follows left indicators');

position = 'right-before-tray';
manager._showDateTime();
manager._showDateTime();
assert.deepEqual(right.get_children(), [network, clock, tray],
    'clock stays before the tray after repeated updates');

position = 'right-after-tray';
manager._showDateTime();
manager._showDateTime();
assert.deepEqual(right.get_children(), [network, tray, clock],
    'clock stays after the tray after repeated updates');

position = 'right-before-tray';
manager._ensureQuickSettingsRightmost = vm.runInContext(`(${quickSettingsMethod})`, context);
manager._hideIndicators = () => {};
manager._cloneAllMainPanelIndicators = () => {};
manager._updatePanel();
assert.deepEqual(right.get_children(), [network, clock, tray],
    'panel refresh restores the selected position');

position = 'right-after-tray';
manager._ensureQuickSettingsRightmost();
assert.deepEqual(right.get_children(), [network, tray, clock],
    'a later Quick Settings refresh keeps the clock after the tray');

enabled = false;
manager._showDateTime();
assert.equal(clock.get_parent(), null, 'hiding the clock removes it from the panel');

// Center items keep the main panel's order around the clock
const mainCenter = new Actor();
const mainClock = new Actor();
const mainWeather = new Actor();
mainCenter.add_child(mainClock);
mainCenter.add_child(mainWeather);
Object.assign(context.Main.panel, { _centerBox: mainCenter });
Object.assign(context.Main.panel.statusArea, { dateMenu: mainClock, weather: mainWeather });
const weather = new Actor();
enabled = true;
position = 'center';
manager._showDateTime();
manager._addToPanelBox('weather', weather, 0, center);
assert.deepEqual(centerBin.get_children(), [clock, weather],
    'an item right of the main clock stays right of the mirrored clock');

enabled = false;
manager._showDateTime();
enabled = true;
manager._showDateTime();
assert.deepEqual(centerBin.get_children(), [clock, weather],
    'a re-added clock goes back before the item that follows it on the main panel');

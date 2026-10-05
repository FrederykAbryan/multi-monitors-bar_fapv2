import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as policy from '../monitorIndicatorPolicy.js';

class Actor {
    constructor(params = {}) { this._init(params); }
    _init(params = {}) {
        this.children = [];
        this.handlers = new Map();
        this._visible = true;
        Object.assign(this, typeof params === 'object' ? params : {});
    }
    connect(signal, callback) {
        const id = Symbol(signal);
        this.handlers.set(id, {signal, callback});
        return id;
    }
    disconnect(id) { assert.ok(this.handlers.delete(id), 'disconnect a live handler'); }
    emit(signal) {
        for (const {signal: name, callback} of [...this.handlers.values()])
            if (name === signal) callback(this);
    }
    get visible() { return this._visible; }
    set visible(value) {
        if (this._visible === value) return;
        this._visible = value;
        this.emit('notify::visible');
    }
    add_child(child) { this.children.push(child); }
    get_children() { return [...this.children]; }
    set_child(child) { this.add_child(child); }
    set_style(style) { this.style = style; }
    destroy_all_children() {
        for (const child of this.children) child.destroy();
        this.children = [];
    }
    destroy() {
        this.emit('destroy');
        this.destroy_all_children();
        this.handlers.clear();
    }
}
class Checkbox extends Actor {
    get active() { return this._active; }
    set active(value) {
        if (this._active === value) return;
        this._active = value;
        this.emit('toggled');
    }
    click() { this.active = !this.active; }
}
class PreferencesWidget extends Actor {
    add(child) { this.add_child(child); }
    remove(child) { this.children = this.children.filter(value => value !== child); }
    add_suffix(child) { this.add_child(child); }
}
class Settings extends Actor {
    constructor() {
        super();
        this.values = {'monitor-indicator-catalog': '{}', 'monitor-indicator-visibility': '{}', 'show-date-time': true,
            'show-app-menu': true, 'show-activities': true};
    }
    get_string(key) { return this.values[key]; }
    get_boolean(key) { return this.values[key]; }
    set_string(key, value) { this.values[key] = value; this.emit(`changed::${key}`); }
}

const pending = new Map();
let timer = 0;
const flush = () => {
    // A sync may enqueue one further update through source observers.
    for (let count = 0; pending.size; count++) {
        assert.ok(count < 10, 'source visibility updates settle');
        for (const [id, callback] of [...pending]) {
            pending.delete(id);
            callback();
        }
    }
};
const settings = new Settings();
const monitors = [{width: 1920, height: 1080}, {width: 2560, height: 1440}, {width: 1920, height: 1080}];
let connectors = ['HDMI-1', 'DP-1', 'DP-2'];
const layout = new Actor({monitors, primaryIndex: 1});
const sources = {dateMenu: new Actor(), quickSettings: new Actor(), clipboard: new Actor()};
const empty = new Actor({visible: false});
const mainPanel = {
    statusArea: {...sources, empty},
    _leftBox: new Actor(), _centerBox: new Actor(), _rightBox: new Actor(),
    addToStatusArea() { assert.fail('settings control must not add a panel icon'); },
};
const panels = [{refreshes: 0, _updatePanel() { this.refreshes++; }}];
const context = vm.createContext({
    ...policy,
    _: text => text,
    Main: {panel: mainPanel, layoutManager: layout, extensionManager: new Actor()},
    global: {display: {get_monitor_plug_name: index => connectors[index], get_current_monitor: () => 1}},
    Adw: {PreferencesPage: PreferencesWidget, PreferencesGroup: PreferencesWidget, ActionRow: PreferencesWidget},
    Gtk: {CheckButton: Checkbox, Align: {CENTER: 0}},
    GObject: {registerClass: value => value, signal_lookup: () => true},
    GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
        timeout_add(_priority, _delay, callback) { pending.set(++timer, callback); return timer; },
        source_remove(id) { pending.delete(id); }},
});
const source = readFileSync(new URL('../monitorIndicatorsDialog.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export class MonitorIndicatorsController', 'class MonitorIndicatorsController');
const Controller = vm.runInContext(`${source}\nMonitorIndicatorsController;`, context);
const controller = new Controller(settings, () => panels);
flush();
const prefsSource = readFileSync(new URL('../monitorIndicatorPrefs.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export class MonitorIndicatorPreferences', 'class MonitorIndicatorPreferences');
const Preferences = vm.runInContext(`${prefsSource}\nMonitorIndicatorPreferences;`, context);
const preferences = new Preferences(settings);
assert.equal(preferences.page.children.length, 3, 'one section per connected monitor');
assert.match(preferences.page.children[0].title, /^Main monitor/,
    'main section comes first even when primary index is not zero');
assert.match(preferences.page.children[1].title, /^Extended 1/);
assert.match(preferences.page.children[2].title, /^Extended 2/);
const check = (index, role) => preferences._checks.find(row =>
    row.monitor.key === policy.monitorKey(context.global.display, index, layout.primaryIndex) && row.role === role).checkbox;
assert.equal(check(1, 'clipboard').active, true);
assert.ok(!preferences._checks.some(row => row.role === policy.CONTROL_ROLE));

check(1, 'clipboard').click();
assert.equal(sources.clipboard.visible, false, 'uncheck main immediately hides the source');
assert.equal(policy.sourceIsVisible(sources.clipboard), true, 'extended mirrors retain source content');
assert.equal(controller.enabled(0, 'clipboard'), true, 'extended 1 remains enabled');
assert.equal(controller.enabled(2, 'clipboard'), true, 'extended 2 remains enabled');
check(2, 'clipboard').click();
assert.equal(controller.enabled(2, 'clipboard'), false, 'extended 2 has an independent override');
assert.equal(controller.enabled(0, 'clipboard'), true);
assert.ok(panels[0].refreshes > 1, 'changes refresh extended panels');

sources.clipboard.visible = true;
assert.equal(sources.clipboard.visible, false, 'source updates cannot override a main selection');
flush();
check(1, 'clipboard').click();
assert.equal(sources.clipboard.visible, true, 'checking restores the source');
check(1, 'clipboard').click();

settings.values['show-date-time'] = false;
settings.emit('changed::show-date-time');
assert.equal(check(0, 'dateMenu').active, false, 'existing defaults remain effective without an override');
check(0, 'dateMenu').click();
assert.equal(controller.enabled(0, 'dateMenu'), true, 'per-monitor choice overrides an existing default');

layout.monitors = [monitors[1], monitors[2]];
layout.primaryIndex = 0;
connectors = ['DP-1', 'DP-2'];
layout.emit('monitors-changed');
flush();
assert.equal(preferences.page.children.length, 2, 'disconnect removes the extra section');
assert.equal(controller.enabled(1, 'clipboard'), false, 'connector choice survives monitor index changes');
assert.equal(sources.clipboard.visible, false, 'main choice follows the primary monitor');
layout.monitors = [monitors[1]];
connectors = ['DP-1'];
layout.emit('monitors-changed');
flush();
assert.equal(preferences.page.children.length, 1, 'single monitor only has a main section');

const late = new Actor();
mainPanel.statusArea.lateExtension = late;
mainPanel._rightBox.emit('child-added');
flush();
assert.ok(preferences._checks.some(row => row.role === 'lateExtension'), 'late extension appears in the checklist');
late.destroy();
delete mainPanel.statusArea.lateExtension;
flush();
assert.ok(!preferences._checks.some(row => row.role === 'lateExtension'), 'removed extension disappears');

controller.destroy();
assert.match(preferences.page.children[0].description, /Enable the extension/);
preferences.destroy();
assert.equal(settings.handlers.size, 0, 'preferences and controller release settings watchers');
assert.equal(sources.clipboard.visible, true, 'disable restores originally visible sources');
assert.equal(empty.visible, false, 'disable preserves naturally hidden indicators');
assert.equal(pending.size, 0, 'disable removes pending refreshes');
assert.equal(policy.primaryVisibility.has(sources.clipboard), false, 'disable clears source overrides');
assert.equal(layout.handlers.size, 0, 'disable disconnects monitor watchers');

const previous = settings.get_string(policy.VISIBILITY_KEY);
const restored = new Controller(settings, () => panels);
flush();
assert.equal(sources.clipboard.visible, false, 're-enable reapplies the saved main preference');
assert.equal(settings.get_string(policy.VISIBILITY_KEY), previous, 're-enable preserves selections');
restored.destroy();

// Exercise the actual panel scan with a source hidden on main and different
// choices on two extended monitors. No mirror should depend on main visibility.
const panelSource = readFileSync(new URL('../mmpanel.js', import.meta.url), 'utf8');
const method = (name, next) => {
    const start = panelSource.indexOf(`        ${name}(`);
    const end = panelSource.indexOf(`\n        ${next}(`, start);
    assert.ok(start >= 0 && end > start);
    return panelSource.slice(start, end);
};
context.SHOW_ACTIVITIES_ID = 'show-activities';
context.SHOW_APP_MENU_ID = 'show-app-menu';
context.SHOW_DATE_TIME_ID = 'show-date-time';
const panel = vm.runInContext(`({
    ${method('_roleIsEnabled', '_ensureIndicator')},
    ${method('_cloneAllMainPanelIndicators', '_isArcMenuRole')}
})`, context);
layout.monitors = monitors;
layout.primaryIndex = 1;
connectors = ['HDMI-1', 'DP-1', 'DP-2'];
mainPanel._rightBox.children = [sources.clipboard, sources.quickSettings];
sources.clipboard.visible = false;
policy.primaryVisibility.set(sources.clipboard, {visible: true});
Object.assign(panel, {
    monitorIndex: 0, _settings: settings,
    _leftBox: new Actor(), _centerBox: new Actor(), _rightBox: new Actor(),
    _hasArcMenuRole() { return false; },
    _removeStaleIndicators(roles) { this.desiredRoles = roles; },
    _updateBox() {},
});
panel._cloneAllMainPanelIndicators();
assert.equal(panel.desiredRoles.has('clipboard'), true, 'panel scan mirrors a source hidden only on main');
assert.equal(panel.desiredRoles.has('dateMenu'), true, 'per-monitor clock override survives a global default');
panel.monitorIndex = 2;
panel._cloneAllMainPanelIndicators();
assert.equal(panel.desiredRoles.has('clipboard'), false, 'other extended panel omits the unchecked icon');
policy.setIndicatorEnabled(settings, 'connector:DP-2', 'quickSettings', false);
const trayStart = panelSource.indexOf('MultiMonitorsPanel.prototype._ensureQuickSettingsRightmost = function () {');
const trayEnd = panelSource.indexOf('\n};', trayStart);
panel._ensureQuickSettingsRightmost = vm.runInContext(`(${panelSource.slice(trayStart, trayEnd + 2)
    .replace('MultiMonitorsPanel.prototype._ensureQuickSettingsRightmost = ', '')})`, context);
panel.statusArea = {};
panel._destroyIndicator = role => { panel.removedRole = role; };
panel._showDateTime = () => {};
panel._ensureQuickSettingsRightmost();
assert.equal(panel.removedRole, 'quickSettings', 'tray placement respects the per-monitor checkbox');
policy.primaryVisibility.delete(sources.clipboard);
settings.values[policy.VISIBILITY_KEY] = 'invalid JSON';
assert.equal(policy.indicatorIsEnabled(settings, 'main', 'clipboard'), true, 'invalid settings fall back safely');
settings.values[policy.VISIBILITY_KEY] = 'null';
policy.setIndicatorEnabled(settings, 'main', 'clipboard', false);
assert.equal(policy.indicatorIsEnabled(settings, 'main', 'clipboard'), false, 'malformed settings can be replaced');
console.log('Per-monitor preferences, persistence, hotplug, source visibility, and cleanup checks passed');

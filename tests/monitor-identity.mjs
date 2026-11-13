// Issue #64: per-monitor settings are keyed by connector. Mutter 49+ lists its
// monitors; older releases only map a connector name to an index, so the names
// come from DisplayConfig asynchronously.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as policy from '../monitorIndicatorPolicy.js';
import {PANEL_LAYOUT_KEY} from '../monitorPanelPolicy.js';

class Cancellable {
    cancelled = false;
    cancel() { this.cancelled = true; }
}

// Pending DisplayConfig calls; reply() answers the oldest one.
const calls = [];
const reply = connectors => {
    const {pending, callback} = calls.shift();
    callback({
        call_finish() {
            if (pending.cancelled)
                throw new Error('cancelled');
            if (!connectors)
                throw new Error('DisplayConfig unavailable');
            return {deep_unpack: () => [1, connectors.map(name => [[name, 'VND', 'PRD', 'SER'], [], {}]), [], {}]};
        },
    }, {});
};
const settings = {
    values: {[policy.VISIBILITY_KEY]: '{}', [PANEL_LAYOUT_KEY]: '{}'},
    get_string(key) { return this.values[key]; },
    set_string(key, value) { this.values[key] = value; },
};
const layout = {monitors: [{}, {}, {}], primaryIndex: 0};
const context = vm.createContext({
    ...policy,
    PANEL_LAYOUT_KEY,
    Main: {layoutManager: layout},
    Gio: {
        Cancellable,
        DBusCallFlags: {NONE: 0},
        DBus: {session: {call(...args) { calls.push({pending: args[8], callback: args[9]}); }}},
    },
    global: {backend: {get_monitor_manager: () => manager}},
});
const source = readFileSync(new URL('../monitorIdentity.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/^export /gm, '');
const identity = vm.runInContext(`${source}
({monitorConnector, refreshMonitorConnectors, clearMonitorConnectors, currentMonitorKey, migrateMonitorSettings})`,
context);

// Mutter 49+: connectors are read directly, no DBus round trip.
let order = ['eDP-1', 'DP-1', 'HDMI-1'];
let manager = {
    get_logical_monitors: () => order.map((connector, number) => ({
        get_number: () => number,
        get_monitors: () => [{get_connector: () => connector}],
    })),
};
let changes = 0;
identity.refreshMonitorConnectors(() => changes++);
assert.equal(calls.length, 0, 'no DisplayConfig call when Mutter lists its monitors');
assert.equal(identity.currentMonitorKey(0), 'main');
assert.equal(identity.currentMonitorKey(1), 'connector:DP-1');
assert.equal(identity.currentMonitorKey(5), 'monitor:5', 'unknown index falls back to the index key');
order = ['eDP-1', 'HDMI-1', 'DP-1'];
assert.equal(identity.currentMonitorKey(2), 'connector:DP-1', 'key follows the connector to a new index');

settings.values[PANEL_LAYOUT_KEY] = '{"monitor:1":{"position":"left"},"monitor:2":{"color":"red"}}';
identity.migrateMonitorSettings(settings);
assert.deepEqual(JSON.parse(settings.values[PANEL_LAYOUT_KEY]),
    {'connector:HDMI-1': {position: 'left'}, 'connector:DP-1': {color: 'red'}});

// Mutter 45-48: only get_monitor_for_connector() exists.
order = ['eDP-1', 'DP-1', 'HDMI-1'];
manager = {get_monitor_for_connector: name => order.indexOf(name)};
settings.values[PANEL_LAYOUT_KEY] = '{"monitor:1":{"position":"left"}}';
identity.refreshMonitorConnectors(() => changes++);
assert.equal(calls.length, 1, 'connector names are requested from DisplayConfig');
assert.equal(identity.currentMonitorKey(1), 'monitor:1', 'index key until the names arrive');
identity.migrateMonitorSettings(settings);
assert.equal(settings.values[PANEL_LAYOUT_KEY], '{"monitor:1":{"position":"left"}}', 'nothing migrates without names');
reply(order);
assert.equal(changes, 1, 'arrival of the names is reported');
assert.equal(identity.currentMonitorKey(0), 'main');
assert.equal(identity.currentMonitorKey(1), 'connector:DP-1');
identity.migrateMonitorSettings(settings);
assert.deepEqual(JSON.parse(settings.values[PANEL_LAYOUT_KEY]), {'connector:DP-1': {position: 'left'}});
order = ['eDP-1', 'HDMI-1', 'DP-1'];
assert.equal(identity.currentMonitorKey(2), 'connector:DP-1', 'cached names still resolve live indices');

identity.refreshMonitorConnectors(() => changes++);
reply(order);
assert.equal(changes, 1, 'unchanged names are not reported again');
identity.refreshMonitorConnectors(() => changes++);
reply(null);
assert.equal(identity.currentMonitorKey(2), 'connector:DP-1', 'a failed call keeps the known names');

// A newer request supersedes the previous one; disable cancels and forgets.
identity.refreshMonitorConnectors(() => changes++);
identity.refreshMonitorConnectors(() => changes++);
assert.equal(calls[0].pending.cancelled, true, 'superseded request is cancelled');
reply(['eDP-1']);
reply(['eDP-1', 'DP-3']);
assert.equal(changes, 2, 'only the latest reply is applied');
identity.refreshMonitorConnectors(() => changes++);
identity.clearMonitorConnectors();
assert.equal(calls[0].pending.cancelled, true, 'disable cancels the pending request');
reply(order);
assert.equal(changes, 2, 'a cancelled reply never calls back');
assert.equal(identity.currentMonitorKey(1), 'monitor:1', 'disable forgets the cached names');

console.log('Monitor identity checks passed (Mutter 49+ lookup, DisplayConfig fallback, migration, cleanup)');

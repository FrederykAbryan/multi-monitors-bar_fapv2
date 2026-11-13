// Issue #64: per-monitor settings are keyed by connector. Mutter maps a
// connector name to an index; the names come from DisplayConfig asynchronously.
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
                throw Object.assign(new Error('cancelled'), {matches: () => true});
            if (!connectors)
                throw Object.assign(new Error('DisplayConfig unavailable'), {matches: () => false});
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
const warnings = [];
const context = vm.createContext({
    ...policy,
    PANEL_LAYOUT_KEY,
    Main: {layoutManager: layout},
    console: {warn: message => warnings.push(message)},
    Gio: {
        Cancellable,
        IOErrorEnum: {CANCELLED: 19},
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

let order = ['eDP-1', 'DP-1', 'HDMI-1'];
const manager = {get_monitor_for_connector: name => order.indexOf(name)};
let changes = 0;
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
assert.equal(identity.currentMonitorKey(5), 'monitor:5', 'unknown index falls back to the index key');
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
assert.equal(warnings.length, 1, 'a failed call is reported');

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
assert.equal(warnings.length, 1, 'cancellation is not reported');
assert.equal(identity.currentMonitorKey(1), 'monitor:1', 'disable forgets the cached names');

console.log('Monitor identity checks passed (DisplayConfig lookup, migration, cleanup)');

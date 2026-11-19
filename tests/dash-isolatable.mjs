// A startup placeholder must not be treated as a Dash. Wrapping one throws
// in enable() because DashMonitorIsolation calls _queueRedisplay immediately.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dashIsolation.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
const isIsolatableDash = vm.runInContext(`${source}\nisIsolatableDash`, vm.createContext({
    GLib: {USEC_PER_SEC: 1000000},
    Clutter: {},
    Shell: {},
    Meta: {},
    Main: {},
    global: {},
}));

const dash = {
    _box: {},
    _appSystem: {},
    _queueRedisplay() {},
    _redisplay() {},
};

assert.equal(isIsolatableDash(dash), true, 'a Dash with the private surface');
assert.equal(isIsolatableDash(null), false, 'no dash');
assert.equal(isIsolatableDash({}), false, 'blank actor');
assert.equal(isIsolatableDash({
    showAppsButton: {},
}), false, 'Dash to Dock startup dummy');
assert.equal(isIsolatableDash({
    _box: {},
    _appSystem: {},
}), false, 'missing redisplay methods');

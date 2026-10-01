import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../mmoverview.js', import.meta.url), 'utf8');
const timers = new Map();
let nextId = 1;
const context = vm.createContext({
    GLib: {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        timeout_add(_priority, _delay, callback) {
            const id = nextId++;
            timers.set(id, callback);
            return id;
        },
        source_remove(id) { assert.ok(timers.delete(id), 'remove only a live timer'); },
    },
    Main: {overview: {}, layoutManager: {disconnectObject() {}}},
    Shell: {AppSystem: {get_default: () => ({disconnectObject() {}})}},
    global: {display: {disconnect(id) { disconnected.push(id); }}},
});
const disconnected = [];
const names = ['_scheduleWindowOperation', '_disconnectAll'];
const manager = vm.runInContext('({' + names.map(name => {
    const start = source.indexOf('        ' + name + '(');
    assert.ok(start >= 0);
    return source.slice(start, source.indexOf('\n        }', start) + 10);
}).join(',') + '})', context);
manager._pendingTimeouts = [];
manager._resetWorkspacesViewTransform = () => {};

function makeWindow() {
    const signals = new Map();
    return {
        signals,
        connect(name, callback) {
            assert.equal(name, 'unmanaged');
            const id = nextId++;
            signals.set(id, callback);
            return id;
        },
        disconnect(id) { assert.ok(signals.delete(id), 'disconnect only an owned handler'); },
        close() { for (const callback of [...signals.values()]) callback(); },
    };
}

// A window closing before the delayed move cancels the callback and its source.
const closed = makeWindow();
manager._scheduleWindowOperation(closed, 100, () => assert.fail('closed window was accessed'));
closed.close();
assert.equal(timers.size, 0);
assert.equal(closed.signals.size, 0);
assert.equal(manager._windowOperations.size, 0);

// A fired timeout is no longer a live GLib source when its callback executes.
const live = makeWindow();
let moves = 0;
manager._scheduleWindowOperation(live, 100, () => moves++);
const [id, callback] = [...timers.entries()][0];
timers.delete(id);
callback();
assert.equal(moves, 1);
assert.equal(live.signals.size, 0);
assert.equal(manager._windowOperations.size, 0);

// Disabling with pending moves also releases the launch listener immediately.
const pending = makeWindow();
manager._scheduleWindowOperation(pending, 50, () => assert.fail('callback after disable'));
manager._launchSignalIds = new Set([123]);
manager._disconnectAll();
assert.equal(timers.size, 0);
assert.equal(pending.signals.size, 0);
assert.deepEqual(disconnected, [123]);
assert.equal(manager._windowOperations, null);
console.log('Overview window lifecycle checks passed');

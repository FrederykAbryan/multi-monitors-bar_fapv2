// Review: every timeout, compositor later and signal handler DashMonitorIsolation
// starts for a window placement must be removed when the instance is destroyed.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Signals {
    handlers = new Map();
    nextId = 1;
    connect(name, callback) {
        const id = this.nextId++;
        this.handlers.set(id, {name, callback});
        return id;
    }
    disconnect(id) {
        assert.ok(this.handlers.delete(id), `disconnect of unknown handler ${id}`);
    }
    connectObject(...args) {
        const owner = args.pop();
        for (let i = 0; i < args.length; i += 2)
            (owner.owned ??= []).push([this, this.connect(args[i], args[i + 1])]);
    }
    disconnectObject(owner) {
        owner.owned = (owner.owned ?? []).filter(([object, id]) => {
            if (object !== this)
                return true;
            // GJS's signal tracker already dropped a destroyed emitter's handlers.
            if (!this.destroyed)
                this.disconnect(id);
            return false;
        });
    }
    destroy() {
        this.destroyed = true;
        this.handlers.clear();
    }
    emit(name, ...args) {
        for (const {name: n, callback} of [...this.handlers.values()])
            if (n === name) callback(this, ...args);
    }
}

// GLib main loop sources and Meta laters, with strict removal checks.
class Sources {
    pending = new Map();
    nextId = 1;
    add(callback) {
        const id = this.nextId++;
        this.pending.set(id, callback);
        return id;
    }
    remove(id) {
        assert.ok(this.pending.delete(id), `removal of unknown source ${id}`);
    }
    runAll() {
        for (const [id, callback] of [...this.pending]) {
            if (!this.pending.has(id))
                continue;
            this.pending.delete(id);
            callback();
        }
    }
}

const timeouts = new Sources();
const laters = new Sources();
const display = new Signals();
const GLib = {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    USEC_PER_SEC: 1000000,
    get_monotonic_time: () => 0,
    timeout_add: (_priority, ms, callback) => {
        const id = timeouts.add(callback);
        timeouts.pending.get(id).ms = ms;
        return id;
    },
    source_remove: id => timeouts.remove(id),
};
const context = vm.createContext({
    GLib,
    Clutter: {},
    Shell: {},
    Meta: {LaterType: {BEFORE_REDRAW: 0}, WindowType: {NORMAL: 0}},
    Main: {},
    DASH_ANIMATION_TIME: 200,
    global: {
        display,
        compositor: {get_laters: () => ({
            add: (_type, callback) => laters.add(callback),
            remove: id => laters.remove(id),
        })},
    },
});
const source = readFileSync(new URL('../dashIsolation.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
const DashMonitorIsolation = vm.runInContext(`${source}\nDashMonitorIsolation`, context);

function setup() {
    const settings = new Signals();
    settings.get_boolean = () => false;
    const dash = new Signals();
    dash._appSystem = {};
    dash._queueRedisplay = () => {};
    let monitorQueries = 0;
    const isolation = new DashMonitorIsolation(dash, settings, () => {
        monitorQueries++;
        return 1;
    });
    const actor = new Signals();
    Object.assign(actor, {mapped: false, visible: true});
    const window = new Signals();
    Object.assign(window, {
        monitor: 0,
        get_monitor() { return this.monitor; },
        move_to_monitor(index) { this.monitor = index; },
        get_compositor_private: () => actor,
    });
    return {isolation, window, actor, queries: () => monitorQueries};
}

function assertNothingPending(what, {window, actor}) {
    assert.equal(timeouts.pending.size, 0, `${what}: timeouts removed`);
    assert.equal(laters.pending.size, 0, `${what}: laters removed`);
    assert.equal(window.handlers.size, 0, `${what}: window handlers disconnected`);
    assert.equal(actor.handlers.size, 0, `${what}: actor handlers disconnected`);
    assert.equal(display.handlers.size, 0, `${what}: display handlers disconnected`);
}

// 1. Destroyed before the first-frame later ran: hard-cap timeout, the later
//    and the hold's window/display handlers are all pending.
{
    const t = setup();
    t.isolation._holdOnMonitor(t.window);
    assert.equal(t.window.monitor, 1, 'window moved to the dock monitor');
    assert.equal(timeouts.pending.size, 1, 'hard-cap timeout armed');
    assert.equal(laters.pending.size, 1, 'first-frame later queued');
    t.isolation.destroy();
    assertNothingPending('before first frame', t);
    const queries = t.queries();
    t.window.emit('position-changed');
    assert.equal(t.queries(), queries, 'destroyed hold no longer moves the window');
}

// 2. Destroyed while waiting for the actor's first frame.
{
    const t = setup();
    t.isolation._holdOnMonitor(t.window);
    laters.runAll();
    assert.equal(t.actor.handlers.size, 1, 'waiting on first-frame');
    t.isolation.destroy();
    assertNothingPending('waiting for first frame', t);
}

// 3. Destroyed during the settle period after the first frame.
{
    const t = setup();
    t.isolation._holdOnMonitor(t.window);
    laters.runAll();
    t.actor.emit('first-frame');
    assert.equal(timeouts.pending.size, 1, 'settle timeout replaces the hard cap');
    assert.equal([...timeouts.pending.values()][0].ms, 1500, 'settle timeout armed');
    assert.equal(t.actor.handlers.size, 0, 'first-frame wait released once fired');
    t.isolation.destroy();
    assertNothingPending('settling', t);
}

// 4. A hold that already ended (window unmanaged) is not stopped twice, and
//    a closed-before-drawn actor leaves nothing to disconnect.
{
    const t = setup();
    t.isolation._holdOnMonitor(t.window);
    laters.runAll();
    t.actor.destroy(); // window closed before its first frame
    t.window.emit('unmanaged');
    assert.equal(timeouts.pending.size, 0, 'unmanaged window ends its hold');
    t.isolation.destroy(); // would assert on a double disconnect/remove
    assertNothingPending('already stopped', t);
}

// 5. A standalone first-frame wait (from _watchPlacement) is cancelled too.
{
    const t = setup();
    let fired = false;
    t.isolation._onFirstFrame(t.window, () => (fired = true));
    t.isolation.destroy();
    assertNothingPending('placement wait', t);
    assert.equal(fired, false, 'cancelled wait never calls back');
}

console.log('DashMonitorIsolation destroy removes every timeout, later and handler');

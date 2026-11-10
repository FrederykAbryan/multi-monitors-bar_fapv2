import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../mmoverview.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('class MultiMonitorsControlsManager'));
let installed = [];
const handlers = new Map();
const appSystem = {
    get_installed: () => installed,
    connectObject(signal, callback, owner) {
        assert.equal(signal, 'installed-changed');
        handlers.set(owner, callback);
    },
    disconnectObject(owner) { handlers.delete(owner); },
};
const context = vm.createContext({
    Shell: { AppSystem: { get_default: () => appSystem } },
    AppDisplay: { AppSearchProvider: class {
        async getInitialResultSet(terms) {
            return installed.filter(info => info.should_show() &&
                terms.every(term => info.get_name().toLowerCase().includes(term)))
                .map(info => info.get_id());
        }
    } },
    Main: { layoutManager: { disconnectObject() {} } },
    console: { debug() {} },
});
context.Main.overview = {};
const names = ['_populateAppGrid', '_onInstalledAppsChanged', '_syncAppGridState',
    '_resetWorkspacesViewTransform', '_disconnectAll'];
const manager = vm.runInContext('({' + names.map(name => {
    const start = body.search(new RegExp('        (?:async )?' + name + '\\('));
    assert.ok(start >= 0, name);
    return body.slice(start, body.indexOf('\n        }', start) + 10);
}).join(',') + '})', context);
let query = 'zebra';
const grid = {
    children: [],
    get_children() { return [...this.children]; },
    add_child(child) { this.children.push(child); },
    set_child_at_index(child, index) {
        this.children.splice(this.children.indexOf(child), 1);
        this.children.splice(index, 0, child);
    },
};
Object.assign(manager, {
    _visible: true,
    _appGrid: grid,
    _pendingTimeouts: [],
    _getSearchText: () => query,
    _isAppGridState: () => false,
    _tryFindWorkspacesViews() {},
    _setFocusedApp(app) {
        assert.ok(!this._focusedApp?.destroyed, 'release focus before destroying buttons');
        this._focusedApp = app;
    },
    _createAppButton(app) {
        return {
            _appInfo: app, visible: true, destroyed: false,
            destroy() {
                this.destroyed = true;
                grid.children.splice(grid.children.indexOf(this), 1);
            },
        };
    },
});
const app = (name, visible = true) => ({
    get_name: () => name,
    get_id: () => name.toLowerCase() + '.desktop',
    should_show: () => visible,
});
const results = () => grid.children.filter(child => child.visible);

// Exercise the actual subscription from _init without constructing GNOME actors.
const subscription = body.match(/Shell\.AppSystem\.get_default\(\)\.connectObject\([\s\S]*?\);/);
assert.ok(subscription, 'listen for app installation changes');
context.manager = manager;
vm.runInContext('(function () {' + subscription[0] + '}).call(manager)', context);
installed = Array.from({ length: 110 }, (_, i) => app('App ' + String(i).padStart(3, '0')));
manager._populateAppGrid();
await manager._syncAppGridState();
assert.equal(results().length, 0);

// New apps sort beyond the old 100-app cap and appear without changing the query.
const retired = [...grid.children];
installed.push(app('Zebra'), app('Zebra Hidden', false));
await handlers.get(manager)();
assert.equal(grid.children.length, 111);
assert.ok(retired.every(child => child.destroyed));
assert.equal(results().length, 1);
assert.equal(manager._focusedApp._appInfo.get_name(), 'Zebra');

// Uninstall the focused app, then refresh repeatedly without duplicate buttons.
installed = installed.filter(info => info.get_name() !== 'Zebra');
await handlers.get(manager)();
assert.equal(results().length, 0);
assert.equal(manager._focusedApp, null);
await handlers.get(manager)();
assert.equal(grid.children.length, 110);

query = 'app';
await manager._syncAppGridState();
assert.equal(results().length, 6, 'keep the existing six-result display limit');
manager._visible = false;
installed.push(app('Zebra'));
await handlers.get(manager)();
query = 'zebra';
manager._visible = true;
await manager._syncAppGridState();
assert.equal(results().length, 1, 'changes while hidden appear on reopening');

// Provider matches may come from keywords or executable names, not display names.
installed.push(app('Antigravity'), app('Visual Studio Code'));
await handlers.get(manager)();
const requestedTerms = [];
manager._appSearchProvider = {
    async getInitialResultSet(terms) {
        requestedTerms.push([...terms]);
        return ['visual studio code.desktop', 'antigravity.desktop', 'power-off'];
    },
};
query = '  VSC   editor  ';
await manager._syncAppGridState();
assert.deepEqual(requestedTerms, [['vsc', 'editor']]);
assert.deepEqual(results().map(child => child._appInfo.get_name()),
    ['Visual Studio Code', 'Antigravity'], 'preserve provider ranking, not alphabetical order');
assert.equal(manager._focusedApp, results()[0]);

// Searching hides the workspace preview; clearing must restore it on this open.
const workspace = { visible: true, opacity: 255, disconnectObject() {} };
Object.assign(manager, {
    _workspacesViews: workspace,
    _appGridScrollView: { visible: false },
    _thumbnailsBox: { visible: true },
    _searchController: { visible: false },
    _isActorUsable: () => true,
    _setActorVisible(actor, visible) { actor.visible = visible; },
    _syncWorkspacesViewGeometry() {},
});
for (const emptyQuery of ['', '   ']) {
    query = 'vsc';
    await manager._syncAppGridState();
    assert.equal(workspace.visible, false);
    assert.equal(workspace.opacity, 0);
    assert.equal(manager._appGridScrollView.visible, true);

    query = emptyQuery;
    await manager._syncAppGridState();
    assert.equal(workspace.visible, true, 'clearing search restores the workspace preview');
    assert.equal(workspace.opacity, 255);
    assert.equal(workspace.scale_x, 1);
    assert.equal(workspace.translation_x, 0);
    assert.equal(manager._appGridScrollView.visible, false);
    assert.equal(manager._thumbnailsBox.visible, true);
    assert.equal(manager._focusedApp, null);
}

const pending = [];
manager._appSearchProvider = {
    getInitialResultSet() { return new Promise(resolve => pending.push(resolve)); },
};
query = 'vsc';
const oldSearch = manager._syncAppGridState();
assert.equal(manager._focusedApp, null, 'Enter must not launch a stale result while searching');
query = 'zebra';
const newSearch = manager._syncAppGridState();
pending[1](['zebra.desktop']);
await newSearch;
pending[0](['visual studio code.desktop']);
await oldSearch;
assert.deepEqual(results().map(child => child._appInfo.get_name()), ['Zebra']);

// Clearing while a provider request is pending must also restore the preview,
// and the late response must not hide it again.
const clearingSearch = manager._syncAppGridState();
query = '';
await manager._syncAppGridState();
assert.equal(workspace.visible, true);
assert.equal(workspace.opacity, 255);
pending[2](['visual studio code.desktop']);
await clearingSearch;
assert.equal(workspace.visible, true);
assert.equal(manager._appGridScrollView.visible, false);

query = 'vsc';
const closingSearch = manager._syncAppGridState();
manager._visible = false;
query = '';
await manager._syncAppGridState();
pending[3](['visual studio code.desktop']);
await closingSearch;
assert.equal(manager._focusedApp, null, 'closing invalidates pending results');

manager._visible = true;
query = 'vsc';
const retiringSearch = manager._syncAppGridState();
manager._disconnectAll();
// Teardown disconnects 'installed-changed', so it cannot fire afterwards.
assert.equal(handlers.size, 0);
grid.get_children = () => assert.fail('pending search must not access destroyed actors');
pending[4](['visual studio code.desktop']);
await retiringSearch;
manager._disconnectAll();
console.log('Overview app search regression checks passed');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../mmoverview.js', import.meta.url), 'utf8');
const start = source.indexOf('        _configureNativeAppDisplayLayout() {');
assert.ok(start >= 0);
const end = source.indexOf('\n        _syncNativePageIndicatorsPosition()', start);
const manager = vm.runInNewContext(`({${source.slice(start, end)}})`);

// Model IconGrid's allocation-time mode selection and cached mode index.
// These are the GNOME behaviors that direct layout property writes bypassed.
const grid = {
    layoutManager: { columnsPerPage: 6, rowsPerPage: 4 },
    _gridModes: [{ columns: 6, rows: 4 }, { columns: 8, rows: 3 }],
    _currentMode: -1,
    relayouts: 0,
    queue_relayout() { this.relayouts++; },
    setGridModes(modes) {
        this._gridModes = modes;
        this.relayouts++;
    },
    _setGridMode(index) {
        if (this._currentMode === index)
            return;
        this._currentMode = index;
        if (index !== -1) {
            this.layoutManager.columnsPerPage = this._gridModes[index].columns;
            this.layoutManager.rowsPerPage = this._gridModes[index].rows;
        }
    },
    allocate(width, height, padding = 0) {
        const ratio = (width - padding * 2) / (height - padding * 2);
        let best = -1;
        let distance = Infinity;
        this._gridModes.forEach(({ columns, rows }, index) => {
            const candidate = Math.abs(ratio - columns / rows);
            if (candidate < distance) {
                distance = candidate;
                best = index;
            }
        });
        this._setGridMode(best);
    },
};
let portrait = false;
Object.assign(manager, {
    _appDisplay: { _grid: grid },
    _isActorUsable: actor => !!actor,
    _isPortraitMonitor: () => portrait,
});
const dimensions = () => [grid.layoutManager.columnsPerPage, grid.layoutManager.rowsPerPage];

// Allocation must not replace the configured layout, regardless of the theme
// padding or available size. Reopening must retain the same dimensions.
manager._configureNativeAppDisplayLayout();
for (const [width, height, padding] of [[1920, 1080, 0], [1366, 768, 48], [960, 1080, 24]]) {
    grid.allocate(width, height, padding);
    assert.deepEqual(dimensions(), [8, 3]);
    manager._configureNativeAppDisplayLayout();
    assert.deepEqual(dimensions(), [8, 3]);
}
assert.equal(grid.relayouts, 1, 'unchanged layouts should not queue more work');

// Rotating replaces mode 0, so its previous cached index must be invalidated.
portrait = true;
manager._configureNativeAppDisplayLayout();
grid.allocate(1080, 1920, 48);
assert.deepEqual(dimensions(), [4, 5]);
portrait = false;
manager._configureNativeAppDisplayLayout();
grid.allocate(1920, 1080);
assert.deepEqual(dimensions(), [8, 3]);

manager._isActorUsable = () => false;
manager._appDisplayVisible = true;
manager._configureNativeAppDisplayLayout();
assert.equal(manager._appDisplay, null);
assert.equal(manager._appDisplayVisible, false);
console.log('Overview app-grid layout regression checks passed');

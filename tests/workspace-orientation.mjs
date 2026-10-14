import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Actor {
    constructor(props = {}) { Object.assign(this, props); this.children = []; }
    add_child(child) { this.children.push(child); }
    set_child(child) { this.add_child(child); }
    set_size(width, height) { Object.assign(this, {width, height}); }
    destroy_all_children() { this.children = []; }
}
const source = readFileSync(new URL('../mirroredIndicatorButton.js', import.meta.url), 'utf8');
const method = (name, next) => source.slice(source.indexOf(`        ${name}(`),
    source.indexOf(`\n        ${next}(`, source.indexOf(`        ${name}(`)));
let active = 0;
const context = vm.createContext({
    St: {Widget: Actor, Button: Actor, BoxLayout: Actor, Bin: Actor},
    Clutter: {ActorAlign: {CENTER: 1, FILL: 2}, Orientation: {VERTICAL: 1}},
    MMWorkspacePreviewLayout: class {},
    setBoxVertical: (box, vertical) => { box.vertical = vertical; },
});
const button = vm.runInContext(`({
    ${method('_updateWorkspaceDots', '_syncPanelOrientation')},
    ${method('_syncPanelOrientation', '_initGenericIndicator')},
    ${method('_createWorkspacePreviewThumbnail', '_populateWorkspacePreviewLayer')}
})`, context);
Object.assign(button, {
    _role: 'activities', _panel: {_vertical: true},
    _workspaceDotsBox: new Actor(),
    _workspaceManager: {n_workspaces: 2, get_active_workspace_index: () => active},
});
button._syncPanelOrientation(true);
assert.deepEqual(button._workspaceDotsBox.children.map(dot => [dot.width, dot.height]), [[44, 12], [44, 8]],
    'side bar workspace markers have a legible width and height');
active = 1;
button._updateWorkspaceDots();
assert.equal(button._workspaceDotsBox.children[1].height, 12, 'switching workspaces preserves the larger active marker');
button._syncPanelOrientation(false);
assert.deepEqual(button._workspaceDotsBox.children.map(dot => [dot.width, dot.height]), [[7, 7], [34, 8]],
    'horizontal bars restore their original dots');

button._role = 'workspace-indicator';
button._workspacePreviewBox = new Actor();
button.set_height = height => { button.height = height; };
button._updateWorkspacePreviewMirror = () => {
    button._workspacePreviewBox.children = [button._createWorkspacePreviewThumbnail(0, true),
        button._createWorkspacePreviewThumbnail(1, false)];
};
button._populateWorkspacePreviewLayer = () => {};
button._syncPanelOrientation(true);
assert.equal(button.height, -1, 'vertical preview stacks use their natural height');
assert.equal(button._workspacePreviewBox.vertical, true, 'side bar thumbnails stack instead of being shrunk as a row');
assert.equal(button._workspacePreviewBox.children[0].height, 42, 'each workspace receives a full-height thumbnail');
const preview = button._workspacePreviewBox.children[0].children[0].children[0];
assert.equal(preview.height, 28, 'side bar previews are taller than the horizontal previews');
assert.equal(preview.child.height, 28, 'window preview layer matches the enlarged preview');
button._syncPanelOrientation(false);
assert.equal(button.height, 30, 'horizontal preview button height is restored');
assert.equal(button._workspacePreviewBox.vertical, false, 'horizontal bars lay thumbnails out in a row');
assert.equal(button._workspacePreviewBox.children[0].width, 62);
assert.equal(button._workspacePreviewBox.children[0].height, 30);
console.log('Workspace dots, preview sizing, workspace switching, and orientation checks passed');

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const utils = readFileSync(join(root, 'utils.js'), 'utf8');

assert.match(utils, /export function boxLayoutOrientation/);
assert.match(utils, /SHELL_VERSION >= 51/);
assert.match(utils, /Clutter\.Orientation\.VERTICAL/);
assert.match(utils, /Clutter\.Orientation\.HORIZONTAL/);

for (const name of readdirSync(root)) {
    if (!name.endsWith('.js') || name === 'utils.js')
        continue;
    const src = readFileSync(join(root, name), 'utf8');
    assert.doesNotMatch(
        src,
        /vertical:\s*true/,
        `${name} still passes vertical: true to a constructor`);
}

console.log('BoxLayout orientation helper checks passed');

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyBuildAssets } from '../scripts/build-assets.mjs';

const root = await mkdtemp(join(tmpdir(), 'olympus-build-assets-'));
const source = join(root, 'source with spaces');
const destination = join(root, 'output with spaces');

await mkdir(join(source, 'workers', '__pycache__'), { recursive: true });
await writeFile(join(source, 'schema.sql'), 'schema');
await writeFile(join(source, 'workers', 'worker.py'), 'worker');
await writeFile(join(source, 'workers', '__pycache__', 'cached.py'), 'cached');
await writeFile(join(source, 'ignored.ts'), 'ignored');

const copied = await copyBuildAssets(source, destination);

assert.deepEqual(copied.sort(), ['schema.sql', 'workers/worker.py']);
assert.equal(await readFile(join(destination, 'schema.sql'), 'utf8'), 'schema');
assert.equal(await readFile(join(destination, 'workers', 'worker.py'), 'utf8'), 'worker');
await assert.rejects(readFile(join(destination, 'ignored.ts')));
await assert.rejects(readFile(join(destination, 'workers', '__pycache__', 'cached.py')));

console.log('Build asset copier tests passed');

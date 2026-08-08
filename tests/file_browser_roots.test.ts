import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// The file browser is unauthenticated, so its only boundary is the set of browsable
// roots. Pin the roots before importing the router, which reads them from the env.
const base = mkdtempSync(join(tmpdir(), 'olympus-file-roots-'));
const olympusHome = join(base, 'state');
const projectRoot = join(base, 'projects');
mkdirSync(join(olympusHome, 'workspace'), { recursive: true });
mkdirSync(projectRoot, { recursive: true });

process.env.OLYMPUS_DISPATCH_HOME = olympusHome;
process.env.OLYMPUS_DISPATCH_PROJECT_ROOT = projectRoot;
process.env.HERMES_HOME = join(base, 'hermes');

const { isBrowsablePath } = await import('../server/routes/files.js');
const { expandHomePrefix } = await import('../server/paths.js');

const workspace = join(olympusHome, 'workspace');

// A client-dispatched "~/.olympus-dispatch/..." path must resolve against the
// configured OLYMPUS_DISPATCH_HOME, not the process $HOME — otherwise Docker
// runs (HOME=/opt/data/home but OLYMPUS home=/opt/data/olympus-dispatch) point
// the file browser at a non-browsable path.
assert.equal(
  expandHomePrefix('~/.olympus-dispatch/workspace'),
  join(olympusHome, 'workspace'),
  '~/.olympus-dispatch must map to OLYMPUS_DISPATCH_HOME, not $HOME',
);
assert.equal(expandHomePrefix('~/.olympus-dispatch'), olympusHome);
assert.equal(
  isBrowsablePath(expandHomePrefix('~/.olympus-dispatch/workspace/uploads/x.png')),
  true,
  'client upload path must be browsable under configured home',
);

// Inside a root.
assert.equal(isBrowsablePath(workspace), true);
assert.equal(isBrowsablePath(join(workspace, 'notes', 'plan.md')), true);
assert.equal(isBrowsablePath(join(projectRoot, 'app', 'src', 'index.ts')), true);

// Outside every root — including sibling state the browser has no business reading.
assert.equal(isBrowsablePath(join(olympusHome, 'data', 'olympus-dispatch.db')), false);
assert.equal(isBrowsablePath(join(homedir(), '.ssh', 'id_rsa')), false);
assert.equal(isBrowsablePath('/etc/passwd'), false);

// Traversal cannot climb out of a root.
assert.equal(isBrowsablePath(join(workspace, '..', '..', 'secret')), false);

// A path that merely shares a prefix with a root is not inside it.
assert.equal(isBrowsablePath(`${workspace}-other/file.txt`), false);

console.log('file browser root containment ok');

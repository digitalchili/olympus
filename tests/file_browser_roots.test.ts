import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

const { filesRouter, isBrowsablePath } = await import('../server/routes/files.js');
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

// Lexical containment is not sufficient: every content-bearing route must reject
// a path that starts inside a root but resolves through a symlink to the outside.
const outside = join(base, 'outside');
mkdirSync(outside);
writeFileSync(join(outside, 'secret.txt'), 'do not expose');
writeFileSync(join(outside, 'image.png'), 'not really an image');
symlinkSync(outside, join(workspace, 'escape'), 'dir');
assert.equal(isBrowsablePath(join(workspace, 'escape', 'secret.txt')), true, 'the lexical check alone accepts the path');

async function invokeFileRoute(method: string, routePath: string, request: Record<string, unknown>) {
  const layer = filesRouter.stack.find((candidate) => candidate.route?.path === routePath);
  const handler = layer?.route?.stack.at(-1)?.handle as Function | undefined;
  assert.ok(handler, `${method.toUpperCase()} ${routePath} must be registered`);

  const result = { status: 200, body: undefined as unknown };
  const response = {
    status(status: number) { result.status = status; return this; },
    json(body: unknown) { result.body = body; return this; },
  };
  await handler(request, response);
  return result;
}

const escapedTextPath = join(workspace, 'escape', 'secret.txt');
const escapedImagePath = join(workspace, 'escape', 'image.png');
for (const [method, routePath, request] of [
  ['get', '/list', { query: { path: join(workspace, 'escape') } }],
  ['get', '/read', { query: { path: escapedTextPath } }],
  ['get', '/preview', { query: { path: escapedImagePath } }],
  ['get', '/download', { query: { path: escapedTextPath } }],
  ['put', '/write', { body: { path: escapedTextPath, content: 'overwritten' } }],
] as const) {
  const response = await invokeFileRoute(method, routePath, request);
  assert.equal(response.status, 403, `${method.toUpperCase()} ${routePath} must reject a symlink escape`);
  assert.equal((response.body as { code?: string }).code, 'PATH_NOT_ALLOWED');
}
assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'do not expose', 'rejected writes must not alter the target');

console.log('file browser root containment ok');
rmSync(base, { recursive: true, force: true });

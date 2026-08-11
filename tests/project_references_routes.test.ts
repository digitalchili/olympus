import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'olympus-project-refs-routes-'));
const dispatchHome = join(root, 'dispatch');
const hermesHome = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.HERMES_HOME = hermesHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'project-refs.db');
await mkdir(hermesHome, { recursive: true });
await writeFile(join(hermesHome, 'profile.yaml'), 'displayName: Default\nactive: true\n');
for (const id of ['reader', 'stranger']) {
  const profileHome = join(hermesHome, 'profiles', id);
  await mkdir(profileHome, { recursive: true });
  await writeFile(join(profileHome, 'profile.yaml'), `displayName: ${id}\nactive: true\n`);
}

const { createProject, grantProjectProfileAccess } = await import('../server/db/projects.js');
const { createProjectsRouter } = await import('../server/routes/projects.js');
const { default: db } = await import('../server/db/index.js');

const project = createProject({
  name: 'Reference Routes Project',
  purpose: 'Synthetic route fixtures',
  managerProfileId: 'default',
  changedBy: 'local-user',
}, 1_000);
grantProjectProfileAccess({ projectId: project.id, profileId: 'reader', role: 'view', grantedBy: 'local-user' }, 1_100);

const app = express();
app.use('/api/projects', createProjectsRouter({ now: () => 2_000, changedBy: 'local-user' }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');

type Result = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: Record<string, unknown> };

function multipartBody(field: string, filename: string, contentType: string, content: string) {
  const boundary = `----olympus-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, body };
}

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const call = (path: string, method = 'GET', body?: Buffer, contentType?: string) => new Promise<Result>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: body ? { 'Content-Type': contentType ?? 'application/octet-stream', 'Content-Length': body.length } : undefined,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json: text && (res.headers['content-type'] ?? '').toString().includes('application/json') ? JSON.parse(text) as Record<string, unknown> : {} });
      });
    });
    req.on('error', reject);
    req.end(body);
  });

  const upload = multipartBody('file', 'brief.md', 'text/markdown', '# Brief\n\nNeed gamma citations from Project references.');
  const deniedUpload = await call(`/api/projects/${project.id}/references?profile=reader`, 'POST', upload.body, `multipart/form-data; boundary=${upload.boundary}`);
  assert.equal(deniedUpload.status, 404, 'view-only profiles cannot contribute references');

  const allowedUpload = await call(`/api/projects/${project.id}/references?profile=default`, 'POST', upload.body, `multipart/form-data; boundary=${upload.boundary}`);
  assert.equal(allowedUpload.status, 201, `upload failed: ${allowedUpload.body}`);
  const reference = allowedUpload.json.reference as Record<string, unknown>;
  assert.equal(reference.originalFilename, 'brief.md');
  assert.equal(reference.status, 'indexed');
  assert.equal('storagePath' in reference, false, 'upload response must not expose storage roots');
  const refId = String(reference.id);

  const mismatch = multipartBody('file', 'fake.pdf', 'text/plain', 'not really a pdf');
  const mismatchResponse = await call(`/api/projects/${project.id}/references`, 'POST', mismatch.body, `multipart/form-data; boundary=${mismatch.boundary}`);
  assert.equal(mismatchResponse.status, 400);
  assert.equal(mismatchResponse.json.code, 'PROJECT_REFERENCE_REJECTED');

  const strangerList = await call(`/api/projects/${project.id}/references?profile=stranger`);
  assert.equal(strangerList.status, 404);
  const readerList = await call(`/api/projects/${project.id}/references?profile=reader`);
  assert.equal(readerList.status, 200);
  assert.equal((readerList.json.references as unknown[]).length, 1);

  const search = await call(`/api/projects/${project.id}/references/search?q=gamma&profile=reader`);
  assert.equal(search.status, 200);
  const results = search.json.results as Array<Record<string, unknown>>;
  assert.equal(results.length, 1);
  assert.deepEqual((results[0].citation as Record<string, unknown>).originalFilename, 'brief.md');

  const detail = await call(`/api/projects/${project.id}/references/${refId}?profile=reader`);
  assert.equal(detail.status, 200);
  assert.equal(((detail.json.chunks as unknown[]) ?? []).length, 1);
  assert.equal('storagePath' in (detail.json.reference as Record<string, unknown>), false);

  const download = await call(`/api/projects/${project.id}/references/${refId}/download?profile=reader`);
  assert.equal(download.status, 200);
  assert.match(download.body, /Need gamma citations/);
  assert.match(String(download.headers['content-disposition']), /brief\.md/);

  const forbiddenDelete = await call(`/api/projects/${project.id}/references/${refId}?profile=reader`, 'DELETE');
  assert.equal(forbiddenDelete.status, 404);
  const reindex = await call(`/api/projects/${project.id}/references/${refId}/reindex?profile=default`, 'POST');
  assert.equal(reindex.status, 200);
  const deleted = await call(`/api/projects/${project.id}/references/${refId}?profile=default`, 'DELETE');
  assert.equal(deleted.status, 204);
  assert.equal((await call(`/api/projects/${project.id}/references/search?q=gamma&profile=default`)).json.results instanceof Array, true);
  assert.equal(((await call(`/api/projects/${project.id}/references/search?q=gamma&profile=default`)).json.results as unknown[]).length, 0);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  await rm(root, { recursive: true, force: true });
}

console.log('Project reference route ACL, upload, citation, download, and lifecycle tests passed');

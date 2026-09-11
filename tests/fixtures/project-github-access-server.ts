// Disposable full-page QA: real Project access routes, fake GitHub and Hermes.
// Run: node --import tsx tests/fixtures/project-github-access-server.ts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { createServer } from 'vite';
import type { StudioGitHubRepository } from '../../shared/types.js';
import type { StudioGitHubGateway } from '../../server/routes/studio.js';

for (const port of [4185, 4186]) {
  const probe = createNetServer().listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
}

const root = await mkdtemp(join(tmpdir(), 'project-github-access-ui-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'db.sqlite');
process.env.OLYMPUS_DISPATCH_PROJECT_ROOT = join(root, 'projects');
for (const [id, displayName] of [['default', 'Project manager'], ['viewer', 'View-only collaborator']]) {
  const home = id === 'default' ? process.env.HERMES_HOME : join(process.env.HERMES_HOME, 'profiles', id);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.yaml'), '{}\n');
  await writeFile(join(home, 'profile.yaml'), `display_name: ${displayName}\nactive: true\n`);
}
await mkdir(process.env.OLYMPUS_DISPATCH_PROJECT_ROOT, { recursive: true });

const { default: api, adapter } = await import('../../server/app.js');
const { default: db } = await import('../../server/db/index.js');
const { createProjectWithRepository, grantProjectProfileAccess, getProjectRepositoryLink } = await import('../../server/db/projects.js');
const { upsertGitHubInstallation, updateGitHubInstallationLabel, listGitHubInstallations } = await import('../../server/db/studio-projects.js');
const { getProjectGitHubInstallationIds } = await import('../../server/db/project-github-access.js');
const { createProjectGitHubAccessRouter } = await import('../../server/routes/project-github-access.js');

const repositories: Record<number, StudioGitHubRepository[]> = {
  11: [{ id: 101, name: 'migration-target', fullName: 'digitalchili/migration-target', owner: 'digitalchili', private: true, defaultBranch: 'main', htmlUrl: 'https://github.com/digitalchili/migration-target', cloneUrl: 'https://github.com/digitalchili/migration-target.git' }],
  22: [{ id: 202, name: 'source-library', fullName: 'leakim69/source-library', owner: 'leakim69', private: true, defaultBranch: 'main', htmlUrl: 'https://github.com/leakim69/source-library', cloneUrl: 'https://github.com/leakim69/source-library.git' }],
};
upsertGitHubInstallation({ id: 11, accountLogin: 'digitalchili', accountType: 'Organization', permissionMode: 'read_write' });
upsertGitHubInstallation({ id: 22, accountLogin: 'leakim69', accountType: 'User', permissionMode: 'upgrade_required' });
updateGitHubInstallationLabel(11, 'Digital Chili');
updateGitHubInstallationLabel(22, 'Michael’s source repositories');
const project = createProjectWithRepository({ name: 'GitHub access QA', purpose: 'Read source repositories while publishing to the main repository.', managerProfileId: 'default', changedBy: 'fixture' }, { installationId: 11, repository: repositories[11][0] });
grantProjectProfileAccess({ projectId: project.id, profileId: 'viewer', role: 'view', grantedBy: 'fixture' });

adapter.getDefaults = async () => ({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'low', showReasoning: true, baseUrl: null, apiMode: null });
adapter.getModels = async () => ({ defaultModel: 'fixture-model', activeProvider: 'fixture', groups: [] }) as never;
adapter.healthCheck = async () => true;
adapter.getBackgroundWork = async () => ({ available: true, work: [] });
adapter.getGoalStatus = async () => null;
adapter.getMessages = async () => [];
adapter.getMessagePage = async () => ({ messages: [], pageInfo: { hasOlder: false, olderCursor: null } });
adapter.chatStream = async function* () { throw new Error('Task execution is disabled in this UI fixture.'); };

let rejectChecks = false;
let delayMs = 0;
const checks: number[] = [];
const gateway = {
  configured: true,
  async listRepositories(id: number, options?: { readOnly?: boolean }) {
    assert.equal(options?.readOnly, true);
    checks.push(id);
    if (delayMs) await new Promise(done => setTimeout(done, delayMs));
    if (rejectChecks) throw new Error('Fixture GitHub connection failure');
    return repositories[id] ?? [];
  },
} as StudioGitHubGateway;

const app = express();
app.use(express.json());
app.get('/api/fixture/state', (_req, res) => res.json({ projectId: project.id, installationIds: getProjectGitHubInstallationIds(project.id), repositoryLink: getProjectRepositoryLink(project.id), checks, rejectChecks, delayMs }));
app.post('/api/fixture/github', (req, res) => {
  rejectChecks = req.body.rejectChecks === true;
  delayMs = typeof req.body.delayMs === 'number' ? Math.max(0, Math.min(3000, req.body.delayMs)) : 0;
  res.json({ rejectChecks, delayMs });
});
app.get('/api/studio/github/status', (_req, res) => res.json({ configured: true, installations: listGitHubInstallations() }));
app.get('/api/studio/github/repositories', (req, res) => res.json({ repositories: repositories[Number(req.query.installationId)] ?? [] }));
app.get('/api/profiles/attention', (_req, res) => res.json({ profiles: [] }));
app.get('/api/scheduled-tasks', (_req, res) => res.json({ scheduledTasks: [] }));
app.get('/api/projects/:id/sync', (_req, res) => res.json({ lastSync: null, blocker: null }));
app.use('/api/projects', createProjectGitHubAccessRouter(gateway));
// The access router is the only mutable production API enabled in this fixture.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  res.status(403).json({ error: 'Only GitHub source access changes are enabled in this fixture.' });
});
app.use(api);
const vite = await createServer({ root: resolve('client'), configFile: resolve('client/vite.config.ts'), cacheDir: join(root, 'vite-cache'), server: { middlewareMode: true, hmr: { host: '127.0.0.1', port: 4186 } }, appType: 'spa' });
app.use(vite.middlewares);
const server = app.listen(4185, '127.0.0.1');
await once(server, 'listening');
console.log(`Project GitHub access UI: http://127.0.0.1:4185/projects/${project.id}?tab=settings&profile=default`);

let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  await vite.close();
  await adapter.stop();
  db.close();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGTERM', () => void cleanup());
process.once('SIGINT', () => void cleanup());

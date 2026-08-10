import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile('server/app.ts', 'utf8');
const clientApp = await readFile('client/src/App.tsx', 'utf8');
const sidebar = await readFile('client/src/components/Sidebar.tsx', 'utf8');
const api = await readFile('client/src/lib/api.ts', 'utf8');
const page = await readFile('client/src/components/StudioProjectsPage.tsx', 'utf8');

assert.match(app, /app\.use\('\/api\/studio', createStudioRouter\(\{ github: createGitHubAppGateway\(\) \}\)\)/);
assert.match(clientApp, /path="\/studio" element=\{<StudioProjectsPage \/>\}/);
assert.match(sidebar, /label="Projects"[\s\S]*to="\/studio"/);
assert.match(api, /export function connectStudioGitHub\(\)/);
assert.match(api, /export function fetchStudioRepositories\(installationId: number\)/);
assert.match(api, /export function importStudioProject\(installationId: number, repositoryId: number\)/);
assert.match(page, /Connect GitHub/);
assert.match(page, /Approve repository/);
assert.match(page, /Read-only/);
assert.doesNotMatch(page, /Deploy production|Merge to main|Push to main/);

console.log('Studio Projects route and read-only onboarding UI tests passed');

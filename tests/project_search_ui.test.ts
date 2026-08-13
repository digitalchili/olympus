import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dialog = await readFile('client/src/components/TaskSearchDialog.tsx', 'utf8');
const api = await readFile('client/src/lib/api.ts', 'utf8');
const route = await readFile('server/routes/search.ts', 'utf8');

assert.match(dialog, /aria-label="Search scope"/);
assert.match(dialog, /<option value="">Current profile<\/option>/);
assert.match(dialog, /fetchProjects\(\)/);
assert.match(dialog, /searchTasks\(query, projectId \|\| undefined\)/);
assert.match(dialog, /projectTaskPath\(\{ id: result\.taskId, project_id: result\.projectId \}, resultProject\)/);
assert.match(api, /projectId: string \| null/);
assert.match(route, /projectId: task\.project_id/);
assert.match(api, /if \(projectId\) params\.set\('projectId', projectId\)/);
assert.match(route, /requireProfileProjectAccess\(projectId, profile\.id, 'view'\)/);
assert.match(route, /tasksByHandler/);
assert.match(route, /handler\.hermesHome/);

console.log('Project-aware search UI and routing contract tests passed');

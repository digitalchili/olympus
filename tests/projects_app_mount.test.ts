import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../server/app.ts', import.meta.url), 'utf8');
assert.match(appSource, /import \{ createProjectsRouter \} from '\.\/routes\/projects\.js';/);
assert.match(appSource, /const studioGitHubGateway = createGitHubAppGateway\(\{ credentialStore: createGitHubCredentialStore\(\) \}\);/);
assert.match(appSource, /const projectCp = createProjectCpService\(/);
assert.match(appSource, /app\.use\('\/api\/projects', createProjectsRouter\(\{ github: studioGitHubGateway, projectCp \}\)\);/);
const prepareMount = appSource.indexOf("app.use('/api/tasks', createProjectTaskWorkspaceRouter({ projectCp, github: studioGitHubGateway }));");
const chatMount = appSource.indexOf("app.use('/api/tasks', chatRouter);");
assert.ok(prepareMount >= 0, 'Project repository preparation middleware is mounted');
assert.ok(chatMount > prepareMount, 'Project repository preparation runs before chat execution');

const profilesRoute = await readFile(new URL('../server/routes/profiles.ts', import.meta.url), 'utf8');
assert.match(profilesRoute, /countProjectsManagedByProfile/);
assert.match(profilesRoute, /PROFILE_MANAGES_PROJECTS/);

console.log('Global Projects application mount and manager deletion guard tests passed');

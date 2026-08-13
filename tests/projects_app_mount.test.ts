import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../server/app.ts', import.meta.url), 'utf8');
assert.match(appSource, /import \{ createProjectsRouter \} from '\.\/routes\/projects\.js';/);
assert.match(appSource, /const studioGitHubGateway = createGitHubAppGateway\(\{ credentialStore: createGitHubCredentialStore\(\) \}\);/);
assert.match(appSource, /app\.use\('\/api\/projects', createProjectsRouter\(\{ github: studioGitHubGateway \}\)\);/);

const profilesRoute = await readFile(new URL('../server/routes/profiles.ts', import.meta.url), 'utf8');
assert.match(profilesRoute, /countProjectsManagedByProfile/);
assert.match(profilesRoute, /PROFILE_MANAGES_PROJECTS/);

console.log('Global Projects application mount and manager deletion guard tests passed');

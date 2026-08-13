import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const chatRoute = await readFile('server/routes/chat.ts', 'utf8');
const chatUi = await readFile('client/src/components/TaskChat.tsx', 'utf8');
const useChat = await readFile('client/src/hooks/useChat.ts', 'utf8');

assert.match(chatRoute, /confirmPersistentCollaboration === true/);
assert.match(chatRoute, /requireProfileProjectAccess\(task\.project_id, requestProfile\(req\)\.id, 'manage'\)/);
assert.match(chatRoute, /listPersistentCollaborationGrants/);
assert.match(chatRoute, /grantPersistentCollaboration/);
assert.match(chatRoute, /revokePersistentCollaborationGrant/);
assert.ok(
  chatRoute.indexOf('collaborationInvites = validateCollaborationInvites')
    < chatRoute.lastIndexOf('grantPersistentCollaboration({'),
  'persistent grants must be written only after effective participant validation',
);
assert.match(useChat, /confirmPersistentCollaboration/);
assert.match(chatUi, /aria-label="Collaboration invitation scope"/);
assert.match(chatUi, /Confirm persistent/);
assert.match(chatUi, /Persistent collaborators/);
assert.match(chatUi, /handleRevokePersistentGrant/);
assert.match(chatUi, /projectId && <option value="project">/);

console.log('Persistent collaboration API ordering and UI contract tests passed');

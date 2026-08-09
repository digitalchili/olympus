import assert from 'node:assert/strict';
import { beginProfileDeletion } from '../server/profile-deletion.js';
import { createProfilesRouter } from '../server/routes/profiles.js';

const router = createProfilesRouter({
  async chatForProfile() {
    throw new Error('not used');
  },
});
const settingsRoute = router.stack.find((layer) => layer.route?.path === '/:id/settings')?.route;
assert.ok(settingsRoute, 'GET /:id/settings must be registered');
assert.equal(settingsRoute.stack.length, 2, 'profile settings reads must use the target profile gate');

const deletion = beginProfileDeletion('profile-being-deleted');
try {
  const result = { status: 200, body: undefined as unknown, next: false };
  const response = {
    once() { return this; },
    status(status: number) { result.status = status; return this; },
    json(body: unknown) { result.body = body; return this; },
  };
  settingsRoute.stack[0].handle(
    { params: { id: 'profile-being-deleted' } },
    response,
    () => { result.next = true; },
  );

  assert.equal(result.next, false, 'a deleting target profile must not reach the settings reader');
  assert.equal(result.status, 409);
  assert.equal((result.body as { code?: string }).code, 'PROFILE_DELETING');
} finally {
  deletion.release();
}

console.log('Profile settings target gate test passed');
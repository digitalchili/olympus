import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const testRoot = join(process.cwd(), `.test-profile-attention-${process.pid}`);
process.env.OLYMPUS_DISPATCH_HOME = testRoot;
process.env.DB_PATH = join(testRoot, 'data', 'olympus-dispatch.db');

const { getProfileTaskAttention, insertTask, markTaskViewed } = await import('../server/db/queries.js');

try {
  const unseen = insertTask({
    title: 'Waiting for review',
    status: 'in_review',
    handling_profile_id: 'writer',
    profile_name: 'writer',
    last_agent_response_at: 200,
  });
  insertTask({
    title: 'Already complete',
    status: 'done',
    handling_profile_id: 'writer',
    profile_name: 'writer',
    last_agent_response_at: 300,
  });
  insertTask({
    title: 'Another profile',
    status: 'in_review',
    handling_profile_id: 'reviewer',
    profile_name: 'reviewer',
    last_agent_response_at: 400,
  });

  assert.deepEqual(getProfileTaskAttention(), [
    { profileId: 'reviewer', reviewCount: 1 },
    { profileId: 'writer', reviewCount: 1 },
  ]);

  markTaskViewed(unseen.id);
  assert.deepEqual(getProfileTaskAttention(), [
    { profileId: 'reviewer', reviewCount: 1 },
  ]);
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

console.log('Profile attention query tests passed');
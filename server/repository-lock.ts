import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { repositoryOwnerForTask } from './db/repository-queue.js';
import { resolveOlympusDataDir } from './paths.js';

export function repositoryLockPath(taskId: string | undefined): string | undefined {
  const owner = taskId ? repositoryOwnerForTask(taskId) : undefined;
  return owner ? join(resolveOlympusDataDir(), 'repository-locks', createHash('sha256').update(owner.key).digest('hex') + '.lock') : undefined;
}

import type { Task } from '../../shared/types.js';
import { assertProfileAcceptingWork } from '../profile-deletion.js';
import db from './index.js';
import { insertTask } from './queries.js';

export function getBotTask(profileId: string): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE kind = 'bot' AND handling_profile_id = ?").get(profileId) as Task | undefined;
}

export function ensureBotTask(profile: { id: string; label: string; workspaceDir: string; isDefault?: boolean }): Task {
  return db.transaction(() => {
    assertProfileAcceptingWork(profile.id);
    return getBotTask(profile.id) ?? insertTask({
      kind: 'bot', profile_name: profile.id, handling_profile_id: profile.id,
      workdir: profile.workspaceDir, title: profile.label, status: 'in_progress',
    });
  }).immediate();
}

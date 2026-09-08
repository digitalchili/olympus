import type { ProjectChatBlocker } from '../lib/chatSendRecovery';
import { Link } from 'react-router';
import { toWithProfile } from '../lib/profileQuery';

export function ProjectChatBlockedNotice({ projectId, profileId, blocker }: { projectId: string; profileId: string; blocker: ProjectChatBlocker | null }) {
  if (!blocker) return null;
  const projectPath = `/projects/${encodeURIComponent(projectId)}`;
  return <div role="alert" className="mx-auto mb-2 max-w-[760px] rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
    <p>{blocker.error}</p>
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
      {blocker.activeTaskId && <Link className="font-medium underline" to={toWithProfile(`${projectPath}/tasks/${encodeURIComponent(blocker.activeTaskId)}`, blocker.activeTaskProfileId || profileId)} target="_blank" rel="noopener noreferrer">Open previous task</Link>}
      <Link className="font-medium underline" to={toWithProfile(projectPath, profileId)} target="_blank" rel="noopener noreferrer">Manage Project</Link>
    </div>
  </div>;
}

import { randomUUID } from 'node:crypto';
import type { ProjectRepositoryLink, QueuedTaskMessage, Task } from '../shared/types.js';
import { sourceIdentity, hasPassingCodingEvidence } from './coding-verification.js';
import { hasUnansweredInteractions } from './db/interactions.js';
import { getLatestTaskAgentRun } from './db/task-agent-runs.js';
import { getTask, touchTask } from './db/queries.js';
import { getProjectRepositoryLink } from './db/projects.js';
import { getPendingProjectPublication, getProjectPublication } from './db/project-publications.js';
import { getProjectEditorForTask } from './db/project-cp.js';
import { getQueuedTaskMessage, pauseQueuedPublication, restoreQueuedTaskMessage, replaceFailedQueuedPublication } from './db/task-message-queue.js';
import { getRunStatus } from './live-chat.js';
import { broadcastRecovery } from './run-recovery.js';
import { assertQueuedMessageDeliveryResponse, scheduleQueuedMessageDispatch } from './queued-message-dispatcher.js';
import { broadcast } from './events.js';

export function notifyQueuedPublication(taskId: string): void {
  touchTask(taskId);
  const task = getTask(taskId);
  if (task) broadcast({ type: 'task_updated', task });
  broadcastRecovery(taskId);
}

export function publicationQueueError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409, code: 'PUBLICATION_QUEUE_BLOCKED' });
}

/** The server dispatcher owns this feedback, including failures before route access. */
export async function handleQueuedPublicationResponse(queued: QueuedTaskMessage, response: Response): Promise<void> {
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => ({})) as { code?: string };
    if (!['PROJECT_OPERATION_ACTIVE', 'MAINTENANCE_DRAIN'].includes(payload.code ?? '')) {
      // Preserve a more specific route-owned explanation; never persist upstream errors.
      if (!getQueuedTaskMessage(queued.taskId)?.publication?.error) {
        pauseQueuedPublication(queued.taskId, queued.id, 'Publication needs attention. Open Commit & Push to check the task and GitHub access.');
        notifyQueuedPublication(queued.taskId);
      }
    }
  }
  await assertQueuedMessageDeliveryResponse(response);
}

function repositoryIdentity(link: ProjectRepositoryLink | null | undefined): string {
  if (!link) return '';
  return JSON.stringify([link.projectId, link.installationId, link.providerRepositoryId, link.fullName, link.cloneUrl, link.defaultBranch]);
}

/** Save intent only. The active task retains exclusive ownership of its checkout. */
export async function queueProjectPublication(task: Task, link: ProjectRepositoryLink, message: string, deployToDefaultBranch: boolean, publicationId?: string): Promise<QueuedTaskMessage> {
  const run = getLatestTaskAgentRun(task.id);
  const editor = getProjectEditorForTask(link.projectId, task.id);
  if (!run || !task.workdir || !editor || editor.workdir !== task.workdir) throw publicationQueueError('Open Commit & Push after this task finishes.');
  const receipt = publicationId ? getProjectPublication(publicationId) : null;
  if (publicationId) {
    if (!receipt || receipt.id !== getPendingProjectPublication(link.projectId, task.id)?.id || receipt.leaseId !== editor.id
      || receipt.repository.installationId !== link.installationId || receipt.repository.providerRepositoryId !== link.providerRepositoryId
      || receipt.repository.cloneUrl !== link.cloneUrl || receipt.repository.defaultBranch !== link.defaultBranch) {
      throw publicationQueueError('The saved publication changed. Review it in Commit & Push.');
    }
    message = receipt.commitMessage;
    deployToDefaultBranch = receipt.targetBranch === link.defaultBranch;
  } else if (getPendingProjectPublication(link.projectId, task.id)) throw publicationQueueError('Review the saved publication in Commit & Push first.');
  if (!message.trim() || message.trim().length > 200 || /\p{Cc}/u.test(message)) throw publicationQueueError('Enter a commit message of 1–200 characters.');
  const identity = repositoryIdentity(link);
  const existing = getQueuedTaskMessage(task.id);
  if (existing) {
    const action = existing.publication;
    if (action && action.runId === run.runId && action.editorId === editor.id && action.branchName === editor.branchName
      && action.repositoryIdentity === identity && action.message === message.trim()
      && action.deployToDefaultBranch === deployToDefaultBranch && action.publicationId === publicationId && !action.error) return existing;
    if (!receipt || !action?.error || action.editorId !== editor.id || action.repositoryIdentity !== identity
      || (action.publicationId && action.publicationId !== publicationId)) {
      throw publicationQueueError('A follow-up is already queued. Keep it or remove it before scheduling publication.');
    }
  }
  // A resume approves the saved receipt, never the active turn's working tree.
  const source = receipt ? null : await sourceIdentity(task.workdir);
  if (getLatestTaskAgentRun(task.id)?.runId !== run.runId || getTask(task.id)?.workdir !== task.workdir
    || repositoryIdentity(getProjectRepositoryLink(link.projectId)!) !== identity) {
    throw publicationQueueError('The task changed. Review it before scheduling publication.');
  }
  const now = Date.now();
  const queued: QueuedTaskMessage = {
    id: randomUUID(), taskId: task.id,
    content: `${receipt ? 'Resume publication' : 'Commit & Push'} to ${receipt?.targetBranch ?? (deployToDefaultBranch ? link.defaultBranch : editor.branchName)}`,
    settings: {}, invitedProfileIds: [], collaborationScope: 'discussion', confirmPersistentCollaboration: false,
    createdAt: now, updatedAt: now,
    publication: { projectId: link.projectId, runId: run.runId, repositoryIdentity: identity, editorId: editor.id, branchName: editor.branchName, workdir: task.workdir,
      fingerprint: source?.fingerprint ?? '', message: message.trim(), deployToDefaultBranch, ...(publicationId ? { publicationId } : {}) },
  };
  if (!(existing ? replaceFailedQueuedPublication(existing.id, queued) : restoreQueuedTaskMessage(queued))) throw publicationQueueError('A follow-up is already queued. Keep it or remove it before scheduling publication.');
  notifyQueuedPublication(task.id);
  scheduleQueuedMessageDispatch(task.id); // Handles a turn settling while the source was read.
  return queued;
}

/** Called under the normal mutation lock, after the native background-work check. */
export async function validateQueuedPublication(task: Task, link: ProjectRepositoryLink, queued: QueuedTaskMessage): Promise<void> {
  const action = queued.publication!;
  const run = getLatestTaskAgentRun(task.id);
  const live = getRunStatus(task.id);
  const editor = getProjectEditorForTask(link.projectId, task.id);
  if (action.error) throw publicationQueueError(action.error);
  if (action.started) throw publicationQueueError('Publication was interrupted. Open Commit & Push to review or resume it.');
  if (action.projectId !== task.project_id || action.repositoryIdentity !== repositoryIdentity(link) || action.workdir !== task.workdir
    || editor?.id !== action.editorId || editor.branchName !== action.branchName) {
    throw publicationQueueError('The repository changed. Review the destination in Commit & Push.');
  }
  if (run?.runId !== action.runId || run.status !== 'done' || (live && live.runId !== action.runId)
    || hasUnansweredInteractions(task.id, action.runId)) {
    throw publicationQueueError('The task did not finish successfully. Review it before publishing.');
  }
  if (action.publicationId) {
    if (getPendingProjectPublication(link.projectId, task.id)?.id !== action.publicationId) throw publicationQueueError('The saved publication changed. Review it in Commit & Push.');
    return; // retryPublication revalidates the immutable receipt and preserves later edits.
  }
  const source = await sourceIdentity(action.workdir);
  if (source.fingerprint !== action.fingerprint) throw publicationQueueError('Files changed after publication was requested. Review them in Commit & Push.');
  if (!hasPassingCodingEvidence(task, source.fingerprint)) throw publicationQueueError('Checks need attention. Run checks, then publish from Commit & Push.');
}

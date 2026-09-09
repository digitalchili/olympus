import { CHAT_RUN_MODES, type QueuedTaskMessage } from '../shared/types.js';
import { parseRunSettingsBody } from './agent-settings.js';
import { validateCollaborationInvites } from './collaboration.js';
import { isRecord } from './errors.js';

export function parseTaskStart(value: unknown, ownerProfileId: string): Pick<QueuedTaskMessage, 'content' | 'settings' | 'invitedProfileIds'> | null {
  if (value === undefined) return null;
  if (!isRecord(value) || typeof value.content !== 'string' || !value.content.trim()) throw new Error('Initial message content is required');
  const { taskFields } = parseRunSettingsBody({ settings: value.settings ?? {} });
  const mode = isRecord(value.settings) ? value.settings.mode ?? 'task' : 'task';
  if (!CHAT_RUN_MODES.includes(mode as 'task' | 'goal')) throw new Error('Initial message mode must be task or goal');
  const invites = validateCollaborationInvites(value.invitedProfileIds, ownerProfileId);
  const invitedProfileIds = [...invites.participants.map(profile => profile.id), ...(invites.ownerInvited ? [ownerProfileId] : [])];
  if (mode === 'goal' && invitedProfileIds.length) throw new Error('Goal mode cannot invite collaborators');
  return { content: value.content.trim(), settings: {
    ...(taskFields.agent_model !== undefined ? { model: taskFields.agent_model } : {}),
    ...(taskFields.agent_provider !== undefined ? { provider: taskFields.agent_provider } : {}),
    ...(taskFields.reasoning_effort !== undefined ? { reasoningEffort: taskFields.reasoning_effort } : {}),
    mode: mode as 'task' | 'goal',
  }, invitedProfileIds };
}

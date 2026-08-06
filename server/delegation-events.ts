import type { DelegationRunStatus, DelegationWorkerEvent } from '../shared/types.js';

const STATUSES = new Set<DelegationRunStatus>([
  'queued', 'running', 'waiting', 'stalled', 'completed', 'failed', 'cancelled', 'timed_out', 'unknown',
]);

function safeId(value: unknown, max = 160): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || !/^[A-Za-z0-9_.:@/-]+$/.test(trimmed)) return null;
  return trimmed;
}

function safeOptionalId(value: unknown, max = 160): string | null {
  return value == null ? null : safeId(value, max);
}

function safeCount(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), max);
}

function safeNullableNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, max);
}

/** Fail-closed worker trust boundary. Never copy arbitrary callback fields. */
export function normalizeDelegationEvent(value: unknown): DelegationWorkerEvent | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.schema !== 'olympus.delegation.event.v1') return null;
  const delegationId = safeId(input.delegationId);
  const childId = safeId(input.childId);
  const parentSessionId = safeId(input.parentSessionId);
  const status = input.status as DelegationRunStatus;
  if (!delegationId || !childId || !parentSessionId || !STATUSES.has(status)) return null;

  return {
    schema: 'olympus.delegation.event.v1',
    delegationId,
    childId,
    parentSessionId,
    childSessionId: safeOptionalId(input.childSessionId),
    parentChildId: safeOptionalId(input.parentChildId),
    childIndex: safeCount(input.childIndex, 99),
    childCount: Math.max(1, safeCount(input.childCount, 100)),
    status,
    currentAction: safeOptionalId(input.currentAction, 64),
    model: safeOptionalId(input.model, 120),
    toolCount: safeCount(input.toolCount),
    apiCalls: safeCount(input.apiCalls),
    durationSeconds: safeNullableNumber(input.durationSeconds, 31_536_000),
    inputTokens: safeCount(input.inputTokens),
    outputTokens: safeCount(input.outputTokens),
    reasoningTokens: safeCount(input.reasoningTokens),
    costUsd: safeNullableNumber(input.costUsd, 1_000_000),
    filesTouched: safeCount(input.filesTouched, 10_000),
  };
}

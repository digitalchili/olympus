import type { DelegationRun } from '@shared/types';

const ACTIVE = new Set(['queued', 'running', 'waiting']);

export function applyDelegationRunUpdate(current: DelegationRun[], incoming: DelegationRun): DelegationRun[] {
  const index = current.findIndex((run) => run.id === incoming.id);
  if (index < 0) return [...current, incoming];
  const existing = current[index];
  if (incoming.updated_at <= existing.updated_at) return current;
  const next = [...current];
  next[index] = incoming;
  return next;
}

export function summarizeDelegationActivity(runs: DelegationRun[]) {
  const activeCount = runs.filter((run) => ACTIVE.has(run.status)).length;
  const totalCount = runs.length;
  return {
    activeCount,
    totalCount,
    title: activeCount > 0
      ? `${activeCount} delegated worker${activeCount === 1 ? '' : 's'} active`
      : `${totalCount} delegated worker${totalCount === 1 ? '' : 's'}`,
  };
}

export function isActiveDelegation(run: DelegationRun): boolean {
  return ACTIVE.has(run.status);
}

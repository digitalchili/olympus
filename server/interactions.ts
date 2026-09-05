import type { NativeInteraction } from '../shared/interactions.js';

const MAX_EXPIRY_MS = 30 * 60_000;
const MAX_TEXT = 50_000;
const MAX_TITLE = 2_000;
const SAFE_ID = /^[A-Za-z0-9_.:@/-]{1,160}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.startsWith('__') && value !== 'prototype' && value !== 'constructor';
}

function boundedString(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

export function normalizeNativeInteraction(raw: unknown, eventId: string, now = Date.now()): NativeInteraction | null {
  if (!isRecord(raw)) return null;
  const allowed = ['id', 'workerRunId', 'kind', 'title', 'questions', 'command', 'reason', 'expiresAt'];
  if (Object.keys(raw).some((key) => !allowed.includes(key) || key.startsWith('__') || key === 'prototype' || key === 'constructor')) return null;
  if (!safeId(raw.id) || !safeId(raw.workerRunId) || raw.workerRunId !== eventId) return null;
  if (raw.kind !== 'clarification' && raw.kind !== 'approval') return null;
  if (!boundedString(raw.title, MAX_TITLE)) return null;
  if (!Array.isArray(raw.questions)) return null;
  if (raw.kind === 'clarification' && (raw.questions.length < 1 || raw.questions.length > 5)) return null;
  if (raw.kind === 'approval' && raw.questions.length !== 0) return null;
  if (raw.command !== undefined && !boundedString(raw.command, MAX_TEXT)) return null;
  if (raw.reason !== undefined && !boundedString(raw.reason, MAX_TEXT)) return null;
  if (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt)) return null;
  if (raw.expiresAt <= now || raw.expiresAt > now + MAX_EXPIRY_MS) return null;

  const seen = new Set<string>();
  const questions = [];
  for (const question of raw.questions) {
    if (!isRecord(question) || !exactKeys(question, ['id', 'question', 'choices', 'multiSelect'])) return null;
    if (!safeId(question.id) || seen.has(question.id)) return null;
    if (!boundedString(question.question, MAX_TEXT)) return null;
    if (!Array.isArray(question.choices) || question.choices.length > 5) return null;
    const choices: string[] = [];
    for (const choice of question.choices) {
      if (!boundedString(choice, 2_000)) return null;
      choices.push(choice);
    }
    if (new Set(choices).size !== choices.length) return null;
    if (typeof question.multiSelect !== 'boolean') return null;
    seen.add(question.id);
    questions.push({ id: question.id, question: question.question, choices, multiSelect: question.multiSelect });
  }

  return {
    id: raw.id,
    workerRunId: raw.workerRunId,
    kind: raw.kind,
    title: raw.title,
    questions,
    ...(raw.command !== undefined ? { command: raw.command } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    expiresAt: raw.expiresAt,
  };
}

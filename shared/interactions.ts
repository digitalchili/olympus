export const INTERACTION_KINDS = ['clarification', 'approval'] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const INTERACTION_STATUSES = [
  'waiting',
  'claimed',
  'answered',
  'denied',
  'expired',
  'cancelled',
  'delivery_unknown',
] as const;
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

export interface InteractionQuestion {
  id: string;
  question: string;
  choices: string[];
  multiSelect: boolean;
  freeOther?: boolean;
}

export interface NativeInteraction {
  id: string;
  workerRunId: string;
  kind: InteractionKind;
  title: string;
  questions: InteractionQuestion[];
  command?: string;
  reason?: string;
  expiresAt: number;
}

export type InteractionResponse =
  | { answers: Record<string, string | string[]> }
  | { decision: 'once' | 'deny' };

export interface TaskInteraction extends NativeInteraction {
  taskId: string;
  profileName: string;
  olympusRunId: string;
  status: InteractionStatus;
  requestedAt: number;
  settledAt: number | null;
  response: InteractionResponse | null;
  deliveryError?: string | null;
}

export type InteractionValidationResult =
  | { ok: true; response: InteractionResponse; settleStatus: 'answered' | 'denied' }
  | { ok: false; error: string };

const MAX_TEXT_LENGTH = 10_000;
const MAX_ID_LENGTH = 160;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_ID_LENGTH && !key.startsWith('__') && key !== 'prototype' && key !== 'constructor';
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

export function validateInteractionResponse(
  interaction: Pick<NativeInteraction, 'kind' | 'questions'>,
  raw: unknown,
): InteractionValidationResult {
  if (!isPlainRecord(raw)) return { ok: false, error: 'response must be an object' };

  if (interaction.kind === 'approval') {
    if (!hasExactKeys(raw, ['decision']) || (raw.decision !== 'once' && raw.decision !== 'deny')) {
      return { ok: false, error: 'approval response must be exactly once or deny' };
    }
    return { ok: true, response: { decision: raw.decision }, settleStatus: raw.decision === 'once' ? 'answered' : 'denied' };
  }

  if (!hasExactKeys(raw, ['answers']) || !isPlainRecord(raw.answers)) {
    return { ok: false, error: 'clarification response must contain only answers' };
  }

  const questions = interaction.questions;
  const expectedIds = questions.map((question) => question.id);
  const answerIds = Object.keys(raw.answers);
  if (answerIds.some((id) => !safeKey(id)) || answerIds.length !== expectedIds.length || !expectedIds.every((id) => answerIds.includes(id))) {
    return { ok: false, error: 'every question must be answered exactly once' };
  }

  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const value = raw.answers[question.id];
    if (question.multiSelect) {
      if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
        return { ok: false, error: 'multi-select answers must contain one to five values' };
      }
      const items: string[] = [];
      for (const item of value) {
        if (!boundedText(item)) return { ok: false, error: 'answers must be non-empty bounded text' };
        items.push(item);
      }
      if (new Set(items).size !== items.length) return { ok: false, error: 'multi-select answers must be unique' };
      answers[question.id] = items;
    } else {
      if (!boundedText(value)) return { ok: false, error: 'answers must be non-empty bounded text' };
      answers[question.id] = value;
    }
  }

  return { ok: true, response: { answers }, settleStatus: 'answered' };
}

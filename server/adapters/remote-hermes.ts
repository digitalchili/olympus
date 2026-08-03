import type {
  CompactResult,
  GoalDecision,
  GoalStateSnapshot,
  ScheduledTask,
  ScheduledTaskInput,
  SessionMetadata,
  TaskMessage,
} from '../../shared/types.js';
import type { AgentAdapter, AgentRunOptions, AgentRunSettings, StreamEvent } from './types.js';

export interface RemoteHermesTargetConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  remoteProfile: string;
  remotePath?: string | null;
  timeoutMs?: number;
}

export class RemoteHermesUnsupportedError extends Error {
  status = 501;
  code = 'REMOTE_HERMES_UNSUPPORTED';

  constructor(operation: string) {
    super(`${operation} is not supported by the remote Hermes gateway adapter.`);
    this.name = 'RemoteHermesUnsupportedError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_REMOTE_MODEL = 'hermes-agent';

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

function safeRemoteError(status: number): Error {
  return new Error(`Remote Hermes gateway request failed with HTTP ${status}`);
}

function toSafeCode(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(toText).filter((part) => part.length > 0).join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function toOptionalText(value: unknown): string | undefined {
  const text = toText(value);
  return text ? text : undefined;
}

function toEpochMs(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.trunc(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
}

function toInt(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function toFloatOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeMessageRecord(record: unknown, taskId: string, sessionId: string, index: number): TaskMessage | null {
  if (!record || typeof record !== 'object') return null;
  const row = record as Record<string, unknown>;
  if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'system') return null;

  const message: TaskMessage = {
    id: typeof row.id === 'string' && row.id ? row.id : `remote:${sessionId}:${index}`,
    task_id: taskId,
    role: row.role,
    content: toText(row.content),
    created_at: toEpochMs(row.timestamp),
  };
  const thinking = toOptionalText(row.reasoning_content) ?? toOptionalText(row.reasoning);
  if (thinking) message.thinking = thinking;
  return message;
}

function remoteStreamError(code?: string): StreamEvent {
  const event: StreamEvent = {
    type: 'error',
    error: 'Remote Hermes gateway stream failed',
  };
  if (code) event.code = code;
  return event;
}

function normalizeSseEvent(data: string, sessionId: string, eventName?: string): StreamEvent | null {
  if (!data.trim()) return null;
  if (data.trim() === '[DONE]') return { type: 'done', sessionId };

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;

  if (record.type === 'tool_progress' || eventName === 'hermes.tool.progress') {
    const status = record.status === 'completed' || record.status === 'error' ? record.status : 'running';
    const event: StreamEvent = {
      type: 'tool_progress',
      tool: typeof record.tool === 'string' ? record.tool : 'tool',
      status,
    };
    if (typeof record.duration === 'number') event.duration = record.duration;
    if (typeof record.label === 'string') event.label = record.label;
    return event;
  }

  if (record.type === 'status') {
    return {
      type: 'tool_progress',
      tool: 'remote-hermes',
      status: 'running',
      label: typeof record.message === 'string' ? record.message : 'Remote Hermes status',
    };
  }

  if (record.type === 'error') {
    return remoteStreamError(toSafeCode(record.code));
  }

  if (Array.isArray(record.choices)) {
    const choice = record.choices[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    const content = delta?.content;
    if (typeof content === 'string' && content) return { type: 'text_delta', content };
    if (choice?.finish_reason) {
      if (choice.finish_reason === 'stop') return { type: 'done', sessionId };
      return remoteStreamError(toSafeCode((record.error as Record<string, unknown> | undefined)?.code) ?? toSafeCode(record.code));
    }
  }

  return null;
}

async function* parseSseResponse(response: Response, sessionId: string): AsyncIterable<StreamEvent> {
  if (!response.body) throw new Error('Remote Hermes gateway returned an empty stream');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundaryMatch = /\r?\n\r?\n/.exec(buffer);
      while (boundaryMatch) {
        const block = buffer.slice(0, boundaryMatch.index);
        buffer = buffer.slice(boundaryMatch.index + boundaryMatch[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        const eventName = block
          .split(/\r?\n/)
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        const event = normalizeSseEvent(data, sessionId, eventName);
        if (event) {
          if (event.type === 'error') {
            sawDone = true;
            yield event;
            return;
          }
          if (event.type === 'done') {
            if (sawDone) {
              boundaryMatch = /\r?\n\r?\n/.exec(buffer);
              continue;
            }
            sawDone = true;
          }
          yield event;
        }
        boundaryMatch = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawDone) throw new Error('Remote Hermes gateway stream ended before completion');
}

export class RemoteHermesAdapter implements AgentAdapter {
  private timeoutMs: number;

  constructor(private target: RemoteHermesTargetConfig) {
    this.timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chat(sessionId: string, message: string, options?: AgentRunOptions): Promise<{ text: string; sessionId: string }> {
    let text = '';
    for await (const event of this.chatStream(sessionId, message, options)) {
      if (event.type === 'text_delta') text += event.content ?? '';
      if (event.type === 'error') throw new Error(event.error ?? 'Remote Hermes gateway error');
    }
    return { text, sessionId };
  }

  async *chatStream(sessionId: string, message: string, options?: AgentRunOptions): AsyncIterable<StreamEvent> {
    const timeout = withTimeout(this.timeoutMs);
    try {
      const response = await fetch(joinUrl(this.target.baseUrl, '/v1/chat/completions'), {
        method: 'POST',
        signal: timeout.signal,
        headers: {
          'Authorization': `Bearer ${this.target.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'X-Hermes-Session-Id': sessionId,
        },
        body: JSON.stringify({
          model: options?.settings?.model ?? DEFAULT_REMOTE_MODEL,
          messages: [
            ...(options?.systemMessage ? [{ role: 'system', content: options.systemMessage }] : []),
            { role: 'user', content: message },
          ],
          stream: true,
          model_options: options?.settings?.reasoningEffort ? {
            reasoning_effort: options.settings.reasoningEffort,
          } : undefined,
        }),
      });
      if (!response.ok) throw safeRemoteError(response.status);
      yield* parseSseResponse(response, sessionId);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Remote Hermes gateway timed out');
      }
      throw error;
    } finally {
      timeout.cancel();
    }
  }

  async healthCheck(): Promise<boolean> {
    const timeout = withTimeout(10_000);
    try {
      const response = await fetch(joinUrl(this.target.baseUrl, '/health'), {
        signal: timeout.signal,
        headers: { Authorization: `Bearer ${this.target.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      timeout.cancel();
    }
  }

  async interruptChat(): Promise<boolean> {
    throw new RemoteHermesUnsupportedError('Stopping remote chat');
  }

  async steerChat(): Promise<boolean> {
    // Hermes' HTTP gateway has no active-run steer endpoint. Returning false
    // keeps the follow-up queued so Olympus sends it as the next normal turn.
    return false;
  }

  async getMessages(sessionId: string, taskId: string): Promise<TaskMessage[]> {
    const response = await this.getRemoteJson(joinUrl(this.target.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/messages`));
    if (!response) return [];
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows
      .map((record, index) => normalizeMessageRecord(record, taskId, sessionId, index))
      .filter((message): message is TaskMessage => Boolean(message));
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const response = await this.getRemoteJson(joinUrl(this.target.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`));
    if (!response) return null;
    const rawSession = response.session;
    if (!rawSession || typeof rawSession !== 'object') return null;
    const session = rawSession as Record<string, unknown>;
    return {
      id: toStringOrNull(session.id) ?? sessionId,
      input_tokens: toInt(session.input_tokens),
      output_tokens: toInt(session.output_tokens),
      cache_read_tokens: toInt(session.cache_read_tokens),
      cache_write_tokens: toInt(session.cache_write_tokens),
      reasoning_tokens: toInt(session.reasoning_tokens),
      estimated_cost_usd: toFloatOrNull(session.estimated_cost_usd),
      cost_status: toStringOrNull(session.cost_status),
      model: toStringOrNull(session.model),
    };
  }

  private async getRemoteJson(url: string): Promise<Record<string, unknown> | null> {
    const timeout = withTimeout(this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: timeout.signal,
        headers: {
          Authorization: `Bearer ${this.target.apiKey}`,
          Accept: 'application/json',
        },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw safeRemoteError(response.status);
      const parsed = await response.json() as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Remote Hermes gateway timed out');
      }
      throw error;
    } finally {
      timeout.cancel();
    }
  }

  async generateTitle(): Promise<{ title: string }> {
    throw new RemoteHermesUnsupportedError('Remote title generation');
  }

  async compressSession(_sessionId: string, _options?: { focusTopic?: string | null; currentTokens?: number | null; systemMessage?: string; settings?: AgentRunSettings }): Promise<CompactResult> {
    throw new RemoteHermesUnsupportedError('Remote session compaction');
  }

  async getGoalStatus(): Promise<GoalStateSnapshot | null> {
    throw new RemoteHermesUnsupportedError('Remote goal status');
  }

  async setGoal(): Promise<GoalStateSnapshot> {
    throw new RemoteHermesUnsupportedError('Remote goal runs');
  }

  async pauseGoal(): Promise<GoalStateSnapshot | null> {
    throw new RemoteHermesUnsupportedError('Remote goal pause');
  }

  async resumeGoal(): Promise<GoalStateSnapshot | null> {
    throw new RemoteHermesUnsupportedError('Remote goal resume');
  }

  async clearGoal(): Promise<boolean> {
    throw new RemoteHermesUnsupportedError('Remote goal clear');
  }

  async evaluateGoal(): Promise<GoalDecision> {
    throw new RemoteHermesUnsupportedError('Remote goal evaluation');
  }

  async listScheduledTasks(): Promise<ScheduledTask[]> {
    throw new RemoteHermesUnsupportedError('Remote scheduled task listing');
  }

  async getScheduledTask(): Promise<ScheduledTask | null> {
    throw new RemoteHermesUnsupportedError('Remote scheduled task reads');
  }

  async createScheduledTask(_input: ScheduledTaskInput): Promise<ScheduledTask> {
    throw new RemoteHermesUnsupportedError('Remote scheduled task creation');
  }

  async updateScheduledTask(): Promise<ScheduledTask | null> {
    throw new RemoteHermesUnsupportedError('Remote scheduled task updates');
  }

  async pauseScheduledTask(): Promise<ScheduledTask | null> {
    throw new RemoteHermesUnsupportedError('Remote scheduled task pause');
  }

  async resumeScheduledTask(): Promise<ScheduledTask | null> {
    throw new RemoteHermesUnsupportedError('Remote scheduled task resume');
  }

  async runScheduledTask(): Promise<ScheduledTask | null> {
    throw new RemoteHermesUnsupportedError('Remote scheduled task runs');
  }

  async removeScheduledTask(): Promise<boolean> {
    throw new RemoteHermesUnsupportedError('Remote scheduled task deletion');
  }

  async tickScheduledTasks(): Promise<number> {
    throw new RemoteHermesUnsupportedError('Remote scheduled task ticking');
  }
}

import type {
  AgentRunSettings,
  AgentModelResolution,
  AdapterDelegationEvent,
  CompactResult,
  ContextUsage,
  GoalDecision,
  GoalStateSnapshot,
  ScheduledTask,
  ScheduledTaskInput,
  SessionMetadata,
  TaskMessage,
  TaskMessagePageInfo,
} from '../../shared/types.js';

export type { AgentRunSettings, ContextUsage };

export interface TaskBackgroundWork {
  available: boolean;
  work: Array<{ id: string; kind: 'process' | 'delegation'; status: string }>;
}

export interface AgentRunOptions {
  systemMessage?: string;
  settings?: AgentRunSettings;
  task?: {
    id: string;
    title?: string | null;
    workdir?: string | null;
  };
  runBudget?: {
    maxRuntimeMs: number;
    hardDeadlineAtMs: number;
    finalizeBeforeMs: number;
    childDrainBeforeMs: number;
    maxDelegatedChildren: number;
  };
}

export interface StreamEvent {
  type: 'text_delta' | 'thinking_delta' | 'tool_progress' | 'model_resolution' | 'done' | 'error';
  content?: string;
  error?: string;
  code?: string;
  sessionId?: string;
  tool?: string;
  status?: 'running' | 'completed' | 'error';
  duration?: number;
  label?: string;
  context?: ContextUsage | null;
  interrupted?: boolean;
  pendingSteer?: string;
  attachments?: TaskMessage['attachments'];
  modelResolution?: AgentModelResolution;
}

export interface AgentAdapter {
  chat(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): Promise<{ text: string; sessionId: string }>;

  chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent>;

  interruptChat(sessionId: string, reason?: string): Promise<boolean>;

  getBackgroundWork?(sessionId: string): Promise<TaskBackgroundWork>;

  steerChat(sessionId: string, message: string): Promise<boolean>;

  healthCheck(): Promise<boolean>;

  onDelegationEvent?(listener: (event: AdapterDelegationEvent) => void): () => void;

  onDelegationReset?(listener: (profileId?: string) => void): () => void;

  getMessages(sessionId: string, taskId: string): Promise<TaskMessage[]>;

  getMessagePage(
    sessionId: string,
    taskId: string,
    options: { limit: number; before?: string | null },
  ): Promise<{ messages: TaskMessage[]; pageInfo: TaskMessagePageInfo }>;

  getSessionMetadata(sessionId: string): Promise<SessionMetadata | null>;

  generateTitle(description: string, profileId?: string | null): Promise<{ title: string }>;

  compressSession(
    sessionId: string,
    options?: {
      focusTopic?: string | null;
      currentTokens?: number | null;
      systemMessage?: string;
      settings?: AgentRunSettings;
    },
  ): Promise<CompactResult>;

  getGoalStatus(sessionId: string): Promise<GoalStateSnapshot | null>;

  setGoal(
    sessionId: string,
    goal: string,
    options?: { maxTurns?: number | null },
  ): Promise<GoalStateSnapshot>;

  pauseGoal(sessionId: string, reason?: string): Promise<GoalStateSnapshot | null>;

  resumeGoal(sessionId: string): Promise<GoalStateSnapshot | null>;

  clearGoal(sessionId: string): Promise<boolean>;

  evaluateGoal(sessionId: string, responseText: string): Promise<GoalDecision>;

  listScheduledTasks(includeDisabled?: boolean, limit?: number, profileId?: string | null): Promise<ScheduledTask[]>;

  getScheduledTask(scheduledTaskId: string, profileId?: string | null): Promise<ScheduledTask | null>;

  createScheduledTask(input: ScheduledTaskInput, profileId?: string | null): Promise<ScheduledTask>;

  updateScheduledTask(scheduledTaskId: string, updates: Partial<ScheduledTaskInput>, profileId?: string | null): Promise<ScheduledTask | null>;

  pauseScheduledTask(scheduledTaskId: string, reason?: string, profileId?: string | null): Promise<ScheduledTask | null>;

  resumeScheduledTask(scheduledTaskId: string, profileId?: string | null): Promise<ScheduledTask | null>;

  runScheduledTask(scheduledTaskId: string, profileId?: string | null): Promise<ScheduledTask | null>;

  removeScheduledTask(scheduledTaskId: string, profileId?: string | null): Promise<boolean>;

  tickScheduledTasks(profileId?: string | null): Promise<number>;
}

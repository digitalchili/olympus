import { getTask } from '../db/queries.js';
import { remoteProfileRegistry, type RemoteProfileTarget } from '../remote-profiles.js';
import type { AgentAdapter, AgentRunOptions, StreamEvent } from './types.js';
import { RemoteHermesAdapter, RemoteHermesUnsupportedError } from './remote-hermes.js';
import type { AgentDefaults, AgentModelsResponse } from '../../shared/types.js';

export { RemoteHermesUnsupportedError };

export class RoutingAgentAdapter implements AgentAdapter {
  private remotes = new Map<string, RemoteHermesAdapter>();

  constructor(private local: AgentAdapter) {}

  async start(): Promise<void> {
    const startable = this.local as AgentAdapter & { start?: () => Promise<void> };
    await startable.start?.();
  }

  async stop(): Promise<void> {
    const stoppable = this.local as AgentAdapter & { stop?: () => Promise<void> };
    await stoppable.stop?.();
  }

  private remoteForTarget(target: RemoteProfileTarget): RemoteHermesAdapter {
    let remote = this.remotes.get(target.id);
    if (!remote) {
      if (!target.baseUrl || !target.apiKey) throw new Error(`Remote profile ${target.label} is not configured`);
      remote = new RemoteHermesAdapter({
        id: target.id,
        label: target.label,
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        remoteProfile: target.remoteProfile,
        remotePath: target.remotePath,
      });
      this.remotes.set(target.id, remote);
    }
    return remote;
  }

  private adapterForTaskId(taskId: string | null | undefined): AgentAdapter {
    const task = taskId ? getTask(taskId) : undefined;
    if (!task?.profile_name) return this.local;
    const target = remoteProfileRegistry.requireAvailable(task.profile_name);
    return this.remoteForTarget(target);
  }

  private adapterForSession(sessionId: string): AgentAdapter {
    return this.adapterForTaskId(sessionId);
  }

  chat(sessionId: string, message: string, options?: AgentRunOptions) {
    return this.adapterForTaskId(options?.task?.id ?? sessionId).chat(sessionId, message, options);
  }

  chatStream(sessionId: string, message: string, options?: AgentRunOptions): AsyncIterable<StreamEvent> {
    return this.adapterForTaskId(options?.task?.id ?? sessionId).chatStream(sessionId, message, options);
  }

  interruptChat(sessionId: string, reason?: string) {
    return this.adapterForSession(sessionId).interruptChat(sessionId, reason);
  }

  steerChat(sessionId: string, message: string) {
    return this.adapterForSession(sessionId).steerChat(sessionId, message);
  }

  async healthCheck(): Promise<boolean> {
    const localOk = await this.local.healthCheck();
    const remoteChecks = await Promise.all(remoteProfileRegistry.publicProfiles().filter((profile) => profile.available).map(async (profile) => {
      try {
        const target = remoteProfileRegistry.requireAvailable(profile.id);
        return await this.remoteForTarget(target).healthCheck();
      } catch {
        return false;
      }
    }));
    return localOk || remoteChecks.some(Boolean);
  }

  getMessages(sessionId: string, taskId: string) {
    return this.adapterForTaskId(taskId).getMessages(sessionId, taskId);
  }

  getSessionMetadata(sessionId: string) {
    return this.adapterForSession(sessionId).getSessionMetadata(sessionId);
  }

  generateTitle(description: string) {
    return this.local.generateTitle(description);
  }

  getDefaults(): Promise<AgentDefaults> {
    return (this.local as AgentAdapter & { getDefaults: () => Promise<AgentDefaults> }).getDefaults();
  }

  setDefaults(updates: { provider?: string | null; model?: string | null; reasoningEffort?: string | null }): Promise<AgentDefaults> {
    return (this.local as AgentAdapter & {
      setDefaults: (updates: { provider?: string | null; model?: string | null; reasoningEffort?: string | null }) => Promise<AgentDefaults>;
    }).setDefaults(updates);
  }

  getModels(): Promise<AgentModelsResponse> {
    return (this.local as AgentAdapter & { getModels: () => Promise<AgentModelsResponse> }).getModels();
  }

  compressSession(sessionId: string, options?: Parameters<AgentAdapter['compressSession']>[1]) {
    return this.adapterForSession(sessionId).compressSession(sessionId, options);
  }

  getGoalStatus(sessionId: string) {
    return this.adapterForSession(sessionId).getGoalStatus(sessionId);
  }

  setGoal(sessionId: string, goal: string, options?: { maxTurns?: number | null }) {
    return this.adapterForSession(sessionId).setGoal(sessionId, goal, options);
  }

  pauseGoal(sessionId: string, reason?: string) {
    return this.adapterForSession(sessionId).pauseGoal(sessionId, reason);
  }

  resumeGoal(sessionId: string) {
    return this.adapterForSession(sessionId).resumeGoal(sessionId);
  }

  clearGoal(sessionId: string) {
    return this.adapterForSession(sessionId).clearGoal(sessionId);
  }

  evaluateGoal(sessionId: string, responseText: string) {
    return this.adapterForSession(sessionId).evaluateGoal(sessionId, responseText);
  }

  listScheduledTasks(includeDisabled?: boolean, limit?: number) {
    return this.local.listScheduledTasks(includeDisabled, limit);
  }

  getScheduledTask(scheduledTaskId: string) {
    return this.local.getScheduledTask(scheduledTaskId);
  }

  createScheduledTask(input: Parameters<AgentAdapter['createScheduledTask']>[0]) {
    return this.local.createScheduledTask(input);
  }

  updateScheduledTask(scheduledTaskId: string, updates: Parameters<AgentAdapter['updateScheduledTask']>[1]) {
    return this.local.updateScheduledTask(scheduledTaskId, updates);
  }

  pauseScheduledTask(scheduledTaskId: string, reason?: string) {
    return this.local.pauseScheduledTask(scheduledTaskId, reason);
  }

  resumeScheduledTask(scheduledTaskId: string) {
    return this.local.resumeScheduledTask(scheduledTaskId);
  }

  runScheduledTask(scheduledTaskId: string) {
    return this.local.runScheduledTask(scheduledTaskId);
  }

  removeScheduledTask(scheduledTaskId: string) {
    return this.local.removeScheduledTask(scheduledTaskId);
  }

  tickScheduledTasks() {
    return this.local.tickScheduledTasks();
  }
}

import { getTask } from '../db/queries.js';
import { localProfileRegistry, type LocalProfileRegistry, type LocalProfileTarget } from '../local-profiles.js';
import type { AgentAdapter, AgentRunOptions, StreamEvent, TaskBackgroundWork } from './types.js';
import { HermesWorkerAdapter } from './hermes-worker.js';
import type { AdapterDelegationEvent, AgentDefaults, AgentModelsResponse } from '../../shared/types.js';
import { acquireProfileWork } from '../profile-deletion.js';

type LifecycleAdapter = AgentAdapter & {
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
};

interface ProfileAdapterOptions {
  registry?: LocalProfileRegistry;
  createAdapter?: (profile: LocalProfileTarget) => AgentAdapter;
  taskProfile?: (taskId: string) => string | null | undefined;
}

export class ProfileAgentAdapter implements AgentAdapter {
  private registry: LocalProfileRegistry;
  private createAdapter: (profile: LocalProfileTarget) => AgentAdapter;
  private taskProfile: (taskId: string) => string | null | undefined;
  private workers = new Map<string, LifecycleAdapter>();
  private starting = new Map<string, Promise<void>>();
  private started = new Set<string>();
  private delegationListeners = new Set<(event: AdapterDelegationEvent) => void>();
  private delegationResetListeners = new Set<(profileId?: string) => void>();
  private delegationUnsubscribers = new Map<LifecycleAdapter, () => void>();

  constructor(private defaultAdapter: LifecycleAdapter, options: ProfileAdapterOptions = {}) {
    this.registry = options.registry ?? localProfileRegistry;
    this.createAdapter = options.createAdapter ?? ((profile) => new HermesWorkerAdapter({ hermesHome: profile.hermesHome }));
    this.taskProfile = options.taskProfile ?? ((taskId) => getTask(taskId)?.profile_name);
    this.bindDelegationEvents(defaultAdapter, 'default');
  }

  private bindDelegationEvents(worker: LifecycleAdapter, profileId: string): void {
    if (!worker.onDelegationEvent || this.delegationUnsubscribers.has(worker)) return;
    const unsubscribeEvent = worker.onDelegationEvent((incoming) => {
      const task = getTask(incoming.taskId);
      if (!task) return;
      const ownerProfileId = task.profile_name ?? 'default';
      if (ownerProfileId !== profileId) return;
      const event = { ...incoming, profileId } satisfies AdapterDelegationEvent;
      for (const listener of this.delegationListeners) listener(event);
    });
    const unsubscribeReset = worker.onDelegationReset?.(() => {
      for (const listener of this.delegationResetListeners) listener(profileId);
    });
    this.delegationUnsubscribers.set(worker, () => {
      unsubscribeEvent();
      unsubscribeReset?.();
    });
  }

  onDelegationEvent(listener: (event: AdapterDelegationEvent) => void): () => void {
    this.delegationListeners.add(listener);
    return () => this.delegationListeners.delete(listener);
  }

  onDelegationReset(listener: (profileId?: string) => void): () => void {
    this.delegationResetListeners.add(listener);
    return () => this.delegationResetListeners.delete(listener);
  }

  async start(): Promise<void> {
    await this.defaultAdapter.start?.();
  }

  async stop(): Promise<void> {
    const workers = [this.defaultAdapter, ...this.workers.values()];
    this.workers.clear();
    this.starting.clear();
    this.started.clear();
    for (const unsubscribe of this.delegationUnsubscribers.values()) unsubscribe();
    this.delegationUnsubscribers.clear();
    await Promise.all(workers.map(async (worker) => worker.stop?.()));
  }

  async evictProfile(profileId: string): Promise<void> {
    const worker = this.workers.get(profileId);
    const starting = this.starting.get(profileId);
    this.workers.delete(profileId);
    this.starting.delete(profileId);
    this.started.delete(profileId);

    await starting?.catch(() => undefined);
    this.started.delete(profileId);
    await worker?.stop?.();
  }

  private async namedAdapter(profileName: string): Promise<LifecycleAdapter> {
    const profile = this.registry.require(profileName);
    if (profile.isDefault) return this.defaultAdapter;

    let worker = this.workers.get(profile.id);
    if (!worker) {
      worker = this.createAdapter(profile) as LifecycleAdapter;
      this.workers.set(profile.id, worker);
      this.bindDelegationEvents(worker, profile.id);
    }

    if (worker.start && !this.started.has(profile.id)) {
      let start = this.starting.get(profile.id);
      if (!start) {
        start = worker.start()
          .then(() => { this.started.add(profile.id); })
          .catch((error) => {
            if (this.workers.get(profile.id) === worker) this.workers.delete(profile.id);
            throw error;
          })
          .finally(() => {
            if (this.starting.get(profile.id) === start) this.starting.delete(profile.id);
          });
        this.starting.set(profile.id, start);
      }
      await start;
    }
    return worker;
  }

  private async adapterForProfileId(profileId: string | null | undefined): Promise<LifecycleAdapter> {
    if (!profileId) return this.defaultAdapter;
    return await this.namedAdapter(profileId);
  }

  private async adapterForTaskId(taskId: string | null | undefined): Promise<AgentAdapter> {
    const profileName = taskId ? this.taskProfile(taskId) : null;
    if (!profileName) return this.defaultAdapter;
    return await this.namedAdapter(profileName);
  }

  private adapterForSession(sessionId: string): Promise<AgentAdapter> {
    return this.adapterForTaskId(sessionId);
  }

  async chat(sessionId: string, message: string, options?: AgentRunOptions) {
    const worker = await this.adapterForTaskId(options?.task?.id ?? sessionId);
    return await worker.chat(sessionId, message, options);
  }

  async chatForProfile(profileId: string, sessionId: string, message: string, options?: AgentRunOptions) {
    const worker = await this.adapterForProfileId(profileId);
    return await worker.chat(sessionId, message, options);
  }

  async *chatStream(sessionId: string, message: string, options?: AgentRunOptions): AsyncIterable<StreamEvent> {
    const worker = await this.adapterForTaskId(options?.task?.id ?? sessionId);
    yield* worker.chatStream(sessionId, message, options);
  }

  async interruptChatForProfile(profileId: string, sessionId: string, reason?: string) {
    return await (await this.adapterForProfileId(profileId)).interruptChat(sessionId, reason);
  }

  async interruptChat(sessionId: string, reason?: string) {
    return await (await this.adapterForSession(sessionId)).interruptChat(sessionId, reason);
  }

  async getBackgroundWork(sessionId: string): Promise<TaskBackgroundWork> {
    const worker = await this.adapterForSession(sessionId);
    return worker.getBackgroundWork ? await worker.getBackgroundWork(sessionId) : { available: false, work: [] };
  }

  async steerChat(sessionId: string, message: string) {
    return await (await this.adapterForSession(sessionId)).steerChat(sessionId, message);
  }


  async respondInteraction(request: Parameters<NonNullable<AgentAdapter['respondInteraction']>>[0]) {
    const worker = await this.adapterForTaskId(request.taskId);
    if (!worker.respondInteraction) throw Object.assign(new Error('This agent adapter does not support interactive questions'), { code: 'interaction_unavailable' });
    return await worker.respondInteraction(request);
  }

  async healthCheck(): Promise<boolean> {
    return await this.defaultAdapter.healthCheck();
  }

  async getMessages(sessionId: string, taskId: string) {
    return await (await this.adapterForTaskId(taskId)).getMessages(sessionId, taskId);
  }

  async getMessagePage(sessionId: string, taskId: string, options: { limit: number; before?: string | null }) {
    return await (await this.adapterForTaskId(taskId)).getMessagePage(sessionId, taskId, options);
  }

  async getSessionMetadata(sessionId: string) {
    return await (await this.adapterForSession(sessionId)).getSessionMetadata(sessionId);
  }

  async generateTitle(description: string, profileId?: string | null) {
    if (!profileId) return await this.defaultAdapter.generateTitle(description);

    const release = acquireProfileWork(profileId);
    try {
      return await (await this.adapterForProfileId(profileId)).generateTitle(description);
    } finally {
      release();
    }
  }

  async getDefaults(profileId?: string | null): Promise<AgentDefaults> {
    const worker = await this.adapterForProfileId(profileId);
    return (worker as AgentAdapter & { getDefaults: () => Promise<AgentDefaults> }).getDefaults();
  }

  async setDefaults(updates: { provider?: string | null; model?: string | null; reasoningEffort?: string | null }, profileId?: string | null): Promise<AgentDefaults> {
    const worker = await this.adapterForProfileId(profileId);
    return (worker as AgentAdapter & {
      setDefaults: (updates: { provider?: string | null; model?: string | null; reasoningEffort?: string | null }) => Promise<AgentDefaults>;
    }).setDefaults(updates);
  }

  async getModels(profileId?: string | null): Promise<AgentModelsResponse> {
    const worker = await this.adapterForProfileId(profileId);
    return (worker as AgentAdapter & { getModels: () => Promise<AgentModelsResponse> }).getModels();
  }

  async compressSession(sessionId: string, options?: Parameters<AgentAdapter['compressSession']>[1]) {
    return await (await this.adapterForSession(sessionId)).compressSession(sessionId, options);
  }

  async getGoalStatus(sessionId: string) {
    return await (await this.adapterForSession(sessionId)).getGoalStatus(sessionId);
  }

  async setGoal(sessionId: string, goal: string, options?: { maxTurns?: number | null }) {
    return await (await this.adapterForSession(sessionId)).setGoal(sessionId, goal, options);
  }

  async pauseGoal(sessionId: string, reason?: string) {
    return await (await this.adapterForSession(sessionId)).pauseGoal(sessionId, reason);
  }

  async resumeGoal(sessionId: string) {
    return await (await this.adapterForSession(sessionId)).resumeGoal(sessionId);
  }

  async clearGoal(sessionId: string) {
    return await (await this.adapterForSession(sessionId)).clearGoal(sessionId);
  }

  async evaluateGoal(sessionId: string, responseText: string) {
    return await (await this.adapterForSession(sessionId)).evaluateGoal(sessionId, responseText);
  }

  async listScheduledTasks(includeDisabled?: boolean, limit?: number, profileId?: string | null) {
    return (await this.adapterForProfileId(profileId)).listScheduledTasks(includeDisabled, limit);
  }

  async getScheduledTask(scheduledTaskId: string, profileId?: string | null) {
    return (await this.adapterForProfileId(profileId)).getScheduledTask(scheduledTaskId);
  }

  async createScheduledTask(input: Parameters<AgentAdapter['createScheduledTask']>[0], profileId?: string | null) {
    return (await this.adapterForProfileId(profileId)).createScheduledTask(input);
  }

  async updateScheduledTask(scheduledTaskId: string, updates: Parameters<AgentAdapter['updateScheduledTask']>[1], profileId?: string | null) {
    return (await this.adapterForProfileId(profileId)).updateScheduledTask(scheduledTaskId, updates);
  }

  async pauseScheduledTask(scheduledTaskId: string, reason?: string, profileId?: string | null) {
    return (await this.adapterForProfileId(profileId)).pauseScheduledTask(scheduledTaskId, reason);
  }

  async resumeScheduledTask(scheduledTaskId: string, profileId?: string | null) {
    return (await this.adapterForProfileId(profileId)).resumeScheduledTask(scheduledTaskId);
  }

  async runScheduledTask(scheduledTaskId: string, profileId?: string | null) {
    return (await this.adapterForProfileId(profileId)).runScheduledTask(scheduledTaskId);
  }

  async removeScheduledTask(scheduledTaskId: string, profileId?: string | null) {
    return (await this.adapterForProfileId(profileId)).removeScheduledTask(scheduledTaskId);
  }

  async tickScheduledTasks(profileId?: string | null) {
    return (await this.adapterForProfileId(profileId)).tickScheduledTasks();
  }
}

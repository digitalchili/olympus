interface Delivery { id: string; recipientTaskId: string }

export function createBotMessageDispatcher<T extends Delivery>(options: {
  canDispatch(): boolean;
  load(): T[];
  isBusy(taskId: string): boolean;
  deliver(message: T): Promise<void>;
  onError(message: T, error: unknown): void;
}): { dispatch(): Promise<void> } {
  let dispatching = false;
  return {
    async dispatch() {
      if (dispatching || !options.canDispatch()) return;
      dispatching = true;
      try {
        const visited = new Set<string>();
        for (const message of options.load()) {
          if (!options.canDispatch()) break;
          if (visited.has(message.recipientTaskId)) continue;
          visited.add(message.recipientTaskId);
          if (options.isBusy(message.recipientTaskId)) continue;
          try { await options.deliver(message); }
          catch (error) { options.onError(message, error); }
        }
      } finally { dispatching = false; }
    },
  };
}

let dispatcher: { dispatch(): Promise<void> } | undefined;
export function configureBotMessageDispatcher(value: { dispatch(): Promise<void> }): void { dispatcher = value; }
export function scheduleBotMessageDispatch(): void {
  setTimeout(() => { void dispatcher?.dispatch().catch(error => console.error('Bot delivery dispatch failed:', error)); }, 0).unref();
}

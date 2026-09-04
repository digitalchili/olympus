import type { QueuedTaskMessage } from '../shared/types.js';

export interface QueuedMessageDispatcher {
  schedule(taskId: string): void;
}

interface DispatcherDependencies<T> {
  load(taskId: string): T | undefined;
  isActive(taskId: string): boolean;
  deliver(taskId: string, message: T): Promise<void>;
  defer?: (work: () => void) => void;
  onError?: (taskId: string, error: unknown) => void;
}

interface DeliveryResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export async function assertQueuedMessageDeliveryResponse(response: DeliveryResponse): Promise<void> {
  const body = await response.text();
  const detail = body.slice(0, 500);
  if (response.status === 202) return;
  if (response.status === 200) {
    let payload: { action?: unknown };
    try {
      payload = JSON.parse(body) as { action?: unknown };
    } catch {
      throw new Error('Queued message dispatch returned HTTP 200: expected commit_push JSON');
    }
    if (payload.action === 'commit_push') return;
    throw new Error('Queued message dispatch returned HTTP 200: expected commit_push response');
  }
  throw new Error(`Queued message dispatch returned HTTP ${response.status}: ${detail}`);
}

export function createQueuedMessageDispatcher<T = QueuedTaskMessage>(
  dependencies: DispatcherDependencies<T>,
): QueuedMessageDispatcher {
  const scheduled = new Set<string>();
  const defer = dependencies.defer ?? ((work: () => void) => setTimeout(work, 0));

  return {
    schedule(taskId: string) {
      if (scheduled.has(taskId)) return;
      scheduled.add(taskId);
      defer(() => {
        scheduled.delete(taskId);
        if (dependencies.isActive(taskId)) return;
        const message = dependencies.load(taskId);
        if (!message) return;
        void dependencies.deliver(taskId, message).catch((error) => {
          dependencies.onError?.(taskId, error);
        });
      });
    },
  };
}

let configuredDispatcher: QueuedMessageDispatcher | null = null;

export function configureQueuedMessageDispatcher(dispatcher: QueuedMessageDispatcher): void {
  configuredDispatcher = dispatcher;
}

export function scheduleQueuedMessageDispatch(taskId: string): void {
  configuredDispatcher?.schedule(taskId);
}

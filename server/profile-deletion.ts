export class ProfileDeletingError extends Error {
  readonly status = 409;
  readonly code = 'PROFILE_DELETING';

  constructor(public readonly profileId: string) {
    super(`Hermes profile is being deleted: ${profileId}`);
    this.name = 'ProfileDeletingError';
  }
}

type ProfileWorkState = {
  activeRequests: number;
  deleting: boolean;
  idleWaiters: Set<() => void>;
};

const profileWork = new Map<string, ProfileWorkState>();

function stateFor(profileId: string): ProfileWorkState {
  let state = profileWork.get(profileId);
  if (!state) {
    state = { activeRequests: 0, deleting: false, idleWaiters: new Set() };
    profileWork.set(profileId, state);
  }
  return state;
}

function cleanUp(profileId: string, state: ProfileWorkState): void {
  if (!state.deleting && state.activeRequests === 0 && state.idleWaiters.size === 0) {
    profileWork.delete(profileId);
  }
}

export function isProfileDeleting(profileId: string): boolean {
  return profileWork.get(profileId)?.deleting === true;
}

export function assertProfileAcceptingWork(profileId: string): void {
  if (isProfileDeleting(profileId)) throw new ProfileDeletingError(profileId);
}

export function acquireProfileWork(profileId: string): () => void {
  const state = stateFor(profileId);
  if (state.deleting) throw new ProfileDeletingError(profileId);
  state.activeRequests += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.activeRequests -= 1;
    if (state.activeRequests === 0) {
      for (const resolve of state.idleWaiters) resolve();
      state.idleWaiters.clear();
    }
    cleanUp(profileId, state);
  };
}

export type ProfileDeletionLock = {
  waitForIdle(): Promise<void>;
  release(): void;
};

export function beginProfileDeletion(profileId: string): ProfileDeletionLock {
  const state = stateFor(profileId);
  if (state.deleting) throw new ProfileDeletingError(profileId);
  state.deleting = true;

  let released = false;
  return {
    waitForIdle() {
      if (state.activeRequests === 0) return Promise.resolve();
      return new Promise<void>((resolve) => state.idleWaiters.add(resolve));
    },
    release() {
      if (released) return;
      released = true;
      state.deleting = false;
      cleanUp(profileId, state);
    },
  };
}

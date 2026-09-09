/** Wait for the operation to settle, or an explicit user Stop. No execution timer. */
export async function untilStopped<T>(work: () => Promise<T>, isStopped?: () => boolean): Promise<T> {
  let stopTimer: ReturnType<typeof setInterval> | undefined;
  try {
    if (isStopped?.()) throw new Error('Run stopped by user');
    const result = await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        if (isStopped) stopTimer = setInterval(() => {
          if (isStopped()) reject(new Error('Run stopped by user'));
        }, 50);
      }),
    ]);
    if (isStopped?.()) throw new Error('Run stopped by user');
    return result;
  } finally {
    if (stopTimer) clearInterval(stopTimer);
  }
}

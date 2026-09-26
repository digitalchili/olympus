import type { Response } from 'express';

export interface SseWriter {
  bootstrap(frames: readonly string[]): void;
  send(frame: string): void;
  keepalive(): void;
  close(): void;
}

export function createSseWriter(res: Response): SseWriter {
  let closed = false;
  let blocked = false;
  let bootstrapFrames: readonly string[] = [];
  let bootstrapIndex = -1;
  let needsResync = false;

  function close() {
    if (closed) return;
    closed = true;
    bootstrapFrames = [];
    res.off('drain', drain);
    res.off('close', close);
    res.off('error', close);
    res.off('finish', close);
    if (!res.writableEnded && !res.destroyed) {
      try { res.end(); } catch { res.destroy(); }
    }
  }

  function write(frame: string) {
    if (res.writableEnded || res.destroyed) { close(); return; }
    try {
      // false still accepts this frame. Never resend it after drain.
      blocked = !res.write(frame);
    } catch { close(); }
  }

  function flushBootstrap() {
    while (!closed && !blocked && bootstrapIndex >= 0 && bootstrapIndex < bootstrapFrames.length) {
      write(bootstrapFrames[bootstrapIndex++]);
    }
    if (!closed && !blocked && bootstrapIndex >= 0) {
      bootstrapFrames = [];
      bootstrapIndex = 0;
      if (needsResync) close();
    }
  }

  function drain() {
    if (closed) return;
    blocked = false;
    flushBootstrap();
  }

  res.on('drain', drain);
  res.on('close', close);
  res.on('error', close);
  res.on('finish', close);

  return {
    bootstrap(frames) {
      if (closed || bootstrapIndex !== -1) return;
      // Callers supply one finite snapshot batch, never incremental history.
      bootstrapFrames = frames;
      bootstrapIndex = 0;
      flushBootstrap();
    },
    send(frame) {
      if (closed) return;
      if (blocked || bootstrapIndex < 0 || bootstrapFrames.length > 0) {
        needsResync = true;
        return;
      }
      write(frame);
    },
    keepalive() {
      if (!closed && !blocked && bootstrapIndex >= 0 && bootstrapFrames.length === 0) write(':keepalive\n\n');
    },
    close,
  };
}

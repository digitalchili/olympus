import type { RequestHandler } from 'express';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createActiveRequestTracker(): { count: () => number; middleware: RequestHandler } {
  let active = 0;
  return {
    count: () => active,
    middleware: (req, res, next) => {
      if (READ_METHODS.has(req.method)) {
        next();
        return;
      }
      active += 1;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        active -= 1;
      };
      res.once('finish', finish);
      res.once('close', finish);
      next();
    },
  };
}

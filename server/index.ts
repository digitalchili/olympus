import 'dotenv/config';
import './logging.js';
import './db/index.js';
import { createServer, type Server } from 'node:http';
import app, { adapter, drainController } from './app.js';
import { mountFrontend, type FrontendCleanup } from './frontend.js';
import { closeClientsForRestart } from './events.js';
import { closeSubscribersForRestart } from './live-chat.js';

const PORT = parseInt(process.env.PORT || '6969', 10);
const PORT_FALLBACK_ATTEMPTS = process.env.OLYMPUS_STRICT_PORT === '1' ? 1 : 20;

const httpServer = createServer(app);
let closeFrontend: FrontendCleanup = () => {};
let shuttingDown = false;

type ShutdownReason = NodeJS.Signals | 'startup-error';

async function listenWithFallback(
  server: Server,
  startPort: number,
  maxAttempts: number,
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const tryPort = startPort + i;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          rejectListen(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolveListen();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(tryPort);
      });
      if (tryPort !== startPort) {
        console.warn(`Port ${startPort} was busy — using port ${tryPort} instead.`);
      }
      return tryPort;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(
    `Could not find a free port after ${maxAttempts} attempts starting from ${startPort}.`,
  );
}

async function main() {
  closeFrontend = await mountFrontend(app, httpServer);
  try {
    await adapter.start();
  } catch (error) {
    console.error(
      'Hermes worker failed to start — UI will load but agent features are unavailable until the worker recovers:',
      error instanceof Error ? error.message : error,
    );
  }
  const boundPort = await listenWithFallback(httpServer, PORT, PORT_FALLBACK_ATTEMPTS);

  console.log(`Olympus Dispatch by Digital Chili running on http://localhost:${boundPort}`);
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    if (!httpServer.listening) {
      resolveClose();
      return;
    }

    httpServer.close((error?: Error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });

  });
}

async function shutdown(reason: ShutdownReason, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    httpServer.closeAllConnections();
    process.exit(1);
  }
  shuttingDown = true;

  drainController.begin();
  const drainTimeoutMs = Number.parseInt(process.env.OLYMPUS_DRAIN_TIMEOUT_MS || '120000', 10);
  const idle = await drainController.waitForIdle(drainTimeoutMs);
  if (!idle) console.error(`Drain timed out after ${drainTimeoutMs}ms; stopping with active work.`);
  closeClientsForRestart();
  closeSubscribersForRestart();

  const forceExit = setTimeout(() => {
    console.error(`Forced shutdown after ${reason}`);
    httpServer.closeAllConnections();
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  const results = await Promise.allSettled([
    closeHttpServer(),
    closeFrontend(),
    adapter.stop(),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') console.error(result.reason);
  }

  clearTimeout(forceExit);
  process.exit(results.some((result) => result.status === 'rejected') ? 1 : exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  console.error(error);
  void shutdown('startup-error', 1);
});

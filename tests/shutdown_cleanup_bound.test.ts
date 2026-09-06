import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual shutdown function with a cleanup operation that never
// settles, without importing index.ts or launching an application/worker.
const source = await readFile('server/index.ts', 'utf8');
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest);
const shutdown = tree.statements.find((statement): statement is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'shutdown');
assert.ok(shutdown);
let closed = false;
let exit!: (code: number) => void;
const exited = new Promise<number>((resolve) => { exit = resolve; });
const script = ts.transpileModule(`${shutdown.getText(tree)}\nvoid shutdown('SIGTERM');`, {}).outputText;
vm.runInNewContext(script, {
  shuttingDown: false,
  drainController: { begin() {}, async waitForIdle() { return true; } },
  cancelAllCodingVerifications: () => new Promise(() => {}),
  httpServer: { closeAllConnections() { closed = true; } },
  closeClientsForRestart() {}, closeSubscribersForRestart() {},
  closeHttpServer: async () => {}, closeFrontend: async () => {}, adapter: { stop: async () => {} },
  process: { env: {}, exit }, console: { error() {} },
  setTimeout: (callback: () => void) => setTimeout(callback, 5), clearTimeout,
});
const deadline = setTimeout(() => exit(-1), 100);
assert.equal(await exited, 1, 'the shutdown deadline must cover pending verification cancellation');
clearTimeout(deadline);
assert.equal(closed, true);
console.log('Shutdown cleanup deadline regression passed');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { ProjectRepositoryLink, ProjectVersion, PublicProjectEditorLease } from '../shared/types.js';
import type { TaskCommitPushModal } from '../client/src/components/TaskCommitPushModal.js';

const file = new URL('../client/src/components/TaskCommitPushModal.tsx', import.meta.url);
const dependency = createRequire(file);
const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const repositoryLink = { fullName: 'fixture/repository', defaultBranch: 'main' } as ProjectRepositoryLink;
const editor = { taskId: 'task-1', branchName: 'olympus/task-1' } as PublicProjectEditorLease;
const dirty = { clean: false, changedFiles: ['draft.txt'], summary: 'One changed file', diff: 'unsaved draft', pendingPublication: null };
const pending = { id: 'publication-1', action: 'commit_push', commitSha: 'a'.repeat(40), targetBranches: ['olympus/task-1', 'main'], state: 'pending' };
const version = { commitSha: 'a'.repeat(40), branchName: 'main' } as ProjectVersion;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness() {
  const slots: any[] = [];
  let cursor = 0;
  const effects: Array<() => void> = [];
  const requests: Array<{ url: string; init?: RequestInit; resolve: (response: Response) => void }> = [];
  const confirms: string[] = [];
  let confirm = true;
  let props: Parameters<typeof TaskCommitPushModal>[0] = { open: true, onClose() {}, projectId: 'project-1', taskId: 'task-1', taskTitle: 'Fixture', repositoryLink };
  globalThis.fetch = (input, init) => new Promise<Response>(resolve => requests.push({ url: String(input), init, resolve }));
  const exports: any = {};
  const window = { confirm: (message: string) => { confirms.push(message); return confirm; } };
  Object.assign(globalThis, { window });
  runInNewContext(code, {
    exports, require: (name: string) => name === 'react' ? {
      useState(initial: any) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
      },
      useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
      useEffect(effect: () => (() => void) | void, deps: unknown[]) {
        const index = cursor++, previous = slots[index];
        if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) effects.push(() => {
          previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() };
        });
      },
    } : dependency(name), window, setTimeout: () => 0, clearTimeout() {}, console,
  });
  let tree: ReactNode;
  const render = () => {
    cursor = 0; tree = exports.TaskCommitPushModal(props);
    while (effects.length) effects.shift()!();
    return renderToStaticMarkup(tree);
  };
  const nodes = (node: ReactNode): ReactElement<any>[] => {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== 'object' || !('props' in node)) return [];
    const element = node as ReactElement<any>;
    if (typeof element.type === 'function') return nodes(element.type(element.props));
    return [element, ...nodes(element.props.children)];
  };
  const inputs = () => { render(); return nodes(tree).filter(node => node.type === 'input'); };
  return {
    render, requests, confirms,
    change(next: Partial<typeof props>) { props = { ...props, ...next }; render(); return render(); },
    inputs,
    chooseDefault(value: boolean) { const node = inputs().find(node => node.props.type === 'checkbox'); assert.ok(node && !node.props.disabled); node.props.onChange({ target: { checked: value } }); render(); },
    message(value: string) { const node = inputs().find(node => node.props.type !== 'checkbox'); assert.ok(node && !node.props.disabled); node.props.onChange({ target: { value } }); render(); },
    click(label: string) {
      render();
      const node = nodes(tree).find(node => node.type === 'button' && renderToStaticMarkup(node).includes(label));
      assert.ok(node, `Missing button ${label}`); assert.ok(!node.props.disabled, `Disabled button ${label}`); node.props.onClick();
    },
    confirm(value: boolean) { confirm = value; },
    async respond(index: number, body: unknown, status = 200) {
      assert.ok(requests[index], `Missing request ${index}`);
      requests[index].resolve(Response.json(body, { status })); await flush(); render(); return render();
    },
  };
}

const oldFetch = globalThis.fetch;
const oldWindow = (globalThis as any).window;
try {
  const waiting = harness(); waiting.render();
  const activeMessage = 'Wait for this task and its checks to finish, then try again.';
  const notice = await waiting.respond(0, { error: activeMessage, code: 'PROJECT_OPERATION_ACTIVE' }, 409);
  assert.match(notice, /role="status"/);
  assert.match(notice, /Waiting for active work/);
  assert.match(notice, /Wait for this task and its checks/);
  assert.doesNotMatch(notice, /role="alert"|Unable to continue/);
  assert.equal(waiting.requests.length, 1, 'showing a waiting notice must not publish or restart work');
  waiting.click('Refresh status');
  await waiting.respond(1, { editor });
  const ready = await waiting.respond(2, { status: dirty });
  assert.doesNotMatch(ready, /Waiting for active work/);
  waiting.message('Publish once ready'); waiting.click('Commit &amp; Push');
  assert.match(waiting.requests[3].url, /\/commit-push$/);

  const failed = harness(); failed.render();
  const failure = await failed.respond(0, { error: 'GitHub connection is unavailable', code: 'GITHUB_UNAVAILABLE' }, 503);
  assert.match(failure, /role="alert"/);
  assert.match(failure, /Unable to continue/);
  assert.match(failure, /GitHub connection is unavailable/);
  assert.doesNotMatch(failure, /Waiting for active work/);

  const h = harness(); h.render();
  await h.respond(0, { editor }); await h.respond(1, { status: dirty });
  assert.equal(h.inputs().find(node => node.props.type === 'checkbox')?.props.checked, false, 'a newly opened dialog must default to the task branch');
  h.chooseDefault(true); h.message('Preserve this draft');
  h.change({ open: false }); h.change({ open: true });
  await h.respond(2, { editor }); await h.respond(3, { status: dirty });
  assert.equal(h.inputs().find(node => node.props.type === 'checkbox')?.props.checked, false, 'reopening resets a previous default-branch choice');
  h.chooseDefault(true); h.change({ taskId: 'task-2' });
  await h.respond(4, { editor: { ...editor, taskId: 'task-2', branchName: 'olympus/task-2' } }); await h.respond(5, { status: dirty });
  assert.equal(h.inputs().find(node => node.props.type === 'checkbox')?.props.checked, false, 'switching task resets the target');
  h.message('A reviewed change'); h.click('Commit &amp; Push');
  assert.deepEqual(JSON.parse(String(h.requests[6].init?.body)), { taskId: 'task-2', message: 'A reviewed change', deployToDefaultBranch: false });
  const success = await h.respond(6, { version, versions: [version] });
  assert.match(success, /Pushed aaaaaaa to main/);
  assert.doesNotMatch(success, /Deployed|Deploying|Dokploy|Successfully.*deployed/i);

  const uncertain = harness(); uncertain.render();
  await uncertain.respond(0, { editor }); await uncertain.respond(1, { status: dirty });
  uncertain.message('Keep the exact approved message'); uncertain.chooseDefault(true); uncertain.click('Commit &amp; Push');
  await uncertain.respond(2, { error: 'Publication could not be confirmed', code: 'PROJECT_PUBLICATION_UNCONFIRMED' }, 503);
  const awaiting = await uncertain.respond(3, { status: { ...dirty, clean: true, pendingPublication: pending } });
  assert.match(awaiting, /Resume publication/);
  assert.match(awaiting, /olympus\/task-1/); assert.match(awaiting, /main/); assert.match(awaiting, /aaaaaaa/);
  assert.ok(uncertain.inputs().every(node => node.props.disabled), 'pending intent must not allow replacing message or targets');
  uncertain.click('Resume publication');
  assert.match(uncertain.requests[4].url, /\/publications\/publication-1\/retry$/);
  assert.deepEqual(JSON.parse(String(uncertain.requests[4].init?.body)), { taskId: 'task-1' });
  const resumed = await uncertain.respond(4, { version, versions: [version] });
  assert.match(resumed, /Pushed aaaaaaa to main/);

  const restored = harness(); restored.render();
  await restored.respond(0, { editor }); await restored.respond(1, { status: { ...dirty, clean: true, pendingPublication: pending } });
  assert.match(restored.render(), /Resume publication/, 'reload must recover a pending receipt despite a clean tree');
  restored.confirm(false); restored.click('Stop retrying this publication');
  assert.equal(restored.requests.length, 2);
  restored.confirm(true); restored.click('Stop retrying this publication');
  assert.match(restored.confirms.at(-1)!, /does not undo.*GitHub/i);
  assert.match(restored.requests[2].url, /\/publications\/publication-1\/abandon$/);
  assert.deepEqual(JSON.parse(String(restored.requests[2].init?.body)), { taskId: 'task-1' });
  assert.match(restored.render(), /Stopping publication retries/);
  assert.doesNotMatch(restored.render(), /Pushing to GitHub|Uploading changes/);
  await restored.respond(2, { abandoned: true });
  await restored.respond(3, { status: dirty });
  assert.doesNotMatch(restored.render(), /Resume publication/);

  const modal = readFileSync(file, 'utf8');
  const detail = readFileSync(new URL('../client/src/components/ProjectDetailPage.tsx', import.meta.url), 'utf8');
  for (const source of [modal, detail]) {
    assert.doesNotMatch(source, /Deploy directly|Commit & Deploy|Deployed!|Dokploy|Successfully committed and deployed/);
    assert.match(source, /PendingProjectPublication/);
    assert.match(source, /retryProjectPublication/);
    assert.match(source, /abandonProjectPublication/);
  }
} finally { globalThis.fetch = oldFetch; (globalThis as any).window = oldWindow; }
console.log('Publication UI exact intent, reload, resume and truthful success tests passed');

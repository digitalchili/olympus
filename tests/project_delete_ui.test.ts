import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const file = new URL('../client/src/components/DeleteProjectSection.tsx', import.meta.url);
assert.ok(existsSync(file), 'Project Settings needs a Delete Project action');
const dependency = createRequire(file);
const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(disabled = false) {
  const slots: any[] = [];
  let cursor = 0;
  let deleted = 0;
  const requests: Array<{ url: string; init?: RequestInit; resolve: (response: Response) => void }> = [];
  globalThis.fetch = (url, init) => new Promise(resolve => requests.push({ url: String(url), init, resolve }));
  const exports: any = {};
  runInNewContext(code, {
    exports, require: (name: string) => name === 'react' ? {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (next: unknown) => { slots[index] = next; }];
      },
      useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
    } : dependency(name),
  });
  let tree: ReactNode;
  const nodes = (node: ReactNode): ReactElement<any>[] => {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== 'object' || !('props' in node)) return [];
    const element = node as ReactElement<any>;
    if (typeof element.type === 'function') return nodes(element.type(element.props));
    return [element, ...nodes(element.props.children)];
  };
  const render = () => {
    cursor = 0;
    tree = exports.DeleteProjectSection({ projectId: 'project/one', projectName: 'Example <Project>', disabled, onDeleted: () => { deleted++; } });
    return renderToStaticMarkup(tree);
  };
  const button = (label: string) => {
    render();
    const matches = nodes(tree).filter(node => node.type === 'button' && renderToStaticMarkup(node.props.children).replace(/<[^>]+>/g, '').trim() === label);
    const found = matches.at(-1);
    assert.ok(found, `Missing ${label} button`);
    return found;
  };
  return {
    render, requests, button, deleted: () => deleted,
    click(label: string) { const found = button(label); assert.ok(!found.props.disabled); found.props.onClick(); },
    async respond(status: number, body?: unknown) {
      requests.at(-1)!.resolve(status === 204 ? new Response(null, { status }) : Response.json(body, { status }));
      await flush(); return render();
    },
  };
}

const previousFetch = globalThis.fetch;
try {
  const h = harness();
  h.click('Delete Project');
  assert.match(h.render(), /Example &lt;Project&gt;/, 'confirmation names the selected project safely');
  assert.match(h.render(), /and all its tasks/);
  assert.match(h.render(), /cannot be undone/);
  assert.match(h.render(), /not pushed to GitHub/);
  assert.match(h.render(), /local project copies/);
  assert.match(h.render(), /GitHub repository/);
  assert.equal(h.requests.length, 0, 'opening confirmation must not delete');
  h.click('Cancel');
  assert.equal(h.requests.length, 0, 'cancel must not delete');
  assert.equal(h.deleted(), 0);

  h.click('Delete Project');
  const confirm = h.button('Delete Project');
  confirm.props.onClick(); confirm.props.onClick();
  assert.equal(h.requests.length, 1, 'double confirmation must send one deletion');
  assert.equal(h.requests[0].url, '/api/projects/project%2Fone', 'Project deletion uses the existing operator API context');
  assert.equal(h.requests[0].init?.method, 'DELETE');
  assert.ok(h.button('Cancel').props.disabled);
  assert.ok(h.button('Deleting...').props.disabled);
  assert.match(await h.respond(409, { error: 'Finish the active task before deleting this Project.' }), /Finish the active task/);
  assert.equal(h.deleted(), 0, 'failed deletion must leave the user in the project');
  h.click('Delete Project');
  await h.respond(204);
  assert.equal(h.deleted(), 1, 'only confirmed server success leaves the project');

  const cleanup = harness();
  cleanup.click('Delete Project'); cleanup.click('Delete Project');
  assert.match(await cleanup.respond(409, { code: 'PROJECT_CLEANUP_PENDING', error: 'Project deleted; disk cleanup needs a retry.' }), /Retry cleanup/);
  assert.equal(cleanup.deleted(), 0);
  cleanup.click('Retry cleanup');
  assert.equal(cleanup.requests.length, 2);
  await cleanup.respond(204);
  assert.equal(cleanup.deleted(), 1);

  const pendingCleanup = harness();
  pendingCleanup.click('Delete Project'); pendingCleanup.click('Delete Project');
  await pendingCleanup.respond(409, { code: 'PROJECT_CLEANUP_PENDING', error: 'Retry disk cleanup.' });
  pendingCleanup.click('Back to Projects');
  assert.equal(pendingCleanup.deleted(), 1, 'a deleted project must not remain as a stale details page');

  const stale = harness();
  stale.click('Delete Project'); stale.click('Delete Project');
  await stale.respond(404, { error: 'Project not found' });
  assert.equal(stale.deleted(), 1, 'retry after a lost successful response leaves a deleted Project');

  assert.ok(harness(true).button('Delete Project').props.disabled, 'another Project operation disables deletion');
  console.log('Project deletion confirmation, error recovery, request ownership and success tests passed');
} finally { globalThis.fetch = previousFetch; }

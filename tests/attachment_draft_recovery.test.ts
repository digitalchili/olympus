import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Exercise the real composer and attachment hook. Only scheduling and the
// upload/chat transports are controlled; the attachment payload and tray are real.
function composer(streaming: boolean) {
  const slots: any[] = [];
  let cursor = 0, taskId = 'task-one', profileId = 'default';
  let accepted = false, delay = false, release: (() => void) | undefined;
  const sent: string[] = [], uploads: string[] = [], deleted: string[] = [];
  const dependency = createRequire(import.meta.url);
  const hooks = { ...dependency('react'),
    useState(initial: any) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
      return [slots[at], (next: any) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }];
    },
    useRef(initial: any) { const at = cursor++; return slots[at] ??= { current: initial }; },
    useCallback: (fn: any) => fn, useMemo: (fn: any) => fn(), useEffect() {}, useLayoutEffect() {},
  };
  const submit = async (content: string) => {
    sent.push(content);
    if (delay) await new Promise<void>(resolve => { release = resolve; });
    if (!accepted) throw new Error('Olympus is finishing active work for an update.');
  };
  function load(path: string, overrides: Record<string, any>) {
    const file = new URL(path, import.meta.url), require = createRequire(file), exports: any = {};
    runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, {
      exports, console, setTimeout, clearTimeout, URL, File, AbortController, DOMException,
      requestAnimationFrame() {},
      require: (id: string) => id === 'react' ? hooks : overrides[id] ?? (
        id.startsWith('./') && id !== './ChatAttachments'
          ? new Proxy({}, { get: () => () => null })
          : require(id)
      ),
    });
    return exports;
  }
  const attachments = load('../client/src/hooks/useFileAttachments.ts', {
    '../lib/api': {
      uploadChatAttachment: async (_bucket: string, _id: string, file: File) => {
        uploads.push(file.name); return `/workspace/uploads/${file.name}`;
      },
      deleteFileEntry: async (path: string) => { deleted.push(path); },
    },
  });
  const component = load('../client/src/components/TaskChat.tsx', {
    '../hooks/useFileAttachments': attachments,
    '../hooks/useProjectSecretEntry': { useProjectSecretEntry: () => ({}) },
    '../hooks/useAgentConfig': { useAgentConfig: () => ({ defaults: {}, modelGroups: [] }) },
    '../contexts/ProfileContext': { useProfile: () => ({ activeProfileId: profileId }) },
    '../hooks/useChat': { useChat: () => ({ messages: [], activeTools: [], isStreaming: streaming,
      sendMessage: async (_task: string, content: string) => {
        try { await submit(content); return { ok: true }; }
        catch (error) { return { ok: false, error: String(error) }; }
      },
    }) },
    '../lib/store': { useStore: (select: any) => select({ tasks: [], taskRuns: new Map(), taskOutcomes: new Map(), delegationRuns: new Map() }) },
    '../lib/api': { ...dependency('../client/src/lib/api.ts'),
      putQueuedTaskMessage: async (_task: string, message: any) => { await submit(message.content); return { queuedMessage: message }; },
    },
  });
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props
    ? [node, ...nodes(node.props.children)] : [];
  const render = () => { cursor = 0; return nodes(component.TaskChat({ taskId })); };
  const input = () => render().find(node => node.type === 'textarea');
  const tray = () => render().find(node => node.type?.name === 'AttachmentTray');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return { sent, uploads, deleted, tray, input, tick,
    type(text: string) { input().props.onChange({ target: { value: text, selectionStart: text.length } }); },
    async attach(name: string) {
      render().find(node => node.type?.name === 'AttachButton').props.onFiles([new File(['image'], name, { type: 'image/png' })]);
      await tick();
    },
    async send() { input().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }); await tick(); },
    accept() { accepted = true; delay = false; },
    delay() { delay = true; },
    async finishRequest() { release!(); await tick(); },
    navigate(task: string, profile = profileId) { taskId = task; profileId = profile; render(); },
  };
}

for (const streaming of [true, false]) {
  const h = composer(streaming);
  h.type('Is this setting correct?');
  await h.attach('settings.png');
  const firstPreview = h.tray().props.files[0].previewUrl;
  await h.send();
  assert.equal(h.input().props.value, 'Is this setting correct?', 'rejected sends restore only the user text');
  assert.equal(h.tray().props.files.length, 1, 'the rejected attachment returns to the tray');
  const file = h.tray().props.files[0];
  assert.equal(file.uploadedPath, '/workspace/uploads/settings.png');
  assert.equal(file.status, 'uploaded');
  assert.notEqual(file.previewUrl, firstPreview, 'restoration creates a live preview after the old URL was revoked');
  assert.equal(await (await fetch(file.previewUrl)).text(), 'image');
  const markup = renderToStaticMarkup(h.tray());
  assert.match(markup, /<img[^>]*alt="settings.png"/);
  assert.doesNotMatch(markup, /Attached files:|\/workspace\/uploads/);
  assert.equal(h.deleted.length, 0, 'rejection never removes the uploaded file');
  h.accept();
  await h.send();
  assert.equal(h.sent[1], 'Is this setting correct?\n\n[Attached files:\n- /workspace/uploads/settings.png]');
  assert.equal(h.uploads.length, 1, 'retry reuses the original upload');
  assert.equal(h.input().props.value, '');
  assert.equal(h.tray().props.files.length, 0, 'accepted sends clear the tray');
}

for (const streaming of [true, false]) {
  const h = composer(streaming);
  await h.attach('image-only.png');
  await h.send();
  assert.equal(h.input().props.value, '', 'attachment-only failure does not inject a synthetic prompt');
  assert.equal(h.tray().props.files.length, 1);
  h.tray().props.onRemove(h.tray().props.files[0].id);
  assert.equal(h.tray().props.files.length, 0);
  assert.deepEqual(h.deleted, ['/workspace/uploads/image-only.png']);

  const newer = composer(streaming);
  newer.type('First draft');
  await newer.attach('first.png');
  newer.delay(); await newer.send();
  newer.type('Newer draft'); await newer.attach('newer.png');
  await newer.finishRequest();
  assert.equal(newer.input().props.value, 'Newer draft', 'a delayed failure never overwrites newer typing');
  assert.deepEqual(Array.from(newer.tray().props.files, (f: any) => f.file.name).sort(), ['first.png', 'newer.png']);

  const accepted = composer(streaming);
  accepted.type('First draft'); await accepted.attach('first.png');
  accepted.delay(); await accepted.send();
  accepted.type('Next draft'); await accepted.attach('next.png');
  accepted.accept(); await accepted.finishRequest();
  assert.equal(accepted.input().props.value, 'Next draft', 'late acceptance also preserves newer typing');
  assert.deepEqual(Array.from(accepted.tray().props.files, (f: any) => f.file.name), ['next.png']);

  for (const [task, profile] of [['other-task', 'default'], ['task-one', 'other-profile']]) {
    const moved = composer(streaming);
    moved.type('Old draft'); await moved.attach('old.png');
    moved.delay(); await moved.send(); moved.navigate(task, profile); moved.type('Different task');
    await moved.finishRequest();
    assert.equal(moved.input().props.value, 'Different task');
    assert.equal(moved.tray().props.files.length, 0, 'a late failure cannot restore attachments into another task or profile');
  }
}
console.log('Attachment draft recovery tests passed');

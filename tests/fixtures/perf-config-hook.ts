import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = new URL('../../client/src/hooks/useAgentConfig.ts', import.meta.url);
const dependency = createRequire(file);
export const currentConfigSource = () => readFileSync(file, 'utf8');
export const flushConfig = () => new Promise<void>(resolve => setImmediate(resolve));

// Runs the real hook, controlling only React scheduling and its HTTP boundary.
export function configHarness(source = currentConfigSource()) {
  const slots: any[] = [], effects: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const cache = new Map<string, any>();
  const requests: Array<{ kind: string; task?: string; profile: string; resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  let cursor = 0, dirty = false, profile = 'default', task: string | undefined = 'task-a', initial: any;
  const queue = (kind: string, target?: string, selected = profile) => new Promise((resolve, reject) => requests.push({ kind, task: target, profile: selected, resolve, reject }));
  const same = (a: any[] | undefined, b: any[]) => a && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial: any) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
      return [slots[at], (next: any) => { const value = typeof next === 'function' ? next(slots[at]) : next; dirty ||= !Object.is(value, slots[at]); slots[at] = value; }];
    },
    useRef(initial: any) { const at = cursor++; return slots[at] ??= { current: initial }; },
    useCallback(callback: any, deps: any[]) { const at = cursor++; if (!same(slots[at]?.deps, deps)) slots[at] = { deps, callback }; return slots[at].callback; },
    useEffect(run: () => any, deps: any[]) {
      const at = cursor++, old = slots[at];
      if (!same(old?.deps, deps)) effects.push(() => { old?.cleanup?.(); slots[at] = { deps, cleanup: run() }; });
    },
  };
  const exported: any = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: exported, console,
    window: { addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) },
    require: (name: string) => name === 'react' ? hooks : name === '../lib/api' ? {
      fetchAgentDefaults: (selected?: string) => queue('defaults', undefined, selected),
      fetchTaskAgentSettings: (id: string, selected?: string) => queue('settings', id, selected),
      fetchAgentModels: (selected?: string) => queue('models', undefined, selected),
    } : name === '../lib/profileQuery' ? { activeProfileIdFromWindow: () => profile }
      : name === '../lib/agentDefaultsCache' ? {
        readCachedAgentDefaults: (selected = 'default') => cache.get(selected) ?? null,
        writeCachedAgentDefaults: (value: any, selected = 'default') => cache.set(selected, value),
      } : dependency(name),
  });
  const render = () => {
    let result: any, count = 0;
    do {
      dirty = false; cursor = 0; result = exported.useAgentConfig(task, initial, profile);
      while (effects.length) effects.shift()!();
      if (++count > 20) throw new Error('Hook did not settle');
    } while (dirty);
    return result;
  };
  return { render, requests, cache,
    select(nextTask: string | undefined, nextProfile = profile, nextInitial?: any) { task = nextTask; profile = nextProfile; initial = nextInitial; return render(); },
    refresh() { for (const listener of listeners) listener(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

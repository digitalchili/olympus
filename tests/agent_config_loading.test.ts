import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { configHarness, currentConfigSource, flushConfig } from './fixtures/perf-config-hook.js';

const defaults = { model: 'default-model', provider: 'default-provider', reasoningEffort: 'medium', baseUrl: null, apiMode: null, showReasoning: true };
const settings = (model = 'saved-model') => ({ defaults, task: { model, provider: 'saved-provider', reasoningEffort: 'high' } });
const models = { groups: [], defaultModel: 'irrelevant-catalog-model', activeProvider: 'catalog-provider' };

if (process.env.PERF_CONFIG_BASELINE === '1') {
  const baseline = execFileSync('git', ['show', '9ba0fd67:client/src/hooks/useAgentConfig.ts'], { encoding: 'utf8' });
  const samples: Array<{ label: string; readyMs: number }> = [];
  for (let sample = -2; sample < 30; sample++) {
    const pair = [['released-0.7.20', baseline], ['working-tree', currentConfigSource()]];
    if (sample % 2) pair.reverse();
    for (const [label, source] of pair) {
      const h = configHarness(source); const started = performance.now(); h.render();
      h.requests[0].resolve(settings()); await flushConfig();
      const readyWithCatalogHeld = !h.render().isLoading;
      let readyMs = readyWithCatalogHeld ? performance.now() - started : null;
      await new Promise(resolve => setTimeout(resolve, 150));
      const releasedAtMs = performance.now() - started;
      h.requests[1].resolve(models); await flushConfig();
      readyMs ??= performance.now() - started;
      assert.equal(h.render().model, 'saved-model'); assert.equal(h.render().provider, 'saved-provider'); assert.equal(h.render().reasoningEffort, 'high');
      console.log(JSON.stringify({ label, sample, warmup: sample < 0, readyWithCatalogHeld, readyMs, releasedAtMs, selectedSettingsPreserved: true }));
      if (sample >= 0) samples.push({ label, readyMs });
      h.unmount();
    }
  }
  for (const label of ['released-0.7.20', 'working-tree']) {
    const times = samples.filter(s => s.label === label).map(s => s.readyMs).sort((a, b) => a - b);
    console.log(JSON.stringify({ summary: label, count: times.length, medianMs: (times[14] + times[15]) / 2, p95Ms: times[Math.ceil(times.length * .95) - 1] }));
  }
} else {
  {
    const h = configHarness(); h.render(); h.refresh();
    h.requests.findLast(r => r.kind === 'defaults')!.reject(new Error('refresh unavailable'));
    h.requests[0].resolve(settings()); await flushConfig();
    assert.equal(h.render().defaults?.model, 'default-model', 'an optional refresh failure cannot discard required settings');
    h.unmount();
  }
  {
    const h = configHarness(); h.render();
    h.requests[0].resolve(settings()); await flushConfig();
    assert.equal(h.render().model, 'saved-model', 'saved settings apply while the optional catalog remains unresolved');
    assert.equal(h.render().provider, 'saved-provider'); assert.equal(h.render().reasoningEffort, 'high');
    assert.equal(h.render().isLoading, false); assert.equal(h.render().isLoadingModels, true);
    h.requests[1].reject(new Error('private catalog error')); await flushConfig();
    assert.equal(h.render().model, 'saved-model'); assert.equal(h.render().settingsError, null);
    assert.equal(h.render().isLoadingModels, false); h.unmount();
  }
  {
    const h = configHarness(); h.render(); h.requests[1].resolve(models); await flushConfig();
    assert.equal(h.render().isLoading, true, 'catalog readiness never authorizes use of unknown task settings');
    h.render().setModel('explicit-model'); h.render().setProvider('explicit-provider'); h.render().setReasoningEffort('low');
    h.requests[0].resolve(settings()); await flushConfig();
    assert.equal(h.render().model, 'explicit-model'); assert.equal(h.render().provider, 'explicit-provider'); assert.equal(h.render().reasoningEffort, 'low');
    h.refresh(); h.render().setModel('newer-choice');
    h.requests.findLast(r => r.kind === 'defaults')!.resolve({ ...defaults, model: 'late-default' });
    await flushConfig(); assert.equal(h.render().model, 'newer-choice');
    h.refresh(); h.render().replaceDefaults({ ...defaults, model: 'explicit-default' });
    h.requests.findLast(r => r.kind === 'defaults')!.resolve({ ...defaults, model: 'old-default' });
    await flushConfig(); assert.equal(h.render().defaults.model, 'explicit-default'); h.unmount();
  }
  {
    const h = configHarness(); h.cache.set('default', defaults); h.render();
    h.requests[0].reject(new Error('private upstream detail')); await flushConfig();
    assert.equal(h.render().isLoading, false); assert.ok(h.render().settingsError);
    assert.doesNotMatch(h.render().settingsError, /private/);
    const count = h.requests.filter(r => r.kind === 'models').length;
    h.render().retrySettings(); h.render();
    assert.equal(h.render().isLoading, true); assert.equal(h.render().settingsError, null);
    assert.equal(h.requests.filter(r => r.kind === 'models').length, count, 'settings retry does not wait for or restart model discovery');
    h.requests.findLast(r => r.kind === 'settings')!.resolve(settings()); await flushConfig();
    assert.equal(h.render().model, 'saved-model'); assert.equal(h.render().settingsError, null); h.unmount();
  }
  {
    const h = configHarness(); h.render();
    h.select('task-b', 'named');
    assert.equal(h.render().defaults, null); assert.equal(h.render().model, null); assert.equal(h.render().isLoading, true);
    assert.equal(h.requests[2].profile, 'named'); assert.equal(h.requests[2].task, 'task-b');
    h.requests[2].resolve(settings('named-model')); h.requests[3].resolve(models); await flushConfig();
    h.requests[0].resolve(settings('wrong-old-model')); h.requests[1].resolve({ ...models, groups: [{ provider: 'old' }] }); await flushConfig();
    assert.equal(h.render().model, 'named-model'); assert.equal(h.render().modelGroups.length, 0);
    assert.equal(h.cache.has('default'), false, 'late old settings do not write even their cache');
    h.select('task-b', 'other'); assert.equal(h.render().model, null); assert.equal(h.render().isLoading, true);
    assert.equal(h.requests[4].profile, 'other', 'same task ID under another profile requires fresh settings');
    h.unmount(); h.requests[4].resolve(settings('unmounted')); await flushConfig(); assert.equal(h.cache.has('other'), false);
  }
  {
    const previousWindow = (globalThis as any).window, previousFetch = globalThis.fetch;
    const storage = new Map<string, string>(), urls: string[] = [];
    (globalThis as any).window = { location: { search: '?profile=wrong-profile' }, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } };
    try {
      const { readCachedAgentDefaults, writeCachedAgentDefaults } = await import('../client/src/lib/agentDefaultsCache.js');
      writeCachedAgentDefaults(defaults as any, 'named');
      assert.equal(readCachedAgentDefaults('other'), null, 'another profile cannot read the named defaults cache');
      assert.equal(readCachedAgentDefaults('named')?.model, 'default-model');
      globalThis.fetch = async input => { urls.push(String(input)); return Response.json({}); };
      const { fetchAgentDefaults, fetchTaskAgentSettings } = await import('../client/src/lib/api.js');
      await fetchAgentDefaults('named'); await fetchTaskAgentSettings('task-a', 'named');
      assert.deepEqual(urls, ['/api/agent/defaults?profile=named', '/api/tasks/task-a/agent-settings?profile=named']);
    } finally { (globalThis as any).window = previousWindow; globalThis.fetch = previousFetch; }
  }
  console.log('Agent configuration loading tests passed');
}

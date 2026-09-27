# P3 evidence — 2026-09-27

Base: `9ba0fd6`, local `codex/response-performance` worktree. Node v22.22.3, macOS arm64, Apple Git 2.54.0. Only disposable Git repositories and SQLite databases were used. No model calls, live account/installation operation, commit or publication.

## Implementation boundaries

`SourceIdentity` retains the exact existing HEAD/path/mode/content/symlink/deletion hash. Baseline capture, post-check freshness, evidence-read freshness and repair freshness now request identity only. Full verification snapshots still include unchanged diagnostics against the original baseline revision. Old JSON baselines remain readable without rewriting data. No source cache, metadata shortcut, generated-file exclusion, admission reordering, or task limit was added.

The evidence panel uses one verification/recovery fetch pair per task/profile generation, waits for both requests to settle even if one fails, schedules the next read after settlement (1s active / 10s idle), and pauses hidden-tab reads. Returning to visibility queues a fresh read. Explicit actions still execute immediately; if their read is already in flight or the tab is hidden, their follow-up freshness read waits for settlement/visibility. Superseded reads and old task/action completions cannot update the new generation. No global cache or polling framework was added.

## Before/after measurement

Before production edits: `node --import tsx tests/fixtures/source-identity-benchmark.ts` (30 warm samples after two warmups). After extraction: `node --import tsx tests/fixtures/source-identity-benchmark.ts --after`, alternating the frozen `9ba0fd6` oracle and new identity reader in the same process, 30 samples of each after two warmups. Fixtures contain 20 x 1KiB or 1,000 x 8KiB tracked text files; half are modified before scanning. Every result is checked against the original hash. A local shell wrapper counts each real Git invocation and adds the same per-invocation instrumentation overhead to both variants. Timings include ordinary concurrent development load; they are synthetic local scan measurements, not cold-machine, end-to-end Send, provider or Hermes Desktop measurements.

Git invocations per identity-only scan fall from five to two. Actual baseline capture still performs its unchanged enclosing-root probe, making that path six to three. Payload bytes below describe the baseline/source object itself, excluding the rest of the evidence JSON. All file bytes are still read for freshness.

| Repository | Variant | Median ms | p95 ms | Git invocations | Object JSON bytes |
|---|---|---:|---:|---:|---:|
| small | before | 230.1 | 511.0 | 5 | 22639 |
| small | after | 80.3 | 263.7 | 2 | 132 |
| large | before | 879.1 | 1220.6 | 5 | 265219 |
| large | after | 339.0 | 578.5 | 2 | 132 |

The earlier pre-edit medians were 158.9ms small / 684.4ms large. The paired comparison shows a material improvement on these dirty fixtures; clean/smaller diffs and other storage or load may have different gains.

## Regression evidence

- RED: `node scripts/run-tests.mjs tests/source_identity.test.ts` failed because the identity-only export was absent. The independent frozen oracle is copied from `9ba0fd6`, not composed from the new function.
- RED: `node scripts/run-tests.mjs tests/coding_evidence_polling.test.ts` exercised the original component: five polling ticks while the first pair remained unresolved started 12 requests instead of two.
- Additional RED cases caught a queued visibility refresh starting after the tab became hidden again, and an old action leaving a newly selected task busy. Both now pass.
- GREEN: `node scripts/run-tests.mjs tests/source_identity.test.ts tests/coding_verification.test.ts tests/verification_lifecycle.test.ts tests/verification_repair.test.ts tests/coding_evidence_polling.test.ts` passed. Lifecycle: 26/26; repair: 10/10; all three assertion-based suites passed.
- Identity cases cover clean, modified, staged, untracked, deleted, executable-bit, symlink and retargeted-symlink states; identical HEAD/length/restored mtime edits; nested workdirs; unsupported embedded repositories; old JSON; unchanged pre-agent baseline; and abort. The original full snapshot remains byte-for-byte equivalent to the frozen oracle.
- A real Git latch holds an older evidence scan while a later scan independently detects same-length/restored-mtime changes. Stop during baseline capture retains ownership until cancellation settles and starts zero model requests. Existing source-modifying checks and unchanged failing repairs remain blocked.
- Real component/hook callbacks cover slow pairs, partial failure with a still-pending peer, both polling cadences, hidden mount/hide/show, queued fresh reads, late task/profile results, old actions, queued recovery wait text, and unmount cleanup.
- GREEN: `node scripts/run-tests.mjs tests/verification_workspace_binding.test.ts tests/verification_shutdown.test.ts tests/verification_progress.test.ts tests/project_task_isolation.test.ts` passed all four assertion-based suites. Root owns integrated typecheck/full-suite and P4 end-to-end evidence.
- Extraction review found an abort boundary previously supplied by the first diagnostic Git call: cancellation during the final asynchronous symlink read. A real-filesystem test that aborts immediately after that read failed first, then passed with a final `throwIfAborted()` before returning identity. The hash bytes are unchanged.

## Raw timing records

Pre-edit capture (median recalculated from retained raw samples using the conventional average of the middle two):

```jsonl
{"name":"small","variant":"before","files":20,"bytes":20480,"samples":30,"medianMs":158.9085,"p95Ms":225.40445799999998,"gitProcesses":5,"payloadBytes":22639,"rawMs":[171.452,248.441,197.958,148.998,149.471,184.951,150.783,137.442,167.271,163.516,154.585,161.148,158.373,156.982,151.276,203.411,159.444,143.266,154.784,172.82,205.567,148.324,152.264,177.798,225.404,148.976,127.876,167.271,175.744,150.716]}
{"name":"large","variant":"before","files":1000,"bytes":8192000,"samples":30,"medianMs":684.354,"p95Ms":989.9327499999999,"gitProcesses":5,"payloadBytes":265219,"rawMs":[691.016,709.817,618.255,575.696,686.767,737.698,836.545,809.841,701.726,606.374,621.171,2103.337,989.933,784.018,747.4,644.769,661.808,776.121,817.471,683.998,640.168,660.291,626.314,630.278,582.967,574.003,539.122,684.71,601.411,685.267]}
```

Final-code paired comparison (same 30 samples per variant; additional concurrent development load is visible in the raw timings):

```jsonl
{"name":"small","variant":"before","files":20,"bytes":20480,"samples":30,"medianMs":230.10485449999987,"p95Ms":510.996709,"gitProcesses":5,"payloadBytes":22639,"rawMs":[510.997,710.05,158.425,273.545,238.08,172.832,173.147,137.639,242.922,233.063,239.625,242.821,227.147,217.292,372.088,393.562,336.335,303.388,222.065,150.746,243.534,154.139,206.483,146.744,198.275,207.589,489.97,211.981,150.162,302.805]}
{"name":"small","variant":"after","files":20,"bytes":20480,"samples":30,"medianMs":80.3397500000001,"p95Ms":263.723833,"gitProcesses":2,"payloadBytes":132,"rawMs":[116.762,87.835,81.794,98.6,67.385,78.886,65.845,65.947,97.973,104.619,90.791,151.956,71.759,263.724,126.16,103.356,154.688,95.555,61.758,65.404,67.698,76.356,63.892,65.552,63.984,414.783,98.647,68.482,57.452,75.435]}
{"name":"large","variant":"before","files":1000,"bytes":8192000,"samples":30,"medianMs":879.0615630000011,"p95Ms":1220.5697080000027,"gitProcesses":5,"payloadBytes":265219,"rawMs":[611.76,694.188,944.581,933.931,795.375,826.236,1182.459,769.178,820.869,747.448,604.223,873.55,618.014,761.858,797.665,714.657,817.48,707.75,1059.364,884.573,953.904,1136.676,1220.57,1136.694,1756.984,939.715,971.383,924.966,1098.09,1057.648]}
{"name":"large","variant":"after","files":1000,"bytes":8192000,"samples":30,"medianMs":338.9772290000019,"p95Ms":578.4916669999948,"gitProcesses":2,"payloadBytes":132,"rawMs":[194.351,338.892,342.517,186.051,314.19,339.063,330.344,212.105,333.869,241.276,263.085,388.625,241.71,296.791,306.886,318.173,241.274,204.173,452.523,406.266,578.492,679.676,462.402,465.379,441.992,565.202,483.416,428.226,507.052,391.875]}
```

## P4 appendix: new Project task workspace versus reuse

Command: `node --import tsx tests/fixtures/project-preparation-benchmark.ts > qa/response-performance-project-preparation.csv`. The fixture reuses the real local bare-Git / SQLite setup from `tests/project_task_isolation.test.ts`; no production code changes. Raw records are in [response-performance-project-preparation.csv](response-performance-project-preparation.csv).

Seed: 20 tracked files x 1KiB, one local bare remote, one Project, isolated state and Hermes home. The initial pair creates the Project's first baseline and first task workspace. Two subsequent warmup pairs precede 30 measured pairs; each pair prepares a new task from the already downloaded baseline, writes an uncommitted sentinel outside timing, then prepares that same task again. Task-row creation, fixture setup and preservation assertions are outside the timed `prepareTask` call. All operations run sequentially; ordinary concurrent development load remains a source of variance.

| Case | Samples | Median ms | p95 ms | Git processes per call | Clone source |
|---|---:|---:|---:|---:|---|
| Initial Project/task preparation | 1 | 1143.081 (single elapsed value) | Not estimated | 10 | One local bare remote → baseline, one baseline → task |
| Initial workspace reuse | 1 | 27.901 (single elapsed value) | Not estimated | 1 | None |
| New task, retained baseline | 30 | 524.289 | 590.118 | 13 | One retained baseline → task |
| Reuse same task workspace | 30 | 32.332 | 47.596 | 1 | None |

All 33 pairs passed the hard assertions: no `fetch`, `ls-remote` or publication; no token-provider invocation; only the initial Project preparation clones the fake remote; each later new task clones the retained local baseline; reuse returns the same lease and path, invokes one local Git worktree probe, and preserves the uncommitted sentinel. All temporary repositories and databases were removed.

The initial row is a first-use sample after fixture and module setup, not a cold operating-system cache/worker or real network test. These values measure workspace preparation only, not Send-to-first-answer or a before/after optimization. They support the narrower conclusion that an existing task does not fetch/clone on each message. Real GitHub transport, large Project clones and provider latency remain unmeasured here.

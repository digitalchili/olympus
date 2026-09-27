# Response performance evidence

Implemented and measured 27 September 2026 against released **v0.7.20 / 9ba0fd67e6559746a069451dce6bb9c2b35add5a**. The historical plan's v0.7.18 baseline predates the already released threaded model-discovery work; this change does not claim credit for that fix.

## Conclusions and limits

- Required settings no longer wait for optional model discovery. The real composers preserve saved profile/model/provider/reasoning, retain drafts on settings failure, and require successful settings recovery before sending.
- Source identity remains byte-for-byte equivalent to the frozen released algorithm. Identity-only reads run two Git commands instead of five; they still read and hash all relevant file bytes. No source cache, timeout, concurrency increase or model/reasoning reduction was introduced.
- Evidence polling no longer overlaps, pauses while hidden, coalesces explicit refreshes into a fresh follow-up, and ignores previous task/profile results.
- Opt-in stage metadata separates admission, native work and post-answer verification. Collection remains disabled by default and never logs conversation content or credentials.
- Synthetic browser and Docker delivery passed. These results do **not** establish production OpenAI latency, native cold-worker/history cost, actual browser paint timing, or a speed comparison with Hermes Desktop. The actual Desktop installation was not operated.

## Environment and method

macOS arm64, Node 22.22.3, local SQLite/Git, repository dependencies already installed. Disposable temporary Hermes home/database/workspaces; fake adapter, no provider calls or user transcripts. One sequential fixture run at a time. Other local review/test work sometimes competed for CPU/storage, and Vite development mode was used for the browser. Route before/after runs were sequential, not alternated; cache/order/load bias prevents treating small differences as controlled speedups.

The baseline source was exported with `git archive 9ba0fd6` into a temporary directory with the same dependencies. Each route case had two warmups and 30 warm samples, fixed output and three 20ms fake-agent waits. Small Git: 32 files × 4,096 bytes. Large Git: 512 files × 16,384 bytes. Long-history fixture: 1,000 generated rows, each with 256 filler bytes; the fake adapter serializes/parses these rows, **not native Hermes SessionDB**. The Bot case reuses its canonical session. First sample (`index=-2`) is preserved separately; it is a fresh-fixture request, **not a measured cold native worker**.

Raw measurements: [route samples](response-performance/route-samples.csv), [opt-in diagnostic stages](response-performance/diagnostic-stages.csv), [browser samples](response-performance/browser-samples.csv), [Docker delivery](response-performance/docker-delivery.json). Timing values are milliseconds. CSV rounds to three decimals; original browser UI uses nearest-rank percentiles, while this report uses the average of the two middle samples for median.

## Required settings / held catalog

The real transpiled hook ran 2 warmups + 30 paired alternating samples per revision. Settings resolved immediately; the catalog remained held for 150ms. Released readiness median/p95: **152.154 / 164.154ms**. Updated: **0.594 / 15.614ms**. Every updated sample became ready while the catalog was held; all samples preserved the saved model/provider/high reasoning. This isolates a removed dependency, not real-network latency. Raw hook samples are in `response-performance/catalog-samples.jsonl`.

The real TaskChat browser fixture, named profile, verified:

1. A message was sent once with `saved-model`, `saved-provider`, `high` while the catalog remained held.
2. First answer text was visible while the run was still streaming and the picker still showed **Loading models…**.
3. Releasing the catalog did not change the selected settings or submit another message.
4. A required-settings failure kept the draft editable and Send disabled. **Retry settings** recovered the saved choices without losing the draft; the retained message then sent once while the catalog stayed held.

Hook/composer tests also cover opposite completion order, task/profile switches, late defaults versus explicit selections, optional catalog failure, and retry isolation. Worker responsiveness remains covered by the existing threaded-reader regression.

## Exact repository identity

See [P3 oracle and paired measurements](response-performance-p3-evidence.md) for the independent released-algorithm oracle, restored-mtime edits, symlinks/modes/deletions, cancellation gates, polling tests and raw arrays. Final paired local medians: small **230.1→80.3ms**, large **879.1→339.0ms**. Identity payloads shrink to 132 bytes by excluding unused diagnostics. Full snapshots still include their actual changed paths and diff; missing baseline diagnostics are not invented.

## Real-route integration

Real Project preparation was also measured against a disposable local bare remote: one initial baseline download/task clone took 1,143ms, with immediate reuse 28ms (single first-use sample, not cold OS/network). After two warmups, 30 paired new-task/reuse samples measured **524ms median / 590ms p95** for a new task from the retained baseline, and **32ms median / 48ms p95** for the same workspace. Reuse performed one local Git probe; every pair preserved its lease/path and uncommitted sentinel without fetch, push or credential calls. This is current-version characterization, not a before/after clone-speed claim. The [P3 appendix](response-performance-p3-evidence.md) contains the reproducible command and [raw samples](response-performance-project-preparation.csv).

The HTTP client subscribes before sending. Assertions require one agent invocation, exact ordered thinking/text/text/done events, complete unduplicated text, and durable run status `done`. All 320 warmup/warm samples passed (160 before, 160 after). The after run enabled diagnostics to exercise their actual boundaries; the before run has none. These are observed local timings with the load/cache caveat above.

| Case | First answer received, before median / p95 | After median / p95 | Send to fake-agent start, before median / p95 | After median / p95 |
|---|---:|---:|---:|---:|
| Plain | 45.91 / 47.99 | 48.22 / 65.21 | 2.99 / 5.00 | 4.48 / 13.34 |
| Bot | 48.86 / 55.86 | 48.51 / 81.42 | 5.64 / 12.70 | 5.02 / 20.55 |
| Small Git | 196.64 / 310.58 | 181.26 / 401.90 | 153.02 / 267.65 | 137.96 / 345.20 |
| Large Git | 485.00 / 974.85 | 318.08 / 623.41 | 441.49 / 931.35 | 275.78 / 581.59 |
| Synthetic long history | 50.68 / 58.39 | 47.16 / 48.49 | 6.57 / 12.73 | 4.06 / 5.93 |

`sendToFakeAgentStart` includes loopback HTTP/admission and synthetic history parsing; it is not pure server overhead. Earlier raw logs called that field `serverPreparation`; the CSV normalizes the corrected name. The warm plain-chat measured upper bound p95 (13.34ms) meets the diagnostic 250ms preparation target in this fixture. Plain-chat first-answer latency did not improve here. Small-repository tail latency and verification time were noisy; the isolated alternating identity benchmark is stronger evidence for the removed Git work. Large-repository preparation remains proportional to bytes/files and is reported separately.

Send→202, Send→first activity, native-done→terminal and complete per-stage records are preserved in the CSV files. They must not be substituted for first-answer time. The deterministic stage tests additionally assert inventory40ms, baseline80ms and first-text150ms as separate values, missing stages absent, idempotent Stop/error/rejection, no HTTP-provided trace IDs, and silence when disabled.

## Browser rendering and Docker delivery

The real `useChat` hook used actual fixture HTTP/SSE with three 800ms producer waits so intermediate output could be observed. Two warmups + 30 warm samples: receive→React DOM commit median **1.65ms**, p95 **2.60ms**; all 30 first answers committed while streaming continued; no failures. This meets the fixture's 100ms render target. It is a commit measurement, not a browser paint timestamp, and does not benchmark a production Markdown-heavy long conversation. See the sample CSV for Send→accepted, first activity, first received text, first committed answer and terminal values.

Docker Engine29.4.0 (OrbStack), repository `deploy/nginx/nginx.conf`, local disposable `nginx:1.27-alpine` image (amd64 emulation on arm64). Three direct and three proxy runs all delivered separate chunks before completion, with the intentional ~800ms gaps observable. No compression/content accumulation appeared. Reconnecting after completion recovered the exact terminal snapshot and complete text, with one agent start. This verifies the bundled proxy configuration, not the live Dokploy/Tailscale proxy. The existing reconnect regression separately covers snapshot expiry and durable history without resending.

## Reproduce

```sh
# Real routes, local fake adapter, two warmups and 30 samples per case.
OLYMPUS_PERF_DIAGNOSTICS=1 node --import tsx tests/fixtures/response-performance-server.ts --benchmark
# Same fixture against the exported baseline source (same dependencies).
PERF_SOURCE_ROOT=/absolute/path/to/baseline node --import tsx tests/fixtures/response-performance-server.ts --benchmark
# Real-hook browser fixture; open the printed local URL.
PERF_PORT=4191 node --import tsx tests/fixtures/response-performance-server.ts --ui
# For Docker access, start the disposable fake server with PERF_HOST=0.0.0.0.
# With repository Nginx locally forwarding port4192 to the fixture4191:
node tests/fixtures/response-performance-delivery.mjs http://127.0.0.1:4191 http://127.0.0.1:4192
# P2 browser fixture (no real network/model writes):
node node_modules/vite/bin/vite.js --config tests/fixtures/vite.config.ts --port 4196 --strictPort
```

Use `/tests/fixtures/perf-config.html?profile=named` and add `&settings=fail` for recovery. Browser timing route: `/tests/fixtures/response-performance.html`. Stop the fixture processes and remove only their disposable Docker container/directory after QA. No fixture endpoint is mounted by the production app.

## Remaining operational measurements / Desktop comparison

Native cold-worker setup, native long-history loading, production CPU throttling/memory pressure/disk latency, browser-to-server RTT and a same-settings Desktop comparison remain unmeasured. Keep existing history/subscription hydration and frame batching: changing them without reproducing the completion/reconnect race is outside this fix.

For a fair operator-run comparison, record Olympus, Hermes core and Desktop revisions; actual provider/model/reasoning; identical prompt/history/tools/skills/collaboration; fresh versus warm state and concurrent load. Compare ordinary chat first, Git tasks separately. With explicit approval for those real model calls, alternate at least ten low-cost trials per app, record all failures, first activity, first answer and completion, and note cache/order/network/CPU/storage differences. A remote server versus local Desktop comparison measures the whole experience. Different versions/settings make the result confounded. Do not lower reasoning globally or add task deadlines to improve the score.

## Verification status

Focused P1/P2/P3 regressions and independent reviews passed. `npm test`, `npm run typecheck`, `npm run build` and `git diff --check` all passed. The full suite emitted a non-failing Vite dependency-scan shutdown/port warning from its Markdown fixture; the production build emitted the existing large-chunk warning. Native-dependent Python cases retained their explicit skips; no skipped native check is presented as runtime proof. Disposable browser pages, both fixture servers and the Docker proxy were stopped after QA. Live updater configuration remains a separate installation operation; these code results do not establish that the live Update button is repaired.

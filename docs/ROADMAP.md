# Olympus Roadmap

**Status:** Canonical product-direction index
**Last reconciled:** 2026-08-15
**Source of truth:** This file in the `digitalchili/olympus` GitHub repository
**Scope:** Product direction, architecture invariants, capability sequencing, and idea provenance. Detailed implementation belongs in linked plans.

## North star

> **Olympus is a privacy-bounded control plane for reconstructable delegated work.**

Olympus coordinates Projects, tasks, workers, evidence, approvals, source revisions, previews, and releases. It is not an agent harness and does not own private worker reasoning or full profile transcripts.

### Core principle

> **Olympus never trusts agent assertions when machine-verifiable evidence is available.**

### Non-negotiable architecture

1. Record bounded workflow facts, not complete agent transcripts.
2. Canonical workflow history is immutable and append-only. Mutable tables and UI state are projections.
3. Private prompts, memories, hidden reasoning, and unrelated profile sessions remain profile-owned.
4. Workers submit claims and evidence. Olympus policy decides whether evidence satisfies a transition.
5. Capabilities are enforced at server, adapter, and tool seams—not merely described in prompts.
6. Privileged actions are server-owned commands tied to exact revisions and approvals.
7. GitHub is canonical source history; rollback creates a new revert commit and never rewrites history.
8. Qdrant is derived retrieval only and never canonical workflow truth.
9. No Cordis import, DeepSeek Harness runtime dependency, or arbitrary model-written workflow JavaScript.
10. Michael remains final authority for priority, approval, merge, release, and production promotion.
11. Pecker is an internal isolated Olympus/Hermes development profile, not a public Project, product feature, customer-facing identity, or architecture layer.

## Authority chain

```text
Postgres  -> target canonical Project/workflow/event truth
GitHub    -> canonical source truth
Dokploy   -> canonical deployment execution and observed status
Qdrant    -> derived semantic retrieval only
Workers   -> scoped execution and submitted claims/evidence
Olympus   -> policy, verification, approval, coordination and projection
Michael   -> final authority
```

Olympus v0.5.1 currently persists local control-plane state in SQLite. New contracts must remain deterministic and portable so the canonical event ledger can move to Postgres without changing event identity or semantics. SQLite implementation is current deployment fact; Postgres is the target authority boundary, not a feature that should be falsely marked shipped.

## Status vocabulary

| Status | Meaning |
|---|---|
| `shipped` | Verified in a merged release/source revision. |
| `active` | Being implemented on an identified branch/task; not yet shipped. |
| `active-prototype` | A narrow subset is implemented, but the canonical contract and merge requirements are incomplete. |
| `merge-blocker` | Must be resolved before an overlapping active branch may merge. |
| `approved-next` | Architecture accepted and ordered next, but implementation has not started. |
| `candidate` | Valuable idea requiring design or sequencing. |
| `deferred` | Intentionally postponed. |
| `not-pursuing` | Rejected, with the reason retained to prevent repeated reconsideration. |

A chat answer, worker message, local diff, or passing focused test is not `shipped` evidence.

## Current baseline

Verified in the v0.5.1 source baseline (`e5e6807f5afb4f3bd8dbb2e98661d325e56fc387`):

- local Hermes profile discovery and profile-owned workers;
- profile-scoped tasks, collaboration, task handoffs, and sanitized delegation visibility;
- global Projects with manager history, ACL grants, Project task routing, repository links, and references;
- task-scoped repository preparation, one active Project editor lease, and immutable Project `commit_push`/`revert` version records;
- readiness, graceful drain, portable native/Docker installation, and update foundations;
- a curated skill-catalog surface and protected Project reference ingestion.

These are foundations to extend, not reasons to duplicate Project identity, leases, versions, delegation tables, or reference storage under new names.

## Active implementation: task-control foundation

**Branch/worktree:** `feat/control-plane-foundation` / `worktrees/control-plane-foundation`
**Source state when reconciled:** uncommitted implementation based on v0.5.1 plus focused test evidence. It is not shipped.

The active task is a valid narrow proving slice for:

- immutable, monotonic task snapshots with deterministic hashes;
- explicit task-control states: `dispatched -> implemented -> submitted -> verified -> releasable`;
- append-only attributable verification evidence;
- worker claims separated from independent system verification;
- worker denial for `verified` and `releasable` authority;
- human approval before `releasable`;
- a completion gate requiring the policy state to be releasable.

### Reconciliation requirements before merge

The active work must converge with the canonical direction rather than establish parallel concepts:

| Active foundation concept | Canonical relationship | Required reconciliation |
|---|---|---|
| `task_snapshots` | Immutable dispatch contract | Keep. Add exact repository/base SHA, selected decision/document revisions, attachment hashes, dispatch-payload hash, required checks, and capability-lease reference. A new contract produces a new snapshot. |
| `task_control_events` | Task-local transition facts | Do not let this become a competing event ledger. Emit the canonical `control_events` envelope, or explicitly define this table as a task-domain append source projected into `control_events`. Decide before merge. |
| `task_verification_evidence` | Append-only evidence facts | Keep as immutable evidence records attributable to snapshot, producer, source revision/deployment, observation time, and policy evaluation. Enforce append-only behavior in storage. |
| snapshot `capabilities[]` | Coarse prototype grant | Replace or back with immutable capability leases containing Project/repository/path/tool/budget/network/side-effect scope, issuer, subject, expiry, and supported-adapter checks. |
| `implemented` | Worker implementation claim | Never imply verification. It may be entered only through a scoped worker action. |
| `submitted` | Receipt/evidence submitted | Bind to `olympus.run.receipt.v1` and referenced evidence IDs. |
| `verified` | Olympus policy decision | Require independent evidence for every snapshot check. Worker-produced evidence remains a claim. |
| `releasable` | Human approval decision | Bind approval to the exact snapshot, receipt, commit, artifacts, and policy result. Deployment remains a separate action and fact. |
| task board status | Mutable UI projection | Specify one mapping from control state; do not maintain an independent authority path through generic task-status mutation. |
| SQLite schema | Current local implementation | Preserve deterministic hashes, stable IDs, schema versions, and JSON semantics compatible with the Postgres target. |

### Immediate collision risks

1. **Two event ledgers:** general `control_events` versus task-only `task_control_events`.
2. **Two completion authorities:** board `done` versus `verified`/`releasable` policy state.
3. **Capability labels mistaken for enforcement:** a string array is not a scoped lease or operating-system boundary.
4. **Evidence mistaken for truth:** worker evidence and independent verifier evidence must remain distinguishable.
5. **Snapshot confused with actual model context:** a task snapshot is the dispatch contract; a Context Receipt records what was actually assembled and sent.
6. **SQLite prototype mistaken for target authority:** current storage and target authority must remain explicitly distinguished.

## Approved control-plane roadmap

### CP-001 — Canonical `control_events` and projectors

**Status:** `merge-blocker` for the active foundation; full projector/SSE work remains `approved-next`

The active branch already introduces `task_control_events`. Its relationship to the canonical event envelope must be settled before that branch merges: either emit `control_events` directly, or define `task_control_events` explicitly as a task-domain append source projected into `control_events`. A second independent workflow ledger is not acceptable.

Add a versioned append-only envelope for bounded workflow facts:

```text
event_id, schema_version, project_id, task_id,
aggregate_type, aggregate_id, event_type,
actor_type, actor_id, profile_id, runtime,
causation_id, correlation_id,
bounded_payload, payload_hash, created_at
```

Initial event families:

```text
task.snapshot_created
task.state_claimed
task.state_decided
context.bound
delegation.started
delegation.status_changed
delegation.settled
run.receipt_recorded
evidence.recorded
artifact.committed
approval.asked
approval.decided
action.requested
action.settled
project.version_pushed
preview.revision_created
task.review_requested
```

Requirements:

- current-state tables are rebuildable projections;
- projectors expose `as_of_event_id`;
- SSE carries event IDs and supports cursor resume/`Last-Event-ID`;
- unknown schema versions fail safely;
- events contain bounded control facts, never raw private transcripts or secrets.

### CP-002 — Immutable task snapshots

**Status:** `active-prototype`

The active prototype proves monotonic snapshot versions, deterministic payload hashing, and task binding. The remaining fields below—including exact source/reference/artifact hashes and a capability-lease ID—are merge requirements, not features already claimed as implemented.

Persist the exact dispatch contract:

- goal and acceptance criteria;
- Project/repository identity, base branch, and resolved base SHA;
- selected decision/document/reference revisions and their hashes;
- attached artifact/document hashes;
- required verification checks and policy version;
- capability-lease ID;
- worker adapter/runtime target;
- environment-policy descriptor without secrets;
- canonical dispatch-payload hash.

Snapshots are immutable. Any changed contract creates a new version and invalidates unapproved assumptions derived from an older snapshot.

### CP-003 — Privacy-preserving Context Receipts

**Status:** `approved-next`

A task snapshot records intended inputs. A Context Receipt records the actual bounded context assembled for one run:

- snapshot and run-attempt IDs;
- selected source IDs, exact revisions, and content hashes;
- ACL decision and policy version for each source;
- repository/branch/base SHA;
- provider, model, adapter, and tool-schema/policy hash;
- capability-lease ID;
- final assembled-context hash.

Full prompts, memories, hidden reasoning, and unrelated profile transcripts remain profile-owned. Olympus stores references and hashes sufficient for accountable reconstruction without becoming a transcript warehouse.

### CP-004 — `olympus.run.receipt.v1`

**Status:** `approved-next`

A model or worker saying “done” is not completion. Every terminal run produces a typed receipt:

```text
outcome: completed | blocked | failed | aborted |
         refused | timed_out | interrupted
summary, external_run_id, snapshot_id, context_receipt_id,
commit_sha, pull_request, tests[], artifacts[],
preview_revision, blocker, started_at, finished_at
```

Olympus validates referenced evidence before allowing policy transitions. A receipt may report successful execution without satisfying verification or release policy.

### CP-005 — Append-only, attributable verification evidence

**Status:** `active-prototype`

The active prototype records attributable evidence rows and separates worker claims from system verification. Storage-level update/delete prevention, evidence hashes, run-receipt binding, and supersession semantics remain merge requirements.

Minimum record:

```text
task_snapshot_id
run_receipt_id (when applicable)
verifier identity and version
evidence kind and subject
observed result
source URL / commit SHA / deployment ID / artifact ID
observed_at and recorded_at
evidence hash
policy decision reference
```

Requirements:

- worker-produced evidence is labelled as a claim;
- independent system verification is separately attributable;
- storage prevents update/delete of canonical evidence;
- superseding evidence appends a new record;
- `verified` requires passing independent evidence for every required snapshot check.

### CP-006 — Action-level capability leases

**Status:** `approved-next`

A lease binds:

- subject worker/run/profile;
- Project, repository, branch, and path scope;
- tool and action scope;
- network/resource/budget limits;
- allowed side effects;
- issuer, issue time, expiry, and revocation/settlement state;
- parent lease and delegation lineage;
- adapter capabilities confirmed before execution.

Examples:

```text
repo:read
branch:create
branch:write
tests:run
evidence:submit
artifact:publish
commit:request
preview:request
```

Reviewers cannot push. Implementers cannot deploy production. No worker silently mutates canonical decisions. A Hermes profile remains an identity/memory boundary—not an operating-system sandbox.

### CP-007 — Content-addressed task artifacts

**Status:** `approved-next`

Remove `MEDIA:` and transient worker-path archaeology as a workflow dependency:

1. validate bytes, type, size, and authorization;
2. persist immutably in the approved task artifact workspace;
3. calculate content hash and metadata;
4. record `artifact.committed`;
5. return an opaque artifact ID;
6. verify digest and ACL on download.

Project references and worker-produced artifacts remain separate resource classes but share content-integrity principles.

### CP-008 — Evidence-gated task and release transitions

**Status:** `active-prototype`

Canonical policy states retain the distinction between implementation, submission, verification, approval, and deployment. Workers may claim or submit only within a lease. Olympus policy owns verification. Human approval owns releasability. Deployment is a separate server action with its own receipt and observed status.

No task-status mutation seam may bypass this policy, including internal `updateTask` callers, import/migration helpers, HTTP routes, and background jobs. Completion must use one policy-aware function, or a narrowly named internal escape hatch whose callers and tests prove that an unreleasable task cannot become `done`. The board is a projection, not a second state authority.

### CP-009 — Server-owned direct commands

**Status:** `approved-next`

The following bypass model interpretation and execute through guarded server pipelines:

- approve exact snapshot/revision;
- commit and push task branch;
- revert by new commit;
- create/refresh/expire preview;
- publish or promote;
- cancel run;
- invite profile;
- transfer/release capability or editor lease.

Each action records requested and settled facts, exact target hashes, authorization basis, result, and blocker. Merge and production promotion remain separate approvals.

### CP-010 — Doctor, invariants, and replay fixtures

**Status:** `approved-next`

Add runtime and CI checks proving:

- no active Project editor/capability lease collision;
- no terminal state regression;
- no approval without exact target hashes;
- no Project source enters context without effective ACL;
- no child exceeds its parent capability lease;
- every artifact resolves and matches its digest;
- every pushed Project version resolves to GitHub source truth;
- every deployment observation names an exact revision/deployment ID;
- restart-orphaned attempts become explicitly `interrupted`;
- keyless fixture replay rebuilds the same projections and SSE cursors.

### CP-011 — Durable run attempts, queues, and recovery

**Status:** `candidate`

Separate durable run/attempt identity from a live process activation. Persist queue state, attempt lineage, heartbeat, interruption, resumption, cancellation, and settlement. Existing in-memory live-run maps remain runtime aids, never canonical completion truth.

### CP-012 — Checkpoint forks and typed workflow DAGs

**Status:** `deferred`

Allow alternate work to branch from an explicit snapshot/event/revision with inherited source hashes and bounded capabilities. Later workflows may use validated typed DAGs with phases, dependencies, budgets, and approval gates. Arbitrary model-authored JavaScript remains prohibited.

## Product capability lanes

### Projects, identity, ACL, and privacy

**Current:** Global Projects, manager history, profile grants, Project task routing, repository links, and Project references exist.
**Next:** Event-backed Project activity, exact-source Context Receipts, approval records, and fail-closed Postgres authority migration.
**Rule:** Project-global means addressable inside Olympus, not readable by every profile.

### Source control and isolated execution

**Current:** Task-scoped repository preparation, editor leases, branch workspaces, commit/push checkpoints, and revert-version records exist.
**Next:** Capability leases, durable run attempts, exact-SHA approvals, branch/PR policy, and executor sandbox enforcement.
**Rule:** Prompted workdir is explanatory; filesystem/tool enforcement is the boundary. GitHub remains code truth.

### Delegation and collaboration

**Current:** Sanitized visible delegation, task handoffs, bounded collaboration, profile attribution, and terminal-state protection exist.
**Next:** Event-backed delegation lineage, parent-child capability inheritance, continuable child identity, typed settlement receipts, and explicit invitation approvals.
**Rule:** Only user-originated confirmed actions may invite profiles; assistant output cannot silently expand participation or authority.

### Artifacts, previews, visual review, and release

**Current:** Project references and path-derived task attachments exist; Project versions can name pushed commits.
**Next:** Content-addressed task artifacts, immutable preview revisions, Dokploy provider adapter, desktop/mobile evidence capture, exact-revision approval, annotations, expiry with retained evidence, and separate publish/promotion actions.
**Rule:** Approve a revision plus evidence—not a mutable task URL.

### Worker adapters and external providers

**Current:** Hermes workers are profile-owned; broad profile capabilities and a narrow Codex Cloud connector direction exist.
**Next:** Runtime action-capability negotiation, structured receipts, artifact publishing, fail-loud unsupported capabilities, and provider-specific evidence normalization.
**Rule:** Olympus owns Project/task/approval semantics; adapters translate provider behavior and cannot redefine authority.

### Knowledge, references, and retrieval

**Current:** Project references are validated, versioned, hashed, extracted, and searchable within ACL boundaries.
**Next:** Context Receipts, provenance-preserving source selection, Postgres canonical metadata, and Qdrant derived semantic indexing.
**Rule:** Finding a private file by searching canonical storage is a boundary bypass, not successful retrieval.

### Skills and extension governance

**Current:** Olympus ships a curated reviewed skills catalog and profile-scoped installation flows.
**Next:** Keep the private Digital Chili registry canonical, deterministic and bundle-hashed; add only narrow extension registries for worker providers, artifact renderers, preview providers, approval policies, and activity cards.
**Rule:** Extensions cannot redefine Project identity, ACL, event history, approvals, or audit semantics.

### Portability, updates, and recovery

**Current:** Native/Docker installation, readiness, graceful drain, and update foundations exist.
**Next:** Event/projector recovery checks, durable attempt reconciliation, backup/restore verification, Postgres migration, and single-writer promotion evidence.
**Rule:** Candidate updates are tested against disposable/cloned state before live promotion; no concurrent canonical writers.

## Sequencing

### Now — reconcile and finish the foundation

1. Keep the active task snapshot and evidence work isolated on `feat/control-plane-foundation`.
2. Decide the one canonical event-envelope relationship before merging `task_control_events`.
3. Define the policy-state-to-board-projection mapping and block generic bypasses.
4. Replace coarse capability labels with or explicitly migrate them to scoped lease records.
5. Bind `submitted` to `olympus.run.receipt.v1`.
6. Add append-only enforcement and migration/idempotency tests.
7. Verify targeted tests, full suite, typecheck, production build, replay/restart behavior, and built-worker integration.

### Next — reconstructable runs

1. Canonical `control_events` and projector cursor.
2. Context Receipts.
3. Structured run receipts and evidence validation.
4. Content-addressed task artifacts.
5. Activity/lineage UI with resumable SSE.
6. Direct approval and action records.
7. Doctor and keyless replay fixtures.

### Later — review and controlled automation

1. Immutable preview revisions and Dokploy lifecycle.
2. Visual artifacts, device screenshots, annotations, and structured revision feedback.
3. Durable run attempts, queues, cold resume, and lease recovery.
4. Exact-PR/SHA merge and separate production-promotion approvals.
5. Checkpoint forks and validated workflow DAGs.
6. Multi-human internal authentication only when real identity/authorization is designed; do not fake it through profile names.

## Idea intake and collision protocol

Every new Olympus idea from a task, chat, code review, external project, or incident should be reconciled here before a second implementation begins.

Each roadmap proposal must include:

```text
Roadmap ID
Problem and intended outcome
Source task/session/incident or external revision
Present / active / gap classification
Dependencies and overlapping roadmap IDs
Privacy/security implications
Proposed next slice
Decision and approver
```

Implementation rules:

1. Every Olympus implementation task names its roadmap IDs and exact base revision.
2. Before work starts, inspect merged source, open branches/worktrees, and existing plans for overlap.
3. One integration owner decides shared schema and contract names when tasks overlap.
4. Concurrent tasks use separate branches/worktrees and do not edit the same canonical contract without explicit coordination.
5. Roadmap status changes are committed; assistants do not mark work shipped from chat prose.
6. `shipped` entries identify a merged commit/release and verification evidence.
7. Superseded plans remain linked but are labelled; they do not silently regain authority.
8. Do not ingest full chats. Store bounded decisions, source references, and implementation evidence.
9. No secrets, credentials, customer data, or unrelated profile memory belong in this document.

## Existing detailed plans and design references

- [`docs/plans/2026-08-05-v0-4-visible-delegation.md`](plans/2026-08-05-v0-4-visible-delegation.md) — **implemented baseline, partially superseded.** Sanitized delegation visibility and bounded handoffs remain authoritative; future lifecycle work maps to CP-001, CP-003, CP-004, CP-006, and CP-011.
- [`docs/plans/2026-08-10-olympus-global-projects-v1.md`](plans/2026-08-10-olympus-global-projects-v1.md) — **partially implemented, partially superseded.** Project identity, ACL, repository links, references, editor leases, and version records are the baseline. Proposed `project_task_leases`, `task_workspaces`, and queue/evidence concepts must map to current `project_editor_leases`, capability leases, durable attempts, snapshots, and verification evidence rather than creating duplicate authorities.
- [`docs/plans/2026-08-10-somboon-studio-control-plane.md`](plans/2026-08-10-somboon-studio-control-plane.md) — **partially implemented, first-slice assumptions superseded.** Its read-only safety principles remain; v0.5.1 branch/push/version foundations supersede the original no-push first-slice description. CP-006, CP-008, and CP-009 govern future write authority.
- [`docs/plans/portable-install-updates.md`](plans/portable-install-updates.md) — **partially implemented.** Native/Docker installation, readiness, drain, and update foundations are current; event/projector recovery and durable attempt reconciliation remain future work under CP-010 and CP-011.

These plans contain useful implementation history but do not override this roadmap’s current product direction or architecture invariants.

## Explicitly not pursuing

- Replacing Olympus with an agent harness or plugin framework.
- Importing Cordis or depending on DeepSeek Harness.
- Centralizing full Hermes/profile transcripts, prompts, memories, or hidden reasoning.
- Treating worker prose, a streaming `done`, a pushed commit, or a mutable preview URL as verified completion.
- Letting workers merge, deploy production, alter canonical decisions, or expand authority without server policy and explicit approval.
- Using Qdrant as canonical workflow state.
- Force-push/reset rollback or silent history rewriting.
- Arbitrary model-written workflow JavaScript.

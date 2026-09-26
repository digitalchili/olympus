# OpenAI Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute A1 before implementing against a newer native API.

**Goal:** Repair shared-login renewal and provide shared-default OpenAI sign-in, with an explicit separate-profile option, without restarting or replaying tasks.

**Architecture:** Keep native Hermes credential renewal/storage. A worker auth manager and private helper handle device authorization; the profile adapter coordinates safe saves. Shared sign-in belongs to the default worker and waits for all started profile workers to become idle. Separate sign-in belongs to the selected profile. Typed RPC/routes and one Providers card expose this scope explicitly. Only the OpenAI-specific portion of R2 is included in this implementation.

**Tech Stack:** Python native Hermes OAuth, JSONL, TypeScript/Express, React. No new OAuth library or external service.

**Spec:** [Reliability design](../specs/2026-09-26-reliability-improvements-design.md), Global constraints and A.

**Implementation note — 2026-09-26:** The authentication scope is implemented locally in `codex/shared-openai-auth`. The contracts below match the code; checked items record completed implementation/native checks, while commit, Docker and remaining acceptance items stay unchecked. See [OpenAI authentication evidence](../../testing/openai-authentication.md) for the current validation record. This does not complete the broader retry, GitHub or performance plans, authorize task replay, or claim a commit, Docker build or deployment.

## Global Constraints

All Global constraints in the spec apply verbatim. Fixed provider `openai-codex`; issuer/client ID/storage paths are server/native-owned. Tokens never leave the private worker/helper boundary except into native credential storage. No model call for a saved-login check, no periodic refresh script, no worker restart, no automatic task replay or model/default change. Node remains `>=22.22 <26`.

## Review Focus

- Two profiles rotate the same inherited grant simultaneously: A1.
- A supposedly read-only status request repairs or backs up a credential file: A2.
- Explicit cancellation races helper completion; navigation stops browser polling but preserves the server attempt: A2/A3.
- Scheduled work begins between sign-in and credential persistence: A2.
- Reconnect silently replaces a known profile-owned account: A2.

## Task A1: Validate and pin a compatible Hermes release

**Files:** Modify `Dockerfile`, `docs/coding-harness.md`, associated pinned-image assertions found with `rg '29112bef|v2026.8.31|64923fae'`, and native contract tests only where a legitimate interface change requires it. Create `tests/test_worker_openai_auth_native.py` for the Olympus adapter/native boundary. Do not edit the user's installed Hermes checkout.

**Inputs and current pin:** Previous pin `29112bef099274229cadff79cdff7bf7b99c4b77`. Required fixes `6bd29f26f6631be5b02db7e7d23c75800fd3934a` and `e117e792b676c93464b0e5c79d8a9c298ff00ed4` are ancestors of **v2026.9.24**, source **`f97608f178d1ffeca59860195ab7da295f7c8e5f`**. The local Dockerfile now uses its verified multi-platform registry digest **`sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7`**. Both supported image configurations identify that source. A Docker build/runtime check remains pending because the daemon was unavailable.

**Output contract:** An immutable image tag/digest with recorded source SHA and passing native compatibility evidence. Use that exact source for A2. If no compatible image can be verified, leave the old pin untouched, report A1 blocked, and leave unrequested R/G/P work pending; do not quietly use `latest` or lower test expectations.

- [x] **Establish a disposable candidate.** Resolve the public tag/source and published multi-platform image manifest; verify both required commits are ancestors and supported deployment architectures exist. Record the exact digest and platforms. Do not pull a running server's volume or use local Hermes HEAD (it may be a release candidate). Source reading or a new disposable checkout/image is sufficient; no installed update.
- [x] **Write the shared-grant regression.** Fake default/root and two profile stores share one rotating refresh grant. Assert one source-store renewal succeeds, the second caller adopts its replacement, root and borrower references remain coherent, and explicit named-profile login uses profile-only storage. Prohibit real HTTP and real auth-store reads. The old pin must expose the stale-root/shared-transaction behavior; the candidate must pass.
- [x] **Run native coverage in an isolated Python environment/home.** Candidate tests: `tests/hermes_cli/test_codex_token_writethrough.py`, `tests/hermes_cli/test_auth_codex_provider.py`, `tests/hermes_cli/test_oauth_status_pool_observation.py`, `tests/agent/test_credential_pool_profile_oauth_fork.py`, `tests/agent/test_credential_pool_oauth_writethrough.py`. Use its pytest runner. Run Olympus native recovery, background-work, interactions, delegation, provider/model resolution and usage contracts against that candidate as well. Tests must redirect both profile and default-store access to fixtures; setting only a named `HERMES_HOME` is not sufficient if native fallback still points to real root credentials.
- [x] **Add `test_worker_openai_auth_native.py`.** Accept the candidate source path as its explicit argument, following `test_worker_usage_native.py`. Mock provider HTTP and store paths; assert the exact native signatures below, shared-root renewal, profile-only save, and no defaults change. Test native progress prints are captured privately, not leaked into worker JSONL. Required native tests cannot be counted as passed when skipped.
- [x] **Update the pin after source compatibility passes.** Keep the immutable `tag@sha256:...` and source/digest/test evidence in `docs/coding-harness.md`. Bot and Project GitHub refresh hooks required narrow compatibility changes; native tests pass against both source revisions.
- [ ] **Validate Docker packaging/runtime.** Run a disposable candidate Docker build and fixture tests without live volumes when a Docker daemon is available. No deployment is part of this task.
- [ ] **Record checkpoint:** `fix: update Hermes for safe shared OpenAI token renewal` with the actual compatible version in the body. Record unsuccessful candidate evidence without claiming an upgrade if blocked.

## Task A2: Shared/profile worker auth contract and cancelable device flow

**Files:** Create `shared/openai-auth.ts`, `server/workers/hermes_openai_auth.py`, `server/workers/hermes_openai_auth_helper.py`, `tests/test_worker_openai_auth.py`. Modify `server/workers/hermes_worker.py`, `server/workers/hermes_scheduled_tasks.py`, `server/workers/hermes_usage.py` (explicit cache invalidation), `server/adapters/worker-protocol.ts`, `server/adapters/hermes-worker.ts`, `server/adapters/routing.ts`, and `scripts/run-tests.mjs` (register the Python unit test). New `.py` files are already included by the asset copier; verify the build output.

**Public and internal types in `shared/openai-auth.ts`:**

```ts
type OpenAIAuthScope = 'shared' | 'profile';
type OpenAIAuthState = 'unknown' | 'not_configured' | 'saved_login_ready'
  | 'reconnect_required' | 'temporarily_unavailable';
interface OpenAIAuthStatus {
  provider: 'openai-codex'; state: OpenAIAuthState; checkedAt: number | null;
  credentialScope: 'profile' | 'shared_default' | 'none' | 'unknown'; code: string | null;
}
interface OpenAIAuthSession {
  sessionId: string;
  state: 'starting' | 'awaiting_user' | 'waiting_for_idle'
    | 'saved' | 'cancelled' | 'expired' | 'failed';
  verificationUrl: string | null; userCode: string | null;
  expiresAt: number | null; pollIntervalMs: number; code: string | null;
}
type OpenAIAuthRequest = { action: 'status' | 'check' | 'start' }
  | { action: 'poll' | 'cancel'; sessionId: string };
interface OpenAIAuthResponse { status: OpenAIAuthStatus; session: OpenAIAuthSession | null; }
// Internal JSONL actions, never accepted from HTTP callers.
type OpenAIAuthWorkerRequest = OpenAIAuthRequest
  | { action: 'commit'; sessionId: string }
  | { action: 'invalidate' }
  | { action: 'guard'; enabled: boolean };
interface OpenAIAuthGuard { guarded: boolean; activeRuns: number }
```

Export these types. `code` contains only reviewed identifiers (`openai_auth_required`, `openai_auth_unavailable`, `auth_busy`, `auth_session_invalid`, `auth_cancelled`, `auth_expired`, `auth_account_mismatch`, `auth_incomplete_credentials`, `auth_storage_failed`, `auth_unsupported`). Unknown native errors map to fixed safe failure text/code, never their string representation.

**Adapter/RPC interfaces:** `manageOpenAIAuthWorker(input: OpenAIAuthWorkerRequest): Promise<OpenAIAuthResponse | OpenAIAuthGuard>` on a worker adapter. The profile adapter exposes `manageOpenAIAuth(input: OpenAIAuthRequest, profileId = 'default', scope: OpenAIAuthScope = 'shared'): Promise<OpenAIAuthResponse>`. JSONL uses one request type, `auth.openai`, with the action union above; `guard`, `commit` and `invalidate` are adapter-owned internal operations. `WorkerResult` includes both response types. `shared` routes to the default worker; `profile` routes to the selected worker. Owner/affected profiles use `acquireProfileWork` during save coordination.

**Python interface:** `OpenAIAuthManager.handle(request: dict) -> dict`, with injected native/helper/clock/admission functions for deterministic tests, and `close() -> None` for worker teardown. `status` is a cache-only immediate projection; `check` and all potentially blocking actions run off the JSONL reader.

**Candidate native APIs (verify A1; these are internal APIs and require contract tests):**

```python
from hermes_cli.auth_codex import (
    _codex_request_device_code, _codex_poll_authorization_code,
    _codex_exchange_authorization_code, _save_codex_tokens,
    resolve_codex_runtime_credentials,
)
# request(issuer, client_id) -> dict
# poll(issuer, *, device_auth_id, user_code, poll_interval) -> dict
# exchange(issuer, client_id, code_resp) -> dict
# save(tokens, last_refresh=None, label=None, *, set_active=True, write_through=False)
# resolve(*, force_refresh=False, refresh_if_expiring=True,
#         refresh_skew_seconds=120, read_only=False) -> dict
```

- [ ] **Write failing unit tests before implementation.** Cold status returns unknown and performs zero filesystem reads/writes/network calls, including with a malformed credential file. Check invokes native normal renewal, not force-refresh or a model call. Duplicate start returns the active attempt without a second helper. Wrong-profile/session ID rejects; cancellation/expiry/generation replacement before late helper completion prevents every save. Save waits when foreground or scheduled work is active, then succeeds once idle. Missing refresh token, account mismatch and storage failure are terminal safe errors. Explicit login calls native save with `set_active=False, write_through=False`; renewal still respects upstream source ownership. Defaults are unchanged, cache invalidation covers every affected started worker, and worker stop is never called.
- [ ] **Run red:** `node scripts/run-tests.mjs tests/test_worker_openai_auth.py`.
- [x] **Implement cached state and native check.** Never call `get_codex_auth_status`, `load_pool`, or the resolver from GET/status: in the candidate they can heal stores or write corrupt-file backups despite read-only wording. Explicit check may renew natively and returns Saved login ready; it does not assert live model availability. A transient check failure must not erase known credentials or automatically start device auth.
- [x] **Implement the auth-only helper.** Use the selected worker's Python and fixed native issuer/client ID. Run request/poll/exchange in this helper; redirect native progress output/logging so nothing secret or non-JSON reaches the task worker's public protocol. Emit a bounded private `device` event carrying user code, expiry and native interval (candidate defaults 5 seconds, minimum 3); the parent projects `awaiting_user` and the fixed URL `https://auth.openai.com/codex/device`. Return credentials only through the private pipe. The device-flow child never saves credentials. A separate private save operation performs the native write only after the parent and profile adapter authorize commit. Capture raw helper errors privately and discard/redact them; do not relay raw stderr. Tokens/auth codes/device secret never enter command arguments or transfer files; access/refresh tokens are persisted only through the authorized native credential save.
- [x] **Implement lifetime and final save.** Use the native 15-minute authorization window beginning when device code is issued; honor a shorter provider expiry if supplied. `starting` can be cancelled while native request retry is in progress. Cancel/expiry terminates only this helper and invalidates its generation before cleanup. Worker `poll` reads state; a `waiting_for_idle` response lets the profile adapter acquire guards and request internal `commit`; it never launches a second native polling loop. Sign-in may begin while work is running. Retain approved credentials only in memory until all affected workers are idle or the authorization expires, and show waiting_for_idle. Browser navigation/unmount stops polling and ignores stale responses; it does not cancel the server attempt. Returning to the same scope recovers the attempt through status. Once saved/cancelled/expired/failed, clear codes/private tokens and prevent late callbacks from changing the terminal state. After worker restart return unknown/no active attempt; never replay an old authorization code.
- [x] **Guard principal ownership and admission.** Shared save waits for default and every started named-profile worker, including profiles with separate credentials, and defers while a worker is starting or not confirmed ready. Block new worker admission during coordinated commit. Install an internal guard on each affected worker under the consistently ordered scheduled-dispatch guard plus `PROVIDER_CONFIG_LOCK`/`ACTIVE_TASKS_LOCK`; verify foreground and native scheduled counts are zero before internal `commit`. Separate-profile save guards only its owner. Inventory errors mean unavailable, not idle. Release every guard, including a request whose acknowledgement was lost; keep unresolved cleanup tracked and reject unsafe follow-up work until it is released. Never hold these locks during browser wait/network exchange. Preserve known profile-owned account/workspace identity using a small mode-0600 atomic metadata sidecar `olympus-openai-auth.json` containing only a principal hash/version, if native storage no longer retains that identity after failure. Do not treat an inherited root identity as a named profile's explicit account choice. Unknown identity is never claimed as a verified account match. Reject a different known principal without altering credentials. Clear model/usage/config caches after save, including internal `invalidate` for the other affected workers on shared save; do not restart workers.
- [ ] **Run green:** `node scripts/run-tests.mjs tests/test_worker_openai_auth.py tests/test_worker_providers.py tests/test_scheduled_task_drain.py tests/local_profile_adapter.test.ts tests/profile_settings_gate.test.ts`. Run the A1 native adapter test against its candidate with fake HTTP/stores. Inspect captured HTTP/JSONL/SSE/logs/metadata for secret sentinels; none may be present. User code is permitted only in active sign-in responses, not logs/history.
- [ ] **Record checkpoint:** `feat: add profile-scoped OpenAI device authentication`.

## Task A3: HTTP routes, Providers card, and stopped-task reconnect

**Files:** Create `client/src/components/OpenAIAuthSettings.tsx`, `tests/openai_auth_routes.test.ts`, `tests/openai_auth_ui.test.ts`. Modify `server/routes/agent.ts`, `client/src/lib/api.ts`, `client/src/components/ProvidersSettings.tsx`, and R2's TaskChat/RunFailureBanner action wiring. Add a disposable UI fixture under `tests/fixtures/` using a fake adapter; no real login is needed for automated QA.

**HTTP contract:** All return `OpenAIAuthResponse` and `Cache-Control: no-store`. `GET /api/agent/openai-auth?scope=shared|profile` returns status; `POST /api/agent/openai-auth/{check,start}` accepts `{scope?: 'shared' | 'profile'}`; `POST /api/agent/openai-auth/{poll,cancel}` accepts only that optional scope plus required `{sessionId:string}`. Omitted scope defaults to `shared`. Resolve selected profile through existing `?profile=`/`requestProfile` and use `profileRequestGate` on mutations; shared ownership remains the default worker. Invalid scope/extra fields return 400. Internal `guard`, `commit`, `invalidate` have no HTTP endpoints. Reject caller-supplied endpoint/path/provider/token fields. Invalid session -> 404; busy -> 409; unsupported/unavailable worker -> 503, using safe typed codes. Device-flow terminal failed/expired/cancelled states return the typed session normally so the UI can render them.

**Client contract:** `manageOpenAIAuth(profileId: string, input: OpenAIAuthRequest, scope: OpenAIAuthScope = 'shared'): Promise<OpenAIAuthResponse>` maps to those endpoints. `OpenAIAuthSettings({profileId, profileLabel, initialScope?, onReady?})` appears above existing API providers and defaults to shared sign-in; a named profile can explicitly choose its separate login. A task reconnect uses `initialScope='effective'`: read its credential scope, explicitly check if unknown, retain an owned profile login, choose shared for inherited/missing credentials, and ask for a scope choice if ownership remains unknown. Do not silently switch profile/account. Navigation stops local polling without sending cancel; status can recover the same owner's active attempt.

- [ ] **Write failing route/UI tests.** A separate-profile session cannot be polled/cancelled through another owner; shared-scope views intentionally reach the same default-owned attempt; body cannot set credential paths; status does not mutate; every response is no-store and secret-free. Starting state becomes awaiting_user with open-link/copy-code/cancel controls; polling respects `pollIntervalMs`; duplicate clicks start once. Profile switch/unmount discards stale responses and stops browser polling without implicitly signing out or saving a different profile. Reload can recover the active attempt from status. Waiting-for-idle copy explains active work is preserved. Saved state emits model/usage refresh only, makes zero task-message POSTs, and preserves unsent task drafts. Generic auth errors never trigger this flow.
- [ ] **Run red:** `node scripts/run-tests.mjs tests/openai_auth_routes.test.ts tests/openai_auth_ui.test.ts tests/run_failure_presentation.test.ts`.
- [x] **Implement routes and card.** Show safe status for unknown, missing, ready, reconnect-required and temporarily unavailable credentials; expose Sign in to OpenAI and Check saved login with an explicit login scope. Explain that a saved login check makes no model request. Show shared ownership by default and the selected profile label for separate sign-in. Use fixed trusted verification URL in an ordinary user-clicked link; do not auto-open browsers or automate passwords/MFA/consent.
- [x] **Integrate failure recovery.** Connect the implemented OpenAI-specific codes to this real card, without claiming the broader R2 taxonomy is complete. After saved, user can return to the task and choose Continue saved work; do not call its message API automatically or claim the previous turn completed. Leave existing custom API provider/default selection behavior intact.
- [ ] **Run green and visual QA:** repeat tests; run `npm run typecheck` and `npm run build`; use a disposable fake-adapter browser fixture to exercise cancellation, expiry, reload, wrong profile, temporary failure and success. Confirm the new Python assets are copied. Stop fixture servers after QA.
- [ ] **Record checkpoint:** `feat: expose OpenAI reconnect and saved-login status`.

## Regression assertion examples

Use these checks inside the task's injected-manager/route fixtures. Do not use real credentials to make the assertions pass.

```python
# test_worker_openai_auth.py: test_cold_status_is_side_effect_free
assert manager.handle({"action": "status"})["status"]["state"] == "unknown"
native_resolver.assert_not_called()
store_reader.assert_not_called()
token_saver.assert_not_called()

# test_cancel_prevents_late_helper_save: after cancelling, deliver late helper result
assert manager.handle({"action": "poll", "sessionId": attempt_id})["session"]["state"] == "cancelled"
token_saver.assert_not_called()
```

```ts
// openai_auth_ui.test.ts: saved_login_does_not_resume_task
assert.equal(cardState.session?.state, 'saved');
assert.equal(taskMessagePosts.length, 0);
assert.equal(workerRestartCalls.length, 0);
```

## Release boundary

Authentication-specific evidence is tracked in [OpenAI authentication evidence](../../testing/openai-authentication.md). V1 remains the later whole-package gate; broader retry/Git/performance work is pending and must not be started merely because this scope is implemented. A real sign-in/model task belongs to the selected installation's separately authorized acceptance check. An available upstream image and passing mocks alone do not establish Docker/native compatibility or resolution of Michael's incidents.

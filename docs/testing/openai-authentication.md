# Shared OpenAI authentication validation — 2026-09-26

## Scope and source

Implemented on `codex/shared-openai-auth`, based on Olympus `1f81b95f7c9d1cae049657a56fb8a8919a9267f3` (v0.7.18). This change implements the authentication portion of the [reliability handoff](../superpowers/plans/2026-09-26-reliability-handoff.md), plus the necessary non-destructive readiness behavior and OpenAI-specific task actions. The wider Git publication, retry taxonomy and response-performance work remains pending.

Shared sign-in targets the default Hermes store. Explicit profile sign-in targets only that profile. Model selection remains separate. Native refresh repairs inherited grants; device sign-in obtains user consent through the link/code shown in Olympus. No fallback model is used.

## Safety contracts exercised

- Cache-only status performs no native credential reads, renewal, filesystem repair or model call. Explicit Check uses native renewal.
- Duplicate starts reuse an active attempt. Cancel, expiry and late callbacks cannot save cancelled credentials. Navigation stops client polling without cancelling the attempt; status restores it.
- Tokens stay within the private helper/worker boundary and native credential storage. Native stdout/stderr is suppressed at descriptor level; fixed safe error codes cross the public protocol.
- A shared save requires idle foreground and scheduled work in every started profile worker. Internal guard/commit requests preserve reader order. The owner acknowledges release before peer guards are removed, including after a lost commit response. Failed cleanup retains a fence against creating/restarting unguarded workers and can be retried from the auth UI.
- Existing worker history/Stop controls remain available. Worker lifecycle reset clears the cached started flag; an internal guard request can safely restart an exited worker and count any work admitted during startup, so an idle worker exit cannot leave sign-in waiting forever. Delayed readiness checks return unavailable without terminating workers or marking unrelated profile tasks failed.
- Normal worker shutdown reaches auth cleanup; private children close before waiting for the manager lock held by a save. Authentication never stops task workers, resends a task, changes model defaults, or copies a shared token into a profile override.
- A mode-0600 account-hash receipt preserves a known owned account through token loss. A profile with such a receipt requires reconnecting its own account. Uncertain storage outcomes require checking the saved login and do not claim that credentials stayed unchanged.

## Executed validation

The tests use temporary homes/state, fake credentials and mocked or denied provider networking. No real account authorization, paid model request or live installation state was used.

- `npm test`: complete suite (17 Python files and 172 TypeScript files) passed. Native-dependency cases skipped by the ordinary runner were exercised separately where listed below. After the final idle-worker recovery adjustment, the auth routing, local profile adapter, scheduled profile drain and profile settings gate tests passed again.
- `npm run typecheck`, `npm run build`, `npm run lint:shell` and `git diff --check` passed. The production build retains the existing large-client-chunk warning. Both new Python helper assets are included in the output.
- New route, UI, profile routing, non-destructive readiness, worker admission and auth-manager regression suites passed. Tests were observed failing before the relevant fixes for missing functionality, guard ordering, worker shutdown and account ownership.
- Candidate native auth contracts: four tests passed, including two profile processes refreshing one rotating root grant. The shared-refresh case failed against the previous Hermes pin and passed against the candidate. The real Olympus helper check/save contract passed with synthetic accounts and networking denied; it verifies ownership after token loss and unchanged model/default configuration.
- Hermes candidate's five targeted upstream auth test files: 53 tests passed. Olympus native recovery, background work, delegation, interactions, provider/model resolution, usage, Bot messaging, Project GitHub and scheduled drain contracts passed against the candidate. Bot/Project hooks also passed against the previous source. Scheduled drain passed all six tests with the candidate enabled.
- Browser fixture exercised the actual auth component/API wrapper using simulated responses: trusted link/code, Copy, pending approval, waiting for tasks, saved state with explicit Continue, cancellation, expiry and account-scope labels. A failed recheck removed stale Continue readiness and the old success message. No OpenAI verification page was submitted. Component tests cover reload/restored sessions, stale responses, polling errors and no automatic task message submission. The fixture server and browser tab were stopped after QA.

## Native dependency and compatibility changes

Docker now pins Hermes `v2026.9.24`, source `f97608f178d1ffeca59860195ab7da295f7c8e5f`, multi-platform digest `sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7`. The registry's amd64 and arm64 source labels were checked. This source includes the shared-store refresh locking and write-through fixes. Node remains 22.22.3 for Olympus.

The new Hermes release moved dynamic-tool hooks. Narrow Bot and Project GitHub compatibility changes retain Olympus-controlled transport and authority; they do not enable unmanaged native delivery or redesign Git publication. Native approval-context facade deprecation warnings remain.

## Acceptance still required

The local Docker daemon was unavailable, so a disposable image build/container acceptance run was not performed. Source tests and registry evidence are not container-runtime proof. No release, live installation update or deployment was performed.

A selected installation must still exercise a real link/code sign-in, expiry/cancellation, named-profile inheritance/override, and a safe task after sign-in under its normal deployment controls. A forcibly killed worker or host crash during native storage writes has not been fault-injected; normal SIGTERM cleanup is tested. Follow the existing installer dry-run/approval and Docker single-writer rules. No claim is made that the reported production disconnects have been reproduced or eliminated.

# Hermes v0.21.7 compatibility acceptance

Date: 2026-10-13. Candidate Olympus: 0.7.43.

## Runtime identity

- The deployed 0.7.42 runtime reported revision `f97608f178d1ffeca59860195ab7da295f7c8e5f`; its immutable released image imports Hermes version 0.21.5.
- The official v0.21.7 Git tag resolves to `71d34bad1045610252eda02ee79549436896e784`.
- The official `v0.21.7` Docker tag was unavailable. The selected `stable` image is pinned by index digest `sha256:444b42594e7f467425872fc35e077a227d377f0fe0726bc818706d62175fad8b`; its install stamp and provenance match that release commit, and its Python package reports 0.21.7.
- Runtime reporting now prefers the installed version stamp over the stale upstream release-date constant. Manifest validation still requires the official repository, exact immutable digest, supported tag spelling, release URL and source revision.

## Demonstrated compatibility fixes

- Use the relocated native approval context, preserving thread-local callbacks and denial behavior.
- Accept the native batch clarification callback and return its documented `submitted` outcome.
- Preserve model-facing `api_content`, signed reasoning, original timestamps and native hidden interrupt rows during replay. Native dangerous-confirmation expiry must still remove both old confirmation text and its model-facing sidecar.

## Local evidence

All tests used disposable state. No production profile or credential was mounted locally.

- Full Python/TypeScript suite with Node 22, typecheck, production build and shell syntax checks.
- Built-image worker acceptance using real Hermes imports: approvals, clarification, history, delegation, background work, steering, Bot messaging, GitHub context and recovery.
- Three real worker conversation turns through a local deterministic HTTP provider: resume history persists; a newly installed external skill reaches the existing session once, while its cached system prompt remains unchanged.
- Real SessionDB and Anthropic conversion preserve a synthetic signed-thinking block. Native replay expires old dangerous confirmations and preserves hidden interruption alternation without exposing model-only text in the transcript.
- Browser exercise through the actual Olympus server and worker: batched single/multiple/free-text questions survive reload; submitted answers reach Hermes; successful completion enters review; Stop closes a later pending request and leaves the task unfinished.
- Disposable released-image upgrade from 0.7.42 to the candidate, preserving synthetic profiles, settings, credential fixture, sessions, tasks and Bot state. Authenticated drain, verified SQLite backup/restore, forced promotion failure recovery and rollback to the immutable released image pass.
- Independent review identified replay metadata and clarification outcome gaps; targeted regressions reproduced each failure before the fixes.

## Limits and production gate

Deterministic provider responses test integration, not model quality or latency. Signed reasoning uses a synthetic signature and the real converter, not a paid live Anthropic request. Plugin isolation and voice integration remain unchanged. No measured speed improvement is claimed.

Production deployment additionally requires passing CI and image publication for the release commit, unchanged remote main, zero active runs, authenticated drain, verified native background-work inventory and protected backups of the existing persistent state. Preserve the existing service configuration and volumes. Read back the deployed Olympus/Hermes versions, readiness and state after deployment; local acceptance alone does not establish production completion.

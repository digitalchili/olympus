# Somboon Studio Control Plane Implementation Plan

> **For Hermes:** Execute this plan in small TDD slices. Keep GitHub canonical, preserve read-only defaults, and require Michael's explicit approval before any merge or deployment.

**Goal:** Add a VPS-native Studio surface that can connect a GitHub App, select approved repositories, retain project/evidence records, and later support approval-gated branch/preview workflows.

**Architecture:** Olympus remains the control plane and SQLite remains its local system of record. GitHub App credentials stay in environment-backed server configuration; only installation/repository metadata is persisted. The first slice is deliberately read-only: no clone, executor, push, merge, Dokploy, or production capability exists until separate enforcement PRs add and test each boundary.

**Tech Stack:** Express, SQLite/better-sqlite3, React/Vite, Node crypto/fetch, TypeScript, existing node:test-style assertion scripts.

---

## Safety contract

- `Somboon/default` and `somboon-studio` may retrieve shared and project-scoped memory; task packets remain bounded rather than injecting all memory.
- A Hermes profile is not treated as an execution sandbox.
- GitHub App installation tokens are minted on demand and never stored in SQLite or returned to the browser.
- Imported projects start in `read_only` mode.
- No raw shell endpoint, host Docker socket, broad home mount, push, merge, preview, or production deployment is introduced in the first slice.
- `push` will eventually mean task branch + PR + preview. `merge to main` and production promotion remain separate explicit approvals.

## PR 1: Read-only project and GitHub App onboarding

### Task 1: Persist GitHub installations and Studio projects

**Files:**
- Modify: `server/db/schema.sql`
- Create: `server/db/studio-projects.ts`
- Modify: `shared/types.ts`
- Test: `tests/studio_github.test.ts`

**Steps:**
1. Write a failing integration test proving installation/project tables and list/import behavior do not exist yet.
2. Run `TSX_TSCONFIG_PATH=client/tsconfig.json node --import tsx tests/studio_github.test.ts` and confirm the expected missing-module/schema failure.
3. Add installation and project tables with unique GitHub IDs and `read_only` project mode.
4. Add typed queries that upsert installation metadata and idempotently import a repository.
5. Re-run the targeted test.

### Task 2: Add a GitHub App client without persistent tokens

**Files:**
- Create: `server/studio/github-app.ts`
- Test: `tests/studio_github_jwt.test.ts`

**Steps:**
1. Write a failing test for a short-lived RS256 GitHub App JWT, GitHub user-authorization ownership check, and injected-fetch installation repository listing.
2. Run the targeted test and confirm failure because the module is absent.
3. Implement JWT generation, single-use OAuth state, user-token exchange, user/installation ownership verification, installation-token exchange, repository listing, timeouts, and sanitized errors.
4. Verify the JWT signature and that no user or installation token appears in returned project/API data.

### Task 3: Add read-only Studio API routes

**Files:**
- Create: `server/routes/studio.ts`
- Modify: `server/app.ts`
- Test: `tests/studio_github.test.ts`

**Endpoints:**
- `GET /api/studio/github/status`
- `POST /api/studio/github/connect`
- `GET /api/studio/github/callback`
- `GET /api/studio/github/oauth/callback`
- `GET /api/studio/github/repositories?installationId=...`
- `GET /api/studio/projects`
- `POST /api/studio/projects`

**Steps:**
1. Test unconfigured fail-closed behavior, two single-use callback states, verified user/installation association, installation-scoped repository listing, validation of repository selection, and idempotent import.
2. Implement the minimum routes using dependency injection for the GitHub adapter.
3. Mount the router globally rather than per Hermes profile because Studio projects are shared.
4. Re-run targeted and full tests.

### Task 4: Add the Projects onboarding UI

**Files:**
- Create: `client/src/components/StudioProjectsPage.tsx`
- Modify: `client/src/lib/api.ts`
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/Sidebar.tsx`
- Test: `tests/studio_projects_ui.test.ts`

**Steps:**
1. Write a source-level regression test for the `/studio` route, navigation link, explicit Connect GitHub action, repository selection, and read-only project labeling.
2. Confirm the test fails before UI implementation.
3. Add a simple project list and GitHub App installation/repository approval flow.
4. Keep configuration errors explanatory and never expose credentials.
5. Run targeted test, typecheck, build, and browser smoke if a local server can be started safely.

## PR 2: Run/evidence foundations (no code push)

- Add immutable base SHA, run status, lease expiry, command evidence, artifacts, and approval-decision tables.
- Add predefined verification-policy records; do not accept arbitrary shell commands from the browser.
- Add evidence API/UI with redacted logs and explicit blocked-capability explanations.
- No GitHub write token and no executor in this PR.

## PR 3: Constrained sandbox-write executor

- Use a read-only bare mirror/object cache and a fresh disposable checkout at a recorded SHA.
- Run as a separate Linux identity or rootless container with resource/time/network limits.
- Mount one task workspace only; no host Docker socket, broad home mount, production secrets, or production network.
- Retain evidence, destroy task state, and test cleanup/failure recovery.

## PR 4: Approval-gated task-branch push and PR

- Mint a short-lived GitHub App installation token only after an approved push action.
- Restrict repository and branch server-side; never push directly to protected `main`.
- `push` creates/updates a task branch and PR, then records resulting SHA and GitHub URL.
- Verify branch protection and required checks without granting worker bypass.

## PR 5: Dokploy preview

- Map approved projects to separate preview applications/domains.
- Use preview-only credentials and networks, automatic expiry, and cleanup.
- Never expose production databases or production environment secrets.
- Return a verified custom preview URL as evidence.

## PR 6: Protected-main and production promotion

- `merge to main` identifies the exact PR/SHA, verifies CI/review, displays an approval card, then merges through GitHub.
- Production deployment uses a separate identity and approval from code push.
- Record deployment SHA, URL, verification result, rollback target, and reviewer decision.

## Verification gates for every PR

1. Targeted failing test observed before implementation.
2. Targeted test passes after minimal implementation.
3. `npm test` passes.
4. `npm run typecheck` and `npm run build` pass.
5. Diff reviewed for secrets, unsafe shell, path traversal, SQL injection, credential leakage, and unintended authority.
6. Independent reviewer checks spec compliance and security-sensitive failure cases.
7. No merge or deployment without Michael's approval.

## GitHub App deployment configuration

No GitHub credentials are required for first-run setup. The Connect GitHub button starts GitHub's App Manifest flow, exchanges GitHub's temporary code server-side, and stores the generated app ID, slug, private key, client ID, and client secret as AES-256-GCM ciphertext. The local encryption key is generated once in the persistent Olympus data directory with mode `0600`.

For an organization-owned private app, configure only the non-secret owner slug:

- `OLYMPUS_STUDIO_GITHUB_APP_OWNER=digitalchili`

`OLYMPUS_STUDIO_PUBLIC_URL` is an optional canonical-origin override. Without it, Olympus requires the browser `Origin` to match the public proxy host and requires HTTPS in production.

Existing app credentials remain supported as an advanced override. If used, provide all five values:

- `OLYMPUS_STUDIO_GITHUB_APP_ID`
- `OLYMPUS_STUDIO_GITHUB_APP_SLUG`
- `OLYMPUS_STUDIO_GITHUB_PRIVATE_KEY`
- `OLYMPUS_STUDIO_GITHUB_CLIENT_ID`
- `OLYMPUS_STUDIO_GITHUB_CLIENT_SECRET`

The manifest supplies `/api/studio/github/manifest/callback` as the app-creation redirect, `/api/studio/github/callback` as the post-install setup URL, and `/api/studio/github/oauth/callback` as the user authorization callback. The app requests repository Metadata: Read only and no events or webhooks.

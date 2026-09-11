# Project GitHub account access

Approved design: Project settings selects existing GitHub installations with checkboxes. Selected accounts grant read-only repository access to that Project's tasks. The primary repository remains the only Olympus publication target. Account selection alone must not claim a repository clone succeeded. Never expose credentials in task context, tool responses, Git remotes or stored files.

Implementation and validation:

- [x] Persist explicit installation selections in `project_github_access`, expose GET/PUT `/api/projects/:id/github-access` with manager-only writes, verify selected connections before saving, retain connection deletion guards. No implicit grant to every account.
- [x] Add a settings component with independent Save action and loading/error states. API response: `{ installationIds: number[], accounts: StudioGitHubInstallation[] }`; PUT body `{ installationIds: number[] }`. Explain read-only access and primary repository publishing.
- [x] Add `project_github` agent tool with actions `list`, `check`, `clone`, optional `repository` in owner/name form. Use the existing JSONL reverse-request pattern, authenticated runtime task/run identity, cancellation and tool-refresh reinjection. Worker event `project_github_requested` carries `projectGitHub: { requestId, workerRunId, action, repository? }`; response request `project.github.respond` carries `{ taskId, requestId, workerRunId, result }`. `AgentRunOptions.projectGitHub` is a boolean enabled only for Project tasks with explicit selections.
- [x] Server rechecks current task/profile/Project selection for every operation. Resolve repository from GitHub's selected-installation catalog. Mint a read-only token restricted to the one repository. Check real remote refs; clone full history into profile workspace task sources outside the primary checkout, disable push URLs and recursive submodules, and return only safe metadata/local paths. Fixed HTTPS GitHub origins, no caller-controlled paths or token output. Failed/unselected requests never receive credentials.
- [x] Regressions: selection persistence and ACL, disconnected accounts, exact installation/repository read-only scopes, no credential leaks, full-history clone and missing access, same-profile unrelated-task isolation, cancellation and refresh, UI saved-selection behavior.
- [x] Run targeted tests, full `npm test`, `npm run typecheck`, `npm run build`, local browser settings verification and independent review. Keep changes local; no push, installation, deployment or live account permission changes.

Existing uncommitted empty-repository fix is preserved. Server access work is owned by the parent; UI and Python/adapter transport are separate bounded agent assignments.


## Verification evidence

- Final `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` passed on the combined local changes, including the earlier empty-repository fix.
- Real disposable Git repositories verified original commits, all branches, source reuse, preservation of edits, access isolation, revocation during listing, and explicit Stop cancellation. Source credentials were fake; this did not grant access to or clone the live private repositories.
- Native Hermes registry tests used the installed source with a disposable Python environment and actual temporary SessionDB. They verified tool dispatch, compaction session rotation, child-result continuation, MCP refresh, and rejection of unrelated/child/stopped sessions.
- Browser QA used a disposable Project and fake GitHub gateway with the real API and client: selecting the second account, saving, reload persistence, checking/saving state, failed verification preserving stored grants, revocation while GitHub was unavailable, and disabled controls for a view-only collaborator. The main publish link remained unchanged. The fixture server and browser tab were closed.
- Independent review found four issues (session rotation, existing source identity, revocation during listing, and cancellation). All were fixed, regression-tested, and reviewed again with no remaining actionable findings.
- An initial full run hit the existing intermittent `task_run_snapshot.test.ts` same-millisecond timestamp failure. The same failure was reproduced on an untouched archive of HEAD `6b48f38`; both later full runs passed. Unrelated snapshot code was unchanged. Existing Vite shutdown/port and bundle-size diagnostics were nonfatal.
- Implementation verification was performed locally on `codex/empty-project-repositories`, without a deployment, live account permission change, or installed Hermes modification. The user subsequently authorized committing, pushing, and tagging the changes as release `v0.7.16`.

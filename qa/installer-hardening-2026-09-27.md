# Install/update hardening — 27 September 2026

This records the code and documentation findings from the install/update review, on `codex/production-hardening` after checkpoint `0f2194b`. These checks did not update an installed service. The user subsequently authorized the v0.7.20 release; see [the release acceptance record](release-0.7.20.md) for its final version and gates.

## Changes

- Docker installation requires an explicitly selected image. Every update requires `--image`; an old `.env` image cannot silently become an update target. Slot images remain pinned to immutable identities. Source Compose builds use a local image name, and HA Compose requires explicit slot pins.
- Docker lifecycle commands reject a Hermes volume that conflicts with the saved installation before Docker calls or configuration changes. Installation saves a previously missing selection and preserves unrelated settings. Public-image failures never invoke `gh auth token` or configure registry credentials.
- macOS installation validates and saves the selected Hermes source, profile home and Python executable in the LaunchAgent. Updates use that saved identity, not incidental shell settings. Ambiguous legacy identity fails before build or drain. Explicit missing worker source fails instead of discovering another installation.
- Native backups use a private directory (700) and private database, archive and metadata files (600), independently of the caller's umask. Archive/finalization failure removes incomplete restore metadata while retaining the verified SQLite backup.
- Update discovery only accepts published stable GitHub Releases. Bare tags, drafts, prereleases and malformed release metadata cannot advertise an update. An installation ahead of the published release is not offered a downgrade.
- Installation, backup and updater guidance now describes public images, explicit releases, separate Olympus/Hermes backup coverage, and the distinction between single-service and blue/green deployments.
- Failed Docker promotion/rollback cannot resume the old writer if the candidate cannot be stopped, including when a start command may have partially succeeded. Proxy configuration changes use atomic file replacement so an existing Nginx reader can finish reading the previous complete file.

## Regression and integration evidence

The original reported defects were reproduced by failing regressions before their fixes. Fixtures use disposable directories and synthetic data. Docker and service-control boundaries are mocked in the ordinary suite; native plist rendering and SQLite backup integrity are exercised directly.

The full `npm test` run passed (exit 0), covering 183 TypeScript test files and 18 Python files. Nine existing native-dependency cases were skipped by the ordinary runner; this pass does not replace the separate native evidence in [the earlier reliability report](reliability-2026-09-26.md).

`npm run typecheck`, `npm run build`, `npm run lint:shell`, both Compose configuration checks and `git diff --check` passed. The built worker matches its source. The existing large client-bundle warning and Vite test-server shutdown diagnostic remain; they did not fail assertions or the build.

Independent review found two additional selection cases after the full suite: Docker update accepted a volume override inconsistent with `.env`, and a legacy macOS plist with a custom profile home could be incorrectly assigned the default source. Both received explicit regression coverage and focused re-verification before completion.

After both final selection corrections, the focused suite passed again: Docker install reliability, macOS install identity/update reliability, portable shell/packaging, standalone update reliability, update API/UI and worker source resolution. Shell/Compose checks, copied worker comparison and diff checks also passed again. A separate reviewer verified legacy macOS default/custom cases with actual PlistBuddy and unchanged fixture files.

Local logs: `/tmp/olympus-installer-full-tests.log`, `/tmp/olympus-installer-final-focused.log`, `/tmp/olympus-installer-typecheck.log`, `/tmp/olympus-installer-build.log`, `/tmp/olympus-macos-independent-legacy-check.log`. These are ephemeral developer-machine evidence, not public artifacts.

## Stronger Docker release gate

`tests/docker_e2e.sh` now starts from the real released v0.7.18 multi-platform manifest, pinned to `sha256:2ac9aafcced1be576acdb650342508e1469285370173094b3d664b679e2bd954`, rather than building both versions from the same checkout. The registry digest was checked directly. Only the candidate is built from the current source, and the harness verifies distinct image identities and each running version.

The synthetic persistence fixture covers a discoverable named Hermes profile, settings, a private placeholder credential, default/profile session history, Olympus tasks and the canonical Bot. It checks preservation after upgrade and rollback, alongside drain behavior, failed promotion recovery and Olympus backup/restore. All container state is unique and disposable. CI and release publication run this gate before publishing the release image.

The Python fixture's seed and verify modes first passed against the isolated pinned Hermes runtime using a disposable home. The subsequent real Docker gate below also verified them in the released and candidate images.

## Real Docker acceptance — completed

The user started OrbStack and authorized the local disposable test. Docker Engine 29.4.0 ran the application images on Linux arm64. No installed Hermes volume, credentials or Dokploy service were used. The existing cached Nginx image ran through Docker's amd64 compatibility; publication still requires the release workflow's multi-platform build.

The candidate was built successfully from this worktree as `olympus-dispatch:e2e-hardening-20260927-local`, image `sha256:8ce393f543901dfc3f23662fe2c5e2bee612e46b0fa49a4cdbcaa195dc939b6e`. Its package version remains 0.7.19; this is an unpublished hardening candidate, not the published v0.7.19 artifact. The worker in the image matches the source SHA-256 `07154fb36e231958663468d7c7fb4cca93318c4324d13f05ee478bd30ca2cba6`.

The final real lifecycle run exited 0 after checking:

- Dry-run reports, installation of released v0.7.18, and its actual running version.
- Upgrade to the distinct candidate image with readiness and persistent Olympus/Hermes fixture data.
- Authenticated drain rejection of new work and consistent SQLite backup integrity.
- Deliberately unreachable proxy candidate, the expected proxy-verification failure, recovery of the prior service, and stopped failed candidate.
- Rollback to the actual released image with the same profiles, settings, sessions, tasks and Bot.
- Restoration of a matching archive/database pair into a fresh volume and successful startup with the saved task and canonical Bot.

Runtime testing exposed two additional cases. The first run failed a one-shot proxy readiness check immediately after recovery; the harness now waits for the asynchronous proxy reload with bounded readiness retries. A later run caught Nginx reading a file being overwritten (`pread` returned fewer bytes than expected). Real held-file-descriptor regressions reproduced changed/truncated contents; atomic rename now preserves the prior reader. The harness also requires the intended proxy-verification error so an unrelated earlier failure cannot count as successful fault injection.

An independent source review found that failed candidate stops could be ignored before resuming the old instance. Four regressions first failed, then passed after both update and rollback were made fail-closed, including partial-start uncertainty. A second reviewer verified this ordering. These exceptional Docker-command errors are simulated; the real runtime gate exercises successful stops after a forced proxy failure.

After these final shell changes, portable lifecycle tests (six new cases plus existing checks), Docker installation tests (10 cases), packaging and standalone update reliability passed again. Shell syntax and diff checks passed. Application TypeScript/Python code did not change during this Docker continuation, so the prior full suite/typecheck and freshly built candidate remain applicable.

Final runtime log: `/tmp/olympus-installer-docker-e2e-atomic-final.log`. Focused log: `/tmp/olympus-docker-atomic-final-focused.log`. Earlier diagnostic logs remain under `/tmp/olympus-installer-docker-e2e*.log`. The final run used unique project `olympus-e2e-84246`; all test containers, volumes and networks were removed afterward. Only reusable local image/build caches remain.

## Remaining operational acceptance

Real macOS launchd restart acceptance was not performed against an installed Hermes home. No live provider authentication, live GitHub publication or deployment is claimed by this local Docker result. Later release publication is tracked separately in the release acceptance record.

The selected live installation's unavailable update hook is an operational issue still requiring its exact service, mount and runner configuration to be verified. These source changes do not configure that runner or update the live app. Follow `INSTALL.md`: review a dry-run for the selected installation, obtain approval for the concrete operation, preserve both stores, and verify readiness, data and a safe task after rollout.

This is code/build/regression evidence, not a production-readiness or deployed-fix claim. Release publication and live acceptance remain separate gates.

# Olympus Dispatch — Agent Installation Rules

Use these rules when a user asks to install, update, or operate Olympus Dispatch from this repository.

## Scope and safety

- Olympus is **local-first and standalone**. Operate only on the machine and Hermes installation the user explicitly named or is currently using.
- Never discover, contact, synchronize with, copy state from, or configure another host, VPS, Mac, profile directory, or Hermes installation.
- Preserve existing Hermes state, profiles, sessions, skills, credentials, and data volumes.
- Do not print, request in chat, commit, or log tokens, credentials, or secrets.
- Do not bind Olympus publicly by default. The default listener is loopback only.

## Installation workflow

1. Read `INSTALL.md` and identify macOS or Docker mode.
2. Inspect prerequisites and run the relevant installer with `--dry-run` first.
3. Report the exact local Hermes path or Docker volume the dry run selects.
4. Wait for explicit approval before a non-dry-run installation, update, restart, or configuration change.
5. Verify `GET /api/ready` after the operation. For a new installation, also run one safe test task and verify it reaches review.

## Docker-specific rules

- Reuse a Hermes data volume only after verifying it belongs to the selected local installation.
- If volume discovery is ambiguous, fail closed and ask the user to choose `--hermes-volume NAME`.
- Do not use `--yes` to bypass the user’s confirmation.

## Public releases

- The GitHub repository and `ghcr.io/digitalchili/olympus` image are public; no GitHub token is required to install or pull a release image.
- The installation-local updater uses a local Unix socket and an installation-local secret. It must never be exposed over the network or shared between installations.

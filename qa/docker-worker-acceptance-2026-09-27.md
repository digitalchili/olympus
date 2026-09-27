# Built-container worker and authentication acceptance

The disposable worker gate passed on 27 September 2026 against the release candidate `olympus-dispatch:release-check-0.7.20`, image `sha256:c406edf7ebb347086b6e8f2fc12005519626e501f6502037c224b90abab20ddc`. It also passed during development against the earlier unpublished hardening candidate. No installed service, host profile, real credential or model endpoint was used.

```sh
DOCKER_CONTEXT=orbstack sh tests/docker_worker_acceptance.sh olympus-dispatch:release-check-0.7.20
```

The runner uses a unique disposable container, read-only root filesystem, tmpfs state, no external network, and the image's unprivileged user. Only test files are mounted read-only. It imports the built worker/helper assets from `/opt/olympus-dispatch/dist/server/server/workers` and the pinned Hermes runtime from `/opt/hermes`; it does not substitute source worker files. The built worker SHA-256 was `07154fb36e231958663468d7c7fb4cca93318c4324d13f05ee478bd30ca2cba6`. All fixture containers were removed afterward.

## Passed evidence

- While the native model-inventory boundary was deliberately blocked, the actual JSONL worker handled health, settings, chat admission and explicit Stop before that boundary was released. Those operations completed in 0.031 seconds in the final local run, with per-response acceptance bounds of two seconds. This is responsiveness evidence, not a production latency baseline. Concurrent catalog misses shared one discovery call.
- The real auth helper subprocess executed native device-code request, pending polling, authorization-code exchange, native save and explicit credential check through a fake HTTP transport. No native OAuth parsing or persistence function was replaced. The public session supplied the expected trusted URL/code, duplicate Start reused the attempt, and received credentials remained unsaved until an internal guard permitted commit.
- Saving preserved the configured model and active provider. The resulting native auth store was mode 600. Cancellation and expiry preserved the saved credentials, and the worker remained available and shut down normally.
- Synthetic private token material, authorization-code details and deliberately noisy native stdout/stderr did not appear in public worker JSONL or worker stderr.
- The existing four native auth tests passed inside the image, including two profile processes rotating one shared root grant once. The existing real helper contract passed against built helper assets, covering inherited versus profile-owned credentials, unchanged shared state/defaults, account ownership after token loss, and rejection of a mismatched account. Networking in these reused fixtures is mocked or denied.

Final local log: `/tmp/olympus-docker-worker-acceptance-0.7.20.log`. Shell syntax and diff checks passed. The root integration owns the full suite and release lifecycle gate.

## Boundaries

The model turn is a no-model sentinel so the test proves admission and Stop without requesting a completion. Model inventory is blocked at its native I/O boundary. Auth HTTP is synthetic; this does not prove real OpenAI approval, account entitlement, network connectivity or successful live model execution. The worker-level test does not replace the existing Node cross-profile guard tests or browser acceptance. Forced host failure during credential storage remains untested. A user-approved live sign-in and safe task are still required, and the original reported production disconnects are not claimed resolved by this gate.

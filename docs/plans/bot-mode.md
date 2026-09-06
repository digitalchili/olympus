# Persistent Bot chats and messaging

## Approved scope

The user requested implementation of the two remaining additions: one persistent conversation per existing profile and native bot-to-bot messaging. This extends the existing chat architecture. It does not replace profiles, Kanban tasks, scheduled tasks or structured Project collaboration.

## Design and acceptance

- A `kind` discriminator identifies canonical Bot sessions stored alongside task metadata. A unique database index prevents duplicate Bot sessions per profile. Existing tasks migrate unchanged. Bot sessions keep the existing profile routing, Hermes history, SSE, attachments, settings, Stop, compact and run ledger.
- `/bots` shows the existing profile roster and each profile's canonical conversation. Bot conversations never enter Kanban/review or acquire Project editors. Tasks and their existing collaboration keep their current behavior.
- Only explicitly enabled Bot agents receive Hermes's native `message_agent(target, message)` schema. A worker-local transport bridge acknowledges a durable Olympus queue insert. It never falls through to Hermes's unmanaged CLI/background transport. Native support missing or bridge errors produce explicit tool errors.
- Olympus resolves the sender from the active run, validates an active local recipient, adds attribution and labels incoming Bot content as untrusted teammate material. No model-supplied sender identity, remote peers, shared credentials or shell interpolation is used.
- SQLite stores message receipts, correlated replies, chain deadlines and run contexts. Delivery uses the ordinary chat route and therefore participates in admission, profile deletion, Stop, watchdog and maintenance drain. User-queued work has priority. One active turn per Bot; at most ten requests per chain, three message hops, and fifty pending deliveries per recipient.
- A successful recipient turn atomically records its receipt and queues one attributed reply to the sender. Reply turns do not themselves generate automatic replies. Repeated identical sends within one source run return the original receipt. Uncertain interrupted deliveries remain visible for deliberate retry; pending messages survive restarts.
- Stop cancels the relevant exchange and its queued/active Bot runs; a late acknowledgement or recipient completion cannot restart a cancelled chain. Maintenance pauses dispatch until readiness resumes.

## Implementation plan

1. Add the kind migration, canonical session lookup and board/mutation boundaries; test with real isolated SQLite and profile fixtures.
2. Add the native worker schema/transport bridge and response RPC; test fail-closed behavior, concurrent identity, acknowledgement and interrupt handling.
3. Add queue/run/chain persistence, message dispatcher and chat lifecycle integration; test attribution, FIFO, deduplication, bounded exchanges, failure/restart, Stop and drain.
4. Add the Bots roster/chat and message receipts using existing client components; test board exclusion and visible controls, then exercise the browser at desktop/mobile sizes.
5. Run isolated regression tests, native Hermes bridge tests, typecheck, production build, independent review and Docker lifecycle checks. Commit and push the verified release; apply the established guarded updater to the selected installation and verify readiness and preserved storage.

## Release

Version 0.7.0 introduces the additive Bots feature. Preserve the existing data volumes and use the installed guarded updater. Production smoke tests must not send model prompts or messages without the user's authorization; this request authorizes implementing messaging, while deterministic fixtures cover message exchange without involving real teammates.

## Verification completed

- Full isolated regression suite, typecheck, production build, shell syntax and production dependency audit passed.
- Native Bot bridge tests passed against pinned Hermes commit `29112bef099274229cadff79cdff7bf7b99c4b77`, including real tool dispatch, MCP/compaction refresh and cancellation. Optional native recovery, background work and scheduled-drain regressions also passed with that runtime.
- Desktop and 390px mobile browser fixtures passed for profile switching, persistent history, mentions, delivery controls and board exclusion.
- Docker lifecycle tests passed for installation, canonical Bot persistence, maintenance drain, verified backup/restore, promotion, failed-promotion recovery and immutable rollback.
- Independent review of persistence, native transport, admission, cancellation, recovery and profile deletion found no remaining release blocker.

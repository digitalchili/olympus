# Interim delegation recovery acceptance

Hermes 0.21.7 can emit `task_failure_notice` before a detached batch finishes.
It deliberately returns an empty delivery claim for that notice. Treating it
as the final result leaves an Olympus `ack_pending` receipt that native Hermes
cannot acknowledge, even when the genuine final result is saved and pending.
Hermes also saves `partial: true` child results while the batch is running.

The fix ignores owned interim queue notices in final-result delivery, waits for
native batches to leave their active states, and rejects partial result payloads.
Legacy ready or acknowledgement-pending interim receipts are repaired only when
an owned terminal completed/error result remains undelivered. The original
receipt is preserved atomically in `superseded_interim_results`; normal worker
continuation then synthesizes and acknowledges the actual final once. Stopped,
ambiguous, foreign and already-consumed results are not silently repaired.

Validation:

- Regressions reproduced interim-receipt acceptance and premature partial-result
  promotion before their respective fixes.
- Unit coverage includes queue ownership, waiting siblings, existing receipt
  preservation, changed fingerprints, stopped/ambiguous states, consumed or
  foreign results, and ordinary terminal `unknown` evidence recovery.
- Real Hermes 0.21.7 tests run offline in the existing disposable acceptance
  image. They exercise its native ledger, empty interim claim, acknowledgement
  CAS, partial child persistence and notification while a sibling waits, then
  final delivery. Only the model boundary is a deterministic fixture.
- All 60 recovery tests passed against real Hermes; the complete project test
  suite, typecheck and production build passed. Independent review found the
  partial-result edge case above, which was fixed and re-reviewed.
- A separate offline compatibility probe ran the released 0.7.44 worker against
  a repaired receipt. It synthesized the actual final once, acknowledged native
  delivery and cleared the continuation without replaying the interim response.
- Production operation must use the selected installation, authenticated drain
  with zero active runs, private online backups and exact receipt validation.
  Repair does not replace an app, change a transcript, acknowledge a final or
  mark a task completed. Resume through normal recovery and verify its result.
- Release deployment still requires green CI, unchanged remote main, zero active
  runs, the unchanged full maintenance guard, backups and live readback.

The release also includes the previously verified composer draft fix from
v0.7.45. No model, provider, task limit or unrelated application changes.

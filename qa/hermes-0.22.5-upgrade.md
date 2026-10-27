# Hermes 0.22.5 compatibility

Target: Olympus 0.7.50 with official Hermes 0.22.5,
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`, immutable multi-platform image
`sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d`.
The upstream annotated tag and image install stamp agree (2026-10-27).

## Scope

Only the pinned runtime, release version, compatibility documentation and
acceptance coverage change. The downstream selective-skills patch is byte-for-byte
unchanged. No one-shot session marker, tool restrictions, delegation limits or
task/repository queue behavior is added. Existing conversations retain their
native cached prompts; fresh chats receive the selective policy.

## Executed locally

- The new native policy regression failed on pristine upstream 0.22.5 because
  regular sessions still used the broad skill-loading prompt. It passed in the
  patched image, including retained normal-session tools, identical skill catalog,
  consolidation guidance and separate one-shot restrictions.
- Built production image succeeded. Native worker acceptance passed: sign-in and
  guarded credential saves, shared refresh, clarification/approval, history and
  signed thinking, delegation reasoning, background work, steering, Bot messaging,
  Project GitHub and 60 recovery tests. Three real streamed/resumed Hermes turns
  retained the selective prompt and skill-authoring tool, discovered an added
  skill, and preserved the cached prompt without duplicate announcements.
- Independent review found no blocking code issues. Current-runtime documentation
  references identified by review were updated.
- Full Olympus test suite and typecheck passed. Production audit passed the high
  threshold; three existing low-severity KaTeX-related findings remain.
- Disposable Docker upgrade from released Olympus 0.7.49 / Hermes 0.21.7 to the
  candidate passed, including named profiles, private settings and sessions,
  task/Bot persistence, drain, online backup/integrity, restore, forced failed
  promotion recovery and rollback to 0.7.49.

Native tests use real installed Hermes with synthetic provider I/O and no
external networking or production credentials. Python 3.14 emitted resource
warnings from test database lifetimes; the tests completed successfully.

## Deployment acceptance

Production deployment and real model/tool/delegation/queue verification are
pending. They require an idle window, maintenance checks, fresh online backups,
preserved-state readback and fresh Olympus fixture tasks. Local tests alone do
not prove the live flow. Anthropic OAuth is not part of this installation's live
acceptance and is not claimed as tested.

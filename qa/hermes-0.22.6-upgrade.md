# Hermes 0.22.6 compatibility

The official release tag and image install stamp both identify commit
`f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab`; the immutable multi-platform
image digest is `sha256:d27689bc6e8581ec884a7227c9101fdaebf6c853cff8859020dac14f21452b4d`.

The existing selective-skills patch was adapted to the native prompt builder.
Hermes 0.22.6's one-shot tool behavior and compaction safety rule stay native.
The pristine image fails Olympus's selective-guidance regression; the patched
image passes it. The worker acceptance suite passed with disposable state and
synthetic provider traffic, including sign-in, interactions, recovery and
three streamed/resumed turns. The test transport restores its test-only Python
path because this Hermes release resets that path during worker startup.

An independent supplemental review ran 190 upstream prompt, one-shot and
compaction tests with the candidate image; upstream root fixtures and platform
gating were excluded and three unknown-marker warnings were emitted. It also
passed the native scheduled-drain and Project secret execution tests.

The disposable Docker upgrade suite passed from released Olympus 0.7.58 to the
candidate, including profile/session persistence, backup/restore, a simulated
failed promotion and rollback. Live provider behavior and the VPS deployment
require separate verification; no real credentials were used in these tests.

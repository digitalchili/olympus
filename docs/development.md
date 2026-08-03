# Development

Use Node.js 22.22–25 (Node 22 LTS recommended) and run `npm ci`, `npm test`, and `npm run build`. Production assets are copied by `scripts/build-assets.mjs`; no host `rsync` is needed.

Runtime changes should be developed vertically: add one failing behavior test, confirm its expected failure, implement the smallest change, and rerun before the next behavior. Keep schema changes additive. The database uses WAL, an explicit 5-second busy timeout, and an immediate transaction around startup migration.

The direct Hermes Python worker is the feature-complete default. Do not replace it with a gateway-only implementation unless goals, compaction, steering, settings, sessions, and scheduled tasks have parity.

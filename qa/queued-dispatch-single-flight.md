# Queued message dispatch single flight

A saved message may be scheduled repeatedly while a previous dispatch is still awaiting admission. Previously the dispatcher removed its scheduled marker before awaiting delivery, allowing a second request for the same task to race the first. Somboon logs showed repeated HTTP 409 admission conflicts for the Android task. This race can contribute to those errors; it has not been proven to explain the entire delay. The original question was ultimately delivered and answered.

The dispatcher now permits one delivery per task at a time and rechecks a pending schedule once it settles. Different tasks remain independent; a message already consumed is not replayed; a failed attempt reaches the error handler and a pending retry remains serialized. Browser/manual requests can still collide with a server request, and this change does not resolve every possible admission blocker.

A regression reproduced two overlapping deliveries before the fix and passes afterward. Node 22 full tests, build, typecheck, and independent review passed. The native SQLite dependency did not load under unsupported Node 26; validation used the supported Node 22 runtime.

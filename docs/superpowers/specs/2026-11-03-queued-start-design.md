# Queued task startup

Olympus currently lets both the browser and server start the same saved request. A slow background-work check exposes a false busy warning before one request succeeds. Michael asked for a simple fix, so coordinate matching requests at the existing admission point and return the actual outcome to both. Keep explicit retry and genuine failure reporting; never hide unrelated conflicts.

New tasks and successful follow-ups must still start without an open browser. Failed or stopped work must not replay automatically; saved requests, selected settings, attachments, project preparation, replacement protection, and manual retry must remain intact. Never start a second agent for a single saved request. Diagnose earlier hangs independently, without inventing their cause or restarting the VPS.

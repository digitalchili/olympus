# Bot conversations and messaging

Version 0.7.0 adds a **Bots** view over the existing local Hermes profiles. Select a Bot to return to its persistent conversation. Switching profiles, reloading the browser, restarting Olympus and compacting context keep the same conversation identity.

The chat supports attachments, model/reasoning selection, streaming, Stop and compaction. It stays outside the Kanban board. Use **New Task** for coding goals and Project repository work; existing task collaboration and recurring tasks retain their own workflows.

## Asking a teammate

Mention another profile in a Bot chat, for example:

> Ask @writer to suggest a concise introduction, then review the result.

The Bot receives the local roster and decides what context to send using Hermes's native `message_agent(target, message)` tool. Olympus validates the sender and recipient, saves the request, and returns a queue receipt. The recipient responds in its own persistent conversation; Olympus then queues one attributed reply to the sender. The sender can finish its first turn while waiting for that reply.

Expand **Bot messages** to see requests and replies, their sender and recipient, and delivery status. A queue acknowledgement does not mean the recipient has finished. Failed or interrupted deliveries show an error and a **Retry delivery** action. Check the recipient's chat before retrying an interrupted operation: tools may have run before interruption. **Cancel delivery** stops that exchange and its pending or active Bot turns. The chat's **Stop** also cancels its associated exchanges.

Teammate messages are attributed, untrusted advisory material. They do not supply new user authorization or access to another profile's files or credentials. Ordinary tasks keep their structured collaboration workflow; the native messaging interface is enabled only in Bot conversations.

## Runtime and limits

Olympus imports Hermes `AIAgent` directly. This feature uses the native messaging schema with an Olympus transport; it does not install Hermes Desktop's Bot Mode plugin, alter Desktop roster metadata, or launch an additional gateway or independent Hermes process.

The bundled Docker runtime pins Hermes v2026.8.31. Other installations must expose its compatible native messaging schema and tool refresh hooks; missing support produces an explicit error. Native tool refresh and compaction retain the authorized messaging tool.

- Only existing active profiles on the selected local installation are eligible. Self-messaging and remote peers are excluded.
- An exchange allows at most ten outgoing requests and three message hops within a shared deadline. The recipient's pending inbox is capped at fifty requests/deliveries at admission.
- Replies are correlated to requests and do not automatically generate another reply. Identical requests from the same Bot within one exchange return their existing receipt.
- One active chat turn per Bot; queued user messages have priority over incoming Bot delivery.
- Maintenance pauses new delivery. Accepted turns remain part of Olympus's normal drain and shutdown accounting.
- Pending messages survive restart. In-flight deliveries become visibly interrupted and are not automatically replayed. Explicit retry retires the old exchange before admitting a new attempt.

Hermes continues to own chat transcripts. Olympus stores canonical session metadata, delivery payloads and receipts in SQLite, using the existing state volume. Existing profiles, sessions and Project storage remain in place.

## Verification

Regression tests cover SQLite migration and uniqueness, profile isolation, board exclusion, literal message transport, native schema/acknowledgement handling, tool refresh, correlated replies, duplicate sends, deadlines and hop limits, Stop races, restart recovery, disconnected retry ownership, profile deletion, and maintenance admission. Browser fixtures exercise the real client without model calls. Docker lifecycle checks additionally verify canonical Bot identity in the live database, verified backup, upgraded service and restored service.

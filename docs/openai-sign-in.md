# OpenAI sign-in

Open **Settings → Providers → OpenAI sign-in**. The shared login is the default for profiles that do not have a separate OpenAI account. Selecting another model in a profile's settings does not require creating a separate OpenAI login and is not changed by signing in.

1. Choose **Sign in to OpenAI**.
2. Copy the code and select **Open OpenAI sign-in**. Complete the account verification on OpenAI's page, then return to Olympus. No server terminal is needed.
3. Olympus detects approval and saves the login. If affected tasks are running, it waits for them to finish. You can cancel the pending sign-in without stopping tasks.

Existing profile-owned logins remain separate. On a named profile, Settings also offers **Separate login** for intentionally managing that profile's account. Reconnecting a known account requires the same account/workspace. Olympus does not silently replace an owned account with the shared login when credentials disappear.

When a task stops because its OpenAI login needs attention, **Reconnect OpenAI** opens this flow inside the task. After reconnecting, review the saved progress and select **Continue task**. Authentication alone never resends a message or replays unfinished actions.

**Check saved login** checks the stored credentials and lets Hermes renew them when possible. It makes no model request. A successful check confirms saved credentials; it does not prove that the next model request will succeed. Temporary connection failures can be checked again without a new sign-in. A revoked or expired refresh grant can still require your consent through OpenAI's page.

The device code expires after its authorization window. Navigation within Olympus preserves an active attempt; reopening the card restores it while its worker remains alive. A worker/application restart requires a new attempt. Advanced credential pools and disabled entries continue using their existing native management flow.

This feature uses application code and native OAuth helpers. It does not require a backup model, does not send work to another provider, and does not change profile model selections.

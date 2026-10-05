# Project secrets

Project secrets let Olympus run local tests against databases and AI services without putting credentials into task conversations or repository files. They belong to a Project; model-provider credentials in Settings → Providers are separate.

## Save from task chat

Click **Add secret** beside the composer, or open **Project Settings → Secrets → Add secrets**. In that explicit form, enter named credentials or a dotenv block. For example, using a fake value:

```text
API_KEY=example-only-not-a-real-key
```

Review the variable names and choose **Save secrets**. Values are masked. A task in a Project uses that Project; a standalone task asks you to select one and stays in its current location. This also works from New Task without creating a task or calling a model.

Ordinary task text is never classified as secret entry. Pasting, typing, sending, queueing, steering and answering a task question do not open the form or save secrets, even when the text contains assignments, credential-like examples or `/secrets`. Long pasted text follows the normal text-attachment behavior. Use the explicit form when you want encrypted secret storage.

The save confirmation contains names only and is not written to the agent's conversation. Values entered through the form stay out of chat history, queued messages and title generation. Secret entry works without a running model. `.env` and `.env.*` chat file attachments remain rejected; choose **Add secret** to paste their contents into the form. Other attachments are not scanned for credentials.

Use this feature inside Olympus. There is no secret-saving tool for the model, Bots or Telegram. Pasting a credential into Telegram still sends it to Telegram and its connected service.

## Manage and use secrets

Project Settings lists names and offers **Replace** and **Remove**. Saving an existing name replaces its value. Values cannot be revealed through the UI or API. Removal affects future commands; an already-running process has its own environment. Deleting a Project removes its saved encrypted entries.

After saving, send an ordinary instruction such as “Use DATABASE_URL to test the database connection.” Project tasks with contributor access see available variable names. The agent uses `project_run` with a foreground command and the names it needs. Olympus supplies those values only to that command's child process in the task workspace. Normal terminal commands do not inherit them, and Olympus does not create a plaintext `.env` file.

`project_run` respects Hermes terminal availability and native command approval. It returns bounded, redacted output; common encodings and database URL passwords are also redacted. Stop, loss of the worker, or loss of task/project access terminates the owned process group. There is no automatic command runtime limit. This feature supports foreground tests; it does not manage persistent preview servers or background services.

## Storage and recovery

Values are encrypted with AES-256-GCM in the Olympus SQLite database. The installation's private encryption key is `data/project-secrets.key` under `OLYMPUS_DISPATCH_HOME`. It is created on first save, is owned by the application user, and must retain mode `600`. Each encrypted value is bound to its Project and variable name.

Back up the database **and its matching state archive**, including the encryption key. The existing Docker backup and macOS updater backup include this file in the non-database state archive. A database-only backup cannot recover secrets. Restore the key with its original permissions and the appropriate application owner. Missing, corrupt or insecure key files fail closed; Olympus does not silently replace a missing key while encrypted entries exist. See [backup and restore](backup-restore.md).

## Trust boundary

Olympus still assumes a trusted local caller. Secret-entry request checks protect against cross-site browser writes; they do not add authentication. Remote deployments need their existing protected access boundary, and the application state and backups must remain private.

Local test code receives the selected credentials and must be trusted. Encryption and output redaction do not sandbox programs or prevent deliberate file writes, network transmission, arbitrary encodings or access by another process running as the same operating-system user. Prefer service-scoped development credentials appropriate for the tests you authorize.

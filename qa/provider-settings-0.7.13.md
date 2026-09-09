# v0.7.13: profile provider and model setup

Settings → Providers adds a DeepSeek preset and generic OpenAI-compatible endpoint editor around native Hermes configuration. Successful model discovery and real completion responses are required before selected models are saved. The default is changed only through the separate explicit action. API keys are write-only, profile-scoped, and not present in task transcripts.

Verification performed:

- Seventeen Python provider tests use a local HTTP server and temporary profile configuration. Cases cover discovery without writes; selected-model testing; rejected credentials/unknown models; native placeholder-key rejection; secret reuse; endpoint changes; blank keys restricted to local endpoints; disconnect/default protection; busy tasks; rollback and silently refused native writes; advanced authentication and credential pools; disabled entries; concurrent default changes; redirects; and responsive worker health during connection testing.
- Twenty-one worker resolution tests include duplicate model names across providers, explicit provider precedence and preservation of the configured default.
- API tests check resolved profile routing, request field allowlisting, invalid actions and redacted failures. Model resolution/UI tests pass.
- The real React component was exercised through the browser with simulated HTTP: add, discover, failed authentication, successful save, editing selected models with a retained key, explicit default selection, and disabled disconnect for the default. Desktop and 390-pixel layouts were visually inspected.
- Native Hermes source at `40420a619b588049f138889add2417cb9dcb7b91` was exercised with a disposable Python environment, temporary Hermes profile and local HTTP endpoint. Save/load, private `.env` permissions (0600), native runtime URL/credential resolution, placeholder-key rejection, matching test/runtime credentials for keyless local endpoints, and disconnect passed. No live API key or paid model was used.
- Full `npm test`, type checking, production build, shell syntax checks and production dependency audit passed. The focused provider/routing tests and build were repeated after final review fixes; the audit reported zero vulnerabilities.

Run focused checks with `node scripts/run-tests.mjs tests/test_worker_providers.py tests/test_hermes_worker_resolve.py tests/provider_settings.test.ts tests/model_resolution.test.ts tests/model_resolution_ui.test.ts`. For UI checks, run `npx vite --config tests/fixtures/vite.config.ts` and open `http://127.0.0.1:4183/tests/fixtures/providers.html`.

Actual DeepSeek/account authentication remains for the user to test by entering a key in the upgraded UI. This work does not change any live Hermes credentials, restart the user's installation or deploy Olympus.

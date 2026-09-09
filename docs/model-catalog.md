# Remote model catalog

Olympus reads this repository's `catalog/model-catalog.json` when the model picker refreshes. The worker caches it for one hour by default. Set `OLYMPUS_DISPATCH_MODEL_CATALOG_TTL_SECONDS` to change that interval; it has a one-minute minimum so a broken network path cannot block every picker opening.

The catalog is **metadata only**, never an execution authority. A remote entry may rename an exact provider/model pair already reported by the selected profile's live credential-compatible Hermes inventory. It cannot add a runnable model, even when the provider is authenticated. Hermes still performs its normal validation when a task starts. If the remote catalog cannot be read or parsed, Olympus continues with the Hermes-provided list.

Schema `version: 1`:

```json
{
  "version": 1,
  "models": [
    {"provider": "openai-codex", "id": "gpt-5.5", "label": "GPT-5.5"}
  ]
}
```

Use a normal reviewed commit to update labels or retire metadata. A catalogue entry only has an effect on installations whose active profile already reports that exact model as runnable.

## Provider and model setup

Settings → Providers configures API endpoints for the selected local Hermes profile. Start with the DeepSeek preset or a custom OpenAI-compatible base URL. Discover the endpoint's models, select the models to expose, then choose **Test and save**. Each selected model receives a small no-tool chat completion request; these requests may consume provider credit. Model names alone are not accepted, and failed tests leave the existing connection intact.

New endpoints use Hermes's `providers` configuration with `key_env` referencing a secret in the selected profile's `.env`. Credentials are never returned by the API or stored in task messages. The profile's `olympus-provider-checks.json` contains only verification fingerprints and timestamps. Connected means the configuration still matches a successfully tested and persisted connection; it is not a guarantee of future quota or availability.

Edit a connection to replace its key, change its endpoint, refresh discovery or change selected models. An endpoint change requires explicitly entering the key again. **Disconnect** removes the endpoint and its Olympus-owned key when not shared. Advanced auth configurations, credential pools, disabled endpoints and other API protocols are not edited by this interface.

Adding or editing a connection preserves the profile's current default. **Use as profile default** is an explicit separate action. Existing task model overrides stay intact, including when another endpoint offers the same model ID. Choose another default before disconnecting its provider or removing its model. Changes are refused while this profile has active agent turns; no task is interrupted or worker restarted. Network testing stays off the worker's JSONL reader so health and Stop requests remain responsive.

The initial editor supports HTTPS endpoints and HTTP on localhost. Remote endpoints require an explicit or previously saved API key; blank keys are supported only on local endpoints. It requires an OpenAI-compatible `/models` response and `/chat/completions`; redirects are rejected. It does not configure OAuth or credential pools. Endpoint discovery and configuration formats follow [DeepSeek's API documentation](https://api-docs.deepseek.com/) and [Hermes model configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models).

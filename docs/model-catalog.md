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

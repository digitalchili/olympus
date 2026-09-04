# Remote model catalog

Olympus reads this repository's `catalog/model-catalog.json` for additive model
entries. The worker checks it on a picker refresh and caches it for one hour by
default. Set `OLYMPUS_DISPATCH_MODEL_CATALOG_TTL_SECONDS` to change that
interval; it has a one-minute minimum to prevent a broken network path from
blocking every picker opening.

The catalog is deliberately **not** an execution authority. An entry appears
only when Hermes already reports its provider as authenticated for the selected
profile. Hermes still performs normal provider/model validation when the task
starts. If the remote catalog cannot be read or parsed, Olympus continues with
the Hermes-provided list.

Schema `version: 1`:

```json
{
  "version": 1,
  "models": [
    {"provider": "openai-codex", "id": "gpt-6-astra", "label": "GPT-6 Astra"}
  ]
}
```

Use a normal reviewed commit to add or retire an entry. Existing Olympus
installations pick up the catalog change on their next refresh interval without
a binary or package update.

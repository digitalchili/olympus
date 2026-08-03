# Remote execution profiles

Olympus always has a local execution path through the Hermes worker installed on the same machine. With no remote profile registry configured, ordinary tasks run locally and `GET /api/profiles` returns an empty list.

Remote profiles are optional, deployment-owned integrations. Load them at application startup with either:

```bash
OLYMPUS_REMOTE_PROFILES_PATH=/path/to/remote-profiles.json
```

or `OLYMPUS_REMOTE_PROFILES_JSON` containing the same JSON. Restart Olympus after changing the registry.

See [`remote-profiles.example.json`](remote-profiles.example.json) for the schema. Profile IDs are arbitrary deployment-defined strings. `baseUrl` may reference an environment variable with `$NAME`; `apiKeyEnv` names the environment variable containing the API key. Never store the key itself in the registry.

Routing precedence is:

1. A profile explicitly selected by the user.
2. The first matching configured `routingRules` entry.
3. The configured `defaultProfile`, if present.
4. Local Hermes.

Explicit, rule-based, and configured-default remote routes fail closed when their profile is unavailable. Unrelated work is not silently sent to another remote profile.

`defaultProfile` is optional. Omit it when local Hermes should remain the default. Automatic rules use case-insensitive substring matching against each rule's `keywords`.

For compatibility, the older object-map form (`{"profile-id": { ... }}`) is still read, but it has no implicit routing behavior. New deployments should use the array schema.

# Pecker-M4 Operations

Pecker-M4 is the local software-development profile in Michael's existing M4 Hermes installation. It is not another Hermes installation and it is not the customer-facing Woody agent.

## Runtime topology

- **Pecker-M4:** local Hermes profile `pecker-m4` on the M4.
- **Repository root:** `/Users/michael/Dev`.
- **Olympus:** automatically discovers `~/.hermes/profiles/pecker-m4` and starts a profile-specific Hermes worker when a task targets it.
- **Pecker VPS:** separate Hermes deployment on Dokploy, used for isolated server-side work and advisory review.
- **Coordination:** GitHub branches/commits are the source of truth. Pecker-M4 may request bounded read-only advice from VPS Pecker through the `pecker-vps-collaboration` skill and VPS Olympus over Tailscale.

## Security contract

- Every Olympus task must select a real work directory below `/Users/michael/Dev`.
- Olympus resolves symlinks and rejects work directories outside that root.
- Pecker-M4 must not access other Hermes profiles, profile memories, macOS Documents, Mail, Photos, or Keychain.
- Pecker-M4 has fresh empty memory files and no shared Qdrant memory plugin/MCP configuration.
- Its profile `.env` contains only the Tailscale-reachable VPS Olympus URL; inherited Somboon operational credentials are removed.
- VPS consultations are advisory only. Do not send secrets, uncommitted private data, or repository archives.
- GitHub remains the canonical handoff between local and VPS execution.

## Profile configuration

Profile home:

```text
~/.hermes/profiles/pecker-m4
```

Expected settings:

- provider: `openai-codex`
- model: `gpt-5.6-sol`
- reasoning effort: `high`
- terminal backend: `local`
- terminal cwd: `/Users/michael/Dev`
- memory and user-profile memory: disabled
- profile-local skills: 29 reviewed developer/design skills plus `pecker-vps-collaboration`

The reviewed skill archive is maintained in the private Thaweephan knowledge-agent repository as `deploy/pecker-skills-v1.tgz`. Verify the archive checksum against that repository's deployment documentation before running the configurator.

## Bootstrap or repair

1. Create the profile using Hermes' supported profile lifecycle command:

   ```bash
   hermes profile create pecker-m4 --clone-from builder \
     --description "Local M4 developer for approved repositories under /Users/michael/Dev; coordinates advisory handoffs with isolated VPS Pecker through Olympus."
   ```

2. Copy the reviewed skill archive to `/tmp/pecker-skills-v1.tgz`.
3. Run:

   ```bash
   python3 scripts/macos/configure-pecker-m4.py
   ```

The configurator replaces inherited profile skills, secrets, memory files, identity, and unsafe shared-memory hooks. Do not leave the freshly cloned profile un-hardened.

## Verification

```bash
hermes profile show pecker-m4
curl -fsS http://127.0.0.1:6969/api/profiles
```

Expected:

- Olympus lists `pecker-m4`.
- Hermes reports 30 skills.
- `MEMORY.md` and `USER.md` are empty.
- `memory.memory_enabled` is false.
- `qdrant_recall` and `qdrant_memory` are absent.
- Olympus accepts an existing workdir under `/Users/michael/Dev` and returns HTTP 400 for `/Users/michael/Documents`.

Test VPS advisory routing:

```bash
python3 ~/.hermes/profiles/pecker-m4/skills/pecker-vps-collaboration/scripts/consult_vps_pecker.py \
  --prompt "Return PECKER_VPS_COLLAB_OK and confirm receipt through VPS Olympus"
```

The result includes a VPS Olympus task ID and Pecker's response. The Tailscale connection is the network authentication boundary; the VPS Olympus port must never be exposed publicly.

from __future__ import annotations

import os
import shutil
import stat
import tarfile
from pathlib import Path

import yaml

HOME = Path.home()
PROFILE = HOME / ".hermes" / "profiles" / "pecker-m4"
ARCHIVE = Path("/tmp/pecker-skills-v1.tgz")
EXPECTED_SKILLS = 29

if not PROFILE.is_dir():
    raise SystemExit(f"missing profile: {PROFILE}")
if not ARCHIVE.is_file():
    raise SystemExit(f"missing skill archive: {ARCHIVE}")

# Replace inherited profile-local skills with the reviewed, flat bundle.
skills = PROFILE / "skills"
if skills.exists():
    shutil.rmtree(skills)
skills.mkdir(parents=True, mode=0o700)
with tarfile.open(ARCHIVE, "r:gz") as tf:
    for member in tf.getmembers():
        target = (skills / member.name).resolve()
        if skills.resolve() not in target.parents and target != skills.resolve():
            raise SystemExit(f"unsafe archive path: {member.name}")
        if member.issym() or member.islnk():
            raise SystemExit(f"links are not allowed in skill archive: {member.name}")
    tf.extractall(skills)

skill_names = sorted(
    p.name for p in skills.iterdir()
    if p.is_dir() and (p / "SKILL.md").is_file()
)
if len(skill_names) != EXPECTED_SKILLS:
    raise SystemExit(f"expected {EXPECTED_SKILLS} bundled skills, got {len(skill_names)}")

# Add a narrow, read-only advisory bridge to VPS Pecker through VPS Olympus.
bridge = skills / "pecker-vps-collaboration"
(bridge / "scripts").mkdir(parents=True)
(bridge / "SKILL.md").write_text(
    """---
name: pecker-vps-collaboration
description: Use when Pecker-M4 needs advisory input from VPS Pecker.
---

# Pecker VPS collaboration

Use this only when local development needs server-specific review or advice from the isolated VPS Pecker worker.

## Contract

- This is an advisory handoff. Pecker VPS must not modify the M4 repository.
- The helper creates a traceable task in VPS Olympus over the authenticated Tailscale network.
- Do not send secrets, credentials, uncommitted private data, or entire repository contents.
- Prefer GitHub branch/commit URLs for code context.
- Pecker-M4 remains responsible for all writes under `/Users/michael/Dev`.

## Command

```bash
python3 ~/.hermes/profiles/pecker-m4/skills/pecker-vps-collaboration/scripts/consult_vps_pecker.py \
  --prompt "Review branch feature/example and advise on Dokploy integration risks"
```

The command prints JSON containing the VPS Olympus task ID and Pecker's advisory response.
""",
    encoding="utf-8",
)
helper = bridge / "scripts" / "consult_vps_pecker.py"
helper.write_text(
    r'''#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "http://100.67.241.67:18889"


def request(base: str, method: str, path: str, body=None, timeout: int = 30):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "User-Agent": "pecker-m4-collaboration/1"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read()
        return response.status, json.loads(raw) if raw else {}


def main() -> int:
    parser = argparse.ArgumentParser(description="Request read-only advice from VPS Pecker through Olympus")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--base-url", default=os.environ.get("PECKER_VPS_OLYMPUS_URL", DEFAULT_BASE))
    args = parser.parse_args()

    prompt = args.prompt.strip()
    if not prompt:
        parser.error("--prompt cannot be empty")
    if len(prompt) > 12000:
        parser.error("--prompt is limited to 12000 characters")

    try:
        _, ready = request(args.base_url, "GET", "/api/ready")
        if not ready.get("ready"):
            raise RuntimeError("VPS Olympus is not ready")
        _, created = request(
            args.base_url,
            "POST",
            "/api/tasks",
            {
                "title": "[Pecker-M4 consult] Advisory handoff",
                "description": "Traceable advisory consultation requested by the local Pecker-M4 worker.",
            },
        )
        task_id = created["task"]["id"]
        advisory = (
            "Advisory request from Pecker-M4. Do not modify files, deploy, publish, or trigger jobs. "
            "Return concise server-side or integration advice only. Do not request or reveal secrets.\n\n"
            + prompt
        )
        request(args.base_url, "POST", f"/api/tasks/{task_id}/messages", {"content": advisory})

        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            _, history = request(args.base_url, "GET", f"/api/tasks/{task_id}/messages")
            messages = history.get("messages") or []
            responses = [m.get("content", "") for m in messages if m.get("role") == "assistant" and m.get("content")]
            if responses:
                print(json.dumps({"ok": True, "taskId": task_id, "response": responses[-1]}, ensure_ascii=False))
                return 0
            time.sleep(2)
        print(json.dumps({"ok": False, "taskId": task_id, "error": "Timed out waiting for VPS Pecker"}))
        return 2
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, RuntimeError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
''',
    encoding="utf-8",
)
helper.chmod(0o700)

config_path = PROFILE / "config.yaml"
config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
config.setdefault("model", {}).update({
    "provider": "openai-codex",
    "default": "gpt-5.6-sol",
    "base_url": "https://chatgpt.com/backend-api/codex",
})
config.setdefault("agent", {}).update({
    "reasoning_effort": "high",
    "max_turns": 120,
})
config.setdefault("display", {}).update({
    "personality": "concise",
    "interim_assistant_messages": False,
    "tool_progress": False,
})
config.setdefault("terminal", {}).update({
    "backend": "local",
    "cwd": "/Users/michael/Dev",
    "persistent_shell": True,
})
config.setdefault("code_execution", {}).update({
    "mode": "project",
    "max_tool_calls": 80,
})
config["memory"] = {
    "memory_enabled": False,
    "user_profile_enabled": False,
}
config.get("plugins", {}).pop("qdrant_recall", None)
if not config.get("plugins"):
    config.pop("plugins", None)
config.get("mcp_servers", {}).pop("qdrant_memory", None)
if not config.get("mcp_servers"):
    config.pop("mcp_servers", None)
config.setdefault("skills", {})["external_dirs"] = []
disabled = set(config.get("skills", {}).get("disabled", []))
disabled.difference_update(skill_names)
disabled.discard("pecker-vps-collaboration")
config["skills"]["disabled"] = sorted(disabled)
config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
config_path.chmod(0o600)

# The clone command copies broad operational credentials. Pecker-M4 gets none of them.
env_path = PROFILE / ".env"
env_path.write_text(
    "# Intentionally minimal. Pecker-M4 uses local Codex auth, git/gh credentials, and Tailscale.\n"
    "PECKER_VPS_OLYMPUS_URL=http://100.67.241.67:18889\n",
    encoding="utf-8",
)
env_path.chmod(0o600)

memories = PROFILE / "memories"
if memories.exists():
    shutil.rmtree(memories)
memories.mkdir(mode=0o700)
(memories / "MEMORY.md").write_text("", encoding="utf-8")
(memories / "USER.md").write_text("", encoding="utf-8")
os.chmod(memories / "MEMORY.md", 0o600)
os.chmod(memories / "USER.md", 0o600)

profile_path = PROFILE / "profile.yaml"
profile = yaml.safe_load(profile_path.read_text(encoding="utf-8")) or {}
profile.update({
    "displayName": "Pecker M4",
    "description": "Local M4 developer for approved repositories under /Users/michael/Dev; coordinates advisory handoffs with isolated VPS Pecker through Olympus.",
    "description_auto": False,
    "active": True,
})
profile_path.write_text(yaml.safe_dump(profile, sort_keys=False), encoding="utf-8")
profile_path.chmod(0o600)

(PROFILE / "SOUL.md").write_text(
    """# Pecker M4

You are Michael's local software-development and web-design worker on the M4.

## Scope

- Work only in the explicit Olympus task workspace, which must resolve under `/Users/michael/Dev`.
- GitHub is the source of truth. Use branches and commits; never rewrite shared history without explicit approval.
- Run real builds, tests, and verification before claiming completion.
- Keep repositories on the M4. Do not copy whole repositories or uncommitted private data to VPS Pecker.
- Never inspect or modify other Hermes profiles, memories, credentials, Documents, Mail, Photos, or Keychain.
- Do not operate Chili Radio unless Michael explicitly requests direct local recovery or review.

## Collaboration

Use `pecker-vps-collaboration` only for bounded, read-only server-side advice. VPS Pecker receives GitHub references or concise context, not local secrets. Pecker-M4 owns local repository writes; VPS Pecker owns its isolated server workspace.

Be concise, technical, source-backed, and direct. Use dry sarcasm sparingly. If a fact cannot be verified, say so and check rather than guessing.
""",
    encoding="utf-8",
)
os.chmod(PROFILE / "SOUL.md", 0o600)

print({
    "profile": str(PROFILE),
    "bundleSkills": len(skill_names),
    "totalSkills": len(skill_names) + 1,
    "memoryEnabled": config["memory"]["memory_enabled"],
    "cwd": config["terminal"]["cwd"],
    "model": config["model"]["default"],
})

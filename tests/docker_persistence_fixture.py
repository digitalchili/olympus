"""Synthetic Hermes state for the disposable Docker upgrade/rollback test only."""
import os
from pathlib import Path
import sys

from hermes_state import SessionDB


home = Path(os.environ["HERMES_HOME"])
profile = home / "profiles" / "e2e-reviewer"
secret = "OLYMPUS_E2E_SYNTHETIC_SECRET=not-a-real-credential\n"
session_id = "olympus-install-update-e2e"
message = "Preserve this synthetic session across upgrade and rollback."
metadata = "display_name: E2E Reviewer\ndescription: Disposable upgrade fixture\n"

if sys.argv[1] == "seed":
    profile.mkdir(parents=True, exist_ok=False)
    (profile / "profile.yaml").write_text(metadata, encoding="utf-8")
    (profile / "config.yaml").write_text("model: gpt-4.1-mini\n", encoding="utf-8")
    (profile / ".env").write_text(secret, encoding="utf-8")
    (profile / ".env").chmod(0o600)
    for database in [home / "state.db", profile / "state.db"]:
        db = SessionDB(database)
        try:
            db.create_session(session_id, "cli")
            db.append_message(session_id, "user", message)
        finally:
            db.close()
elif sys.argv[1] != "verify":
    raise ValueError("Expected seed or verify")

assert (profile / "config.yaml").read_text(encoding="utf-8") == "model: gpt-4.1-mini\n"
assert (profile / "profile.yaml").read_text(encoding="utf-8") == metadata
assert (profile / ".env").read_text(encoding="utf-8") == secret
assert (profile / ".env").stat().st_mode & 0o777 == 0o600
for database in [home / "state.db", profile / "state.db"]:
    db = SessionDB(database)
    try:
        assert db.get_session(session_id) is not None
        assert any(row.get("content") == message for row in db.get_messages(session_id))
    finally:
        db.close()
print("Synthetic Hermes profile, private setting and session preserved")

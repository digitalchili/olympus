"""Real SessionDB compaction contract; run with OLYMPUS_NATIVE_HERMES_SOURCE."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = os.environ.get("OLYMPUS_NATIVE_HERMES_SOURCE")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "workers"))
if SOURCE:
    sys.path.insert(0, SOURCE)

import hermes_sessions


@unittest.skipUnless(SOURCE, "Set OLYMPUS_NATIVE_HERMES_SOURCE for real SessionDB checks")
class CompactedHistoryTest(unittest.TestCase):
    def test_archived_conversation_is_readable_once_without_expanding_model_context(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"HERMES_HOME": home}):
            from hermes_state import SessionDB
            db = SessionDB(db_path=Path(home) / "state.db")
            try:
                db.create_session("task", "olympus")
                for index in range(60):
                    db.append_message("task", "user" if index % 2 == 0 else "assistant",
                                      f"message-{index:02d}", timestamp=100 + index)
                # A withdrawn message must stay hidden even when reading older history.
                withdrawn = db.append_message("task", "user", "withdrawn message", timestamp=161)
                db.rewind_to_message("task", withdrawn)
                for generation in range(2):
                    tail = db.get_messages("task")[-4:]
                    db.archive_and_compact("task", [
                        {"role": "user", "content": "[CONTEXT COMPACTION - REFERENCE ONLY] private summary",
                         "_compressed_summary": True, "timestamp": 170 + generation},
                        *tail,
                    ], tail_count=4)
                db.append_message("task", "assistant", "model-only note", timestamp=180,
                                  display_metadata={"model_only": True})
                before = db.get_messages_as_conversation("task")
                with patch.object(hermes_sessions, "open_session", return_value=(db, "task")):
                    page = hermes_sessions.project_session_message_page("task", limit=7)
                    self.assertTrue(page["pageInfo"]["hasOlder"], "compaction must not hide the older history button")
                    assembled = page["messages"]
                    # New activity after the first page must not shift older-page offsets.
                    db.append_message("task", "assistant", "new activity", timestamp=181)
                    seen = set()
                    while page["pageInfo"]["hasOlder"]:
                        cursor = page["pageInfo"]["olderCursor"]
                        self.assertNotIn(cursor, seen)
                        seen.add(cursor)
                        page = hermes_sessions.project_session_message_page("task", limit=7, before=cursor)
                        assembled = page["messages"] + assembled
                    visible = [m["content"] for m in assembled if m["role"] != "system"]
                    self.assertEqual(visible, [f"message-{i:02d}" for i in range(60)])
                    full = hermes_sessions.project_session_messages("task")["messages"]
                    self.assertEqual([m["content"] for m in full if m["role"] != "system"], visible + ["new activity"])
                after = db.get_messages_as_conversation("task")
                self.assertEqual(after[:-1], before, "display reads must not restore archived rows into model context")
            finally:
                db.close()

    def test_legacy_child_and_in_place_compaction_use_logical_message_order(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"HERMES_HOME": home}):
            from hermes_state import SessionDB
            db = SessionDB(db_path=Path(home) / "state.db")
            try:
                db.create_session("root", "olympus")
                db.append_message("root", "user", "original question", timestamp=100)
                db.append_message("root", "assistant", "original answer", timestamp=101)
                db.end_session("root", "compression")
                db.create_session("child", "olympus", parent_session_id="root")
                contents = [
                    ("user", "[CONTEXT COMPACTION - REFERENCE ONLY] old summary"),
                    ("assistant", "private scaffold"),
                    ("user", "first question"), ("assistant", "first answer"),
                    ("user", "second question"), ("assistant", "second answer"),
                    ("user", "third question"), ("assistant", "third answer"),
                ]
                for index, (role, content) in enumerate(contents):
                    db.append_message("child", role, content, timestamp=102 + index)
                rows = db.get_messages("child")
                db.archive_and_compact("child", [rows[2],
                    {"role": "user", "content": "[CONTEXT COMPACTION - REFERENCE ONLY] new summary", "_compressed_summary": True},
                    *rows[-2:],
                ])
                with patch.object(hermes_sessions, "open_session", return_value=(db, "root")):
                    page = hermes_sessions.project_session_message_page("root", limit=3)
                    assembled = page["messages"]
                    while page["pageInfo"]["hasOlder"]:
                        page = hermes_sessions.project_session_message_page("root", limit=3, before=page["pageInfo"]["olderCursor"])
                        assembled = page["messages"] + assembled
                    self.assertEqual([m["content"] for m in assembled if m["role"] != "system"],
                        ["original question", "original answer", "first question", "first answer",
                         "second question", "second answer", "third question", "third answer"])
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()

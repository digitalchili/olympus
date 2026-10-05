"""Exercise the pinned Hermes steering boundary and SQLite replay without model calls."""
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

NATIVE_SOURCE = os.environ.get('OLYMPUS_NATIVE_HERMES_SOURCE')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/workers'))


@unittest.skipUnless(NATIVE_SOURCE, 'Set OLYMPUS_NATIVE_HERMES_SOURCE to test native steering')
class NativeSteeringTests(unittest.TestCase):
    def test_attachment_delivery_and_replay_are_owned_by_native_hermes(self):
        sys.path.insert(0, NATIVE_SOURCE)
        with tempfile.TemporaryDirectory(prefix='olympus-native-steer-') as root, \
                patch.dict(os.environ, {'HERMES_HOME': root}):
            from agent.interrupt_control import InterruptControlMixin
            from agent.agent_runtime_helpers import apply_pending_steer_to_tool_results
            from hermes_state import SessionDB
            from hermes_sessions import load_agent_history, project_session_messages, _project_message_page_row
            db = SessionDB(Path(root) / 'fixture.db')
            try:
                db.create_session(session_id='task-1', source='olympus-dispatch')
                agent = InterruptControlMixin()
                content = 'Here\n\n[Attached files:\n- /workspace/uploads/new-screenshot.jpg]'
                self.assertTrue(agent.steer(content))
                messages = [{'role': 'tool', 'tool_call_id': 'read-1', 'content': 'Previous tool result'}]
                # Only the logger's lazy run_agent import is replaced. Steering,
                # native row formatting and SessionDB use the pinned library.
                with patch('agent.agent_runtime_helpers._ra', return_value=SimpleNamespace(logger=logging.getLogger('fixture'))):
                    apply_pending_steer_to_tool_results(agent, messages, 1)
                delivered = messages[-1]
                self.assertEqual(delivered['role'], 'user')
                self.assertEqual(delivered['display_kind'], 'steer')
                self.assertIn(content, delivered['content'])
                self.assertIsNone(agent._drain_pending_steer())
                db.append_message('task-1', **delivered)
                replay = load_agent_history(db, 'task-1')
                self.assertEqual(replay, [delivered], 'Keep native steering provenance and full file path in model history')
                rows = db.get_messages('task-1')
                self.assertEqual(len(rows), 1, 'No duplicate Olympus delivery receipt')
                with patch('hermes_sessions.open_session', return_value=(db, 'task-1')):
                    full = project_session_messages('task-1')['messages']
                paged = _project_message_page_row(rows[0], 'task-1', 'task-1', None)
                self.assertEqual(full[0]['content'], content)
                self.assertEqual(paged['content'], content)
                # A late drain is handed back by Hermes finalization, never
                # written as an applied message before a model consumes it.
                self.assertTrue(agent.steer('Late attachment'))
                self.assertEqual(agent._drain_pending_steer(), 'Late attachment')
                self.assertEqual(len(db.get_messages('task-1')), 1)
            finally:
                db.close()


if __name__ == '__main__':
    unittest.main()

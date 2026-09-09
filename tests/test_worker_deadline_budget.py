"""Olympus leaves task timing and delegation limits to Hermes."""
import unittest
from unittest.mock import patch
import test_worker_recovery as recovery

class NativeExecutionTests(unittest.TestCase):
    def test_legacy_budget_does_not_schedule_any_deadline_or_child_interrupt(self):
        fixture = recovery.RecoveryTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        with patch.object(recovery.worker.threading, 'Timer', side_effect=AssertionError('Unexpected automatic deadline')):
            fixture.run_chat(runBudget={'maxRuntimeMs': 1, 'maxDelegatedChildren': 1})
        self.assertEqual(len(fixture.messages), 2)
        self.assertTrue(fixture.completed)
        self.assertFalse(any(event.get('type') == 'error' for event in fixture.sent))

if __name__ == '__main__':
    unittest.main()

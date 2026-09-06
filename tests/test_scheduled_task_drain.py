from __future__ import annotations

import os
import json
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

WORKER_DIR = Path(__file__).resolve().parents[1] / "server" / "workers"
sys.path.insert(0, str(WORKER_DIR))
import hermes_scheduled_tasks as scheduled


class ScheduledDrainTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(scheduled, "set_scheduled_task_drain"), "scheduled work must participate in maintenance drain")
        self.running = set()
        self.dispatched = []
        self.scheduler = types.SimpleNamespace(
            get_running_job_ids=lambda: frozenset(self.running),
            tick=self.tick,
        )
        self.modules = patch.dict(sys.modules, {"cron.scheduler": self.scheduler})
        self.modules.start()
        self.imports = patch.object(scheduled, "_ensure_imports")
        self.imports.start()
        scheduled.set_scheduled_task_drain(False)

    def tearDown(self):
        if hasattr(self, "modules"):
            self.imports.stop()
            self.modules.stop()

    def tick(self, **kwargs):
        self.assertFalse(kwargs["sync"], "native registry tracks work beyond dispatch")
        if kwargs["can_dispatch"]():
            self.dispatched.append("job")
            self.running.add("job")
            return 1
        return 0

    def test_active_native_job_remains_counted_after_tick_returns(self):
        self.assertEqual(scheduled.tick_scheduled_tasks(), 1)
        self.assertEqual(scheduled.set_scheduled_task_drain(True), {"draining": True, "activeRuns": 1})
        self.running.clear()
        self.assertEqual(scheduled.set_scheduled_task_drain(True)["activeRuns"], 0)

    def test_due_and_manually_triggered_ticks_wait_until_drain_cancelled(self):
        scheduled.set_scheduled_task_drain(True)
        self.assertEqual(scheduled.tick_scheduled_tasks(), 0)
        with patch.dict(sys.modules, {"cron.jobs": types.SimpleNamespace(trigger_job=lambda job_id: {"id": job_id})}):
            with self.assertRaisesRegex(Exception, "drain"):
                scheduled.trigger_scheduled_task("job")
        self.assertEqual(self.dispatched, [])
        scheduled.set_scheduled_task_drain(False)
        self.assertEqual(scheduled.tick_scheduled_tasks(), 1)

    def test_drain_waits_for_dispatch_admission_before_reporting_idle(self):
        entered, release, drained = threading.Event(), threading.Event(), threading.Event()
        original_tick = self.scheduler.tick
        def delayed_tick(**kwargs):
            entered.set()
            self.assertTrue(release.wait(2))
            return original_tick(**kwargs)
        self.scheduler.tick = delayed_tick
        ticker = threading.Thread(target=scheduled.tick_scheduled_tasks)
        ticker.start()
        self.assertTrue(entered.wait(2))
        result = []
        def drain():
            result.append(scheduled.set_scheduled_task_drain(True))
            drained.set()
        waiter = threading.Thread(target=drain)
        waiter.start()
        self.assertFalse(drained.wait(0.03), "unacknowledged admission cannot count as idle")
        release.set()
        ticker.join(2)
        waiter.join(2)
        self.assertEqual(result, [{"draining": True, "activeRuns": 1}])

    def test_missing_native_inventory_is_unknown_not_zero(self):
        del self.scheduler.get_running_job_ids
        with self.assertRaises(Exception):
            scheduled.set_scheduled_task_drain(True)

    def test_cold_worker_waits_for_maintenance_handshake_before_dispatch(self):
        requests = [
            {"id": "health", "type": "health"},
            {"id": "cold-tick", "type": "scheduledTasks.tick"},
            {"id": "drain", "type": "scheduledTasks.drain", "draining": True},
            {"id": "drained-tick", "type": "scheduledTasks.tick"},
        ]
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, HOME=home, HERMES_HOME=home, HERMES_AGENT_DIR=str(Path(home) / "not-installed"))
            result = subprocess.run([sys.executable, str(WORKER_DIR / "hermes_worker.py")],
                                    input="".join(json.dumps(request) + "\n" for request in requests),
                                    env=env, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        responses = {item["id"]: item for item in map(json.loads, result.stdout.splitlines())}
        self.assertEqual(responses["drain"]["data"], {"draining": True, "activeRuns": 0})
        for request_id in ("cold-tick", "drained-tick"):
            self.assertEqual(responses[request_id]["data"], {"executed": 0})

    @unittest.skipUnless(os.environ.get("OLYMPUS_NATIVE_HERMES_SOURCE"), "native Hermes source not selected")
    def test_real_native_scheduler_keeps_due_job_and_running_job_during_drain(self):
        script = r'''
import sys, threading
sys.path[:0] = [sys.argv[1], sys.argv[2]]
import hermes_scheduled_tasks as wrapper
from cron import jobs, scheduler
from unittest.mock import patch
entered, release = threading.Event(), threading.Event()
first = jobs.create_job(prompt="test-only", schedule="every 1m", deliver="local")
jobs.trigger_job(first["id"])
def runner(job, **kwargs):
    entered.set()
    assert release.wait(5)
    return True
with patch.object(wrapper, "_ensure_imports"), patch.object(scheduler, "run_one_job", side_effect=runner):
    wrapper.set_scheduled_task_drain(False)
    assert wrapper.tick_scheduled_tasks() == 1
    assert entered.wait(3)
    assert wrapper.set_scheduled_task_drain(True)["activeRuns"] == 1
    second = jobs.create_job(prompt="test-only", schedule="every 1m", deliver="local")
    jobs.trigger_job(second["id"])
    before = jobs.get_job(second["id"])
    assert wrapper.tick_scheduled_tasks() == 0
    assert jobs.get_job(second["id"]) == before
    release.set()
    scheduler._parallel_pool.shutdown(wait=True)
    assert wrapper.set_scheduled_task_drain(True)["activeRuns"] == 0
print("native scheduled drain passed")
'''
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, HOME=home, HERMES_HOME=home, TERMINAL_ENV="local")
            result = subprocess.run([sys.executable, "-c", script, str(WORKER_DIR), os.environ["OLYMPUS_NATIVE_HERMES_SOURCE"]], env=env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

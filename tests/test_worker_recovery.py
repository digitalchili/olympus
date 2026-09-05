"""Recovery regressions use disposable state and a deterministic fake agent only."""
import os
import sys
import tempfile
import threading
import types
import unittest
from contextlib import ExitStack, nullcontext
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/workers'))
import hermes_worker as worker
from hermes_recovery import ContinuationJournal, RecoveryBlocked


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {'HERMES_HOME': self.tmp.name + '/hermes', 'OLYMPUS_DISPATCH_HOME': self.tmp.name})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.event = {'type': 'async_delegation', 'session_key': 'task-1', 'delegation_id': 'deleg-1', 'summary': 'Saved child result'}
        self.messages = []
        self.sent = []
        self.completed = []
        self.released = []
        self.native = types.ModuleType('tools.async_delegation')
        self.native.claim_event_delivery = lambda *_: 'claim-1'
        self.native_states = {}
        def complete(event, claim):
            self.completed.append(event)
            self.native_states[event['delegation_id']] = 'delivered'
        self.native.complete_event_delivery = complete
        self.native.release_event_delivery = lambda event, claim: self.released.append(event)
        self.native.get_durable_delegation = lambda ident: {
            'delegation_id': ident, 'origin_session': 'task-1', 'origin_session_id': 'task-1',
            'state': 'completed', 'delivery_state': self.native_states.get(ident, 'pending'), 'result': {'summary': 'Saved child result'},
        }
        self.native.interrupt_for_session = lambda **_: None
        self.process = types.ModuleType('tools.process_registry')
        import queue
        self.process.process_registry = types.SimpleNamespace(completion_queue=queue.Queue())
        self.process.format_process_notification = lambda event: 'Saved child result'

    def notification(self, *_a, **_k):
        self.polls = getattr(self, 'polls', 0) + 1
        if self.polls > 4:
            raise AssertionError('Missing notification never reconciled native state')
        return None

    def run_chat(self, synthesis=None, notification=True, dispatch=True, finalized=False, threaded=False, on_send=None, **request_extra):
        outer = self
        class Agent:
            session_id = 'task-1'
            context_compressor = None
            _interrupt_requested = False
            def run_conversation(self, *, user_message, **kwargs):
                outer.messages.append((user_message, kwargs.get('system_message')))
                if len(outer.messages) == 1 and dispatch:
                    self.tool_progress_callback('tool.completed', 'delegate_task', None, None,
                        result='{"status":"dispatched","delegation_id":"deleg-1"}')
                    return {'final_response': 'Working'}
                if len(outer.messages) > 4:
                    raise AssertionError('Previous user message replayed or unbounded synthesis')
                return synthesis or {'final_response': 'Synthesized', 'completed': True}
        agent = Agent()
        finalization = threading.Event()
        if finalized:
            finalization.set()
        def create(**kwargs):
            agent.tool_progress_callback = kwargs['callbacks']['tool_progress_callback']
            return agent
        with ExitStack() as stack:
            for name, value in {
                'open_session': lambda *_: (object(), 'task-1'),
                'load_agent_history': lambda *_: [], '_create_agent': create,
                'native_approval_context': lambda *_: nullcontext(),
                '_start_deadline_controls': lambda *_: types.SimpleNamespace(cancel=lambda: None, finalization_started=finalization),
                'take_owned_delegation_notification': self.notification if not notification else lambda *_a, **_k: self.event,
                '_send': lambda event: (self.sent.append(event), on_send(event) if on_send else None),
            }.items():
                stack.enter_context(patch.object(worker, name, value))
            stack.enter_context(patch.dict(sys.modules, {'tools.async_delegation': self.native, 'tools.process_registry': self.process}))
            request = {'sessionId': 'task-1', 'taskId': 'task-1', 'message': 'User request',
                'runBudget': {'maxRuntimeMs': 1000, 'finalizeBeforeMs': 100, 'childDrainBeforeMs': 50}, **request_extra}
            if threaded:
                worker._run_chat_thread('request-1', request, 'task-1')
            else:
                terminal = worker._run_chat('request-1', request)
                if terminal:
                    self.sent.extend(terminal)

    def test_claim_busy_never_replays_user_request(self):
        self.native.claim_event_delivery = lambda *_: None
        with self.assertRaises(worker.WorkerError):
            self.run_chat()
        self.assertEqual(len(self.messages), 1)
        self.assertFalse(self.completed)

    def test_interrupted_synthesis_keeps_result_unacknowledged(self):
        self.run_chat({'interrupted': True})
        self.assertEqual(self.completed, [])
        self.assertTrue(self.released)

    def test_incomplete_synthesis_keeps_result_unacknowledged(self):
        with self.assertRaises(worker.WorkerError):
            self.run_chat({'completed': False, 'final_response': 'Partial work'})
        self.assertEqual(self.completed, [])
        self.assertTrue(self.released)

    def test_missing_notification_reconciles_native_result(self):
        self.run_chat(notification=False)
        self.assertEqual(len(self.messages), 2)
        self.assertIn('Saved child result', str(self.messages[1]))
        self.assertEqual(len(self.completed), 1)

    def test_fresh_chat_injects_saved_result_without_replaying_old_request(self):
        journal = ContinuationJournal('task-1')
        journal.track('deleg-1', 'task-1')
        journal.save_event(self.event)
        self.run_chat(dispatch=False)
        self.assertEqual(len(self.messages), 1)
        self.assertEqual(self.messages[0][0], 'User request')
        self.assertIn('Saved child result', self.messages[0][1])
        self.assertIn('Do not replay', self.messages[0][1])
        self.assertEqual(ContinuationJournal('task-1').status(), {'status': 'none'})

    def test_failed_synthesis_survives_restart_and_blocks_automatic_recovery(self):
        with self.assertRaises(worker.WorkerError):
            self.run_chat({'completed': False, 'final_response': 'Partial'})
        restarted = ContinuationJournal('task-1')
        self.assertEqual(restarted.status()['status'], 'blocked')
        self.assertEqual(restarted.receipt()['undeliveredResultCount'], 1)
        with self.assertRaises(worker.WorkerError):
            self.run_chat(dispatch=False, recoveryContinuation=True)
        self.assertEqual(len(self.messages), 2)

    def test_wrong_task_result_and_profile_cannot_be_recovered(self):
        journal = ContinuationJournal('task-1')
        journal.track('deleg-1', 'task-1')
        with self.assertRaises(RecoveryBlocked):
            journal.save_event({**self.event, 'session_key': 'task-2'})
        self.native.get_durable_delegation = lambda _: {'origin_session': 'task-2', 'result': {'summary': 'foreign'}}
        with self.assertRaises(RecoveryBlocked):
            journal.reconcile(self.native)
        self.assertEqual(ContinuationJournal('task-2').rows(), [])
        with patch.dict(os.environ, {'HERMES_HOME': self.tmp.name + '/other-profile'}):
            self.assertEqual(ContinuationJournal('task-1').rows(), [])

    def test_native_dispatch_before_callback_is_discovered_after_restart(self):
        import sqlite3
        native_home = Path(os.environ['HERMES_HOME'])
        native_home.mkdir()
        db = sqlite3.connect(native_home / 'state.db')
        db.execute('CREATE TABLE async_delegations (delegation_id TEXT, origin_session TEXT, origin_session_id TEXT, delivery_state TEXT)')
        db.executemany('INSERT INTO async_delegations VALUES (?, ?, ?, ?)', [
            ('deleg-1', 'task-1', 'task-1', 'pending'),
            ('foreign', 'task-2', 'task-2', 'pending'),
            ('old', 'task-1', 'task-1', 'delivered'),
        ])
        db.commit()
        db.close()
        self.run_chat(dispatch=False)
        self.assertIn('Saved child result', self.messages[0][1] or '')
        self.assertEqual(len(self.completed), 1)

    def test_cancel_is_saved_before_interrupted_agent_returns(self):
        journal = ContinuationJournal('task-1')
        journal.track('deleg-1', 'task-1')
        agent = types.SimpleNamespace(interrupt=lambda _: None)
        with patch.dict(worker.ACTIVE_TASKS, {'task-1': 'request-1'}), patch.dict(worker.ACTIVE_AGENTS, {'task-1': agent}):
            worker._interrupt_active_chat({'taskId': 'task-1'})
        self.assertEqual(journal.status()['status'], 'blocked')


    def test_background_inventory_reports_recoverable_result_and_receipt(self):
        import hermes_background_work
        journal = ContinuationJournal('task-1')
        journal.track('deleg-1', 'task-1')
        self.native._records = {}
        self.native._records_lock = threading.Lock()
        registry = types.SimpleNamespace(list_sessions=lambda **_: [])
        result = hermes_background_work.get_background_work({'sessionId': 'task-1'},
            process_registry=registry, async_delegation=self.native)
        self.assertTrue(result['available'])
        self.assertEqual(result.get('continuation'), {'status': 'pending'})
        self.assertEqual(result.get('checkpoint', {}).get('undeliveredResultCount'), 1)
        self.assertNotIn('Saved child result', str(result))

    def test_inventory_missing_native_capability_is_explicitly_blocked(self):
        import hermes_background_work
        ContinuationJournal('task-1').track('deleg-1', 'task-1')
        del self.native.get_durable_delegation
        self.native._records = {}
        self.native._records_lock = threading.Lock()
        result = hermes_background_work.get_background_work({'sessionId': 'task-1'},
            process_registry=types.SimpleNamespace(list_sessions=lambda **_: []), async_delegation=self.native)
        self.assertEqual(result.get('continuation', {}).get('status'), 'blocked')


    @unittest.skipUnless(os.environ.get('OLYMPUS_NATIVE_HERMES_SOURCE'), 'native Hermes source not selected')
    def test_real_pinned_native_result_recovers_with_queue_lost(self):
        self.native_recovery_probe()

    @unittest.skipUnless(os.environ.get('OLYMPUS_NATIVE_HERMES_SOURCE'), 'native Hermes source not selected')
    def test_real_native_ack_failure_repairs_without_synthesis_replay(self):
        self.native_recovery_probe('failure')

    @unittest.skipUnless(os.environ.get('OLYMPUS_NATIVE_HERMES_SOURCE'), 'native Hermes source not selected')
    def test_real_native_ack_cas_noop_is_retried_without_synthesis_replay(self):
        self.native_recovery_probe('noop')

    @unittest.skipUnless(os.environ.get('OLYMPUS_NATIVE_HERMES_SOURCE'), 'native Hermes source not selected')
    def test_real_native_committed_ack_lost_receipt_repairs_without_synthesis_replay(self):
        self.native_recovery_probe('committed')

    def native_recovery_probe(self, failure=None):
        import importlib
        import queue
        import time
        source = os.environ['OLYMPUS_NATIVE_HERMES_SOURCE']
        with patch.object(sys, 'path', [source] + sys.path):
            native = importlib.import_module('tools.async_delegation')
            process = importlib.import_module('tools.process_registry')
            dispatched = native.dispatch_async_delegation(
                goal='Return a fixture result', context=None, toolsets=[], role='leaf', model=None,
                session_key='task-1', parent_session_id='task-1', origin_session_id='task-1',
                runner=lambda: {'summary': 'Saved child result'},
            )
            delegation = dispatched['delegation_id']
            deadline = time.monotonic() + 3
            while not (native.get_durable_delegation(delegation) or {}).get('result'):
                if time.monotonic() > deadline:
                    self.fail('Native fixture did not finish')
                time.sleep(0.01)
            while True:
                try:
                    process.process_registry.completion_queue.get_nowait()
                except queue.Empty:
                    break
            self.native, self.process = native, process
            if failure:
                complete = native.complete_event_delivery
                def fail_ack(*args):
                    if failure == 'committed':
                        complete(*args)
                    raise OSError('Injected acknowledgement failure')
                failure_patch = (patch.object(native, 'complete_completion_delivery', return_value=False)
                                 if failure == 'noop' else patch.object(native, 'complete_event_delivery', side_effect=fail_ack))
                with failure_patch, self.assertRaises(worker.WorkerError):
                    self.run_chat(dispatch=False, notification=False)
                self.assertEqual(len(self.messages), 1)
                journal = ContinuationJournal('task-1')
                self.assertEqual(journal.rows()[0]['state'], 'ack_pending')
                self.assertEqual(native.get_durable_delegation(delegation)['delivery_state'],
                                 'delivered' if failure == 'committed' else 'pending')
                import hermes_background_work
                inventory = hermes_background_work.get_background_work({'sessionId': 'task-1'},
                    process_registry=process.process_registry, async_delegation=native)
                self.assertEqual(inventory['continuation']['status'], 'pending')
                self.run_chat(dispatch=False, notification=False, recoveryContinuation=True)
                self.assertEqual(len(self.messages), 1, 'Acknowledgement repair must not rerun synthesis')
            else:
                self.run_chat(dispatch=False, notification=False)
            self.assertIn('Saved child result', self.messages[0][1])
            self.assertEqual(native.get_durable_delegation(delegation)['delivery_state'], 'delivered')
            self.assertEqual(ContinuationJournal('task-1').status(), {'status': 'none'})


    def test_wait_is_bounded_and_reports_progress_with_pending_receipt(self):
        self.native.get_durable_delegation = lambda ident: {
            'origin_session': 'task-1', 'state': 'running', 'delivery_state': 'pending', 'result': None,
        }
        clock = iter(range(100))
        with patch.object(worker.time, 'monotonic', side_effect=lambda: next(clock)):
            with self.assertRaises(worker.WorkerError) as error:
                self.run_chat(notification=False)
        self.assertEqual(error.exception.code, 'recovery_pending')
        self.assertEqual(len(self.messages), 1)
        self.assertTrue(any(event.get('label') == 'Waiting for saved child results' for event in self.sent))
        self.assertEqual(self.sent[-1]['checkpoint']['continuation'], {'status': 'pending'})

    def test_automatic_timeout_does_not_mark_waiting_results_as_human_cancelled(self):
        journal = ContinuationJournal('task-1')
        journal.track('deleg-1', 'task-1')
        agent = types.SimpleNamespace(interrupt=lambda _: None)
        with patch.dict(worker.ACTIVE_TASKS, {'task-1': 'request-1'}), patch.dict(worker.ACTIVE_AGENTS, {'task-1': agent}):
            worker._interrupt_active_chat({'taskId': 'task-1', 'reason': 'Stopped automatically because the run exceeded the Olympus runtime limit.'})
        self.assertEqual(journal.status()['status'], 'pending')


    def test_notification_cannot_override_foreign_native_ownership(self):
        self.native.get_durable_delegation = lambda _: {
            'origin_session': 'task-2', 'origin_session_id': 'task-2',
            'state': 'completed', 'delivery_state': 'pending', 'result': {'summary': 'foreign'},
        }
        with self.assertRaises(worker.WorkerError):
            self.run_chat()
        self.assertEqual(len(self.messages), 1)
        self.assertFalse(self.completed)

    def test_duplicate_notification_cannot_replay_successful_synthesis(self):
        self.run_chat()
        self.messages.clear()
        self.run_chat(dispatch=False)
        self.assertEqual(len(self.messages), 1)
        self.assertEqual(len(self.completed), 1)
        self.assertNotIn('Saved child result', self.messages[0][1] or '')


    def test_completed_deadline_finalization_without_child_is_durably_recoverable(self):
        self.run_chat(dispatch=False, finalized=True)
        restarted = ContinuationJournal('task-1')
        self.assertEqual(restarted.status()['status'], 'pending')
        receipt = next(event['checkpoint'] for event in self.sent if event['type'] == 'checkpoint')
        self.assertEqual(receipt['continuation']['status'], 'pending')
        self.assertEqual(receipt['pendingDelegationIds'], [])
        self.messages.clear()
        self.run_chat(dispatch=False, recoveryContinuation=True)
        self.assertEqual(len(self.messages), 1)
        self.assertIn('saved session history', self.messages[0][1])
        self.assertEqual(restarted.status(), {'status': 'none'})

    def test_failed_auto_continuation_of_finalized_turn_is_not_replayed(self):
        self.run_chat(dispatch=False, finalized=True)
        self.messages.clear()
        with self.assertRaises(worker.WorkerError):
            self.run_chat({'completed': False, 'final_response': 'Partial'}, dispatch=False, recoveryContinuation=True)
        self.assertEqual(len(self.messages), 1)
        self.assertEqual(ContinuationJournal('task-1').status()['status'], 'blocked')


    def test_ack_failure_keeps_ack_pending_and_retry_never_reruns_synthesis(self):
        complete = self.native.complete_event_delivery
        self.native.complete_event_delivery = lambda *_: (_ for _ in ()).throw(OSError('ack unavailable'))
        with self.assertRaises((worker.WorkerError, OSError)):
            self.run_chat()
        self.assertEqual(len(ContinuationJournal('task-1').rows()), 1)
        self.assertEqual(ContinuationJournal('task-1').rows()[0]['state'], 'ack_pending')
        self.assertEqual(len(self.messages), 2)
        self.native.complete_event_delivery = complete
        self.run_chat(dispatch=False, recoveryContinuation=True)
        self.assertEqual(len(self.messages), 2)
        self.assertEqual(ContinuationJournal('task-1').status(), {'status': 'none'})

    def test_silent_native_ack_noop_is_not_success(self):
        self.native.complete_event_delivery = lambda *_: None
        with self.assertRaises(worker.WorkerError):
            self.run_chat()
        self.assertEqual(ContinuationJournal('task-1').rows()[0]['state'], 'ack_pending')
        self.assertFalse(any(event['type'] == 'done' for event in self.sent))



    def terminal_handoff(self, synthesis):
        entered, release, finished = (threading.Event() for _ in range(3))
        original_done = False
        def evaluate(_request):
            entered.set()
            release.wait(2)
            return {}
        def send(event):
            nonlocal original_done
            if event.get('id') == 'next-eval' and event.get('type') == 'result':
                finished.set()
            if event.get('id') == 'request-1' and event['type'] in {'done', 'error'} and not original_done:
                original_done = True
                worker._handle_request({'id': 'next-eval', 'type': 'goal.evaluate', 'sessionId': 'task-1'})
        self.assertTrue(worker._try_mark_task_active('task-1', 'request-1'))
        try:
            with patch.object(worker, '_goal_evaluate', side_effect=evaluate), patch.object(worker, '_send', side_effect=send):
                self.run_chat(synthesis, dispatch=False, threaded=True, on_send=send)
                self.assertTrue(entered.wait(0.2), 'Immediate evaluator must not see the finished chat as busy')
                self.assertEqual(worker.ACTIVE_TASKS.get('task-1'), 'next-eval', 'Old chat cleanup must not clear the new evaluator')
                release.set()
                self.assertTrue(finished.wait(1))
        finally:
            release.set()
            worker._clear_task_active('task-1', 'request-1')
            worker._clear_task_active('task-1', 'next-eval')

    def test_done_chat_allows_immediate_goal_evaluation(self):
        self.terminal_handoff({'completed': True, 'final_response': 'Done'})

    def test_failed_chat_allows_immediate_goal_evaluation_after_error(self):
        self.terminal_handoff({'completed': False, 'final_response': 'Incomplete'})

    def test_interrupted_chat_allows_immediate_goal_evaluation(self):
        self.terminal_handoff({'interrupted': True})


class GoalOperationTests(unittest.TestCase):
    def blocked_operation(self, operation):
        entered, release, returned, finished = (threading.Event() for _ in range(4))
        sent, mutations, lock_at_result = [], [], []
        independent = threading.Event()
        request = {'id': 'private-operation-value', 'type': operation, 'sessionId': 'task-lock'}
        def handler(request):
            if request['id'] == 'private-operation-value':
                entered.set()
                if not release.wait(3):
                    raise AssertionError('Blocked goal fixture was not released')
            else:
                mutations.append(request['type'])
            return {'goal': None}
        def send(event):
            sent.append(event)
            if event.get('id') == 'independent':
                independent.set()
            if event.get('id') == 'private-operation-value' and event.get('type') in {'result', 'error'}:
                lock_at_result.append(worker.ACTIVE_TASKS.get('task-lock'))
                finished.set()
        with ExitStack() as stack:
            for name in ('_goal_set', '_goal_pause', '_goal_resume', '_goal_clear', '_goal_evaluate'):
                stack.enter_context(patch.object(worker, name, handler))
            stack.enter_context(patch.object(worker, '_goal_status', return_value={'goal': None}))
            stack.enter_context(patch.object(worker, '_send', side_effect=send))
            # Keep the native read-only inventory isolated; test the real RPC overlay.
            if hasattr(worker, '_native_session_background_work'):
                stack.enter_context(patch.object(worker, '_native_session_background_work', return_value={'available': True, 'work': []}))
            else:
                stack.enter_context(patch.object(worker, '_session_background_work', return_value={'available': True, 'work': []}))
            stack.enter_context(patch.object(worker, '_run_chat', side_effect=lambda *_: mutations.append('chat')))
            stack.enter_context(patch.object(worker, '_run_compress', side_effect=lambda *_: mutations.append('compress') or {}))
            def dispatch():
                worker._handle_request(request)
                returned.set()
            dispatcher = threading.Thread(target=dispatch, daemon=True)
            dispatcher.start()
            try:
                self.assertTrue(entered.wait(1))
                self.assertTrue(returned.wait(0.2), 'Goal setup must not block JSONL reads')
                for kind in ('goal.set', 'goal.pause', 'goal.resume', 'goal.clear', 'goal.evaluate', 'session.compress', 'chat'):
                    worker._handle_request({'id': kind, 'type': kind, 'sessionId': 'task-lock', 'message': 'New request'})
                errors = [event for event in sent if event['type'] == 'error']
                self.assertEqual(len(errors), 7)
                self.assertTrue(all(event['error']['code'] == 'task_busy' for event in errors))
                self.assertEqual(mutations, [])
                worker._handle_request({'id': 'status', 'type': 'goal.status', 'sessionId': 'task-lock'})
                worker._handle_request({'id': 'inventory', 'type': 'session.backgroundWork.get', 'sessionId': 'task-lock'})
                worker._handle_request({'id': 'foreign', 'type': 'session.backgroundWork.get', 'sessionId': 'task-other'})
                status = next(event for event in sent if event['id'] == 'status')
                self.assertEqual(status['type'], 'result')
                inventory = next(event['data'] for event in sent if event['id'] == 'inventory')
                self.assertEqual(len(inventory['work']), 1)
                self.assertEqual(inventory['work'][0]['kind'], 'operation')
                self.assertEqual(inventory['work'][0]['status'], 'running')
                self.assertNotIn('private-operation-value', str(inventory))
                self.assertEqual(next(event['data']['work'] for event in sent if event['id'] == 'foreign'), [])
                worker._handle_request({'id': 'independent', 'type': 'goal.set', 'sessionId': 'task-other'})
                self.assertTrue(independent.wait(1), 'Different tasks must remain independent')
                self.assertEqual(mutations, ['goal.set'])
            finally:
                release.set()
                dispatcher.join(1)
                self.assertTrue(finished.wait(1))
            self.assertEqual(lock_at_result, [None], 'Next request may arrive as soon as the result is sent')
            self.assertNotIn('task-lock', worker.ACTIVE_TASKS)

    def test_goal_evaluator_failure_releases_task_lock_before_error(self):
        finished = threading.Event()
        sent = []
        def send(event):
            sent.append((event, worker.ACTIVE_TASKS.get('failed-goal')))
            finished.set()
        with patch.object(worker, '_goal_evaluate', side_effect=RuntimeError('fixture failed')), patch.object(worker, '_send', side_effect=send):
            worker._handle_request({'id': 'failed-eval', 'type': 'goal.evaluate', 'sessionId': 'failed-goal'})
            self.assertTrue(finished.wait(1))
        self.assertEqual(sent[0][0]['type'], 'error')
        self.assertIsNone(sent[0][1])
        self.assertNotIn('failed-goal', worker.ACTIVE_TASKS)

    def test_blocked_goal_evaluation_excludes_new_writes_but_not_status(self):
        self.blocked_operation('goal.evaluate')

    def test_blocked_goal_setup_excludes_new_writes_but_not_status(self):
        self.blocked_operation('goal.set')


if __name__ == '__main__':
    unittest.main()

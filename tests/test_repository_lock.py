import sys
import tempfile
import subprocess
import unittest
from unittest.mock import patch
from pathlib import Path

WORKERS = Path(__file__).resolve().parents[1] / 'server' / 'workers'
sys.path.insert(0, str(WORKERS))
from hermes_repository_lock import acquire_repository_lock, repository_locked
import hermes_worker


class RepositoryLockTests(unittest.TestCase):
    def test_old_worker_excludes_replacement_until_it_really_exits(self):
        with tempfile.TemporaryDirectory() as root:
            path = str(Path(root) / 'repo.lock')
            child = subprocess.Popen([sys.executable, '-u', '-c',
                'import sys; sys.path.insert(0, sys.argv[1]); from hermes_repository_lock import acquire_repository_lock; '
                'lock=acquire_repository_lock(sys.argv[2]); print("locked", flush=True); sys.stdin.read()', str(WORKERS), path],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'locked')
                self.assertTrue(repository_locked(path))
                with self.assertRaises(BlockingIOError):
                    acquire_repository_lock(path)
            finally:
                child.stdin.close()
                child.wait(timeout=5)
                child.stdout.close()
            self.assertFalse(repository_locked(path))
            lock = acquire_repository_lock(path)
            lock.close()

    def test_different_repositories_do_not_block_each_other(self):
        with tempfile.TemporaryDirectory() as root:
            first = acquire_repository_lock(str(Path(root) / 'a.lock'))
            second = acquire_repository_lock(str(Path(root) / 'b.lock'))
            first.close()
            second.close()

    def test_worker_cannot_call_agent_while_old_owner_holds_lock(self):
        with tempfile.TemporaryDirectory() as root:
            path = str(Path(root) / 'repo.lock')
            old = acquire_repository_lock(path)
            try:
                with patch.object(hermes_worker, '_run_chat') as run, patch.object(hermes_worker, '_send_error') as error, patch.object(hermes_worker, '_send'):
                    hermes_worker._run_chat_thread('new-run', {'repositoryLockPath': path}, 'task-a')
                    run.assert_not_called()
                    self.assertEqual(error.call_args.args[1].code, 'repository_busy')
            finally:
                old.close()


if __name__ == '__main__':
    unittest.main()

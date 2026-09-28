from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server' / 'workers'))
import hermes_worker

class HermesRuntimeTests(unittest.TestCase):
    def request(self, source):
        received = []
        complete = threading.Event()
        with patch.dict(os.environ, {'HERMES_AGENT_DIR': str(source), 'OLYMPUS_INSTALL_KIND': ''}), patch.object(hermes_worker, '_ensure_imports', side_effect=AssertionError('runtime must not import Hermes')), patch.object(hermes_worker, '_result', side_effect=lambda _, data: (received.append(data), complete.set())):
            hermes_worker._handle_request({'id': 'runtime', 'type': 'hermes.runtime.get'})
            self.assertTrue(complete.wait(3), 'runtime RPC must produce a result without importing AIAgent')
        return received[0]

    def test_source_reports_exact_revision_without_importing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / 'run_agent.py').write_text('raise RuntimeError("do not import")')
            (source / 'hermes_cli').mkdir()
            (source / 'hermes_cli' / '__init__.py').write_text('__version__ = "0.21.5"\n__release_date__ = "2026.9.24"\nraise RuntimeError("do not import")')
            subprocess.run(['git', 'init', '-q', str(source)], check=True)
            subprocess.run(['git', '-C', str(source), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(source), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)
            revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
            result = self.request(source)
            self.assertEqual(result['version'], '2026.9.24')
            self.assertEqual(result['revision'], revision)
            self.assertEqual(result['installation'], 'source')
            self.assertEqual(result['sourcePath'], str(source.resolve()))
            self.assertFalse(result['dirty'])
            (source / 'run_agent.py').write_text('# changed')
            self.assertTrue(self.request(source)['dirty'])

    def test_missing_configured_source_is_unavailable_without_fallback(self):
        result = self.request(Path('/nonexistent/olympus-runtime-fixture'))
        self.assertFalse(result['available'])
        self.assertIsNone(result['sourcePath'])

    def test_verification_import_failure_is_safe_unavailable(self):
        received = []
        done = threading.Event()
        with patch.object(hermes_worker, '_discover_agent_dir', return_value=Path(__file__).parent), patch.object(hermes_worker, 'get_runtime', return_value={'available': True}), patch.object(hermes_worker, '_ensure_imports', side_effect=RuntimeError('SECRET upstream failure')), patch.object(hermes_worker, '_result', side_effect=lambda _, data: (received.append(data), done.set())):
            hermes_worker._handle_request({'id': 'verify', 'type': 'hermes.runtime.get', 'verify': True})
            self.assertTrue(done.wait(3))
        self.assertFalse(received[0]['available'])
        self.assertNotIn('SECRET', json.dumps(received))

    def test_baked_image_is_not_updatable_source_even_with_git(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / 'run_agent.py').write_text('')
            with patch.dict(os.environ, {'OLYMPUS_INSTALL_KIND': 'docker'}):
                from hermes_runtime import get_runtime
                self.assertEqual(get_runtime(source)['installation'], 'docker')

if __name__ == '__main__':
    unittest.main()

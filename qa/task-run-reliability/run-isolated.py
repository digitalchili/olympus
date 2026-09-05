"""Run repository verification with no live config, credentials, or databases."""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory(prefix='.or-', dir=os.environ.get('OLYMPUS_QA_TEMP_ROOT')) as tmp:
    root = Path(tmp)
    for name in ['home', 'hermes', 'olympus', 'tmp']:
        (root / name).mkdir()
    env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'),
           'HERMES_HOME': str(root / 'hermes'), 'OLYMPUS_DISPATCH_HOME': str(root / 'olympus'),
           'OLYMPUS_DATA_DIR': str(root / 'olympus'), 'DB_PATH': str(root / 'olympus/state.db'),
           'TMPDIR': str(root / 'tmp'), 'PYTHONDONTWRITEBYTECODE': '1',
           'TSX_TSCONFIG_PATH': 'client/tsconfig.json', 'NODE_ENV': 'test', 'OLYMPUS_QA_ISOLATED': '1'}
    raise SystemExit(subprocess.run(sys.argv[1:], env=env).returncode)


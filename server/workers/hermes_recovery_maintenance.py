"""Explicit, local maintenance repair for obsolete native delivery receipts.

Run only after backing up this installation and draining it. The successful
operation intentionally leaves the restart fence and drain held for deployment
of the context-aware worker. This never runs from normal worker admission.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import urllib.request
import uuid

from hermes_recovery import ContinuationJournal, RecoveryBlocked
from hermes_background_work import _lineage_aliases


def read_db(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


class NativeLedger:
    def __init__(self, home):
        self.path = Path(home) / 'state.db'

    def get_durable_delegation(self, delegation):
        with closing(read_db(self.path)) as db:
            row = db.execute('SELECT * FROM async_delegations WHERE delegation_id=?', (delegation,)).fetchone()
        return dict(row) if row else None


def validate_target(target, olympus_db):
    """Read-only validation; never infer a successful task or modify history."""
    with closing(read_db(olympus_db)) as db:
        task = db.execute('SELECT status, profile_name FROM tasks WHERE id=?', (target['taskId'],)).fetchone()
        if not task or (task['profile_name'] or 'default') != target['profile']:
            raise RecoveryBlocked('Task/profile selection does not match this installation.')
        last = db.execute('SELECT run_id,status,error_code FROM task_agent_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1',
                          (target['taskId'],)).fetchone()
        if last and db.execute("SELECT 1 FROM task_interactions WHERE task_id=? AND olympus_run_id=? AND status NOT IN ('answered','denied')",
                               (target['taskId'], last['run_id'])).fetchone():
            raise RecoveryBlocked('Unanswered interactions must remain pending.')
    # The existing dispatcher pauses queued messages after an error. Preserve
    # that terminal run and queue verbatim; neither is rewritten by this repair.
    if not last or last['status'] != 'error':
        raise RecoveryBlocked('A saved failed foreground run is required.')
    journal = ContinuationJournal(target['taskId'])
    if journal.rows():
        if task['status'] != 'done':
            raise RecoveryBlocked('Dropped-result retirement requires an explicitly completed task.')
    elif journal.turn_state() != 'running':
        raise RecoveryBlocked('Turn-only repair requires a saved unfinished turn.')
    return journal


def idle(status):
    if status.get('draining') is not True or status.get('activeRuns') != 0:
        raise RecoveryBlocked('Authenticated drain with zero active runs is required.')


def repair(targets, *, olympus_home, backup_dir, request):
    """Retain exact receipts, then ask the unchanged live maintenance guard."""
    idle(request('/status'))
    home = Path(olympus_home)
    backups = Path(backup_dir)
    backups.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(backups, 0o700)
    fence = home / '.hermes-update-in-progress'
    operation = str(uuid.uuid4())
    payload = json.dumps({'operation': 'recovery-retention', 'id': operation, 'targets': targets})
    # Exclusive creation prevents stealing another maintenance operation's fence.
    with fence.open('x') as output:
        os.chmod(fence, 0o600)
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    applied = []
    attempted = []
    try:
        for target in targets:
            idle(request('/status'))
            os.environ['HERMES_HOME'] = target['hermesHome']
            journal = validate_target(target, home / 'data/olympus-dispatch.db')
            path = backups / (target['taskId'] + '.db')
            with closing(read_db(journal.path)) as source, closing(sqlite3.connect(path)) as destination:
                source.backup(destination)
                if destination.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise RecoveryBlocked('Recovery backup integrity check failed.')
            os.chmod(path, 0o600)
            attempted.append(journal)
            receipt = journal.retain_for_user(NativeLedger(target['hermesHome']), expected=target['fingerprint'],
                                              owners=_lineage_aliases(target['taskId']))
            applied.append((journal, receipt, target))
        idle(request('/status'))
        if request('/hermes/check').get('ready') is not True:
            raise RecoveryBlocked('The existing full maintenance check did not pass.')
        idle(request('/status'))
        (backups / 'receipts.json').write_text(json.dumps([
            {'taskId': target['taskId'], 'path': str(journal.path), 'receipt': receipt}
            for journal, receipt, target in applied]))
        os.chmod(backups / 'receipts.json', 0o600)
        return {'ready': True, 'retainedTasks': len(applied), 'fenceId': operation, 'draining': True}
    except BaseException:
        # Never un-fence a partially restored installation. A crash also leaves
        # the fence durable so the old worker cannot omit retained context.
        for journal, receipt, target in reversed(applied):
            journal.restore_retained(receipt)
            if journal.fingerprint() != target['fingerprint']:
                raise RecoveryBlocked('Exact recovery restoration could not be verified; keep drained.')
        if len(attempted) != len(applied):
            raise RecoveryBlocked('Recovery commit outcome is uncertain; keep drained and inspect retained receipts.')
        if fence.read_text() != payload:
            raise RecoveryBlocked('Maintenance fence ownership changed; keep drained.')
        fence.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--targets', required=True, help='JSON array: taskId, profile, hermesHome, fingerprint')
    parser.add_argument('--backup-dir', required=True, help='New private directory under this installation backups')
    args = parser.parse_args()
    home = Path(os.environ['OLYMPUS_DISPATCH_HOME']).resolve()
    backups = Path(args.backup_dir).resolve()
    if not backups.is_relative_to(home / 'backups'):
        raise RecoveryBlocked('Backups must stay in the selected installation.')
    token = os.environ['OLYMPUS_MAINTENANCE_TOKEN']
    port = int(os.environ.get('PORT', '6969'))
    def request(route):
        req = urllib.request.Request(f'http://127.0.0.1:{port}/api/maintenance{route}',
                                     headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.load(response)
    print(json.dumps(repair(json.loads(Path(args.targets).read_text()), olympus_home=home,
                            backup_dir=backups, request=request)))


if __name__ == '__main__':
    main()

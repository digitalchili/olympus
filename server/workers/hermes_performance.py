"""Opt-in local stage metadata. Never write diagnostics to protocol stdout."""
import json
import os
import re
import sys
import threading
import time

STAGES = frozenset(('dispatched', 'slot_acquired', 'history_ready', 'mcp_ready', 'runtime_ready',
                    'agent_ready', 'native_started', 'first_activity', 'first_text', 'cleaned_up'))
OUTCOMES = frozenset(('done', 'error', 'stopped', 'rejected'))


class PerformanceTrace:
    def __init__(self, trace_id, *, clock=None, write=None):
        self.enabled = (os.environ.get('OLYMPUS_PERF_DIAGNOSTICS') == '1'
                        and isinstance(trace_id, str)
                        and re.fullmatch(r'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}', trace_id) is not None)
        if not self.enabled:
            return
        self.trace_id = trace_id
        self.clock = clock or time.monotonic
        self.write = write or (lambda line: print(line, file=sys.stderr, flush=True))
        self.started = self.clock()
        self.recorded = set()
        self.finished = False
        self.native_started_at = None
        self.lock = threading.Lock()

    def _emit(self, **record):
        try:
            self.write('[olympus-perf] ' + json.dumps(dict(source='worker', traceId=self.trace_id,
                       elapsedMs=round(max(0, self.clock() - self.started) * 1000, 3), **record), separators=(',', ':')))
        except Exception:
            pass

    def mark(self, stage):
        if not self.enabled or not isinstance(stage, str) or stage not in STAGES:
            return
        with self.lock:
            if self.finished or stage in self.recorded:
                return
            self.recorded.add(stage)
            if stage == 'native_started':
                self.native_started_at = self.clock()
            # Includes native preparation/retries and provider waiting; this is
            # deliberately not labelled upstream request or provider-only time.
            interval = ({'nativeFirstOutputMs': round(max(0, self.clock() - self.native_started_at) * 1000, 3)}
                        if stage == 'first_activity' and self.native_started_at is not None else {})
            self._emit(event='stage', stage=stage, **interval)

    def finish(self, outcome):
        if not self.enabled or not isinstance(outcome, str) or outcome not in OUTCOMES:
            return
        with self.lock:
            if self.finished:
                return
            self.finished = True
            self._emit(event='finished', outcome=outcome)

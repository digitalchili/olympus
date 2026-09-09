"""Read provider allowances using the selected profile's native Hermes auth."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import math
import threading
import time

_lock = threading.Lock()
_cached = None
_cached_at = 0.0
_cached_default = None
_links = {
    'openai-codex': 'https://chatgpt.com/codex/settings/usage',
    'openai': 'https://platform.openai.com/usage',
    'anthropic': 'https://console.anthropic.com/settings/usage',
    'openrouter': 'https://openrouter.ai/activity',
}
_labels = {'openai-codex': 'OpenAI · ChatGPT subscription', 'openai': 'OpenAI · API', 'anthropic': 'Anthropic', 'openrouter': 'OpenRouter'}


def project_usage(provider, label, snapshot, default_provider):
    reason = None
    windows = []
    details = []
    plan = None
    if snapshot is not None and not getattr(snapshot, 'unavailable_reason', None):
        plan = getattr(snapshot, 'plan', None)
        for window in getattr(snapshot, 'windows', ()):
            used = getattr(window, 'used_percent', None)
            remaining = max(0, min(100, 100 - used)) if type(used) in (int, float) and math.isfinite(used) else None
            reset = getattr(window, 'reset_at', None)
            windows.append({'label': 'Current window' if window.label == 'Session' else window.label,
                            'remainingPercent': remaining,
                            'resetAt': int(reset.timestamp() * 1000) if isinstance(reset, datetime) else None,
                            'detail': getattr(window, 'detail', None)})
        # Reset redemption belongs to Codex; never surface CLI instructions as controls.
        details = [line for line in getattr(snapshot, 'details', ()) if isinstance(line, str) and '/usage reset' not in line]
    available = bool(details or any(w['remainingPercent'] is not None for w in windows))
    if not available:
        reason = ('API spending is separate from subscription allowance. Open the provider dashboard for usage and billing.'
                  if provider == 'openai' else 'This connection does not currently report account usage. Check its provider dashboard or refresh later.')
    return {'provider': provider, 'label': _labels.get(provider, label), 'isDefault': provider == default_provider,
            'available': available, 'plan': plan, 'windows': windows, 'details': details,
            'unavailableReason': reason, 'dashboardUrl': 'https://claude.ai/settings/usage' if provider == 'anthropic' and available else _links.get(provider),
            'fetchedAt': int(datetime.now(timezone.utc).timestamp() * 1000)}


def get_usage(defaults, config, refresh=False):
    global _cached, _cached_at, _cached_default
    # Workers are profile scoped. Serialize refreshes without blocking the JSONL reader.
    with _lock:
        if not refresh and _cached is not None and _cached_default == defaults.get('provider') and time.monotonic() - _cached_at < 60:
            return _cached
        from agent.account_usage import fetch_account_usage
        from hermes_cli.model_switch import list_authenticated_providers
        from hermes_cli.config import get_compatible_custom_providers
        default = defaults.get('provider')
        providers = list_authenticated_providers(
            current_provider=default or '', current_base_url=defaults.get('baseUrl') or '',
            current_model=defaults.get('model') or '', user_providers=config.get('providers') or {},
            custom_providers=get_compatible_custom_providers(config), max_models=1, probe_custom_providers=False)
        inventory = {p['slug']: p.get('name') or p['slug'] for p in providers if isinstance(p, dict) and p.get('slug')}
        if default:
            inventory.setdefault(default, default)

        def load(item):
            provider, label = item
            snapshot = None
            if provider in ('openai-codex', 'anthropic', 'openrouter'):
                try:
                    snapshot = fetch_account_usage(provider)
                except Exception:
                    pass  # Never return credential-bearing upstream exception text.
            return project_usage(provider, label, snapshot, default)

        with ThreadPoolExecutor(max_workers=3) as pool:
            rows = list(pool.map(load, inventory.items()))
        rows.sort(key=lambda row: (0 if row['provider'].startswith('openai') else 1, not row['isDefault'], row['label']))
        _cached = {'providers': rows}
        _cached_at = time.monotonic()
        _cached_default = default
        return _cached

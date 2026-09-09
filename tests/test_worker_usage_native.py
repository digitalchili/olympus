"""Run explicitly with Hermes dependencies: python tests/test_worker_usage_native.py HERMES_SOURCE.

Uses the real Hermes usage parser with mocked credentials and provider HTTP.
"""
import inspect
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch


source = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="olympus-usage-native-") as home:
    os.environ["HERMES_HOME"] = home
    Path(home, "config.yaml").write_text("{}\n")
    sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "server" / "workers"), source]
    import agent.account_usage as native
    from hermes_cli.model_switch import list_authenticated_providers
    from hermes_usage import get_usage

    assert "probe_custom_providers" in inspect.signature(list_authenticated_providers).parameters
    client = MagicMock()
    client.__enter__.return_value = client
    response = MagicMock()
    response.json.return_value = {
        "plan_type": "pro",
        "rate_limit": {
            "primary_window": {"used_percent": 23, "reset_at": 1893456000},
            "secondary_window": {"used_percent": 61, "reset_at": 1894060800},
        },
    }
    client.get.return_value = response
    with (
        patch.object(native, "_resolve_codex_usage_credentials", return_value=(
            "fixture-token", "https://chatgpt.com/backend-api/codex", "fixture-account",
        )),
        patch.object(native.httpx, "Client", return_value=client),
        patch("hermes_cli.model_switch.list_authenticated_providers", return_value=[
            {"slug": "openai-codex", "name": "OpenAI"},
        ]),
    ):
        result = get_usage({"provider": "openai-codex"}, {}, True)
        row = result["providers"][0]
        assert [window["remainingPercent"] for window in row["windows"]] == [77.0, 39.0]
        assert row["plan"] == "Pro"
        assert "fixture-token" not in str(result)

print("Native Hermes usage contract passed with mocked provider HTTP and credentials.")

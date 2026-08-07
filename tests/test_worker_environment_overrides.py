from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1] / "server" / "workers"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from hermes_worker_utils import (  # noqa: E402
    WorkerError,
    apply_worker_environment_overrides,
)


class WorkerEnvironmentOverrideTests(unittest.TestCase):
    def test_missing_override_file_is_a_noop(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            environment = {"EXISTING": "kept"}
            loaded = apply_worker_environment_overrides(Path(root), environment)
            self.assertEqual(loaded, {})
            self.assertEqual(environment, {"EXISTING": "kept"})

    def test_profile_override_file_wins_over_native_profile_environment(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            home = Path(root)
            (home / ".olympus-dispatch.env").write_text(
                "# Olympus-only profile connectivity\n"
                "PROFILE_API_URL=http://profile-api.private:18080\n"
                "export HTTPS_PROXY='http://proxy.internal:8080'\n",
                encoding="utf-8",
            )
            environment = {
                "PROFILE_API_URL": "http://native-api:8080",
                "HERMES_HOME": str(home),
            }

            loaded = apply_worker_environment_overrides(home, environment)

            self.assertEqual(
                loaded,
                {
                    "PROFILE_API_URL": "http://profile-api.private:18080",
                    "HTTPS_PROXY": "http://proxy.internal:8080",
                },
            )
            self.assertEqual(environment["PROFILE_API_URL"], "http://profile-api.private:18080")
            self.assertEqual(environment["HERMES_HOME"], str(home))

    def test_core_process_environment_cannot_be_overridden(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            home = Path(root)
            (home / ".olympus-dispatch.env").write_text("HERMES_HOME=/tmp/escape\n", encoding="utf-8")

            with self.assertRaises(WorkerError) as raised:
                apply_worker_environment_overrides(home, {})

            self.assertEqual(raised.exception.code, "invalid_worker_environment")
            self.assertNotIn("/tmp/escape", str(raised.exception))

    def test_override_file_must_not_be_a_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as external:
            home = Path(root)
            target = Path(external) / "outside.env"
            target.write_text("SAFE_VALUE=outside\n", encoding="utf-8")
            os.symlink(target, home / ".olympus-dispatch.env")

            with self.assertRaises(WorkerError) as raised:
                apply_worker_environment_overrides(home, {})

            self.assertEqual(raised.exception.code, "invalid_worker_environment")

    def test_worker_applies_override_after_hermes_import_loads_native_environment(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / "profile"
            agent_dir = Path(root) / "hermes-agent"
            hermes_cli_dir = agent_dir / "hermes_cli"
            home.mkdir()
            hermes_cli_dir.mkdir(parents=True)
            (hermes_cli_dir / "__init__.py").write_text("", encoding="utf-8")
            (hermes_cli_dir / "env_loader.py").write_text(
                "import os\n"
                "def _apply_external_secret_sources(home_path):\n"
                "    os.environ['EXTERNAL_VALUE'] = 'external-source'\n"
                "def _apply_managed_env():\n"
                "    os.environ['MANAGED_ENDPOINT'] = 'http://managed-policy:8080'\n"
                "def load_hermes_dotenv(*, hermes_home=None, project_env=None):\n"
                "    os.environ['PROFILE_API_URL'] = 'http://native-api:8080'\n"
                "    os.environ['EXTERNAL_VALUE'] = 'native-value'\n"
                "    os.environ['MANAGED_ENDPOINT'] = 'http://native-managed:8080'\n"
                "    _apply_external_secret_sources(hermes_home)\n"
                "    _apply_managed_env()\n"
                "    return []\n",
                encoding="utf-8",
            )
            (home / ".olympus-dispatch.env").write_text(
                "PROFILE_API_URL=http://profile-api.private:18080\n"
                "EXTERNAL_VALUE=profile-value\n"
                "MANAGED_ENDPOINT=http://profile-managed:8080\n",
                encoding="utf-8",
            )
            (agent_dir / "run_agent.py").write_text(
                "import os\n"
                "from hermes_cli.env_loader import load_hermes_dotenv\n"
                "load_hermes_dotenv()\n"
                "PLUGIN_API_URL = os.environ['PROFILE_API_URL']\n"
                "PLUGIN_EXTERNAL_VALUE = os.environ['EXTERNAL_VALUE']\n"
                "PLUGIN_MANAGED_ENDPOINT = os.environ['MANAGED_ENDPOINT']\n"
                "class AIAgent:\n"
                "    plugin_api_url = PLUGIN_API_URL\n"
                "    plugin_external_value = PLUGIN_EXTERNAL_VALUE\n"
                "    plugin_managed_endpoint = PLUGIN_MANAGED_ENDPOINT\n"
                "    def __init__(self):\n"
                "        pass\n",
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment.update(
                {
                    "HERMES_AGENT_DIR": str(agent_dir),
                    "HERMES_HOME": str(home),
                    "PROFILE_API_URL": "http://parent-environment:8080",
                }
            )
            command = (
                "import os,sys; "
                f"sys.path.insert(0, {str(WORKER_DIR)!r}); "
                "import hermes_worker; "
                "hermes_worker._ensure_imports(); "
                "print('|'.join([hermes_worker._AIAgent.plugin_api_url, "
                "hermes_worker._AIAgent.plugin_external_value, "
                "hermes_worker._AIAgent.plugin_managed_endpoint]))"
            )

            completed = subprocess.run(
                [sys.executable, "-c", command],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )

            self.assertEqual(
                completed.stdout.strip(),
                "http://profile-api.private:18080|external-source|http://managed-policy:8080",
            )


if __name__ == "__main__":
    unittest.main()

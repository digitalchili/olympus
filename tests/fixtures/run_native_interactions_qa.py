"""Disposable real-Hermes/browser integration. Requires a built app and preinstalled runtimes.
Only the external model is a deterministic fixture; no production credentials are inherited.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(url, process):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"QA process exited with {process.returncode}; inspect logs")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.15)
    raise RuntimeError(f"QA readiness timeout: {url}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", required=True, help="Python in an installed Hermes v0.21 environment")
    parser.add_argument("--hermes-root", required=True, help="Matching Hermes source checkout")
    parser.add_argument("--playwright", required=True, help="Absolute path to Playwright's index.mjs")
    parser.add_argument("--browsers", required=True, help="Preinstalled PLAYWRIGHT_BROWSERS_PATH")
    args = parser.parse_args()
    # Do not resolve the venv Python symlink: doing so would bypass its pyvenv.cfg.
    native_python = os.path.abspath(args.python)
    hermes_root = str(Path(args.hermes_root).resolve())
    if not (ROOT / "dist/server/server/index.js").is_file():
        parser.error("Run npm run build first")
    for required in [native_python, hermes_root, args.playwright, args.browsers]:
        if not Path(required).exists():
            parser.error(f"Missing preinstalled prerequisite: {required}")
    node = shutil.which("node")
    if not node:
        parser.error("Node.js is required")
    output = Path(tempfile.mkdtemp(prefix=".tmp-native-qa-", dir=ROOT))
    print(f"QA_ARTIFACTS={output}", flush=True)
    for folder in ["home", "tmp", "hermes", "app/data", "app/workspace"]:
        (output / folder).mkdir(parents=True, exist_ok=True)
    provider_port, app_port = available_port(), available_port()
    while provider_port == app_port:
        app_port = available_port()
    provider_url = f"http://127.0.0.1:{provider_port}/v1"
    base = f"http://127.0.0.1:{app_port}"
    config = {
        "_config_version": 39,
        "model": {"default": "qa-fixture", "provider": "custom:qa-fixture", "base_url": provider_url},
        "toolsets": ["clarification"], "agent": {"max_iterations": 4},
        "terminal": {"backend": "local"},
        "memory": {"memory_enabled": False, "user_profile_enabled": False},
        "custom_providers": [{"name": "qa-fixture", "base_url": provider_url,
            "api_key": "qa-fixture-not-a-secret", "api_mode": "chat_completions",
            "model": "qa-fixture", "models": {"qa-fixture": {}}, "models_discovered": True}],
    }
    (output / "hermes/config.yaml").write_text(json.dumps(config), encoding="utf-8")
    env = {
        "PATH": os.environ.get("PATH", os.defpath), "LANG": "C.UTF-8", "NO_COLOR": "1",
        "HOME": str(output / "home"), "TMPDIR": str(output / "tmp"),
        "HERMES_HOME": str(output / "hermes"), "HERMES_AGENT_DIR": hermes_root,
        "HERMES_PYTHON": native_python, "PYTHONPATH": hermes_root,
        "OLYMPUS_DISPATCH_HOME": str(output / "app"), "DB_PATH": str(output / "app/data/qa.db"),
        "HOST": "127.0.0.1", "PORT": str(app_port), "OLYMPUS_STRICT_PORT": "1", "NODE_ENV": "production",
        "OLYMPUS_QA_PROVIDER_PORT": str(provider_port), "OLYMPUS_NATIVE_QA_URL": base,
        "OLYMPUS_QA_OUTPUT": str(output), "OLYMPUS_QA_PLAYWRIGHT": str(Path(args.playwright).resolve()),
        "PLAYWRIGHT_BROWSERS_PATH": str(Path(args.browsers).resolve()),
    }
    processes, logs = [], []
    try:
        for name, command, health in [
            ("provider", [sys.executable, "-u", "tests/fixtures/native_interaction_provider.py"], provider_url + "/models"),
            ("app", [node, "dist/server/server/index.js"], base + "/api/health"),
        ]:
            log = (output / f"{name}.log").open("w", encoding="utf-8")
            logs.append(log)
            process = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append(process)
            wait_for(health, process)
        result = subprocess.run([node, "tests/browser/task_forms_and_paste.mjs"], cwd=ROOT,
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        (output / "browser.log").write_text(result.stdout, encoding="utf-8")
        print(result.stdout, end="", flush=True)
        return result.returncode
    finally:
        # Each service has its own owned process group, including its native worker children.
        for process in reversed(processes):
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            except ProcessLookupError:
                process.wait(timeout=5)
        for log in logs:
            log.close()


if __name__ == "__main__":
    raise SystemExit(main())

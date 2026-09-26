"""Explicit native contract: python tests/test_worker_openai_auth_native.py HERMES_SOURCE.

Only disposable homes, synthetic grants, and mocked HTTP are used. The shared-grant
test uses separate processes because each Olympus profile owns a separate worker.
"""
import contextlib
import inspect
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch


SOURCE = Path(sys.argv[1]).resolve()
SCRIPT = Path(__file__).resolve()


def pair(prefix):
    return {"access_token": prefix + "-at", "refresh_token": prefix + "-rt"}


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def isolated_env(home, profile="work"):
    return {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home),
        "LOCALAPPDATA": str(home),
        "HERMES_HOME": str(home / ".hermes" / "profiles" / profile),
        "CODEX_HOME": str(home / ".codex"),
        "PYTHONPATH": str(SOURCE),
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def load_native():
    sys.path.insert(0, str(SOURCE))
    from hermes_cli import auth
    assert Path(auth.__file__).resolve().is_relative_to(SOURCE)
    return auth


def deny_network(*args, **kwargs):
    raise AssertionError("Unmocked network access in native auth contract")


def refresh_child(home, profile):
    env = isolated_env(home, profile)
    os.environ.clear()
    os.environ.update(env)
    with patch.object(socket.socket, "connect", deny_network):
        auth = load_native()
        import httpx

        class Endpoint:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def post(self, url, *, data, **kwargs):
                assert data["refresh_token"] == "old-rt"
                # Exclusive create is our fake single-use token endpoint's atomic state.
                try:
                    with (home / "token-consumed").open("x") as consumed:
                        consumed.write(profile)
                    status, result = 200, pair("new")
                except FileExistsError:
                    status, result = 400, {"error": "refresh_token_reused"}
                with (home / "requests").open("a") as requests:
                    requests.write(profile + "\n")
                time.sleep(0.25)
                return httpx.Response(status, json=result)

        (home / (profile + "-ready")).touch()
        deadline = time.monotonic() + 15
        while not (home / "go").exists():
            if time.monotonic() > deadline:
                raise AssertionError("Parent did not release refresh barrier")
            time.sleep(0.01)
        with patch.object(httpx, "Client", return_value=Endpoint()), contextlib.redirect_stdout(io.StringIO()):
            result = auth._refresh_codex_auth_tokens(pair("old"), timeout_seconds=1.0)
        assert result == pair("new")
        print("shared refresh passed")


class NativeOpenAIAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="olympus-openai-native-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.env = patch.dict(os.environ, isolated_env(self.home), clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.net = patch.object(socket.socket, "connect", deny_network)
        self.net.start()
        self.addCleanup(self.net.stop)
        self.auth = load_native()
        self.root = self.home / ".hermes" / "auth.json"
        self.profile = Path(os.environ["HERMES_HOME"]) / "auth.json"
        write(self.root, {
            "version": 1, "active_provider": "fixture-provider",
            "providers": {"openai-codex": {"auth_mode": "chatgpt", "tokens": pair("old")}},
            "credential_pool": {"openai-codex": [
                {"provider": "openai-codex", "source": "device_code", **pair("old")},
            ]},
        })
        write(self.profile, {"version": 1, "active_provider": "fixture-provider", "providers": {}})
        self.config = self.profile.parent / "config.yaml"
        self.config.write_text("model:\n  provider: fixture-provider\n  default: fixture-model\n")

    def test_native_helper_signatures(self):
        from hermes_cli import auth_codex
        expected = {
            "_codex_request_device_code": {"issuer", "client_id"},
            "_codex_poll_authorization_code": {"issuer", "device_auth_id", "user_code", "poll_interval"},
            "_codex_exchange_authorization_code": {"issuer", "client_id", "code_resp"},
            "_save_codex_tokens": {"tokens", "set_active", "write_through"},
            "resolve_codex_runtime_credentials": {"force_refresh", "refresh_if_expiring", "read_only"},
        }
        for name, required in expected.items():
            with self.subTest(function=name):
                self.assertTrue(required <= inspect.signature(getattr(auth_codex, name)).parameters.keys())

    def test_device_flow_mocked_http_and_private_progress(self):
        from hermes_cli import auth_codex
        import httpx
        captured = io.StringIO()
        device = {"device_auth_id": "fixture-device", "user_code": "FIXTURE", "interval": "1"}
        code = {"authorization_code": "fixture-code", "code_verifier": "fixture-verifier"}
        client = MagicMock()
        client.__enter__.return_value = client
        client.post.side_effect = [httpx.Response(404), httpx.Response(200, json=code)]
        with (
            contextlib.redirect_stdout(captured),
            patch.object(auth_codex.time, "sleep"),
            patch.object(auth_codex, "_codex_login_post", side_effect=[
                httpx.Response(429, headers={"Retry-After": "1"}),
                httpx.Response(200, json=device),
                httpx.Response(200, json=pair("login")),
            ]) as post,
            patch.object(auth_codex, "_codex_http_client", return_value=client),
        ):
            requested = auth_codex._codex_request_device_code("https://auth.openai.com", "fixture-client")
            self.assertEqual(requested["interval"], 3)
            approved = auth_codex._codex_poll_authorization_code(
                "https://auth.openai.com", device_auth_id=requested["device_auth_id"],
                user_code=requested["user_code"], poll_interval=requested["interval"],
            )
            tokens = auth_codex._codex_exchange_authorization_code(
                "https://auth.openai.com", "fixture-client", approved,
            )
        self.assertEqual(tokens, pair("login"))
        self.assertEqual(post.call_count, 3)
        self.assertEqual(client.post.call_count, 2)
        self.assertEqual(post.call_args.kwargs["data"]["code_verifier"], "fixture-verifier")
        self.assertIn("rate-limiting", captured.getvalue())

    def test_explicit_login_stays_in_profile_and_preserves_defaults(self):
        root_before, config_before = self.root.read_bytes(), self.config.read_bytes()
        self.auth._save_codex_tokens(pair("login"), set_active=False, write_through=False)
        saved = read(self.profile)
        self.assertEqual(saved["providers"]["openai-codex"]["tokens"], pair("login"))
        self.assertEqual(saved["active_provider"], "fixture-provider")
        self.assertEqual(self.root.read_bytes(), root_before)
        self.assertEqual(self.config.read_bytes(), config_before)

    def test_two_profile_processes_rotate_shared_root_once(self):
        children = []
        before = {}
        try:
            for name in ("a", "b"):
                profile = self.root.parent / "profiles" / name
                write(profile / "auth.json", {"version": 1, "providers": {}})
                config = profile / "config.yaml"
                config.write_text("model:\n  provider: fixture-provider\n  default: fixture-model\n")
                before[name] = config.read_bytes()
                children.append(subprocess.Popen(
                    [sys.executable, str(SCRIPT), str(SOURCE), "--refresh-child", str(self.home), name],
                    env=isolated_env(self.home, name), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                ))
            deadline = time.monotonic() + 15
            while not all((self.home / (name + "-ready")).exists() for name in ("a", "b")):
                if any(child.poll() is not None for child in children) or time.monotonic() > deadline:
                    self.fail("Native refresh children did not reach the barrier")
                time.sleep(0.01)
            (self.home / "go").touch()
            outcomes = [child.communicate(timeout=20) for child in children]
            self.assertEqual([child.returncode for child in children], [0, 0], outcomes)
            self.assertEqual(len((self.home / "requests").read_text().splitlines()), 1)
            root = read(self.root)
            self.assertEqual(root["providers"]["openai-codex"]["tokens"], pair("new"))
            pool = root["credential_pool"]["openai-codex"][0]
            self.assertEqual({key: pool[key] for key in pair("new")}, pair("new"))
            self.assertEqual(root["active_provider"], "fixture-provider")
            for name in ("a", "b"):
                profile = self.root.parent / "profiles" / name
                self.assertNotIn("openai-codex", read(profile / "auth.json")["providers"])
                self.assertEqual((profile / "config.yaml").read_bytes(), before[name])
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.communicate()


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[2] == "--refresh-child":
        refresh_child(Path(sys.argv[3]), sys.argv[4])
    else:
        unittest.main(argv=[sys.argv[0], *sys.argv[2:]])

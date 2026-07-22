from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import safe_restart  # noqa: E402


class DeferredThread:
    instances = []

    def __init__(self, *, target, name, daemon):
        self.target = target
        self.name = name
        self.daemon = daemon
        self.started = False
        self.__class__.instances.append(self)

    def start(self):
        self.started = True


class RestartControllerTests(unittest.TestCase):
    def setUp(self):
        DeferredThread.instances.clear()
        self.environ = {}

    def test_restart_lock_allows_only_one_request(self):
        controller = safe_restart.RestartController(
            thread_factory=DeferredThread,
            environ=self.environ,
        )

        self.assertTrue(controller.schedule_restart())
        self.assertFalse(controller.schedule_restart())
        self.assertTrue(controller.restart_accepted)
        self.assertEqual(len(DeferredThread.instances), 1)
        self.assertTrue(DeferredThread.instances[0].started)

    def test_reexec_uses_same_interpreter_and_arguments(self):
        execv = Mock(side_effect=OSError("test stop"))
        sleep = Mock()
        controller = safe_restart.RestartController(
            executable="python-test",
            argv=["ComfyUI/main.py", "--listen", "127.0.0.1"],
            delay=0.25,
            execv=execv,
            sleep=sleep,
            thread_factory=DeferredThread,
            environ=self.environ,
        )

        self.assertTrue(controller.schedule_restart())
        with self.assertLogs(safe_restart.LOGGER, level="WARNING"):
            DeferredThread.instances[0].target()

        sleep.assert_called_once_with(0.25)
        execv.assert_called_once_with(
            "python-test",
            [
                "python-test",
                "ComfyUI/main.py",
                "--listen",
                "127.0.0.1",
                "--disable-auto-launch",
            ],
        )
        self.assertFalse(controller.restart_accepted)

    def test_disable_auto_launch_is_not_duplicated(self):
        execv = Mock(side_effect=OSError("test stop"))
        controller = safe_restart.RestartController(
            executable="python-test",
            argv=["ComfyUI/main.py", "--disable-auto-launch"],
            delay=0,
            execv=execv,
            sleep=Mock(),
            thread_factory=DeferredThread,
            environ=self.environ,
        )

        self.assertTrue(controller.schedule_restart())
        with self.assertLogs(safe_restart.LOGGER, level="WARNING"):
            DeferredThread.instances[0].target()

        execv.assert_called_once_with(
            "python-test",
            ["python-test", "ComfyUI/main.py", "--disable-auto-launch"],
        )

    def test_safe_mode_loads_only_safe_restart(self):
        execv = Mock(side_effect=OSError("test stop"))
        controller = safe_restart.RestartController(
            executable="python-test",
            argv=[
                "ComfyUI/main.py",
                "--disable-all-custom-nodes",
                "--whitelist-custom-nodes",
                "Another-Plugin",
                "--listen",
                "127.0.0.1",
            ],
            delay=0,
            execv=execv,
            sleep=Mock(),
            thread_factory=DeferredThread,
            environ=self.environ,
            custom_node_folder="ComfyUI-Restart-Control",
        )

        self.assertTrue(controller.schedule_restart(safe_mode=True))
        with self.assertLogs(safe_restart.LOGGER, level="WARNING"):
            DeferredThread.instances[0].target()

        execv.assert_called_once_with(
            "python-test",
            [
                "python-test",
                "ComfyUI/main.py",
                "--listen",
                "127.0.0.1",
                "--disable-all-custom-nodes",
                "--whitelist-custom-nodes",
                "ComfyUI-Restart-Control",
                "--disable-auto-launch",
            ],
        )
        self.assertEqual(self.environ, {})

    def test_inventory_distinguishes_active_disabled_and_excluded_plugins(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["Active-Plugin", "Disabled-Plugin.disabled", "Safe-Restart"]:
                (root / name).mkdir()
            controller = safe_restart.RestartController(
                argv=[
                    "ComfyUI/main.py",
                    "--disable-all-custom-nodes",
                    "--whitelist-custom-nodes",
                    "Safe-Restart",
                ],
                environ={
                    safe_restart.SAFE_MODE_ENV: "1",
                    safe_restart.ORIGINAL_ARGV_ENV: safe_restart.json.dumps(
                        ["ComfyUI/main.py"]
                    ),
                },
                custom_node_folder="Safe-Restart",
                custom_node_paths=lambda: [directory],
            )

            inventory = {plugin["id"]: plugin for plugin in controller.plugin_inventory()}

            self.assertEqual(inventory["Active-Plugin"]["state"], "excluded")
            self.assertTrue(inventory["Active-Plugin"]["selectable"])
            self.assertEqual(inventory["Disabled-Plugin.disabled"]["state"], "disabled")
            self.assertFalse(inventory["Disabled-Plugin.disabled"]["selectable"])
            self.assertEqual(inventory["Safe-Restart"]["state"], "protected")
            self.assertFalse(inventory["Safe-Restart"]["selectable"])

    def test_selective_safe_mode_uses_only_valid_enabled_plugins(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["Plugin-A", "Plugin-B", "Safe-Restart"]:
                (root / name).mkdir()
            execv = Mock(side_effect=OSError("test stop"))
            controller = safe_restart.RestartController(
                executable="python-test",
                argv=["ComfyUI/main.py"],
                delay=0,
                execv=execv,
                sleep=Mock(),
                thread_factory=DeferredThread,
                environ=self.environ,
                custom_node_folder="Safe-Restart",
                custom_node_paths=lambda: [directory],
            )
            enabled = controller.enabled_plugins(["Plugin-B"])

            self.assertEqual(enabled, ["Plugin-B", "Safe-Restart"])
            self.assertTrue(controller.schedule_restart(safe_mode=True, enabled_plugins=enabled))
            with self.assertLogs(safe_restart.LOGGER, level="WARNING"):
                DeferredThread.instances[0].target()

            execv.assert_called_once_with(
                "python-test",
                [
                    "python-test",
                    "ComfyUI/main.py",
                    "--disable-all-custom-nodes",
                    "--whitelist-custom-nodes",
                    "Plugin-B",
                    "Safe-Restart",
                    "--disable-auto-launch",
                ],
            )

    def test_selection_rejects_unknown_or_unavailable_plugins(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Safe-Restart").mkdir()
            (root / "Disabled.disabled").mkdir()
            controller = safe_restart.RestartController(
                environ={},
                custom_node_folder="Safe-Restart",
                custom_node_paths=lambda: [directory],
            )

            with self.assertRaises(ValueError):
                controller.enabled_plugins(["Unknown"])
            with self.assertRaises(ValueError):
                controller.enabled_plugins(["Disabled.disabled"])

    def test_normal_restart_restores_arguments_saved_before_safe_mode(self):
        original_argv = ["ComfyUI/main.py", "--listen", "0.0.0.0"]
        self.environ.update(
            {
                safe_restart.SAFE_MODE_ENV: "1",
                safe_restart.ORIGINAL_ARGV_ENV: safe_restart.json.dumps(original_argv),
            }
        )
        execv = Mock(side_effect=OSError("test stop"))
        controller = safe_restart.RestartController(
            executable="python-test",
            argv=[
                "ComfyUI/main.py",
                "--disable-all-custom-nodes",
                "--whitelist-custom-nodes",
                "ComfyUI-Restart-Control",
            ],
            delay=0,
            execv=execv,
            sleep=Mock(),
            thread_factory=DeferredThread,
            environ=self.environ,
        )

        self.assertTrue(controller.managed_safe_mode)
        self.assertTrue(controller.schedule_restart())
        with self.assertLogs(safe_restart.LOGGER, level="WARNING"):
            DeferredThread.instances[0].target()

        execv.assert_called_once_with(
            "python-test",
            [
                "python-test",
                "ComfyUI/main.py",
                "--listen",
                "0.0.0.0",
                "--disable-auto-launch",
            ],
        )


class RestartEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        DeferredThread.instances.clear()
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.plugin_root = Path(self.temporary_directory.name)
        for name in ["Plugin-A", "Disabled.disabled", "Safe-Restart"]:
            (self.plugin_root / name).mkdir()
        self.original_controller = safe_restart.CONTROLLER
        self.controller = safe_restart.RestartController(
            thread_factory=DeferredThread,
            environ={},
            custom_node_folder="Safe-Restart",
            custom_node_paths=lambda: [self.temporary_directory.name],
        )
        safe_restart.CONTROLLER = self.controller
        app = web.Application()
        app.router.add_get(safe_restart.CAPABILITIES_PATH, safe_restart.capabilities)
        app.router.add_get(safe_restart.PLUGINS_PATH, safe_restart.plugins)
        app.router.add_post(safe_restart.RESTART_PATH, safe_restart.restart)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.origin = f"http://{self.client.host}:{self.client.port}"

    async def asyncTearDown(self):
        await self.client.close()
        safe_restart.CONTROLLER = self.original_controller
        self.temporary_directory.cleanup()

    async def post(
        self,
        *,
        token=None,
        origin=None,
        json_body=None,
        raw_body=None,
        content_type=None,
    ):
        headers = {"Origin": origin or self.origin}
        if token is not None:
            headers[safe_restart.TOKEN_HEADER] = token
        if raw_body is not None:
            if content_type:
                headers["Content-Type"] = content_type
            return await self.client.post(
                safe_restart.RESTART_PATH,
                data=raw_body,
                headers=headers,
            )
        return await self.client.post(
            safe_restart.RESTART_PATH,
            json={} if json_body is None else json_body,
            headers=headers,
        )

    async def test_capabilities_are_not_cached_and_expose_boot_token(self):
        response = await self.client.get(safe_restart.CAPABILITIES_PATH)
        body = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store, max-age=0")
        self.assertEqual(body["boot_id"], self.controller.boot_id)
        self.assertEqual(body["restart_token"], self.controller.token)
        self.assertFalse(body["restart_in_progress"])
        self.assertFalse(body["safe_mode"])

    async def test_missing_and_invalid_tokens_are_rejected(self):
        missing = await self.post()
        invalid = await self.post(token="not-the-token")

        self.assertEqual(missing.status, 403)
        self.assertEqual(invalid.status, 403)
        self.assertFalse(self.controller.restart_accepted)

    async def test_plugin_inventory_requires_token_and_protects_safe_restart(self):
        missing = await self.client.get(safe_restart.PLUGINS_PATH)
        response = await self.client.get(
            safe_restart.PLUGINS_PATH,
            headers={safe_restart.TOKEN_HEADER: self.controller.token},
        )
        body = await response.json()
        inventory = {plugin["id"]: plugin for plugin in body["plugins"]}

        self.assertEqual(missing.status, 403)
        self.assertEqual(response.status, 200)
        self.assertTrue(inventory["Plugin-A"]["selectable"])
        self.assertEqual(inventory["Disabled.disabled"]["state"], "disabled")
        self.assertTrue(inventory["Safe-Restart"]["protected"])

    async def test_cross_origin_request_is_rejected(self):
        response = await self.post(
            token=self.controller.token,
            origin="https://attacker.example",
        )

        self.assertEqual(response.status, 403)
        self.assertFalse(self.controller.restart_accepted)

    async def test_json_content_type_and_empty_object_are_required(self):
        wrong_type = await self.post(
            token=self.controller.token,
            raw_body="{}",
            content_type="text/plain",
        )
        non_empty = await self.post(
            token=self.controller.token,
            json_body={"command": "anything"},
        )
        false_safe_mode = await self.post(
            token=self.controller.token,
            json_body={"safe_mode": False},
        )

        self.assertEqual(wrong_type.status, 415)
        self.assertEqual(non_empty.status, 400)
        self.assertEqual(false_safe_mode.status, 400)
        self.assertFalse(self.controller.restart_accepted)

    async def test_safe_mode_request_is_accepted(self):
        response = await self.post(
            token=self.controller.token,
            json_body={"safe_mode": True},
        )
        body = await response.json()

        self.assertEqual(response.status, 202)
        self.assertTrue(body["safe_mode"])
        self.assertTrue(self.controller.restart_accepted)

    async def test_selective_safe_mode_request_is_validated_and_accepted(self):
        response = await self.post(
            token=self.controller.token,
            json_body={"safe_mode": True, "enabled_plugins": ["Plugin-A"]},
        )
        body = await response.json()

        self.assertEqual(response.status, 202)
        self.assertEqual(body["enabled_plugins"], ["Plugin-A", "Safe-Restart"])
        self.assertTrue(self.controller.restart_accepted)

    async def test_selective_safe_mode_rejects_unknown_and_duplicate_plugins(self):
        unknown = await self.post(
            token=self.controller.token,
            json_body={"safe_mode": True, "enabled_plugins": ["Unknown"]},
        )
        duplicate = await self.post(
            token=self.controller.token,
            json_body={"safe_mode": True, "enabled_plugins": ["Plugin-A", "Plugin-A"]},
        )

        self.assertEqual(unknown.status, 400)
        self.assertEqual(duplicate.status, 400)
        self.assertFalse(self.controller.restart_accepted)

    async def test_accepts_once_and_returns_202_then_409(self):
        accepted = await self.post(token=self.controller.token)
        duplicate = await self.post(token=self.controller.token)

        self.assertEqual(accepted.status, 202)
        self.assertEqual(duplicate.status, 409)
        self.assertTrue(self.controller.restart_accepted)
        self.assertEqual(len(DeferredThread.instances), 1)


if __name__ == "__main__":
    unittest.main()

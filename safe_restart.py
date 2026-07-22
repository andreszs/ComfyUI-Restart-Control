from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
import sys
import threading
import time
import uuid
from collections.abc import Callable, MutableMapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from aiohttp import web

LOGGER = logging.getLogger("comfyui.restart_control")
CAPABILITIES_PATH = "/safe-restart/capabilities"
PLUGINS_PATH = "/safe-restart/plugins"
RESTART_PATH = "/safe-restart/restart"
TOKEN_HEADER = "X-ComfyUI-Safe-Restart-Token"
RESTART_DELAY_SECONDS = 0.75
DISABLE_AUTO_LAUNCH_ARG = "--disable-auto-launch"
DISABLE_ALL_CUSTOM_NODES_ARG = "--disable-all-custom-nodes"
WHITELIST_CUSTOM_NODES_ARG = "--whitelist-custom-nodes"
SAFE_MODE_ENV = "COMFYUI_SAFE_RESTART_MANAGED_SAFE_MODE"
ORIGINAL_ARGV_ENV = "COMFYUI_SAFE_RESTART_ORIGINAL_ARGV"


def _without_custom_node_mode_args(argv: list[str]) -> list[str]:
    result = []
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == DISABLE_ALL_CUSTOM_NODES_ARG:
            index += 1
            continue
        if argument == WHITELIST_CUSTOM_NODES_ARG:
            index += 1
            while index < len(argv) and not argv[index].startswith("-"):
                index += 1
            continue
        result.append(argument)
        index += 1
    return result


def _stored_argv(value: str | None) -> list[str] | None:
    if not value:
        return None
    try:
        argv = json.loads(value)
    except json.JSONDecodeError:
        return None
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
        return None
    return argv


def _custom_node_mode(argv: list[str]) -> tuple[bool, set[str]]:
    disabled = DISABLE_ALL_CUSTOM_NODES_ARG in argv
    whitelist = set()
    if WHITELIST_CUSTOM_NODES_ARG not in argv:
        return disabled, whitelist

    index = argv.index(WHITELIST_CUSTOM_NODES_ARG) + 1
    while index < len(argv) and not argv[index].startswith("-"):
        whitelist.add(argv[index])
        index += 1
    return disabled, whitelist


def _default_custom_node_paths() -> list[str]:
    import folder_paths

    return folder_paths.get_folder_paths("custom_nodes")


class RestartController:
    def __init__(
        self,
        *,
        executable: str | None = None,
        argv: list[str] | None = None,
        delay: float = RESTART_DELAY_SECONDS,
        execv: Callable[[str, list[str]], Any] = os.execv,
        sleep: Callable[[float], Any] = time.sleep,
        thread_factory: Callable[..., threading.Thread] = threading.Thread,
        environ: MutableMapping[str, str] | None = None,
        custom_node_folder: str | None = None,
        custom_node_paths: Callable[[], list[str]] = _default_custom_node_paths,
    ) -> None:
        self.boot_id = str(uuid.uuid4())
        self.token = secrets.token_urlsafe(32)
        self.executable = executable or sys.executable
        self.argv = list(sys.argv if argv is None else argv)
        self.delay = delay
        self._execv = execv
        self._sleep = sleep
        self._thread_factory = thread_factory
        self._environ = os.environ if environ is None else environ
        self.custom_node_folder = custom_node_folder or Path(__file__).resolve().parent.name
        self._custom_node_paths = custom_node_paths
        self.managed_safe_mode = self._environ.get(SAFE_MODE_ENV) == "1"
        self._lock = threading.Lock()
        self._restart_accepted = False

    @property
    def restart_accepted(self) -> bool:
        with self._lock:
            return self._restart_accepted

    def plugin_inventory(self) -> list[dict[str, Any]]:
        original_argv = _stored_argv(self._environ.get(ORIGINAL_ARGV_ENV))
        baseline_argv = original_argv if self.managed_safe_mode and original_argv else self.argv
        baseline_disabled, baseline_whitelist = _custom_node_mode(baseline_argv)
        current_disabled, current_whitelist = _custom_node_mode(self.argv)
        entries: dict[str, dict[str, Any]] = {}

        for custom_node_path in self._custom_node_paths():
            path = Path(custom_node_path)
            if not path.is_dir():
                continue
            for entry in path.iterdir():
                name = entry.name
                if name.startswith(".") or name == "__pycache__":
                    continue
                physically_disabled = name.endswith(".disabled")
                if not entry.is_dir() and entry.suffix != ".py" and not physically_disabled:
                    continue

                baseline_enabled = not physically_disabled and (
                    not baseline_disabled or name in baseline_whitelist
                )
                current_enabled = not physically_disabled and (
                    not current_disabled or name in current_whitelist
                )
                protected = name == self.custom_node_folder
                if physically_disabled:
                    state = "disabled"
                elif protected:
                    state = "protected"
                elif not baseline_enabled:
                    state = "launch_disabled"
                elif current_enabled:
                    state = "active"
                else:
                    state = "excluded"

                existing = entries.get(name)
                if existing:
                    existing["locations"] += 1
                    existing["active"] = existing["active"] or current_enabled
                    continue
                display_name = name.removesuffix(".disabled").removesuffix(".py")
                entries[name] = {
                    "id": name,
                    "name": display_name,
                    "state": state,
                    "active": current_enabled,
                    "selectable": baseline_enabled and not protected,
                    "protected": protected,
                    "locations": 1,
                }

        return sorted(entries.values(), key=lambda plugin: plugin["name"].casefold())

    def enabled_plugins(self, requested: list[str]) -> list[str]:
        inventory = self.plugin_inventory()
        allowed = {plugin["id"] for plugin in inventory if plugin["selectable"]}
        unknown = set(requested) - allowed - {self.custom_node_folder}
        if unknown:
            raise ValueError("Unknown or unavailable custom node selection")

        selected = set(requested)
        selected.add(self.custom_node_folder)
        enabled = [
            plugin["id"]
            for plugin in inventory
            if plugin["id"] in selected and (plugin["selectable"] or plugin["protected"])
        ]
        if self.custom_node_folder not in enabled:
            enabled.append(self.custom_node_folder)
        return enabled

    def schedule_restart(
        self,
        *,
        safe_mode: bool = False,
        enabled_plugins: list[str] | None = None,
    ) -> bool:
        with self._lock:
            if self._restart_accepted:
                return False
            self._restart_accepted = True

        thread = self._thread_factory(
            target=lambda: self._replace_process(
                safe_mode=safe_mode,
                enabled_plugins=enabled_plugins,
            ),
            name="comfyui-restart-control",
            daemon=True,
        )
        try:
            thread.start()
        except Exception:
            with self._lock:
                self._restart_accepted = False
            LOGGER.exception("Unable to schedule the ComfyUI restart")
            raise
        return True

    def _restart_argv(
        self,
        *,
        safe_mode: bool,
        enabled_plugins: list[str] | None = None,
    ) -> list[str]:
        if safe_mode:
            if not self.managed_safe_mode and ORIGINAL_ARGV_ENV not in self._environ:
                self._environ[ORIGINAL_ARGV_ENV] = json.dumps(self.argv)
            self._environ[SAFE_MODE_ENV] = "1"
            restart_argv = _without_custom_node_mode_args(self.argv)
            whitelist = enabled_plugins or [self.custom_node_folder]
            restart_argv.extend(
                [DISABLE_ALL_CUSTOM_NODES_ARG, WHITELIST_CUSTOM_NODES_ARG, *whitelist]
            )
        elif self.managed_safe_mode:
            restart_argv = _stored_argv(self._environ.get(ORIGINAL_ARGV_ENV))
            if restart_argv is None:
                LOGGER.warning(
                    "Original launch arguments were unavailable; removing managed safe-mode flags"
                )
                restart_argv = _without_custom_node_mode_args(self.argv)
            self._environ.pop(SAFE_MODE_ENV, None)
            self._environ.pop(ORIGINAL_ARGV_ENV, None)
        else:
            restart_argv = list(self.argv)

        if DISABLE_AUTO_LAUNCH_ARG not in restart_argv:
            restart_argv.append(DISABLE_AUTO_LAUNCH_ARG)
        return restart_argv

    def _replace_process(
        self,
        *,
        safe_mode: bool,
        enabled_plugins: list[str] | None = None,
    ) -> None:
        environment_snapshot = {
            SAFE_MODE_ENV: self._environ.get(SAFE_MODE_ENV),
            ORIGINAL_ARGV_ENV: self._environ.get(ORIGINAL_ARGV_ENV),
        }
        try:
            self._sleep(self.delay)
            restart_argv = self._restart_argv(
                safe_mode=safe_mode,
                enabled_plugins=enabled_plugins,
            )
            command = [self.executable, *restart_argv]
            mode = "safe mode" if safe_mode else "normal mode"
            LOGGER.warning("Restarting the ComfyUI process in %s", mode)
            self._execv(self.executable, command)
            raise RuntimeError("os.execv returned without replacing the process")
        except Exception:
            for key, value in environment_snapshot.items():
                if value is None:
                    self._environ.pop(key, None)
                else:
                    self._environ[key] = value
            with self._lock:
                self._restart_accepted = False
            LOGGER.exception("ComfyUI restart failed; restart requests are enabled again")


CONTROLLER = RestartController()
_ROUTES_REGISTERED = False


def _json_response(data: dict[str, Any], *, status: int = 200) -> web.Response:
    response = web.json_response(data, status=status)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def _same_origin(request: web.Request) -> bool:
    origin = request.headers.get("Origin")
    if not origin:
        return False

    parsed = urlsplit(origin)
    return (
        parsed.scheme in {"http", "https"}
        and parsed.netloc.casefold() == request.host.casefold()
    )


async def capabilities(request: web.Request) -> web.Response:
    return _json_response(
        {
            "available": True,
            "boot_id": CONTROLLER.boot_id,
            "restart_token": CONTROLLER.token,
            "restart_in_progress": CONTROLLER.restart_accepted,
            "safe_mode": CONTROLLER.managed_safe_mode,
        }
    )


async def plugins(request: web.Request) -> web.Response:
    supplied_token = request.headers.get(TOKEN_HEADER, "")
    if not supplied_token or not hmac.compare_digest(supplied_token, CONTROLLER.token):
        return _json_response({"error": "Invalid restart token"}, status=403)
    return _json_response({"plugins": CONTROLLER.plugin_inventory()})


async def restart(request: web.Request) -> web.Response:
    if request.content_type != "application/json":
        return _json_response(
            {"error": "Content-Type must be application/json"}, status=415
        )

    if not _same_origin(request):
        return _json_response({"error": "Cross-origin request rejected"}, status=403)

    supplied_token = request.headers.get(TOKEN_HEADER, "")
    if not supplied_token or not hmac.compare_digest(supplied_token, CONTROLLER.token):
        return _json_response({"error": "Invalid restart token"}, status=403)

    try:
        body = await request.json(loads=json.loads)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_response({"error": "Invalid JSON body"}, status=400)

    if not isinstance(body, dict):
        return _json_response(
            {"error": "Request body must be a JSON object"}, status=400
        )
    safe_mode = body.get("safe_mode") is True
    enabled_plugins = body.get("enabled_plugins")
    valid_keys = {"safe_mode", "enabled_plugins"} if enabled_plugins is not None else {"safe_mode"}
    if (
        set(body) - valid_keys
        or ("safe_mode" in body and body["safe_mode"] is not True)
        or (enabled_plugins is not None and not safe_mode)
        or (enabled_plugins is not None and (
            not isinstance(enabled_plugins, list)
            or len(enabled_plugins) > 1024
            or not all(isinstance(plugin, str) for plugin in enabled_plugins)
            or len(enabled_plugins) != len(set(enabled_plugins))
        ))
    ):
        return _json_response({"error": "Invalid restart selection"}, status=400)

    if safe_mode and enabled_plugins is not None:
        try:
            enabled_plugins = CONTROLLER.enabled_plugins(enabled_plugins)
        except ValueError as error:
            return _json_response({"error": str(error)}, status=400)

    try:
        accepted = CONTROLLER.schedule_restart(
            safe_mode=safe_mode,
            enabled_plugins=enabled_plugins,
        )
    except Exception:
        return _json_response({"error": "Unable to schedule restart"}, status=500)

    if not accepted:
        return _json_response({"error": "A restart is already in progress"}, status=409)

    return _json_response(
        {
            "accepted": True,
            "boot_id": CONTROLLER.boot_id,
            "safe_mode": safe_mode,
            "enabled_plugins": enabled_plugins,
        },
        status=202,
    )


def register_routes() -> None:
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return

    from server import PromptServer

    PromptServer.instance.routes.get(CAPABILITIES_PATH)(capabilities)
    PromptServer.instance.routes.get(PLUGINS_PATH)(plugins)
    PromptServer.instance.routes.post(RESTART_PATH)(restart)
    _ROUTES_REGISTERED = True

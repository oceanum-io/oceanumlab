"""Kernel-side setup for Oceanum Notebook.

The @oceanum/auth-oceanum extension executes this source in the Pyodide kernel whenever a
kernel starts or restarts, and again whenever the Oceanum.io access token changes. It runs
before any user code, so it must stay cheap: it never imports ``oceanum`` (that costs
seconds), and patches ``oceanum`` lazily when user code imports it.

Everything here is idempotent. See SPEC.md §3 (workaround 4) and §9 (decision D3).
"""

from __future__ import annotations

import functools
import importlib.abc
import os
import sys
from types import ModuleType
from typing import Any
from urllib.parse import urlsplit

TOKEN_ENV = "DATAMESH_TOKEN"
SERVICE_ENV = "DATAMESH_SERVICE"

#: Present in every snippet the extension sends, so their history entries can be found.
SNIPPET_MARKER = "__oceanum_notebook__"
REDACTED = "# [Oceanum Notebook: kernel setup, hidden]"

_CONNECTION_MODULE = "oceanum.datamesh.connection"
#: oceanum POSTs JSON strings to these paths without a Content-Type; browser XHR then
#: labels them text/plain and Datamesh returns 422.
_JSON_POST_PATHS = ("/oceanql/stage/", "/oceanql/")
_PATCH_FLAG = "_oceanum_notebook_patched"
_FINDER_FLAG = "_oceanum_notebook_finder"

#: The token this module last set, so a token the user set themselves is never clobbered.
_managed_token: str | None = None


def _skip_check_info(self: Any) -> None:
    """Replaces ``Connector._check_info`` in the browser.

    It only fetches an optional "client outdated" message from ``/info/oceanum_python/``,
    which sends no CORS header. In the browser every attempt fails: oceanum retries for ~5 s
    and swallows the error, but Pyodide still reports the rejected fetch, so the cell that
    creates the Connector ends in a ``JsException: Failed to fetch`` traceback. The kernel's
    oceanum version is pinned, so the message has nothing to say. Remove this once Datamesh
    sends CORS headers on that endpoint (SPEC §15, item 3).
    """


def patch_connection(module: ModuleType) -> None:
    """Make oceanum's Connector work from the browser.

    - Send ``Content-Type: application/json`` on the stage and query POSTs. The upstream fix
      belongs in ``_stage_request`` and ``_query``, which both send through
      ``Connector._retried_request``.
    - Skip the ``/info`` version check (see ``_skip_check_info``).
    """
    connector = module.Connector
    original = connector._retried_request
    if getattr(original, _PATCH_FLAG, False):
        return
    connector._check_info = _skip_check_info

    @functools.wraps(original)
    def _retried_request(self: Any, url: str, *args: Any, **kwargs: Any) -> Any:
        method = kwargs.get("method", "GET")
        if (
            isinstance(method, str)
            and method.upper() == "POST"
            and isinstance(kwargs.get("data"), (str, bytes))
            and urlsplit(url).path.endswith(_JSON_POST_PATHS)
        ):
            headers = dict(kwargs.get("headers") or {})
            if not any(key.lower() == "content-type" for key in headers):
                headers["Content-Type"] = "application/json"
            kwargs["headers"] = headers
        return original(self, url, *args, **kwargs)

    setattr(_retried_request, _PATCH_FLAG, True)
    connector._retried_request = _retried_request


class _PatchingLoader(importlib.abc.Loader):
    """Delegates to the real loader, then patches the freshly executed module."""

    def __init__(self, loader: importlib.abc.Loader) -> None:
        self._loader = loader

    def create_module(self, spec: Any) -> ModuleType | None:
        return self._loader.create_module(spec)

    def exec_module(self, module: ModuleType) -> None:
        self._loader.exec_module(module)
        patch_connection(module)

    def __getattr__(self, name: str) -> Any:
        # get_source, get_resource_reader, ... so tracebacks and inspect keep working.
        return getattr(self._loader, name)


class _PatchOnImport(importlib.abc.MetaPathFinder):
    """Patches ``oceanum.datamesh.connection`` when it is first imported."""

    def find_spec(self, fullname: str, path: Any, target: Any = None) -> Any:
        if fullname != _CONNECTION_MODULE:
            return None
        for finder in sys.meta_path:
            if getattr(finder, _FINDER_FLAG, False) or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is not None and spec.loader is not None:
                spec.loader = _PatchingLoader(spec.loader)
                return spec
        return None


setattr(_PatchOnImport, _FINDER_FLAG, True)


def install(datamesh_url: str | None) -> None:
    """Install the oceanum patch and point oceanum at this environment's Datamesh."""
    # oceanum reads DATAMESH_SERVICE as a default argument, i.e. once, at import time.
    if datamesh_url and SERVICE_ENV not in os.environ:
        os.environ[SERVICE_ENV] = datamesh_url
    module = sys.modules.get(_CONNECTION_MODULE)
    if module is not None:
        patch_connection(module)
    elif not any(getattr(finder, _FINDER_FLAG, False) for finder in sys.meta_path):
        sys.meta_path.insert(0, _PatchOnImport())


def set_token(token: str | None) -> None:
    """Set or clear ``DATAMESH_TOKEN``, leaving alone a value the user set themselves."""
    global _managed_token
    current = os.environ.get(TOKEN_ENV)
    if current is not None and current != _managed_token:
        return
    if token is None:
        os.environ.pop(TOKEN_ENV, None)
    else:
        os.environ[TOKEN_ENV] = token
    _managed_token = token


def scrub_history() -> None:
    """Hide the injected snippet, which carries the token, from IPython's input history."""
    try:
        from IPython import get_ipython
    except ImportError:
        return
    shell = get_ipython()
    if shell is None:
        return
    manager = shell.history_manager
    if manager is not None:
        for history in (manager.input_hist_parsed, manager.input_hist_raw):
            for index, source in enumerate(history):
                if SNIPPET_MARKER in source:
                    history[index] = REDACTED
        # The manager's rolling copies are pushed back into the namespace by the next cell.
        for attr in ("_i00", "_i", "_ii", "_iii"):
            if SNIPPET_MARKER in str(getattr(manager, attr, "")):
                setattr(manager, attr, REDACTED)
    namespace = shell.user_ns
    for key in [key for key in namespace if key.startswith("_i")]:
        value = namespace[key]
        if isinstance(value, str) and SNIPPET_MARKER in value:
            namespace[key] = REDACTED

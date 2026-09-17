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
import importlib.machinery
import importlib.util
import inspect
import os
import sys
from types import ModuleType
from typing import Any
from urllib.parse import urlsplit

TOKEN_ENV = "DATAMESH_TOKEN"
SERVICE_ENV = "DATAMESH_SERVICE"
#: Read by plotly when it is imported. Its default here, plotly_mimetype+notebook, also embeds
#: all of plotly.js (about 4 MB) as HTML in every notebook that shows a figure. The mimetype
#: output alone is drawn by the jupyterlab-plotly extension this site ships.
PLOTLY_RENDERER_ENV = "PLOTLY_RENDERER"
PLOTLY_RENDERER = "plotly_mimetype"

#: Present in every snippet the extension sends, so their history entries can be found.
SNIPPET_MARKER = "__oceanum_notebook__"
REDACTED = "# [Oceanum Notebook: kernel setup, hidden]"

_CONNECTION_MODULE = "oceanum.datamesh.connection"
_CARTOPY_IO_MODULE = "cartopy.io"
_UTILS_MODULE = "oceanum.datamesh.utils"
#: oceanum modules that import retried_request by name.
_RETRIED_REQUEST_IMPORTERS = (
    "oceanum.datamesh.connection",
    "oceanum.datamesh.session",
    "oceanum.datamesh.zarr",
)
#: oceanum POSTs JSON strings to these paths without a Content-Type; browser XHR then
#: labels them text/plain and Datamesh returns 422.
_JSON_POST_PATHS = ("/oceanql/stage/", "/oceanql/")
_PATCH_FLAG = "_oceanum_notebook_patched"
_FINDER_FLAG = "_oceanum_notebook_finder"
_LOCK_FINDER_FLAG = "_oceanum_notebook_lock_finder"

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


def _browser_urlopen(self: Any, url: str) -> Any:
    """Replaces ``cartopy.io.Downloader._urlopen``.

    cartopy downloads Natural Earth and other map data with ``urllib.request.urlopen``, which
    opens a socket and fails in the browser ("TLS not supported in this environment"). requests
    goes through the browser's HTTP instead. Natural Earth's bucket allows cross-origin reads.
    """
    import io
    import urllib.error
    import warnings

    import requests
    from cartopy.io import DownloadWarning

    warnings.warn(f"Downloading: {url}", DownloadWarning, stacklevel=2)
    response = requests.get(url, timeout=120)
    if not response.ok:
        # cartopy catches urllib's HTTPError to fall back to an older data release.
        raise urllib.error.HTTPError(
            url, response.status_code, response.reason, response.headers, None
        )
    return io.BytesIO(response.content)


setattr(_browser_urlopen, _PATCH_FLAG, True)


def patch_cartopy_io(module: ModuleType) -> None:
    """Let cartopy download map data (coastlines, borders, ...) from the browser."""
    downloader = module.Downloader
    if getattr(downloader._urlopen, _PATCH_FLAG, False):
        return
    downloader._urlopen = _browser_urlopen


def patch_utils(module: ModuleType) -> None:
    """Use oceanum's read timeout as the limit on the whole request.

    oceanum passes requests a (connect, read) timeout, (3.05, 10) by default. In the browser
    there is no separate connect phase: urllib3's Emscripten backend aborts the whole fetch
    after the connect timeout. Any request slower than 3.05 s, such as the first catalog
    search, was cut off, and the aborted fetch then surfaced in the cell as
    `JsException: AbortError: signal is aborted without reason`. Both halves now get the read
    timeout: 10 s for metadata, and oceanum's longer ones for queries and downloads.
    """
    original = module.retried_request
    if getattr(original, _PATCH_FLAG, False):
        return
    signature = inspect.signature(original)

    @functools.wraps(original)
    def retried_request(*args: Any, **kwargs: Any) -> Any:
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        timeout = bound.arguments.get("timeout")
        if isinstance(timeout, tuple) and len(timeout) == 2:
            bound.arguments["timeout"] = (timeout[1], timeout[1])
        return original(*bound.args, **bound.kwargs)

    setattr(retried_request, _PATCH_FLAG, True)
    module.retried_request = retried_request
    # Modules that imported the original by name before this patch ran.
    for name in _RETRIED_REQUEST_IMPORTERS:
        importer = sys.modules.get(name)
        if (
            importer is not None
            and getattr(importer, "retried_request", None) is original
        ):
            importer.retried_request = retried_request


#: Modules patched when first imported (or at once, if already imported).
_PATCHES = {
    _UTILS_MODULE: patch_utils,
    _CONNECTION_MODULE: patch_connection,
    _CARTOPY_IO_MODULE: patch_cartopy_io,
}


class _PatchingLoader(importlib.abc.Loader):
    """Delegates to the real loader, then patches the freshly executed module."""

    def __init__(self, loader: importlib.abc.Loader, patch: Any) -> None:
        self._loader = loader
        self._patch = patch

    def create_module(self, spec: Any) -> ModuleType | None:
        return self._loader.create_module(spec)

    def exec_module(self, module: ModuleType) -> None:
        self._loader.exec_module(module)
        self._patch(module)

    def __getattr__(self, name: str) -> Any:
        # get_source, get_resource_reader, ... so tracebacks and inspect keep working.
        return getattr(self._loader, name)


class _PatchOnImport(importlib.abc.MetaPathFinder):
    """Patches the modules in ``_PATCHES`` when they are first imported."""

    def find_spec(self, fullname: str, path: Any, target: Any = None) -> Any:
        patch = _PATCHES.get(fullname)
        if patch is None:
            return None
        for finder in sys.meta_path:
            if getattr(finder, _FINDER_FLAG, False) or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is not None and spec.loader is not None:
                spec.loader = _PatchingLoader(spec.loader, patch)
                return spec
        return None


setattr(_PatchOnImport, _FINDER_FLAG, True)


class _LockPackageLoader(importlib.abc.Loader):
    """Loads a package from the Pyodide lock, then runs the module's real loader."""

    def __init__(self, package: str) -> None:
        self._package = package
        self._spec: importlib.machinery.ModuleSpec | None = None

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> ModuleType:
        import pyodide_js
        from pyodide.ffi import run_sync

        run_sync(pyodide_js.loadPackage(self._package))
        importlib.invalidate_caches()
        real = importlib.machinery.PathFinder.find_spec(spec.name)
        if real is None or real.loader is None:
            raise ModuleNotFoundError(f"No module named {spec.name!r}", name=spec.name)
        self._spec = real
        return importlib.util.module_from_spec(real)

    def exec_module(self, module: ModuleType) -> None:
        assert self._spec is not None and self._spec.loader is not None
        # The import system stamped this placeholder spec on the module; give it the real one.
        module.__spec__ = self._spec
        module.__loader__ = self._spec.loader
        self._spec.loader.exec_module(module)


def _module_initialising() -> bool:
    """Whether a module is being imported now, i.e. its body is still running."""
    return any(
        getattr(getattr(module, "__spec__", None), "_initializing", False) is True
        for module in list(sys.modules.values())
    )


class _LoadFromLock(importlib.abc.MetaPathFinder):
    """Imports packages from the Pyodide lock that library code imports at call time.

    Before a cell runs, the kernel loads the packages named by that cell's own import
    statements (pyodide.loadPackagesFromImports). Imports made later from inside a library
    are never seen: ``DataArray.plot()`` imports matplotlib, and it fails although matplotlib
    is in the lock. This finder is last on sys.meta_path, so it is only asked about modules
    nothing else can find.

    It answers with a spec whose loader fetches the package only when the module is imported.
    Libraries often probe for optional dependencies with ``importlib.util.find_spec`` without
    importing them, and a probe must not download a package.

    It also stays out of the way while any module is being imported. Libraries try optional
    imports as they load (``try: import scipy``), and fetching those made ``import xarray``
    download scipy, 10 s instead of 1 s. An import at call time, which is what this finder is
    for, runs when no module is loading.

    Loading mid-import needs ``pyodide.ffi.run_sync``, which needs JavaScript Promise
    Integration. Where the browser lacks it, this finder answers nothing, so imports behave as
    they would without it.
    """

    _looking = False

    def find_spec(self, fullname: str, path: Any, target: Any = None) -> Any:
        # Submodules come from their package, once it is loaded. The re-entrancy guard covers
        # the imports below, which ask this finder again wherever they cannot be found.
        if self._looking or path is not None or "." in fullname:
            return None
        self._looking = True
        try:
            return self._find_spec(fullname)
        finally:
            self._looking = False

    def _find_spec(self, fullname: str) -> Any:
        try:
            import pyodide_js
            from pyodide.ffi import can_run_sync
        except ImportError:
            return None
        if not can_run_sync() or _module_initialising():
            return None
        names = getattr(
            getattr(pyodide_js, "_api", None), "_import_name_to_package_name", None
        )
        package = names.get(fullname) if names is not None else None
        if package is None or package in pyodide_js.loadedPackages.to_py():
            return None
        return importlib.machinery.ModuleSpec(fullname, _LockPackageLoader(package))


setattr(_LoadFromLock, _LOCK_FINDER_FLAG, True)


def install(datamesh_url: str | None) -> None:
    """Set up the kernel.

    - Install the oceanum and cartopy patches, and point oceanum at this environment's
      Datamesh.
    - Let library code import packages from the lock (see ``_LoadFromLock``).
    - Default plotly to its mimetype renderer (see ``PLOTLY_RENDERER``).
    """
    # oceanum reads DATAMESH_SERVICE as a default argument, i.e. once, at import time.
    if datamesh_url and SERVICE_ENV not in os.environ:
        os.environ[SERVICE_ENV] = datamesh_url
    os.environ.setdefault(PLOTLY_RENDERER_ENV, PLOTLY_RENDERER)
    for name, patch in _PATCHES.items():
        module = sys.modules.get(name)
        if module is not None:
            patch(module)
    if not any(getattr(finder, _FINDER_FLAG, False) for finder in sys.meta_path):
        sys.meta_path.insert(0, _PatchOnImport())
    if not any(getattr(finder, _LOCK_FINDER_FLAG, False) for finder in sys.meta_path):
        sys.meta_path.append(_LoadFromLock())


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

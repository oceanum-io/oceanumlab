import os
import json
from pathlib import Path

from traitlets import Dict, Enum
from traitlets.config import Configurable

from .auth import DeviceAuth
from .handlers import setup_handlers


HERE = Path(__file__).parent.resolve()

try:
    from ._version import __version__
except ImportError:
    # Fallback when using the package in dev mode without installing
    # in editable mode with pip. It is highly recommended to install
    # the package from a stable release or in editable mode: https://pip.pypa.io/en/stable/topics/local-project-installs/#editable-installs
    import warnings

    warnings.warn(
        "Importing 'jupyterlab_examples_hello_world' outside a proper installation."
    )
    __version__ = "dev"


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "@oceanum/oceanumlab"}]


def _jupyter_server_extension_points():
    return [{"module": "oceanumlab"}]


#: The page option that tells the frontend this server runs the device sign-in, and which
#: Oceanum deployment it signs in to. Must match SERVER_AUTH_OPTION in src/auth/serverAuth.ts.
SERVER_AUTH_OPTION = "oceanumServerAuth"

#: Oceanum production. The device grant needs no callback URL, so unlike a browser flow
#: these values work from any host and port, and can simply be the default.
PRODUCTION = {
    "auth0Domain": "auth.oceanum.io",
    # The Auth0 Native application with the Device Code grant enabled. Not a secret: a
    # native client has none, and the id identifies the application, not the user.
    "clientId": "ah2hkmuxnFaKwoKoTyLxJPA9z91WBjlt",
    "audience": "",
    "oceanumDomain": "oceanum.io",
    "urls": {
        "datamesh": "https://datamesh.oceanum.io",
        "specs": "https://specs.oceanum.io",
        "manage": "https://manage.oceanum.io",
        "datameshUi": "https://ui.datamesh.oceanum.io",
        "ai": "https://ai.oceanum.io",
    },
}


class OceanumLab(Configurable):
    """Deployment configuration for the Oceanum JupyterLab extensions."""

    sign_in = Enum(
        ["device", "off"],
        default_value="device",
        config=True,
        help="""How this JupyterLab signs in to Oceanum.io.

        "device" (the default) runs the OAuth device grant from this server: the user
        opens a link, confirms a code, and the server receives the tokens. It needs no
        callback URL, so it works on any host and port. A browser flow cannot: Auth0 has
        to know the page's address in advance, and a JupyterLab's is not knowable.

        "off" offers no sign-in.

        (notebook.oceanum.io is a JupyterLite site with no server, so none of this applies
        there; it signs in with the Oceanum widget from its own extension.)
        """,
    )

    device_environment = Dict(
        default_value=PRODUCTION,
        config=True,
        help="""The Oceanum deployment the device sign-in uses; Oceanum production by
        default. Replace it whole to sign in elsewhere: auth0Domain, clientId (an Auth0
        Native application with the Device Code grant), audience (may be empty),
        oceanumDomain, and urls.datamesh/specs/manage, with urls.datameshUi and urls.ai
        optional.
        """,
    )

    file_management = Enum(
        ["local", "oceanum"],
        default_value="local",
        config=True,
        help="""Whose file management this JupyterLab shows.

        "local" (the default) keeps JupyterLab's file browser and File menu, with
        Open/Save/Share on Oceanum alongside them.

        "oceanum" makes Oceanum.io the only file management, as on notebook.oceanum.io:
        the file browser and the File menu's local-file entries are hidden, and every
        save of a notebook (Ctrl+S, the toolbar, Save All, autosave) is also pushed to
        the Oceanum spec store. The local files remain underneath as working copies.
        Needs sign_in.
        """,
    )


def _configure_sign_in(server_app):
    """Publish this server's sign-in mode to the page; return the DeviceAuth, if any.

    Deliberately server configuration rather than a frontend setting. Which Auth0 tenant
    this notebook signs in to, and which Datamesh its kernels are handed credentials for,
    is the deployment's decision; a user-editable setting could be pointed at someone
    else's tenant and service URLs.
    """
    config = OceanumLab(config=server_app.config)
    page_config = server_app.web_app.settings.setdefault("page_config_data", {})

    if config.sign_in == "device":
        environment = config.device_environment
        if not environment.get("auth0Domain") or not environment.get("clientId"):
            server_app.log.warning(
                "oceanumlab: sign_in is 'device' but device_environment has no auth0Domain "
                "or clientId, so Oceanum.io sign-in is off."
            )
            return None
        # Everything but the Auth0 application details, which only this process uses.
        page_config[SERVER_AUTH_OPTION] = json.dumps(
            {
                "auth0Domain": environment["auth0Domain"],
                "clientId": environment["clientId"],
                "oceanumDomain": environment.get("oceanumDomain", ""),
                "urls": environment.get("urls", {}),
                "fileManagement": config.file_management,
            }
        )
        server_app.log.info(
            f"oceanumlab: Oceanum.io sign-in by device code, against {environment['auth0Domain']}"
        )
        return DeviceAuth(
            domain=environment["auth0Domain"],
            client_id=environment["clientId"],
            audience=environment.get("audience", ""),
        )

    server_app.log.info("oceanumlab: Oceanum.io sign-in is off (sign_in = 'off').")
    return None


def _load_jupyter_server_extension(server_app):
    """Registers the API handler to receive HTTP requests from the frontend extension.
    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    url_path = "oceanum"
    setup_handlers(
        server_app.web_app, url_path, device_auth=_configure_sign_in(server_app)
    )
    server_app.log.info(f"Registered oceanumlab extension at URL path /{url_path}")


# For backward compatibility with the classical notebook
load_jupyter_server_extension = _load_jupyter_server_extension

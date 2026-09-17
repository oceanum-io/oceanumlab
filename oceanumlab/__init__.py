import os
import json
from pathlib import Path

from traitlets import Dict, List
from traitlets.config import Configurable

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


#: The page option the frontend reads its environments from. Must match
#: ENVIRONMENTS_OPTION in packages/auth-oceanum/src/config.ts.
ENVIRONMENTS_OPTION = "oceanumEnvironments"


class OceanumLab(Configurable):
    """Deployment configuration for the Oceanum JupyterLab extensions."""

    environments = List(
        Dict(),
        config=True,
        help="""The Oceanum deployments this JupyterLab may sign in to.

        Each entry needs hosts, auth0Domain, clientId, oceanumDomain and
        urls.datamesh/specs/manage; urls.datameshUi and urls.ai are optional. The
        frontend matches hosts against the page hostname exactly, so "localhost"
        does not match a page served from 127.0.0.1.

        With none configured there is no sign-in on offer and no account control
        appears, which is the expected state on an ordinary JupyterLab.

        Configure in jupyter_server_config.py, for example::

            c.OceanumLab.environments = [
                {
                    "hosts": ["localhost"],
                    "auth0Domain": "auth.oceanum.io",
                    "clientId": "...",
                    "oceanumDomain": "oceanum.io",
                    "urls": {
                        "datamesh": "https://datamesh.oceanum.io",
                        "specs": "https://specs.oceanum.io",
                        "manage": "https://manage.oceanum.io",
                    },
                }
            ]
        """,
    )


def _publish_environments(server_app):
    """Hand the configured environments to the frontend through the page config.

    Deliberately server configuration rather than a frontend setting. Which Auth0 tenant
    this notebook signs in to, and which Datamesh its kernels are handed credentials for,
    is the deployment's decision; a user-editable setting could be pointed at someone
    else's tenant and service URLs.
    """
    environments = OceanumLab(config=server_app.config).environments
    if not environments:
        return
    page_config = server_app.web_app.settings.setdefault("page_config_data", {})
    page_config[ENVIRONMENTS_OPTION] = json.dumps(environments)
    server_app.log.info(
        f"oceanumlab: published {len(environments)} Oceanum environment(s) to the frontend"
    )


def _load_jupyter_server_extension(server_app):
    """Registers the API handler to receive HTTP requests from the frontend extension.
    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    url_path = "oceanum"
    setup_handlers(server_app.web_app, url_path)
    _publish_environments(server_app)
    server_app.log.info(f"Registered oceanumlab extension at URL path /{url_path}")


# For backward compatibility with the classical notebook
load_jupyter_server_extension = _load_jupyter_server_extension

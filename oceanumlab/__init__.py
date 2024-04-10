import os
import json
from pathlib import Path

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


def _load_jupyter_server_extension(server_app):
    """Registers the API handler to receive HTTP requests from the frontend extension.
    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    url_path = "oceanum"
    setup_handlers(server_app.web_app, url_path)
    server_app.log.info(f"Registered oceanumlab extension at URL path /{url_path}")


# For backward compatibility with the classical notebook
load_jupyter_server_extension = _load_jupyter_server_extension

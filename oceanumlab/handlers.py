import os
import json
import tornado
from tornado import web

from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.utils import url_path_join, ensure_async


class EnvarsHandler(APIHandler):
    # The following decorator should be present on all verb methods (head, get, post,
    # patch, put, delete, options) to ensure only authorized user can request the
    # Jupyter server
    SUPPORTED_METHODS = ("GET",)

    @tornado.web.authenticated
    def get(self, envar):
        self.finish(json.dumps({envar: os.environ.get(envar, None)}))


def setup_handlers(web_app, url_path):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]

    # Prepend the base_url so that it works in a JupyterHub setting
    env_pattern = url_path_join(base_url, url_path, "env/(.*)")
    handlers = [(env_pattern, EnvarsHandler)]
    web_app.add_handlers(host_pattern, handlers)

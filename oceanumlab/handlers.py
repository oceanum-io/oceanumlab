import os
import json
import tornado
from tornado import web

from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.utils import url_path_join, ensure_async


class EnvarsHandler(APIHandler):
    SUPPORTED_METHODS = ("GET", "POST")

    @tornado.web.authenticated
    def get(self, envar):
        self.finish(json.dumps({envar: os.environ.get(envar, None)}))

    @tornado.web.authenticated
    def post(self, *args, **kwargs):
        body = json.loads(self.request.body)
        if body:
            try:
                for key in body:
                    os.environ[key] = body[key]
            except:
                self.send_error(400)
        self.finish("OK")


def setup_handlers(web_app, url_path):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]

    # Prepend the base_url so that it works in a JupyterHub setting
    env_pattern = url_path_join(base_url, url_path, "env/(.*)")
    handlers = [(env_pattern, EnvarsHandler)]
    web_app.add_handlers(host_pattern, handlers)
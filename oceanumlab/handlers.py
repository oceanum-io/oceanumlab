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


class DeviceAuthHandler(APIHandler):
    """Oceanum.io sign-in by the device grant (see auth.py), driven from the page.

    `action` is one of status, start, cancel, token, signout. Everything is behind the
    server's own authentication, like every other API handler: the access token this hands
    out is the user's Oceanum credential.
    """

    SUPPORTED_METHODS = ("GET", "POST")

    @property
    def device_auth(self):
        return self.settings["oceanum_device_auth"]

    @tornado.web.authenticated
    async def get(self, action):
        if action == "status":
            self.finish(json.dumps(self.device_auth.status()))
        elif action == "token":
            token = await self.device_auth.access_token()
            self.finish(json.dumps({"accessToken": token, **self.device_auth.status()}))
        else:
            self.send_error(404)

    @tornado.web.authenticated
    async def post(self, action):
        if action == "start":
            self.finish(json.dumps(await self.device_auth.start()))
        elif action == "cancel":
            self.device_auth.cancel()
            self.finish(json.dumps(self.device_auth.status()))
        elif action == "signout":
            await self.device_auth.sign_out()
            self.finish(json.dumps(self.device_auth.status()))
        else:
            self.send_error(404)


def setup_handlers(web_app, url_path, device_auth=None):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]

    # Prepend the base_url so that it works in a JupyterHub setting
    env_pattern = url_path_join(base_url, url_path, "env/(.*)")
    handlers = [(env_pattern, EnvarsHandler)]
    if device_auth is not None:
        web_app.settings["oceanum_device_auth"] = device_auth
        handlers.append(
            (url_path_join(base_url, url_path, "auth/(.*)"), DeviceAuthHandler)
        )
    web_app.add_handlers(host_pattern, handlers)
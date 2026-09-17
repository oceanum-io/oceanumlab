import json

from oceanumlab import ENVIRONMENTS_OPTION, _publish_environments


class _FakeLog:
    def __init__(self):
        self.messages = []

    def info(self, message, *args, **kwargs):
        self.messages.append(message)


class _FakeWebApp:
    def __init__(self):
        self.settings = {}


class _FakeServerApp:
    """Only the parts _publish_environments touches."""

    def __init__(self, config):
        self.config = config
        self.web_app = _FakeWebApp()
        self.log = _FakeLog()


ENVIRONMENT = {
    "hosts": ["localhost"],
    "auth0Domain": "auth.oceanum.io",
    "clientId": "a-client",
    "oceanumDomain": "oceanum.io",
    "urls": {
        "datamesh": "https://datamesh.oceanum.io",
        "specs": "https://specs.oceanum.io",
        "manage": "https://manage.oceanum.io",
    },
}


def test_page_option_name_matches_the_frontend():
    # The frontend reads this literal (ENVIRONMENTS_OPTION in
    # packages/auth-oceanum/src/config.ts, pinned by its own test). Renaming either side
    # alone would silently stop every deployment's environments reaching the page, so both
    # sides pin the string and a rename fails here.
    assert ENVIRONMENTS_OPTION == "oceanumEnvironments"


def test_publishes_configured_environments_to_the_page():
    # The frontend reads this page option; it is deployment configuration rather than a
    # frontend setting, so that a user cannot point sign-in at another Auth0 tenant.
    from traitlets.config import Config

    app = _FakeServerApp(Config({"OceanumLab": {"environments": [ENVIRONMENT]}}))

    _publish_environments(app)

    published = app.web_app.settings["page_config_data"][ENVIRONMENTS_OPTION]
    assert json.loads(published) == [ENVIRONMENT]


def test_publishes_nothing_when_none_are_configured():
    # An ordinary JupyterLab. The option must be absent rather than an empty array, so the
    # frontend sees no environments and offers no sign-in at all.
    from traitlets.config import Config

    app = _FakeServerApp(Config())

    _publish_environments(app)

    assert ENVIRONMENTS_OPTION not in app.web_app.settings.get("page_config_data", {})
    # And it says so. Silence here is indistinguishable from the extension not being
    # installed, and a config file that failed to parse also arrives here.
    assert any("no Oceanum environments configured" in m for m in app.log.messages)


def test_keeps_page_config_another_extension_already_set():
    from traitlets.config import Config

    app = _FakeServerApp(Config({"OceanumLab": {"environments": [ENVIRONMENT]}}))
    app.web_app.settings["page_config_data"] = {"somethingElse": "keep me"}

    _publish_environments(app)

    page_config = app.web_app.settings["page_config_data"]
    assert page_config["somethingElse"] == "keep me"
    assert ENVIRONMENTS_OPTION in page_config

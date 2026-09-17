"""The device sign-in (oceanumlab/auth.py), against a scripted Auth0.

Each test runs its own event loop with asyncio.run rather than relying on a pytest asyncio
plugin's mode, so the file behaves the same whichever plugin the environment has.
"""

import asyncio
import base64
import json
import time

from traitlets.config import Config

from oceanumlab import SERVER_AUTH_OPTION, _configure_sign_in
from oceanumlab.auth import DeviceAuth, claims_of


def _id_token(claims):
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"header.{body}.signature"


CLAIMS = {"sub": "auth0|abc", "email": "ada@example.org", "name": "Ada"}

DEVICE_CODE = {
    "device_code": "SECRET-DEVICE-CODE",
    "user_code": "WXYZ-1234",
    "verification_uri": "https://auth.example/activate",
    "verification_uri_complete": "https://auth.example/activate?user_code=WXYZ-1234",
    "expires_in": 900,
    "interval": 5,
}


def _tokens(access="access-1", refresh="refresh-1", expires_in=3600):
    body = {
        "access_token": access,
        "expires_in": expires_in,
        "id_token": _id_token(CLAIMS),
    }
    if refresh:
        body["refresh_token"] = refresh
    return body


class Auth0:
    """Answers each POST from a script, and records what it was sent."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []
        self.sleeps = []

    async def post(self, url, form):
        self.requests.append((url.rsplit("/", 1)[-1], dict(form)))
        return self.responses.pop(0)

    async def sleep(self, seconds):
        self.sleeps.append(seconds)
        await asyncio.sleep(0)

    def auth(self):
        return DeviceAuth(
            domain="auth.example", client_id="client", post=self.post, sleep=self.sleep
        )


async def _settle(auth):
    """Let the polling task run to its end."""
    for _ in range(50):
        if auth.status()["state"] != "pending":
            return
        await asyncio.sleep(0)


def test_start_shows_the_user_code_but_never_the_device_code():
    async def run():
        auth0 = Auth0((200, DEVICE_CODE), (403, {"error": "authorization_pending"}))
        auth = auth0.auth()
        status = await auth.start()
        auth.cancel()
        return status

    status = asyncio.run(run())
    assert status["state"] == "pending"
    assert status["pending"]["userCode"] == "WXYZ-1234"
    assert status["pending"]["verificationUriComplete"].endswith("WXYZ-1234")
    # The device code is the secret half of the grant: whoever holds it collects the tokens.
    assert "SECRET-DEVICE-CODE" not in json.dumps(status)


def test_polls_through_pending_and_signs_in():
    async def run():
        auth0 = Auth0(
            (200, DEVICE_CODE),
            (403, {"error": "authorization_pending"}),
            (403, {"error": "authorization_pending"}),
            (200, _tokens()),
        )
        auth = auth0.auth()
        await auth.start()
        await _settle(auth)
        return auth0, auth.status(), await auth.access_token()

    auth0, status, token = asyncio.run(run())
    assert status["state"] == "signedIn"
    assert status["claims"]["email"] == "ada@example.org"
    assert status["pending"] is None
    assert token == "access-1"
    polls = [form for name, form in auth0.requests if name == "token"]
    assert len(polls) == 3
    assert polls[0]["device_code"] == "SECRET-DEVICE-CODE"


def test_slow_down_lengthens_the_polling_interval():
    async def run():
        auth0 = Auth0(
            (200, DEVICE_CODE), (429, {"error": "slow_down"}), (200, _tokens())
        )
        auth = auth0.auth()
        await auth.start()
        await _settle(auth)
        return auth0

    auth0 = asyncio.run(run())
    assert auth0.sleeps == [5, 10]


def test_a_refused_sign_in_ends_signed_out_with_the_reason():
    async def run():
        auth0 = Auth0(
            (200, DEVICE_CODE),
            (403, {"error": "access_denied", "error_description": "User cancelled"}),
        )
        auth = auth0.auth()
        await auth.start()
        await _settle(auth)
        return auth.status()

    status = asyncio.run(run())
    assert status["state"] == "signedOut"
    assert status["error"] == "User cancelled"


def test_a_second_start_reuses_the_code_already_waiting():
    # A double click, or a second tab. A fresh request would supersede the code the user is
    # already looking at.
    async def run():
        auth0 = Auth0((200, DEVICE_CODE), (403, {"error": "authorization_pending"}))
        auth = auth0.auth()
        first = await auth.start()
        second = await auth.start()
        auth.cancel()
        return auth0, first, second

    auth0, first, second = asyncio.run(run())
    assert [name for name, _ in auth0.requests].count("code") == 1
    assert first["pending"]["userCode"] == second["pending"]["userCode"]


def test_a_failed_code_request_reports_why():
    async def run():
        auth0 = Auth0(
            (403, {"error": "unauthorized_client", "error_description": "No grant"})
        )
        auth = auth0.auth()
        return await auth.start()

    status = asyncio.run(run())
    assert status["state"] == "signedOut"
    assert status["error"] == "No grant"


def _signed_in(auth0, **tokens):
    """A DeviceAuth that has already completed a sign-in."""
    auth = auth0.auth()
    auth._accept(_tokens(**tokens), previous_refresh=None)
    return auth


def test_refreshes_a_token_that_is_about_to_lapse_and_keeps_a_rotated_refresh_token():
    async def run():
        auth0 = Auth0(
            (200, _tokens(access="access-2", refresh="refresh-2", expires_in=30)),
            (200, _tokens(access="access-3", refresh=None)),
        )
        auth = _signed_in(auth0, expires_in=30)
        first = await auth.access_token()
        second = await auth.access_token()
        return auth0, first, second

    auth0, first, second = asyncio.run(run())
    assert (first, second) == ("access-2", "access-3")
    sent = [form["refresh_token"] for _, form in auth0.requests]
    # The rotated token is the one used next; with none sent back, the last one still is.
    assert sent == ["refresh-1", "refresh-2"]


def test_a_live_token_is_served_without_asking_auth0():
    async def run():
        auth0 = Auth0()
        auth = _signed_in(auth0)
        return auth0, await auth.access_token()

    auth0, token = asyncio.run(run())
    assert token == "access-1"
    assert auth0.requests == []


def test_a_revoked_refresh_token_ends_the_session():
    async def run():
        auth0 = Auth0((403, {"error": "invalid_grant"}))
        auth = _signed_in(auth0, expires_in=30)
        return await auth.access_token(), auth.status()

    token, status = asyncio.run(run())
    assert token is None
    assert status["state"] == "signedOut"
    assert "ended" in status["error"]


def test_a_transient_refresh_failure_keeps_the_session():
    async def run():
        auth0 = Auth0((503, {}))
        auth = _signed_in(auth0, expires_in=30)
        return await auth.access_token(), auth.status()

    token, status = asyncio.run(run())
    # Still inside its lifetime, so still usable; and one bad gateway is not a sign-out.
    assert token == "access-1"
    assert status["state"] == "signedIn"


def test_sign_out_revokes_the_refresh_token_and_clears_everything():
    async def run():
        auth0 = Auth0((200, {}))
        auth = _signed_in(auth0)
        await auth.sign_out()
        return auth0, auth.status(), await auth.access_token()

    auth0, status, token = asyncio.run(run())
    assert auth0.requests == [("revoke", {"client_id": "client", "token": "refresh-1"})]
    assert status["state"] == "signedOut"
    assert token is None


def test_claims_of_reads_an_id_token_and_shrugs_at_nonsense():
    assert claims_of(_id_token(CLAIMS))["email"] == "ada@example.org"
    assert claims_of(None) is None
    assert claims_of("not-a-jwt") is None
    assert claims_of("a.%%%.c") is None


# --- what the server tells the page ---------------------------------------------------


class _FakeLog:
    def __init__(self):
        self.messages = []

    def info(self, message, *args, **kwargs):
        self.messages.append(message)

    warning = info


class _FakeWebApp:
    def __init__(self):
        self.settings = {}


class _FakeServerApp:
    def __init__(self, config):
        self.config = config
        self.web_app = _FakeWebApp()
        self.log = _FakeLog()


def test_page_option_name_matches_the_frontend():
    # The frontend reads this literal (SERVER_AUTH_OPTION in src/auth/serverAuth.ts, pinned
    # by its own test). Renaming either side alone would silently turn sign-in off.
    assert SERVER_AUTH_OPTION == "oceanumServerAuth"


def test_device_sign_in_is_the_default_and_publishes_production():
    app = _FakeServerApp(Config())
    device_auth = _configure_sign_in(app)

    assert isinstance(device_auth, DeviceAuth)
    assert device_auth.domain == "auth.oceanum.io"
    published = json.loads(app.web_app.settings["page_config_data"][SERVER_AUTH_OPTION])
    assert published["urls"]["specs"] == "https://specs.oceanum.io"
    assert published["oceanumDomain"] == "oceanum.io"


def test_sign_in_off_publishes_nothing():
    app = _FakeServerApp(Config({"OceanumLab": {"sign_in": "off"}}))

    assert _configure_sign_in(app) is None
    assert SERVER_AUTH_OPTION not in app.web_app.settings.get("page_config_data", {})


def test_another_deployment_replaces_production_whole():
    dev = {
        "auth0Domain": "dev.auth.example",
        "clientId": "dev-client",
        "audience": "https://api.example",
        "oceanumDomain": "oceanum.tech",
        "urls": {
            "datamesh": "https://datamesh.oceanum.tech",
            "specs": "https://specs.oceanum.tech",
            "manage": "https://manage.oceanum.tech",
        },
    }
    app = _FakeServerApp(Config({"OceanumLab": {"device_environment": dev}}))
    device_auth = _configure_sign_in(app)

    assert (device_auth.domain, device_auth.client_id) == (
        "dev.auth.example",
        "dev-client",
    )
    assert device_auth.audience == "https://api.example"
    published = json.loads(app.web_app.settings["page_config_data"][SERVER_AUTH_OPTION])
    assert published["urls"]["datamesh"] == "https://datamesh.oceanum.tech"


def test_expired_codes_stop_being_reported_as_pending():
    async def run():
        auth0 = Auth0((200, {**DEVICE_CODE, "expires_in": 0}))
        auth = auth0.auth()
        await auth.start()
        return auth.status()

    assert asyncio.run(run())["state"] == "signedOut"
    assert time.time() > 0  # keeps the import honest if the body above changes

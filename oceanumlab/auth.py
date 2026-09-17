"""Oceanum.io sign-in for a server-backed JupyterLab.

The OAuth 2.0 Device Authorization Grant (RFC 8628), run by the Jupyter server rather
than the page. The browser flows (popup, redirect, silent iframe) all need the page's own
origin registered with Auth0, and a JupyterLab has no stable one: the port moves when 8888
is taken, and a JupyterHub or a remote server can be any host. Auth0 cannot wildcard a
port or an arbitrary host, so those flows answer "Callback URL mismatch" everywhere but
Oceanum's own sites. The device grant has no callback at all.

Nothing here is written to disk. The device code and the refresh token stay in this
process's memory and never reach the page; the page is handed short-lived access tokens
only, which is what it held under the browser flows too. Restarting the server signs out.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode

from tornado.httpclient import AsyncHTTPClient, HTTPRequest

DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
SCOPE = "openid profile email offline_access"

#: Refresh when the access token has less than this long left.
REFRESH_MARGIN_SECONDS = 60

#: What one HTTP exchange with Auth0 returns: the status and the decoded JSON body.
Post = Callable[[str, dict[str, str]], Awaitable[tuple[int, dict[str, Any]]]]


async def _tornado_post(url: str, form: dict[str, str]) -> tuple[int, dict[str, Any]]:
    request = HTTPRequest(
        url,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=urlencode(form),
        request_timeout=20,
    )
    # Auth0 answers a pending poll with 403 and a JSON body; that is an answer, not a failure.
    response = await AsyncHTTPClient().fetch(request, raise_error=False)
    try:
        body = json.loads(response.body or b"{}")
    except ValueError:
        body = {}
    return response.code, body if isinstance(body, dict) else {}


def claims_of(id_token: str | None) -> dict[str, Any] | None:
    """The claims of an ID token received directly from Auth0's token endpoint.

    Decoded without verifying the signature, which OpenID Connect allows for exactly this
    case (Core 3.1.3.7): the token came straight from the issuer over TLS, not through the
    browser, so the TLS server check is what authenticates it.
    """
    if not id_token:
        return None
    try:
        payload = id_token.split(".")[1]
        decoded = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        claims = json.loads(decoded)
    except (IndexError, ValueError):
        return None
    return claims if isinstance(claims, dict) else None


@dataclass
class _Pending:
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_at: float
    task: asyncio.Future | None = None

    def public(self) -> dict[str, Any]:
        return {
            "userCode": self.user_code,
            "verificationUri": self.verification_uri,
            "verificationUriComplete": self.verification_uri_complete,
            "expiresIn": max(0, int(self.expires_at - time.time())),
        }


@dataclass
class _Session:
    access_token: str
    expires_at: float
    refresh_token: str | None
    claims: dict[str, Any] | None


@dataclass
class DeviceAuth:
    """One Oceanum.io session for this Jupyter server, which serves one user."""

    domain: str
    client_id: str
    audience: str = ""
    post: Post = _tornado_post
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep

    _pending: _Pending | None = field(default=None, init=False)
    _session: _Session | None = field(default=None, init=False)
    _error: str | None = field(default=None, init=False)
    _refreshing: asyncio.Lock = field(default_factory=asyncio.Lock, init=False)

    def _url(self, path: str) -> str:
        return f"https://{self.domain}{path}"

    # --- state the page may see -------------------------------------------------------

    def status(self) -> dict[str, Any]:
        if self._pending and self._pending.expires_at <= time.time():
            self._pending = None
        state = (
            "signedIn" if self._session else "pending" if self._pending else "signedOut"
        )
        return {
            "state": state,
            "claims": self._session.claims if self._session else None,
            "pending": self._pending.public() if self._pending else None,
            "error": self._error,
        }

    # --- signing in -------------------------------------------------------------------

    async def start(self) -> dict[str, Any]:
        """Begin a sign-in, or hand back the one already waiting on the user.

        Reusing a live code matters: a double click, or a second browser tab, would
        otherwise leave the user holding a code that the newer request had superseded.
        """
        if self._session:
            return self.status()
        if self._pending and self._pending.expires_at > time.time():
            return self.status()

        form = {"client_id": self.client_id, "scope": SCOPE}
        if self.audience:
            form["audience"] = self.audience
        code, body = await self.post(self._url("/oauth/device/code"), form)
        if code != 200 or "device_code" not in body:
            self._error = str(
                body.get("error_description") or body.get("error") or f"HTTP {code}"
            )
            return self.status()

        self._error = None
        self._pending = _Pending(
            user_code=str(body["user_code"]),
            verification_uri=str(body["verification_uri"]),
            verification_uri_complete=str(
                body.get("verification_uri_complete") or body["verification_uri"]
            ),
            expires_at=time.time() + float(body.get("expires_in", 900)),
        )
        self._pending.task = asyncio.ensure_future(
            self._poll(
                self._pending,
                str(body["device_code"]),
                float(body.get("interval", 5)),
            )
        )
        return self.status()

    async def _poll(self, pending: _Pending, device_code: str, interval: float) -> None:
        form = {
            "grant_type": DEVICE_GRANT,
            "device_code": device_code,
            "client_id": self.client_id,
        }
        while self._pending is pending and pending.expires_at > time.time():
            await self.sleep(interval)
            if self._pending is not pending:  # cancelled, or superseded
                return
            code, body = await self.post(self._url("/oauth/token"), form)
            if code == 200 and "access_token" in body:
                self._pending = None
                self._accept(body, previous_refresh=None)
                return
            error = body.get("error")
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                interval += 5
                continue
            # expired_token, access_denied, or something unexpected: all end the attempt.
            self._pending = None
            self._error = str(body.get("error_description") or error or f"HTTP {code}")
            return
        if self._pending is pending:
            self._pending = None
            self._error = "The sign-in code expired before it was used."

    def cancel(self) -> None:
        pending, self._pending = self._pending, None
        if pending and pending.task:
            pending.task.cancel()

    def _accept(self, body: dict[str, Any], previous_refresh: str | None) -> None:
        self._session = _Session(
            access_token=str(body["access_token"]),
            expires_at=time.time() + float(body.get("expires_in", 0)),
            # Auth0 rotates refresh tokens when the application is set to; when it does
            # not send a new one, the old one is still the one to use.
            refresh_token=body.get("refresh_token") or previous_refresh,
            claims=claims_of(body.get("id_token"))
            or (self._session.claims if self._session else None),
        )
        self._error = None

    # --- using the session ------------------------------------------------------------

    async def access_token(self) -> str | None:
        """A current access token, refreshed if it is about to lapse, or None."""
        async with self._refreshing:
            session = self._session
            if session is None:
                return None
            if session.expires_at - time.time() > REFRESH_MARGIN_SECONDS:
                return session.access_token
            if not session.refresh_token:
                self._session = None
                return None
            code, body = await self.post(
                self._url("/oauth/token"),
                {
                    "grant_type": "refresh_token",
                    "client_id": self.client_id,
                    "refresh_token": session.refresh_token,
                },
            )
            if code == 200 and "access_token" in body:
                self._accept(body, previous_refresh=session.refresh_token)
                return self._session.access_token if self._session else None
            if body.get("error") == "invalid_grant":
                # The refresh token was revoked or has expired: the session is over.
                self._session = None
                self._error = "Your Oceanum.io session has ended."
                return None
            # Anything else is treated as transient: keep the session, and let the caller
            # have the token while it is still inside its lifetime.
            return session.access_token if session.expires_at > time.time() else None

    async def sign_out(self) -> None:
        self.cancel()
        session, self._session = self._session, None
        self._error = None
        if session and session.refresh_token:
            try:
                await self.post(
                    self._url("/oauth/revoke"),
                    {"client_id": self.client_id, "token": session.refresh_token},
                )
            except Exception:  # noqa: BLE001 - signing out must not fail on the network
                pass

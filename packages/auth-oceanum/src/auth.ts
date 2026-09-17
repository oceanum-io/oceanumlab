import { PromiseDelegate } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import type { ISignInRedirect } from './signInRedirect';

import {
  ColorScheme,
  IOceanumAuth,
  IOceanumEnvironment,
  IOceanumServiceUrls,
  IOceanumUser
} from './tokens';

const CLAIM = 'https://oceanum.io/';
const COLOR_SCHEMES: readonly ColorScheme[] = ['light', 'dark', 'auto'];

/** Build the user from Auth0 ID token claims; `null` if the claims lack an identity. */
export function userFromClaims(
  claims: Record<string, unknown>
): IOceanumUser | null {
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  const sub = str(claims.sub);
  const email = str(claims.email) ?? str(claims[`${CLAIM}email`]);
  if (!sub || !email) {
    return null;
  }
  const scheme = claims[`${CLAIM}color_scheme`];
  return {
    sub,
    email,
    name: str(claims.name),
    activeOrg: str(claims[`${CLAIM}active_org`]),
    colorScheme: COLOR_SCHEMES.includes(scheme as ColorScheme)
      ? (scheme as ColorScheme)
      : null
  };
}

/** Auth0 error codes meaning the session is over, as opposed to a transient failure. */
const SESSION_ENDED_ERRORS = new Set([
  'login_required',
  'consent_required',
  'interaction_required',
  'missing_refresh_token',
  'invalid_grant'
]);

export function isSessionEndedError(reason: unknown): boolean {
  const code = (reason as { error?: unknown } | null)?.error;
  return typeof code === 'string' && SESSION_ENDED_ERRORS.has(code);
}

/** The Oceanum nav's login status (`useOceanumNav().loginStatus`). */
export const LoginStatus = {
  SignedOut: -1,
  /** Restoring the session, or refreshing an established one. */
  Loading: 0,
  SignedIn: 1
} as const;

/** What the Oceanum nav reports about the session (see nav.tsx). */
export interface INavState {
  readonly loginStatus: number;
  /** The Auth0 user, i.e. the ID token claims, or `null`. */
  readonly claims: Record<string, unknown> | null;
  /** The session access token, if any. */
  readonly accessToken: string | undefined;
}

/** The Oceanum nav's actions, available once it has mounted (see nav.tsx). */
export interface INavControls {
  /** Start sign-in: a popup, so the page and its kernels survive. */
  signIn(): void;
  /** Sign out; the nav navigates to its logout URL. */
  signOut(): void;
  /** A session token from the Auth0 cache, refreshed near expiry; rejects when it cannot. */
  getAccessToken(): Promise<string>;
}

export interface INavAuthOptions {
  environment: IOceanumEnvironment | null;
  /** Called when the session ends without the user signing out. */
  onSessionExpired?: () => void;
  /** How often to check whether the access token needs refreshing. */
  refreshIntervalMs?: number;
  /** How long `ready` waits for the check for an existing session on arrival. */
  sessionCheckTimeoutMs?: number;
  /** Checks with a full-page redirect when the iframe check finds no session (see there). */
  signInRedirect?: ISignInRedirect | null;
}

/**
 * Oceanum.io sign-in backed by the Oceanum nav (@oceanum/oceanum-io-nav), which owns the Auth0
 * session. The nav's React tree reports its state through `update()` and hands over its actions
 * through `attach()`; everything else in the notebook sees only `IOceanumAuth`.
 */
export class NavAuth implements IOceanumAuth {
  constructor(options: INavAuthOptions) {
    this.environment = options.environment;
    this._onSessionExpired = options.onSessionExpired;
    // Auth0's cache hands out a new access token once the old one is within 60 s of expiry;
    // checking every 15 s gets it to the kernel with at least 45 s to spare. A check that
    // finds the cached token still fresh makes no network request.
    this._refreshIntervalMs = options.refreshIntervalMs ?? 15_000;
    this._sessionCheckTimeoutMs = options.sessionCheckTimeoutMs ?? 10_000;
    this._signInRedirect = options.signInRedirect ?? null;
    if (!this.environment) {
      this._ready.resolve();
    }
  }

  readonly environment: IOceanumEnvironment | null;

  get urls(): IOceanumServiceUrls | null {
    return this.environment?.urls ?? null;
  }

  get ready(): Promise<void> {
    return this._ready.promise;
  }

  get user(): IOceanumUser | null {
    return this._user;
  }

  get userChanged(): ISignal<IOceanumAuth, IOceanumUser | null> {
    return this._userChanged;
  }

  get tokenChanged(): ISignal<IOceanumAuth, string | null> {
    return this._tokenChanged;
  }

  /** The nav's state changed. */
  update(state: INavState): void {
    if (!this.environment || this._isDisposed) {
      return;
    }
    if (state.loginStatus !== LoginStatus.Loading) {
      this._navState = state;
    }
    if (state.loginStatus === LoginStatus.Loading) {
      // The nav reports Loading both while restoring a session and during its own token
      // refresh. Neither changes an established session, so keep the current state.
      return;
    }
    if (state.loginStatus === LoginStatus.SignedIn) {
      const user = state.claims ? userFromClaims(state.claims) : null;
      if (user && state.accessToken) {
        if (this._signedOut) {
          // The nav still holds the session a moment after sign-out; don't bring it back.
          return;
        }
        this._sessionChecked = true;
        this._signInRedirect?.settled(true);
        this._setState(user, state.accessToken);
        this._startRefresh();
        this._ready.resolve();
        return;
      }
    }
    this._end();
    this._checkForSession();
  }

  /** The nav's actions became available (or went away, with `null`). */
  attach(controls: INavControls | null): void {
    this._controls = controls;
  }

  async signIn(): Promise<void> {
    if (!this.environment) {
      throw new Error('Oceanum.io sign-in is not available on this site');
    }
    if (!this._controls) {
      throw new Error('Oceanum.io sign-in is not ready yet');
    }
    if (this._user !== null) {
      // The nav opens no popup for a session it still holds; it would keep the request and
      // open one, with no click behind it, the next time the session drops.
      return;
    }
    this._signedOut = false;
    if (this._navState?.loginStatus === LoginStatus.SignedIn) {
      // A sign-out that never left the page (e.g. the unsaved-changes prompt was cancelled):
      // the nav still shows the session and would open no popup, so take its state back and
      // let a refresh confirm the session is still good.
      this.update(this._navState);
      await this.refresh();
      return;
    }
    this._controls.signIn();
  }

  async signOut(): Promise<void> {
    if (!this.environment) {
      return;
    }
    this._signedOut = true;
    this._stopRefresh();
    // A refresh already in flight must not restore the session it started from.
    this._generation += 1;
    // Clear the token first, so kernels lose DATAMESH_TOKEN before the nav navigates away.
    this._setState(null, null);
    this._controls?.signOut();
  }

  async getAccessToken(): Promise<string | null> {
    if (!this._user) {
      return null;
    }
    await this.refresh();
    return this._token;
  }

  /** Check the session now, e.g. when the page becomes visible again. */
  async refresh(): Promise<void> {
    const controls = this._controls;
    if (!controls || !this._user) {
      return;
    }
    const generation = this._generation;
    let token: string;
    try {
      token = await controls.getAccessToken();
    } catch (reason) {
      if (generation !== this._generation) {
        return;
      }
      if (isSessionEndedError(reason)) {
        this._end();
      } else {
        // A network hiccup or timeout: keep the current state and try again next time.
        console.warn('Oceanum.io session could not be refreshed', reason);
      }
      return;
    }
    if (generation !== this._generation || !this._user) {
      return;
    }
    this._setState(this._user, token);
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._stopRefresh();
    this._controls = null;
    Signal.clearData(this);
  }

  /**
   * The nav settled signed out. Once per page, before `ready` resolves, ask Auth0 whether the
   * user is signed in to Oceanum.io already.
   *
   * The Auth0 SDK only checks on load if this site has signed in before (its
   * `auth0.<clientId>.is.authenticated` cookie). So a user signed in through another Oceanum.io
   * app would arrive signed out. A silent token request does ask, in a hidden iframe, with no
   * popup and no page reload. If there is a session, the nav reports it through `update()`; if
   * not, the user stays signed out.
   *
   * `ready` waits for the answer, up to a limit, so nothing offers sign-in to a user about to be
   * signed in. The iframe only works where the browser sends Auth0's cookie to it: always when
   * Auth0 is on the same site (auth.oceanum.io for notebook.oceanum.io), and otherwise only if
   * third-party cookies are allowed.
   */
  private _checkForSession(): void {
    const controls = this._controls;
    if (this._sessionChecked || this._signedOut || controls === null) {
      this._ready.resolve();
      return;
    }
    this._sessionChecked = true;
    const timer = setTimeout(
      () => this._ready.resolve(),
      this._sessionCheckTimeoutMs
    );
    // A session is reported by the nav through update(). A rejection (login_required) means
    // the iframe saw none: where configured, ask again with a full-page redirect, which leaves
    // the page. Otherwise stay signed out.
    void controls
      .getAccessToken()
      .then(
        () => undefined,
        async () => {
          const redirect = this._signInRedirect;
          if (this._user !== null || this._signedOut || !redirect) {
            return;
          }
          if (redirect.shouldTry()) {
            await redirect.start();
          } else {
            redirect.settled(false);
          }
        }
      )
      .finally(() => {
        clearTimeout(timer);
        this._ready.resolve();
      });
  }

  /** The session is gone: clear it, and say so unless the user signed out. */
  private _end(): void {
    const expired = this._user !== null && !this._signedOut;
    this._generation += 1;
    this._stopRefresh();
    this._setState(null, null);
    if (expired) {
      this._onSessionExpired?.();
    }
  }

  private _setState(user: IOceanumUser | null, token: string | null): void {
    const userChanged = JSON.stringify(user) !== JSON.stringify(this._user);
    const tokenChanged = token !== this._token;
    this._user = user;
    this._token = token;
    if (userChanged) {
      this._userChanged.emit(user);
    }
    if (tokenChanged) {
      this._tokenChanged.emit(token);
    }
  }

  private _startRefresh(): void {
    if (this._timer === null) {
      this._timer = setInterval(
        () => void this.refresh(),
        this._refreshIntervalMs
      );
    }
  }

  private _stopRefresh(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private _controls: INavControls | null = null;
  /** The nav's last settled (not Loading) state. */
  private _navState: INavState | null = null;
  private _onSessionExpired: (() => void) | undefined;
  private _refreshIntervalMs: number;
  private _sessionCheckTimeoutMs: number;
  private _signInRedirect: ISignInRedirect | null;
  /** Whether this page has checked for an existing session (or had one). */
  private _sessionChecked = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _user: IOceanumUser | null = null;
  private _token: string | null = null;
  private _generation = 0;
  private _signedOut = false;
  private _isDisposed = false;
  private _ready = new PromiseDelegate<void>();
  private _userChanged = new Signal<IOceanumAuth, IOceanumUser | null>(this);
  private _tokenChanged = new Signal<IOceanumAuth, string | null>(this);
}

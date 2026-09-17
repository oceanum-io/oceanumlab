import { PromiseDelegate } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import {
  ColorScheme,
  IOceanumAuth,
  IOceanumEnvironment,
  IOceanumServiceUrls,
  IOceanumUser
} from './tokens';

/** The subset of `@auth0/auth0-spa-js`'s `Auth0Client` this extension uses. */
export interface IAuth0Client {
  loginWithRedirect(options: {
    authorizationParams: { redirect_uri: string };
    appState: IAppState;
  }): Promise<void>;
  handleRedirectCallback(url: string): Promise<{ appState?: IAppState }>;
  checkSession(): Promise<void>;
  isAuthenticated(): Promise<boolean>;
  getTokenSilently(): Promise<string | undefined>;
  getIdTokenClaims(): Promise<Record<string, unknown> | undefined>;
  logout(options: { logoutParams: { returnTo: string } }): Promise<void>;
}

/** Carried through the Auth0 redirect. */
export interface IAppState {
  returnTo?: string;
}

/** Page URL access, injectable for tests. */
export interface IBrowserLocation {
  href(): string;
  /** Replace the address bar URL without reloading. */
  replace(url: string): void;
}

const CLAIM = 'https://oceanum.io/';
const REDIRECT_PARAMS = ['code', 'state', 'error', 'error_description'];
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

/** An app directory, so `/lab/` and `/lab/index.html` compare equal. */
function appPath(url: URL): string {
  return url.pathname.replace(/index\.html$/, '');
}

export interface IOceanumAuthOptions {
  environment: IOceanumEnvironment | null;
  /** `null` when `environment` is `null`. */
  client: IAuth0Client | null;
  /** Where Auth0 returns after login and logout; must be registered with Auth0. */
  redirectUri: string;
  location: IBrowserLocation;
  /** Called when a refresh finds the session has ended without the user signing out. */
  onSessionExpired?: () => void;
  /** How often to check whether the access token needs refreshing. */
  refreshIntervalMs?: number;
}

export class OceanumAuth implements IOceanumAuth {
  constructor(options: IOceanumAuthOptions) {
    this.environment = options.environment;
    this._client = options.environment ? options.client : null;
    this._redirectUri = options.redirectUri;
    this._location = options.location;
    this._onSessionExpired = options.onSessionExpired;
    // Auth0's cache hands out a new access token once the old one is within 60 s of expiry;
    // checking every 15 s gets it to the kernel with at least 45 s to spare. A check that
    // finds the cached token still fresh makes no network request.
    this._refreshIntervalMs = options.refreshIntervalMs ?? 15_000;
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

  /** Handle a login redirect or restore an existing session. Resolves `ready` when done. */
  async initialize(): Promise<void> {
    const client = this._client;
    try {
      if (client) {
        const url = new URL(this._location.href());
        if (
          url.searchParams.has('state') &&
          (url.searchParams.has('code') || url.searchParams.has('error'))
        ) {
          await this._handleRedirect(client, url);
        } else {
          // Annotated because this repo compiles with strictNullChecks off, where a
          // bare `() => undefined` infers an implicit any return and trips noImplicitAny.
          await client.checkSession().catch((): void => undefined);
        }
        await this._update(false);
      }
    } finally {
      this._ready.resolve();
    }
  }

  async signIn(): Promise<void> {
    if (!this._client) {
      throw new Error('Oceanum.io sign-in is not available on this site');
    }
    await this._client.loginWithRedirect({
      authorizationParams: { redirect_uri: this._redirectUri },
      appState: { returnTo: this._location.href() }
    });
  }

  async signOut(): Promise<void> {
    if (!this._client) {
      return;
    }
    this._stopRefresh();
    // A refresh already in flight must not restore the session it started from.
    this._signOuts += 1;
    this._setState(null, null);
    await this._client.logout({
      logoutParams: { returnTo: this._redirectUri }
    });
  }

  async getAccessToken(): Promise<string | null> {
    if (!this._client || !this._user) {
      return null;
    }
    await this._update(true);
    return this._token;
  }

  /** Check the session now, e.g. when the page becomes visible again. */
  refresh(): Promise<void> {
    return this._client && this._user ? this._update(true) : Promise.resolve();
  }

  dispose(): void {
    this._stopRefresh();
    Signal.clearData(this);
  }

  private async _handleRedirect(client: IAuth0Client, url: URL): Promise<void> {
    let returnTo: string | undefined;
    try {
      if (url.searchParams.has('error')) {
        throw new Error(
          url.searchParams.get('error_description') ??
            url.searchParams.get('error')!
        );
      }
      const result = await client.handleRedirectCallback(url.href);
      returnTo = result.appState?.returnTo;
    } catch (reason) {
      console.error('Oceanum.io sign-in failed', reason);
    }
    // Drop the one-time code from the address bar; restore where the user started when it is
    // the same app (the page cannot change apps without reloading, which loses the session).
    let next = new URL(url.href);
    if (returnTo) {
      const target = new URL(returnTo, url.href);
      if (target.origin === url.origin && appPath(target) === appPath(url)) {
        next = target;
      }
    }
    for (const param of REDIRECT_PARAMS) {
      next.searchParams.delete(param);
    }
    this._location.replace(next.href);
  }

  /**
   * Read the session from the Auth0 client. `wasSignedIn` distinguishes an expired session
   * from never having signed in.
   */
  private async _update(wasSignedIn: boolean): Promise<void> {
    const client = this._client!;
    const signOuts = this._signOuts;
    let user: IOceanumUser | null = null;
    let token: string | null = null;
    try {
      if (await client.isAuthenticated()) {
        token = (await client.getTokenSilently()) ?? null;
        const claims = await client.getIdTokenClaims();
        user = claims ? userFromClaims(claims) : null;
      }
    } catch (reason) {
      if (!isSessionEndedError(reason)) {
        // A network hiccup or timeout: keep the current state and try again next time.
        console.warn('Oceanum.io session could not be refreshed', reason);
        return;
      }
    }
    if (signOuts !== this._signOuts) {
      return;
    }
    if (!user || !token) {
      user = null;
      token = null;
    }
    const expired = wasSignedIn && this._user !== null && user === null;
    this._setState(user, token);
    if (user) {
      this._startRefresh();
    } else {
      this._stopRefresh();
      if (expired) {
        this._onSessionExpired?.();
      }
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
        (): void => void this._update(true),
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

  private _client: IAuth0Client | null;
  private _redirectUri: string;
  private _location: IBrowserLocation;
  private _onSessionExpired: (() => void) | undefined;
  private _refreshIntervalMs: number;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _user: IOceanumUser | null = null;
  private _token: string | null = null;
  private _signOuts = 0;
  private _ready = new PromiseDelegate<void>();
  private _userChanged = new Signal<IOceanumAuth, IOceanumUser | null>(this);
  private _tokenChanged = new Signal<IOceanumAuth, string | null>(this);
}

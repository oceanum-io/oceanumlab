/**
 * Oceanum.io sign-in on an ordinary JupyterLab, where the Jupyter server runs the OAuth
 * device grant (oceanumlab/auth.py) and this only reflects its state.
 *
 * A browser sign-in cannot work here. Popup, redirect and the silent iframe check all send
 * the page's own origin to Auth0 as the callback, Auth0 only accepts addresses registered in
 * advance, and it cannot wildcard a port or an arbitrary host -- so everywhere but Oceanum's
 * own sites the answer is "Callback URL mismatch". The device grant has no callback: the
 * user opens a link and confirms a code, and the server collects the tokens.
 *
 * The refresh token and the device code never reach this page. It is handed short-lived
 * access tokens only.
 */
import { PromiseDelegate } from '@lumino/coreutils';
import { IDisposable } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signaling';

import { userFromClaims } from './claims';
import {
  IOceanumAuth,
  IOceanumEnvironment,
  IOceanumServiceUrls,
  IOceanumUser
} from './tokens';

/**
 * The page option the server extension publishes when it runs the device sign-in. Must
 * match SERVER_AUTH_OPTION in oceanumlab/__init__.py.
 */
export const SERVER_AUTH_OPTION = 'oceanumServerAuth';

/** A sign-in waiting on the user: the code to confirm, and where to confirm it. */
export interface IPendingSignIn {
  readonly userCode: string;
  readonly verificationUri: string;
  /** The verification page with the code already filled in. */
  readonly verificationUriComplete: string;
  /** Seconds until the code lapses. */
  readonly expiresIn: number;
}

interface IServerStatus {
  state: 'signedOut' | 'pending' | 'signedIn';
  claims: Record<string, unknown> | null;
  pending: IPendingSignIn | null;
  error: string | null;
  accessToken?: string | null;
}

/** One exchange with the server extension's `/oceanum/auth/<action>` handler. */
export type AuthRequest = (
  action: 'status' | 'token' | 'start' | 'cancel' | 'signout',
  method: 'GET' | 'POST'
) => Promise<unknown>;

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href.replace(/\/+$/, '')
      : null;
  } catch {
    return null;
  }
}

/**
 * The Oceanum deployment the server signs in to, from the page option, or `null` when the
 * server offers no device sign-in (or the option is malformed, which is treated the same).
 */
export function readServerAuthOption(
  option: string | undefined,
  hostname: string
): IOceanumEnvironment | null {
  if (!option) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(option);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const config = raw as Record<string, unknown>;
  const urlsIn = (config.urls ?? {}) as Record<string, unknown>;
  const datamesh = httpUrl(urlsIn.datamesh);
  const specs = httpUrl(urlsIn.specs);
  const manage = httpUrl(urlsIn.manage);
  if (
    typeof config.auth0Domain !== 'string' ||
    typeof config.clientId !== 'string' ||
    !datamesh ||
    !specs ||
    !manage
  ) {
    return null;
  }
  const urls: IOceanumServiceUrls = {
    datamesh,
    specs,
    manage,
    ...(httpUrl(urlsIn.datameshUi)
      ? { datameshUi: httpUrl(urlsIn.datameshUi) as string }
      : {}),
    ...(httpUrl(urlsIn.ai) ? { ai: httpUrl(urlsIn.ai) as string } : {})
  };
  return {
    // The device grant is indifferent to where the page is served from, so this is simply
    // wherever that is, rather than a list to match against.
    hosts: [hostname.toLowerCase()],
    auth0Domain: config.auth0Domain,
    clientId: config.clientId,
    oceanumDomain:
      typeof config.oceanumDomain === 'string' ? config.oceanumDomain : '',
    signInRedirect: false,
    fileManagement: config.fileManagement === 'oceanum' ? 'oceanum' : 'local',
    urls
  };
}

export interface IServerAuthOptions {
  /** The deployment the server signs in to, or `null` when it offers no sign-in. */
  environment: IOceanumEnvironment | null;
  request: AuthRequest;
  /** Called when a session ends other than by `signOut()`. */
  onSessionEnded?: (message: string) => void;
  /** How often to ask the server whether a pending sign-in has completed. */
  pendingPollMs?: number;
  /** How often to pick up a refreshed access token while signed in. */
  tokenPollMs?: number;
}

export class ServerAuth implements IOceanumAuth, IDisposable {
  constructor(options: IServerAuthOptions) {
    this.environment = options.environment;
    this._request = options.request;
    this._onSessionEnded = options.onSessionEnded;
    this._pendingPollMs = options.pendingPollMs ?? 2000;
    this._tokenPollMs = options.tokenPollMs ?? 60000;
    if (!this.environment) {
      this._ready.resolve();
      return;
    }
    // A server that signed in before this page loaded (a reload, a second tab) is already
    // signed in; `ready` waits for that answer so nothing downstream sees a false sign-out.
    void this._sync('token').finally(() => this._ready.resolve());
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

  /** The sign-in waiting on the user, if any. */
  get pending(): IPendingSignIn | null {
    return this._pending;
  }

  /** Why the last sign-in attempt ended, if it failed. */
  get error(): string | null {
    return this._error;
  }

  /** Emits when `pending` or `error` changes. */
  get stateChanged(): ISignal<ServerAuth, void> {
    return this._stateChanged;
  }

  async signIn(): Promise<void> {
    if (!this.environment || this._user) {
      return;
    }
    await this._sync('start', 'POST');
  }

  /** Abandon a sign-in that is waiting on the user. */
  async cancelSignIn(): Promise<void> {
    if (this._pending) {
      await this._sync('cancel', 'POST');
    }
  }

  async signOut(): Promise<void> {
    this._signingOut = true;
    try {
      await this._sync('signout', 'POST');
    } finally {
      this._signingOut = false;
    }
  }

  async getAccessToken(): Promise<string | null> {
    if (!this.environment || !this._user) {
      return null;
    }
    await this._sync('token');
    return this._token;
  }

  /** Re-read the server's state, e.g. when the tab becomes visible again. */
  async refresh(): Promise<void> {
    if (this.environment) {
      await this._sync(this._user ? 'token' : 'status');
    }
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._clearTimer();
    Signal.clearData(this);
  }

  private async _sync(
    action: 'status' | 'token' | 'start' | 'cancel' | 'signout',
    method: 'GET' | 'POST' = 'GET'
  ): Promise<void> {
    let status: IServerStatus;
    try {
      status = (await this._request(action, method)) as IServerStatus;
    } catch (reason) {
      // The Jupyter server being briefly unreachable is not a sign-out: keep what we have
      // and let the next poll find out.
      console.warn(`Oceanum.io sign-in: ${action} failed`, reason);
      this._schedule();
      return;
    }
    if (this._disposed || !status || typeof status.state !== 'string') {
      return;
    }
    this._apply(status);
    if (status.state === 'signedIn' && action !== 'token') {
      // A sign-in that has just completed: fetch the token it produced.
      await this._sync('token');
    }
  }

  private _apply(status: IServerStatus): void {
    const user =
      status.state === 'signedIn' ? userFromClaims(status.claims) : null;
    const pending = status.state === 'pending' ? status.pending : null;
    const error = status.error ?? null;

    if (
      pending?.userCode !== this._pending?.userCode ||
      error !== this._error
    ) {
      this._pending = pending;
      this._error = error;
      this._stateChanged.emit();
    }

    const wasSignedIn = this._user !== null;
    if ((user?.sub ?? null) !== (this._user?.sub ?? null)) {
      this._user = user;
      this._userChanged.emit(user);
      if (wasSignedIn && !user && !this._signingOut) {
        this._onSessionEnded?.(
          error ?? 'Your Oceanum.io session has ended. Sign in again.'
        );
      }
    }

    const token = user ? (status.accessToken ?? this._token) : null;
    if (token !== this._token) {
      this._token = token;
      this._tokenChanged.emit(token);
    }
    this._schedule();
  }

  /** Poll quickly while a sign-in is pending, slowly while signed in, not at all otherwise. */
  private _schedule(): void {
    this._clearTimer();
    if (this._disposed) {
      return;
    }
    if (this._pending) {
      this._timer = setTimeout(
        () => void this._sync('status'),
        this._pendingPollMs
      );
    } else if (this._user) {
      this._timer = setTimeout(
        () => void this._sync('token'),
        this._tokenPollMs
      );
    }
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _request: AuthRequest;
  private _onSessionEnded: ((message: string) => void) | undefined;
  private _pendingPollMs: number;
  private _tokenPollMs: number;
  private _ready = new PromiseDelegate<void>();
  private _user: IOceanumUser | null = null;
  private _token: string | null = null;
  private _pending: IPendingSignIn | null = null;
  private _error: string | null = null;
  private _signingOut = false;
  private _disposed = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _userChanged = new Signal<IOceanumAuth, IOceanumUser | null>(this);
  private _tokenChanged = new Signal<IOceanumAuth, string | null>(this);
  private _stateChanged = new Signal<ServerAuth, void>(this);
}

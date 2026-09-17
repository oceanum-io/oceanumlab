/**
 * Checking for an existing Oceanum.io session with a full-page redirect.
 *
 * The notebook first asks Auth0 silently in a hidden iframe (NavAuth). Where the Auth0 tenant
 * is on another site than the notebook (the development tenant, oceanum-test.au.auth0.com, for
 * notebook.oceanum.tech), browsers that block third-party cookies hide the session from that
 * iframe, so a signed-in user arrives signed out. The other Oceanum.io apps redirect to Auth0,
 * where its cookie is first-party. This does the same, silently (prompt=none): with a session
 * Auth0 returns straight back with a code, and without one it returns login_required, and the
 * visitor stays anonymous.
 *
 * The Oceanum nav owns the Auth0 client and completes the sign-in: its bundled auth0-react
 * handles the returning code on load. It exposes no redirect, so the redirect starts from a
 * client of the same auth0-spa-js version (pinned in package.json), which stores its
 * transaction where the nav's client looks for it (sessionStorage `a0.spajs.txs.<clientId>`).
 * The site origin is the redirect URI: it is the allowed callback URL, and
 * scripts/brand-app.mjs forwards a returning code from the site root to the app.
 */
import type { Auth0Client, Auth0ClientOptions } from '@auth0/auth0-spa-js';

import { IOceanumEnvironment } from './tokens';

/** sessionStorage key: `pending` while a redirect is out, `no-session` once Auth0 had none. */
export const REDIRECT_STATE_KEY = 'oceanum-notebook:sign-in-redirect';

export interface ISignInRedirect {
  /** Whether to check with a redirect now: at most until Auth0 once reports no session. */
  shouldTry(): boolean;
  /** Leave the page for Auth0. Resolves only if the redirect could not start. */
  start(): Promise<void>;
  /** The nav settled after the checks: remember the answer, and tidy the returned URL. */
  settled(signedIn: boolean): void;
}

export interface IBrowser {
  readonly location: Pick<
    Location,
    'hostname' | 'origin' | 'pathname' | 'search' | 'hash'
  >;
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly history: Pick<History, 'replaceState' | 'state'>;
  /** Creates the Auth0 client that starts the redirect (auth0-spa-js, loaded on demand). */
  createClient(
    options: Auth0ClientOptions
  ): Promise<Pick<Auth0Client, 'loginWithRedirect'>>;
}

const CALLBACK = /[?&]state=/;
const CALLBACK_RESULT = /[?&](code|error)=/;

export function isAuthCallback(search: string): boolean {
  return CALLBACK.test(search) && CALLBACK_RESULT.test(search);
}

export function signInRedirect(
  environment: IOceanumEnvironment,
  browser: IBrowser
): ISignInRedirect | null {
  if (!environment.signInRedirect) {
    return null;
  }
  const { location, storage, history } = browser;
  return {
    shouldTry: () =>
      // localhost is not an allowed callback URL; a query (a shared-notebook link, a returning
      // code) must not be lost to the round trip.
      location.hostname !== 'localhost' &&
      location.search === '' &&
      storage.getItem(REDIRECT_STATE_KEY) === null,

    async start() {
      storage.setItem(REDIRECT_STATE_KEY, 'pending');
      try {
        const client = await browser.createClient({
          domain: environment.auth0Domain,
          clientId: environment.clientId,
          // As the nav's client, so the tokens it caches from the returning code are the ones
          // it asks for: the same scope (openid profile email offline_access) and no audience.
          useRefreshTokens: true,
          cacheLocation: 'memory',
          authorizationParams: { redirect_uri: location.origin }
        });
        await client.loginWithRedirect({
          authorizationParams: {
            prompt: 'none',
            redirect_uri: location.origin
          },
          // auth0-react returns here after handling the code.
          appState: { returnTo: `${location.pathname}${location.hash}` }
        });
      } catch (error) {
        storage.setItem(REDIRECT_STATE_KEY, 'no-session');
        console.warn('Oceanum.io sign-in redirect could not start', error);
      }
    },

    settled(signedIn) {
      if (signedIn) {
        storage.removeItem(REDIRECT_STATE_KEY);
        return;
      }
      if (storage.getItem(REDIRECT_STATE_KEY) === 'pending') {
        storage.setItem(REDIRECT_STATE_KEY, 'no-session');
      }
      // auth0-react tidies the URL after a code, not after an error (login_required).
      if (isAuthCallback(location.search)) {
        history.replaceState(
          history.state,
          '',
          `${location.pathname}${location.hash}`
        );
      }
    }
  };
}

/** The real browser, with auth0-spa-js loaded only when a redirect starts. */
export const browserWindow: IBrowser = {
  get location() {
    return window.location;
  },
  get storage() {
    return window.sessionStorage;
  },
  get history() {
    return window.history;
  },
  async createClient(options) {
    const { Auth0Client } = await import('@auth0/auth0-spa-js');
    return new Auth0Client(options);
  }
};

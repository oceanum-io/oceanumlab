import { Token } from '@lumino/coreutils';
import { ISignal } from '@lumino/signaling';

/**
 * One Oceanum deployment (production or development).
 */
export interface IOceanumEnvironment {
  /** Page hostnames served by this environment, e.g. `notebook.oceanum.io`. */
  readonly hosts: readonly string[];
  /** Auth0 tenant domain, e.g. `auth.oceanum.io`. */
  readonly auth0Domain: string;
  /** Auth0 SPA client id. */
  readonly clientId: string;
  /**
   * The Oceanum apps domain, e.g. `oceanum.io`. The Oceanum nav builds its app, account,
   * docs and sign-out URLs from it (`https://platform.oceanum.io/account`, ...).
   */
  readonly oceanumDomain: string;
  /** Service base URLs for this environment. */
  readonly urls: IOceanumServiceUrls;
  /**
   * Whether to check for an existing Oceanum.io session with a full-page redirect when the
   * silent iframe check finds none. Only for a tenant on another site than the notebook
   * (browsers that block third-party cookies hide the session from the iframe), and only where
   * the site origin is an allowed callback URL.
   */
  readonly signInRedirect: boolean;
}

/** Service base URLs for an environment, without trailing slashes. */
export interface IOceanumServiceUrls {
  /** Datamesh gateway, e.g. `https://datamesh.oceanum.io`. */
  readonly datamesh: string;
  /** Spec store, e.g. `https://specs.oceanum.io`. */
  readonly specs: string;
  /** User management service (Auth0 user metadata), e.g. `https://manage.oceanum.io`. */
  readonly manage: string;
  /**
   * Datamesh UI, e.g. `https://ui.datamesh.oceanum.io`, shown by oceanumlab's Datamesh panel.
   * Optional: without it, oceanumlab's own setting applies.
   */
  readonly datameshUi?: string;
  /**
   * Oceanum AI backend, e.g. `https://ai.oceanum.io`, called by oceanumlab's AI chat.
   * Optional: without it, oceanumlab's own setting applies.
   */
  readonly ai?: string;
}

export type ColorScheme = 'light' | 'dark' | 'auto';

/** The signed-in user, from the Auth0 ID token claims. */
export interface IOceanumUser {
  readonly sub: string;
  readonly email: string;
  readonly name: string | null;
  /** `https://oceanum.io/active_org`. */
  readonly activeOrg: string | null;
  /** `https://oceanum.io/color_scheme`. */
  readonly colorScheme: ColorScheme | null;
}

/**
 * Oceanum.io sign-in state, shared with other Oceanum Notebook extensions.
 */
export interface IOceanumAuth {
  /** The environment for this page, or `null` if sign-in is not configured for this host. */
  readonly environment: IOceanumEnvironment | null;
  /** Service URLs for `environment`, or `null` when it is `null`. */
  readonly urls: IOceanumServiceUrls | null;
  /** Resolves once any login redirect has been handled and the session restored. */
  readonly ready: Promise<void>;
  /** The signed-in user, or `null`. */
  readonly user: IOceanumUser | null;
  /** Emits the new user (or `null`) on sign-in and sign-out. */
  readonly userChanged: ISignal<IOceanumAuth, IOceanumUser | null>;
  /** Emits the new access token (or `null`) whenever it changes, including refreshes. */
  readonly tokenChanged: ISignal<IOceanumAuth, string | null>;
  /**
   * Start sign-in without leaving the page, so its kernels survive. Resolves once sign-in has
   * started, not when it completes; watch `userChanged` for the result. Does nothing while a
   * user is signed in.
   */
  signIn(): Promise<void>;
  /** Sign out of Oceanum.io and clear the session. */
  signOut(): Promise<void>;
  /**
   * A current access token, refreshed if it is near expiry, or `null` when signed out.
   * Never cache the result: Auth0 access tokens are short-lived.
   */
  getAccessToken(): Promise<string | null>;
}

/**
 * The sign-in contract. oceanumlab owns it and exports it from its package entry, because a
 * Lumino token is matched by object identity: every extension that provides or consumes it
 * has to import this one object, which JupyterLab arranges by sharing `@oceanum/oceanumlab`
 * as a singleton module. On an ordinary JupyterLab oceanumlab's own device sign-in provides
 * it; on notebook.oceanum.io the notebook's Oceanum widget extension does.
 */
export const IOceanumAuth = new Token<IOceanumAuth>(
  '@oceanum/oceanumlab:IOceanumAuth',
  'Oceanum.io sign-in state and Datamesh access tokens.'
);

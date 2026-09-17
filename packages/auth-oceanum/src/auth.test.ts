import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INavControls,
  INavState,
  isSessionEndedError,
  LoginStatus,
  NavAuth,
  userFromClaims
} from './auth';
import { IOceanumEnvironment } from './tokens';

const environment: IOceanumEnvironment = {
  hosts: ['notebook.oceanum.tech'],
  auth0Domain: 'oceanum-test.au.auth0.com',
  clientId: 'client',
  oceanumDomain: 'oceanum.tech',
  urls: {
    datamesh: 'https://datamesh.oceanum.tech',
    specs: 'https://specs.oceanum.tech',
    manage: 'https://manage.oceanum.tech'
  },
  signInRedirect: false
};

const CLAIMS = {
  sub: 'auth0|1',
  email: 'user@example.com',
  name: 'User',
  'https://oceanum.io/active_org': 'oceanum',
  'https://oceanum.io/color_scheme': 'dark'
};

const signedIn = (accessToken = 'token-1', claims = CLAIMS): INavState => ({
  loginStatus: LoginStatus.SignedIn,
  claims,
  accessToken
});
const loading: INavState = {
  loginStatus: LoginStatus.Loading,
  claims: null,
  accessToken: undefined
};
const signedOut: INavState = {
  loginStatus: LoginStatus.SignedOut,
  claims: null,
  accessToken: undefined
};

class FakeControls implements INavControls {
  token = 'token-1';
  tokenError: unknown = null;
  signIn = vi.fn();
  signOut = vi.fn();
  getAccessToken = vi.fn(async () => {
    if (this.tokenError) {
      throw this.tokenError;
    }
    return this.token;
  });
}

function create(onSessionExpired = vi.fn()) {
  const auth = new NavAuth({
    environment,
    onSessionExpired,
    refreshIntervalMs: 1000
  });
  const controls = new FakeControls();
  auth.attach(controls);
  const tokens: (string | null)[] = [];
  auth.tokenChanged.connect((_, token) => tokens.push(token));
  return { auth, controls, onSessionExpired, tokens };
}

function authError(error: string): Error & { error: string } {
  return Object.assign(new Error(error), { error });
}

async function isResolved(promise: Promise<unknown>): Promise<boolean> {
  let resolved = false;
  void promise.then(() => (resolved = true));
  await Promise.resolve();
  return resolved;
}

describe('userFromClaims', () => {
  it('reads the Oceanum claims', () => {
    expect(userFromClaims(CLAIMS)).toEqual({
      sub: 'auth0|1',
      email: 'user@example.com',
      name: 'User',
      activeOrg: 'oceanum',
      colorScheme: 'dark'
    });
  });

  it('falls back to the namespaced email claim and ignores unknown colour schemes', () => {
    const user = userFromClaims({
      sub: 's',
      'https://oceanum.io/email': 'x@example.com',
      'https://oceanum.io/color_scheme': 'sepia'
    });
    expect(user?.email).toBe('x@example.com');
    expect(user?.colorScheme).toBeNull();
  });

  it('requires an identity', () => {
    expect(userFromClaims({ email: 'x@example.com' })).toBeNull();
    expect(userFromClaims({ sub: 's' })).toBeNull();
  });
});

describe('isSessionEndedError', () => {
  it('distinguishes an ended session from a transient failure', () => {
    expect(isSessionEndedError(authError('login_required'))).toBe(true);
    expect(isSessionEndedError(authError('missing_refresh_token'))).toBe(true);
    expect(isSessionEndedError(authError('timeout'))).toBe(false);
    expect(isSessionEndedError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isSessionEndedError(null)).toBe(false);
  });
});

describe('NavAuth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not ready while the nav is still restoring the session', async () => {
    const { auth } = create();
    auth.update(loading);
    expect(await isResolved(auth.ready)).toBe(false);
  });

  it('is signed out and ready when there is no session', async () => {
    const { auth, tokens } = create();
    auth.update(signedOut);
    await auth.ready;
    expect(auth.user).toBeNull();
    expect(await auth.getAccessToken()).toBeNull();
    expect(tokens).toEqual([]);
  });

  it('asks once for a session from another Oceanum.io app when the nav settles signed out', async () => {
    const { auth, controls } = create();
    let answer: (token: string) => void = () => undefined;
    controls.getAccessToken = vi.fn(
      () => new Promise<string>(resolve => (answer = resolve))
    );

    auth.update(signedOut);
    expect(controls.getAccessToken).toHaveBeenCalledTimes(1);
    // Nothing offers sign-in while the answer may still sign the user in.
    expect(await isResolved(auth.ready)).toBe(false);

    answer('token-1');
    auth.update(signedIn()); // the nav reports the session it found
    await auth.ready;
    expect(auth.user?.email).toBe('user@example.com');

    auth.update(signedOut);
    expect(controls.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('stays signed out, without a session-ended warning, when there is no session', async () => {
    const { auth, controls, onSessionExpired } = create();
    controls.tokenError = authError('login_required');

    auth.update(signedOut);
    await auth.ready;

    expect(auth.user).toBeNull();
    expect(onSessionExpired).not.toHaveBeenCalled();
    auth.update(signedOut);
    expect(controls.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the session check forever', async () => {
    const auth = new NavAuth({ environment, sessionCheckTimeoutMs: 1000 });
    const controls = new FakeControls();
    controls.getAccessToken = vi.fn(() => new Promise<string>(() => undefined));
    auth.attach(controls);

    auth.update(signedOut);
    expect(await isResolved(auth.ready)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await isResolved(auth.ready)).toBe(true);
  });

  it('does not check for a session after the user signs out or a session ends', async () => {
    const { auth, controls } = create();
    auth.update(signedIn());
    auth.update(signedOut); // the session ended
    await auth.signOut();
    auth.update(signedOut);
    expect(controls.getAccessToken).not.toHaveBeenCalled();
  });

  it('checks again with a redirect when the iframe finds no session, where configured', async () => {
    const redirect = {
      shouldTry: vi.fn(() => true),
      start: vi.fn(async () => undefined),
      settled: vi.fn()
    };
    const auth = new NavAuth({ environment, signInRedirect: redirect });
    const controls = new FakeControls();
    controls.tokenError = authError('login_required');
    auth.attach(controls);

    auth.update(signedOut);
    await auth.ready;

    expect(redirect.start).toHaveBeenCalledTimes(1);
    expect(redirect.settled).not.toHaveBeenCalled();
  });

  it('records the answer instead once a redirect may not be tried', async () => {
    const redirect = {
      shouldTry: vi.fn(() => false),
      start: vi.fn(async () => undefined),
      settled: vi.fn()
    };
    const auth = new NavAuth({ environment, signInRedirect: redirect });
    const controls = new FakeControls();
    controls.tokenError = authError('login_required');
    auth.attach(controls);

    auth.update(signedOut);
    await auth.ready;

    expect(redirect.start).not.toHaveBeenCalled();
    expect(redirect.settled).toHaveBeenCalledWith(false);
  });

  it('tells the redirect when a session arrives', () => {
    const redirect = {
      shouldTry: vi.fn(() => true),
      start: vi.fn(async () => undefined),
      settled: vi.fn()
    };
    const auth = new NavAuth({ environment, signInRedirect: redirect });
    auth.attach(new FakeControls());

    auth.update(signedIn());

    expect(redirect.settled).toHaveBeenCalledWith(true);
    expect(redirect.start).not.toHaveBeenCalled();
  });

  it('is ready at once when the nav has no controls to check with', async () => {
    const auth = new NavAuth({ environment });
    auth.update(signedOut);
    expect(await isResolved(auth.ready)).toBe(true);
  });

  it('restores an existing session', async () => {
    const { auth, tokens } = create();
    const users: unknown[] = [];
    auth.userChanged.connect((_, user) => users.push(user));
    auth.update(signedIn());
    await auth.ready;
    expect(auth.user?.email).toBe('user@example.com');
    expect(tokens).toEqual(['token-1']);
    expect(users).toHaveLength(1);
  });

  it('keeps an established session while the nav refreshes (Loading)', () => {
    const { auth, tokens } = create();
    auth.update(signedIn());
    auth.update(loading);
    expect(auth.user).not.toBeNull();
    expect(tokens).toEqual(['token-1']);
  });

  it('follows a new token from the nav without re-emitting the user', () => {
    const { auth, tokens } = create();
    const users: unknown[] = [];
    auth.userChanged.connect((_, user) => users.push(user));
    auth.update(signedIn('token-1'));
    auth.update(signedIn('token-2'));
    expect(tokens).toEqual(['token-1', 'token-2']);
    expect(users).toHaveLength(1);
  });

  it('treats claims without an identity as signed out', async () => {
    const { auth } = create();
    auth.update(signedIn('token-1', { sub: 'no-email' } as never));
    await auth.ready;
    expect(auth.user).toBeNull();
  });

  it('emits the refreshed token on the refresh interval', async () => {
    const { auth, controls, tokens } = create();
    auth.update(signedIn());
    controls.token = 'token-2';
    await vi.advanceTimersByTimeAsync(1000);
    expect(tokens).toEqual(['token-1', 'token-2']);
  });

  it('keeps the session through a transient refresh failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { auth, controls, onSessionExpired, tokens } = create();
    auth.update(signedIn());
    controls.tokenError = new TypeError('Failed to fetch');
    await vi.advanceTimersByTimeAsync(1000);
    expect(auth.user).not.toBeNull();
    expect(tokens).toEqual(['token-1']);
    expect(onSessionExpired).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports an ended session and clears the token', async () => {
    const { auth, controls, onSessionExpired, tokens } = create();
    auth.update(signedIn());
    controls.tokenError = authError('login_required');
    await vi.advanceTimersByTimeAsync(1000);
    expect(auth.user).toBeNull();
    expect(tokens).toEqual(['token-1', null]);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    // No further refreshes once the session is gone.
    await vi.advanceTimersByTimeAsync(5000);
    expect(controls.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('reports a session the nav drops as expired', () => {
    const { auth, onSessionExpired, tokens } = create();
    auth.update(signedIn());
    auth.update(signedOut);
    expect(tokens).toEqual(['token-1', null]);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('signs in through the nav', async () => {
    const { auth, controls } = create();
    auth.update(signedOut);
    await auth.signIn();
    expect(controls.signIn).toHaveBeenCalledTimes(1);
  });

  it('does not ask the nav to sign in while signed in', async () => {
    const { auth, controls } = create();
    auth.update(signedIn());
    await auth.signIn();
    expect(controls.signIn).not.toHaveBeenCalled();
  });

  it('refuses to sign in before the nav has mounted', async () => {
    const auth = new NavAuth({ environment });
    await expect(auth.signIn()).rejects.toThrow(/not ready/);
  });

  it('clears the token before the nav signs out', async () => {
    const { auth, controls, onSessionExpired, tokens } = create();
    auth.update(signedIn());
    controls.signOut.mockImplementation(() => {
      // The kernel bridge has already been told there is no token.
      expect(tokens).toEqual(['token-1', null]);
    });
    await auth.signOut();
    expect(controls.signOut).toHaveBeenCalledTimes(1);
    expect(auth.user).toBeNull();
    // Signing out is not a session expiry, even when the nav then reports SignedOut.
    auth.update(signedOut);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('does not let a refresh that was in flight restore the session after sign-out', async () => {
    const { auth, controls, tokens } = create();
    auth.update(signedIn());
    let release: (token: string) => void = () => undefined;
    controls.getAccessToken.mockImplementation(
      () => new Promise<string>(resolve => (release = resolve))
    );
    const pending = auth.refresh();
    await auth.signOut();
    release('token-2');
    await pending;
    expect(auth.user).toBeNull();
    expect(tokens).toEqual(['token-1', null]);
  });

  it('does not let the nav bring back a session the user just signed out of', async () => {
    const { auth, tokens } = create();
    auth.update(signedIn());
    await auth.signOut();
    auth.update(signedIn('token-1'));
    expect(auth.user).toBeNull();
    expect(tokens).toEqual(['token-1', null]);
  });

  it('takes back a session whose sign-out never left the page', async () => {
    const { auth, controls } = create();
    auth.update(signedIn());
    await auth.signOut();
    // The page did not navigate; the nav still reports the same session.
    await auth.signIn();
    expect(controls.signIn).not.toHaveBeenCalled();
    expect(auth.user?.email).toBe('user@example.com');
  });

  it('does nothing without an environment', async () => {
    const auth = new NavAuth({ environment: null });
    await auth.ready;
    auth.update(signedIn());
    expect(auth.user).toBeNull();
    expect(auth.urls).toBeNull();
    await expect(auth.signIn()).rejects.toThrow(/not available/);
    await auth.signOut();
    expect(await auth.getAccessToken()).toBeNull();
  });
});

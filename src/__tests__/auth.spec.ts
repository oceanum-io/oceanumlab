import {
  IAppState,
  IAuth0Client,
  isSessionEndedError,
  OceanumAuth,
  userFromClaims
} from '../auth/auth';
import { IOceanumEnvironment } from '../auth/tokens';

const environment: IOceanumEnvironment = {
  hosts: ['notebook.oceanum.tech'],
  auth0Domain: 'oceanum-test.au.auth0.com',
  clientId: 'client',
  urls: {
    datamesh: 'https://datamesh.oceanum.tech',
    specs: 'https://specs.oceanum.tech',
    manage: 'https://manage.oceanum.tech'
  }
};

const REDIRECT = 'https://notebook.oceanum.tech/lab/index.html';
const CLAIMS = {
  sub: 'auth0|1',
  email: 'user@example.com',
  name: 'User',
  'https://oceanum.io/active_org': 'oceanum',
  'https://oceanum.io/color_scheme': 'dark'
};

class FakeClient implements IAuth0Client {
  authenticated = false;
  token = 'token-1';
  claims: Record<string, unknown> = CLAIMS;
  tokenError: unknown = null;
  appState: IAppState = {};
  loginWithRedirect = jest.fn(async (): Promise<void> => undefined);
  handleRedirectCallback = jest.fn(async () => {
    this.authenticated = true;
    return { appState: this.appState };
  });
  checkSession = jest.fn(async (): Promise<void> => undefined);
  isAuthenticated = jest.fn(async () => this.authenticated);
  getTokenSilently = jest.fn(async () => {
    if (this.tokenError) {
      throw this.tokenError;
    }
    return this.token;
  });
  getIdTokenClaims = jest.fn(async () => this.claims);
  logout = jest.fn(async (): Promise<void> => undefined);
}

function create(
  href: string,
  client = new FakeClient(),
  onSessionExpired = jest.fn()
) {
  const location = { href: () => href, replace: jest.fn() };
  const auth = new OceanumAuth({
    environment,
    client,
    redirectUri: REDIRECT,
    location,
    onSessionExpired,
    refreshIntervalMs: 1000
  });
  return { auth, client, location, onSessionExpired };
}

function authError(error: string): Error & { error: string } {
  return Object.assign(new Error(error), { error });
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

describe('OceanumAuth', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is signed out and ready when there is no session', async () => {
    const { auth, client } = create('https://notebook.oceanum.tech/lab/');
    const users = jest.fn();
    auth.userChanged.connect((_, user) => users(user));

    await auth.initialize();
    await auth.ready;

    expect(client.checkSession).toHaveBeenCalled();
    expect(auth.user).toBeNull();
    expect(await auth.getAccessToken()).toBeNull();
    expect(users).not.toHaveBeenCalled();
  });

  it('restores an existing session', async () => {
    const client = new FakeClient();
    client.authenticated = true;
    const { auth } = create('https://notebook.oceanum.tech/lab/', client);
    const tokens = jest.fn();
    auth.tokenChanged.connect((_, token) => tokens(token));

    await auth.initialize();

    expect(auth.user?.email).toBe('user@example.com');
    expect(tokens).toHaveBeenCalledWith('token-1');
    auth.dispose();
  });

  it('handles the login redirect, strips the code and returns to the same app', async () => {
    const client = new FakeClient();
    client.appState = {
      returnTo: 'https://notebook.oceanum.tech/lab/?path=a.ipynb'
    };
    const href = `${REDIRECT}?code=abc&state=xyz`;
    const { auth, location } = create(href, client);

    await auth.initialize();

    expect(client.handleRedirectCallback).toHaveBeenCalledWith(href);
    expect(client.checkSession).not.toHaveBeenCalled();
    expect(location.replace).toHaveBeenCalledWith(
      'https://notebook.oceanum.tech/lab/?path=a.ipynb'
    );
    expect(auth.user).not.toBeNull();
    auth.dispose();
  });

  it('does not follow a returnTo into another app or origin', async () => {
    for (const returnTo of [
      'https://notebook.oceanum.tech/notebooks/?path=a.ipynb',
      'https://evil.example/lab/'
    ]) {
      const client = new FakeClient();
      client.appState = { returnTo };
      const { auth, location } = create(
        `${REDIRECT}?code=abc&state=xyz&path=b.ipynb`,
        client
      );

      await auth.initialize();

      expect(location.replace).toHaveBeenCalledWith(`${REDIRECT}?path=b.ipynb`);
      auth.dispose();
    }
  });

  it('strips an Auth0 error from the address bar and stays signed out', async () => {
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { auth, client, location } = create(
      `${REDIRECT}?error=access_denied&error_description=nope&state=xyz`
    );

    await auth.initialize();

    expect(client.handleRedirectCallback).not.toHaveBeenCalled();
    expect(location.replace).toHaveBeenCalledWith(REDIRECT);
    expect(auth.user).toBeNull();
    error.mockRestore();
  });

  it('signs in with the registered redirect URI and the current page as appState', async () => {
    const { auth, client } = create(
      'https://notebook.oceanum.tech/lab/?path=a.ipynb'
    );

    await auth.signIn();

    expect(client.loginWithRedirect).toHaveBeenCalledWith({
      authorizationParams: { redirect_uri: REDIRECT },
      appState: { returnTo: 'https://notebook.oceanum.tech/lab/?path=a.ipynb' }
    });
  });

  it('emits the refreshed token on the refresh interval', async () => {
    const client = new FakeClient();
    client.authenticated = true;
    const { auth } = create('https://notebook.oceanum.tech/lab/', client);
    await auth.initialize();
    const tokens = jest.fn();
    auth.tokenChanged.connect((_, token) => tokens(token));

    client.token = 'token-2';
    await jest.advanceTimersByTimeAsync(1000);

    expect(tokens).toHaveBeenCalledWith('token-2');
    auth.dispose();
  });

  it('keeps the session through a transient refresh failure', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const client = new FakeClient();
    client.authenticated = true;
    const { auth, onSessionExpired } = create(
      'https://notebook.oceanum.tech/lab/',
      client
    );
    await auth.initialize();

    client.tokenError = authError('timeout');
    await jest.advanceTimersByTimeAsync(1000);

    expect(auth.user).not.toBeNull();
    expect(onSessionExpired).not.toHaveBeenCalled();
    auth.dispose();
    warn.mockRestore();
  });

  it('reports an ended session and clears the token', async () => {
    const client = new FakeClient();
    client.authenticated = true;
    const { auth, onSessionExpired } = create(
      'https://notebook.oceanum.tech/lab/',
      client
    );
    await auth.initialize();
    const tokens = jest.fn();
    auth.tokenChanged.connect((_, token) => tokens(token));

    client.tokenError = authError('login_required');
    await jest.advanceTimersByTimeAsync(1000);

    expect(auth.user).toBeNull();
    expect(tokens).toHaveBeenCalledWith(null);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    auth.dispose();
  });

  it('clears the token before redirecting on sign-out', async () => {
    const client = new FakeClient();
    client.authenticated = true;
    const { auth, onSessionExpired } = create(
      'https://notebook.oceanum.tech/lab/',
      client
    );
    await auth.initialize();
    const tokens = jest.fn();
    auth.tokenChanged.connect((_, token) => tokens(token));

    await auth.signOut();

    expect(tokens).toHaveBeenCalledWith(null);
    expect(client.logout).toHaveBeenCalledWith({
      logoutParams: { returnTo: REDIRECT }
    });
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('does not let a refresh that was in flight restore the session after sign-out', async () => {
    const client = new FakeClient();
    client.authenticated = true;
    const { auth } = create('https://notebook.oceanum.tech/lab/', client);
    await auth.initialize();
    let finishRefresh: (token: string) => void = () => undefined;
    client.getTokenSilently.mockImplementationOnce(
      () => new Promise<string>(resolve => (finishRefresh = resolve))
    );
    const tokens = jest.fn();
    auth.tokenChanged.connect((_, token) => tokens(token));

    const refresh = auth.refresh();
    await Promise.resolve();
    await auth.signOut();
    finishRefresh('token-late');
    await refresh;

    expect(auth.user).toBeNull();
    expect(tokens.mock.calls).toEqual([[null]]);
  });

  it('treats a state parameter without a code or error as an ordinary page load', async () => {
    const { auth, client, location } = create(
      'https://notebook.oceanum.tech/lab/index.html?state=unrelated'
    );

    await auth.initialize();

    expect(client.handleRedirectCallback).not.toHaveBeenCalled();
    expect(client.checkSession).toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('does nothing without an environment', async () => {
    const auth = new OceanumAuth({
      environment: null,
      client: new FakeClient(),
      redirectUri: REDIRECT,
      location: {
        href: () => 'https://preview.example/lab/',
        replace: jest.fn()
      }
    });

    await auth.initialize();

    expect(auth.urls).toBeNull();
    expect(await auth.getAccessToken()).toBeNull();
    await expect(auth.signIn()).rejects.toThrow(/not available/);
  });
});

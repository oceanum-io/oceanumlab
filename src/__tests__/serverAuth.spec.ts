import {
  AuthRequest,
  readServerAuthOption,
  SERVER_AUTH_OPTION,
  ServerAuth
} from '../auth/serverAuth';
import { IOceanumEnvironment } from '../auth/tokens';

const OPTION = JSON.stringify({
  auth0Domain: 'auth.oceanum.io',
  clientId: 'a-client',
  oceanumDomain: 'oceanum.io',
  urls: {
    datamesh: 'https://datamesh.oceanum.io/',
    specs: 'https://specs.oceanum.io',
    manage: 'https://manage.oceanum.io',
    ai: 'https://ai.oceanum.io'
  }
});

const ENVIRONMENT = readServerAuthOption(
  OPTION,
  'localhost'
) as IOceanumEnvironment;

const CLAIMS = { sub: 'auth0|abc', email: 'ada@example.org', name: 'Ada' };
const PENDING = {
  userCode: 'WXYZ-1234',
  verificationUri: 'https://auth.oceanum.io/activate',
  verificationUriComplete:
    'https://auth.oceanum.io/activate?user_code=WXYZ-1234',
  expiresIn: 900
};

const SIGNED_OUT = {
  state: 'signedOut',
  claims: null as unknown,
  pending: null as unknown,
  error: null as string | null
};
const WAITING = { ...SIGNED_OUT, state: 'pending', pending: PENDING };
const SIGNED_IN = { ...SIGNED_OUT, state: 'signedIn', claims: CLAIMS };

/** A Jupyter server whose answers can be changed as the test goes. */
function server(initial: Record<string, unknown>) {
  const calls: string[] = [];
  const state = { status: initial, token: 'jwt-1' as string | null };
  const request: AuthRequest = async (action, method) => {
    calls.push(`${method} ${action}`);
    if (action === 'token') {
      const signedIn = state.status.state === 'signedIn';
      return { ...state.status, accessToken: signedIn ? state.token : null };
    }
    return state.status;
  };
  return { calls, state, request };
}

const tick = (ms = 0): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

async function until(check: () => void, timeout = 2000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > end) {
        throw err;
      }
    }
    await tick(10);
  }
}

describe('readServerAuthOption', () => {
  it('reads the page option name the server publishes under', () => {
    // oceanumlab/__init__.py writes this literal (SERVER_AUTH_OPTION there, pinned by its
    // own test). Renaming either side alone would silently turn sign-in off everywhere.
    expect(SERVER_AUTH_OPTION).toBe('oceanumServerAuth');
  });

  it('builds the environment, normalising URLs and dropping absent optional ones', () => {
    expect(ENVIRONMENT.urls).toEqual({
      datamesh: 'https://datamesh.oceanum.io',
      specs: 'https://specs.oceanum.io',
      manage: 'https://manage.oceanum.io',
      ai: 'https://ai.oceanum.io'
    });
    // The device grant is indifferent to the page's address, so there is nothing to match.
    expect(ENVIRONMENT.hosts).toEqual(['localhost']);
  });

  it('treats a missing or unusable option as no sign-in on offer', () => {
    expect(readServerAuthOption(undefined, 'localhost')).toBeNull();
    expect(readServerAuthOption('', 'localhost')).toBeNull();
    expect(readServerAuthOption('not json', 'localhost')).toBeNull();
    expect(readServerAuthOption('[]', 'localhost')).toBeNull();
    const noSpecs = JSON.parse(OPTION);
    delete noSpecs.urls.specs;
    expect(
      readServerAuthOption(JSON.stringify(noSpecs), 'localhost')
    ).toBeNull();
    const script = JSON.parse(OPTION);
    script.urls.specs = 'javascript:alert(1)';
    expect(
      readServerAuthOption(JSON.stringify(script), 'localhost')
    ).toBeNull();
  });
});

describe('ServerAuth', () => {
  it('is inert, and ready, when the server offers no sign-in', async () => {
    const jupyter = server(SIGNED_OUT);
    const auth = new ServerAuth({
      environment: null,
      request: jupyter.request
    });

    await auth.ready;
    await auth.signIn();

    expect(auth.user).toBeNull();
    expect(await auth.getAccessToken()).toBeNull();
    expect(jupyter.calls).toEqual([]);
    auth.dispose();
  });

  it('finds a session the server already holds, before it says it is ready', async () => {
    // A page reload, or a second tab: the server signed in earlier and still is.
    const jupyter = server(SIGNED_IN);
    const auth = new ServerAuth({
      environment: ENVIRONMENT,
      request: jupyter.request
    });

    await auth.ready;

    expect(auth.user?.email).toBe('ada@example.org');
    expect(await auth.getAccessToken()).toBe('jwt-1');
    auth.dispose();
  });

  it('starts a sign-in, waits on the user, then reports the user and the token', async () => {
    const jupyter = server(SIGNED_OUT);
    const auth = new ServerAuth({
      environment: ENVIRONMENT,
      request: jupyter.request,
      pendingPollMs: 10
    });
    await auth.ready;
    const users: (string | null)[] = [];
    const tokens: (string | null)[] = [];
    auth.userChanged.connect((_, user) => users.push(user?.email ?? null));
    auth.tokenChanged.connect((_, token) => tokens.push(token));

    jupyter.state.status = WAITING;
    await auth.signIn();
    expect(auth.pending?.userCode).toBe('WXYZ-1234');
    expect(auth.user).toBeNull();

    // The user confirms the code in their browser; the server's next answer says so.
    jupyter.state.status = SIGNED_IN;
    await until(() => expect(auth.user?.email).toBe('ada@example.org'));

    expect(auth.pending).toBeNull();
    expect(users).toEqual(['ada@example.org']);
    expect(tokens).toEqual(['jwt-1']);
    auth.dispose();
  });

  it('passes on a refreshed token while signed in', async () => {
    const jupyter = server(SIGNED_IN);
    const auth = new ServerAuth({
      environment: ENVIRONMENT,
      request: jupyter.request,
      tokenPollMs: 10
    });
    await auth.ready;
    const tokens: (string | null)[] = [];
    auth.tokenChanged.connect((_, token) => tokens.push(token));

    jupyter.state.token = 'jwt-2';
    await until(() => expect(tokens).toEqual(['jwt-2']));
    auth.dispose();
  });

  it('signs out without calling it a session that ended', async () => {
    const jupyter = server(SIGNED_IN);
    const ended: string[] = [];
    const auth = new ServerAuth({
      environment: ENVIRONMENT,
      request: jupyter.request,
      onSessionEnded: message => ended.push(message)
    });
    await auth.ready;
    const tokens: (string | null)[] = [];
    auth.tokenChanged.connect((_, token) => tokens.push(token));

    jupyter.state.status = SIGNED_OUT;
    await auth.signOut();

    expect(jupyter.calls).toContain('POST signout');
    expect(auth.user).toBeNull();
    expect(tokens).toEqual([null]);
    expect(ended).toEqual([]);
    auth.dispose();
  });

  it('says so when the server ends the session itself', async () => {
    const jupyter = server(SIGNED_IN);
    const ended: string[] = [];
    const auth = new ServerAuth({
      environment: ENVIRONMENT,
      request: jupyter.request,
      onSessionEnded: message => ended.push(message),
      tokenPollMs: 10
    });
    await auth.ready;

    // The refresh token was revoked: the server's next answer is signed out, with why.
    jupyter.state.status = {
      ...SIGNED_OUT,
      error: 'Your Oceanum.io session has ended.'
    };
    await until(() => expect(auth.user).toBeNull());

    expect(ended).toEqual(['Your Oceanum.io session has ended.']);
    auth.dispose();
  });

  it('keeps the session when the Jupyter server is briefly unreachable', async () => {
    const jupyter = server(SIGNED_IN);
    let failing = false;
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const auth = new ServerAuth({
      environment: ENVIRONMENT,
      request: async (action, method) => {
        if (failing) {
          throw new Error('connection refused');
        }
        return jupyter.request(action, method);
      }
    });
    await auth.ready;

    failing = true;
    await auth.refresh();

    // One failed request is not a sign-out.
    expect(auth.user?.email).toBe('ada@example.org');
    auth.dispose();
    warn.mockRestore();
  });

  it('cancels a sign-in that is waiting', async () => {
    const jupyter = server(SIGNED_OUT);
    const auth = new ServerAuth({
      environment: ENVIRONMENT,
      request: jupyter.request,
      pendingPollMs: 10000
    });
    await auth.ready;
    jupyter.state.status = WAITING;
    await auth.signIn();

    jupyter.state.status = SIGNED_OUT;
    await auth.cancelSignIn();

    expect(jupyter.calls).toContain('POST cancel');
    expect(auth.pending).toBeNull();
    auth.dispose();
  });
});

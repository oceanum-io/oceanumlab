import {
  ACCESS_TOKEN_COMMAND,
  SIGN_IN_COMMAND,
  SIGN_OUT_COMMAND,
  aiBackendUrl,
  aiCredentialSource,
  canSignIn,
  isSignedIn,
  resolveAiCredential,
  signInToken,
  type AuthCommands
} from '../aiBackend';
import { OCEANUM_AI_BACKEND_URL } from '../constants';
import { validHttpUrl } from '../httpUrl';

describe('aiBackendUrl', () => {
  it('is production when the deployment names no address', () => {
    // What index.ts passes when the sign-in environment has no `ai` URL, or there is no
    // sign-in at all.
    expect(aiBackendUrl('')).toBe(OCEANUM_AI_BACKEND_URL);
    expect(aiBackendUrl(undefined)).toBe('https://ai.oceanum.io');
  });

  it.each([
    ['as it is', 'https://ai.oceanum.tech', 'https://ai.oceanum.tech'],
    [
      'without a trailing slash',
      'https://ai.oceanum.tech/',
      'https://ai.oceanum.tech'
    ],
    ['trimmed', '  https://ai.oceanum.tech/  ', 'https://ai.oceanum.tech'],
    [
      'over plain http, with a port',
      'http://localhost:8000/',
      'http://localhost:8000'
    ],
    [
      'with a path prefix',
      'https://example.test/ai//',
      'https://example.test/ai'
    ],
    [
      'without a query or fragment',
      'https://ai.oceanum.tech/?x=1#y',
      'https://ai.oceanum.tech'
    ]
  ])('takes an http(s) address %s', (_, value, expected) => {
    expect(aiBackendUrl(value)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['missing', undefined],
    ['null', null],
    ['not a URL', 'not a url'],
    ['a relative path', '/api'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a file: URL', 'file:///etc/passwd']
  ])('falls back to the default for %s', (_, value) => {
    expect(aiBackendUrl(value)).toBe('https://ai.oceanum.io');
  });
});

describe('validHttpUrl', () => {
  it('falls back to the fallback it is given', () => {
    expect(validHttpUrl('ftp://x', 'https://fallback.test').href).toBe(
      'https://fallback.test/'
    );
  });
});

describe('resolveAiCredential', () => {
  const never = jest.fn(async (): Promise<unknown> => 'unused');

  beforeEach(() => never.mockClear());

  it('uses a pasted token, trimmed, without asking for the sign-in', async () => {
    expect(await resolveAiCredential('  a-token \n', never)).toEqual({
      source: 'datamesh-token',
      headers: { 'X-Datamesh-Token': 'a-token' }
    });
    expect(never).not.toHaveBeenCalled();
  });

  it.each([
    ['no', undefined],
    ['a null', null],
    ['an empty', ''],
    ['a blank', ' \t ']
  ])(
    'uses the sign-in as a bearer token with %s pasted token',
    async (_, pasted) => {
      expect(await resolveAiCredential(pasted, async () => ' a-jwt ')).toEqual({
        source: 'sign-in',
        headers: { Authorization: 'Bearer a-jwt' }
      });
    }
  );

  it.each([
    ['signed out', async (): Promise<unknown> => null],
    ['an empty token', async (): Promise<unknown> => ''],
    ['a blank token', async (): Promise<unknown> => '   '],
    ['a non-string', async (): Promise<unknown> => ({ token: 'a-jwt' })],
    ['a number', async (): Promise<unknown> => 42],
    [
      'a rejection',
      (): Promise<unknown> => Promise.reject(new Error('sign-in failed'))
    ],
    [
      'a throw',
      (): Promise<unknown> => {
        throw new Error('sign-in failed');
      }
    ]
  ])('has no credential without a pasted token and %s', async (_, get) => {
    expect(await resolveAiCredential('', get)).toBeNull();
  });
});

/**
 * A host registry: `commands` are registered, `enabled`/`visible` say what its
 * queries answer. Queries must never execute anything.
 */
const host = (
  commands: Record<string, () => unknown>,
  { enabled = [] as string[], visible = [] as string[] } = {}
) => ({
  hasCommand: jest.fn((id: string) => id in commands),
  execute: jest.fn(async (id: string) => commands[id]()),
  isEnabled: jest.fn((id: string) => enabled.includes(id)),
  isVisible: jest.fn((id: string) => visible.includes(id))
});

const asCommands = (commands: ReturnType<typeof host>): AuthCommands =>
  commands as unknown as AuthCommands;

describe('canSignIn and isSignedIn', () => {
  const all = {
    [ACCESS_TOKEN_COMMAND]: () => 'a-jwt',
    [SIGN_IN_COMMAND]: (): void => undefined,
    [SIGN_OUT_COMMAND]: (): void => undefined
  };

  it('reads the queries, and runs nothing', () => {
    const commands = host(all, {
      enabled: [SIGN_IN_COMMAND],
      visible: [SIGN_OUT_COMMAND]
    });

    expect(canSignIn(asCommands(commands))).toBe(true);
    expect(isSignedIn(asCommands(commands))).toBe(true);
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('is signed out while the sign-out command is hidden', () => {
    const commands = host(all, { enabled: [SIGN_IN_COMMAND] });

    expect(canSignIn(asCommands(commands))).toBe(true);
    expect(isSignedIn(asCommands(commands))).toBe(false);
  });

  it('cannot sign in where the site has sign-in disabled', () => {
    const commands = host(all, { visible: [SIGN_OUT_COMMAND] });

    expect(canSignIn(asCommands(commands))).toBe(false);
  });

  it('is false where the host has no such commands', () => {
    const commands = host({});

    expect(canSignIn(asCommands(commands))).toBe(false);
    expect(isSignedIn(asCommands(commands))).toBe(false);
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('is false when a query throws', () => {
    const commands = {
      hasCommand: () => true,
      execute: jest.fn(),
      isEnabled: () => {
        throw new Error('no');
      },
      isVisible: () => {
        throw new Error('no');
      }
    } as unknown as AuthCommands;

    expect(canSignIn(commands)).toBe(false);
    expect(isSignedIn(commands)).toBe(false);
  });
});

describe('aiCredentialSource', () => {
  const signedIn = {
    enabled: [SIGN_IN_COMMAND],
    visible: [SIGN_OUT_COMMAND]
  };
  const all = {
    [ACCESS_TOKEN_COMMAND]: () => 'a-jwt',
    [SIGN_IN_COMMAND]: (): void => undefined,
    [SIGN_OUT_COMMAND]: (): void => undefined
  };

  it('is the pasted token when there is one', () => {
    const commands = host(all, signedIn);

    expect(aiCredentialSource('  a-token ', asCommands(commands))).toBe(
      'datamesh-token'
    );
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('is the sign-in while signed in, and nothing once signed out', () => {
    const commands = host(all, signedIn);
    expect(aiCredentialSource('', asCommands(commands))).toBe('sign-in');
    expect(commands.execute).not.toHaveBeenCalled();

    const out = host(all, { enabled: [SIGN_IN_COMMAND] });
    expect(aiCredentialSource('', asCommands(out))).toBeNull();
  });

  it('is nothing where the host has no access-token command', () => {
    const commands = host(
      { [SIGN_OUT_COMMAND]: (): void => undefined },
      { visible: [SIGN_OUT_COMMAND] }
    );

    expect(aiCredentialSource('', asCommands(commands))).toBeNull();
  });

  it.each([
    ['blank', '   '],
    ['missing', undefined],
    ['not a string', 42]
  ])('treats a %s pasted token as none', (_, value) => {
    const commands = host(all, signedIn);

    expect(aiCredentialSource(value, asCommands(commands))).toBe('sign-in');
  });
});

describe('signInToken', () => {
  it('is null, without running anything, when the host has no access-token command', async () => {
    const commands = host({});

    expect(await signInToken(asCommands(commands))()).toBeNull();
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it("is what the host's access-token command answers", async () => {
    let token: string | null = 'a-jwt';
    const commands = host({ [ACCESS_TOKEN_COMMAND]: () => token });
    const get = signInToken(asCommands(commands));

    expect(await get()).toBe('a-jwt');
    token = null;
    expect(await get()).toBeNull();
    expect(commands.execute).toHaveBeenCalledWith(ACCESS_TOKEN_COMMAND);
  });

  it('checks for the command on every call, so a host registering it late is found', async () => {
    const commands: Record<string, () => unknown> = {};
    const get = signInToken(asCommands(host(commands)));

    expect(await get()).toBeNull();
    commands[ACCESS_TOKEN_COMMAND] = () => 'a-jwt';
    expect(await get()).toBe('a-jwt');
  });
});

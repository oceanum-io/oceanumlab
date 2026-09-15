import type { AuthCommands } from '../aiBackend';
import { ChatRouter } from '../chatRouter';
import type { INotebookSnapshot } from '../notebookContext';

/** Settings holding `values`; a key not given has no value. */
const settingsWith = (values: Record<string, unknown>) =>
  ({
    get: (key: string) => ({ composite: values[key] })
  }) as unknown as ConstructorParameters<typeof ChatRouter>[0];

const settings = settingsWith({ datameshToken: 'a-token' });

/**
 * A host with these commands, each answering with what its function returns.
 * `enabled` and `visible` are what the registry's queries answer, which is how
 * the sign-in state is read without running anything.
 */
const hostCommands = (
  commands: Record<string, () => unknown>,
  { enabled = [] as string[], visible = [] as string[] } = {}
) =>
  ({
    hasCommand: jest.fn((id: string) => id in commands),
    execute: jest.fn(async (id: string) => commands[id]()),
    isEnabled: jest.fn((id: string) => enabled.includes(id)),
    isVisible: jest.fn((id: string) => visible.includes(id))
  }) as AuthCommands & { execute: jest.Mock };

/** Plain JupyterLab: no Oceanum.io sign-in to lend. */
const noSignIn = hostCommands({});

const snapshot = (
  cells: INotebookSnapshot['cells'],
  selected: INotebookSnapshot['selected'] = null
): INotebookSnapshot => ({ cells, selected });

let sent: Record<string, unknown> | undefined;
let sentHeaders: Record<string, string> | undefined;
let sentUrl: string | undefined;

interface IRequestInit {
  body: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/** Answer every request with what `response` builds from it. */
function answering(response: (init: IRequestInit) => unknown): void {
  (globalThis as any).fetch = jest.fn(
    async (url: string, init: IRequestInit) => {
      sent = JSON.parse(init.body);
      sentHeaders = init.headers;
      sentUrl = url;
      return response(init);
    }
  );
}

beforeEach(() => {
  sent = undefined;
  sentHeaders = undefined;
  sentUrl = undefined;
  answering(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async (): Promise<unknown> => ({ message: 'ok', blocks: [] })
  }));
});

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * A 200 whose body streams `frames` and ends -- or, with `hang`, then stays
 * open until `signal` aborts, failing the read in flight as fetch does.
 */
function streamed(frames: string[], signal?: AbortSignal, hang = false) {
  const encoder = new TextEncoder();
  const chunks = frames.map(f => encoder.encode(f));
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    json: async (): Promise<unknown> => {
      throw new Error('a stream is not JSON');
    },
    body: {
      getReader: () => ({
        read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
          if (index < chunks.length) {
            return Promise.resolve({ done: false, value: chunks[index++] });
          }
          if (!hang) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((_ok, fail) => {
            signal?.addEventListener('abort', () =>
              fail(new DOMException('Aborted', 'AbortError'))
            );
          });
        },
        releaseLock: (): void => undefined
      })
    }
  };
}

describe('ChatRouter: the notebook sent with a request', () => {
  it('is the conversation notebook, code and markdown', async () => {
    const router = new ChatRouter(settings, noSignIn, async () =>
      snapshot([
        { kind: 'code', source: 'x = 1' },
        { kind: 'markdown', source: '## Notes' },
        { kind: 'code', source: 'y = x' }
      ])
    );

    await router.route('what does this do?');

    expect(sent?.notebookCells).toEqual([
      'x = 1',
      '# %% [markdown]\n# ## Notes',
      'y = x'
    ]);
  });

  it('carries the selected cell of that notebook, which a code answer may replace', async () => {
    const router = new ChatRouter(settings, noSignIn, async () =>
      snapshot([{ kind: 'code', source: 'df.head()' }], {
        source: 'df.head()',
        isCode: true
      })
    );

    const result = await router.route('fix this');

    expect(sent?.codeContext).toBe('df.head()');
    expect(result.hasCodeCellSelected).toBe(true);
  });

  it('asks for the notebook on every request, so it follows the conversation', async () => {
    let current = snapshot([{ kind: 'code', source: 'a = 1' }]);
    const router = new ChatRouter(settings, noSignIn, async () => current);

    await router.route('one');
    expect(sent?.notebookCells).toEqual(['a = 1']);

    current = snapshot([{ kind: 'code', source: 'b = 2' }]);
    await router.route('two');
    expect(sent?.notebookCells).toEqual(['b = 2']);
  });

  it('sends no notebook when there is none', async () => {
    const router = new ChatRouter(settings, noSignIn, async () => null);

    await router.route('hello');

    expect(sent?.notebookCells).toBeUndefined();
    expect(sent?.codeContext).toBeUndefined();
    expect(sent?.context).toBeUndefined();
  });

  it('still sends the question when the notebook cannot be read', async () => {
    // Context is best-effort; a notebook that could not be read must not
    // cost the user the answer.
    const router = new ChatRouter(settings, noSignIn, async () => {
      throw new Error('could not read');
    });

    await router.route('hello');

    expect(sent?.prompt).toBe('hello');
    expect(sent?.notebookCells).toBeUndefined();
  });
});

describe('ChatRouter: the streamed answer', () => {
  const noNotebook = async (): Promise<null> => null;

  it('asks for the stream only when someone is listening', async () => {
    // Without a listener the request is byte-identical to what it always was.
    const router = new ChatRouter(settings, noSignIn, noNotebook);

    await router.route('hello');
    expect(sentHeaders?.Accept).toBeUndefined();

    await router.route('hello', [], undefined, () => undefined);
    expect(sentHeaders?.Accept).toBe('text/event-stream');
  });

  it('reports each phase, and takes the answer from done', async () => {
    // The events before `done` are for the user to look at. Assembled from
    // them, the answer would come out short whenever a frame went missing.
    answering(() =>
      streamed([
        frame('status', { phase: 'generating' }),
        ': keepalive\n\n',
        frame('status', { phase: 'tool', tool: 'search_catalog' }),
        frame('message', { message: 'partial' }),
        frame('done', {
          message: 'The whole answer.',
          blocks: [{ type: 'code', content: 'x = 1' }]
        })
      ])
    );
    const progress: unknown[] = [];
    const router = new ChatRouter(settings, noSignIn, noNotebook);

    const result = await router.route('find waves', [], undefined, p =>
      progress.push(p)
    );

    expect(progress).toEqual([
      { phase: 'generating' },
      { phase: 'tool', tool: 'search_catalog' }
    ]);
    expect(result.response).toEqual({
      message: 'The whole answer.',
      blocks: [{ type: 'code', content: 'x = 1' }]
    });
  });

  it('reads JSON when the server answers with JSON anyway', async () => {
    // An older backend, or a proxy that buffered the stream away.
    const router = new ChatRouter(settings, noSignIn, noNotebook);

    const result = await router.route('hello', [], undefined, () => undefined);

    expect(result.response).toEqual({ message: 'ok', blocks: [] });
  });

  it('turns an error event into the error the chat shows', async () => {
    // The status was already 200, so the failure can only arrive as an event.
    answering(() =>
      streamed([
        frame('status', { phase: 'generating' }),
        frame('error', {
          detail: 'Internal error',
          status_code: 500,
          code: 'internal_error'
        })
      ])
    );
    const router = new ChatRouter(settings, noSignIn, noNotebook);

    await expect(
      router.route('hi', [], undefined, () => undefined)
    ).rejects.toMatchObject({
      name: 'ChatRouterError',
      message: 'Backend error: Internal error',
      statusCode: 500
    });
  });

  it('fails a stream that ends without its answer', async () => {
    // A dropped connection: a failure, not a shorter answer.
    answering(() => streamed([frame('status', { phase: 'generating' })]));
    const router = new ChatRouter(settings, noSignIn, noNotebook);

    await expect(
      router.route('hi', [], undefined, () => undefined)
    ).rejects.toThrow('The response ended before it was complete.');
  });

  it('reports a connection lost mid-answer as an error, not silence', async () => {
    // A redeploy or a network drop fails the read in flight with a bare
    // TypeError. Unwrapped, it reached the command as unexpected, and the chat
    // showed an empty answer.
    let reads = 0;
    answering(() => ({
      ...streamed([]),
      body: {
        getReader: () => ({
          read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
            reads += 1;
            return reads === 1
              ? Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode(
                    frame('status', { phase: 'generating' })
                  )
                })
              : Promise.reject(new TypeError('terminated'));
          },
          releaseLock: (): void => undefined
        })
      }
    }));
    const router = new ChatRouter(settings, noSignIn, noNotebook);

    await expect(
      router.route('hi', [], undefined, () => undefined)
    ).rejects.toMatchObject({
      name: 'ChatRouterError',
      message:
        'The connection to Oceanum AI was lost before the response was complete.'
    });
  });

  it('streams the observe round too', async () => {
    answering(() =>
      streamed([
        frame('status', { phase: 'interpreting' }),
        frame('done', { message: 'Read it.', blocks: [] })
      ])
    );
    const progress: unknown[] = [];
    const router = new ChatRouter(settings, noSignIn, noNotebook);

    const response = await router.observe(
      'hi',
      [],
      [{ code: 'x', status: 'ok', stdout: '', error: null, message: 'm' }],
      undefined,
      p => progress.push(p)
    );

    expect(sentHeaders?.Accept).toBe('text/event-stream');
    expect(progress).toEqual([{ phase: 'interpreting' }]);
    expect(response).toEqual({ message: 'Read it.', blocks: [] });
  });

  it('stops in the middle of the stream when the request is aborted', async () => {
    const controller = new AbortController();
    answering(init =>
      streamed([frame('status', { phase: 'generating' })], init.signal, true)
    );
    const progress: unknown[] = [];
    const router = new ChatRouter(settings, noSignIn, noNotebook);

    const pending = router.route('hi', [], controller.signal, p =>
      progress.push(p)
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toEqual([{ phase: 'generating' }]);
  });
});

describe('ChatRouter: where a request goes, and what it is signed with', () => {
  const noNotebook = async (): Promise<null> => null;
  /** Oceanum Notebook with sign-in configured, and someone signed in. */
  const signedIn = (token: () => unknown) =>
    hostCommands(
      {
        'oceanum-auth:access-token': token,
        'oceanum-auth:sign-in': () => undefined,
        'oceanum-auth:sign-out': () => undefined
      },
      {
        enabled: ['oceanum-auth:sign-in'],
        visible: ['oceanum-auth:sign-out']
      }
    );

  it('sends a pasted token as X-Datamesh-Token to the default backend', async () => {
    const router = new ChatRouter(settings, noSignIn, noNotebook);

    await router.route('hello');

    expect(sentUrl).toBe('https://ai.oceanum.io/api/chat');
    expect(sentHeaders?.['X-Datamesh-Token']).toBe('a-token');
    expect(sentHeaders?.Authorization).toBeUndefined();
  });

  it('prefers a pasted token over the sign-in, without asking for it', async () => {
    // An explicit token is the user's choice, as it is in the kernel.
    const host = signedIn(() => 'a-jwt');
    const router = new ChatRouter(settings, host, noNotebook);

    await router.route('hello');

    expect(sentHeaders?.['X-Datamesh-Token']).toBe('a-token');
    expect(sentHeaders?.Authorization).toBeUndefined();
    expect(host.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['no', undefined],
    ['an empty', ''],
    ['a blank', '   ']
  ])(
    'uses the sign-in as a bearer token with %s pasted token',
    async (_, token) => {
      const router = new ChatRouter(
        settingsWith({ datameshToken: token }),
        signedIn(() => 'a-jwt'),
        noNotebook
      );

      await router.route('hello');

      expect(sentHeaders?.Authorization).toBe('Bearer a-jwt');
      expect(sentHeaders?.['X-Datamesh-Token']).toBeUndefined();
    }
  );

  it('asks for the sign-in on every request, so a refreshed token is used', async () => {
    let token = 'first-jwt';
    const router = new ChatRouter(
      settingsWith({}),
      signedIn(() => token),
      noNotebook
    );

    await router.route('one');
    expect(sentHeaders?.Authorization).toBe('Bearer first-jwt');

    token = 'second-jwt';
    await router.observe('two', [], []);
    expect(sentHeaders?.Authorization).toBe('Bearer second-jwt');
  });

  it('sends to the configured address, without a double slash', async () => {
    const router = new ChatRouter(
      settingsWith({
        datameshToken: 'a-token',
        aiBackendUrl: ' https://ai.oceanum.tech/ '
      }),
      noSignIn,
      noNotebook
    );

    await router.route('hello');
    expect(sentUrl).toBe('https://ai.oceanum.tech/api/chat');

    await router.observe('hello', [], []);
    expect(sentUrl).toBe('https://ai.oceanum.tech/api/chat/observe');
  });

  it('sends to the default for an invalid address', async () => {
    const router = new ChatRouter(
      settingsWith({
        datameshToken: 'a-token',
        aiBackendUrl: 'javascript:alert(1)'
      }),
      noSignIn,
      noNotebook
    );

    await router.route('hello');

    expect(sentUrl).toBe('https://ai.oceanum.io/api/chat');
  });

  it('asks the user to sign in when the host can sign in and nobody has', async () => {
    const router = new ChatRouter(
      settingsWith({}),
      signedIn(() => null),
      noNotebook
    );

    await expect(router.route('hello')).rejects.toMatchObject({
      name: 'ChatRouterError',
      message: expect.stringContaining('Sign in to Oceanum.io')
    });
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });

  it('asks for a Datamesh token when the host has no sign-in', async () => {
    const router = new ChatRouter(settingsWith({}), noSignIn, noNotebook);

    await expect(router.route('hello')).rejects.toThrow(
      'Datamesh token not configured. Set your token in Settings → Oceanum.io.'
    );
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });

  it('asks for a Datamesh token where the site has sign-in disabled', async () => {
    // The command is there, but the site has no Oceanum.io environment, so
    // telling the user to sign in would be telling them to do the impossible.
    const router = new ChatRouter(
      settingsWith({}),
      hostCommands({
        'oceanum-auth:access-token': () => null,
        'oceanum-auth:sign-in': () => undefined
      }),
      noNotebook
    );

    await expect(router.route('hello')).rejects.toThrow(
      'Datamesh token not configured. Set your token in Settings → Oceanum.io.'
    );
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('no'))],
    ['answers with something other than a string', () => ({ token: 'x' })]
  ])('counts a sign-in command that %s as signed out', async (_, answer) => {
    const router = new ChatRouter(
      settingsWith({}),
      signedIn(answer),
      noNotebook
    );

    await expect(router.route('hello')).rejects.toThrow(
      'Sign in to Oceanum.io'
    );
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });

  it('says the sign-in was refused on a 401 with the sign-in', async () => {
    answering(() => ({ ok: false, status: 401 }));
    const router = new ChatRouter(
      settingsWith({}),
      signedIn(() => 'a-jwt'),
      noNotebook
    );

    await expect(router.route('hello')).rejects.toMatchObject({
      message:
        'Your Oceanum.io sign-in was not accepted. Sign in to Oceanum.io again.',
      statusCode: 401
    });
  });

  it('says the token was refused on a 401 with a pasted token', async () => {
    answering(() => ({ ok: false, status: 401 }));

    await expect(
      new ChatRouter(settings, noSignIn, noNotebook).route('hello')
    ).rejects.toMatchObject({
      message: 'Invalid or expired Datamesh token.',
      statusCode: 401
    });
    // Where the host can sign in, the pasted token is what stands in the way.
    await expect(
      new ChatRouter(
        settings,
        signedIn(() => 'a-jwt'),
        noNotebook
      ).route('hello')
    ).rejects.toThrow('clear it to use your Oceanum.io sign-in');
  });

  it('names the configured address when it cannot be reached', async () => {
    (globalThis as any).fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const router = new ChatRouter(
      settingsWith({
        datameshToken: 'a-token',
        aiBackendUrl: 'http://localhost:8000/'
      }),
      noSignIn,
      noNotebook
    );

    await expect(router.route('hello')).rejects.toThrow(
      'Could not reach Oceanum AI backend at http://localhost:8000. Is it running?'
    );
  });
});

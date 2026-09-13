import { ChatRouter } from '../chatRouter';
import type { INotebookSnapshot } from '../notebookContext';

const settings = {
  get: () => ({ composite: 'a-token' })
} as unknown as ConstructorParameters<typeof ChatRouter>[0];

const snapshot = (
  cells: INotebookSnapshot['cells'],
  selected: INotebookSnapshot['selected'] = null
): INotebookSnapshot => ({ cells, selected });

let sent: Record<string, unknown> | undefined;
let sentHeaders: Record<string, string> | undefined;

interface IRequestInit {
  body: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/** Answer every request with what `response` builds from it. */
function answering(response: (init: IRequestInit) => unknown): void {
  (globalThis as any).fetch = jest.fn(
    async (_url: string, init: IRequestInit) => {
      sent = JSON.parse(init.body);
      sentHeaders = init.headers;
      return response(init);
    }
  );
}

beforeEach(() => {
  sent = undefined;
  sentHeaders = undefined;
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
    const router = new ChatRouter(settings, async () =>
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
    const router = new ChatRouter(settings, async () =>
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
    const router = new ChatRouter(settings, async () => current);

    await router.route('one');
    expect(sent?.notebookCells).toEqual(['a = 1']);

    current = snapshot([{ kind: 'code', source: 'b = 2' }]);
    await router.route('two');
    expect(sent?.notebookCells).toEqual(['b = 2']);
  });

  it('sends no notebook when there is none', async () => {
    const router = new ChatRouter(settings, async () => null);

    await router.route('hello');

    expect(sent?.notebookCells).toBeUndefined();
    expect(sent?.codeContext).toBeUndefined();
    expect(sent?.context).toBeUndefined();
  });

  it('still sends the question when the notebook cannot be read', async () => {
    // Context is best-effort; a notebook that could not be read must not
    // cost the user the answer.
    const router = new ChatRouter(settings, async () => {
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
    const router = new ChatRouter(settings, noNotebook);

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
    const router = new ChatRouter(settings, noNotebook);

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
    const router = new ChatRouter(settings, noNotebook);

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
    const router = new ChatRouter(settings, noNotebook);

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
    const router = new ChatRouter(settings, noNotebook);

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
    const router = new ChatRouter(settings, noNotebook);

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
    const router = new ChatRouter(settings, noNotebook);

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
    const router = new ChatRouter(settings, noNotebook);

    const pending = router.route('hi', [], controller.signal, p =>
      progress.push(p)
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toEqual([{ phase: 'generating' }]);
  });
});

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

beforeEach(() => {
  sent = undefined;
  (globalThis as any).fetch = jest.fn(
    async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => ({ message: 'ok', blocks: [] })
      };
    }
  );
});

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

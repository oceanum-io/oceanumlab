import { ChatRouter } from '../chatRouter';

interface IFakeCell {
  model: { type: string; sharedModel: { getSource: () => string } };
}

type RouterNotebook = Awaited<
  ReturnType<ConstructorParameters<typeof ChatRouter>[1]>
>;

const cell = (type: string, source: string): IFakeCell => ({
  model: { type, sharedModel: { getSource: () => source } }
});

const notebook = (
  cells: IFakeCell[],
  activeCell: IFakeCell | null = null
): RouterNotebook =>
  ({ widgets: cells, activeCell }) as unknown as RouterNotebook;

const settings = {
  get: () => ({ composite: 'a-token' })
} as unknown as ConstructorParameters<typeof ChatRouter>[0];

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
  it('is the conversation notebook, code and markdown, raw cells left out', async () => {
    const pinned = notebook([
      cell('code', 'x = 1'),
      cell('markdown', '## Notes'),
      cell('raw', 'not python, not prose'),
      cell('code', 'y = x')
    ]);
    const router = new ChatRouter(settings, async () => pinned);

    await router.route('what does this do?');

    expect(sent?.notebookCells).toEqual([
      'x = 1',
      '# %% [markdown]\n# ## Notes',
      'y = x'
    ]);
  });

  it('carries the selected cell of that notebook, which a code answer may replace', async () => {
    const selected = cell('code', 'df.head()');
    const router = new ChatRouter(settings, async () =>
      notebook([selected], selected)
    );

    const result = await router.route('fix this');

    expect(sent?.codeContext).toBe('df.head()');
    expect(result.hasCodeCellSelected).toBe(true);
  });

  it('asks for the notebook on every request, so it follows the conversation', async () => {
    let current = notebook([cell('code', 'a = 1')]);
    const router = new ChatRouter(settings, async () => current);

    await router.route('one');
    expect(sent?.notebookCells).toEqual(['a = 1']);

    current = notebook([cell('code', 'b = 2')]);
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

  it('still sends the question when the notebook cannot be had', async () => {
    // Context is best-effort; a notebook that could not be opened must not
    // cost the user the answer.
    const router = new ChatRouter(settings, async () => {
      throw new Error('could not open');
    });

    await router.route('hello');

    expect(sent?.prompt).toBe('hello');
    expect(sent?.notebookCells).toBeUndefined();
  });
});

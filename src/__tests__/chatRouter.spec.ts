import { ChatRouter, IChatNotebook } from '../chatRouter';

interface IFakeCell {
  model: { type: string; sharedModel: { getSource: () => string } };
}

const cell = (type: string, source: string): IFakeCell => ({
  model: { type, sharedModel: { getSource: () => source } }
});

const notebook = (
  cells: IFakeCell[],
  activeCell: IFakeCell | null = null
): IChatNotebook['notebook'] =>
  ({ widgets: cells, activeCell }) as unknown as IChatNotebook['notebook'];

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
  it('is the pinned notebook, code and markdown, whatever tab is active', async () => {
    const pinned = notebook([
      cell('code', 'x = 1'),
      cell('markdown', '## Notes'),
      cell('raw', 'not python, not prose'),
      cell('code', 'y = x')
    ]);
    const router = new ChatRouter(settings, () => ({
      notebook: pinned,
      receivesAnswers: false
    }));

    await router.route('what does this do?');

    expect(sent?.notebookCells).toEqual([
      'x = 1',
      '# %% [markdown]\n# ## Notes',
      'y = x'
    ]);
  });

  it('carries the selected cell only when answers land in that notebook', async () => {
    // The server treats a selected code cell as the one its answer replaces,
    // and KernelHandoff replaces the selected cell of the notebook it places
    // into. From any other notebook, that edit would land in the wrong place.
    const selected = cell('code', 'df.head()');
    const pinned = notebook([selected], selected);

    let receivesAnswers = true;
    const router = new ChatRouter(settings, () => ({
      notebook: pinned,
      receivesAnswers
    }));

    const placing = await router.route('fix this');
    expect(sent?.codeContext).toBe('df.head()');
    expect(placing.hasCodeCellSelected).toBe(true);

    receivesAnswers = false;
    const elsewhere = await router.route('fix this');
    expect(sent?.codeContext).toBeUndefined();
    expect(sent?.context).toBeUndefined();
    expect(elsewhere.hasCodeCellSelected).toBe(false);
  });

  it('sends no notebook when the conversation has none', async () => {
    const router = new ChatRouter(settings, () => null);

    await router.route('hello');

    expect(sent?.notebookCells).toBeUndefined();
    expect(sent?.codeContext).toBeUndefined();
    expect(sent?.context).toBeUndefined();
  });
});

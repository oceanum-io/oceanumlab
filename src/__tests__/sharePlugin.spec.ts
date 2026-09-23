/**
 * The share plugin's commands, driven through a real CommandRegistry against fakes.
 *
 * These cover what reading cannot: which record or notebook a command decides to act
 * on. Two of them are regressions for defects a review found, both marked below.
 */
import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { INotebookContent } from '@jupyterlab/nbformat';
import type { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { CommandRegistry } from '@lumino/commands';
import type { Widget } from '@lumino/widgets';
import { Signal } from '@lumino/signaling';

import type { IOceanumAuth, IOceanumUser } from '../auth/tokens';
import type { ISpecRecord } from '../share/notebook';
import { CommandIDs, sharePlugin } from '../share/plugin';

/** What every dialog answers. Accepting with no value is "chose nothing". */
const mockDialog: { accept: boolean; value: unknown } = {
  accept: true,
  value: null
};

jest.mock('@jupyterlab/apputils', () => {
  const actual = jest.requireActual('@jupyterlab/apputils');
  const answer = async () => ({
    button: { accept: mockDialog.accept },
    value: mockDialog.value
  });
  const quiet = (): void => undefined;
  return {
    ...actual,
    showDialog: answer,
    InputDialog: { ...actual.InputDialog, getText: answer },
    Notification: {
      ...actual.Notification,
      error: quiet,
      success: quiet,
      warning: quiet,
      info: quiet
    }
  };
});

/** What the file picker answers: a file, or null for a cancelled picker. */
const mockPicked: { file: { name: string; text: string } | null } = {
  file: null
};
const mockPickerCalls = { count: 0 };

jest.mock('../share/upload', () => ({
  chooseNotebookFile: async () => {
    mockPickerCalls.count++;
    const picked = mockPicked.file;
    return picked && { name: picked.name, text: async () => picked.text };
  }
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  mockPicked.file = null;
  mockPickerCalls.count = 0;
  globalThis.fetch = originalFetch;
  mockDialog.accept = true;
  mockDialog.value = null;
});

const SPECS = 'https://specs.example.com';
const ID_A = '6f1c1a52-4b8e-4c0f-9a57-1d2e3f4a5b6c';
const ID_B = '0b7d9f2e-1111-4a2b-8c3d-9e8f7a6b5c4d';

const USER: IOceanumUser = {
  sub: 'auth0|1',
  email: 'me@example.com',
  name: null,
  activeOrg: null,
  colorScheme: null
};

const notebook = (link?: string): INotebookContent => ({
  nbformat: 4,
  nbformat_minor: 5,
  cells: [],
  metadata: link ? { oceanum: { spec_id: link, specs_url: SPECS } } : {}
});

const record = (id: string, name: string): ISpecRecord => ({
  id,
  name,
  description: null,
  modified: '2026-09-12T10:00:00',
  creator: 'me@example.com',
  spec: notebook()
});

/**
 * Records the spec store calls a command makes, and answers them. A record holds
 * `stored[id]` when given, else an empty notebook.
 */
function store(stored: Record<string, INotebookContent> = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const names: Record<string, string> = { [ID_A]: 'Alpha', [ID_B]: 'Beta' };
  const fetcher = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const id = url.split('/').pop() ?? '';
    calls.push(`${method} ${id}`);
    if (init?.body) {
      bodies.push(JSON.parse(String(init.body)));
    }
    return {
      ok: true,
      status: method === 'DELETE' ? 204 : 200,
      json: async () =>
        method === 'GET' && id === 'notebook'
          ? [record(ID_A, 'Alpha'), record(ID_B, 'Beta')]
          : {
              ...record(id, names[id] ?? 'Alpha'),
              spec: stored[id] ?? notebook()
            }
    } as unknown as Response;
  };
  return { calls, bodies, fetcher };
}

/** A notebook panel with just the surface the plugin touches. */
function panel(id: string, path: string, link?: string): NotebookPanel {
  const saveState = new Signal<unknown, string>({});
  const metadata: Record<string, unknown> = link
    ? { oceanum: { spec_id: link, specs_url: SPECS } }
    : {};
  return {
    id,
    context: {
      path,
      ready: Promise.resolve(),
      saveState,
      save: async (): Promise<void> => undefined,
      model: {
        toJSON: () => notebook(link),
        getMetadata: (key: string) => metadata[key],
        setMetadata: (key: string, value: unknown) => {
          metadata[key] = value;
        },
        deleteMetadata: (key: string) => {
          delete metadata[key];
        },
        dirty: false
      }
    }
  } as unknown as NotebookPanel;
}

interface IHarness {
  commands: CommandRegistry;
  calls: string[];
  bodies: Record<string, unknown>[];
  saved: string[];
  /** What each save wrote, by path. */
  written: Record<string, unknown>;
  opened: string[];
  /** The widgets `openOrReveal` returned, in order; set `isDisposed` to close one. */
  widgets: { id: string; isDisposed: boolean }[];
  activated: string[];
  renamed: [string, string][];
  /** What a right-click last landed on; never cleared, as JupyterLab does not. */
  setHit: (node: HTMLElement | null) => void;
  setCurrent: (panel: NotebookPanel | null) => void;
}

function activate(
  options: {
    user?: IOceanumUser | null;
    panels?: NotebookPanel[];
    current?: NotebookPanel | null;
    folder?: Record<string, unknown>;
    stored?: Record<string, INotebookContent>;
  } = {}
): IHarness {
  const commands = new CommandRegistry();
  const { calls, bodies, fetcher } = store(options.stored);
  const saved: string[] = [];
  const written: Record<string, unknown> = {};
  const opened: string[] = [];
  const widgets: { id: string; isDisposed: boolean }[] = [];
  const activated: string[] = [];
  const renamed: [string, string][] = [];
  const panels = options.panels ?? [];
  let current = options.current ?? null;
  let hit: HTMLElement | null = null;
  const folder = options.folder ?? {};

  const auth = {
    environment: { fileManagement: 'local' },
    urls: { specs: SPECS },
    ready: Promise.resolve(),
    user: options.user === undefined ? USER : options.user,
    userChanged: new Signal<IOceanumAuth, IOceanumUser | null>(
      {} as IOceanumAuth
    ),
    tokenChanged: new Signal<IOceanumAuth, string | null>({} as IOceanumAuth),
    signIn: async (): Promise<void> => undefined,
    signOut: async (): Promise<void> => undefined,
    getAccessToken: async (): Promise<string> => 'tok'
  } as unknown as IOceanumAuth;

  const app = {
    commands,
    restored: Promise.resolve(),
    shell: {
      get currentWidget() {
        return current;
      },
      activateById: (id: string): void => {
        activated.push(id);
      },
      widgets: (): Widget[] => []
    },
    contextMenu: { addItem: (): void => undefined },
    contextMenuHitTest: (test: (node: HTMLElement) => boolean) => {
      for (let node = hit; node; node = node.parentElement) {
        if (test(node)) {
          return node;
        }
      }
      return undefined;
    }
  } as unknown as JupyterFrontEnd;

  const contents = {
    get: async (path: string) => {
      if (path === 'Oceanum') {
        return {
          type: 'directory',
          content: Object.keys(folder).map(name => ({ name }))
        };
      }
      const name = path.replace('Oceanum/', '');
      if (!(name in folder)) {
        throw new Error('not found');
      }
      return { type: 'notebook', content: folder[name] };
    },
    save: async (path: string, model?: { content?: unknown }) => {
      saved.push(path);
      written[path] = model?.content;
      // Like the real drive, the folder lists the file from now on.
      if (path.startsWith('Oceanum/')) {
        folder[path.replace('Oceanum/', '')] = model?.content;
      }
      return { path };
    },
    newUntitled: async () => ({ path: 'Untitled Folder' }),
    rename: async () => ({ path: 'Oceanum' })
  };
  const docManager = {
    services: { contents },
    openOrReveal: (path: string) => {
      opened.push(path);
      const widget = { id: `widget-${widgets.length}`, isDisposed: false };
      widgets.push(widget);
      return widget;
    },
    rename: async (from: string, to: string): Promise<void> => {
      renamed.push([from, to]);
    },
    deleteFile: async (): Promise<void> => undefined
  } as unknown as IDocumentManager;

  const tracker = {
    currentWidget: null as NotebookPanel | null,
    forEach: (fn: (p: NotebookPanel) => void) => panels.forEach(fn),
    find: (test: (p: NotebookPanel) => boolean) => panels.find(test) ?? null,
    widgetAdded: new Signal<INotebookTracker, NotebookPanel>(
      {} as INotebookTracker
    ),
    currentChanged: new Signal<INotebookTracker, NotebookPanel | null>(
      {} as INotebookTracker
    )
  } as unknown as INotebookTracker;
  (tracker as { currentWidget: NotebookPanel | null }).currentWidget = current;

  // The plugin builds its own client; point its fetch at the fake store. A top-level
  // afterEach puts the real one back.
  globalThis.fetch = fetcher as unknown as typeof fetch;

  const palette = { addItem: (): void => undefined };
  sharePlugin.activate(
    app,
    auth,
    docManager,
    tracker,
    palette,
    null,
    null
  ) as void;

  return {
    commands,
    calls,
    bodies,
    saved,
    written,
    opened,
    widgets,
    activated,
    renamed,
    setHit: node => {
      hit = node;
    },
    setCurrent: value => {
      current = value;
      (tracker as { currentWidget: NotebookPanel | null }).currentWidget =
        value;
    }
  };
}

describe('renaming a record', () => {
  it('patches just the name, and moves the open notebook to match', async () => {
    const open = panel('panel-a', 'notebooks/Alpha.ipynb', ID_A);
    const harness = activate({ current: open, panels: [open] });
    mockDialog.value = 'Renamed';

    await harness.commands.execute(CommandIDs.rename, { id: ID_A });

    // Read once for the dialog's current name, then one patch. No PUT: the notebook
    // is not sent back, so a change another writer made to it cannot be overwritten.
    expect(harness.calls).toEqual([`GET ${ID_A}`, `PATCH ${ID_A}`]);
    expect(harness.bodies).toEqual([{ name: 'Renamed' }]);
    expect(harness.renamed).toEqual([
      ['notebooks/Alpha.ipynb', 'notebooks/Renamed.ipynb']
    ]);
  });

  it('leaves everything alone when the name is unchanged', async () => {
    const harness = activate();
    mockDialog.value = 'Alpha';

    await harness.commands.execute(CommandIDs.rename, { id: ID_A });

    expect(harness.calls).toEqual([`GET ${ID_A}`]);
  });
});

/** A Notebooks tab row, as StoredNotebooks renders it. */
function row(id: string): HTMLElement {
  const node = document.createElement('button');
  node.className = 'oceanum-notebooks-item';
  node.setAttribute('data-spec-id', id);
  return node;
}

describe('the share commands, invoked from the File menu or the palette', () => {
  // Regression: JupyterLab keeps the last contextmenu event for the life of the page
  // and never clears it, so a hit test answers long after its menu has gone. Reading
  // it unconditionally let the last right-clicked row decide what File > … acted on.
  it('ignore a row that was right-clicked earlier', async () => {
    const current = panel('panel-a', 'notebooks/Alpha.ipynb', ID_A);
    const harness = activate({ current, panels: [current] });
    harness.setHit(row(ID_B));

    expect(harness.commands.label(CommandIDs.open)).toBe('Open from Oceanum…');
    expect(harness.commands.label(CommandIDs.delete)).toBe(
      'Delete from Oceanum'
    );

    await harness.commands.execute(CommandIDs.delete);

    // The current notebook's record, not the stale row's.
    expect(harness.calls).toContain(`GET ${ID_A}`);
    expect(harness.calls).not.toContain(`GET ${ID_B}`);
  });

  it('ignore a tab that was right-clicked earlier when saving', async () => {
    const a = panel('panel-a', 'notebooks/Alpha.ipynb', ID_A);
    const b = panel('panel-b', 'notebooks/Beta.ipynb', ID_B);
    const harness = activate({ current: b, panels: [a, b] });
    const tab = document.createElement('li');
    tab.dataset.id = 'panel-a';
    harness.setHit(tab);

    await harness.commands.execute(CommandIDs.save);

    expect(harness.calls).toEqual([`PUT ${ID_B}`]);
  });

  it('open the picker rather than a stale row', async () => {
    const harness = activate();
    harness.setHit(row(ID_B));

    await harness.commands.execute(CommandIDs.open);

    // The picker lists; it does not read one record.
    expect(harness.calls).toEqual(['GET notebook']);
  });
});

describe('the share commands, invoked from a Notebooks row', () => {
  it('act on the row under the pointer', async () => {
    const harness = activate();
    harness.setHit(row(ID_B));

    expect(harness.commands.label(CommandIDs.open, { source: 'row' })).toBe(
      'Open'
    );
    expect(
      harness.commands.isEnabled(CommandIDs.delete, { source: 'row' })
    ).toBe(true);

    await harness.commands.execute(CommandIDs.open, { source: 'row' });

    expect(harness.calls).toContain(`GET ${ID_B}`);
  });

  it('are disabled while signed out', async () => {
    const harness = activate({ user: null });
    harness.setHit(row(ID_B));

    for (const command of Object.values(CommandIDs)) {
      expect(harness.commands.isEnabled(command, { source: 'row' })).toBe(
        false
      );
    }
  });
});

describe('opening a record whose local copy already exists', () => {
  // Regression: a second copy is named "<name> (1)", and a record takes its name from
  // its file on every save, so opening the same notebook twice renamed it on Oceanum.
  it('reuses the file an earlier session left, so the record keeps its name', async () => {
    const harness = activate({
      folder: { 'Alpha.ipynb': notebook(ID_A) }
    });

    await harness.commands.execute(CommandIDs.open, { id: ID_A });

    expect(harness.saved).toEqual(['Oceanum/Alpha.ipynb']);
    expect(harness.opened).toEqual(['Oceanum/Alpha.ipynb']);
  });

  it('finds the copy under a numbered name too', async () => {
    const harness = activate({
      folder: {
        'Alpha.ipynb': notebook(ID_B),
        'Alpha (1).ipynb': notebook(ID_A)
      }
    });

    await harness.commands.execute(CommandIDs.open, { id: ID_A });

    expect(harness.saved).toEqual(['Oceanum/Alpha (1).ipynb']);
  });

  it('still takes a free name when the file belongs to another record', async () => {
    const harness = activate({
      folder: { 'Alpha.ipynb': notebook(ID_B) }
    });

    await harness.commands.execute(CommandIDs.open, { id: ID_A });

    expect(harness.saved).toEqual(['Oceanum/Alpha (1).ipynb']);
  });
});

describe('opening an example', () => {
  // As stored on Oceanum: linked to its own record, with a trusted cell.
  const example: INotebookContent = {
    ...notebook(ID_A),
    cells: [
      {
        cell_type: 'code',
        source: 'print(1)',
        metadata: { trusted: true },
        outputs: [],
        execution_count: null
      }
    ]
  };

  it('writes an untrusted copy linked to nothing, named from its title', async () => {
    const harness = activate({ stored: { [ID_A]: example } });

    await harness.commands.execute(CommandIDs.openExample, {
      id: ID_A,
      title: 'Query a datasource'
    });

    // Read, never written back: the example's record is Oceanum's.
    expect(harness.calls).toEqual([`GET ${ID_A}`]);
    const path = 'Oceanum/Query a datasource.ipynb';
    expect(harness.saved).toEqual([path]);
    expect(harness.opened).toEqual([path]);
    const content = harness.written[path] as INotebookContent;
    // A linked copy's first save would PUT to the example's record and be refused.
    expect(content.metadata).not.toHaveProperty('oceanum');
    expect(content.cells[0].metadata).toEqual({});
  });

  it('never overwrites a file already there', async () => {
    const harness = activate({
      folder: { 'Query a datasource.ipynb': notebook() }
    });

    await harness.commands.execute(CommandIDs.openExample, {
      id: ID_A,
      title: 'Query a datasource'
    });

    expect(harness.saved).toEqual(['Oceanum/Query a datasource (1).ipynb']);
  });

  it('brings its open copy forward instead of writing another', async () => {
    const harness = activate();
    const args = { id: ID_A, title: 'Example' };

    await harness.commands.execute(CommandIDs.openExample, args);
    await harness.commands.execute(CommandIDs.openExample, args);

    expect(harness.saved).toEqual(['Oceanum/Example.ipynb']);
    expect(harness.activated).toEqual([harness.widgets[0].id]);
  });

  it('writes one copy when opened twice before the first finishes', async () => {
    const harness = activate();
    const args = { id: ID_A, title: 'Example' };

    await Promise.all([
      harness.commands.execute(CommandIDs.openExample, args),
      harness.commands.execute(CommandIDs.openExample, args)
    ]);

    expect(harness.saved).toEqual(['Oceanum/Example.ipynb']);
  });

  it('writes a fresh copy once the last one was closed', async () => {
    const harness = activate();
    const args = { id: ID_A, title: 'Example' };

    await harness.commands.execute(CommandIDs.openExample, args);
    harness.widgets[0].isDisposed = true;
    await harness.commands.execute(CommandIDs.openExample, args);

    expect(harness.saved).toEqual([
      'Oceanum/Example.ipynb',
      'Oceanum/Example (1).ipynb'
    ]);
    expect(harness.activated).toEqual([]);
  });

  it('falls back to the record name when given no title', async () => {
    const harness = activate();

    await harness.commands.execute(CommandIDs.openExample, { id: ID_A });

    expect(harness.saved).toEqual(['Oceanum/Alpha.ipynb']);
  });

  it('ignores an id that is not a record id', async () => {
    const harness = activate();

    await harness.commands.execute(CommandIDs.openExample, {
      id: '../eidos',
      title: 'Nope'
    });

    expect(harness.calls).toEqual([]);
    expect(harness.saved).toEqual([]);
  });

  it('is disabled while signed out', () => {
    const harness = activate({ user: null });

    expect(harness.commands.isEnabled(CommandIDs.openExample)).toBe(false);
  });
});

describe('uploading a notebook', () => {
  // As downloaded from someone else's record: linked to it, with a trusted cell.
  const downloaded: INotebookContent = {
    ...notebook(ID_B),
    cells: [
      {
        cell_type: 'code',
        source: 'print(1)',
        metadata: { trusted: true },
        outputs: [],
        execution_count: null
      }
    ]
  };

  it('writes an untrusted copy linked to nothing into the Oceanum folder, and opens it', async () => {
    mockPicked.file = {
      name: 'analysis.ipynb',
      text: JSON.stringify(downloaded)
    };
    const harness = activate();

    await harness.commands.execute(CommandIDs.upload);

    const path = 'Oceanum/analysis.ipynb';
    expect(harness.saved).toEqual([path]);
    expect(harness.opened).toEqual([path]);
    const content = harness.written[path] as INotebookContent;
    // Linked, its first save would write over the record it was downloaded from.
    expect(content.metadata).not.toHaveProperty('oceanum');
    expect(content.cells[0].metadata).toEqual({});
    // Nothing reaches Oceanum until the notebook is saved.
    expect(harness.calls).toEqual([]);
  });

  it('never overwrites a file already there', async () => {
    mockPicked.file = {
      name: 'analysis.ipynb',
      text: JSON.stringify(notebook())
    };
    const harness = activate({ folder: { 'analysis.ipynb': notebook() } });

    await harness.commands.execute(CommandIDs.upload);

    expect(harness.saved).toEqual(['Oceanum/analysis (1).ipynb']);
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['JSON that is not a notebook', JSON.stringify({ cells: [] })],
    ['an nbformat 3 notebook', JSON.stringify({ ...notebook(), nbformat: 3 })]
  ])('writes nothing for %s', async (_, text) => {
    mockPicked.file = { name: 'bad.ipynb', text };
    const harness = activate();

    await harness.commands.execute(CommandIDs.upload);

    expect(harness.saved).toEqual([]);
    expect(harness.opened).toEqual([]);
  });

  it('writes nothing when the picker is cancelled', async () => {
    const harness = activate();

    await harness.commands.execute(CommandIDs.upload);

    expect(mockPickerCalls.count).toBe(1);
    expect(harness.saved).toEqual([]);
  });

  it('asks for sign-in first, and writes nothing when declined', async () => {
    mockPicked.file = { name: 'a.ipynb', text: JSON.stringify(notebook()) };
    mockDialog.accept = false;
    const harness = activate({ user: null });

    await harness.commands.execute(CommandIDs.upload);

    expect(mockPickerCalls.count).toBe(0);
    expect(harness.saved).toEqual([]);
    expect(harness.commands.isEnabled(CommandIDs.upload)).toBe(false);
  });
});

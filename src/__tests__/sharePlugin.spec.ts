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

const originalFetch = globalThis.fetch;
afterEach(() => {
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

/** Records the spec store calls a command makes, and answers them. */
function store() {
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
          : record(id, names[id] ?? 'Alpha')
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
  opened: string[];
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
  } = {}
): IHarness {
  const commands = new CommandRegistry();
  const { calls, bodies, fetcher } = store();
  const saved: string[] = [];
  const opened: string[] = [];
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
      activateById: (): void => undefined,
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
    save: async (path: string) => {
      saved.push(path);
      return { path };
    },
    newUntitled: async () => ({ path: 'Untitled Folder' }),
    rename: async () => ({ path: 'Oceanum' })
  };
  const docManager = {
    services: { contents },
    openOrReveal: (path: string) => {
      opened.push(path);
      return {};
    },
    rename: async (): Promise<void> => undefined,
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
    opened,
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

import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { INotebookTracker } from '@jupyterlab/notebook';
import { NotebookPanel } from '@jupyterlab/notebook';
import { notebookHost } from '../notebookHost';

// The real module pulls in ES-module UI code that jest cannot load; only the
// class, for `instanceof`, is needed here.
jest.mock('@jupyterlab/notebook', () => ({
  NotebookPanel: class NotebookPanel {}
}));

interface IFakeContent {
  widgets: unknown[];
  activeCellIndex: number;
}

/** A notebook panel whose file has not been read yet; `load` reads it. */
function unloaded(
  id: string,
  cells = 3
): { panel: NotebookPanel; content: IFakeContent; load: () => void } {
  let load: () => void = () => undefined;
  const ready = new Promise<void>(resolve => {
    load = resolve;
  });
  const content: IFakeContent = {
    widgets: new Array(cells).fill(null),
    activeCellIndex: 0
  };
  const panel = Object.create(NotebookPanel.prototype) as NotebookPanel;
  Object.defineProperty(panel, 'id', { value: id });
  Object.defineProperty(panel, 'context', { value: { ready } });
  Object.defineProperty(panel, 'content', { value: content });
  return { panel, content, load };
}

function fakeLab(
  execute: (command: string, args: unknown) => Promise<unknown>,
  tracked: unknown[] = []
) {
  const activated: string[] = [];
  const commands = { execute: jest.fn(execute) };
  const shell = {
    currentWidget: null as unknown,
    activateById: (id: string) => {
      activated.push(id);
    }
  };
  const tracker = { has: (widget: unknown) => tracked.includes(widget) };
  return {
    app: { commands, shell } as unknown as JupyterFrontEnd,
    tracker: tracker as unknown as INotebookTracker,
    commands,
    shell,
    activated
  };
}

const flush = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

const never = (): Promise<unknown> => new Promise(() => undefined);

describe('notebookHost: re-opening', () => {
  it('re-opens a notebook only once its file has been read', async () => {
    // Reading the file replaces every cell, so an answer placed before then
    // would be wiped when it arrived.
    const { panel, load } = unloaded('nb');
    const { app, tracker } = fakeLab(async () => panel);
    let result: NotebookPanel | null | undefined;
    void notebookHost(app, tracker)
      .reopen('work/a.ipynb')
      .then(p => {
        result = p;
      });

    await flush();
    expect(result).toBeUndefined();

    load();
    await flush();
    expect(result).toBe(panel);
  });

  it('selects the last cell, so that answers go at the end', async () => {
    // It opens with its first cell selected, and answers go below the
    // selected cell: above the user's work.
    const { panel, content, load } = unloaded('nb', 30);
    const { app, tracker } = fakeLab(async () => panel);
    load();

    await notebookHost(app, tracker).reopen('work/a.ipynb');

    expect(content.activeCellIndex).toBe(29);
  });

  it('gives up on a notebook that never loads, rather than stalling the chat', async () => {
    const { panel } = unloaded('nb');
    const { app, tracker } = fakeLab(async () => panel);

    await expect(
      notebookHost(app, tracker, 10).reopen('work/a.ipynb')
    ).resolves.toBeNull();
  });

  it('gives up on an open that never finishes, rather than stalling the chat', async () => {
    const { app, tracker } = fakeLab(never);

    await expect(
      notebookHost(app, tracker, 10).reopen('work/a.ipynb')
    ).resolves.toBeNull();
  });

  it('reports a notebook that cannot be re-opened as none', async () => {
    const { app, tracker } = fakeLab(async () => {
      throw new Error('not found');
    });

    await expect(
      notebookHost(app, tracker).reopen('work/gone.ipynb')
    ).resolves.toBeNull();
  });
});

describe('notebookHost: creating', () => {
  it('creates a notebook, and brings it to the front once it has loaded', async () => {
    const { panel, load } = unloaded('new');
    const { app, tracker, commands, activated } = fakeLab(async () => panel);
    let result: NotebookPanel | null | undefined;
    void notebookHost(app, tracker)
      .create()
      .then(p => {
        result = p;
      });

    await flush();
    expect(commands.execute).toHaveBeenCalledWith('notebook:create-new', {
      kernelName: 'python3'
    });
    expect(result).toBeUndefined();
    expect(activated).toEqual([]);

    load();
    await flush();
    expect(result).toBe(panel);
    expect(activated).toEqual(['new']);
  });

  it('takes no notebook but the one it created', async () => {
    // Anything else could be a notebook the user opened meanwhile.
    const { app, tracker, activated } = fakeLab(async () => undefined);

    await expect(notebookHost(app, tracker).create()).resolves.toBeNull();
    expect(activated).toEqual([]);
  });

  it('gives up on a notebook that is never created', async () => {
    const { app, tracker, activated } = fakeLab(never);

    await expect(notebookHost(app, tracker, 10).create()).resolves.toBeNull();
    expect(activated).toEqual([]);
  });
});

describe('notebookHost: the active tab', () => {
  it('is the notebook in it, or none when the tab is not a notebook', () => {
    const { panel } = unloaded('nb');
    const { app, tracker, shell } = fakeLab(async () => null, [panel]);
    const host = notebookHost(app, tracker);

    shell.currentWidget = panel;
    expect(host.activeTab()).toBe(panel);

    shell.currentWidget = { id: 'terminal-1' };
    expect(host.activeTab()).toBeNull();
  });
});

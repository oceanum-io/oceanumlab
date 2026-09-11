import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { INotebookTracker } from '@jupyterlab/notebook';
import { NotebookPanel } from '@jupyterlab/notebook';
import { notebookHost } from '../notebookHost';

// The real module pulls in ES-module UI code that jest cannot load; only the
// class, for `instanceof`, is needed here.
jest.mock('@jupyterlab/notebook', () => ({
  NotebookPanel: class NotebookPanel {}
}));

/** A notebook panel whose file has not been read yet; `load` reads it. */
function unloaded(id: string): { panel: NotebookPanel; load: () => void } {
  let load: () => void = () => undefined;
  const ready = new Promise<void>(resolve => {
    load = resolve;
  });
  const panel = Object.create(NotebookPanel.prototype) as NotebookPanel;
  Object.defineProperty(panel, 'id', { value: id });
  Object.defineProperty(panel, 'context', { value: { ready } });
  return { panel, load };
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
  const tracker = {
    has: (widget: unknown) => tracked.includes(widget),
    widgetAdded: { connect: jest.fn(), disconnect: jest.fn() }
  };
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

describe('notebookHost', () => {
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

  it('gives up on a notebook that never loads, rather than stalling the chat', async () => {
    const { panel } = unloaded('nb');
    const { app, tracker } = fakeLab(async () => panel);

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

  it('gives up on a notebook that is never created', async () => {
    const { app, tracker, activated } = fakeLab(
      () => new Promise(() => undefined)
    );

    await expect(notebookHost(app, tracker, 10).create()).resolves.toBeNull();
    expect(activated).toEqual([]);
  });

  it('finds the notebook in the active tab, and none when the tab is not one', () => {
    const { panel } = unloaded('nb');
    const { app, tracker, shell } = fakeLab(async () => null, [panel]);
    const host = notebookHost(app, tracker);

    shell.currentWidget = panel;
    expect(host.activeTab()).toBe(panel);

    shell.currentWidget = { id: 'terminal-1' };
    expect(host.activeTab()).toBeNull();
  });
});

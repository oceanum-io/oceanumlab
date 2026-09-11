import type { NotebookPanel } from '@jupyterlab/notebook';
import { ConversationPin, INotebookHost } from '../conversationPin';

type Slot = (sender: unknown, path: string) => void;

interface IFakePanel {
  id: string;
  isDisposed: boolean;
  title: { label: string };
  context: {
    path: string;
    pathChanged: {
      slots: Array<[Slot, unknown]>;
      connect(slot: Slot, thisArg: unknown): void;
      disconnect(slot: Slot, thisArg: unknown): void;
    };
  };
}

const panel = (path: string): IFakePanel => {
  const slots: Array<[Slot, unknown]> = [];
  return {
    id: `id:${path}`,
    isDisposed: false,
    title: { label: path.split('/').pop() ?? path },
    context: {
      path,
      pathChanged: {
        slots,
        connect: (slot, thisArg) => slots.push([slot, thisArg]),
        disconnect: (slot, thisArg) => {
          const at = slots.findIndex(([s, t]) => s === slot && t === thisArg);
          if (at >= 0) {
            slots.splice(at, 1);
          }
        }
      }
    }
  };
};

/** JupyterLab renaming or moving an open notebook. */
const rename = (p: IFakePanel, path: string): void => {
  p.context.path = path;
  p.title.label = path.split('/').pop() ?? path;
  for (const [slot, thisArg] of [...p.context.pathChanged.slots]) {
    slot.call(thisArg, p.context, path);
  }
};

const asPanel = (p: IFakePanel | null) => p as unknown as NotebookPanel | null;

describe('ConversationPin', () => {
  let active: IFakePanel | null;
  let created: number;
  let onDisk: Set<string>;
  let host: jest.Mocked<INotebookHost>;
  let pin: ConversationPin;

  beforeEach(() => {
    active = null;
    created = 0;
    onDisk = new Set();
    host = {
      activeTab: jest.fn(() => asPanel(active)),
      // Like notebook:create-new: the new notebook becomes the active tab.
      create: jest.fn(async () => {
        created += 1;
        active = panel(`Untitled${created}.ipynb`);
        return asPanel(active);
      }),
      reopen: jest.fn(async (path: string) =>
        asPanel(onDisk.has(path) ? panel(path) : null)
      ),
      activate: jest.fn()
    };
    pin = new ConversationPin(host);
  });

  it('pins the notebook in the active tab when a conversation starts', async () => {
    active = panel('work/a.ipynb');
    await expect(pin.start()).resolves.toBe('a.ipynb');
    expect(host.create).not.toHaveBeenCalled();
  });

  it('creates a notebook when the active tab is not one, and pins it', async () => {
    await expect(pin.start()).resolves.toBe('Untitled1.ipynb');
    expect(host.create).toHaveBeenCalledTimes(1);
    await expect(pin.notebook()).resolves.toBe(active);
  });

  it('starts an unstarted conversation at its first message, the same way', async () => {
    await expect(pin.ensure()).resolves.toBe('Untitled1.ipynb');
    await expect(pin.ensure()).resolves.toBe('Untitled1.ipynb');
    expect(host.create).toHaveBeenCalledTimes(1);
  });

  it('keeps the pin for the whole conversation, whatever tab is active', async () => {
    const a = panel('a.ipynb');
    active = a;
    await pin.start();

    active = panel('b.ipynb');
    await expect(pin.ensure()).resolves.toBe('a.ipynb');
    await expect(pin.current()).resolves.toBe(a);
    await expect(pin.notebook()).resolves.toBe(a);
  });

  it('creates one notebook for two New chats in quick succession', async () => {
    // The second must find the notebook the first created as the active tab.
    const [first, second] = await Promise.all([pin.start(), pin.start()]);
    expect(host.create).toHaveBeenCalledTimes(1);
    expect(first).toBe('Untitled1.ipynb');
    expect(second).toBe('Untitled1.ipynb');
  });

  it('does not reopen a closed notebook just to be asked about', async () => {
    // Re-opening the tab is for an answer that has cells to place.
    const a = panel('work/a.ipynb');
    onDisk.add('work/a.ipynb');
    active = a;
    await pin.start();

    a.isDisposed = true;
    await expect(pin.current()).resolves.toBeNull();
    expect(pin.path()).toBe('work/a.ipynb');
    expect(host.reopen).not.toHaveBeenCalled();
  });

  it('opens a closed notebook again, from where it was, to place an answer', async () => {
    const a = panel('work/a.ipynb');
    onDisk.add('work/a.ipynb');
    active = a;
    await pin.start();

    a.isDisposed = true;
    active = null;
    const reopened = await pin.notebook();

    expect(host.reopen).toHaveBeenCalledWith('work/a.ipynb');
    expect(reopened).not.toBe(a);
    expect(pin.name()).toBe('a.ipynb');
    expect(host.create).not.toHaveBeenCalled();
  });

  it('reports the last known name while the notebook is closed', async () => {
    const a = panel('work/a.ipynb');
    active = a;
    await pin.start();
    a.isDisposed = true;
    expect(pin.name()).toBe('a.ipynb');
  });

  it('follows a rename made while the notebook was open', async () => {
    // Renamed and then closed with no request in between: found under the
    // new name, not replaced by a new notebook.
    const a = panel('work/a.ipynb');
    onDisk.add('work/renamed.ipynb');
    active = a;
    await pin.start();

    rename(a, 'work/renamed.ipynb');
    a.isDisposed = true;
    await pin.notebook();

    expect(host.reopen).toHaveBeenCalledWith('work/renamed.ipynb');
    expect(host.create).not.toHaveBeenCalled();
  });

  it('stops following a notebook once the conversation has moved on', async () => {
    const a = panel('work/a.ipynb');
    active = a;
    await pin.start();
    active = panel('work/b.ipynb');
    await pin.start();

    rename(a, 'work/elsewhere.ipynb');
    expect(pin.path()).toBe('work/b.ipynb');
  });

  it('replaces a notebook that cannot be opened again with a new one', async () => {
    const a = panel('work/gone.ipynb');
    active = a;
    await pin.start();

    a.isDisposed = true;
    active = null;
    const replacement = await pin.notebook();

    expect(host.create).toHaveBeenCalledTimes(1);
    expect(replacement).toBe(active);
    expect(pin.name()).toBe('Untitled1.ipynb');
  });

  it('brings the notebook to the front when shown, opening it first if closed', async () => {
    const a = panel('work/a.ipynb');
    onDisk.add('work/a.ipynb');
    active = a;
    await pin.start();
    active = panel('b.ipynb');

    await pin.show();
    expect(host.activate).toHaveBeenLastCalledWith(a);

    a.isDisposed = true;
    const reopened = await pin.show();
    expect(host.activate).toHaveBeenLastCalledWith(reopened);
  });

  it('retries a notebook that could not be created', async () => {
    host.create.mockResolvedValueOnce(null);
    await expect(pin.start()).resolves.toBeNull();

    // Read `active` only after notebook() has run: it is the notebook the
    // retry created.
    const created = await pin.notebook();
    expect(created).not.toBeNull();
    expect(created).toBe(active);
    expect(host.create).toHaveBeenCalledTimes(2);
  });

  it('keeps working after a step fails', async () => {
    // One failure is its caller's to report; it must not block the queue.
    const a = panel('work/a.ipynb');
    onDisk.add('work/a.ipynb');
    active = a;
    await pin.start();
    a.isDisposed = true;

    host.reopen.mockRejectedValueOnce(new Error('server went away'));
    await expect(pin.notebook()).rejects.toThrow('server went away');

    await expect(pin.notebook()).resolves.not.toBeNull();
    await expect(pin.ensure()).resolves.toBe('a.ipynb');
  });
});

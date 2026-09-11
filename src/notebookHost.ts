import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { INotebookTracker } from '@jupyterlab/notebook';
import { NotebookPanel } from '@jupyterlab/notebook';
import type { INotebookHost } from './conversationPin';

// Longest wait to create a notebook, or for one to load. The pin takes one
// step at a time, so a step that never finished would stall every chat.
export const NOTEBOOK_WAIT_MS = 15000;

/** `promise`, or null if it fails or has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/**
 * `panel` once its contents have loaded, or null if they do not within `ms`.
 *
 * `docmanager:open` and `notebook:create-new` hand back the panel before the
 * file has been read, and reading it REPLACES every cell: an answer placed
 * before then is wiped when the file arrives.
 */
function loaded(
  panel: NotebookPanel,
  ms: number
): Promise<NotebookPanel | null> {
  return within(
    panel.context.ready.then(() => panel),
    ms
  );
}

/**
 * A new Python 3 notebook, loaded and made the active tab.
 *
 * `notebook:create-new` opens what it creates and, in JupyterLab 4, returns
 * the panel; failing that, the panel is the next one the tracker gains -- not
 * the tracker's current notebook, which would be some older one if creating
 * had quietly failed.
 */
async function createNotebook(
  app: JupyterFrontEnd,
  tracker: INotebookTracker,
  ms: number
): Promise<NotebookPanel | null> {
  let onAdded:
    | ((sender: INotebookTracker, panel: NotebookPanel) => void)
    | undefined;
  const added = new Promise<NotebookPanel>(resolve => {
    onAdded = (_, panel) => resolve(panel);
    tracker.widgetAdded.connect(onAdded);
  });
  try {
    const executed = app.commands
      .execute('notebook:create-new', { kernelName: 'python3' })
      .then(widget => (widget instanceof NotebookPanel ? widget : added));
    const panel = await within(Promise.race([executed, added]), ms);
    const ready = panel ? await loaded(panel, ms) : null;
    if (ready) {
      app.shell.activateById(ready.id);
    }
    return ready;
  } finally {
    if (onAdded) {
      tracker.widgetAdded.disconnect(onAdded);
    }
  }
}

/** JupyterLab as ConversationPin sees it. */
export function notebookHost(
  app: JupyterFrontEnd,
  tracker: INotebookTracker,
  waitMs = NOTEBOOK_WAIT_MS
): INotebookHost {
  return {
    // `app.shell` tracks only main-area tabs, so its current widget is the
    // active tab even while focus is in the sidebar.
    activeTab: () => {
      const widget = app.shell.currentWidget;
      return widget && tracker.has(widget) ? (widget as NotebookPanel) : null;
    },
    create: () => createNotebook(app, tracker, waitMs),
    reopen: async path => {
      try {
        const widget = await app.commands.execute('docmanager:open', { path });
        return widget instanceof NotebookPanel ? loaded(widget, waitMs) : null;
      } catch {
        // Deleted, or gone some other way: a new notebook takes over.
        return null;
      }
    },
    activate: panel => app.shell.activateById(panel.id)
  };
}

import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { INotebookTracker } from '@jupyterlab/notebook';
import { NotebookPanel } from '@jupyterlab/notebook';
import type { INotebookHost } from './conversationPin';

// Longest wait for a notebook to open, be created, or load. The pin takes one
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
 * The notebook a command opened, once its contents have loaded; null if the
 * command opened something else, or either step failed or took over `ms`.
 *
 * `docmanager:open` and `notebook:create-new` hand back the panel before the
 * file has been read, and reading it REPLACES every cell: an answer placed
 * before then is wiped when the file arrives.
 */
async function loaded(
  opened: Promise<unknown>,
  ms: number
): Promise<NotebookPanel | null> {
  const widget = await within(opened, ms);
  if (!(widget instanceof NotebookPanel)) {
    return null;
  }
  return within(
    widget.context.ready.then(() => widget),
    ms
  );
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
    // A new Python 3 notebook, made the active tab. `notebook:create-new`
    // returns the panel it opens; anything else is a failure. Taking the next
    // notebook to appear instead could take one the user opened meanwhile.
    create: async () => {
      const panel = await loaded(
        app.commands.execute('notebook:create-new', { kernelName: 'python3' }),
        waitMs
      );
      if (panel) {
        app.shell.activateById(panel.id);
      }
      return panel;
    },
    // Null when the file has been deleted, or has gone some other way: a new
    // notebook then takes over.
    reopen: async path => {
      // Opened again by the user already: theirs, selection and all.
      const open = tracker.find(panel => panel.context.path === path);
      if (open) {
        return loaded(Promise.resolve(open), waitMs);
      }
      const panel = await loaded(
        app.commands.execute('docmanager:open', { path }),
        waitMs
      );
      if (panel) {
        // It opens with its first cell selected, which nobody chose, and
        // answers go below the selected cell: above all the user's work.
        // Select the last cell, so they go at the end.
        panel.content.activeCellIndex = panel.content.widgets.length - 1;
      }
      return panel;
    },
    activate: panel => app.shell.activateById(panel.id)
  };
}

import type { NotebookPanel } from '@jupyterlab/notebook';

/**
 * What ConversationPin needs from JupyterLab -- passed in, so the pin can be
 * tested without it. Both `create` and `reopen` must resolve only once the
 * notebook's contents have loaded: loading replaces every cell, so anything
 * placed before then is wiped.
 */
export interface INotebookHost {
  /** The notebook in the active main-area tab, or null if that is not one. */
  activeTab(): NotebookPanel | null;
  /** A new notebook, made the active tab. Null if none can be created. */
  create(): Promise<NotebookPanel | null>;
  /** The notebook at `path`, opened again as a tab. Null if it cannot be. */
  reopen(path: string): Promise<NotebookPanel | null>;
  /** Bring `panel`'s tab to the front. */
  activate(panel: NotebookPanel): void;
}

/**
 * The notebook the current conversation lives in: what the agent is shown,
 * and where its answers go.
 *
 * Pinned when the conversation starts -- New chat, or the first message after
 * the panel opens -- to the notebook in the ACTIVE TAB or, when that tab is
 * not a notebook, to a new notebook made the active tab. Kept for the whole
 * conversation: switching tabs does not move it, a rename is followed, and a
 * pinned notebook that has been closed is opened again when an answer has
 * cells to place in it. The active tab rather than the tracker's current
 * notebook, which is the LAST-FOCUSED notebook even with a terminal or a text
 * file in front.
 */
export class ConversationPin {
  private _panel: NotebookPanel | null = null;
  // Kept separately so a closed notebook can be found again.
  private _path: string | null = null;
  private _started = false;
  // Starting, re-opening and creating happen one at a time: a second New chat
  // must find the notebook the first one created as the active tab rather
  // than create another.
  private _queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly _host: INotebookHost) {}

  /** Start a new conversation. Resolves to its notebook's name. */
  start(): Promise<string | null> {
    return this._serial(() => this._startNow());
  }

  /**
   * Start the conversation if nothing has, and report its notebook's name
   * either way.
   */
  ensure(): Promise<string | null> {
    return this._serial(async () =>
      this._started ? this.name() : this._startNow()
    );
  }

  /**
   * The conversation's notebook if it is open, starting the conversation if
   * nothing has -- but NOT opening a closed one again: that is for placing an
   * answer, not for asking a question. See path() for reading a closed one.
   */
  current(): Promise<NotebookPanel | null> {
    return this._serial(async () => {
      if (!this._started) {
        await this._startNow();
      }
      return this._live();
    });
  }

  /**
   * The conversation's notebook, opened again if it has been closed. When it
   * cannot be -- deleted, or gone some other way -- a new notebook takes its
   * place, so the conversation always has one. Null only if none can be made.
   */
  notebook(): Promise<NotebookPanel | null> {
    return this._serial(async () => {
      if (!this._started) {
        await this._startNow();
      }
      const live = this._live();
      if (live) {
        return live;
      }
      const reopened = this._path ? await this._host.reopen(this._path) : null;
      this._pin(reopened ?? (await this._host.create()));
      return this._panel;
    });
  }

  /** The conversation's notebook, brought to the front: see notebook(). */
  async show(): Promise<NotebookPanel | null> {
    const panel = await this.notebook();
    if (panel) {
      this._host.activate(panel);
    }
    return panel;
  }

  /** Where the notebook's file is -- its last known place while it is closed. */
  path(): string | null {
    return this._path;
  }

  /** The notebook's name -- its last known one while it is closed. */
  name(): string | null {
    const live = this._live();
    if (live) {
      return live.title.label;
    }
    return this._path ? this._path.split('/').pop() ?? this._path : null;
  }

  private _live(): NotebookPanel | null {
    return this._panel && !this._panel.isDisposed ? this._panel : null;
  }

  private async _startNow(): Promise<string | null> {
    this._pin(this._host.activeTab() ?? (await this._host.create()));
    this._started = true;
    return this.name();
  }

  private _pin(panel: NotebookPanel | null): void {
    this._panel?.context.pathChanged.disconnect(this._onPathChanged, this);
    this._panel = panel;
    this._path = panel?.context.path ?? null;
    // Follows a rename or move made while it is open, so that a notebook
    // renamed and then closed is found again under its new name.
    panel?.context.pathChanged.connect(this._onPathChanged, this);
  }

  private _onPathChanged(_: unknown, path: string): void {
    this._path = path;
  }

  private _serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this._queue.then(task);
    // A failed step is reported to its caller; it must not block the next.
    this._queue = run.catch(() => {
      /* swallowed here only */
    });
    return run;
  }
}

import type { NotebookPanel } from '@jupyterlab/notebook';
import type { IChatNotebook } from './chatRouter';

/**
 * Which notebook the current conversation is about.
 *
 * Pinned when the conversation starts -- New chat, or the first message after
 * the panel opens -- from the ACTIVE TAB, and kept for the whole conversation,
 * so switching tabs mid-thread does not change what the agent is shown. The
 * active tab rather than the tracker's current notebook: that one is the
 * LAST-FOCUSED notebook, even with a terminal or a text file in front.
 */
export class ConversationPin {
  // undefined: the conversation has not started. null: it has no notebook.
  private _pinned: NotebookPanel | null | undefined = undefined;

  /**
   * @param _activeTab The notebook in the active main-area tab, or null when
   *   that tab is not a notebook.
   */
  constructor(private readonly _activeTab: () => NotebookPanel | null) {}

  /** Start a new conversation, pinned to the active tab. Returns its name. */
  start(): string | null {
    this._pinned = this._activeTab();
    return this._name();
  }

  /**
   * Start the conversation if nothing has, and report the pin either way. A
   * conversation that has started keeps its notebook -- or its lack of one.
   */
  ensure(): string | null {
    return this._pinned === undefined ? this.start() : this._name();
  }

  /**
   * The pinned notebook, forgotten once it has been closed: a disposed panel
   * still answers, but with cells that are no longer anywhere.
   */
  get notebook(): NotebookPanel | null {
    if (this._pinned?.isDisposed) {
      this._pinned = null;
    }
    return this._pinned ?? null;
  }

  /**
   * The pinned notebook as ChatRouter needs it.
   *
   * @param answersGoTo The notebook answers are placed in. The selected cell is
   *   only sent when it is the pinned one, because the server treats a
   *   selected code cell as the one its answer replaces, and KernelHandoff
   *   replaces the selected cell of the notebook it places into.
   */
  forRequest(answersGoTo: NotebookPanel | null): IChatNotebook | null {
    const panel = this.notebook;
    return panel
      ? { notebook: panel.content, receivesAnswers: panel === answersGoTo }
      : null;
  }

  private _name(): string | null {
    return this.notebook?.title.label ?? null;
  }
}

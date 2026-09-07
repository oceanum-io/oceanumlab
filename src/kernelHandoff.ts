import {
  INotebookTracker,
  NotebookActions,
  NotebookPanel
} from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import { CommandRegistry } from '@lumino/commands';
import { OceanumResponse } from './chatRouter';
import { AUTO_RUN_CODE } from './constants';

export interface InjectOptions {
  /** If true, replace the selected code cell instead of inserting a new one */
  replaceCodeCell?: boolean;
}

export class KernelHandoff {
  constructor(
    private _notebookTracker: INotebookTracker,
    private _commands: CommandRegistry
  ) {}

  /**
   * Create a new Python 3 notebook if none exists.
   */
  private async _ensureNotebook(): Promise<NotebookPanel | null> {
    let notebookPanel = this._notebookTracker.currentWidget;
    if (notebookPanel) {
      return notebookPanel;
    }

    // Create a new Python 3 notebook
    try {
      await this._commands.execute('notebook:create-new', {
        kernelName: 'python3'
      });

      // Wait for the notebook to be created and tracked
      return new Promise(resolve => {
        const checkNotebook = () => {
          const panel = this._notebookTracker.currentWidget;
          if (panel) {
            resolve(panel);
          } else {
            setTimeout(checkNotebook, 100);
          }
        };
        // Give it a moment to initialize
        setTimeout(checkNotebook, 200);
        // Timeout after 5 seconds
        setTimeout(() => resolve(null), 5000);
      });
    } catch {
      return null;
    }
  }

  /**
   * Place every block the response carries, in order, and return the message
   * for the chat window.
   *
   * This used to switch on `response.type`, because a response was exactly one
   * of text, code or markdown. It can now carry any number of blocks in any
   * combination (OCE-173) — a markdown table describing a dataset followed by
   * the query that produced it is one response, not two — so the branch became
   * a loop. No blocks is the commonest case and still touches no notebook.
   */
  async inject(
    response: OceanumResponse,
    options: InjectOptions = {}
  ): Promise<string> {
    if (response.blocks.length === 0) {
      // Nothing to place — just the message for the chat window.
      return response.message;
    }

    // Ensure we have a notebook (create one if needed)
    const notebookPanel = await this._ensureNotebook();
    if (!notebookPanel) {
      return response.message + '\n\n(Could not create notebook)';
    }

    const notebook = notebookPanel.content;

    // The user selected ONE cell, so only the first code block can replace it;
    // everything after is inserted below in order. Captured before the loop
    // because inserting moves `activeCell`.
    const selected = notebook.activeCell;
    let replaceTarget =
      options.replaceCodeCell && selected instanceof CodeCell ? selected : null;

    for (const block of response.blocks) {
      if (block.type === 'code') {
        if (replaceTarget) {
          replaceTarget.model.sharedModel.setSource(block.content);
          replaceTarget = null;
        } else {
          NotebookActions.insertBelow(notebook);
          const newCell = notebook.activeCell;
          if (!newCell) {
            continue;
          }
          newCell.model.sharedModel.setSource(block.content);
        }

        // Auto-run if enabled. Per block, as before: `run` executes the
        // selected cell, and the block just written is the selected one.
        if (AUTO_RUN_CODE) {
          await NotebookActions.run(notebook, notebookPanel.sessionContext);
        }
      } else {
        NotebookActions.insertBelow(notebook);
        if (!notebook.activeCell) {
          continue;
        }

        // Convert to markdown cell and populate
        NotebookActions.changeCellType(notebook, 'markdown');
        const mdCell = notebook.activeCell;
        if (mdCell) {
          mdCell.model.sharedModel.setSource(block.content);
          // Render the markdown cell
          await NotebookActions.run(notebook, notebookPanel.sessionContext);
        }
      }
    }

    return response.message;
  }
}

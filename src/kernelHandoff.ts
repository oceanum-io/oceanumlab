import {
  INotebookTracker,
  NotebookActions,
  NotebookPanel
} from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import { CommandRegistry } from '@lumino/commands';
import type * as nbformat from '@jupyterlab/nbformat';
import { OceanumResponse } from './chatRouter';
import { harvestOutputs, ObservedRun } from './notebookRun';
import type { PlacedResponse } from './aiLoop';

export interface InjectOptions {
  /** If true, replace the selected code cell instead of inserting a new one */
  replaceCodeCell?: boolean;
  /** Run each code cell as it is placed. A user setting, not a build constant. */
  autoRun?: boolean;
  /**
   * Stop. Once aborted, no further block is placed or run, and a cell that is
   * executing is interrupted -- the kernel is the half of a round that an
   * aborted fetch cannot reach.
   */
  signal?: AbortSignal;
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
    const notebookPanel = this._notebookTracker.currentWidget;
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
  ): Promise<PlacedResponse> {
    const runs: ObservedRun[] = [];
    if (response.blocks.length === 0) {
      // Nothing to place — just the message for the chat window.
      return { message: response.message, runs };
    }

    // Ensure we have a notebook (create one if needed)
    const notebookPanel = await this._ensureNotebook();
    if (!notebookPanel) {
      return {
        message: response.message + '\n\n(Could not create notebook)',
        runs
      };
    }

    const notebook = notebookPanel.content;
    const { sessionContext } = notebookPanel;

    // The user selected ONE cell, so only the first code block can replace it;
    // everything after is inserted below in order. Captured before the loop
    // because inserting moves `activeCell`.
    const selected = notebook.activeCell;
    let replaceTarget =
      options.replaceCodeCell && selected instanceof CodeCell ? selected : null;

    for (const block of response.blocks) {
      if (options.signal?.aborted) {
        break;
      }
      if (block.type === 'code') {
        let cell: CodeCell | null = null;
        if (replaceTarget) {
          replaceTarget.model.sharedModel.setSource(block.content);
          cell = replaceTarget;
          replaceTarget = null;
        } else {
          NotebookActions.insertBelow(notebook);
          // `insertBelow` makes whatever the user's default cell type is;
          // code goes in a code cell regardless.
          if (
            notebook.activeCell &&
            !(notebook.activeCell instanceof CodeCell)
          ) {
            NotebookActions.changeCellType(notebook, 'code');
          }
          const newCell = notebook.activeCell;
          if (!newCell) {
            continue;
          }
          newCell.model.sharedModel.setSource(block.content);
          cell = newCell instanceof CodeCell ? newCell : null;
        }

        // Run THIS cell, not the selection: the cell just written need not be
        // the active one (a markdown block placed before it moved the
        // selection), and the user may have several cells selected. Reading
        // the outputs afterwards is what makes the iterate workflow possible
        // -- it is the only place the kernel's answer can be seen.
        if (options.autoRun && cell) {
          const outcome = await this._run(notebookPanel, cell, options.signal);
          runs.push({
            code: block.content,
            message: response.message,
            ...outcome
          });
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
          await NotebookActions.run(notebook, sessionContext);
        }
      }
    }

    return { message: response.message, runs };
  }

  /**
   * Execute one cell and report what happened.
   *
   * `runCells` resolves false both for a kernel error (the traceback is in the
   * outputs) and for a cell that never executed at all -- no kernel, kernel
   * still starting or terminating, pending input, interrupted. The second
   * kind leaves the outputs empty, or, for a replaced cell, STALE from its
   * previous run, so it must not be reported as a clean run.
   */
  private async _run(
    notebookPanel: NotebookPanel,
    cell: CodeCell,
    signal?: AbortSignal
  ): Promise<Pick<ObservedRun, 'status' | 'stdout' | 'error'>> {
    const { content: notebook, sessionContext } = notebookPanel;
    const interrupt = () => {
      void sessionContext.session?.kernel?.interrupt();
    };
    signal?.addEventListener('abort', interrupt, { once: true });
    let ran: boolean;
    try {
      ran = await NotebookActions.runCells(notebook, [cell], sessionContext);
    } finally {
      signal?.removeEventListener('abort', interrupt);
    }

    // Only stream and error outputs are wanted; serialising a rendered plot
    // or DataFrame just to discard it is not.
    const outputs: nbformat.IOutput[] = [];
    const model = cell.model.outputs;
    for (let i = 0; i < model.length; i++) {
      const item = model.get(i);
      if (item.type === 'stream' || item.type === 'error') {
        outputs.push(item.toJSON());
      }
    }
    const outcome = harvestOutputs(outputs);

    if ((!ran || sessionContext.hasNoKernel) && outcome.status === 'ok') {
      return {
        status: 'error',
        stdout: '',
        error:
          'The cell did not execute (no kernel available, or the execution was interrupted).'
      };
    }
    return outcome;
  }
}

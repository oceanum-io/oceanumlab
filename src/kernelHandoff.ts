import { NotebookActions, NotebookPanel } from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import type { ISessionContext } from '@jupyterlab/apputils';
import type * as nbformat from '@jupyterlab/nbformat';
import { OceanumResponse } from './chatRouter';
import { harvestOutputs, ObservedRun, RunOutcome } from './notebookRun';
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

/** Longest wait for a starting kernel before the cell is reported as not run. */
const KERNEL_START_WAIT_MS = 10000;

export class KernelHandoff {
  /**
   * @param _target The conversation's notebook, brought to the front -- and
   *   opened again first, if it was closed. Asked only when there is
   *   something to place, so an answer with no blocks leaves the tabs alone.
   * @param _readFrom The panel the request read its selected cell from, if
   *   any. A code answer replaces the selected cell only in that same panel:
   *   one opened since has some other cell selected, and replacing it would
   *   overwrite the user's work.
   */
  constructor(
    private _target: () => Promise<NotebookPanel | null>,
    private _readFrom: () => NotebookPanel | null
  ) {}

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
    let halted = false;
    if (response.blocks.length === 0) {
      // Nothing to place — just the message for the chat window.
      return { message: response.message, runs };
    }

    // Every answer goes into the conversation's notebook, whichever tab is in
    // front, and that notebook is brought to the front so the user sees it.
    const notebookPanel = await this._target();
    if (!notebookPanel) {
      return {
        message: response.message + '\n\n(Could not open a notebook)',
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
      options.replaceCodeCell &&
      notebookPanel === this._readFrom() &&
      selected instanceof CodeCell
        ? selected
        : null;

    for (const block of response.blocks) {
      if (options.signal?.aborted) {
        break;
      }
      if (block.type === 'code') {
        let cell: CodeCell | null = null;
        // The target can be gone by now: a markdown block placed before this
        // one yielded while it rendered, and the user deleted the cell.
        if (replaceTarget && !replaceTarget.isDisposed) {
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
        // -- it is the only place the kernel's answer can be seen. A blank
        // block is placed but not run: `CodeCell.execute` would send nothing
        // and the empty result would read as a kernel failure.
        if (options.autoRun && cell && block.content.trim()) {
          const { outcome, executed } = await this._run(
            notebookPanel,
            cell,
            options.signal
          );
          runs.push({
            code: block.content,
            message: response.message,
            ...outcome
          });
          if (!executed) {
            halted = true;
          }
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

    return { message: response.message, runs, halted };
  }

  /**
   * Execute one cell and report what happened, and whether it happened at all.
   *
   * `runCells` resolves false for a kernel error (the traceback is in the
   * outputs) and for some of the ways a cell can fail to execute at all
   * (pending input, interrupted); it resolves TRUE with nothing run when there
   * is no kernel, when the kernel is terminating, or when the kernel is still
   * starting (`CodeCell.execute` bails silently on a session without a
   * kernel); and it rejects when the kernel is dead. None of the did-not-run
   * paths touch the outputs, so a replaced cell would still show its previous
   * run; they are cleared first so that whatever is there afterwards came from
   * this run. The execution count is cleared with them and only a kernel
   * reply sets it again, so a null count afterwards means nothing ran,
   * whatever `runCells` resolved to; that is reported as an error rather than
   * as a clean, silent run.
   *
   * Pending input is refused BEFORE clearing: clearing the outputs of a cell
   * that is waiting on `input()` disposes the prompt widget, and the kernel
   * then waits forever for an answer nobody can give.
   */
  private async _run(
    notebookPanel: NotebookPanel,
    cell: CodeCell,
    signal?: AbortSignal
  ): Promise<{ outcome: RunOutcome; executed: boolean }> {
    const { content: notebook, sessionContext } = notebookPanel;
    if (sessionContext.kernelDisplayStatus === 'initializing') {
      // A kernel is starting (for a notebook this call just created, say).
      // Bounded: `ready` never resolves if the kernel ends up needing to be
      // selected by hand.
      await waitForReady(sessionContext, signal);
      if (signal?.aborted) {
        return didNotRun('stopped before the kernel was ready');
      }
    }
    // Closing the notebook, or deleting the cell, disposes it and nulls its
    // model; every access below would throw and take the whole reply with it.
    if (cell.isDisposed) {
      return didNotRun('the cell was deleted or its notebook closed');
    }
    if (sessionContext.pendingInput) {
      return didNotRun(
        'the kernel is waiting for input that must be answered first'
      );
    }
    const interrupt = () => {
      void sessionContext.session?.kernel?.interrupt().catch(() => {
        // Already dead or gone; there is nothing left to interrupt.
      });
    };
    cell.model.sharedModel.transact(() => {
      cell.model.clearExecution();
    }, false);
    signal?.addEventListener('abort', interrupt, { once: true });
    let ran: boolean;
    let failure: string | null = null;
    try {
      ran = await NotebookActions.runCells(notebook, [cell], sessionContext);
    } catch (err) {
      // A dead kernel rejects rather than resolving false. Report it like any
      // other did-not-run so the rounds already placed keep their messages,
      // and log it: a rejection can also be a fault inside JupyterLab's
      // executor, and the chat line alone would hide that.
      console.error('Oceanum AI: cell execution failed', err);
      ran = false;
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      signal?.removeEventListener('abort', interrupt);
    }
    if (cell.isDisposed) {
      return didNotRun('the cell was deleted or its notebook closed');
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

    if (
      (!ran || cell.model.executionCount === null) &&
      outcome.status === 'ok'
    ) {
      return didNotRun(
        failure ?? 'no kernel available yet, or the execution was interrupted'
      );
    }
    return { outcome, executed: true };
  }
}

/**
 * Resolve when the session context is ready, when Stop is pressed, or after
 * `KERNEL_START_WAIT_MS`, whichever comes first. Stop is raced too so the
 * button answers at once rather than after the kernel, or the timeout.
 */
function waitForReady(
  sessionContext: ISessionContext,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, KERNEL_START_WAIT_MS);
    void sessionContext.ready.then(done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function didNotRun(reason: string): { outcome: RunOutcome; executed: false } {
  return {
    outcome: {
      status: 'error',
      stdout: '',
      error: `The cell did not execute (${reason}).`
    },
    executed: false
  };
}

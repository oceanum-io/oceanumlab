import {
  INotebookTracker,
  NotebookActions,
  NotebookPanel
} from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { CommandRegistry } from '@lumino/commands';
import { OceanumResponse } from './chatRouter';

export interface InjectOptions {
  /** If true, replace the selected code cell instead of inserting a new one */
  replaceCodeCell?: boolean;
}

export class KernelHandoff {
  constructor(
    private _notebookTracker: INotebookTracker,
    private _settings: ISettingRegistry.ISettings,
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
   * Handle AI response:
   * - text: return message for chat window display only
   * - code: insert code cell into notebook (or replace if replaceCodeCell is true)
   * - markdown: insert markdown cell into notebook, return confirmation for chat
   */
  async inject(
    response: OceanumResponse,
    options: InjectOptions = {}
  ): Promise<string> {
    if (response.type === 'text') {
      // Text-only response — just return the message for the chat window
      return response.message;
    }

    // Ensure we have a notebook (create one if needed)
    const notebookPanel = await this._ensureNotebook();
    if (!notebookPanel) {
      if (response.type === 'code') {
        return response.message + '\n\n(Could not create notebook)';
      }
      return 'Could not create notebook to insert content.';
    }

    const notebook = notebookPanel.content;

    if (response.type === 'code') {
      // Check if we should replace the current code cell
      const currentCell = notebook.activeCell;
      const shouldReplace =
        options.replaceCodeCell && currentCell instanceof CodeCell;

      if (shouldReplace) {
        // Replace content of the selected code cell
        currentCell.model.sharedModel.setSource(response.code);
      } else {
        // Insert a new cell below the current active cell
        NotebookActions.insertBelow(notebook);
        const newCell = notebook.activeCell;
        if (!newCell) {
          return response.message;
        }
        newCell.model.sharedModel.setSource(response.code);
      }

      // Auto-run if enabled
      const autoRun = this._settings.get('autoRunCode').composite as boolean;
      if (autoRun) {
        await NotebookActions.run(notebook, notebookPanel.sessionContext);
      }

      return response.message;
    }

    if (response.type === 'markdown') {
      // Insert a new cell below the current active cell
      NotebookActions.insertBelow(notebook);

      const activeCell = notebook.activeCell;
      if (!activeCell) {
        return 'Could not create cell.';
      }

      // Convert to markdown cell and populate
      NotebookActions.changeCellType(notebook, 'markdown');
      const mdCell = notebook.activeCell;
      if (mdCell) {
        mdCell.model.sharedModel.setSource(response.content);
        // Render the markdown cell
        NotebookActions.run(notebook, notebookPanel.sessionContext);
      }
      return response.message ?? 'Added markdown to notebook.';
    }

    return 'Unknown response type.';
  }
}

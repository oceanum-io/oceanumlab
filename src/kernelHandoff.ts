import { INotebookTracker, NotebookActions } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { OceanumResponse } from './chatRouter';

export class KernelHandoff {
  constructor(
    private _notebookTracker: INotebookTracker,
    private _settings: ISettingRegistry.ISettings
  ) {}

  /**
   * Insert the generated code into a new cell and optionally execute it.
   * Returns a message to display in the chat UI.
   */
  async inject(response: OceanumResponse): Promise<string> {
    if (response.type === 'text') {
      // Text-only response — just return the message for the chat window
      return response.message;
    }

    // Code response — insert cell and return explanation for chat
    const notebookPanel = this._notebookTracker.currentWidget;
    if (!notebookPanel) {
      return response.explanation;
    }

    const notebook = notebookPanel.content;

    // Insert a new cell below the current active cell
    NotebookActions.insertBelow(notebook);

    // Populate the new cell with the generated code
    const activeCell = notebook.activeCell;
    if (activeCell) {
      activeCell.model.sharedModel.setSource(response.code);
    }

    // Auto-run if enabled
    const autoRun = this._settings.get('autoRunCode').composite as boolean;
    if (autoRun) {
      await NotebookActions.run(notebook, notebookPanel.sessionContext);
    }

    return response.explanation;
  }
}

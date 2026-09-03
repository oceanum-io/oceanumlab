import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { INotebookTracker } from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import { OCEANUM_AI_BACKEND_URL } from './constants';

export type OceanumResponse =
  | { type: 'text'; message: string }
  | { type: 'code'; message: string; code: string }
  | { type: 'markdown'; content: string; message?: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RouteResult {
  response: OceanumResponse;
  hasCodeCellSelected: boolean;
}

export class ChatRouterError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'ChatRouterError';
  }
}

export class ChatRouter {
  constructor(
    private _settings: ISettingRegistry.ISettings,
    private _notebookTracker: INotebookTracker
  ) {}

  async route(
    prompt: string,
    chatHistory: ChatMessage[] = []
  ): Promise<RouteResult> {
    const token = this._settings.get('datameshToken').composite as string;

    if (!token) {
      throw new ChatRouterError(
        'Datamesh token not configured. Set your token in Settings → Oceanum.io.'
      );
    }

    // Get active cell source as context (best-effort)
    let context = '';
    let isCodeCell = false;
    const notebookCells: string[] = [];

    try {
      const notebook = this._notebookTracker.currentWidget?.content;
      if (notebook) {
        // Collect all code cells (without outputs)
        for (const cell of notebook.widgets) {
          if (cell instanceof CodeCell) {
            const source = cell.model.sharedModel.getSource();
            if (source.trim()) {
              notebookCells.push(source);
            }
          }
        }

        // Get active cell info
        if (notebook.activeCell) {
          const activeCell = notebook.activeCell;
          context = activeCell.model.sharedModel.getSource();
          isCodeCell = activeCell instanceof CodeCell;
        }
      }
    } catch {
      // context is optional — never throw
    }

    const url = `${OCEANUM_AI_BACKEND_URL}/api/chat`;

    // Build payload with all context
    const payload: {
      prompt: string;
      context?: string;
      codeContext?: string;
      chatHistory?: ChatMessage[];
      notebookCells?: string[];
    } = { prompt };

    if (context) {
      if (isCodeCell) {
        payload.codeContext = context;
      } else {
        payload.context = context;
      }
    }

    // Include chat history (excluding the current prompt which is already in 'prompt')
    if (chatHistory.length > 0) {
      payload.chatHistory = chatHistory;
    }

    // Include all notebook code cells
    if (notebookCells.length > 0) {
      payload.notebookCells = notebookCells;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Datamesh-Token': token
        },
        body: JSON.stringify(payload)
      });
    } catch {
      throw new ChatRouterError(
        `Could not reach Oceanum AI backend at ${OCEANUM_AI_BACKEND_URL}. Is it running?`
      );
    }

    if (response.status === 401) {
      throw new ChatRouterError('Invalid or expired Datamesh token.', 401);
    }

    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = body.detail ?? JSON.stringify(body);
      } catch {
        detail = response.statusText;
      }
      throw new ChatRouterError(`Backend error: ${detail}`, response.status);
    }

    const data = await response.json();
    return {
      response: data as OceanumResponse,
      hasCodeCellSelected: isCodeCell && context.trim().length > 0
    };
  }
}

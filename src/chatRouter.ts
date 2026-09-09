import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { INotebookTracker } from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import { OCEANUM_AI_BACKEND_URL } from './constants';
import type { ObservedRun } from './notebookRun';

/** One thing the backend asks us to place in the notebook. */
export interface Block {
  type: 'code' | 'markdown';
  content: string;
}

/**
 * What `/api/chat` answers with: one message, plus anything to place.
 *
 * This replaced a discriminated union of text/code/markdown responses
 * (OCE-173). The union was exclusive, so the backend could not send a markdown
 * table AND the query that produced it — it had to drop one. `message` is what
 * goes in the chat window; `blocks` is what goes in the notebook, in order.
 *
 * `message` is always present now. On the old markdown variant it was optional,
 * which is why the handoff used to fall back to 'Added markdown to notebook.'
 */
export interface OceanumResponse {
  message: string;
  blocks: Block[];
}

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

/**
 * Check the body is the shape we expect before anything reads it.
 *
 * A bare `as OceanumResponse` cast used to be enough because the shape had not
 * changed since the extension was written. It has now (OCE-173), and an
 * extension pinned to one contract will meet a backend serving the other during
 * any deploy where the two are not released together: the old body has no
 * `blocks`, so `response.blocks.length` throws deep inside the handoff and the
 * user sees nothing happen. One check turns that into the error the chat window
 * already knows how to show.
 */
function asOceanumResponse(data: unknown): OceanumResponse {
  const body = data as Partial<OceanumResponse> | null;
  if (
    !body ||
    typeof body.message !== 'string' ||
    !Array.isArray(body.blocks)
  ) {
    throw new ChatRouterError(
      'Unexpected response from the AI backend. It may be running an ' +
        'incompatible version of the chat API.'
    );
  }
  return { message: body.message, blocks: body.blocks };
}

export class ChatRouter {
  constructor(
    private _settings: ISettingRegistry.ISettings,
    private _notebookTracker: INotebookTracker
  ) {}

  async route(
    prompt: string,
    chatHistory: ChatMessage[] = [],
    signal?: AbortSignal
  ): Promise<RouteResult> {
    const { payload, isCodeCell, context } = this._gather(prompt, chatHistory);
    const data = await this._send('/api/chat', payload, signal);
    return {
      response: asOceanumResponse(data),
      hasCodeCellSelected: isCodeCell && context.trim().length > 0
    };
  }

  /**
   * The notebook half of the execute loop: the code ran in the user's own
   * kernel, here is what happened, what next? Same context as `route`, plus
   * every run so far, so the agent sees the whole chain it is continuing.
   */
  async observe(
    prompt: string,
    chatHistory: ChatMessage[],
    runs: ObservedRun[],
    signal?: AbortSignal
  ): Promise<OceanumResponse> {
    const { payload } = this._gather(prompt, chatHistory);
    const data = await this._send(
      '/api/chat/observe',
      { ...payload, runs },
      signal
    );
    return asOceanumResponse(data);
  }

  private _gather(
    prompt: string,
    chatHistory: ChatMessage[]
  ): { payload: ChatPayload; isCodeCell: boolean; context: string } {
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

    // Build payload with all context
    const payload: ChatPayload = { prompt };

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

    return { payload, isCodeCell, context };
  }

  private async _send(
    path: string,
    payload: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const token = this._settings.get('datameshToken').composite as string;
    if (!token) {
      throw new ChatRouterError(
        'Datamesh token not configured. Set your token in Settings → Oceanum.io.'
      );
    }

    let response: Response;
    try {
      response = await fetch(`${OCEANUM_AI_BACKEND_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Datamesh-Token': token
        },
        body: JSON.stringify(payload),
        signal
      });
    } catch (err) {
      // The user pressed Stop. Not a failure, and not "could not reach".
      if (signal?.aborted) {
        throw new ChatStopped();
      }
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

    return response.json();
  }
}

interface ChatPayload {
  prompt: string;
  context?: string;
  codeContext?: string;
  chatHistory?: ChatMessage[];
  notebookCells?: string[];
}

/** Thrown when a request was cancelled by Stop. Distinct so callers can stay quiet. */
export class ChatStopped extends Error {
  constructor() {
    super('Stopped.');
    this.name = 'ChatStopped';
  }
}

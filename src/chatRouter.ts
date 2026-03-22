import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { INotebookTracker } from '@jupyterlab/notebook';

export type OceanumResponse =
  | { type: 'text'; message: string }
  | { type: 'code'; explanation: string; code: string };

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

  async route(prompt: string): Promise<OceanumResponse> {
    const token = this._settings.get('datameshToken').composite as string;
    const backendUrl = this._settings.get('backendUrl').composite as string;

    if (!token) {
      throw new ChatRouterError(
        'Datamesh token not configured. Set your token in Settings → Oceanum.io.'
      );
    }

    // Get active cell source as context (best-effort)
    let context = '';
    try {
      const notebook = this._notebookTracker.currentWidget?.content;
      if (notebook?.activeCell) {
        context = notebook.activeCell.model.sharedModel.getSource();
      }
    } catch {
      // context is optional — never throw
    }

    const url = `${backendUrl.replace(/\/$/, '')}/api/generate-code`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Datamesh-Token': token
        },
        body: JSON.stringify({ prompt, context: context || undefined })
      });
    } catch {
      throw new ChatRouterError(
        `Could not reach Oceanum AI backend at ${backendUrl}. Is it running?`
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
    return data as OceanumResponse;
  }
}

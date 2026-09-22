import { JupyterFrontEnd } from '@jupyterlab/application';
import {
  Dialog,
  ReactWidget,
  UseSignal,
  showDialog
} from '@jupyterlab/apputils';
import { CodeCell } from '@jupyterlab/cells';
import { CodeEditor } from '@jupyterlab/codeeditor';
import * as nbformat from '@jupyterlab/nbformat';
import { Notebook, NotebookPanel } from '@jupyterlab/notebook';
import { CodeCellModel } from '@jupyterlab/cells';
import { LabIcon, addIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { MimeData, ReadonlyJSONArray } from '@lumino/coreutils';
import { Drag } from '@lumino/dragdrop';
import { ISignal, Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';

import React from 'react';
import { marked } from 'marked';

import { DatasourceItem } from './DatasourceItem';
import { IOceanumAuth } from './auth/tokens';
import { startSignIn } from './auth/startSignIn';
import { StoredNotebooks } from './StoredNotebooks';
import { ITab, Tabs } from './Tabs';
import {
  SIGN_IN_COMMAND,
  aiBackendUrl,
  aiCredentialSource,
  canSignIn,
  isSignedIn,
  pastedToken,
  resolveAiCredential,
  signInToken,
  type AiCredentialSource
} from './aiBackend';
import { isDatameshUiMessage } from './datameshUiUrl';
import { describeProgress, onProgress, type Progress } from './progress';

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true
});

/**
 * Renders markdown content safely using dangerouslySetInnerHTML.
 */
function MarkdownContent({ content }: { content: string }): React.ReactElement {
  const html = React.useMemo(() => {
    try {
      return marked.parse(content) as string;
    } catch {
      return content;
    }
  }, [content]);

  return (
    <div
      className="oceanum-ai-chat-content oceanum-ai-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const JUPYTER_CELL_MIME = 'application/vnd.jupyter.cells';

const DRAG_IMAGE = new Image();
DRAG_IMAGE.src =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgZmlsbD0iIzAwMDAwMCIgdmlld0JveD0iMCAwIDI1NiAyNTYiPjxwYXRoIGQ9Ik02OS4xMiw5NC4xNSwyOC41LDEyOGw0MC42MiwzMy44NWE4LDgsMCwxLDEtMTAuMjQsMTIuMjlsLTQ4LTQwYTgsOCwwLDAsMSwwLTEyLjI5bDQ4LTQwYTgsOCwwLDAsMSwxMC4yNCwxMi4zWm0xNzYsMjcuNy00OC00MGE4LDgsMCwxLDAtMTAuMjQsMTIuM0wyMjcuNSwxMjhsLTQwLjYyLDMzLjg1YTgsOCwwLDEsMCwxMC4yNCwxMi4yOWw0OC00MGE4LDgsMCwwLDAsMC0xMi4yOVpNMTYyLjczLDMyLjQ4YTgsOCwwLDAsMC0xMC4yNSw0Ljc5bC02NCwxNzZhOCw4LDAsMCwwLDQuNzksMTAuMjZBOC4xNCw4LjE0LDAsMCwwLDk2LDIyNGE4LDgsMCwwLDAsNy41Mi01LjI3bDY0LTE3NkE4LDgsMCwwLDAsMTYyLjczLDMyLjQ4WiI+PC9wYXRoPjwvc3ZnPg==';

const datameshToken = (notebook: Notebook): string => {
  const datameshTokenInjected =
    notebook &&
    notebook.widgets.find(cell => {
      if (cell.editor) {
        const line = cell.editor.getLine(0);
        if (line && line.indexOf('DATAMESH_TOKEN=') >= 0) {
          return true;
        }
      }
    });
  if (!datameshTokenInjected) {
    return `DATAMESH_TOKEN='${window.datameshToken}';`;
  } else {
    return '';
  }
};

const datasourceCode = (
  datasource: IDatasource,
  notebook: Notebook,
  icell: number
): string => {
  const datameshImport =
    notebook &&
    notebook.widgets.find(cell => {
      if (cell.editor) {
        let found = false;
        for (let i = 0; i < icell; i++) {
          const line = cell.editor.getLine(i);
          if (
            line &&
            line.indexOf('from oceanum.datamesh import Connector') >= 0
          ) {
            found = true;
            break;
          }
        }
        return found;
      }
    });
  let datasourceStr = (datasource.label || datasource.datasource).replace(
    /[\s-.]/g,
    '_'
  );
  const tokenString = window.injectToken ? 'token=DATAMESH_TOKEN' : '';
  if (
    datasource.variables ||
    datasource.geofilter ||
    datasource.timefilter ||
    datasource.spatialref
  ) {
    datasourceStr += `=datamesh.query(${JSON.stringify(
      datasource,
      null,
      '  '
    ).replace(/null/g, 'None')})`;
  } else {
    datasourceStr += `=datamesh.load_datasource('${datasource.datasource}')`;
  }
  if (!datameshImport) {
    datasourceStr =
      'from oceanum.datamesh import Connector' +
      '\n' +
      '#Put your datamesh token in the Jupyterlab settings, or as argument in the constructor below' +
      '\n' +
      `datamesh=Connector(${tokenString})` +
      '\n' +
      datasourceStr;
  }
  return datasourceStr;
};

export interface IDatasource {
  id: string;
  label: string;
  datasource: string;
  description: string;
  variables?: string[];
  geofilter?: Record<string, any>;
  timefilter: any;
  spatialref: string;
}

export interface IWorkspaceSpec {
  id: string;
  name: string;
  data: IDatasource[];
}

export interface IDatameshWorkspaceProps {
  spec: IWorkspaceSpec;
  openDatameshUI: (args: any) => void;
  getCurrentWidget: () => Widget;
  shell: JupyterFrontEnd.IShell;
}

export interface IDatasourceActionButton {
  title: string;
  icon: LabIcon;
  feedback?: string;
  onClick: () => void;
}

class DatameshWorkspaceDisplay extends React.Component<IDatameshWorkspaceProps> {
  constructor(props: IDatameshWorkspaceProps) {
    super(props);
    this._drag = null;
    this._dragData = null;
    this.handleDragMove = this.handleDragMove.bind(this);
    this._evtMouseUp = this._evtMouseUp.bind(this);
  }

  private _drag: Drag | null;
  private _dragData: {
    pressX: number;
    pressY: number;
    dragImage: HTMLElement;
  } | null;

  render(): React.ReactElement {
    return (
      <div className={'datamesh-workspace-display'}>
        {this.props.spec && (
          <div>
            <span className="datamesh-workspace-name">
              {this.props.spec.name}
            </span>
            <hr></hr>
            {this.props.spec.data.map(datasource => (
              // Render display of a code datasource
              <div
                key={datasource.id}
                data-item-id={datasource.id}
                className={'datasource-item'}
              >
                <DatasourceItem
                  datasource={datasource}
                  insertDatasource={this.insertDatameshConnect}
                  onMouseDown={(event: any): void => {
                    this.handleDragSnippet(event, datasource);
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  private injectToken = (notebookWidget: NotebookPanel): void => {
    const notebookContent = notebookWidget.content as Notebook;
    const datameshTokenInject = datameshToken(notebookContent);
    //const codeCell=new CodeCellModel({});
    if (datameshTokenInject) {
      // const tokenCell = notebookContent.contentFactory.createCodeCell({
      //   model: codeCell,
      //   rendermime: notebookContent.rendermime,
      //   contentFactory: notebookContent.contentFactory,
      // })
      // tokenCell.model.sharedModel.setSource(datameshTokenInject);
      notebookContent.model?.sharedModel.insertCell(0, {
        cell_type: 'code',
        source: datameshTokenInject,
        metadata: {}
      });
      // CodeCell.execute(
      //   notebookContent.widgets[0] as CodeCell,
      //   notebookWidget.sessionContext
      // );
    }
  };

  // Handle code datasource insert into an editor
  private insertDatameshConnect = async (
    datasource: IDatasource
  ): Promise<void> => {
    const widget: Widget = this.props.getCurrentWidget();
    if (widget instanceof NotebookPanel) {
      const notebookWidget = widget as NotebookPanel;
      const notebookContent = notebookWidget.content as Notebook;
      const notebookCell = notebookContent.activeCell;
      const notebookCellIndex = notebookContent.activeCellIndex;
      const notebookCellEditor = notebookCell.editor;

      const datasourceStr = datasourceCode(
        datasource,
        notebookContent,
        notebookCellIndex
      );
      if (notebookCellEditor) {
        if (notebookCell instanceof CodeCell) {
          this.verifyLanguageAndInsert(
            datasourceStr,
            'python',
            notebookCellEditor
          );
        } else {
          notebookCellEditor.replaceSelection(datasourceStr);
        }
        if (window.injectToken) {
          this.injectToken(notebookWidget);
        }
      } else {
        this.showErrDialog(
          'Datamesh datasource insert failed: Please select code cell'
        );
      }
    }
  };

  // Handle language compatibility between code datasource and editor
  private verifyLanguageAndInsert = async (
    datasourceStr: string,
    editorLanguage: string,
    editor: CodeEditor.IEditor
  ): Promise<void> => {
    if (editor && editorLanguage && 'python' !== editorLanguage.toLowerCase()) {
      const result = await this.showWarnDialog(editorLanguage);
      if (result.button.accept) {
        editor.replaceSelection(datasourceStr);
      }
    } else {
      // Language match or editorLanguage is unavailable
      editor?.replaceSelection(datasourceStr);
    }
  };

  // Display warning dialog when inserting a code datasource incompatible with editor's language
  private showWarnDialog = async (
    editorLanguage: string
  ): Promise<Dialog.IResult<string>> => {
    return showDialog({
      title: 'Warning',
      body: `Datamesh connector is incompatible with ${editorLanguage}. Continue?`,
      buttons: [Dialog.cancelButton(), Dialog.okButton()]
    });
  };

  // Display error dialog when inserting a code datasource into unsupported widget (i.e. not an editor)
  private showErrDialog = (errMsg: string): Promise<Dialog.IResult<string>> => {
    return showDialog({
      title: 'Error',
      body: errMsg,
      buttons: [Dialog.okButton()]
    });
  };

  // Initial setup to handle dragging a code datasource
  private handleDragSnippet(
    event: React.MouseEvent<HTMLDivElement, MouseEvent>,
    datasource: IDatasource
  ): void {
    const { button } = event;

    // do nothing if left mouse button is clicked
    if (button !== 0) {
      return;
    }

    this._dragData = {
      pressX: event.clientX,
      pressY: event.clientY,
      dragImage: DRAG_IMAGE
    };

    const mouseUpListener = (event: MouseEvent): void => {
      this._evtMouseUp(event, datasource, mouseMoveListener);
    };
    const mouseMoveListener = (event: MouseEvent): void => {
      this.handleDragMove(
        event,
        datasource,
        mouseMoveListener,
        mouseUpListener
      );
    };

    const target = event.target as HTMLElement;
    target.addEventListener('mouseup', mouseUpListener, {
      once: true,
      capture: true
    });
    target.addEventListener('mousemove', mouseMoveListener, true);

    // since a browser has its own drag'n'drop support for images and some other elements.
    target.ondragstart = (): boolean => false;
  }

  private _evtMouseUp(
    event: MouseEvent,
    datasource: IDatasource,
    mouseMoveListener: (event: MouseEvent) => void
  ): void {
    event.preventDefault();
    event.stopPropagation();

    const target = event.target as HTMLElement;
    target.removeEventListener('mousemove', mouseMoveListener, true);
  }

  private handleDragMove(
    event: MouseEvent,
    datasource: IDatasource,
    mouseMoveListener: (event: MouseEvent) => void,
    mouseUpListener: (event: MouseEvent) => void
  ): void {
    event.preventDefault();
    event.stopPropagation();

    const data = this._dragData;

    if (
      data &&
      this.shouldStartDrag(
        data.pressX,
        data.pressY,
        event.clientX,
        event.clientY
      )
    ) {
      // Create drag image
      const element = document.createElement('div');
      element.innerHTML = datasource.description;
      element.classList.add('datasource-drag-image');
      data.dragImage = element;

      // Remove mouse listeners and start the drag.
      const target = event.target as HTMLElement;
      target.removeEventListener('mousemove', mouseMoveListener, true);
      target.removeEventListener('mouseup', mouseUpListener, true);

      void this.startDrag(
        data.dragImage,
        datasource,
        event.clientX,
        event.clientY
      );
    }
  }

  /**
   * Detect if a drag event should be started. This is down if the
   * mouse is moved beyond a certain distance (DRAG_THRESHOLD).
   *
   * @param prevX - X Coordinate of the mouse pointer during the mousedown event
   * @param prevY - Y Coordinate of the mouse pointer during the mousedown event
   * @param nextX - Current X Coordinate of the mouse pointer
   * @param nextY - Current Y Coordinate of the mouse pointer
   */
  private shouldStartDrag(
    prevX: number,
    prevY: number,
    nextX: number,
    nextY: number
  ): boolean {
    const dx = Math.abs(nextX - prevX);
    const dy = Math.abs(nextY - prevY);
    return dx >= 0 || dy >= 5;
  }

  private async startDrag(
    dragImage: HTMLElement,
    datasource: IDatasource,
    clientX: number,
    clientY: number
  ): Promise<void> {
    const notebookPanel: NotebookPanel =
      this.props.getCurrentWidget() as NotebookPanel;
    const notebookContent = notebookPanel.content as Notebook;
    const codeCell = new CodeCellModel({});
    const cell = notebookContent.contentFactory.createCodeCell({
      model: codeCell,
      rendermime: notebookContent.rendermime,
      contentFactory: notebookContent.contentFactory
    });
    let content = datasourceCode(datasource, notebookContent, 0);
    if (window.injectToken) {
      const notebookPanel = this.props.getCurrentWidget() as NotebookPanel;
      content = datameshToken(notebookPanel.content) + '\n' + content;
    }
    cell.model.sharedModel.setSource(content);

    this._drag = new Drag({
      mimeData: new MimeData(),
      dragImage: dragImage,
      supportedActions: 'copy-move',
      proposedAction: 'copy',
      source: this
    });

    const selected: nbformat.ICell[] = [cell.model.toJSON()];
    this._drag.mimeData.setData(JUPYTER_CELL_MIME, selected);
    this._drag.mimeData.setData('text/plain', datasource.description);

    return this._drag.start(clientX, clientY).then(() => {
      this._drag = null;
      this._dragData = null;
    });
  }
}

/** The settings the sidebar reaches Oceanum AI with. */
interface IAiSettings {
  /**
   * The `datameshToken` setting: the same value a chat request is signed with.
   * Not `window.datameshToken`, which keeps a token after it is cleared.
   */
  datameshToken: () => string;
  /** The deployment's Oceanum AI address. */
  aiBackendUrl: () => string;
  /** Emitted when the settings change. */
  settingsChanged: ISignal<unknown, void>;
}

/**
 * How the sidebar can reach Oceanum AI right now. Holds no sign-in token:
 * finding one out means running the host's command.
 */
interface IAiAccess {
  /** Which credential a request would carry; null when there is none. */
  source: AiCredentialSource | null;
  /** The pasted Datamesh token, trimmed; '' when there is none. */
  pasted: string;
  /** Whether the host can sign the user in to Oceanum.io on this site. */
  canSignIn: boolean;
  /** Whether the host says the user is signed in to Oceanum.io. */
  signedIn: boolean;
  /** The backend address: the deployment's Oceanum AI. */
  backend: string;
}

function readAiAccess(
  commands: CommandRegistry,
  settings: IAiSettings
): IAiAccess {
  const datameshToken = settings.datameshToken();
  return {
    source: aiCredentialSource(datameshToken, commands),
    pasted: pastedToken(datameshToken),
    canSignIn: canSignIn(commands),
    signedIn: isSignedIn(commands),
    backend: aiBackendUrl(settings.aiBackendUrl())
  };
}

/**
 * How the sidebar can reach Oceanum AI, read again whenever the settings or the
 * commands change: the host calls `notifyCommandChanged` when the user signs
 * in or out.
 *
 * Only the registry's queries are used, never `execute`, and nothing runs on a
 * timer: every executed command closes JupyterLab's command palette.
 */
function useAiAccess(
  commands: CommandRegistry,
  settings: IAiSettings
): IAiAccess {
  const [access, setAccess] = React.useState(() =>
    readAiAccess(commands, settings)
  );

  React.useEffect(() => {
    const update = () => {
      const next = readAiAccess(commands, settings);
      // Same content keeps the same object, so nothing downstream re-runs.
      setAccess(prev =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      );
    };
    // Anything that changed between the first render and now.
    update();
    commands.commandChanged.connect(update);
    settings.settingsChanged.connect(update);
    return () => {
      commands.commandChanged.disconnect(update);
      settings.settingsChanged.disconnect(update);
    };
  }, [commands, settings]);

  return access;
}

/**
 * The `showExamples` setting, read again whenever the settings change. True where the
 * host passes no such setting.
 */
function useShowExamples(
  settings: IAiSettings,
  read: (() => boolean) | undefined
): boolean {
  const [show, setShow] = React.useState(() => read?.() ?? true);

  React.useEffect(() => {
    if (!read) {
      return;
    }
    const update = () => setShow(read());
    // Anything that changed between the first render and now.
    update();
    settings.settingsChanged.connect(update);
    return () => {
      settings.settingsChanged.disconnect(update);
    };
  }, [settings, read]);

  return show;
}

/**
 * Shows a message prompting the user to sign in to Oceanum.io, or to configure
 * their Datamesh token where the site has no sign-in. Only renders when there
 * is no credential.
 */
function TokenConfigMessage({
  commands,
  settings
}: {
  commands: CommandRegistry;
  settings: IAiSettings;
}): React.ReactElement | null {
  const access = useAiAccess(commands, settings);

  if (access.source) {
    return null;
  }

  const openSettings = () =>
    commands.execute('settingeditor:open', { query: 'Oceanum' });

  if (access.canSignIn) {
    const signIn = () =>
      commands.execute(SIGN_IN_COMMAND).catch(() => {
        console.warn('Oceanum AI: could not start signing in to Oceanum.io.');
      });
    return (
      <div className="oceanum-token-config">
        <a onClick={() => void signIn()}>Sign in to Oceanum.io</a> to use
        Oceanum AI, or set a <a onClick={openSettings}>Datamesh token</a>.
      </div>
    );
  }

  return (
    <div className="oceanum-token-config">
      Set your{' '}
      <a
        onClick={() =>
          commands.execute('settingeditor:open', { query: 'Oceanum' })
        }
      >
        Datamesh token
      </a>{' '}
      to enable Oceanum.io services{' '}
      <a
        href="https://home.oceanum.io/account"
        target="_blank"
        rel="noopener noreferrer"
      >
        Get token here
      </a>
    </div>
  );
}

interface IChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface IAIChatPanelProps {
  commands: CommandRegistry;
  settings: IAiSettings;
}

function AIChatPanel({
  commands,
  settings
}: IAIChatPanelProps): React.ReactElement | null {
  const [messages, setMessages] = React.useState<IChatMessage[]>([]);
  const [input, setInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState<Progress | null>(null);

  // What the agent is doing, as the backend reports it. A `/api/chat` call
  // takes around fifty seconds and used to spend all of them showing the same
  // three words, which read as a hang rather than as work.
  React.useEffect(() => onProgress(setProgress), []);
  const [error, setError] = React.useState<string | null>(null);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  // Chat history navigation
  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState(-1);
  const [tempInput, setTempInput] = React.useState('');

  // Which credential and address the chat has, as the settings and the host
  // report them.
  const access = useAiAccess(commands, settings);
  // What the capabilities depend on: which credential, the pasted token and
  // the address. Not the sign-in token itself: it refreshes, and finding it out
  // runs the host's command.
  const capabilitiesKey = access.source
    ? JSON.stringify([access.source, access.pasted, access.backend])
    : '';

  // Check if code capability is enabled (null = loading/unknown)
  const [codeEnabled, setCodeEnabled] = React.useState<boolean | null>(null);

  // The sidebar's one pending access-token request, shared rather than
  // repeated if the capabilities are asked for again before it answers.
  const tokenRequest = React.useRef<Promise<unknown> | null>(null);

  // Fetch capabilities when the credential or the address changes
  React.useEffect(() => {
    if (!access.source) {
      setCodeEnabled(null);
      return;
    }

    // An answer for a credential that has since changed is dropped.
    let current = true;
    const signInTokenOnce = (): Promise<unknown> => {
      if (!tokenRequest.current) {
        tokenRequest.current = signInToken(commands)().finally(() => {
          tokenRequest.current = null;
        });
      }
      return tokenRequest.current;
    };
    const fetchCapabilities = async () => {
      const credential = await resolveAiCredential(
        access.pasted,
        signInTokenOnce
      );
      if (!current) {
        return;
      }
      if (!credential) {
        // The host says signed in but has no token to give: leave it to a
        // request to report, rather than hide the chat.
        setCodeEnabled(null);
        return;
      }
      try {
        const response = await fetch(`${access.backend}/api/capabilities`, {
          headers: credential.headers
        });
        if (!current) {
          return;
        }
        if (response.ok) {
          const data = await response.json();
          if (current) {
            setCodeEnabled(data.code === true);
          }
        } else {
          setCodeEnabled(false);
        }
      } catch {
        if (current) {
          setCodeEnabled(false);
        }
      }
    };

    void fetchCapabilities();
    return () => {
      current = false;
    };
  }, [capabilitiesKey]);

  // Auto-scroll to bottom when messages change
  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // The notebook this conversation is pinned to: undefined until it starts,
  // null when it has none. See 'oceanum-ai:chat-context' in index.ts.
  const [context, setContext] = React.useState<string | null | undefined>(
    undefined
  );
  // Bumped by New chat. A request keeps the value it started with, and drops
  // its result once the value has moved on: the run New chat stopped resolves
  // AFTER the reset -- with "Stopped." or a late answer -- and must neither
  // land in the new conversation nor end `loading` under a newer request.
  const conversation = React.useRef(0);

  const handleSubmit = async (): Promise<void> => {
    const prompt = input.trim();
    if (!prompt || loading) {
      return;
    }
    const mine = conversation.current;

    // Add to history
    setHistory(prev => [...prev, prompt]);
    setHistoryIndex(-1);
    setTempInput('');

    setInput('');
    setError(null);
    setMessages(prev => [...prev, { role: 'user', content: prompt }]);
    setProgress(null);
    setLoading(true);

    try {
      // Starts the conversation if this is its first message, and reports
      // its notebook's name either way.
      const pinned = await commands.execute('oceanum-ai:chat-context');
      if (mine !== conversation.current) {
        return;
      }
      setContext((pinned as string | null) ?? null);
      // Pass current chat history (before adding the new user message)
      // The user message was already added to state, so we use the messages array directly
      const result = await commands.execute('oceanum-ai:submit-prompt', {
        prompt,
        chatHistory: messages as unknown as ReadonlyJSONArray
      });
      if (mine !== conversation.current) {
        return;
      }
      // Placing the answer can have put it in a new notebook (the old one was
      // deleted), so the line is read again rather than left as it was.
      const after = await commands.execute('oceanum-ai:chat-context');
      if (mine !== conversation.current) {
        return;
      }
      setContext((after as string | null) ?? null);
      const explanation = (result as string) ?? '';
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: explanation }
      ]);
    } catch (err: any) {
      if (mine === conversation.current) {
        setError(err?.message ?? 'An error occurred');
      }
    } finally {
      if (mine === conversation.current) {
        setLoading(false);
      }
    }
  };

  // Clear the conversation and start another, pinned to whichever notebook is
  // the active tab now. The prompt history (up/down arrow) is kept: it is
  // input recall, not conversation.
  const handleNewChat = async (): Promise<void> => {
    conversation.current += 1;
    const mine = conversation.current;
    setMessages([]);
    setInput('');
    setError(null);
    setLoading(false);
    // The old run's last phase belongs to the conversation thrown away.
    setProgress(null);
    setHistoryIndex(-1);
    setTempInput('');
    try {
      const pinned = await commands.execute('oceanum-ai:new-chat');
      if (mine === conversation.current) {
        setContext((pinned as string | null) ?? null);
      }
    } catch (err: any) {
      // The chat commands register once settings have loaded, so a click
      // before that has nothing to reach. Say so, rather than leave the old
      // conversation's "Context:" line under a cleared chat.
      if (mine === conversation.current) {
        setContext(undefined);
        setError(err?.message ?? 'Oceanum AI is not ready yet.');
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
      return;
    }

    // History navigation with up/down arrows
    if (e.key === 'ArrowUp' && history.length > 0) {
      e.preventDefault();
      if (historyIndex === -1) {
        // Save current input before navigating
        setTempInput(input);
        setHistoryIndex(history.length - 1);
        setInput(history[history.length - 1]);
      } else if (historyIndex > 0) {
        setHistoryIndex(historyIndex - 1);
        setInput(history[historyIndex - 1]);
      }
      return;
    }

    if (e.key === 'ArrowDown' && historyIndex !== -1) {
      e.preventDefault();
      if (historyIndex < history.length - 1) {
        setHistoryIndex(historyIndex + 1);
        setInput(history[historyIndex + 1]);
      } else {
        // Return to current input
        setHistoryIndex(-1);
        setInput(tempInput);
      }
      return;
    }
  };

  // Hide AI panel if no credential or code capability is not enabled
  if (!access.source || codeEnabled === false) {
    return null;
  }

  return (
    <div className="oceanum-ai-chat">
      <div className="oceanum-ai-chat-header">
        <span className="oceanum-ai-chat-title">Oceanum AI</span>
        <button
          className="jp-mod-styled oceanum-ai-chat-new"
          onClick={() => void handleNewChat()}
          title="Clear this conversation and start a new one, with the active notebook as its context"
        >
          New chat
        </button>
      </div>
      {context !== undefined && (
        <div className="oceanum-ai-chat-context" title={context ?? undefined}>
          {context === null ? 'No notebook in context' : `Context: ${context}`}
        </div>
      )}
      <div className="oceanum-ai-chat-messages">
        {messages.length === 0 && (
          <div className="oceanum-text-empty">
            Ask Oceanum AI to query and analyse data from Datamesh.
            <br></br>
            Answers go into this chat&apos;s notebook: the one in the active tab
            when the chat starts, or a new one.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`oceanum-ai-chat-message oceanum-ai-chat-message--${msg.role}`}
          >
            <span className="oceanum-ai-chat-role">
              {msg.role === 'user' ? 'You' : 'AI'}
            </span>
            {msg.role === 'user' ? (
              <pre className="oceanum-ai-chat-content">{msg.content}</pre>
            ) : (
              <MarkdownContent content={msg.content} />
            )}
          </div>
        ))}
        {loading && (
          <div className="oceanum-ai-chat-message oceanum-ai-chat-message--assistant">
            <span className="oceanum-ai-chat-role">AI</span>
            <span className="oceanum-ai-chat-loading">
              {describeProgress(progress)}
            </span>
          </div>
        )}
        {error && <div className="oceanum-ai-chat-error">{error}</div>}
        <div ref={messagesEndRef} />
      </div>
      <div className="oceanum-ai-chat-input-area">
        <textarea
          className="oceanum-ai-chat-input"
          rows={3}
          placeholder="Ask Oceanum AI… (Enter to send, Shift+Enter for newline)"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          className="jp-mod-styled oceanum-ai-chat-send"
          onClick={() =>
            void (loading
              ? commands.execute('oceanum-ai:stop')
              : handleSubmit())
          }
          disabled={!loading && !input.trim()}
          title={loading ? 'Stop the current response' : undefined}
        >
          {loading ? 'Stop' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/**
 * DatameshConnectWidget props.
 */
export interface IDatameshWidgetProps {
  app: JupyterFrontEnd;
  name: string;
  icon: LabIcon;
  openDatameshUI: any;
  /** The deployment's Datamesh UI address. */
  datameshUiUrl: () => string;
  /** The Datamesh UI panel's iframe window; `null` when the panel is closed. */
  datameshUiFrame: () => Window | null;
  /** The `datameshToken` setting. */
  datameshToken: () => string;
  /** The deployment's Oceanum AI address. */
  aiBackendUrl: () => string;
  /** Emitted when the settings change. */
  settingsChanged: ISignal<unknown, void>;
  commands: CommandRegistry;
  getCurrentWidget: () => Widget;
  /** Oceanum.io sign-in, or null on a host with no Oceanum environment. */
  auth?: IOceanumAuth | null;
  /** Open a stored notebook by spec store id. */
  openStoredNotebook?: (id: string) => void;
  /** Open a copy of an example by spec store id, named from its title. */
  openExample?: (id: string, title: string) => void;
  /** The `showExamples` setting: whether the Notebooks tab lists the examples. */
  showExamples?: () => boolean;
  /** Save the `showExamples` setting, from the switch on the Examples heading. */
  setShowExamples?: (show: boolean) => void;
}

/**
 * The panel's tabs.
 *
 * A component rather than a list built in `render`, because whether Oceanum AI is
 * reachable is not static: `useAiAccess` re-reads it when the settings change and when
 * the host signals a sign-in or sign-out. An AI tab is only offered when the chat has a
 * credential to work with — otherwise it would open on the same nothing the panel
 * rendered before there were tabs, except now with a label promising otherwise.
 */
function PanelTabs({
  auth,
  commands,
  settings,
  renderDatamesh,
  openStoredNotebook,
  openExample,
  showExamples,
  setShowExamples,
  selected,
  onSelect
}: {
  auth: IOceanumAuth | null;
  commands: CommandRegistry;
  settings: IAiSettings;
  renderDatamesh: () => React.ReactElement;
  openStoredNotebook?: (id: string) => void;
  openExample?: (id: string, title: string) => void;
  showExamples?: () => boolean;
  setShowExamples?: (show: boolean) => void;
  selected: string;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const access = useAiAccess(commands, settings);
  const examplesShown = useShowExamples(settings, showExamples);
  const tabs: ITab[] = [
    {
      id: 'notebooks',
      label: 'Notebooks',
      render: () =>
        // An auth with no environment is a provider that has nothing to sign in to (the
        // server has sign-in turned off). Asking the user to sign in would be a dead end.
        auth?.environment ? (
          <StoredNotebooks
            auth={auth}
            onOpen={openStoredNotebook && (item => openStoredNotebook(item.id))}
            onOpenExample={
              openExample && (item => openExample(item.id, item.title))
            }
            showExamples={examplesShown}
            onShowExamplesChange={setShowExamples}
            onSignIn={() => {
              startSignIn(commands, auth).catch(error => {
                console.warn('Oceanum.io sign-in could not start.', error);
              });
            }}
          />
        ) : (
          <div className="oceanum-text-empty">
            Oceanum.io sign-in is not configured for this host.
          </div>
        )
    },
    { id: 'datamesh', label: 'Datamesh', render: renderDatamesh }
  ];
  // Signed in, not merely holding a credential: a Datamesh token pasted into the
  // settings would reach the backend, but the tab stays out of the way until someone
  // has signed in to Oceanum.io.
  if (access.signedIn) {
    tabs.push({
      id: 'ai',
      label: 'Oceanum AI',
      render: () => <AIChatPanel commands={commands} settings={settings} />
    });
  }
  return <Tabs tabs={tabs} selected={selected} onSelect={onSelect} />;
}

/**
 * A widget for Datamesh Connections.
 */
export class DatameshConnectWidget extends ReactWidget {
  props: IDatameshWidgetProps;
  renderSignal: Signal<this, any>;
  icon: LabIcon;
  openDatameshUI: any;
  datameshWorkspaceSpec: IWorkspaceSpec | null = null;

  constructor(props: IDatameshWidgetProps) {
    super();
    this.props = props;
    this.renderSignal = new Signal<this, any>(this);
    this.renderDisplay = this.renderDisplay.bind(this);

    window.addEventListener(
      'message',
      this.receiveIFrameMessage.bind(this),
      false
    );
  }

  receiveIFrameMessage(event: MessageEvent): void {
    // Any page or frame can post to this window; only the Datamesh UI panel
    // may change the workspace.
    if (
      !isDatameshUiMessage(
        event,
        this.props.datameshUiUrl(),
        this.props.datameshUiFrame()
      )
    ) {
      return;
    }
    if (event.data && event.data.action === 'workspace-modify') {
      this.datameshWorkspaceSpec = {
        id: event.data.id,
        name: event.data.name,
        data: event.data.data
      };
      this.renderSignal.emit(this.datameshWorkspaceSpec);
    }
  }

  renderDisplay(datameshWorkspace: IWorkspaceSpec): React.ReactElement {
    return (
      <>
        {this.datameshWorkspaceSpec ? (
          <DatameshWorkspaceDisplay
            spec={datameshWorkspace}
            openDatameshUI={this.props.openDatameshUI}
            getCurrentWidget={this.props.getCurrentWidget}
            shell={this.props.app.shell}
          />
        ) : (
          <div className="oceanum-text-empty">
            <a onClick={this.props.openDatameshUI}>Open</a> the Oceanum Datamesh
            UI to add datasources.
          </div>
        )}
      </>
    );
  }

  /** The Datamesh workspace tab: what this panel showed above the divider. */
  renderDatamesh(): React.ReactElement {
    return (
      <>
        <div className="datamesh-workspace-header">
          <span>Datamesh Workspace</span>
          <div
            className="open-datamesh-ui"
            onClick={this.props.openDatameshUI}
            title="Open Datamesh UI"
          >
            {<addIcon.react height="20px" verticalAlign="middle" />}
          </div>
        </div>
        <div className="datamesh-connect-workspace">
          <UseSignal signal={this.renderSignal} initialArgs={null}>
            {(_, datameshWorkspace): React.ReactElement =>
              this.renderDisplay(datameshWorkspace)
            }
          </UseSignal>
          <TokenConfigMessage
            commands={this.props.commands}
            settings={this.props}
          />
        </div>
      </>
    );
  }

  render(): React.ReactElement {
    return (
      <div className="datamesh-connect">
        <header className="oceanum-sidebar-header">
          <this.props.icon.react
            tag="span"
            width="auto"
            height="20px"
            verticalAlign="middle"
          />
          <span className="oceanum-sidebar-title">Oceanum.io</span>
        </header>
        <UseSignal signal={this.tabChanged} initialArgs={this.selectedTab}>
          {(): React.ReactElement => (
            <PanelTabs
              auth={this.props.auth ?? null}
              commands={this.props.commands}
              settings={this.props}
              renderDatamesh={() => this.renderDatamesh()}
              openStoredNotebook={this.props.openStoredNotebook}
              openExample={this.props.openExample}
              showExamples={this.props.showExamples}
              setShowExamples={this.props.setShowExamples}
              selected={this.selectedTab}
              onSelect={id => this.selectTab(id)}
            />
          )}
        </UseSignal>
      </div>
    );
  }

  /**
   * The visible tab. The widget only holds it and announces changes through
   * `tabChanged`; the plugin persists it in IStateDB, because the layout restorer
   * restores a widget's place in the shell rather than fields on it.
   */
  get selectedTab(): string {
    return this._selectedTab;
  }

  selectTab(id: string): void {
    if (id !== this._selectedTab) {
      this._selectedTab = id;
      this.tabChanged.emit(id);
    }
  }

  readonly tabChanged = new Signal<this, string>(this);
  // Notebooks first: on notebook.oceanum.io this panel is how a user reaches their
  // work, so it opens there rather than on Datamesh.
  private _selectedTab = 'notebooks';
}

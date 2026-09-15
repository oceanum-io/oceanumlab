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
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';

import React from 'react';
import { marked } from 'marked';

import { DatasourceItem } from './DatasourceItem';
import {
  SIGN_IN_COMMAND,
  aiBackendUrl,
  canSignIn,
  resolveAiCredential,
  signInToken,
  type IAiCredential
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

/** How the sidebar can reach Oceanum AI right now. */
interface IAiAccess {
  /** What a request would be signed with; null when there is nothing. */
  credential: IAiCredential | null;
  /** Whether the host signs users in to Oceanum.io. */
  canSignIn: boolean;
  /** Whether the host has a command that starts signing in. */
  canStartSignIn: boolean;
  /** The backend address, from the `aiBackendUrl` setting. */
  backend: string;
}

/**
 * How the sidebar can reach Oceanum AI, checked every second: the pasted token
 * and the address follow the settings, and the host's sign-in changes when the
 * user signs in or out. Null until the first check has answered.
 *
 * The credential is resolved the same way a chat request resolves it, and is
 * only held in memory: the sign-in token is never written anywhere.
 */
function useAiAccess(
  commands: CommandRegistry,
  backendSetting: () => string
): IAiAccess | null {
  const [access, setAccess] = React.useState<IAiAccess | null>(null);

  React.useEffect(() => {
    let live = true;
    // Checks can overlap if the host is slow to answer; an older one must not
    // overwrite what a newer one found.
    let started = 0;
    let applied = 0;
    const check = async () => {
      const mine = ++started;
      const next: IAiAccess = {
        credential: await resolveAiCredential(
          window.datameshToken,
          signInToken(commands)
        ),
        canSignIn: canSignIn(commands),
        canStartSignIn: commands.hasCommand(SIGN_IN_COMMAND),
        backend: aiBackendUrl(backendSetting())
      };
      if (!live || mine < applied) {
        return;
      }
      applied = mine;
      // Same content keeps the same object, so nothing downstream re-runs.
      setAccess(prev =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      );
    };
    void check();
    const interval = setInterval(() => {
      void check();
    }, 1000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [commands, backendSetting]);

  return access;
}

/**
 * Shows a message prompting the user to sign in to Oceanum.io, or to configure
 * their Datamesh token where the host has no sign-in. Only renders when there
 * is no credential.
 */
function TokenConfigMessage({
  commands,
  backendSetting
}: {
  commands: CommandRegistry;
  backendSetting: () => string;
}): React.ReactElement | null {
  const access = useAiAccess(commands, backendSetting);

  if (!access || access.credential) {
    return null;
  }

  const openSettings = () =>
    commands.execute('settingeditor:open', { query: 'Oceanum' });

  if (access.canSignIn) {
    return (
      <div className="oceanum-token-config">
        {access.canStartSignIn ? (
          <a onClick={() => void commands.execute(SIGN_IN_COMMAND)}>
            Sign in to Oceanum.io
          </a>
        ) : (
          'Sign in to Oceanum.io'
        )}{' '}
        to use Oceanum AI, or set a <a onClick={openSettings}>Datamesh token</a>
        .
      </div>
    );
  }

  return (
    <div className="oceanum-token-config">
      Set your <a onClick={openSettings}>Datamesh token</a> to enable Oceanum.io
      services{' '}
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
  /** The `aiBackendUrl` setting. */
  backendSetting: () => string;
}

function AIChatPanel({
  commands,
  backendSetting
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

  // The credential and address, re-checked every second: settings may change,
  // and the user may sign in or out of Oceanum.io.
  const access = useAiAccess(commands, backendSetting);
  const credential = access?.credential ?? null;
  // What the capabilities depend on, as a value: a new sign-in token, a new
  // pasted token or a new address each fetch them again.
  const capabilitiesKey = credential
    ? JSON.stringify([access.backend, credential.headers])
    : '';

  // Check if code capability is enabled (null = loading/unknown)
  const [codeEnabled, setCodeEnabled] = React.useState<boolean | null>(null);

  // Fetch capabilities when the credential or the address changes
  React.useEffect(() => {
    if (!credential) {
      setCodeEnabled(null);
      return;
    }

    // An answer for a credential that has since changed is dropped.
    let current = true;
    const fetchCapabilities = async () => {
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
  if (!credential || codeEnabled === false) {
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
  /** The `datameshUiUrl` setting. */
  datameshUiUrl: () => string;
  /** The Datamesh UI panel's iframe window; `null` when the panel is closed. */
  datameshUiFrame: () => Window | null;
  /** The `aiBackendUrl` setting. */
  aiBackendUrl: () => string;
  commands: CommandRegistry;
  getCurrentWidget: () => Widget;
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
            backendSetting={this.props.aiBackendUrl}
          />
        </div>
        <div className="datamesh-connect-divider" />
        <AIChatPanel
          commands={this.props.commands}
          backendSetting={this.props.aiBackendUrl}
        />
      </div>
    );
  }
}

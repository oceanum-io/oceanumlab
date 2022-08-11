import { JupyterFrontEnd } from '@jupyterlab/application';
import {
  Dialog,
  showDialog,
  ReactWidget,
  UseSignal
} from '@jupyterlab/apputils';
import { CodeCell } from '@jupyterlab/cells';
import { CodeEditor } from '@jupyterlab/codeeditor';
import * as nbformat from '@jupyterlab/nbformat';
import { Notebook, NotebookModel, NotebookPanel } from '@jupyterlab/notebook';
import { addIcon, LabIcon } from '@jupyterlab/ui-components';
import { MimeData } from '@lumino/coreutils';
import { Drag } from '@lumino/dragdrop';
import { Widget } from '@lumino/widgets';
import { Signal } from '@lumino/signaling';

import React from 'react';

import { DatasourceItem } from './DatasourceItem';

const JUPYTER_CELL_MIME = 'application/vnd.jupyter.cells';

const datasourceCode = (
  datasource: IDatasource,
  notebook: Notebook,
  icell: number
): string => {
  const datameshImport =
    notebook &&
    notebook.widgets.find(cell => {
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
    });
  let datasourceStr = datasource.datasource.replace(/[\s-.]/g, '_');
  if (
    datasource.variables ||
    datasource.geofilter ||
    datasource.timefilter ||
    datasource.spatialref
  ) {
    datasourceStr += `=datamesh.query(${JSON.stringify(datasource)})`;
  } else {
    datasourceStr += `=datamesh.load_datasource('${datasource.datasource}')`;
  }
  if (!datameshImport) {
    datasourceStr =
      'from oceanum.datamesh import Connector' +
      '\n' +
      `datamesh=Connector("${window.datameshToken}")` +
      '\n' +
      datasourceStr;
  }
  return datasourceStr;
};

export interface IDatasource {
  id: string;
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

  // Handle code datasource insert into an editor
  private insertDatameshConnect = async (
    datasource: IDatasource
  ): Promise<void> => {
    const widget: Widget = this.props.getCurrentWidget();
    if (widget instanceof NotebookPanel) {
      const notebookWidget = widget as NotebookPanel;
      const notebookCell = (notebookWidget.content as Notebook).activeCell;
      const notebookCellIndex = (notebookWidget.content as Notebook)
        .activeCellIndex;
      const notebookCellEditor = notebookCell.editor;
      const datasourceStr = datasourceCode(
        datasource,
        notebookWidget.content as Notebook,
        notebookCellIndex
      );
      if (notebookCell instanceof CodeCell) {
        this.verifyLanguageAndInsert(
          datasource,
          'python',
          notebookCellEditor,
          notebookWidget.content,
          notebookCellIndex
        );
      } else {
        notebookCellEditor.replaceSelection(datasourceStr);
      }
      const cell = notebookWidget.model.contentFactory.createCodeCell({});
      notebookWidget.model.cells.insert(notebookCellIndex + 1, cell);
    } else {
      this.showErrDialog(
        'Datamesh datasource insert failed: Please select code cell'
      );
    }
  };

  // Handle language compatibility between code datasource and editor
  private verifyLanguageAndInsert = async (
    datasource: IDatasource,
    editorLanguage: string,
    editor: CodeEditor.IEditor,
    notebook: Notebook,
    icell: number
  ): Promise<void> => {
    const datasourceStr = datasourceCode(datasource, notebook, icell);
    if (editorLanguage && 'python' !== editorLanguage.toLowerCase()) {
      const result = await this.showWarnDialog(
        editorLanguage,
        datasource.description
      );
      if (result.button.accept) {
        editor.replaceSelection(datasourceStr);
      }
    } else {
      // Language match or editorLanguage is unavailable
      editor.replaceSelection(datasourceStr);
    }
  };

  // Display warning dialog when inserting a code datasource incompatible with editor's language
  private showWarnDialog = async (
    editorLanguage: string,
    datasourceName: string
  ): Promise<Dialog.IResult<string>> => {
    return showDialog({
      title: 'Warning',
      body: `Datasource connect is incompatible with ${editorLanguage}. Continue?`,
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
      dragImage: null
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
    const contentFactory = new NotebookModel.ContentFactory({});
    const model = contentFactory.createCodeCell({});
    const content = datasourceCode(datasource, null, 0);
    model.value.text = content;

    this._drag = new Drag({
      mimeData: new MimeData(),
      dragImage: dragImage,
      supportedActions: 'copy-move',
      proposedAction: 'copy',
      source: this
    });

    const selected: nbformat.ICell[] = [model.toJSON()];
    this._drag.mimeData.setData(JUPYTER_CELL_MIME, selected);
    this._drag.mimeData.setData('text/plain', datasource.description);

    return this._drag.start(clientX, clientY).then(() => {
      this._drag = null;
      this._dragData = null;
    });
  }

  private _drag: Drag;
  private _dragData: { pressX: number; pressY: number; dragImage: HTMLElement };
}

/**
 * DatameshConnectWidget props.
 */
export interface IDatameshWidgetProps {
  app: JupyterFrontEnd;
  name: string;
  icon: LabIcon;
  openDatameshUI: any;

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
    if (event.data && event.data.action === 'workspace-modify') {
      this.datameshWorkspaceSpec = {
        id: event.data.id,
        name: event.data.name,
        data: event.data.data
      };
      console.log(this.datameshWorkspaceSpec);
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
          <div className="datasource-item-details">
            <a onClick={this.props.openDatameshUI}>Open</a> the Oceanum datamesh
            UI to add datasources. You will need to allow popups on this page if
            you are not already logged in to Oceanum.io.
          </div>
        )}
      </>
    );
  }

  render(): React.ReactElement {
    return (
      <div className={'datamesh-connect'}>
        <header className={'datamesh-connect-header'}>
          <this.props.icon.react
            tag="span"
            width="auto"
            height="24px"
            verticalAlign="middle"
            marginRight="5px"
          />
          <p> Datamesh workspace </p>
          <div
            className="open-datamesh-ui"
            onClick={this.props.openDatameshUI}
            title={'Open Datamesh UI'}
          >
            {<addIcon.react height="24px" verticalAlign="middle" />}
          </div>
        </header>
        <UseSignal signal={this.renderSignal} initialArgs={null}>
          {(_, datameshWorkspace): React.ReactElement =>
            this.renderDisplay(datameshWorkspace)
          }
        </UseSignal>
      </div>
    );
  }
}

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

const make_query = (datasource_request: IDatasource) => {
  const query: Record<string, any> = {
    datasource: datasource_request.datasource
  };
  if (datasource_request.variables) {
    query.variables = datasource_request.variables;
  }
  if (datasource_request.geofilter) {
    query.geofilter = datasource_request.geofilter;
  }
  if (datasource_request.timefilter) {
    query.timefilter = datasource_request.timefilter;
  }
  if (datasource_request.spatialref) {
    query.spatialref = datasource_request.spatialref;
  }
  return query;
};

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
  let datasourceStr = `${datasource.datasource.replace(
    /[\s-.]/g,
    '_'
  )}=datamesh.query(${JSON.stringify(make_query(datasource))})`;
  if (!datameshImport) {
    datasourceStr =
      'from oceanum.datamesh import Connector' +
      '\n' +
      'datamesh=Connector()' +
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
  timefilter: string[];
  spatialref: string;
}

export interface IPackageSpec {
  id: string;
  name: string;
  data: IDatasource[];
}

export interface IDatameshPackageProps {
  spec: IPackageSpec;
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

class DatameshPackageDisplay extends React.Component<IDatameshPackageProps> {
  constructor(props: IDatameshPackageProps) {
    super(props);
    this._drag = null;
    this._dragData = null;
    this.handleDragMove = this.handleDragMove.bind(this);
    this._evtMouseUp = this._evtMouseUp.bind(this);
  }

  render(): React.ReactElement {
    return (
      <div className={'datamesh-package-display'}>
        <div>
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
  datameshPackageSpec: IPackageSpec;

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
    this.datameshPackageSpec = { id: '', name: '', data: [] };
  }

  renderDisplay(datasourcelist: IDatasource[]): React.ReactElement {
    return (
      <DatameshPackageDisplay
        spec={this.datameshPackageSpec}
        openDatameshUI={this.props.openDatameshUI}
        getCurrentWidget={this.props.getCurrentWidget}
        shell={this.props.app.shell}
      />
    );
  }

  render(): React.ReactElement {
    return (
      <div className={'datamesh-connect'}>
        <header className={'datamesh-connect-header'}>
          <div style={{ display: 'flex' }}>
            <this.props.icon.react
              tag="span"
              width="auto"
              height="24px"
              verticalAlign="middle"
              marginRight="5px"
            />
            <p> Datamesh package </p>
          </div>
          <div
            className="open-ui"
            onClick={this.props.openDatameshUI}
            title={'Open Datamesh UI'}
          >
            {<addIcon.react height="24px" verticalAlign="middle" />}
          </div>
        </header>
        <UseSignal signal={this.renderSignal} initialArgs={[]}>
          {(_, datameshPackage): React.ReactElement =>
            this.renderDisplay(datameshPackage)
          }
        </UseSignal>
      </div>
    );
  }
}

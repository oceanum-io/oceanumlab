import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer,
  ILabStatus
} from '@jupyterlab/application';
import { ICommandPalette, IThemeManager } from '@jupyterlab/apputils';
import { URLExt } from '@jupyterlab/coreutils';
import { LabIcon } from '@jupyterlab/ui-components';
import { textEditorIcon } from '@jupyterlab/ui-components';
import { find } from '@lumino/algorithm';
import { Widget } from '@lumino/widgets';
import { ServerConnection } from '@jupyterlab/services';

import { DatameshConnectWidget } from './DatameshWidget';
import { DatameshUI } from './DatameshUI';

import '../style/index.css';

import oceanumSvg from '../style/icons/oceanum.svg';

declare global {
  interface Window {
    datameshToken: string;
  }
}

const oceanumIcon = new LabIcon({
  name: 'oceanum:main',
  svgstr: oceanumSvg
});

/**
 * Initialization data for the extension.
 */
export const datamesh_connect_extension: JupyterFrontEndPlugin<void> = {
  id: 'datamesh-connect',
  autoStart: true,
  requires: [ICommandPalette, ILayoutRestorer, ILabStatus],
  optional: [IThemeManager],
  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette,
    restorer: ILayoutRestorer,
    status: ILabStatus,
    themeManager: IThemeManager | null
  ) => {
    console.log('Oceanum datamesh connect extension is loaded');

    const settings = ServerConnection.makeSettings();
    const requestUrl = URLExt.join(
      settings.baseUrl,
      'oceanum',
      'env',
      'DATAMESH_TOKEN'
    );

    fetch(requestUrl)
      .then(res => res.json())
      .then(json => {
        window.datameshToken = json['DATAMESH_TOKEN'];
      });

    const getCurrentWidget = (): Widget => {
      return app.shell.currentWidget;
    };

    const openDatameshUI = (event: any): void => {
      const widgetId = 'datamesh-ui';
      const openWidget = find(
        app.shell.widgets('main'),
        (widget: Widget, index: number) => {
          return widget.id === widgetId;
        }
      );
      if (openWidget) {
        app.shell.activateById(widgetId);
        return;
      }

      const datameshUIWidget = new DatameshUI();
      datameshUIWidget.title.label = 'Oceanum Datamesh';
      datameshUIWidget.id = widgetId;
      datameshUIWidget.title.closable = true;
      datameshUIWidget.title.icon = textEditorIcon;
      datameshUIWidget.addClass('datamesh-ui');
      app.shell.add(datameshUIWidget, 'main');
    };

    const datameshConnectWidget = new DatameshConnectWidget({
      app,
      name: 'Datamesh Connect',
      icon: oceanumIcon,
      openDatameshUI: openDatameshUI,
      getCurrentWidget
    });
    datameshConnectWidget.id = 'datamesh-connect';
    datameshConnectWidget.title.icon = oceanumIcon;
    datameshConnectWidget.title.caption = 'Datamesh Connect';

    restorer.add(datameshConnectWidget, 'datamesh-connect');

    // Rank has been chosen somewhat arbitrarily to give priority to the running
    // sessions widget in the sidebar.
    app.shell.add(datameshConnectWidget, 'left', { rank: 900 });

    app.commands.addCommand('datamesh-ui:open', {
      execute: (args: any) => {
        openDatameshUI(args);
      }
    });
  }
};

export default datamesh_connect_extension;
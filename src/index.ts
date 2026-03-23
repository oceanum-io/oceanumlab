import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer,
  ILabStatus
} from '@jupyterlab/application';
import { ICommandPalette, IThemeManager, Notification } from '@jupyterlab/apputils';
import { LabIcon } from '@jupyterlab/ui-components';
import { find } from '@lumino/algorithm';
import { Widget } from '@lumino/widgets';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import { INotebookTracker } from '@jupyterlab/notebook';
import { DatameshConnectWidget } from './DatameshWidget';
import { DatameshUI } from './DatameshUI';
import { requestAPI } from './handler';
import { ChatRouter, ChatRouterError } from './chatRouter';
import { KernelHandoff } from './kernelHandoff';

import '../style/index.css';

import oceanumLightSvg from '../style/icons/oceanum-light.svg';
import oceanumDarkSvg from '../style/icons/oceanum-dark.svg';
import oceanumSvg from '../style/icons/oceanum.svg';

const oceanumIconLight = new LabIcon({
  name: 'oceanum:icon-light',
  svgstr: oceanumLightSvg
});

const oceanumIconDark = new LabIcon({
  name: 'oceanum:icon-dark',
  svgstr: oceanumDarkSvg
});

// Theme-adaptive icon using currentColor (registered for settings panel)
export const oceanumIcon = new LabIcon({
  name: 'oceanum:icon',
  svgstr: oceanumSvg
});

const PLUGIN_ID = '@oceanum/oceanumlab:datamesh-connect';

/**
 * Initialization data for the extension.
 */
export const datamesh_connect_extension: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  autoStart: true,
  requires: [
    ICommandPalette,
    ILayoutRestorer,
    ILabStatus,
    ISettingRegistry,
    IStateDB
  ],
  optional: [IThemeManager],
  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette,
    restorer: ILayoutRestorer,
    status: ILabStatus,
    settingRegistry: ISettingRegistry,
    themeManager: IThemeManager | null
  ) => {
    console.log('Oceanum datamesh connect extension is loaded');

    // Theme-aware icon helper
    // Light theme needs dark icon (visible on light background)
    // Dark theme needs light icon (visible on dark background)
    const isLightTheme = (): boolean => {
      const theme = themeManager?.theme ?? '';
      // Check for light theme (JupyterLab Light, etc.)
      // If theme is empty or contains 'Light', assume light theme
      // Dark themes typically contain 'Dark' in the name
      return !theme.toLowerCase().includes('dark');
    };

    const getOceanumIcon = () => {
      return isLightTheme() ? oceanumIconDark : oceanumIconLight;
    };

    let oceanumIcon = getOceanumIcon();

    //Try to get the datamesh token from the settings
    const updateSettings = (set: ISettingRegistry.ISettings) => {
      const token = set.get('datameshToken');
      if (token && token.user) {
        window.datameshToken = token.user as string;
        requestAPI('env/', {
          method: 'POST',
          body: JSON.stringify({ DATAMESH_TOKEN: token.user })
        }).then(res => console.log(res));
      }
      window.injectToken = set.get('injectToken').user as boolean;
    };
    //Try to get the datamesh token from the envars

    Promise.all([app.restored, settingRegistry.load(PLUGIN_ID)])
      .then(([, setting]) => {
        // Read the settings
        updateSettings(setting);

        // Listen for your plugin setting changes using Signal
        setting.changed.connect(updateSettings);
      })
      .catch(reason => {
        console.error(
          `Something went wrong when reading the Oceanumlab settings.\n${reason}`
        );
      });

    const getCurrentWidget = (): Widget => {
      return app.shell!.currentWidget!;
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
      datameshUIWidget.title.icon = oceanumIcon;
      datameshUIWidget.addClass('datamesh-ui');
      app.shell.add(datameshUIWidget, 'main');
    };

    const datameshConnectWidget = new DatameshConnectWidget({
      app,
      name: 'Datamesh Connect',
      icon: oceanumIcon,
      openDatameshUI: openDatameshUI,
      commands: app.commands,
      getCurrentWidget
    });
    datameshConnectWidget.id = 'datamesh-connect';
    datameshConnectWidget.title.icon = oceanumIcon;
    datameshConnectWidget.title.caption = 'Datamesh Connect';

    restorer.add(datameshConnectWidget, 'datamesh-connect');

    // Rank has been chosen somewhat arbitrarily to give priority to the running
    // sessions widget in the sidebar.
    app.shell.add(datameshConnectWidget, 'left', { rank: 900 });

    // Update icons when theme changes
    if (themeManager) {
      // Update icon when theme changes
      themeManager.themeChanged.connect(() => {
        oceanumIcon = getOceanumIcon();
        datameshConnectWidget.title.icon = oceanumIcon;
      });

      // Also update icon once app is restored (theme may not be ready at init)
      app.restored.then(() => {
        oceanumIcon = getOceanumIcon();
        datameshConnectWidget.title.icon = oceanumIcon;
      });
    }

    app.commands.addCommand('datamesh-ui:open', {
      execute: (args: any) => {
        openDatameshUI(args);
      }
    });
  }
};

/**
 * Second plugin: Oceanum AI chat integration.
 * Wires ChatRouter → KernelHandoff and exposes the
 * `oceanum-ai:submit-prompt` command.
 */
export const oceanum_ai_extension: JupyterFrontEndPlugin<void> = {
  id: '@oceanum/oceanumlab:ai-chat',
  autoStart: true,
  requires: [INotebookTracker, ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    notebookTracker: INotebookTracker,
    settingRegistry: ISettingRegistry
  ) => {
    console.log('Oceanum AI chat extension is loaded');

    const SETTINGS_ID = '@oceanum/oceanumlab:datamesh-connect';

    settingRegistry
      .load(SETTINGS_ID)
      .then(settings => {
        const router = new ChatRouter(settings, notebookTracker);
        const handoff = new KernelHandoff(notebookTracker, settings, app.commands);

        app.commands.addCommand('oceanum-ai:submit-prompt', {
          label: 'Submit prompt to Oceanum AI',
          execute: async (args: Record<string, unknown>) => {
            const prompt = args['prompt'] as string | undefined;
            if (!prompt) {
              return;
            }
            try {
              const result = await router.route(prompt);
              const explanation = await handoff.inject(result.response, {
                replaceCodeCell: result.hasCodeCellSelected
              });
              return explanation;
            } catch (err) {
              if (err instanceof ChatRouterError) {
                Notification.error(err.message, { autoClose: 5000 });
              } else {
                console.error('Oceanum AI: unexpected error', err);
              }
            }
          }
        });
      })
      .catch(reason => {
        console.error(
          `Oceanum AI: could not load settings from ${SETTINGS_ID}.\n${reason}`
        );
      });
  }
};

export default [datamesh_connect_extension, oceanum_ai_extension];

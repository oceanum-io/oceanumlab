import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer,
  ILabStatus
} from '@jupyterlab/application';
import { ICommandPalette, Notification } from '@jupyterlab/apputils';
import { LabIcon } from '@jupyterlab/ui-components';
import { find } from '@lumino/algorithm';
import { Widget } from '@lumino/widgets';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import { INotebookTracker } from '@jupyterlab/notebook';
import { DatameshConnectWidget } from './DatameshWidget';
import { DatameshUI } from './DatameshUI';
import { requestAPI } from './handler';
import { ChatRouter, ChatRouterError, ChatMessage } from './chatRouter';
import { reportProgress } from './progress';
import { KernelHandoff } from './kernelHandoff';
import { runChatLoop, STOPPED } from './aiLoop';
import { MAX_OBSERVE_ROUNDS } from './constants';

import '../style/index.css';

import oceanumSvg from '../style/icons/oceanum.svg';

// Theme-adaptive icon using currentColor (auto-adapts to light/dark themes)
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
  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette,
    restorer: ILayoutRestorer,
    status: ILabStatus,
    settingRegistry: ISettingRegistry
  ) => {
    console.log('Oceanum datamesh connect extension is loaded');

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
        const handoff = new KernelHandoff(notebookTracker, app.commands);

        // The run in flight, if any. Command args must be JSON, so a signal
        // cannot be passed in; Stop is a second command that reaches it here.
        let current: AbortController | null = null;

        app.commands.addCommand('oceanum-ai:stop', {
          label: 'Stop the current Oceanum AI response',
          execute: () => {
            current?.abort();
          }
        });

        app.commands.addCommand('oceanum-ai:submit-prompt', {
          label: 'Submit prompt to Oceanum AI',
          execute: async (args: Record<string, unknown>) => {
            const prompt = args['prompt'] as string | undefined;
            const chatHistory = (args['chatHistory'] as ChatMessage[]) ?? [];
            if (!prompt) {
              return;
            }
            // Read per prompt, not once at load, so a settings change applies
            // to the next question without a reload.
            const autoRunCode = settings.get('autoRunCode')
              .composite as boolean;
            const iterate = settings.get('iterate').composite as boolean;

            current?.abort();
            const controller = new AbortController();
            current = controller;
            try {
              // Cleared in the `finally` below however this ends, so the last
              // phase does not sit on screen after the answer has arrived --
              // or after Stop.
              return await runChatLoop(
                prompt,
                chatHistory,
                {
                  route: (p, h, signal) =>
                    router.route(p, h, signal, reportProgress),
                  observe: (p, h, runs, signal) =>
                    router.observe(p, h, runs, signal, reportProgress),
                  place: (response, opts) => {
                    // The notebook's turn, not the agent's. Without this the
                    // last phase the AGENT reported stays on screen while a
                    // cell is running, so the user is told the agent is
                    // reading dataset details when what is actually happening
                    // is their own code executing. That is a worse claim than
                    // the "Thinking…" it replaced, which was vague rather than
                    // wrong.
                    reportProgress({
                      phase: autoRunCode ? 'running' : 'placing'
                    });
                    return handoff.inject(response, opts);
                  }
                },
                {
                  autoRunCode,
                  iterate,
                  maxRounds: MAX_OBSERVE_ROUNDS,
                  signal: controller.signal
                }
              );
            } catch (err) {
              // Anything that failed because the user pressed Stop is not an
              // error to them: the aborted fetch, or its body read.
              if (controller.signal.aborted) {
                return STOPPED;
              }
              if (err instanceof ChatRouterError) {
                Notification.error(err.message, { autoClose: 5000 });
              } else {
                console.error('Oceanum AI: unexpected error', err);
              }
            } finally {
              // However this ended -- answered, failed, or stopped -- the
              // agent is no longer doing anything, so the last phase must not
              // sit on screen claiming otherwise.
              reportProgress(null);
              if (current === controller) {
                current = null;
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

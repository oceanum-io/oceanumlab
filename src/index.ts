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
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { DatameshConnectWidget } from './DatameshWidget';
import { DatameshUI } from './DatameshUI';
import { requestAPI } from './handler';
import { ChatRouter, ChatRouterError, ChatMessage } from './chatRouter';
import { ConversationPin } from './conversationPin';
import { snapshotFromIpynb, snapshotOf } from './notebookContext';
import { notebookHost } from './notebookHost';
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
        // The notebook the current conversation lives in: what the agent is
        // shown, and where its answers go.
        const pin = new ConversationPin(notebookHost(app, notebookTracker));

        // What a request carries from the conversation's notebook. An open
        // notebook is read as it stands; a closed one is read from its file
        // rather than opened again, which is left for an answer that has
        // cells to place.
        // The panel the current request read its selected cell from, if the
        // notebook was open: a code answer may replace that cell only there.
        let readFrom: NotebookPanel | null = null;
        const router = new ChatRouter(settings, async () => {
          const open = await pin.current();
          readFrom = open;
          if (open) {
            return snapshotOf(open.content);
          }
          const path = pin.path();
          if (!path) {
            return null;
          }
          try {
            const file = await app.serviceManager.contents.get(path, {
              content: true
            });
            return snapshotFromIpynb(file.content);
          } catch {
            // Gone: an answer's cells will go into a new notebook instead.
            return null;
          }
        });
        // Asked only when an answer has blocks to place: brings the
        // conversation's notebook to the front, opening it again if closed.
        const handoff = new KernelHandoff(
          () => pin.show(),
          () => readFrom
        );

        // The run in flight, if any. Command args must be JSON, so a signal
        // cannot be passed in; Stop is a second command that reaches it here.
        let current: AbortController | null = null;

        app.commands.addCommand('oceanum-ai:stop', {
          label: 'Stop the current Oceanum AI response',
          execute: () => {
            current?.abort();
          }
        });

        app.commands.addCommand('oceanum-ai:new-chat', {
          label: 'Start a new Oceanum AI chat',
          execute: () => {
            // The run in flight belongs to the conversation being thrown away:
            // stop it placing anything more. The panel discards its result.
            current?.abort();
            return pin.start();
          }
        });

        app.commands.addCommand('oceanum-ai:chat-context', {
          label: 'The notebook the current Oceanum AI chat is about',
          // Starts the conversation if nothing has -- so the first message of
          // one nobody started with New chat pins the same way -- and reports
          // its notebook either way.
          execute: () => pin.ensure()
        });

        app.commands.addCommand('oceanum-ai:submit-prompt', {
          label: 'Submit prompt to Oceanum AI',
          execute: async (args: Record<string, unknown>) => {
            const prompt = args['prompt'] as string | undefined;
            const chatHistory = (args['chatHistory'] as ChatMessage[]) ?? [];
            if (!prompt) {
              return;
            }
            // A caller that skipped 'oceanum-ai:chat-context' still gets a
            // conversation pinned the same way.
            await pin.ensure();
            // Read per prompt, not once at load, so a settings change applies
            // to the next question without a reload.
            const autoRunCode = settings.get('autoRunCode')
              .composite as boolean;
            const iterate = settings.get('iterate').composite as boolean;

            current?.abort();
            const controller = new AbortController();
            current = controller;
            try {
              return await runChatLoop(
                prompt,
                chatHistory,
                {
                  route: (p, h, signal) => router.route(p, h, signal),
                  observe: (p, h, runs, signal) =>
                    router.observe(p, h, runs, signal),
                  place: (response, opts) => handoff.inject(response, opts)
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

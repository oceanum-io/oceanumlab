import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer,
  ILabStatus
} from '@jupyterlab/application';
import { ICommandPalette, Notification } from '@jupyterlab/apputils';
import { LabIcon } from '@jupyterlab/ui-components';
import { find } from '@lumino/algorithm';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { DatameshConnectWidget } from './DatameshWidget';
import { DatameshUI } from './DatameshUI';
import { requestAPI } from './handler';
import { ChatRouter, ChatRouterError, ChatMessage } from './chatRouter';
import { reporterFor } from './progress';
import { ConversationPin } from './conversationPin';
import { deviceAuthPlugin } from './auth/plugin';
import { IOceanumAuth } from './auth/tokens';
import { CommandIDs as ShareCommandIDs, sharePlugin } from './share/plugin';

import { snapshotFromIpynb, snapshotOf } from './notebookContext';
import { notebookHost } from './notebookHost';
import { KernelHandoff } from './kernelHandoff';
import { runChatLoop, STOPPED } from './aiLoop';
import {
  DATAMESH_UI_SERVICE,
  MAX_OBSERVE_ROUNDS,
  OCEANUM_AI_BACKEND_URL
} from './constants';

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
  // Optional so the panel still loads on a host with no Oceanum environment; the
  // Notebooks tab then explains why it is empty instead of the panel failing to start.
  optional: [IOceanumAuth],
  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette,
    restorer: ILayoutRestorer,
    status: ILabStatus,
    settingRegistry: ISettingRegistry,
    stateDB: IStateDB,
    auth: IOceanumAuth | null
  ) => {
    console.log('Oceanum datamesh connect extension is loaded');

    // Where the Datamesh UI and Oceanum AI live is the deployment's business, so it comes
    // from the sign-in environment (the Jupyter server's configuration, or the notebook
    // site's) and falls back to production. These were user settings until 4.7.1; a
    // user-editable service address is somewhere to send the user's credential.
    const datameshUiUrl = auth?.urls?.datameshUi ?? DATAMESH_UI_SERVICE;
    const aiBackendUrl = auth?.urls?.ai ?? OCEANUM_AI_BACKEND_URL;
    // The `datameshToken` setting for the AI chat; empty until the settings load.
    let datameshTokenSetting = '';
    // Tells the sidebar the settings above have changed.
    const settingsChanged = new Signal<JupyterFrontEnd, void>(app);

    const findDatameshUI = (): DatameshUI | undefined =>
      find(
        app.shell.widgets('main'),
        (widget: Widget) => widget.id === 'datamesh-ui'
      ) as DatameshUI | undefined;

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
      datameshTokenSetting = set.get('datameshToken').composite as string;
      settingsChanged.emit();
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
      if (findDatameshUI()) {
        app.shell.activateById(widgetId);
        return;
      }

      const datameshUIWidget = new DatameshUI(datameshUiUrl);
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
      datameshUiUrl: () => datameshUiUrl,
      datameshUiFrame: () => findDatameshUI()?.frame ?? null,
      datameshToken: () => datameshTokenSetting,
      aiBackendUrl: () => aiBackendUrl,
      settingsChanged,
      commands: app.commands,
      getCurrentWidget,
      auth,
      openStoredNotebook: id => {
        app.commands.execute(ShareCommandIDs.open, { id }).catch(error => {
          console.error('Oceanum: could not open the stored notebook.', error);
        });
      },
      openExample: (id, title) => {
        app.commands
          .execute(ShareCommandIDs.openExample, { id, title })
          .catch(error => {
            console.error('Oceanum: could not open the example.', error);
          });
      }
    });
    datameshConnectWidget.id = 'datamesh-connect';
    datameshConnectWidget.title.icon = oceanumIcon;
    datameshConnectWidget.title.caption = 'Datamesh Connect';

    restorer.add(datameshConnectWidget, 'datamesh-connect');

    // The layout restorer restores the widget's place in the shell, not fields on it,
    // so the chosen tab is kept here. Restoring is best effort: a missing or unreadable
    // entry just leaves the default.
    const TAB_STATE_KEY = `${PLUGIN_ID}:tab`;
    void stateDB
      .fetch(TAB_STATE_KEY)
      .then(value => {
        if (typeof value === 'string') {
          datameshConnectWidget.selectTab(value);
        }
      })
      .catch((): void => undefined);
    datameshConnectWidget.tabChanged.connect((_, id) => {
      void stateDB.save(TAB_STATE_KEY, id);
    });

    // Rank has been chosen somewhat arbitrarily to give priority to the running
    // sessions widget in the sidebar.
    //
    // Oceanum Notebook wants this panel first instead, but that is a property of that
    // distribution rather than of the extension: in a plain JupyterLab the file browser
    // is the primary navigation surface and displacing it would be a regression. A
    // distribution moves it with JupyterLab's own shell user-layout settings, keyed on
    // this widget's id, rather than this extension hard-coding one host's preference.
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
  optional: [IOceanumAuth],
  activate: (
    app: JupyterFrontEnd,
    notebookTracker: INotebookTracker,
    settingRegistry: ISettingRegistry,
    auth: IOceanumAuth | null
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
        const router = new ChatRouter(
          settings,
          app.commands,
          async () => {
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
          },
          () => auth?.urls?.ai ?? ''
        );
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
            // It stops being the current run now, not once it has finished
            // unwinding, so it cannot report progress into the new chat.
            const run = current;
            current = null;
            run?.abort();
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
            // This run's progress, heard only while it is the current run.
            const report = reporterFor(() => current === controller);
            try {
              // Cleared in the `finally` below however this ends, so the last
              // phase does not sit on screen after the answer has arrived --
              // or after Stop.
              return await runChatLoop(
                prompt,
                chatHistory,
                {
                  route: (p, h, signal) => router.route(p, h, signal, report),
                  observe: (p, h, runs, signal) => {
                    // The agent's turn again: the notebook's "Running the
                    // code…" must not stay up while the agent reads what the
                    // code printed.
                    report({ phase: 'interpreting' });
                    return router.observe(p, h, runs, signal, report);
                  },
                  place: (response, opts) => {
                    // The notebook's turn, not the agent's. Without this the
                    // last phase the AGENT reported stays on screen while a
                    // cell is running, so the user is told the agent is
                    // reading dataset details when what is actually happening
                    // is their own code executing. That is a worse claim than
                    // the "Thinking…" it replaced, which was vague rather than
                    // wrong. And "running" only when there is code that will.
                    if (response.blocks.length > 0) {
                      const runsCode =
                        autoRunCode &&
                        response.blocks.some(
                          block => block.type === 'code' && block.content.trim()
                        );
                      report({ phase: runsCode ? 'running' : 'placing' });
                    }
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
              report(null);
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

/**
 * The sign-in contract, exported so another extension can provide or consume it: a Lumino
 * token is matched by object identity, so everyone has to import this one object, and
 * JupyterLab shares `@oceanum/oceanumlab` between extensions as a singleton module.
 */
export * from './auth/tokens';

export default [
  deviceAuthPlugin,
  sharePlugin,
  datamesh_connect_extension,
  oceanum_ai_extension
];

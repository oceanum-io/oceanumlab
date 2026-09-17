import {
  ILabStatus,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  ICommandPalette,
  IThemeManager,
  Notification,
  showDialog
} from '@jupyterlab/apputils';
import { IConsoleTracker } from '@jupyterlab/console';
import { PageConfig, URLExt } from '@jupyterlab/coreutils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';

import bootstrapSource from '../kernel/bootstrap.py';
import { NavAuth } from './auth';
import { KernelCredentialBridge } from './bridge';
import {
  ColorSchemeSync,
  IColorSchemeManager,
  themeColorSchemeManager
} from './colorScheme';
import {
  offersSignIn,
  parseEnvironments,
  PLUGIN_ID,
  readEnvironments,
  selectEnvironment
} from './config';
import {
  OCEANUMLAB_SETTINGS,
  URL_SETTINGS,
  urlSettingToWrite
} from './oceanumlabUrls';
import { kernelSetupCode, settingToken } from './kernelCode';
import { browserWindow, signInRedirect } from './signInRedirect';
import { IOceanumAuth } from './tokens';
import { CommandIDs, NavWidget } from './widget';

export * from './tokens';

/** Used only where there is no theme manager: the nav stays light. */
const FIXED_LIGHT: IColorSchemeManager = {
  get: () => 'light',
  set: () => undefined,
  subscribe: () => undefined,
  unsubscribe: () => undefined,
  clear: () => undefined
};

const authPlugin: JupyterFrontEndPlugin<IOceanumAuth> = {
  id: PLUGIN_ID,
  description: 'Oceanum.io sign-in, through the Oceanum nav in the top bar.',
  autoStart: true,
  provides: IOceanumAuth,
  optional: [IThemeManager, ISettingRegistry],
  activate: async (
    app: JupyterFrontEnd,
    themes: IThemeManager | null,
    settings: ISettingRegistry | null
  ): Promise<IOceanumAuth> => {
    const hostname = window.location.hostname;
    // Two sources, because the two hosts configure differently. JupyterLite deployments carry
    // their environments in jupyter-lite.json; native JupyterLab has no equivalent page
    // option, so it uses this plugin's settings (see schema/plugin.json). Settings come first
    // so a locally configured environment wins over a baked-in one.
    const configured = settings
      ? await settings
          .load(PLUGIN_ID)
          .then(loaded => parseEnvironments(loaded.composite.environments))
          // No schema on an older deployment, or the registry could not read it.
          .catch(() => [])
      : [];
    const environments = [
      ...configured,
      ...readEnvironments(PageConfig.getOption('litePluginSettings'))
    ];
    const environment = selectEnvironment(environments, hostname);
    if (!environment) {
      console.info(`${PLUGIN_ID}: no Oceanum environment for ${hostname}`);
    }
    const auth = new NavAuth({
      environment,
      signInRedirect: environment
        ? signInRedirect(environment, browserWindow)
        : null,
      onSessionExpired: () => {
        Notification.warning(
          'Your Oceanum.io session has ended. Sign in again to use Datamesh.',
          { autoClose: false }
        );
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void auth.refresh();
      }
    });
    // Sign-out returns to this notebook, so it must be an allowed logout URL in Auth0.
    const logoutRedirect = new URL(
      URLExt.join(PageConfig.getBaseUrl(), 'lab/index.html'),
      window.location.href
    ).href;
    const prefersDark = (): boolean =>
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    // NavWidget itself is never hidden: where sign-in is expected, a control that quietly
    // vanishes reads as a bug rather than as "not available here". Whether there is anything
    // to show at all is this caller's call -- see offersSignIn.
    if (offersSignIn(environments)) {
      app.shell.add(
        new NavWidget({
          environment,
          host: auth,
          colorSchemeManager: themes
            ? themeColorSchemeManager(themes, prefersDark)
            : FIXED_LIGHT,
          logoutRedirect,
          hostname
        }),
        'top',
        { rank: 1000 }
      );
    }
    return auth;
  }
};

const kernelPlugin: JupyterFrontEndPlugin<void> = {
  id: '@oceanum/auth-oceanum:kernel',
  description:
    'Sets up every kernel: the oceanum Content-Type patch, DATAMESH_SERVICE and DATAMESH_TOKEN.',
  autoStart: true,
  requires: [IOceanumAuth],
  optional: [INotebookTracker, IConsoleTracker, ISettingRegistry],
  activate: (
    _app: JupyterFrontEnd,
    auth: IOceanumAuth,
    notebooks: INotebookTracker | null,
    consoles: IConsoleTracker | null,
    settings: ISettingRegistry | null
  ): void => {
    let token: string | null = null;
    let configured: string | null = null;
    const bridge = new KernelCredentialBridge(() =>
      kernelSetupCode({
        bootstrapSource,
        datameshUrl: auth.urls?.datamesh ?? null,
        accessToken: token,
        settingToken: configured
      })
    );
    const setToken = (value: string | null): void => {
      if (value !== token) {
        token = value;
        bridge.refresh();
      }
    };
    auth.tokenChanged.connect((_, value) => setToken(value));
    // A sign-in can complete before this plugin activates, so the signal alone could miss the
    // first token.
    void auth.ready.then(() => auth.getAccessToken()).then(setToken);

    // oceanumlab's "Datamesh token" setting. oceanumlab hands it to kernels through its Jupyter
    // server extension, and JupyterLite has no server, so it would never reach the kernel.
    settings
      ?.load(OCEANUMLAB_SETTINGS)
      .then(oceanumlab => {
        const read = (): void => {
          const raw = oceanumlab.composite.datameshToken;
          const value = settingToken(raw);
          if (value === null && typeof raw === 'string' && raw.trim() !== '') {
            console.warn(
              `${PLUGIN_ID}: ignoring the malformed Datamesh token setting`
            );
          }
          if (value !== configured) {
            configured = value;
            bridge.refresh();
          }
        };
        read();
        oceanumlab.changed.connect(read);
      })
      .catch(() => undefined); // oceanumlab is not installed
    notebooks?.forEach(panel => bridge.track(panel.sessionContext));
    notebooks?.widgetAdded.connect((_, panel) =>
      bridge.track(panel.sessionContext)
    );
    consoles?.forEach(panel => bridge.track(panel.sessionContext));
    consoles?.widgetAdded.connect((_, panel) =>
      bridge.track(panel.sessionContext)
    );
  }
};

const colorSchemePlugin: JupyterFrontEndPlugin<void> = {
  id: '@oceanum/auth-oceanum:color-scheme',
  description: 'Follows the Oceanum.io light/dark preference.',
  autoStart: true,
  requires: [IOceanumAuth, IThemeManager],
  activate: (
    app: JupyterFrontEnd,
    auth: IOceanumAuth,
    themes: IThemeManager
  ): void => {
    // Wait until every extension has activated, so the Oceanum themes are registered.
    void app.restored.then(
      () =>
        new ColorSchemeSync({
          auth,
          themes,
          fetch: (...args) => window.fetch(...args),
          prefersDark: () =>
            window.matchMedia('(prefers-color-scheme: dark)').matches
        })
    );
  }
};

const accountPlugin: JupyterFrontEndPlugin<void> = {
  id: '@oceanum/auth-oceanum:account',
  description:
    'Sign-in and sign-out commands, and the access token for other extensions.',
  autoStart: true,
  requires: [IOceanumAuth],
  optional: [ICommandPalette, ILabStatus],
  activate: (
    app: JupyterFrontEnd,
    auth: IOceanumAuth,
    palette: ICommandPalette | null,
    labStatus: ILabStatus | null
  ): void => {
    const { commands } = app;
    commands.addCommand(CommandIDs.signIn, {
      label: 'Sign in to Oceanum.io',
      isVisible: () => !auth.user,
      isEnabled: () => auth.environment !== null,
      // A popup: the page and its kernels survive signing in.
      execute: () => auth.signIn()
    });
    commands.addCommand(CommandIDs.signOut, {
      label: 'Sign out of Oceanum.io',
      isVisible: () => auth.user !== null,
      execute: async () => {
        if (labStatus?.isDirty) {
          const result = await showDialog({
            title: 'Sign out of Oceanum.io',
            body: 'Signing out reloads the page, and you have unsaved changes. Save your work first.',
            buttons: [
              Dialog.cancelButton(),
              Dialog.warnButton({ label: 'Sign out anyway' })
            ]
          });
          if (!result.button.accept) {
            return;
          }
        }
        await auth.signOut();
      }
    });
    commands.addCommand(CommandIDs.account, {
      label: () =>
        auth.user ? `Signed in as ${auth.user.email}` : 'Not signed in',
      isEnabled: () => false,
      execute: () => undefined
    });
    commands.addCommand(CommandIDs.accessToken, {
      label: 'Oceanum.io access token',
      isVisible: () => false,
      execute: () => auth.getAccessToken().catch(() => null)
    });
    auth.userChanged.connect(() => commands.notifyCommandChanged());

    if (palette) {
      palette.addItem({ command: CommandIDs.signIn, category: 'Oceanum' });
      palette.addItem({ command: CommandIDs.signOut, category: 'Oceanum' });
    }
  }
};

const oceanumlabUrlsPlugin: JupyterFrontEndPlugin<void> = {
  id: '@oceanum/auth-oceanum:oceanumlab-urls',
  description:
    "Points oceanumlab's Datamesh panel and AI chat at the environment's Datamesh UI and Oceanum AI.",
  autoStart: true,
  requires: [IOceanumAuth],
  optional: [ISettingRegistry],
  activate: (
    _app: JupyterFrontEnd,
    auth: IOceanumAuth,
    settings: ISettingRegistry | null
  ): void => {
    const urls = auth.urls;
    if (!settings || !urls) {
      return;
    }
    settings.load(OCEANUMLAB_SETTINGS).then(
      async oceanumlab => {
        // One at a time: each write saves all of the user's oceanumlab settings.
        for (const { setting, url } of URL_SETTINGS) {
          // An older oceanumlab without this setting would reject it.
          if (!oceanumlab.schema.properties?.[setting]) {
            continue;
          }
          const value = urlSettingToWrite(
            url(urls),
            oceanumlab.user[setting],
            oceanumlab.composite[setting]
          );
          if (value !== null) {
            // oceanumlab follows the change, e.g. an open Datamesh panel moves.
            await oceanumlab
              .set(setting, value)
              .catch(error =>
                console.warn(
                  `${PLUGIN_ID}: could not set oceanumlab's ${setting}`,
                  error
                )
              );
          }
        }
      },
      () => undefined // oceanumlab is not installed
    );
  }
};

/**
 * The Oceanum sign-in plugins.
 *
 * The ids stay `@oceanum/auth-oceanum:*` because deployed `jupyter-lite.json` files key
 * their `litePluginSettings` on them (see config.ts), and renaming would silently drop
 * every environment table.
 *
 * The sharp edge, which moving this package into the oceanumlab repository widened:
 * oceanum-notebook pins oceanumlab and still builds its own `@oceanum/auth-oceanum`
 * labextension. The oceanumlab wheel now installs one under that same name, to the same
 * path — `share/jupyter/labextensions/@oceanum/auth-oceanum`. Bumping the notebook's pin
 * past this change therefore does not merely register these five ids twice; whichever
 * extension is installed last overwrites the other. Retire the notebook's copy in the
 * same change as the bump, not after it.
 */
const plugins: JupyterFrontEndPlugin<unknown>[] = [
  authPlugin,
  kernelPlugin,
  colorSchemePlugin,
  accountPlugin,
  oceanumlabUrlsPlugin
];

export default plugins;

import { Auth0Client } from '@auth0/auth0-spa-js';
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

import bootstrapSource from '../../kernel/bootstrap.py';
import { OceanumAuth } from './auth';
import { KernelCredentialBridge } from './bridge';
import { ColorSchemeSync } from './colorScheme';
import { PLUGIN_ID, readEnvironments, selectEnvironment } from './config';
import { kernelSetupCode } from './kernelCode';
import { IOceanumAuth } from './tokens';
import { AccountWidget, CommandIDs } from './widget';

export * from './tokens';

const authPlugin: JupyterFrontEndPlugin<IOceanumAuth> = {
  id: PLUGIN_ID,
  description: 'Oceanum.io sign-in.',
  autoStart: true,
  provides: IOceanumAuth,
  activate: (_app: JupyterFrontEnd): IOceanumAuth => {
    const environment = selectEnvironment(
      readEnvironments(PageConfig.getOption('litePluginSettings')),
      window.location.hostname
    );
    const redirectUri = new URL(
      URLExt.join(PageConfig.getBaseUrl(), 'lab/index.html'),
      window.location.href
    ).href;
    const client = environment
      ? new Auth0Client({
          domain: environment.auth0Domain,
          clientId: environment.clientId,
          authorizationParams: {
            redirect_uri: redirectUri,
            scope: 'openid profile email offline_access'
          },
          // Tokens stay in memory, never in localStorage: this page renders notebook outputs,
          // so a refresh token at rest would be one script away from exfiltration.
          cacheLocation: 'memory',
          useRefreshTokens: true,
          useRefreshTokensFallback: true
        })
      : null;
    if (!environment) {
      console.info(
        `${PLUGIN_ID}: no Oceanum environment for ${window.location.hostname}`
      );
    }
    const auth = new OceanumAuth({
      environment,
      client,
      redirectUri,
      location: {
        href: () => window.location.href,
        replace: url =>
          window.history.replaceState(window.history.state, '', url)
      },
      onSessionExpired: () => {
        Notification.warning(
          'Your Oceanum.io session has ended. Sign in again to use Datamesh.',
          {
            autoClose: false
          }
        );
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void auth.refresh();
      }
    });
    void auth.initialize();
    return auth;
  }
};

const kernelPlugin: JupyterFrontEndPlugin<void> = {
  id: '@oceanum/auth-oceanum:kernel',
  description:
    'Sets up every kernel: the oceanum Content-Type patch, DATAMESH_SERVICE and DATAMESH_TOKEN.',
  autoStart: true,
  requires: [IOceanumAuth],
  optional: [INotebookTracker, IConsoleTracker],
  activate: (
    _app: JupyterFrontEnd,
    auth: IOceanumAuth,
    notebooks: INotebookTracker | null,
    consoles: IConsoleTracker | null
  ): void => {
    let token: string | null = null;
    const bridge = new KernelCredentialBridge(() =>
      kernelSetupCode({
        bootstrapSource,
        datameshUrl: auth.urls?.datamesh ?? null,
        accessToken: token
      })
    );
    const setToken = (value: string | null): void => {
      if (value !== token) {
        token = value;
        bridge.refresh();
      }
    };
    auth.tokenChanged.connect((_, value) => setToken(value));
    // A login redirect can complete before this plugin activates, so the signal alone could
    // miss the first token.
    void auth.ready.then(() => auth.getAccessToken()).then(setToken);
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
  description: 'Sign-in commands and the top-bar account control.',
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
      execute: async () => {
        if (labStatus?.isDirty) {
          const result = await showDialog({
            title: 'Sign in to Oceanum.io',
            body: 'Signing in reloads the page, and you have unsaved changes. Save your work first.',
            buttons: [
              Dialog.cancelButton(),
              Dialog.warnButton({ label: 'Sign in anyway' })
            ]
          });
          if (!result.button.accept) {
            return;
          }
        }
        await auth.signIn();
      }
    });
    commands.addCommand(CommandIDs.signOut, {
      label: 'Sign out of Oceanum.io',
      isVisible: () => auth.user !== null,
      execute: () => auth.signOut()
    });
    commands.addCommand(CommandIDs.account, {
      label: () =>
        auth.user ? `Signed in as ${auth.user.email}` : 'Not signed in',
      isEnabled: () => false,
      execute: () => undefined
    });
    auth.userChanged.connect(() => commands.notifyCommandChanged());

    if (palette) {
      palette.addItem({ command: CommandIDs.signIn, category: 'Oceanum' });
      palette.addItem({ command: CommandIDs.signOut, category: 'Oceanum' });
    }
    app.shell.add(new AccountWidget(auth, commands), 'top', { rank: 1000 });
  }
};

/**
 * The Oceanum sign-in plugins, spread into oceanumlab's extension list.
 *
 * The ids stay `@oceanum/auth-oceanum:*` although this now ships inside
 * `@oceanum/oceanumlab`, because deployed `jupyter-lite.json` files key their
 * `litePluginSettings` on them (see config.ts) and renaming would silently drop every
 * environment table.
 *
 * The cost: oceanum-notebook still ships its own `@oceanum/auth-oceanum` labextension
 * alongside a pinned oceanumlab. When that pin is bumped past this change, both
 * extensions register these four ids in one application. Retire the notebook's copy in
 * the same change as the bump, not after it.
 */
export const authPlugins: JupyterFrontEndPlugin<unknown>[] = [
  authPlugin,
  kernelPlugin,
  colorSchemePlugin,
  accountPlugin
];

export default authPlugins;

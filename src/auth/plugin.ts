import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Dialog, ICommandPalette, Notification } from '@jupyterlab/apputils';
import { PageConfig, URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

import { AccountWidget, CommandIDs, SignInBody } from './accountWidget';
import {
  AuthRequest,
  readServerAuthOption,
  SERVER_AUTH_OPTION,
  ServerAuth
} from './serverAuth';
import { IOceanumAuth } from './tokens';

/**
 * The id other deployments disable. notebook.oceanum.io provides IOceanumAuth from its own
 * Oceanum widget extension, and Lumino lets a second provider silently replace the first
 * rather than refusing it, so that site lists this id under `disabledExtensions`.
 */
export const DEVICE_AUTH_PLUGIN_ID = '@oceanum/oceanumlab:device-auth';

function serverRequest(settings: ServerConnection.ISettings): AuthRequest {
  return async (action, method) => {
    const url = URLExt.join(settings.baseUrl, 'oceanum', 'auth', action);
    const response = await ServerConnection.makeRequest(
      url,
      { method },
      settings
    );
    if (!response.ok) {
      throw new ServerConnection.ResponseError(response);
    }
    return response.json();
  };
}

/** Show the code and the link until the sign-in completes, fails, or is cancelled. */
async function showSignIn(auth: ServerAuth): Promise<void> {
  const pending = auth.pending;
  if (!pending) {
    return;
  }
  const dialog = new Dialog({
    title: 'Sign in to Oceanum.io',
    body: new SignInBody(pending),
    buttons: [Dialog.cancelButton()]
  });
  const closeWhenSettled = (): void => {
    if (auth.pending === null) {
      dialog.reject();
    }
  };
  auth.stateChanged.connect(closeWhenSettled);
  auth.userChanged.connect(closeWhenSettled);
  try {
    await dialog.launch();
  } finally {
    auth.stateChanged.disconnect(closeWhenSettled);
    auth.userChanged.disconnect(closeWhenSettled);
  }
  if (auth.pending) {
    // Still waiting, so it was the user who closed it.
    await auth.cancelSignIn();
  } else if (!auth.user && auth.error) {
    Notification.warning(`Oceanum.io sign-in did not complete: ${auth.error}`, {
      autoClose: false
    });
  }
}

export const deviceAuthPlugin: JupyterFrontEndPlugin<IOceanumAuth> = {
  id: DEVICE_AUTH_PLUGIN_ID,
  description:
    'Oceanum.io sign-in by device code, run by the Jupyter server extension.',
  autoStart: true,
  provides: IOceanumAuth,
  optional: [ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette | null
  ): IOceanumAuth => {
    const environment = readServerAuthOption(
      PageConfig.getOption(SERVER_AUTH_OPTION),
      window.location.hostname
    );
    const auth = new ServerAuth({
      environment,
      request: serverRequest(app.serviceManager.serverSettings),
      onSessionEnded: message =>
        Notification.warning(message, { autoClose: false })
    });
    if (!environment) {
      // The server offers no sign-in (`c.OceanumLab.sign_in = "off"`), or there is no
      // oceanumlab server extension at all. Consumers see an auth with no environment and
      // say sign-in is not configured; nothing is added to the top bar.
      return auth;
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void auth.refresh();
      }
    });

    const { commands } = app;
    let dialogOpen = false;
    commands.addCommand(CommandIDs.signIn, {
      label: 'Sign in to Oceanum.io',
      isVisible: () => !auth.user,
      execute: async () => {
        await auth.signIn();
        if (auth.pending && !dialogOpen) {
          dialogOpen = true;
          try {
            await showSignIn(auth);
          } finally {
            dialogOpen = false;
          }
        } else if (!auth.user && !auth.pending && auth.error) {
          Notification.warning(
            `Oceanum.io sign-in could not start: ${auth.error}`,
            { autoClose: false }
          );
        }
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
    commands.addCommand(CommandIDs.accessToken, {
      label: 'Oceanum.io access token',
      isVisible: () => false,
      execute: () => auth.getAccessToken().catch((): null => null)
    });
    auth.userChanged.connect(() => commands.notifyCommandChanged());

    if (palette) {
      palette.addItem({ command: CommandIDs.signIn, category: 'Oceanum' });
      palette.addItem({ command: CommandIDs.signOut, category: 'Oceanum' });
    }
    app.shell.add(new AccountWidget(auth, commands), 'top', { rank: 1000 });
    return auth;
  }
};

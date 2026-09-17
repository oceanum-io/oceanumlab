/**
 * The Oceanum nav (@oceanum/oceanum-io-nav) in the JupyterLab top bar: the same sign-in button,
 * app switcher, profile and consent dialogs as the other Oceanum apps.
 *
 * It owns the Auth0 session. React and Mantine are bundled privately with this extension
 * (jupyterlab.sharedPackages in package.json): io-nav needs React 19, while JupyterLab's own
 * React is 18 and shared as a singleton. Only Mantine's scoped styles are imported; its
 * baseline.css would restyle every element on the page.
 *
 * default-css-variables.css only defines --mantine-* custom properties, but it is required.
 * MantineProvider leaves out every variable that equals Mantine's default, expecting this file to
 * supply it. Without it, radii, spacing and font sizes are undefined, and the nav's buttons and
 * avatar lose their rounded corners.
 */
import '@mantine/core/styles/default-css-variables.css';
import '@mantine/core/styles/global.css';
import '@mantine/core/styles/UnstyledButton.css';
import '@mantine/core/styles/Button.css';
import '@mantine/core/styles/ActionIcon.css';
import '@mantine/core/styles/CloseButton.css';
import '@mantine/core/styles/Avatar.css';
import '@mantine/core/styles/Paper.css';
import '@mantine/core/styles/Card.css';
import '@mantine/core/styles/Group.css';
import '@mantine/core/styles/Text.css';
import '@mantine/core/styles/ThemeIcon.css';
import '@mantine/core/styles/Loader.css';
import '@mantine/core/styles/Popover.css';
import '@mantine/core/styles/Menu.css';
import '@mantine/core/styles/Tooltip.css';
import '@mantine/core/styles/ScrollArea.css';
import '@mantine/core/styles/Overlay.css';
import '@mantine/core/styles/ModalBase.css';
import '@mantine/core/styles/Modal.css';
import '@mantine/core/styles/Affix.css';
import '@mantine/core/styles/Dialog.css';

import { MantineColorSchemeManager, MantineProvider } from '@mantine/core';
import { OceanumNavProvider, useOceanumNav } from '@oceanum/oceanum-io-nav';
import { cssVariablesResolver, theme } from '@oceanum/theme';
import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

import { INavControls, INavState, LoginStatus } from './auth';
import { IOceanumEnvironment } from './tokens';

/** Receives the nav's state and actions (NavAuth). */
export interface INavHost {
  update(state: INavState): void;
  attach(controls: INavControls | null): void;
}

export interface INavOptions {
  environment: IOceanumEnvironment;
  host: INavHost;
  colorSchemeManager: MantineColorSchemeManager;
  /** Where sign-out returns to: this notebook. Must be an allowed logout URL in Auth0. */
  logoutRedirect: string;
}

const SIGNED_OUT: INavState = {
  loginStatus: LoginStatus.SignedOut,
  claims: null,
  accessToken: undefined
};

/** Reports the nav's state to the host and renders the nav itself. */
function Bridge({ host }: { host: INavHost }): React.ReactElement {
  const nav = useOceanumNav();
  const {
    loginStatus,
    user,
    accessToken,
    doSignin,
    signout,
    getAccessToken,
    NavBar
  } = nav;
  // The nav's loginStatus starts at SignedOut before its own effect switches to Loading
  // while Auth0 restores the session, and this child effect runs first. Reporting that
  // initial value would resolve `ready` as signed out before the session is restored.
  const started = useRef(false);

  useEffect(() => {
    if (loginStatus !== LoginStatus.SignedOut) {
      started.current = true;
    }
    if (!started.current) {
      return;
    }
    host.update({
      loginStatus,
      claims: user as Record<string, unknown> | null,
      accessToken
    });
  }, [host, loginStatus, user, accessToken]);

  useEffect(() => {
    host.attach({
      signIn: () => doSignin(true),
      signOut: () => signout(),
      getAccessToken: () => getAccessToken()
    });
    return () => host.attach(null);
  }, [host, doSignin, signout, getAccessToken]);

  return NavBar;
}

interface IBoundaryProps {
  host: INavHost;
  children: React.ReactNode;
}

/**
 * If the nav fails to render, report signed-out so `IOceanumAuth.ready` still resolves and the
 * notebook keeps working without Datamesh credentials. (Error boundaries must be classes.)
 */
class NavErrorBoundary extends React.Component<
  IBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('Oceanum Notebook: the Oceanum nav failed to render', error);
    this.props.host.attach(null);
    this.props.host.update(SIGNED_OUT);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Render the Oceanum nav into `node`. Returns a function that unmounts it. */
export function mountNav(node: HTMLElement, options: INavOptions): () => void {
  const { environment, host, colorSchemeManager, logoutRedirect } = options;
  const root = createRoot(node);
  root.render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      colorSchemeManager={colorSchemeManager}
      defaultColorScheme="light"
    >
      <NavErrorBoundary host={host}>
        <OceanumNavProvider
          auth0Domain={environment.auth0Domain}
          auth0ClientId={environment.clientId}
          oceanumDomain={environment.oceanumDomain}
          userManagementService={environment.urls.manage}
          // This page runs notebook code: keep refresh tokens out of localStorage, where any
          // script in an output cell could read them.
          cacheLocation="memory"
          // A popup, so signing in never reloads the page and its kernels.
          popupLogin={true}
          logoutRedirect={logoutRedirect}
          // The nav otherwise navigates back to the pre-login URL, reloading the page.
          onPostLoginRedirect={() => undefined}
          // The nav can take an access token by postMessage (for hosts such as the VS Code
          // webview) without checking where the message came from. Here, any site that opened
          // this page could sign it in as another account, whose token would reach the kernels.
          acceptExternalToken={false}
        >
          <Bridge host={host} />
        </OceanumNavProvider>
      </NavErrorBoundary>
    </MantineProvider>
  );
  return () => root.unmount();
}

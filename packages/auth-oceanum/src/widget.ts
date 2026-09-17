import { Widget } from '@lumino/widgets';

import { IColorSchemeManager } from './colorScheme';
import { INavHost, mountNav } from './nav';
import { IOceanumEnvironment } from './tokens';

export const CommandIDs = {
  signIn: 'oceanum-auth:sign-in',
  signOut: 'oceanum-auth:sign-out',
  account: 'oceanum-auth:account',
  /**
   * For other extensions, such as oceanumlab's AI chat: resolves to the current access token,
   * or `null` when signed out. Never rejects.
   */
  accessToken: 'oceanum-auth:access-token'
} as const;

export interface INavWidgetOptions {
  /** The environment for this page, or `null` when sign-in is not configured for it. */
  environment: IOceanumEnvironment | null;
  host: INavHost;
  colorSchemeManager: IColorSchemeManager;
  /** Where sign-out returns to. */
  logoutRedirect: string;
  /** The page hostname, named when sign-in is unavailable. */
  hostname: string;
}

/**
 * The top-bar account control: the Oceanum nav, or a note that sign-in is not configured for
 * this host. It is never hidden, because a missing control reads as a bug rather than as
 * "not available here".
 */
export class NavWidget extends Widget {
  constructor(options: INavWidgetOptions) {
    super();
    // The application shell refuses widgets without an id.
    this.id = 'oceanum-account';
    this.addClass('oc-Account');
    if (options.environment) {
      this._unmount = mountNav(this.node, {
        environment: options.environment,
        host: options.host,
        colorSchemeManager: options.colorSchemeManager,
        logoutRedirect: options.logoutRedirect
      });
    } else {
      this.addClass('oc-mod-unavailable');
      this.node.textContent = 'Sign-in unavailable';
      this.node.title = `Oceanum.io sign-in is not configured for ${options.hostname}`;
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._unmount?.();
    this._unmount = null;
    super.dispose();
  }

  private _unmount: (() => void) | null = null;
}

import { PageConfig } from '@jupyterlab/coreutils';
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

const constructed: Record<string, unknown>[] = [];

jest.mock('@auth0/auth0-spa-js', () => ({
  Auth0Client: class {
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
  }
}));

// The kernel bootstrap is inlined by a webpack asset/source rule, which jest has no
// equivalent for; `virtual` lets it stand in for a module jest cannot resolve.
jest.mock('../../kernel/bootstrap.py', () => 'BOOTSTRAP', { virtual: true });

import { authPlugins } from '../auth/plugin';
import { PLUGIN_ID } from '../auth/config';

/**
 * The Auth0 client options the sign-in plugin builds, by activating it against an
 * environment whose host matches jsdom's.
 */
function activateAuth(): Record<string, unknown> {
  const plugin = authPlugins.find(
    (candidate): candidate is JupyterFrontEndPlugin<unknown> =>
      candidate.id === PLUGIN_ID
  );
  if (!plugin) {
    throw new Error(`no plugin with id ${PLUGIN_ID}`);
  }
  PageConfig.setOption(
    'litePluginSettings',
    JSON.stringify({
      [PLUGIN_ID]: {
        environments: [
          {
            hosts: [window.location.hostname],
            auth0Domain: 'auth.example.com',
            clientId: 'client-id',
            urls: {
              datamesh: 'https://datamesh.example.com',
              specs: 'https://specs.example.com',
              manage: 'https://manage.example.com'
            }
          }
        ]
      }
    })
  );
  constructed.length = 0;
  plugin.activate({} as JupyterFrontEnd);
  if (constructed.length !== 1) {
    throw new Error(`expected one Auth0Client, got ${constructed.length}`);
  }
  return constructed[0];
}

describe('Auth0 client options', () => {
  /**
   * This is a security property, not a preference. A JupyterLab page renders notebook
   * output, which can carry arbitrary script, so a refresh token at rest in
   * localStorage would be one malicious notebook away from exfiltration. Both
   * 'memory' and 'localstorage' are legal CacheLocation values, so neither the
   * compiler nor any other test notices if this is changed.
   */
  it('keeps tokens in memory, never in web storage', () => {
    expect(activateAuth().cacheLocation).toBe('memory');
  });

  it('uses refresh tokens, which memory caching depends on to survive a reload', () => {
    const options = activateAuth();
    expect(options.useRefreshTokens).toBe(true);
    expect(options.useRefreshTokensFallback).toBe(true);
  });
});

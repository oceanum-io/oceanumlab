import { describe, expect, it, vi } from 'vitest';

import {
  offersSignIn,
  parseEnvironments,
  PLUGIN_ID,
  readEnvironments,
  readEnvironmentsOption,
  selectEnvironment
} from './config';

const prod = {
  hosts: ['notebook.oceanum.io'],
  auth0Domain: 'auth.oceanum.io',
  clientId: 'prod-client',
  oceanumDomain: 'oceanum.io',
  urls: {
    datamesh: 'https://datamesh.oceanum.io/',
    specs: 'https://specs.oceanum.io',
    manage: 'https://manage.oceanum.io'
  }
};

function settings(environments: unknown): string {
  return JSON.stringify({ [PLUGIN_ID]: { environments }, other: {} });
}

describe('readEnvironments', () => {
  it('parses environments and strips trailing slashes from URLs', () => {
    const [environment] = readEnvironments(settings([prod]));

    expect(environment.urls.datamesh).toBe('https://datamesh.oceanum.io');
    expect(environment.hosts).toEqual(['notebook.oceanum.io']);
    expect(environment.oceanumDomain).toBe('oceanum.io');
    expect(environment.signInRedirect).toBe(false);
  });

  it('reads optional Datamesh UI and Oceanum AI URLs, ignoring invalid ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const [withBoth, without, invalid] = readEnvironments(
      settings([
        {
          ...prod,
          urls: {
            ...prod.urls,
            datameshUi: 'https://ui.datamesh.oceanum.io/',
            ai: 'https://ai.oceanum.io/'
          }
        },
        prod,
        {
          ...prod,
          urls: {
            ...prod.urls,
            datameshUi: 'javascript:alert(1)',
            ai: 'not a url'
          }
        }
      ])
    );

    expect(withBoth.urls.datameshUi).toBe('https://ui.datamesh.oceanum.io');
    expect(withBoth.urls.ai).toBe('https://ai.oceanum.io');
    expect(without.urls.datameshUi).toBeUndefined();
    expect(without.urls.ai).toBeUndefined();
    expect(invalid.urls.datameshUi).toBeUndefined();
    expect(invalid.urls.ai).toBeUndefined();
    expect(invalid.urls.datamesh).toBe('https://datamesh.oceanum.io');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('turns the sign-in redirect on only when set to true', () => {
    const [on, off] = readEnvironments(
      settings([
        { ...prod, signInRedirect: true },
        { ...prod, signInRedirect: 'yes' }
      ])
    );
    expect(on.signInRedirect).toBe(true);
    expect(off.signInRedirect).toBe(false);
  });

  it('returns nothing for missing or malformed settings', () => {
    expect(readEnvironments(undefined)).toEqual([]);
    expect(readEnvironments('')).toEqual([]);
    expect(readEnvironments('not json')).toEqual([]);
    expect(readEnvironments(JSON.stringify({ [PLUGIN_ID]: {} }))).toEqual([]);
  });

  it('drops invalid environments but keeps valid ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = [
      { ...prod, clientId: '' },
      { ...prod, hosts: [] },
      { ...prod, oceanumDomain: undefined },
      { ...prod, oceanumDomain: 'https://oceanum.io' },
      { ...prod, oceanumDomain: 'oceanum.io/evil' },
      { ...prod, oceanumDomain: '.oceanum.io' },
      { ...prod, oceanumDomain: 'localhost' },
      { ...prod, urls: { ...prod.urls, specs: 'javascript:alert(1)' } },
      { ...prod, urls: { datamesh: prod.urls.datamesh } }
    ];

    expect(readEnvironments(settings([...invalid, prod]))).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(invalid.length);
    warn.mockRestore();
  });
});

describe('selectEnvironment', () => {
  const environments = readEnvironments(settings([prod]));

  it('matches the page hostname case-insensitively', () => {
    expect(
      selectEnvironment(environments, 'Notebook.Oceanum.io')?.clientId
    ).toBe('prod-client');
  });

  it('returns null for an unknown host', () => {
    expect(
      selectEnvironment(environments, 'notebook.oceanum.io.evil.example')
    ).toBeNull();
  });
});

describe('offersSignIn', () => {
  // Whether the account control reaches the top bar at all. Getting this wrong is visible on
  // every install: oceanumlab ships to ordinary JupyterLab, which declares no environments,
  // and a "Sign-in unavailable" notice there would be permanent noise.
  it('says no when the deployment declares no environments', () => {
    // What an ordinary JupyterLab yields: it sets no litePluginSettings at all.
    expect(offersSignIn(readEnvironments(undefined))).toBe(false);
    expect(offersSignIn([])).toBe(false);
  });

  it('says yes when environments are declared, even with none for this host', () => {
    // Declared but unmatched is a misconfiguration, and the control has to be there to
    // report it rather than silently vanishing.
    const environments = readEnvironments(settings([prod]));
    expect(selectEnvironment(environments, 'localhost')).toBeNull();
    expect(offersSignIn(environments)).toBe(true);
  });
});

describe('parseEnvironments', () => {
  it('drops invalid entries and anything that is not an array', () => {
    expect(parseEnvironments([prod, { hosts: [] }, 'nonsense'])).toHaveLength(
      1
    );
    expect(parseEnvironments(undefined)).toEqual([]);
    expect(parseEnvironments({ environments: [prod] })).toEqual([]);
  });
});

describe('readEnvironmentsOption', () => {
  // What a native JupyterLab uses: the server extension publishes this page option from
  // jupyter_server_config, so the environments are never a user-editable setting. It must
  // validate identically to the JupyterLite source, or a deployment could be accepted on one
  // host and silently dropped on the other.
  it('accepts the same environments the JupyterLite page option does', () => {
    const viaServer = readEnvironmentsOption(JSON.stringify([prod]));
    const viaLite = readEnvironments(settings([prod]));
    expect(viaServer).toEqual(viaLite);
    expect(viaServer[0].urls.datamesh).toBe('https://datamesh.oceanum.io');
  });

  it('returns nothing for a missing or malformed option', () => {
    expect(readEnvironmentsOption(undefined)).toEqual([]);
    expect(readEnvironmentsOption('')).toEqual([]);
    expect(readEnvironmentsOption('not json')).toEqual([]);
    // An object rather than the array the server publishes.
    expect(
      readEnvironmentsOption(JSON.stringify({ environments: [prod] }))
    ).toEqual([]);
  });
});

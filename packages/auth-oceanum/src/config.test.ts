import { describe, expect, it, vi } from 'vitest';

import { PLUGIN_ID, readEnvironments, selectEnvironment } from './config';

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

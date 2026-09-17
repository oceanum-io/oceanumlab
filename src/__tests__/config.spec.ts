import { PLUGIN_ID, readEnvironments, selectEnvironment } from '../auth/config';

const prod = {
  hosts: ['notebook.oceanum.io'],
  auth0Domain: 'auth.oceanum.io',
  clientId: 'prod-client',
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
  });

  it('returns nothing for missing or malformed settings', () => {
    expect(readEnvironments(undefined)).toEqual([]);
    expect(readEnvironments('')).toEqual([]);
    expect(readEnvironments('not json')).toEqual([]);
    expect(readEnvironments(JSON.stringify({ [PLUGIN_ID]: {} }))).toEqual([]);
  });

  it('drops invalid environments but keeps valid ones', () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const invalid = [
      { ...prod, clientId: '' },
      { ...prod, hosts: [] },
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

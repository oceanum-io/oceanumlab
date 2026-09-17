import { describe, expect, it, vi } from 'vitest';

import {
  IBrowser,
  isAuthCallback,
  REDIRECT_STATE_KEY,
  signInRedirect
} from './signInRedirect';
import { IOceanumEnvironment } from './tokens';

const environment: IOceanumEnvironment = {
  hosts: ['notebook.oceanum.tech'],
  auth0Domain: 'oceanum-test.au.auth0.com',
  clientId: 'dev-client',
  oceanumDomain: 'oceanum.tech',
  urls: {
    datamesh: 'https://datamesh.oceanum.tech',
    specs: 'https://specs.oceanum.tech',
    manage: 'https://manage.oceanum.tech'
  },
  signInRedirect: true
};

function fakeBrowser(where: Partial<IBrowser['location']> = {}) {
  const items = new Map<string, string>();
  const loginWithRedirect = vi.fn(async () => undefined);
  const browser = {
    location: {
      hostname: 'notebook.oceanum.tech',
      origin: 'https://notebook.oceanum.tech',
      pathname: '/lab/index.html',
      search: '',
      hash: '',
      ...where
    },
    storage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key)
    },
    history: { state: null, replaceState: vi.fn() },
    createClient: vi.fn(async () => ({ loginWithRedirect }))
  };
  return {
    browser: browser as unknown as IBrowser & typeof browser,
    items,
    loginWithRedirect
  };
}

describe('signInRedirect', () => {
  it('is off unless the environment turns it on', () => {
    const { browser } = fakeBrowser();
    expect(
      signInRedirect({ ...environment, signInRedirect: false }, browser)
    ).toBeNull();
  });

  it("redirects silently to Auth0, back to the site origin, with the nav client's settings", async () => {
    const { browser, items, loginWithRedirect } = fakeBrowser({
      hash: '#section'
    });
    const redirect = signInRedirect(environment, browser)!;

    expect(redirect.shouldTry()).toBe(true);
    await redirect.start();

    expect(items.get(REDIRECT_STATE_KEY)).toBe('pending');
    expect(browser.createClient).toHaveBeenCalledWith({
      domain: 'oceanum-test.au.auth0.com',
      clientId: 'dev-client',
      useRefreshTokens: true,
      cacheLocation: 'memory',
      authorizationParams: { redirect_uri: 'https://notebook.oceanum.tech' }
    });
    expect(loginWithRedirect).toHaveBeenCalledWith({
      authorizationParams: {
        prompt: 'none',
        redirect_uri: 'https://notebook.oceanum.tech'
      },
      appState: { returnTo: '/lab/index.html#section' }
    });
  });

  it('does not redirect on localhost, with a query, or once a redirect is out or found none', () => {
    expect(
      signInRedirect(
        environment,
        fakeBrowser({ hostname: 'localhost' }).browser
      )!.shouldTry()
    ).toBe(false);
    expect(
      signInRedirect(
        environment,
        fakeBrowser({ search: '?oceanum-notebook=abc' }).browser
      )!.shouldTry()
    ).toBe(false);
    for (const state of ['pending', 'no-session']) {
      const { browser, items } = fakeBrowser();
      items.set(REDIRECT_STATE_KEY, state);
      expect(signInRedirect(environment, browser)!.shouldTry()).toBe(false);
    }
  });

  it('gives up for this tab if the redirect cannot start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { browser, items } = fakeBrowser();
    browser.createClient.mockRejectedValueOnce(new Error('offline'));

    await signInRedirect(environment, browser)!.start();

    expect(items.get(REDIRECT_STATE_KEY)).toBe('no-session');
    warn.mockRestore();
  });

  it('remembers a redirect that found no session, and tidies the returned URL', () => {
    const { browser, items } = fakeBrowser({
      search:
        '?error=login_required&error_description=Login%20required&state=abc'
    });
    items.set(REDIRECT_STATE_KEY, 'pending');

    signInRedirect(environment, browser)!.settled(false);

    expect(items.get(REDIRECT_STATE_KEY)).toBe('no-session');
    expect(browser.history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/lab/index.html'
    );
  });

  it('forgets the check once signed in, so a reload can sign in again', () => {
    const { browser, items } = fakeBrowser();
    items.set(REDIRECT_STATE_KEY, 'pending');

    signInRedirect(environment, browser)!.settled(true);

    expect(items.has(REDIRECT_STATE_KEY)).toBe(false);
  });

  it('leaves an ordinary URL alone when settling signed out', () => {
    const { browser, items } = fakeBrowser({ search: '?oceanum-notebook=abc' });

    signInRedirect(environment, browser)!.settled(false);

    expect(items.has(REDIRECT_STATE_KEY)).toBe(false);
    expect(browser.history.replaceState).not.toHaveBeenCalled();
  });
});

describe('isAuthCallback', () => {
  it('recognises a code or error with its state', () => {
    expect(isAuthCallback('?code=x&state=y')).toBe(true);
    expect(isAuthCallback('?state=y&error=login_required')).toBe(true);
    expect(isAuthCallback('?oceanum-notebook=abc')).toBe(false);
    expect(isAuthCallback('?code=x')).toBe(false);
  });
});

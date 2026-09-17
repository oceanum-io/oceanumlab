import { Signal } from '@lumino/signaling';

import type { IChangedArgs } from '@jupyterlab/coreutils';

import {
  ColorSchemeSync,
  DARK_THEME,
  IThemes,
  LIGHT_THEME,
  themeForScheme
} from '../auth/colorScheme';
import { IOceanumAuth, IOceanumUser } from '../auth/tokens';

function user(
  colorScheme: IOceanumUser['colorScheme'],
  sub = 'auth0|1'
): IOceanumUser {
  return {
    sub,
    email: 'u@example.com',
    name: null,
    activeOrg: null,
    colorScheme
  };
}

function setup(
  initialTheme = LIGHT_THEME,
  registered = [LIGHT_THEME, DARK_THEME, 'JupyterLab Dark']
) {
  const auth = {
    user: null as IOceanumUser | null,
    urls: { datamesh: '', specs: '', manage: 'https://manage.oceanum.tech' },
    // The signal's owner is never read by these tests; it only has to be an
    // IOceanumAuth to satisfy the type parameter.
    userChanged: new Signal<IOceanumAuth, IOceanumUser | null>(
      {} as IOceanumAuth
    ),
    getAccessToken: jest.fn(async () => 'jwt')
  };
  const themeChanged = new Signal<unknown, IChangedArgs<string, string | null>>(
    {}
  );
  const themes: IThemes & { theme: string } = {
    theme: initialTheme,
    themes: registered,
    themeChanged,
    // Like ThemeManager.isLight, which reads a property of the registered theme.
    isLight: name => {
      if (!registered.includes(name)) {
        throw new TypeError(
          "Cannot read properties of undefined (reading 'isLight')"
        );
      }
      return !name.includes('Dark');
    },
    setTheme: jest.fn(async (name: string) => {
      const oldValue = themes.theme;
      themes.theme = name;
      themeChanged.emit({ name: 'theme', oldValue, newValue: name });
    })
  };
  const fetch = jest.fn(async () => new Response(null, { status: 200 }));
  new ColorSchemeSync({
    auth: auth as unknown as IOceanumAuth,
    themes,
    fetch: fetch as unknown as typeof globalThis.fetch,
    prefersDark: () => true
  });
  const signIn = (u: IOceanumUser | null) => {
    auth.user = u;
    auth.userChanged.emit(u);
  };
  const userChangesTheme = (name: string) => themes.setTheme(name);
  return { auth, themes, fetch, signIn, userChangesTheme };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('themeForScheme', () => {
  it('maps schemes to Oceanum themes, following the OS for auto', () => {
    expect(themeForScheme('light', true)).toBe(LIGHT_THEME);
    expect(themeForScheme('dark', false)).toBe(DARK_THEME);
    expect(themeForScheme('auto', true)).toBe(DARK_THEME);
    expect(themeForScheme('auto', false)).toBe(LIGHT_THEME);
  });
});

describe('ColorSchemeSync', () => {
  it('applies the claim at sign-in without writing it back', async () => {
    const { themes, fetch, signIn } = setup();

    signIn(user('dark'));
    await flush();

    expect(themes.theme).toBe(DARK_THEME);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('writes a theme change made in the notebook back to the user metadata', async () => {
    const { fetch, signIn, userChangesTheme } = setup();
    signIn(user('light'));
    await flush();

    await userChangesTheme('JupyterLab Dark');
    await flush();

    expect(fetch).toHaveBeenCalledWith(
      'https://manage.oceanum.tech/users/auth0%7C1/metadata',
      expect.objectContaining({
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer jwt',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ color_scheme: 'dark' })
      })
    );
  });

  it('does not write when the change keeps the same light/dark scheme', async () => {
    const { fetch, signIn, userChangesTheme } = setup('JupyterLab Light');
    signIn(user(null));
    await flush();

    await userChangesTheme(LIGHT_THEME);
    await flush();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores theme changes while signed out', async () => {
    const { fetch, userChangesTheme } = setup();

    await userChangesTheme(DARK_THEME);
    await flush();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not re-apply a stale claim when a token refresh re-emits the same user', async () => {
    const { themes, signIn, userChangesTheme } = setup();
    signIn(user('light'));
    await flush();
    await userChangesTheme(DARK_THEME);
    await flush();

    signIn({ ...user('light'), name: 'refreshed' });
    await flush();

    expect(themes.theme).toBe(DARK_THEME);
  });

  it('does not fail when the Oceanum themes are not registered', async () => {
    const { themes, signIn } = setup('JupyterLab Light', ['JupyterLab Light']);

    signIn(user('dark'));
    await flush();

    expect(themes.setTheme).not.toHaveBeenCalled();
  });
});

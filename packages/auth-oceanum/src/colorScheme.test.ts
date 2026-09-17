import { Signal } from '@lumino/signaling';
import { describe, expect, it, vi } from 'vitest';

import type { IChangedArgs } from '@jupyterlab/coreutils';

import {
  ColorSchemeSync,
  DARK_THEME,
  IThemes,
  LIGHT_THEME,
  schemeOfTheme,
  themeColorSchemeManager,
  themeForScheme
} from './colorScheme';
import { IOceanumAuth, IOceanumUser } from './tokens';

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
    userChanged: new Signal<IOceanumAuth, IOceanumUser | null>({}),
    getAccessToken: vi.fn(async () => 'jwt')
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
    setTheme: vi.fn(async (name: string) => {
      const oldValue = themes.theme;
      themes.theme = name;
      themeChanged.emit({ name: 'theme', oldValue, newValue: name });
    })
  };
  const fetch = vi.fn(async () => new Response(null, { status: 200 }));
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

describe('schemeOfTheme', () => {
  it('is safe for a theme that is not registered yet', () => {
    const { themes } = setup(LIGHT_THEME, []);
    expect(schemeOfTheme(themes, DARK_THEME)).toBe('dark');
    expect(schemeOfTheme(themes, 'Some Future Theme')).toBe('light');
  });

  it('asks the theme manager about other registered themes', () => {
    const { themes } = setup();
    expect(schemeOfTheme(themes, 'JupyterLab Dark')).toBe('dark');
  });
});

describe('themeColorSchemeManager', () => {
  it('reads the scheme from the current notebook theme', () => {
    const { themes } = setup(DARK_THEME);
    expect(themeColorSchemeManager(themes, () => false).get('light')).toBe(
      'dark'
    );
    const unset = { ...themes, theme: null };
    expect(themeColorSchemeManager(unset, () => false).get('light')).toBe(
      'light'
    );
  });

  it("switches the notebook theme when the nav's toggle sets a scheme", () => {
    const { themes } = setup(LIGHT_THEME);
    const manager = themeColorSchemeManager(themes, () => true);

    manager.set('dark');
    expect(themes.theme).toBe(DARK_THEME);
    manager.set('auto'); // follows the OS, which prefers dark here: already dark
    expect(themes.setTheme).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-Oceanum theme whose scheme Mantine echoes back through set()', async () => {
    const { themes, userChangesTheme } = setup(LIGHT_THEME);
    const manager = themeColorSchemeManager(themes, () => false);
    // Mantine's subscribe handler is setColorScheme, which calls manager.set().
    manager.subscribe(scheme => manager.set(scheme));

    await userChangesTheme('JupyterLab Dark');

    expect(themes.theme).toBe('JupyterLab Dark');
    expect(themes.setTheme).toHaveBeenCalledTimes(1); // the user's change only
  });

  it('does nothing for a theme that is not registered', () => {
    const { themes } = setup('JupyterLab Light', ['JupyterLab Light']);
    themeColorSchemeManager(themes, () => false).set('dark');
    expect(themes.setTheme).not.toHaveBeenCalled();
  });

  it('reports theme changes made in the notebook, and stops when unsubscribed', async () => {
    const { themes, userChangesTheme } = setup(LIGHT_THEME);
    const manager = themeColorSchemeManager(themes, () => false);
    const updates: string[] = [];
    manager.subscribe(scheme => updates.push(`first:${scheme}`));
    // Mantine re-subscribes on remount: the old listener must not keep firing.
    manager.subscribe(scheme => updates.push(scheme));

    await userChangesTheme('JupyterLab Dark');
    manager.unsubscribe();
    await userChangesTheme(LIGHT_THEME);

    expect(updates).toEqual(['dark']);
  });
});

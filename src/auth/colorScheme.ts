import type { IChangedArgs } from '@jupyterlab/coreutils';

import { ColorScheme, IOceanumAuth, IOceanumUser } from './tokens';

/** Theme names registered by @oceanum/theme-oceanum. */
export const LIGHT_THEME = 'Oceanum Light';
export const DARK_THEME = 'Oceanum Dark';

export function themeForScheme(
  scheme: ColorScheme,
  prefersDark: boolean
): string {
  const dark = scheme === 'dark' || (scheme === 'auto' && prefersDark);
  return dark ? DARK_THEME : LIGHT_THEME;
}

/** The subset of `IThemeManager` used here. */
export interface IThemes {
  readonly theme: string | null;
  readonly themes: ReadonlyArray<string>;
  readonly themeChanged: {
    connect(
      slot: (
        sender: unknown,
        args: IChangedArgs<string, string | null>
      ) => void,
      thisArg?: unknown
    ): boolean;
  };
  setTheme(name: string): Promise<void>;
  isLight(name: string): boolean;
}

export interface IColorSchemeSyncOptions {
  auth: IOceanumAuth;
  themes: IThemes;
  fetch: typeof fetch;
  prefersDark: () => boolean;
}

/**
 * Follows the Oceanum colour scheme preference in both directions (SPEC §7): the
 * `https://oceanum.io/color_scheme` claim picks the theme at sign-in, and a theme change made
 * in the notebook is written back to the user's Auth0 metadata for the other Oceanum apps.
 */
export class ColorSchemeSync {
  constructor(options: IColorSchemeSyncOptions) {
    this._auth = options.auth;
    this._themes = options.themes;
    this._fetch = options.fetch;
    this._prefersDark = options.prefersDark;
    this._auth.userChanged.connect((_, user) => void this._onUserChanged(user));
    this._themes.themeChanged.connect(
      (_, change) => void this._onThemeChanged(change)
    );
    if (this._auth.user) {
      void this._onUserChanged(this._auth.user);
    }
  }

  private async _onUserChanged(user: IOceanumUser | null): Promise<void> {
    const sub = user?.sub ?? null;
    if (sub === this._sub) {
      // A token refresh can carry a stale claim; only apply the claim when someone signs in.
      return;
    }
    this._sub = sub;
    this._lastKnown = null;
    if (!user) {
      return;
    }
    const current = this._themes.theme;
    if (!user.colorScheme) {
      this._lastKnown = current ? this._schemeOf(current) : null;
      return;
    }
    const target = themeForScheme(user.colorScheme, this._prefersDark());
    this._lastKnown = this._schemeOf(target);
    if (current === target || !this._themes.themes.includes(target)) {
      return;
    }
    this._applying = true;
    try {
      await this._themes.setTheme(target);
    } finally {
      this._applying = false;
    }
  }

  private async _onThemeChanged(
    change: IChangedArgs<string, string | null>
  ): Promise<void> {
    const user = this._auth.user;
    const urls = this._auth.urls;
    if (this._applying || !user || !urls || user.sub !== this._sub) {
      return;
    }
    const scheme = this._schemeOf(change.newValue);
    if (scheme === this._lastKnown) {
      return;
    }
    this._lastKnown = scheme;
    const token = await this._auth.getAccessToken();
    if (!token) {
      return;
    }
    try {
      const response = await this._fetch(
        `${urls.manage}/users/${encodeURIComponent(user.sub)}/metadata`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ color_scheme: scheme })
        }
      );
      if (!response.ok) {
        console.warn(
          `Oceanum colour scheme was not saved (HTTP ${response.status})`
        );
      }
    } catch (reason) {
      console.warn('Oceanum colour scheme was not saved', reason);
    }
  }

  private _schemeOf(theme: string): 'light' | 'dark' {
    // IThemeManager.isLight throws for a theme that has not been registered.
    if (theme === LIGHT_THEME || theme === DARK_THEME) {
      return theme === LIGHT_THEME ? 'light' : 'dark';
    }
    return this._themes.themes.includes(theme) && !this._themes.isLight(theme)
      ? 'dark'
      : 'light';
  }

  private _auth: IOceanumAuth;
  private _themes: IThemes;
  private _fetch: typeof fetch;
  private _prefersDark: () => boolean;
  private _sub: string | null = null;
  private _lastKnown: 'light' | 'dark' | null = null;
  private _applying = false;
}

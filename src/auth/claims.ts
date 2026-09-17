import { ColorScheme, IOceanumUser } from './tokens';

const CLAIM = 'https://oceanum.io/';
const COLOR_SCHEMES: readonly ColorScheme[] = ['light', 'dark', 'auto'];

/** Build the user from Auth0 ID token claims; `null` if the claims lack an identity. */
export function userFromClaims(
  claims: Record<string, unknown> | null | undefined
): IOceanumUser | null {
  if (!claims) {
    return null;
  }
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  const sub = str(claims.sub);
  const email = str(claims.email) ?? str(claims[`${CLAIM}email`]);
  if (!sub || !email) {
    return null;
  }
  const scheme = claims[`${CLAIM}color_scheme`];
  return {
    sub,
    email,
    name: str(claims.name),
    activeOrg: str(claims[`${CLAIM}active_org`]),
    colorScheme: COLOR_SCHEMES.includes(scheme as ColorScheme)
      ? (scheme as ColorScheme)
      : null
  };
}

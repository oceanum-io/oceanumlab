/**
 * Where the Oceanum AI backend is, and what a request to it is signed with.
 *
 * The backend accepts either a Datamesh token (`X-Datamesh-Token`) or an
 * Oceanum.io access token (`Authorization: Bearer`). A token pasted into the
 * settings is explicit, so it wins; otherwise a host that signs users in to
 * Oceanum.io -- Oceanum Notebook -- lends its sign-in through a command. Plain
 * JupyterLab has no such command and needs the pasted token.
 */
import type { CommandRegistry } from '@lumino/commands';
import { OCEANUM_AI_BACKEND_URL } from './constants';
import { validHttpUrl } from './httpUrl';

/**
 * The host's command answering with the current Oceanum.io access token (a
 * JWT), or null when signed out. The token is cached and refreshed by the
 * host, so it is asked for on every use rather than kept.
 */
export const ACCESS_TOKEN_COMMAND = 'oceanum-auth:access-token';

/** The host's command that starts signing in to Oceanum.io. */
export const SIGN_IN_COMMAND = 'oceanum-auth:sign-in';

/** The part of the command registry the sign-in is reached through. */
export type AuthCommands = Pick<CommandRegistry, 'hasCommand' | 'execute'>;

export interface IAiCredential {
  /** Which credential it is: the 401 message differs. */
  source: 'datamesh-token' | 'sign-in';
  headers: Record<string, string>;
}

/**
 * The backend address for an `aiBackendUrl` setting value, without a trailing
 * slash so a path can be appended. An invalid value falls back to the default.
 */
export function aiBackendUrl(value: string | null | undefined): string {
  const url = validHttpUrl(value, OCEANUM_AI_BACKEND_URL);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Whether the host can sign the user in to Oceanum.io. */
export function canSignIn(commands: AuthCommands): boolean {
  return commands.hasCommand(ACCESS_TOKEN_COMMAND);
}

/** Asks the host for its Oceanum.io access token; null without the command. */
export function signInToken(commands: AuthCommands): () => Promise<unknown> {
  return async () =>
    canSignIn(commands) ? commands.execute(ACCESS_TOKEN_COMMAND) : null;
}

/**
 * The credential for a request: the pasted Datamesh token if there is one,
 * otherwise the host's sign-in, otherwise null.
 *
 * @param datameshToken The `datameshToken` setting value.
 * @param getSignInToken Asked only without a pasted token. Anything but a
 *   non-empty string -- including a rejection -- counts as signed out.
 */
export async function resolveAiCredential(
  datameshToken: unknown,
  getSignInToken: () => Promise<unknown>
): Promise<IAiCredential | null> {
  const pasted = typeof datameshToken === 'string' ? datameshToken.trim() : '';
  if (pasted) {
    return {
      source: 'datamesh-token',
      headers: { 'X-Datamesh-Token': pasted }
    };
  }
  let token: unknown;
  try {
    token = await getSignInToken();
  } catch {
    return null;
  }
  const signedIn = typeof token === 'string' ? token.trim() : '';
  if (!signedIn) {
    return null;
  }
  return {
    source: 'sign-in',
    headers: { Authorization: `Bearer ${signedIn}` }
  };
}

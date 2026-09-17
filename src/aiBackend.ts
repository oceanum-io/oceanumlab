/**
 * Where the Oceanum AI backend is, and what a request to it is signed with.
 *
 * The backend accepts either a Datamesh token (`X-Datamesh-Token`) or an
 * Oceanum.io access token (`Authorization: Bearer`). A token pasted into the
 * settings is explicit, so it wins; otherwise a host that signs users in to
 * Oceanum.io -- Oceanum Notebook -- lends its sign-in through its commands.
 * Plain JupyterLab has no such commands and needs the pasted token.
 *
 * Whether the user is signed in, or can sign in, is read with the registry's
 * queries (`isVisible`, `isEnabled`), never by running a command: every
 * `execute` emits `commandExecuted`, which closes JupyterLab's command palette.
 * The access-token command is run only when a token is actually needed.
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

/**
 * The host's command that starts signing in to Oceanum.io. Enabled only where
 * sign-in is configured for the site.
 */
export const SIGN_IN_COMMAND = 'oceanum-auth:sign-in';

/** The host's command that signs out. Visible only while signed in. */
export const SIGN_OUT_COMMAND = 'oceanum-auth:sign-out';

/** The part of the command registry the sign-in is reached through. */
export type AuthCommands = Pick<
  CommandRegistry,
  'hasCommand' | 'execute' | 'isEnabled' | 'isVisible'
>;

export type AiCredentialSource = 'datamesh-token' | 'sign-in';

export interface IAiCredential {
  /** Which credential it is: the 401 message differs. */
  source: AiCredentialSource;
  headers: Record<string, string>;
}

/**
 * The backend address for a configured value, without a trailing
 * slash so a path can be appended. An invalid value falls back to the default.
 */
export function aiBackendUrl(value: string | null | undefined): string {
  const url = validHttpUrl(value, OCEANUM_AI_BACKEND_URL);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** A `datameshToken` setting value, trimmed; '' when there is none. */
export function pastedToken(datameshToken: unknown): string {
  return typeof datameshToken === 'string' ? datameshToken.trim() : '';
}

/**
 * Asks a query of the host's command, treating a missing command, or a query
 * that throws, as false. Queries never emit `commandExecuted`.
 */
function query(
  commands: AuthCommands,
  id: string,
  which: 'isEnabled' | 'isVisible'
): boolean {
  try {
    return commands.hasCommand(id) && commands[which](id);
  } catch {
    return false;
  }
}

/** Whether the host can sign the user in to Oceanum.io on this site. */
export function canSignIn(commands: AuthCommands): boolean {
  return query(commands, SIGN_IN_COMMAND, 'isEnabled');
}

/** Whether the host says the user is signed in to Oceanum.io. */
export function isSignedIn(commands: AuthCommands): boolean {
  return query(commands, SIGN_OUT_COMMAND, 'isVisible');
}

/**
 * Which credential a request would carry, without fetching it: runs no
 * command, so it is safe to ask whenever something changes.
 */
export function aiCredentialSource(
  datameshToken: unknown,
  commands: AuthCommands
): AiCredentialSource | null {
  if (pastedToken(datameshToken)) {
    return 'datamesh-token';
  }
  if (commands.hasCommand(ACCESS_TOKEN_COMMAND) && isSignedIn(commands)) {
    return 'sign-in';
  }
  return null;
}

/**
 * Asks the host for its Oceanum.io access token; null without the command.
 * This runs a command: call it only when a token is needed for a request.
 */
export function signInToken(commands: AuthCommands): () => Promise<unknown> {
  return async () =>
    commands.hasCommand(ACCESS_TOKEN_COMMAND)
      ? commands.execute(ACCESS_TOKEN_COMMAND)
      : null;
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
  const pasted = pastedToken(datameshToken);
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

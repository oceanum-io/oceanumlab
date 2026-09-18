import type { CommandRegistry } from '@lumino/commands';

import { CommandIDs } from './accountWidget';
import type { IOceanumAuth } from './tokens';

/**
 * Start signing in the way this host shows it.
 *
 * On a JupyterLab server the device sign-in command both starts the flow and shows the
 * code dialog; `auth.signIn()` alone starts the flow and shows nothing, so the user is
 * left with a "Signing in…" top bar and no code. notebook.oceanum.io disables that
 * command and provides an auth whose `signIn()` opens the Oceanum sign-in itself.
 */
export async function startSignIn(
  commands: CommandRegistry,
  auth: IOceanumAuth
): Promise<void> {
  if (commands.hasCommand(CommandIDs.signIn)) {
    await commands.execute(CommandIDs.signIn);
    return;
  }
  await auth.signIn();
}

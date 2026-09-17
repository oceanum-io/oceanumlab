import { CommandRegistry } from '@lumino/commands';
import { Menu, Widget } from '@lumino/widgets';

import { IPendingSignIn, ServerAuth } from './serverAuth';

export const CommandIDs = {
  signIn: 'oceanum-auth:sign-in',
  signOut: 'oceanum-auth:sign-out',
  account: 'oceanum-auth:account',
  /**
   * For other parts of oceanumlab and other extensions, such as the AI chat: resolves to
   * the current access token, or `null` when signed out. Never rejects.
   */
  accessToken: 'oceanum-auth:access-token'
} as const;

/**
 * The top-bar account control: "Sign in" when signed out, the user's email with a sign-out
 * menu when signed in.
 */
export class AccountWidget extends Widget {
  constructor(auth: ServerAuth, commands: CommandRegistry) {
    super({ node: document.createElement('button') });
    this._auth = auth;
    this._commands = commands;
    this._menu = new Menu({ commands });
    this._menu.addItem({ command: CommandIDs.account });
    this._menu.addItem({ type: 'separator' });
    this._menu.addItem({ command: CommandIDs.signOut });
    // The application shell refuses widgets without an id.
    this.id = 'oceanum-account';
    this.addClass('oc-Account');
    this.node.setAttribute('type', 'button');
    this.node.addEventListener('click', this._onClick);
    auth.userChanged.connect(this._render, this);
    auth.stateChanged.connect(this._render, this);
    void auth.ready.then(() => this._render());
    this._render();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.node.removeEventListener('click', this._onClick);
    this._menu.dispose();
    super.dispose();
  }

  private _onClick = (): void => {
    if (!this._auth.user) {
      void this._commands.execute(CommandIDs.signIn);
      return;
    }
    const rect = this.node.getBoundingClientRect();
    this._menu.open(rect.left, rect.bottom);
  };

  private _render(): void {
    const user = this._auth.user;
    const waiting = !user && this._auth.pending !== null;
    this.node.textContent = user
      ? user.email
      : waiting
        ? 'Signing in to Oceanum.io…'
        : 'Sign in to Oceanum.io';
    this.node.title = user
      ? `Signed in to Oceanum.io as ${user.email}`
      : 'Sign in to Oceanum.io';
    this.toggleClass('oc-mod-signedIn', user !== null);
  }

  private _auth: ServerAuth;
  private _commands: CommandRegistry;
  private _menu: Menu;
}

/**
 * What the sign-in dialog shows: the code to confirm, and a link to the page that confirms
 * it. A real link rather than `window.open`, which a popup blocker stops once there has
 * been an `await` between the click and the call -- and there always has, because the code
 * comes from the server.
 */
export class SignInBody extends Widget {
  constructor(pending: IPendingSignIn) {
    super();
    this.addClass('oc-SignIn');

    const intro = document.createElement('p');
    intro.textContent =
      'Open the Oceanum.io sign-in page, and check that it shows this code:';

    const code = document.createElement('div');
    code.className = 'oc-SignIn-code';
    code.textContent = pending.userCode;

    const link = document.createElement('a');
    link.className = 'oc-SignIn-link jp-mod-styled jp-mod-accept';
    link.href = pending.verificationUriComplete;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open the sign-in page';

    const note = document.createElement('p');
    note.className = 'oc-SignIn-note';
    const minutes = Math.max(1, Math.round(pending.expiresIn / 60));
    note.textContent =
      `This closes by itself once you have signed in. The code lasts ${minutes} ` +
      `minute${minutes === 1 ? '' : 's'}. Only confirm a code you asked for yourself.`;

    this.node.append(intro, code, link, note);
  }
}

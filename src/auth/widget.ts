import { CommandRegistry } from '@lumino/commands';
import { Menu, Widget } from '@lumino/widgets';

import { IOceanumAuth } from './tokens';

export const CommandIDs = {
  signIn: 'oceanum-auth:sign-in',
  signOut: 'oceanum-auth:sign-out',
  account: 'oceanum-auth:account'
} as const;

/**
 * The top-bar account control: "Sign in" when signed out, the user's email with a sign-out
 * menu when signed in.
 */
export class AccountWidget extends Widget {
  constructor(auth: IOceanumAuth, commands: CommandRegistry) {
    super({ node: document.createElement('button') });
    this._auth = auth;
    this._menu = new Menu({ commands });
    this._menu.addItem({ command: CommandIDs.account });
    this._menu.addItem({ type: 'separator' });
    this._menu.addItem({ command: CommandIDs.signOut });
    this._commands = commands;
    // The application shell refuses widgets without an id.
    this.id = 'oceanum-account';
    this.addClass('oc-Account');
    this.node.setAttribute('type', 'button');
    this.node.addEventListener('click', this._onClick);
    auth.userChanged.connect(this._render, this);
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
    this.node.textContent = user ? user.email : 'Sign in to Oceanum.io';
    this.node.title = user
      ? `Signed in to Oceanum.io as ${user.email}`
      : 'Sign in to Oceanum.io';
    this.node.toggleAttribute('disabled', !user && !this._auth.environment);
    this.toggleClass('oc-mod-signedIn', user !== null);
  }

  private _auth: IOceanumAuth;
  private _commands: CommandRegistry;
  private _menu: Menu;
}

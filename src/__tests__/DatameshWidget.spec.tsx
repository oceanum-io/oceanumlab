/**
 * The sidebar against a fake host and a fake backend: whether the Oceanum AI
 * chat appears, what the capabilities request is signed with, and -- above all
 * -- that watching for a sign-in runs no commands.
 *
 * Every `CommandRegistry.execute` emits `commandExecuted`, and JupyterLab's
 * modal command palette closes itself on any of those. So the sidebar reads
 * `isVisible`/`isEnabled` and listens for `commandChanged`, and only asks for
 * the token when a request needs one.
 */
import { ModalCommandPalette } from '@jupyterlab/apputils';
import { addIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { CommandPalette, Widget } from '@lumino/widgets';

import {
  ACCESS_TOKEN_COMMAND,
  SIGN_IN_COMMAND,
  SIGN_OUT_COMMAND
} from '../aiBackend';
import { DatameshConnectWidget } from '../DatameshWidget';
import { Signal } from '@lumino/signaling';

interface IRequest {
  url: string;
  headers: Record<string, string>;
}

let requests: IRequest[];
let widget: DatameshConnectWidget | null;
let palette: ModalCommandPalette | null;
const settingsChanged = new Signal<unknown, void>({});

beforeAll(() => {
  // The chat scrolls to its last message; jsdom has no scrollIntoView, and
  // the error would come back as React unmounting the sidebar.
  (Element.prototype as any).scrollIntoView = (): void => undefined;
});

beforeEach(() => {
  requests = [];
  window.datameshToken = undefined as unknown as string;
  (globalThis as any).fetch = jest.fn(
    async (url: string, init: { headers: Record<string, string> }) => {
      requests.push({ url, headers: init.headers });
      return { ok: true, json: async () => ({ code: true }) };
    }
  );
});

afterEach(() => {
  if (widget) {
    Widget.detach(widget);
    widget.dispose();
    widget = null;
  }
  if (palette) {
    palette.dispose();
    palette = null;
  }
});

interface IHost {
  commands: CommandRegistry;
  signIn: jest.Mock;
  accessToken: jest.Mock;
  /** Every command the registry reported as executed, in order. */
  executed: string[];
  setSignedIn: (signedIn: boolean) => void;
  setToken: (token: string | null) => void;
}

/**
 * A host like Oceanum Notebook: an access-token command, a sign-in command
 * enabled where the site has sign-in, and a sign-out command visible only
 * while signed in. `auth: false` is plain JupyterLab, which has none of them.
 */
function host({
  auth = true,
  signInEnabled = true,
  signedIn = false,
  signInRejects = false
} = {}): IHost {
  const state = { signedIn, token: 'a-jwt' as string | null };
  const commands = new CommandRegistry();
  const executed: string[] = [];
  commands.commandExecuted.connect((_, args) => executed.push(args.id));
  const signIn = jest.fn(() =>
    signInRejects
      ? Promise.reject(new Error('the sign-in window was blocked'))
      : undefined
  );
  const accessToken = jest.fn(() => (state.signedIn ? state.token : null));
  if (auth) {
    commands.addCommand(ACCESS_TOKEN_COMMAND, {
      execute: () => accessToken() as any
    });
    commands.addCommand(SIGN_IN_COMMAND, {
      execute: signIn,
      isEnabled: () => signInEnabled
    });
    commands.addCommand(SIGN_OUT_COMMAND, {
      execute: () => undefined,
      isVisible: () => state.signedIn
    });
  }
  return {
    commands,
    signIn,
    accessToken,
    executed,
    setSignedIn: (value: boolean) => {
      state.signedIn = value;
      // What the host does on every sign-in and sign-out.
      commands.notifyCommandChanged();
    },
    setToken: (token: string | null) => {
      state.token = token;
    }
  };
}

function mount(
  commands: CommandRegistry,
  { backend = '', pasted = '' } = {}
): HTMLElement {
  widget = new DatameshConnectWidget({
    app: {} as any,
    name: 'Datamesh Connect',
    icon: addIcon,
    openDatameshUI: (): void => undefined,
    datameshUiUrl: () => '',
    datameshUiFrame: () => null,
    datameshToken: () => pasted,
    aiBackendUrl: () => backend,
    settingsChanged,
    commands,
    getCurrentWidget: () => null as unknown as Widget
  });
  Widget.attach(widget, document.body);
  widget.update();
  return widget.node;
}

/** JupyterLab's modal command palette, open with something typed in it. */
function openPalette(commands: CommandRegistry): ModalCommandPalette {
  palette = new ModalCommandPalette({
    commandPalette: new CommandPalette({ commands })
  });
  palette.attach();
  palette.palette.inputNode.value = 'notebook';
  palette.show();
  return palette;
}

/** Waits for `check` to pass: the sidebar renders asynchronously. */
async function until(check: () => void, timeout = 4000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > end) {
        throw err;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const settle = (ms = 150): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const chat = (node: HTMLElement) => node.querySelector('.oceanum-ai-chat');
const notice = (node: HTMLElement) =>
  node.querySelector('.oceanum-token-config')?.textContent ?? null;

describe('DatameshConnectWidget: Oceanum AI with the host sign-in', () => {
  it('asks to sign in, then shows the chat once signed in, and hides it on sign-out', async () => {
    const oceanum = host();
    const node = mount(oceanum.commands, {
      backend: 'https://ai.example.test/'
    });

    await until(() =>
      expect(notice(node)).toBe(
        'Sign in to Oceanum.io to use Oceanum AI, or set a Datamesh token.'
      )
    );
    expect(chat(node)).toBeNull();
    expect(requests).toEqual([]);
    // Signed out, nothing was run: not even to find out there is no token.
    expect(oceanum.executed).toEqual([]);

    (node.querySelector('.oceanum-token-config a') as HTMLElement).click();
    expect(oceanum.signIn).toHaveBeenCalled();

    oceanum.setSignedIn(true);
    await until(() => expect(chat(node)).not.toBeNull());
    expect(notice(node)).toBeNull();
    // Also awaited: the chat renders before the capabilities call resolves, so asserting
    // this straight after the chat appears is a race that a slow run loses.
    await until(() =>
      expect(requests).toEqual([
        {
          url: 'https://ai.example.test/api/capabilities',
          headers: { Authorization: 'Bearer a-jwt' }
        }
      ])
    );
    // One token request for the capabilities, however many components watch.
    expect(oceanum.accessToken).toHaveBeenCalledTimes(1);

    oceanum.setSignedIn(false);
    await until(() => expect(chat(node)).toBeNull());
    expect(notice(node)).toContain('Sign in to Oceanum.io');
    expect(requests).toHaveLength(1);
    // The sign-in token never becomes the pasted one.
    expect(window.datameshToken).toBeUndefined();
  }, 15000);

  it('runs no command while it watches, so the command palette stays open', async () => {
    // The regression this test exists for: a one-second poll that executed the
    // access-token command closed the palette within half a second, because
    // ModalCommandPalette hides itself on any commandExecuted.
    const oceanum = host();
    const node = mount(oceanum.commands);
    await until(() => expect(notice(node)).toContain('Sign in to Oceanum.io'));

    const modal = openPalette(oceanum.commands);
    expect(modal.isHidden).toBe(false);

    await settle(3000);

    expect(oceanum.executed).toEqual([]);
    expect(oceanum.accessToken).not.toHaveBeenCalled();
    expect(modal.isHidden).toBe(false);
    expect(modal.palette.inputNode.value).toBe('notebook');

    // Signing in is a change, not a poll: it may run the token command once.
    oceanum.setSignedIn(true);
    await until(() => expect(chat(node)).not.toBeNull());
    expect(oceanum.executed).toEqual([ACCESS_TOKEN_COMMAND]);

    await settle(2000);
    expect(oceanum.executed).toEqual([ACCESS_TOKEN_COMMAND]);
  }, 20000);

  it('does not ask again when only the sign-in token has refreshed', async () => {
    const oceanum = host({ signedIn: true });
    const node = mount(oceanum.commands);

    await until(() => expect(chat(node)).not.toBeNull());
    expect(requests).toHaveLength(1);

    // The host refreshed the token and told the registry, as it does.
    oceanum.setToken('refreshed-jwt');
    oceanum.commands.notifyCommandChanged();
    await settle(500);

    expect(requests).toHaveLength(1);
    expect(oceanum.accessToken).toHaveBeenCalledTimes(1);
  }, 15000);

  it('signs with a pasted token rather than the sign-in, running nothing', async () => {
    const oceanum = host({ signedIn: true });
    const node = mount(oceanum.commands, { pasted: 'pasted-token' });

    await until(() => expect(chat(node)).not.toBeNull());
    expect(requests).toEqual([
      {
        url: 'https://ai.oceanum.io/api/capabilities',
        headers: { 'X-Datamesh-Token': 'pasted-token' }
      }
    ]);
    expect(oceanum.executed).toEqual([]);
  });

  it('uses the sign-in once the pasted token is cleared, as a chat request does', async () => {
    // window.datameshToken keeps a token after the setting is cleared, until
    // reload. Signing the capabilities with it would disagree with the chat
    // requests, which read the setting -- and an expired one would hide the
    // chat from a user who is signed in.
    window.datameshToken = 'cleared-token';
    const oceanum = host({ signedIn: true });
    const node = mount(oceanum.commands, { pasted: '' });

    await until(() => expect(chat(node)).not.toBeNull());
    expect(requests).toEqual([
      {
        url: 'https://ai.oceanum.io/api/capabilities',
        headers: { Authorization: 'Bearer a-jwt' }
      }
    ]);
  });

  it('keeps the chat hidden when the capabilities say there is no code', async () => {
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ code: false })
    }));
    const oceanum = host({ signedIn: true });
    const node = mount(oceanum.commands);

    await until(() => expect((globalThis as any).fetch).toHaveBeenCalled());
    await settle();
    expect(chat(node)).toBeNull();
    expect(notice(node)).toBeNull();
  });

  it('asks for a Datamesh token where the host has no sign-in', async () => {
    const oceanum = host({ auth: false });
    const node = mount(oceanum.commands);

    await until(() =>
      expect(notice(node)).toBe(
        'Set your Datamesh token to enable Oceanum.io services Get token here'
      )
    );
    expect(chat(node)).toBeNull();
    expect(requests).toEqual([]);
  });

  it('asks for a Datamesh token where sign-in is not enabled for the site', async () => {
    const oceanum = host({ signInEnabled: false });
    const node = mount(oceanum.commands);

    await until(() =>
      expect(notice(node)).toBe(
        'Set your Datamesh token to enable Oceanum.io services Get token here'
      )
    );
    expect(chat(node)).toBeNull();
  });

  it('says so, rather than failing, when signing in cannot start', async () => {
    // Node's process, without @types/node in the test tsconfig.
    const node_ = (globalThis as any).process as {
      on: (event: string, handler: (reason: unknown) => void) => void;
      off: (event: string, handler: (reason: unknown) => void) => void;
    };
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    node_.on('unhandledRejection', onRejection);
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const oceanum = host({ signInRejects: true });
    const node = mount(oceanum.commands);

    try {
      await until(() =>
        expect(notice(node)).toContain('Sign in to Oceanum.io')
      );
      (node.querySelector('.oceanum-token-config a') as HTMLElement).click();
      await settle();

      expect(warn).toHaveBeenCalledWith(
        'Oceanum AI: could not start signing in to Oceanum.io.'
      );
      expect(rejections).toEqual([]);
    } finally {
      node_.off('unhandledRejection', onRejection);
      warn.mockRestore();
    }
  });

  it('stops watching once it is disposed', async () => {
    const oceanum = host();
    const node = mount(oceanum.commands);
    await until(() => expect(notice(node)).toContain('Sign in to Oceanum.io'));

    Widget.detach(widget!);
    widget!.dispose();
    widget = null;

    oceanum.setSignedIn(true);
    await settle(500);

    expect(oceanum.executed).toEqual([]);
    expect(requests).toEqual([]);
  });
});

/**
 * The sidebar against a fake host and a fake backend: whether the Oceanum AI
 * chat appears, and what the capabilities request is signed with, as the user
 * signs in to Oceanum.io, signs out, or pastes a token.
 */
import { addIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';

import { DatameshConnectWidget } from '../DatameshWidget';

interface IRequest {
  url: string;
  headers: Record<string, string>;
}

let requests: IRequest[];
let widget: DatameshConnectWidget | null;

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
});

/** A host whose access token is whatever `token()` says at the time. */
function host(token?: () => unknown): {
  commands: CommandRegistry;
  signIn: jest.Mock;
} {
  const commands = new CommandRegistry();
  const signIn = jest.fn();
  if (token) {
    commands.addCommand('oceanum-auth:access-token', {
      execute: () => token() as any
    });
    commands.addCommand('oceanum-auth:sign-in', { execute: signIn });
  }
  return { commands, signIn };
}

function mount(commands: CommandRegistry, backend = ''): HTMLElement {
  widget = new DatameshConnectWidget({
    app: {} as any,
    name: 'Datamesh Connect',
    icon: addIcon,
    openDatameshUI: (): void => undefined,
    datameshUiUrl: () => '',
    datameshUiFrame: () => null,
    aiBackendUrl: () => backend,
    commands,
    getCurrentWidget: () => null as unknown as Widget
  });
  Widget.attach(widget, document.body);
  widget.update();
  return widget.node;
}

/** Waits for `check` to pass: the sidebar polls every second. */
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

const chat = (node: HTMLElement) => node.querySelector('.oceanum-ai-chat');
const notice = (node: HTMLElement) =>
  node.querySelector('.oceanum-token-config')?.textContent ?? null;

describe('DatameshConnectWidget: Oceanum AI with the host sign-in', () => {
  it('asks to sign in, then shows the chat once signed in, and hides it on sign-out', async () => {
    let token: string | null = null;
    const { commands, signIn } = host(() => token);
    const node = mount(commands, 'https://ai.example.test/');

    await until(() =>
      expect(notice(node)).toBe(
        'Sign in to Oceanum.io to use Oceanum AI, or set a Datamesh token.'
      )
    );
    expect(chat(node)).toBeNull();
    expect(requests).toEqual([]);

    (node.querySelector('.oceanum-token-config a') as HTMLElement).click();
    expect(signIn).toHaveBeenCalled();

    token = 'first-jwt';
    await until(() => expect(chat(node)).not.toBeNull());
    expect(notice(node)).toBeNull();
    expect(requests).toEqual([
      {
        url: 'https://ai.example.test/api/capabilities',
        headers: { Authorization: 'Bearer first-jwt' }
      }
    ]);

    // A refreshed token asks for the capabilities again, with the new token.
    token = 'second-jwt';
    await until(() => expect(requests).toHaveLength(2));
    expect(requests[1].headers).toEqual({ Authorization: 'Bearer second-jwt' });

    token = null;
    await until(() => expect(chat(node)).toBeNull());
    expect(notice(node)).toContain('Sign in to Oceanum.io');
    // The sign-in token never becomes the pasted one.
    expect(window.datameshToken).toBeUndefined();
  }, 15000);

  it('signs with a pasted token rather than the sign-in', async () => {
    window.datameshToken = 'pasted-token';
    const { commands } = host(() => 'a-jwt');
    const node = mount(commands);

    await until(() => expect(chat(node)).not.toBeNull());
    expect(requests).toEqual([
      {
        url: 'https://ai.oceanum.io/api/capabilities',
        headers: { 'X-Datamesh-Token': 'pasted-token' }
      }
    ]);
  });

  it('keeps the chat hidden when the capabilities say there is no code', async () => {
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ code: false })
    }));
    const { commands } = host(() => 'a-jwt');
    const node = mount(commands);

    await until(() => expect((globalThis as any).fetch).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(chat(node)).toBeNull();
    expect(notice(node)).toBeNull();
  });

  it('asks for a Datamesh token where the host has no sign-in', async () => {
    const { commands } = host();
    const node = mount(commands);

    await until(() =>
      expect(notice(node)).toBe(
        'Set your Datamesh token to enable Oceanum.io services Get token here'
      )
    );
    expect(chat(node)).toBeNull();
    expect(requests).toEqual([]);
  });

  it('shows no sign-in link when the host cannot start signing in', async () => {
    const commands = new CommandRegistry();
    commands.addCommand('oceanum-auth:access-token', { execute: () => null });
    const node = mount(commands);

    await until(() => expect(notice(node)).toContain('Sign in to Oceanum.io'));
    const links = Array.from(
      node.querySelectorAll('.oceanum-token-config a')
    ).map(a => a.textContent);
    expect(links).toEqual(['Datamesh token']);
  });
});

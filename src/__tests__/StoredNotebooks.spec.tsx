import { ReactWidget } from '@jupyterlab/ui-components';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import React from 'react';

import { IOceanumAuth, IOceanumUser } from '../auth/tokens';
import { notebooksChanged } from '../share/events';
import { StoredNotebooks } from '../StoredNotebooks';

/** A signed-out auth that records whether sign-in was asked for. */
function signedOut(): IOceanumAuth & { signIns: number } {
  const auth = {
    signIns: 0,
    environment: null as IOceanumAuth['environment'],
    urls: { specs: 'https://specs.example.com' },
    ready: Promise.resolve(),
    user: null as IOceanumUser | null,
    userChanged: new Signal<IOceanumAuth, IOceanumUser | null>(
      {} as IOceanumAuth
    ),
    tokenChanged: new Signal<IOceanumAuth, string | null>({} as IOceanumAuth),
    signIn: async (): Promise<void> => {
      auth.signIns += 1;
    },
    signOut: async (): Promise<void> => undefined,
    getAccessToken: async (): Promise<string | null> => null
  };
  return auth as unknown as IOceanumAuth & { signIns: number };
}

class Harness extends ReactWidget {
  constructor(
    private readonly _auth: IOceanumAuth,
    private readonly _onSignIn?: () => void
  ) {
    super();
  }

  render(): React.ReactElement {
    return <StoredNotebooks auth={this._auth} onSignIn={this._onSignIn} />;
  }
}

async function mount(
  auth: IOceanumAuth,
  onSignIn?: () => void
): Promise<Harness> {
  const widget = new Harness(auth, onSignIn);
  Widget.attach(widget, document.body);
  const deadline = Date.now() + 4000;
  for (;;) {
    if (widget.node.querySelector('.oceanum-text-empty')) {
      return widget;
    }
    if (Date.now() > deadline) {
      throw new Error('StoredNotebooks rendered nothing within 4s');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('the Notebooks tab while signed in', () => {
  const ID = '6f1c1a52-4b8e-4c0f-9a57-1d2e3f4a5b6c';

  it('lists again when a record is created, renamed or deleted', async () => {
    const auth = signedOut();
    (auth as { user: IOceanumUser | null }).user = {
      sub: 'auth0|1',
      email: 'me@example.com',
      name: null,
      activeOrg: null,
      colorScheme: null
    };
    auth.getAccessToken = async () => 'tok';
    const fetches: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetches.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: ID,
            name: 'Waves',
            description: null as string | null,
            modified: '2026-09-12T10:00:00',
            creator: 'me@example.com'
          }
        ]
      } as unknown as Response;
    }) as typeof fetch;
    try {
      const widget = new Harness(auth);
      Widget.attach(widget, document.body);
      const until = async (test: () => boolean): Promise<void> => {
        const deadline = Date.now() + 4000;
        while (!test()) {
          if (Date.now() > deadline) {
            throw new Error('timed out');
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      };
      await until(() => !!widget.node.querySelector('.oceanum-notebooks-item'));
      expect(fetches).toHaveLength(1);
      const row = widget.node.querySelector('.oceanum-notebooks-item')!;
      expect(row.getAttribute('data-spec-id')).toBe(ID);

      notebooksChanged.emit();

      await until(() => fetches.length === 2);
      widget.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('the Notebooks tab while signed out', () => {
  it('links "Sign in" to starting a sign-in', async () => {
    const auth = signedOut();
    const widget = await mount(auth);

    expect(widget.node.textContent).toContain(
      'Sign in to Oceanum.io to see your notebooks.'
    );
    const link = widget.node.querySelector<HTMLAnchorElement>(
      '.oceanum-text-empty a'
    );
    expect(link?.textContent).toBe('Sign in');

    link!.click();
    expect(auth.signIns).toBe(1);

    widget.dispose();
  });

  it("prefers the host's own way of signing in when given one", async () => {
    // On a JupyterLab server that is the device sign-in command, which shows the
    // code; the auth's signIn() alone would start the flow with nothing to look at.
    const auth = signedOut();
    let hostSignIns = 0;
    const widget = await mount(auth, () => {
      hostSignIns += 1;
    });

    widget.node
      .querySelector<HTMLAnchorElement>('.oceanum-text-empty a')!
      .click();

    expect(hostSignIns).toBe(1);
    expect(auth.signIns).toBe(0);

    widget.dispose();
  });
});

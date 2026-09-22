import { ReactWidget } from '@jupyterlab/ui-components';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import React from 'react';

import { IOceanumAuth, IOceanumUser } from '../auth/tokens';
import { notebooksChanged } from '../share/events';
import type { INotebookDemoItem } from '../share/notebook';
import { NOTEBOOK_ITEM_SELECTOR } from '../share/plugin';
import { IStoredNotebooksProps, StoredNotebooks } from '../StoredNotebooks';

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
    private readonly _onSignIn?: () => void,
    private readonly _onOpenExample?: (item: INotebookDemoItem) => void,
    private readonly _more: Partial<IStoredNotebooksProps> = {}
  ) {
    super();
  }

  render(): React.ReactElement {
    return (
      <StoredNotebooks
        auth={this._auth}
        onSignIn={this._onSignIn}
        onOpenExample={this._onOpenExample}
        {...this._more}
      />
    );
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

describe('the Examples in the Notebooks tab', () => {
  const MINE = '6f1c1a52-4b8e-4c0f-9a57-1d2e3f4a5b6c';
  const PUBLIC_EXAMPLE = '0b7d9f2e-1111-4a2b-8c3d-9e8f7a6b5c4d';
  const OTHER_EXAMPLE = '1c2d3e4f-2222-4a2b-8c3d-9e8f7a6b5c4d';
  const SHARED = '2d3e4f5a-3333-4a2b-8c3d-9e8f7a6b5c4d';
  const DEMO_ID = '3e4f5a6b-4444-4a2b-8c3d-9e8f7a6b5c4d';

  const summary = (id: string, name: string, creator: string | null) => ({
    id,
    name,
    description: null as string | null,
    modified: '2026-09-12T10:00:00',
    creator
  });

  // The listing returns a public example as shared with every signed-in user.
  const LISTING = [
    summary(MINE, 'Mine', 'me@example.com'),
    summary(PUBLIC_EXAMPLE, 'Query (example)', null),
    summary(SHARED, 'Shared', null)
  ];

  const DEMO = {
    ...summary(DEMO_ID, 'Notebook Demo', null),
    spec: {
      kind: 'notebook-demo',
      version: 1,
      sections: [
        {
          title: 'Getting started',
          items: [
            {
              id: PUBLIC_EXAMPLE,
              title: 'Query a datasource',
              summary: 'One line'
            },
            { id: OTHER_EXAMPLE, title: 'Plot waves' }
          ]
        },
        // A curator's own example is also theirs: it stays in My notebooks.
        { title: 'Advanced', items: [{ id: MINE, title: 'Spectra' }] }
      ]
    }
  };

  const ok = (data: unknown): Response =>
    ({ ok: true, status: 200, json: async () => data }) as unknown as Response;

  function signedIn(notebookDemo?: string): IOceanumAuth {
    const auth = signedOut();
    (auth as { user: IOceanumUser | null }).user = {
      sub: 'auth0|1',
      email: 'me@example.com',
      name: null,
      activeOrg: null,
      colorScheme: null
    };
    auth.getAccessToken = async () => 'tok';
    (auth as { environment: unknown }).environment = notebookDemo
      ? { notebookDemo }
      : {};
    return auth;
  }

  const originalFetch = globalThis.fetch;
  let fetches: string[];
  function stubFetch(demo: () => Response = () => ok(DEMO)): void {
    fetches = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetches.push(url);
      return url.includes('/specs/notebook-demo/') ? demo() : ok(LISTING);
    }) as typeof fetch;
  }
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function render(
    auth: IOceanumAuth,
    onOpenExample?: (item: INotebookDemoItem) => void,
    more: Partial<IStoredNotebooksProps> = {}
  ): Promise<Harness> {
    const widget = new Harness(auth, undefined, onOpenExample, more);
    Widget.attach(widget, document.body);
    const deadline = Date.now() + 4000;
    while (!widget.node.querySelector('.oceanum-notebooks')) {
      if (Date.now() > deadline) {
        throw new Error('the Notebooks tab did not load within 4s');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return widget;
  }

  /** The section whose heading starts with `title`. */
  function section(widget: Harness, title: string): HTMLElement | null {
    const sections = widget.node.querySelectorAll<HTMLElement>(
      '.oceanum-notebooks-section'
    );
    return (
      Array.from(sections).find(node =>
        node
          .querySelector('.oceanum-notebooks-heading')
          ?.textContent?.startsWith(title)
      ) ?? null
    );
  }

  const idsIn = (node: HTMLElement | null, attribute: string): string[] =>
    Array.from(node?.querySelectorAll(`[${attribute}]`) ?? []).map(
      row => row.getAttribute(attribute) ?? ''
    );

  it('lists the record’s examples in order, under their section titles', async () => {
    stubFetch();
    const widget = await render(signedIn(DEMO_ID));

    const examples = section(widget, 'Examples')!;
    expect(examples).not.toBeNull();
    expect(
      Array.from(
        examples.querySelectorAll('.oceanum-notebooks-subheading'),
        node => node.textContent
      )
    ).toEqual(['Getting started', 'Advanced']);
    const rows = Array.from(
      examples.querySelectorAll<HTMLElement>('[data-example-id]')
    );
    expect(rows.map(row => row.textContent)).toEqual([
      'Query a datasource',
      'Plot waves',
      'Spectra'
    ]);
    expect(rows.map(row => row.getAttribute('data-example-id'))).toEqual([
      PUBLIC_EXAMPLE,
      OTHER_EXAMPLE,
      MINE
    ]);
    expect(rows[0].getAttribute('title')).toBe('One line');
    expect(
      examples.querySelector('.oceanum-notebooks-count')?.textContent
    ).toBe('3');
    expect(fetches).toContain(
      `https://specs.example.com/specs/notebook-demo/${DEMO_ID}`
    );
    widget.dispose();
  });

  it('moves examples out of Shared with me, but leaves My notebooks alone', async () => {
    stubFetch();
    const widget = await render(signedIn(DEMO_ID));

    expect(idsIn(section(widget, 'Shared with me'), 'data-spec-id')).toEqual([
      SHARED
    ]);
    expect(idsIn(section(widget, 'My notebooks'), 'data-spec-id')).toEqual([
      MINE
    ]);
    widget.dispose();
  });

  it('asks for nothing more and shows no Examples where none is configured', async () => {
    stubFetch();
    const widget = await render(signedIn());

    expect(section(widget, 'Examples')).toBeNull();
    expect(fetches).toEqual(['https://specs.example.com/specs/notebook']);
    // Without a record, a public example is just another shared notebook.
    expect(idsIn(section(widget, 'Shared with me'), 'data-spec-id')).toEqual([
      PUBLIC_EXAMPLE,
      SHARED
    ]);
    widget.dispose();
  });

  it('says so when the record cannot be read, and still lists the rest', async () => {
    stubFetch(
      () => ({ ok: false, status: 404, json: async () => ({}) }) as Response
    );
    const widget = await render(signedIn(DEMO_ID));

    const examples = section(widget, 'Examples')!;
    expect(
      examples.querySelector('.oceanum-text-error')?.textContent
    ).toContain('The examples could not be loaded.');
    expect(examples.querySelector('[data-example-id]')).toBeNull();
    expect(idsIn(section(widget, 'My notebooks'), 'data-spec-id')).toEqual([
      MINE
    ]);
    expect(idsIn(section(widget, 'Shared with me'), 'data-spec-id')).toEqual([
      PUBLIC_EXAMPLE,
      SHARED
    ]);
    widget.dispose();
  });

  it('keeps example rows out of the stored-notebook row menu', async () => {
    // Its Rename and Delete would act on Oceanum's own example records.
    stubFetch();
    const widget = await render(signedIn(DEMO_ID), () => undefined);

    const rows = section(widget, 'Examples')!.querySelectorAll('button');
    expect(rows).toHaveLength(3);
    for (const row of Array.from(rows)) {
      expect(row.matches(NOTEBOOK_ITEM_SELECTOR)).toBe(false);
    }
    widget.dispose();
  });

  it('opens an example through onOpenExample, with its title', async () => {
    stubFetch();
    const opened: INotebookDemoItem[] = [];
    const widget = await render(signedIn(DEMO_ID), item => opened.push(item));

    section(widget, 'Examples')!
      .querySelector<HTMLButtonElement>(`[data-example-id="${OTHER_EXAMPLE}"]`)!
      .click();

    expect(opened).toEqual([{ id: OTHER_EXAMPLE, title: 'Plot waves' }]);
    widget.dispose();
  });

  const switchIn = (widget: Harness): HTMLButtonElement | null =>
    section(widget, 'Examples')!.querySelector<HTMLButtonElement>(
      '[role="switch"]'
    );

  it('puts a switch on the Examples heading that asks to hide them', async () => {
    stubFetch();
    const changes: boolean[] = [];
    const widget = await render(signedIn(DEMO_ID), undefined, {
      showExamples: true,
      onShowExamplesChange: show => changes.push(show)
    });

    const toggle = switchIn(widget)!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Show examples');
    expect(
      section(widget, 'Examples')!
        .querySelector('.oceanum-notebooks-heading')!
        .contains(toggle)
    ).toBe(true);

    toggle.click();

    expect(changes).toEqual([false]);
    widget.dispose();
  });

  it('keeps hidden examples folded under their heading, with the switch to bring them back', async () => {
    stubFetch();
    const changes: boolean[] = [];
    const widget = await render(signedIn(DEMO_ID), undefined, {
      showExamples: false,
      onShowExamplesChange: show => changes.push(show)
    });

    const examples = section(widget, 'Examples')!;
    expect(examples.querySelector('[data-example-id]')).toBeNull();
    expect(
      examples.querySelector('.oceanum-notebooks-count')?.textContent
    ).toBe('3');
    // Hidden, not forgotten: the record is still read, and its examples stay out of
    // Shared with me.
    expect(fetches).toContain(
      `https://specs.example.com/specs/notebook-demo/${DEMO_ID}`
    );
    expect(idsIn(section(widget, 'Shared with me'), 'data-spec-id')).toEqual([
      SHARED
    ]);

    const toggle = switchIn(widget)!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    toggle.click();

    expect(changes).toEqual([true]);
    widget.dispose();
  });

  it('shows no error for examples the user has hidden', async () => {
    stubFetch(
      () => ({ ok: false, status: 404, json: async () => ({}) }) as Response
    );
    const widget = await render(signedIn(DEMO_ID), undefined, {
      showExamples: false,
      onShowExamplesChange: () => undefined
    });

    const examples = section(widget, 'Examples')!;
    expect(examples.querySelector('.oceanum-text-error')).toBeNull();
    expect(switchIn(widget)).not.toBeNull();
    widget.dispose();
  });

  it('offers no switch where the choice could not be kept', async () => {
    stubFetch();
    const widget = await render(signedIn(DEMO_ID));

    expect(switchIn(widget)).toBeNull();
    expect(
      section(widget, 'Examples')!.querySelectorAll('[data-example-id]')
    ).toHaveLength(3);
    widget.dispose();
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

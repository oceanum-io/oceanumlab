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
      // Counts the notebook listing only; each load also lists the demos.
      if (String(input).endsWith('/specs/notebook')) {
        fetches.push(String(input));
      }
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
  const QUERY = '0b7d9f2e-1111-4a2b-8c3d-9e8f7a6b5c4d';
  const PLOT = '1c2d3e4f-2222-4a2b-8c3d-9e8f7a6b5c4d';
  const SHARED = '2d3e4f5a-3333-4a2b-8c3d-9e8f7a6b5c4d';
  const SPECTRA = '3e4f5a6b-4444-4a2b-8c3d-9e8f7a6b5c4d';

  const summary = (
    id: string,
    name: string,
    creator: string | null,
    description: string | null = null
  ) => ({
    id,
    name,
    description,
    modified: '2026-09-12T10:00:00',
    creator
  });

  // The user's notebooks.
  const LISTING = [
    summary(MINE, 'Mine', 'me@example.com'),
    summary(SHARED, 'Shared', null)
  ];

  // The Notebook Demo specs, each one an example notebook, in no particular order.
  const DEMOS = [
    summary(PLOT, '10 Plot waves', null),
    summary(SPECTRA, 'Spectra', null),
    summary(QUERY, '2 Query a datasource', null, 'One line')
  ];

  const ok = (data: unknown): Response =>
    ({ ok: true, status: 200, json: async () => data }) as unknown as Response;

  function signedIn(): IOceanumAuth {
    const auth = signedOut();
    (auth as { user: IOceanumUser | null }).user = {
      sub: 'auth0|1',
      email: 'me@example.com',
      name: null,
      activeOrg: null,
      colorScheme: null
    };
    auth.getAccessToken = async () => 'tok';
    (auth as { environment: unknown }).environment = {};
    return auth;
  }

  const originalFetch = globalThis.fetch;
  let fetches: string[];
  const DEMO_LISTING = 'https://specs.example.com/specs/notebook-demo';
  function stubFetch(demos: () => Response = () => ok(DEMOS)): void {
    fetches = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetches.push(url);
      return url === DEMO_LISTING ? demos() : ok(LISTING);
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

  it('offers Upload where the host can upload, and runs it on click', async () => {
    stubFetch();
    let uploads = 0;
    const widget = await render(signedIn(), undefined, {
      onUpload: () => {
        uploads++;
      }
    });

    const button = widget.node.querySelector<HTMLButtonElement>(
      '.oceanum-notebooks-upload'
    );
    button!.click();

    expect(uploads).toBe(1);
    Widget.detach(widget);
  });

  it('has no Upload button where the host cannot upload', async () => {
    stubFetch();
    const widget = await render(signedIn());

    expect(widget.node.querySelector('.oceanum-notebooks-upload')).toBeNull();
    Widget.detach(widget);
  });

  it('lists every Notebook Demo spec as an example, ordered by name', async () => {
    stubFetch();
    const widget = await render(signedIn());

    const examples = section(widget, 'Examples')!;
    expect(examples).not.toBeNull();
    const rows = Array.from(
      examples.querySelectorAll<HTMLElement>('[data-example-id]')
    );
    // Numbered as people number them: 2 before 10.
    expect(rows.map(row => row.textContent)).toEqual([
      '2 Query a datasource',
      '10 Plot waves',
      'Spectra'
    ]);
    expect(rows.map(row => row.getAttribute('data-example-id'))).toEqual([
      QUERY,
      PLOT,
      SPECTRA
    ]);
    expect(rows[0].getAttribute('title')).toBe('One line');
    expect(
      examples.querySelector('.oceanum-notebooks-count')?.textContent
    ).toBe('3');
    expect(fetches).toContain(DEMO_LISTING);
    widget.dispose();
  });

  it('leaves My notebooks and Shared with me as listed', async () => {
    stubFetch();
    const widget = await render(signedIn());

    expect(idsIn(section(widget, 'My notebooks'), 'data-spec-id')).toEqual([
      MINE
    ]);
    expect(idsIn(section(widget, 'Shared with me'), 'data-spec-id')).toEqual([
      SHARED
    ]);
    widget.dispose();
  });

  it('shows no Examples section when there are no demos', async () => {
    stubFetch(() => ok([]));
    const widget = await render(signedIn());

    expect(section(widget, 'Examples')).toBeNull();
    widget.dispose();
  });

  it('shows no Examples, and no error, where the store has no Notebook Demo type', async () => {
    stubFetch(
      () => ({ ok: false, status: 404, json: async () => ({}) }) as Response
    );
    const widget = await render(signedIn());

    expect(section(widget, 'Examples')).toBeNull();
    expect(idsIn(section(widget, 'My notebooks'), 'data-spec-id')).toEqual([
      MINE
    ]);
    widget.dispose();
  });

  it('asks for no demos while signed out', async () => {
    stubFetch();
    const widget = new Harness(signedOut());
    Widget.attach(widget, document.body);
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(fetches).toEqual([]);
    widget.dispose();
  });

  it('says so when the demos cannot be listed, and still lists the rest', async () => {
    stubFetch(
      () => ({ ok: false, status: 500, json: async () => ({}) }) as Response
    );
    const widget = await render(signedIn());

    const examples = section(widget, 'Examples')!;
    expect(
      examples.querySelector('.oceanum-text-error')?.textContent
    ).toContain('The examples could not be loaded.');
    expect(examples.querySelector('[data-example-id]')).toBeNull();
    expect(idsIn(section(widget, 'My notebooks'), 'data-spec-id')).toEqual([
      MINE
    ]);
    expect(idsIn(section(widget, 'Shared with me'), 'data-spec-id')).toEqual([
      SHARED
    ]);
    widget.dispose();
  });

  it('keeps example rows out of the stored-notebook row menu', async () => {
    // Its Rename and Delete would act on Oceanum's own example records.
    stubFetch();
    const widget = await render(signedIn(), () => undefined);

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
    const widget = await render(signedIn(), item => opened.push(item));

    section(widget, 'Examples')!
      .querySelector<HTMLButtonElement>(`[data-example-id="${PLOT}"]`)!
      .click();

    expect(opened).toEqual([{ id: PLOT, title: '10 Plot waves' }]);
    widget.dispose();
  });

  const switchIn = (widget: Harness): HTMLButtonElement | null =>
    section(widget, 'Examples')!.querySelector<HTMLButtonElement>(
      '[role="switch"]'
    );

  it('puts a switch on the Examples heading that asks to hide them', async () => {
    stubFetch();
    const changes: boolean[] = [];
    const widget = await render(signedIn(), undefined, {
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
    const widget = await render(signedIn(), undefined, {
      showExamples: false,
      onShowExamplesChange: show => changes.push(show)
    });

    const examples = section(widget, 'Examples')!;
    expect(examples.querySelector('[data-example-id]')).toBeNull();
    expect(
      examples.querySelector('.oceanum-notebooks-count')?.textContent
    ).toBe('3');
    // Hidden, not forgotten: the demos are still listed, for the count.
    expect(fetches).toContain(DEMO_LISTING);

    const toggle = switchIn(widget)!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    toggle.click();

    expect(changes).toEqual([true]);
    widget.dispose();
  });

  it('shows no error for examples the user has hidden', async () => {
    stubFetch(
      () => ({ ok: false, status: 500, json: async () => ({}) }) as Response
    );
    const widget = await render(signedIn(), undefined, {
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
    const widget = await render(signedIn());

    expect(switchIn(widget)).toBeNull();
    expect(
      section(widget, 'Examples')!.querySelectorAll('[data-example-id]')
    ).toHaveLength(3);
    widget.dispose();
  });

  it('shows no examples while the setting is still loading', async () => {
    // Otherwise examples a user has hidden would show for a moment on every reload.
    stubFetch();
    const widget = await render(signedIn(), undefined, {
      showExamples: null,
      onShowExamplesChange: () => undefined
    });

    expect(section(widget, 'Examples')).toBeNull();
    // They are still kept out of Shared with me in the meantime.
    expect(idsIn(section(widget, 'Shared with me'), 'data-spec-id')).toEqual([
      SHARED
    ]);
    widget.dispose();
  });

  it('shows nothing for hidden examples that no switch could bring back', async () => {
    stubFetch();
    const widget = await render(signedIn(), undefined, {
      showExamples: false
    });

    expect(section(widget, 'Examples')).toBeNull();
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

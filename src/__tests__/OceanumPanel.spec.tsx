import { JupyterFrontEnd } from '@jupyterlab/application';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { LabIcon } from '@jupyterlab/ui-components';

import { DatameshConnectWidget } from '../DatameshWidget';

const icon = new LabIcon({
  name: 'oceanum:test-icon',
  svgstr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
});

interface IPanelOptions {
  /** The `datameshToken` setting value. */
  token?: string;
  /** Register the host's sign-in commands, and say whether someone is signed in. */
  signedIn?: boolean;
  /** Widget props to use instead of the defaults below. */
  props?: Record<string, unknown>;
}

function panel(options: IPanelOptions = {}): DatameshConnectWidget {
  const commands = new CommandRegistry();
  if (options.signedIn !== undefined) {
    // What the host provides: sign-out is visible only while signed in, which is how
    // the sidebar reads the state without running anything.
    commands.addCommand('oceanum-auth:sign-out', {
      execute: () => undefined,
      isVisible: () => options.signedIn === true
    });
    commands.addCommand('oceanum-auth:access-token', {
      execute: () => null,
      isVisible: () => false
    });
  }
  const app = {
    shell: { currentWidget: null },
    commands
  } as unknown as JupyterFrontEnd;
  return new DatameshConnectWidget({
    app,
    name: 'Datamesh Connect',
    icon,
    openDatameshUI: (): void => undefined,
    datameshUiUrl: () => 'https://ui.datamesh.example.com',
    datameshUiFrame: (): Window | null => null,
    datameshToken: () => options.token ?? '',
    aiBackendUrl: () => 'https://ai.example.com',
    settingsChanged: new Signal<unknown, void>({}),
    commands,
    getCurrentWidget: () => new Widget(),
    auth: null,
    ...options.props
  } as unknown as ConstructorParameters<typeof DatameshConnectWidget>[0]);
}

async function mount(
  options: IPanelOptions = {}
): Promise<DatameshConnectWidget> {
  const widget = panel(options);
  Widget.attach(widget, document.body);
  await new Promise(resolve => setTimeout(resolve, 100));
  return widget;
}

/**
 * The panel used to render the Datamesh workspace and the AI chat one above the other.
 * They are now tabs. `DatameshWidget.spec.tsx` covers the AI chat's behaviour but never
 * touches the Datamesh surface, so nothing else here would notice if rearranging the
 * two lost one of them.
 */
beforeAll(() => {
  // The AI chat scrolls to its last message, and every pane renders whether or not it
  // is the selected one. jsdom has no scrollIntoView, and the error would come back as
  // React unmounting the whole sidebar.
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView =
    (): void => undefined;
});

const tabLabels = (widget: DatameshConnectWidget): (string | null)[] =>
  Array.from(widget.node.querySelectorAll('[role="tab"]')).map(
    node => node.textContent
  );

describe('the Oceanum panel', () => {
  it('offers no Oceanum AI tab when the chat has no credential', async () => {
    // AIChatPanel renders nothing without one, so a labelled tab would open on the
    // same emptiness the panel showed before there were tabs, but now advertised.
    const widget = await mount();
    const labels = Array.from(widget.node.querySelectorAll('[role="tab"]')).map(
      node => node.textContent
    );

    expect(labels).toEqual(['Notebooks', 'Datamesh']);
    expect(widget.node.querySelector('#oceanum-tabpanel-ai')).toBeNull();

    widget.dispose();
  });

  it('offers no Oceanum AI tab for a pasted token alone, until someone signs in', async () => {
    // The token would reach the backend, but the tab waits for a sign-in.
    const withToken = await mount({ token: 'a-datamesh-token' });
    expect(tabLabels(withToken)).toEqual(['Notebooks', 'Datamesh']);
    withToken.dispose();

    const signedOut = await mount({
      token: 'a-datamesh-token',
      signedIn: false
    });
    expect(tabLabels(signedOut)).toEqual(['Notebooks', 'Datamesh']);
    signedOut.dispose();
  });

  it('offers the Oceanum AI tab once the host says the user is signed in', async () => {
    const widget = await mount({ signedIn: true });

    expect(tabLabels(widget)).toEqual(['Notebooks', 'Datamesh', 'Oceanum AI']);

    widget.dispose();
  });

  it('still renders the Datamesh workspace section', async () => {
    const widget = await mount();

    expect(
      widget.node.querySelector('.datamesh-workspace-header')
    ).not.toBeNull();
    expect(
      widget.node.querySelector('.datamesh-connect-workspace')
    ).not.toBeNull();
    expect(widget.node.textContent).toContain('Datamesh Workspace');

    widget.dispose();
  });

  it('opens on Notebooks, and announces a change so it can be persisted', async () => {
    const widget = await mount();
    const seen: string[] = [];
    widget.tabChanged.connect((_, id) => seen.push(id));

    expect(widget.selectedTab).toBe('notebooks');
    widget.selectTab('datamesh');
    expect(widget.selectedTab).toBe('datamesh');
    expect(seen).toEqual(['datamesh']);

    // Selecting the same tab again is not a change.
    widget.selectTab('datamesh');
    expect(seen).toEqual(['datamesh']);

    widget.dispose();
  });

  it('explains the Notebooks tab rather than failing when sign-in is unavailable', async () => {
    // auth is null on a host with no Oceanum environment.
    const widget = await mount();
    expect(widget.node.textContent).toContain('sign-in is not configured');
    widget.dispose();
  });
});

describe('the Examples switch in the Oceanum panel', () => {
  const DEMO_ID = '3e4f5a6b-4444-4a2b-8c3d-9e8f7a6b5c4d';
  const EXAMPLE = '0b7d9f2e-1111-4a2b-8c3d-9e8f7a6b5c4d';
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const until = async (test: () => boolean): Promise<void> => {
    const deadline = Date.now() + 4000;
    while (!test()) {
      if (Date.now() > deadline) {
        throw new Error('timed out');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  it('saves the choice, and follows the setting once it has changed', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const demo = String(input).includes('/specs/notebook-demo/');
      const data: unknown = demo
        ? {
            id: DEMO_ID,
            name: 'Notebook Demo',
            description: null as string | null,
            modified: '2026-09-22T10:00:00',
            creator: null as string | null,
            spec: {
              kind: 'notebook-demo',
              version: 1,
              sections: [
                { title: 'Start', items: [{ id: EXAMPLE, title: 'Query' }] }
              ]
            }
          }
        : [];
      return { ok: true, status: 200, json: async () => data } as Response;
    }) as typeof fetch;
    const auth = {
      environment: { notebookDemo: DEMO_ID },
      urls: { specs: 'https://specs.example.com' },
      ready: Promise.resolve(),
      user: {
        sub: 'auth0|1',
        email: 'me@example.com',
        name: null as string | null,
        activeOrg: null as string | null,
        colorScheme: null as string | null
      },
      userChanged: new Signal<unknown, unknown>({}),
      tokenChanged: new Signal<unknown, unknown>({}),
      signIn: async (): Promise<void> => undefined,
      signOut: async (): Promise<void> => undefined,
      getAccessToken: async (): Promise<string> => 'tok'
    };
    // What the host keeps: the setting, and the signal it emits when it changes.
    let shown = true;
    const saved: boolean[] = [];
    const settingsChanged = new Signal<unknown, void>({});
    const widget = await mount({
      props: {
        auth,
        settingsChanged,
        showExamples: () => shown,
        setShowExamples: (show: boolean) => saved.push(show)
      }
    });
    const toggle = (): HTMLButtonElement | null =>
      widget.node.querySelector<HTMLButtonElement>('[role="switch"]');
    await until(() => toggle() !== null);
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');
    expect(widget.node.querySelector('[data-example-id]')).not.toBeNull();

    toggle()!.click();
    expect(saved).toEqual([false]);

    // The host saves the setting and says so; the panel reads it again.
    shown = false;
    settingsChanged.emit();
    await until(() => toggle()?.getAttribute('aria-checked') === 'false');
    expect(widget.node.querySelector('[data-example-id]')).toBeNull();

    widget.dispose();
  });
});

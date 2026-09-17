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

function panel(): DatameshConnectWidget {
  const commands = new CommandRegistry();
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
    datameshToken: () => '',
    aiBackendUrl: () => 'https://ai.example.com',
    settingsChanged: new Signal<unknown, void>({}),
    commands,
    getCurrentWidget: () => new Widget(),
    auth: null
  } as unknown as ConstructorParameters<typeof DatameshConnectWidget>[0]);
}

async function mount(): Promise<DatameshConnectWidget> {
  const widget = panel();
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
describe('the Oceanum panel', () => {
  it('offers all three tabs', async () => {
    const widget = await mount();
    const labels = Array.from(widget.node.querySelectorAll('[role="tab"]')).map(
      node => node.textContent
    );

    expect(labels).toEqual(['Notebooks', 'Datamesh', 'Oceanum AI']);

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

  it('gives the AI chat its own pane', async () => {
    const widget = await mount();
    const pane = widget.node.querySelector('#oceanum-tabpanel-ai');

    expect(pane).not.toBeNull();
    // Deliberately not asserting content: with no token and no sign-in AIChatPanel
    // renders nothing, as it did before this change when it sat below the divider.
    // The tab now labels that emptiness, which is worth revisiting separately.
    expect(pane?.getAttribute('role')).toBe('tabpanel');

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

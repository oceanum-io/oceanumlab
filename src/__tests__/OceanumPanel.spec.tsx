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

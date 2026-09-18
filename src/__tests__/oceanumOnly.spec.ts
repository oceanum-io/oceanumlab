import type { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Menu, Panel, Widget } from '@lumino/widgets';

import {
  FILE_BROWSER_ID,
  hideFileBrowser,
  LOCAL_FILE_COMMANDS,
  pruneBeforeEachOpen,
  pruneFileMenu,
  routeSaves
} from '../share/oceanumOnly';

describe('hideFileBrowser', () => {
  it('closes the file browser without disposing it, and leaves the rest', () => {
    const left = new Panel();
    const browser = new Widget();
    browser.id = FILE_BROWSER_ID;
    const running = new Widget();
    running.id = 'jp-running-sessions';
    left.addWidget(browser);
    left.addWidget(running);

    expect(hideFileBrowser({ widgets: () => left.widgets })).toBe(true);

    expect(left.widgets).toEqual([running]);
    // Other extensions still hold it through IDefaultFileBrowser.
    expect(browser.isDisposed).toBe(false);
  });

  it('reports when there is none to hide', () => {
    const left = new Panel();
    expect(hideFileBrowser({ widgets: () => left.widgets })).toBe(false);
  });
});

function fileMenu(commands: string[]): {
  menu: Menu;
  registry: CommandRegistry;
} {
  const registry = new CommandRegistry();
  const menu = new Menu({ commands: registry });
  for (const command of commands) {
    if (command === '-') {
      menu.addItem({ type: 'separator' });
      continue;
    }
    registry.addCommand(command, { execute: () => undefined, label: command });
    menu.addItem({ command });
  }
  return { menu, registry };
}

const menuCommands = (menu: Menu): string[] =>
  menu.items.map(item => (item.type === 'separator' ? '-' : item.command));

describe('pruneFileMenu', () => {
  it('drops the local-file entries and keeps Save, Rename and everything else', () => {
    const { menu } = fileMenu([
      'filebrowser:open-path',
      'filebrowser:open-url',
      '-',
      'docmanager:save',
      'docmanager:save-as',
      'docmanager:save-all',
      '-',
      'docmanager:reload',
      'docmanager:restore-checkpoint',
      'docmanager:rename',
      'docmanager:duplicate',
      '-',
      'docmanager:download',
      'oceanum-share:save'
    ]);

    expect(pruneFileMenu(menu)).toBe(7);

    expect(menuCommands(menu)).toEqual([
      '-',
      'docmanager:save',
      'docmanager:save-all',
      '-',
      'docmanager:rename',
      '-',
      'oceanum-share:save'
    ]);
    // Idempotent: nothing left to remove.
    expect(pruneFileMenu(menu)).toBe(0);
  });

  it('drops the Open Recent submenu, which the document manager builds by hand', () => {
    const { menu, registry } = fileMenu(['docmanager:save']);
    registry.addCommand('docmanager:clear-recents', {
      execute: () => undefined,
      label: 'Clear Recent'
    });
    const recents = new Menu({ commands: registry });
    recents.title.label = 'Open Recent';
    recents.addItem({ command: 'docmanager:clear-recents' });
    menu.addItem({ type: 'submenu', submenu: recents });
    const other = new Menu({ commands: registry });
    other.title.label = 'New';
    menu.addItem({ type: 'submenu', submenu: other });

    expect(pruneFileMenu(menu)).toBe(1);

    expect(menu.items.map(item => item.type)).toEqual(['command', 'submenu']);
    expect(menu.items[1].submenu?.title.label).toBe('New');
  });

  it('names every entry it prunes, so the list is reviewable', () => {
    expect(LOCAL_FILE_COMMANDS).toEqual([
      'filebrowser:open-path',
      'filebrowser:open-url',
      'docmanager:save-as',
      'docmanager:reload',
      'docmanager:restore-checkpoint',
      'docmanager:duplicate',
      'docmanager:download'
    ]);
  });
});

describe('pruneBeforeEachOpen', () => {
  it('prunes entries that arrive after the first pass, each time the menu opens', () => {
    const { menu, registry } = fileMenu(['docmanager:save']);
    pruneBeforeEachOpen(menu);
    // A plugin's settings schema loads late and adds its entry.
    registry.addCommand('docmanager:save-as', {
      execute: () => undefined,
      label: 'Save As'
    });
    menu.addItem({ command: 'docmanager:save-as' });
    expect(menuCommands(menu)).toEqual([
      'docmanager:save',
      'docmanager:save-as'
    ]);

    menu.open(0, 0);
    try {
      expect(menuCommands(menu)).toEqual(['docmanager:save']);
    } finally {
      menu.close();
      menu.dispose();
    }
  });
});

/** Just enough of a notebook tracker and its panels to route saves. */
function fakeTracker(): {
  tracker: INotebookTracker;
  add: () => { panel: NotebookPanel; saveState: Signal<unknown, string> };
} {
  const panels: NotebookPanel[] = [];
  const widgetAdded = new Signal<INotebookTracker, NotebookPanel>(
    {} as INotebookTracker
  );
  const tracker = {
    forEach: (fn: (panel: NotebookPanel) => void) => panels.forEach(fn),
    widgetAdded
  } as unknown as INotebookTracker;
  const add = () => {
    const saveState = new Signal<unknown, string>({});
    const panel = { context: { saveState } } as unknown as NotebookPanel;
    panels.push(panel);
    widgetAdded.emit(panel);
    return { panel, saveState };
  };
  return { tracker, add };
}

describe('routeSaves', () => {
  it('pushes after every completed save, of notebooks open now and later', () => {
    const { tracker, add } = fakeTracker();
    const first = add();
    const pushed: NotebookPanel[] = [];
    routeSaves(tracker, async panel => {
      pushed.push(panel);
    });

    first.saveState.emit('started');
    expect(pushed).toEqual([]);
    first.saveState.emit('completed');
    expect(pushed).toEqual([first.panel]);

    const second = add();
    second.saveState.emit('completed');
    second.saveState.emit('failed');
    first.saveState.emit('completed');
    expect(pushed).toEqual([first.panel, second.panel, first.panel]);
  });
});

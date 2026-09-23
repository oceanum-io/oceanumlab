/**
 * Oceanum-only file management: what a deployment gets when its environment says
 * `fileManagement: 'oceanum'`, as notebook.oceanum.io does.
 *
 * The local drive stays as the working copy underneath, out of sight: the file browser
 * is taken out of the sidebar, the File menu loses the entries that manage local files,
 * and every completed local save is pushed to the spec store, so Ctrl+S, the toolbar
 * button, Save All and autosave all reach Oceanum.
 */
import type { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { MessageLoop } from '@lumino/messaging';
import type { Menu, Widget } from '@lumino/widgets';

/** The widget id `@jupyterlab/filebrowser-extension:browser` gives the file browser. */
export const FILE_BROWSER_ID = 'filebrowser';

/** The widget id of this extension's Oceanum.io panel, which takes the browser's place. */
export const OCEANUM_PANEL_ID = 'datamesh-connect';

/**
 * File menu entries that manage local files. Save, Save All and Rename stay: saving is
 * routed to Oceanum, and renaming the local file is how a notebook gets its name.
 */
export const LOCAL_FILE_COMMANDS: readonly string[] = [
  'filebrowser:open-path',
  'filebrowser:open-url',
  'docmanager:save-as',
  'docmanager:reload',
  'docmanager:restore-checkpoint',
  'docmanager:duplicate',
  'docmanager:download'
];

/**
 * File > New entries for files that are not notebooks. The spec store holds notebooks
 * only, so such a file could never be saved anywhere the user can see.
 */
export const NON_NOTEBOOK_NEW_COMMANDS: readonly string[] = [
  'fileeditor:create-new',
  'fileeditor:create-new-markdown-file'
];

/**
 * Take the file browser out of the sidebar; true if it was there. It is closed, not
 * disposed: other extensions hold it through IDefaultFileBrowser and still use it to
 * open paths. If it was the open panel, `instead` is opened in its place; a sidebar the
 * user had collapsed stays collapsed.
 */
export function hideFileBrowser(
  shell: {
    widgets(area: 'left'): Iterable<Widget>;
    activateById(id: string): void;
  },
  instead?: string
): boolean {
  for (const widget of shell.widgets('left')) {
    if (widget.id === FILE_BROWSER_ID) {
      const wasOpen = widget.isVisible;
      widget.close();
      if (wasOpen && instead) {
        shell.activateById(instead);
      }
      return true;
    }
  }
  return false;
}

/**
 * Submenus of local files. "Open Recent" is built by the document manager rather than
 * declared in a schema, and its menu has no id, so it is known by the commands it holds.
 */
export const LOCAL_FILE_SUBMENU_COMMANDS: readonly string[] = [
  'docmanager:open-recent',
  'docmanager:clear-recents'
];

function isLocalSubmenu(item: Menu.IItem): boolean {
  return (
    item.type === 'submenu' &&
    !!item.submenu &&
    (item.submenu.title.label === 'Open Recent' ||
      item.submenu.items.some(child =>
        LOCAL_FILE_SUBMENU_COMMANDS.includes(child.command)
      ))
  );
}

/**
 * Remove the local-file entries from a menu; returns how many went. Idempotent, so it
 * can run every time the menu is about to show: entries arrive from settings schemas as
 * plugins load, not all at once.
 */
export function pruneFileMenu(
  menu: Menu,
  commands: readonly string[] = LOCAL_FILE_COMMANDS
): number {
  let removed = 0;
  for (let i = menu.items.length - 1; i >= 0; i--) {
    const item = menu.items[i];
    if (
      (item.type === 'command' && commands.includes(item.command)) ||
      isLocalSubmenu(item)
    ) {
      menu.removeItemAt(i);
      removed++;
    }
  }
  return removed;
}

/**
 * Prune the menu again every time it opens. Entries arrive from settings schemas as
 * plugins load rather than all at once, and a menu has no "about to show" signal; it
 * is attached to the document each time it opens, which a message hook can watch.
 */
export function pruneBeforeEachOpen(
  menu: Menu,
  commands: readonly string[] = LOCAL_FILE_COMMANDS
): void {
  MessageLoop.installMessageHook(menu, (_, message) => {
    if (message.type === 'before-attach') {
      pruneFileMenu(menu, commands);
    }
    return true;
  });
}

/**
 * Call `push` after every completed local save of every notebook, open now or later.
 * `push` must guard against its own saves: writing the record link back to the notebook
 * saves it again.
 */
export function routeSaves(
  tracker: INotebookTracker,
  push: (panel: NotebookPanel) => Promise<void>
): void {
  const watch = (panel: NotebookPanel): void => {
    panel.context.saveState.connect((_, state) => {
      if (state === 'completed') {
        void push(panel);
      }
    });
  };
  tracker.forEach(watch);
  tracker.widgetAdded.connect((_, panel) => watch(panel));
}

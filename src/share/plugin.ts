import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  ICommandPalette,
  InputDialog,
  Notification,
  showDialog
} from '@jupyterlab/apputils';
import { PageConfig } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IMainMenu } from '@jupyterlab/mainmenu';
import type { INotebookContent } from '@jupyterlab/nbformat';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Menu } from '@lumino/widgets';

import { startSignIn } from '../auth/startSignIn';
import { IOceanumAuth } from '../auth/tokens';
import { type ErrorKind, SpecStoreClient, SpecStoreError } from './client';
import { notebooksChanged } from './events';
import {
  buildSpecBody,
  IOceanumLink,
  isSpecId,
  ISpecRecord,
  METADATA_KEY,
  notebookFromRecord,
  notebookNamesFor,
  OCEANUM_DIR,
  partitionSummaries,
  QUERY_PARAM,
  readLink,
  reportForShareFailures,
  sanitizeName,
  shareLink,
  uniqueNotebookPath
} from './notebook';
import {
  hideFileBrowser,
  pruneBeforeEachOpen,
  pruneFileMenu,
  routeSaves
} from './oceanumOnly';
import { NotebookListBody, ShareBody } from './widgets';

export const CommandIDs = {
  open: 'oceanum-share:open',
  save: 'oceanum-share:save',
  share: 'oceanum-share:share',
  rename: 'oceanum-share:rename',
  delete: 'oceanum-share:delete'
} as const;

export const SHARE_PLUGIN_ID = '@oceanum/oceanumlab:share';

/** The Notebooks tab marks each listed record with this, for its context menu. */
export const SPEC_ID_ATTRIBUTE = 'data-spec-id';
export const NOTEBOOK_ITEM_SELECTOR = `.oceanum-notebooks-item[${SPEC_ID_ATTRIBUTE}]`;

const UNAVAILABLE =
  ' (unavailable: Oceanum sign-in is not configured for this host)';

interface IStore {
  specsUrl: string;
  client: SpecStoreClient;
}

/**
 * Open, save, share, rename and delete notebooks through the Oceanum spec store.
 *
 * The commands sit in the File menu, the command palette, a notebook's context menu
 * (and its tab's), and the Notebooks tab's rows. They are enabled only while signed in.
 * With `fileManagement: 'oceanum'` in the environment the local drive goes out of
 * sight and every local save is pushed to the store: see `oceanumOnly.ts`.
 */
export const sharePlugin: JupyterFrontEndPlugin<void> = {
  id: SHARE_PLUGIN_ID,
  description:
    'Open, save, share, rename and delete notebooks through the Oceanum spec store.',
  autoStart: true,
  requires: [IOceanumAuth, IDocumentManager, INotebookTracker, ICommandPalette],
  optional: [IMainMenu, ILabShell],
  activate: (
    app: JupyterFrontEnd,
    auth: IOceanumAuth,
    docManager: IDocumentManager,
    tracker: INotebookTracker,
    palette: ICommandPalette,
    mainMenu: IMainMenu | null,
    labShell: ILabShell | null
  ): void => {
    const specsUrl = auth.urls?.specs ?? null;
    const store: IStore | null =
      specsUrl === null
        ? null
        : {
            specsUrl,
            client: new SpecStoreClient({
              specsUrl,
              getAccessToken: () => auth.getAccessToken()
            })
          };
    const oceanumOnly =
      store !== null && auth.environment?.fileManagement === 'oceanum';
    const saving = new Set<NotebookPanel>();
    // Notebooks whose routed saves stopped reaching Oceanum, and the sign-in they
    // stopped under: signing in again gives every notebook another go.
    const muted = new WeakMap<NotebookPanel, number>();
    // Notebooks already reported as failing for a passing reason, so a flaky network
    // does not raise the same notification on every autosave.
    const warnedTransient = new WeakSet<NotebookPanel>();
    let signInGeneration = 0;
    let warnedSignedOut = false;

    const signedIn = (): boolean => store !== null && auth.user !== null;
    const label = (text: string) => () =>
      store ? text : `${text}${UNAVAILABLE}`;

    // --- what a command acts on ---------------------------------------------------

    /**
     * Where a command was invoked from. The context menus pass this; the File menu, the
     * palette and a keyboard shortcut pass nothing, and must not be answered with
     * whatever happens to have been right-clicked earlier — JupyterLab keeps the last
     * contextmenu event for the life of the page and never clears it, so the hit tests
     * below answer long after their menu has gone.
     */
    const sourceOf = (
      args: ReadonlyPartialJSONObject
    ): 'row' | 'notebook' | null =>
      args.source === 'row' || args.source === 'notebook' ? args.source : null;

    /** The record id under the pointer; only ask from the Notebooks tab's own menu. */
    const hitTestSpecId = (): string | null => {
      const node = app.contextMenuHitTest(candidate =>
        candidate.hasAttribute(SPEC_ID_ATTRIBUTE)
      );
      const id = node?.getAttribute(SPEC_ID_ATTRIBUTE);
      return isSpecId(id) ? id : null;
    };

    /**
     * The notebook a command acts on: from a notebook's or a tab's context menu, the one
     * under the pointer; anywhere else the current notebook, and only that.
     */
    const targetNotebook = (
      source: 'row' | 'notebook' | null
    ): NotebookPanel | null => {
      if (source === 'notebook') {
        const node = app.contextMenuHitTest(
          candidate => !!candidate.dataset.id
        );
        const id = node?.dataset.id;
        if (id) {
          const panel = tracker.find(candidate => candidate.id === id);
          if (panel) {
            return panel;
          }
        }
      }
      const widget = tracker.currentWidget;
      return widget !== null && widget === app.shell.currentWidget
        ? widget
        : null;
    };

    const linkOf = (panel: NotebookPanel): IOceanumLink | null =>
      store
        ? readLink(
            panel.context.model.getMetadata(METADATA_KEY),
            store.specsUrl
          )
        : null;

    /** The open notebook linked to a record, if any. */
    const panelFor = (id: string): NotebookPanel | null =>
      tracker.find(panel => linkOf(panel)?.spec_id === id) ?? null;

    /** A record id from the command's arguments, the pointer, or the target notebook. */
    const targetSpecId = (args: ReadonlyPartialJSONObject): string | null => {
      if (isSpecId(args.id)) {
        return args.id;
      }
      const source = sourceOf(args);
      if (source === 'row') {
        return hitTestSpecId();
      }
      const panel = targetNotebook(source);
      return panel ? (linkOf(panel)?.spec_id ?? null) : null;
    };

    // --- sign-in and errors -------------------------------------------------------

    async function offerSignIn(reason: string): Promise<boolean> {
      const result = await showDialog({
        title: 'Sign in to Oceanum.io',
        body: `${reason} Sign in to Oceanum.io?`,
        buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Sign in' })]
      });
      if (!result.button.accept) {
        return false;
      }
      try {
        await startSignIn(app.commands, auth);
      } catch (error) {
        console.error('Oceanum.io sign-in could not start', error);
        Notification.error('Oceanum.io sign-in is not available right now.', {
          autoClose: 5000
        });
        return false;
      }
      return true;
    }

    async function ensureSignedIn(reason: string): Promise<boolean> {
      await auth.ready;
      if (auth.user !== null) {
        return true;
      }
      await offerSignIn(reason);
      return false;
    }

    /**
     * Whether an error calls for signing in. A signed-in user can't sign in again: the
     * spec store refused a token Auth0 still considers valid, so show the error instead.
     */
    const needsSignIn = (error: SpecStoreError): boolean =>
      (error.kind === 'expired' || error.kind === 'signed-out') &&
      auth.user === null;

    /**
     * Tell the user. Messages never include notebook content, which can hold
     * credentials. `quiet` is for saves nobody asked for by name (autosave, Ctrl+S in
     * Oceanum-only mode): a notification, never a dialog.
     */
    async function reportError(
      action: string,
      error: unknown,
      quiet = false
    ): Promise<void> {
      if (!quiet && error instanceof SpecStoreError && needsSignIn(error)) {
        await offerSignIn(error.message);
        return;
      }
      console.error(`${action}:`, error);
      const message = error instanceof Error ? error.message : 'Unknown error.';
      Notification.error(`${action}: ${message}`, {
        autoClose: quiet ? 8000 : false
      });
    }

    /** Sharing failures are usually the owner check, which is worth explaining. */
    function shareError(kind: ErrorKind | null, error: unknown): unknown {
      return kind === 'forbidden'
        ? new Error(
            'Only the owner can share this notebook; if that is you, switch to the organisation you created it under.'
          )
        : error;
    }

    // --- opening ------------------------------------------------------------------

    /** File names in the `Oceanum` folder, creating the folder if it is missing. */
    async function oceanumFolderNames(): Promise<string[]> {
      const contents = docManager.services.contents;
      let dir;
      try {
        dir = await contents.get(OCEANUM_DIR, { content: true });
      } catch {
        dir = null;
      }
      if (!dir) {
        const created = await contents.newUntitled({
          path: '',
          type: 'directory'
        });
        await contents.rename(created.path, OCEANUM_DIR);
        return [];
      }
      if (dir.type !== 'directory' || !Array.isArray(dir.content)) {
        throw new Error(`"${OCEANUM_DIR}" exists and is not a folder.`);
      }
      return dir.content.map((item: { name: string }) => item.name);
    }

    /**
     * The file in the Oceanum folder already holding this record, or null. Only the
     * names the record itself could have been written to are read.
     */
    async function pathHoldingRecord(
      s: IStore,
      record: ISpecRecord,
      names: readonly string[]
    ): Promise<string | null> {
      for (const name of notebookNamesFor(record.name, names)) {
        const path = `${OCEANUM_DIR}/${name}`;
        try {
          const file = await docManager.services.contents.get(path, {
            content: true
          });
          const metadata = (file.content as INotebookContent | null)?.metadata;
          if (
            readLink(metadata?.[METADATA_KEY], s.specsUrl)?.spec_id ===
            record.id
          ) {
            return path;
          }
        } catch {
          // Unreadable or gone: not the copy we are looking for.
        }
      }
      return null;
    }

    /** Write a record to the local drive as `Oceanum/<name>.ipynb` and open it. */
    async function openRecord(s: IStore, record: ISpecRecord): Promise<void> {
      // Already open: bring it forward rather than writing a second copy.
      const open = panelFor(record.id);
      if (open) {
        app.shell.activateById(open.id);
        return;
      }
      const content = notebookFromRecord(record, s.specsUrl);
      const names = await oceanumFolderNames();
      // Reuse the file an earlier session left for this record. A second copy would be
      // named "<name> (1)", and a record takes its name from the file on every save, so
      // opening the same notebook twice would quietly rename it on Oceanum.
      const path =
        (await pathHoldingRecord(s, record, names)) ??
        uniqueNotebookPath(record.name, names);
      await docManager.services.contents.save(path, {
        type: 'notebook',
        format: 'json',
        content
      });
      if (!docManager.openOrReveal(path)) {
        throw new Error(`Could not open ${path}.`);
      }
    }

    async function openById(id: string): Promise<void> {
      if (
        !store ||
        !(await ensureSignedIn(
          'Opening notebooks needs an Oceanum.io account.'
        ))
      ) {
        return;
      }
      try {
        await openRecord(store, await store.client.get(id));
      } catch (error) {
        await reportError('Open from Oceanum failed', error);
      }
    }

    async function openFromOceanum(): Promise<void> {
      if (
        !store ||
        !(await ensureSignedIn(
          'Opening notebooks needs an Oceanum.io account.'
        ))
      ) {
        return;
      }
      try {
        const { mine, shared } = partitionSummaries(
          await store.client.list(),
          auth.user?.email ?? null
        );
        const result = await showDialog({
          title: 'Open from Oceanum',
          body: new NotebookListBody(mine, shared),
          buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Open' })]
        });
        if (!result.button.accept || !result.value) {
          return;
        }
        await openRecord(store, await store.client.get(result.value));
      } catch (error) {
        await reportError('Open from Oceanum failed', error);
      }
    }

    // --- saving -------------------------------------------------------------------

    /** Save a notebook to Oceanum.io; resolves with its record id, or `null`. */
    async function saveToOceanum(
      panel: NotebookPanel,
      quiet = false
    ): Promise<string | null> {
      // Ignore repeat requests while a save is in flight, so it cannot create two records.
      if (!store || saving.has(panel)) {
        return null;
      }
      saving.add(panel);
      try {
        if (quiet) {
          if (auth.user === null) {
            if (!warnedSignedOut) {
              warnedSignedOut = true;
              Notification.warning(
                'Not signed in to Oceanum.io: notebooks are only being saved locally.',
                { autoClose: 8000 }
              );
            }
            return null;
          }
        } else if (
          !(await ensureSignedIn(
            'Saving notebooks needs an Oceanum.io account.'
          ))
        ) {
          return null;
        }
        const id = await saveRecord(store, panel, quiet);
        if (id !== null) {
          muted.delete(panel);
          warnedTransient.delete(panel);
        }
        return id;
      } finally {
        saving.delete(panel);
      }
    }

    /** A routed save: after every local save in Oceanum-only mode. */
    async function pushQuietly(panel: NotebookPanel): Promise<void> {
      if (muted.get(panel) === signInGeneration) {
        return;
      }
      await saveToOceanum(panel, true);
    }

    /** Stop routed saves of a notebook until the next explicit save or sign-in. */
    function mute(panel: NotebookPanel): void {
      muted.set(panel, signInGeneration);
    }

    /** Whether repeating this save unchanged would fail for the same reason. */
    function isPermanent(error: unknown): boolean {
      return (
        error instanceof SpecStoreError &&
        error.kind !== 'network' &&
        error.kind !== 'server'
      );
    }

    async function saveRecord(
      s: IStore,
      panel: NotebookPanel,
      quiet: boolean
    ): Promise<string | null> {
      await panel.context.ready;
      const model = panel.context.model;
      // INotebookModel types toJSON loosely; NotebookModel returns INotebookContent.
      const content = model.toJSON() as INotebookContent;
      const built = buildSpecBody(content, panel.context.path, s.specsUrl);
      if (!built.ok) {
        if (quiet) {
          mute(panel);
        }
        Notification.error(
          'This notebook is too large to save to Oceanum.io, even without outputs.',
          { autoClose: quiet ? 8000 : false }
        );
        return null;
      }
      const link = readLink(model.getMetadata(METADATA_KEY), s.specsUrl);

      let record: ISpecRecord;
      try {
        if (link === null) {
          record = await s.client.create(built.body);
        } else {
          try {
            record = await s.client.update(link.spec_id, built.body);
          } catch (error) {
            if (
              !(error instanceof SpecStoreError) ||
              (error.kind !== 'forbidden' && error.kind !== 'not-found')
            ) {
              throw error;
            }
            if (quiet) {
              // Nobody asked for this save by name, so no dialog: say once why it
              // is not reaching Oceanum and leave the notebook alone until they do.
              mute(panel);
              Notification.error(
                `${error.message} Use Save to Oceanum to save a copy.`,
                { autoClose: 8000 }
              );
              return null;
            }
            const result = await showDialog({
              title: 'Cannot save to the linked Oceanum notebook',
              body: `${error.message} Save as a new copy instead?`,
              buttons: [
                Dialog.cancelButton(),
                Dialog.okButton({ label: 'Save as a new copy' })
              ]
            });
            if (!result.button.accept) {
              return null;
            }
            record = await s.client.create(built.body);
          }
        }
      } catch (error) {
        if (quiet) {
          // A reason that will not pass on its own (no access, gone, signed out) mutes
          // this notebook until the user saves it themselves or signs in again. A
          // passing one (network, 5xx) does not: the next save simply tries again, and
          // the warning is raised once rather than on every autosave until one works.
          if (isPermanent(error)) {
            mute(panel);
          } else if (warnedTransient.has(panel)) {
            console.warn('Save to Oceanum failed again', error);
            return null;
          } else {
            warnedTransient.add(panel);
          }
        }
        await reportError('Save to Oceanum failed', error, quiet);
        return null;
      }

      if (record.id !== link?.spec_id) {
        const value: IOceanumLink = {
          spec_id: record.id,
          specs_url: s.specsUrl
        };
        if (link?.description) {
          value.description = link.description;
        }
        model.setMetadata(METADATA_KEY, value);
        notebooksChanged.emit();
      }
      try {
        await panel.context.save();
      } catch (error) {
        await reportError(
          'Saved to Oceanum, but saving the local file failed',
          error,
          quiet
        );
        return record.id;
      }
      if (!quiet) {
        Notification.success(
          built.strippedOutputs
            ? `Saved "${record.name}" to Oceanum without outputs, which made it too large.`
            : `Saved "${record.name}" to Oceanum.`,
          { autoClose: 5000 }
        );
      }
      return record.id;
    }

    // --- sharing ------------------------------------------------------------------

    async function shareOnOceanum(panel: NotebookPanel): Promise<void> {
      if (
        !store ||
        !(await ensureSignedIn(
          'Sharing notebooks needs an Oceanum.io account.'
        ))
      ) {
        return;
      }
      await panel.context.ready;
      let id = linkOf(panel)?.spec_id ?? null;
      if (id === null) {
        const result = await showDialog({
          title: 'Save to Oceanum first',
          body: 'This notebook must be saved to Oceanum before it can be shared. Save it now?',
          buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Save' })]
        });
        if (!result.button.accept) {
          return;
        }
        id = await saveToOceanum(panel);
        if (id === null) {
          return;
        }
      }
      await shareRecord(id);
    }

    async function shareRecord(id: string): Promise<void> {
      if (
        !store ||
        !(await ensureSignedIn(
          'Sharing notebooks needs an Oceanum.io account.'
        ))
      ) {
        return;
      }
      const result = await showDialog({
        title: 'Share on Oceanum',
        body: new ShareBody(
          shareLink(PageConfig.getBaseUrl(), window.location.href, id)
        ),
        focusNodeSelector: 'textarea.jp-OceanumShare-email',
        buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Share' })]
      });
      if (!result.button.accept) {
        return;
      }
      const choice = result.value;
      if (!choice) {
        Notification.warning(
          'Enter a valid email address to share with a person.',
          { autoClose: 5000 }
        );
        return;
      }
      if (choice.action === 'revoke') {
        const { grant } = choice;
        try {
          await store.client.removePermission(id, grant);
        } catch (error) {
          const kind = error instanceof SpecStoreError ? error.kind : null;
          if (kind === 'not-found') {
            Notification.info('This notebook was not shared with everyone.', {
              autoClose: 5000
            });
            return;
          }
          await reportError('Share on Oceanum failed', shareError(kind, error));
          return;
        }
        Notification.success(
          'Only people it is shared with can open this notebook now.',
          { autoClose: 5000 }
        );
        return;
      }

      // Share with the addresses we can and name the rest. Refusing the whole
      // submission would be defensible on its own, but the dialog is rebuilt on every
      // open and is destroyed when it is accepted, so it would also throw away
      // everything typed — one bad address in a pasted list of twenty would mean
      // reassembling all twenty.
      if (choice.invalid.length > 0) {
        Notification.warning(
          `Not a valid email address: ${choice.invalid.join(', ')}.` +
            (choice.grants.length === 0 ? ' Nobody was added.' : ''),
          { autoClose: 8000 }
        );
        if (choice.grants.length === 0) {
          return;
        }
      }

      // The spec store takes one grant per request, so share with each person in turn
      // and report the outcomes together — a failure part-way through must not leave
      // the user guessing which of them now have access.
      const failures: { entity: string; error: unknown }[] = [];
      let shared = 0;
      for (const grant of choice.grants) {
        try {
          await store.client.addPermission(id, grant);
          shared++;
        } catch (error) {
          failures.push({ entity: grant.entity, error });
          // The owner check is on the record, not the address: if it refuses one it
          // refuses all of them, so stop rather than firing the rest at a wall.
          if (error instanceof SpecStoreError && error.kind === 'forbidden') {
            break;
          }
        }
      }

      const isPublic = choice.grants.some(grant => grant.type === 'public');
      const forbidden = failures.some(
        failure =>
          failure.error instanceof SpecStoreError &&
          failure.error.kind === 'forbidden'
      );

      // Losing the owner check fails every grant for the same reason, so say it once.
      if (forbidden && shared === 0) {
        await reportError(
          'Share on Oceanum failed',
          shareError('forbidden', null)
        );
        return;
      }
      if (failures.length > 0) {
        // Keep the original error rather than describing it. It carries the only
        // explanation the user gets ("Could not reach Oceanum.io", "HTTP 500"), and
        // reportError reads it to decide whether to offer sign-in — a synthetic Error
        // is never a SpecStoreError, so an expired session would leave no way back
        // in. The public grant has an empty entity, so naming entities alone says
        // nothing at all.
        const first = failures[0].error;
        const report = reportForShareFailures(
          choice.grants.length,
          failures.map(failure => failure.entity),
          first instanceof SpecStoreError && needsSignIn(first)
        );
        if (report.kind === 'original') {
          await reportError('Share on Oceanum failed', first);
          return;
        }
        // Some worked: say which did not, and still give the reason for the first.
        const reason =
          first instanceof Error ? first.message : 'Unknown error.';
        await reportError(
          'Share on Oceanum failed',
          new Error(
            `Shared with ${shared} of ${choice.grants.length}. Could not share with ${report.named.join(', ')}: ${reason}`
          )
        );
        return;
      }

      const level =
        choice.grants[0]?.permission === 'write' ? 'can edit' : 'can view';
      Notification.success(
        isPublic
          ? 'Anyone with the link can now view this notebook.'
          : shared === 1
            ? `Shared with ${choice.grants[0].entity} (${level}).`
            : `Shared with ${shared} people (${level}).`,
        { autoClose: 5000 }
      );
    }

    // --- renaming and deleting ----------------------------------------------------

    async function renameRecord(id: string): Promise<void> {
      if (
        !store ||
        !(await ensureSignedIn(
          'Renaming notebooks needs an Oceanum.io account.'
        ))
      ) {
        return;
      }
      const open = panelFor(id);
      let record: ISpecRecord;
      try {
        record = await store.client.get(id);
      } catch (error) {
        await reportError('Rename on Oceanum failed', error);
        return;
      }
      const result = await InputDialog.getText({
        title: 'Rename on Oceanum',
        text: record.name,
        okLabel: 'Rename'
      });
      const name = result.value?.trim() ?? '';
      if (!result.button.accept || name === '' || name === record.name) {
        return;
      }
      try {
        if (open) {
          // The record takes its name from the local file on every save, so the file
          // has to follow or the next save would put the old name back. It moves first:
          // if the record is what fails, the next save renames it anyway and the two
          // converge on what was asked for, where the other order would undo itself.
          const path = open.context.path;
          const dir = path.includes('/')
            ? path.slice(0, path.lastIndexOf('/') + 1)
            : '';
          await docManager.rename(path, `${dir}${sanitizeName(name)}.ipynb`);
        }
        // Only the name goes: the notebook stays as it is, so this cannot overwrite a
        // change another writer made to it while the dialog was open.
        await store.client.rename(id, name);
      } catch (error) {
        await reportError('Rename on Oceanum failed', error);
        return;
      }
      notebooksChanged.emit();
    }

    async function deleteRecord(id: string): Promise<void> {
      if (
        !store ||
        !(await ensureSignedIn(
          'Deleting notebooks needs an Oceanum.io account.'
        ))
      ) {
        return;
      }
      const open = panelFor(id);
      let name: string;
      try {
        name = (await store.client.get(id)).name;
      } catch (error) {
        await reportError('Delete from Oceanum failed', error);
        return;
      }
      const result = await showDialog({
        title: 'Delete from Oceanum',
        body: `Delete "${name}" from Oceanum.io? Everyone it is shared with loses it, and this cannot be undone.`,
        buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Delete' })]
      });
      if (!result.button.accept) {
        return;
      }
      try {
        await store.client.remove(id);
      } catch (error) {
        await reportError('Delete from Oceanum failed', error);
        return;
      }
      notebooksChanged.emit();
      if (!open) {
        Notification.success(`Deleted "${name}" from Oceanum.`, {
          autoClose: 5000
        });
        return;
      }
      if (oceanumOnly) {
        // The local file is the hidden working copy of a record that is gone; left
        // there, the next routed save would bring the record straight back.
        try {
          open.context.model.dirty = false;
          await docManager.deleteFile(open.context.path);
        } catch (error) {
          await reportError(
            'Deleted from Oceanum, but closing the notebook failed',
            error
          );
        }
        Notification.success(`Deleted "${name}" from Oceanum.`, {
          autoClose: 5000
        });
        return;
      }
      // Elsewhere the local file is the user's own: keep it, but forget the record so
      // the next Save to Oceanum creates a new one rather than failing on a missing id.
      open.context.model.deleteMetadata(METADATA_KEY);
      Notification.success(
        `Deleted "${name}" from Oceanum. The local file was kept.`,
        { autoClose: 5000 }
      );
    }

    // --- shared links -------------------------------------------------------------

    /**
     * Try the link again once a user signs in, through the dialog or the account
     * button. It cannot loop: a signed-in user who still may not open it gets an error
     * and the link clears.
     */
    function openWhenSignedIn(): void {
      if (auth.user !== null) {
        // Already signed in (signIn() does nothing then), so no userChanged will follow.
        void openFromQuery();
        return;
      }
      const onUserChanged = (_: unknown, user: unknown): void => {
        if (user !== null) {
          auth.userChanged.disconnect(onUserChanged);
          void openFromQuery();
        }
      };
      auth.userChanged.connect(onUserChanged);
    }

    /** Open `?oceanum-notebook=<id>`, then remove the parameter from the address bar. */
    async function openFromQuery(): Promise<void> {
      const url = new URL(window.location.href);
      const id = url.searchParams.get(QUERY_PARAM);
      if (id === null || !store) {
        return;
      }
      const clearQuery = () => {
        url.searchParams.delete(QUERY_PARAM);
        window.history.replaceState(window.history.state, '', url.toString());
      };
      if (!isSpecId(id)) {
        clearQuery();
        Notification.warning('The Oceanum notebook link is not valid.', {
          autoClose: 5000
        });
        return;
      }
      let record: ISpecRecord;
      try {
        record = await store.client.get(id);
      } catch (error) {
        const kind = error instanceof SpecStoreError ? error.kind : null;
        const reason =
          kind === 'forbidden' && auth.user === null
            ? 'This notebook is not shared publicly.'
            : error instanceof SpecStoreError && needsSignIn(error)
              ? error.message
              : null;
        if (reason !== null) {
          if (!(await offerSignIn(reason))) {
            clearQuery();
            return;
          }
          // Leave the parameter in place while signing in, and open the link once
          // someone has. Sign-in does not reload the page to try again.
          openWhenSignedIn();
          return;
        }
        clearQuery();
        await reportError('Opening the shared notebook failed', error);
        return;
      }
      try {
        await openRecord(store, record);
      } catch (error) {
        await reportError('Opening the shared notebook failed', error);
      }
      clearQuery();
    }

    // --- commands -----------------------------------------------------------------

    /** Whether the command can act on the pointer's row, the target notebook, or both. */
    const enabledFor = (
      wants: 'row-or-notebook' | 'row-or-link' | 'notebook',
      args: ReadonlyPartialJSONObject
    ): boolean => {
      if (!signedIn()) {
        return false;
      }
      const source = sourceOf(args);
      if (wants !== 'notebook' && source === 'row') {
        return hitTestSpecId() !== null;
      }
      const panel = targetNotebook(source);
      if (panel === null) {
        return false;
      }
      return wants === 'row-or-link' ? linkOf(panel) !== null : true;
    };

    /** The id a row-sourced command acts on, or null anywhere else. */
    const rowSpecId = (args: ReadonlyPartialJSONObject): string | null =>
      isSpecId(args.id)
        ? args.id
        : sourceOf(args) === 'row'
          ? hitTestSpecId()
          : null;

    app.commands.addCommand(CommandIDs.open, {
      // On a Notebooks row the command is plainly "Open"; elsewhere it opens a picker.
      label: args => (rowSpecId(args) ? 'Open' : label('Open from Oceanum…')()),
      caption: 'Open a notebook saved on Oceanum.io',
      isEnabled: () => signedIn(),
      execute: async args => {
        const id = rowSpecId(args);
        await (id ? openById(id) : openFromOceanum());
      }
    });
    app.commands.addCommand(CommandIDs.save, {
      label: label('Save to Oceanum'),
      caption: 'Save the notebook to Oceanum.io',
      isEnabled: args => enabledFor('notebook', args),
      execute: async args => {
        const panel = targetNotebook(sourceOf(args));
        if (panel) {
          await saveToOceanum(panel);
        }
      }
    });
    app.commands.addCommand(CommandIDs.share, {
      label: label('Share on Oceanum…'),
      caption: 'Share the notebook through Oceanum.io',
      isEnabled: args => enabledFor('row-or-notebook', args),
      execute: async args => {
        const id = rowSpecId(args);
        if (id) {
          await shareRecord(id);
          return;
        }
        const panel = targetNotebook(sourceOf(args));
        if (panel) {
          await shareOnOceanum(panel);
        }
      }
    });
    app.commands.addCommand(CommandIDs.rename, {
      label: args =>
        rowSpecId(args) ? 'Rename…' : label('Rename on Oceanum…')(),
      caption: 'Rename the notebook on Oceanum.io',
      isEnabled: args => enabledFor('row-or-link', args),
      execute: async args => {
        const id = targetSpecId(args);
        if (id) {
          await renameRecord(id);
        }
      }
    });
    app.commands.addCommand(CommandIDs.delete, {
      label: args =>
        rowSpecId(args) ? 'Delete' : label('Delete from Oceanum')(),
      caption: 'Delete the notebook from Oceanum.io',
      isEnabled: args => enabledFor('row-or-link', args),
      execute: async args => {
        const id = targetSpecId(args);
        if (id) {
          await deleteRecord(id);
        }
      }
    });

    const commands = [
      CommandIDs.open,
      CommandIDs.save,
      CommandIDs.share,
      CommandIDs.rename,
      CommandIDs.delete
    ];
    for (const command of commands) {
      palette.addItem({ command, category: 'Oceanum' });
    }
    // After JupyterLab's own Save group (rank 4), before Reload and Rename (rank 5).
    mainMenu?.fileMenu.addGroup(
      commands.map(command => ({ command })),
      4.5
    );
    // Right-click in a notebook, or on its tab.
    for (const selector of ['.jp-Notebook', '[data-type="document-title"]']) {
      app.contextMenu.addItem({ type: 'separator', selector, rank: 45 });
      for (const [i, command] of [
        CommandIDs.save,
        CommandIDs.share,
        CommandIDs.rename,
        CommandIDs.delete
      ].entries()) {
        app.contextMenu.addItem({
          command,
          args: { source: 'notebook' },
          selector,
          rank: 46 + i
        });
      }
    }
    // Right-click on a row of the Notebooks tab.
    for (const [i, command] of [
      CommandIDs.open,
      CommandIDs.rename,
      CommandIDs.share,
      CommandIDs.delete
    ].entries()) {
      app.contextMenu.addItem({
        command,
        args: { source: 'row' },
        selector: NOTEBOOK_ITEM_SELECTOR,
        rank: i
      });
    }

    const refresh = (): void => {
      for (const command of commands) {
        app.commands.notifyCommandChanged(command);
      }
    };
    tracker.currentChanged.connect(refresh);
    labShell?.currentChanged.connect(refresh);
    auth.userChanged.connect((_, user) => {
      if (user !== null) {
        signInGeneration++;
      }
      warnedSignedOut = false;
      refresh();
    });

    if (oceanumOnly) {
      void app.restored.then(() => {
        hideFileBrowser(app.shell);
        // IFileMenu is the narrow interface; the menu itself is a Lumino Menu, which
        // is what can drop items.
        const fileMenu = mainMenu?.fileMenu;
        if (fileMenu instanceof Menu) {
          pruneFileMenu(fileMenu);
          pruneBeforeEachOpen(fileMenu);
        }
        routeSaves(tracker, pushQuietly);
      });
    }

    Promise.all([app.restored, auth.ready])
      .then(() => openFromQuery())
      .catch(error =>
        console.error('Failed to open the Oceanum notebook link', error)
      );
  }
};

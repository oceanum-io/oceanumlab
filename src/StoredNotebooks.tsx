import * as React from 'react';

import { IOceanumAuth } from './auth/tokens';
import { SpecStoreClient, SpecStoreError } from './share/client';
import { notebooksChanged } from './share/events';
import {
  demoItemsFromSummaries,
  INotebookDemoItem,
  ISpecSummary,
  NOTEBOOK_DEMO_TYPE,
  partitionSummaries
} from './share/notebook';
import { SPEC_ID_ATTRIBUTE } from './share/plugin';

/** Example rows carry their record id here, not in SPEC_ID_ATTRIBUTE: see Examples. */
export const EXAMPLE_ID_ATTRIBUTE = 'data-example-id';

export interface IStoredNotebooksProps {
  auth: IOceanumAuth;
  /**
   * Open a stored notebook. Undefined where nothing has registered a way to open one;
   * the list then reads rather than offering a click that does nothing.
   */
  onOpen?: (item: ISpecSummary) => void;
  /** Open a copy of an example, as `onOpen` does for a stored notebook. */
  onOpenExample?: (item: INotebookDemoItem) => void;
  /** Upload a notebook from the user's computer; no Upload button without it. */
  onUpload?: () => void;
  /**
   * Whether the examples are listed, or folded under their heading. Default true. Null
   * while the setting is still loading: the Examples wait for it, so examples a user
   * has hidden never show for a moment first.
   */
  showExamples?: boolean | null;
  /**
   * Record the user's choice to show or hide the examples. The Examples heading offers
   * its switch only where this is given: a switch that could not keep its setting
   * would flip back on the next load.
   */
  onShowExamplesChange?: (show: boolean) => void;
  /**
   * Start signing in the way this host shows it; without it the auth's own `signIn()`
   * is used, which on a JupyterLab server shows no code dialog.
   */
  onSignIn?: () => void;
}

/** The Notebook Demo specs the user can read, which are the Examples. */
type Examples =
  | { state: 'none' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: INotebookDemoItem[] };

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: ISpecSummary[]; examples: Examples };

/**
 * List the Notebook Demo specs, each one an example notebook. Only org oceanum may
 * create them (spec store 0.6.2), so every one listed is Oceanum's. Never rejects: a
 * failure here is shown in the Examples section and leaves the rest of the tab alone.
 */
async function loadExamples(
  auth: IOceanumAuth,
  specsUrl: string
): Promise<Examples> {
  try {
    const client = new SpecStoreClient({
      specsUrl,
      getAccessToken: () => auth.getAccessToken(),
      specType: NOTEBOOK_DEMO_TYPE
    });
    return {
      state: 'ready',
      items: demoItemsFromSummaries(await client.list())
    };
  } catch (error) {
    // A store with no Notebook Demo type has no examples, which is not an error.
    if (error instanceof SpecStoreError && error.kind === 'not-found') {
      return { state: 'none' };
    }
    return {
      state: 'error',
      message:
        error instanceof Error ? error.message : 'Could not reach Oceanum.io.'
    };
  }
}

/**
 * The curated examples. Their rows deliberately leave out SPEC_ID_ATTRIBUTE and the
 * stored-notebook row class: the share plugin's row menu (Open, Rename, Share, Delete)
 * is bound to those, and none of it applies to Oceanum's own example records.
 */
function ExampleSections({
  examples,
  onOpen,
  show,
  onShowChange
}: {
  examples: Examples;
  onOpen?: (item: INotebookDemoItem) => void;
  show: boolean | null;
  onShowChange?: (show: boolean) => void;
}): React.ReactElement | null {
  // Not yet known, or hidden with no switch to bring them back: nothing to show.
  if (examples.state === 'none' || show === null || (!show && !onShowChange)) {
    return null;
  }
  const count = examples.state === 'ready' ? examples.items.length : null;
  if (count === 0) {
    return null;
  }
  const heading = (
    <div className="oceanum-notebooks-heading">
      Examples
      <span className="oceanum-notebooks-heading-end">
        {count !== null && (
          <span className="oceanum-notebooks-count">{count}</span>
        )}
        {onShowChange && (
          <button
            type="button"
            role="switch"
            aria-checked={show}
            aria-label="Show examples"
            title="Show examples"
            className="oceanum-notebooks-switch"
            onClick={() => onShowChange(!show)}
          >
            <span className="oceanum-notebooks-switch-thumb" />
          </button>
        )}
      </span>
    </div>
  );
  // Hidden: the heading stays, so the switch is there to bring them back.
  if (!show) {
    return <div className="oceanum-notebooks-section">{heading}</div>;
  }
  if (examples.state === 'error') {
    return (
      <div className="oceanum-notebooks-section">
        {heading}
        <div className="oceanum-text-error">
          The examples could not be loaded. {examples.message}
        </div>
      </div>
    );
  }
  return (
    <div className="oceanum-notebooks-section">
      {heading}
      <ul className="oceanum-notebooks-list">
        {examples.items.map(item => {
          const attributes = {
            [EXAMPLE_ID_ATTRIBUTE]: item.id,
            title: item.summary
          };
          // Names come from the spec store: React escapes them, never set as HTML.
          const name = (
            <span className="oceanum-notebooks-name">{item.title}</span>
          );
          return (
            <li key={item.id}>
              {onOpen ? (
                <button
                  type="button"
                  className="oceanum-notebooks-example"
                  onClick={() => onOpen(item)}
                  {...attributes}
                >
                  {name}
                </button>
              ) : (
                <div
                  className="oceanum-notebooks-example oceanum-notebooks-item-static"
                  {...attributes}
                >
                  {name}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Section({
  title,
  items,
  empty,
  onOpen
}: {
  title: string;
  items: readonly ISpecSummary[];
  empty: string;
  onOpen?: (item: ISpecSummary) => void;
}): React.ReactElement {
  // Each row carries its record id so the share plugin's context menu (Open, Rename,
  // Share, Delete) can tell which one was clicked.
  const rowAttributes = (item: ISpecSummary) => ({
    [SPEC_ID_ATTRIBUTE]: item.id,
    title: item.description ?? undefined
  });
  return (
    <div className="oceanum-notebooks-section">
      <div className="oceanum-notebooks-heading">
        {title}
        <span className="oceanum-notebooks-count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="oceanum-text-empty">{empty}</div>
      ) : (
        <ul className="oceanum-notebooks-list">
          {items.map(item => (
            <li key={item.id}>
              {/* Names come from other users: React escapes these, never set as HTML. */}
              {onOpen ? (
                <button
                  type="button"
                  className="oceanum-notebooks-item"
                  onClick={() => onOpen(item)}
                  {...rowAttributes(item)}
                >
                  <span className="oceanum-notebooks-name">
                    {item.name || 'Untitled'}
                  </span>
                </button>
              ) : (
                <div
                  className="oceanum-notebooks-item oceanum-notebooks-item-static"
                  {...rowAttributes(item)}
                >
                  <span className="oceanum-notebooks-name">
                    {item.name || 'Untitled'}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The notebooks this user has stored on Oceanum.io, theirs and those shared with them.
 */
export function StoredNotebooks({
  auth,
  onOpen,
  onOpenExample,
  onUpload,
  showExamples = true,
  onShowExamplesChange,
  onSignIn
}: IStoredNotebooksProps): React.ReactElement {
  const [load, setLoad] = React.useState<Load>({ state: 'loading' });
  const [user, setUser] = React.useState(auth.user);
  // Bumped whenever the store changes, so the list is fetched again.
  const [version, setVersion] = React.useState(0);

  // Reload whenever the signed-in user changes, so signing in or out does not leave a
  // stale list from the previous session on screen; and whenever this extension has
  // created, renamed or deleted a record.
  React.useEffect(() => {
    const onUser = (): void => setUser(auth.user);
    const onChanged = (): void => setVersion(v => v + 1);
    auth.userChanged.connect(onUser);
    notebooksChanged.connect(onChanged);
    return () => {
      auth.userChanged.disconnect(onUser);
      notebooksChanged.disconnect(onChanged);
    };
  }, [auth]);

  React.useEffect(() => {
    let cancelled = false;
    const specs = auth.urls?.specs ?? null;
    if (!user || !specs) {
      setLoad({ state: 'ready', items: [], examples: { state: 'none' } });
      return;
    }
    setLoad({ state: 'loading' });
    void (async () => {
      try {
        const client = new SpecStoreClient({
          specsUrl: specs,
          getAccessToken: () => auth.getAccessToken()
        });
        const [items, examples] = await Promise.all([
          client.list(),
          loadExamples(auth, specs)
        ]);
        if (!cancelled) {
          setLoad({ state: 'ready', items, examples });
        }
      } catch (error) {
        if (!cancelled) {
          setLoad({
            state: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Could not reach Oceanum.io.'
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, user, version]);

  if (!user) {
    const signIn = (): void => {
      if (onSignIn) {
        onSignIn();
        return;
      }
      auth.signIn().catch(error => {
        console.warn('Oceanum.io sign-in could not start.', error);
      });
    };
    return (
      <div className="oceanum-text-empty">
        {/* A link rather than a button to match the panel's other actions, so it
            carries the role and the keys a button would have. */}
        <a
          role="button"
          tabIndex={0}
          onClick={signIn}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              signIn();
            }
          }}
        >
          Sign in
        </a>{' '}
        to Oceanum.io to see your notebooks.
      </div>
    );
  }
  if (load.state === 'loading') {
    return <div className="oceanum-text-empty">Loading…</div>;
  }
  if (load.state === 'error') {
    // Never render the sections alongside an error: their empty messages would claim
    // the account has no notebooks when the load simply failed.
    return <div className="oceanum-text-error">{load.message}</div>;
  }

  const { mine, shared } = partitionSummaries(load.items, user.email);
  return (
    <div className="oceanum-notebooks">
      {/* Without a spec store the upload command does nothing. */}
      {onUpload && auth.urls?.specs ? (
        <div className="oceanum-notebooks-actions">
          <button
            type="button"
            className="oceanum-notebooks-upload"
            title="Upload a notebook from this computer, to save on Oceanum.io"
            onClick={onUpload}
          >
            Upload notebook…
          </button>
        </div>
      ) : null}
      <Section
        title="My notebooks"
        items={mine}
        empty="You have not saved any notebooks yet."
        onOpen={onOpen}
      />
      <Section
        title="Shared with me"
        items={shared}
        empty="No notebooks have been shared with you."
        onOpen={onOpen}
      />
      <ExampleSections
        examples={load.examples}
        onOpen={onOpenExample}
        show={showExamples}
        onShowChange={onShowExamplesChange}
      />
    </div>
  );
}

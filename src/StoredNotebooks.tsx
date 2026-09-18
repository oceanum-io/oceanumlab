import * as React from 'react';

import { IOceanumAuth } from './auth/tokens';
import { SpecStoreClient } from './share/client';
import { notebooksChanged } from './share/events';
import { ISpecSummary, partitionSummaries } from './share/notebook';
import { SPEC_ID_ATTRIBUTE } from './share/plugin';

export interface IStoredNotebooksProps {
  auth: IOceanumAuth;
  /**
   * Open a stored notebook. Undefined where nothing has registered a way to open one;
   * the list then reads rather than offering a click that does nothing.
   */
  onOpen?: (item: ISpecSummary) => void;
  /**
   * Start signing in the way this host shows it; without it the auth's own `signIn()`
   * is used, which on a JupyterLab server shows no code dialog.
   */
  onSignIn?: () => void;
}

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: ISpecSummary[] };

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
      setLoad({ state: 'ready', items: [] });
      return;
    }
    setLoad({ state: 'loading' });
    void (async () => {
      try {
        const client = new SpecStoreClient({
          specsUrl: specs,
          getAccessToken: () => auth.getAccessToken()
        });
        const items = await client.list();
        if (!cancelled) {
          setLoad({ state: 'ready', items });
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
        <a onClick={signIn}>Sign in</a> to Oceanum.io to see your notebooks.
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
    </div>
  );
}

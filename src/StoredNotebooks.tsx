import * as React from 'react';

import { IOceanumAuth } from './auth/tokens';
import { ISpecSummary, listNotebooks, partitionNotebooks } from './specStore';

export interface IStoredNotebooksProps {
  auth: IOceanumAuth;
  /**
   * Open a stored notebook, when this host can. Undefined where nothing has registered
   * a way to open one — today that is native JupyterLab, which has no spec store drive
   * until OCE-182. The list then reads rather than offering an action that does nothing.
   */
  onOpen?: (item: ISpecSummary) => void;
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
                  title={item.description ?? undefined}
                >
                  <span className="oceanum-notebooks-name">
                    {item.name || 'Untitled'}
                  </span>
                </button>
              ) : (
                <div
                  className="oceanum-notebooks-item oceanum-notebooks-item-static"
                  title={item.description ?? undefined}
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
  onOpen
}: IStoredNotebooksProps): React.ReactElement {
  const [load, setLoad] = React.useState<Load>({ state: 'loading' });
  const [user, setUser] = React.useState(auth.user);

  // Reload whenever the signed-in user changes, so signing in or out does not leave a
  // stale list from the previous session on screen.
  React.useEffect(() => {
    const onUser = (): void => setUser(auth.user);
    auth.userChanged.connect(onUser);
    return () => {
      auth.userChanged.disconnect(onUser);
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
        const token = await auth.getAccessToken();
        if (cancelled) {
          return;
        }
        if (!token) {
          setLoad({ state: 'ready', items: [] });
          return;
        }
        const items = await listNotebooks(specs, token);
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
  }, [auth, user]);

  if (!user) {
    return (
      <div className="oceanum-text-empty">
        Sign in to Oceanum.io to see your notebooks.
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

  const { mine, shared } = partitionNotebooks(load.items, user.email);
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

/**
 * Reading the Oceanum spec store's `notebook` records.
 *
 * Deliberately small: only what the Stored notebooks tab needs. oceanum-notebook's
 * share-oceanum package has a fuller client (create, update, permissions), and when
 * sharing moves here the two should become one rather than sitting side by side.
 */

/** A spec store list entry. The list omits the notebook body. */
export interface ISpecSummary {
  id: string;
  name: string;
  description: string | null;
  /** Set when the record is created and never updated, so this is a creation time. */
  modified: string;
  /** Null unless the caller created the record: the store hides other creators. */
  creator: string | null;
}

function isSummary(value: unknown): value is ISpecSummary {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.modified === 'string'
  );
}

/**
 * Every notebook the signed-in user may read: their own and those shared with them.
 *
 * The store answers an unauthenticated caller with an empty list rather than an error,
 * so a missing token is indistinguishable from an empty account — callers should check
 * they are signed in before showing "no notebooks".
 */
export async function listNotebooks(
  specsUrl: string,
  token: string,
  fetcher: typeof fetch = fetch
): Promise<ISpecSummary[]> {
  const url = `${specsUrl.replace(/\/+$/, '')}/specs/notebook`;
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    // The store answers a bad or expired token with 400, and 403 both for no access
    // and for a record that does not exist.
    throw new Error(`Oceanum.io returned HTTP ${response.status}.`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('Oceanum.io returned an unexpected response.');
  }
  return data.filter(isSummary);
}

/**
 * Split a listing into the caller's own notebooks and the rest, newest first.
 *
 * The store only sends `creator` on records the caller created, so anything else it
 * returns is shared with them — directly, or because it is public. Addresses are
 * compared case-insensitively: the store matches entities as case-sensitive globs, so
 * the two sides can differ in case.
 */
export function partitionNotebooks(
  items: readonly ISpecSummary[],
  email: string | null
): { mine: ISpecSummary[]; shared: ISpecSummary[] } {
  const me = email?.toLowerCase() ?? null;
  const sorted = [...items].sort((a, b) =>
    b.modified.localeCompare(a.modified)
  );
  const isMine = (item: ISpecSummary): boolean =>
    me !== null && item.creator?.toLowerCase() === me;
  return {
    mine: sorted.filter(isMine),
    shared: sorted.filter(item => !isMine(item))
  };
}

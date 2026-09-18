import {
  isSpecId,
  ISpecBody,
  ISpecPatch,
  ISpecRecord,
  ISpecSummary
} from './notebook';

export type ErrorKind =
  | 'signed-out'
  | 'expired'
  | 'forbidden'
  | 'not-found'
  | 'too-large'
  | 'network'
  | 'invalid'
  | 'unsupported'
  | 'server';

const MESSAGES: Record<Exclude<ErrorKind, 'server'>, string> = {
  'signed-out': 'Sign in to Oceanum.io to continue.',
  expired: 'Your Oceanum session has expired, sign in again.',
  forbidden:
    'You have no access to this notebook. It may not exist, or was created under another organisation.',
  'not-found': 'This notebook no longer exists on Oceanum.io.',
  'too-large': 'The notebook is too large for Oceanum.io (32 MiB limit).',
  network:
    'Could not reach Oceanum.io. Check your connection; very large notebooks can also fail this way.',
  invalid: 'Oceanum.io returned an unexpected response.',
  unsupported: 'This Oceanum.io service does not offer that operation yet.'
};

/** A spec store failure with a message that is safe to show to the user. */
export class SpecStoreError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly status: number | null = null
  ) {
    super(
      kind === 'server'
        ? `Oceanum.io returned an error (HTTP ${status}).`
        : MESSAGES[kind]
    );
    this.name = 'SpecStoreError';
  }
}

/** Map a failed HTTP status to an error. */
export function errorForStatus(status: number): SpecStoreError {
  switch (status) {
    // The spec store's authentication middleware answers a bad or expired token with 400.
    case 400:
      return new SpecStoreError('expired', status);
    // Casbin answers 403 both for no access and for a record that does not exist.
    case 403:
      return new SpecStoreError('forbidden', status);
    case 404:
      return new SpecStoreError('not-found', status);
    case 405:
      // The route is there but not this method: a store from before it had PATCH.
      return new SpecStoreError('unsupported', status);
    case 413:
      return new SpecStoreError('too-large', status);
    default:
      return new SpecStoreError('server', status);
  }
}

export type SharePermission = 'read' | 'write';

/** A permission grant, as accepted by `POST /specs/notebook/{id}/permissions`. */
export type PermissionGrant =
  | { type: 'user'; entity: string; permission: SharePermission }
  | { type: 'public'; entity: ''; permission: 'read' };

/**
 * What the share dialog asks for: add grants, or remove one (e.g. stop public access).
 *
 * Granting carries a list because the dialog shares with several people at once, while
 * the spec store takes one grant per request. `invalid` carries back anything typed that
 * is not a shareable address, so the caller can name it rather than failing with
 * "invalid email".
 */
export type ShareChoice =
  | { action: 'grant'; grants: PermissionGrant[]; invalid: string[] }
  | { action: 'revoke'; grant: PermissionGrant };

export interface ISpecStoreClientOptions {
  /** Spec store base URL, e.g. `https://specs.oceanum.io`. */
  specsUrl: string;
  /** Returns a current access token or `null`. Called for every request. */
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}

function isSummary(value: unknown): value is ISpecSummary {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    isSpecId(v.id) &&
    typeof v.name === 'string' &&
    typeof v.modified === 'string'
  );
}

function isRecord(value: unknown): value is ISpecRecord {
  return isSummary(value) && 'spec' in value;
}

/** Client for the `notebook` spec type of the Oceanum spec store. */
export class SpecStoreClient {
  constructor(options: ISpecStoreClientOptions) {
    this._base = `${options.specsUrl.replace(/\/+$/, '')}/specs/notebook`;
    this._getAccessToken = options.getAccessToken;
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Every notebook the user may read, including public ones. */
  async list(): Promise<ISpecSummary[]> {
    const data = await this._request('GET', this._base, { auth: 'required' });
    if (!Array.isArray(data) || !data.every(isSummary)) {
      throw new SpecStoreError('invalid');
    }
    return data;
  }

  /** Read a record, anonymously when signed out. */
  async get(id: string): Promise<ISpecRecord> {
    return this._record(
      await this._request('GET', this._url(id), { auth: 'optional' })
    );
  }

  /** Create a record. The server mints the id: use the returned record's. */
  async create(body: ISpecBody): Promise<ISpecRecord> {
    return this._record(
      await this._request('POST', this._base, {
        auth: 'required',
        body: pick(body)
      })
    );
  }

  /** Replace a record's name, description and notebook. */
  async update(id: string, body: ISpecBody): Promise<ISpecRecord> {
    return this._record(
      await this._request('PUT', this._url(id), {
        auth: 'required',
        body: pick(body)
      })
    );
  }

  /**
   * Change some of a record's fields and leave the rest as they are. Needs the same
   * write access as `update`, which the store enforces a patch as.
   */
  async patch(id: string, changes: ISpecPatch): Promise<ISpecRecord> {
    if (Object.keys(changes).length === 0) {
      // The store answers an empty patch with 400; there is nothing to send anyway.
      throw new SpecStoreError('invalid');
    }
    return this._record(
      await this._request('PATCH', this._url(id), {
        auth: 'required',
        body: changes
      })
    );
  }

  /**
   * Give a record a new name, without sending the notebook back with it.
   *
   * Falls back to reading the record and putting it back where the store has no PATCH
   * (production had none when this was written). That fallback races another writer's
   * change to the notebook, which is the whole reason to prefer a patch.
   */
  async rename(id: string, name: string): Promise<ISpecRecord> {
    try {
      return await this.patch(id, { name });
    } catch (error) {
      if (!(error instanceof SpecStoreError) || error.kind !== 'unsupported') {
        throw error;
      }
      const record = await this.get(id);
      return this.update(id, {
        name,
        description: record.description,
        spec: record.spec as ISpecBody['spec']
      });
    }
  }

  /** Delete a record (requires admin access to it). */
  async remove(id: string): Promise<void> {
    await this._request('DELETE', this._url(id), { auth: 'required' });
  }

  /** Grant a permission on a record (requires admin access to it). */
  async addPermission(id: string, grant: PermissionGrant): Promise<void> {
    await this._request('POST', `${this._url(id)}/permissions`, {
      auth: 'required',
      body: {
        type: grant.type,
        entity: grant.entity,
        permission: grant.permission
      }
    });
  }

  /**
   * Remove a permission (requires admin access). The server matches the exact grant and
   * answers 404 when there is no such permission.
   */
  async removePermission(id: string, grant: PermissionGrant): Promise<void> {
    await this._request('DELETE', `${this._url(id)}/permissions`, {
      auth: 'required',
      body: {
        type: grant.type,
        entity: grant.entity,
        permission: grant.permission
      }
    });
  }

  private _url(id: string): string {
    if (!isSpecId(id)) {
      throw new SpecStoreError('invalid');
    }
    return `${this._base}/${id}`;
  }

  private _record(data: unknown): ISpecRecord {
    if (!isRecord(data)) {
      throw new SpecStoreError('invalid');
    }
    return data;
  }

  private async _request(
    method: string,
    url: string,
    options: { auth: 'required' | 'optional'; body?: object }
  ): Promise<unknown> {
    const token = await this._getAccessToken();
    if (token === null && options.auth === 'required') {
      throw new SpecStoreError('signed-out');
    }
    const headers: Record<string, string> = {};
    if (token !== null) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this._fetch(url, init);
    } catch {
      throw new SpecStoreError('network');
    }
    if (!response.ok) {
      throw errorForStatus(response.status);
    }
    if (response.status === 204) {
      return null;
    }
    try {
      return await response.json();
    } catch {
      throw new SpecStoreError('invalid');
    }
  }

  private readonly _base: string;
  private readonly _getAccessToken: () => Promise<string | null>;
  private readonly _fetch: typeof fetch;
}

/** Only the fields the server accepts; in particular never send an `id`. */
function pick(body: ISpecBody): ISpecBody {
  return { name: body.name, description: body.description, spec: body.spec };
}

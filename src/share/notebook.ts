/**
 * Notebook records in the Oceanum spec store: the link a local notebook keeps to its
 * record, the body that is stored, and the names, paths and addresses around them.
 *
 * Ported from oceanum-notebook's share-oceanum package, which notebook.oceanum.io will
 * drop in favour of this one.
 */
import type { ICodeCell, INotebookContent } from '@jupyterlab/nbformat';

/** Notebook metadata key linking a local notebook to its spec store record. */
export const METADATA_KEY = 'oceanum';

/** Folder that notebooks opened from Oceanum.io are written to. */
export const OCEANUM_DIR = 'Oceanum';

/** Query parameter carrying a shared notebook id. */
export const QUERY_PARAM = 'oceanum-notebook';

/**
 * Largest request body we send. Cloud Run rejects requests over 32 MiB; keep a margin
 * for headers and the server's own encoding.
 */
export const MAX_BODY_BYTES = 30 * 1024 * 1024;

/** The `oceanum` notebook metadata value. */
export interface IOceanumLink {
  spec_id: string;
  /** Spec store the id belongs to, so a development id is never PUT to production. */
  specs_url: string;
  description?: string;
}

/** A spec store request body for `POST`/`PUT /specs/notebook`. */
export interface ISpecBody {
  name: string;
  description: string | null;
  spec: INotebookContent;
}

/**
 * The fields a `PATCH /specs/notebook/{id}` may change. A field left out keeps its
 * stored value, so a rename need not send the notebook back.
 *
 * The store refuses anything else outright rather than ignoring it, and refuses a patch
 * that carries no field at all, so never send an empty one. `spec` is replaced whole:
 * there is no way to change one key of a stored notebook.
 */
export interface ISpecPatch {
  name?: string;
  description?: string | null;
  spec?: INotebookContent;
}

/** A spec store list entry (the list omits `spec`). */
export interface ISpecSummary {
  id: string;
  name: string;
  description: string | null;
  /**
   * When the record was created, or last patched. A `PUT` does not touch it, so for a
   * record nothing has patched this is still a creation time.
   */
  modified: string;
  /** Null unless the caller created the record: the store hides other creators. */
  creator: string | null;
}

/** A full spec store record. */
export interface ISpecRecord extends ISpecSummary {
  spec: unknown;
}

export type BuildResult =
  | { ok: true; body: ISpecBody; bytes: number; strippedOutputs: boolean }
  | { ok: false; bytes: number };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a UUID, and so safe to put in a spec store URL. */
export function isSpecId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the link from an `oceanum` metadata value, or `null` if it is missing, malformed,
 * or belongs to a different spec store.
 */
export function readLink(
  value: unknown,
  specsUrl: string
): IOceanumLink | null {
  if (
    !isObject(value) ||
    !isSpecId(value.spec_id) ||
    value.specs_url !== specsUrl
  ) {
    return null;
  }
  const link: IOceanumLink = { spec_id: value.spec_id, specs_url: specsUrl };
  if (typeof value.description === 'string') {
    link.description = value.description;
  }
  return link;
}

/** The notebook name stored on Oceanum.io for a local path. */
export function nameFromPath(path: string): string {
  const base = path.split('/').pop() ?? '';
  return base.replace(/\.ipynb$/i, '') || 'Untitled';
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function withoutLink(content: INotebookContent): INotebookContent {
  const metadata = { ...content.metadata };
  delete metadata[METADATA_KEY];
  return { ...content, metadata };
}

/**
 * The notebook with every cell's `trusted` metadata removed.
 *
 * JupyterLab trusts a cell whose metadata says `trusted: true` and then renders its HTML
 * and Markdown unsanitised, running any script in them. A notebook from the spec store
 * (anyone with write access can edit a record) must arrive untrusted; its outputs
 * become trusted again when the reader re-runs the cells.
 */
export function withoutTrust(content: INotebookContent): INotebookContent {
  const cells = content.cells.map(cell => {
    if (!isObject(cell.metadata) || !('trusted' in cell.metadata)) {
      return cell;
    }
    const metadata = { ...cell.metadata };
    delete metadata.trusted;
    return { ...cell, metadata };
  });
  return { ...content, cells };
}

function withoutOutputs(content: INotebookContent): INotebookContent {
  const cells = content.cells.map(cell =>
    cell.cell_type === 'code'
      ? ({ ...cell, outputs: [], execution_count: null } as ICodeCell)
      : cell
  );
  return { ...content, cells };
}

/**
 * Build the spec store body for a notebook. The `oceanum` link is not stored in the
 * record. If the body is over `maxBytes`, code-cell outputs and execution counts are
 * dropped; if it is still too large, the result is not ok.
 */
export function buildSpecBody(
  content: INotebookContent,
  path: string,
  specsUrl: string,
  maxBytes: number = MAX_BODY_BYTES
): BuildResult {
  const link = readLink(content.metadata?.[METADATA_KEY], specsUrl);
  const make = (spec: INotebookContent): ISpecBody => ({
    name: nameFromPath(path),
    description: link?.description ?? null,
    spec
  });

  const full = make(withoutTrust(withoutLink(content)));
  const fullBytes = byteLength(JSON.stringify(full));
  if (fullBytes <= maxBytes) {
    return { ok: true, body: full, bytes: fullBytes, strippedOutputs: false };
  }
  const stripped = make(withoutOutputs(full.spec));
  const strippedBytes = byteLength(JSON.stringify(stripped));
  if (strippedBytes <= maxBytes) {
    return {
      ok: true,
      body: stripped,
      bytes: strippedBytes,
      strippedOutputs: true
    };
  }
  return { ok: false, bytes: strippedBytes };
}

/**
 * The notebook stored in a record, untrusted. Throws if the record does not hold an
 * nbformat 4 notebook.
 */
function recordNotebook(record: ISpecRecord): INotebookContent {
  const spec = record.spec;
  if (!isNotebook(spec)) {
    throw new Error('This Oceanum.io record is not a valid notebook.');
  }
  return withoutTrust(spec);
}

function isNotebook(value: unknown): value is INotebookContent {
  return (
    isObject(value) &&
    value.nbformat === 4 &&
    Array.isArray(value.cells) &&
    isObject(value.metadata)
  );
}

/**
 * A notebook uploaded from the user's computer, untrusted and linked to nothing: a file
 * someone else downloaded from a record must not save over that record, and its outputs
 * must not run scripts on the origin that holds the Oceanum.io session. Throws if the
 * text is not an nbformat 4 notebook; the message never quotes the file.
 */
export function notebookFromUpload(text: string): INotebookContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The file is not a Jupyter notebook: it is not JSON.');
  }
  if (!isNotebook(parsed)) {
    throw new Error('The file is not a Jupyter notebook in nbformat 4.');
  }
  return withoutLink(withoutTrust(parsed));
}

/**
 * The notebook stored in a record, with its `oceanum` link set. Throws if the record
 * does not hold an nbformat 4 notebook.
 */
export function notebookFromRecord(
  record: ISpecRecord,
  specsUrl: string
): INotebookContent {
  const link: IOceanumLink = { spec_id: record.id, specs_url: specsUrl };
  if (record.description) {
    link.description = record.description;
  }
  const content = recordNotebook(record);
  return {
    ...content,
    metadata: { ...content.metadata, [METADATA_KEY]: { ...link } }
  };
}

/**
 * A copy of the notebook stored in a record, linked to nothing: untrusted, and without
 * any `oceanum` link, so saving it creates a record of the user's own instead of
 * writing to this one. Throws if the record does not hold an nbformat 4 notebook.
 */
export function unlinkedNotebookFromRecord(
  record: ISpecRecord
): INotebookContent {
  return withoutLink(recordNotebook(record));
}

/** Make a record name safe to use as a single path segment. */
export function sanitizeName(name: string): string {
  const clean = name
    .trim()
    .replace(/\.ipynb$/i, '')
    .replace(/[/\\]/g, '-')
    .trim();
  return clean === '' || clean === '.' || clean === '..' ? 'Untitled' : clean;
}

/**
 * A path `Oceanum/<name>.ipynb` that does not collide with `existing` (file names in the
 * `Oceanum` folder), appending ` (1)`, ` (2)`, ... as needed.
 */
export function uniqueNotebookPath(
  name: string,
  existing: Iterable<string>
): string {
  const taken = new Set(existing);
  const base = sanitizeName(name);
  let candidate = `${base}.ipynb`;
  for (let i = 1; taken.has(candidate); i++) {
    candidate = `${base} (${i}).ipynb`;
  }
  return `${OCEANUM_DIR}/${candidate}`;
}

/**
 * The names in `existing` that `uniqueNotebookPath` could have given a record called
 * `name`, in the order it would have tried them: `<base>.ipynb`, then `<base> (1).ipynb`,
 * `<base> (2).ipynb` and so on.
 *
 * Opening a record looks through these for the copy a previous session left, so the same
 * record keeps one local file. Without that the second copy is named `<base> (1)`, and
 * since a record takes its name from the file on every save, opening a notebook twice
 * would quietly rename it on Oceanum.
 */
export function notebookNamesFor(
  name: string,
  existing: Iterable<string>
): string[] {
  const base = sanitizeName(name);
  const prefix = `${base} (`;
  const suffix = ').ipynb';
  const plain: string[] = [];
  const numbered: { name: string; index: number }[] = [];
  for (const candidate of existing) {
    if (candidate === `${base}.ipynb`) {
      plain.push(candidate);
      continue;
    }
    if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) {
      continue;
    }
    const index = candidate.slice(
      prefix.length,
      candidate.length - suffix.length
    );
    if (/^\d+$/.test(index)) {
      numbered.push({ name: candidate, index: Number(index) });
    }
  }
  numbered.sort((a, b) => a.index - b.index);
  return [...plain, ...numbered.map(entry => entry.name)];
}

/**
 * Split a listing into the caller's own notebooks and the rest, newest first.
 *
 * The store only sends `creator` on records the caller created, so anything else it
 * returns is shared with them — directly, or because it is public. Addresses are
 * compared case-insensitively: the store matches entities as case-sensitive globs, so
 * the two sides can differ in case.
 */
export function partitionSummaries(
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

/** The `kind` of a Notebook Demo record's spec. */
export const NOTEBOOK_DEMO_KIND = 'notebook-demo';

/** One example in a Notebook Demo record: a notebook record and how to list it. */
export interface INotebookDemoItem {
  id: string;
  title: string;
  summary?: string;
}

/** A titled group of examples. */
export interface INotebookDemoSection {
  title: string;
  items: INotebookDemoItem[];
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The sections of a Notebook Demo record's spec, keeping only what can be listed: items
 * with a record id and a title, in sections with a title and at least one such item.
 * A spec of another kind or version gives no sections, with a warning.
 */
export function parseNotebookDemo(spec: unknown): INotebookDemoSection[] {
  if (
    !isObject(spec) ||
    spec.kind !== NOTEBOOK_DEMO_KIND ||
    spec.version !== 1 ||
    !Array.isArray(spec.sections)
  ) {
    console.warn(
      'Oceanum: ignoring a Notebook Demo record this version cannot read.'
    );
    return [];
  }
  const sections: INotebookDemoSection[] = [];
  for (const section of spec.sections) {
    if (
      !isObject(section) ||
      !nonBlank(section.title) ||
      !Array.isArray(section.items)
    ) {
      continue;
    }
    const items: INotebookDemoItem[] = [];
    for (const item of section.items) {
      if (!isObject(item) || !isSpecId(item.id) || !nonBlank(item.title)) {
        continue;
      }
      items.push(
        typeof item.summary === 'string'
          ? { id: item.id, title: item.title, summary: item.summary }
          : { id: item.id, title: item.title }
      );
    }
    if (items.length > 0) {
      sections.push({ title: section.title, items });
    }
  }
  return sections;
}

/** Parse a spec store timestamp, which is UTC but usually has no zone designator. */
export function parseTimestamp(value: string): Date | null {
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const date = new Date(zoned);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Whether `email` can be granted access. Glob characters are refused: the server
 * matches user entities as globs.
 */
export function isShareableEmail(email: string): boolean {
  return /^[^\s@*?[\]]+@[^\s@*?[\]]+\.[^\s@*?[\]]+$/.test(email);
}

/** Addresses typed into the share dialog, split into the ones we can grant and the rest. */
export interface IParsedShareEmails {
  /** Valid, lower-cased and de-duplicated, in the order first written. */
  emails: string[];
  /** Everything that is not a shareable address, as written, for reporting back. */
  invalid: string[];
}

/**
 * Split what the user typed into individual addresses. Commas, semicolons and any
 * whitespace all separate, so one-per-line and a comma-separated list both work.
 *
 * Bare addresses only: a mail client's "To:" line carries display names, and
 * `"Alice B" <alice@example.com>` splits into tokens that are not addresses. Those
 * come back in `invalid` so the user is told, rather than being silently dropped.
 *
 * Addresses are lower-cased because the spec store matches the user entity as a
 * case-sensitive glob against the Auth0 email claim, which Auth0 stores lower case.
 */
export function parseShareEmails(raw: string): IParsedShareEmails {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const entry = part.trim();
    if (entry === '') {
      continue;
    }
    const email = entry.toLowerCase();
    if (!isShareableEmail(email)) {
      // Report it as written, so the user recognises what they typed.
      invalid.push(entry);
      continue;
    }
    if (!seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }
  return { emails, invalid };
}

/**
 * How to report share failures.
 *
 * `original` means hand the underlying error to the reporter untouched — it holds the
 * only explanation the user gets, and the reporter reads its type to decide whether to
 * offer sign-in. `partial` is only for the case the original error cannot describe on
 * its own: some addresses worked and some did not, so the message has to name them.
 */
export type ShareReport =
  { kind: 'original' } | { kind: 'partial'; named: string[] };

/**
 * Decide how to report a set of failed grants.
 *
 * `entities` are the failed grants' entities, in order; the public grant's entity is
 * the empty string, which names nobody.
 */
export function reportForShareFailures(
  grantCount: number,
  entities: readonly string[],
  needsSignIn: boolean
): ShareReport {
  const named = entities.filter(entity => entity !== '');
  // A sign-in problem must reach the reporter as the original error or the user is
  // never offered a way back in; an unnamed or total failure has nothing extra worth
  // saying.
  if (needsSignIn || named.length === 0 || entities.length >= grantCount) {
    return { kind: 'original' };
  }
  return { kind: 'partial', named };
}

/**
 * The link that opens a shared notebook in this deployment.
 *
 * JupyterLite is static files, so its page is `lab/index.html`; a JupyterLab server
 * serves the application at `lab` and has no `index.html` to route.
 */
export function shareLink(
  baseUrl: string,
  pageHref: string,
  id: string
): string {
  const app = new URL(pageHref).pathname.endsWith('/index.html')
    ? 'lab/index.html'
    : 'lab';
  const url = new URL(app, new URL(baseUrl, pageHref));
  url.searchParams.set(QUERY_PARAM, id);
  return url.toString();
}

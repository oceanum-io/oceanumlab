/**
 * Notebooks generated from a Datamesh UI workspace or query.
 *
 * The Datamesh UI's "Open in notebook" button opens this app with the workspace in the
 * address fragment, `#oceanum-datamesh=<base64url JSON>`. The fragment is never sent
 * to a server, so the queries stay out of request logs and are not bound by URL
 * length limits on the way in.
 *
 * Anyone can craft such a link, so the payload is treated as data only: it is
 * validated, every value reaches the notebook as a Python literal, and the notebook is
 * built from fixed templates, opened untrusted and never run automatically.
 */
import type { ICell, INotebookContent } from '@jupyterlab/nbformat';

/** Fragment key carrying a Datamesh workspace. */
export const FRAGMENT_KEY = 'oceanum-datamesh';

/** Payload version this module reads. */
export const PAYLOAD_VERSION = 1;

/** Most queries one link may carry. */
export const MAX_ITEMS = 100;

/** Longest encoded payload accepted (characters of base64url). */
export const MAX_ENCODED_LENGTH = 4 * 1024 * 1024;

/** The fields of oceanum-python's `Query`. Anything else would make it warn. */
const QUERY_FIELDS = [
  'datasource',
  'parameters',
  'description',
  'variables',
  'timefilter',
  'geofilter',
  'levelfilter',
  'coordfilter',
  'crs',
  'aggregate',
  'functions',
  'limit'
] as const;

/** Fields that make a query select something rather than the whole datasource. */
const FILTER_FIELDS = QUERY_FIELDS.filter(
  f => f !== 'datasource' && f !== 'description'
);

/** One query: an OceanQL spec plus the Datamesh UI's own `label`. */
export interface IDatameshQuery {
  datasource: string;
  label?: string;
  description?: string;
  [key: string]: unknown;
}

/** What the fragment carries. */
export interface IDatameshNotebookRequest {
  v: typeof PAYLOAD_VERSION;
  /** Workspace name, used for the notebook name and heading. */
  name?: string;
  items: IDatameshQuery[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UTF-8 JSON to base64url, without padding. */
export function encodePayload(request: IDatameshNotebookRequest): string {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Read and validate a payload. Throws an `Error` whose message can be shown to the
 * user; it never quotes the payload.
 */
export function decodePayload(encoded: string): IDatameshNotebookRequest {
  if (encoded.length > MAX_ENCODED_LENGTH) {
    throw new Error('The Datamesh link is too large to open.');
  }
  let parsed: unknown;
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
  } catch {
    throw new Error('The Datamesh link is not valid.');
  }
  if (!isObject(parsed) || parsed.v !== PAYLOAD_VERSION) {
    throw new Error(
      'The Datamesh link is not valid, or comes from a newer Datamesh UI.'
    );
  }
  const { name, items } = parsed;
  if (name !== undefined && typeof name !== 'string') {
    throw new Error('The Datamesh link is not valid.');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('The Datamesh link holds no queries.');
  }
  if (items.length > MAX_ITEMS) {
    throw new Error(
      `The Datamesh link holds more than ${MAX_ITEMS} queries, which is too many to open.`
    );
  }
  for (const item of items) {
    if (
      !isObject(item) ||
      typeof item.datasource !== 'string' ||
      item.datasource.trim() === '' ||
      (item.label !== undefined && typeof item.label !== 'string') ||
      (item.description !== undefined && typeof item.description !== 'string')
    ) {
      throw new Error('The Datamesh link holds a query that is not valid.');
    }
  }
  return {
    v: PAYLOAD_VERSION,
    ...(typeof name === 'string' ? { name } : {}),
    items: items as IDatameshQuery[]
  };
}

/**
 * The payload in a location hash (`#oceanum-datamesh=...`), or null when the hash
 * carries none. Other keys in the hash are ignored.
 */
export function payloadFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return params.get(FRAGMENT_KEY);
}

/** The hash with the payload removed (`''` when nothing else is left). */
export function hashWithoutPayload(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.delete(FRAGMENT_KEY);
  const rest = params.toString();
  return rest ? `#${rest}` : '';
}

const INLINE_WIDTH = 72;

/**
 * A Python literal for a JSON value. Strings use JSON's escaping, which is also valid
 * Python, so no value can end the literal early.
 */
export function pyLiteral(value: unknown, indent = 0): string {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number') {
    // Parsed JSON has no NaN or Infinity; guard anyway rather than emit bad code.
    return Number.isFinite(value) ? JSON.stringify(value) : 'None';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  const pad = ' '.repeat(indent + 4);
  const end = ' '.repeat(indent);
  if (Array.isArray(value)) {
    const inline = `[${value.map(v => pyLiteral(v)).join(', ')}]`;
    if (inline.length + indent <= INLINE_WIDTH || value.length === 0) {
      return inline;
    }
    const lines = value.map(v => pad + pyLiteral(v, indent + 4));
    return `[\n${lines.join(',\n')},\n${end}]`;
  }
  if (isObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    const inline = `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}: ${pyLiteral(v)}`)
      .join(', ')}}`;
    if (inline.length + indent <= INLINE_WIDTH || entries.length === 0) {
      return inline;
    }
    const lines = entries.map(
      ([k, v]) => `${pad}${JSON.stringify(k)}: ${pyLiteral(v, indent + 4)}`
    );
    return `{\n${lines.join(',\n')},\n${end}}`;
  }
  return 'None';
}

const PY_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  // Names the generated code itself uses.
  'datamesh',
  'Connector'
]);

/** A Python identifier for `text`, not in `taken`; adds it to `taken`. */
export function pyIdentifier(text: string, taken: Set<string>): string {
  let base = text
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (base === '') {
    base = 'data';
  }
  if (/^[0-9]/.test(base)) {
    base = `ds_${base}`;
  }
  if (PY_KEYWORDS.has(base)) {
    base = `${base}_`;
  }
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    name = `${base}_${i}`;
  }
  taken.add(name);
  return name;
}

/** CR, LF and the Unicode line and paragraph separators (U+2028, U+2029). */
const LINE_BREAKS = new RegExp(
  `[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]+`,
  'g'
);

/** One line of text safe to put after a `#` comment marker. */
function commentText(text: string): string {
  return text.replace(LINE_BREAKS, ' ').trim();
}

/** Text safe to put in a Markdown heading: no HTML, no Markdown syntax. */
function markdownText(text: string): string {
  return commentText(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+\-.!|~])/g, '\\$1');
}

/** The OceanQL query to send: only fields oceanum-python's `Query` accepts. */
export function queryFields(item: IDatameshQuery): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const field of QUERY_FIELDS) {
    if (item[field] !== undefined && item[field] !== null) {
      query[field] = item[field];
    }
  }
  return query;
}

/** Whether a query selects part of its datasource (else it loads the whole one). */
function isFiltered(query: Record<string, unknown>): boolean {
  return FILTER_FIELDS.some(f => {
    const v = query[f];
    return !(Array.isArray(v) && v.length === 0) && v !== undefined;
  });
}

/** The code cell that loads one query into a variable and shows it. */
export function queryCellSource(
  item: IDatameshQuery,
  variable: string
): string {
  const query = queryFields(item);
  const lines: string[] = [];
  const title = commentText(item.description ?? item.label ?? '');
  if (title) {
    lines.push(`# ${title}`);
  }
  if (isFiltered(query)) {
    lines.push(`${variable} = datamesh.query(${pyLiteral(query)})`);
  } else {
    // No filter: open the datasource lazily rather than download all of it.
    lines.push(
      `${variable} = datamesh.load_datasource(${pyLiteral(item.datasource)})`
    );
  }
  lines.push(variable);
  return lines.join('\n');
}

function codeCell(source: string): ICell {
  return {
    cell_type: 'code',
    execution_count: null,
    metadata: {},
    outputs: [],
    source
  };
}

/** The notebook name for a request: the workspace name, or the single query's. */
export function notebookName(request: IDatameshNotebookRequest): string {
  const only = request.items.length === 1 ? request.items[0] : null;
  const name =
    request.name?.trim() ||
    only?.label?.trim() ||
    only?.datasource.trim() ||
    'Datamesh workspace';
  return commentText(name);
}

/**
 * A new notebook that loads every query in `request`. It carries no `oceanum` link and
 * no trust, so saving it creates a record of the user's own.
 */
export function notebookFromDatamesh(
  request: IDatameshNotebookRequest
): INotebookContent {
  const taken = new Set<string>();
  const cells: ICell[] = [
    {
      cell_type: 'markdown',
      metadata: {},
      source:
        `# ${markdownText(notebookName(request))}\n\n` +
        'Opened from the Oceanum Datamesh UI. Run the cells to load the data.'
    },
    codeCell(
      'from oceanum.datamesh import Connector\n\ndatamesh = Connector()'
    ),
    ...request.items.map(item =>
      codeCell(
        queryCellSource(
          item,
          pyIdentifier(item.label || item.datasource, taken)
        )
      )
    )
  ];
  return {
    nbformat: 4,
    nbformat_minor: 5,
    // No kernelspec: the kernel is `python` in JupyterLite and `python3` in
    // JupyterLab, and the language alone lets either pick its Python kernel.
    metadata: { language_info: { name: 'python' } },
    cells
  };
}

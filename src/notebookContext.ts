import type { Notebook } from '@jupyterlab/notebook';

/**
 * A notebook cell reduced to what the chat context needs.
 */
export interface IContextCell {
  kind: 'code' | 'markdown';
  source: string;
}

/** What a request carries from the conversation's notebook. */
export interface INotebookSnapshot {
  cells: IContextCell[];
  /** The selected cell, which a code answer may replace. None when closed. */
  selected: { source: string; isCode: boolean } | null;
}

// Mirrors oceanum-ai's app/config.py. Past either limit the server rejects the
// whole request, so the chat fails outright rather than losing some context.
export const MAX_NOTEBOOK_CELLS = 500;
export const MAX_CELL_CHARS = 100000;

// The server also caps the WHOLE request body at 2 MiB (MAX_REQUEST_BYTES),
// and that body carries chat history and, on follow-up rounds, run outputs as
// well as the cells. Markdown may take the cells up to half of it.
export const MAX_CELLS_BYTES = 1024 * 1024;

// An inline image: the one thing in markdown that is routinely huge. Any media
// type, any `;param` or `;param=value` (charset, base64, utf8), then the data
// up to the first space, bracket or quote.
const DATA_URI =
  /data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+(?:=[\w.+-]+)?)*,[^\s)"']+/g;

/** An open notebook's code and markdown cells, and its selected cell. */
export function snapshotOf(notebook: Notebook): INotebookSnapshot {
  const cells: IContextCell[] = [];
  for (const cell of notebook.widgets) {
    const type = cell.model.type;
    if (type === 'code' || type === 'markdown') {
      cells.push({ kind: type, source: cell.model.sharedModel.getSource() });
    }
  }
  const active = notebook.activeCell;
  return {
    cells,
    selected: active
      ? {
          source: active.model.sharedModel.getSource(),
          isCode: active.model.type === 'code'
        }
      : null
  };
}

/**
 * A closed notebook's cells, read from its file.
 *
 * Read rather than opened again: re-opening the tab is for an answer with
 * cells to place, not for asking a question. A closed notebook has no
 * selected cell. Anything unexpected in the file reads as no cells rather
 * than an error -- context is best-effort.
 */
export function snapshotFromIpynb(content: unknown): INotebookSnapshot {
  const raw = (content as { cells?: unknown } | null)?.cells;
  const cells: IContextCell[] = [];
  if (Array.isArray(raw)) {
    for (const cell of raw) {
      const { cell_type: type, source } = (cell ?? {}) as {
        cell_type?: unknown;
        source?: unknown;
      };
      if (type !== 'code' && type !== 'markdown') {
        continue;
      }
      // nbformat allows the source as one string or as a list of lines.
      const text = Array.isArray(source)
        ? source.join('')
        : typeof source === 'string'
          ? source
          : '';
      cells.push({ kind: type, source: text });
    }
  }
  return { cells, selected: null };
}

/**
 * The notebook as `notebookCells`: every non-empty code and markdown cell, in
 * order.
 *
 * The server renders all of them inside ONE ```python block, each headed
 * `# Cell N`, so markdown sent raw would read there as broken code. It goes as
 * comment lines under a jupytext-style `# %% [markdown]` marker instead: still
 * valid Python, and unambiguous to the model.
 *
 * Markdown is also what can push a request past the server's limits, and those
 * reject the whole request -- costing the user the chat for the sake of some
 * prose. So markdown gives way first: inline images are dropped from it, an
 * oversized markdown cell is left out, and when the markdown would take the
 * cells past the server's cell count or past MAX_CELLS_BYTES, only the code is
 * sent -- which is what was sent before markdown was included.
 */
export function formatNotebookCells(cells: readonly IContextCell[]): string[] {
  const code: string[] = [];
  const all: string[] = [];
  for (const cell of cells) {
    if (!cell.source.trim()) {
      continue;
    }
    if (cell.kind === 'code') {
      code.push(cell.source);
      all.push(cell.source);
      continue;
    }
    const markdown = asMarkdownComment(cell.source);
    if (markdown.length <= MAX_CELL_CHARS) {
      all.push(markdown);
    }
  }
  if (all.length > MAX_NOTEBOOK_CELLS || totalBytes(all) > MAX_CELLS_BYTES) {
    return code;
  }
  return all;
}

function asMarkdownComment(source: string): string {
  const lines = source
    .replace(DATA_URI, 'data:…')
    .split(/\r?\n/)
    .map(line => (line ? `# ${line}` : '#'));
  return ['# %% [markdown]', ...lines].join('\n');
}

/** UTF-8 size, which is what the server's byte limit counts. */
function totalBytes(texts: readonly string[]): number {
  let bytes = 0;
  for (const text of texts) {
    for (const char of text) {
      const point = char.codePointAt(0) ?? 0;
      bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    }
  }
  return bytes;
}

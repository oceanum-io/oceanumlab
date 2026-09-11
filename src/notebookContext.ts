/**
 * A notebook cell reduced to what the chat context needs.
 */
export interface IContextCell {
  kind: 'code' | 'markdown';
  source: string;
}

// Mirrors oceanum-ai's app/config.py. Past either limit the server rejects the
// whole request, so the chat fails outright rather than losing some context.
export const MAX_NOTEBOOK_CELLS = 500;
export const MAX_CELL_CHARS = 100000;

// An inline image: the one thing in markdown that is routinely huge.
const DATA_URI = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g;

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
 * oversized markdown cell is left out, and a notebook with more cells than the
 * server accepts falls back to code only, which is exactly what was sent
 * before markdown was included.
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
  return all.length > MAX_NOTEBOOK_CELLS ? code : all;
}

function asMarkdownComment(source: string): string {
  const lines = source
    .replace(DATA_URI, 'data:…')
    .split(/\r?\n/)
    .map(line => (line ? `# ${line}` : '#'));
  return ['# %% [markdown]', ...lines].join('\n');
}

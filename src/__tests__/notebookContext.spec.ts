import {
  formatNotebookCells,
  IContextCell,
  MAX_CELL_CHARS,
  MAX_CELLS_BYTES,
  MAX_NOTEBOOK_CELLS
} from '../notebookContext';

const code = (source: string): IContextCell => ({ kind: 'code', source });
const md = (source: string): IContextCell => ({ kind: 'markdown', source });

describe('formatNotebookCells', () => {
  it('keeps code verbatim and markdown as comments, in notebook order', () => {
    // The server wraps every cell in one ```python block, so markdown must
    // arrive as something that reads as Python there.
    expect(
      formatNotebookCells([
        code('import xarray as xr'),
        md('## Results\n\nWave height is *high*.'),
        code('ds.plot()')
      ])
    ).toEqual([
      'import xarray as xr',
      '# %% [markdown]\n# ## Results\n#\n# Wave height is *high*.',
      'ds.plot()'
    ]);
  });

  it('skips empty and whitespace-only cells of either kind', () => {
    expect(formatNotebookCells([code('  \n'), md(''), code('x = 1')])).toEqual([
      'x = 1'
    ]);
  });

  it('reads CRLF markdown line by line', () => {
    expect(formatNotebookCells([md('a\r\nb')])).toEqual([
      '# %% [markdown]\n# a\n# b'
    ]);
  });

  it('drops inline image data from markdown but keeps the reference', () => {
    const image = `![plot](data:image/png;base64,${'A'.repeat(5000)}=)`;
    expect(formatNotebookCells([md(`See ${image} above.`)])).toEqual([
      '# %% [markdown]\n# See ![plot](data:…) above.'
    ]);
  });

  it('drops inline images whatever parameters they carry', () => {
    const charset = `![a](data:image/png;charset=utf-8;base64,${'B'.repeat(300)})`;
    const svg = `<img src="data:image/svg+xml;utf8,%3Csvg%20${'C'.repeat(300)}%3E">`;
    expect(formatNotebookCells([md(`${charset} and ${svg}`)])).toEqual([
      '# %% [markdown]\n# ![a](data:…) and <img src="data:…">'
    ]);
  });

  it('leaves out a markdown cell the server would reject, keeping the rest', () => {
    // One oversized cell fails the WHOLE request server-side.
    const huge = md('x'.repeat(MAX_CELL_CHARS + 1));
    expect(formatNotebookCells([code('a = 1'), huge, md('ok')])).toEqual([
      'a = 1',
      '# %% [markdown]\n# ok'
    ]);
  });

  it('falls back to code only when markdown would exceed the cell limit', () => {
    const cells = Array.from({ length: MAX_NOTEBOOK_CELLS }, (_, i) =>
      i % 2 === 0 ? code(`c${i}`) : md(`m${i}`)
    );
    cells.push(md('one too many'));
    const sent = formatNotebookCells(cells);
    expect(sent).toHaveLength(MAX_NOTEBOOK_CELLS / 2);
    expect(sent.every(s => !s.startsWith('# %% [markdown]'))).toBe(true);
  });

  it('falls back to code only when markdown would exceed the byte budget', () => {
    // The server caps the whole request at 2 MiB, history and run outputs
    // included. A notebook whose code fits must not be pushed over by prose.
    const codeCells = Array.from({ length: 10 }, (_, i) =>
      code(`x${i} = "${'a'.repeat(60000)}"`)
    );
    const prose = Array.from({ length: 10 }, () => md('b'.repeat(60000)));
    const sent = formatNotebookCells([...codeCells, ...prose]);
    expect(sent).toHaveLength(10);
    expect(sent.every(s => !s.startsWith('# %% [markdown]'))).toBe(true);
  });

  it('counts the budget in UTF-8 bytes, not characters', () => {
    // 'é' is 2 bytes: in characters these cells are just under the budget, in
    // bytes well over it.
    const half = Math.floor(MAX_CELLS_BYTES / 2) - 100;
    const sent = formatNotebookCells([
      code('é'.repeat(half)),
      md('b'.repeat(half))
    ]);
    expect(sent).toHaveLength(1);
  });
});

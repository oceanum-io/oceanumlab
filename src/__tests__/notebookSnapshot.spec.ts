import type { Notebook } from '@jupyterlab/notebook';
import { snapshotFromIpynb, snapshotOf } from '../notebookContext';

const cell = (type: string, source: string) => ({
  model: { type, sharedModel: { getSource: () => source } }
});

describe('snapshotOf: an open notebook', () => {
  it('reads its code and markdown cells in order, and its selected cell', () => {
    const selected = cell('code', 'df.head()');
    const notebook = {
      widgets: [
        cell('code', 'x = 1'),
        cell('raw', 'not context'),
        cell('markdown', '## Notes'),
        selected
      ],
      activeCell: selected
    } as unknown as Notebook;

    expect(snapshotOf(notebook)).toEqual({
      cells: [
        { kind: 'code', source: 'x = 1' },
        { kind: 'markdown', source: '## Notes' },
        { kind: 'code', source: 'df.head()' }
      ],
      selected: { source: 'df.head()', isCode: true }
    });
  });
});

describe('snapshotFromIpynb: a closed notebook, read from its file', () => {
  it('reads code and markdown cells in order, from either form of source', () => {
    // nbformat allows a cell's source as one string or as a list of lines.
    const snapshot = snapshotFromIpynb({
      cells: [
        { cell_type: 'code', source: ['x = 1\n', 'y = 2'] },
        { cell_type: 'raw', source: 'not context' },
        { cell_type: 'markdown', source: '## Notes' }
      ]
    });

    expect(snapshot).toEqual({
      cells: [
        { kind: 'code', source: 'x = 1\ny = 2' },
        { kind: 'markdown', source: '## Notes' }
      ],
      selected: null
    });
  });

  it('reads anything unexpected as no cells rather than failing', () => {
    // Context is best-effort: a file that is not quite a notebook must not
    // cost the user the answer.
    for (const content of [null, 'text', {}, { cells: 'no' }]) {
      expect(snapshotFromIpynb(content)).toEqual({ cells: [], selected: null });
    }
    expect(
      snapshotFromIpynb({ cells: [null, { cell_type: 'code' }] }).cells
    ).toEqual([{ kind: 'code', source: '' }]);
  });
});

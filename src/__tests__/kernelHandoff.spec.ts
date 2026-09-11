import { CodeCell } from '@jupyterlab/cells';
import type { NotebookPanel } from '@jupyterlab/notebook';
import { NotebookActions } from '@jupyterlab/notebook';
import { KernelHandoff } from '../kernelHandoff';

// The real modules pull in ES-module UI code that jest cannot load. Stand-ins
// with just what placing a code block without running it touches.
jest.mock('@jupyterlab/notebook', () => ({
  NotebookActions: { insertBelow: jest.fn(), changeCellType: jest.fn() },
  NotebookPanel: class NotebookPanel {}
}));
jest.mock('@jupyterlab/cells', () => ({ CodeCell: class CodeCell {} }));

/** A code cell holding `source`; `text()` reads what it holds now. */
function codeCell(source: string): { cell: CodeCell; text: () => string } {
  let text = source;
  const cell = Object.create(CodeCell.prototype) as CodeCell;
  Object.defineProperty(cell, 'isDisposed', { value: false });
  Object.defineProperty(cell, 'model', {
    value: {
      sharedModel: {
        setSource: (value: string) => {
          text = value;
        }
      }
    }
  });
  return { cell, text: () => text };
}

/** A notebook panel with `selected` selected; inserting selects `inserted`. */
function panelWith(selected: CodeCell, inserted: CodeCell): NotebookPanel {
  const content = { activeCell: selected };
  (NotebookActions.insertBelow as jest.Mock).mockImplementation(() => {
    content.activeCell = inserted;
  });
  return { content, sessionContext: {} } as unknown as NotebookPanel;
}

const answer = {
  message: 'Fixed.',
  blocks: [{ type: 'code' as const, content: 'x = 2' }]
};

describe('KernelHandoff: which notebook it touches', () => {
  it('leaves the tabs alone when an answer has nothing to place', async () => {
    // The conversation's notebook is re-opened for an answer with cells to
    // place, not for one that is only words.
    const target = jest.fn(async (): Promise<null> => null);
    const handoff = new KernelHandoff(target, () => null);

    const placed = await handoff.inject({ message: 'Just words.', blocks: [] });

    expect(target).not.toHaveBeenCalled();
    expect(placed.message).toBe('Just words.');
  });

  it('asks for the conversation notebook once when there are cells to place', async () => {
    const target = jest.fn(async (): Promise<null> => null);
    const handoff = new KernelHandoff(target, () => null);

    const placed = await handoff.inject({
      message: 'Here.',
      blocks: [{ type: 'code', content: 'x = 1' }]
    });

    expect(target).toHaveBeenCalledTimes(1);
    expect(placed.message).toContain('(Could not open a notebook)');
    expect(placed.runs).toEqual([]);
  });
});

describe('KernelHandoff: replacing the selected cell', () => {
  it('replaces it in the notebook the request read it from', async () => {
    const selected = codeCell('x = 1');
    const inserted = codeCell('');
    const panel = panelWith(selected.cell, inserted.cell);
    const handoff = new KernelHandoff(
      async () => panel,
      () => panel
    );

    await handoff.inject(answer, { replaceCodeCell: true });

    expect(selected.text()).toBe('x = 2');
    expect(inserted.text()).toBe('');
  });

  it('never replaces a cell in a notebook opened again since', async () => {
    // Closed while the answer was on its way and opened again: its selected
    // cell is not the one the user chose, but some other work of theirs.
    const selected = codeCell('users_latest_work()');
    const inserted = codeCell('');
    const reopened = panelWith(selected.cell, inserted.cell);
    const readFrom = {} as NotebookPanel;
    const handoff = new KernelHandoff(
      async () => reopened,
      () => readFrom
    );

    await handoff.inject(answer, { replaceCodeCell: true });

    expect(selected.text()).toBe('users_latest_work()');
    expect(inserted.text()).toBe('x = 2');
  });
});

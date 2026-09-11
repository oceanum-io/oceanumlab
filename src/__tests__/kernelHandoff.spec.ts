import { KernelHandoff } from '../kernelHandoff';

// The real modules pull in ES-module UI code that jest cannot load. Neither
// test gets as far as placing a cell, so empty stand-ins are enough.
jest.mock('@jupyterlab/notebook', () => ({
  NotebookActions: {},
  NotebookPanel: class NotebookPanel {}
}));
jest.mock('@jupyterlab/cells', () => ({ CodeCell: class CodeCell {} }));

describe('KernelHandoff: which notebook it touches', () => {
  it('leaves the tabs alone when an answer has nothing to place', async () => {
    // The conversation's notebook is re-opened for an answer with cells to
    // place, not for one that is only words.
    const target = jest.fn(async (): Promise<null> => null);
    const handoff = new KernelHandoff(target);

    const placed = await handoff.inject({ message: 'Just words.', blocks: [] });

    expect(target).not.toHaveBeenCalled();
    expect(placed.message).toBe('Just words.');
  });

  it('asks for the conversation notebook once when there are cells to place', async () => {
    const target = jest.fn(async (): Promise<null> => null);
    const handoff = new KernelHandoff(target);

    const placed = await handoff.inject({
      message: 'Here.',
      blocks: [{ type: 'code', content: 'x = 1' }]
    });

    expect(target).toHaveBeenCalledTimes(1);
    expect(placed.message).toContain('(Could not open a notebook)');
    expect(placed.runs).toEqual([]);
  });
});

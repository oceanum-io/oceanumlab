import { harvestOutputs, stripAnsi } from '../notebookRun';
import type * as nbformat from '@jupyterlab/nbformat';

const stream = (name: 'stdout' | 'stderr', text: string | string[]) =>
  ({ output_type: 'stream', name, text }) as nbformat.IStream;

const error = (ename: string, evalue: string, traceback: string[]) =>
  ({ output_type: 'error', ename, evalue, traceback }) as nbformat.IError;

describe('harvestOutputs', () => {
  it('concatenates stdout streams in order and reports ok', () => {
    const out = harvestOutputs([
      stream('stdout', 'rows 240\n'),
      stream('stdout', ['max ', '2.5\n'])
    ]);
    expect(out).toEqual({
      status: 'ok',
      stdout: 'rows 240\nmax 2.5\n',
      error: null
    });
  });

  it('turns an error output into an error run with the traceback', () => {
    const out = harvestOutputs([
      stream('stdout', 'before\n'),
      error('NameError', "name 'ds' is not defined", [
        '\u001b[0;31mNameError\u001b[0m Traceback',
        "name 'ds' is not defined"
      ])
    ]);
    expect(out.status).toBe('error');
    expect(out.stdout).toBe('before\n');
    expect(out.error).toContain("NameError: name 'ds' is not defined");
    // ANSI colour codes are for a terminal, not for the model.
    expect(out.error).not.toContain('\u001b[');
    expect(out.error).toContain('NameError Traceback');
  });

  it('folds stderr into the error text when the run failed', () => {
    const out = harvestOutputs([
      stream('stderr', 'FutureWarning: something\n'),
      error('ValueError', 'bad', [])
    ]);
    expect(out.status).toBe('error');
    expect(out.error).toContain('ValueError: bad');
    expect(out.error).toContain('FutureWarning');
  });

  it('does not send rendered outputs like DataFrame reprs', () => {
    const out = harvestOutputs([
      {
        output_type: 'execute_result',
        data: { 'text/plain': 'huge dataframe repr' },
        metadata: {},
        execution_count: 1
      } as nbformat.IExecuteResult
    ]);
    expect(out).toEqual({ status: 'ok', stdout: '', error: null });
  });

  it('is ok with no outputs at all', () => {
    expect(harvestOutputs([])).toEqual({
      status: 'ok',
      stdout: '',
      error: null
    });
  });
});

describe('stripAnsi', () => {
  it('removes colour and cursor codes', () => {
    expect(stripAnsi('\u001b[1;31mred\u001b[0m plain')).toBe('red plain');
  });
});

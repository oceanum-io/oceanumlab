import type * as nbformat from '@jupyterlab/nbformat';

/**
 * What one code cell did when it ran, in the shape `/api/chat/observe` takes.
 *
 * The notebook counterpart of the sandbox's ExecResult. `message` is the
 * agent's own explanation for the response that carried this code, so a
 * capped final answer can say what the whole chain was doing.
 */
export interface ObservedRun {
  code: string;
  status: 'ok' | 'error';
  stdout: string;
  error: string | null;
  message: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Kernel tracebacks are coloured for a terminal; the model does not need that. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function asText(value: nbformat.MultilineString | undefined): string {
  if (value === undefined) {
    return '';
  }
  return Array.isArray(value) ? value.join('') : value;
}

/**
 * Reduce a cell's outputs to what the observation prompt needs.
 *
 * Stream stdout is concatenated in order. An `error` output makes the run an
 * error and its traceback the error text; the kernel's stderr stream is folded
 * in after it, because warnings there are often the useful part of a failure.
 * Rendered outputs (execute_result, display_data) are deliberately NOT sent:
 * a DataFrame repr is kilobytes of dataset-derived text, and the agent gets
 * the printed summary the code chose to make instead.
 */
export function harvestOutputs(
  outputs: readonly nbformat.IOutput[]
): Pick<ObservedRun, 'status' | 'stdout' | 'error'> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let error: string | null = null;

  for (const output of outputs) {
    if (nbformatIsStream(output)) {
      (output.name === 'stderr' ? stderr : stdout).push(asText(output.text));
    } else if (nbformatIsError(output)) {
      const traceback = stripAnsi(output.traceback.join('\n'));
      error = `${output.ename}: ${output.evalue}\n${traceback}`.trim();
    }
  }

  if (error !== null && stderr.length > 0) {
    error = `${error}\n${stripAnsi(stderr.join(''))}`.trim();
  }

  return {
    status: error === null ? 'ok' : 'error',
    stdout: stripAnsi(stdout.join('')),
    error
  };
}

function nbformatIsStream(
  output: nbformat.IOutput
): output is nbformat.IStream {
  return output.output_type === 'stream';
}

function nbformatIsError(output: nbformat.IOutput): output is nbformat.IError {
  return output.output_type === 'error';
}

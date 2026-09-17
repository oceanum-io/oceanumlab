/**
 * Build the Python snippet that sets up a kernel (see kernel/bootstrap.py).
 *
 * Kept free of JupyterLab imports so it can be unit-tested in Node.
 */

/** Must match SNIPPET_MARKER in kernel/bootstrap.py: the snippet's history entry is scrubbed. */
export const SNIPPET_MARKER = '__oceanum_notebook__';

/** The module name the bootstrap source is registered under in the kernel. */
const MODULE_NAME = 'oceanum_notebook_kernel';

/**
 * Auth0 access tokens are JWTs (or opaque tokens) drawn from this alphabet. Anything else is
 * rejected rather than escaped, so a malformed token can never alter the Python snippet.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;

export function isValidAccessToken(token: string): boolean {
  return token.length > 0 && token.length < 16384 && TOKEN_PATTERN.test(token);
}

/**
 * A Python string literal. JSON string syntax is a subset of Python's, provided `/` is not
 * escaped, which JSON.stringify never does.
 */
export function pythonString(value: string): string {
  return JSON.stringify(value);
}

function pythonOptionalString(value: string | null): string {
  return value === null ? 'None' : pythonString(value);
}

export interface IKernelSetup {
  /** Source of kernel/bootstrap.py. */
  readonly bootstrapSource: string;
  /** Datamesh base URL for DATAMESH_SERVICE, or `null` to leave oceanum's default. */
  readonly datameshUrl: string | null;
  /** The current Auth0 access token, or `null` when signed out. */
  readonly accessToken: string | null;
}

/**
 * The code executed silently in every kernel on start, restart and token change.
 * It is idempotent: the bootstrap module is created once per kernel and then reused.
 */
export function kernelSetupCode(setup: IKernelSetup): string {
  const { accessToken } = setup;
  if (accessToken !== null && !isValidAccessToken(accessToken)) {
    throw new Error('Refusing to send a malformed access token to the kernel');
  }
  const token = accessToken === null ? null : `Bearer ${accessToken}`;
  return [
    `def ${SNIPPET_MARKER}():`,
    '    import sys, types',
    `    module = sys.modules.get(${pythonString(MODULE_NAME)})`,
    '    if module is None:',
    `        module = types.ModuleType(${pythonString(MODULE_NAME)})`,
    `        source = ${pythonString(setup.bootstrapSource)}`,
    '        exec(compile(source, "<oceanum-notebook>", "exec"), module.__dict__)',
    `        sys.modules[${pythonString(MODULE_NAME)}] = module`,
    `    module.install(${pythonOptionalString(setup.datameshUrl)})`,
    `    module.set_token(${pythonOptionalString(token)})`,
    '    module.scrub_history()',
    `${SNIPPET_MARKER}()`,
    `del ${SNIPPET_MARKER}`,
    ''
  ].join('\n');
}

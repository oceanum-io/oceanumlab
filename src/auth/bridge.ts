import type { ISessionContext } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import type { Kernel } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';

type KernelChange = IChangedArgs<
  Kernel.IKernelConnection | null,
  Kernel.IKernelConnection | null,
  'kernel'
>;

/**
 * Runs the kernel setup code in every kernel a notebook or console connects to: when the
 * kernel starts, after it restarts, and whenever `refresh()` is called (e.g. on token change).
 *
 * The code is sent as a silent execute request, so it does not bump the execution count or
 * enter the frontend's history, and the bootstrap scrubs it from IPython's history.
 */
export class KernelCredentialBridge implements IDisposable {
  constructor(code: () => string) {
    this._code = code;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** Start managing the kernels of a session context (a notebook or console). */
  track(context: ISessionContext): void {
    if (this._isDisposed || this._contexts.has(context)) {
      return;
    }
    this._contexts.add(context);
    context.kernelChanged.connect(this._onKernelChanged, this);
    context.disposed.connect(this._onContextDisposed, this);
    const kernel = context.session?.kernel;
    if (kernel) {
      this._watch(kernel);
    }
  }

  /** Re-run the setup code in every managed kernel. */
  refresh(): void {
    for (const kernel of this._kernels) {
      this._inject(kernel);
    }
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    for (const context of this._contexts) {
      context.kernelChanged.disconnect(this._onKernelChanged, this);
      context.disposed.disconnect(this._onContextDisposed, this);
    }
    for (const kernel of this._kernels) {
      kernel.statusChanged.disconnect(this._onStatusChanged, this);
    }
    this._contexts.clear();
    this._kernels.clear();
  }

  private _onKernelChanged(
    _context: ISessionContext,
    change: KernelChange
  ): void {
    if (change.oldValue) {
      this._unwatch(change.oldValue);
    }
    if (change.newValue) {
      this._watch(change.newValue);
    }
  }

  private _onContextDisposed(context: ISessionContext): void {
    context.kernelChanged.disconnect(this._onKernelChanged, this);
    context.disposed.disconnect(this._onContextDisposed, this);
    this._contexts.delete(context);
    const kernel = context.session?.kernel;
    if (kernel) {
      this._unwatch(kernel);
    }
  }

  private _watch(kernel: Kernel.IKernelConnection): void {
    if (this._kernels.has(kernel)) {
      return;
    }
    this._kernels.add(kernel);
    kernel.statusChanged.connect(this._onStatusChanged, this);
    kernel.disposed.connect(this._unwatch, this);
    // A new connection queues messages until the kernel is ready, so this runs before any
    // cell the user executes.
    this._inject(kernel);
  }

  private _unwatch(kernel: Kernel.IKernelConnection): void {
    kernel.statusChanged.disconnect(this._onStatusChanged, this);
    kernel.disposed.disconnect(this._unwatch, this);
    this._kernels.delete(kernel);
  }

  private _onStatusChanged(
    kernel: Kernel.IKernelConnection,
    status: Kernel.Status
  ): void {
    if (status === 'restarting' || status === 'autorestarting') {
      // KernelConnection emits this status *before* clearing its pending-message queue, so a
      // message sent synchronously here would be dropped. One microtask later the connection
      // is flagged as restarting and queues the message ahead of anything the user runs.
      queueMicrotask(() => this._inject(kernel));
    }
  }

  private _inject(kernel: Kernel.IKernelConnection): void {
    if (this._isDisposed || kernel.isDisposed || kernel.status === 'dead') {
      return;
    }
    try {
      const code = this._code();
      const future = kernel.requestExecute(
        {
          code,
          silent: true,
          store_history: false,
          allow_stdin: false,
          stop_on_error: false
        },
        true
      );
      future.done.catch(reason => {
        console.warn('Oceanum Notebook: kernel setup did not complete', reason);
      });
    } catch (reason) {
      console.error('Oceanum Notebook: could not set up the kernel', reason);
    }
  }

  private _code: () => string;
  private _contexts = new Set<ISessionContext>();
  private _kernels = new Set<Kernel.IKernelConnection>();
  private _isDisposed = false;
}

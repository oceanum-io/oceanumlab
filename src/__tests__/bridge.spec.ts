import { Signal } from '@lumino/signaling';

import type { ISessionContext } from '@jupyterlab/apputils';
import type { Kernel } from '@jupyterlab/services';

import { KernelCredentialBridge } from '../auth/bridge';

class FakeKernel {
  status: Kernel.Status = 'idle';
  isDisposed = false;
  statusChanged = new Signal<FakeKernel, Kernel.Status>(this);
  disposed = new Signal<FakeKernel, void>(this);
  /** Mirrors KernelConnection: a 'restarting' status is emitted before the queue is cleared. */
  queue: string[] = [];
  requestExecute = jest.fn(
    (content: { code: string; silent: boolean; store_history: boolean }) => {
      this.queue.push(content.code);
      return { done: Promise.resolve() };
    }
  );

  restart(): void {
    this.status = 'restarting';
    this.statusChanged.emit('restarting');
    this.queue = [];
  }
}

class FakeContext {
  session: { kernel: FakeKernel | null } | null = { kernel: null };
  kernelChanged = new Signal<
    FakeContext,
    { oldValue: FakeKernel | null; newValue: FakeKernel | null }
  >(this);
  disposed = new Signal<FakeContext, void>(this);

  setKernel(kernel: FakeKernel | null): void {
    const oldValue = this.session!.kernel;
    this.session!.kernel = kernel;
    this.kernelChanged.emit({ oldValue, newValue: kernel });
  }
}

function setup() {
  let n = 0;
  const bridge = new KernelCredentialBridge(() => `setup ${++n}`);
  const context = new FakeContext();
  bridge.track(context as unknown as ISessionContext);
  return { bridge, context };
}

describe('KernelCredentialBridge', () => {
  it('sets up a kernel as soon as the context gets one, silently', () => {
    const { context } = setup();
    const kernel = new FakeKernel();

    context.setKernel(kernel);

    expect(kernel.requestExecute).toHaveBeenCalledWith(
      {
        code: 'setup 1',
        silent: true,
        store_history: false,
        allow_stdin: false,
        stop_on_error: false
      },
      true
    );
  });

  it('sets up a kernel the context already had when tracking starts', () => {
    const kernel = new FakeKernel();
    const context = new FakeContext();
    context.session!.kernel = kernel;

    new KernelCredentialBridge(() => 'code').track(
      context as unknown as ISessionContext
    );

    expect(kernel.queue).toEqual(['code']);
  });

  it('queues setup after a restart has cleared the pending messages', async () => {
    const { context } = setup();
    const kernel = new FakeKernel();
    context.setKernel(kernel);

    kernel.restart();
    await Promise.resolve();

    expect(kernel.queue).toEqual(['setup 2']);
  });

  it('re-runs setup in every kernel on refresh', () => {
    const { bridge, context } = setup();
    const other = new FakeContext();
    bridge.track(other as unknown as ISessionContext);
    const a = new FakeKernel();
    const b = new FakeKernel();
    context.setKernel(a);
    other.setKernel(b);

    bridge.refresh();

    expect(a.queue).toHaveLength(2);
    expect(b.queue).toHaveLength(2);
  });

  it('stops managing a kernel that was replaced, disposed or is dead', () => {
    const { bridge, context } = setup();
    const replaced = new FakeKernel();
    const disposed = new FakeKernel();
    const current = new FakeKernel();
    context.setKernel(replaced);
    context.setKernel(current);
    const other = new FakeContext();
    bridge.track(other as unknown as ISessionContext);
    other.setKernel(disposed);
    disposed.disposed.emit();

    current.status = 'dead';
    bridge.refresh();

    expect(replaced.queue).toHaveLength(1);
    expect(disposed.queue).toHaveLength(1);
    expect(current.queue).toHaveLength(1);
  });

  it('does not let a code error escape into JupyterLab', () => {
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const bridge = new KernelCredentialBridge(() => {
      throw new Error('bad token');
    });
    const context = new FakeContext();
    bridge.track(context as unknown as ISessionContext);

    expect(() => context.setKernel(new FakeKernel())).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

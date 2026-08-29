import * as assert from 'assert';
import { waitForPromiseOrCancellation } from '../../cancellable';

class FakeCancellationToken {
  public isCancellationRequested = false;
  private readonly listeners = new Set<() => void>();

  public readonly onCancellationRequested = (listener: () => void): { dispose(): void } => {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  };

  public cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  public get listenerCount(): number {
    return this.listeners.size;
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

suite('cancellable promise waiting', () => {
  test('settles immediately when cancellation has already been requested', async () => {
    const operation = deferred();
    const token = new FakeCancellationToken();
    token.cancel();

    assert.strictEqual(await waitForPromiseOrCancellation(operation.promise, token), false);
    assert.strictEqual(token.listenerCount, 0);
  });

  test('releases a cancelled waiter without waiting for the operation', async () => {
    const operation = deferred();
    const token = new FakeCancellationToken();
    const waiting = waitForPromiseOrCancellation(operation.promise, token);
    assert.strictEqual(token.listenerCount, 1);

    token.cancel();
    assert.strictEqual(await waiting, false);
    assert.strictEqual(token.listenerCount, 0);
    operation.resolve();
  });

  test('reports completion and disposes the cancellation listener', async () => {
    const operation = deferred();
    const token = new FakeCancellationToken();
    const waiting = waitForPromiseOrCancellation(operation.promise, token);

    operation.resolve();
    assert.strictEqual(await waiting, true);
    assert.strictEqual(token.listenerCount, 0);
  });
});

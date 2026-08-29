export interface DisposableLike {
  dispose(): unknown;
}

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: (listener: () => void) => DisposableLike;
}

export type PromiseOrCancellationResult<T> =
  | { completed: true; value: T }
  | { completed: false };

/** Waits for a value while allowing only this caller to leave on cancellation. */
export function waitForValueOrCancellation<T>(
  operation: PromiseLike<T>,
  token: CancellationTokenLike,
): Promise<PromiseOrCancellationResult<T>> {
  if (token.isCancellationRequested) {
    return Promise.resolve({ completed: false });
  }

  return new Promise<PromiseOrCancellationResult<T>>((resolve, reject) => {
    let settled = false;
    let cancellationSubscription: DisposableLike | undefined;
    const disposeCancellationSubscription = (): void => {
      cancellationSubscription?.dispose();
      cancellationSubscription = undefined;
    };
    const complete = (result: PromiseOrCancellationResult<T>): void => {
      if (settled) {
        return;
      }
      settled = true;
      disposeCancellationSubscription();
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      disposeCancellationSubscription();
      reject(error);
    };

    cancellationSubscription = token.onCancellationRequested(() => complete({ completed: false }));
    if (settled) {
      disposeCancellationSubscription();
    }
    void Promise.resolve(operation).then(
      value => complete({ completed: true, value }),
      fail,
    );
  });
}

/**
 * Wait for an operation without keeping its caller alive after cancellation.
 * Returns false when cancellation wins and true when the operation completes.
 */
export async function waitForPromiseOrCancellation(
  operation: PromiseLike<void>,
  token: CancellationTokenLike,
): Promise<boolean> {
  return (await waitForValueOrCancellation(operation, token)).completed;
}

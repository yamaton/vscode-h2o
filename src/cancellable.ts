export interface DisposableLike {
  dispose(): unknown;
}

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: (listener: () => void) => DisposableLike;
}

/**
 * Wait for an operation without keeping its caller alive after cancellation.
 * Returns false when cancellation wins and true when the operation completes.
 */
export function waitForPromiseOrCancellation(
  operation: PromiseLike<void>,
  token: CancellationTokenLike,
): Promise<boolean> {
  if (token.isCancellationRequested) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let cancellationSubscription: DisposableLike | undefined;
    const disposeCancellationSubscription = (): void => {
      cancellationSubscription?.dispose();
      cancellationSubscription = undefined;
    };
    const complete = (completed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      disposeCancellationSubscription();
      resolve(completed);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      disposeCancellationSubscription();
      reject(error);
    };

    cancellationSubscription = token.onCancellationRequested(() => complete(false));
    if (settled) {
      disposeCancellationSubscription();
    }
    void Promise.resolve(operation).then(() => complete(true), fail);
  });
}

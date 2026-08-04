/**
 * Wrap a promise with a hard deadline. Used to guarantee tool calls that touch the (not yet
 * provisioned) UNO Q board can never hang the agent, even if the underlying transport misbehaves.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Node timers would otherwise keep the process alive; this script always has other work
    // (stdio transport) keeping it alive anyway, but unref is good hygiene for the CLI script.
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

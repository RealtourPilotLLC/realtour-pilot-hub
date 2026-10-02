/** Bound a caller's wait, without claiming that the underlying operation was
 * cancelled. A timed-out write must retain its reconciliation guard. */
export async function boundedWait<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Confirmation timed out")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// barrier(n): hold n racers at one point, then let them all go at once
// (R04, Sep 28 2026).
//
// A race drill proves nothing if its racers happen to run one after another.
// Put a barrier where the racers must overlap — inside a stubbed provider
// call, between a read and its write, after each has opened its transaction —
// and the first n arrivals wait until the n-th arrives, then are released
// together. Across processes, the parent does the same with its children:
// wait for each child's "ready" message, then send every one "go".
//
// A barrier that is never filled rejects every waiter after timeoutMs, naming
// itself and the count, so a race that cannot overlap fails loudly instead of
// hanging the drill. Arrivals after the release pass straight through and are
// counted in `late`, so a drill can assert that nothing arrived it did not
// expect (a retry, a duplicate worker).
// ---------------------------------------------------------------------------

export type Barrier = {
  /** Resolves with this caller's arrival order (1…n) once all n have arrived. */
  wait: () => Promise<number>;
  readonly arrived: number;
  readonly released: boolean;
  /** Arrivals after the release; they did not wait. */
  readonly late: number;
};

export function barrier(n: number, opts: { timeoutMs?: number; label?: string } = {}): Barrier {
  if (!Number.isInteger(n) || n < 1) throw new Error(`barrier(n) needs a positive whole number, got ${n}`);
  const label = opts.label ?? `barrier(${n})`;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let arrived = 0;
  let late = 0;
  let released = false;
  let failed: Error | null = null;
  const waiting: { resolve: () => void; reject: (e: Error) => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    wait() {
      if (failed) return Promise.reject(failed);
      if (released) {
        late++;
        return Promise.resolve(n + late);
      }
      const order = ++arrived;
      const here = new Promise<number>((resolve, reject) => {
        waiting.push({ resolve: () => resolve(order), reject });
      });
      if (arrived === n) {
        released = true;
        if (timer) clearTimeout(timer);
        for (const w of waiting.splice(0)) w.resolve();
      } else if (!timer) {
        timer = setTimeout(() => {
          failed = new Error(`${label}: only ${arrived} of ${n} arrived within ${timeoutMs} ms, so the racers never overlapped`);
          for (const w of waiting.splice(0)) w.reject(failed);
        }, timeoutMs);
      }
      return here;
    },
    get arrived() { return arrived; },
    get released() { return released; },
    get late() { return late; },
  };
}

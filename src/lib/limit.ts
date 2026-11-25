/**
 * Runs at most `max` of the wrapped tasks at once; the rest wait in order.
 * Used to keep heavy work (Remotion renders, Whisper) from piling onto the
 * machine at the same time, which made renders time out.
 * `onQueue(ahead)` reports how many tasks are ahead while this one waits,
 * and 0 when it starts, so the app can show its place in line.
 */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<{ go: () => void; onQueue?: (ahead: number) => void }> = [];

  return async function run<T>(task: () => Promise<T>, onQueue?: (ahead: number) => void): Promise<T> {
    if (active >= max) {
      await new Promise<void>((go) => {
        waiting.push({ go, onQueue });
        onQueue?.(waiting.length);
      });
    } else active++;
    onQueue?.(0);
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = waiting.shift();
      if (next) {
        waiting.forEach((w, i) => w.onQueue?.(i + 1));
        next.go();
      } else active--;
    }
  };
}

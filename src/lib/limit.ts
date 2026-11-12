/**
 * Runs at most `max` of the wrapped tasks at once; the rest wait in order.
 * Used to keep heavy work (Remotion renders, Whisper) from piling onto the
 * machine at the same time, which made renders time out.
 */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * A counting semaphore — the whole of the fallback's concurrency control
 * (docs/engine-spec.md section 5.1). Bounded because a review that spawns twenty workers
 * at once buys nothing but rate limits.
 *
 * Replaced at Integrate by NeuroLink's own delegation pool, which this deliberately
 * mirrors: a spawn QUEUES, it never fails.
 */
export const createPool = (
  size: number,
): {
  acquire: () => Promise<() => void>;
  active: () => number;
  queued: () => number;
} => {
  const capacity = Math.max(1, Math.trunc(size));
  const waiting: (() => void)[] = [];
  let inUse = 0;

  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    inUse -= 1;
  };

  const acquire = async (): Promise<() => void> => {
    if (inUse < capacity) {
      inUse += 1;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (!released) {
        released = true;
        release();
      }
    };
  };

  return { acquire, active: () => inUse, queued: () => waiting.length };
};

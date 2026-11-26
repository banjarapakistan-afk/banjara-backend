import { AppError } from './AppError';

/**
 * Limits how many copies of an expensive job run at the same time in this process.
 *
 * Rate limits count requests per window, which does not stop one caller from starting
 * many memory-heavy jobs in the same second. The gate runs up to `maxConcurrent` jobs,
 * lets `maxQueued` more wait their turn, and refuses the rest immediately so a burst
 * cannot pile up buffers in memory.
 */
export function createConcurrencyGate(options: {
  maxConcurrent: number;
  maxQueued: number;
  busyMessage: string;
}) {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    const next = waiting.shift();
    // Hand the slot straight to the next waiter, so `active` never dips and a newcomer
    // cannot jump the queue.
    if (next) next();
    else active -= 1;
  };

  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (active < options.maxConcurrent) {
      active += 1;
    } else {
      if (waiting.length >= options.maxQueued) {
        throw new AppError(options.busyMessage, 429);
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await job();
    } finally {
      release();
    }
  };
}

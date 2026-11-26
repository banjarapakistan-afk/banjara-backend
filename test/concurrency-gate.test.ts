import { describe, expect, it } from 'vitest';
import { createConcurrencyGate } from '../src/utils/concurrencyGate';

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('concurrency gate', () => {
  it('runs one job at a time, queues up to the limit and refuses the rest', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 1, busyMessage: 'busy' });
    let running = 0;
    let peak = 0;
    const finish: Array<() => void> = [];
    const job = () =>
      gate(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => finish.push(resolve));
        running -= 1;
        return 'done';
      });

    const first = job();
    const second = job();
    await expect(job()).rejects.toMatchObject({ statusCode: 429, message: 'busy' });

    // The queued job has not started while the first one is still running.
    expect(finish).toHaveLength(1);
    finish[0]();
    await expect(first).resolves.toBe('done');
    await nextTick();
    expect(finish).toHaveLength(2);
    finish[1]();
    await expect(second).resolves.toBe('done');
    expect(peak).toBe(1);

    // The slot is free again afterwards.
    const third = job();
    await nextTick();
    finish[2]();
    await expect(third).resolves.toBe('done');
  });

  it('frees the slot when a job throws', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 0, busyMessage: 'busy' });
    await expect(
      gate(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(gate(async () => 'ok')).resolves.toBe('ok');
  });
});

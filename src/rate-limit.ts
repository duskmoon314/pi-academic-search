import { sleep } from "./utils.ts";

/**
 * Per-source rate limiter with a serial queue and minimum interval.
 *
 * Each source gets its own queue. Requests within the same queue execute
 * serially with a minimum gap of `minIntervalMs` between starts.
 * Cross-source queues are independent and run in parallel.
 */
export class RateLimiter {
  private queues = new Map<string, Promise<void>>();
  private lastStart = new Map<string, number>();
  private readonly minIntervalMs: number;

  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs;
  }

  /**
   * Schedule a task on this limiter's queue.
   * Returns the result of the task after enforcing the rate limit.
   */
  async schedule<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();

    let resolve!: () => void;
    const barrier = new Promise<void>((r) => { resolve = r; });

    this.queues.set(key, barrier);

    await prev;

    const now = Date.now();
    const last = this.lastStart.get(key) ?? 0;
    const elapsed = now - last;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastStart.set(key, Date.now());

    try {
      return await task();
    } finally {
      resolve();
    }
  }
}

/**
 * Rate limit intervals per source:
 *
 * | Source           | No key | With key |
 * |------------------|--------|----------|
 * | Semantic Scholar | 3s     | 1s       |
 * | arXiv            | 3s     | 3s       |
 * | PubMed           | 350ms  | 100ms    |
 * | OpenAlex         | loose  | loose    |
 * | Crossref         | loose  | loose    |
 * | DBLP             | loose  | loose    |
 */
export function createRateLimiters(hasS2Key: boolean, hasNcbiKey: boolean = false): Map<string, RateLimiter> {
  const limiters = new Map<string, RateLimiter>();
  limiters.set("semantic", new RateLimiter(hasS2Key ? 1_000 : 3_000));
  limiters.set("arxiv", new RateLimiter(3_000));
  limiters.set("pubmed", new RateLimiter(hasNcbiKey ? 100 : 350));
  limiters.set("openalex", new RateLimiter(100)); // minimal delay
  limiters.set("crossref", new RateLimiter(100));  // minimal delay
  limiters.set("dblp", new RateLimiter(1_000));    // 1s to avoid 429
  return limiters;
}

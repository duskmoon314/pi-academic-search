import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/rate-limit.ts";

describe("RateLimiter", () => {
  it("executes tasks sequentially within the same key", async () => {
    const limiter = new RateLimiter(50); // 50ms interval for fast test
    const order: number[] = [];

    const task1 = limiter.schedule("src", async () => {
      order.push(1);
      return "a";
    });
    const task2 = limiter.schedule("src", async () => {
      order.push(2);
      return "b";
    });
    const task3 = limiter.schedule("src", async () => {
      order.push(3);
      return "c";
    });

    const results = await Promise.all([task1, task2, task3]);
    assert.deepEqual(results, ["a", "b", "c"]);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it("enforces minimum interval between task starts", async () => {
    const intervalMs = 80;
    const limiter = new RateLimiter(intervalMs);
    const timestamps: number[] = [];

    const start = Date.now();
    await limiter.schedule("src", async () => {
      timestamps.push(Date.now() - start);
    });
    await limiter.schedule("src", async () => {
      timestamps.push(Date.now() - start);
    });
    await limiter.schedule("src", async () => {
      timestamps.push(Date.now() - start);
    });

    // Second task should start at least intervalMs after first
    assert.ok(timestamps[1] >= intervalMs - 10, `Expected >= ${intervalMs - 10}, got ${timestamps[1]}`);
    assert.ok(timestamps[2] >= 2 * intervalMs - 10, `Expected >= ${2 * intervalMs - 10}, got ${timestamps[2]}`);
  });

  it("runs different keys in parallel (no cross-key blocking)", async () => {
    const limiter = new RateLimiter(200); // long interval
    const order: string[] = [];

    const start = Date.now();
    const p1 = limiter.schedule("keyA", async () => {
      order.push("A");
      return "a";
    });
    const p2 = limiter.schedule("keyB", async () => {
      order.push("B");
      return "b";
    });

    const results = await Promise.all([p1, p2]);
    // Both should run nearly simultaneously (within first few ms)
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 100, `Expected fast parallel execution, took ${elapsed}ms`);
    assert.equal(results.length, 2);
    // Both keys ran
    assert.ok(order.includes("A"));
    assert.ok(order.includes("B"));
  });

  it("propagates task errors without breaking the queue", async () => {
    const limiter = new RateLimiter(50);

    // First task fails
    await assert.rejects(
      () => limiter.schedule("src", async () => { throw new Error("fail"); }),
      { message: "fail" },
    );

    // Second task should still run
    const result = await limiter.schedule("src", async () => "ok");
    assert.equal(result, "ok");
  });

  it("returns the value from the task", async () => {
    const limiter = new RateLimiter(10);
    const result = await limiter.schedule("src", async () => 42);
    assert.equal(result, 42);
  });
});

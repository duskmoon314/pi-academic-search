import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter } from "../src/utils.ts";

describe("parseRetryAfter", () => {
  it("parses non-negative integer seconds", () => {
    assert.equal(parseRetryAfter("5"), 5);
    assert.equal(parseRetryAfter("0"), 0);
    assert.equal(parseRetryAfter("1"), 1);
  });

  it("clamps to 20s maximum", () => {
    assert.equal(parseRetryAfter("30"), 20);
    assert.equal(parseRetryAfter("100"), 20);
  });

  it("parses HTTP-date format", () => {
    // Create a date 5 seconds in the future
    const future = new Date(Date.now() + 5000);
    const result = parseRetryAfter(future.toUTCString());
    // Should be approximately 5 (allow ±1 for timing)
    assert.ok(result !== null && result >= 4 && result <= 6, `Expected ~5, got ${result}`);
  });

  it("clamps HTTP-date to 20s max", () => {
    // Create a date 60 seconds in the future
    const future = new Date(Date.now() + 60_000);
    assert.equal(parseRetryAfter(future.toUTCString()), 20);
  });

  it("returns 0 for past HTTP-date", () => {
    const past = new Date(Date.now() - 10_000);
    assert.equal(parseRetryAfter(past.toUTCString()), 0);
  });

  it("returns null for unparseable string", () => {
    assert.equal(parseRetryAfter("not-a-date"), null);
    assert.equal(parseRetryAfter(""), null);
    assert.equal(parseRetryAfter("abc"), null);
  });

  it("handles negative integer by falling through to date parse", () => {
    // "-1" as parseInt gives -1, which fails the >= 0 check
    // Date.parse("-1") may return a valid year-0001 date, so the function
    // may return clamped value. The key behavior: negative int is NOT treated as seconds.
    const result = parseRetryAfter("-1");
    // It should NOT return -1 (the integer interpretation)
    assert.ok(result !== -1, "should not interpret -1 as negative seconds");
  });
});

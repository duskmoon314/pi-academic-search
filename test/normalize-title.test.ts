import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTitle } from "../src/dedupe.ts";

describe("normalizeTitle Unicode support", () => {
  it("preserves CJK characters", () => {
    const result = normalizeTitle("基于深度学习的自然语言处理方法综述");
    assert.ok(result);
    assert.ok(result.length > 0);
    assert.ok(result.includes("基于深度学习"));
  });

  it("preserves accented characters", () => {
    const result = normalizeTitle("Étude de l'attention");
    assert.ok(result);
    assert.ok(result.includes("étude"));
    assert.ok(result.includes("l"));
    assert.ok(result.includes("attention"));
  });

  it("removes punctuation but keeps Unicode letters", () => {
    const result = normalizeTitle("Hello, World! 你好世界");
    assert.ok(result);
    assert.ok(result.includes("hello"));
    assert.ok(result.includes("world"));
    assert.ok(result.includes("你好世界"));
    assert.ok(!result.includes("!"));
    assert.ok(!result.includes(","));
  });

  it("handles mixed scripts", () => {
    const result = normalizeTitle("Transformerの仕組み");
    assert.ok(result);
    assert.ok(result.includes("transformer"));
    assert.ok(result.includes("の"));
    assert.ok(result.includes("仕組み"));
  });

  it("normalizes whitespace", () => {
    const result = normalizeTitle("  Hello   World  ");
    assert.equal(result, "hello world");
  });

  it("returns null for undefined", () => {
    assert.equal(normalizeTitle(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.equal(normalizeTitle(""), null);
  });

  it("handles titles with only punctuation", () => {
    const result = normalizeTitle("!@#$%^&*()");
    assert.equal(result, null);
  });
});

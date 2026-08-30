import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOpenAlexParams } from "../src/providers/openalex.ts";

describe("buildOpenAlexParams", () => {
  it("includes api_key when provided", () => {
    const params = buildOpenAlexParams(null, "test-key-123");
    assert.equal(params.get("api_key"), "test-key-123");
    assert.equal(params.get("mailto"), null);
  });

  it("includes mailto when provided", () => {
    const params = buildOpenAlexParams("user@example.com", null);
    assert.equal(params.get("mailto"), "user@example.com");
    assert.equal(params.get("api_key"), null);
  });

  it("includes both mailto and api_key when both provided", () => {
    const params = buildOpenAlexParams("user@example.com", "test-key-123");
    assert.equal(params.get("mailto"), "user@example.com");
    assert.equal(params.get("api_key"), "test-key-123");
  });

  it("returns empty params when neither is provided", () => {
    const params = buildOpenAlexParams(null, null);
    assert.equal(params.toString(), "");
  });
});

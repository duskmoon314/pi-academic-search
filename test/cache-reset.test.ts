import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test that each provider exports a reset function
// We import the modules to verify the exports exist

describe("provider cache reset exports", () => {
  it("semanticscholar exports resetS2Cache", async () => {
    const mod = await import("../src/providers/semanticscholar.ts");
    assert.equal(typeof mod.resetS2Cache, "function");
  });

  it("openalex exports resetOpenAlexCache", async () => {
    const mod = await import("../src/providers/openalex.ts");
    assert.equal(typeof mod.resetOpenAlexCache, "function");
  });

  it("crossref exports resetCrossrefCache", async () => {
    const mod = await import("../src/providers/crossref.ts");
    assert.equal(typeof mod.resetCrossrefCache, "function");
  });

  it("pubmed exports resetPubmedCache", async () => {
    const mod = await import("../src/providers/pubmed.ts");
    assert.equal(typeof mod.resetPubmedCache, "function");
  });

  it("unpaywall exports resetUnpaywallCache", async () => {
    const mod = await import("../src/pdf/unpaywall.ts");
    assert.equal(typeof mod.resetUnpaywallCache, "function");
  });

  it("resetS2Cache can be called without error", async () => {
    const { resetS2Cache } = await import("../src/providers/semanticscholar.ts");
    assert.doesNotThrow(() => resetS2Cache());
  });

  it("resetOpenAlexCache can be called without error", async () => {
    const { resetOpenAlexCache } = await import("../src/providers/openalex.ts");
    assert.doesNotThrow(() => resetOpenAlexCache());
  });

  it("resetCrossrefCache can be called without error", async () => {
    const { resetCrossrefCache } = await import("../src/providers/crossref.ts");
    assert.doesNotThrow(() => resetCrossrefCache());
  });

  it("resetPubmedCache can be called without error", async () => {
    const { resetPubmedCache } = await import("../src/providers/pubmed.ts");
    assert.doesNotThrow(() => resetPubmedCache());
  });

  it("resetUnpaywallCache can be called without error", async () => {
    const { resetUnpaywallCache } = await import("../src/pdf/unpaywall.ts");
    assert.doesNotThrow(() => resetUnpaywallCache());
  });
});

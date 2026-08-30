import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { identifyId } from "../src/identify-id.ts";

describe("identifyId", () => {
  describe("bare DOI", () => {
    it("recognizes bare DOI", () => {
      const result = identifyId("10.1145/3292500.3330919");
      assert.ok(result);
      assert.equal(result.type, "doi");
      assert.equal(result.normalized, "10.1145/3292500.3330919");
    });

    it("recognizes DOI with https://doi.org/ prefix", () => {
      const result = identifyId("https://doi.org/10.1234/ABCD");
      assert.ok(result);
      assert.equal(result.type, "doi");
      assert.equal(result.normalized, "10.1234/abcd");
    });

    it("recognizes DOI with http://dx.doi.org/ prefix", () => {
      const result = identifyId("http://dx.doi.org/10.5555/test");
      assert.ok(result);
      assert.equal(result.type, "doi");
    });

    it("recognizes DOI with doi: prefix", () => {
      const result = identifyId("doi:10.1234/test");
      assert.ok(result);
      assert.equal(result.type, "doi");
    });

    it("recognizes DOI with DOI: prefix (uppercase)", () => {
      const result = identifyId("DOI:10.1234/TEST");
      assert.ok(result);
      assert.equal(result.type, "doi");
      assert.equal(result.normalized, "10.1234/test");
    });
  });

  describe("ARXIV: prefix", () => {
    it("recognizes ARXIV: prefix", () => {
      const result = identifyId("ARXIV:1706.03762");
      assert.ok(result);
      assert.equal(result.type, "arxiv");
      assert.equal(result.normalized, "1706.03762");
    });

    it("recognizes arxiv: prefix (lowercase)", () => {
      const result = identifyId("arxiv:2301.07041");
      assert.ok(result);
      assert.equal(result.type, "arxiv");
    });

    it("strips version from ARXIV: ID", () => {
      const result = identifyId("ARXIV:1706.03762v3");
      assert.ok(result);
      assert.equal(result.normalized, "1706.03762");
    });

    it("recognizes ARXIV: with old-style ID", () => {
      const result = identifyId("ARXIV:cs/0501001");
      assert.ok(result);
      assert.equal(result.type, "arxiv");
      assert.equal(result.normalized, "cs/0501001");
    });
  });

  describe("bare arXiv ID", () => {
    it("recognizes bare arXiv ID", () => {
      const result = identifyId("1706.03762");
      assert.ok(result);
      assert.equal(result.type, "arxiv");
      assert.equal(result.normalized, "1706.03762");
    });

    it("strips version from bare ID", () => {
      const result = identifyId("2301.07041v2");
      assert.ok(result);
      assert.equal(result.normalized, "2301.07041");
    });

    it("handles longer arXiv IDs", () => {
      const result = identifyId("2301.07041");
      assert.ok(result);
      assert.equal(result.type, "arxiv");
    });

    it("recognizes old-style bare arXiv ID", () => {
      const result = identifyId("cs/0501001");
      assert.ok(result);
      assert.equal(result.type, "arxiv");
      assert.equal(result.normalized, "cs/0501001");
    });

    it("recognizes old-style bare arXiv ID with sub-category", () => {
      const result = identifyId("hep-ph/0001001");
      assert.ok(result);
      assert.equal(result.type, "arxiv");
      assert.equal(result.normalized, "hep-ph/0001001");
    });
  });

  describe("PMID:", () => {
    it("recognizes PMID: prefix", () => {
      const result = identifyId("PMID:12345678");
      assert.ok(result);
      assert.equal(result.type, "pmid");
      assert.equal(result.normalized, "12345678");
    });

    it("recognizes pmid: prefix (lowercase)", () => {
      const result = identifyId("pmid:99999");
      assert.ok(result);
      assert.equal(result.type, "pmid");
    });
  });

  describe("S2: prefix", () => {
    it("recognizes S2: prefix", () => {
      const result = identifyId("S2:abc123def456");
      assert.ok(result);
      assert.equal(result.type, "s2");
      assert.equal(result.normalized, "abc123def456");
    });

    it("recognizes s2: prefix (lowercase)", () => {
      const result = identifyId("s2:abc123");
      assert.ok(result);
      assert.equal(result.type, "s2");
    });
  });

  describe("OPENALEX: prefix", () => {
    it("recognizes OPENALEX: prefix", () => {
      const result = identifyId("OPENALEX:W2741809807");
      assert.ok(result);
      assert.equal(result.type, "openalex");
      assert.equal(result.normalized, "W2741809807");
    });

    it("recognizes openalex: prefix (lowercase)", () => {
      const result = identifyId("openalex:W12345");
      assert.ok(result);
      assert.equal(result.type, "openalex");
    });

    it("adds W prefix when missing", () => {
      const result = identifyId("OPENALEX:2741809807");
      assert.ok(result);
      assert.equal(result.type, "openalex");
      assert.equal(result.normalized, "W2741809807");
    });
  });

  describe("unrecognized", () => {
    it("returns null for random text", () => {
      assert.equal(identifyId("hello world"), null);
    });

    it("returns null for empty string", () => {
      assert.equal(identifyId(""), null);
    });

    it("returns null for too-short DOI prefix", () => {
      assert.equal(identifyId("10.12/short"), null);
    });

    it("returns null for whitespace-only", () => {
      assert.equal(identifyId("   "), null);
    });
  });
});

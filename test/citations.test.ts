import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseS2Citations } from "../src/providers/semanticscholar.ts";

/**
 * S2 citations/references response parsing tests.
 * Tests the real `parseS2Citations` function with fixture data (no live requests).
 */

// --- Fixtures ---

const S2_CITATIONS_FIXTURE = {
  data: [
    {
      citingPaper: {
        paperId: "abc123",
        title: "Citing Paper One",
        year: 2023,
        venue: "ICML",
        authors: [{ name: "Alice Author" }, { name: "Bob Builder" }],
        citationCount: 5,
        isOpenAccess: true,
        openAccessPdf: { url: "https://example.com/paper1.pdf" },
        externalIds: { DOI: "10.1234/citing1", ArXiv: "2301.00001" },
      },
    },
    {
      citingPaper: {
        paperId: "def456",
        title: "Citing Paper Two",
        year: 2024,
        authors: [{ name: "Charlie Chaplin" }],
        externalIds: {},
      },
    },
  ],
};

const S2_REFERENCES_FIXTURE = {
  data: [
    {
      citedPaper: {
        paperId: "ghi789",
        title: "Referenced Paper Alpha",
        year: 2020,
        authors: [{ name: "Diana Prince" }],
        citationCount: 100,
        externalIds: { DOI: "10.5678/ref1", PubMed: "12345678" },
      },
    },
    {
      citedPaper: {
        paperId: "jkl012",
        title: "Referenced Paper Beta",
        year: 2019,
        authors: [{ name: "Eve Online" }, { name: "Frank Castle" }],
        externalIds: { DOI: "10.5678/ref2" },
      },
    },
    {
      citedPaper: {
        paperId: "mno345",
        title: "Referenced Paper Gamma",
        year: 2021,
        authors: [],
        externalIds: {},
      },
    },
  ],
};

// Empty response (no citations/references found)
const S2_EMPTY_FIXTURE = {
  data: [],
};

// Response with malformed entry (missing nested key)
const S2_MALFORMED_FIXTURE = {
  data: [
    { unrelatedField: "noise" },
    { citingPaper: null },
    {
      citingPaper: {
        paperId: "valid123",
        title: "Valid Paper",
        authors: [{ name: "Grace Hopper" }],
        externalIds: { DOI: "10.9999/valid" },
      },
    },
  ],
};

describe("S2 citations response parsing", () => {
  it("parses citingPaper entries correctly", () => {
    const results = parseS2Citations("citing", S2_CITATIONS_FIXTURE);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.title, "Citing Paper One");
    assert.equal(results[0]!.doi, "10.1234/citing1");
    assert.equal(results[0]!.s2Id, "abc123");
    assert.deepEqual(results[0]!.authors, ["Alice Author", "Bob Builder"]);
    assert.equal(results[0]!.isOpenAccess, true);
    assert.equal(results[0]!.pdfUrl, "https://example.com/paper1.pdf");
    assert.equal(results[1]!.title, "Citing Paper Two");
    assert.equal(results[1]!.s2Id, "def456");
    assert.equal(results[1]!.doi, undefined);
  });

  it("parses citedPaper entries correctly", () => {
    const results = parseS2Citations("references", S2_REFERENCES_FIXTURE);
    assert.equal(results.length, 3);
    assert.equal(results[0]!.title, "Referenced Paper Alpha");
    assert.equal(results[0]!.doi, "10.5678/ref1");
    assert.equal(results[0]!.s2Id, "ghi789");
    assert.deepEqual(results[0]!.authors, ["Diana Prince"]);
    assert.equal(results[1]!.title, "Referenced Paper Beta");
    assert.equal(results[1]!.doi, "10.5678/ref2");
    assert.deepEqual(results[1]!.authors, ["Eve Online", "Frank Castle"]);
    assert.equal(results[2]!.title, "Referenced Paper Gamma");
    assert.deepEqual(results[2]!.authors, []);
  });

  it("returns empty array for empty data", () => {
    const results = parseS2Citations("citing", S2_EMPTY_FIXTURE);
    assert.deepEqual(results, []);
  });

  it("skips malformed entries and parses valid ones", () => {
    const results = parseS2Citations("citing", S2_MALFORMED_FIXTURE as any);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.title, "Valid Paper");
    assert.equal(results[0]!.s2Id, "valid123");
    assert.deepEqual(results[0]!.authors, ["Grace Hopper"]);
  });

  it("does not confuse citingPaper with citedPaper keys", () => {
    // citations response should NOT have citedPaper entries
    const results = parseS2Citations("citing", S2_REFERENCES_FIXTURE);
    // citedPaper key won't match citingPaper — all entries should be skipped
    assert.equal(results.length, 0);
  });

  it("does not confuse citedPaper with citingPaper keys", () => {
    // references response should NOT have citingPaper entries
    const results = parseS2Citations("references", S2_CITATIONS_FIXTURE);
    assert.equal(results.length, 0);
  });
});

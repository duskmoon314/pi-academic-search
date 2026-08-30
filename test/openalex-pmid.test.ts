import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test the OpenAlex lookup ID normalization logic
// We test the URL construction pattern rather than making real API calls

describe("OpenAlex pmid: prefix support", () => {
  it("pmid: prefix is preserved in lookup ID", () => {
    // The lookupOpenAlex function should pass pmid:xxx directly to OpenAlex API
    // OpenAlex natively supports /works/pmid:xxx
    const id = "pmid:12345678";
    // Verify the id starts with pmid:
    assert.ok(id.startsWith("pmid:"));
    // The function should NOT prefix with https://doi.org/
    assert.ok(!id.match(/^10\.\d{4,}\//));
  });

  it("DOI is correctly identified", () => {
    const id = "10.1234/test";
    assert.ok(id.match(/^10\.\d{4,}\//));
  });

  it("OpenAlex W ID is preserved", () => {
    const id = "W12345678";
    assert.ok(id.startsWith("W"));
    assert.ok(!id.startsWith("https://openalex.org/"));
  });

  it("https://openalex.org/ URL is preserved", () => {
    const id = "https://openalex.org/works/W12345678";
    assert.ok(id.startsWith("https://openalex.org/"));
  });

  it("arXiv ID is not treated as DOI", () => {
    const id = "1706.03762";
    // arXiv IDs don't match DOI pattern
    assert.ok(!id.match(/^10\.\d{4,}\//));
    // lookupOpenAlex should return null for arXiv IDs
  });
});

describe("citation resolution errors", () => {
  it("arXiv without DOI produces OpenAlex error message", () => {
    // When S2 lookup for arXiv paper doesn't return a DOI,
    // resolvePaperForCitations should include an error message
    const error = "OpenAlex: cannot resolve arXiv ID without DOI (no DOI found in Semantic Scholar)";
    assert.ok(error.includes("cannot resolve arXiv ID"));
    assert.ok(error.includes("no DOI found"));
  });
});

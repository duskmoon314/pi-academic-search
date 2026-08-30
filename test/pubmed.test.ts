import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPaperResult, parsePubmedSummaries } from "../src/providers/pubmed.ts";

/**
 * PubMed response parsing tests using real API response samples.
 * Tests the real `toPaperResult` and `parsePubmedSummaries` functions.
 * No live requests — uses fixture data to verify parsing logic.
 */

// --- Fixtures: real PubMed API response samples ---

const ESUMMARY_FIXTURE = {
  result: {
    uids: ["38273037", "37937655"],
    "38273037": {
      uid: "38273037",
      title: "Large language models in medicine: current status and future prospects.",
      sortpubdate: "2024/01/25",
      source: "Nat Med",
      fulljournalname: "Nature medicine",
      authors: [
        { name: "Thirunavukarasu AJ", authtype: "Author" },
        { name: "Ting DSJ", authtype: "Author" },
        { name: "Gopinath K", authtype: "Author" },
        { name: "Bhatt R", authtype: "Author" },
        { name: "Tan TF", authtype: "Author" },
      ],
      articleids: [
        { idtype: "pubmed", value: "38273037" },
        { idtype: "doi", value: "10.1038/s41591-023-02448-8" },
        { idtype: "pii", value: "10.1038/s41591-023-02448-8" },
      ],
      volume: "30",
      issue: "1",
      pages: "11-23",
      elocationid: "10.1038/s41591-023-02448-8",
    },
    "37937655": {
      uid: "37937655",
      title: "ChatGPT and other large language models are double-edged swords.",
      sortpubdate: "2023/11",
      source: "Radiology",
      fulljournalname: "Radiology",
      authors: [
        { name: "Shen Y", authtype: "Author" },
        { name: "Heacock L", authtype: "Author" },
        { name: "Elias J", authtype: "Author" },
        { name: "Hentel KD", authtype: "Author" },
        { name: "Reig B", authtype: "Author" },
        { name: "Shih G", authtype: "Author" },
        { name: "Moy L", authtype: "Author" },
      ],
      articleids: [
        { idtype: "pubmed", value: "37937655" },
        { idtype: "doi", value: "10.1148/radiol.230823" },
      ],
      volume: "309",
      issue: "2",
      pages: "e230823",
      elocationid: "10.1148/radiol.230823",
    },
  },
};

describe("PubMed esummary parsing (real toPaperResult)", () => {
  it("parses multi-author paper with DOI", () => {
    const item = ESUMMARY_FIXTURE.result!["38273037"] as any;
    const paper = toPaperResult(item);
    assert.ok(paper);
    assert.equal(paper.title, "Large language models in medicine: current status and future prospects.");
    assert.equal(paper.authors.length, 5);
    assert.equal(paper.authors[0], "Thirunavukarasu AJ");
    assert.equal(paper.year, 2024);
    assert.equal(paper.venue, "Nature medicine");
    assert.equal(paper.doi, "10.1038/s41591-023-02448-8");
    assert.equal(paper.pmid, "38273037");
    assert.equal(paper.landingPageUrl, "https://pubmed.ncbi.nlm.nih.gov/38273037/");
    assert.deepEqual(paper.sources, ["pubmed"]);
    assert.equal(paper.sourceUrl, "https://pubmed.ncbi.nlm.nih.gov/38273037/");
    assert.equal(paper.abstract, undefined); // esummary has no abstract
    assert.equal(paper.citationCount, undefined);
    assert.equal(paper.isOpenAccess, false); // PubMed doesn't indicate OA in esummary
  });

  it("parses second paper correctly", () => {
    const item = ESUMMARY_FIXTURE.result!["37937655"] as any;
    const paper = toPaperResult(item);
    assert.ok(paper);
    assert.equal(paper.title, "ChatGPT and other large language models are double-edged swords.");
    assert.equal(paper.authors.length, 7);
    assert.equal(paper.year, 2023);
    assert.equal(paper.venue, "Radiology");
    assert.equal(paper.doi, "10.1148/radiol.230823");
    assert.equal(paper.pmid, "37937655");
  });

  it("returns null for item with missing title", () => {
    const paper = toPaperResult({ uid: "12345" } as any);
    assert.equal(paper, null);
  });

  it("returns null for item with missing uid", () => {
    const paper = toPaperResult({ title: "Test" } as any);
    assert.equal(paper, null);
  });

  it("handles missing authors", () => {
    const paper = toPaperResult({ uid: "12345", title: "No Authors Paper" } as any);
    assert.ok(paper);
    assert.deepEqual(paper.authors, []);
  });

  it("handles missing sortpubdate", () => {
    const paper = toPaperResult({ uid: "12345", title: "No Date Paper" } as any);
    assert.ok(paper);
    assert.equal(paper.year, undefined);
  });

  it("handles malformed sortpubdate", () => {
    const paper = toPaperResult({ uid: "12345", title: "Bad Date Paper", sortpubdate: "unknown" } as any);
    assert.ok(paper);
    assert.equal(paper.year, undefined);
  });

  it("extracts PMID from uid fallback when articleids missing", () => {
    const paper = toPaperResult({
      uid: "99999",
      title: "Fallback PMID",
      articleids: [],
    } as any);
    assert.ok(paper);
    assert.equal(paper.pmid, "99999");
    assert.equal(paper.landingPageUrl, "https://pubmed.ncbi.nlm.nih.gov/99999/");
  });

  it("prioritizes fulljournalname over source", () => {
    const paper = toPaperResult({
      uid: "123",
      title: "Journal Test",
      source: "JAB",
      fulljournalname: "Journal of Applied Biology",
    } as any);
    assert.ok(paper);
    assert.equal(paper.venue, "Journal of Applied Biology");
  });

  it("falls back to source when fulljournalname missing", () => {
    const paper = toPaperResult({
      uid: "123",
      title: "Source Fallback",
      source: "Nat Med",
    } as any);
    assert.ok(paper);
    assert.equal(paper.venue, "Nat Med");
  });
});

describe("PubMed parsePubmedSummaries (real function)", () => {
  it("parses full esummary response", () => {
    const papers = parsePubmedSummaries(ESUMMARY_FIXTURE as any);
    assert.equal(papers.length, 2);
    assert.equal(papers[0]!.pmid, "38273037");
    assert.equal(papers[1]!.pmid, "37937655");
  });

  it("handles empty uids", () => {
    const papers = parsePubmedSummaries({ result: { uids: [] } } as any);
    assert.equal(papers.length, 0);
  });

  it("handles missing result", () => {
    const papers = parsePubmedSummaries({} as any);
    assert.equal(papers.length, 0);
  });

  it("skips non-object entries in result", () => {
    const papers = parsePubmedSummaries({
      result: {
        uids: ["123"],
        "123": "not-an-object",
      },
    } as any);
    assert.equal(papers.length, 0);
  });
});

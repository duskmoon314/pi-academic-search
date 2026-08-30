import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deduplicatePapers, normalizeDoi, normalizeArxivId, normalizeTitle } from "../src/dedupe.ts";
import type { PaperResult } from "../src/types.ts";

function makePaper(overrides: Partial<PaperResult> = {}): PaperResult {
  return {
    id: "test",
    title: "Test Paper",
    authors: ["Alice"],
    isOpenAccess: false,
    sources: ["semantic"],
    sourceUrl: "",
    ...overrides,
  };
}

describe("normalizeDoi", () => {
  it("lowercases and strips https://doi.org/ prefix", () => {
    assert.equal(normalizeDoi("https://doi.org/10.1234/ABCD"), "10.1234/abcd");
  });

  it("strips http://dx.doi.org/ prefix", () => {
    assert.equal(normalizeDoi("http://dx.doi.org/10.5555/test"), "10.5555/test");
  });

  it("returns null for undefined", () => {
    assert.equal(normalizeDoi(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.equal(normalizeDoi(""), null);
  });

  it("trims whitespace", () => {
    assert.equal(normalizeDoi("  10.1234/test  "), "10.1234/test");
  });
});

describe("normalizeArxivId", () => {
  it("strips arxiv: prefix (case-insensitive)", () => {
    assert.equal(normalizeArxivId("ARXIV:1706.03762"), "1706.03762");
    assert.equal(normalizeArxivId("arxiv:1706.03762"), "1706.03762");
  });

  it("strips version suffix", () => {
    assert.equal(normalizeArxivId("1706.03762v3"), "1706.03762");
  });

  it("handles prefix and version together", () => {
    assert.equal(normalizeArxivId("arxiv:1706.03762v1"), "1706.03762");
  });

  it("returns null for undefined", () => {
    assert.equal(normalizeArxivId(undefined), null);
  });
});

describe("normalizeTitle", () => {
  it("lowercases and removes non-alphanumeric", () => {
    assert.equal(normalizeTitle("Attention Is All You Need!"), "attention is all you need");
  });

  it("collapses whitespace", () => {
    assert.equal(normalizeTitle("  Hello   World  "), "hello world");
  });

  it("returns null for undefined", () => {
    assert.equal(normalizeTitle(undefined), null);
  });
});

describe("deduplicatePapers", () => {
  it("merges papers with same DOI", () => {
    const papers = [
      makePaper({ doi: "10.1234/test", sources: ["semantic"], citationCount: 10 }),
      makePaper({ doi: "10.1234/test", sources: ["openalex"], citationCount: 20 }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources, ["semantic", "openalex"]);
    assert.equal(result[0].citationCount, 20); // max
  });

  it("merges papers with same DOI (case-insensitive, URL prefix)", () => {
    const papers = [
      makePaper({ doi: "https://doi.org/10.1234/Test", sources: ["crossref"] }),
      makePaper({ doi: "10.1234/test", sources: ["semantic"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources, ["crossref", "semantic"]);
  });

  it("merges papers with same arXiv ID", () => {
    const papers = [
      makePaper({ arxivId: "1706.03762v1", sources: ["arxiv"] }),
      makePaper({ arxivId: "arxiv:1706.03762v2", sources: ["semantic"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources, ["arxiv", "semantic"]);
  });

  it("merges papers with same normalized title", () => {
    const papers = [
      makePaper({ title: "Attention Is All You Need!", sources: ["semantic"] }),
      makePaper({ title: "Attention is all you need", sources: ["openalex"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources, ["semantic", "openalex"]);
  });

  it("keeps distinct papers separate", () => {
    const papers = [
      makePaper({ doi: "10.1111/a", title: "Paper A", sources: ["semantic"] }),
      makePaper({ doi: "10.1111/b", title: "Paper B", sources: ["openalex"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 2);
  });

  it("fills missing fields from merged source", () => {
    const papers = [
      makePaper({
        doi: "10.1234/test",
        sources: ["semantic"],
        abstract: undefined,
        pdfUrl: undefined,
      }),
      makePaper({
        doi: "10.1234/test",
        sources: ["arxiv"],
        abstract: "This is the abstract",
        pdfUrl: "https://arxiv.org/pdf/test",
        isOpenAccess: true,
      }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 1);
    assert.equal(result[0].abstract, "This is the abstract");
    assert.equal(result[0].pdfUrl, "https://arxiv.org/pdf/test");
    assert.equal(result[0].isOpenAccess, true);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(deduplicatePapers([]), []);
  });

  it("registers incoming DOI keys after title merge", () => {
    // Paper A: title-only (no DOI)
    // Paper B: same title + has DOI
    // Paper C: same DOI as B but different title
    // B should merge into A by title, then C should merge by DOI
    const papers = [
      makePaper({ title: "A Very Long And Specific Title For Testing", sources: ["semantic"] }),
      makePaper({ title: "A Very Long And Specific Title For Testing", doi: "10.1234/merged", year: 2023, authors: ["Alice"], sources: ["openalex"] }),
      makePaper({ title: "Different Title Same DOI", doi: "10.1234/merged", sources: ["crossref"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources, ["semantic", "openalex", "crossref"]);
    assert.equal(result[0].doi, "10.1234/merged");
  });

  it("registers incoming arXiv keys after title merge", () => {
    const papers = [
      makePaper({ title: "Another Very Long Specific Title For Testing", year: 2023, authors: ["Alice"], sources: ["semantic"] }),
      makePaper({ title: "Another Very Long Specific Title For Testing", arxivId: "2301.07041", year: 2023, authors: ["Alice"], sources: ["arxiv"] }),
      makePaper({ title: "Third Different Title", arxivId: "2301.07041", sources: ["semantic"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources, ["semantic", "arxiv"]);
  });

  it("does not merge short titles (< 20 chars)", () => {
    const papers = [
      makePaper({ title: "Introduction", year: 2020, sources: ["semantic"] }),
      makePaper({ title: "Introduction", year: 2023, authors: ["Other"], sources: ["openalex"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 2);
  });

  it("merges long titles with year match", () => {
    const papers = [
      makePaper({ title: "A Comprehensive Study of Transformer Architecture Variants", year: 2023, sources: ["semantic"] }),
      makePaper({ title: "A Comprehensive Study of Transformer Architecture Variants", year: 2023, authors: ["Other"], sources: ["openalex"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 1);
  });

  it("merges long titles with author overlap", () => {
    const papers = [
      makePaper({ title: "A Comprehensive Study of Transformer Architecture Variants", year: 2020, authors: ["Alice Smith"], sources: ["semantic"] }),
      makePaper({ title: "A Comprehensive Study of Transformer Architecture Variants", year: 2023, authors: ["Alice Smith"], sources: ["openalex"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 1);
  });

  it("does not merge long titles with different year and no author overlap", () => {
    const papers = [
      makePaper({ title: "A Comprehensive Study of Transformer Architecture Variants", year: 2020, authors: ["Alice"], sources: ["semantic"] }),
      makePaper({ title: "A Comprehensive Study of Transformer Architecture Variants", year: 2023, authors: ["Bob"], sources: ["openalex"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 2);
  });

  it("does not merge long titles with no year data and different authors", () => {
    const papers = [
      makePaper({ title: "A Comprehensive Study of Transformer Architecture Variants", authors: ["Alice Smith"], sources: ["semantic"] }),
      makePaper({ title: "A Comprehensive Study of Transformer Architecture Variants", authors: ["Bob Jones"], sources: ["openalex"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 2);
  });

  it("handles Chinese titles correctly (Unicode-aware)", () => {
    const papers = [
      makePaper({ title: "基于深度学习的自然语言处理方法综述与未来展望研究", year: 2023, authors: ["张三"], sources: ["semantic"] }),
      makePaper({ title: "基于深度学习的自然语言处理方法综述与未来展望研究", year: 2023, authors: ["张三"], sources: ["openalex"] }),
    ];
    const result = deduplicatePapers(papers);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources, ["semantic", "openalex"]);
  });
});

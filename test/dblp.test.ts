import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPaperResult, parseDblpHits } from "../src/providers/dblp.ts";

/**
 * DBLP response parsing tests using real API response samples.
 * Tests the real `toPaperResult` and `parseDblpHits` functions.
 * No live requests — uses fixture data to verify parsing logic.
 */

// --- Fixture: real DBLP API response sample ---
const DBLP_FIXTURE = {
  result: {
    hits: {
      hit: [
        {
          info: {
            title: "Attention is All you Need",
            authors: {
              author: [
                { text: "Ashish Vaswani" },
                { text: "Noam Shazeer" },
                { text: "Niki Parmar" },
                { text: "Jakob Uszkoreit" },
                { text: "Llion Jones" },
                { text: "Aidan N. Gomez" },
                { text: "Lukasz Kaiser" },
                { text: "Illia Polosukhin" },
              ],
            },
            year: "2017",
            venue: "NIPS",
            url: "https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17",
            doi: "10.5555/3295222.3295349",
            ee: "https://arxiv.org/abs/1706.03762",
            type: "Conference and Workshop Papers",
          },
        },
        {
          info: {
            title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
            authors: {
              author: [
                { text: "Jacob Devlin" },
                { text: "Ming-Wei Chang" },
                { text: "Kenton Lee" },
                { text: "Kristina Toutanova" },
              ],
            },
            year: "2019",
            venue: "HLT-NAACL",
            url: "https://dblp.org/rec/conf/naacl/DevlinCLT19",
            doi: "10.18653/v1/N19-1423",
            ee: "https://aclanthology.org/N19-1423/",
            type: "Conference and Workshop Papers",
          },
        },
      ],
      "@total": "2",
      "@computed": "2",
    },
  },
};

// Fixture with a single-author paper (edge case: author is object, not array)
const DBLP_SINGLE_AUTHOR_FIXTURE = {
  result: {
    hits: {
      hit: [
        {
          info: {
            title: "A Test Paper",
            authors: {
              author: { text: "Solo Author" },
            },
            year: "2023",
            venue: "TestConf",
            url: "https://dblp.org/rec/test",
          },
        },
      ],
    },
  },
};

describe("DBLP response parsing (real toPaperResult)", () => {
  it("parses multi-author paper correctly", () => {
    const hit = DBLP_FIXTURE.result!.hits!.hit![0]!;
    const paper = toPaperResult(hit as any);
    assert.ok(paper);
    assert.equal(paper.title, "Attention is All you Need");
    assert.equal(paper.authors.length, 8);
    assert.equal(paper.authors[0], "Ashish Vaswani");
    assert.equal(paper.year, 2017);
    assert.equal(paper.venue, "NIPS");
    assert.equal(paper.doi, "10.5555/3295222.3295349");
    assert.equal(paper.landingPageUrl, "https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17");
    assert.equal(paper.sourceUrl, "https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17");
    assert.deepEqual(paper.sources, ["dblp"]);
    assert.equal(paper.isOpenAccess, false); // ee is NOT OA indicator
    assert.equal(paper.abstract, undefined); // DBLP has no abstracts
    assert.equal(paper.citationCount, undefined); // DBLP has no citation counts
  });

  it("parses second paper correctly", () => {
    const hit = DBLP_FIXTURE.result!.hits!.hit![1]!;
    const paper = toPaperResult(hit as any);
    assert.ok(paper);
    assert.equal(paper.title, "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding");
    assert.equal(paper.authors.length, 4);
    assert.equal(paper.authors[0], "Jacob Devlin");
    assert.equal(paper.year, 2019);
    assert.equal(paper.venue, "HLT-NAACL");
    assert.equal(paper.doi, "10.18653/v1/N19-1423");
  });

  it("handles single-author (object, not array) edge case", () => {
    const hit = DBLP_SINGLE_AUTHOR_FIXTURE.result!.hits!.hit![0]!;
    const paper = toPaperResult(hit as any);
    assert.ok(paper);
    assert.equal(paper.authors.length, 1);
    assert.equal(paper.authors[0], "Solo Author");
  });

  it("returns null for hit with missing title", () => {
    const paper = toPaperResult({ info: { authors: { author: [{ text: "Test" }] } } } as any);
    assert.equal(paper, null);
  });

  it("returns null for hit with no info", () => {
    const paper = toPaperResult({} as any);
    assert.equal(paper, null);
  });

  it("handles missing year gracefully", () => {
    const hit = {
      info: {
        title: "No Year Paper",
      },
    };
    const paper = toPaperResult(hit as any);
    assert.ok(paper);
    assert.equal(paper.year, undefined);
  });
});

describe("DBLP parseDblpHits (real function)", () => {
  it("parses full search response", () => {
    const papers = parseDblpHits(DBLP_FIXTURE as any);
    assert.equal(papers.length, 2);
    assert.equal(papers[0]!.title, "Attention is All you Need");
    assert.equal(papers[1]!.title, "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding");
  });

  it("applies year filter", () => {
    const papers = parseDblpHits(DBLP_FIXTURE as any, "2019");
    assert.equal(papers.length, 1);
    assert.equal(papers[0]!.year, 2019);
  });

  it("applies year range filter", () => {
    const papers = parseDblpHits(DBLP_FIXTURE as any, "2017-2018");
    assert.equal(papers.length, 1);
    assert.equal(papers[0]!.year, 2017);
  });

  it("returns empty for empty hits", () => {
    const papers = parseDblpHits({ result: { hits: { hit: [] } } } as any);
    assert.equal(papers.length, 0);
  });

  it("returns empty for missing hits", () => {
    const papers = parseDblpHits({} as any);
    assert.equal(papers.length, 0);
  });
});

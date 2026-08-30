import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PaperResult } from "../src/types.ts";

// --- A. 429 retry logic ---
import { fetchWithTimeout } from "../src/utils.ts";

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

describe("fetchWithTimeout 429 retry", () => {
  it("retries on 429 and returns successful response", async () => {
    let callCount = 0;
    const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      callCount++;
      if (callCount <= 2) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return new Response("ok", { status: 200 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const resp = await fetchWithTimeout("https://example.com", {}, undefined, undefined, { maxRetries: 3 });
      assert.equal(resp.status, 200);
      assert.equal(callCount, 3);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("respects Retry-After header (0 = immediate)", async () => {
    let callCount = 0;
    const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return new Response("ok", { status: 200 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const resp = await fetchWithTimeout("https://example.com", {}, undefined, undefined, { maxRetries: 2 });
      assert.equal(resp.status, 200);
      assert.equal(callCount, 2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("uses exponential backoff when no Retry-After header (mock setTimeout for instant)", async () => {
    // Mock setTimeout to execute callbacks immediately (no real wait)
    const origSetTimeout = globalThis.setTimeout;
    // @ts-ignore
    globalThis.setTimeout = (fn: Function, _ms?: number, ...args: any[]) => {
      fn(...args);
      return 0 as any;
    };
    let callCount = 0;
    const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      callCount++;
      if (callCount <= 2) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response("ok", { status: 200 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const resp = await fetchWithTimeout("https://example.com", {}, undefined, undefined, { maxRetries: 3 });
      assert.equal(resp.status, 200);
      assert.equal(callCount, 3);
    } finally {
      globalThis.fetch = origFetch;
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it("gives up after maxRetries and returns last 429", async () => {
    let callCount = 0;
    const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      callCount++;
      return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const resp = await fetchWithTimeout("https://example.com", {}, undefined, undefined, { maxRetries: 2 });
      assert.equal(resp.status, 429);
      assert.equal(callCount, 3); // initial + 2 retries
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("does not retry on non-429 errors", async () => {
    let callCount = 0;
    const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      callCount++;
      return new Response("server error", { status: 500 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const resp = await fetchWithTimeout("https://example.com", {}, undefined, undefined, { maxRetries: 3 });
      assert.equal(resp.status, 500);
      assert.equal(callCount, 1); // No retry for 500
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("aborts immediately on external signal during retry wait", async () => {
    let callCount = 0;
    const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      callCount++;
      return new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    const ac = new AbortController();
    // Abort after a very short time
    setTimeout(() => ac.abort(), 10);
    try {
      await assert.rejects(
        () => fetchWithTimeout("https://example.com", {}, ac.signal, undefined, { maxRetries: 3 }),
        (err: Error) => err.message.includes("aborted"),
      );
      assert.equal(callCount, 1); // Only one attempt before abort
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// --- B. buildArxivQuery ---
import { buildArxivQuery } from "../src/providers/arxiv.ts";

describe("buildArxivQuery", () => {
  it("passes through query with field prefix unchanged", () => {
    const result = buildArxivQuery("ti:machine learning");
    assert.equal(result, "ti:machine learning");
  });

  it("passes through query with boolean operator unchanged", () => {
    const result = buildArxivQuery("deep learning AND transformer");
    assert.equal(result, "deep learning AND transformer");
  });

  it("passes through query with OR unchanged", () => {
    const result = buildArxivQuery("neural network OR deep learning");
    assert.equal(result, "neural network OR deep learning");
  });

  it("passes through query with ANDNOT unchanged", () => {
    const result = buildArxivQuery("neural network ANDNOT convolutional");
    assert.equal(result, "neural network ANDNOT convolutional");
  });

  it("passes through query with abs: prefix unchanged", () => {
    const result = buildArxivQuery("abs:transformer attention");
    assert.equal(result, "abs:transformer attention");
  });

  it("constructs ti/abs query for plain text", () => {
    const result = buildArxivQuery("mixture of experts");
    assert.equal(result, 'ti:"mixture of experts" OR abs:"mixture of experts"');
  });

  it("wraps plain query with categories", () => {
    const result = buildArxivQuery("transformer", ["cs.CL", "cs.LG"]);
    assert.equal(result, '(ti:"transformer" OR abs:"transformer") AND (cat:cs.CL OR cat:cs.LG)');
  });

  it("wraps field-prefix query with categories", () => {
    const result = buildArxivQuery("ti:mixture of experts", ["cs.CL"]);
    assert.equal(result, "(ti:mixture of experts) AND (cat:cs.CL)");
  });

  it("returns plain query when categories is empty array", () => {
    const result = buildArxivQuery("attention", []);
    assert.equal(result, 'ti:"attention" OR abs:"attention"');
  });

  it("escapes double quotes in query", () => {
    const result = buildArxivQuery('test "quoted"');
    assert.equal(result, "ti:\"test 'quoted'\" OR abs:\"test 'quoted'\"");
  });

  it("returns plain query when categories is undefined", () => {
    const result = buildArxivQuery("test query");
    assert.equal(result, 'ti:"test query" OR abs:"test query"');
  });
});

// --- C. yearMatchesFilter ---
import { yearMatchesFilter } from "../src/utils.ts";

describe("yearMatchesFilter", () => {
  it("matches single year exactly", () => {
    assert.equal(yearMatchesFilter(2023, "2023"), true);
    assert.equal(yearMatchesFilter(2024, "2023"), false);
  });

  it("matches year in range", () => {
    assert.equal(yearMatchesFilter(2020, "2020-2024"), true);
    assert.equal(yearMatchesFilter(2022, "2020-2024"), true);
    assert.equal(yearMatchesFilter(2024, "2020-2024"), true);
    assert.equal(yearMatchesFilter(2025, "2020-2024"), false);
    assert.equal(yearMatchesFilter(2019, "2020-2024"), false);
  });

  it("preserves papers with no year field (undefined)", () => {
    assert.equal(yearMatchesFilter(undefined, "2023"), true);
    assert.equal(yearMatchesFilter(undefined, "2020-2024"), true);
  });
});

describe("post-dedupe year filter integration", () => {
  it("filters merged results by year while preserving papers without year", () => {
    const papers = [
      makePaper({ title: "A", year: 2023, sources: ["semantic"] }),
      makePaper({ title: "B", year: 2019, sources: ["arxiv"] }),
      makePaper({ title: "C", year: undefined, sources: ["crossref"] }),
      makePaper({ title: "D", year: 2022, sources: ["openalex"] }),
    ];
    const filtered = papers.filter((p) => yearMatchesFilter(p.year, "2020-2024"));
    assert.equal(filtered.length, 3); // A, C (no year preserved), D
    assert.deepEqual(filtered.map((p) => p.title), ["A", "C", "D"]);
  });

  it("single year filter preserves no-year papers", () => {
    const papers = [
      makePaper({ title: "A", year: 2023 }),
      makePaper({ title: "B", year: 2022 }),
      makePaper({ title: "C", year: undefined }),
    ];
    const filtered = papers.filter((p) => yearMatchesFilter(p.year, "2023"));
    assert.equal(filtered.length, 2); // A + C (no year)
    assert.deepEqual(filtered.map((p) => p.title), ["A", "C"]);
  });
});

// --- D. enrichAbstractsBatch ---
import { enrichAbstractsBatch } from "../src/providers/semanticscholar.ts";

describe("enrichAbstractsBatch", () => {
  it("returns original array when no papers need enrichment", async () => {
    const papers = [
      makePaper({ abstract: "Already has abstract", doi: "10.1234/test" }),
    ];
    const result = await enrichAbstractsBatch(papers);
    assert.equal(result, papers);
    assert.equal(result.length, 1);
  });

  it("returns original array when papers have no DOI", async () => {
    const papers = [
      makePaper({ abstract: undefined, doi: undefined }),
    ];
    const result = await enrichAbstractsBatch(papers);
    assert.equal(result, papers);
  });

  it("returns original array on fetch failure", async () => {
    const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      throw new Error("Network error");
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const papers = [
        makePaper({ abstract: undefined, doi: "10.1234/test" }),
      ];
      const result = await enrichAbstractsBatch(papers);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.abstract, undefined); // unchanged
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("enriches papers via batch API with mock fetch", async () => {
    let postedBody: string | undefined;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("paper/batch")) {
        postedBody = init?.body as string;
        return new Response(
          JSON.stringify([
            {
              externalIds: { DOI: "10.1234/test1" },
              abstract: "Enriched abstract for test1",
            },
            {
              externalIds: { DOI: "10.1234/test2" },
              abstract: "Enriched abstract for test2",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // For the API key resolution (if called)
      return new Response("{}", { status: 200 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const papers = [
        makePaper({ doi: "10.1234/test1", abstract: undefined, sources: ["crossref"] }),
        makePaper({ doi: "10.1234/test2", abstract: undefined, sources: ["dblp"] }),
        makePaper({ doi: "10.1234/test3", abstract: "Already has abstract" }),
      ];
      const result = await enrichAbstractsBatch(papers);

      assert.equal(result.length, 3);
      assert.equal(result[0]!.abstract, "Enriched abstract for test1");
      assert.equal(result[1]!.abstract, "Enriched abstract for test2");
      assert.equal(result[2]!.abstract, "Already has abstract");

      // Verify the batch request was made
      assert.ok(postedBody);
      const parsed = JSON.parse(postedBody);
      assert.deepEqual(parsed.ids, ["DOI:10.1234/test1", "DOI:10.1234/test2"]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("limits to 20 papers max", async () => {
    let postedBody: string | undefined;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("paper/batch")) {
        postedBody = init?.body as string;
        const ids = JSON.parse(postedBody!).ids;
        return new Response(
          JSON.stringify(ids.map(() => ({ externalIds: { DOI: "x" }, abstract: null }))),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const papers = Array.from({ length: 25 }, (_, i) =>
        makePaper({ doi: `10.1234/test${i}`, abstract: undefined }),
      );
      const result = await enrichAbstractsBatch(papers);
      assert.equal(result.length, 25);
      // Verify only 20 were sent
      assert.ok(postedBody);
      const parsed = JSON.parse(postedBody!);
      assert.equal(parsed.ids.length, 20);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("does not mutate the original papers array", async () => {
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("paper/batch")) {
        return new Response(
          JSON.stringify([
            { externalIds: { DOI: "10.1234/test1" }, abstract: "New abstract" },
          ]),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const originalPaper = makePaper({ doi: "10.1234/test1", abstract: undefined });
      const papers = [originalPaper];
      const result = await enrichAbstractsBatch(papers);

      assert.equal(result[0]!.abstract, "New abstract");
      assert.equal(originalPaper.abstract, undefined); // Original unchanged
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// --- E. ID routing ---
import { identifyId } from "../src/identify-id.ts";

describe("ID routing detection", () => {
  it("identifies bare DOI for routing", () => {
    const id = identifyId("10.1145/3292500.3330919");
    assert.ok(id);
    assert.equal(id.type, "doi");
  });

  it("identifies ARXIV prefix for routing", () => {
    const id = identifyId("ARXIV:2301.07041");
    assert.ok(id);
    assert.equal(id.type, "arxiv");
  });

  it("identifies bare arXiv ID for routing", () => {
    const id = identifyId("1706.03762");
    assert.ok(id);
    assert.equal(id.type, "arxiv");
  });

  it("returns null for natural language query (not an ID)", () => {
    assert.equal(identifyId("mixture of experts"), null);
    assert.equal(identifyId("transformer attention mechanism"), null);
    assert.equal(identifyId("deep learning survey 2024"), null);
  });

  it("returns null for empty query", () => {
    assert.equal(identifyId(""), null);
  });
});

// --- F. Source priority sorting ---
describe("source priority sorting", () => {
  it("sorts semantic before openalex before arxiv before crossref before dblp before pubmed", () => {
    const SOURCE_PRIORITY: Record<string, number> = {
      semantic: 0,
      openalex: 1,
      arxiv: 2,
      crossref: 3,
      dblp: 4,
      pubmed: 5,
    };

    const papers = [
      makePaper({ title: "pubmed paper", sources: ["pubmed"] }),
      makePaper({ title: "semantic paper", sources: ["semantic"] }),
      makePaper({ title: "dblp paper", sources: ["dblp"] }),
      makePaper({ title: "arxiv paper", sources: ["arxiv"] }),
      makePaper({ title: "openalex paper", sources: ["openalex"] }),
      makePaper({ title: "crossref paper", sources: ["crossref"] }),
    ];

    papers.sort((a, b) => {
      const pa = Math.min(...a.sources.map((s) => SOURCE_PRIORITY[s] ?? 99));
      const pb = Math.min(...b.sources.map((s) => SOURCE_PRIORITY[s] ?? 99));
      return pa - pb;
    });

    assert.deepEqual(papers.map((p) => p.sources[0]), [
      "semantic", "openalex", "arxiv", "crossref", "dblp", "pubmed",
    ]);
  });

  it("merged paper gets priority of its highest-priority source", () => {
    const SOURCE_PRIORITY: Record<string, number> = {
      semantic: 0,
      openalex: 1,
      arxiv: 2,
      crossref: 3,
      dblp: 4,
      pubmed: 5,
    };

    const papers = [
      makePaper({ title: "merged paper", sources: ["crossref", "semantic"] }),
      makePaper({ title: "openalex only", sources: ["openalex"] }),
    ];

    papers.sort((a, b) => {
      const pa = Math.min(...a.sources.map((s) => SOURCE_PRIORITY[s] ?? 99));
      const pb = Math.min(...b.sources.map((s) => SOURCE_PRIORITY[s] ?? 99));
      return pa - pb;
    });

    // The merged paper has semantic (priority 0), so it should come first
    assert.equal(papers[0]!.title, "merged paper");
    assert.equal(papers[1]!.title, "openalex only");
  });

  it("stable sort preserves relative order for same-priority papers", () => {
    const SOURCE_PRIORITY: Record<string, number> = {
      semantic: 0,
      openalex: 1,
      arxiv: 2,
      crossref: 3,
      dblp: 4,
      pubmed: 5,
    };

    const papers = [
      makePaper({ title: "First semantic", sources: ["semantic"] }),
      makePaper({ title: "Second semantic", sources: ["semantic"] }),
      makePaper({ title: "Third semantic", sources: ["semantic"] }),
    ];

    papers.sort((a, b) => {
      const pa = Math.min(...a.sources.map((s) => SOURCE_PRIORITY[s] ?? 99));
      const pb = Math.min(...b.sources.map((s) => SOURCE_PRIORITY[s] ?? 99));
      return pa - pb;
    });

    assert.deepEqual(
      papers.map((p) => p.title),
      ["First semantic", "Second semantic", "Third semantic"],
    );
  });
});

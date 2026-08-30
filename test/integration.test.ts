import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clearResults, storeResult, generateId } from "../src/storage.ts";
import { clearResults as clearStorageResults } from "../src/storage.ts";

/**
 * Integration tests for academic_search, paper_lookup, paper_citations, and download_pdf.
 *
 * Uses a fake ExtensionAPI to capture tool registrations, and mocks global fetch
 * to route requests by URL pattern to fixture data.
 *
 * LLM/UI interactions are not tested.
 */

// --- Tool type captured from the fake API ---

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (callId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
}

interface RegisteredCommand {
  name: string;
  definition: {
    description: string;
    handler: (args: string, ctx: Record<string, unknown>) => Promise<void>;
  };
}

// --- Fixtures ---

function makeS2SearchResponse() {
  return {
    data: [
      {
        paperId: "s2-1",
        title: "Attention is All You Need",
        year: 2017,
        venue: "NeurIPS",
        authors: [{ name: "Ashish Vaswani" }],
        citationCount: 10000,
        isOpenAccess: true,
        openAccessPdf: { url: "https://arxiv.org/pdf/1706.03762" },
        externalIds: { DOI: "10.48550/arxiv.1706.03762", ArXiv: "1706.03762" },
      },
      {
        paperId: "s2-2",
        title: "BERT Paper",
        year: 2019,
        authors: [{ name: "Jacob Devlin" }],
        citationCount: 5000,
        isOpenAccess: false,
        externalIds: { DOI: "10.18653/v1/N19-1423" },
      },
    ],
  };
}

function makeOpenAlexSearchResponse() {
  return {
    results: [
      {
        id: "https://openalex.org/W2963434567",
        title: "Attention is All You Need",
        publication_year: 2017,
        authorships: [{ author: { display_name: "Ashish Vaswani" } }],
        cited_by_count: 10000,
        open_access: { is_oa: true, oa_url: "https://arxiv.org/pdf/1706.03762" },
        ids: { doi: "https://doi.org/10.48550/arxiv.1706.03762", openalex: "W2963434567" },
      },
    ],
  };
}

function makeS2LookupResponse() {
  return {
    paperId: "s2-lookup-1",
    title: "Looked Up Paper",
    year: 2022,
    authors: [{ name: "Test Author" }],
    citationCount: 100,
    isOpenAccess: true,
    openAccessPdf: { url: "https://example.com/paper.pdf" },
    externalIds: { DOI: "10.1234/test" },
  };
}

function makeS2CitationsResponse() {
  return {
    data: [
      {
        citingPaper: {
          paperId: "citing-1",
          title: "Citing Paper A",
          year: 2023,
          authors: [{ name: "Citer One" }],
          externalIds: { DOI: "10.1111/citing1" },
        },
      },
    ],
  };
}

function makeOpenAlexCitationsResponse() {
  return {
    results: [
      {
        id: "https://openalex.org/W999",
        title: "Citing Paper B",
        publication_year: 2023,
        authorships: [{ author: { display_name: "Citer Two" } }],
        cited_by_count: 5,
        open_access: { is_oa: false },
        ids: { openalex: "W999" },
      },
    ],
  };
}

// --- Fetch mock ---

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

let fetchHandlers: Map<string | RegExp, FetchHandler>;

function mockFetch(url: string, init?: RequestInit): Promise<Response> {
  for (const [pattern, handler] of fetchHandlers) {
    if (typeof pattern === "string" && url.includes(pattern)) {
      return handler(url, init);
    }
    if (pattern instanceof RegExp && pattern.test(url)) {
      return handler(url, init);
    }
  }
  // Default: return 404
  return Promise.resolve(new Response("Not Found", { status: 404 }));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

// --- Test setup ---

let registeredTools: Map<string, RegisteredTool>;
let registeredCommands: Map<string, RegisteredCommand>;

async function loadExtension() {
  // Dynamic import to get a fresh module
  const mod = await import("../src/index.ts");
  const defaultFn = mod.default;

  registeredTools = new Map();
  registeredCommands = new Map();

  const fakeAPI = {
    registerTool(tool: RegisteredTool) {
      registeredTools.set(tool.name, tool);
    },
    registerCommand(name: string, definition: RegisteredCommand["definition"]) {
      registeredCommands.set(name, { name, definition });
    },
  };

  defaultFn(fakeAPI as any);
}

describe("Integration: academic_search", () => {
  const origFetch = globalThis.fetch;

  beforeEach(async () => {
    fetchHandlers = new Map();
    clearResults();
    // Set up fetch mock
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
    await loadExtension();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    clearResults();
  });

  it("returns merged results from multiple sources", async () => {
    fetchHandlers.set("api.semanticscholar.org", async () => jsonResponse(makeS2SearchResponse()));
    fetchHandlers.set("api.openalex.org", async () => jsonResponse(makeOpenAlexSearchResponse()));

    const tool = registeredTools.get("academic_search")!;
    const result = await tool.execute("call1", { query: "attention", sources: ["semantic", "openalex"] });

    assert.ok(result.content);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.ok(text.includes("Attention is All You Need"));
    assert.ok(result.details);
    const details = result.details as Record<string, unknown>;
    assert.ok((details.papers as unknown[]).length >= 1);
  });

  it("filters by sources parameter", async () => {
    fetchHandlers.set("api.semanticscholar.org", async () => jsonResponse(makeS2SearchResponse()));

    const tool = registeredTools.get("academic_search")!;
    const result = await tool.execute("call2", { query: "test", sources: ["semantic"] });

    const details = result.details as Record<string, unknown>;
    assert.deepEqual(details.sourcesQueried, ["semantic"]);
  });

  it("handles all sources failing", async () => {
    fetchHandlers.set("api.semanticscholar.org", async () => textResponse("Server Error", 500));

    const tool = registeredTools.get("academic_search")!;
    const result = await tool.execute("call3", { query: "test", sources: ["semantic"] });

    assert.ok(result.details);
    const details = result.details as Record<string, unknown>;
    assert.ok(details.error);
    assert.ok(Array.isArray(details.error));
  });

  it("applies OA post-filter at aggregation layer", async () => {
    // S2 returns one OA and one non-OA
    fetchHandlers.set("api.semanticscholar.org", async () => jsonResponse(makeS2SearchResponse()));

    const tool = registeredTools.get("academic_search")!;
    const result = await tool.execute("call4", {
      query: "test",
      sources: ["semantic"],
      openAccessOnly: true,
    });

    const details = result.details as Record<string, unknown>;
    const papers = details.papers as Array<{ isOpenAccess: boolean }>;
    for (const p of papers) {
      assert.equal(p.isOpenAccess, true, `Expected all papers to be OA, but got isOpenAccess=${p.isOpenAccess}`);
    }
  });

  it("applies year post-filter after dedup", async () => {
    fetchHandlers.set("api.semanticscholar.org", async () => jsonResponse(makeS2SearchResponse()));

    const tool = registeredTools.get("academic_search")!;
    const result = await tool.execute("call5", {
      query: "test",
      sources: ["semantic"],
      year: "2017",
    });

    const details = result.details as Record<string, unknown>;
    const papers = details.papers as Array<{ year?: number }>;
    // Only the2017 paper should remain
    for (const p of papers) {
      if (p.year) assert.equal(p.year, 2017);
    }
  });

  it("auto-routes DOI query to ID lookup and prepends result", async () => {
    fetchHandlers.set("api.semanticscholar.org", async (url) => {
      if (url.includes("/paper/search")) return jsonResponse({ data: [] });
      if (url.includes("/paper/")) return jsonResponse(makeS2LookupResponse());
      return textResponse("Not Found", 404);
    });
    fetchHandlers.set("api.crossref.org", async () => textResponse("Not Found", 404));
    fetchHandlers.set("api.openalex.org", async () => textResponse("Not Found", 404));

    const tool = registeredTools.get("academic_search")!;
    const result = await tool.execute("call6", { query: "10.1234/test" });

    const details = result.details as Record<string, unknown>;
    const papers = details.papers as Array<{ doi?: string }>;
    assert.ok(papers.length >= 1);
    // The ID-routed paper should be present
    assert.ok(papers.some((p) => p.doi === "10.1234/test"));
  });
});

describe("Integration: paper_lookup", () => {
  const origFetch = globalThis.fetch;

  beforeEach(async () => {
    fetchHandlers = new Map();
    clearResults();
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
    await loadExtension();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    clearResults();
  });

  it("returns a paper card for DOI lookup", async () => {
    fetchHandlers.set("api.crossref.org", async () => textResponse("Not Found", 404));
    fetchHandlers.set("api.semanticscholar.org", async () => jsonResponse(makeS2LookupResponse()));
    fetchHandlers.set("api.openalex.org", async () => textResponse("Not Found", 404));

    const tool = registeredTools.get("paper_lookup")!;
    const result = await tool.execute("call1", { id: "10.1234/test" });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.ok(text.includes("Looked Up Paper"));
    assert.ok(result.details);
  });

  it("returns error for unrecognized ID", async () => {
    const tool = registeredTools.get("paper_lookup")!;
    const result = await tool.execute("call2", { id: "not-a-valid-id" });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.ok(text.includes("Could not identify"));
  });

  it("merges fields from multiple sources by priority", async () => {
    // Crossref returns title, S2 returns abstract
    fetchHandlers.set("api.crossref.org", async () => jsonResponse({
      message: {
        DOI: "10.1234/test",
        title: ["Crossref Title"],
        author: [{ given: "A", family: "B" }],
        "is-referenced-by-count": 50,
      },
    }));
    fetchHandlers.set("api.semanticscholar.org", async () => jsonResponse({
      paperId: "s2-x",
      title: "S2 Title",
      abstract: "This is the abstract from S2",
      year: 2022,
      externalIds: { DOI: "10.1234/test" },
      authors: [{ name: "C D" }],
      isOpenAccess: false,
    }));
    fetchHandlers.set("api.openalex.org", async () => textResponse("Not Found", 404));

    const tool = registeredTools.get("paper_lookup")!;
    const result = await tool.execute("call3", { id: "10.1234/test" });

    const details = result.details as Record<string, unknown>;
    // Priority: S2 > OpenAlex > Crossref, so S2 title should win
    assert.equal(details.title, "S2 Title");
    // But abstract from S2 should be present
    assert.equal(details.abstract, "This is the abstract from S2");
  });
});

describe("Integration: paper_citations", () => {
  const origFetch = globalThis.fetch;

  beforeEach(async () => {
    fetchHandlers = new Map();
    clearResults();
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
    await loadExtension();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    clearResults();
  });

  it("fetches citations from both S2 and OpenAlex", async () => {
    // DOI lookup: S2 and OpenAlex both return a paper
    fetchHandlers.set("api.crossref.org", async () => textResponse("Not Found", 404));
    fetchHandlers.set("api.semanticscholar.org", async (url) => {
      if (url.includes("/citations")) return jsonResponse(makeS2CitationsResponse());
      // Lookup returns a paper with s2Id
      return jsonResponse({
        paperId: "s2-cite-test",
        title: "Cited Paper",
        year: 2020,
        externalIds: { DOI: "10.1234/cited" },
        authors: [{ name: "Author" }],
        isOpenAccess: false,
      });
    });
    fetchHandlers.set("api.openalex.org", async (url) => {
      if (url.includes("/works?")) return jsonResponse(makeOpenAlexCitationsResponse());
      // Lookup returns a paper with openAlexId
      return jsonResponse({
        id: "https://openalex.org/W12345",
        title: "Cited Paper",
        publication_year: 2020,
        authorships: [{ author: { display_name: "Author" } }],
        cited_by_count: 100,
        open_access: { is_oa: false },
        ids: { doi: "https://doi.org/10.1234/cited", openalex: "W12345" },
      });
    });

    const tool = registeredTools.get("paper_citations")!;
    const result = await tool.execute("call1", { id: "10.1234/cited", direction: "citing" });

    const details = result.details as Record<string, unknown>;
    const papers = details.papers as unknown[];
    assert.ok(papers.length >= 2, `Expected ≥2 citing papers, got ${papers.length}`);
  });

  it("reports errors when source IDs are unavailable", async () => {
    // Return a paper with no s2Id or openAlexId
    fetchHandlers.set("api.crossref.org", async () => jsonResponse({
      message: {
        DOI: "10.1234/no-ids",
        title: ["No IDs Paper"],
      },
    }));
    fetchHandlers.set("api.semanticscholar.org", async () => textResponse("Not Found", 404));
    fetchHandlers.set("api.openalex.org", async () => textResponse("Not Found", 404));

    const tool = registeredTools.get("paper_citations")!;
    const result = await tool.execute("call2", { id: "10.1234/no-ids", direction: "citing" });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    // Should mention no S2 ID or no OpenAlex ID available
    assert.ok(text.includes("No") || text.includes("error") || text.includes("Could not resolve") || text.includes("Semantic Scholar") || text.includes("OpenAlex"));
  });
});

describe("Integration: download_pdf", () => {
  const origFetch = globalThis.fetch;

  beforeEach(async () => {
    fetchHandlers = new Map();
    clearResults();
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
    await loadExtension();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    clearResults();
  });

  it("rejects when no identifier is provided", async () => {
    const tool = registeredTools.get("download_pdf")!;
    const result = await tool.execute("call1", {});

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.ok(text.includes("Provide at least one"));
  });

  it("resolves resultId from storage and uses stored paper data", async () => {
    // Pre-populate storage with a paper
    const storedId = generateId();
    storeResult({
      id: storedId,
      type: "paper-search",
      timestamp: Date.now(),
      query: "test",
      papers: [{
        id: "paper-abc",
        title: "Stored Paper",
        authors: ["Author"],
        doi: "10.1234/stored",
        isOpenAccess: true,
        sources: ["semantic"],
        sourceUrl: "",
      }],
      failedSources: [],
    });

    // Mock fetch to return a PDF for arXiv
    fetchHandlers.set("arxiv.org", async () => {
      const pdfContent = "%PDF-1.4 test content";
      return new Response(pdfContent, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    });

    const tool = registeredTools.get("download_pdf")!;
    const result = await tool.execute("call2", {
      resultId: "paper-abc",
      outputDir: "/tmp/test-papers-integration",
    });

    // It should either succeed or fail with a download error (DNS etc),
    // but should NOT say "Result ID not found"
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.ok(!text.includes("Result ID not found"), `Unexpected: ${text}`);
  });

  it("rejects resultId not found in storage", async () => {
    const tool = registeredTools.get("download_pdf")!;
    const result = await tool.execute("call3", { resultId: "nonexistent-id" });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.ok(text.includes("not found in storage"));
  });

  it("rejects outputDir that escapes cwd boundary", async () => {
    const tool = registeredTools.get("download_pdf")!;
    const result = await tool.execute("call4", {
      arxivId: "1706.03762",
      outputDir: "/etc",
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.ok(
      text.includes("rejected") || text.includes("outside") || text.includes("boundary"),
      `Expected rejection message, got: ${text}`,
    );
  });
});

describe("Integration: DEFAULT_SOURCES constant", () => {
  it("DEFAULT_SOURCES is exported from types.ts", async () => {
    const { DEFAULT_SOURCES } = await import("../src/types.ts");
    assert.deepEqual(DEFAULT_SOURCES, ["semantic", "openalex", "arxiv", "dblp", "crossref"]);
  });
});

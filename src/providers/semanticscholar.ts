import { existsSync, readFileSync } from "node:fs";
import type { PaperResult, SearchOptions } from "../types.ts";
import { hasCredentialSource, resolveCredential } from "../credential-source.ts";
import { fetchWithTimeout, getAcademicSearchConfigPath, redactCredential } from "../utils.ts";

const S2_API_BASE = "https://api.semanticscholar.org/graph/v1";
const SEARCH_TIMEOUT_MS = 30_000;

const S2_FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "venue",
  "authors",
  "citationCount",
  "referenceCount",
  "influentialCitationCount",
  "isOpenAccess",
  "openAccessPdf",
  "externalIds",
].join(",");

interface S2Author {
  name?: string;
}

interface S2Paper {
  paperId?: string;
  title?: string;
  abstract?: string;
  year?: number;
  venue?: string;
  authors?: S2Author[];
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
  isOpenAccess?: boolean;
  openAccessPdf?: { url?: string };
  externalIds?: {
    DOI?: string;
    ArXiv?: string;
    PubMed?: string;
  };
}

interface S2SearchResponse {
  data?: S2Paper[];
  total?: number;
  message?: string;
}

interface S2Config {
  semanticScholarApiKey?: unknown;
}

let cachedConfig: S2Config | null = null;

function loadConfig(): S2Config {
  if (cachedConfig) return cachedConfig;
  const configPath = getAcademicSearchConfigPath();
  if (!existsSync(configPath)) {
    cachedConfig = {};
    return cachedConfig;
  }
  try {
    cachedConfig = JSON.parse(readFileSync(configPath, "utf-8")) as S2Config;
    return cachedConfig;
  } catch {
    cachedConfig = {};
    return cachedConfig;
  }
}

/** Reset all cached config/credential state. Call after config changes. */
export function resetS2Cache(): void {
  cachedConfig = null;
  cachedApiKey = undefined;
  apiKeyResolved = false;
}

let cachedApiKey: string | undefined;
let apiKeyResolved = false;

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
  if (apiKeyResolved) return cachedApiKey ?? null;
  const key = await resolveCredential({
    provider: "SemanticScholar",
    configuredValue: loadConfig().semanticScholarApiKey,
    environmentValue: process.env.S2_API_KEY,
    signal,
  });
  cachedApiKey = key ?? undefined;
  apiKeyResolved = true;
  return key;
}

/** Check if Semantic Scholar is available (always true — no key required). */
export function isSemanticScholarAvailable(): boolean {
  // S2 works without a key, just with lower rate limits
  return true;
}

/** Resolve the API key synchronously from config (for rate limiter setup). */
export function hasS2Key(): boolean {
  return hasCredentialSource({
    provider: "SemanticScholar",
    configuredValue: loadConfig().semanticScholarApiKey,
    environmentValue: process.env.S2_API_KEY,
  });
}

function toPaperResult(paper: S2Paper): PaperResult {
  const authors = (paper.authors ?? [])
    .map((a) => a.name ?? "")
    .filter((name) => name.length > 0);

  const extIds = paper.externalIds ?? {};
  return {
    id: "", // assigned by storage
    title: paper.title ?? "Untitled",
    authors,
    year: paper.year ?? undefined,
    venue: paper.venue ?? undefined,
    abstract: paper.abstract ?? undefined,
    doi: extIds.DOI ?? undefined,
    arxivId: extIds.ArXiv ?? undefined,
    pmid: extIds.PubMed ?? undefined,
    s2Id: paper.paperId ?? undefined,
    citationCount: paper.citationCount ?? undefined,
    referenceCount: paper.referenceCount ?? undefined,
    influentialCitationCount: paper.influentialCitationCount ?? undefined,
    isOpenAccess: paper.isOpenAccess ?? false,
    pdfUrl: paper.openAccessPdf?.url ?? undefined,
    landingPageUrl: undefined,
    sources: ["semantic"],
    sourceUrl: paper.paperId
      ? `https://www.semanticscholar.org/paper/${paper.paperId}`
      : "",
  };
}

/** Search Semantic Scholar for papers matching a query. */
export async function searchSemanticScholar(
  query: string,
  options: SearchOptions,
): Promise<PaperResult[]> {
  const params = new URLSearchParams({
    query,
    fields: S2_FIELDS,
    limit: String(Math.min(options.limit, 100)),
  });

  if (options.year) {
    params.set("year", options.year);
  }
  if (options.openAccessOnly) {
    params.set("openAccessPdf", "");
  }

  const apiKey = await getApiKey(options.signal);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const url = `${S2_API_BASE}/paper/search?${params}`;
  const response = await fetchWithTimeout(
    url,
    { headers },
    options.signal,
    "semantic",
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const redacted = redactCredential(errorText, apiKey);
    throw new Error(`Semantic Scholar API error ${response.status}: ${redacted.slice(0, 200)}`);
  }

  const data = await response.json() as S2SearchResponse;
  if (!data.data || data.data.length === 0) {
    return [];
  }

  return data.data.map(toPaperResult);
}

/** Look up a single paper by ID (DOI, ARXIV:xxx, PMID:xxx, or S2 paperId). */
export async function lookupSemanticScholar(
  id: string,
  signal?: AbortSignal,
): Promise<PaperResult | null> {
  const apiKey = await getApiKey(signal);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const url = `${S2_API_BASE}/paper/${encodeURIComponent(id)}?fields=${S2_FIELDS}`;
  const response = await fetchWithTimeout(url, { headers }, signal, "semantic");

  if (response.status === 404) return null;
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const redacted = redactCredential(errorText, apiKey);
    throw new Error(`Semantic Scholar lookup error ${response.status}: ${redacted.slice(0, 200)}`);
  }

  const paper = await response.json() as S2Paper;
  return toPaperResult(paper);
}

/**
 * Parse an S2 citations/references response into PaperResult[].
 * Exported for testing.
 *
 * S2 citations endpoint returns `{ data: [{ citingPaper: {...} }] }`.
 * S2 references endpoint returns `{ data: [{ citedPaper: {...} }] }`.
 */
export function parseS2Citations(
  direction: "citing" | "references",
  data: { data?: Array<Record<string, unknown>> },
): PaperResult[] {
  const nestedKey = direction === "citing" ? "citingPaper" : "citedPaper";
  const items = data.data ?? [];
  const results: PaperResult[] = [];

  for (const item of items) {
    const raw = item[nestedKey];
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const extIds = (p.externalIds ?? {}) as Record<string, string>;
    const authorsList = ((p.authors ?? []) as Array<{ name?: string }>)
      .map((a) => a.name ?? "").filter((n) => n.length > 0);
    results.push({
      id: "",
      title: (p.title as string) ?? "Untitled",
      authors: authorsList,
      year: p.year as number | undefined,
      venue: p.venue as string | undefined,
      abstract: p.abstract as string | undefined,
      doi: extIds.DOI,
      arxivId: extIds.ArXiv,
      pmid: extIds.PubMed,
      s2Id: p.paperId as string | undefined,
      citationCount: p.citationCount as number | undefined,
      referenceCount: p.referenceCount as number | undefined,
      isOpenAccess: (p.isOpenAccess as boolean) ?? false,
      pdfUrl: (p.openAccessPdf as { url?: string } | undefined)?.url,
      landingPageUrl: undefined,
      sources: ["semantic"],
      sourceUrl: p.paperId
        ? `https://www.semanticscholar.org/paper/${p.paperId}`
        : "",
    });
  }

  return results;
}

/**
 * Get citations or references for a paper via Semantic Scholar.
 *
 * S2 citations endpoint returns `{ data: [{ citingPaper: {...} }] }`.
 * S2 references endpoint returns `{ data: [{ citedPaper: {...} }] }`.
 */
export async function citationsSemanticScholar(
  s2Id: string,
  direction: "citing" | "references",
  limit: number,
  signal?: AbortSignal,
): Promise<PaperResult[]> {
  const endpoint = direction === "citing" ? "citations" : "references";
  const url = `${S2_API_BASE}/paper/${encodeURIComponent(s2Id)}/${endpoint}?fields=${S2_FIELDS}&limit=${limit}`;

  const apiKey = await getApiKey(signal);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const response = await fetchWithTimeout(url, { headers }, signal, "semantic");
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const redacted = redactCredential(errorText, apiKey);
    throw new Error(`S2 ${endpoint} API error ${response.status}: ${redacted.slice(0, 200)}`);
  }

  const data = await response.json() as { data?: Array<Record<string, unknown>> };
  return parseS2Citations(direction, data);
}

/**
 * Enrich papers that are missing abstracts using the Semantic Scholar batch API.
 *
 * Collects up to 20 papers with missing abstracts and a DOI, sends them
 * in a single POST to the batch endpoint, and backfills abstracts by DOI.
 * Any failure silently returns the original array unchanged.
 */
export async function enrichAbstractsBatch(
  papers: PaperResult[],
  signal?: AbortSignal,
): Promise<PaperResult[]> {
  // Collect papers missing abstracts that have a DOI
  const toEnrich: Array<{ index: number; doi: string }> = [];
  for (let i = 0; i < papers.length; i++) {
    const p = papers[i]!;
    if (!p.abstract && p.doi) {
      toEnrich.push({ index: i, doi: p.doi });
    }
    if (toEnrich.length >= 20) break;
  }

  if (toEnrich.length === 0) return papers;

  try {
    const apiKey = await getApiKey(signal);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const ids = toEnrich.map((e) => `DOI:${e.doi}`);
    const params = new URLSearchParams({ fields: "abstract,externalIds" });
    const url = `https://api.semanticscholar.org/graph/v1/paper/batch?${params}`;

    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ids }),
      },
      signal,
      "semantic",
    );

    if (!response.ok) return papers;

    const results = await response.json() as Array<{
      externalIds?: { DOI?: string };
      abstract?: string | null;
    } | null>;

    // Build DOI → abstract map
    const abstractByDoi = new Map<string, string>();
    for (const item of results) {
      if (item?.abstract && item.externalIds?.DOI) {
        abstractByDoi.set(item.externalIds.DOI.toLowerCase(), item.abstract);
      }
    }

    if (abstractByDoi.size === 0) return papers;

    // Backfill — clone array to avoid mutating caller's refs
    const enriched = [...papers];
    for (const { index, doi } of toEnrich) {
      const abs = abstractByDoi.get(doi.toLowerCase());
      if (abs && enriched[index]) {
        enriched[index] = { ...enriched[index]!, abstract: abs };
      }
    }

    return enriched;
  } catch {
    return papers;
  }
}

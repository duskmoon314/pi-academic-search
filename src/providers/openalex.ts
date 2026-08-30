import { existsSync, readFileSync } from "node:fs";
import type { PaperResult, SearchOptions } from "../types.ts";
import { hasCredentialSource, resolveCredential } from "../credential-source.ts";
import { fetchWithTimeout, getAcademicSearchConfigPath, redactCredential } from "../utils.ts";
import { RateLimiter } from "../rate-limit.ts";

const OPENALEX_API_BASE = "https://api.openalex.org";

interface OpenAlexAuthor {
  author?: { display_name?: string };
}

interface OpenAlexIds {
  doi?: string;
  openalex?: string;
  pmid?: string;
}

interface OpenAlexWork {
  id?: string;
  title?: string;
  display_name?: string;
  publication_year?: number;
  primary_location?: {
    source?: { display_name?: string };
    landing_page_url?: string;
    pdf_url?: string;
  };
  authorships?: OpenAlexAuthor[];
  cited_by_count?: number;
  referenced_works_count?: number;
  open_access?: {
    is_oa?: boolean;
    oa_url?: string;
  };
  ids?: OpenAlexIds;
  abstract_inverted_index?: Record<string, number[]>;
}

interface OpenAlexSearchResponse {
  results?: OpenAlexWork[];
  meta?: { count?: number };
}

interface OpenAlexConfig {
  openAlexMailto?: unknown;
  openAlexApiKey?: unknown;
}

let cachedConfig: OpenAlexConfig | null = null;

function loadConfig(): OpenAlexConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = getAcademicSearchConfigPath();
  if (!existsSync(configPath)) {
    cachedConfig = {};
    return cachedConfig;
  }
  try {
    cachedConfig = JSON.parse(readFileSync(configPath, "utf-8")) as OpenAlexConfig;
    return cachedConfig;
  } catch {
    cachedConfig = {};
    return cachedConfig;
  }
}

let openAlexLimiter = new RateLimiter(100);

/** Reset all cached config/credential state. Call after config changes. */
export function resetOpenAlexCache(): void {
  cachedConfig = null;
  cachedApiKey = undefined;
  apiKeyResolved = false;
  cachedMailto = undefined;
  mailtoResolved = false;
  openAlexLimiter = new RateLimiter(100);
}

let cachedApiKey: string | undefined;
let apiKeyResolved = false;

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
  if (apiKeyResolved) return cachedApiKey ?? null;
  const key = await resolveCredential({
    provider: "OpenAlex",
    configuredValue: loadConfig().openAlexApiKey,
    environmentValue: process.env.OPENALEX_API_KEY,
    signal,
  });
  cachedApiKey = key ?? undefined;
  apiKeyResolved = true;
  return key;
}

let cachedMailto: string | undefined;
let mailtoResolved = false;

async function getMailto(signal?: AbortSignal): Promise<string | null> {
  if (mailtoResolved) return cachedMailto ?? null;
  const value = await resolveCredential({
    provider: "OpenAlex",
    configuredValue: loadConfig().openAlexMailto,
    environmentValue: process.env.OPENALEX_MAILTO,
    signal,
  });
  cachedMailto = value ?? undefined;
  mailtoResolved = true;
  return value;
}

/** Build common OpenAlex query params (mailto + api_key). */
export function buildOpenAlexParams(mailto: string | null, apiKey: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (mailto) params.set("mailto", mailto);
  if (apiKey) params.set("api_key", apiKey);
  return params;
}

/** Check if OpenAlex is available (always true — no key required). */
export function isOpenAlexAvailable(): boolean {
  return true;
}

/** Check if an OpenAlex API key is configured. */
export function hasOpenAlexKey(): boolean {
  return hasCredentialSource({
    provider: "OpenAlex",
    configuredValue: loadConfig().openAlexApiKey,
    environmentValue: process.env.OPENALEX_API_KEY,
  });
}

/**
 * Reconstruct abstract from OpenAlex inverted index format.
 * { "word": [0, 5, 10] } → positions-based reconstruction
 */
function reconstructAbstract(index: Record<string, number[]> | undefined): string | undefined {
  if (!index) return undefined;
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, w]) => w).join(" ");
}

function toPaperResult(work: OpenAlexWork): PaperResult {
  const authors = (work.authorships ?? [])
    .map((a) => a.author?.display_name ?? "")
    .filter((name) => name.length > 0);

  const ids = work.ids ?? {};
  const loc = work.primary_location;
  const oa = work.open_access;

  // Extract arXiv ID from the OpenAlex ID or DOI if it looks like one
  let arxivId: string | undefined;
  const openAlexIdStr = ids.openalex ?? "";

  return {
    id: "",
    title: work.title ?? work.display_name ?? "Untitled",
    authors,
    year: work.publication_year ?? undefined,
    venue: loc?.source?.display_name ?? undefined,
    abstract: reconstructAbstract(work.abstract_inverted_index),
    doi: ids.doi?.replace(/^https?:\/\/doi\.org\//, "") ?? undefined,
    arxivId,
    pmid: ids.pmid ?? undefined,
    openAlexId: openAlexIdStr,
    citationCount: work.cited_by_count ?? undefined,
    referenceCount: work.referenced_works_count ?? undefined,
    isOpenAccess: oa?.is_oa ?? false,
    pdfUrl: oa?.oa_url ?? loc?.pdf_url ?? undefined,
    landingPageUrl: loc?.landing_page_url ?? undefined,
    sources: ["openalex"],
    sourceUrl: work.id ?? "",
  };
}

/** Search OpenAlex for papers matching a query. */
export async function searchOpenAlex(
  query: string,
  options: SearchOptions,
): Promise<PaperResult[]> {
  const params = new URLSearchParams({
    search: query,
    per_page: String(Math.min(options.limit, 200)),
  });

  const mailto = await getMailto(options.signal);
  if (mailto) params.set("mailto", mailto);

  const apiKey = await getApiKey(options.signal);
  if (apiKey) params.set("api_key", apiKey);

  // Build filters
  const filters: string[] = [];
  if (options.year) {
    // Support "2023" or "2023-2024" range
    const yearParts = options.year.split("-");
    if (yearParts.length === 1) {
      filters.push(`publication_year:${yearParts[0]}`);
    } else if (yearParts.length === 2) {
      filters.push(`publication_year:${yearParts[0]}-${yearParts[1]}`);
    }
  }
  if (options.openAccessOnly) {
    filters.push("is_oa:true");
  }
  if (filters.length > 0) {
    params.set("filter", filters.join(","));
  }

  const url = `${OPENALEX_API_BASE}/works?${params}`;
  const response = await openAlexLimiter.schedule("openalex", () => fetchWithTimeout(url, {}, options.signal, "openalex"));

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    let redacted = redactCredential(errorText, apiKey);
    if (mailto) redacted = redactCredential(redacted, mailto);
    throw new Error(`OpenAlex API error ${response.status}: ${redacted.slice(0, 200)}`);
  }

  const data = await response.json() as OpenAlexSearchResponse;
  if (!data.results || data.results.length === 0) {
    return [];
  }

  return data.results.map(toPaperResult);
}

/** Look up a single work by OpenAlex ID or DOI. */
export async function lookupOpenAlex(
  id: string,
  signal?: AbortSignal,
): Promise<PaperResult | null> {
  const mailto = await getMailto(signal);
  const params = new URLSearchParams();
  if (mailto) params.set("mailto", mailto);

  const apiKey = await getApiKey(signal);
  if (apiKey) params.set("api_key", apiKey);

  // Normalize: accept DOI, OpenAlex ID, or pmid:xxx
  let lookupId = id;
  if (id.startsWith("https://openalex.org/") || id.startsWith("W")) {
    lookupId = id;
  } else if (id.startsWith("pmid:")) {
    // OpenAlex natively supports /works/pmid:xxx
    lookupId = id;
  } else if (id.match(/^10\.\d{4,}\//)) {
    // Looks like a DOI — prefix with https://doi.org/
    lookupId = `https://doi.org/${id}`;
  } else {
    // Not a recognized lookup ID (e.g. arXiv ID) — cannot resolve
    return null;
  }

  const qs = params.toString();
  const url = `${OPENALEX_API_BASE}/works/${encodeURIComponent(lookupId)}${qs ? `?${qs}` : ""}`;
  const response = await openAlexLimiter.schedule("openalex", () => fetchWithTimeout(url, {}, signal, "openalex"));

  if (response.status === 404) return null;
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    let redacted = redactCredential(errorText, apiKey);
    if (mailto) redacted = redactCredential(redacted, mailto);
    throw new Error(`OpenAlex lookup error ${response.status}: ${redacted.slice(0, 200)}`);
  }

  const work = await response.json() as OpenAlexWork;
  return toPaperResult(work);
}

/**
 * Get citations or references for a paper via OpenAlex.
 *
 * - "citing": fetches works that cite this paper (filter=cites:{id}).
 * - "references": fetches referenced works by batch-fetching referenced_works IDs.
 */
export async function citationsOpenAlex(
  openAlexId: string,
  direction: "citing" | "references",
  limit: number,
  signal?: AbortSignal,
): Promise<PaperResult[]> {
  const mailto = await getMailto(signal);
  const qsBase = new URLSearchParams();
  if (mailto) qsBase.set("mailto", mailto);

  const apiKey = await getApiKey(signal);
  if (apiKey) qsBase.set("api_key", apiKey);

  if (direction === "citing") {
    const params = new URLSearchParams({
      filter: `cites:${openAlexId}`,
      per_page: String(limit),
    });
    if (mailto) params.set("mailto", mailto);
    if (apiKey) params.set("api_key", apiKey);
    const url = `${OPENALEX_API_BASE}/works?${params}`;
    const response = await openAlexLimiter.schedule("openalex", () => fetchWithTimeout(url, {}, signal, "openalex"));
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      let redacted = redactCredential(errText, apiKey);
      if (mailto) redacted = redactCredential(redacted, mailto);
      throw new Error(`OpenAlex cited_by error ${response.status}: ${redacted.slice(0, 200)}`);
    }
    const data = await response.json() as OpenAlexSearchResponse;
    return (data.results ?? []).map(toPaperResult);
  }

  // references: get the work first, then batch-fetch referenced_works
  const workQs = new URLSearchParams();
  if (mailto) workQs.set("mailto", mailto);
  if (apiKey) workQs.set("api_key", apiKey);
  const workQsStr = workQs.toString();
  const workUrl = `${OPENALEX_API_BASE}/works/${encodeURIComponent(openAlexId)}${workQsStr ? `?${workQsStr}` : ""}`;
  const workResp = await openAlexLimiter.schedule("openalex", () => fetchWithTimeout(workUrl, {}, signal, "openalex"));
  if (!workResp.ok) {
    const errText = await workResp.text().catch(() => "");
    let redacted = redactCredential(errText, apiKey);
    if (mailto) redacted = redactCredential(redacted, mailto);
    throw new Error(`OpenAlex work lookup error ${workResp.status}: ${redacted.slice(0, 200)}`);
  }
  const workData = await workResp.json() as { referenced_works?: string[] };
  const refIds = (workData.referenced_works ?? []).slice(0, limit);
  if (refIds.length === 0) return [];

  const params = new URLSearchParams({
    filter: `openalex:${refIds.join("|")}`,
    per_page: String(limit),
  });
  if (mailto) params.set("mailto", mailto);
  if (apiKey) params.set("api_key", apiKey);
  const refsUrl = `${OPENALEX_API_BASE}/works?${params}`;
  const refsResp = await openAlexLimiter.schedule("openalex", () => fetchWithTimeout(refsUrl, {}, signal, "openalex"));
  if (!refsResp.ok) {
    const errText = await refsResp.text().catch(() => "");
    let redacted = redactCredential(errText, apiKey);
    if (mailto) redacted = redactCredential(redacted, mailto);
    throw new Error(`OpenAlex references error ${refsResp.status}: ${redacted.slice(0, 200)}`);
  }
  const refsData = await refsResp.json() as OpenAlexSearchResponse;
  return (refsData.results ?? []).map(toPaperResult);
}

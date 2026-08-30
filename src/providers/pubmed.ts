import { existsSync, readFileSync } from "node:fs";
import type { PaperResult, SearchOptions } from "../types.ts";
import { hasCredentialSource, resolveCredential } from "../credential-source.ts";
import { fetchWithTimeout, getAcademicSearchConfigPath, redactCredential } from "../utils.ts";
import { RateLimiter } from "../rate-limit.ts";

const ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

interface PubmedConfig {
  ncbiApiKey?: unknown;
}

let cachedConfig: PubmedConfig | null = null;

function loadConfig(): PubmedConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = getAcademicSearchConfigPath();
  if (!existsSync(configPath)) {
    cachedConfig = {};
    return cachedConfig;
  }
  try {
    cachedConfig = JSON.parse(readFileSync(configPath, "utf-8")) as PubmedConfig;
    return cachedConfig;
  } catch {
    cachedConfig = {};
    return cachedConfig;
  }
}

let pubmedLimiter = new RateLimiter(350);

/** Reset all cached config/credential state. Call after config changes. */
export function resetPubmedCache(): void {
  cachedConfig = null;
  cachedApiKey = undefined;
  apiKeyResolved = false;
  pubmedLimiter = new RateLimiter(hasPubmedKey() ? 100 : 350);
}

let cachedApiKey: string | undefined;
let apiKeyResolved = false;

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
  if (apiKeyResolved) return cachedApiKey ?? null;
  const key = await resolveCredential({
    provider: "PubMed",
    configuredValue: loadConfig().ncbiApiKey,
    environmentValue: process.env.NCBI_API_KEY,
    signal,
  });
  cachedApiKey = key ?? undefined;
  apiKeyResolved = true;
  return key;
}

/** Check if a PubMed API key is available (for rate limiter setup). */
export function hasPubmedKey(): boolean {
  return hasCredentialSource({
    provider: "PubMed",
    configuredValue: loadConfig().ncbiApiKey,
    environmentValue: process.env.NCBI_API_KEY,
  });
}

/** Check if PubMed is available (always true — no key required). */
export function isPubmedAvailable(): boolean {
  return true;
}

interface ESearchResponse {
  esearchresult?: {
    idlist?: string[];
    count?: string;
  };
}

interface ESummaryResultItem {
  uid?: string;
  title?: string;
  sortpubdate?: string;
  source?: string;  // journal abbreviation
  authors?: Array<{ name?: string; authtype?: string }>;
  articleids?: Array<{ idtype?: string; value?: string }>;
  volume?: string;
  issue?: string;
  pages?: string;
  fulljournalname?: string;
  elocationid?: string;
}

interface ESummaryResponse {
  result?: {
    uids?: string[];
    [key: string]: ESummaryResultItem | string[] | undefined;
  };
}

/** Parse a PubMed esummary item into a PaperResult. Exported for testing. */
export function toPaperResult(item: ESummaryResultItem): PaperResult | null {
  if (!item.title || !item.uid) return null;

  const authors = (item.authors ?? [])
    .map((a) => a.name ?? "")
    .filter((n) => n.length > 0);

  // Extract year from sortpubdate (format: "2023/01/15" or "2023")
  let year: number | undefined;
  if (item.sortpubdate) {
    const match = item.sortpubdate.match(/^(\d{4})/);
    if (match) year = parseInt(match[1]!, 10);
  }

  // Extract DOI from articleids
  let doi: string | undefined;
  let pmid: string | undefined;
  for (const aid of item.articleids ?? []) {
    if (aid.idtype === "doi") doi = aid.value ?? undefined;
    if (aid.idtype === "pubmed") pmid = aid.value ?? undefined;
  }
  // Fallback PMID to uid
  if (!pmid) pmid = item.uid;

  // Landing page
  const landingPageUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

  return {
    id: "",
    title: item.title,
    authors,
    year,
    venue: item.fulljournalname ?? item.source ?? undefined,
    // PubMed esummary doesn't include abstract
    abstract: undefined,
    doi,
    pmid,
    citationCount: undefined,
    referenceCount: undefined,
    influentialCitationCount: undefined,
    isOpenAccess: false, // PubMed doesn't indicate OA status in esummary
    pdfUrl: undefined,
    landingPageUrl,
    sources: ["pubmed"],
    sourceUrl: landingPageUrl,
  };
}

/**
 * Parse PubMed esummary response into PaperResult[].
 * Iterates uids, looks up each item, and returns valid results.
 * Exported for testing.
 */
export function parsePubmedSummaries(data: ESummaryResponse): PaperResult[] {
  const uids = data.result?.uids ?? [];
  const results: PaperResult[] = [];
  for (const uid of uids) {
    const item = data.result?.[uid];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const paper = toPaperResult(item as ESummaryResultItem);
      if (paper) results.push(paper);
    }
  }
  return results;
}

/** Search PubMed for papers matching a query. */
export async function searchPubmed(
  query: string,
  options: SearchOptions,
): Promise<PaperResult[]> {
  const apiKey = await getApiKey(options.signal);

  // Step 1: esearch to get IDs
  const esearchParams = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmax: String(Math.min(options.limit, 200)),
    retmode: "json",
  });
  if (options.year) {
    // Use datetype=pdat for publication date filtering
    const yearParts = options.year.split("-");
    if (yearParts.length === 1) {
      esearchParams.set("mindate", yearParts[0]!);
      esearchParams.set("maxdate", yearParts[0]!);
    } else if (yearParts.length === 2) {
      esearchParams.set("mindate", yearParts[0]!);
      esearchParams.set("maxdate", yearParts[1]!);
    }
    esearchParams.set("datetype", "pdat");
  }
  if (apiKey) {
    esearchParams.set("api_key", apiKey);
  }

  const esearchUrl = `${ESEARCH_URL}?${esearchParams}`;
  const esearchResp = await pubmedLimiter.schedule("pubmed", () => fetchWithTimeout(esearchUrl, {}, options.signal, "pubmed"));

  if (!esearchResp.ok) {
    const errorText = await esearchResp.text().catch(() => "");
    const redacted = redactCredential(errorText, apiKey);
    throw new Error(`PubMed esearch error ${esearchResp.status}: ${redacted.slice(0, 200)}`);
  }

  const esearchData = await esearchResp.json() as ESearchResponse;
  const idList = esearchData.esearchresult?.idlist;
  if (!idList || idList.length === 0) {
    return [];
  }

  // Step 2: esummary to get details
  const esummaryParams = new URLSearchParams({
    db: "pubmed",
    id: idList.join(","),
    retmode: "json",
  });
  if (apiKey) {
    esummaryParams.set("api_key", apiKey);
  }

  const esummaryUrl = `${ESUMMARY_URL}?${esummaryParams}`;
  const esummaryResp = await pubmedLimiter.schedule("pubmed", () => fetchWithTimeout(esummaryUrl, {}, options.signal, "pubmed"));

  if (!esummaryResp.ok) {
    const errorText = await esummaryResp.text().catch(() => "");
    const redacted = redactCredential(errorText, apiKey);
    throw new Error(`PubMed esummary error ${esummaryResp.status}: ${redacted.slice(0, 200)}`);
  }

  const esummaryData = await esummaryResp.json() as ESummaryResponse;
  return parsePubmedSummaries(esummaryData);
}

/** Look up a single PubMed article by PMID. */
export async function lookupPubmed(
  id: string,
  signal?: AbortSignal,
): Promise<PaperResult | null> {
  // Strip PMID: prefix if present
  const pmid = id.replace(/^pmid:/i, "").trim();
  if (!pmid || !/^\d+$/.test(pmid)) return null;

  const apiKey = await getApiKey(signal);

  const esummaryParams = new URLSearchParams({
    db: "pubmed",
    id: pmid,
    retmode: "json",
  });
  if (apiKey) {
    esummaryParams.set("api_key", apiKey);
  }

  const url = `${ESUMMARY_URL}?${esummaryParams}`;
  const response = await pubmedLimiter.schedule("pubmed", () => fetchWithTimeout(url, {}, signal, "pubmed"));

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const redacted = redactCredential(errorText, apiKey);
    throw new Error(`PubMed esummary error ${response.status}: ${redacted.slice(0, 200)}`);
  }

  const data = await response.json() as ESummaryResponse;
  const item = data.result?.[pmid];
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  return toPaperResult(item as ESummaryResultItem);
}

import { existsSync, readFileSync } from "node:fs";
import type { PaperResult, SearchOptions } from "../types.ts";
import { resolveCredential } from "../credential-source.ts";
import { fetchWithTimeout, getAcademicSearchConfigPath, redactCredential } from "../utils.ts";

const CROSSREF_API_BASE = "https://api.crossref.org";

interface CrossrefAuthor {
  given?: string;
  family?: string;
}

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  abstract?: string;
  "is-referenced-by-count"?: number;
  "references-count"?: number;
  link?: Array<{ URL?: string; "content-type"?: string }>;
  URL?: string;
  license?: Array<{ URL?: string }>;
}

interface CrossrefSearchResponse {
  message?: {
    items?: CrossrefWork[];
    "total-results"?: number;
  };
}

interface CrossrefConfig {
  crossrefMailto?: unknown;
}

let cachedConfig: CrossrefConfig | null = null;

function loadConfig(): CrossrefConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = getAcademicSearchConfigPath();
  if (!existsSync(configPath)) {
    cachedConfig = {};
    return cachedConfig;
  }
  try {
    cachedConfig = JSON.parse(readFileSync(configPath, "utf-8")) as CrossrefConfig;
    return cachedConfig;
  } catch {
    cachedConfig = {};
    return cachedConfig;
  }
}

/** Reset all cached config/credential state. Call after config changes. */
export function resetCrossrefCache(): void {
  cachedConfig = null;
  cachedMailto = undefined;
  mailtoResolved = false;
}

let cachedMailto: string | undefined;
let mailtoResolved = false;

async function getMailto(signal?: AbortSignal): Promise<string | null> {
  if (mailtoResolved) return cachedMailto ?? null;
  const value = await resolveCredential({
    provider: "Crossref",
    configuredValue: loadConfig().crossrefMailto,
    environmentValue: process.env.CROSSREF_MAILTO,
    signal,
  });
  cachedMailto = value ?? undefined;
  mailtoResolved = true;
  return value;
}

/** Check if Crossref is available (always true — no key required). */
export function isCrossrefAvailable(): boolean {
  return true;
}

function formatAuthor(author: CrossrefAuthor): string {
  const parts: string[] = [];
  if (author.given) parts.push(author.given);
  if (author.family) parts.push(author.family);
  return parts.join(" ");
}

function extractYear(work: CrossrefWork): number | undefined {
  const pub = work["published-print"] ?? work["published-online"];
  const parts = pub?.["date-parts"]?.[0];
  if (parts && parts[0]) return parts[0];
  return undefined;
}

function toPaperResult(work: CrossrefWork): PaperResult {
  const authors = (work.author ?? []).map(formatAuthor).filter((a) => a.length > 0);
  const title = work.title?.[0] ?? "Untitled";

  // Try to find a PDF link
  let pdfUrl: string | undefined;
  for (const link of work.link ?? []) {
    if (link["content-type"]?.includes("pdf")) {
      pdfUrl = link.URL;
      break;
    }
  }

  // Check license for OA indication
  const hasOaLicense = (work.license ?? []).some(
    (l) => l.URL?.includes("creativecommons") || l.URL?.includes("open"),
  );

  return {
    id: "",
    title,
    authors,
    year: extractYear(work),
    venue: work["container-title"]?.[0] ?? undefined,
    abstract: work.abstract?.replace(/<[^>]+>/g, "") ?? undefined, // Strip HTML tags
    doi: work.DOI ?? undefined,
    citationCount: work["is-referenced-by-count"] ?? undefined,
    referenceCount: work["references-count"] ?? undefined,
    isOpenAccess: hasOaLicense || !!pdfUrl,
    pdfUrl,
    landingPageUrl: work.URL ?? undefined,
    sources: ["crossref"],
    sourceUrl: work.DOI ? `https://doi.org/${work.DOI}` : "",
  };
}

/** Search Crossref for papers matching a query. */
export async function searchCrossref(
  query: string,
  options: SearchOptions,
): Promise<PaperResult[]> {
  const params = new URLSearchParams({
    query,
    rows: String(Math.min(options.limit, 100)),
  });

  const mailto = await getMailto(options.signal);
  if (mailto) params.set("mailto", mailto);

  // Year filter using Crossref filter syntax
  if (options.year) {
    const yearParts = options.year.split("-");
    if (yearParts.length === 1) {
      params.set("filter", `from-pub-date:${yearParts[0]},until-pub-date:${yearParts[0]}`);
    } else if (yearParts.length === 2) {
      params.set("filter", `from-pub-date:${yearParts[0]},until-pub-date:${yearParts[1]}`);
    }
  }

  const url = `${CROSSREF_API_BASE}/works?${params}`;
  const response = await fetchWithTimeout(url, {}, options.signal, "crossref");

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const redacted = redactCredential(errorText, mailto);
    throw new Error(`Crossref API error ${response.status}: ${redacted.slice(0, 200)}`);
  }

  const data = await response.json() as CrossrefSearchResponse;
  const items = data.message?.items;
  if (!items || items.length === 0) {
    return [];
  }

  let results = items.map(toPaperResult);

  // Apply openAccessOnly filter post-hoc (Crossref doesn't have a direct OA filter)
  if (options.openAccessOnly) {
    results = results.filter((r) => r.isOpenAccess);
  }

  return results;
}

/** Look up a single work by DOI. */
export async function lookupCrossref(
  id: string,
  signal?: AbortSignal,
): Promise<PaperResult | null> {
  // Crossref lookup is DOI-based
  const doi = id.replace(/^https?:\/\/doi\.org\//i, "").replace(/^doi:/i, "");

  const mailto = await getMailto(signal);
  const params = new URLSearchParams();
  if (mailto) params.set("mailto", mailto);

  const qs = params.toString();
  const url = `${CROSSREF_API_BASE}/works/${encodeURIComponent(doi)}${qs ? `?${qs}` : ""}`;
  const response = await fetchWithTimeout(url, {}, signal, "crossref");

  if (response.status === 404) return null;
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const redacted = redactCredential(errorText, mailto);
    throw new Error(`Crossref lookup error ${response.status}: ${redacted.slice(0, 200)}`);
  }

  const data = await response.json() as { message?: CrossrefWork };
  if (!data.message) return null;
  return toPaperResult(data.message);
}

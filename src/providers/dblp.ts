import type { PaperResult, SearchOptions } from "../types.ts";
import { fetchWithTimeout } from "../utils.ts";

const DBLP_API_BASE = "https://dblp.org/search/publ/api";

/** Check if DBLP is available (always true — no key required). */
export function isDblpAvailable(): boolean {
  return true;
}

interface DblpAuthor {
  text?: string;
}

interface DblpHitInfo {
  title?: string;
  authors?: { author?: DblpAuthor[] | DblpAuthor };
  year?: string;
  venue?: string;
  url?: string;
  doi?: string;
  ee?: string; // electronic edition URL
  type?: string;
}

interface DblpHit {
  info?: DblpHitInfo;
}

interface DblpSearchResult {
  hits?: {
    hit?: DblpHit[];
    "@total"?: string;
    "@computed"?: string;
  };
}

interface DblpSearchResponse {
  result?: DblpSearchResult;
}

/**
 * Normalize DBLP authors array from its sometimes-single-object-or-array format.
 */
function extractAuthors(authors: { author?: DblpAuthor[] | DblpAuthor } | undefined): string[] {
  if (!authors?.author) return [];
  const raw = Array.isArray(authors.author) ? authors.author : [authors.author];
  return raw.map((a) => a.text ?? "").filter((n) => n.length > 0);
}

/** Parse a single DBLP hit into a PaperResult. Exported for testing. */
export function toPaperResult(hit: DblpHit): PaperResult | null {
  const info = hit.info;
  if (!info?.title) return null;

  const title = info.title.replace(/\s+/g, " ").trim();
  const authors = extractAuthors(info.authors);
  const year = info.year ? parseInt(info.year, 10) : undefined;

  // DOI: bare DOI from DBLP
  const doi = info.doi ?? undefined;

  // URL: prefer info.url (DBLP page), fallback to ee (electronic edition)
  const landingPageUrl = info.url ?? info.ee ?? undefined;

  return {
    id: "",
    title,
    authors,
    year: isNaN(year!) ? undefined : year,
    venue: info.venue ?? undefined,
    // DBLP does not provide abstracts
    abstract: undefined,
    doi,
    // DBLP does not provide citation counts
    citationCount: undefined,
    referenceCount: undefined,
    influentialCitationCount: undefined,
    isOpenAccess: false, // ee is electronic edition, not OA indicator
    pdfUrl: undefined,
    landingPageUrl,
    sources: ["dblp"],
    sourceUrl: info.url ?? (doi ? `https://doi.org/${doi}` : ""),
  };
}

/**
 * Parse a DBLP search response into PaperResult[].
 * Extracts hits, converts each, and applies optional year filter.
 * Exported for testing.
 */
export function parseDblpHits(data: DblpSearchResponse, year?: string): PaperResult[] {
  const hits = data.result?.hits?.hit;
  if (!hits || hits.length === 0) return [];

  const results: PaperResult[] = [];
  for (const hit of hits) {
    const paper = toPaperResult(hit);
    if (paper) results.push(paper);
  }

  // DBLP doesn't support year filtering; do it post-hoc
  if (year) {
    const yearParts = year.split("-");
    const fromYear = parseInt(yearParts[0]!, 10);
    const toYear = yearParts[1] ? parseInt(yearParts[1], 10) : fromYear;
    return results.filter((r) => {
      if (!r.year) return false;
      return r.year >= fromYear && r.year <= toYear;
    });
  }

  return results;
}

/** Search DBLP for papers matching a query. */
export async function searchDblp(
  query: string,
  options: SearchOptions,
): Promise<PaperResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    h: String(Math.min(options.limit, 1000)),
  });

  const url = `${DBLP_API_BASE}?${params}`;
  const response = await fetchWithTimeout(url, {}, options.signal, "dblp");

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`DBLP API error ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = await response.json() as DblpSearchResponse;
  return parseDblpHits(data, options.year);
}

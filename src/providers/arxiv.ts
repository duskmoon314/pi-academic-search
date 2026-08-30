import type { PaperResult, SearchOptions } from "../types.ts";
import { fetchWithTimeout } from "../utils.ts";

const ARXIV_API_BASE = "https://export.arxiv.org/api/query";

/** Check if arXiv is available (always true — no key required). */
export function isArxivAvailable(): boolean {
  return true;
}

/** Regex matching arXiv field prefixes (ti:, au:, abs:, cat:, all:). */
const FIELD_PREFIX_RE = /\b(?:ti|au|abs|cat|all):/i;
/** Regex matching boolean operators used in arXiv advanced queries. */
const BOOLEAN_OP_RE = /\b(?:AND|OR|ANDNOT)\b/;

/**
 * Build an arXiv search query string.
 *
 * - If `query` already contains field prefixes (ti:/au:/abs:/cat:/all:) or
 *   boolean operators (AND/OR/ANDNOT), it is passed through verbatim.
 * - Otherwise, wraps as `ti:"Q" OR abs:"Q"` for better precision.
 * - When `categories` is non-empty, the result is wrapped in an AND with
 *   `cat:X OR cat:Y` to restrict to specified categories.
 */
export function buildArxivQuery(query: string, categories?: string[]): string {
  let base: string;
  if (FIELD_PREFIX_RE.test(query) || BOOLEAN_OP_RE.test(query)) {
    base = query;
  } else {
    const escaped = query.replace(/"/g, "'");
    base = `ti:"${escaped}" OR abs:"${escaped}"`;
  }

  if (categories && categories.length > 0) {
    const catExpr = categories.map((c) => `cat:${c}`).join(" OR ");
    return `(${base}) AND (${catExpr})`;
  }

  return base;
}

/**
 * Lightweight Atom XML parser for arXiv API responses.
 * No XML library needed — just regex-based extraction of entry elements.
 */
function parseAtomEntries(xml: string): PaperResult[] {
  const entries: PaperResult[] = [];
  const entryBlocks = xml.split("<entry>").slice(1); // skip everything before first <entry>

  for (const block of entryBlocks) {
    const endIdx = block.indexOf("</entry>");
    if (endIdx === -1) continue;
    const entryXml = block.slice(0, endIdx);

    const title = extractTag(entryXml, "title")
      ?.replace(/\s+/g, " ")
      .trim() ?? "Untitled";

    // Skip the empty "no results" title sometimes returned
    if (title === "No results found") continue;

    const summary = extractTag(entryXml, "summary")
      ?.replace(/\s+/g, " ")
      .trim();

    const published = extractTag(entryXml, "published");
    const year = published ? parseInt(published.slice(0, 4), 10) : undefined;

    // Extract arXiv ID from <id> tag
    const idUrl = extractTag(entryXml, "id");
    let arxivId: string | undefined;
    if (idUrl) {
      const match = idUrl.match(/abs\/(\d+\.\d+(?:v\d+)?)/);
      if (match) arxivId = match[1];
    }

    // Extract authors
    const authors: string[] = [];
    const authorBlocks = entryXml.split("<author>").slice(1);
    for (const ab of authorBlocks) {
      const endAuthor = ab.indexOf("</author>");
      if (endAuthor === -1) continue;
      const authorXml = ab.slice(0, endAuthor);
      const name = extractTag(authorXml, "name");
      if (name) authors.push(name.trim());
    }

    // Extract DOI if present
    let doi: string | undefined;
    const doiLinks = entryXml.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/);
    if (doiLinks) doi = doiLinks[1].trim();

    // Extract PDF link (order-independent attribute matching)
    let pdfUrl: string | undefined;
    const pdfHref = findLinkByAttrs(entryXml, { title: "pdf", rel: "related" })
      ?? findLinkByAttrs(entryXml, { title: "pdf" });
    if (pdfHref) {
      pdfUrl = pdfHref;
    } else if (arxivId) {
      pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
    }

    // Extract primary category
    let venue: string | undefined;
    const primaryCat = entryXml.match(/<arxiv:primary_category[^>]*term="([^"]+)"/);
    if (primaryCat) venue = decodeXmlEntities(primaryCat[1]!);

    // Extract abstract link (landing page, order-independent)
    let landingPageUrl: string | undefined;
    const absHref = findLinkByAttrs(entryXml, { title: "abs", rel: "alternate" })
      ?? findLinkByAttrs(entryXml, { title: "abs" });
    if (absHref) {
      landingPageUrl = absHref;
    } else if (arxivId) {
      landingPageUrl = `https://arxiv.org/abs/${arxivId}`;
    }

    entries.push({
      id: "",
      title,
      authors,
      year,
      venue,
      abstract: summary,
      doi,
      arxivId,
      isOpenAccess: true, // arXiv papers are always OA
      pdfUrl,
      landingPageUrl,
      sources: ["arxiv"],
      sourceUrl: landingPageUrl ?? "",
    });
  }

  return entries;
}

/** Extract text content from an XML tag. */
function extractTag(xml: string, tag: string): string | undefined {
  // Handle both <tag>value</tag> and <tag attr="...">value</tag>
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "m");
  const match = xml.match(regex);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

/** Decode common XML entities. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * Extract all <link .../> attributes as a Map.
 * Returns an array of Maps, one per <link> element found.
 */
function extractLinkAttributes(xml: string): Array<Map<string, string>> {
  const results: Array<Map<string, string>> = [];
  // Match both self-closing <link ... /> and <link ...> (without closing tag)
  const linkRe = /<link\s([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(xml)) !== null) {
    const attrs = m[1]!;
    const attrMap = new Map<string, string>();
    const attrRe = /(\w[\w:-]*)\s*=\s*"([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrs)) !== null) {
      attrMap.set(am[1]!.toLowerCase(), am[2]!);
    }
    results.push(attrMap);
  }
  return results;
}

/**
 * Find a <link> element by matching attribute key-value pairs.
 * Order-independent: extracts all attributes, then checks for match.
 */
function findLinkByAttrs(xml: string, matchAttrs: Record<string, string>): string | undefined {
  const links = extractLinkAttributes(xml);
  for (const attrs of links) {
    let match = true;
    for (const [key, value] of Object.entries(matchAttrs)) {
      if (attrs.get(key) !== value) {
        match = false;
        break;
      }
    }
    if (match) return decodeXmlEntities(attrs.get("href") ?? "") || undefined;
  }
  return undefined;
}

/** Search arXiv for papers matching a query. */
export async function searchArxiv(
  query: string,
  options: SearchOptions,
): Promise<PaperResult[]> {
  const arxivQuery = buildArxivQuery(query, options.categories);
  const params = new URLSearchParams({
    search_query: arxivQuery,
    start: "0",
    max_results: String(Math.min(options.limit, 200)),
    sortBy: "relevance",
    sortOrder: "descending",
  });

  const url = `${ARXIV_API_BASE}?${params}`;
  const response = await fetchWithTimeout(url, {}, options.signal, "arxiv");

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`arXiv API error ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const xml = await response.text();
  let results = parseAtomEntries(xml);

  // Apply year filter (arXiv API doesn't support year filter directly)
  if (options.year) {
    const yearParts = options.year.split("-");
    const fromYear = parseInt(yearParts[0], 10);
    const toYear = yearParts[1] ? parseInt(yearParts[1], 10) : fromYear;
    results = results.filter((r) => {
      if (!r.year) return false;
      return r.year >= fromYear && r.year <= toYear;
    });
  }

  return results;
}

/** Look up a single paper by arXiv ID. */
export async function lookupArxiv(
  id: string,
  signal?: AbortSignal,
): Promise<PaperResult | null> {
  // Strip arxiv: prefix and version
  let arxivId = id.replace(/^arxiv:/i, "").replace(/v\d+$/, "");

  const params = new URLSearchParams({
    id_list: arxivId,
    max_results: "1",
  });

  const url = `${ARXIV_API_BASE}?${params}`;
  const response = await fetchWithTimeout(url, {}, signal, "arxiv");

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`arXiv lookup error ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const xml = await response.text();
  const results = parseAtomEntries(xml);
  return results[0] ?? null;
}

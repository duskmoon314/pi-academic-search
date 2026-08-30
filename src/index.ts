import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve as pathResolve, isAbsolute, normalize } from "node:path";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PaperResult, SourceId, StoredPaperData, AcademicSearchConfig } from "./types.ts";
import { SOURCES, DEFAULT_SOURCES } from "./types.ts";
import { getAcademicSearchConfigDir, getAcademicSearchConfigPath } from "./utils.ts";
import { hasCredentialSource, resolveCredential } from "./credential-source.ts";
import { createRateLimiters } from "./rate-limit.ts";
import { deduplicatePapers } from "./dedupe.ts";
import { generateId, storeResult, getAllResults } from "./storage.ts";
import { buildErrorPlan, formatFailedSources } from "./render-error.ts";
import { identifyId } from "./identify-id.ts";
import { isUnpaywallAvailable, resetUnpaywallCache } from "./pdf/unpaywall.ts";
import { downloadPaperPdf } from "./pdf/download.ts";
import { formatHealthSuffix, getAllHealth, getCredentialInvalidHint } from "./health.ts";
import { yearMatchesFilter } from "./utils.ts";
import { isSemanticScholarAvailable, hasS2Key, searchSemanticScholar, lookupSemanticScholar, citationsSemanticScholar, enrichAbstractsBatch, resetS2Cache } from "./providers/semanticscholar.ts";
import { isOpenAlexAvailable, hasOpenAlexKey, searchOpenAlex, lookupOpenAlex, citationsOpenAlex, resetOpenAlexCache } from "./providers/openalex.ts";
import { isCrossrefAvailable, searchCrossref, lookupCrossref, resetCrossrefCache } from "./providers/crossref.ts";
import { isArxivAvailable, searchArxiv, lookupArxiv } from "./providers/arxiv.ts";
import { isDblpAvailable, searchDblp } from "./providers/dblp.ts";
import { isPubmedAvailable, hasPubmedKey, searchPubmed, lookupPubmed, resetPubmedCache } from "./providers/pubmed.ts";

// --- Config management ---

const CONFIG_PATH = getAcademicSearchConfigPath();

function parseConfigRoot(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function loadConfig(): AcademicSearchConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  return parseConfigRoot(readFileSync(CONFIG_PATH, "utf-8")) as AcademicSearchConfig;
}

function saveConfig(updates: Partial<AcademicSearchConfig>): void {
  let config: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) {
    config = parseConfigRoot(readFileSync(CONFIG_PATH, "utf-8"));
  }
  Object.assign(config, updates);
  const dir = getAcademicSearchConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// --- Provider availability ---

interface ProviderAvailability {
  semantic: boolean;
  openalex: boolean;
  crossref: boolean;
  arxiv: boolean;
  dblp: boolean;
  pubmed: boolean;
}

function getProviderAvailability(): ProviderAvailability {
  return {
    semantic: isSemanticScholarAvailable(),
    openalex: isOpenAlexAvailable(),
    crossref: isCrossrefAvailable(),
    arxiv: isArxivAvailable(),
    dblp: isDblpAvailable(),
    pubmed: isPubmedAvailable(),
  };
}

// --- Search logic ---

type SearchFn = (query: string, options: import("./types.ts").SearchOptions) => Promise<PaperResult[]>;

const SEARCH_FNS: Record<SourceId, SearchFn> = {
  semantic: searchSemanticScholar,
  openalex: searchOpenAlex,
  crossref: searchCrossref,
  arxiv: searchArxiv,
  dblp: searchDblp,
  pubmed: searchPubmed,
};

const SOURCE_LABELS: Record<SourceId, string> = {
  semantic: "Semantic Scholar",
  openalex: "OpenAlex",
  crossref: "Crossref",
  arxiv: "arXiv",
  dblp: "DBLP",
  pubmed: "PubMed",
};

/** Normalize a source string to a valid SourceId. */
function normalizeSource(value: string): SourceId | null {
  const lower = value.toLowerCase().trim();
  if ((SOURCES as readonly string[]).includes(lower)) return lower as SourceId;
  return null;
}

/** Normalize the `sources` parameter from the tool call. */
function normalizeSourcesParam(value: unknown): SourceId[] {
  if (value === undefined || value === null) {
    return loadConfig().defaultSources ?? DEFAULT_SOURCES;
  }
  if (typeof value === "string") {
    const s = normalizeSource(value);
    return s ? [s] : [];
  }
  if (Array.isArray(value)) {
    const result: SourceId[] = [];
    for (const v of value) {
      if (typeof v === "string") {
        const s = normalizeSource(v);
        if (s && !result.includes(s)) result.push(s);
      }
    }
    return result;
  }
  return [];
}

/**
 * Escape a string for Markdown table cell content.
 * Escapes pipe characters, newlines, and backticks that could break the table.
 */
function escapeMarkdownCell(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .replace(/`/g, "'");
}

/**
 * Sanitize abstract text for inclusion in LLM context.
 * Removes control characters, limits length, treats as untrusted text.
 */
function sanitizeAbstract(text: string): string {
  // Remove control characters (keep newlines and tabs)
  const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Limit to 2000 chars
  if (cleaned.length > 2000) return cleaned.slice(0, 1997) + "...";
  return cleaned;
}

/** Format paper results as a Markdown table for LLM consumption. */
function formatResultsMarkdown(
  papers: PaperResult[],
  query: string,
  failedSources: Array<{ source: string; error: string }>,
): string {
  if (papers.length === 0) {
    let output = `No results found for "${query}".`;
    if (failedSources.length > 0) {
      output += "\n\n" + formatFailedSources(failedSources);
    }
    return output;
  }

  const lines: string[] = [
    `Found ${papers.length} paper(s) for "${query}":`,
    "",
    "| # | Title | Authors | Year | Citations | Source | DOI |",
    "|---|-------|---------|------|-----------|--------|-----|",
  ];

  for (let i = 0; i < papers.length; i++) {
    const p = papers[i]!;
    const num = String(i + 1);
    const title = escapeMarkdownCell(truncate(p.title, 60));
    const authors = escapeMarkdownCell(formatAuthorsShort(p.authors));
    const year = p.year ? String(p.year) : "—";
    const citations = p.citationCount != null ? String(p.citationCount) : "—";
    const source = escapeMarkdownCell(p.sources.join(", "));
    const doi = p.doi ? `[${escapeMarkdownCell(truncate(p.doi, 30))}](https://doi.org/${encodeURIComponent(p.doi)})` : "—";
    lines.push(`| ${num} | ${title} | ${authors} | ${year} | ${citations} | ${source} | ${doi} |`);
  }

  if (failedSources.length > 0) {
    lines.push("");
    lines.push(formatFailedSources(failedSources));
  }

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAuthorsShort(authors: string[]): string {
  if (authors.length === 0) return "—";
  if (authors.length <= 2) return authors.join(", ");
  return `${authors[0]} et al.`;
}

// Assign storage IDs to papers
function assignIds(papers: PaperResult[]): PaperResult[] {
  return papers.map((p) => ({ ...p, id: generateId() }));
}

// --- Paper lookup helpers ---

/** Format a single paper as a Markdown card. */
function formatPaperCard(paper: PaperResult): string {
  const lines: string[] = [
    `# ${escapeMarkdownCell(paper.title)}`,
    "",
  ];

  if (paper.authors.length > 0) {
    lines.push(`**Authors:** ${escapeMarkdownCell(paper.authors.join(", "))}`);
  }
  if (paper.year) {
    lines.push(`**Year:** ${paper.year}`);
  }
  if (paper.venue) {
    lines.push(`**Venue:** ${escapeMarkdownCell(paper.venue)}`);
  }
  if (paper.doi) {
    const safeDoi = escapeMarkdownCell(paper.doi);
    lines.push(`**DOI:** [${safeDoi}](https://doi.org/${encodeURIComponent(paper.doi)})`);
  }
  if (paper.arxivId) {
    lines.push(`**arXiv:** [${paper.arxivId}](https://arxiv.org/abs/${paper.arxivId})`);
  }
  if (paper.pmid) {
    lines.push(`**PMID:** [${paper.pmid}](https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/)`);
  }
  if (paper.citationCount != null) {
    lines.push(`**Citations:** ${paper.citationCount}`);
  }
  if (paper.referenceCount != null) {
    lines.push(`**References:** ${paper.referenceCount}`);
  }
  lines.push(`**Open Access:** ${paper.isOpenAccess ? "Yes" : "No"}`);
  if (paper.pdfUrl) {
    lines.push(`**PDF:** [link](${encodeURI(paper.pdfUrl)})`);
  }
  if (paper.landingPageUrl) {
    lines.push(`**URL:** [link](${encodeURI(paper.landingPageUrl)})`);
  }
  lines.push(`**Sources:** ${escapeMarkdownCell(paper.sources.join(", "))}`);

  if (paper.abstract) {
    lines.push("");
    lines.push("## Abstract");
    lines.push("");
    lines.push(sanitizeAbstract(paper.abstract));
  }

  return lines.join("\n");
}

/**
 * Resolve a paper by identified ID — the shared logic used by both
 * `paper_lookup` and the ID-routing path of `academic_search`.
 *
 * For DOI: parallel lookup across Crossref, S2, OpenAlex, merge fields.
 * For arXiv: parallel lookup across arXiv, S2, merge fields.
 * For PMID: parallel lookup across PubMed, S2, merge fields.
 * For S2/OpenAlex: direct lookup.
 */
const LOOKUP_SOURCE_PRIORITY: Record<string, number> = {
  semantic: 0,
  openalex: 1,
  arxiv: 2,
  crossref: 3,
  dblp: 4,
  pubmed: 5,
};

export async function resolvePaperById(
  identified: import("./identify-id.ts").IdentifiedId,
  signal?: AbortSignal,
): Promise<PaperResult | null> {
  let paper: PaperResult | null = null;

  switch (identified.type) {
    case "doi": {
      const doi = identified.normalized;
      const promises = [
        rateLimiters.get("crossref")?.schedule("crossref", () => lookupCrossref(doi, signal).catch(() => null)) ?? lookupCrossref(doi, signal).catch(() => null),
        rateLimiters.get("semantic")?.schedule("semantic", () => lookupSemanticScholar(`DOI:${doi}`, signal).catch(() => null)) ?? lookupSemanticScholar(`DOI:${doi}`, signal).catch(() => null),
        lookupOpenAlex(doi, signal).catch(() => null),
      ];
      const results = await Promise.allSettled(promises);
      const papers: PaperResult[] = [];
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) papers.push(r.value);
      }
      // Sort by source priority: semantic > openalex > crossref
      papers.sort((a, b) => {
        const pa = Math.min(...a.sources.map((s) => LOOKUP_SOURCE_PRIORITY[s] ?? 99));
        const pb = Math.min(...b.sources.map((s) => LOOKUP_SOURCE_PRIORITY[s] ?? 99));
        return pa - pb;
      });
      if (papers.length > 0) {
        paper = papers[0]!;
        for (let i = 1; i < papers.length; i++) {
          const extra = papers[i]!;
          if (!paper.abstract && extra.abstract) paper.abstract = extra.abstract;
          if (!paper.citationCount && extra.citationCount) paper.citationCount = extra.citationCount;
          if (!paper.referenceCount && extra.referenceCount) paper.referenceCount = extra.referenceCount;
          if (!paper.pdfUrl && extra.pdfUrl) paper.pdfUrl = extra.pdfUrl;
          if (!paper.venue && extra.venue) paper.venue = extra.venue;
          for (const src of extra.sources) {
            if (!paper.sources.includes(src)) paper.sources.push(src);
          }
        }
      }
      break;
    }
    case "arxiv": {
      const arxivId = identified.normalized;
      const promises = [
        rateLimiters.get("arxiv")?.schedule("arxiv", () => lookupArxiv(arxivId, signal).catch(() => null)) ?? lookupArxiv(arxivId, signal).catch(() => null),
        rateLimiters.get("semantic")?.schedule("semantic", () => lookupSemanticScholar(`ARXIV:${arxivId}`, signal).catch(() => null)) ?? lookupSemanticScholar(`ARXIV:${arxivId}`, signal).catch(() => null),
      ];
      const results = await Promise.allSettled(promises);
      const papers: PaperResult[] = [];
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) papers.push(r.value);
      }
      // Sort by source priority: semantic > arxiv
      papers.sort((a, b) => {
        const pa = Math.min(...a.sources.map((s) => LOOKUP_SOURCE_PRIORITY[s] ?? 99));
        const pb = Math.min(...b.sources.map((s) => LOOKUP_SOURCE_PRIORITY[s] ?? 99));
        return pa - pb;
      });
      if (papers.length > 0) {
        paper = papers[0]!;
        for (let i = 1; i < papers.length; i++) {
          const extra = papers[i]!;
          if (!paper.abstract && extra.abstract) paper.abstract = extra.abstract;
          if (!paper.citationCount && extra.citationCount) paper.citationCount = extra.citationCount;
          if (!paper.pdfUrl && extra.pdfUrl) paper.pdfUrl = extra.pdfUrl;
          for (const src of extra.sources) {
            if (!paper.sources.includes(src)) paper.sources.push(src);
          }
        }
      }
      break;
    }
    case "pmid": {
      const pmid = identified.normalized;
      const promises = [
        lookupPubmed(pmid, signal).catch(() => null),
        rateLimiters.get("semantic")?.schedule("semantic", () => lookupSemanticScholar(`PMID:${pmid}`, signal).catch(() => null)) ?? lookupSemanticScholar(`PMID:${pmid}`, signal).catch(() => null),
      ];
      const results = await Promise.allSettled(promises);
      const papers: PaperResult[] = [];
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) papers.push(r.value);
      }
      // Sort by source priority: semantic > pubmed
      papers.sort((a, b) => {
        const pa = Math.min(...a.sources.map((s) => LOOKUP_SOURCE_PRIORITY[s] ?? 99));
        const pb = Math.min(...b.sources.map((s) => LOOKUP_SOURCE_PRIORITY[s] ?? 99));
        return pa - pb;
      });
      if (papers.length > 0) {
        paper = papers[0]!;
        for (let i = 1; i < papers.length; i++) {
          const extra = papers[i]!;
          if (!paper.abstract && extra.abstract) paper.abstract = extra.abstract;
          if (!paper.citationCount && extra.citationCount) paper.citationCount = extra.citationCount;
          if (!paper.pdfUrl && extra.pdfUrl) paper.pdfUrl = extra.pdfUrl;
          for (const src of extra.sources) {
            if (!paper.sources.includes(src)) paper.sources.push(src);
          }
        }
      }
      break;
    }
    case "s2": {
      const limiter = rateLimiters.get("semantic");
      paper = limiter
        ? await limiter.schedule("semantic", () => lookupSemanticScholar(identified.normalized, signal))
        : await lookupSemanticScholar(identified.normalized, signal);
      break;
    }
    case "openalex": {
      paper = await lookupOpenAlex(identified.normalized, signal);
      break;
    }
  }

  return paper;
}

/**
 * Resolve a paper ID to get both s2Id and openAlexId via parallel lookups.
 * Merges results to maximize the chance both citation sources can be used.
 */
async function resolvePaperForCitations(
  identified: import("./identify-id.ts").IdentifiedId,
  signal?: AbortSignal,
): Promise<{ paper: PaperResult | null; errors: string[] }> {
  let s2Paper: PaperResult | null = null;
  let oaPaper: PaperResult | null = null;
  const errors: string[] = [];

  switch (identified.type) {
    case "doi": {
      const [s2Result, oaResult] = await Promise.allSettled([
        rateLimiters.get("semantic")?.schedule("semantic", () => lookupSemanticScholar(`DOI:${identified.normalized}`, signal)) ?? lookupSemanticScholar(`DOI:${identified.normalized}`, signal),
        lookupOpenAlex(identified.normalized, signal),
      ]);
      s2Paper = s2Result.status === "fulfilled" ? s2Result.value : null;
      oaPaper = oaResult.status === "fulfilled" ? oaResult.value : null;
      break;
    }
    case "arxiv": {
      // First get S2 result to check for DOI
      const s2Limiter = rateLimiters.get("semantic");
      s2Paper = s2Limiter
        ? await s2Limiter.schedule("semantic", () => lookupSemanticScholar(`ARXIV:${identified.normalized}`, signal)).catch(() => null)
        : await lookupSemanticScholar(`ARXIV:${identified.normalized}`, signal).catch(() => null);
      // Use DOI to look up OpenAlex (arXiv ID not directly supported by OpenAlex lookup)
      if (s2Paper?.doi) {
        oaPaper = await lookupOpenAlex(s2Paper.doi, signal).catch(() => null);
      } else {
        errors.push("OpenAlex: cannot resolve arXiv ID without DOI (no DOI found in Semantic Scholar)");
      }
      break;
    }
    case "pmid": {
      const [s2Result, oaResult] = await Promise.allSettled([
        rateLimiters.get("semantic")?.schedule("semantic", () => lookupSemanticScholar(`PMID:${identified.normalized}`, signal)) ?? lookupSemanticScholar(`PMID:${identified.normalized}`, signal),
        lookupOpenAlex(`pmid:${identified.normalized}`, signal),
      ]);
      s2Paper = s2Result.status === "fulfilled" ? s2Result.value : null;
      oaPaper = oaResult.status === "fulfilled" ? oaResult.value : null;
      break;
    }
    case "s2": {
      const limiter = rateLimiters.get("semantic");
      s2Paper = limiter
        ? await limiter.schedule("semantic", () => lookupSemanticScholar(identified.normalized, signal)).catch(() => null)
        : await lookupSemanticScholar(identified.normalized, signal).catch(() => null);
      break;
    }
    case "openalex": {
      oaPaper = await lookupOpenAlex(identified.normalized, signal).catch(() => null);
      break;
    }
  }

  // Merge: take the first non-null and fill missing IDs from the other
  if (s2Paper && oaPaper) {
    if (!s2Paper.openAlexId && oaPaper.openAlexId) s2Paper.openAlexId = oaPaper.openAlexId;
    for (const src of oaPaper.sources) {
      if (!s2Paper.sources.includes(src)) s2Paper.sources.push(src);
    }
    return { paper: s2Paper, errors };
  }
  return { paper: s2Paper ?? oaPaper, errors };
}

// --- Extension factory ---

/** Module-level rate limiters, initialized by the factory function. */
let rateLimiters = createRateLimiters(false, false);

export default function (pi: ExtensionAPI) {
  const availability = getProviderAvailability();
  rateLimiters = createRateLimiters(hasS2Key(), hasPubmedKey());

  // Register the academic_search tool
  pi.registerTool({
    name: "academic_search",
    label: "Academic Search",
    description: `Search academic papers across multiple sources. Returns merged, deduplicated results with title, authors, year, citation count, source, and DOI.\n\nAvailable sources: ${
      Object.entries(availability)
        .filter(([, v]) => v)
        .map(([k]) => SOURCE_LABELS[k as SourceId])
        .join(", ")
    }.\n\n- Pass a DOI or arXiv ID as the query to auto-route to direct paper lookup.\n- Use categories to restrict arXiv results to specific categories (e.g. ["cs.CL","cs.LG"]).\n- Set enrich=true (default) to auto-fill missing abstracts from Semantic Scholar.`,
    parameters: Type.Object({
      query: Type.String({ description: "Search query for academic papers. Also accepts DOI (10.xxxx/yyyy) or arXiv ID for direct lookup." }),
      sources: Type.Optional(
        Type.Union([
          StringEnum([...SOURCES]),
          Type.Array(StringEnum([...SOURCES]), { minItems: 1 }),
        ], { description: `Sources to search. Defaults to ${DEFAULT_SOURCES.join(", ")}.` }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max results per source (default 10, max 50)", minimum: 1, maximum: 50 }),
      ),
      year: Type.Optional(
        Type.String({ description: "Year filter: '2023' or '2020-2024' range" }),
      ),
      openAccessOnly: Type.Optional(
        Type.Boolean({ description: "Only return open access papers" }),
      ),
      categories: Type.Optional(
        Type.Array(Type.String(), { description: "arXiv categories to restrict results (e.g. ['cs.CL','cs.LG']). Only affects arXiv source." }),
      ),
      enrich: Type.Optional(
        Type.Boolean({ description: "Auto-fill missing abstracts from Semantic Scholar batch API (default true)" }),
      ),
    }),
    async execute(_callId: string, params: { query: string; sources?: unknown; limit?: number; year?: string; openAccessOnly?: boolean; categories?: string[]; enrich?: boolean }, signal: AbortSignal | undefined) {
      const { query } = params;
      const requestedSources = normalizeSourcesParam(params.sources);
      const limit = Math.min(Math.max(params.limit ?? loadConfig().defaultLimit ?? 10, 1), 50);
      const year = params.year ?? undefined;
      const openAccessOnly = params.openAccessOnly ?? false;
      const categories = params.categories;
      const enrich = params.enrich ?? true;

      // E. ID-based auto-routing: if query identifies as a paper ID, resolve first
      const identified = identifyId(query);
      let idPaper: PaperResult | null = null;
      if (identified) {
        try {
          idPaper = await resolvePaperById(identified, signal);
        } catch {
          // Silent — fall through to normal search
        }
      }

      // Filter to available sources
      const sources = requestedSources.filter((s) => {
        const avail = availability[s as keyof ProviderAvailability];
        return avail === true;
      });

      if (sources.length === 0 && !idPaper) {
        return {
          content: [{ type: "text" as const, text: "No available sources. Check your configuration." }],
          details: { error: "no_sources", requestedSources },
        };
      }

      // Execute searches in parallel across sources
      // Sources with internal per-request rate limiting (openalex, pubmed) skip the outer wrapper
      const INTERNAL_LIMITED = new Set(["openalex", "pubmed"]);
      const searchOptions = { query, limit, year, openAccessOnly, categories, signal };
      const searchPromises = sources.map(async (source) => {
        if (INTERNAL_LIMITED.has(source)) {
          return SEARCH_FNS[source]!(query, searchOptions);
        }
        const limiter = rateLimiters.get(source);
        if (limiter) {
          return limiter.schedule(source, () => SEARCH_FNS[source]!(query, searchOptions));
        }
        return SEARCH_FNS[source]!(query, searchOptions);
      });

      const settled = await Promise.allSettled(searchPromises);

      const allPapers: PaperResult[] = [];
      const failedSources: Array<{ source: string; error: string }> = [];

      // E. Prepend ID-resolved paper so it participates in dedup
      if (idPaper) {
        allPapers.push(idPaper);
      }

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]!;
        const sourceId = sources[i]!;
        if (result.status === "fulfilled") {
          allPapers.push(...result.value);
        } else {
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          failedSources.push({ source: SOURCE_LABELS[sourceId], error: errMsg.slice(0, 200) });
        }
      }

      // All sources failed and no ID paper
      if (allPapers.length === 0 && failedSources.length === sources.length) {
        const plan = buildErrorPlan(query, failedSources, sources.length);

        // Add credential invalid hints
        const credentialHints: string[] = [];
        for (const sourceId of sources) {
          const hasKey = sourceId === "semantic" ? hasS2Key()
            : sourceId === "openalex" ? hasOpenAlexKey()
            : sourceId === "crossref" ? hasCredentialSource({ provider: "Crossref", configuredValue: loadConfig().crossrefMailto, environmentValue: process.env.CROSSREF_MAILTO })
            : sourceId === "pubmed" ? hasPubmedKey()
            : false;
          const hint = getCredentialInvalidHint(sourceId, hasKey);
          if (hint) credentialHints.push(`[${SOURCE_LABELS[sourceId]}] ${hint}`);
        }

        const suffix = credentialHints.length > 0 ? "\n\n" + credentialHints.join("\n") : "";
        return {
          content: [{ type: "text" as const, text: plan.collapsed + suffix }],
          details: { error: [...plan.expanded, ...(credentialHints.length > 0 ? ["", ...credentialHints] : [])], failedSources },
        };
      }

      // F. Sort by source priority before dedup: semantic > openalex > arxiv > crossref > dblp > pubmed
      const SOURCE_PRIORITY: Record<SourceId, number> = {
        semantic: 0,
        openalex: 1,
        arxiv: 2,
        crossref: 3,
        dblp: 4,
        pubmed: 5,
      };
      allPapers.sort((a, b) => {
        const pa = Math.min(...a.sources.map((s) => SOURCE_PRIORITY[s as SourceId] ?? 99));
        const pb = Math.min(...b.sources.map((s) => SOURCE_PRIORITY[s as SourceId] ?? 99));
        return pa - pb;
      });

      // Deduplicate and assign IDs
      const deduped = deduplicatePapers(allPapers);

      // C. Post-dedupe year filter on merged results
      let filtered = deduped;
      if (year) {
        filtered = filtered.filter((p) => yearMatchesFilter(p.year, year));
      }

      // D. Post-dedupe OA filter at aggregation layer
      if (openAccessOnly) {
        filtered = filtered.filter((p) => p.isOpenAccess);
      }

      const withIds = assignIds(filtered);

      // D. Enrich missing abstracts from Semantic Scholar batch API
      let finalPapers = withIds;
      if (enrich) {
        try {
          const s2Limiter = rateLimiters.get("semantic");
          finalPapers = s2Limiter
            ? await s2Limiter.schedule("semantic", () => enrichAbstractsBatch(withIds, signal))
            : await enrichAbstractsBatch(withIds, signal);
        } catch {
          // Silent — enrichment failure does not affect main results
        }
      }

      // Store results
      const storedId = generateId();
      const storedData: StoredPaperData = {
        id: storedId,
        type: "paper-search",
        timestamp: Date.now(),
        query,
        papers: finalPapers,
        failedSources,
      };
      storeResult(storedData);

      // Format output
      const content = formatResultsMarkdown(finalPapers, query, failedSources);

      return {
        content: [{ type: "text" as const, text: content }],
        details: {
          id: storedId,
          papers: finalPapers,
          failedSources,
          totalResults: finalPapers.length,
          sourcesQueried: sources,
        },
      };
    },
    // `as any` needed: upstream ToolDefinition<TDetails> requires a single TDetails, but our
    // execute returns multiple branches with different `details` shapes. Safe at runtime.
  } as any);
  pi.registerTool({
    name: "paper_lookup",
    label: "Paper Lookup",
    description: `Look up a single academic paper by ID. Supports bare DOI, doi:/DOI:, https://doi.org/, ARXIV:, PMID:, S2:, OPENALEX:, and bare arXiv IDs. Returns a detailed Markdown card with abstract, metadata, and identifiers.`,
    parameters: Type.Object({
      id: Type.String({ description: "Paper identifier: DOI, ARXIV:xxx, PMID:xxx, S2:xxx, OPENALEX:xxx, or bare arXiv ID" }),
    }),
    async execute(_callId: string, params: { id: string }, signal: AbortSignal | undefined) {
      const identified = identifyId(params.id);
      if (!identified) {
        return {
          content: [{ type: "text" as const, text: `Could not identify paper ID format: "${params.id}".\n\nSupported formats:\n- DOI: 10.xxxx/yyyy, doi:10.xxxx/yyyy, https://doi.org/10.xxxx/yyyy\n- arXiv: ARXIV:2301.07041, bare 2301.07041\n- PubMed: PMID:12345678\n- Semantic Scholar: S2:abc123\n- OpenAlex: OPENALEX:W12345` }],
          details: { error: "unrecognized_id", input: params.id },
        };
      }

      let paper: PaperResult | null = null;

      try {
        paper = await resolvePaperById(identified, signal);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error looking up "${params.id}": ${errMsg}` }],
          details: { error: errMsg, input: params.id },
        };
      }

      if (!paper) {
        return {
          content: [{ type: "text" as const, text: `No paper found for "${params.id}" (identified as ${identified.type}: ${identified.normalized}).` }],
          details: { error: "not_found", input: params.id },
        };
      }

      // Assign storage ID
      const withId = { ...paper, id: generateId() };
      const card = formatPaperCard(withId);

      return {
        content: [{ type: "text" as const, text: card }],
        details: withId,
      };
    },
    // `as any` needed: same ToolDefinition<TDetails> single-type constraint as above.
  } as any);

  // --- paper_citations tool ---
  pi.registerTool({
    name: "paper_citations",
    label: "Paper Citations",
    description: `Get citing papers or references for a paper. Only Semantic Scholar and OpenAlex support citation/reference queries. If the paper ID is not a DOI or S2/OpenAlex ID, it will be looked up first to resolve the identifiers needed.`,
    parameters: Type.Object({
      id: Type.String({ description: "Paper identifier (any supported format)" }),
      direction: StringEnum(["citing", "references"], { description: "'citing' = papers citing this one; 'references' = papers this one cites" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 20, max 100)", minimum: 1, maximum: 100 }),
      ),
    }),
    async execute(_callId: string, params: { id: string; direction: string; limit?: number }, signal: AbortSignal | undefined) {
      const limit = Math.min(params.limit ?? 20, 100);
      const direction = params.direction as "citing" | "references";

      const identified = identifyId(params.id);
      if (!identified) {
        return {
          content: [{ type: "text" as const, text: `Could not identify paper ID: "${params.id}"` }],
          details: { error: "unrecognized_id", input: params.id },
        };
      }

      // Resolve the paper — parallel lookups to get both s2Id and openAlexId
      let paper: PaperResult | null = null;
      const resolveErrors: string[] = [];
      try {
        const resolved = await resolvePaperForCitations(identified, signal);
        paper = resolved.paper;
        resolveErrors.push(...resolved.errors);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error resolving paper "${params.id}": ${errMsg}` }],
          details: { error: errMsg, input: params.id },
        };
      }

      if (!paper) {
        return {
          content: [{ type: "text" as const, text: `Could not resolve paper "${params.id}". Ensure the paper exists in Semantic Scholar or OpenAlex.` }],
          details: { error: "not_found", input: params.id },
        };
      }

      const allResults: PaperResult[] = [];
      const errors: string[] = [...resolveErrors];

      // Try S2 and OpenAlex citations in parallel
      const citationPromises: Array<Promise<PaperResult[]>> = [];

      if (paper.s2Id) {
        const s2Limiter = rateLimiters.get("semantic");
        citationPromises.push(
          (s2Limiter
            ? s2Limiter.schedule("semantic", () => citationsSemanticScholar(paper.s2Id!, direction, limit, signal))
            : citationsSemanticScholar(paper.s2Id, direction, limit, signal)
          ).catch((err) => {
            errors.push(`S2: ${err instanceof Error ? err.message : String(err)}`);
            return [] as PaperResult[];
          }),
        );
      } else {
        errors.push("S2: No Semantic Scholar ID available for this paper");
      }

      if (paper.openAlexId) {
        citationPromises.push(
          citationsOpenAlex(paper.openAlexId!, direction, limit, signal).catch((err) => {
            errors.push(`OpenAlex: ${err instanceof Error ? err.message : String(err)}`);
            return [] as PaperResult[];
          }),
        );
      } else {
        errors.push("OpenAlex: No OpenAlex ID available for this paper");
      }

      if (citationPromises.length > 0) {
        const settled = await Promise.allSettled(citationPromises);
        for (const result of settled) {
          if (result.status === "fulfilled") {
            allResults.push(...result.value);
          }
        }
      }

      if (allResults.length === 0) {
        const credentialHints: string[] = [];
        if (paper.s2Id) {
          const hint = getCredentialInvalidHint("semantic", hasS2Key());
          if (hint) credentialHints.push(`[S2] ${hint}`);
        }
        if (paper.openAlexId) {
          const hint = getCredentialInvalidHint("openalex", hasOpenAlexKey());
          if (hint) credentialHints.push(`[OpenAlex] ${hint}`);
        }
        const hintSuffix = credentialHints.length > 0 ? "\n\n" + credentialHints.join("\n") : "";
        const msg = errors.length > 0
          ? `No ${direction} found for "${params.id}".\n\n${errors.join("\n")}${hintSuffix}`
          : `Neither Semantic Scholar nor OpenAlex support citation queries for "${params.id}". Ensure the paper has a S2 or OpenAlex ID.`;
        return {
          content: [{ type: "text" as const, text: msg }],
          details: { error: "no_results", input: params.id, direction, errors },
        };
      }

      const content = [
        `Found ${allResults.length} ${direction === "citing" ? "citing papers" : "references"} for "${params.id}":`,
        "",
        "| # | Title | Authors | Year | Source | DOI |",
        "|---|-------|---------|------|--------|-----|",
        ...allResults.map((p, i) => {
          const num = String(i + 1);
          const title = escapeMarkdownCell(truncate(p.title, 60));
          const authorsStr = escapeMarkdownCell(formatAuthorsShort(p.authors));
          const year = p.year ? String(p.year) : "—";
          const source = escapeMarkdownCell(p.sources.join(", "));
          const doi = p.doi ? `[${escapeMarkdownCell(truncate(p.doi, 30))}](https://doi.org/${encodeURIComponent(p.doi)})` : "—";
          return `| ${num} | ${title} | ${authorsStr} | ${year} | ${source} | ${doi} |`;
        }),
      ];

      if (errors.length > 0) {
        content.push("", "---", "Notes:");
        for (const e of errors) {
          content.push(`- ${e}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: content.join("\n") }],
        details: {
          papers: allResults,
          direction,
          totalResults: allResults.length,
          errors,
        },
      };
    },
    // `as any` needed: same ToolDefinition<TDetails> single-type constraint as above.
  } as any);

  // --- download_pdf tool ---
  pi.registerTool({
    name: "download_pdf",
    label: "Download PDF",
    description: `Download a paper's open-access PDF to local disk. Supports arXiv direct download, Unpaywall DOI-based OA lookup, and direct PDF URLs. ⚠️ Writes files to the local filesystem (default: ./papers). Provide arxivId, doi, or a resultId from a previous academic_search.`,
    parameters: Type.Object({
      doi: Type.Optional(Type.String({ description: "Paper DOI (e.g. 10.1234/abcd)" })),
      arxivId: Type.Optional(Type.String({ description: "arXiv ID (e.g. 1706.03762)" })),
      resultId: Type.Optional(Type.String({ description: "Result ID from a previous academic_search call" })),
      outputDir: Type.Optional(Type.String({ description: "Output directory (default: ./papers)" })),
    }),
    async execute(
      _callId: string,
      params: { doi?: string; arxivId?: string; resultId?: string; outputDir?: string },
      signal: AbortSignal | undefined,
    ) {
      // At least one identifier required
      if (!params.doi && !params.arxivId && !params.resultId) {
        return {
          content: [{ type: "text" as const, text: "Provide at least one of: doi, arxivId, or resultId (from a previous academic_search)." }],
          details: { error: "no_identifier" },
        };
      }

      const config = loadConfig();
      let outputDirRaw = params.outputDir ?? config.downloadDir ?? "./papers";

      // Reject empty outputDir or NUL characters
      if (outputDirRaw.length === 0 || outputDirRaw.includes("\0")) {
        return {
          content: [{ type: "text" as const, text: `Output directory rejected: empty or contains NUL character.` }],
          details: { error: "output_dir_invalid", outputDir: outputDirRaw },
        };
      }

      // Expand ~ to home directory
      if (outputDirRaw.startsWith("~/") || outputDirRaw === "~") {
        outputDirRaw = outputDirRaw.replace(/^~/, homedir());
      }

      // Resolve relative paths against cwd
      const outputDir = isAbsolute(outputDirRaw)
        ? normalize(outputDirRaw)
        : pathResolve(process.cwd(), outputDirRaw);

      // Boundary check: realpath must be within allowed root
      // Strict check: downloadAllowOutsideCwd must be exactly true (not a truthy string)
      if (config.downloadAllowOutsideCwd !== true) {
        const allowRoot = normalize(process.cwd());
        // Create the directory first so realpath can succeed
        if (!existsSync(outputDir)) {
          mkdirSync(outputDir, { recursive: true });
        }
        let resolvedDir: string;
        try {
          resolvedDir = await realpath(outputDir);
        } catch {
          resolvedDir = outputDir;
        }
        const normalizedRoot = normalize(allowRoot) + "/";
        const normalizedDir = normalize(resolvedDir);
        if (normalizedDir !== normalize(allowRoot) && !normalizedDir.startsWith(normalizedRoot)) {
          return {
            content: [{ type: "text" as const, text: `Output directory rejected: "${outputDirRaw}" resolves outside the working directory (${allowRoot}). Set downloadAllowOutsideCwd: true in config to allow writing outside cwd.` }],
            details: { error: "output_dir_escape", outputDir: outputDirRaw, resolvedDir, allowRoot },
          };
        }
      }

      // Build download input from parameters
      let doi = params.doi;
      let arxivId = params.arxivId;
      let paper: { doi?: string; arxivId?: string; pdfUrl?: string; title?: string } | undefined;

      // If resultId given, look up the paper in storage
      if (params.resultId) {
        const allResults = getAllResults();
        let found = false;
        for (const stored of allResults) {
          const match = stored.papers.find((p) => p.id === params.resultId);
          if (match) {
            doi = doi ?? match.doi;
            arxivId = arxivId ?? match.arxivId;
            paper = {
              doi: match.doi,
              arxivId: match.arxivId,
              pdfUrl: match.pdfUrl,
              title: match.title,
            };
            found = true;
            break;
          }
        }
        if (!found) {
          return {
            content: [{ type: "text" as const, text: `Result ID "${params.resultId}" not found in storage. Run academic_search first to generate a result ID.` }],
            details: { error: "result_not_found", resultId: params.resultId },
          };
        }
      }

      if (!paper && (doi || arxivId)) {
        paper = { doi, arxivId };
      }

      try {
        const result = await downloadPaperPdf(
          { doi, arxivId, paper },
          outputDir,
          signal,
        );

        const fileSize = formatBytes(result.bytes);
        const sourceLabel =
          result.source === "arxiv" ? "arXiv direct"
          : result.source === "unpaywall" ? "Unpaywall OA"
          : "direct URL";

        const title = paper?.title;
        const markdown = [
          `✅ PDF downloaded successfully`,
          ``,
          `| Field | Value |`,
          `|-------|-------|`,
          `| **File** | \`${result.filePath}\` |`,
          `| **Size** | ${fileSize} |`,
          `| **Source** | ${sourceLabel} |`,
          title ? `| **Title** | ${title} |` : "",
          doi ? `| **DOI** | [${doi}](https://doi.org/${doi}) |` : "",
          arxivId ? `| **arXiv** | [${arxivId}](https://arxiv.org/abs/${arxivId}) |` : "",
        ].filter(Boolean).join("\n");

        return {
          content: [{ type: "text" as const, text: markdown }],
          details: {
            ...result,
            doi,
            arxivId,
            title,
          },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `❌ Download failed: ${errMsg}` }],
          details: { error: errMsg, doi, arxivId, outputDir },
        };
      }
    },
    // `as any` needed: same ToolDefinition<TDetails> single-type constraint as above.
  } as any);

  // --- /academic-search config command ---
  pi.registerCommand("academic-search", {
    description: "Configure academic search providers and credentials",
    async handler(_args: string, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("Configuration UI requires an interactive terminal. Edit ~/.pi/academic-search.json manually.", "warning");
        return;
      }

      const avail = getProviderAvailability();

      // Credential status for each provider
      function getCredentialStatus(): Record<string, string> {
        const config = loadConfig();
        const status: Record<string, string> = {};
        status["semantic"] = hasCredentialSource({ provider: "SemanticScholar", configuredValue: config.semanticScholarApiKey, environmentValue: process.env.S2_API_KEY })
          ? "✓ key configured" : "✗ no key (3s rate limit)";
        status["openalex"] = hasCredentialSource({ provider: "OpenAlex", configuredValue: config.openAlexApiKey, environmentValue: process.env.OPENALEX_API_KEY })
          ? "✓ api key" : "✗ no key";
        status["openalex"] += " | " + (hasCredentialSource({ provider: "OpenAlex", configuredValue: config.openAlexMailto, environmentValue: process.env.OPENALEX_MAILTO })
          ? "✓ mailto" : "✗ no mailto (still works)");
        status["crossref"] = hasCredentialSource({ provider: "Crossref", configuredValue: config.crossrefMailto, environmentValue: process.env.CROSSREF_MAILTO })
          ? "✓ mailto configured" : "✗ no mailto (still works)";
        status["arxiv"] = "no credentials needed";
        status["dblp"] = "no credentials needed";
        status["pubmed"] = hasCredentialSource({ provider: "PubMed", configuredValue: config.ncbiApiKey, environmentValue: process.env.NCBI_API_KEY })
          ? "✓ API key configured" : "✗ no key (350ms rate limit)";
        status["unpaywall"] = hasCredentialSource({ provider: "Unpaywall", configuredValue: config.unpaywallEmail, environmentValue: process.env.UNPAYWALL_EMAIL })
          ? "✓ email configured" : "✗ no email (unavailable)";
        return status;
      }

      const credStatus = getCredentialStatus();

      while (true) {
        const mainOptions = [
          ...SOURCES.map((src) => `${SOURCE_LABELS[src]} — ${avail[src] ? "available" : "unavailable"} | ${credStatus[src]}${formatHealthSuffix(src) ? ` ${formatHealthSuffix(src)}` : ""}`),
          `Unpaywall (PDF download) — ${isUnpaywallAvailable() ? "available" : "unavailable"} | ${credStatus["unpaywall"]}`,
          "Show status",
          "Cancel",
        ];

        const choice = await ctx.ui.select("Select a provider to configure:", mainOptions);
        if (!choice || choice === "Cancel") {
          return;
        }

        if (choice === "Show status") {
          const lines = ["## Academic Search Provider Status", ""];
          for (const src of SOURCES) {
            const available = avail[src];
            const healthSuffix = formatHealthSuffix(src);
            lines.push(`- **${SOURCE_LABELS[src]}**: ${available ? "✓ available" : "✗ unavailable"} | ${credStatus[src]}${healthSuffix ? ` ${healthSuffix}` : ""}`);
          }
          lines.push(`- **Unpaywall (PDF)**: ${isUnpaywallAvailable() ? "✓ available" : "✗ unavailable"} | ${credStatus["unpaywall"]}`);
          lines.push("");
          lines.push(`Config file: ${CONFIG_PATH}`);
          const healthData = getAllHealth();
          if (Object.keys(healthData).length > 0) {
            lines.push("");
            lines.push(`Health file: ${getAcademicSearchConfigDir()}/academic-search-health.json`);
          }
          ctx.ui.notify(lines.join("\n"), "info");
          continue;
        }

        // Parse the selected provider from the choice string
        const srcChoice = choice.split(" — ")[0]?.trim();
        const src = srcChoice ? normalizeSource(srcChoice) : null;

        // Handle Unpaywall configuration (not a standard source)
        if (srcChoice === "Unpaywall (PDF download)") {
          const value = await ctx.ui.input("Unpaywall email (supports $ENV, !command, blank to clear):");
          if (value === undefined) continue;

          if (value.trim() === "") {
            saveConfig({ unpaywallEmail: null } as Partial<AcademicSearchConfig>);
            ctx.ui.notify("Cleared Unpaywall email.", "info");
          } else {
            saveConfig({ unpaywallEmail: value } as Partial<AcademicSearchConfig>);
            ctx.ui.notify("Saved Unpaywall email.", "info");
          }

          resetUnpaywallCache();
          Object.assign(credStatus, getCredentialStatus());
          continue;
        }

        if (!src) continue;

        let prompt: string;
        let configKey: string;

        switch (src) {
          case "semantic":
            prompt = "Semantic Scholar API key (supports $ENV, !command, blank to clear):";
            configKey = "semanticScholarApiKey";
            break;
          case "pubmed":
            prompt = "NCBI API key (supports $ENV, !command, blank to clear):";
            configKey = "ncbiApiKey";
            break;
          case "crossref":
            prompt = "Crossref mailto email (supports $ENV, !command, blank to clear):";
            configKey = "crossrefMailto";
            break;
          case "openalex": {
            const credentialType = await ctx.ui.select("OpenAlex credential type:", [
              "API key (recommended, 10x daily budget)",
              "mailto email (polite pool)",
            ]);
            if (!credentialType) continue;
            if (credentialType.startsWith("API key")) {
              prompt = "OpenAlex API key (supports $ENV, !command, blank to clear):";
              configKey = "openAlexApiKey";
            } else {
              prompt = "OpenAlex mailto email (supports $ENV, !command, blank to clear):";
              configKey = "openAlexMailto";
            }
            break;
          }
          default:
            ctx.ui.notify(`${SOURCE_LABELS[src]} requires no credentials.`, "info");
            continue;
        }

        const value = await ctx.ui.input(prompt);
        if (value === undefined) continue; // user cancelled input

        if (value.trim() === "") {
          saveConfig({ [configKey]: null } as Partial<AcademicSearchConfig>);
          ctx.ui.notify(`Cleared ${SOURCE_LABELS[src]} credential.`, "info");
        } else {
          saveConfig({ [configKey]: value } as Partial<AcademicSearchConfig>);
          ctx.ui.notify(`Saved ${SOURCE_LABELS[src]} credential.`, "info");
        }

        // Reset provider caches and rebuild rate limiters so new credentials take effect immediately
        resetS2Cache();
        resetOpenAlexCache();
        resetCrossrefCache();
        resetPubmedCache();
        resetUnpaywallCache();
        // Rebuild rate limiters with updated key status
        const newLimiters = createRateLimiters(hasS2Key(), hasPubmedKey());
        for (const [key, limiter] of newLimiters) {
          rateLimiters.set(key, limiter);
        }

        // Refresh credential status
        Object.assign(credStatus, getCredentialStatus());
      }
    },
  });
}

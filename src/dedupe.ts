import type { PaperResult } from "./types.ts";

/**
 * Normalize a DOI for deduplication:
 * - lowercase
 * - strip https://doi.org/ or http://dx.doi.org/ prefix
 * - trim whitespace
 */
export function normalizeDoi(doi: string | undefined): string | null {
  if (!doi) return null;
  let normalized = doi.trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
  return normalized || null;
}

/**
 * Normalize an arXiv ID for deduplication:
 * - strip "arxiv:" or "ARXIV:" prefix
 * - strip version suffix (v1, v2, etc.)
 * - trim whitespace
 */
export function normalizeArxivId(id: string | undefined): string | null {
  if (!id) return null;
  let normalized = id.trim().toLowerCase();
  normalized = normalized.replace(/^arxiv:/, "");
  normalized = normalized.replace(/v\d+$/, "");
  return normalized || null;
}

/**
 * Simple fuzzy title normalization for matching:
 * - lowercase
 * - Unicode-aware: keep \p{L} (letters) and \p{N} (numbers), remove rest
 * - collapse whitespace
 */
export function normalizeTitle(title: string | undefined): string | null {
  if (!title) return null;
  return title
    .toLowerCase()
    .replace(/[\p{L}\p{N}]+/gu, (m) => m) // keep Unicode letters/numbers
    .replace(/[^\p{L}\p{N}\s]/gu, "") // remove punctuation/symbols
    .replace(/\s+/g, " ")
    .trim() || null;
}

/**
 * Check if two papers have overlapping author surnames (for title merge gating).
 */
function hasAuthorOverlap(a: PaperResult, b: PaperResult): boolean {
  const surnamesA = new Set(
    a.authors.map((name) => {
      const parts = name.trim().split(/\s+/);
      return parts[parts.length - 1]?.toLowerCase() ?? "";
    }).filter(Boolean),
  );
  for (const name of b.authors) {
    const parts = name.trim().split(/\s+/);
    const surname = parts[parts.length - 1]?.toLowerCase() ?? "";
    if (surname && surnamesA.has(surname)) return true;
  }
  return false;
}

/**
 * Deduplicate and merge paper results from multiple sources.
 *
 * Merge priority:
 * 1. DOI match (strongest)
 * 2. arXiv ID match
 * 3. Title fuzzy match (after normalization)
 *
 * When merging, fields from the first occurrence win for scalar fields;
 * `sources` arrays are concatenated and deduplicated.
 * Citation counts take the max from any source.
 *
 * After merging, all identity keys from the incoming paper are registered
 * to point to the merged representative.
 */
export function deduplicatePapers(papers: PaperResult[]): PaperResult[] {
  const byDoi = new Map<string, PaperResult>();
  const byArxiv = new Map<string, PaperResult>();
  const byTitle = new Map<string, PaperResult>();
  const result: PaperResult[] = [];

  for (const paper of papers) {
    const doiKey = normalizeDoi(paper.doi);
    const arxivKey = normalizeArxivId(paper.arxivId);
    const titleKey = normalizeTitle(paper.title);

    // Try DOI match first
    if (doiKey && byDoi.has(doiKey)) {
      const existing = byDoi.get(doiKey)!;
      mergeInto(existing, paper);
      registerKeys(byDoi, byArxiv, byTitle, existing, paper);
      continue;
    }

    // Then arXiv ID
    if (arxivKey && byArxiv.has(arxivKey)) {
      const existing = byArxiv.get(arxivKey)!;
      mergeInto(existing, paper);
      registerKeys(byDoi, byArxiv, byTitle, existing, paper);
      continue;
    }

    // Then title fuzzy match (with gating)
    if (titleKey && byTitle.has(titleKey)) {
      const existing = byTitle.get(titleKey)!;
      // Gate: require normalized title length >= 20 and (year match or author overlap)
      if (titleKey.length >= 20) {
        const yearMatch = existing.year && paper.year && existing.year === paper.year;
        const authorOverlap = hasAuthorOverlap(existing, paper);
        if (yearMatch || authorOverlap) {
          mergeInto(existing, paper);
          registerKeys(byDoi, byArxiv, byTitle, existing, paper);
          continue;
        }
      }
    }

    // New unique paper
    result.push(paper);
    if (doiKey) byDoi.set(doiKey, paper);
    if (arxivKey) byArxiv.set(arxivKey, paper);
    if (titleKey) byTitle.set(titleKey, paper);
  }

  return result;
}

/**
 * Register all identity keys from `incoming` paper to point to `existing` representative.
 * This ensures subsequent papers with the same keys are deduplicated.
 */
function registerKeys(
  byDoi: Map<string, PaperResult>,
  byArxiv: Map<string, PaperResult>,
  byTitle: Map<string, PaperResult>,
  existing: PaperResult,
  incoming: PaperResult,
): void {
  const doiKey = normalizeDoi(incoming.doi);
  const arxivKey = normalizeArxivId(incoming.arxivId);
  const titleKey = normalizeTitle(incoming.title);
  if (doiKey) byDoi.set(doiKey, existing);
  if (arxivKey) byArxiv.set(arxivKey, existing);
  if (titleKey) byTitle.set(titleKey, existing);
}

/**
 * Merge data from `incoming` into `existing`.
 * - Scalar fields: keep existing (first occurrence)
 * - sources: concatenate + deduplicate
 * - citationCount/referenceCount/influentialCitationCount: take max
 * - isOpenAccess: true if any source says true
 * - pdfUrl/landingPageUrl: keep existing, fill from incoming if missing
 */
function mergeInto(existing: PaperResult, incoming: PaperResult): void {
  // Merge sources
  for (const src of incoming.sources) {
    if (!existing.sources.includes(src)) {
      existing.sources.push(src);
    }
  }

  // Take max citation counts
  if (incoming.citationCount != null) {
    existing.citationCount = Math.max(existing.citationCount ?? 0, incoming.citationCount);
  }
  if (incoming.referenceCount != null) {
    existing.referenceCount = Math.max(existing.referenceCount ?? 0, incoming.referenceCount);
  }
  if (incoming.influentialCitationCount != null) {
    existing.influentialCitationCount = Math.max(
      existing.influentialCitationCount ?? 0,
      incoming.influentialCitationCount,
    );
  }

  // Open access: true if any says true
  if (incoming.isOpenAccess) existing.isOpenAccess = true;

  // Fill missing URLs
  if (!existing.pdfUrl && incoming.pdfUrl) existing.pdfUrl = incoming.pdfUrl;
  if (!existing.landingPageUrl && incoming.landingPageUrl) existing.landingPageUrl = incoming.landingPageUrl;

  // Fill missing abstract
  if (!existing.abstract && incoming.abstract) existing.abstract = incoming.abstract;

  // Fill missing identifiers
  if (!existing.doi && incoming.doi) existing.doi = incoming.doi;
  if (!existing.arxivId && incoming.arxivId) existing.arxivId = incoming.arxivId;
  if (!existing.pmid && incoming.pmid) existing.pmid = incoming.pmid;
  if (!existing.s2Id && incoming.s2Id) existing.s2Id = incoming.s2Id;
  if (!existing.openAlexId && incoming.openAlexId) existing.openAlexId = incoming.openAlexId;
}

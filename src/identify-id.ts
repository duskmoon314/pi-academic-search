/**
 * Identify and normalize academic paper IDs.
 *
 * Supports:
 * - Bare DOI: 10.xxxx/yyyy
 * - DOI with prefix: doi:, DOI:, https://doi.org/, http://dx.doi.org/
 * - arXiv: ARXIV:, arxiv: prefix; bare arXiv ID (new-style 2301.07041, old-style cs/0501001)
 * - PubMed: PMID:, pmid:
 * - Semantic Scholar: S2:
 * - OpenAlex: OPENALEX:
 */

export type IdType = "doi" | "arxiv" | "pmid" | "s2" | "openalex";

export interface IdentifiedId {
  type: IdType;
  normalized: string;
}

/**
 * Identify the type of an academic paper ID string.
 *
 * Returns `{ type, normalized }` or `null` if unrecognised.
 */
export function identifyId(id: string): IdentifiedId | null {
  const trimmed = id.trim();
  if (!trimmed) return null;

  // --- Semantic Scholar ID ---
  const s2Match = trimmed.match(/^s2:(.+)$/i);
  if (s2Match) {
    const norm = s2Match[1]!.trim();
    if (norm) return { type: "s2", normalized: norm };
  }

  // --- OpenAlex ID ---
  const openalexMatch = trimmed.match(/^openalex:(.+)$/i);
  if (openalexMatch) {
    const norm = openalexMatch[1]!.trim();
    if (norm) return { type: "openalex", normalized: norm.startsWith("W") ? norm : `W${norm}` };
  }

  // --- DOI: bare, doi:, DOI:, https://doi.org/, http://dx.doi.org/ ---
  const doiMatch = trimmed.match(
    /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.\d{4,}\/.+)$/i,
  );
  if (doiMatch) {
    return { type: "doi", normalized: doiMatch[1]!.toLowerCase() };
  }

  // --- ARXIV: prefix ---
  const arxivPrefixMatch = trimmed.match(/^arxiv:(.+)$/i);
  if (arxivPrefixMatch) {
    const norm = normalizeArxivIdString(arxivPrefixMatch[1]!);
    if (norm) return { type: "arxiv", normalized: norm };
  }

  // --- Bare arXiv ID (new-style: 2301.07041 or 2301.07041v2) ---
  const bareArxivNew = trimmed.match(/^(\d{4}\.\d{4,5}(?:v\d+)?)$/);
  if (bareArxivNew) {
    return { type: "arxiv", normalized: bareArxivNew[1]!.replace(/v\d+$/, "") };
  }

  // --- Bare arXiv ID (old-style: cs/0501001, hep-ph/0001001) ---
  const bareArxivOld = trimmed.match(/^([a-z-]+(?:\.[a-z-]+)?\/\d{7}(?:v\d+)?)$/i);
  if (bareArxivOld) {
    return { type: "arxiv", normalized: bareArxivOld[1]!.replace(/v\d+$/, "").toLowerCase() };
  }

  // --- PMID: prefix ---
  const pmidMatch = trimmed.match(/^pmid:(\d+)$/i);
  if (pmidMatch) {
    return { type: "pmid", normalized: pmidMatch[1]! };
  }

  return null;
}

/**
 * Normalize an arXiv ID string (without prefix).
 * Strips version suffix and lowercases old-style IDs.
 */
function normalizeArxivIdString(id: string): string | null {
  const stripped = id.trim().replace(/v\d+$/, "");
  // New-style: 2301.07041
  if (/^\d{4}\.\d{4,5}$/.test(stripped)) return stripped;
  // Old-style: cs/0501001
  if (/^[a-z-]+(?:\.[a-z-]+)?\/\d{7}$/i.test(stripped)) return stripped.toLowerCase();
  return null;
}

/** Unified paper result returned by all providers. */
export interface PaperResult {
  /** Storage-internal unique ID (assigned by storage layer). */
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  abstract?: string;
  doi?: string;
  arxivId?: string;
  pmid?: string;
  s2Id?: string;
  openAlexId?: string;
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
  isOpenAccess: boolean;
  pdfUrl?: string;
  landingPageUrl?: string;
  /** All sources that contributed this merged result. */
  sources: string[];
  sourceUrl: string;
}

/** Options passed to a search provider. */
export interface SearchOptions {
  query: string;
  limit: number;
  year?: string;
  openAccessOnly?: boolean;
  categories?: string[];
  signal?: AbortSignal;
}

/** Provider capabilities used for aggregation. */
export interface ProviderCapabilities {
  search: boolean;
  lookup: boolean;
  citations: boolean;
}

/** Shape of a provider module (each provider file exports these). */
export interface ProviderModule {
  isAvailable(): boolean;
  search(query: string, options: SearchOptions): Promise<PaperResult[]>;
  lookup?(id: string, signal?: AbortSignal): Promise<PaperResult | null>;
  citations?(id: string, direction: "citing" | "references", limit: number, signal?: AbortSignal): Promise<PaperResult[]>;
}

/** Known provider source identifiers. */
export const SOURCES = [
  "semantic",
  "openalex",
  "crossref",
  "arxiv",
  "dblp",
  "pubmed",
] as const;

export type SourceId = (typeof SOURCES)[number];

/** Default sources when the user does not specify. Used as the single source of truth
 *  for README and the tool description. */
export const DEFAULT_SOURCES: SourceId[] = ["semantic", "openalex", "arxiv", "dblp", "crossref"];

/** Config shape stored in ~/.pi/academic-search.json. */
export interface AcademicSearchConfig {
  semanticScholarApiKey?: string | null;
  ncbiApiKey?: string | null;
  coreApiKey?: string | null;
  crossrefMailto?: string | null;
  unpaywallEmail?: string | null;
  openAlexMailto?: string | null;
  openAlexApiKey?: string | null;
  defaultSources?: SourceId[];
  defaultLimit?: number;
  downloadDir?: string;
  downloadAllowOutsideCwd?: boolean;
  proxy?: string | null;
}

/** Stored search result entry (for storage.ts). */
export interface StoredPaperData {
  id: string;
  type: "paper-search";
  timestamp: number;
  query: string;
  papers: PaperResult[];
  failedSources: Array<{ source: string; error: string }>;
}

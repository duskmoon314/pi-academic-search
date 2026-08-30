# Pi Academic Search

**Multi-source academic paper search, lookup, citation analysis, and PDF download for Pi coding agent.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

Search across Semantic Scholar, OpenAlex, Crossref, arXiv, DBLP, and PubMed — merged and deduplicated. Look up papers by DOI, arXiv ID, or PMID. Explore citation graphs. Download open-access PDFs.

## Install

```bash
pi install npm:@duskmoon/pi-academic-search
```

Works immediately with no API keys — Semantic Scholar, OpenAlex, Crossref, arXiv, DBLP, and PubMed all support keyless access. Add API keys for better rate limits and Unpaywall for PDF downloads.

### OpenAlex API Key

OpenAlex offers a free API key (register at [openalex.org](https://openalex.org), then get your key at [openalex.org/settings/api](https://openalex.org/settings/api)). Adding an API key increases your daily request budget by 10x. The key works alongside the `mailto` polite pool mechanism — both can be configured simultaneously.

## Quick Start

```typescript
// Search papers across default sources (semantic, openalex, arxiv, dblp, crossref)
academic_search({ query: "transformer attention mechanism" })

// Search with arXiv category filtering
academic_search({ query: "mixture of experts", categories: ["cs.CL", "cs.LG"] })

// Auto-route DOI query to direct lookup
academic_search({ query: "10.1145/3292500.3330919" })

// Search specific sources with filters
academic_search({ query: "quantum computing", sources: ["arxiv", "semantic"], year: "2023-2024", limit: 5 })

// Look up a paper by ID
paper_lookup({ id: "ARXIV:1706.03762" })
paper_lookup({ id: "10.1145/3292500.3330919" })
paper_lookup({ id: "PMID:12345678" })

// Get citations or references
paper_citations({ id: "ARXIV:1706.03762", direction: "citing", limit: 20 })

// Download an open-access PDF
download_pdf({ arxivId: "1706.03762" })
download_pdf({ doi: "10.1145/3292500.3330919", outputDir: "./papers" })
download_pdf({ resultId: "abc12345" }) // from a previous academic_search
```

## Tools

### academic_search

Search academic papers across multiple sources. Returns merged, deduplicated results. Supports ID-based auto-routing, arXiv category filtering, and abstract enrichment.

```typescript
academic_search({
  query: "transformer attention mechanism",
  sources: ["semantic", "openalex", "arxiv"],  // optional, defaults to semantic, openalex, arxiv, dblp, crossref
  limit: 10,                                    // per source, default 10, max 50
  year: "2020-2024",                            // optional year filter
  openAccessOnly: false,                        // optional OA filter
  categories: ["cs.CL", "cs.LG"],              // optional, arXiv categories
  enrich: true                                  // optional, fill missing abstracts (default true)
})

// ID auto-routing — pass a DOI or arXiv ID as query
academic_search({ query: "10.1145/3292500.3330919" })
academic_search({ query: "2301.07041" })
```

| Parameter | Description |
|-----------|-------------|
| `query` | Search query string, DOI, or arXiv ID (auto-routed to direct lookup) |
| `sources` | Single source or array of sources. Default: semantic, openalex, arxiv, dblp, crossref |
| `limit` | Max results per source (1–50, default 10) |
| `year` | Year filter: `"2023"` or `"2020-2024"` range (applied post-dedupe) |
| `openAccessOnly` | Only return open access papers |
| `categories` | arXiv categories to restrict results (e.g. `["cs.CL","cs.LG"]`) |
| `enrich` | Auto-fill missing abstracts from Semantic Scholar batch API (default true) |

Results are stored with a unique ID (TTL 1 hour) for reference by other tools.

### paper_lookup

Look up a single paper by identifier. Returns a detailed Markdown card with abstract, metadata, and all known identifiers.

```typescript
paper_lookup({ id: "10.1145/3292500.3330919" })
paper_lookup({ id: "ARXIV:1706.03762" })
paper_lookup({ id: "PMID:12345678" })
paper_lookup({ id: "S2:abc123def" })
paper_lookup({ id: "OPENALEX:W2741809807" })
```

Supported ID formats:
- **DOI**: bare `10.xxxx/yyyy`, `doi:10.xxxx/yyyy`, `https://doi.org/10.xxxx/yyyy`
- **arXiv**: `ARXIV:2301.07041`, bare `2301.07041`, old-style `cs/0501001`
- **PubMed**: `PMID:12345678`
- **Semantic Scholar**: `S2:abc123def`
- **OpenAlex**: `OPENALEX:W2741809807`

### paper_citations

Get citing papers or references for a paper. Only Semantic Scholar and OpenAlex support citation queries.

```typescript
paper_citations({ id: "ARXIV:1706.03762", direction: "citing" })
paper_citations({ id: "10.1145/3292500.3330919", direction: "references", limit: 50 })
```

| Parameter | Description |
|-----------|-------------|
| `id` | Paper identifier (any supported format) |
| `direction` | `"citing"` = papers citing this one; `"references"` = papers this one cites |
| `limit` | Max results (default 20, max 100) |

### download_pdf

Download an open-access PDF to local disk. ⚠️ **Writes files to the local filesystem.**

```typescript
download_pdf({ arxivId: "1706.03762" })
download_pdf({ doi: "10.1145/3292500.3330919" })
download_pdf({ resultId: "abc12345", outputDir: "./papers" })
```

| Parameter | Description |
|-----------|-------------|
| `doi` | Paper DOI |
| `arxivId` | arXiv paper ID |
| `resultId` | Result ID from a previous `academic_search` call |
| `outputDir` | Output directory (default: `./papers`) |

At least one of `doi`, `arxivId`, or `resultId` is required.

**Download chain priority:**
1. arXiv direct link (if arXiv ID available) — highest priority
2. Unpaywall OA lookup (if DOI available and Unpaywall email configured)
3. Direct PDF URL from paper metadata (from search results or lookup)

**Safety:** Validates response `content-type` or `%PDF` magic bytes before writing. 100 MB size limit (streaming check). 60-second download timeout. Existing files get a random suffix to avoid overwrites. All download URLs are validated against SSRF: only HTTPS allowed, DNS-resolved IPs are checked for private/loopback/link-local ranges, and redirects are followed manually with per-hop validation (max 5 hops).

**Output directory boundary:** By default, `outputDir` must resolve within the current working directory. Set `downloadAllowOutsideCwd: true` in config to allow writing outside cwd. Paths starting with `~` are expanded to the home directory.

## Commands

### /academic-search

Interactive configuration wizard for providers and credentials. Opens a selection menu to configure each provider's API key or email.

## Configuration

Config file: `~/.pi/academic-search.json` (all fields optional).

```json
{
  "semanticScholarApiKey": "$S2_API_KEY",
  "ncbiApiKey": "$NCBI_API_KEY",
  "coreApiKey": null,
  "crossrefMailto": "me@example.com",
  "unpaywallEmail": "$UNPAYWALL_EMAIL",
  "openAlexMailto": null,
  "openAlexApiKey": null,
  "defaultSources": ["semantic", "openalex", "arxiv", "crossref", "dblp"],
  "defaultLimit": 10,
  "downloadDir": "./papers",
  "downloadAllowOutsideCwd": false,
  "proxy": null
}
```

All credential fields support:
- **Literal**: `"sk-xxx"` — plain text value
- **Environment variable**: `"$VAR"` or `"${VAR}"` — read from environment
- **Command**: `"!op read op://Private/..."` — execute local command, use stdout
- **Escape**: `"$$..."` or `"$!..."` — literal `$` or `!` prefix

### Environment Variables

| Variable | Used By | Purpose |
|----------|---------|---------|
| `S2_API_KEY` | Semantic Scholar | API key for higher rate limits |
| `NCBI_API_KEY` | PubMed | API key for higher rate limits |
| `CROSSREF_MAILTO` | Crossref | Email for Polite Pool access |
| `UNPAYWALL_EMAIL` | Unpaywall | Email required for PDF download (free, 100k/day) |
| `OPENALEX_MAILTO` | OpenAlex | Email for polite access |
| `OPENALEX_API_KEY` | OpenAlex | API key for 10x daily request budget |

When a config value is null/absent, the corresponding environment variable is tried automatically.

## Providers

| Provider | Search | Lookup | Citations | Key Required | Rate Limit (no key) |
|----------|--------|--------|-----------|--------------|---------------------|
| Semantic Scholar | ✓ | ✓ | ✓ | Optional | ~3s interval |
| OpenAlex | ✓ | ✓ | ✓ | Optional (API key or mailto) | Default limits |
| Crossref | ✓ | ✓ | — | Optional (mailto) | Default limits |
| arXiv | ✓ | ✓ | — | No | 3s interval |
| DBLP | ✓ | — | — | No | ~1s interval |
| PubMed | ✓ | ✓ | — | Optional | ~350ms interval |

## License

MIT

## Provider Health Status

The extension passively records the health status of each provider during normal use — no extra requests are made. When a provider consistently returns errors (e.g., 403 for invalid credentials, 429 for rate limiting), a brief health indicator is shown in the `/academic-search` status display.

**Health indicators:**
- `⚠ HTTP 403 (凭据可能无效) · 5分钟前` — authentication may be invalid
- `⏳ 429 限速 · 2分钟前` — rate limited
- `⚠ 503 服务端错误 · 1分钟前` — server-side issue
- `⚠ 网络/超时 · 30秒前` — network connectivity issue

Health data is stored in `academic-search-health.json` alongside the config file (e.g., `~/.pi/academic-search-health.json`). It resets to healthy status once a successful request is made.

## Quality Pack Features

### 429 Retry with Backoff

All provider requests automatically retry on HTTP 429 (rate limit) errors. Retries respect the `Retry-After` header when present, otherwise use exponential backoff (1s → 2s → 4s, capped at 20s). External abort signals are honored during retry waits.

### ID Auto-Routing

Pass a DOI or arXiv ID as the `query` parameter to `academic_search` and it will automatically resolve the paper via direct lookup, prepend the result to search results, and deduplicate normally.

### arXiv Category Filtering

Use the `categories` parameter to restrict arXiv results to specific categories (e.g., `["cs.CL", "cs.LG"]`). Queries with existing arXiv field prefixes (ti:, au:, abs:, cat:, all:) or boolean operators (AND/OR/ANDNOT) are passed through verbatim.

### Abstract Enrichment

By default (`enrich: true`), papers missing abstracts are enriched via the Semantic Scholar batch API (up to 20 papers per call, matched by DOI). Failures are silent — the original results are returned unchanged.

### Source Priority

When the same paper appears from multiple sources, the first source in the priority order determines scalar fields (title, year, abstract, etc.): Semantic Scholar > OpenAlex > arXiv > Crossref > DBLP > PubMed.

### Open Access Filtering

When `openAccessOnly` is true, OA filtering is applied uniformly at the aggregation layer after deduplication, based on the merged `isOpenAccess` field. DBLP results are always marked as `isOpenAccess: false` (the `ee` field indicates electronic edition, not open access).

### Post-Dedupe Year Filter

The `year` filter is applied after deduplication on the merged results, ensuring consistent filtering regardless of which source contributed the data. Papers without a year field are preserved (not filtered out).

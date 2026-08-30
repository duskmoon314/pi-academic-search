/**
 * PDF download orchestration.
 *
 * Download chain priority:
 * 1. arXiv direct link (if arxivId present)
 * 2. Unpaywall OA PDF (if doi present and Unpaywall available)
 * 3. paper.pdfUrl fallback (from storage record or paper_lookup result)
 *
 * Returns `{ filePath, bytes, source }` on success.
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isUnpaywallAvailable, getUnpaywallPdfUrl } from "./unpaywall.ts";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_PDF_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_REDIRECTS = 5;

// --- SSRF protection ---

/** Check if an IPv4 address is private/loopback/link-local. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number) as [number, number];
  if (a === 127) return true;                           // loopback
  if (a === 10) return true;                            // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16
  if (a === 169 && b === 254) return true;               // link-local / cloud metadata
  return false;
}

/** Check if an IPv6 address is private/loopback/link-local. */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::") return true;                        // unspecified
  if (lower === "::1") return true;                      // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("fe80")) return true;             // link-local fe80::/10
  // IPv4-mapped: ::ffff:x.x.x.x → extract v4 part and check
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]!);
  return false;
}

/**
 * Validate a URL for outbound download requests.
 * Rejects non-https, private IPs, and cloud metadata addresses.
 */
async function validateDownloadUrl(urlStr: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Blocked: only HTTPS URLs allowed, got ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
  // Block obvious private hostnames
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error(`Blocked: localhost/local hostname not allowed`);
  }
  // DNS resolve and check ALL resolved IPs
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`Blocked: DNS resolution failed for ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new Error(`Blocked: DNS resolution returned no addresses for ${hostname}`);
  }
  for (const entry of addresses) {
    if (isPrivateIPv4(entry.address) || isPrivateIPv6(entry.address)) {
      throw new Error(`Blocked: resolved to private IP ${entry.address}`);
    }
  }
}

/**
 * Safe fetch wrapper for PDF downloads.
 * - Only HTTPS
 * - DNS validation against private IPs
 * - Manual redirect handling with per-hop validation
 * - Streaming size limit (100MB)
 * - Returns { bytes, contentType } for compatibility
 */
export async function safeFetchDownload(
  url: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; contentType: string }> {
  await validateDownloadUrl(url);

  let currentUrl = url;
  let redirects = 0;

  while (true) {
    const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    const response = await fetch(currentUrl, {
      signal: combinedSignal,
      redirect: "manual",
    });

    // Handle redirects manually
    if (response.status >= 300 && response.status < 400) {
      redirects++;
      if (redirects > MAX_REDIRECTS) {
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect without Location header`);
      }
      // Resolve relative redirects
      const nextUrl = new URL(location, currentUrl).toString();
      await validateDownloadUrl(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";

    // Streaming size check
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > MAX_PDF_BYTES) {
        throw new Error(`PDF too large: ${size} bytes (max ${MAX_PDF_BYTES})`);
      }
    }

    // Stream body with size limit
    const buffer = await streamToBuffer(response, combinedSignal);
    return { bytes: buffer, contentType };
  }
}

/**
 * Stream a response body to a buffer, aborting if it exceeds MAX_PDF_BYTES.
 */
async function streamToBuffer(
  response: Response,
  combinedSignal?: AbortSignal,
): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    throw new Error("Empty response body");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = body.getReader();

  try {
    while (true) {
      if (combinedSignal?.aborted) {
        throw new Error("Download cancelled");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalBytes += value.length;
        if (totalBytes > MAX_PDF_BYTES) {
          // Cancel the reader before throwing to release resources
          await reader.cancel().catch(() => {});
          throw new Error(`PDF too large: exceeds ${MAX_PDF_BYTES} bytes during download`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

export interface DownloadResult {
  filePath: string;
  bytes: number;
  source: "arxiv" | "unpaywall" | "direct";
}

export interface DownloadInput {
  doi?: string;
  arxivId?: string;
  paper?: {
    doi?: string;
    arxivId?: string;
    pdfUrl?: string;
    title?: string;
  };
}

/** A single download attempt entry in the chain. */
export interface DownloadAttempt {
  url: string;
  source: DownloadResult["source"];
  label: string;
}

/**
 * Build the ordered list of download attempts.
 * Exported for testing chain priority logic without making real HTTP requests.
 */
export function buildDownloadChain(input: DownloadInput): DownloadAttempt[] {
  const attempts: DownloadAttempt[] = [];

  // 1. arXiv direct link (highest priority)
  const arxivId = input.arxivId ?? input.paper?.arxivId;
  if (arxivId) {
    const arxivUrl = `https://arxiv.org/pdf/${normalizeArxivId(arxivId)}.pdf`;
    attempts.push({ url: arxivUrl, source: "arxiv", label: `arXiv (${arxivUrl})` });
  }

  // 2. Unpaywall OA PDF
  const doi = input.doi ?? input.paper?.doi;
  if (doi && isUnpaywallAvailable()) {
    attempts.push({
      url: `unpaywall:${doi}`,
      source: "unpaywall",
      label: `Unpaywall (${doi})`,
    });
  }

  // 3. paper.pdfUrl fallback
  if (input.paper?.pdfUrl) {
    attempts.push({
      url: input.paper.pdfUrl,
      source: "direct",
      label: `direct (${input.paper.pdfUrl})`,
    });
  }

  return attempts;
}

/**
 * Download a paper PDF and save it to disk.
 *
 * @param input - Identifiers for the paper (doi, arxivId, or paper object with pdfUrl)
 * @param outputDir - Directory to save the PDF to
 * @param signal - AbortSignal for cancellation
 * @param fetcher - Optional custom fetcher for testing (defaults to fetch + downloadFile)
 */
export async function downloadPaperPdf(
  input: DownloadInput,
  outputDir: string,
  signal?: AbortSignal,
  fetcher?: (url: string, signal?: AbortSignal) => Promise<{ bytes: Buffer; contentType: string }>,
): Promise<DownloadResult> {
  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  // Build the chain of download attempts
  const attempts = buildDownloadChain(input);
  const tried: string[] = [];

  if (attempts.length === 0) {
    throw new Error(
      "No open-access PDF found. Provide an arXiv ID, DOI (with Unpaywall email configured), or a direct PDF URL.",
    );
  }

  // Generate filename
  const title = input.paper?.title;
  const fallbackId = input.arxivId ?? input.paper?.arxivId ?? input.doi ?? input.paper?.doi ?? "paper";
  const filename = sanitizeFilename(title, fallbackId);
  const baseFilepath = join(outputDir, filename);

  // Try each attempt in order
  let lastError: string | undefined;

  for (const attempt of attempts) {
    tried.push(attempt.label);

    if (signal?.aborted) {
      throw new Error("Download cancelled");
    }

    try {
      if (attempt.source === "unpaywall") {
        // Unpaywall needs special handling — resolve the DOI first
        const doi = input.doi ?? input.paper?.doi;
        if (!doi) {
          lastError = "No DOI available for Unpaywall lookup";
          continue;
        }
        const result = await getUnpaywallPdfUrl(doi, signal);
        if (!result || !result.pdfUrl) {
          lastError = "Unpaywall returned no PDF URL";
          continue;
        }
        const filePath = await ensureUniqueFilepath(baseFilepath);
        if (fetcher) {
          const fetched = await fetcher(result.pdfUrl, signal);
          // Size validation for injected fetcher path
          if (fetched.bytes.length > MAX_PDF_BYTES) {
            throw new Error(`PDF too large: ${fetched.bytes.length} bytes (max ${MAX_PDF_BYTES})`);
          }
          validatePdf(fetched.bytes, fetched.contentType);
          await writeFile(filePath, fetched.bytes);
          return { filePath, bytes: fetched.bytes.length, source: "unpaywall" };
        }
        const bytes = await downloadFile(result.pdfUrl, filePath, signal);
        return { filePath, bytes, source: "unpaywall" };
      } else {
        const filePath = await ensureUniqueFilepath(baseFilepath);
        if (fetcher) {
          const fetched = await fetcher(attempt.url, signal);
          // Size validation for injected fetcher path
          if (fetched.bytes.length > MAX_PDF_BYTES) {
            throw new Error(`PDF too large: ${fetched.bytes.length} bytes (max ${MAX_PDF_BYTES})`);
          }
          validatePdf(fetched.bytes, fetched.contentType);
          await writeFile(filePath, fetched.bytes);
          return { filePath, bytes: fetched.bytes.length, source: attempt.source };
        }
        const bytes = await downloadFile(attempt.url, filePath, signal);
        return { filePath, bytes, source: attempt.source };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
  }

  // All attempts failed
  throw new Error(
    `Failed to download PDF. Tried:\n${tried.map((t) => `  - ${t}`).join("\n")}\nLast error: ${lastError ?? "unknown"}`,
  );
}

/**
 * Validate that a buffer is a PDF (by content-type or magic bytes).
 */
export function validatePdf(buffer: Buffer, contentType: string): void {
  const isPdfContentType = contentType.toLowerCase().includes("pdf");
  const isPdfMagic = buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "%PDF";

  if (!isPdfContentType && !isPdfMagic) {
    throw new Error(
      `Not a PDF: content-type="${contentType}", magic="${buffer.subarray(0, 4).toString("ascii")}"`,
    );
  }

  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(`PDF too large: ${buffer.length} bytes (max ${MAX_PDF_BYTES})`);
  }

  if (buffer.length === 0) {
    throw new Error("Empty response body");
  }
}

/**
 * Download a file from a URL, validate it's a PDF, and write to disk.
 * Uses SSRF-safe fetch (HTTPS-only, DNS validation, manual redirects, streaming size limit).
 */
async function downloadFile(url: string, filePath: string, signal?: AbortSignal): Promise<number> {
  const { bytes, contentType } = await safeFetchDownload(url, signal);

  validatePdf(bytes, contentType);

  await writeFile(filePath, bytes);
  return bytes.length;
}

/**
 * Sanitize a paper title for use as a filename.
 * - Remove characters not allowed in filenames
 * - Collapse whitespace to hyphens
 * - Limit length to 80 characters
 * - Fall back to the provided ID if no usable title
 */
export function sanitizeFilename(title: string | undefined, fallbackId: string): string {
  let base = "";

  if (title && title.trim().length > 0) {
    base = title
      // Remove characters not allowed in filenames (cross-platform safe set)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      // Replace remaining whitespace with hyphens
      .replace(/\s+/g, "-")
      // Remove leading/trailing hyphens and dots
      .replace(/^[-.]+|[-.]+$/g, "")
      // Collapse multiple hyphens
      .replace(/-+/g, "-")
      // Limit length
      .slice(0, 80);
  }

  // If sanitization left nothing usable, fall back to ID
  if (!base || base.length === 0) {
    base = sanitizeId(fallbackId);
  }

  return `${base}.pdf`;
}

/**
 * Sanitize a paper ID for use as a filename.
 * Note: `/` is replaced with `-` (not removed) to preserve readability.
 */
function sanitizeId(id: string): string {
  // First replace / with - (preserving readability), then strip other illegal chars
  return (
    id
      .replace(/\//g, "-")
      .replace(/[<>:"\\|?*\x00-\x1f]/g, "")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "paper"
  );
}

/**
 * Ensure a unique filepath by appending a random suffix if the file already exists.
 */
async function ensureUniqueFilepath(filepath: string): Promise<string> {
  try {
    await access(filepath);
    // File exists — append random suffix
    const ext = ".pdf";
    const base = filepath.slice(0, -ext.length);
    const suffix = randomBytes(4).toString("hex");
    return `${base}-${suffix}${ext}`;
  } catch {
    // File does not exist — use as-is
    return filepath;
  }
}

/**
 * Normalize an arXiv ID for use in download URLs.
 * Strips arxiv: prefix and version suffix.
 */
function normalizeArxivId(id: string): string {
  return id
    .replace(/^arxiv:/i, "")
    .replace(/v\d+$/, "")
    .trim();
}

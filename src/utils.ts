import { homedir } from "node:os";
import { join } from "node:path";
import { recordProviderOutcome } from "./health.ts";

/**
 * Resolve config directory, aligned with pi-web-access pattern.
 * Priority: PI_CODING_AGENT_DIR → XDG_CONFIG_HOME/pi → ~/.pi
 */
export function getAcademicSearchConfigDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "pi");
  return join(homedir(), ".pi");
}

/** Full path to the academic-search config file. */
export function getAcademicSearchConfigPath(): string {
  return join(getAcademicSearchConfigDir(), "academic-search.json");
}

interface RetryOptions {
  maxRetries?: number;
}

/**
 * Fetch with AbortSignal.timeout merged with an optional external signal.
 * Always uses a 30s timeout as required.
 *
 * When `provider` is given, the outcome is passively recorded for health
 * tracking. Abort (signal.aborted) is not recorded.
 *
 * When `retry` is given, HTTP 429 responses trigger automatic retry with
 * exponential backoff (respecting Retry-After header). Health is only
 * recorded once on the final result.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  externalSignal?: AbortSignal,
  provider?: string,
  retry?: RetryOptions,
): Promise<Response> {
  const maxRetries = retry?.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeoutSignal = AbortSignal.timeout(30_000);
    const signal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (err) {
      // Don't record deliberate aborts
      if (externalSignal?.aborted) throw err;
      if (provider) {
        const message = err instanceof Error ? err.message : String(err);
        recordProviderOutcome(provider, { ok: false, status: "network", message: message.slice(0, 200) });
      }
      throw err;
    }

    // Handle 429 with retry
    if (response.status === 429 && attempt < maxRetries) {
      const retryAfterHeader = response.headers.get("retry-after");
      let delayMs: number;
      if (retryAfterHeader) {
        const seconds = parseRetryAfter(retryAfterHeader);
        delayMs = seconds != null ? Math.min(seconds * 1000, 20_000) : Math.min(1000 * Math.pow(2, attempt), 20_000);
      } else {
        delayMs = Math.min(1000 * Math.pow(2, attempt), 20_000);
      }
      // Respect external abort signal during wait
      if (externalSignal?.aborted) throw new Error("The operation was aborted");
      await sleep(delayMs, externalSignal);
      continue;
    }

    // Record health only on the final result (not on intermediate 429 retries)
    if (provider && !externalSignal?.aborted) {
      if (response.ok) {
        recordProviderOutcome(provider, { ok: true });
      } else {
        // Health only stores status code + fixed category phrase (no raw body)
        const category = response.status === 429 ? "rate-limited"
          : response.status === 401 || response.status === 403 ? "auth-error"
          : response.status >= 500 ? "server-error"
          : "client-error";
        recordProviderOutcome(provider, {
          ok: false,
          status: response.status,
          message: category,
        });
      }
    }

    return response;
  }

  // Unreachable in practice — the loop returns on any non-429 response
  throw new Error("Max retries exceeded");
}

/**
 * Parse a year filter string and check if a year matches.
 * Supports single year "2023" and range "2020-2024".
 * Returns true if the year passes the filter (or if no year is present, to avoid false rejection).
 */
export function yearMatchesFilter(year: number | undefined, yearFilter: string): boolean {
  // Papers without a year field are preserved (not rejected)
  if (year === undefined) return true;
  const parts = yearFilter.split("-");
  if (parts.length === 1) {
    const target = parseInt(parts[0]!, 10);
    return year === target;
  }
  if (parts.length === 2) {
    const from = parseInt(parts[0]!, 10);
    const to = parseInt(parts[1]!, 10);
    return year >= from && year <= to;
  }
  return true;
}

/**
 * Redact a credential string from error messages.
 */
export function redactCredential(text: string, credential: string | null | undefined): string {
  if (!credential) return text;
  return text.split(credential).join("[redacted]");
}

/**
 * Parse a Retry-After header value.
 * Supports:
 * - Non-negative integer (seconds)
 * - HTTP-date (RFC 7231)
 *
 * Returns seconds, clamped to 0–20s, or null if unparseable.
 */
export function parseRetryAfter(header: string): number | null {
  // Try non-negative integer first
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds, 20);
  }

  // Try HTTP-date format
  const targetMs = Date.parse(header);
  if (!isNaN(targetMs)) {
    const diffSec = Math.max(0, (targetMs - Date.now()) / 1000);
    return Math.min(diffSec, 20);
  }

  return null;
}

/**
 * Simple sleep helper for rate limiting.
 * When a signal is provided, resolves early on abort.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("The operation was aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("The operation was aborted"));
      }, { once: true });
    }
  });
}

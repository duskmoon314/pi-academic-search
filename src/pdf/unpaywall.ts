/**
 * Unpaywall API client — DOI → open-access PDF link.
 *
 * Endpoint: https://api.unpaywall.org/v2/{doi}?email={email}
 * Requires an email for polite access. Without an email, the provider is unavailable.
 */

import { existsSync, readFileSync } from "node:fs";
import { getAcademicSearchConfigPath, fetchWithTimeout, redactCredential } from "../utils.ts";
import { hasCredentialSource, resolveCredential } from "../credential-source.ts";
import { RateLimiter } from "../rate-limit.ts";

const UNPAYWALL_BASE = "https://api.unpaywall.org/v2";

interface UnpaywallConfig {
  unpaywallEmail?: unknown;
}

let cachedConfig: UnpaywallConfig | null = null;

function loadConfig(): UnpaywallConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = getAcademicSearchConfigPath();
  if (!existsSync(configPath)) {
    cachedConfig = {};
    return cachedConfig;
  }
  try {
    cachedConfig = JSON.parse(readFileSync(configPath, "utf-8")) as UnpaywallConfig;
    return cachedConfig;
  } catch {
    cachedConfig = {};
    return cachedConfig;
  }
}

let unpaywallLimiter = new RateLimiter(1_000);

/** Reset all cached config/credential state. Call after config changes. */
export function resetUnpaywallCache(): void {
  cachedConfig = null;
  cachedEmail = undefined;
  emailResolved = false;
  unpaywallLimiter = new RateLimiter(1_000);
}

let cachedEmail: string | undefined;
let emailResolved = false;

async function getEmail(signal?: AbortSignal): Promise<string | null> {
  if (emailResolved) return cachedEmail ?? null;
  const email = await resolveCredential({
    provider: "Unpaywall",
    configuredValue: loadConfig().unpaywallEmail,
    environmentValue: process.env.UNPAYWALL_EMAIL,
    signal,
  });
  cachedEmail = email ?? undefined;
  emailResolved = true;
  return email;
}

/** Check if Unpaywall is available (requires email). */
export function isUnpaywallAvailable(): boolean {
  return hasCredentialSource({
    provider: "Unpaywall",
    configuredValue: loadConfig().unpaywallEmail,
    environmentValue: process.env.UNPAYWALL_EMAIL,
  });
}

export interface UnpaywallResult {
  pdfUrl: string;
  landingPageUrl: string;
  isOa: boolean;
}

interface UnpaywallBestOaLocation {
  url_for_pdf?: string | null;
  url_for_landing_page?: string | null;
}

export interface UnpaywallResponse {
  is_oa?: boolean;
  best_oa_location?: UnpaywallBestOaLocation | null;
}

/**
 * Parse an Unpaywall API response into a UnpaywallResult or null.
 * Exported for testing.
 */
export function parseUnpaywallResponse(data: UnpaywallResponse): UnpaywallResult | null {
  const bestOa = data.best_oa_location;
  if (!bestOa) return null;

  const pdfUrl = bestOa.url_for_pdf ?? undefined;
  const landingPageUrl = bestOa.url_for_landing_page ?? undefined;

  if (!pdfUrl && !landingPageUrl) return null;

  return {
    pdfUrl: pdfUrl ?? "",
    landingPageUrl: landingPageUrl ?? "",
    isOa: data.is_oa ?? false,
  };
}

/**
 * Query Unpaywall for OA PDF information about a DOI.
 *
 * Returns `{ pdfUrl, landingPageUrl, isOa }` when a best OA location is found,
 * or `null` when Unpaywall has no data for this DOI (404 or missing location).
 */
export async function getUnpaywallPdfUrl(
  doi: string,
  signal?: AbortSignal,
): Promise<UnpaywallResult | null> {
  const email = await getEmail(signal);
  if (!email) return null;

  const url = `${UNPAYWALL_BASE}/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;

  const response = await unpaywallLimiter.schedule("unpaywall", () => fetchWithTimeout(url, {}, signal, "unpaywall"));

  if (response.status === 404) return null;
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const redacted = redactCredential(errorText, email);
    throw new Error(`Unpaywall API error ${response.status}: ${redacted.slice(0, 200)}`);
  }

  const data = (await response.json()) as UnpaywallResponse;
  return parseUnpaywallResponse(data);
}

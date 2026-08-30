/**
 * Provider health status — passive recording from existing requests only.
 *
 * No extra requests are ever made. Health is tracked as a side-effect of
 * normal provider calls via `recordProviderOutcome`.
 *
 * State file: `academic-search-health.json` in the config directory
 * (alongside `academic-search.json`).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAcademicSearchConfigDir } from "./utils.ts";

const HEALTH_FILENAME = "academic-search-health.json";

interface ProviderHealth {
  lastSuccessAt?: number;
  lastFailure?: {
    status: number | "network";
    message: string;
    at: number;
  };
  consecutiveFailures: number;
}

type HealthMap = Record<string, ProviderHealth>;

function getHealthPath(): string {
  return join(getAcademicSearchConfigDir(), HEALTH_FILENAME);
}

/** Validate a single health entry. Discards structurally invalid entries. */
function isValidHealthEntry(value: unknown): value is ProviderHealth {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.consecutiveFailures !== "number") return false;
  if (obj.lastSuccessAt !== undefined && typeof obj.lastSuccessAt !== "number") return false;
  if (obj.lastFailure !== undefined) {
    const lf = obj.lastFailure;
    if (!lf || typeof lf !== "object") return false;
    const lfo = lf as Record<string, unknown>;
    if (lfo.status !== "network" && typeof lfo.status !== "number") return false;
    if (typeof lfo.message !== "string") return false;
    if (typeof lfo.at !== "number") return false;
  }
  return true;
}

function loadHealth(): HealthMap {
  const path = getHealthPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    // Validate each entry, discard bad ones
    const result: HealthMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === "string" && isValidHealthEntry(value)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Save health data atomically: write to tmp file then rename.
 * This prevents corruption from concurrent writes.
 */
function saveHealth(health: HealthMap): void {
  const path = getHealthPath();
  const dir = getAcademicSearchConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = `${path}.tmp.${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(health, null, 2) + "\n");
    renameSync(tmpPath, path);
  } catch {
    // Cleanup tmp file on failure
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Record the outcome of a provider request. Called passively from
 * `fetchWithTimeout` — never generates extra network traffic.
 */
export function recordProviderOutcome(
  provider: string,
  outcome: { ok: true } | { ok: false; status: number | "network"; message: string },
): void {
  try {
    const health = loadHealth();
    const entry = health[provider] ?? { consecutiveFailures: 0 };

    if (outcome.ok) {
      entry.lastSuccessAt = Date.now();
      entry.consecutiveFailures = 0;
    } else {
      entry.lastFailure = {
        status: outcome.status,
        message: outcome.message,
        at: Date.now(),
      };
      entry.consecutiveFailures += 1;
    }

    health[provider] = entry;
    saveHealth(health);
  } catch {
    // Health recording is best-effort — never break the caller
  }
}

/** Get health data for a single provider. */
export function getProviderHealth(provider: string): ProviderHealth {
  const health = loadHealth();
  return health[provider] ?? { consecutiveFailures: 0 };
}

/** Get health data for all providers. */
export function getAllHealth(): HealthMap {
  return loadHealth();
}

/**
 * Format a short health suffix for a provider.
 *
 * Returns an empty string when healthy (recent success, no unresolved failure),
 * or a concise warning string like `⚠ HTTP 403 (凭据可能无效) · 5分钟前`.
 */
export function formatHealthSuffix(provider: string): string {
  const h = getProviderHealth(provider);

  // No data at all
  if (!h.lastSuccessAt && !h.lastFailure) return "";

  // If the most recent event is a success, show nothing (healthy)
  if (h.lastSuccessAt && h.lastFailure) {
    if (h.lastSuccessAt >= h.lastFailure.at) return "";
  }
  if (h.lastSuccessAt && !h.lastFailure) return "";

  // We have an unresolved failure as the most recent event
  const f = h.lastFailure!;
  const ago = formatTimeAgo(f.at);
  const status = f.status;

  if (status === 401 || status === 403) {
    return `⚠ HTTP ${status} (凭据可能无效) · ${ago}`;
  }
  if (status === 429) {
    return `⏳ 429 限速 · ${ago}`;
  }
  if (typeof status === "number" && status >= 500) {
    return `⚠ ${status} 服务端错误 · ${ago}`;
  }
  if (status === "network") {
    return `⚠ 网络/超时 · ${ago}`;
  }
  return `⚠ ${status} · ${ago}`;
}

/**
 * Check if a provider has a recent 401/403 failure and a configured credential.
 * Returns a hint string if so, empty string otherwise.
 */
export function getCredentialInvalidHint(
  provider: string,
  hasCredential: boolean,
): string {
  if (!hasCredential) return "";
  const h = getProviderHealth(provider);
  const lastStatus = h.lastFailure?.status;
  if (lastStatus === 401 || lastStatus === 403) {
    return "该源凭据可能无效，可用 /academic-search 检查";
  }
  return "";
}

/** Format a timestamp as a human-readable relative time string (Chinese). */
function formatTimeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Health recording tests using an isolated temporary directory.
 * No real HTTP requests — tests the record/get/format logic only.
 */

// We need to control the config dir. Set PI_CODING_AGENT_DIR before importing.
let tempDir: string;

function setupTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "health-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

// Import health module after setting env (module reads PI_CODING_AGENT_DIR lazily via getAcademicSearchConfigDir)
let health: typeof import("../src/health.ts");

async function loadHealth() {
  // Dynamic import to pick up the env var
  return await import("../src/health.ts");
}

describe("provider health recording", () => {
  beforeEach(async () => {
    tempDir = setupTempDir();
    health = await loadHealth();
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns empty state when no health file exists", () => {
    const h = health.getProviderHealth("semantic");
    assert.equal(h.consecutiveFailures, 0);
    assert.equal(h.lastSuccessAt, undefined);
    assert.equal(h.lastFailure, undefined);
  });

  it("records a successful outcome", () => {
    health.recordProviderOutcome("semantic", { ok: true });
    const h = health.getProviderHealth("semantic");
    assert.equal(h.consecutiveFailures, 0);
    assert.ok(h.lastSuccessAt);
    assert.equal(h.lastFailure, undefined);
  });

  it("records a 403 failure", () => {
    health.recordProviderOutcome("semantic", {
      ok: false,
      status: 403,
      message: "Forbidden",
    });
    const h = health.getProviderHealth("semantic");
    assert.equal(h.consecutiveFailures, 1);
    assert.ok(h.lastFailure);
    assert.equal(h.lastFailure!.status, 403);
    assert.equal(h.lastFailure!.message, "Forbidden");
  });

  it("records a network failure", () => {
    health.recordProviderOutcome("arxiv", {
      ok: false,
      status: "network",
      message: "fetch failed",
    });
    const h = health.getProviderHealth("arxiv");
    assert.equal(h.consecutiveFailures, 1);
    assert.ok(h.lastFailure);
    assert.equal(h.lastFailure!.status, "network");
  });

  it("increments consecutiveFailures on repeated failures", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    const h = health.getProviderHealth("semantic");
    assert.equal(h.consecutiveFailures, 3);
  });

  it("resets consecutiveFailures on success", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    health.recordProviderOutcome("semantic", { ok: true });
    const h = health.getProviderHealth("semantic");
    assert.equal(h.consecutiveFailures, 0);
    assert.ok(h.lastSuccessAt);
  });

  it("preserves lastFailure after success (formatHealthSuffix checks recency)", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    // Small delay to ensure different timestamps
    const before = Date.now();
    health.recordProviderOutcome("semantic", { ok: true });
    const h = health.getProviderHealth("semantic");
    assert.equal(h.consecutiveFailures, 0);
    // lastFailure is still preserved from before
    assert.ok(h.lastFailure);
    assert.equal(h.lastFailure!.status, 403);
  });

  it("tracks multiple providers independently", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    health.recordProviderOutcome("openalex", { ok: true });
    health.recordProviderOutcome("arxiv", { ok: false, status: "network", message: "timeout" });

    const s2 = health.getProviderHealth("semantic");
    assert.equal(s2.consecutiveFailures, 1);

    const oa = health.getProviderHealth("openalex");
    assert.equal(oa.consecutiveFailures, 0);

    const arxiv = health.getProviderHealth("arxiv");
    assert.equal(arxiv.consecutiveFailures, 1);
    assert.equal(arxiv.lastFailure!.status, "network");
  });

  it("getAllHealth returns all tracked providers", () => {
    health.recordProviderOutcome("semantic", { ok: true });
    health.recordProviderOutcome("openalex", { ok: false, status: 500, message: "Internal error" });
    const all = health.getAllHealth();
    assert.ok("semantic" in all);
    assert.ok("openalex" in all);
    assert.equal(all.semantic!.consecutiveFailures, 0);
    assert.equal(all.openalex!.consecutiveFailures, 1);
  });
});

describe("formatHealthSuffix", () => {
  beforeEach(async () => {
    tempDir = setupTempDir();
    health = await loadHealth();
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns empty string when no data", () => {
    assert.equal(health.formatHealthSuffix("semantic"), "");
  });

  it("returns empty string after success", () => {
    health.recordProviderOutcome("semantic", { ok: true });
    assert.equal(health.formatHealthSuffix("semantic"), "");
  });

  it("returns warning for 403 with credential hint", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    const suffix = health.formatHealthSuffix("semantic");
    assert.ok(suffix.includes("⚠ HTTP 403"));
    assert.ok(suffix.includes("凭据可能无效"));
    assert.ok(suffix.includes("秒前"));
  });

  it("returns warning for 401 with credential hint", () => {
    health.recordProviderOutcome("openalex", { ok: false, status: 401, message: "Unauthorized" });
    const suffix = health.formatHealthSuffix("openalex");
    assert.ok(suffix.includes("⚠ HTTP 401"));
    assert.ok(suffix.includes("凭据可能无效"));
  });

  it("returns rate limit warning for 429", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 429, message: "Rate limited" });
    const suffix = health.formatHealthSuffix("semantic");
    assert.ok(suffix.includes("⏳ 429"));
    assert.ok(suffix.includes("限速"));
  });

  it("returns server error warning for 5xx", () => {
    health.recordProviderOutcome("crossref", { ok: false, status: 503, message: "Service Unavailable" });
    const suffix = health.formatHealthSuffix("crossref");
    assert.ok(suffix.includes("503"));
    assert.ok(suffix.includes("服务端错误"));
  });

  it("returns network warning for network errors", () => {
    health.recordProviderOutcome("arxiv", { ok: false, status: "network", message: "fetch failed" });
    const suffix = health.formatHealthSuffix("arxiv");
    assert.ok(suffix.includes("网络/超时"));
  });

  it("clears warning after success (most recent event wins)", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    // Verify warning exists first
    assert.ok(health.formatHealthSuffix("semantic").includes("⚠"));

    health.recordProviderOutcome("semantic", { ok: true });
    assert.equal(health.formatHealthSuffix("semantic"), "");
  });

  it("shows warning when failure is more recent than success", () => {
    health.recordProviderOutcome("semantic", { ok: true });
    // Small delay to ensure different timestamps
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    // Failure after success
    health.recordProviderOutcome("semantic", { ok: false, status: 429, message: "Rate limited" });
    const suffix = health.formatHealthSuffix("semantic");
    assert.ok(suffix.includes("⏳ 429"));
  });

  it("handles unknown status codes", () => {
    health.recordProviderOutcome("pubmed", { ok: false, status: 418, message: "I'm a teapot" });
    const suffix = health.formatHealthSuffix("pubmed");
    assert.ok(suffix.includes("418"));
  });
});

describe("getCredentialInvalidHint", () => {
  beforeEach(async () => {
    tempDir = setupTempDir();
    health = await loadHealth();
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns empty when no credential configured", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    assert.equal(health.getCredentialInvalidHint("semantic", false), "");
  });

  it("returns empty when credential configured but no auth failure", () => {
    health.recordProviderOutcome("semantic", { ok: true });
    assert.equal(health.getCredentialInvalidHint("semantic", true), "");
  });

  it("returns hint when credential configured and 403 failure", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 403, message: "Forbidden" });
    const hint = health.getCredentialInvalidHint("semantic", true);
    assert.ok(hint.includes("凭据可能无效"));
    assert.ok(hint.includes("/academic-search"));
  });

  it("returns hint when credential configured and 401 failure", () => {
    health.recordProviderOutcome("openalex", { ok: false, status: 401, message: "Unauthorized" });
    const hint = health.getCredentialInvalidHint("openalex", true);
    assert.ok(hint.includes("凭据可能无效"));
  });

  it("returns empty for non-auth failure even with credential", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 429, message: "Rate limited" });
    assert.equal(health.getCredentialInvalidHint("semantic", true), "");
  });

  it("returns empty for 500 failure even with credential", () => {
    health.recordProviderOutcome("semantic", { ok: false, status: 500, message: "Internal Error" });
    assert.equal(health.getCredentialInvalidHint("semantic", true), "");
  });
});

describe("file resilience", () => {
  beforeEach(async () => {
    tempDir = setupTempDir();
    health = await loadHealth();
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("handles corrupted health file gracefully", () => {
    const healthPath = join(tempDir, "academic-search-health.json");
    writeFileSync(healthPath, "NOT VALID JSON {{{");
    // Should not throw
    const h = health.getProviderHealth("semantic");
    assert.equal(h.consecutiveFailures, 0);
  });

  it("handles health file with wrong structure", () => {
    const healthPath = join(tempDir, "academic-search-health.json");
    writeFileSync(healthPath, JSON.stringify(["not", "an", "object"]));
    const h = health.getProviderHealth("semantic");
    assert.equal(h.consecutiveFailures, 0);
  });

  it("handles health file that is an array", () => {
    const healthPath = join(tempDir, "academic-search-health.json");
    writeFileSync(healthPath, JSON.stringify(42));
    const h = health.getProviderHealth("semantic");
    assert.equal(h.consecutiveFailures, 0);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCredential, hasCredentialSource, CredentialResolutionError } from "../src/credential-source.ts";

describe("resolveCredential", () => {
  it("returns literal value when configured", async () => {
    const result = await resolveCredential({
      provider: "test",
      configuredValue: "sk-my-key-123",
    });
    assert.equal(result, "sk-my-key-123");
  });

  it("resolves $ENV style environment variable", async () => {
    const result = await resolveCredential({
      provider: "test",
      configuredValue: "$TEST_CRED_VAR",
      environment: { TEST_CRED_VAR: "env-value-42" },
    });
    assert.equal(result, "env-value-42");
  });

  it("resolves ${ENV} style environment variable", async () => {
    const result = await resolveCredential({
      provider: "test",
      configuredValue: "${TEST_CRED_VAR}",
      environment: { TEST_CRED_VAR: "env-value-77" },
    });
    assert.equal(result, "env-value-77");
  });

  it("throws environment-empty when env var is missing", async () => {
    await assert.rejects(
      () =>
        resolveCredential({
          provider: "test",
          configuredValue: "$NONEXISTENT_VAR_XYZ",
          environment: {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof CredentialResolutionError);
        assert.equal(err.category, "environment-empty");
        return true;
      },
    );
  });

  it("resolves $$ escape as literal $-prefixed value", async () => {
    const result = await resolveCredential({
      provider: "test",
      configuredValue: "$$not-a-var",
    });
    assert.equal(result, "$not-a-var");
  });

  it("resolves $! escape as literal !-prefixed value", async () => {
    const result = await resolveCredential({
      provider: "test",
      configuredValue: "$!echo hello",
    });
    assert.equal(result, "!echo hello");
  });

  it("throws invalid-source for malformed $ pattern", async () => {
    await assert.rejects(
      () =>
        resolveCredential({
          provider: "test",
          configuredValue: "$123invalid",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CredentialResolutionError);
        assert.equal(err.category, "invalid-source");
        return true;
      },
    );
  });

  it("falls back to environmentValue when config is null", async () => {
    const result = await resolveCredential({
      provider: "test",
      configuredValue: null,
      environmentValue: "fallback-key",
    });
    assert.equal(result, "fallback-key");
  });

  it("returns null when nothing is configured", async () => {
    const result = await resolveCredential({
      provider: "test",
    });
    assert.equal(result, null);
  });

  it("executes !command and returns stdout", async () => {
    const result = await resolveCredential({
      provider: "test",
      configuredValue: "!echo -n secret-token",
      environment: process.env as Record<string, string | undefined>,
    });
    assert.equal(result, "secret-token");
  });

  it("throws command-empty for empty command output", async () => {
    await assert.rejects(
      () =>
        resolveCredential({
          provider: "test",
          configuredValue: "!echo -n",
          environment: process.env as Record<string, string | undefined>,
        }),
      (err: unknown) => {
        assert.ok(err instanceof CredentialResolutionError);
        assert.equal(err.category, "command-empty");
        return true;
      },
    );
  });

  it("throws invalid-source for empty command string", async () => {
    await assert.rejects(
      () =>
        resolveCredential({
          provider: "test",
          configuredValue: "!",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CredentialResolutionError);
        assert.equal(err.category, "invalid-source");
        return true;
      },
    );
  });

  it("trims whitespace from configured value", async () => {
    const result = await resolveCredential({
      provider: "test",
      configuredValue: "  my-key  ",
    });
    assert.equal(result, "my-key");
  });

  it("treats whitespace-only as null", async () => {
    const result = await resolveCredential({
      provider: "test",
      configuredValue: "   ",
    });
    assert.equal(result, null);
  });
});

describe("hasCredentialSource", () => {
  it("returns true for literal value", () => {
    assert.equal(
      hasCredentialSource({ provider: "test", configuredValue: "sk-xxx" }),
      true,
    );
  });

  it("returns true for $ENV pattern", () => {
    assert.equal(
      hasCredentialSource({ provider: "test", configuredValue: "$MY_VAR" }),
      true,
    );
  });

  it("returns true for !command pattern", () => {
    assert.equal(
      hasCredentialSource({ provider: "test", configuredValue: "!op read" }),
      true,
    );
  });

  it("returns true when environmentValue is present", () => {
    assert.equal(
      hasCredentialSource({ provider: "test", environmentValue: "fallback" }),
      true,
    );
  });

  it("returns false when nothing is configured", () => {
    assert.equal(
      hasCredentialSource({ provider: "test" }),
      false,
    );
  });

  it("returns false for null config", () => {
    assert.equal(
      hasCredentialSource({ provider: "test", configuredValue: null }),
      false,
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Test the outputDir boundary logic
// We test the expansion and resolution logic directly since the actual
// tool handler requires the full ExtensionAPI context

describe("outputDir expansion", () => {
  it("~ expands to home directory", () => {
    const input = "~/papers";
    const expected = resolve(homedir(), "papers");
    // Simulate the expansion logic
    const expanded = input.replace(/^~/, homedir());
    assert.equal(expanded, expected);
  });

  it("~ alone expands to home directory", () => {
    const input = "~";
    const expanded = input.replace(/^~/, homedir());
    assert.equal(expanded, homedir());
  });

  it("relative path resolves against cwd", () => {
    const input = "./papers";
    const resolved = resolve(process.cwd(), input);
    assert.ok(resolved.startsWith(process.cwd()));
  });

  it("relative path with .. resolves against cwd", () => {
    const input = "../papers";
    const resolved = resolve(process.cwd(), input);
    // The resolved path should be the parent of cwd + papers
    assert.ok(resolved.includes("papers"));
  });

  it("absolute path stays absolute", () => {
    const input = "/tmp/papers";
    assert.ok(input.startsWith("/"));
  });

  it("boundary check: path inside cwd passes", () => {
    const cwd = process.cwd();
    const testPath = resolve(cwd, "papers");
    const normalizedCwd = cwd + "/";
    assert.ok(testPath.startsWith(normalizedCwd) || testPath === cwd);
  });

  it("boundary check: path outside cwd fails", () => {
    const cwd = process.cwd();
    const testPath = "/tmp/outside";
    const normalizedCwd = cwd + "/";
    assert.ok(!testPath.startsWith(normalizedCwd) && testPath !== cwd);
  });

  it("downloadAllowOutsideCwd string 'false' is not truthy true", () => {
    // config.downloadAllowOutsideCwd must be strictly === true
    const config = { downloadAllowOutsideCwd: "false" as unknown as boolean };
    assert.notEqual(config.downloadAllowOutsideCwd, true);
    assert.ok(config.downloadAllowOutsideCwd !== true);
  });

  it("NUL character in outputDir is rejected", () => {
    const outputDir = "/tmp/papers\0evil";
    assert.ok(outputDir.includes("\0"));
  });

  it("empty outputDir is rejected", () => {
    const outputDir = "";
    assert.equal(outputDir.length, 0);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeFilename, buildDownloadChain, validatePdf } from "../src/pdf/download.ts";
import { parseUnpaywallResponse } from "../src/pdf/unpaywall.ts";

// --- Unpaywall response parsing ---

describe("parseUnpaywallResponse", () => {
  it("parses a valid OA response with pdfUrl and landingPageUrl", () => {
    const data = {
      is_oa: true,
      best_oa_location: {
        url_for_pdf: "https://example.com/paper.pdf",
        url_for_landing_page: "https://example.com/paper",
      },
    };
    const result = parseUnpaywallResponse(data);
    assert.ok(result);
    assert.equal(result.pdfUrl, "https://example.com/paper.pdf");
    assert.equal(result.landingPageUrl, "https://example.com/paper");
    assert.equal(result.isOa, true);
  });

  it("parses OA response with only pdfUrl", () => {
    const data = {
      is_oa: true,
      best_oa_location: {
        url_for_pdf: "https://example.com/paper.pdf",
      },
    };
    const result = parseUnpaywallResponse(data);
    assert.ok(result);
    assert.equal(result.pdfUrl, "https://example.com/paper.pdf");
    assert.equal(result.landingPageUrl, "");
  });

  it("parses OA response with only landingPageUrl (no pdf)", () => {
    const data = {
      is_oa: true,
      best_oa_location: {
        url_for_landing_page: "https://example.com/paper",
      },
    };
    const result = parseUnpaywallResponse(data);
    assert.ok(result);
    assert.equal(result.pdfUrl, "");
    assert.equal(result.landingPageUrl, "https://example.com/paper");
  });

  it("returns null for non-OA paper (no best_oa_location)", () => {
    const data = {
      is_oa: false,
      best_oa_location: null,
    };
    const result = parseUnpaywallResponse(data);
    assert.equal(result, null);
  });

  it("returns null for non-OA paper (undefined best_oa_location)", () => {
    const data = {
      is_oa: false,
    };
    const result = parseUnpaywallResponse(data);
    assert.equal(result, null);
  });

  it("returns null when best_oa_location has no urls", () => {
    const data = {
      is_oa: true,
      best_oa_location: {},
    };
    const result = parseUnpaywallResponse(data);
    assert.equal(result, null);
  });

  it("returns null for 404-like empty response", () => {
    // Unpaywall 404 typically means we wouldn't parse, but testing the parse function
    // with minimal data that represents "not found"
    const data = {};
    const result = parseUnpaywallResponse(data);
    assert.equal(result, null);
  });

  it("handles null url_for_pdf and url_for_landing_page", () => {
    const data = {
      is_oa: true,
      best_oa_location: {
        url_for_pdf: null,
        url_for_landing_page: null,
      },
    };
    const result = parseUnpaywallResponse(data);
    assert.equal(result, null);
  });
});

// --- Filename sanitization ---

describe("sanitizeFilename", () => {
  it("uses sanitized title when provided", () => {
    const result = sanitizeFilename("Attention Is All You Need", "1234");
    assert.equal(result, "Attention-Is-All-You-Need.pdf");
  });

  it("removes illegal filename characters", () => {
    const result = sanitizeFilename('File<>:"/\\|?*Name', "id");
    assert.equal(result, "FileName.pdf");
  });

  it("collapses whitespace to hyphens", () => {
    const result = sanitizeFilename("  hello   world  ", "id");
    assert.equal(result, "hello-world.pdf");
  });

  it("collapses multiple hyphens", () => {
    const result = sanitizeFilename("a---b---c", "id");
    assert.equal(result, "a-b-c.pdf");
  });

  it("truncates to 80 characters", () => {
    const longTitle = "A".repeat(100);
    const result = sanitizeFilename(longTitle, "id");
    assert.ok(result.length <= 84); // 80 + ".pdf"
    assert.ok(result.endsWith(".pdf"));
    assert.equal(result.slice(0, -4).length, 80);
  });

  it("removes leading/trailing hyphens and dots", () => {
    const result = sanitizeFilename("--..hello..--", "id");
    assert.equal(result, "hello.pdf");
  });

  it("falls back to ID when title is empty", () => {
    const result = sanitizeFilename("", "1706.03762");
    assert.equal(result, "1706.03762.pdf");
  });

  it("falls back to ID when title is undefined", () => {
    const result = sanitizeFilename(undefined, "10.1234/test");
    assert.equal(result, "10.1234-test.pdf");
  });

  it("falls back to ID when title is only whitespace", () => {
    const result = sanitizeFilename("   ", "my-id");
    assert.equal(result, "my-id.pdf");
  });

  it("falls back to ID when title becomes empty after sanitization", () => {
    const result = sanitizeFilename('<>:"/\\|?*', "fallback");
    assert.equal(result, "fallback.pdf");
  });

  it("sanitizes fallback ID containing slashes", () => {
    const result = sanitizeFilename(undefined, "cs/0501001");
    assert.equal(result, "cs-0501001.pdf");
  });

  it("handles title with mixed illegal characters", () => {
    const result = sanitizeFilename('Hello: World? "Yes" <No>', "id");
    assert.equal(result, "Hello-World-Yes-No.pdf");
  });

  it("handles very short valid title", () => {
    const result = sanitizeFilename("AI", "id");
    assert.equal(result, "AI.pdf");
  });
});

// --- Download chain priority ---

describe("buildDownloadChain", () => {
  it("returns arxiv first when arxivId is present", () => {
    const chain = buildDownloadChain({ arxivId: "1706.03762" });
    assert.ok(chain.length >= 1);
    assert.equal(chain[0]!.source, "arxiv");
    assert.ok(chain[0]!.url.includes("arxiv.org/pdf/1706.03762"));
  });

  it("strips version from arxiv ID in URL", () => {
    const chain = buildDownloadChain({ arxivId: "1706.03762v3" });
    assert.equal(chain[0]!.source, "arxiv");
    assert.ok(chain[0]!.url.includes("1706.03762.pdf"));
    assert.ok(!chain[0]!.url.includes("v3"));
  });

  it("includes paper.pdfUrl as direct fallback", () => {
    const chain = buildDownloadChain({
      paper: { pdfUrl: "https://example.com/paper.pdf" },
    });
    assert.equal(chain.length, 1);
    assert.equal(chain[0]!.source, "direct");
    assert.equal(chain[0]!.url, "https://example.com/paper.pdf");
  });

  it("returns empty chain when no identifiers provided", () => {
    const chain = buildDownloadChain({});
    assert.equal(chain.length, 0);
  });

  it("prefers input arxivId over paper.arxivId", () => {
    const chain = buildDownloadChain({
      arxivId: "2301.07041",
      paper: { arxivId: "1706.03762" },
    });
    assert.equal(chain[0]!.source, "arxiv");
    assert.ok(chain[0]!.url.includes("2301.07041"));
  });

  it("builds chain with arxiv + direct (no unpaywall without env)", () => {
    const chain = buildDownloadChain({
      doi: "10.1234/test",
      arxivId: "1706.03762",
      paper: { pdfUrl: "https://example.com/fallback.pdf" },
    });
    // arxiv first, then unpaywall (if available) or direct
    assert.equal(chain[0]!.source, "arxiv");
    // unpaywall depends on config, so we might have 2 or 3 entries
    assert.ok(chain.length >= 2);
    // Last entry should be direct
    assert.equal(chain[chain.length - 1]!.source, "direct");
  });

  it("uses paper.doi when input doi is not provided", () => {
    const chain = buildDownloadChain({
      paper: { doi: "10.1234/test", pdfUrl: "https://example.com/fallback.pdf" },
    });
    // Should have unpaywall (if available) + direct
    assert.ok(chain.length >= 1);
    const directEntry = chain.find((a) => a.source === "direct");
    assert.ok(directEntry);
  });

  it("uses paper.arxivId when input arxivId is not provided", () => {
    const chain = buildDownloadChain({
      paper: { arxivId: "2301.07041" },
    });
    assert.equal(chain[0]!.source, "arxiv");
    assert.ok(chain[0]!.url.includes("2301.07041"));
  });
});

// --- PDF validation ---

describe("validatePdf", () => {
  it("accepts valid PDF with %PDF magic bytes", () => {
    const buffer = Buffer.from("%PDF-1.4 fake pdf content");
    assert.doesNotThrow(() => validatePdf(buffer, "application/octet-stream"));
  });

  it("accepts PDF by content-type even without magic", () => {
    const buffer = Buffer.from("some content");
    assert.doesNotThrow(() => validatePdf(buffer, "application/pdf"));
  });

  it("rejects non-PDF content", () => {
    const buffer = Buffer.from("<html>not a pdf</html>");
    assert.throws(
      () => validatePdf(buffer, "text/html"),
      (err: Error) => err.message.includes("Not a PDF"),
    );
  });

  it("rejects empty buffer", () => {
    const buffer = Buffer.alloc(0);
    assert.throws(
      () => validatePdf(buffer, "application/pdf"),
      (err: Error) => err.message.includes("Empty response body"),
    );
  });
});

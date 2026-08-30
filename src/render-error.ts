/**
 * Error rendering for academic search.
 *
 * Produces a collapsed one-line summary (for normal view)
 * and an expanded per-source diagnostic (for Ctrl+O / expand).
 */

export interface ErrorPlan {
  /** Collapsed view: one-line summary. */
  collapsed: string;
  /** Expanded view: per-source diagnostics. */
  expanded: string[];
  /** Hint shown to the user about how to expand. */
  expandHint?: string;
}

/**
 * Build an error plan for academic search failures.
 *
 * @param query - The search query.
 * @param errors - Array of per-source errors with source name and error message.
 * @param totalSources - Number of sources that were attempted.
 */
export function buildErrorPlan(
  query: string,
  errors: Array<{ source: string; error: string }>,
  totalSources: number,
): ErrorPlan {
  const failedCount = errors.length;

  if (failedCount === totalSources) {
    // All sources failed
    const collapsed = `All ${totalSources} source(s) failed for "${query}".`;
    const expanded = [
      collapsed,
      "",
      "Per-source diagnostics:",
      ...errors.map((e) => `  [${e.source}] ${e.error}`),
      "",
      "Tip: Check your network connection and API credentials.",
    ];
    return { collapsed, expanded, expandHint: "Press Ctrl+O for details" };
  }

  // Partial failure — this is normal, not an error plan needed
  // But if caller wants it:
  const collapsed = `${failedCount}/${totalSources} source(s) failed for "${query}".`;
  const expanded = [
    collapsed,
    "",
    "Failed sources:",
    ...errors.map((e) => `  [${e.source}] ${e.error}`),
  ];
  return { collapsed, expanded };
}

/**
 * Format a failed-sources list into a string appended to search output.
 */
export function formatFailedSources(errors: Array<{ source: string; error: string }>): string {
  if (errors.length === 0) return "";
  const lines = ["", "---", "Failed sources:"];
  for (const e of errors) {
    lines.push(`- [${e.source}] ${e.error}`);
  }
  return lines.join("\n");
}

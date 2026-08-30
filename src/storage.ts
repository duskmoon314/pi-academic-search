import { randomUUID } from "node:crypto";
import type { PaperResult, StoredPaperData } from "./types.ts";

interface StoredEntry {
  data: StoredPaperData;
  timer: ReturnType<typeof setTimeout>;
}

/** In-memory storage for search results. TTL is 1 hour. */
const store = new Map<string, StoredEntry>();

const TTL_MS = 60 * 60 * 1000; // 1 hour

/** Generate a unique storage ID. */
export function generateId(): string {
  return randomUUID().slice(0, 8);
}

/** Store a search result set and return its ID. */
export function storeResult(data: StoredPaperData): string {
  // If same ID already exists, cancel old timer to prevent premature deletion
  const existing = store.get(data.id);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => store.delete(data.id), TTL_MS);
  // Prevent the timer from keeping the process alive (e.g. during testing)
  if (timer.unref) timer.unref();

  store.set(data.id, { data, timer });
  return data.id;
}

/**
 * Retrieve a stored result by ID. Returns null if expired or missing.
 * Checks timestamp to handle timer drift or event loop delays.
 */
export function getResult(id: string): StoredPaperData | null {
  const entry = store.get(id);
  if (!entry) return null;

  // TTL check by timestamp (don't rely solely on timer firing)
  if (Date.now() - entry.data.timestamp > TTL_MS) {
    clearTimeout(entry.timer);
    store.delete(id);
    return null;
  }

  return entry.data;
}

/** Retrieve all stored results (filters expired by timestamp). */
export function getAllResults(): StoredPaperData[] {
  const now = Date.now();
  const results: StoredPaperData[] = [];
  for (const [id, entry] of store) {
    if (now - entry.data.timestamp > TTL_MS) {
      clearTimeout(entry.timer);
      store.delete(id);
    } else {
      results.push(entry.data);
    }
  }
  return results;
}

/** Delete a stored result by ID. Clears the timer to prevent leaks. */
export function deleteResult(id: string): boolean {
  const entry = store.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  store.delete(id);
  return true;
}

/** Clear all stored results. Clears all timers to prevent leaks. */
export function clearResults(): void {
  for (const entry of store.values()) {
    clearTimeout(entry.timer);
  }
  store.clear();
}

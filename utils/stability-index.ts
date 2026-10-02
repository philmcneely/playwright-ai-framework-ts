/**
 * Stability Index — track pass/fail per test and quarantine flaky tests.
 *
 * TypeScript port of utils/stability_index.py. History is persisted as JSON in
 * data/stability_history.json (override with STABILITY_HISTORY_FILE, mainly for
 * tests). Writes are atomic (write temp + rename); cross-worker locking is
 * best-effort, matching the Python module's intent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import path from "path";

const DEFAULT_HISTORY_FILE = path.resolve("data", "stability_history.json");

export const DEFAULT_WINDOW = 10;
export const DEFAULT_THRESHOLD = 0.7;

interface StabilityEntry {
  results: number[];
  last_updated: string;
}
type History = Record<string, StabilityEntry>;

export interface StabilityReportEntry {
  stability: number;
  runs: number;
  last_updated: string;
}

let historyFile: string = process.env.STABILITY_HISTORY_FILE || DEFAULT_HISTORY_FILE;

/** Override the history file location. Primarily for tests. */
export function setHistoryFile(path: string): void {
  historyFile = path;
}

function loadHistory(): History {
  if (existsSync(historyFile)) {
    try {
      const text = readFileSync(historyFile, "utf-8");
      return text.trim() ? (JSON.parse(text) as History) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function saveHistory(data: History): void {
  mkdirSync(path.dirname(historyFile), { recursive: true });
  const tmp = `${historyFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, historyFile);
}

export function recordResult(testId: string, passed: boolean, window: number = DEFAULT_WINDOW): void {
  const history = loadHistory();
  if (!history[testId]) {
    history[testId] = { results: [], last_updated: "" };
  }
  const entry = history[testId];
  entry.results.push(passed ? 1 : 0);
  entry.results = entry.results.slice(-window); // keep last N
  entry.last_updated = new Date().toISOString();
  saveHistory(history);
}

export function getStability(testId: string): number {
  const entry = loadHistory()[testId];
  if (!entry || entry.results.length === 0) {
    return 1.0; // no history = assume stable
  }
  return entry.results.reduce((a, b) => a + b, 0) / entry.results.length;
}

export function getUnstableTests(threshold: number = DEFAULT_THRESHOLD): string[] {
  const history = loadHistory();
  const unstable: string[] = [];
  for (const [testId, entry] of Object.entries(history)) {
    if (entry.results.length > 0) {
      const stability = entry.results.reduce((a, b) => a + b, 0) / entry.results.length;
      if (stability < threshold) {
        unstable.push(testId);
      }
    }
  }
  return unstable;
}

export function getStabilityReport(): Record<string, StabilityReportEntry> {
  const history = loadHistory();
  const report: Record<string, StabilityReportEntry> = {};
  for (const [testId, entry] of Object.entries(history)) {
    if (entry.results.length > 0) {
      report[testId] = {
        stability: entry.results.reduce((a, b) => a + b, 0) / entry.results.length,
        runs: entry.results.length,
        last_updated: entry.last_updated,
      };
    }
  }
  return report;
}

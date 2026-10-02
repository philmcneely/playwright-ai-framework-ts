/**
 * Unit tests for the stability index (QA-04). Mirror of
 * tests/test_stability_index.py. Runs under the Playwright runner with no
 * browser; each test uses an isolated temp history file.
 */
import { test, expect } from "@playwright/test";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  setHistoryFile,
  recordResult,
  getStability,
  getUnstableTests,
  getStabilityReport,
} from "../../utils/stability-index.js";

let historyPath: string;

test.beforeEach(() => {
  historyPath = join(tmpdir(), `stability-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  setHistoryFile(historyPath);
});

test.afterEach(() => {
  for (const f of [historyPath, `${historyPath}.tmp`]) {
    if (existsSync(f)) rmSync(f);
  }
});

test("record and get stability", () => {
  for (let i = 0; i < 7; i++) recordResult("test_login", true);
  for (let i = 0; i < 3; i++) recordResult("test_login", false);
  expect(getStability("test_login")).toBe(0.7);
});

test("unknown test returns stable", () => {
  expect(getStability("nonexistent")).toBe(1.0);
});

test("window limit keeps only the last N runs", () => {
  for (let i = 0; i < 15; i++) recordResult("test_window", true);
  const report = getStabilityReport();
  expect(report["test_window"].runs).toBe(10); // default window
});

test("unstable detection", () => {
  for (let i = 0; i < 10; i++) recordResult("test_flaky", false);
  for (let i = 0; i < 10; i++) recordResult("test_solid", true);
  const unstable = getUnstableTests(0.7);
  expect(unstable).toContain("test_flaky");
  expect(unstable).not.toContain("test_solid");
});

test("stability report", () => {
  recordResult("test_a", true);
  recordResult("test_a", false);
  const report = getStabilityReport();
  expect(report["test_a"]).toBeDefined();
  expect(report["test_a"].stability).toBe(0.5);
  expect(report["test_a"].runs).toBe(2);
});

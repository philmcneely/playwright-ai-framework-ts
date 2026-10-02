/**
 * Stability reporter — records each test attempt's pass/fail into the stability
 * index so flaky tests can later be quarantined (see fixtures/index.ts).
 *
 * Mirrors the Python conftest's pytest_runtest_logreport hook, which records
 * every call-phase result (including retries) to capture flakiness.
 */
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { recordResult } from "./stability-index.js";

class StabilityReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult): void {
    // Don't record skipped tests (e.g. quarantined ones) — only real outcomes.
    if (result.status === "skipped") return;
    const key = test.titlePath().join(" > ");
    recordResult(key, result.status === "passed");
  }
}

export default StabilityReporter;

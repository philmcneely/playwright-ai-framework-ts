/**
 * Unit Tests for Pure Logic
 *
 * Runs under the Playwright test runner but does not use the page fixture,
 * so no browser is launched. Covers error categorization,
 * ticket extraction, and observability summarization.
 */

import { test, expect } from "@playwright/test";
import {
  categorizeError,
  TestObservabilityCollector,
  type TestMetric,
} from "../../utils/test-observability.js";
import { extractTicketId } from "../../utils/jira-reporter.js";

// ---------------------------------------------------------------------------
// categorizeError — keyword matching
// ---------------------------------------------------------------------------

test.describe("categorizeError", () => {
  test("returns undefined for missing message", () => {
    expect(categorizeError(undefined)).toBeUndefined();
    expect(categorizeError("")).toBeUndefined();
  });

  test("categorizes timeouts", () => {
    expect(categorizeError("Timeout 30000ms exceeded")).toBe("timeout");
    expect(categorizeError("Test timed out waiting for event")).toBe("timeout");
  });

  test("categorizes element-not-found", () => {
    expect(categorizeError("locator resolved to 0 elements")).toBe("element-not-found");
    expect(categorizeError("Selector did not match")).toBe("element-not-found");
    expect(categorizeError("element not found in DOM")).toBe("element-not-found");
  });

  test("categorizes navigation failures", () => {
    expect(categorizeError("Navigation to page failed")).toBe("navigation");
    expect(categorizeError("net::ERR_CONNECTION_REFUSED")).toBe("navigation");
  });

  test("categorizes assertion failures", () => {
    expect(categorizeError("expect(received).toBe(expected)")).toBe("assertion");
    expect(categorizeError("Assertion failed: values differ")).toBe("assertion");
  });

  test("categorizes browser crashes", () => {
    expect(categorizeError("Browser crash detected")).toBe("browser-crash");
    expect(categorizeError("Target closed")).toBe("browser-crash");
  });

  test("falls back to other", () => {
    expect(categorizeError("Something bizarre happened")).toBe("other");
  });

  test("'unexpectedly' is not an assertion", () => {
    expect(categorizeError("Target closed unexpectedly")).toBe("browser-crash");
    expect(categorizeError("Expected: 1, Received: 2")).toBe("assertion");
    expect(categorizeError("expect(received).toBe(expected)")).toBe("assertion");
  });

  test("earlier keyword categories win over later ones", () => {
    // "locator" outranks "expect" in the keyword order.
    expect(categorizeError("expect(locator).toBeVisible() failed")).toBe("element-not-found");
  });
});

// ---------------------------------------------------------------------------
// extractTicketId — regex + annotation fallback
// ---------------------------------------------------------------------------

test.describe("extractTicketId", () => {
  function fakeTest(titles: string[], annotations: Array<{ type: string; description?: string }> = []) {
    return { titlePath: () => titles, annotations };
  }

  test("extracts ticket id from test title", () => {
    expect(extractTicketId(fakeTest(["Login Tests", "ABC-123 valid login"]))).toBe("ABC-123");
  });

  test("extracts ticket id from suite title", () => {
    expect(extractTicketId(fakeTest(["PROJ42-7 checkout suite", "pays with card"]))).toBe("PROJ42-7");
  });

  test("does not match lowercase or malformed ids", () => {
    expect(extractTicketId(fakeTest(["abc-123 lowercase"]))).toBeNull();
    expect(extractTicketId(fakeTest(["A-123 single letter prefix"]))).toBeNull();
    expect(extractTicketId(fakeTest(["ABC- missing number"]))).toBeNull();
  });

  test("falls back to jira annotation", () => {
    const t = fakeTest(["no ticket here"], [{ type: "jira", description: "XYZ-99" }]);
    expect(extractTicketId(t)).toBe("XYZ-99");
  });

  test("returns null when nothing matches", () => {
    expect(extractTicketId(fakeTest(["plain title"]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TestObservabilityCollector.summarize
// ---------------------------------------------------------------------------

test.describe("TestObservabilityCollector.summarize", () => {
  function metric(overrides: Partial<TestMetric>): TestMetric {
    return {
      testId: "id",
      testName: "test",
      suite: "suite",
      status: "passed",
      durationMs: 1000,
      retryCount: 0,
      browser: "chromium",
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeCollector(): TestObservabilityCollector {
    const collector = new TestObservabilityCollector();
    // Enable in-memory collection; record() also appends to the artifacts
    // dir, which is gitignored, so this is safe for unit tests.
    collector.enabled = true;
    return collector;
  }

  test("summarizes empty collector without dividing by zero", () => {
    const summary = makeCollector().summarize();
    expect(summary.totalTests).toBe(0);
    expect(summary.avgDurationMs).toBe(0);
    expect(summary.passRate).toBe(0);
    expect(summary.flakeRate).toBe(0);
    expect(summary.slowestTests).toEqual([]);
  });

  test("computes counts, rates, and durations", () => {
    const collector = makeCollector();
    collector.record(metric({ testName: "a", status: "passed", durationMs: 1000 }));
    collector.record(metric({ testName: "b", status: "failed", durationMs: 3000, errorCategory: "timeout" }));
    collector.record(metric({ testName: "c", status: "passed", durationMs: 2000, retryCount: 1 }));
    collector.record(metric({ testName: "d", status: "skipped", durationMs: 0 }));

    const summary = collector.summarize();
    expect(summary.totalTests).toBe(4);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.flakeCount).toBe(1); // passed after retries
    expect(summary.totalDurationMs).toBe(6000);
    expect(summary.avgDurationMs).toBe(1500);
    expect(summary.passRate).toBe(50);
    expect(summary.flakeRate).toBe(25);
    expect(summary.slowestTests[0]).toEqual({ name: "b", durationMs: 3000 });
    expect(summary.failuresByCategory).toEqual({ timeout: 1 });
  });

  test("groups failures by category and caps slowest list at 10", () => {
    const collector = makeCollector();
    for (let i = 0; i < 12; i++) {
      collector.record(
        metric({
          testName: `t${i}`,
          status: "failed",
          durationMs: i * 100,
          errorCategory: i % 2 === 0 ? "timeout" : "assertion",
        }),
      );
    }

    const summary = collector.summarize();
    expect(summary.failed).toBe(12);
    expect(summary.slowestTests).toHaveLength(10);
    expect(summary.slowestTests[0].name).toBe("t11");
    expect(summary.failuresByCategory).toEqual({ timeout: 6, assertion: 6 });
  });
});

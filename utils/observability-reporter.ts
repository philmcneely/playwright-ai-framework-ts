import type {
  Reporter,
  TestCase,
  TestResult,
  FullConfig,
  Suite,
  FullResult,
} from "@playwright/test/reporter";
import { execFileSync } from "child_process";
import {
  categorizeError,
  getObservabilityCollector,
  type TestMetric,
} from "./test-observability.js";

function getGitInfo(): { commitSha?: string; branch?: string } {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    return { commitSha: sha, branch };
  } catch {
    return {};
  }
}

class ObservabilityReporter implements Reporter {
  private collector = getObservabilityCollector();
  private gitInfo = getGitInfo();
  private retryTracker = new Map<string, number>();

  onBegin(_config: FullConfig, _suite: Suite): void {
    if (this.collector.enabled) {
      console.log("[Observability] Reporter active");
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.collector.enabled) return;

    const key = test.titlePath().join(" > ");

    if (result.status === "failed" || result.status === "timedOut") {
      const count = (this.retryTracker.get(key) || 0) + 1;
      this.retryTracker.set(key, count);
    }

    const isFinal =
      result.status === "passed" ||
      result.status === "skipped" ||
      result.retry >= test.retries;

    if (!isFinal) return;

    const metric: TestMetric = {
      testId: test.id,
      testName: test.title,
      suite: test.titlePath().slice(0, -1).join(" > "),
      status: result.status as TestMetric["status"],
      durationMs: result.duration,
      retryCount: this.retryTracker.get(key) || 0,
      browser: test.parent?.project()?.name || "unknown",
      timestamp: new Date().toISOString(),
      commitSha: this.gitInfo.commitSha,
      branch: this.gitInfo.branch,
      errorCategory: categorizeError(result.errors?.[0]?.message),
      tags: test.annotations.map((a) => a.type),
    };

    this.collector.record(metric);
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (!this.collector.enabled) return;
    this.collector.writeReport();
    this.collector.printSummary();
  }
}

export default ObservabilityReporter;

/**
 * AI Healing Reporter for Playwright
 *
 * Custom Playwright Reporter that triggers AI healing analysis on final test
 * failures (after all retries are exhausted). Replaces Python's
 * pytest_runtest_makereport hook.
 *
 * Usage in playwright.config.ts:
 *   reporter: [["./utils/ai-healing-reporter.ts"], ...]
 */

import type {
  Reporter,
  TestCase,
  TestResult,
  FullConfig,
  Suite,
  FullResult,
} from "@playwright/test/reporter";
import * as fs from "fs";
import {
  getOllamaService,
  ensureOllamaReady,
  type HealingResponse,
} from "./ai-healing.js";
import { categorizeError } from "./test-observability.js";

class AIHealingReporter implements Reporter {
  private failCounts = new Map<string, number>();
  private service = getOllamaService();
  private healingPromises: Promise<void>[] = [];

  onBegin(_config: FullConfig, _suite: Suite): void {
    if (this.service.enabled) {
      console.log("[AI Healing] Reporter active");
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.service.enabled) return;
    if (result.status !== "failed" && result.status !== "timedOut") return;

    const key = test.titlePath().join(" > ");
    const count = (this.failCounts.get(key) || 0) + 1;
    this.failCounts.set(key, count);

    const maxRetries = test.retries;

    // Only trigger healing on the final failure (after all retries exhausted)
    if (count > maxRetries) {
      const promise = this.triggerHealing(test, result).catch((err) => {
        console.error(`[AI Healing] Error: ${err}`);
      });
      this.healingPromises.push(promise);
    }
  }

  private async triggerHealing(
    test: TestCase,
    result: TestResult,
  ): Promise<void> {
    const ready = await ensureOllamaReady();
    if (!ready) {
      console.log("[AI Healing] Skipping — Ollama not available");
      return;
    }

    const error = result.errors?.[0];
    const errorMessage = error?.message || "Unknown error";

    // Try to read the test source file
    let originalTestCode = "";
    try {
      const testFile = test.location.file;
      originalTestCode = fs.readFileSync(testFile, "utf-8");
    } catch {
      // Could not read source
    }

    // Build context from what the reporter has access to
    const context: Record<string, string> = {
      test_name: test.title,
      error_message: errorMessage,
      error_type: categorizeError(error?.message) || "Unknown",
      test_file: test.location.file,
    };

    // Look for screenshot attachments (from Playwright's screenshot-on-failure)
    let screenshotPath: string | undefined;
    for (const attachment of result.attachments) {
      if (attachment.contentType === "image/png" && attachment.path) {
        screenshotPath = attachment.path;
        break;
      }
    }

    const aiResponse: HealingResponse = await this.service.callOllamaHealing(
      context,
      originalTestCode,
      screenshotPath,
    );

    if (aiResponse && !aiResponse.error) {
      await this.service.generateHealingReport(
        test.title,
        aiResponse,
        context,
      );
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    // Wait for any in-flight healing tasks to complete
    if (this.healingPromises.length > 0) {
      await Promise.allSettled(this.healingPromises);
    }
    if (this.service.enabled) {
      console.log("[AI Healing] Reporter complete");
    }
  }
}

export default AIHealingReporter;

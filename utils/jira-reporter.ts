import type {
  Reporter,
  TestCase,
  TestResult,
  FullConfig,
  Suite,
  FullResult,
} from "@playwright/test/reporter";
import { getJiraClient, type JiraTestResult } from "./jira-client.js";

const TICKET_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/;

function extractTicketId(test: TestCase): string | null {
  for (const part of test.titlePath()) {
    const match = part.match(TICKET_PATTERN);
    if (match) return match[1];
  }
  const ann = test.annotations.find((a) => a.type === "jira");
  if (ann?.description) return ann.description;
  return null;
}

class JiraReporter implements Reporter {
  private client = getJiraClient();
  private pendingReports: Promise<void>[] = [];

  onBegin(_config: FullConfig, _suite: Suite): void {
    if (this.client.config.enabled) {
      console.log(
        `[Jira] Reporter active (dry_run=${this.client.config.dryRun})`,
      );
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.client.config.enabled) return;

    const ticketId = extractTicketId(test);
    if (!ticketId) return;

    const isFinal =
      result.status === "passed" ||
      result.status === "skipped" ||
      result.retry >= test.retries;

    if (!isFinal) return;

    const jiraResult: JiraTestResult = {
      ticketId,
      testName: test.title,
      status: result.status as JiraTestResult["status"],
      durationMs: result.duration,
      errorMessage: result.errors?.[0]?.message,
      testFile: test.location.file,
      timestamp: new Date().toISOString(),
    };

    const promise = this.client
      .reportTestResult(jiraResult)
      .then(() => {})
      .catch((err) => {
        console.error(`[Jira] Report failed for ${ticketId}: ${err}`);
      });
    this.pendingReports.push(promise);
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (this.pendingReports.length > 0) {
      await Promise.allSettled(this.pendingReports);
    }
    if (this.client.config.enabled) {
      console.log(
        `[Jira] Reporter complete (${this.pendingReports.length} reports sent)`,
      );
    }
  }
}

export default JiraReporter;

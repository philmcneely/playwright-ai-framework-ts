import { debugPrint } from "../config/settings.js";

export interface JiraTestResult {
  ticketId: string;
  testName: string;
  status: "passed" | "failed" | "skipped" | "timedOut";
  durationMs: number;
  errorMessage?: string;
  testFile?: string;
  timestamp?: string;
}

export interface JiraConfig {
  enabled: boolean;
  baseUrl: string;
  username: string;
  token: string;
  dryRun: boolean;
  transitionOnPass?: string;
  transitionOnFail?: string;
}

function loadConfig(): JiraConfig {
  return {
    enabled: (process.env.JIRA_ENABLED || "false").toLowerCase() === "true",
    baseUrl: process.env.JIRA_BASE || "",
    username: process.env.JIRA_USER || "",
    token: process.env.JIRA_TOKEN || "",
    dryRun: (process.env.JIRA_DRY_RUN || "false").toLowerCase() === "true",
    transitionOnPass: process.env.JIRA_TRANSITION_ON_PASS,
    transitionOnFail: process.env.JIRA_TRANSITION_ON_FAIL,
  };
}

export class JiraClient {
  readonly config: JiraConfig;

  constructor(config?: Partial<JiraConfig>) {
    const defaults = loadConfig();
    this.config = { ...defaults, ...config };
  }

  private authHeader(): string {
    return (
      "Basic " +
      Buffer.from(`${this.config.username}:${this.config.token}`).toString(
        "base64",
      )
    );
  }

  async postComment(ticketId: string, body: string): Promise<boolean> {
    if (this.config.dryRun) {
      console.log(
        `[Jira DRY RUN] Would post to ${ticketId}: ${body.slice(0, 120)}...`,
      );
      return true;
    }

    const url = `${this.config.baseUrl}/rest/api/2/issue/${ticketId}/comment`;

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(30_000),
      });

      if (resp.status === 201) {
        debugPrint(`[Jira] Comment posted to ${ticketId}`);
        return true;
      }

      console.error(
        `[Jira] Failed to post comment to ${ticketId}: ${resp.status} ${await resp.text()}`,
      );
      return false;
    } catch (err) {
      console.error(`[Jira] Request failed for ${ticketId}: ${err}`);
      return false;
    }
  }

  async transitionTicket(
    ticketId: string,
    transitionName: string,
  ): Promise<boolean> {
    if (this.config.dryRun) {
      console.log(
        `[Jira DRY RUN] Would transition ${ticketId} to ${transitionName}`,
      );
      return true;
    }

    const url = `${this.config.baseUrl}/rest/api/2/issue/${ticketId}/transitions`;

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader(),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        console.error(
          `[Jira] Failed to get transitions for ${ticketId}: ${await resp.text()}`,
        );
        return false;
      }

      const data = (await resp.json()) as {
        transitions?: Array<{ id: string; name: string }>;
      };

      const match = data.transitions?.find(
        (t) => t.name.toLowerCase() === transitionName.toLowerCase(),
      );

      if (!match) {
        console.error(
          `[Jira] Transition '${transitionName}' not found for ${ticketId}`,
        );
        return false;
      }

      const transResp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transition: { id: match.id } }),
        signal: AbortSignal.timeout(30_000),
      });

      if (transResp.status === 204) {
        debugPrint(`[Jira] Transitioned ${ticketId} to ${transitionName}`);
        return true;
      }

      console.error(
        `[Jira] Failed to transition ${ticketId}: ${await transResp.text()}`,
      );
      return false;
    } catch (err) {
      console.error(`[Jira] Transition failed for ${ticketId}: ${err}`);
      return false;
    }
  }

  formatResultComment(result: JiraTestResult): string {
    const emoji: Record<string, string> = {
      passed: "✅",
      failed: "❌",
      skipped: "⏭️",
      timedOut: "⏰",
    };

    const ts = result.timestamp || new Date().toISOString();
    let comment = `${emoji[result.status] || "❓"} *Automated Test Result*\n\n`;
    comment += `*Test:* ${result.testName}\n`;
    comment += `*Status:* ${result.status.toUpperCase()}\n`;
    comment += `*Duration:* ${result.durationMs}ms\n`;
    comment += `*Timestamp:* ${ts}\n`;

    if (result.testFile) {
      comment += `*Test File:* {{${result.testFile}}}\n`;
    }

    if (result.errorMessage && result.status === "failed") {
      comment += `\n*Error Details:*\n{code}\n${result.errorMessage.slice(0, 2000)}\n{code}\n`;
    }

    comment +=
      "\n_This comment was automatically generated by playwright-ai-framework-ts._";

    return comment;
  }

  async reportTestResult(result: JiraTestResult): Promise<boolean> {
    const comment = this.formatResultComment(result);
    const posted = await this.postComment(result.ticketId, comment);

    if (posted && result.status === "passed" && this.config.transitionOnPass) {
      await this.transitionTicket(
        result.ticketId,
        this.config.transitionOnPass,
      );
    }

    if (posted && result.status === "failed" && this.config.transitionOnFail) {
      await this.transitionTicket(
        result.ticketId,
        this.config.transitionOnFail,
      );
    }

    return posted;
  }
}

let _client: JiraClient | null = null;

export function getJiraClient(): JiraClient {
  if (!_client) {
    _client = new JiraClient();
  }
  return _client;
}

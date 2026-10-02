/**
 * OWASP ZAP passive-scanning integration for Playwright tests.
 *
 * TypeScript port of utils/zap_integration.py. Disabled unless ZAP_ENABLED=true.
 * When enabled, routes browser traffic through ZAP and pulls passive-scan alerts
 * over ZAP's REST API (via global fetch — no extra dependency).
 */

interface ZapAlert {
  risk?: string;
  alert?: string;
  url?: string;
  description?: string;
  solution?: string;
}

const RISK_LEVELS: Record<string, number> = {
  Informational: 0,
  Low: 1,
  Medium: 2,
  High: 3,
};

export interface ProxyConfig {
  proxy?: { server: string };
}

export class ZAPIntegration {
  readonly proxyHost: string;
  readonly proxyPort: number;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly enabled: boolean;

  constructor(proxyHost = "localhost", proxyPort = 8080, apiKey = "") {
    this.proxyHost = proxyHost;
    this.proxyPort = Math.trunc(proxyPort);
    this.apiKey = apiKey || process.env.ZAP_API_KEY || "";
    this.baseUrl = `http://${this.proxyHost}:${this.proxyPort}`;
    this.enabled = (process.env.ZAP_ENABLED || "false").toLowerCase() === "true";
  }

  get proxyUrl(): string {
    return `http://${this.proxyHost}:${this.proxyPort}`;
  }

  /** Check if ZAP is accessible. */
  async isRunning(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const url = `${this.baseUrl}/JSON/core/view/version/?apikey=${encodeURIComponent(this.apiKey)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  /** Retrieve alerts from ZAP after a test run, filtered by minimum risk. */
  async getAlerts(minRisk = "Low"): Promise<ZapAlert[]> {
    if (!this.enabled) return [];
    try {
      const minLevel = RISK_LEVELS[minRisk] ?? 1;
      const url = `${this.baseUrl}/JSON/core/view/alerts/?apikey=${encodeURIComponent(this.apiKey)}&start=0&count=100`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (resp.status !== 200) return [];
      const data = (await resp.json()) as { alerts?: ZapAlert[] };
      const alerts = data.alerts ?? [];
      return alerts.filter((a) => (RISK_LEVELS[a.risk ?? "Informational"] ?? 0) >= minLevel);
    } catch (e) {
      console.log(`ZAP alert retrieval failed: ${String(e)}`);
      return [];
    }
  }

  /** Summary of alerts by risk level. */
  async getAlertsSummary(): Promise<Record<string, number>> {
    const alerts = await this.getAlerts("Informational");
    const summary: Record<string, number> = { High: 0, Medium: 0, Low: 0, Informational: 0 };
    for (const alert of alerts) {
      const risk = alert.risk ?? "Informational";
      summary[risk] = (summary[risk] ?? 0) + 1;
    }
    return summary;
  }

  /** Generate a markdown report of ZAP findings. */
  async generateReport(): Promise<string> {
    const alerts = await this.getAlerts();
    if (alerts.length === 0) {
      return "# ZAP Security Scan\n\nNo security alerts found.";
    }

    const summary = await this.getAlertsSummary();
    const lines: string[] = ["# ZAP Passive Scan Report", ""];
    lines.push(`**High:** ${summary.High} | **Medium:** ${summary.Medium} | **Low:** ${summary.Low}`);
    lines.push("");

    const order: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
    const sorted = [...alerts].sort(
      (a, b) => (order[a.risk ?? ""] ?? 3) - (order[b.risk ?? ""] ?? 3),
    );
    for (const alert of sorted) {
      lines.push(`## [${alert.risk ?? "?"}] ${alert.alert ?? "Unknown"}`);
      lines.push(`- **URL:** ${alert.url ?? "N/A"}`);
      lines.push(`- **Description:** ${(alert.description ?? "N/A").slice(0, 200)}`);
      lines.push(`- **Solution:** ${(alert.solution ?? "N/A").slice(0, 200)}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  /** Proxy config for Playwright browser launch (empty when disabled). */
  getBrowserProxyConfig(): ProxyConfig {
    if (!this.enabled) return {};
    return { proxy: { server: this.proxyUrl } };
  }
}

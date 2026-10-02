/**
 * Capture API requests/responses during test execution for debugging.
 *
 * TypeScript port of utils/api_capture.py. Wire onRequest/onResponse to the
 * Playwright page's "request"/"response" events; on failure the captured
 * traffic is attached to the report as JSON.
 */
import type { Request, Response } from "@playwright/test";

const MAX_BODY = 10240; // cap response bodies at 10KB

// Static assets we don't care about capturing
const SKIP_EXTENSIONS = [
  ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg",
  ".woff", ".woff2", ".ttf", ".ico",
];

export interface CapturedRequestDict {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  timestamp: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  responseBody: string;
}

export class CapturedRequest {
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  responseBody: string;
  durationMs: number;
  timestamp: string;

  constructor(init: {
    method: string;
    url: string;
    status?: number;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
    durationMs?: number;
    timestamp?: string;
  }) {
    this.method = init.method;
    this.url = init.url;
    this.status = init.status ?? 0;
    this.requestHeaders = init.requestHeaders ?? {};
    this.responseHeaders = init.responseHeaders ?? {};
    this.responseBody = init.responseBody ?? "";
    this.durationMs = init.durationMs ?? 0;
    this.timestamp = init.timestamp ?? "";
  }

  toDict(): CapturedRequestDict {
    return {
      method: this.method,
      url: this.url,
      status: this.status,
      durationMs: this.durationMs,
      timestamp: this.timestamp,
      requestHeaders: this.requestHeaders,
      responseHeaders: this.responseHeaders,
      responseBody: this.responseBody ? this.responseBody.slice(0, MAX_BODY) : "",
    };
  }
}

export class APICapture {
  requests: CapturedRequest[] = [];
  private pending = new Map<string, CapturedRequest>();

  /** Only capture API calls, skip static assets. */
  shouldCapture(url: string): boolean {
    let path: string;
    try {
      path = new URL(url).pathname.toLowerCase();
    } catch {
      path = url.toLowerCase();
    }
    return !SKIP_EXTENSIONS.some((ext) => path.endsWith(ext));
  }

  onRequest(request: Request): void {
    if (!this.shouldCapture(request.url())) return;
    this.pending.set(
      request.url(),
      new CapturedRequest({
        method: request.method(),
        url: request.url(),
        requestHeaders: request.headers(),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  async onResponse(response: Response): Promise<void> {
    const url = response.url();
    const captured = this.pending.get(url);
    if (!captured) return;
    this.pending.delete(url);
    captured.status = response.status();
    captured.responseHeaders = response.headers();
    try {
      const body = await response.body();
      captured.responseBody = body.toString("utf-8").slice(0, MAX_BODY);
    } catch {
      captured.responseBody = "<could not read body>";
    }
    this.requests.push(captured);
  }

  /** Serialize all captured requests to JSON. */
  toJson(): string {
    return JSON.stringify(
      this.requests.map((r) => r.toDict()),
      null,
      2,
    );
  }

  /** One-line-per-request summary for reports. */
  summary(): string {
    return this.requests
      .map((r) => `${r.method} ${r.status} ${r.url} (${Math.round(r.durationMs)}ms)`)
      .join("\n");
  }

  clear(): void {
    this.requests = [];
    this.pending.clear();
  }
}

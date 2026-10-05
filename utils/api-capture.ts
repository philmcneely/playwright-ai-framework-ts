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

// Headers whose values are credentials: never persist them into report artifacts.
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api[-_]?key|password|auth/i;

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, SENSITIVE_HEADER.test(k) ? "[REDACTED]" : v]),
  );
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
  // Keyed by the Playwright Request object (not the URL) so overlapping calls
  // to the same endpoint are tracked independently.
  private pending = new Map<Request, CapturedRequest>();
  private inflight = new Set<Promise<void>>();

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
      request,
      new CapturedRequest({
        method: request.method(),
        url: request.url(),
        requestHeaders: redactHeaders(request.headers()),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  /** Track the async response handling so teardown can await it via settled(). */
  trackResponse(response: Response): void {
    const p = this.onResponse(response).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /** Resolve once every response seen so far has finished (or been dropped). */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  async onResponse(response: Response): Promise<void> {
    // Everything here is best-effort: a response can be torn down with its
    // page/context mid-flight (Playwright then throws "not bound in the
    // connection"), so no access is allowed to escape as an unhandled
    // rejection and disturb the test.
    try {
      const request = response.request();
      const captured = this.pending.get(request);
      if (!captured) return;
      this.pending.delete(request);
      captured.status = response.status();
      captured.responseHeaders = redactHeaders(response.headers());
      try {
        const body = await response.body();
        captured.responseBody = body.toString("utf-8").slice(0, MAX_BODY);
      } catch {
        captured.responseBody = "<could not read body>";
      }
      this.requests.push(captured);
    } catch {
      // Response no longer bound — drop it silently.
    }
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

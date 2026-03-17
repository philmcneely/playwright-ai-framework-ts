/**
 * Network Mocking Utility
 *
 * Provides comprehensive network request mocking capabilities for Playwright tests.
 * Supports mocking GET/POST/PUT/DELETE requests, loading mock data from files,
 * simulating network failures and slow connections.
 */

import { Page, Route, Request } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/** Shape of a logged request. */
export interface RequestLogEntry {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
  timestamp: number;
}

/** Shape of a logged response. */
export interface ResponseLogEntry {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  timestamp: number;
}

/** Options accepted by the mock helpers. */
export interface MockOptions {
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
}

/** Common mock response templates. */
export const MOCK_TEMPLATES: Record<string, { status: number; headers: Record<string, string>; body: unknown }> = {
  success: {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: { success: true, message: "OK" },
  },
  created: {
    status: 201,
    headers: { "Content-Type": "application/json" },
    body: { success: true, message: "Created" },
  },
  noContent: {
    status: 204,
    headers: {},
    body: null,
  },
  badRequest: {
    status: 400,
    headers: { "Content-Type": "application/json" },
    body: { error: "Bad Request", message: "Invalid request parameters" },
  },
  unauthorized: {
    status: 401,
    headers: { "Content-Type": "application/json" },
    body: { error: "Unauthorized", message: "Authentication required" },
  },
  forbidden: {
    status: 403,
    headers: { "Content-Type": "application/json" },
    body: { error: "Forbidden", message: "Access denied" },
  },
  notFound: {
    status: 404,
    headers: { "Content-Type": "application/json" },
    body: { error: "Not Found", message: "Resource not found" },
  },
  serverError: {
    status: 500,
    headers: { "Content-Type": "application/json" },
    body: { error: "Internal Server Error", message: "Something went wrong" },
  },
};

/**
 * Get a copy of a mock template by name.
 */
export function getMockTemplate(name: string): { status: number; headers: Record<string, string>; body: unknown } {
  const template = MOCK_TEMPLATES[name];
  if (!template) {
    throw new Error(`Unknown mock template: ${name}. Available: ${Object.keys(MOCK_TEMPLATES).join(", ")}`);
  }
  return { ...template, headers: { ...template.headers }, body: structuredClone(template.body) };
}

/**
 * Create a JSON mock data file on disk.
 */
export function createMockDataFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * NetworkMocker provides a high-level API for intercepting and mocking
 * network requests during Playwright tests.
 */
export class NetworkMocker {
  private page: Page;
  private mockedRoutes: Map<string, (route: Route, request: Request) => Promise<void>> = new Map();
  private requestLog: RequestLogEntry[] = [];
  private responseLog: ResponseLogEntry[] = [];

  constructor(page: Page) {
    this.page = page;
  }

  // --------------- public convenience methods ---------------

  async mockGet(
    urlPattern: string,
    responseBody: unknown,
    options: MockOptions = {},
  ): Promise<void> {
    await this._mockRequest(urlPattern, "GET", responseBody, options);
  }

  async mockPost(
    urlPattern: string,
    responseBody: unknown,
    options: MockOptions = {},
  ): Promise<void> {
    await this._mockRequest(urlPattern, "POST", responseBody, options);
  }

  async mockPut(
    urlPattern: string,
    responseBody: unknown,
    options: MockOptions = {},
  ): Promise<void> {
    await this._mockRequest(urlPattern, "PUT", responseBody, options);
  }

  async mockDelete(
    urlPattern: string,
    responseBody: unknown,
    options: MockOptions = {},
  ): Promise<void> {
    await this._mockRequest(urlPattern, "DELETE", responseBody, options);
  }

  /**
   * Load response body from a JSON file on disk.
   */
  async mockFromFile(
    urlPattern: string,
    filePath: string,
    method: string = "GET",
    options: MockOptions = {},
  ): Promise<void> {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    await this._mockRequest(urlPattern, method, data, options);
  }

  /**
   * Use a callback function to build the response dynamically for each request.
   */
  async mockWithFunction(
    urlPattern: string,
    handler: (request: Request) => unknown | Promise<unknown>,
    method?: string,
    options: MockOptions = {},
  ): Promise<void> {
    const status = options.status ?? 200;
    const contentType = options.contentType ?? "application/json";
    const extraHeaders = options.headers ?? {};

    const routeHandler = async (route: Route, request: Request) => {
      // If a specific method is required, skip non-matching requests
      if (method && request.method() !== method.toUpperCase()) {
        await route.fallback();
        return;
      }

      this._logRequest(request);

      const responseData = await handler(request);
      const body = typeof responseData === "string" ? responseData : JSON.stringify(responseData);
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        ...extraHeaders,
      };

      await route.fulfill({ status, headers, body });

      this._logResponse(request.url(), status, headers, responseData);
    };

    await this.page.route(urlPattern, routeHandler);
    this.mockedRoutes.set(`fn:${urlPattern}:${method ?? "ALL"}`, routeHandler);
  }

  /**
   * Simulate a network failure for requests matching the pattern.
   */
  async simulateNetworkFailure(urlPattern: string): Promise<void> {
    const routeHandler = async (route: Route) => {
      await route.abort("failed");
    };
    await this.page.route(urlPattern, routeHandler);
    this.mockedRoutes.set(`fail:${urlPattern}`, routeHandler);
  }

  /**
   * Add artificial latency before letting the request continue or fulfill.
   */
  async simulateSlowNetwork(urlPattern: string, delayMs: number): Promise<void> {
    const routeHandler = async (route: Route, request: Request) => {
      this._logRequest(request);
      await new Promise((r) => setTimeout(r, delayMs));
      await route.continue();
    };
    await this.page.route(urlPattern, routeHandler);
    this.mockedRoutes.set(`slow:${urlPattern}`, routeHandler);
  }

  /**
   * Simulate complete offline mode — all requests fail.
   */
  async simulateOffline(): Promise<void> {
    await this.simulateNetworkFailure("**/*");
  }

  /**
   * Remove all registered mock routes.
   */
  async clearMocks(): Promise<void> {
    for (const [, handler] of this.mockedRoutes) {
      await this.page.unroute("**/*", handler).catch(() => {
        // route may already have been removed
      });
    }
    // Fallback: try to unroute every recorded pattern
    for (const key of this.mockedRoutes.keys()) {
      const parts = key.split(":");
      const pattern = parts.length >= 2 ? parts.slice(1, -1).join(":") || parts[1] : "**/*";
      await this.page.unroute(pattern).catch(() => {});
    }
    this.mockedRoutes.clear();
    this.requestLog = [];
    this.responseLog = [];
  }

  /** Get a copy of the request log. */
  getRequestLog(): RequestLogEntry[] {
    return [...this.requestLog];
  }

  /** Get a copy of the response log. */
  getResponseLog(): ResponseLogEntry[] {
    return [...this.responseLog];
  }

  /** Print all logged network activity to the console. */
  printNetworkActivity(): void {
    console.log("\n=== Network Activity ===");
    console.log(`Requests: ${this.requestLog.length}`);
    for (const req of this.requestLog) {
      console.log(`  → ${req.method} ${req.url}`);
    }
    console.log(`Responses: ${this.responseLog.length}`);
    for (const res of this.responseLog) {
      console.log(`  ← ${res.status} ${res.url}`);
    }
    console.log("========================\n");
  }

  // --------------- private helpers ---------------

  private async _mockRequest(
    urlPattern: string,
    method: string,
    responseBody: unknown,
    options: MockOptions,
  ): Promise<void> {
    const status = options.status ?? 200;
    const contentType = options.contentType ?? "application/json";
    const extraHeaders = options.headers ?? {};

    const routeHandler = async (route: Route, request: Request) => {
      if (request.method() !== method.toUpperCase()) {
        await route.fallback();
        return;
      }

      this._logRequest(request);

      const body = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        ...extraHeaders,
      };

      await route.fulfill({ status, headers, body });

      this._logResponse(request.url(), status, headers, responseBody);
    };

    await this.page.route(urlPattern, routeHandler);
    this.mockedRoutes.set(`${method}:${urlPattern}`, routeHandler);
  }

  private _logRequest(request: Request): void {
    this.requestLog.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      postData: request.postData(),
      timestamp: Date.now(),
    });
  }

  private _logResponse(
    url: string,
    status: number,
    headers: Record<string, string>,
    body: unknown,
  ): void {
    this.responseLog.push({
      url,
      status,
      headers,
      body,
      timestamp: Date.now(),
    });
  }
}

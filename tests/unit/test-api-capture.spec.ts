/**
 * Unit tests for API capture (QA-19). Mirror of tests/test_api_capture.py.
 * Pure logic — no browser.
 */
import { test, expect, type Request, type Response } from "@playwright/test";
import { APICapture, CapturedRequest } from "../../utils/api-capture.js";

test("should capture API calls, skip static assets", () => {
  const cap = new APICapture();
  expect(cap.shouldCapture("https://api.example.com/users")).toBe(true);
  expect(cap.shouldCapture("https://cdn.example.com/style.css")).toBe(false);
  expect(cap.shouldCapture("https://cdn.example.com/logo.png")).toBe(false);
  expect(cap.shouldCapture("https://api.example.com/data.json")).toBe(true);
});

test("captured request to dict", () => {
  const req = new CapturedRequest({ method: "GET", url: "https://api.test.com/v1/users", status: 200 });
  const d = req.toDict();
  expect(d.method).toBe("GET");
  expect(d.status).toBe(200);
  expect(d.url).toBe("https://api.test.com/v1/users");
});

test("response body truncation at 10KB", () => {
  const req = new CapturedRequest({ method: "POST", url: "https://api.test.com", responseBody: "x".repeat(20000) });
  const d = req.toDict();
  expect(d.responseBody.length).toBe(10240);
});

test("summary output", () => {
  const cap = new APICapture();
  cap.requests = [
    new CapturedRequest({ method: "GET", url: "https://api.test.com/users", status: 200, durationMs: 45 }),
    new CapturedRequest({ method: "POST", url: "https://api.test.com/login", status: 401, durationMs: 120 }),
  ];
  const summary = cap.summary();
  expect(summary).toContain("GET 200");
  expect(summary).toContain("POST 401");
});

test("to JSON", () => {
  const cap = new APICapture();
  cap.requests = [new CapturedRequest({ method: "GET", url: "https://test.com", status: 200 })];
  expect(cap.toJson()).toContain('"method": "GET"');
});

test("clear", () => {
  const cap = new APICapture();
  cap.requests = [new CapturedRequest({ method: "GET", url: "https://test.com", status: 200 })];
  cap.clear();
  expect(cap.requests.length).toBe(0);
});

// Minimal stand-ins for Playwright's Request/Response (only what APICapture touches).
type Stub = Record<string, unknown>;
const req = (url: string, headers: Record<string, string> = {}) =>
  ({ url: () => url, method: () => "GET", headers: () => headers }) as unknown as Request;
const res = (request: Request, over: Stub = {}) =>
  ({
    request: () => request,
    url: () => request.url(),
    status: () => 200,
    headers: () => ({}),
    body: async () => Buffer.from("ok"),
    ...over,
  }) as unknown as Response;

test("overlapping requests to the same URL are captured independently", async () => {
  const cap = new APICapture();
  const a = req("https://api.test.com/x");
  const b = req("https://api.test.com/x");
  cap.onRequest(a);
  cap.onRequest(b);
  await cap.onResponse(res(b, { status: () => 201 }));
  await cap.onResponse(res(a, { status: () => 200 }));
  expect(cap.requests.map((r) => r.status).sort()).toEqual([200, 201]);
});

test("credential headers are redacted in requests and responses", async () => {
  const cap = new APICapture();
  const r = req("https://api.test.com/me", { Authorization: "Bearer abc", Cookie: "s=1", "X-Api-Key": "k", Accept: "*/*" });
  cap.onRequest(r);
  await cap.onResponse(res(r, { headers: () => ({ "set-cookie": "s=2", "content-type": "text/plain" }) }));
  const d = cap.requests[0].toDict();
  expect(d.requestHeaders).toEqual({ Authorization: "[REDACTED]", Cookie: "[REDACTED]", "X-Api-Key": "[REDACTED]", Accept: "*/*" });
  expect(d.responseHeaders).toEqual({ "set-cookie": "[REDACTED]", "content-type": "text/plain" });
  expect(cap.toJson()).not.toContain("Bearer abc");
});

test("settled() waits for in-flight body reads", async () => {
  const cap = new APICapture();
  const r = req("https://api.test.com/slow");
  cap.onRequest(r);
  cap.trackResponse(res(r, { body: async () => { await new Promise((ok) => setTimeout(ok, 50)); return Buffer.from("late"); } }));
  expect(cap.requests).toHaveLength(0);
  await cap.settled();
  expect(cap.requests[0].responseBody).toBe("late");
});

test("a response torn down mid-flight is dropped, not thrown", async () => {
  const cap = new APICapture();
  const r = req("https://api.test.com/gone");
  cap.onRequest(r);
  await expect(cap.onResponse(res(r, { status: () => { throw new Error("not bound in the connection"); } }))).resolves.toBeUndefined();
  expect(cap.requests).toHaveLength(0);
});

test("unreadable body keeps the request with a placeholder", async () => {
  const cap = new APICapture();
  const r = req("https://api.test.com/nobody");
  cap.onRequest(r);
  await cap.onResponse(res(r, { body: async () => { throw new Error("evicted"); } }));
  expect(cap.requests[0].responseBody).toBe("<could not read body>");
});

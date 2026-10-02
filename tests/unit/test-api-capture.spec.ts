/**
 * Unit tests for API capture (QA-19). Mirror of tests/test_api_capture.py.
 * Pure logic — no browser.
 */
import { test, expect } from "@playwright/test";
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

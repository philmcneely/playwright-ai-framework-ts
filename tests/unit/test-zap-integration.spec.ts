/**
 * Unit tests for ZAP integration (QA-24). Mirror of
 * tests/test_zap_integration.py. No live ZAP required — disabled instances
 * short-circuit without any network call.
 */
import { test, expect } from "@playwright/test";
import { ZAPIntegration } from "../../utils/zap-integration.js";

let savedEnabled: string | undefined;

test.beforeEach(() => {
  savedEnabled = process.env.ZAP_ENABLED;
  delete process.env.ZAP_ENABLED;
});

test.afterEach(() => {
  if (savedEnabled === undefined) delete process.env.ZAP_ENABLED;
  else process.env.ZAP_ENABLED = savedEnabled;
});

test("proxy url", () => {
  const zap = new ZAPIntegration("localhost", 8080);
  expect(zap.proxyUrl).toBe("http://localhost:8080");
});

test("disabled by default", async () => {
  const zap = new ZAPIntegration();
  expect(zap.enabled).toBe(false);
  expect(await zap.isRunning()).toBe(false);
  expect(await zap.getAlerts()).toEqual([]);
  expect(zap.getBrowserProxyConfig()).toEqual({});
});

test("proxy config when enabled", () => {
  process.env.ZAP_ENABLED = "true";
  const zap = new ZAPIntegration();
  expect(zap.enabled).toBe(true);
  const config = zap.getBrowserProxyConfig();
  expect(config.proxy).toBeDefined();
  expect(config.proxy?.server).toBe("http://localhost:8080");
});

test("custom port", () => {
  const zap = new ZAPIntegration("localhost", 9090);
  expect(zap.proxyUrl).toBe("http://localhost:9090");
  expect(zap.proxyPort).toBe(9090);
});

test("generate report with no alerts", async () => {
  const zap = new ZAPIntegration();
  const report = await zap.generateReport();
  expect(report).toContain("No security alerts");
});

test("alerts summary", async () => {
  const zap = new ZAPIntegration();
  const summary = await zap.getAlertsSummary();
  expect(summary).toEqual({ High: 0, Medium: 0, Low: 0, Informational: 0 });
});

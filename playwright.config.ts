import { defineConfig, devices } from "@playwright/test";
import { settings } from "./config/settings.js";
import { isBrowserStackEnabled, getBrowserStackCaps } from "./utils/browserstack.js";
import { ZAPIntegration } from "./utils/zap-integration.js";

// Route traffic through OWASP ZAP when ZAP_ENABLED=true (QA-24).
const zap = new ZAPIntegration();
const zapProxy = zap.getBrowserProxyConfig().proxy;
// On CI the log shows failures only and the HTML / JUnit reports keep only unexpected, flaky and interrupted tests;
// locally the progress list and full reports stay.
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  timeout: settings.TIMEOUT,
  // Retries and workers are env-driven: PW_RETRIES (default 0), PW_WORKERS (default: Playwright's own).
  retries: Number(process.env.PW_RETRIES ?? 0),
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : undefined,
  outputDir: "results/artifacts",
  globalSetup: "./utils/global-setup.ts",
  globalTeardown: "./utils/global-teardown.ts",
  reporter: [
    ["./utils/jira-reporter.ts"],
    ["./utils/observability-reporter.ts"],
    ["./utils/stability-reporter.ts"],
    ci ? ["failures"] : ["list"],
    ["html", { outputFolder: "results/html", open: "never", onlyFailures: ci }],
    ["junit", { outputFile: "results/junit.xml", onlyFailures: ci }],
    ["json", { outputFile: "results/results.json" }],
    ["allure-playwright", { resultsDir: "results/allure" }],
  ],
  use: {
    baseURL: settings.BASE_URL,
    headless: settings.HEADLESS,
    screenshot: "only-on-failure",
    video: "off",
    trace: "retain-on-failure",
    launchOptions: settings.getBrowserOptions(),
    // ZAP re-signs HTTPS with its own CA, which the test browser does not trust.
    ...(zapProxy ? { proxy: zapProxy, ignoreHTTPSErrors: true } : {}),
  },
  // A plain `playwright test` runs chromium; `--project=firefox` picks one, `--project="*"` runs all three.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      default: false,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      default: false,
    },
    ...(isBrowserStackEnabled()
      ? [{
          name: "browserstack",
          use: {
            connectOptions: {
              wsEndpoint: `wss://cdp.browserstack.com/playwright?caps=${JSON.stringify(getBrowserStackCaps())}`,
            },
          },
        }]
      : []),
  ],
});

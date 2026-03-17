import { defineConfig, devices } from "@playwright/test";
import { settings } from "./config/settings.js";

export default defineConfig({
  testDir: "./tests",
  timeout: settings.TIMEOUT,
  retries: settings.RETRY_COUNT,
  reporter: [
    ["html"],
    ["list"],
  ],
  use: {
    baseURL: settings.BASE_URL,
    headless: settings.HEADLESS,
    screenshot: settings.SCREENSHOT_ON_FAILURE ? "only-on-failure" : "off",
    video: settings.VIDEO_ON_FAILURE ? "retain-on-failure" : "off",
    trace: "retain-on-failure",
    launchOptions: settings.getBrowserOptions(),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
});

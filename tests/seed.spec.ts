import { test } from "@playwright/test";

// Seed file for the Playwright test agents (planner/generator).
// The generator uses this as the environment bootstrap; keep it minimal.
test.describe("Test group", () => {
  test("seed", async ({ page }) => {
    await page.goto("/");
  });
});

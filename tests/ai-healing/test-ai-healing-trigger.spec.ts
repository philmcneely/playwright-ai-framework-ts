import { test, expect } from "../../fixtures/index.js";

test.describe("AI Healing Trigger @ai-healing", () => {
  test("intentionally broken locator triggers healing", async ({ page }) => {
    await page.goto("/login");
    // This uses a broken locator to trigger failure.
    // With AI_HEALING_ENABLED=true, the reporter should detect the
    // element-not-found error and suggest a fix via Ollama.
    await expect(
      page.locator("#nonexistent-element"),
    ).toBeVisible({ timeout: 3000 });
  });
});

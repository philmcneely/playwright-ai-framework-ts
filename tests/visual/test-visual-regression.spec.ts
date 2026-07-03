/**
 * Visual Regression Tests
 *
 * Validates the visual regression utility using inline HTML pages.
 * First run creates baselines; second run performs comparisons.
 *
 * @tags @visual
 */

import * as fs from "fs";
import { test, expect } from "../../fixtures/index.js";
import {
  resetBaseline,
  listVisualFiles,
} from "../../utils/visual-regression.js";
import {
  VISUAL_BASELINE_DIR,
  VISUAL_CURRENT_DIR,
  VISUAL_DIFF_DIR,
} from "../../config/artifact-paths.js";

const SAMPLE_PAGE = `
  <html>
    <head><style>
      body { margin: 0; padding: 40px; font-family: Arial, sans-serif; background: #f0f0f0; }
      h1 { color: #333; }
      .box { width: 200px; height: 200px; background: #4285f4; border-radius: 8px; }
    </style></head>
    <body>
      <h1>Visual Test Page</h1>
      <div class="box" id="test-box"></div>
    </body>
  </html>
`;

const SLIGHTLY_DIFFERENT_PAGE = `
  <html>
    <head><style>
      body { margin: 0; padding: 40px; font-family: Arial, sans-serif; background: #f0f0f0; }
      h1 { color: #333; }
      .box { width: 200px; height: 200px; background: #4285f4; border-radius: 8px; }
    </style></head>
    <body>
      <h1>Visual Test Page!</h1>
      <div class="box" id="test-box"></div>
    </body>
  </html>
`;

const COMPLETELY_DIFFERENT_PAGE = `
  <html>
    <head><style>
      body { margin: 0; padding: 40px; font-family: monospace; background: #ff0000; }
      h1 { color: #fff; font-size: 60px; }
      .circle { width: 300px; height: 300px; background: #000; border-radius: 50%; }
    </style></head>
    <body>
      <h1>TOTALLY DIFFERENT</h1>
      <div class="circle"></div>
    </body>
  </html>
`;

test.describe("Visual Regression @visual", () => {
  test.beforeEach(() => {
    // Clean up baselines for deterministic tests
    resetBaseline("baseline_creation");
    resetBaseline("small_change");
    resetBaseline("major_change");
    resetBaseline("element_screenshot");
  });

  test("baseline creation on first run", async ({ visualRegression, page }) => {
    await page.setContent(SAMPLE_PAGE);
    await page.waitForLoadState("networkidle");

    const result = await visualRegression.compare("baseline_creation");

    expect(result.passed).toBe(true);
    expect(result.message).toContain("Baseline created");

    const baselinePath = `${VISUAL_BASELINE_DIR}/baseline_creation.png`;
    expect(fs.existsSync(baselinePath)).toBe(true);
  });

  test("small change within tolerance passes", async ({ visualRegression, page }) => {
    // Create baseline
    await page.setContent(SAMPLE_PAGE);
    await page.waitForLoadState("networkidle");
    await visualRegression.compare("small_change");

    // Compare with slightly different page (added "!" to heading)
    await page.setContent(SLIGHTLY_DIFFERENT_PAGE);
    await page.waitForLoadState("networkidle");

    const result = await visualRegression.compare("small_change", { tolerance: 0.02 });

    expect(result.passed).toBe(true);
    expect(result.diffRatio).toBeDefined();
    expect(result.diffRatio!).toBeLessThanOrEqual(0.02);
  });

  test("major change should fail", async ({ visualRegression, page }) => {
    // Create baseline
    await page.setContent(SAMPLE_PAGE);
    await page.waitForLoadState("networkidle");
    await visualRegression.compare("major_change");

    // Compare with completely different page
    await page.setContent(COMPLETELY_DIFFERENT_PAGE);
    await page.waitForLoadState("networkidle");

    const result = await visualRegression.compare("major_change", { tolerance: 0.01 });

    expect(result.passed).toBe(false);
    expect(result.message).toContain("Visual regression failed");
    expect(result.diffRatio!).toBeGreaterThan(0.01);

    // Verify diff image was saved
    const diffPath = `${VISUAL_DIFF_DIR}/major_change_diff.png`;
    expect(result.diffPath).toBe(diffPath);
    expect(fs.existsSync(diffPath)).toBe(true);
  });

  test("element-specific screenshot comparison", async ({ visualRegression, page }) => {
    await page.setContent(SAMPLE_PAGE);
    await page.waitForLoadState("networkidle");

    const result = await visualRegression.compare("element_screenshot", {
      selector: "#test-box",
    });

    expect(result.passed).toBe(true);
    expect(result.message).toContain("Baseline created");

    // Re-run with same content — should pass comparison
    const result2 = await visualRegression.compare("element_screenshot", {
      selector: "#test-box",
    });

    expect(result2.passed).toBe(true);
    expect(result2.diffPixels).toBe(0);
  });

  test("visual files are listed correctly", async ({ visualRegression, page }) => {
    await page.setContent(SAMPLE_PAGE);
    await page.waitForLoadState("networkidle");
    await visualRegression.compare("baseline_creation");

    const files = listVisualFiles();

    expect(fs.existsSync(VISUAL_BASELINE_DIR)).toBe(true);
    expect(fs.existsSync(VISUAL_CURRENT_DIR)).toBe(true);
    expect(fs.existsSync(VISUAL_DIFF_DIR)).toBe(true);
    expect(files.baselines).toContain("baseline_creation.png");
    expect(files.current).toContain("baseline_creation.png");
  });
});

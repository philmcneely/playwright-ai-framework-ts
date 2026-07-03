/**
 * Visual Regression Utility
 *
 * Provides screenshot-based visual comparison for Playwright tests.
 * Uses pixelmatch for pixel-level diffing and pngjs for PNG handling.
 */

import { Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  VISUAL_BASELINE_DIR,
  VISUAL_CURRENT_DIR,
  VISUAL_DIFF_DIR,
} from "../config/artifact-paths.js";

export interface CompareOptions {
  /** CSS selector for element-specific screenshot */
  selector?: string;
  /** Capture full scrollable page */
  fullPage?: boolean;
  /** Max fraction of different pixels allowed (0.01 = 1%) */
  tolerance?: number;
}

export interface CompareResult {
  passed: boolean;
  message: string;
  diffRatio?: number;
  diffPixels?: number;
  baselinePath?: string;
  currentPath?: string;
  diffPath?: string;
}

/** Restrict snapshot names to a safe filename charset (no path separators). */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class VisualRegression {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
    fs.mkdirSync(VISUAL_BASELINE_DIR, { recursive: true });
    fs.mkdirSync(VISUAL_CURRENT_DIR, { recursive: true });
    fs.mkdirSync(VISUAL_DIFF_DIR, { recursive: true });
  }

  /**
   * Compare current page/element screenshot against a stored baseline.
   * On first run (no baseline), saves the screenshot as baseline and returns a skip result.
   * On subsequent runs, compares and returns `passed: false` if the diff exceeds
   * tolerance or the dimensions changed — the caller decides whether to fail the test.
   */
  async compare(name: string, options: CompareOptions = {}): Promise<CompareResult> {
    const { selector, fullPage = false, tolerance = 0.01 } = options;

    const safeName = sanitizeName(name);
    const baselinePath = path.join(VISUAL_BASELINE_DIR, `${safeName}.png`);
    const currentPath = path.join(VISUAL_CURRENT_DIR, `${safeName}.png`);
    const diffPath = path.join(VISUAL_DIFF_DIR, `${safeName}_diff.png`);

    // Take screenshot
    const screenshotBuffer = await this.takeScreenshot(selector, fullPage);
    fs.writeFileSync(currentPath, screenshotBuffer);

    // First run — no baseline exists
    if (!fs.existsSync(baselinePath)) {
      fs.copyFileSync(currentPath, baselinePath);
      return {
        passed: true,
        message: `Baseline created for "${name}". Re-run to compare.`,
        baselinePath,
        currentPath,
      };
    }

    // Read baseline and current PNGs
    const baselinePng = PNG.sync.read(fs.readFileSync(baselinePath));
    const currentPng: PNG = PNG.sync.read(screenshotBuffer);

    // Fail fast on dimension mismatch — padding/cropping would only mask the
    // real problem (viewport or element size changed since the baseline).
    if (
      baselinePng.width !== currentPng.width ||
      baselinePng.height !== currentPng.height
    ) {
      return {
        passed: false,
        message:
          `Visual regression failed for "${name}": viewport dimensions changed ` +
          `(baseline ${baselinePng.width}x${baselinePng.height}, ` +
          `current ${currentPng.width}x${currentPng.height}). ` +
          `Delete the baseline to regenerate it at the new dimensions.`,
        baselinePath,
        currentPath,
      };
    }

    const { width, height } = baselinePng;
    const totalPixels = width * height;

    // Create diff output
    const diffPng = new PNG({ width, height });

    const numDiffPixels = pixelmatch(
      baselinePng.data,
      currentPng.data,
      diffPng.data,
      width,
      height,
      { threshold: 0.1 },
    );

    const diffRatio = numDiffPixels / totalPixels;

    if (diffRatio > tolerance) {
      // Save diff image
      fs.writeFileSync(diffPath, PNG.sync.write(diffPng));

      const pct = (diffRatio * 100).toFixed(2);
      const tolPct = (tolerance * 100).toFixed(2);
      return {
        passed: false,
        message: `Visual regression failed for "${name}": ${pct}% pixels differ (tolerance: ${tolPct}%). Diff saved to ${diffPath}`,
        diffRatio,
        diffPixels: numDiffPixels,
        baselinePath,
        currentPath,
        diffPath,
      };
    }

    return {
      passed: true,
      message: `Visual comparison passed for "${name}": ${(diffRatio * 100).toFixed(2)}% difference.`,
      diffRatio,
      diffPixels: numDiffPixels,
      baselinePath,
      currentPath,
    };
  }

  /**
   * Take a screenshot of the page or a specific element.
   */
  private async takeScreenshot(
    selector?: string,
    fullPage?: boolean,
  ): Promise<Buffer> {
    if (selector) {
      const element = this.page.locator(selector);
      return Buffer.from(await element.screenshot({ type: "png" }));
    }
    return Buffer.from(
      await this.page.screenshot({ type: "png", fullPage }),
    );
  }

}

/**
 * Delete a specific baseline image.
 */
export function resetBaseline(name: string): boolean {
  const baselinePath = path.join(VISUAL_BASELINE_DIR, `${sanitizeName(name)}.png`);
  if (fs.existsSync(baselinePath)) {
    fs.unlinkSync(baselinePath);
    return true;
  }
  return false;
}

/**
 * Delete all baseline images.
 */
export function resetAllBaselines(): number {
  if (!fs.existsSync(VISUAL_BASELINE_DIR)) {
    return 0;
  }
  const files = fs.readdirSync(VISUAL_BASELINE_DIR).filter((f) => f.endsWith(".png"));
  for (const file of files) {
    fs.unlinkSync(path.join(VISUAL_BASELINE_DIR, file));
  }
  return files.length;
}

/**
 * List all visual regression files across baseline, current, and diff directories.
 */
export function listVisualFiles(): {
  baselines: string[];
  current: string[];
  diffs: string[];
} {
  const readDir = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
  };

  return {
    baselines: readDir(VISUAL_BASELINE_DIR),
    current: readDir(VISUAL_CURRENT_DIR),
    diffs: readDir(VISUAL_DIFF_DIR),
  };
}

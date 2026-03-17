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
   * On subsequent runs, compares and throws if diff exceeds tolerance.
   */
  async compare(name: string, options: CompareOptions = {}): Promise<CompareResult> {
    const { selector, fullPage = false, tolerance = 0.01 } = options;

    const baselinePath = path.join(VISUAL_BASELINE_DIR, `${name}.png`);
    const currentPath = path.join(VISUAL_CURRENT_DIR, `${name}.png`);
    const diffPath = path.join(VISUAL_DIFF_DIR, `${name}_diff.png`);

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
    let currentPng: PNG = PNG.sync.read(screenshotBuffer);

    // If sizes differ, resize current to match baseline dimensions
    if (
      baselinePng.width !== currentPng.width ||
      baselinePng.height !== currentPng.height
    ) {
      currentPng = this.resizeToMatch(currentPng, baselinePng.width, baselinePng.height);
      // Rewrite the resized current image
      fs.writeFileSync(currentPath, PNG.sync.write(currentPng));
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
      throw new Error(
        `Visual regression failed for "${name}": ${pct}% pixels differ (tolerance: ${tolPct}%). Diff saved to ${diffPath}`,
      );
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

  /**
   * Resize a PNG to target dimensions by creating a new image and copying pixel data.
   * Pixels outside the source bounds are left transparent.
   */
  private resizeToMatch(source: PNG, targetWidth: number, targetHeight: number): PNG {
    const resized = new PNG({ width: targetWidth, height: targetHeight, fill: true });
    // Fill with transparent black
    resized.data.fill(0);

    const copyWidth = Math.min(source.width, targetWidth);
    const copyHeight = Math.min(source.height, targetHeight);

    for (let y = 0; y < copyHeight; y++) {
      for (let x = 0; x < copyWidth; x++) {
        const srcIdx = (y * source.width + x) * 4;
        const dstIdx = (y * targetWidth + x) * 4;
        resized.data[dstIdx] = source.data[srcIdx];
        resized.data[dstIdx + 1] = source.data[srcIdx + 1];
        resized.data[dstIdx + 2] = source.data[srcIdx + 2];
        resized.data[dstIdx + 3] = source.data[srcIdx + 3];
      }
    }

    return resized;
  }
}

/**
 * Delete a specific baseline image.
 */
export function resetBaseline(name: string): boolean {
  const baselinePath = path.join(VISUAL_BASELINE_DIR, `${name}.png`);
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

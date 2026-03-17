import * as fs from "fs";
import * as path from "path";
import type { Page } from "@playwright/test";
import { SCREENSHOT_DIR } from "../config/artifact-paths.js";

export async function captureScreenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(SCREENSHOT_DIR, `${name}_${timestamp}.png`);
  await page.screenshot({ path: filePath });
  console.log(`Screenshot saved: ${filePath}`);
  return filePath;
}

export async function captureFullPageScreenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(SCREENSHOT_DIR, `${name}_${timestamp}_full.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`Full page screenshot saved: ${filePath}`);
  return filePath;
}

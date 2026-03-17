import dotenv from "dotenv";

const env = process.env.ENV || "dev";
dotenv.config({ path: ".env" });
dotenv.config({ path: `.env.${env}`, override: false });

export const settings = {
  BASE_URL: process.env.BASE_URL || "https://the-internet.herokuapp.com",
  BROWSER: (process.env.BROWSER || "chromium") as "chromium" | "firefox" | "webkit",
  HEADLESS: (process.env.HEADLESS || "true").toLowerCase() === "true",
  SLOW_MO: parseInt(process.env.SLOW_MO || "100", 10),
  TIMEOUT: parseInt(process.env.TIMEOUT || "30000", 10),
  RETRY_COUNT: parseInt(process.env.RETRY_COUNT || "3", 10),
  RETRY_DELAY: parseInt(process.env.RETRY_DELAY || "1000", 10),
  SCREENSHOT_ON_FAILURE: (process.env.SCREENSHOT_ON_FAILURE || "true").toLowerCase() === "true",
  VIDEO_ON_FAILURE: (process.env.VIDEO_ON_FAILURE || "true").toLowerCase() === "true",
  DEBUG_MSG: (process.env.DEBUG_MSG || "false").toLowerCase() === "true",

  getBrowserOptions() {
    return {
      headless: this.HEADLESS,
      slowMo: this.SLOW_MO,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    };
  },
};

export function debugPrint(msg: string): void {
  if (settings.DEBUG_MSG) {
    console.log(msg);
  }
}

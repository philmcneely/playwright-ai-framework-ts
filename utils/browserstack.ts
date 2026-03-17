export function isBrowserStackEnabled(): boolean {
  return (process.env.BROWSERSTACK_ENABLED || "false").toLowerCase() === "true";
}

export function getBrowserStackCaps() {
  return {
    browser: "chrome",
    browser_version: "latest",
    os: "osx",
    os_version: "sonoma",
    name: "Playwright Test",
    build: "playwright-ts-build-1",
    "browserstack.username": process.env.BROWSERSTACK_USERNAME,
    "browserstack.accessKey": process.env.BROWSERSTACK_ACCESS_KEY,
  };
}

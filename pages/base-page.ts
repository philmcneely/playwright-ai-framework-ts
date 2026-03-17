import { Page, Locator } from "@playwright/test";

export class BasePage {
  constructor(protected readonly page: Page) {}

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
  }

  async navigateTo(url: string): Promise<void> {
    await this.page.goto(url);
  }

  async waitForLoadState(
    state: "load" | "domcontentloaded" | "networkidle" = "load",
  ): Promise<void> {
    await this.page.waitForLoadState(state);
  }

  async getTitle(): Promise<string> {
    return this.page.title();
  }

  getUrl(): string {
    return this.page.url();
  }

  async fillText(locator: Locator, text: string): Promise<void> {
    await locator.fill(text);
  }

  async clickElement(locator: Locator): Promise<void> {
    await locator.click();
  }

  async getText(locator: Locator): Promise<string> {
    return (await locator.textContent()) || "";
  }

  async isVisible(locator: Locator): Promise<boolean> {
    try {
      return await locator.isVisible();
    } catch {
      return false;
    }
  }

  async waitForElement(locator: Locator): Promise<void> {
    await locator.waitFor({ state: "visible" });
  }
}

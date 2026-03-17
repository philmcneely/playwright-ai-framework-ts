import { Locator } from "@playwright/test";
import { BasePage } from "./base-page.js";

export class SecurePage extends BasePage {
  get heading(): Locator {
    return this.page.locator("h2");
  }

  get flashMessage(): Locator {
    return this.page.locator("#flash");
  }

  get logoutButton(): Locator {
    return this.page.locator("a[href='/logout']");
  }

  async isOnSecurePage(): Promise<boolean> {
    return this.getUrl().includes("/secure");
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.isOnSecurePage()) && (await this.isVisible(this.heading));
  }

  async logout(): Promise<void> {
    await this.clickElement(this.logoutButton);
  }

  async getFlashMessageText(): Promise<string> {
    return this.getText(this.flashMessage);
  }
}

import { Locator } from "@playwright/test";
import { BasePage } from "./base-page.js";

export class LoginPage extends BasePage {
  // Relative path so Playwright's configured baseURL (settings.BASE_URL) applies
  readonly url = "/login";

  get usernameField(): Locator {
    return this.page.locator("#username");
  }

  get passwordField(): Locator {
    return this.page.locator("#password");
  }

  get loginButton(): Locator {
    return this.page.locator("button[type='submit']");
  }

  get successMessage(): Locator {
    return this.page.locator(".flash.success");
  }

  get errorMessage(): Locator {
    return this.page.locator(".flash.error");
  }

  get pageHeading(): Locator {
    return this.page.locator("h2");
  }

  async navigate(): Promise<void> {
    await this.goto(this.url);
  }

  async load(): Promise<void> {
    await this.goto(this.url);
    await this.waitForLoadState("domcontentloaded");
  }

  async enterUsername(username: string): Promise<void> {
    await this.fillText(this.usernameField, username);
  }

  async enterPassword(password: string): Promise<void> {
    await this.fillText(this.passwordField, password);
  }

  async clickLogin(): Promise<void> {
    await this.clickElement(this.loginButton);
  }

  async loginWithCredentials(
    username: string,
    password: string,
  ): Promise<void> {
    await this.enterUsername(username);
    await this.enterPassword(password);
    await this.clickLogin();
  }

  async loginWithDemoUser(): Promise<void> {
    await this.loginWithCredentials("tomsmith", "SuperSecretPassword!");
  }

  async enterPasswordX(password: string): Promise<void> {
    const brokenField = this.page.locator("#passwordx");
    await this.fillText(brokenField, password);
  }

  async isLoginSuccessful(): Promise<boolean> {
    return this.isVisible(this.successMessage);
  }

  async hasErrorMessage(): Promise<boolean> {
    return this.isVisible(this.errorMessage);
  }

  async getSuccessMessageText(): Promise<string> {
    return this.getText(this.successMessage);
  }

  async getErrorMessageText(): Promise<string> {
    return this.getText(this.errorMessage);
  }

  async isOnLoginPage(): Promise<boolean> {
    return this.getUrl().includes("/login");
  }

  async getPageHeading(): Promise<string> {
    return this.getText(this.pageHeading);
  }

  async clearUsername(): Promise<void> {
    await this.usernameField.clear();
  }

  async clearPassword(): Promise<void> {
    await this.passwordField.clear();
  }

  async login(username: string, password: string): Promise<void> {
    await this.loginWithCredentials(username, password);
  }

  async getFlashMessage(): Promise<string> {
    const error = this.page.locator("#flash");
    return this.getText(error);
  }

  async getUsernameValue(): Promise<string> {
    return this.usernameField.inputValue();
  }
}

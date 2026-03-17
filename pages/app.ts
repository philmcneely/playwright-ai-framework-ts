import { Page } from "@playwright/test";
import { LoginPage } from "./login-page.js";
import { SecurePage } from "./secure-page.js";

export class App {
  readonly loginPage: LoginPage;
  readonly securePage: SecurePage;

  constructor(page: Page) {
    this.loginPage = new LoginPage(page);
    this.securePage = new SecurePage(page);
  }
}

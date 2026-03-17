import { test, expect } from "../../fixtures/index.js";
import { INVALID_USERS, EXPECTED_MESSAGES } from "../../data/test-data.js";

test.describe("Login Tests", () => {
  test("valid login @smoke", async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.loginWithDemoUser();
    expect(await app.securePage.isOnSecurePage()).toBeTruthy();
    const flash = await app.securePage.getFlashMessageText();
    expect(flash).toContain("You logged into a secure area!");
  });

  test("invalid username @smoke", async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.login(
      INVALID_USERS.invalid_username.username,
      INVALID_USERS.invalid_username.password,
    );
    expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
    const flash = await app.loginPage.getFlashMessage();
    expect(flash).toContain(EXPECTED_MESSAGES.invalid_username);
  });

  test("invalid password @smoke", async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.login(
      INVALID_USERS.invalid_password.username,
      INVALID_USERS.invalid_password.password,
    );
    expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
    const flash = await app.loginPage.getFlashMessage();
    expect(flash).toContain(EXPECTED_MESSAGES.invalid_password);
  });

  test("empty credentials", async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.login("", "");
    expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
  });

  test("logout functionality @smoke", async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.loginWithDemoUser();
    expect(await app.securePage.isOnSecurePage()).toBeTruthy();
    await app.securePage.logout();
    expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
    const flash = await app.loginPage.getFlashMessage();
    expect(flash).toContain("You logged out of the secure area!");
  });

  test("form field validation", async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.enterUsername("test_user");
    const val = await app.loginPage.getUsernameValue();
    expect(val).toBe("test_user");
    await app.loginPage.clearUsername();
    await app.loginPage.clearPassword();
    const cleared = await app.loginPage.getUsernameValue();
    expect(cleared).toBe("");
  });

  test("AI healing trigger @ai-healing", async ({ app }) => {
    test.skip(
      process.env.AI_HEALING_ENABLED !== "true",
      "AI healing not enabled",
    );
    await app.loginPage.navigate();
    await app.loginPage.enterUsername("tomsmith");
    await app.loginPage.enterPasswordX("SuperSecretPassword!");
    await app.loginPage.clickLogin();
  });
});

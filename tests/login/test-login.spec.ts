import { test, expect } from "../../fixtures/index.js";
import { INVALID_USERS, EXPECTED_MESSAGES } from "../../data/test-data.js";

test.describe("Login Tests", { tag: ["@login", "@regression"] }, () => {
  test("valid login", { tag: ["@smoke", "@p0", "@positive"] }, async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.loginWithDemoUser();
    expect(await app.securePage.isOnSecurePage()).toBeTruthy();
    const flash = await app.securePage.getFlashMessageText();
    expect(flash).toContain("You logged into a secure area!");
  });

  test("invalid username", { tag: ["@smoke", "@p1", "@negative"] }, async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.login(
      INVALID_USERS.invalid_username.username,
      INVALID_USERS.invalid_username.password,
    );
    expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
    const flash = await app.loginPage.getFlashMessage();
    expect(flash).toContain(EXPECTED_MESSAGES.invalid_username);
  });

  test("invalid password", { tag: ["@smoke", "@p1", "@negative"] }, async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.login(
      INVALID_USERS.invalid_password.username,
      INVALID_USERS.invalid_password.password,
    );
    expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
    const flash = await app.loginPage.getFlashMessage();
    expect(flash).toContain(EXPECTED_MESSAGES.invalid_password);
  });

  test("empty credentials", { tag: ["@p2", "@boundary"] }, async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.login("", "");
    expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
  });

  test("logout functionality", { tag: ["@smoke", "@p1", "@positive"] }, async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.loginWithDemoUser();
    expect(await app.securePage.isOnSecurePage()).toBeTruthy();
    await app.securePage.logout();
    expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
    const flash = await app.loginPage.getFlashMessage();
    expect(flash).toContain("You logged out of the secure area!");
  });

  test("form field validation", { tag: ["@p2", "@negative"] }, async ({ app }) => {
    await app.loginPage.navigate();
    await app.loginPage.enterUsername("test_user");
    const val = await app.loginPage.getUsernameValue();
    expect(val).toBe("test_user");
    await app.loginPage.clearUsername();
    await app.loginPage.clearPassword();
    const cleared = await app.loginPage.getUsernameValue();
    expect(cleared).toBe("");
  });

});

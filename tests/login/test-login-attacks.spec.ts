import { test, expect } from "../../fixtures/index.js";
import {
  SQL_INJECTION_PAYLOADS,
  XSS_PAYLOADS,
  COMMAND_INJECTION_PAYLOADS,
  PATH_TRAVERSAL_PAYLOADS,
} from "../../data/test-data.js";

test.describe("Security Attack Tests @security", () => {
  test.describe("SQL Injection", () => {
    for (const [index, payload] of SQL_INJECTION_PAYLOADS.entries()) {
      test(`SQL injection in username: payload ${index}`, async ({ app }) => {
        await app.loginPage.navigate();
        await app.loginPage.login(payload, "password");
        expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
        await app.loginPage.clearUsername();
        await app.loginPage.clearPassword();
      });
    }

    for (const [index, payload] of SQL_INJECTION_PAYLOADS.entries()) {
      test(`SQL injection in password: payload ${index}`, async ({ app }) => {
        await app.loginPage.navigate();
        await app.loginPage.login("admin", payload);
        expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
      });
    }
  });

  test.describe("XSS Attacks", () => {
    for (const [index, payload] of XSS_PAYLOADS.entries()) {
      test(`XSS in username: payload ${index}`, async ({ app }) => {
        await app.loginPage.navigate();
        await app.loginPage.login(payload, "password");
        expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
      });
    }
  });

  test.describe("Command Injection", () => {
    for (const [index, payload] of COMMAND_INJECTION_PAYLOADS.entries()) {
      test(`Command injection: payload ${index}`, async ({ app }) => {
        await app.loginPage.navigate();
        await app.loginPage.login(payload, "password");
        expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
      });
    }
  });

  test.describe("Path Traversal", () => {
    for (const [index, payload] of PATH_TRAVERSAL_PAYLOADS.entries()) {
      test(`Path traversal: payload ${index}`, async ({ app }) => {
        await app.loginPage.navigate();
        await app.loginPage.login(payload, "password");
        expect(await app.loginPage.isOnLoginPage()).toBeTruthy();
      });
    }
  });
});

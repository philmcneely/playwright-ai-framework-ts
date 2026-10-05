/**
 * Unit tests for the heal CLI's validation of untrusted model output.
 *
 * @tags @unit
 */
import { test, expect } from "../../fixtures/index.js";
import { validReplacement } from "../../scripts/heal-validate.mjs";

const R = "this.page";

test.describe("validReplacement", { tag: ["@unit", "@security", "@regression"] }, () => {
  const ok = [
    `this.page.getByRole('button', { name: 'Login' })`,
    `this.page.getByRole("button", { name: /log ?in/i, exact: true })`,
    `this.page.getByLabel('Username')`,
    `this.page.getByTestId('user; name')`,
    `this.page.locator('#flash')`,
  ];
  for (const expr of ok) {
    test(`accepts ${expr}`, () => {
      expect(validReplacement(expr, R)).toBe(true);
    });
  }

  const bad = [
    `this.page.locator('#a'); process.exit(1)`,
    `(() => { require('fs') })()`,
    `this.page.locator('#a').click()`,
    `this.page.locator('#a'), process.exit(1)`,
    "this.page.locator(`${process.env.SECRET}`)",
    `this.page.locator(String(process.exit(1)))`,
    `this.page.getByRole('button', { name: await x })`,
    `other.page.locator('#a')`,
    `page.locator('#a')`,
    `this.page.evaluate('1')`,
    `this.page.locator('#a')\nprocess.exit(1)`,
    ``,
  ];
  for (const expr of bad) {
    test(`rejects ${JSON.stringify(expr)}`, () => {
      expect(validReplacement(expr, R)).toBe(false);
    });
  }
});

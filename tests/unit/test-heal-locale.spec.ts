/**
 * Unit tests: utils/heal-locale.ts - the byLanguage helper the heal service's language-branch code calls.
 *
 * Real pages, real clicks: byLanguage returns one real Playwright Locator built with no page read, so it is used the way any
 * locator is (an action, expect().toHaveText(), a variable, a getter). It must pick the branch of <html lang>, fall back to the
 * first branch for any other language, and stay unique when both copies exist on the page.
 *
 * @tags @unit
 */
import { test, expect } from "@playwright/test";
import { byLanguage, pageLanguage, subtag } from "../../utils/heal-locale.js";

const PAGE = (lang: string, both = false) => `<!doctype html><html lang="${lang}"><body>
  <label for="u">Username</label>${both ? '<label for="u2">Nom</label>' : ""}
  <input id="u" aria-label="Username"><input id="u2" aria-label="Nom">
  <button id="go" onclick="document.getElementById('out').textContent = this.dataset.said">${lang.startsWith("fr") ? "Valider" : "Submit"}</button>
  <input type="checkbox" id="c" aria-label="${lang.startsWith("fr") ? "Recevoir" : "Receive"}">
  <p id="out"></p>
  <p id="en-only">Hello</p>${both ? '<p id="fr-only">Bonjour</p>' : ""}
  ${both ? '<button id="go-en">Submit</button><button id="go-fr">Valider</button>' : ""}
</body></html>`;

for (const [lang, expected] of [["en", "Submit"], ["fr", "Valider"], ["fr-CA", "Valider"], ["de", "Submit"], ["", "Submit"]] as const) {
  test.describe(`on a page with lang="${lang}"`, { tag: ["@unit", "@regression"] }, () => {
    test.beforeEach(async ({ page }) => {
      await page.setContent(PAGE(lang));
    });

    test("it is a real Locator that clicks the branch of the page language", async ({ page }) => {
      const button = byLanguage(page, { en: page.getByRole("button", { name: "Submit" }), fr: page.getByRole("button", { name: "Valider" }) });
      expect(typeof (button as unknown as { then?: unknown }).then).toBe("undefined"); // not a promise or a thenable
      await expect(button).toHaveText(expected);
      await button.evaluate((el, said) => ((el as HTMLElement).dataset.said = said), expected);
      await button.click();
      await expect(page.locator("#out")).toHaveText(expected);
    });

    test("fill, check and expect().toHaveText go through it", async ({ page }) => {
      const field = byLanguage(page, { en: page.getByLabel("Username"), fr: page.getByLabel("Username") });
      await field.fill("jane");
      await expect(field).toHaveValue("jane");
      const box = byLanguage(page, { en: page.getByLabel("Receive"), fr: page.getByLabel("Recevoir") });
      await box.check();
      await expect(box).toBeChecked();
      await expect(byLanguage(page, { en: page.locator("#en-only"), fr: page.locator("#en-only") })).toHaveText("Hello");
    });

    test("it works as a variable, in a chain and without await", async ({ page }) => {
      const b = byLanguage(page, { en: page.getByRole("button"), fr: page.getByRole("button") });
      expect(await b.count()).toBe(1);
      expect(await b.first().textContent()).toBe(expected);
      expect(await byLanguage(page, { en: page.locator("button"), fr: page.locator("button") }).filter({ hasText: expected }).count()).toBe(1);
    });
  });
}

test.describe("both copies on the page", { tag: ["@unit", "@regression"] }, () => {
  for (const [lang, id] of [["en", "go-en"], ["fr", "go-fr"], ["de", "go-en"]] as const) {
    test(`the html:lang scope keeps the result unique: lang="${lang}"`, async ({ page }) => {
      await page.setContent(PAGE(lang, true));
      const both = byLanguage(page, { en: page.getByRole("button", { name: "Submit", exact: true }).and(page.locator("#go-en")), fr: page.locator("#go-fr") });
      await expect(both).toHaveCount(1); // strict mode would throw on 2
      await expect(both).toHaveAttribute("id", id);
      const text = byLanguage(page, { en: page.locator("#en-only"), fr: page.locator("#fr-only") });
      await expect(text).toHaveText(lang === "fr" ? "Bonjour" : "Hello");
    });
  }

  test("three languages: the first takes every language not listed", async ({ page }) => {
    const pick = async (lang: string) => {
      await page.setContent(`<html lang="${lang}"><body><p id="en">E</p><p id="fr">F</p><p id="de">D</p></body></html>`);
      return byLanguage(page, { en: page.locator("#en"), fr: page.locator("#fr"), de: page.locator("#de") }).getAttribute("id");
    };
    expect(await pick("fr")).toBe("fr");
    expect(await pick("de-AT")).toBe("de");
    expect(await pick("en")).toBe("en");
    expect(await pick("ja")).toBe("en");
  });
});

test.describe("inputs", { tag: ["@unit", "@regression"] }, () => {
  test("a frame is searched in its own document", async ({ page }) => {
    await page.setContent('<html lang="en"><body><iframe id="f" srcdoc="<html lang=fr><body><p id=p>Bonjour</p><p id=q>Hello</p></body></html>"></iframe></body></html>');
    const frame = page.frames().find((f) => f !== page.mainFrame())!;
    await frame.waitForSelector("#p");
    await expect(byLanguage(frame, { en: frame.locator("#q"), fr: frame.locator("#p") })).toHaveText("Bonjour");
  });

  test("a single branch is returned as it is, no branches or a bad key is an error", async ({ page }) => {
    const only = page.locator("body");
    expect(byLanguage(page, { en: only })).toBe(only);
    expect(() => byLanguage(page, {})).toThrow(/at least one branch/);
    for (const key of ["EN", "english", "e", "fr'] , html", "__proto__"]) expect(() => byLanguage(page, { en: only, [key]: only })).toThrow(/two or three lower case/);
  });

  test("the language signals", () => {
    for (const [value, expected] of [["fr-CA", "fr"], ["EN_us", "en"], ["de, en;q=0.8", "de"], ["", ""], [null, ""], ["x", ""], ["english", ""]] as const) {
      expect(subtag(value)).toBe(expected);
    }
    expect(pageLanguage("fr", "en", "de")).toBe("fr");
    expect(pageLanguage("", "en-GB", "de")).toBe("en");
    expect(pageLanguage(null, null, "de-AT")).toBe("de");
    expect(pageLanguage("", "", "")).toBe("");
  });
});

/**
 * Unit tests: utils/heal-locale.ts - the byLanguage helper the heal service's language-branch code calls.
 *
 * A fake page answers the language signals, and fake locators record which branch was used, so no browser is needed. The helper
 * returns a lazy locator: `await byLanguage(...)` gives the Locator, and `await byLanguage(...).click()` (the shape the service's
 * `await byLanguage(...)` takes once it replaces a locator that sits in front of `.click()`) runs the chosen branch.
 *
 * @tags @unit
 */
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { byLanguage, pageLanguage, subtag, trackLanguage } from "../../utils/heal-locale.js";

/** A locator that records the calls it receives; narrowing methods return another recording locator. */
class FakeLocator {
  calls: string[] = [];
  constructor(public name: string, calls?: string[]) {
    if (calls) this.calls = calls;
  }
  async click() {
    this.calls.push(`${this.name}.click`);
    return "clicked";
  }
  async fill(value: string) {
    this.calls.push(`${this.name}.fill(${value})`);
  }
  first() {
    return new FakeLocator(`${this.name}.first`, this.calls);
  }
  getByText(text: string) {
    return new FakeLocator(`${this.name}.getByText(${text})`, this.calls);
  }
}

class FakePage {
  asked = 0;
  handlers: Record<string, (arg: unknown) => void> = {};
  constructor(private lang = "", private locale = "en-US", private fail = false) {}
  async evaluate() {
    this.asked += 1;
    if (this.fail) throw new Error("Execution context was destroyed");
    return [this.lang, this.locale];
  }
  on(name: string, handler: (arg: unknown) => void) {
    this.handlers[name] = handler;
  }
  mainFrame() {
    return "main";
  }
}

const EN = new FakeLocator("en");
const FR = new FakeLocator("fr");
const BRANCHES = { en: EN as unknown as Locator, fr: FR as unknown as Locator };
const asPage = (p: FakePage) => p as unknown as Page;

test.describe("byLanguage", { tag: ["@unit", "@regression"] }, () => {
  test("returns the branch of the page language", async () => {
    expect(await byLanguage(asPage(new FakePage("fr-CA")), BRANCHES)).toBe(FR);
    expect(await byLanguage(asPage(new FakePage("en")), BRANCHES)).toBe(EN);
  });

  test("another language gets the first entry, the original copy", async () => {
    expect(await byLanguage(asPage(new FakePage("de")), BRANCHES)).toBe(EN);
    expect(await byLanguage(asPage(new FakePage("de")), { fr: FR as unknown as Locator, en: EN as unknown as Locator })).toBe(FR);
  });

  test("html lang wins, then the browser locale", async () => {
    expect(await byLanguage(asPage(new FakePage("fr", "en-US")), BRANCHES)).toBe(FR);
    expect(await byLanguage(asPage(new FakePage("", "fr-FR")), BRANCHES)).toBe(FR);
  });

  test("a page that raises gets the first entry, and one that is not a page too", async () => {
    expect(await byLanguage(asPage(new FakePage("fr", "en", true)), BRANCHES)).toBe(EN);
    expect(await byLanguage({} as Page, BRANCHES)).toBe(EN);
  });

  test("no branches is an error", () => {
    expect(() => byLanguage(asPage(new FakePage()), {})).toThrow(/at least one branch/);
  });

  test("the language is read when the result is first used, once", async () => {
    const page = new FakePage("fr");
    const lazy = byLanguage(asPage(page), BRANCHES);
    expect(page.asked).toBe(0);
    await lazy;
    await lazy;
    expect(page.asked).toBe(1);
  });

  test("an action called on the result runs on the chosen branch (await await byLanguage(...).click())", async () => {
    const page = new FakePage("fr");
    FR.calls.length = 0;
    expect(await await byLanguage(asPage(page), BRANCHES).click()).toBe("clicked");
    expect(FR.calls).toEqual(["fr.click"]);
    await byLanguage(asPage(page), BRANCHES).fill("Jane");
    expect(FR.calls).toEqual(["fr.click", "fr.fill(Jane)"]);
  });

  test("narrowing methods stay lazy and still use the chosen branch", async () => {
    const page = new FakePage("fr");
    FR.calls.length = 0;
    await byLanguage(asPage(page), BRANCHES).first().getByText("x").click();
    expect(FR.calls).toEqual(["fr.first.getByText(x).click"]);
    const narrowed = byLanguage(asPage(page), BRANCHES).first();
    expect(((await narrowed) as unknown as FakeLocator).name).toBe("fr.first");
  });

  test("a Locator receiver is asked through its page", async () => {
    const page = new FakePage("fr");
    const receiver = { page: () => page } as unknown as Locator;
    expect(await byLanguage(receiver, BRANCHES)).toBe(FR);
  });
});

test.describe("language signals", { tag: ["@unit", "@regression"] }, () => {
  const cases: Array<[string | null | undefined, string]> = [
    ["fr-CA", "fr"], ["EN_us", "en"], ["de, en;q=0.8", "de"], ["", ""], [null, ""], ["x", ""], ["english", ""], ["zh-Hans-CN", "zh"],
  ];
  for (const [value, expected] of cases) {
    test(`subtag(${JSON.stringify(value)}) is ${JSON.stringify(expected)}`, () => {
      expect(subtag(value)).toBe(expected);
    });
  }

  test("priority is html lang, then locale, then Content-Language", () => {
    expect(pageLanguage("fr", "en", "de")).toBe("fr");
    expect(pageLanguage("", "en-GB", "de")).toBe("en");
    expect(pageLanguage(null, null, "de-AT")).toBe("de");
    expect(pageLanguage("", "", "")).toBe("");
  });

  test("the Content-Language header of a main-frame load is remembered and used", async () => {
    const page = new FakePage("", "");
    trackLanguage(asPage(page));
    expect(Object.keys(page.handlers)).toEqual(["response"]);
    const response = (nav: boolean, frame: string, header?: string) => ({
      request: () => ({ isNavigationRequest: () => nav }), frame: () => frame, headers: () => (header ? { "content-language": header } : {}),
    });
    page.handlers.response(response(true, "other", "de")); // a subframe
    page.handlers.response(response(false, "main", "de")); // not a navigation
    expect(await byLanguage(asPage(page), BRANCHES)).toBe(EN);
    page.handlers.response(response(true, "main", "fr"));
    expect(await byLanguage(asPage(page), BRANCHES)).toBe(FR);
  });

  test("a page without events is left alone", () => {
    expect(() => trackLanguage({} as Page)).not.toThrow();
  });
});

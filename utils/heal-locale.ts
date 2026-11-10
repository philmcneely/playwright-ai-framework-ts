/**
 * Language branch helper (byLanguage) for healed copy-based locators.
 *
 * A locator built from page copy (role + name, label, placeholder, text) only works in the language the copy is written in.
 * When the heal service sees that the page now renders in another language than the passing run, it keeps both: it writes
 * code that picks a locator by the page's language, and that code calls this helper:
 *
 *   byLanguage(this.page, { en: this.page.getByLabel('Username'), fr: this.page.getByLabel("Nom d'utilisateur") })
 *
 * The result is a REAL Playwright Locator, built at once with no page read, so it works in any position: `await
 * byLanguage(...).click()`, `expect(byLanguage(...)).toHaveText('x')`, a getter, a field, a variable. It is built from the page
 * language that CSS already knows: each branch is scoped under `html:lang(<key>)`, and the FIRST branch (the original copy) is
 * scoped under every language not listed, so a language nobody healed for behaves exactly as it did before the heal.
 *
 *   page.locator('html:lang(fr)').locator(frBranch).or(page.locator('html:not(:lang(fr))').locator(enBranch))
 *
 * At most one scope matches a page, so the result is as unique as the branch that applies. `:lang()` follows `<html lang>`
 * (and a Content-Language meta tag), and a regional tag matches its language (`fr-CA` is `fr`). Copy is never translated.
 *
 * Features:
 *   - byLanguage(receiver, branches): one Locator choosing the branch of the page's language, else the first
 *   - pageLanguage(htmlLang, browserLocale, contentLanguage), subtag(value): the plain language subtag from the signals
 *   - Keys must be two or three lower case letters (they are written into a selector); anything else throws
 *
 * Environment Variables:
 *   None.
 */
import type { Frame, Locator, Page } from "@playwright/test";

const SUBTAG = /^[A-Za-z]{2,3}$/;
const KEY = /^[a-z]{2,3}$/;

/** The plain primary language subtag of `value` ("fr-CA" -> "fr"), lower case; "" when it is not one. */
export function subtag(value: string | null | undefined): string {
  const first = String(value ?? "")
    .trim()
    .replaceAll("_", "-")
    .split("-")[0]
    .split(",")[0]
    .split(";")[0]
    .trim();
  return SUBTAG.test(first) ? first.toLowerCase() : "";
}

/** The language subtag from <html lang>, then the browser locale, then Content-Language ("" when none is usable). */
export function pageLanguage(
  htmlLang?: string | null,
  browserLocale?: string | null,
  contentLanguage?: string | null,
): string {
  for (const value of [htmlLang, browserLocale, contentLanguage]) {
    const found = subtag(value);
    if (found) return found;
  }
  return "";
}

type Receiver = Page | Frame | Locator;

/** Where `html` is searched: the page or frame the branches belong to. */
function scopeOf(receiver: Receiver): Page | Frame {
  // a Page and a Frame are searched as they are; a Locator is asked for its page
  return "mainFrame" in receiver || "childFrames" in receiver ? (receiver as Page | Frame) : (receiver as Locator).page();
}

/**
 * The entry of `branches` for the page's language, else the first entry (the original copy), as one real Locator.
 */
export function byLanguage(receiver: Receiver, branches: Record<string, Locator>): Locator {
  const entries = Object.entries(branches ?? {});
  if (!entries.length) throw new Error("byLanguage needs at least one branch");
  for (const [key] of entries) if (!KEY.test(key)) throw new Error(`byLanguage keys are two or three lower case letters, not ${JSON.stringify(key)}`);
  const [[, first], ...rest] = entries;
  if (!rest.length) return first;
  const scope = scopeOf(receiver);
  const listed = entries.map(([key]) => `:lang(${key})`).slice(1).join(", ");
  let chosen = scope.locator(`html:not(${listed})`).locator(first);
  for (const [key, branch] of rest) chosen = chosen.or(scope.locator(`html:lang(${key})`).locator(branch));
  return chosen;
}

/**
 * Language branch helper (byLanguage) for healed copy-based locators.
 *
 * A locator built from page copy (role + name, label, placeholder, text) only works in the language the copy is written in.
 * When the heal service sees that the page now renders in another language than the passing run, it keeps both: it writes
 * code that picks a locator by the page's language, and that code calls this helper:
 *
 *   await byLanguage(this.page, { en: this.page.getByLabel('Username'), fr: this.page.getByLabel("Nom d'utilisateur") })
 *
 * The helper returns the entry for the page's language, and the FIRST entry (the original copy) for any other language, so
 * a run in a language nobody healed for behaves exactly as it did before the heal. Copy is never translated.
 *
 * The page language is read from <html lang>, then the browser locale, then the Content-Language header of the page load
 * (recorded by trackLanguage), never from words on the page.
 *
 * The result works in both places the service's code can land. `await byLanguage(...)` gives the Locator, and the result can
 * also be used directly as a Locator (`await byLanguage(...).click()`, `byLanguage(...).first()`): it is a lazy locator that
 * reads the page language when a method is first called and forwards the call to the chosen branch. That matters because
 * the service writes `await byLanguage(...)` in place of the locator expression, which sits in front of `.click()` in the
 * test, so `await await byLanguage(...).click()` must run.
 *
 * Features:
 *   - byLanguage(receiver, branches): the locator of the page's language, else the first one
 *   - pageLanguage(htmlLang, browserLocale, contentLanguage): the plain language subtag from the three signals, in order
 *   - trackLanguage(page): remembers the Content-Language header of the page's main-frame loads
 *   - Never throws on a page that cannot be asked: the first entry is used instead
 *
 * Environment Variables:
 *   None.
 */
import type { Frame, Locator, Page } from "@playwright/test";

const SUBTAG = /^[A-Za-z]{2,3}$/;
const SIGNALS = "() => [document.documentElement.lang || '', navigator.language || '']";
const headers = new WeakMap<object, string>();

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

/** Remember the Content-Language header of each main-frame load of `page`. Safe to call on any page. */
export function trackLanguage(page: Page): void {
  try {
    page.on("response", (response) => {
      try {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          headers.set(page, response.headers()["content-language"] ?? "");
        }
      } catch {
        /* a page that is closing */
      }
    });
  } catch {
    /* not a page we can listen to */
  }
}

type Receiver = Page | Frame | Locator;

function pageOf(receiver: Receiver): Page {
  const owner = receiver as unknown as { page?: () => Page };
  return typeof owner.page === "function" ? owner.page() : (receiver as Page);
}

/** The receiver's language, "" when it cannot be asked (a page that is navigating or closed). */
async function currentLanguage(receiver: Receiver): Promise<string> {
  try {
    const page = pageOf(receiver);
    const [htmlLang, locale] = (await page.evaluate(SIGNALS)) as [string, string];
    return pageLanguage(htmlLang, locale, headers.get(page));
  } catch {
    return "";
  }
}

// Methods that return another locator at once: on a lazy locator they stay lazy. Every other method is an action or a
// read, which returns a promise, so the lazy locator resolves its branch first and then forwards the call.
const LOCATOR_METHODS = new Set([
  "first", "last", "nth", "locator", "getByRole", "getByLabel", "getByText", "getByPlaceholder", "getByAltText",
  "getByTitle", "getByTestId", "filter", "and", "or", "describe", "frameLocator",
]);

export type LazyLocator = Locator & PromiseLike<Locator>;

function lazy(resolve: () => Promise<Locator>): LazyLocator {
  let pending: Promise<Locator> | undefined;
  const once = () => (pending ??= resolve());
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return (ok?: (v: Locator) => unknown, fail?: (e: unknown) => unknown) => once().then(ok, fail);
      if (typeof prop === "symbol") return undefined;
      const call = (...args: unknown[]) =>
        once().then((locator) => (locator as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args));
      if (LOCATOR_METHODS.has(prop)) {
        return (...args: unknown[]) => lazy(() => call(...args) as Promise<Locator>);
      }
      return call;
    },
  }) as unknown as LazyLocator;
}

/**
 * The entry of `branches` for the page's language, else the first entry (the original copy). The page language is read when
 * the result is first used, so it reflects the page the test is on at that moment.
 */
export function byLanguage(receiver: Receiver, branches: Record<string, Locator>): LazyLocator {
  const entries = Object.entries(branches ?? {});
  if (!entries.length) throw new Error("byLanguage needs at least one branch");
  return lazy(async () => {
    const wanted = await currentLanguage(receiver);
    return (wanted && Object.hasOwn(branches, wanted) ? branches[wanted] : entries[0][1]) as Locator;
  });
}

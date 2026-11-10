/**
 * Heal support fixture (auto): fingerprints and the failing route.
 *
 * Wired into fixtures/index.ts as an auto fixture, so every test using the framework's `test` gets it. It does two small things
 * for the heal service client (scripts/heal.mjs):
 *   - with HEAL_FINGERPRINTS=on it records the fingerprint of each locator a clean green test acts on into
 *     `.heal/fingerprints.json` (utils/heal-recorder.ts), the same file format the Python client writes. Nothing is recorded
 *     for a test that failed, was retried, is flaky or ran inside a heal (HEAL_RUN set)
 *   - when a test fails it attaches the PATH of the page it was on (`heal-page-url`, text/plain, no query or fragment), so the
 *     heal client can reopen the failing route
 *   - when a test fails during a heal's own run (HEAL_CAPTURE=1, set by scripts/heal.mjs), it also attaches the page as the test
 *     left it (`heal-page-capture`): the probe listing and the redacted aria snapshot, so the heal sees what the test had
 *     opened (a panel, a tab, a dialog) and not a freshly reopened route. Never a screenshot, HTML or an input value, and never
 *     outside a heal run, so ordinary reports carry none of it
 *
 * Environment Variables:
 *   HEAL_FINGERPRINTS: "on" to record fingerprints (default off); see utils/heal-recorder.ts for the rest
 *   HEAL_CAPTURE: "1" (with HEAL_RUN=1) to attach the failing page's capture; the heal client sets both for its own runs only
 */
import type { Page, TestInfo } from "@playwright/test";
import { HEAL_CAPTURE_ATTACHMENT, capturePage } from "../scripts/heal-client.mjs";
import { pagePath } from "../scripts/heal-fingerprints.mjs";
import { outcomeOf, startRecording, stopRecording } from "../utils/heal-recorder.js";

export const HEAL_PAGE_ATTACHMENT = "heal-page-url";

/** Only a heal's own runs capture (scripts/heal.mjs sets both): HEAL_CAPTURE exported by a user or a CI job alone does not put
 * captures into ordinary reports. */
export function captureWanted(env: Record<string, string | undefined>): boolean {
  return env.HEAL_RUN === "1" && env.HEAL_CAPTURE === "1";
}

export async function healSupport(
  { page }: { page: Page },
  use: () => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const recorder = startRecording(page);
  await use();
  stopRecording();
  if (testInfo.status !== testInfo.expectedStatus) {
    try {
      await testInfo.attach(HEAL_PAGE_ATTACHMENT, { body: pagePath(page.url()), contentType: "text/plain" });
    } catch {
      /* a page that is already closed */
    }
    if (captureWanted(process.env)) {
      try {
        const capture = await capturePage(page);
        await testInfo.attach(HEAL_CAPTURE_ATTACHMENT, { body: JSON.stringify(capture), contentType: "application/json" });
      } catch {
        /* a page that is already closed, or one the probe could not read: the heal reopens the route as before */
      }
    }
  }
  if (recorder) await recorder.finish(outcomeOf(testInfo));
}

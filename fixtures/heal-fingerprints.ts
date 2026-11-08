/**
 * Heal support fixture (auto): fingerprints and the failing route.
 *
 * Wired into fixtures/index.ts as an auto fixture, so every test using the framework's `test` gets it. It does two small things
 * for the heal service client (scripts/heal.mjs):
 *   - with HEAL_FINGERPRINTS=on it records the fingerprint of each locator a clean green test acts on into
 *     `.heal/fingerprints.json` (utils/heal-recorder.ts), the same file format the Python client writes. Nothing is recorded
 *     for a test that failed, was retried, is flaky or ran inside a heal (HEAL_RUN set)
 *   - when a test fails it attaches the PATH of the page it was on (`heal-page-url`, text/plain, no query or fragment), so the
 *     heal client can reopen the failing route. Nothing else about the page is attached
 *
 * Environment Variables:
 *   HEAL_FINGERPRINTS: "on" to record fingerprints (default off); see utils/heal-recorder.ts for the rest
 */
import type { Page, TestInfo } from "@playwright/test";
import { pagePath } from "../scripts/heal-fingerprints.mjs";
import { outcomeOf, startRecording, stopRecording } from "../utils/heal-recorder.js";

export const HEAL_PAGE_ATTACHMENT = "heal-page-url";

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
  }
  if (recorder) await recorder.finish(outcomeOf(testInfo));
}

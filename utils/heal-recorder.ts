/**
 * Heal fingerprint recorder: what each locator hit on the last green run.
 *
 * The heal service can settle many heals with no model call when it knows which element a locator hit the last time its test
 * passed: it looks for that same element on the drifted page (same test id, id, name, role, position). This recorder keeps
 * that knowledge. For every locator a clean green test ACTS ON (click, fill, check, ...) it saves what the page probe sees of
 * the element, its box, its frame, the page path and language into `.heal/fingerprints.json`, keyed by the source line that
 * acted on it. At heal time `scripts/heal.mjs` looks the failing line up and sends the result as `last_pass`, together with the
 * other elements recorded on the same page. The file format is the one the Python client writes (scripts/heal-fingerprints.mjs).
 *
 * It holds attributes, copy and boxes only. Never input values (the probe does not read them), screenshots or HTML. Element
 * copy can hold personal data: set HEAL_FINGERPRINT_COPY=off to store hashes of it instead.
 *
 * Off unless HEAL_FINGERPRINTS=on, and then it costs one small in-page call per distinct locator line per test. With it off,
 * no Playwright class is touched.
 *
 * A fingerprint is written only from a clean green test: it passed, ran once (no retry), is not marked flaky and has not a low
 * stability index, and it is not running inside a heal (HEAL_RUN is set by scripts/heal.mjs). Anything else is dropped.
 *
 * Note for reports: while recording, each acting call goes through the wrapper in this file, so Playwright names this file as
 * the location of a failing action in the report of that run. The heal run (HEAL_RUN set) never installs the wrapper.
 *
 * Features:
 *   - Key = (source file, normalized text of the acting line): the same key at record time and at heal time
 *   - Facts come from the vendored probe (scripts/heal-probe.js), the same script the heal client runs
 *   - The file is written atomically under a lock, merged with what other workers wrote
 *   - Never throws into a test: a recording failure only means no fingerprint for that locator
 *
 * Environment Variables:
 *   HEAL_FINGERPRINTS: "on" to record (default off)
 *   HEAL_FINGERPRINTS_COMMIT, HEAL_FINGERPRINT_COPY, HEAL_DIR, HEAL_SOURCE_ROOTS: see scripts/heal-fingerprints.mjs
 *   HEAL_RUN: set by scripts/heal.mjs while it runs the suite; nothing is recorded then
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  ACTIONS,
  callKey,
  copyMode,
  enabled,
  itemToFingerprint,
  mergeInto,
  normalizeLine,
  pagePath,
  sourceRoots,
  stackFrames,
  type FingerprintEntry,
} from "../scripts/heal-fingerprints.mjs";
import { probeFunction, vendoredProbe } from "../scripts/heal-probe.mjs";
import { DEFAULT_THRESHOLD, getStability } from "./stability-index.js";

const OWN_FILES = ["utils/heal-recorder.ts", "fixtures/heal-fingerprints.ts"];
const INSTALLED = Symbol.for("heal.fingerprints.installed");

/** The name (or id) of the iframe the element sits in, '' for the top document or a frame the page cannot see into. */
const frameName = (e: Element): string => {
  const f = e.ownerDocument.defaultView?.frameElement;
  return f ? f.getAttribute("name") || f.id || "iframe" : "";
};

type Env = Record<string, string | undefined>;
type Probe = { items?: Array<Record<string, unknown>>; page?: { path?: string; lang?: string; browser_lang?: string } };

/** What the end of a test says about whether it was clean green. */
export interface TestOutcome {
  status?: string;
  retry: number;
  tags: string[];
  annotations: Array<{ type: string }>;
  titlePath: string[];
}

export class Recorder {
  readonly pending = new Map<string, FingerprintEntry | null>();
  private readonly roots: string[];
  private readonly probeFn: (only?: unknown) => unknown;

  constructor(
    private readonly root: string = process.cwd(),
    private readonly env: Env = process.env,
    private readonly probe: string = vendoredProbe(),
  ) {
    this.roots = sourceRoots(env);
    this.probeFn = probeFunction(probe);
  }

  /** The innermost frame of `stack` under the source roots that is not this recorder, with its line text on disk. */
  callSite(stack: string): { file: string; text: string } | null {
    for (const frame of stackFrames(stack, this.root, this.roots)) {
      if (OWN_FILES.includes(frame.file)) continue;
      try {
        const lines = readFileSync(path.join(this.root, frame.file), "utf8").split(/\r\n|\r|\n/);
        return { file: frame.file, text: lines[frame.line - 1] ?? "" };
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Record what `locator` (about to be acted on) hits, once per acting line per test. Never throws. */
  async record(locator: Locator, stack: string): Promise<void> {
    let key: string | null = null;
    try {
      const site = this.callSite(stack);
      if (!site) return;
      key = callKey(site.file, site.text);
      if (this.pending.has(key)) return;
      this.pending.set(key, null); // claim the key first: a second action on this line is skipped
      if ((await locator.count()) !== 1) {
        this.pending.delete(key);
        return;
      }
      const data = (await locator.evaluate(this.probeFn as (e: Element) => unknown, undefined, { timeout: 2000 })) as Probe;
      const items = data.items ?? [];
      if (items.length !== 1) {
        this.pending.delete(key);
        return;
      }
      const frame = await locator.evaluate(frameName, undefined, { timeout: 2000 });
      const meta = data.page ?? {};
      const language = (meta.lang || meta.browser_lang || "").split("-")[0].toLowerCase();
      this.pending.set(key, {
        file: site.file,
        text: normalizeLine(site.text),
        page: pagePath(meta.path || "/"),
        language,
        fingerprint: itemToFingerprint(items[0], frame || "", copyMode(this.env)),
      });
    } catch {
      if (key !== null) this.pending.delete(key);
    }
  }

  /** True when the test that just ended was clean green: passed once, no retry, not flaky, not unstable. */
  clean(outcome: TestOutcome): boolean {
    if (outcome.status !== "passed" || outcome.retry > 0) return false;
    if (outcome.tags.includes("@flaky") || outcome.annotations.some((a) => a.type === "flaky")) return false;
    try {
      return getStability(outcome.titlePath.join(" > ")) >= DEFAULT_THRESHOLD;
    } catch {
      return true;
    }
  }

  /** Write the pending fingerprints when the test was clean green; drop them otherwise. True when written. */
  async finish(outcome: TestOutcome): Promise<boolean> {
    const records: Record<string, FingerprintEntry> = {};
    for (const [key, entry] of this.pending) if (entry) records[key] = entry;
    this.pending.clear();
    if (!this.clean(outcome) || !Object.keys(records).length) return false;
    try {
      return await mergeInto(this.root, records, this.env);
    } catch {
      return false;
    }
  }
}

let current: Recorder | null = null;

/** Wrap the acting methods of Playwright's Locator class once, so each records its element first while a recorder is set. */
export function installRecorder(page: Page): void {
  const proto = Object.getPrototypeOf(page.locator("body")) as Record<PropertyKey, unknown>;
  if (proto[INSTALLED]) return;
  for (const name of ACTIONS) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = async function (this: Locator, ...args: unknown[]) {
      const recorder = current;
      if (recorder) await recorder.record(this, new Error().stack ?? "");
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  proto[INSTALLED] = true;
}

/** Start recording for the test that is running (no-op unless HEAL_FINGERPRINTS=on and not in a heal run). */
export function startRecording(page: Page, env: Env = process.env): Recorder | null {
  if (!enabled(env)) return null;
  try {
    installRecorder(page);
  } catch {
    return null;
  }
  current = new Recorder(process.cwd(), env);
  return current;
}

export function stopRecording(): void {
  current = null;
}

/** The outcome fields `Recorder.clean` reads, taken from Playwright's TestInfo. */
export const outcomeOf = (info: TestInfo): TestOutcome => ({
  status: info.status,
  retry: info.retry,
  tags: info.tags,
  annotations: info.annotations,
  titlePath: info.titlePath,
});

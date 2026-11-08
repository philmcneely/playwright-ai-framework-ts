/**
 * ===============================================================================
 * Heal Probe (the vendored in-page script, read from disk, never from the network)
 * ===============================================================================
 * scripts/heal-probe.js is a byte-identical copy of the heal service's probe: the script that runs in the page and lists the
 * elements a locator could hook on (attributes and visible copy, never typed values). It is vendored so the code that runs
 * inside the page under test is code this repository ships and tests, not code a service sends. Two things pin it: its sha256
 * is checked every time it is read (a file that was edited is refused, never run), and tests/unit/test-heal-probe.spec.ts holds
 * the same hash as the service's copy. Nothing is cached on disk, so a file a service once wrote cannot be run later.
 *
 * The file is found from the repository root (the working directory, as everything else the heal tooling reads is) or beside
 * the script that is running. `import.meta` is not used so the module also loads inside the Playwright test runner.
 *
 * Features:
 *     - vendoredProbe(): the script text, after its sha256 matches PROBE_SHA256
 *     - probeFunction(source): the probe as a function object for page.evaluate / locator.evaluate. Playwright for JavaScript
 *       runs a string as an expression and does NOT call it (the Python client does), so the source is wrapped once here
 *     - sha256(data): the hash used to compare a service's copy with the vendored one
 *
 * Environment Variables:
 *     None.
 *
 * Author: PMAC
 * ===============================================================================
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** sha256 of the service's probe.js this copy was taken from. Update both together (and the unit test). */
export const PROBE_SHA256 = "fca8dd814e18c2a5ff13f875c9c2cce86e2f23466cba15c20135aca25e645459";

/** Hex sha256 of a string (as UTF-8) or a byte buffer. */
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

let cached = null;

/** Where the vendored probe may be: the repository's scripts folder, or the folder of the running script. */
export function probeCandidates() {
  const here = process.argv[1] ? [path.join(path.dirname(path.resolve(process.argv[1])), "heal-probe.js")] : [];
  return [path.resolve("scripts", "heal-probe.js"), ...here];
}

/** The page probe shipped in this repository (a copy of the service's). Throws when it is missing or has been changed. */
export function vendoredProbe() {
  if (cached !== null) return cached;
  for (const file of probeCandidates()) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (sha256(text) !== PROBE_SHA256) throw new Error(`${file} is not the vendored probe (sha256 differs), so it is refused`);
    cached = text;
    return text;
  }
  throw new Error("scripts/heal-probe.js (the vendored page probe) was not found");
}

/**
 * The probe as a function `Playwright` can send to the page: `page.evaluate(fn)` runs it for the whole page and
 * `locator.evaluate(fn)` runs it on that one element (`only`). The function is only compiled here, never called in Node:
 * Playwright serializes it with toString() and runs the text in the page, so a page's CSP does not apply.
 */
export function probeFunction(source) {
  return new Function("only", `return (${source})(only);`);
}

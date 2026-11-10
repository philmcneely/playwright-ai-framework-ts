/**
 * ===============================================================================
 * heal.mjs - out-of-band locator healer (v3, heal-service client)
 * ===============================================================================
 * Runs failing Playwright tests, sends each failure's evidence to a heal service, applies the locator patch the service
 * returns, and re-runs to verify. Heals LOCATORS only - never assertions or test intent. A failure it cannot make pass is
 * reverted and reported for a human (likely an app bug, not drift).
 *
 * The service owns the model calls and the healing rules: it finds the broken call, picks the element, writes the locator by
 * the priority rules (test id > id > name > ... > text), adds language branches and decides healed or needs-human. This script
 * contains no model URL, model name, prompt or reply parsing. What it does (see scripts/heal-client.mjs):
 *     - runs the suite with the JSON reporter and collects the failures
 *     - per failure: reopens the failing route, collects the element inventory with the vendored probe script, and sends it
 *       with the stack files, the language signals, (with HEAL_VISION=auto|on) one masked screenshot and (when recorded) the
 *       last green run's fingerprint
 *     - checks each candidate in the live page (exactly one match, the expected element) before editing anything
 *     - applies a patch only if its hash, path, span and replacement pass the safety checks, then re-runs the exact test and
 *       keeps the edit only if that test ran and passed and the service confirms
 *     - prints every decision with its token usage and a run total, writes heal-summary.json, and with --open-pr commits only
 *       the healed files
 *
 * This is the on-demand half of the overnight heal->PR orchestration: run it in CI/cron after the suite, optionally with
 * --open-pr to raise a single PR with the decisions and the tests it left untouched.
 *
 * Usage:
 *   BASE_URL=... HEAL_SERVICE_URL=http://localhost:8765 [HEAL_SERVICE_TOKEN=...] [HEAL_STORAGE_STATE=auth.json] \
 *     node scripts/heal.mjs [--grep <name>] [--max N] [--open-pr]
 *
 * --open-pr needs git + the gh CLI and a clean worktree, and commits ONLY the files it healed.
 *
 * Environment Variables:
 *     HEAL_SERVICE_URL: the heal service (required)
 *     HEAL_SERVICE_TOKEN: bearer token, when the service needs one
 *     HEAL_STORAGE_STATE: Playwright storage-state file, so the page is opened as a signed-in user (never sent)
 *     HEAL_VISION / HEAL_MASK: off (default) | auto | on, and the selectors to mask in the one screenshot
 *     HEAL_TEST_ID_ATTRIBUTE: the project's test id attribute (default data-testid)
 *     HEAL_SOURCE_ROOTS: comma separated source roots (default pages,tests,utils,fixtures)
 *     HEAL_PROJECT: the Playwright project to run and re-run (default chromium; empty runs the config's default)
 *     HEAL_ARTIFACTS_DIR: where heal-summary.json goes (default test_artifacts)
 *     BASE_URL: the app under test
 *
 * Author: PMAC
 * ===============================================================================
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join, relative, resolve } from "node:path";
import { receiverText } from "./heal-code.mjs";
import {
  HEAL_CAPTURE_ATTACHMENT, HealServiceError, Healer, ServiceClient, parseCapture, runTotal, safeRoute, settingsFromEnv,
} from "./heal-client.mjs";
import { validReplacement } from "./heal-validate.mjs";

export { validReplacement };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const HEAL_PAGE_ATTACHMENT = "heal-page-url";

// ---- running the suite ---------------------------------------------------------------------------------------------------
/** Run the suite (optionally one file and a title filter) with the JSON reporter. HEAL_RUN is set for the child so the
 * fingerprint recorder records nothing during a heal, and HEAL_CAPTURE so a failing test attaches its page as it left it. Returns {code, report}; report is null when none was produced. */
export function runSuite({ grep = null, file = null, env = process.env } = {}) {
  const out = join(mkdtempSync(join(tmpdir(), "heal-")), "report.json");
  const args = ["playwright", "test", "--retries=0", "--reporter=json"];
  const project = env.HEAL_PROJECT ?? "chromium";
  if (project) args.push(`--project=${project}`);
  if (file) args.push(escapeRe(file));
  if (grep) args.push("--grep", grep);
  let code = 0;
  try {
    execFileSync("npx", args, { env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: out, HEAL_RUN: "1", HEAL_CAPTURE: "1" }, stdio: "ignore" });
  } catch (e) {
    code = typeof e.status === "number" ? e.status : 1; // a non-zero exit on failures is expected
  }
  try {
    return { code, report: JSON.parse(readFileSync(out, "utf-8")) };
  } catch {
    return { code, report: null };
  } finally {
    rmSync(dirname(out), { recursive: true, force: true }); // the report holds the failing pages' captures
  }
}

/** The attachment `name` of a JSON-report result as text, or null. */
function attachmentText(result, name) {
  const att = (result?.attachments ?? []).find((a) => a.name === name);
  if (!att) return null;
  try {
    return att.body ? Buffer.from(att.body, "base64").toString("utf-8") : att.path ? readFileSync(att.path, "utf-8") : null;
  } catch {
    return null;
  }
}

/** Every test of the JSON report as {title, file, status, results}, `file` being an absolute path. */
function* specsOf(report) {
  const rootDir = report?.config?.rootDir ?? process.cwd();
  function* walk(suite, file) {
    for (const s of suite.suites ?? []) yield* walk(s, s.file || file);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        yield { title: spec.title, file: resolve(rootDir, spec.file || file || ""), test: t };
      }
    }
  }
  for (const s of report?.suites ?? []) yield* walk(s, s.file);
}

/** Flatten the JSON report into the failing tests: error text, stack text, source location and the page path at the failure. */
export function failuresOf(report, baseUrl = settingsFromEnv().baseUrl) {
  const fails = [];
  for (const { title, file, test: t } of specsOf(report)) {
    const results = t.results ?? [];
    if (results.every((r) => r.status === "passed" || r.status === "skipped")) continue;
    const bad = results.filter((r) => r.status !== "passed" && r.status !== "skipped");
    const last = bad[bad.length - 1];
    const errors = bad.flatMap((r) => r.errors ?? []);
    fails.push({
      title,
      file,
      error: errors.map((e) => e.message ?? "").join("\n").replace(ANSI, ""),
      stack: errors.map((e) => e.stack ?? "").join("\n").replace(ANSI, ""),
      location: errors.find((e) => e.location)?.location ?? null,
      // an attachment is a file a test run wrote: only a same-origin path is accepted, checked here where it is read
      route: safeRoute(attachmentText(last, HEAL_PAGE_ATTACHMENT)?.trim(), baseUrl),
      capture: parseCapture(attachmentText(last, HEAL_CAPTURE_ATTACHMENT), baseUrl), // the page as the failing test left it
    });
  }
  return fails;
}

/** Re-runs the exact target test and says what happened: `passed` is true only if that test ran AND passed AND the run exited
 * cleanly (an empty selection, a missing report or a different test with a similar title is NOT a pass); `failure` is the
 * re-run's own failure as failuresOf builds it, or null when it passed or when no report names the exact test. */
export function verifyRun(failure, runner = runSuite, root = process.cwd()) {
  const { code, report } = runner({ grep: escapeRe(failure.title), file: relative(root, failure.file) });
  if (!report) return { passed: false, failure: null };
  const same = (title, file) => title === failure.title && resolve(file) === resolve(failure.file);
  const ran = [...specsOf(report)].filter((s) => same(s.title, s.file));
  const passed = code === 0 && ran.length > 0 && ran.every((s) => s.test.status === "expected" && (s.test.results ?? []).every((r) => r.status === "passed"));
  return { passed, failure: passed ? null : (failuresOf(report).find((f) => same(f.title, f.file)) ?? null) };
}

/** True only if the exact target test ran AND passed AND the run exited cleanly (see verifyRun). */
export const verifyPassed = (failure, runner = runSuite, root = process.cwd()) => verifyRun(failure, runner, root).passed;

/** True if any tracked file has uncommitted changes. */
export function workingTreeDirty() {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf-8" }).trim().length > 0;
}

// ---- deciding ------------------------------------------------------------------------------------------------------------
// A kept heal can reveal the next broken locator of the same test (the heal's own line passes, the test then stops further on).
// The next failure is healed too, up to this many extra rounds per test.
export const MAX_LATER_ROUNDS = 3;

/** One decision per heal. Failures past `max` are recorded as needs_human, never dropped. A failure a previous heal already
 * fixed (a page object shared by several tests) is confirmed by re-running it, not healed twice. A heal the service kept because
 * the test then failed at a different locator (`later_locator`) is followed by a heal of that next failure, each its own
 * decision; if the chain ends with the test still failing, the last kept heal says so (`still_failing`). */
export async function healFailures(fails, healer, max, verify = verifyPassed) {
  const decisions = [];
  const healed = [];
  for (const f of fails.slice(0, max)) {
    if (healed.length && (await verify(f))) {
      const first = healed[0];
      decisions.push({
        test: f.title, outcome: "healed", file: first.file, from: first.from, to: first.to, files: first.files ?? [], usage: {},
        source: `same fix as ${first.test} (shared locator), re-run passed`,
      });
      continue;
    }
    let current = f;
    let last = null; // the latest heal of this test that was kept while the test still failed
    for (let extra = 0; ; extra++) {
      let healedOne;
      try {
        healedOne = await healer.heal(current);
      } catch (e) {
        if (extra === 0) throw e;
        // a chained round failed outright: the earlier kept heals stay, this round is recorded, the run goes on
        healedOne = { test: current.title, outcome: "needs_human", reason: "chain_error", why: `the next round failed (${e?.name ?? "Error"}): ${String(e?.message ?? e).slice(0, 200)}` };
      }
      const { later_failure: next, ...d } = healedOne;
      decisions.push(d);
      if (d.outcome === "healed") healed.push(d);
      if (last && d.outcome !== "healed") {
        last.still_failing = true;
        last.still_failing_why = `the test still fails later at ${last.later_at ?? "another line"}, and that was not healed (${d.reason ?? d.outcome}: ${d.why ?? "no reason given"})`;
      }
      if (d.outcome !== "healed" || !next) break; // not kept, or kept and the test passed: the chain is over
      last = d;
      if (d.reason !== "later_locator") {
        d.still_failing = true;
        d.still_failing_why = `the test still fails later at ${d.later_at ?? "another line"}`;
        break;
      }
      if (extra >= MAX_LATER_ROUNDS) {
        d.still_failing = true;
        d.still_failing_why = `the test still fails later at ${d.later_at ?? "another line"}; the client stopped after ${MAX_LATER_ROUNDS} more rounds`;
        break;
      }
      current = next;
    }
  }
  for (const f of fails.slice(max)) {
    decisions.push({ test: f.title, outcome: "needs_human", reason: "beyond_max", why: `not attempted: beyond --max ${max}` });
  }
  return decisions;
}

const PLAIN_KEYS = ["test", "outcome", "reason", "why", "heal_id", "rounds", "settled_at", "file", "from", "to", "source", "strategy", "tier_movement", "later_at", "still_failing_why"];

/** A decision cut to known keys holding capped strings, plain numbers or string lists, whatever it was built from. */
function plainDecision(d) {
  const out = {};
  for (const k of PLAIN_KEYS) {
    const v = d?.[k];
    if (typeof v === "string") out[k] = v.slice(0, 500);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (v === null) out[k] = null;
  }
  if (d?.still_failing === true) out.still_failing = true;
  const u = d?.usage && typeof d.usage === "object" ? d.usage : {};
  out.usage = Object.fromEntries(["calls", "input_tokens", "output_tokens", "images"].map((k) => [k, Number.isFinite(Number(u[k])) ? Number(u[k]) : 0]));
  for (const k of ["files", "notes"]) if (Array.isArray(d?.[k])) out[k] = d[k].filter((x) => typeof x === "string").slice(0, 50).map((x) => x.slice(0, 300));
  return out;
}

/** Write heal-summary.json (counts, usage total, every decision) into the test artifacts dir; returns its path. */
export function writeSummary(rawDecisions, started, runId, directory = null) {
  const decisions = rawDecisions.map(plainDecision);
  const dir = resolve(directory ?? process.env.HEAL_ARTIFACTS_DIR ?? "test_artifacts");
  mkdirSync(dir, { recursive: true });
  const counts = Object.fromEntries(["healed", "needs_human", "not_drift"].map((k) => [k, decisions.filter((d) => d.outcome === k).length]));
  const summary = {
    run_id: runId, started, finished: new Date().toISOString(), failures: decisions.length, counts, still_failing: decisions.filter((d) => d.still_failing).length,
    usage: runTotal(decisions), decisions,
  };
  const file = join(dir, "heal-summary.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(summary, null, 2), "utf-8");
  renameSync(`${file}.tmp`, file);
  return file;
}

const tokens = (d) => {
  const u = d.usage ?? {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return `tokens ${n(u.input_tokens)} in / ${n(u.output_tokens)} out, ${n(u.calls)} call(s)`;
};

export function printDecisions(decisions, log = console.log) {
  log("\n[heal] decisions:");
  for (const d of decisions) {
    if (d.outcome === "healed") {
      log(`  [healed] ${oneLine(d.test)}: ${oneLine(d.file)}: ${oneLine(d.from)} -> ${oneLine(d.to)}  (${tokens(d)})`);
      if (d.still_failing) log(`      kept, but the test still fails later: ${oneLine(d.still_failing_why)}`);
    } else {
      log(`  [${oneLine(d.outcome, 20)}]${d.reason ? ` [${oneLine(d.reason, 80)}]` : ""} ${oneLine(d.test)}: ${oneLine(d.why)}  (${tokens(d)})`);
    }
    for (const note of d.notes ?? []) log(`      note: ${oneLine(note)}`);
  }
  const t = runTotal(decisions);
  log(`[heal] run total: ${t.calls} model call(s), ${t.input_tokens} input / ${t.output_tokens} output tokens, ${t.images} image(s)`);
}

// ---- the pull request ----------------------------------------------------------------------------------------------------
const MD_SPECIAL = new Set("\\`*_[]()<>#|!~@&{}");

/** `value` as text on one line: control characters and line breaks become a space, capped (it came from the service). */
export function oneLine(value, limit = 300) {
  const text = [...String(value ?? "")]
    .map((c) => {
      const n = c.codePointAt(0);
      return n < 32 || n === 127 || (n >= 0x80 && n < 0xa0) || c === " " || c === " " ? " " : c;
    })
    .join("")
    .replace(/[\p{Cf}\p{Cs}]/gu, ""); // bidi and other format characters change how a line reads on a terminal or a PR
  return text.split(/\s+/).filter(Boolean).join(" ").slice(0, limit);
}

/** `value` safe to put in a markdown line: one line, and every character that makes a link, an image, HTML, a heading, a
 * mention or emphasis is escaped (a service string cannot add a link or a section to a PR). */
export function mdEscape(value, limit = 300) {
  return [...oneLine(value, limit)]
    .map((c) => (c === "@" ? "&#64;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : MD_SPECIAL.has(c) ? "\\" + c : c))
    .join("");
}

/** `value` as an inline code span whose fence is longer than any backtick run inside it. */
export function mdCode(value, limit = 300) {
  const text = oneLine(value, limit);
  const runs = text.match(/`+/g);
  if (!runs) return `\`${text}\``;
  const fence = "`".repeat(Math.max(...runs.map((r) => r.length)) + 1);
  return `${fence} ${text} ${fence}`;
}

/** One single-line entry per healed test for the commit body (no service text can start a new line or a trailer). */
export const commitLines = (healed) => healed.map((d) => `- ${oneLine(d.test, 200)}: ${oneLine(d.from, 200)} -> ${oneLine(d.to, 200)}`);

/** The PR description. Every string that came from the service or the test run is escaped. */
export function buildPrBody(healed, other) {
  const line = (d) => `- **${mdEscape(d.test)}** -- ${mdCode(d.from)} -> ${mdCode(d.to)} (${mdCode(d.why || d.source)})`;
  const partial = healed.filter((d) => d.still_failing);
  const clean = healed.filter((d) => !d.still_failing);
  let body = "Automated locator healing (out-of-band).\n";
  if (clean.length) body += "\n## Healed (locators only, intent preserved)\n" + clean.map(line).join("\n");
  if (partial.length) {
    // the heal's own line passes, the test then stops somewhere else: a human must look at what is left
    body += "\n\n## Kept, test still fails later (review these)\n" + partial.map((d) => `${line(d)}\n  - ${mdCode(d.still_failing_why)}`).join("\n");
  }
  if (other.length) {
    body += "\n\n## Needs human review (not touched)\n" + other.map((d) => `- **${mdEscape(d.test)}** -- ${mdCode(d.why)}`).join("\n");
  }
  return body;
}

/** Branch, commit ONLY the healed files, push, and open one PR listing the decisions. */
function openPr(healed, other) {
  const branch = `heal/${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
  const files = [...new Set(healed.flatMap((d) => d.files ?? [d.file]))].sort();
  execFileSync("git", ["checkout", "-b", branch]);
  // Stage and commit ONLY the files this run healed, never unrelated work in the caller's tree.
  execFileSync("git", ["add", "--", ...files]);
  execFileSync("git", ["commit", "-qm", `fix(heal): update ${healed.length} drifted locator(s)\n\n` + commitLines(healed).join("\n"), "--", ...files]);
  execFileSync("git", ["push", "-q", "-u", "origin", branch]);
  execFileSync("gh", ["pr", "create", "--base", "main", "--head", branch, "--title",
    `Locator healing -- ${healed.length} fixed, ${other.length} for review`, "--body", buildPrBody(healed, other)], { stdio: "inherit" });
}

// ---- main ----------------------------------------------------------------------------------------------------------------
/** The `--grep`, `--max` and `--open-pr` flags, or {error} naming the first problem. */
export function parseArgs(args) {
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return { value: null };
    const v = args[i + 1];
    return v === undefined || v.startsWith("--") ? { error: `${flag} requires a value` } : { value: v };
  };
  const known = new Set(["--grep", "--max", "--open-pr"]);
  for (const a of args) if (a.startsWith("--") && !known.has(a)) return { error: `unknown flag ${a}` };
  const grep = valueOf("--grep");
  const max = valueOf("--max");
  if (grep.error || max.error) return { error: grep.error ?? max.error };
  const n = max.value === null ? 10 : Number(max.value);
  if (!Number.isInteger(n) || n < 1) return { error: "--max must be a positive integer" };
  return { grep: grep.value, max: n, openPr: args.includes("--open-pr") };
}

const usageError = (msg) => {
  console.error(`[heal] ${msg}\nUsage: node scripts/heal.mjs [--grep <name>] [--max N] [--open-pr]`);
  process.exit(2);
};

export async function main(argv = process.argv.slice(2)) {
  const settings = settingsFromEnv();
  if (!settings.url) {
    console.error("Set HEAL_SERVICE_URL (the heal service, for example http://localhost:8765).");
    process.exit(2);
  }
  const args = parseArgs(argv);
  if (args.error) usageError(args.error);
  if (args.openPr && workingTreeDirty()) {
    usageError("--open-pr requires a clean git worktree (commit or stash your changes first)");
  }
  const started = new Date().toISOString();
  const runId = Math.random().toString(16).slice(2, 14);
  console.log(`[heal] running suite${args.grep ? ` (grep: ${args.grep})` : ""}...`);
  const { report } = runSuite({ grep: args.grep });
  if (!report) {
    console.error("[heal] the suite produced no JSON report - nothing to heal.");
    process.exit(1);
  }
  const fails = failuresOf(report);
  if (fails.length === 0) {
    console.log("[heal] no failures - nothing to heal.");
    return;
  }
  console.log(`[heal] ${fails.length} failing test(s).`);

  const healer = new Healer(new ServiceClient(settings.url, settings.token), settings, (f) => verifyRun(f), {
    runId,
    // the framework's own second check on every locator the service writes (the AST validator is the first)
    secondCheck: (expression, original) => {
      const receiver = receiverText(original);
      return receiver !== null && validReplacement(expression, receiver);
    },
  });
  const decisions = await healFailures(fails, healer, args.max);

  printDecisions(decisions);
  const summary = writeSummary(decisions, started, runId);
  const healed = decisions.filter((d) => d.outcome === "healed");
  const other = decisions.filter((d) => d.outcome !== "healed");
  if (args.openPr && healed.length > 0) openPr(healed, other);
  const partial = healed.filter((d) => d.still_failing).length;
  console.log(`\n[heal] done: ${healed.length} healed${partial ? ` (${partial} kept while the test still fails later)` : ""}, ${other.length} for human review. Summary: ${summary}`);
}

// run only when this file is the script (not when a test imports it); `import.meta` stays out so the Playwright runner can load it
if (path.basename(process.argv[1] ?? "") === "heal.mjs") {
  main().catch((e) => {
    console.error(e instanceof HealServiceError ? e.message : e);
    process.exit(1);
  });
}

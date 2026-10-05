/**
 * heal.mjs — out-of-band locator healer (v2, CLI mode)
 *
 * Runs failing Playwright tests, grounds each failure in the page snapshot
 * Playwright captured AT the failure (error-context), asks a configurable model
 * for a resilient semantic locator, applies it to the one exact call that
 * failed, and re-runs to verify. Heals LOCATORS only — never assertions or test
 * intent. The model's output is untrusted: it must be a single Playwright
 * locator call with literal arguments, or it is rejected. Genuine app bugs are
 * left failing and reported for a human, not "healed".
 *
 * This is the on-demand half of the overnight heal->PR orchestration: run it in
 * CI/cron after the suite, optionally with --open-pr to raise a single PR with
 * the decisions and the tests it left untouched.
 *
 * Model is provider-agnostic via an OpenAI-compatible endpoint:
 *   HEAL_BASE_URL   e.g. https://openrouter.ai/api/v1 | http://localhost:3025/v1
 *   HEAL_MODEL      e.g. qwen3:8b
 *   HEAL_API_KEY    optional (omit for a local server or keyless gateway)
 *
 * Usage:
 *   BASE_URL=... HEAL_BASE_URL=... HEAL_MODEL=... node scripts/heal.mjs [--grep <name>] [--open-pr] [--max N]
 *
 * --open-pr needs git + the gh CLI and a clean worktree, and commits ONLY the
 * files it healed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { validReplacement } from "./heal-validate.mjs";

const args = process.argv.slice(2);
const usageError = (msg) => {
  console.error(`[heal] ${msg}\nUsage: node scripts/heal.mjs [--grep <name>] [--max N] [--open-pr]`);
  process.exit(2);
};
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) usageError(`${flag} requires a value`);
  return v;
};
const KNOWN = new Set(["--grep", "--max", "--open-pr"]);
for (const a of args) if (a.startsWith("--") && !KNOWN.has(a)) usageError(`unknown flag ${a}`);
const GREP = valueOf("--grep");
const OPEN_PR = args.includes("--open-pr");
const MAX = valueOf("--max") === null ? 10 : Number(valueOf("--max"));
if (!Number.isInteger(MAX) || MAX < 1) usageError("--max must be a positive integer");

const HEAL_BASE_URL = process.env.HEAL_BASE_URL;
const HEAL_MODEL = process.env.HEAL_MODEL;
const HEAL_API_KEY = process.env.HEAL_API_KEY || "";
if (!HEAL_BASE_URL || !HEAL_MODEL) {
  console.error("Set HEAL_BASE_URL and HEAL_MODEL (OpenAI-compatible endpoint + model id).");
  process.exit(2);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** Run the suite (optionally grep-filtered) with the JSON reporter and return the parsed report. */
function runSuite(grep) {
  const out = join(mkdtempSync(join(tmpdir(), "heal-")), "report.json");
  const a = ["playwright", "test", "--project=chromium", "--retries=0", "--reporter=json"];
  if (grep) a.push("--grep", grep);
  try {
    execFileSync("npx", a, { env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out }, stdio: "ignore" });
  } catch {
    /* non-zero exit on failures is expected */
  }
  return JSON.parse(readFileSync(out, "utf-8"));
}

/** Flatten the JSON report into the failing tests: error text, source location, failure-time snapshot. */
function failuresOf(report) {
  const fails = [];
  const walk = (suite, file) => {
    for (const s of suite.suites || []) walk(s, s.file || file);
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const ok = t.results?.every((r) => r.status === "passed" || r.status === "skipped");
        if (!ok) {
          const bad = (t.results || []).filter((r) => r.status !== "passed" && r.status !== "skipped");
          const last = bad[bad.length - 1];
          const err = bad.map((r) => r.errors?.map((e) => e.message).join("\n")).join("\n").replace(ANSI, "");
          const ctx = last?.attachments?.find((a) => a.name === "error-context" && a.path);
          fails.push({
            title: spec.title,
            file: spec.file || file,
            error: err,
            location: last?.errors?.find((e) => e.location)?.location || null,
            snapshot: ctx ? readFileSync(ctx.path, "utf-8").slice(0, 12000) : null,
          });
        }
      }
    }
  };
  for (const s of report.suites || []) walk(s, s.file);
  return fails;
}

/** Return the balanced `name(...)` call text starting at `start` (the index of `name`), or null. */
function balancedCall(src, start) {
  const open = src.indexOf("(", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/** Quote/whitespace-insensitive form, so source `"x"` matches Playwright's printed `'x'`. */
const normalize = (call) => call.replace(/\s+/g, " ").replace(/"/g, "'");

/** The full locator call Playwright reports as failing, e.g. getByRole('button', { name: 'Go' }). */
function brokenLocatorFrom(error) {
  const m = error.match(/(?:waiting for|Locator:)\s+((?:locator|getBy\w+)\()/);
  if (!m) return null;
  return balancedCall(error, m.index + m[0].length - m[1].length);
}

const LOCATOR_CALL = /(this\.page|\bpage)\.(?=locator\(|getBy\w+\()/g;
const SOURCE_DIRS = ["pages", "tests", "utils", "fixtures"];

/** Every page.locator()/page.getBy*() call in the repo's tracked TS sources. */
function locatorCalls() {
  const files = execFileSync("git", ["ls-files", "--", ...SOURCE_DIRS], { encoding: "utf-8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
  const calls = [];
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(LOCATOR_CALL)) {
      const text = balancedCall(src, m.index + m[0].length);
      if (!text) continue;
      const call = `${m[1]}.${text}`;
      calls.push({
        file,
        src,
        receiver: m[1],
        call,
        index: m.index,
        line: src.slice(0, m.index).split("\n").length,
        norm: normalize(text),
      });
    }
  }
  return calls;
}

/**
 * Find the ONE source call that failed. Prefer the call on the error's reported
 * line; otherwise it must be the only match in the repo. Ambiguity is rejected,
 * never guessed.
 */
function locateInSource(expr, location) {
  const norm = normalize(expr);
  const hits = locatorCalls().filter((c) => c.norm === norm);
  if (hits.length === 0) return { why: `locator ${expr} not found as a page.locator()/getBy*() call in source (dynamic?)` };
  if (location?.file) {
    const rel = relative(process.cwd(), resolve(location.file));
    const here = hits.filter((c) => c.file === rel && c.line === location.line);
    if (here.length === 1) return here[0];
    if (here.length > 1) return { why: `${here.length} identical locators on ${rel}:${location.line} — ambiguous` };
  }
  if (hits.length === 1) return hits[0];
  return { why: `${hits.length} identical locator calls in source and no unique failure location — ambiguous` };
}

/** Ask the model to replace an exact locator expression (semantic, intent-preserving). */
async function proposeReplacement({ call, snapshot }) {
  const prompt =
    `You are a Playwright (TypeScript) test healer. A locator broke after a UI change.\n` +
    `Replace exactly this locator expression:\n  ${call}\n\n` +
    `Page snapshot captured at the moment the test failed:\n${snapshot}\n\n` +
    `Return ONLY the drop-in replacement expression (same leading receiver, e.g. "this.page.getByLabel('Username')"). ` +
    `No prose, no code fence, no trailing semicolon. Prefer a resilient semantic locator ` +
    `(getByRole/getByLabel/getByTestId over raw CSS/id). Target the SAME element — never change the test's intent.`;
  const resp = await fetch(`${HEAL_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(HEAL_API_KEY ? { Authorization: `Bearer ${HEAL_API_KEY}` } : {}) },
    body: JSON.stringify({ model: HEAL_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 200 }),
  });
  const data = await resp.json();
  let out = (data.choices?.[0]?.message?.content || "").trim();
  out = out.replace(/```[a-z]*\n?|```/g, "").trim().split("\n")[0].replace(/;$/, "").trim();
  return out;
}

async function main() {
  if (OPEN_PR && execFileSync("git", ["status", "--porcelain"], { encoding: "utf-8" }).trim()) {
    usageError("--open-pr requires a clean git worktree (commit or stash your changes first)");
  }
  console.log(`[heal] running suite${GREP ? ` (grep: ${GREP})` : ""}…`);
  const fails = failuresOf(runSuite(GREP));
  if (fails.length === 0) {
    console.log("[heal] no failures — nothing to heal.");
    return;
  }
  console.log(`[heal] ${fails.length} failing test(s).`);
  const decisions = [];

  for (const f of fails.slice(0, MAX)) {
    const expr = brokenLocatorFrom(f.error);
    if (!expr) {
      decisions.push({ test: f.title, outcome: "human", why: "no broken locator in the error — looks like a logic/app failure, not locator drift" });
      continue;
    }
    const loc = locateInSource(expr, f.location);
    if (loc.why) {
      decisions.push({ test: f.title, outcome: "human", why: loc.why });
      continue;
    }
    if (!f.snapshot) {
      decisions.push({ test: f.title, outcome: "human", why: "no failure-time page snapshot (error-context) captured — refusing to guess the page state" });
      continue;
    }
    const proposed = await proposeReplacement({ call: loc.call, snapshot: f.snapshot });
    if (!proposed || proposed === loc.call) {
      decisions.push({ test: f.title, outcome: "human", why: "model produced no usable replacement" });
      continue;
    }
    if (!validReplacement(proposed, loc.receiver)) {
      decisions.push({ test: f.title, outcome: "human", why: `model reply rejected (not a single literal-argument ${loc.receiver} locator call): ${JSON.stringify(proposed.slice(0, 120))}` });
      continue;
    }
    // Replace exactly the one located call, by position (no String.replace, so no `$&` expansion).
    const healed = loc.src.slice(0, loc.index) + proposed + loc.src.slice(loc.index + loc.call.length);
    writeFileSync(loc.file, healed);
    const stillFails = failuresOf(runSuite(escapeRe(f.title))).some((x) => x.title === f.title);
    if (stillFails) {
      writeFileSync(loc.file, loc.src); // revert — never leave a non-passing change
      decisions.push({ test: f.title, outcome: "human", why: `proposed "${proposed}" did not make the test pass — reverted; likely an app bug` });
    } else {
      decisions.push({ test: f.title, outcome: "healed", file: loc.file, from: loc.call, to: proposed, source: "page snapshot captured at the failure" });
    }
  }

  console.log("\n[heal] decisions:");
  for (const d of decisions) console.log("  " + JSON.stringify(d));
  const healed = decisions.filter((d) => d.outcome === "healed");
  const human = decisions.filter((d) => d.outcome === "human");

  if (OPEN_PR && healed.length > 0) {
    const branch = `heal/${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
    const files = [...new Set(healed.map((d) => d.file))];
    execFileSync("git", ["checkout", "-b", branch]);
    execFileSync("git", ["add", "--", ...files]);
    // Commit ONLY the healed files, never unrelated work in the caller's tree.
    execFileSync("git", ["commit", "-qm", `fix(heal): update ${healed.length} drifted locator(s)\n\n` + healed.map((d) => `- ${d.test}: ${d.from} -> ${d.to}`).join("\n"), "--", ...files]);
    execFileSync("git", ["push", "-q", "-u", "origin", branch]);
    const body =
      `Automated locator healing (out-of-band).\n\n## Healed (locators only, intent preserved)\n` +
      healed.map((d) => `- **${d.test}** — \`${d.from}\` → \`${d.to}\` (grounded in ${d.source})`).join("\n") +
      (human.length ? `\n\n## Needs human review (not touched)\n` + human.map((d) => `- **${d.test}** — ${d.why}`).join("\n") : "");
    execFileSync("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `Locator healing — ${healed.length} fixed, ${human.length} for review`, "--body", body], { stdio: "inherit" });
  }
  console.log(`\n[heal] done: ${healed.length} healed, ${human.length} for human review.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

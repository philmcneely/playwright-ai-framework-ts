/**
 * heal.mjs — out-of-band locator healer (v2, CLI mode)
 *
 * Runs failing Playwright tests, reproduces each failure in a real browser to
 * read the live accessibility snapshot, asks a configurable model for a
 * resilient semantic locator, applies it, and re-runs to verify. Heals
 * LOCATORS only — never assertions or test intent. Genuine app bugs are left
 * failing and reported for a human, not "healed".
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
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (flag, def = null) => {
  const i = args.indexOf(flag);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const GREP = opt("--grep", null);
const OPEN_PR = args.includes("--open-pr");
const MAX = parseInt(opt("--max", "10"), 10);

const BASE_URL = process.env.BASE_URL || "http://localhost:7080";
const HEAL_BASE_URL = process.env.HEAL_BASE_URL;
const HEAL_MODEL = process.env.HEAL_MODEL;
const HEAL_API_KEY = process.env.HEAL_API_KEY || "";
if (!HEAL_BASE_URL || !HEAL_MODEL) {
  console.error("Set HEAL_BASE_URL and HEAL_MODEL (OpenAI-compatible endpoint + model id).");
  process.exit(2);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** Flatten the JSON report into the failing tests with their error text. */
function failuresOf(report) {
  const fails = [];
  const walk = (suite, file) => {
    for (const s of suite.suites || []) walk(s, s.file || file);
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const ok = t.results?.every((r) => r.status === "passed" || r.status === "skipped");
        if (!ok) {
          const err = t.results?.map((r) => r.errors?.map((e) => e.message).join("\n")).join("\n") || "";
          fails.push({ title: spec.title, file: spec.file || file, error: err });
        }
      }
    }
  };
  for (const s of report.suites || []) walk(s, s.file);
  return fails;
}

/** Pull the first concrete selector literal out of a Playwright error message. */
function brokenSelectorFrom(error) {
  const m =
    error.match(/locator\(['"`]([^'"`]+)['"`]\)/) ||
    error.match(/getBy\w+\(['"`]([^'"`]+)['"`]\)/) ||
    error.match(/waiting for (?:locator )?['"`]([^'"`]+)['"`]/);
  return m ? m[1] : null;
}

/** Find the source file + (page-object) url route that defines a selector literal. */
function locateInSource(selector) {
  let hits = "";
  try {
    hits = execFileSync("grep", ["-rln", "--include=*.ts", selector, "pages", "tests", "utils"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
  const file = hits.split("\n")[0];
  if (!file) return null;
  const src = readFileSync(file, "utf-8");
  const route = src.match(/\burl\s*=\s*["'`]([^"'`]+)["'`]/);
  // The full locator CALL that references the broken selector, e.g. this.page.locator("#x").
  const call = src.match(new RegExp(`(?:this\\.)?page\\.locator\\(\\s*['"\`]${escapeRe(selector)}['"\`]\\s*\\)`));
  return { file, src, route: route ? route[1] : "/", call: call ? call[0] : null };
}

/** Capture the live accessibility snapshot of a route for grounding. */
async function ariaSnapshot(route) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: BASE_URL });
    await page.goto(route);
    return await page.locator("body").ariaSnapshot();
  } finally {
    await browser.close();
  }
}

/** Ask the model to replace an exact locator expression (semantic, intent-preserving). */
async function proposeReplacement({ call, snapshot }) {
  const prompt =
    `You are a Playwright (TypeScript) test healer. A locator broke after a UI change.\n` +
    `Replace exactly this locator expression:\n  ${call}\n\n` +
    `Live page accessibility snapshot:\n${snapshot}\n\n` +
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
  console.log(`[heal] running suite${GREP ? ` (grep: ${GREP})` : ""}…`);
  const fails = failuresOf(runSuite(GREP));
  if (fails.length === 0) {
    console.log("[heal] no failures — nothing to heal.");
    return;
  }
  console.log(`[heal] ${fails.length} failing test(s).`);
  const decisions = [];

  for (const f of fails.slice(0, MAX)) {
    const selector = brokenSelectorFrom(f.error);
    if (!selector) {
      decisions.push({ test: f.title, outcome: "human", why: "no broken selector in the error — looks like a logic/app failure, not locator drift" });
      continue;
    }
    const loc = locateInSource(selector);
    if (!loc || !loc.call) {
      decisions.push({ test: f.title, outcome: "human", why: `selector ${selector} not found as a .locator() call in source (dynamic/semantic?)` });
      continue;
    }
    const snapshot = await ariaSnapshot(loc.route);
    const proposed = await proposeReplacement({ call: loc.call, snapshot });
    if (!proposed || proposed === loc.call) {
      decisions.push({ test: f.title, outcome: "human", why: "model produced no usable replacement" });
      continue;
    }
    const healed = loc.src.replace(loc.call, proposed);
    writeFileSync(loc.file, healed);
    const stillFails = failuresOf(runSuite(f.title)).some((x) => x.title === f.title);
    if (stillFails) {
      writeFileSync(loc.file, loc.src); // revert — never leave a non-passing change
      decisions.push({ test: f.title, outcome: "human", why: `proposed "${proposed}" did not make the test pass — reverted; likely an app bug` });
    } else {
      decisions.push({ test: f.title, outcome: "healed", file: loc.file, from: loc.call, to: proposed, source: `aria snapshot of ${loc.route}` });
    }
  }

  console.log("\n[heal] decisions:");
  for (const d of decisions) console.log("  " + JSON.stringify(d));
  const healed = decisions.filter((d) => d.outcome === "healed");
  const human = decisions.filter((d) => d.outcome === "human");

  if (OPEN_PR && healed.length > 0) {
    const branch = `heal/${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
    execFileSync("git", ["checkout", "-b", branch]);
    execFileSync("git", ["commit", "-aqm", `fix(heal): update ${healed.length} drifted locator(s)\n\n` + healed.map((d) => `- ${d.test}: ${d.from} -> ${d.to}`).join("\n")]);
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

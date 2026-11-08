/**
 * Unit tests: scripts/heal.mjs - the CLI around the heal-service client: the flags, the JSON report, verification of the exact
 * test, decisions beyond --max, shared-fix confirmation, the summary file, the printed usage, the exit when no service is
 * configured, and that the framework contains no model URL, model name, prompt or reply parsing.
 *
 * No browser, heal service or real Playwright subprocess is used; those seams are replaced so the CLI's own decisions are
 * tested in isolation. The client's request building, patch safety and try -> result loop are in test-heal-client.spec.ts.
 *
 * @tags @unit
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPrBody, failuresOf, healFailures, parseArgs, printDecisions, validReplacement, verifyPassed, writeSummary,
  type SuiteRunner,
} from "../../scripts/heal.mjs";

const ROOT = "/repo";
const file = "/repo/tests/t.spec.ts";
const spec = (title: string, results: Array<Record<string, unknown>>, status = "unexpected") => ({
  title, file: "t.spec.ts", tests: [{ status, results }],
});
const report = (...specs: ReturnType<typeof spec>[]) => ({ config: { rootDir: "/repo/tests" }, suites: [{ file: "t.spec.ts", specs }] });
const PASSED = [{ status: "passed", errors: [] }];

test.describe("flags", { tag: ["@unit", "@regression"] }, () => {
  test("defaults and every flag", () => {
    expect(parseArgs([])).toEqual({ grep: null, max: 10, openPr: false });
    expect(parseArgs(["--grep", "login", "--max", "3", "--open-pr"])).toEqual({ grep: "login", max: 3, openPr: true });
  });

  for (const [args, error] of [
    [["--bogus"], "unknown flag --bogus"], [["--grep"], "--grep requires a value"], [["--max", "--open-pr"], "--max requires a value"],
    [["--max", "0"], "--max must be a positive integer"], [["--max", "x"], "--max must be a positive integer"],
  ] as Array<[string[], string]>) {
    test(`a bad flag is named: ${args.join(" ")}`, () => {
      expect(parseArgs(args)).toEqual({ error });
    });
  }
});

test.describe("the JSON report", { tag: ["@unit", "@regression"] }, () => {
  test("failing tests come out with the message, the stack, the location and the page at the failure", () => {
    const failing = spec("valid login", [{
      status: "failed", errors: [{ message: "\u001b[31mError: boom\u001b[39m", stack: "Error: boom\n    at /repo/pages/p.ts:5:1", location: { file: "/repo/pages/p.ts", line: 5 } }],
      attachments: [{ name: "heal-page-url", body: Buffer.from("/secure").toString("base64") }, { name: "trace", path: "/x" }],
    }]);
    const fails = failuresOf(report(failing, spec("fine", PASSED, "expected")));
    expect(fails).toEqual([{
      title: "valid login", file, error: "Error: boom", stack: "Error: boom\n    at /repo/pages/p.ts:5:1",
      location: { file: "/repo/pages/p.ts", line: 5 }, route: "/secure",
    }]);
  });

  test("a skipped or passed test is not a failure, a missing report is none", () => {
    expect(failuresOf(report(spec("a", [{ status: "skipped" }]), spec("b", PASSED, "expected")))).toEqual([]);
    expect(failuresOf(null)).toEqual([]);
  });
});

test.describe("verifyPassed", { tag: ["@unit", "@regression"] }, () => {
  const T = { title: "valid login", file, error: "" };
  const runner = (code: number, rep: unknown): SuiteRunner => () => ({ code, report: rep as never });

  test("pass", () => {
    expect(verifyPassed(T, runner(0, report(spec("valid login", PASSED, "expected"))), ROOT)).toBe(true);
  });

  test("an empty selection or a missing report is not a pass", () => {
    expect(verifyPassed(T, runner(1, null), ROOT)).toBe(false);
    expect(verifyPassed(T, runner(0, null), ROOT)).toBe(false);
    expect(verifyPassed(T, runner(0, report()), ROOT)).toBe(false);
  });

  test("the target did not run (a different test with a similar title)", () => {
    expect(verifyPassed(T, runner(0, report(spec("valid login 2", PASSED, "expected"))), ROOT)).toBe(false);
  });

  test("a non-zero exit, a failure or a flaky pass is not a pass", () => {
    const ok = report(spec("valid login", PASSED, "expected"));
    expect(verifyPassed(T, runner(1, ok), ROOT)).toBe(false);
    expect(verifyPassed(T, runner(0, report(spec("valid login", [{ status: "failed" }]))), ROOT)).toBe(false);
    expect(verifyPassed(T, runner(0, report(spec("valid login", PASSED, "flaky"))), ROOT)).toBe(false);
  });

  test("the run is scoped to the spec file and the title", () => {
    let seen: unknown = null;
    verifyPassed(T, (o) => ((seen = o), { code: 0, report: report(spec("valid login", PASSED, "expected")) as never }), ROOT);
    expect(seen).toEqual({ grep: "valid login", file: "tests/t.spec.ts" });
  });
});

const HEALED = { outcome: "healed", file: "pages/p.ts", from: "a", to: "b", files: ["pages/p.ts"], usage: { calls: 1, input_tokens: 120, output_tokens: 8, images: 0 } };
const HUMAN = { outcome: "needs_human", reason: "target_missing", why: "no element could be the one", usage: { calls: 0, input_tokens: 0, output_tokens: 0, images: 0 } };
const FAILS = [0, 1, 2].map((i) => ({ title: `test ${i}`, file, error: "e" }));

class FakeHealer {
  seen: string[] = [];
  constructor(private decisions: Array<Record<string, unknown>>) {}
  async heal(f: { title: string }) {
    this.seen.push(f.title);
    return { test: f.title, ...this.decisions.shift() } as never;
  }
}

test.describe("healFailures", { tag: ["@unit", "@regression"] }, () => {
  test("failures beyond --max are recorded, not dropped", async () => {
    const healer = new FakeHealer([HUMAN]);
    const out = await healFailures(FAILS, healer, 1);
    expect(healer.seen).toEqual(["test 0"]);
    const beyond = out.filter((d) => d.reason === "beyond_max");
    expect(beyond.map((d) => d.test)).toEqual(["test 1", "test 2"]);
    expect(beyond[0].why).toContain("beyond --max 1");
    expect(beyond.every((d) => d.outcome === "needs_human")).toBe(true);
  });

  test("a test a previous heal already fixed is confirmed by a re-run, not healed again", async () => {
    const healer = new FakeHealer([HEALED, HUMAN]);
    const reruns: string[] = [];
    const out = await healFailures(FAILS, healer, 10, (f) => (reruns.push(f.title), f.title === "test 1"));
    expect(reruns).toEqual(["test 1", "test 2"]);
    expect(healer.seen).toEqual(["test 0", "test 2"]);
    expect(out[1].outcome).toBe("healed");
    expect(out[1].source).toContain("same fix as test 0");
    expect(out[2].outcome).toBe("needs_human");
  });
});

test.describe("summary and output", { tag: ["@unit", "@regression"] }, () => {
  test("the summary file has counts, usage and every decision", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heal-sum-"));
    try {
      const ds = [{ test: "a", ...HEALED }, { test: "b", ...HUMAN }, { test: "c", outcome: "not_drift", why: "assertion" }] as never[];
      const out = writeSummary(ds, "t0", "run1", path.join(dir, "art"));
      const data = JSON.parse(readFileSync(out, "utf8"));
      expect(path.basename(out)).toBe("heal-summary.json");
      expect(data).toMatchObject({ run_id: "run1", started: "t0", failures: 3, counts: { healed: 1, needs_human: 1, not_drift: 1 } });
      expect(data.usage).toEqual({ calls: 1, input_tokens: 120, output_tokens: 8, images: 0 });
      expect(data.decisions.map((d: { test: string }) => d.test)).toEqual(["a", "b", "c"]);
      expect(readdirSync(path.join(dir, "art"))).toEqual(["heal-summary.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("decisions are printed with tokens and a run total", () => {
    const lines: string[] = [];
    printDecisions([{ test: "a", ...HEALED }, { test: "b", ...HUMAN, notes: ["no screenshot sent"] }] as never[], (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).toContain("[healed] a: pages/p.ts: a -> b  (tokens 120 in / 8 out, 1 call(s))");
    expect(out).toContain("[needs_human] [target_missing] b: no element could be the one");
    expect(out).toContain("note: no screenshot sent");
    expect(out).toContain("run total: 1 model call(s), 120 input / 8 output tokens, 0 image(s)");
  });

  test("the PR body lists the healed tests and the ones left for a human", () => {
    const body = buildPrBody([{ test: "a", ...HEALED, why: "same textbox" }] as never[], [{ test: "b", ...HUMAN }] as never[]);
    expect(body).toContain("## Healed");
    expect(body).toContain("## Needs human review");
  });
});

test.describe("the script", { tag: ["@unit", "@regression"] }, () => {
  test("no service url exits 2 with a message, and starts no run", () => {
    const run = spawnSync(process.execPath, ["scripts/heal.mjs"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("HEAL_SERVICE_URL");
  });

  test("an unknown flag exits 2 with the usage", () => {
    const run = spawnSync(process.execPath, ["scripts/heal.mjs", "--bogus"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HEAL_SERVICE_URL: "http://localhost:1" } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown flag --bogus");
    expect(run.stderr).toContain("Usage:");
  });

  test("the second check accepts what the first accepts, chains included, and refuses the rest", () => {
    expect(validReplacement("this.page.getByRole('button', { name: 'Go' }).first()", "this.page")).toBe(true);
    expect(validReplacement("this.page.locator('.row').filter({ hasText: 'x' }).nth(2)", "this.page")).toBe(true);
    expect(validReplacement("this.page.getByRole('button').first().click()", "this.page")).toBe(false);
    expect(validReplacement("this.page.first()", "this.page")).toBe(false);
    expect(validReplacement("page.locator('#a')", "this.page")).toBe(false);
  });
});

test.describe("no model in the framework", { tag: ["@unit", "@security", "@regression"] }, () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "scripts", "utils", "fixtures", "pages", "config"], { encoding: "utf8" })
    .split("\n").filter((f) => /\.(mjs|ts|js)$/.test(f) && !f.endsWith("heal-probe.js"));
  const FORBIDDEN = /chat\/completions|HEAL_MODEL|HEAL_API_KEY|HEAL_BASE_URL|proposeReplacement|openrouter|ollama|api\.openai|api\.anthropic|\bgpt-|\bclaude-|\bqwen/i;

  test("no script, helper, fixture or page names a model URL, a model, a model key or a prompt", () => {
    expect(files.length).toBeGreaterThan(10);
    const hits = files.filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")) && !f.includes("test-heal-cli"));
    expect(hits).toEqual([]);
  });

  test("the client sends nothing but evidence: it calls only the service's own routes", () => {
    const client = readFileSync("scripts/heal-client.mjs", "utf8");
    const routes = [...client.matchAll(/this\.call\("(?:GET|POST)",\s*[`"]([^`"]+)/g)].map((m) => m[1]);
    expect(routes.sort()).toEqual(["/v1/capabilities", "/v1/heal", "/v1/heals/${encodeURIComponent(healId)}/result", "/v1/probe.js"]);
  });
});

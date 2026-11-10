/**
 * Unit tests: a heal is kept when its own line passes on re-run and the test then stops at a different locator that found nothing
 * (the service judges that; the client only reports the facts), and the next failure of that test is healed in a further round.
 *
 * No browser, service or Playwright subprocess: the re-run, the page and the service are scripted (see heal-helpers.ts).
 *
 * @tags @unit
 */
import { test, expect } from "@playwright/test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPrBody, failuresOf, healFailures, MAX_LATER_ROUNDS, verifyPassed, verifyRun, writeSummary, type SuiteRunner } from "../../scripts/heal.mjs";
import type { Failure } from "../../scripts/heal-client.mjs";
import { FakeLive, FakeService, PAGE_FILE, PAGE_SRC, TO, candidate, failureFor, healer, makeProject, read, reply } from "./heal-helpers.js";

let root = "";
test.beforeEach(() => {
  root = makeProject();
});
test.afterEach(() => rmSync(root, { recursive: true, force: true }));

type Run = { passed: boolean; failure: Failure | null };
const LATER_ERROR = "Error: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for locator('#next')\n";

/** The re-run failing at `line` of `file` (relative to the project), as failuresOf builds it. */
const failingAt = (file: string, line: number, error = LATER_ERROR): Failure => ({
  title: "valid login", file: path.join(root, "tests/login.spec.ts"), error, stack: "", location: { file: path.join(root, file), line },
  route: null, capture: null,
});
const scripted = (...runs: Run[]) => {
  const seen: Array<{ failure: Failure; file: string }> = [];
  const fn = async (failure: Failure) => (seen.push({ failure, file: read(root) }), runs.shift() ?? { passed: false, failure: null });
  return Object.assign(fn, { seen });
};

test.describe("reporting a later failure", { tag: ["@unit", "@regression"] }, () => {
  test("the healed line passes and the test stops at another line: reported as failed_later and kept when the service says healed", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("healed", candidate(root), { reason: "later_locator" })]);
    const d = await healer(root, svc, scripted({ passed: false, failure: failingAt(PAGE_FILE, 9) }) as never).heal(failureFor(root));
    expect(svc.posts("/result")).toEqual([{
      count: 1, hit: { ref: "e0" }, test_outcome: "failed_later", later: { error: LATER_ERROR, file: PAGE_FILE, line: 9, stack: [{ file: PAGE_FILE, line: 9 }] },
    }]);
    expect(read(root)).toContain(TO);
    expect(d).toMatchObject({ outcome: "healed", reason: "later_locator", to: TO, later_at: `${PAGE_FILE}:9` });
    expect((d as { later_failure?: Failure }).later_failure?.location?.line).toBe(9);
  });

  test("the edit is still in the file while the service answers, not reverted first", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("healed", candidate(root), { reason: "later_locator" })]);
    const atResult: string[] = [];
    svc.handler = (req) => (req.path.endsWith("/result") ? (atResult.push(read(root)), undefined) : undefined);
    await healer(root, svc, scripted({ passed: false, failure: failingAt(PAGE_FILE, 9) }) as never).heal(failureFor(root));
    expect(atResult).toHaveLength(1);
    expect(atResult[0]).toContain(TO);
  });

  test("a failure in another file (the test itself) is a different line", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("healed", candidate(root), { reason: "later_locator" })]);
    await healer(root, svc, scripted({ passed: false, failure: failingAt("tests/login.spec.ts", 8) }) as never).heal(failureFor(root));
    expect(svc.posts("/result")[0]).toMatchObject({ test_outcome: "failed_later", later: { file: "tests/login.spec.ts", line: 8 } });
  });

  for (const answer of [["try", "the next candidate"], ["needs_human", "a human"]] as const) {
    test(`reverted when the service answers ${answer[0]}`, async () => {
      const second = candidate(root, { to: "this.page.locator('#user')" });
      const replies = answer[0] === "try"
        ? [reply("try", candidate(root)), reply("try", second, { rnd: 2 }), reply("needs_human", null, { reason: "max_rounds" })]
        : [reply("try", candidate(root)), reply("needs_human", null, { reason: "rerun_failed" })];
      const svc = new FakeService(replies);
      const run = scripted({ passed: false, failure: failingAt(PAGE_FILE, 9) }, { passed: false, failure: null });
      const d = await healer(root, svc, run as never).heal(failureFor(root));
      expect(read(root)).toBe(PAGE_SRC);
      expect(d.outcome).toBe("needs_human");
      expect((d as { later_failure?: unknown }).later_failure).toBeUndefined();
      if (answer[0] === "try") expect(run.seen[1].file).toContain("#user"); // the first edit was undone before the next one
    });
  }

  test("a failure on the patched line is a failed re-run, not failed_later", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
    await healer(root, svc, scripted({ passed: false, failure: failingAt(PAGE_FILE, 8) }) as never).heal(failureFor(root));
    expect(svc.posts("/result")).toEqual([{ count: 1, hit: { ref: "e0" }, test_outcome: "failed" }]);
    expect(read(root)).toBe(PAGE_SRC);
  });

  test("a failure with no location, or no failure at all, is a failed re-run", async () => {
    for (const failure of [{ ...failingAt(PAGE_FILE, 9), location: null }, null]) {
      const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
      await healer(root, svc, scripted({ passed: false, failure }) as never).heal(failureFor(root));
      expect(svc.posts("/result")).toEqual([{ count: 1, hit: { ref: "e0" }, test_outcome: "failed" }]);
    }
  });

  test("the later error is capped at 4000 characters, stripped of the repository path and of compared values", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
    const error = `Error: locator.click: ${root}/pages/login-page.ts\n  - waiting for locator('#next')\n${"x".repeat(9000)}`;
    await healer(root, svc, scripted({ passed: false, failure: failingAt(PAGE_FILE, 9, error) }) as never).heal(failureFor(root));
    const later = (svc.posts("/result")[0] as { later: { error: string } }).later;
    expect(later.error.length).toBeLessThanOrEqual(4000);
    expect(later.error).toContain("waiting for locator('#next')");
    expect(later.error).not.toContain(root);
  });

  test("a failure that cannot be placed under the source roots is a failed re-run: nothing is kept", async () => {
    for (const location of [{ file: "/elsewhere/lib.ts", line: 3 }, { file: path.join(root, "node_modules/x/y.js"), line: 3 }]) {
      const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
      await healer(root, svc, scripted({ passed: false, failure: { ...failingAt(PAGE_FILE, 9), location } }) as never).heal(failureFor(root));
      expect(svc.posts("/result")).toEqual([{ count: 1, hit: { ref: "e0" }, test_outcome: "failed" }]);
      expect(read(root)).toBe(PAGE_SRC);
    }
  });

  test("the later stack is built like the request's failure.stack: repo-relative frames under the roots, innermost first", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
    const stack = [
      `Error: x\n    at LoginPage.login (${root}/pages/login-page.ts:9:38)`,
      `    at ${root}/tests/login.spec.ts:4:30`,
      "    at node_modules/playwright/lib/x.js:1:1",
    ].join("\n");
    const rerun = { ...failingAt(PAGE_FILE, 9), stack };
    await healer(root, svc, scripted({ passed: false, failure: rerun }) as never).heal(failureFor(root));
    const req = svc.posts("/v1/heal")[0] as { failure: { stack: unknown } };
    const later = (svc.posts("/result")[0] as { later: { stack: Array<{ file: string; line: number }>; file: string; line: number } }).later;
    expect(later.stack).toEqual([{ file: PAGE_FILE, line: 9 }, { file: "tests/login.spec.ts", line: 4 }]);
    expect(Object.keys(later.stack[0]).sort()).toEqual(Object.keys((req.failure.stack as object[])[0]).sort());
    expect([later.file, later.line]).toEqual([PAGE_FILE, 9]); // the innermost frame
  });

  test("a plain boolean verify still works and never reports a later failure", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
    await healer(root, svc, (async () => false) as never, new FakeLive()).heal(failureFor(root));
    expect(svc.posts("/result")).toEqual([{ count: 1, hit: { ref: "e0" }, test_outcome: "failed" }]);
  });
});

test.describe("rounds", { tag: ["@unit", "@regression"] }, () => {
  test("the next failure of the same test is healed with the failure the re-run produced", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("healed", candidate(root), { reason: "later_locator" }), reply("healed", null)]);
    let heals = 0;
    svc.handler = (req) => {
      if (req.path !== "/v1/heal" || ++heals < 2) return undefined;
      return new Response(JSON.stringify(reply("try", candidate(root, { to: "this.page.getByTestId('pw')" }), { heal_id: "h_2" })), { status: 200 });
    };
    const later = failingAt(PAGE_FILE, 9);
    const run = scripted({ passed: false, failure: later }, { passed: true, failure: null });
    const out = await healFailures([failureFor(root) as never], healer(root, svc, run as never), 10);
    expect(out.map((d) => [d.outcome, d.reason ?? null])).toEqual([["healed", "later_locator"], ["healed", null]]);
    expect(run.seen[1].failure).toBe(later); // the second re-run is of the failure the first one produced
    const second = svc.posts("/v1/heal")[1] as { failure: { error: string } };
    expect(second.failure.error).toContain("waiting for locator('#next')");
    expect(read(root)).toContain("getByTestId('pw')");
    expect(read(root)).toContain(TO);
    expect(out.some((d) => d.still_failing)).toBe(false);
    expect(out.every((d) => !("later_failure" in d))).toBe(true);
  });
});

test.describe("rounds, scripted healer", { tag: ["@unit", "@regression"] }, () => {
  const fail = (title = "t"): never => ({ title, file: "/repo/tests/t.spec.ts", error: "e" }) as never;
  const kept = (n: number, extra: Record<string, unknown> = {}) => ({
    outcome: "healed", reason: "later_locator", file: "pages/p.ts", from: `a${n}`, to: `b${n}`, files: ["pages/p.ts"], later_at: "pages/p.ts:9",
    later_failure: { title: "t", file: "/repo/tests/t.spec.ts", error: `later ${n}` }, ...extra,
  });
  const passing = (n: number) => ({ outcome: "healed", reason: null, file: "pages/p.ts", from: `a${n}`, to: `b${n}`, files: ["pages/p.ts"] });
  const human = { outcome: "needs_human", reason: "target_missing", why: "no element could be the one" };
  class Scripted {
    seen: string[] = [];
    constructor(private decisions: Array<Record<string, unknown>>) {}
    async heal(f: { title: string; error: string }) {
      this.seen.push(f.error);
      return { test: f.title, ...this.decisions.shift() } as never;
    }
  }

  test("the cap is three extra rounds per test, and a chain that is cut there is marked still failing", async () => {
    expect(MAX_LATER_ROUNDS).toBe(3);
    const h = new Scripted([kept(1), kept(2), kept(3), kept(4), kept(5)]);
    const out = await healFailures([fail()], h, 10);
    expect(h.seen).toEqual(["e", "later 1", "later 2", "later 3"]); // the first heal and three more
    expect(out).toHaveLength(4);
    expect(out.slice(0, 3).some((d) => d.still_failing)).toBe(false);
    expect(out[3]).toMatchObject({ outcome: "healed", still_failing: true });
    expect(out[3].still_failing_why).toContain("3 more");
    expect(out.every((d) => !("later_failure" in d))).toBe(true);
  });

  test("a chain that ends passing is not marked", async () => {
    const out = await healFailures([fail()], new Scripted([kept(1), kept(2), passing(3)]), 10);
    expect(out).toHaveLength(3);
    expect(out.some((d) => d.still_failing)).toBe(false);
  });

  test("a later failure that cannot be healed leaves the earlier heals kept and says the test still fails later", async () => {
    const out = await healFailures([fail()], new Scripted([kept(1), kept(2), human]), 10);
    expect(out.map((d) => d.outcome)).toEqual(["healed", "healed", "needs_human"]);
    expect(out[0].still_failing).toBeUndefined();
    expect(out[1]).toMatchObject({ still_failing: true });
    expect(out[1].still_failing_why).toContain("pages/p.ts:9");
    expect(out[1].still_failing_why).toContain("no element could be the one");
  });

  test("a heal kept for a later failure under another reason is not chained, and still marked", async () => {
    const h = new Scripted([kept(1, { reason: null })]);
    const out = await healFailures([fail()], h, 10);
    expect(h.seen).toEqual(["e"]);
    expect(out[0]).toMatchObject({ still_failing: true });
  });

  test("the next test starts fresh, the shared-fix check sees every kept heal", async () => {
    const h = new Scripted([kept(1, { later_failure: { title: "a", file: "/repo/tests/t.spec.ts", error: "later 1" } }), human, passing(5)]);
    const out = await healFailures([fail("a"), fail("b")], h, 10, () => false);
    expect(out.map((d) => `${d.test}:${d.outcome}`)).toEqual(["a:healed", "a:needs_human", "b:healed"]);
    expect(out[2].still_failing).toBeUndefined();
  });
});

test.describe("the pull request and the summary", { tag: ["@unit", "@regression"] }, () => {
  const healed = [
    { test: "a", outcome: "healed", from: "x", to: "y", why: "same textbox" },
    { test: "b [x]", outcome: "healed", from: "p", to: "q", why: "same button", still_failing: true, still_failing_why: "the test still fails later at pages/p.ts:9 (no element)" },
  ];

  test("a test whose kept heal still fails later is listed in its own visible section", () => {
    const body = buildPrBody(healed as never[], []);
    expect(body).toContain("## Kept, test still fails later");
    const section = body.split("## Kept, test still fails later")[1];
    expect(section).toContain("b \\[x\\]");
    expect(section).toContain("pages/p.ts:9");
    expect(section).not.toContain("**a**");
    expect(body.split("## Healed")[1].split("## Kept")[0]).toContain("**a**");
  });

  test("without such a test the body has no such section", () => {
    expect(buildPrBody(healed.slice(0, 1) as never[], [])).not.toContain("still fails later");
  });

  test("the summary keeps still_failing and its why, and counts them", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heal-later-"));
    try {
      const out = writeSummary([...healed, { test: "b [x]", outcome: "needs_human", why: "nope", later_failure: { error: "e" } }] as never[], "t0", "run1", dir);
      const data = JSON.parse(readFileSync(out, "utf8"));
      expect(data.decisions[1]).toMatchObject({ still_failing: true });
      expect(data.decisions[1].still_failing_why).toContain("pages/p.ts:9");
      expect(data.decisions[0].still_failing).toBeUndefined();
      expect(data.counts).toMatchObject({ healed: 2, needs_human: 1 });
      expect(data.still_failing).toBe(1);
      expect(JSON.stringify(data)).not.toContain("later_failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe("verifyRun", { tag: ["@unit", "@regression"] }, () => {
  const file = "/repo/tests/t.spec.ts";
  const T = { title: "valid login", file, error: "" };
  const spec = (title: string, results: Array<Record<string, unknown>>, status = "unexpected") => ({ title, file: "t.spec.ts", tests: [{ status, results }] });
  const report = (...specs: ReturnType<typeof spec>[]) => ({ config: { rootDir: "/repo/tests" }, suites: [{ file: "t.spec.ts", specs }] });
  const runner = (code: number, rep: unknown): SuiteRunner => () => ({ code, report: rep as never });
  const BAD = [{ status: "failed", errors: [{ message: "Error: boom", stack: "s", location: { file: "/repo/pages/p.ts", line: 9 } }] }];

  test("a pass is passed with no failure", () => {
    expect(verifyRun(T, runner(0, report(spec("valid login", [{ status: "passed", errors: [] }], "expected"))), "/repo")).toEqual({ passed: true, failure: null });
  });

  test("a failed re-run returns the failure as failuresOf builds it", () => {
    const rep = report(spec("valid login", BAD));
    const run = verifyRun(T, runner(1, rep), "/repo");
    expect(run.passed).toBe(false);
    expect(run.failure).toEqual(failuresOf(rep)[0]);
    expect(run.failure?.location).toEqual({ file: "/repo/pages/p.ts", line: 9 });
  });

  test("no report, an empty selection or another test is a failed run with no failure", () => {
    for (const rep of [null, report(), report(spec("valid login 2", BAD))]) {
      expect(verifyRun(T, runner(1, rep), "/repo")).toEqual({ passed: false, failure: null });
    }
  });

  test("a flaky pass or a non-zero exit with a passing report is not a pass and has no failure", () => {
    const ok = [{ status: "passed", errors: [] }];
    expect(verifyRun(T, runner(0, report(spec("valid login", ok, "flaky"))), "/repo")).toEqual({ passed: false, failure: null });
    expect(verifyRun(T, runner(1, report(spec("valid login", ok, "expected"))), "/repo")).toEqual({ passed: false, failure: null });
  });

  test("verifyPassed is the same strictness as before", () => {
    expect(verifyPassed(T, runner(0, report(spec("valid login", [{ status: "passed" }], "expected"))), "/repo")).toBe(true);
    expect(verifyPassed(T, runner(0, report(spec("valid login", BAD))), "/repo")).toBe(false);
  });
});

test.describe("a round that throws, an interrupt while a patch is on disk", { tag: ["@unit", "@regression"] }, () => {
  const laterReply = () => reply("healed", candidate(root), { reason: "later_locator" });

  test("a chained round that loses the service is recorded, the earlier heal stays and is marked, the summary is written", async () => {
    const svc = new FakeService([reply("try", candidate(root)), laterReply()]);
    let heals = 0;
    svc.handler = (req) => (req.path === "/v1/heal" && ++heals === 2 ? new Response("{}", { status: 503 }) : undefined);
    const out = await healFailures([failureFor(root) as never], healer(root, svc, scripted({ passed: false, failure: failingAt(PAGE_FILE, 9) }) as never), 10);
    expect(out.map((d) => d.outcome)).toEqual(["healed", "needs_human"]);
    expect(out[0]).toMatchObject({ still_failing: true });
    expect(read(root)).toContain(TO); // the first heal stays
    const dir = mkdtempSync(path.join(tmpdir(), "heal-chain-"));
    try {
      const data = JSON.parse(readFileSync(writeSummary(out, "t0", "r1", dir), "utf8"));
      expect(data.still_failing).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a chained round whose healer throws outright is a needs_human chain_error, and the next test is still healed", async () => {
    const kept = { outcome: "healed", reason: "later_locator", file: "pages/p.ts", from: "a", to: "b", later_at: "pages/p.ts:9", later_failure: { title: "a", file: "/repo/t.ts", error: "e" } };
    const script: Array<Record<string, unknown> | Error> = [kept, new Error("browser gone"), { outcome: "not_drift", why: "assertion" }];
    const h = { async heal(f: { title: string }) {
      const next = script.shift();
      if (next instanceof Error) throw next;
      return { test: f.title, ...next } as never;
    } };
    const out = await healFailures([{ title: "a", file: "/repo/t.ts", error: "e" }, { title: "b", file: "/repo/t.ts", error: "e" }] as never[], h, 10, () => false);
    expect(out.map((d) => `${d.test}:${d.outcome}`)).toEqual(["a:healed", "a:needs_human", "b:not_drift"]);
    expect(out[1]).toMatchObject({ reason: "chain_error" });
    expect(String(out[1].why)).toContain("browser gone");
    expect(out[0]).toMatchObject({ still_failing: true });
  });

  test("the first round still throws as before", async () => {
    await expect(healFailures([{ title: "a", file: "/repo/t.ts", error: "e" }] as never[], { heal: async () => { throw new Error("x"); } }, 10)).rejects.toThrow("x");
  });

  for (const [name, runs, expected] of [
    ["passed", [{ passed: true, failure: null }], "passed"],
    ["failed_later", [{ passed: false, failure: failingAt(PAGE_FILE, 9) }], "failed_later"],
  ] as const) {
    test(`an interrupt while the ${name} edit awaits the service puts the file back and exits non-zero`, async () => {
      const svc = new FakeService([reply("try", candidate(root)), reply("healed", candidate(root), { reason: "later_locator" })]);
      const signals = new EventEmitter();
      const exits: number[] = [];
      let during = "";
      let listeners = 0;
      svc.handler = (req) => {
        if (!req.path.endsWith("/result")) return undefined;
        expect(req.body).toMatchObject({ test_outcome: expected });
        expect(read(root)).toContain(TO); // the edit is on disk while the service judges it
        listeners = signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM");
        signals.emit("SIGTERM");
        during = read(root);
        return undefined;
      };
      await healer(root, svc, scripted(...runs) as never, new FakeLive(), { signals, exit: (c: number) => exits.push(c) }).heal(failureFor(root));
      expect(listeners).toBe(2);
      expect(exits).toEqual([143]);
      expect(during).toBe(PAGE_SRC);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(signals.listenerCount(sig)).toBe(0); // removed after the answer
    });
  }

  test("the handlers are removed when the round throws, and when no edit is made", async () => {
    const signals = new EventEmitter();
    const svc = new FakeService([reply("try", candidate(root))]);
    svc.handler = (req) => (req.path.endsWith("/result") ? new Response("{}", { status: 503 }) : undefined);
    await healer(root, svc, scripted({ passed: true, failure: null }) as never, new FakeLive(), { signals }).heal(failureFor(root));
    expect(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => signals.listenerCount(s))).toEqual([0, 0, 0]);
    expect(read(root)).toBe(PAGE_SRC);
  });
});

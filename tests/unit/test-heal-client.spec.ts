/**
 * Unit tests: scripts/heal-client.mjs - request building, patch safety, the try -> result loop.
 *
 * The heal service is a fake (a scripted fetch) and the live page is a stub, so every decision the client makes is tested
 * without a browser, a model or a network: what it sends, which patches it refuses and why, that a wrong count or element never
 * edits a file, that a failed re-run reverts, and that a service error becomes a needs_human decision instead of a crash.
 * A port of the Python client's tests/unit/test_heal_client.py.
 *
 * @tags @unit
 */
import { test, expect } from "@playwright/test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  Healer, HealServiceError, buildLocator, checkReplacement, collectSource, matchRef, routeFromSource,
  runTotal, settingsFromEnv, splitSelectors, stackFromFailure, testId,
} from "../../scripts/heal-client.mjs";
import { callKey, mergeInto } from "../../scripts/heal-fingerprints.mjs";
import {
  FROM, FakeLive, FakeService, OTHER_SRC, PAGE_FILE, PAGE_SRC, TO, Verify, candidate, failureFor, healer,
  makeProject, patchFor, read, reply, sha,
} from "./heal-helpers.js";

let root = "";
test.beforeEach(() => {
  root = makeProject();
});
test.afterEach(() => rmSync(root, { recursive: true, force: true }));

const ROOTS = ["pages", "tests", "utils"];

// ---- request building ----------------------------------------------------------------------------------------------------
test.describe("request", { tag: ["@unit", "@regression"] }, () => {
  test("sends stack files under roots with hash and the page evidence", async () => {
    const svc = new FakeService([reply("not_drift")]);
    const d = await healer(root, svc, new Verify()).heal(failureFor(root));
    const body = svc.posts("/v1/heal")[0];
    expect(body.source.files.map((f: { path: string }) => f.path)).toEqual([PAGE_FILE, "tests/login.spec.ts"]);
    expect(body.source.files[0].sha256).toBe(sha(PAGE_SRC));
    expect(body.source.files[0].content).toBe(PAGE_SRC);
    expect(body.source.roots).toEqual(["pages", "tests", "utils", "fixtures"]);
    expect(body.failure.stack).toEqual([{ file: PAGE_FILE, line: 8 }, { file: "tests/login.spec.ts", line: 4 }]);
    expect(body.test).toEqual({ id: "tests/login.spec.ts::valid login", title: "valid login" });
    expect(body.client).toEqual({ framework: "playwright-ai-framework-ts", language: "typescript", version: "1.2.3" });
    expect(body.page.language.html_lang).toBe("en");
    expect(body.page.url).toBe("/login");
    expect(body.page.screenshot).toBeNull();
    expect(body.options).toEqual({ vision: "off", max_rounds: 3, locale_branching: true });
    expect(body.test_id_attribute).toBe("data-testid");
    expect(body.run.id).toBe("r1");
    expect(d.outcome).toBe("not_drift");
  });

  test("never carries a value, cookie, storage or image key", async () => {
    const svc = new FakeService([reply("not_drift")]);
    await healer(root, svc, new Verify()).heal(failureFor(root));
    const stack: unknown[] = [svc.posts("/v1/heal")[0]];
    const bad = new Set(["value", "cookie", "cookies", "storage", "storage_state", "png_base64", "data"]);
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...node);
      else if (node && typeof node === "object") {
        for (const k of Object.keys(node)) expect(bad.has(k.toLowerCase())).toBe(false);
        stack.push(...Object.values(node));
      }
    }
  });

  test("the token is sent as a bearer header", async () => {
    const svc = new FakeService([reply("not_drift")]);
    const h = new Healer(svc.client("tok"), settingsFromEnv({}), new Verify().fn, { root, liveFactory: () => new FakeLive() });
    await h.heal(failureFor(root));
    expect(new Set(svc.requests.map((r) => r.auth))).toEqual(new Set(["Bearer tok"]));
  });

  test("files outside the roots are not sent", async () => {
    writeFileSync(path.join(root, "conftest.ts"), "export const x = 1;\n");
    const frames = stackFromFailure({
      title: "t", error: "",
      stack: `    at ${root}/conftest.ts:3:1\n    at /etc/passwd.ts:1:1\n    at ../escape.ts:1:1\n    at ${root}/pages/login-page.ts:8:1\n`,
    }, ROOTS, root);
    expect(frames).toEqual([{ file: PAGE_FILE, line: 8 }]);
    expect(collectSource(frames, ROOTS, root).map((f) => f.path)).toEqual([PAGE_FILE]);
  });

  test("the report's location joins the stack when the stack text lacks it", () => {
    const frames = stackFromFailure({ title: "t", error: "", stack: "", location: { file: `${root}/pages/login-page.ts`, line: 8 } }, ROOTS, root);
    expect(frames).toEqual([{ file: PAGE_FILE, line: 8 }]);
  });

  test("caps twenty files and 256 KB each", () => {
    for (let i = 0; i < 25; i++) writeFileSync(path.join(root, `pages/p${i}.ts`), "export const x = 1;\n");
    writeFileSync(path.join(root, "pages/big.ts"), "#".repeat(256 * 1024 + 1));
    writeFileSync(path.join(root, "pages/edge.ts"), "#".repeat(256 * 1024));
    const stack = [...Array.from({ length: 25 }, (_, i) => ({ file: `pages/p${i}.ts`, line: 1 })),
      { file: "pages/big.ts", line: 1 }, { file: "pages/edge.ts", line: 1 }];
    const files = collectSource(stack, ["pages"], root);
    expect(files).toHaveLength(20);
    expect(files.map((f) => f.path)).not.toContain("pages/big.ts");
    expect(files.map((f) => f.path)).not.toContain("pages/edge.ts"); // past the 20-file cap
    expect(collectSource(stack.slice(-2), ["pages"], root).map((f) => f.path)).toEqual(["pages/edge.ts"]);
  });

  test("a symlink that leaves the repo is not sent", () => {
    const outside = path.join(makeProject(), "secret.ts");
    writeFileSync(outside, "export const TOKEN = 1;\n");
    symlinkSync(outside, path.join(root, "pages/link.ts"));
    expect(collectSource([{ file: "pages/link.ts", line: 1 }], ["pages"], root)).toEqual([]);
  });

  test("the test id is the spec file and title", () => {
    expect(testId(failureFor(root), root)).toBe("tests/login.spec.ts::valid login");
    expect(testId({ title: "t", error: "" }, root)).toBe("::t".replace(/^::/, ""));
  });

  test("the route comes from a page object's url, then goto, else nothing", () => {
    expect(routeFromSource(PAGE_SRC)).toBe("/login");
    expect(routeFromSource("await page.goto('/secure?x=1');")).toBe("/secure");
    expect(routeFromSource('readonly url = "https://app.example/a/b";')).toBe("/a/b");
    expect(routeFromSource("await page.goto(BASE + 'index.html');")).toBeNull();
  });

  test("the error text is cleaned: colour codes and the repository path go, long lines are cut", async () => {
    const svc = new FakeService([reply("not_drift")]);
    const f = failureFor(root);
    f.error = `\u001b[31mError at ${root}/pages/x.ts\u001b[39m\n${"a".repeat(20_000)}`;
    await healer(root, svc, new Verify()).heal(f);
    const sent = svc.posts("/v1/heal")[0].failure.error as string;
    expect(sent).not.toContain(root);
    expect(sent).not.toContain("\u001b");
    expect(Math.max(...sent.split("\n").map((l) => l.length))).toBeLessThanOrEqual(8000);
  });

  test("last pass and its route come from the fingerprint file", async () => {
    const key = callKey(PAGE_FILE, "await this.page.locator('#username').fill(user);");
    await mergeInto(root, {
      [key]: { file: PAGE_FILE, text: "x", page: "/secure/login", language: "fr", fingerprint: { tag: "input", attrs: { id: "username" } } },
      "tests/x.ts::b": { file: "tests/x.ts", text: "b", page: "/secure/login", language: "fr", fingerprint: { tag: "button", text: "Go" } },
      "tests/x.ts::c": { file: "tests/x.ts", text: "c", page: "/elsewhere", language: "fr", fingerprint: { tag: "a" } },
    }, { HEAL_DIR: ".heal" });
    const svc = new FakeService([reply("not_drift")]);
    const routes: string[] = [];
    const h = new Healer(svc.client(), settingsFromEnv({}), new Verify().fn, {
      root, env: { HEAL_DIR: ".heal" }, liveFactory: (route: string) => (routes.push(route), new FakeLive()),
    });
    await h.heal(failureFor(root));
    const lp = svc.posts("/v1/heal")[0].last_pass;
    expect(routes).toEqual(["/secure/login"]);
    expect(lp).not.toHaveProperty("_page");
    expect(lp.fingerprint).toEqual({ tag: "input", attrs: { id: "username" } });
    expect(lp.language).toBe("fr");
    expect(lp.neighbours).toEqual([{ tag: "button", text: "Go" }]); // same page only
  });

  test("the route falls back to the failure-time page, then the page object's url, then root", async () => {
    const run = async (failure: ReturnType<typeof failureFor>) => {
      const routes: string[] = [];
      const svc = new FakeService([reply("not_drift")]);
      await new Healer(svc.client(), settingsFromEnv({}), new Verify().fn, {
        root, env: { HEAL_DIR: ".heal" }, liveFactory: (r: string) => (routes.push(r), new FakeLive()),
      }).heal(failure);
      return routes;
    };
    expect(await run({ ...failureFor(root), route: "/at-failure" })).toEqual(["/at-failure"]);
    expect(await run(failureFor(root))).toEqual(["/login"]);
    writeFileSync(path.join(root, PAGE_FILE), "export const a = this.page.locator('#username');\n");
    expect(await run({ ...failureFor(root), stack: `    at ${root}/${PAGE_FILE}:1:1\n` })).toEqual(["/"]);
  });
});

// ---- the loop ------------------------------------------------------------------------------------------------------------
test.describe("loop", { tag: ["@unit", "@regression"] }, () => {
  test("healed keeps the edit after a check, a re-run and a report", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("healed", candidate(root))]);
    const verify = new Verify(root, [true]);
    const h = healer(root, svc, verify);
    const d = await h.heal(failureFor(root));
    const text = read(root);
    expect(d).toMatchObject({ outcome: "healed", file: PAGE_FILE, from: FROM, to: TO });
    expect(text.split(TO)).toHaveLength(2); // only the diagnosed occurrence changed
    expect(text.split(FROM)).toHaveLength(2);
    expect(verify.seen[0]).toContain(TO); // the re-run saw the edited file
    expect(svc.posts("/result")).toEqual([{ count: 1, hit: { ref: "e0" }, test_outcome: "passed" }]);
    expect(h.live.asked).toEqual([TO]);
    expect(h.live.closed).toBe(true);
    expect(d.usage).toEqual({ calls: 1, input_tokens: 100, output_tokens: 9, images: 0 });
  });

  test("a wrong count edits nothing and tries the next candidate", async () => {
    const live = new FakeLive({ [TO]: [2, null] });
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "no_candidate_left", why: "none left" })]);
    const verify = new Verify();
    const d = await healer(root, svc, verify, live).heal(failureFor(root));
    expect(read(root)).toBe(PAGE_SRC);
    expect(verify.calls).toBe(0);
    expect(svc.posts("/result")).toEqual([{ count: 2 }]);
    expect(d).toMatchObject({ outcome: "needs_human", reason: "no_candidate_left" });
  });

  test("a wrong element edits nothing and names the hit", async () => {
    const live = new FakeLive({ [TO]: [1, "e5"] });
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "max_rounds" })]);
    const verify = new Verify();
    await healer(root, svc, verify, live).heal(failureFor(root));
    expect(read(root)).toBe(PAGE_SRC);
    expect(verify.calls).toBe(0);
    expect(svc.posts("/result")).toEqual([{ count: 1, hit: { ref: "e5" } }]);
  });

  test("a hit that cannot be named is not a pass", async () => {
    const live = new FakeLive({ [TO]: [1, null] });
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
    const verify = new Verify();
    await healer(root, svc, verify, live).heal(failureFor(root));
    expect(verify.calls).toBe(0);
    expect(svc.posts("/result")).toEqual([{ count: 1 }]);
  });

  test("a failed re-run reverts and reports failed, then moves on", async () => {
    const second = candidate(root, { to: "this.page.locator('#user')" });
    const svc = new FakeService([reply("try", candidate(root)), reply("try", second, { rnd: 2 }), reply("healed", second, { rnd: 2 })]);
    const verify = new Verify(root, [false, true]);
    const d = await healer(root, svc, verify).heal(failureFor(root));
    expect(verify.seen[0]).toContain(TO);
    expect(verify.seen[1]).toContain("#user");
    const text = read(root);
    expect(text).not.toContain(TO); // the first try was reverted before the second
    expect(text.split("locator('#user')")).toHaveLength(2);
    expect(svc.posts("/result").map((r) => r.test_outcome)).toEqual(["failed", "passed"]);
    expect(d).toMatchObject({ outcome: "healed", to: "this.page.locator('#user')" });
  });

  test("every candidate failing leaves the file as it was", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "max_rounds", why: "rounds" })]);
    const d = await healer(root, svc, new Verify(root, [false])).heal(failureFor(root));
    expect(read(root)).toBe(PAGE_SRC);
    expect(d.outcome).toBe("needs_human");
  });

  test("a pass the service does not confirm is reverted", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "odd" })]);
    const d = await healer(root, svc, new Verify(root, [true])).heal(failureFor(root));
    expect(read(root)).toBe(PAGE_SRC);
    expect(d.outcome).toBe("needs_human");
  });

  test("losing the service after a pass reverts the edit", async () => {
    const svc = new FakeService([reply("try", candidate(root))]);
    svc.handler = (req) => (req.path.endsWith("/result") ? new Response(JSON.stringify({ detail: "down" }), { status: 503 }) : undefined);
    const d = await healer(root, svc, new Verify(root, [true])).heal(failureFor(root));
    expect(read(root)).toBe(PAGE_SRC);
    expect(d).toMatchObject({ outcome: "needs_human", reason: "service_error" });
    expect(d.why).toContain("503");
  });

  test("a crash in the re-run reverts", async () => {
    const svc = new FakeService([reply("try", candidate(root))]);
    const d = await healer(root, svc, async () => {
      throw new Error("playwright vanished");
    }).heal(failureFor(root));
    expect(read(root)).toBe(PAGE_SRC);
    expect(d).toMatchObject({ outcome: "needs_human", reason: "client_error" });
    expect(d.why).toContain("playwright vanished");
  });

  test("extra patches apply with the main patch in one go", async () => {
    const also = [patchFor(root, { nth: 1 }), patchFor(root, { file: "pages/other-page.ts" })];
    const cand = candidate(root, { also });
    const svc = new FakeService([reply("try", cand), reply("healed", cand)]);
    const d = await healer(root, svc, new Verify(root, [true])).heal(failureFor(root, ["pages/other-page.ts:1:1"]));
    expect(read(root).split(TO)).toHaveLength(3);
    expect(read(root, "pages/other-page.ts")).toBe(OTHER_SRC.replace(FROM, TO));
    expect(d.outcome).toBe("healed");
    expect([...(d.files ?? [])].sort()).toEqual([PAGE_FILE, "pages/other-page.ts"]);
  });

  test("a service error becomes a decision, not a crash", async () => {
    const d = await healer(root, new FakeService([], 500), new Verify()).heal(failureFor(root));
    expect(d).toMatchObject({ outcome: "needs_human", reason: "service_error" });
    expect(d.why).toContain("500");
    expect(d.why).toContain("boom");
  });

  test("an unreachable service becomes a decision", async () => {
    const svc = new FakeService();
    svc.fetch = async () => {
      throw new TypeError("refused");
    };
    const d = await healer(root, svc, new Verify()).heal(failureFor(root));
    expect(d).toMatchObject({ outcome: "needs_human", reason: "service_error" });
    expect(d.why).toContain("could not be reached");
  });

  test("a browser failure becomes a decision", async () => {
    const h = new Healer(new FakeService().client(), settingsFromEnv({}), new Verify().fn, {
      root, liveFactory: () => {
        throw new Error("chromium missing");
      },
    });
    const d = await h.heal(failureFor(root));
    expect(d).toMatchObject({ outcome: "needs_human", reason: "client_error" });
  });

  test("needs_human and not_drift carry the service's reason", async () => {
    const svc = new FakeService([reply("needs_human", null, { reason: "target_missing", why: "no element could be the one" })]);
    const d = await healer(root, svc, new Verify()).heal(failureFor(root));
    expect(d).toMatchObject({ outcome: "needs_human", reason: "target_missing" });
    expect(d.why).toContain("no element");
  });

  test("runTotal sums usage", () => {
    expect(runTotal([{ usage: { calls: 1, input_tokens: 100, output_tokens: 9 } }, { usage: {} }, {}])).toEqual({
      calls: 1, input_tokens: 100, output_tokens: 9, images: 0,
    });
  });

  test("a malformed candidate is a service error, and a hostile heal id is never put in a path", async () => {
    const broken = new FakeService([reply("try", { code: 5 })]);
    expect(await healer(root, broken, new Verify()).heal(failureFor(root))).toMatchObject({ reason: "service_error" });
    const hostile = new FakeService([reply("try", candidate(root), { heal_id: "../../admin?x=" })]);
    const d = await healer(root, hostile, new Verify()).heal(failureFor(root));
    expect(d).toMatchObject({ outcome: "needs_human", reason: "service_error" });
    expect(hostile.requests.filter((r) => r.path.endsWith("/result"))).toEqual([]);
  });
});

// ---- patch safety refusals -----------------------------------------------------------------------------------------------
test.describe("patch safety", { tag: ["@unit", "@security", "@regression"] }, () => {
  async function run(cand: Record<string, unknown>, ...later: Record<string, unknown>[]) {
    const svc = new FakeService([reply("try", cand), ...later]);
    const verify = new Verify(root);
    const d = await healer(root, svc, verify).heal(failureFor(root));
    return { d, svc, verify };
  }

  test("a stale base hash is refused and ends the heal", async () => {
    const { d, svc, verify } = await run(candidate(root, { base: "0".repeat(64) }));
    expect(read(root)).toBe(PAGE_SRC);
    expect(d).toMatchObject({ outcome: "needs_human", reason: "patch_refused" });
    expect(d.why).toContain("base hash");
    expect(verify.calls).toBe(0);
    expect(svc.posts("/result")[0].error).toContain("patch refused");
  });

  test("a file changed after the request is refused", async () => {
    const cand = candidate(root);
    writeFileSync(path.join(root, PAGE_FILE), PAGE_SRC + "// edited meanwhile\n");
    const { d, verify } = await run(cand);
    expect(d.reason).toBe("patch_refused");
    expect(verify.calls).toBe(0);
    expect(read(root).endsWith("// edited meanwhile\n")).toBe(true);
  });

  for (const file of ["conftest.ts", "../outside.ts", "/etc/hosts", "pages/../conftest.ts", "scripts/heal.mjs"]) {
    test(`a file outside the source roots is refused: ${file}`, async () => {
      const cand = candidate(root);
      (cand.patch as { file: string }).file = file;
      const { d, verify } = await run(cand);
      expect(d.reason).toBe("patch_refused");
      expect(d.why).toContain("source roots");
      expect(verify.calls).toBe(0);
      expect(read(root)).toBe(PAGE_SRC);
    });
  }

  test("a file that was never sent is refused", async () => {
    const { d, verify } = await run(candidate(root, { file: "pages/other-page.ts" }));
    expect(d.reason).toBe("patch_refused");
    expect(d.why).toContain("not one of the files sent");
    expect(verify.calls).toBe(0);
  });

  test("a span that does not hold from is refused", async () => {
    const cand = candidate(root);
    (cand.patch as { span: unknown }).span = { start: 0, end: FROM.length };
    const { d, verify } = await run(cand);
    expect(d.reason).toBe("patch_refused");
    expect(d.why).toContain("span");
    expect(verify.calls).toBe(0);
    expect(read(root)).toBe(PAGE_SRC);
  });

  test("a span past the end is refused", async () => {
    const cand = candidate(root);
    (cand.patch as { span: unknown }).span = { start: 10 ** 6, end: 10 ** 6 + 3 };
    expect((await run(cand)).d.reason).toBe("patch_refused");
  });

  test("overlapping spans are refused", async () => {
    const overlap = patchFor(root, { to: "page.getByTestId('x')", frm: "page.locator('#username')" });
    const main = candidate(root);
    expect(overlap.span.start).toBe((main.patch as { span: { start: number } }).span.start + 5); // inside the main patch's span
    expect((await run(candidate(root, { also: [overlap] }))).d.reason).toBe("patch_refused");
  });

  const unsafe = [
    "require('child_process').execSync('id')", "this.page.locator('#a'); process.exit(1)",
    "this.page.getByLabel('a')\nprocess.exit(1)", "other.getByLabel('a')", "this.page.evaluate('1')",
    "this.page.getByLabel(readFileSync('/etc/passwd'))", "this.page.locator('#a').click()", "this.page.locator(`${x}`)", FROM,
  ];
  for (const bad of unsafe) {
    test(`an unsafe replacement is refused but the next candidate is still tried: ${JSON.stringify(bad)}`, async () => {
      const good = candidate(root, { to: "this.page.locator('#user')" });
      const svc = new FakeService([reply("try", candidate(root, { to: bad })), reply("try", good, { rnd: 2 }), reply("healed", good, { rnd: 2 })]);
      const verify = new Verify(root, [true]);
      const d = await healer(root, svc, verify).heal(failureFor(root));
      expect(verify.calls).toBe(1);
      expect(verify.seen[0]).toContain("#user");
      expect(d.outcome).toBe("healed");
      const first = svc.posts("/result")[0];
      expect(first.count).toBeNull();
      expect(first.error).toBeTruthy();
    });
  }

  test("an unsafe extra patch refuses the whole candidate", async () => {
    const also = [patchFor(root, { to: "require('os').cpus()", nth: 1 })];
    const svc = new FakeService([reply("try", candidate(root, { also })), reply("needs_human", null, { reason: "no_candidate_left" })]);
    const d = await healer(root, svc, new Verify(root)).heal(failureFor(root));
    expect(read(root)).toBe(PAGE_SRC); // the main patch was not applied on its own
    expect(d.outcome).toBe("needs_human");
  });

  test("an unsafe locator is not even checked in the live page", async () => {
    const live = new FakeLive();
    const svc = new FakeService([reply("try", candidate(root, { to: "require('os').cpus()" })), reply("needs_human", null, { reason: "x" })]);
    await healer(root, svc, new Verify(), live).heal(failureFor(root));
    expect(live.asked).toEqual([]);
    expect(svc.posts("/result")).toEqual([{ count: null, error: "the locator is not a safe expression" }]);
  });

  test("the framework's second check can refuse what the first accepted", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
    const live = new FakeLive();
    await healer(root, svc, new Verify(), live, { secondCheck: () => false }).heal(failureFor(root));
    expect(live.asked).toEqual([]);
    expect(svc.posts("/result")).toEqual([{ count: null, error: "the locator is not a safe expression" }]);
  });
});

// ---- language branches ---------------------------------------------------------------------------------------------------
const BR = { en: "this.page.getByLabel('Username')", fr: "this.page.getByLabel(\"Nom d'utilisateur\")" };
const BR_TO = `await byLanguage(this.page, { en: ${BR.en}, fr: ${BR.fr} })`;

test.describe("branches", { tag: ["@unit", "@regression"] }, () => {
  test("branch code checks the page-language branch and adds the helper import", async () => {
    const cand = candidate(root, { to: BR_TO, branches: BR });
    const svc = new FakeService([reply("try", cand), reply("healed", cand)]);
    const live = new FakeLive({}, "fr");
    const d = await healer(root, svc, new Verify(root, [true]), live).heal(failureFor(root));
    const text = read(root);
    expect(live.asked).toEqual([BR.fr]); // the branch of the page's language is the one checked
    expect(text).toContain(BR_TO);
    expect(text).toContain('import { byLanguage } from "../utils/heal-locale.js";\n');
    expect(text.indexOf("heal-locale")).toBeLessThan(text.indexOf("export class"));
    expect(d.outcome).toBe("healed");
  });

  test("a page language with no branch is reported as unchecked", async () => {
    const cand = candidate(root, { to: BR_TO, branches: BR });
    const svc = new FakeService([reply("try", cand), reply("needs_human", null, { reason: "max_rounds" })]);
    await healer(root, svc, new Verify(), new FakeLive({}, "de")).heal(failureFor(root));
    expect(svc.posts("/result")[0].count).toBeNull();
    expect(read(root)).toBe(PAGE_SRC);
  });

  test("each branch is validated on its own", () => {
    const badBranches = { en: BR.en, fr: "require('os').cpus()" };
    const to = `await byLanguage(this.page, { en: ${BR.en}, fr: require('os').cpus() })`;
    expect(checkReplacement(to, FROM, badBranches)).toContain("safe locator");
    expect(checkReplacement(BR_TO, FROM, BR)).toBeNull();
    expect(checkReplacement(BR_TO.replace("await ", ""), FROM, BR)).toBeNull(); // the helper's result works without the await
  });

  const mismatches: Array<[string, string]> = [
    [`await byLanguage(other, { en: ${BR.en}, fr: ${BR.fr} })`, "receiver"],
    [`await byLanguage(this.page, { en: ${BR.en}, de: ${BR.fr} })`, "languages"],
    [`await byLanguage(this.page, { en: ${BR.en}, fr: this.page.getByLabel('x') })`, "differs"],
    [`await byLanguage(this.page, { EN: ${BR.en}, fr: ${BR.fr} })`, "matching"],
    ["this.page.getByLabel('x')", "matching"],
    [`await byLanguage(this.page, { en: ${BR.en} })`, "languages"],
  ];
  mismatches.forEach(([to, why], i) => {
    test(`code that does not match its branches is refused (${i + 1}): ${why}`, () => {
      expect(checkReplacement(to, FROM, BR)).toContain(why);
    });
  });

  test("branch code without branches is refused", () => {
    expect(checkReplacement(BR_TO, FROM, null)).not.toBeNull();
  });

  test("an extra patch keeps its own receiver", () => {
    expect(checkReplacement(BR_TO.replaceAll("this.page", "page"), "page.locator('#a')", BR, false)).toBeNull();
  });

  test("a quote style that differs is not a different branch", () => {
    const br = { en: "this.page.getByLabel('Username')", fr: 'this.page.getByLabel("Nom")' };
    const to = `await byLanguage(this.page, { en: this.page.getByLabel("Username"), fr: this.page.getByLabel('Nom') })`;
    expect(checkReplacement(to, FROM, br)).toBeNull();
  });
});

// ---- walking an approved expression --------------------------------------------------------------------------------------
type Steps = Array<[string, unknown[]]>;
/** Stands in for a Playwright page: every approved method call comes back as a recorded step. */
function recorder(steps: Steps = []): { steps: Steps } {
  return new Proxy({ steps }, {
    get: (target, name) => (name === "steps" ? target.steps : (...args: unknown[]) => recorder([...target.steps, [String(name), args]])),
  });
}

test.describe("buildLocator", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("walks an approved chain", () => {
    const loc = buildLocator<{ steps: Steps }>(recorder(), "this.page.getByRole('button', { name: 'Go', exact: true }).first()");
    expect(loc?.steps).toEqual([["getByRole", ["button", { name: "Go", exact: true }]], ["first", []]]);
  });

  test("regex literals and numbers are arguments", () => {
    const loc = buildLocator<{ steps: Steps }>(recorder(), "page.getByText(/log ?in/i).nth(-1)");
    expect(loc?.steps[0][1][0]).toEqual(/log ?in/i);
    expect(loc?.steps[1]).toEqual(["nth", [-1]]);
  });

  test("page and this.page are the same receiver", () => {
    expect(buildLocator<{ steps: Steps }>(recorder(), "page.locator('#a')")?.steps).toEqual([["locator", ["#a"]]]);
  });

  for (const bad of [
    "this.page.evaluate('1')", "require('os').cpus()", "other.locator('#a')", "this.page.locator(x)",
    "this.page.locator('#a').click()", "this.page.locator(", "this.browser.locator('#a')", "this.page.locator({ __proto__: 1 })",
    "this.page.locator(/(/)",
  ]) {
    test(`anything else is never run: ${JSON.stringify(bad)}`, () => {
      expect(buildLocator(recorder(), bad)).toBeNull();
    });
  }
});

test.describe("matchRef", { tag: ["@unit", "@regression"] }, () => {
  const INV = [
    { ref: "e0", tag: "input", id: "a", box: { x: 1, y: 2, width: 3, height: 4 } },
    { ref: "e1", tag: "input", id: "b", box: { x: 9, y: 2, width: 3, height: 4 } },
  ];

  test("exact match", () => {
    expect(matchRef(INV, { tag: "input", id: "b", box: INV[1].box })).toBe("e1");
  });

  test("ignores box and frame when no exact match", () => {
    expect(matchRef(INV, { tag: "input", id: "b", frame: "f", box: null })).toBe("e1");
  });

  test("ambiguous or unknown is null", () => {
    const twin = [...INV, { ref: "e2", tag: "input", id: "b", box: null }];
    expect(matchRef(twin, { tag: "input", id: "b", box: null })).toBe("e2");
    expect(matchRef(twin, { tag: "input", id: "b", box: { x: 0, y: 0, width: 1, height: 1 } })).toBeNull();
    expect(matchRef(INV, { tag: "select" })).toBeNull();
  });
});

test.describe("settings", { tag: ["@unit", "@regression"] }, () => {
  test("defaults and options", () => {
    const s = settingsFromEnv({
      HEAL_SERVICE_URL: "http://localhost:8765/", HEAL_VISION: "AUTO", HEAL_MASK: "#pw;;.card\n[data-x='a,b']",
      HEAL_TEST_ID_ATTRIBUTE: "data-qa", BASE_URL: "http://localhost:7080",
    });
    expect([s.url, s.vision, s.testIdAttribute, s.baseUrl]).toEqual(["http://localhost:8765", "auto", "data-qa", "http://localhost:7080"]);
    expect(s.mask).toEqual(["#pw", ".card", "[data-x='a,b']"]);
    expect(settingsFromEnv({}).testIdAttribute).toBe("data-testid");
    expect(settingsFromEnv({}).vision).toBe("off");
    expect(settingsFromEnv({}).roots).toEqual(["pages", "tests", "utils", "fixtures"]);
    expect(settingsFromEnv({ HEAL_VISION: "maybe" }).vision).toBe("off");
    expect(settingsFromEnv({ HEAL_TEST_ID_ATTRIBUTE: "bad attr!" }).testIdAttribute).toBe("data-testid");
    expect(splitSelectors("a:is(b, c);; d\n\n")).toEqual(["a:is(b, c)", "d"]);
    expect(splitSelectors("a, b")).toEqual(["a, b"]); // a comma is part of a selector now
  });

  test("service errors name status and reason, never the request", async () => {
    const svc = new FakeService([], 422);
    await expect(svc.client().heal({ secret: "x" })).rejects.toThrow(/422.*boom/);
    await svc.client().heal({ secret: "x" }).catch((e: Error) => {
      expect(e).toBeInstanceOf(HealServiceError);
      expect(e.message).not.toContain("secret");
    });
  });
});

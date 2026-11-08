/**
 * Unit tests: the second security review of the heal client (oracle, route, redirect, redaction, output, decision, regex).
 *
 * One group per finding. Each test states the attack it stops: a service that reads hidden page data a character at a time through
 * candidate locators, a route that sends the heal browser to another origin, a redirect that carries the request away, secrets that
 * survive redaction, terminal and PR text that lies, a decision that does not match what was written, a regex that never finishes.
 *
 * @tags @unit @security
 */
import { test, expect } from "@playwright/test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkReplacement, hasControl, probingSelector, validateReplacement, buildLocator } from "../../scripts/heal-code.mjs";
import {
  HealServiceError, LivePage, MAX_ROUNDS, OriginGuard, ServiceClient, cleanError, planPatches, redactErrorValues, revertFiles, safeRoute,
  settingsFromEnv, writeFiles,
} from "../../scripts/heal-client.mjs";
import { cleanInventory, redactTypedValues } from "../../scripts/heal-redact.mjs";
import { mergeInto } from "../../scripts/heal-fingerprints.mjs";
import { buildPrBody, failuresOf, oneLine, printDecisions } from "../../scripts/heal.mjs";
import {
  FROM, FakeLive, FakeService, PAGE_FILE, PAGE_SRC, TO, Verify, candidate, failureFor, healer, makeProject, read, reply, sha,
} from "./heal-helpers.js";

let root = "";
test.beforeEach(() => {
  root = makeProject();
});
test.afterEach(() => rmSync(root, { recursive: true, force: true }));
const O = "page.locator('#a')";

test.describe("M1 oracle", { tag: ["@unit", "@security", "@regression"] }, () => {
  const probing = [
    "input[name=csrf][value^='ab']", "input[value*='x']", "[data-k$='z']", "[data-k~='z']", "[data-k|='z']", "[value='x']", "input[value=x]",
    "div:has-text('secret')", "input:text('x')", "input[type=hidden]", "input[type='hidden']",
  ];
  for (const sel of probing) {
    test(`a probing selector is refused: ${sel}`, () => {
      expect(probingSelector(sel)).toBe(true);
      expect(validateReplacement(`page.locator(${JSON.stringify(sel)})`, O)).toBeNull();
      expect(checkReplacement(`page.locator(${JSON.stringify(sel)})`, O)).not.toBeNull();
      expect(buildLocator({ locator: () => ({}) }, `page.locator(${JSON.stringify(sel)})`)).toBeNull();
    });
  }
  for (const sel of ["[data-qa='x']", '[data-qa="order-row-1"]', "input[name=user]", "#user-name", "tr[data-row=a] td", "[data-qa=status]"]) {
    test(`a selector the service writes still passes: ${sel}`, () => {
      expect(probingSelector(sel)).toBe(false);
      expect(validateReplacement(`page.locator(${JSON.stringify(sel)})`, O)).not.toBeNull();
    });
  }

  test("rounds are capped by the client, and a healed answer ends the loop", async () => {
    const tries = Array.from({ length: 8 }, (_, i) => reply("try", candidate(root, { to: `this.page.locator('#u${i}')` }), { rnd: i + 1 }));
    const svc = new FakeService(tries);
    const live = new FakeLive({}, "en", [{ ref: "e0", tag: "input" }]);
    live.check = async (e: string) => (live.asked.push(e), [1, "e9"]);
    const d = await healer(root, svc, new Verify(), live).heal(failureFor(root));
    expect(live.asked).toHaveLength(MAX_ROUNDS);
    expect(svc.posts("/result")).toHaveLength(MAX_ROUNDS);
    expect(d).toMatchObject({ outcome: "needs_human", reason: "max_rounds" });
  });

  test("a failed expected-ref check reports a coarse count (0, 1 or 2 for more than one)", async () => {
    for (const [n, want] of [[0, 0], [1, 1], [7, 2], [4000, 2]] as const) {
      const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
      await healer(root, svc, new Verify(), new FakeLive({ [TO]: [n, null] })).heal(failureFor(root));
      expect(svc.posts("/result")[0]).toEqual({ count: want });
    }
  });

  test("a count that never answers is cannot-check, not a hang", async () => {
    const live = new LivePage(settingsFromEnv({ BASE_URL: "http://localhost:1" }), "/", "probe");
    live.page = { locator: () => ({ count: () => new Promise(() => undefined) }) };
    const t0 = Date.now();
    expect(await live.check("page.locator('#a')")).toEqual([null, null]);
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});

test.describe("M2 route", { tag: ["@unit", "@security", "@regression"] }, () => {
  const base = "http://app.example:8080";
  for (const bad of ["//evil.example/x", "http://evil.example/", "https://app.example:8080/", "\\\\evil.example", "/a\\b", "/a\nb", "/a b", "javascript:alert(1)", "", null, 5, "/\u0085x"]) {
    test(`a route that is not a same-origin path is refused: ${JSON.stringify(bad)}`, () => {
      expect(safeRoute(bad as string, base)).toBeNull();
    });
  }
  test("a path stays", () => {
    expect(safeRoute("/app/index.html", base)).toBe("/app/index.html");
    expect(safeRoute("/", base)).toBe("/");
  });

  test("a hostile route from the failure is not opened: the heal opens / instead", async () => {
    const routes: string[] = [];
    const svc = new FakeService([reply("not_drift")]);
    const f = { ...failureFor(root), route: "//evil.example/admin" };
    const h = healer(root, svc, new Verify(), new FakeLive(), { liveFactory: (r: string) => (routes.push(r), new FakeLive()) });
    await h.heal(f);
    expect(routes).toEqual(["/login"]); // the page object's own url, a clean path
  });

  test("the guard blocks foreign origins for the whole session, with an allow list", () => {
    const g = new OriginGuard("http://app.example", { always: true, allow: ["https://cdn.example"] });
    expect(g.foreign("http://evil.example/x")).toBe(true);
    expect(g.foreign("https://cdn.example/lib.js")).toBe(false);
    expect(g.foreign("http://app.example/x")).toBe(false);
    expect(g.foreign("data:text/plain,x")).toBe(false);
    expect(g.foreign("ws://evil.example/")).toBe(true);
  });
});

test.describe("M3 redirect", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("fetch is told to refuse a redirect, so the request and the token stay with the configured host", async () => {
    let init: RequestInit | undefined;
    const client = new ServiceClient("https://svc.example", "tok", { fetchImpl: (async (_u: unknown, i: RequestInit) => ((init = i), new Response("{}", { status: 200 }))) as typeof fetch, env: {} });
    await client.heal({});
    expect(init?.redirect).toBe("error");
    const failing = new ServiceClient("https://svc.example", "tok", { fetchImpl: (async () => { throw new TypeError("redirect mode is set to error"); }) as typeof fetch, env: {} });
    await expect(failing.heal({})).rejects.toBeInstanceOf(HealServiceError);
  });
  test("a heal id is a plain token: dots and slashes never reach the path", async () => {
    const client = new ServiceClient("https://svc.example", "", { fetchImpl: (async () => new Response("{}")) as typeof fetch, env: {} });
    for (const id of ["..", ".", "../x", "a/b", "a%2Fb", "", "a".repeat(101), ".hidden"]) await expect(client.result(id, {})).rejects.toThrow(/bad heal id/);
    await client.result("h_ok:1-2", {});
  });
});

test.describe("M4 redaction", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("the query and fragment of a url line go", () => {
    const out = redactTypedValues('- link "Reset":\n  - /url: /reset?token=SECRET#frag\n- link "B":\n  - /url: https://x.example/p?a=1\n');
    expect(out).not.toMatch(/SECRET|a=1|frag/);
    expect(out).toContain("/url: /reset\n");
    expect(out).toContain("/url: https://x.example/p\n");
  });
  test("the name of a selected option goes, an unselected one stays", () => {
    const out = redactTypedValues('- combobox "Plan":\n  - option "Gold" [selected]\n  - option "Silver"\n');
    expect(out).not.toContain("Gold");
    expect(out).toContain('option "Silver"');
    expect(out).toContain("option [selected]");
  });
  test("secret-looking data attributes are dropped", () => {
    const keys = Object.keys(cleanInventory([{
      data_otp: "1", data_pin: "2", data_api_key: "3", data_jwt: "4", data_ssn: "5", data_card_number: "6", data_cvv: "7", data_passcode: "8",
      data_shipping: "kept", data_mapping: "kept", data_row: "kept",
    }])[0]);
    expect(keys.sort()).toEqual(["data_mapping", "data_row", "data_shipping"]);
  });
  test("Received / Expected values and fill() frames leave the error text; the locator and call log stay", () => {
    const text = [
      "Error: expect(locator).toHaveText(expected)", "Locator: getByTestId('summary')", 'Expected: "SECRET-EXPECTED"', "Received string: \"SECRET-RECEIVED\"",
      "Call log:", "  - waiting for getByLabel('Password')", "> 12 | await page.getByLabel('Password').fill('hunter2');", '  13 | await x.type("abc123");',
      "  14 | await page.press(`Enter`);",
    ].join("\n");
    const out = redactErrorValues(text);
    for (const leaked of ["SECRET-EXPECTED", "SECRET-RECEIVED", "hunter2", "abc123"]) expect(out).not.toContain(leaked);
    expect(out).toContain("Locator: getByTestId('summary')");
    expect(out).toContain("waiting for getByLabel('Password')");
    expect(out).toContain("fill(<redacted>");
    expect(cleanError(text, root)).not.toContain("hunter2");
  });
});

test.describe("L5 surrogates", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("a lone surrogate is not text, and a pair is", () => {
    expect(hasControl("a\ud800b")).toBe(true);
    expect(hasControl("\udc00")).toBe(true);
    expect(hasControl("café \u{1F600}")).toBe(false);
    expect(validateReplacement('page.locator("\ud800")', O)).toBeNull();
    expect(checkReplacement('page.getByText("\ud800x")', O)).not.toBeNull();
  });
});

test.describe("L6 output", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("escape sequences and bidi characters never reach the terminal", () => {
    expect(oneLine("a\u001b[31mred\u001b]52;c;x\u0007 ‮evil⁦")).toBe("a [31mred ]52;c;x evil");
    const lines: string[] = [];
    printDecisions([{ test: "t", outcome: "needs_human", reason: "r\u001b[31m", why: "\u001b[2J fake‮", usage: { calls: "x" as never } }] as never[], (l) => lines.push(l));
    // eslint-disable-next-line no-control-regex
    expect(lines.join("\n")).not.toMatch(/[\u001b‮]/);
    expect(lines.join("\n")).toContain("0 call(s)");
  });
  test("service text in a PR body sits in code spans: no autolink, no link, no bidi", () => {
    const body = buildPrBody([{ test: "t", from: "a", to: "b", why: "see https://evil.example/login or www.evil.example ‮evil" }] as never[], [{ test: "u", why: "https://evil.example" }] as never[]);
    for (const m of body.matchAll(/https?:\/\/\S+|www\.\S+/g)) {
      const before = body.slice(0, m.index);
      expect(before.split("`").length % 2, `inside a code span: ${m[0]}`).toBe(0);
    }
    expect(body).not.toContain("‮");
  });
  test("a decision holds capped strings and plain numbers whatever the service sent", async () => {
    const deep = { a: [{ b: [1] }] }; // not a string, not a number
    const svc = new FakeService([{ heal_id: "h_1", status: "needs_human", reason: deep, why: "x".repeat(10_000), usage: { calls: "9", input_tokens: deep }, round: {}, settled_at: [] }]);
    const d = await healer(root, svc, new Verify()).heal(failureFor(root));
    expect(d.reason).toBeNull();
    expect((d.why as string).length).toBeLessThanOrEqual(300);
    expect(d.usage).toEqual({ calls: 9, input_tokens: 0, output_tokens: 0, images: 0 });
    expect(JSON.stringify(d).length).toBeLessThan(2000);
  });
});

test.describe("L7 decision from what was written", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("a healed answer with a different or empty candidate does not change the decision or leave the edit unreported", async () => {
    const svc = new FakeService([reply("try", candidate(root)), { heal_id: "h_1", status: "healed", candidate: {}, usage: {} }]);
    const d = await healer(root, svc, new Verify(root, [true])).heal(failureFor(root));
    expect(d).toMatchObject({ outcome: "healed", file: PAGE_FILE, from: FROM, to: TO, files: [PAGE_FILE] });
    expect(read(root)).toContain(TO);
  });
});

test.describe("L8 and notes: writes", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("a file edited between the plan and the write is not overwritten, and not rolled back over", () => {
    const planned = planPatches(candidate(root), { [PAGE_FILE]: sha(PAGE_SRC) }, ["pages"], root);
    writeFileSync(path.join(root, PAGE_FILE), PAGE_SRC + "// a person's edit\n");
    expect(() => writeFiles(root, planned)).toThrow(/changed since the patch was planned/);
    expect(read(root)).toBe(PAGE_SRC + "// a person's edit\n");
    expect(() => revertFiles(root, planned)).toThrow(/changed by someone else/);
    expect(read(root)).toBe(PAGE_SRC + "// a person's edit\n");
  });
  test("a revert undoes our own edit, and does nothing when the file was never written", () => {
    const planned = planPatches(candidate(root), { [PAGE_FILE]: sha(PAGE_SRC) }, ["pages"], root);
    revertFiles(root, planned);
    expect(read(root)).toBe(PAGE_SRC);
    chmodSync(path.join(root, PAGE_FILE), 0o640);
    writeFiles(root, planned);
    revertFiles(root, planned);
    expect(read(root)).toBe(PAGE_SRC);
  });
  test("inputs for cards, one-time codes and passwords are masked by default in a screenshot", async () => {
    const live = new LivePage(settingsFromEnv({ BASE_URL: "http://localhost:1", HEAL_VISION: "on" }), "/", "probe");
    const asked: string[] = [];
    const main = { url: () => "http://localhost:1/", locator: (s: string) => (asked.push(s), s), evaluate: async () => undefined };
    live.page = {
      url: () => "http://localhost:1/",
      mainFrame: () => main,
      frames: () => [main],
      screenshot: async () => null,
    };
    await live.screenshot();
    for (const need of ['type="password"', 'autocomplete^="cc-"', 'one-time-code', 'autocomplete*="password"', 'name*="card"', 'id*="otp"', 'name*="pwd"', 'textarea[id*="secret"']) expect(asked.some((s) => s.includes(need)), need).toBe(true);
  });
});

test.describe("L9 / N1 regex", { tag: ["@unit", "@security", "@regression"] }, () => {
  const calls = [
    "page.getByText(/a/)", "page.getByLabel(/a/i)", "page.getByRole('button', { name: /^Save/ })", "page.getByPlaceholder(/a/)",
    "page.getByTitle(/a/)", "page.getByAltText(/a/)", "page.locator('tr').filter({ hasText: /x/ })", "page.locator('tr', { hasText: /x/ })",
    "page.getByText(/^(a+)+$/)", "page.getByText(/^a*a*a*a*a*a*a*a*$/)", `page.getByText(/${"a".repeat(250)}/)`,
  ];
  calls.forEach((c, i) => {
    test(`a regex argument is refused outright (${i + 1}): ${c.slice(0, 50)}`, () => {
      expect(validateReplacement(c, O)).toBeNull();
      expect(checkReplacement(c, O)).not.toBeNull();
      expect(buildLocator({ locator: () => ({}), getByText: () => ({}) }, c)).toBeNull();
    });
  });
  test("exact strings stay", () => {
    expect(validateReplacement("page.getByText('log in', { exact: true })", O)).not.toBeNull();
    expect(validateReplacement("page.getByRole('button', { name: 'Save', exact: true })", O)).not.toBeNull();
  });
});

test.describe("route from the report attachment", { tag: ["@unit", "@security", "@regression"] }, () => {
  const report = (route: string) => ({
    config: { rootDir: "/repo/tests" },
    suites: [{ file: "t.spec.ts", specs: [{ title: "t", file: "t.spec.ts", tests: [{ status: "unexpected", results: [{
      status: "failed", errors: [{ message: "e" }], attachments: [{ name: "heal-page-url", body: Buffer.from(route).toString("base64") }],
    }] }] }] }],
  });
  for (const [route, want] of [["/app/index.html", "/app/index.html"], ["//evil.example/x", null], ["http://evil.example/", null], ["/a\\b", null]] as const) {
    test(`failuresOf reads ${JSON.stringify(route)} as ${JSON.stringify(want)}`, () => {
      expect(failuresOf(report(route) as never, "http://app.example")[0].route).toBe(want);
    });
  }
});

test.describe("fingerprint lock", { tag: ["@unit", "@security", "@regression"] }, () => {
  const rec = { file: "pages/p.ts", text: "a", page: "/", language: "en", fingerprint: { tag: "a" } };
  test("the lock file holds the holder's pid while it is held, and is gone after", async () => {
    let seen = "";
    const dir = path.join(root, ".heal");
    const slow = mergeInto(root, { a: rec }, { HEAL_DIR: ".heal" });
    for (let i = 0; i < 50 && !seen; i++) {
      if (existsSync(path.join(dir, ".lock"))) seen = readFileSync(path.join(dir, ".lock"), "utf8");
      await new Promise((r) => setTimeout(r, 1));
    }
    await slow;
    if (seen) expect(seen).toBe(String(process.pid));
    expect(existsSync(path.join(dir, ".lock"))).toBe(false);
  });
  test("a lock whose process is gone is taken over by rename, once, and no stale file is left", async () => {
    const dir = path.join(root, ".heal");
    mkdirSync(dir);
    writeFileSync(path.join(dir, ".lock"), "999999"); // no such pid, and the file is fresh
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => mergeInto(root, { [`k${i}`]: { ...rec, text: `t${i}` } }, { HEAL_DIR: ".heal" })));
    expect(results.every(Boolean)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(path.join(dir, "fingerprints.json"), "utf8")).entries)).toHaveLength(6);
    expect(readdirSync(dir).filter((f) => f.includes("stale") || f === ".lock")).toEqual([]);
  });
  test("an old lock is stale even when its pid is alive, a fresh live one is respected", async () => {
    const dir = path.join(root, ".heal");
    mkdirSync(dir);
    const lock = path.join(dir, ".lock");
    writeFileSync(lock, String(process.pid));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(await mergeInto(root, { a: rec }, { HEAL_DIR: ".heal" })).toBe(true);
    writeFileSync(lock, String(process.pid)); // live and fresh: released by us after 150 ms
    setTimeout(() => rmSync(lock, { force: true }), 150);
    const t0 = Date.now();
    expect(await mergeInto(root, { b: rec }, { HEAL_DIR: ".heal" })).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });
});

test.describe("N1 oracle: engines, escapes, comments and what is reported", { tag: ["@unit", "@security", "@regression"] }, () => {
  const refused = [
    "xpath=//input[starts-with(@value,'k')]", "//input", "(//button)[1]", "../x", "css=input >> nth=0", "a >> b", "internal:attr=[value^=\"k\"i]", "text=hidden", "id=a",
    "data-testid=x", "[\\76 alue=x]", "a\\:b", "a /* c */ b", "role=button", "nth=0",
  ];
  for (const sel of refused) {
    test(`a selector the service never writes is refused: ${sel}`, () => {
      expect(validateReplacement(`page.locator(${JSON.stringify(sel)})`, O)).toBeNull();
      expect(validateReplacement(`page.locator('a', { hasText: ${JSON.stringify(sel)} })`, O)).toBeNull(); // an options object is checked too
      expect(buildLocator({ locator: () => ({}) }, `page.locator(${JSON.stringify(sel)})`)).toBeNull();
    });
  }
  test("the forms the service writes stay", () => {
    for (const ok of ["#user-name", "[data-qa='order-row-1']", 'input[data-pref="newsletter"]', "tr[data-qa=row-9]", "button.primary", "[id=\"a:b\"]"]) {
      expect(validateReplacement(`page.locator(${JSON.stringify(ok)})`, O), ok).not.toBeNull();
    }
    expect(validateReplacement("page.locator('[data-qa=row-1]').locator('[data-qa=status]')", O)).not.toBeNull();
    expect(validateReplacement("page.getByText('Save', { exact: true })", O)).not.toBeNull();
  });
  test("a candidate that is not the expected element reports a coarse count and a hit ref only when the ref is one the service was sent", async () => {
    const svc = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
    const live = new FakeLive({ [TO]: [1, "e5"] }, "en", [{ ref: "e0", tag: "input" }]);
    await healer(root, svc, new Verify(), live).heal(failureFor(root));
    expect(svc.posts("/result")[0]).toEqual({ count: 1, hit: { ref: "e5" } }); // e5 came from the inventory the live page numbered
    const svc2 = new FakeService([reply("try", candidate(root)), reply("needs_human", null, { reason: "x" })]);
    await healer(root, svc2, new Verify(), new FakeLive({ [TO]: [9, null] })).heal(failureFor(root));
    expect(svc2.posts("/result")[0]).toEqual({ count: 2 });
  });
  test("a branch candidate is checked in the branch the page's html:lang() gives, not the browser locale", async () => {
    const br = { en: "this.page.getByLabel('Username')", fr: "this.page.getByLabel('Nom')" };
    const to = `byLanguage(this.page, { en: ${br.en}, fr: ${br.fr} })`;
    const cand = candidate(root, { to, branches: br });
    const svc = new FakeService([reply("try", cand), reply("needs_human", null, { reason: "x" })]);
    const live = Object.assign(new FakeLive({}, "en"), { branchKey: async (keys: string[]) => (keys.includes("fr") ? "fr" : keys[0]) });
    await healer(root, svc, new Verify(), live).heal(failureFor(root));
    expect(live.asked).toEqual([br.fr]); // the page language reads "en"; the runtime would pick fr
  });
});

test.describe("the inventory keeps every fact the service reads", { tag: ["@unit", "@regression"] }, () => {
  test("pw_text, pw_cut, top_at_center and row_attr survive the allowlist: without them the service cannot prove a text locator unique or an element clickable", () => {
    const item = { tag: "td", text: "Echo", pw_text: "Echo GmbH paid", pw_cut: false, top_at_center: true, row: "order-row-1", row_attr: "data-qa", value: "x" };
    expect(cleanInventory([item])[0]).toEqual({ tag: "td", text: "Echo", pw_text: "Echo GmbH paid", pw_cut: false, top_at_center: true, row: "order-row-1", row_attr: "data-qa" });
  });
  test("they are still plain values: a non-string pw_text or a non-boolean flag is dropped", () => {
    expect(cleanInventory([{ tag: "a", pw_text: { x: 1 }, pw_cut: "yes", top_at_center: 1 }])[0]).toEqual({ tag: "a" });
  });
  test("every key the vendored probe lists is sent", () => {
    const probeKeys = ["tag", "type", "role", "name", "aria_label", "label", "placeholder", "id", "testid", "data_test", "data_qa", "data_cy", "class", "name_attr", "title", "alt", "text", "disabled", "hidden", "box", "row", "row_attr", "frame", "shadow", "top_at_center", "pw_text", "pw_cut"];
    const full = Object.fromEntries(probeKeys.map((k) => [k, k === "box" ? { x: 1, y: 2, width: 3, height: 4 } : k === "disabled" || k === "hidden" || k === "pw_cut" || k === "top_at_center" ? true : "v"]));
    expect(Object.keys(cleanInventory([full])[0]).sort()).toEqual(probeKeys.sort());
  });
});

test.describe("the selector and regex refusals are for what the service writes, not for the code being replaced", { tag: ["@unit", "@regression"] }, () => {
  const NEW = "page.getByText('Cobalt Inc', { exact: true })";
  const originals = [
    "page.locator('//table//tr[3]/td[2]')", "page.locator('css=a >> text=Go')", "page.locator('[data-x=\"a\\\\:b\"]')", "page.locator('a /* c */')",
    "page.getByRole('button', { name: /^Save( changes)?$/i })", "page.getByText(/(a+)+$/)", "page.locator('input[value^=\"k\"]')",
    "page.locator('//div[@id=\"app\"]/div[1]')",
  ];
  originals.forEach((orig, i) => {
    test(`an original that was written by a person is replaced (${i + 1}): ${orig.slice(0, 48)}`, () => {
      expect(checkReplacement(NEW, orig)).toBeNull();
    });
  });
  test("the replacement is still held to the strict rules, whatever the original is", () => {
    for (const bad of ["page.locator('//td')", "page.getByText(/x/)", "page.locator('a >> b')", "page.locator('[value^=k]')"]) {
      expect(checkReplacement(bad, "page.locator('//table//tr[3]/td[2]')"), bad).not.toBeNull();
    }
  });
  test("an original that is not a locator chain is still refused", () => {
    expect(checkReplacement(NEW, "page.locator('//td').click()")).not.toBeNull();
    expect(checkReplacement(NEW, "page.locator(x)")).not.toBeNull();
    expect(checkReplacement(NEW, "other.locator('//td')")).toBe("the replacement is not a safe locator expression"); // another receiver
  });
});

test.describe("an original may hold locators as arguments (filter has / hasNot), a replacement may not", { tag: ["@unit", "@regression"] }, () => {
  const NEW = "page.getByText('Row A', { exact: true })";
  for (const orig of [
    "page.locator('mat-menu').filter({ has: page.locator('button', { hasText: 'Open' }) })",
    "page.locator('.agent-option').filter({ has: page.locator('.agent-option-name', { hasText: 'Atlas' }) }).first()",
    "page.locator('select').filter({ hasNot: page.getByText('x', { exact: true }) })",
  ]) {
    test(`replaceable: ${orig.slice(0, 60)}`, () => {
      expect(checkReplacement(NEW, orig)).toBeNull();
    });
  }
  test("still not replaceable: an argument that is a call, a function or another receiver", () => {
    for (const orig of ["page.locator('a').filter({ has: foo() })", "page.locator('a').filter({ has: () => 1 })", "page.locator('a').filter({ has: other.locator('b') })", "page.locator('a').filter({ has: page.locator('b').click() })"]) {
      expect(checkReplacement(NEW, orig), orig).not.toBeNull();
    }
  });
  test("a replacement with a locator argument is still refused", () => {
    expect(checkReplacement("page.locator('a').filter({ has: page.locator('b') })", "page.locator('#x')")).not.toBeNull();
  });
});

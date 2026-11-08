/**
 * Unit tests: what a clean green run records for the heal service (scripts/heal-fingerprints.mjs, utils/heal-recorder.ts).
 *
 * No browser: a fake locator answers the probe call. Covers the key (file + normalized acting line), the facts (never a value),
 * the atomic file with its `*` .gitignore and the opt-in to commit it, the neighbours of a page, the clean-green rule (passed,
 * no retry, not flaky, not during a heal), that nothing is recorded unless HEAL_FINGERPRINTS=on, and that the file is the
 * format the Python client reads and writes.
 *
 * @tags @unit
 */
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ACTIONS, callKey, enabled, ensureIgnore, itemToFingerprint, lastPassFor, lineOf, loadStore, mergeInto, normalizeLine, pagePath,
  relativeUnder, serializeStore, sourceRoots, stackFrames,
} from "../../scripts/heal-fingerprints.mjs";
import { vendoredProbe } from "../../scripts/heal-probe.mjs";
import { recordResult, setHistoryFile } from "../../utils/stability-index.js";
import { Recorder, installRecorder, startRecording, stopRecording, type TestOutcome } from "../../utils/heal-recorder.js";

const ITEM = {
  tag: "input", type: "text", role: "", name: "Username", aria_label: "", label: "Username", placeholder: "", id: "username",
  testid: "login-user", data_test: "", data_qa: "u1", data_cy: "", class: "form-control", name_attr: "user", title: "", alt: "",
  text: "", disabled: false, hidden: false, box: { x: 410, y: 218, width: 280, height: 36 }, row: "login-form", data_section: "auth",
};
const PROBE = { items: [ITEM], more: 0, page: { path: "/login", lang: "fr-CA", browser_lang: "en-US" } };

class FakeLocator {
  calls: string[] = [];
  constructor(private data: unknown = PROBE, private frame = "", private count_ = 1) {}
  async count() {
    return this.count_;
  }
  async evaluate(script: string) {
    this.calls.push(script);
    return script.includes("frameElement") ? this.frame : this.data;
  }
}
const asLocator = (l: FakeLocator) => l as unknown as Locator;

const GREEN: TestOutcome = { status: "passed", retry: 0, tags: [], annotations: [], titlePath: ["unit", "t"] };
let tmp = "";
test.beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "heal-fp-"));
});
test.afterEach(() => {
  stopRecording();
  rmSync(tmp, { recursive: true, force: true });
});

const recorder = (env: Record<string, string> = {}) => new Recorder(process.cwd(), { HEAL_DIR: ".heal", ...env }, "(only) => 1");

test.describe("keys and facts", { tag: ["@unit", "@regression"] }, () => {
  test("the key ignores indentation, spacing and quote style", () => {
    const a = callKey("pages/p.ts", '        await  this.page.locator("#u").fill(v);  ');
    const b = callKey("pages/p.ts", "await this.page.locator('#u').fill(v);");
    expect(a).toBe(b);
    expect(a).toBe("pages/p.ts::await this.page.locator('#u').fill(v);");
    expect(normalizeLine("  a   b ")).toBe("a b");
  });

  test("lineOf reads the normalized line", () => {
    mkdirSync(path.join(tmp, "pages"));
    writeFileSync(path.join(tmp, "pages/p.ts"), 'const a = 1;\n    await this.page.locator("#u").fill(v);\n');
    expect(lineOf(tmp, "pages/p.ts", 2)).toBe("await this.page.locator('#u').fill(v);");
    expect(lineOf(tmp, "pages/p.ts", 9)).toBe("");
    expect(lineOf(tmp, "pages/none.ts", 1)).toBe("");
  });

  test("fingerprint facts are in the service shape and never a value", () => {
    const out = itemToFingerprint(ITEM, "login-frame") as Record<string, unknown>;
    expect(out).toMatchObject({ tag: "input", name: "Username", label: "Username", row: "login-form", frame: "login-frame" });
    expect(out.attrs).toEqual({
      "data-testid": "login-user", id: "username", name: "user", class: "form-control", "data-qa": "u1", "data-section": "auth",
    });
    expect(out.box).toEqual({ x: 410, y: 218, w: 280, h: 36 });
    expect(JSON.stringify(out).toLowerCase().replaceAll("data-", "")).not.toContain("value");
    expect(out).not.toHaveProperty("hidden");
    expect(out).not.toHaveProperty("disabled");
  });

  test("a hidden element has no box", () => {
    expect(itemToFingerprint({ ...ITEM, box: null })).not.toHaveProperty("box");
  });

  test("the page path drops the query and fragment", () => {
    expect(pagePath("https://app.example/login?token=abc#x")).toBe("/login");
    expect(pagePath("")).toBe("/");
  });

  test("a relative path under the roots", () => {
    const roots = ["pages", "tests"];
    expect(relativeUnder("pages/a.ts", tmp, roots)).toBe("pages/a.ts");
    expect(relativeUnder(path.join(tmp, "tests", "b.ts"), tmp, roots)).toBe("tests/b.ts");
    for (const bad of ["conftest.ts", "../pages/a.ts", "/etc/pages/a.ts", "pages/../x.ts", ""]) expect(relativeUnder(bad, tmp, roots)).toBeNull();
  });

  test("stack frames come out innermost first, under the roots only, once each", () => {
    const stack = [
      "Error: x", `    at Page.go (${tmp}/pages/a.ts:5:3)`, `    at ${tmp}/tests/b.spec.ts:10:2`, "    at node_modules/p/x.js:1:1",
      `    at Page.go (${tmp}/pages/a.ts:5:9)`, `    at file://${tmp}/pages/c.ts:2:1`,
    ].join("\n");
    expect(stackFrames(stack, tmp, ["pages", "tests"])).toEqual([
      { file: "pages/a.ts", line: 5 }, { file: "tests/b.spec.ts", line: 10 }, { file: "pages/c.ts", line: 2 },
    ]);
  });

  test("roots come from the environment", () => {
    expect(sourceRoots({})).toEqual(["pages", "tests", "utils", "fixtures"]);
    expect(sourceRoots({ HEAL_SOURCE_ROOTS: "src/pages, e2e" })).toEqual(["src/pages", "e2e"]);
    expect(sourceRoots({ HEAL_SOURCE_ROOTS: "../x" })).toEqual(["pages", "tests", "utils", "fixtures"]);
  });
});

const rec = (text = "a", page = "/login", fingerprint: Record<string, unknown> = {}) => ({
  file: "pages/p.ts", text, page, language: "en", fingerprint: { tag: "input", ...fingerprint },
});

test.describe("the file", { tag: ["@unit", "@regression"] }, () => {
  test("an atomic write creates the file and a star gitignore", async () => {
    expect(await mergeInto(tmp, { k: rec() }, {})).toBe(true);
    expect(JSON.parse(readFileSync(path.join(tmp, ".heal/fingerprints.json"), "utf8")).entries.k.page).toBe("/login");
    expect(readFileSync(path.join(tmp, ".heal/.gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(path.join(tmp, ".heal/.lock"))).toBe(false);
  });

  test("the file is the Python client's format: sorted keys, one-space indent, ASCII, a trailing newline", () => {
    const text = serializeStore({ version: 1, entries: { b: rec("é"), a: rec("a") } });
    expect(text).toBe(
      '{\n "entries": {\n  "a": {\n   "file": "pages/p.ts",\n   "fingerprint": {\n    "tag": "input"\n   },\n   "language": "en",\n' +
      '   "page": "/login",\n   "text": "a"\n  },\n  "b": {\n   "file": "pages/p.ts",\n   "fingerprint": {\n    "tag": "input"\n   },\n' +
      '   "language": "en",\n   "page": "/login",\n   "text": "\\u00e9"\n  }\n },\n "version": 1\n}\n',
    );
  });

  test("an unchanged merge does not rewrite the file", async () => {
    await mergeInto(tmp, { k: rec() }, {});
    const target = path.join(tmp, ".heal/fingerprints.json");
    const before = statSync(target).mtimeMs;
    expect(await mergeInto(tmp, { k: rec() }, {})).toBe(false);
    expect(statSync(target).mtimeMs).toBe(before);
  });

  test("merging keeps what another worker wrote, even when two merge at once", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => mergeInto(tmp, { [`k${i}`]: rec(`t${i}`) }, {})));
    expect(Object.keys(loadStore(path.join(tmp, ".heal/fingerprints.json")).entries).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `k${i}`));
  });

  test("a stale lock is taken over", async () => {
    mkdirSync(path.join(tmp, ".heal"));
    const lock = path.join(tmp, ".heal/.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(await mergeInto(tmp, { k: rec() }, {})).toBe(true);
  });

  test("committing is an opt-in, and then no ignore file is written", async () => {
    await mergeInto(tmp, { k: rec() }, { HEAL_FINGERPRINTS_COMMIT: "on" });
    expect(existsSync(path.join(tmp, ".heal/fingerprints.json"))).toBe(true);
    expect(existsSync(path.join(tmp, ".heal/.gitignore"))).toBe(false);
    ensureIgnore(path.join(tmp, ".heal"), { HEAL_FINGERPRINTS_COMMIT: "on" });
    expect(existsSync(path.join(tmp, ".heal/.gitignore"))).toBe(false);
  });

  test("a corrupt file reads as empty", () => {
    writeFileSync(path.join(tmp, "f.json"), "{nope");
    expect(loadStore(path.join(tmp, "f.json"))).toEqual({ version: 1, entries: {} });
  });

  test("last pass has the fingerprint, the language and same-page neighbours only", () => {
    const store = {
      version: 1, entries: { k: rec("k", "/login", { id: "u" }), n1: rec("n1", "/login", { id: "p" }), n2: rec("n2", "/other", { id: "z" }) },
    };
    const lp = lastPassFor(store, "k");
    expect(lp?.fingerprint).toEqual({ tag: "input", id: "u" });
    expect(lp?.neighbours).toEqual([{ tag: "input", id: "p" }]);
    expect(lp?.language).toBe("en");
    expect(lastPassFor(store, "missing")).toBeNull();
  });

  test("neighbours are capped at what the service accepts", () => {
    const entries: Record<string, ReturnType<typeof rec>> = {};
    for (let i = 0; i < 150; i++) entries[`n${String(i).padStart(3, "0")}`] = rec(`n${i}`, "/login", { id: String(i) });
    entries.k = rec("k");
    expect(lastPassFor({ version: 1, entries }, "k")?.neighbours).toHaveLength(100);
  });
});

test.describe("recording", { tag: ["@unit", "@regression"] }, () => {
  test("records facts, box, frame, page and language keyed by the acting line", async () => {
    const r = recorder();
    await r.record(asLocator(new FakeLocator(PROBE, "f1")), new Error().stack ?? ""); // this line is the acting line
    const [[key, entry]] = [...r.pending];
    expect(key.startsWith("tests/unit/test-heal-fingerprints.spec.ts::await r.record(asLocator(new FakeLocator(PROBE, 'f1'))")).toBe(true);
    expect(entry).toMatchObject({ page: "/login", language: "fr" });
    expect(entry?.file.endsWith("test-heal-fingerprints.spec.ts")).toBe(true);
    expect(entry?.fingerprint).toMatchObject({ frame: "f1", box: { w: 280 } });
  });

  test("one probe per acting line per test", async () => {
    const r = recorder();
    const loc = new FakeLocator();
    for (let i = 0; i < 2; i++) await r.record(asLocator(loc), new Error().stack ?? "");
    expect(loc.calls.filter((c) => !c.includes("frameElement"))).toHaveLength(1);
  });

  test("an ambiguous or missing element is not recorded and never throws", async () => {
    const r = recorder();
    await r.record(asLocator(new FakeLocator({ items: [ITEM, ITEM], page: {} })), new Error().stack ?? "");
    await r.record(asLocator(new FakeLocator({ items: [], page: {} })), new Error().stack ?? "");
    await r.record(asLocator(new FakeLocator(PROBE, "", 2)), new Error().stack ?? ""); // two matches: strict mode would throw
    const boom = { count: async () => 1, evaluate: async () => Promise.reject(new Error("detached")) };
    await r.record(boom as unknown as Locator, new Error().stack ?? "");
    expect([...r.pending.values()].filter(Boolean)).toEqual([]);
  });

  test("the probe is the vendored script and nothing is cached from a service", async () => {
    const r = new Recorder(tmp, { HEAL_DIR: ".heal" });
    await r.record(asLocator(new FakeLocator(PROBE)), `    at ${tmp}/pages/x.ts:1:1`).catch(() => undefined);
    expect(vendoredProbe()).toContain("(only) =>");
    expect(existsSync(path.join(tmp, ".heal/probe.js"))).toBe(false);
  });

  test("only a clean green test writes", async () => {
    const r = new Recorder(tmp, { HEAL_DIR: ".heal" }, "(only) => 1");
    const flaky = { ...GREEN, annotations: [{ type: "flaky" }] };
    const cases: Array<[string, TestOutcome, boolean]> = [
      ["clean", GREEN, true],
      ["failed", { ...GREEN, status: "failed" }, false],
      ["timed out", { ...GREEN, status: "timedOut" }, false],
      ["retry", { ...GREEN, retry: 1 }, false],
      ["flaky annotation", flaky, false],
      ["flaky tag", { ...GREEN, tags: ["@flaky"] }, false],
    ];
    for (const [label, outcome, written] of cases) {
      r.pending.set(`k-${label}`, { file: "pages/p.ts", text: "t", page: "/p", language: "en", fingerprint: { tag: "a" } });
      expect(await r.finish(outcome), label).toBe(written);
    }
    expect(Object.keys(loadStore(path.join(tmp, ".heal/fingerprints.json")).entries)).toEqual(["k-clean"]);
  });

  test("unstable tests are not recorded", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heal-stab-"));
    setHistoryFile(path.join(dir, "history.json"));
    try {
      for (let i = 0; i < 8; i++) recordResult("unit > unstable", i % 4 === 0);
      expect(recorder().clean({ ...GREEN, titlePath: ["unit", "unstable"] })).toBe(false);
      expect(recorder().clean({ ...GREEN, titlePath: ["unit", "no history"] })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe("the switch", { tag: ["@unit", "@regression"] }, () => {
  test("off by default and never during a heal", () => {
    expect(enabled({})).toBe(false);
    expect(enabled({ HEAL_FINGERPRINTS: "off" })).toBe(false);
    expect(enabled({ HEAL_FINGERPRINTS: "on" })).toBe(true);
    expect(enabled({ HEAL_FINGERPRINTS: "ON", HEAL_RUN: "1" })).toBe(false);
  });

  /** A page whose locators are instances of one class, like Playwright's. */
  function fakeLocatorClass() {
    const order: string[] = [];
    class Loc {
      async click() {
        order.push("act");
        return "done";
      }
      async fill() {
        order.push("fill");
      }
    }
    const page = { locator: () => new Loc() } as unknown as Page;
    return { Loc, page, order };
  }

  test("startRecording leaves Playwright untouched when off", () => {
    const { Loc, page } = fakeLocatorClass();
    const before = Loc.prototype.click;
    expect(startRecording(page, {})).toBeNull();
    expect(startRecording(page, { HEAL_FINGERPRINTS: "on", HEAL_RUN: "1" })).toBeNull();
    expect(Loc.prototype.click).toBe(before);
  });

  test("install wraps the acting methods once and records before acting", async () => {
    const { Loc, page, order } = fakeLocatorClass();
    const r = startRecording(page, { HEAL_FINGERPRINTS: "on" });
    expect(r).not.toBeNull();
    r!.record = async () => void order.push("record");
    installRecorder(page); // twice: still wrapped once
    expect(ACTIONS).toContain("click");
    expect(await new Loc().click()).toBe("done");
    expect(order).toEqual(["record", "act"]);
    stopRecording();
    order.length = 0;
    await new Loc().click();
    expect(order).toEqual(["act"]); // no recorder set: straight through
  });
});

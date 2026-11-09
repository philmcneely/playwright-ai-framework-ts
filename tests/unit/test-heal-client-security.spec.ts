/**
 * Unit tests: heal client security findings (every service reply is untrusted input).
 *
 * One test per exploit: a typed value reaching the service, a trailing comment that swallows the rest of a line, a span that
 * covers more than a locator, a live check on code that is not the code written, a probe script supplied by the service, a
 * partial multi-file write, a symlink or a file mode lost on write, a bearer token over plain http, fingerprint copy that may
 * hold personal data, markdown injected through a PR body, a HEAL_DIR that leaves the repository, a helper import faked by a
 * comment, a hostile reply from the service. A port of the Python client's test_heal_client_security.py.
 *
 * @tags @unit @security
 */
import { test, expect } from "@playwright/test";
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkReplacement, validateReplacement } from "../../scripts/heal-code.mjs";
import {
  Healer, HealServiceError, LivePage, OriginGuard, PatchRefused, ServiceClient, collectSource, planPatches, replaceFile,
  revertFiles, settingsFromEnv, writeFiles,
} from "../../scripts/heal-client.mjs";
import { healDir, itemToFingerprint, copyMode, sourceRoots } from "../../scripts/heal-fingerprints.mjs";
import { vendoredProbe } from "../../scripts/heal-probe.mjs";
import { cleanInventory, redactTypedValues } from "../../scripts/heal-redact.mjs";
import { buildPrBody, commitLines } from "../../scripts/heal.mjs";
import {
  FROM, FakeLive, FakeService, OTHER_SRC, PAGE_FILE, PAGE_SRC, TO, Verify, candidate, failureFor, healer, makeProject, patchFor,
  read, reply, sha,
} from "./heal-helpers.js";

let root = "";
test.beforeEach(() => {
  root = makeProject();
});
test.afterEach(() => rmSync(root, { recursive: true, force: true }));

const ORIGINAL = "page.locator('#a')";

// ---- HIGH-1: typed values never leave the client -------------------------------------------------------------------------
test.describe("typed values", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("redacts a prefilled password and nested typed text", () => {
    const aria = [
      '- textbox "Pw": hunter2', '- textbox "Email": me@example.com', '- searchbox "Find":', "  - text: secret query",
      '- spinbutton "Qty": 7', '- button "Go"', '- textbox "Note": |', "    line one", "    line two", '- link "Home"', "",
    ].join("\n");
    const out = redactTypedValues(aria);
    for (const leaked of ["hunter2", "me@example.com", "secret query", "line one", "line two"]) expect(out).not.toContain(leaked);
    expect(out).toContain('- textbox "Pw"');
    expect(out).toContain('- button "Go"');
    expect(out).toContain('- link "Home"');
  });

  test("hostile text is linear", () => {
    const t0 = Date.now();
    redactTypedValues('- textbox "' + "a\\".repeat(200_000)); // an unterminated key must not blow up
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("the request carries no typed value even when the page snapshot does", async () => {
    const svc = new FakeService([reply("not_drift")]);
    const live = new FakeLive({}, "en", [{
      ref: "e0", tag: "input", value: "hunter2", defaultValue: "hunter2", innerHTML: "<b>hunter2</b>", data_note: "ok",
      data_csrf_token: "t0k", data_value: "v", id: "pw", box: { x: 1, y: 2, width: 3, height: 4 },
    }]);
    live.snap = {
      path: "/login", inventory: live.inventory, more: 0, aria: '- textbox "Pw": hunter2\n- button "Go"\n',
      viewport: { w: 1, h: 1, dpr: 1 }, language: { html_lang: "en" },
    };
    await healer(root, svc, new Verify(), live).heal(failureFor(root));
    const raw = JSON.stringify(svc.posts("/v1/heal")[0]);
    for (const leaked of ["hunter2", "t0k", "innerHTML", "defaultValue"]) expect(raw).not.toContain(leaked);
    expect(svc.posts("/v1/heal")[0].page.inventory[0]).toEqual({ ref: "e0", tag: "input", data_note: "ok", id: "pw", box: { x: 1, y: 2, width: 3, height: 4 } });
  });

  test("the allowlist drops unknown keys, values and non-plain types", () => {
    const out = cleanInventory([
      { tag: "a", text: "Go", value: "x", Value: "x", defaultValue: "x", custom: "x", name: { nested: "x" }, disabled: true, box: { x: "1" } },
      "junk", null,
    ]);
    expect(out).toEqual([{ tag: "a", text: "Go", disabled: true }]);
    expect(cleanInventory("not a list")).toEqual([]);
  });

  test("the live page redacts its own snapshot", async () => {
    const live = new LivePage(settingsFromEnv({ BASE_URL: "http://localhost:7080" }), "/login", "probe");
    live.page = {
      url: () => "http://localhost:7080/login?token=abc",
      evaluate: async () => ({ items: [{ tag: "input", value: "hunter2" }], more: 0, copy_more: 3, copy_withheld: 4, copy_withheld_data: 2, page: { lang: "en" } }),
      locator: () => ({ ariaSnapshot: async () => '- textbox "Pw": hunter2\n' }),
    };
    const snap = await live.snapshot();
    expect(JSON.stringify(snap)).not.toContain("hunter2");
    expect(snap.inventory).toEqual([{ ref: "e0", tag: "input" }]);
    expect(snap.path).toBe("/login");
    expect(snap.copy_more).toBe(3);
    expect([snap.copy_withheld, snap.copy_withheld_data]).toEqual([4, 2]);
  });
});

// ---- HIGH-2: a comment or control character cannot swallow the rest of a line --------------------------------------------
test.describe("comments and controls", { tag: ["@unit", "@security", "@regression"] }, () => {
  const bad = [
    'page.locator("#b")  // ', 'page.locator("#b")//', 'page.locator("#b") // .fill("x")', 'page.locator("#b") /* x */',
    'page.locator("#b")\r', 'page.locator("#b")\f', 'page.locator("#b")\v', 'page.locator("#b")\0', 'page.locator("#b")\t',
    'page.locator("#b")\u202e', 'page.locator("#b")\u2028', 'page.locator("#b")\u0085', 'page.locator("#b"\r)', 'page.locator("#\fb")',
    'page.locator(/* x */ "#b")',
  ];
  bad.forEach((to, i) => {
    test(`both validators reject it (${i + 1}): ${JSON.stringify(to)}`, () => {
      expect(validateReplacement(to, ORIGINAL)).toBeNull();
      expect(checkReplacement(to, ORIGINAL)).not.toBeNull();
    });
  });

  test("a branch with a comment is refused", () => {
    const br = { en: "page.getByLabel('A')", fr: "page.getByLabel('B')" };
    const to = "await byLanguage(page, { en: page.getByLabel('A'), fr: page.getByLabel('B') }) // ";
    expect(checkReplacement(to, ORIGINAL, br)).not.toBeNull();
    const inner = "await byLanguage(page, { en: page.getByLabel('A'), /* x */ fr: page.getByLabel('B') })";
    expect(checkReplacement(inner, ORIGINAL, br)).not.toBeNull();
  });

  for (const ok of ["page.locator('#b')", 'page.locator("#b")', "page.getByRole('button', { name: 'Go' }).first()", "page.getByTestId('a; b')"]) {
    test(`ordinary locators still pass: ${ok}`, () => {
      expect(validateReplacement(ok, ORIGINAL)).toBe(ok);
    });
  }

  test("a comment cannot reach the file", async () => {
    const svc = new FakeService([reply("try", candidate(root, { to: FROM + "  // " })), reply("needs_human", null, { reason: "x" })]);
    const verify = new Verify(root);
    await healer(root, svc, verify).heal(failureFor(root));
    expect(read(root)).toBe(PAGE_SRC);
    expect(verify.calls).toBe(0);
  });
});

// ---- HIGH-3: the original must be a locator chain and a node of the file's syntax tree -----------------------------------
test.describe("original span", { tag: ["@unit", "@security", "@regression"] }, () => {
  const sent = () => ({ [PAGE_FILE]: sha(PAGE_SRC) });

  test("a from that covers more than a locator is refused", () => {
    expect(checkReplacement("page.locator('#b')", "page.locator('#a').click()")).not.toBeNull();
  });

  test("a span that covers a click is refused and nothing is written", async () => {
    const frm = "this.page.locator('#username').fill(user)";
    const svc = new FakeService([reply("try", candidate(root, { frm })), reply("needs_human", null, { reason: "x" })]);
    const verify = new Verify(root);
    await healer(root, svc, verify).heal(failureFor(root));
    expect(read(root)).toBe(PAGE_SRC);
    expect(verify.calls).toBe(0);
  });

  test("a span inside a string or comment is not a node", () => {
    const text = "// this.page.locator('#username')\nconst x = \"this.page.locator('#username')\";\n";
    writeFileSync(path.join(root, PAGE_FILE), text);
    for (const nth of [0, 1]) {
      expect(() => planPatches(candidate(root, { nth }), { [PAGE_FILE]: sha(text) }, ["pages"], root)).toThrow(/not one expression/);
    }
  });

  test("a span that cuts a node in half is refused", () => {
    expect(() => planPatches(candidate(root, { frm: "this.page.locator(" }), sent(), ["pages"], root)).toThrow(PatchRefused);
  });

  test("a file that does not parse is refused", () => {
    const text = "function broken( {\n  this.page.locator('#username');\n}}}\n";
    writeFileSync(path.join(root, PAGE_FILE), text);
    expect(() => planPatches(candidate(root), { [PAGE_FILE]: sha(text) }, ["pages"], root)).toThrow(/does not parse/);
  });

  test("the real node is accepted", () => {
    const planned = planPatches(candidate(root), sent(), ["pages"], root);
    expect(planned[0].newText).toContain(TO);
  });

  test("await is not written where the code is not async (a getter, a field, a plain function)", () => {
    const text = "export class A {\n  get a() {\n    return this.page.locator('#username');\n  }\n}\n";
    writeFileSync(path.join(root, PAGE_FILE), text);
    const to = "await byLanguage(this.page, { en: this.page.getByLabel('A'), fr: this.page.getByLabel('B') })";
    const cand = candidate(root, { to, branches: { en: "this.page.getByLabel('A')", fr: "this.page.getByLabel('B')" } });
    expect(() => planPatches(cand, { [PAGE_FILE]: sha(text) }, ["pages"], root)).toThrow(/not async there/);
  });

  test("await is written inside an async method and at the top level of a module", () => {
    const br = { en: "this.page.getByLabel('A')", fr: "this.page.getByLabel('B')" };
    const to = `await byLanguage(this.page, { en: ${br.en}, fr: ${br.fr} })`;
    const text = "export class A {\n  async go() {\n    await this.page.locator('#username').click();\n  }\n}\n";
    writeFileSync(path.join(root, PAGE_FILE), text);
    const next = planPatches(candidate(root, { to, branches: br }), { [PAGE_FILE]: sha(text) }, ["pages"], root)[0].newText;
    expect(next).toContain(`await ${to}.click()`);
    const top = "export const run = 1;\nawait this.page.locator('#username').click();\n";
    writeFileSync(path.join(root, PAGE_FILE), top);
    expect(planPatches(candidate(root, { to, branches: br }), { [PAGE_FILE]: sha(top) }, ["pages"], root)[0].newText).toContain(to);
  });

  test("spans count code points, not UTF-16 units", () => {
    const text = `// \u{1F600}\u{1F600}\nexport const a = this.page.locator('#username');\n`;
    writeFileSync(path.join(root, PAGE_FILE), text);
    const planned = planPatches(candidate(root), { [PAGE_FILE]: sha(text) }, ["pages"], root);
    expect(planned[0].newText).toBe(text.replace(FROM, TO));
  });
});

// ---- HIGH-4: the code that was checked live is the code that is written --------------------------------------------------
test.describe("checked is written", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("a patch whose to differs from the checked code is refused", async () => {
    const cand = candidate(root);
    (cand.patch as { to: string }).to = "this.page.getByTestId('something-else')"; // a safe locator, but not the checked one
    const svc = new FakeService([reply("try", cand), reply("needs_human", null, { reason: "x" })]);
    const verify = new Verify(root);
    const d = await healer(root, svc, verify, new FakeLive()).heal(failureFor(root));
    expect(read(root)).toBe(PAGE_SRC);
    expect(verify.calls).toBe(0);
    expect(d.outcome).toBe("needs_human");
  });

  test("quote style and spacing do not count as a difference", () => {
    const cand = candidate(root);
    cand.code = 'this.page.getByTestId( "login-user" )';
    const planned = planPatches(cand, { [PAGE_FILE]: sha(PAGE_SRC) }, ["pages"], root);
    expect(planned[0].newText).toContain(TO);
  });

  const failureWithOther = () => failureFor(root, ["pages/other-page.ts:1:1"]);

  test("an extra patch that hits two elements refuses the whole candidate", async () => {
    const also = [patchFor(root, { to: "this.page.getByText('Everything')", file: "pages/other-page.ts" })];
    const svc = new FakeService([reply("try", candidate(root, { also })), reply("needs_human", null, { reason: "x" })]);
    const live = new FakeLive({ "this.page.getByText('Everything')": [2, null] });
    const verify = new Verify(root);
    await healer(root, svc, verify, live).heal(failureWithOther());
    expect(read(root)).toBe(PAGE_SRC);
    expect(verify.calls).toBe(0);
    expect(read(root, "pages/other-page.ts")).toBe(OTHER_SRC);
  });

  test("an extra patch that hits another element refuses the whole candidate", async () => {
    const also = [patchFor(root, { to: "this.page.getByText('Other')", file: "pages/other-page.ts" })];
    const svc = new FakeService([reply("try", candidate(root, { also })), reply("needs_human", null, { reason: "x" })]);
    const live = new FakeLive({ "this.page.getByText('Other')": [1, "e9"] });
    const verify = new Verify(root);
    await healer(root, svc, verify, live).heal(failureWithOther());
    expect(verify.calls).toBe(0);
    expect(read(root)).toBe(PAGE_SRC);
  });

  test("every extra patch is checked live", async () => {
    const also = [patchFor(root, { nth: 1 }), patchFor(root, { file: "pages/other-page.ts" })];
    const cand = candidate(root, { also });
    const svc = new FakeService([reply("try", cand), reply("healed", cand)]);
    const live = new FakeLive();
    await healer(root, svc, new Verify(root, [true]), live).heal(failureWithOther());
    expect(live.asked).toEqual([TO, TO, TO]);
  });

  test("a branch extra patch is checked in the page language", async () => {
    const br = { en: "this.page.getByLabel('Username')", fr: "this.page.getByLabel('Nom')" };
    const to = `await byLanguage(this.page, { en: ${br.en}, fr: ${br.fr} })`;
    const cand = candidate(root, { to, branches: br, also: [patchFor(root, { to, nth: 1 })] });
    const svc = new FakeService([reply("try", cand), reply("healed", cand)]);
    const live = new FakeLive({}, "fr");
    await healer(root, svc, new Verify(root, [true]), live).heal(failureFor(root));
    expect(live.asked).toEqual([br.fr, br.fr]);
  });

  test("a branch that differs from what was checked is refused", () => {
    const br = { en: "this.page.getByLabel('Username')", fr: "this.page.getByLabel('Nom')" };
    const to = `await byLanguage(this.page, { en: ${br.en}, fr: this.page.getByLabel('Evil') })`;
    expect(checkReplacement(to, FROM, br)).toContain("differs");
  });
});

// ---- HIGH-5: the probe is vendored; a service copy must be byte-identical; foreign origins are blocked -------------------
test.describe("probe", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("the vendored probe is used and the service is not asked", async () => {
    const svc = new FakeService();
    expect(await svc.client().probeJs()).toBe(vendoredProbe());
    expect(svc.requests.filter((r) => r.path === "/v1/probe.js")).toEqual([]);
  });

  test("the vendored probe never reads a value except a button's own label", () => {
    const text = vendoredProbe();
    expect(text).toContain("el.value");
    expect(text).toContain("textarea");
  });

  test("a service probe with other bytes is refused", async () => {
    const svc = new FakeService(); // serves a different script at /v1/probe.js
    const client = new ServiceClient("http://localhost:1", "", { fetchImpl: svc.fetch as typeof fetch, env: { HEAL_PROBE_FROM_SERVICE: "1" } });
    await expect(client.probeJs()).rejects.toThrow(/probe/);
  });

  test("a service probe with identical bytes is accepted", async () => {
    const text = vendoredProbe();
    const client = new ServiceClient("http://localhost:1", "", {
      fetchImpl: (async () => new Response(text, { status: 200 })) as typeof fetch, env: { HEAL_PROBE_FROM_SERVICE: "1" },
    });
    expect(await client.probeJs()).toBe(text);
  });

  test("foreign origins are blocked only while probing", async () => {
    const guard = new OriginGuard("http://localhost:7080");
    const calls: Array<[string, string]> = [];
    const route = (url: string) => ({
      request: () => ({ url: () => url }),
      abort: async () => void calls.push(["abort", url]),
      continue: async () => void calls.push(["continue", url]),
    });
    await guard.handle(route("http://evil.example/x.png"));
    guard.probing = true;
    await guard.handle(route("http://evil.example/x.png"));
    await guard.handle(route("http://localhost:7080/app.js"));
    await guard.handle(route("http://localhost:9999/app.js"));
    await guard.handle(route("data:text/plain,hi"));
    expect(calls).toEqual([
      ["continue", "http://evil.example/x.png"], ["abort", "http://evil.example/x.png"], ["continue", "http://localhost:7080/app.js"],
      ["abort", "http://localhost:9999/app.js"], ["continue", "data:text/plain,hi"],
    ]);
  });

  test("snapshot and check run the probe with the guard on", async () => {
    const seen: Array<[string, boolean]> = [];
    const live = new LivePage(settingsFromEnv({ BASE_URL: "http://localhost:7080" }), "/", "probe");
    live.page = {
      url: () => "http://localhost:7080/",
      evaluate: async () => (seen.push(["evaluate", live.guard.probing]), { items: [], more: 0, page: {} }),
      locator: () => ({ ariaSnapshot: async () => (seen.push(["aria", live.guard.probing]), "") }),
    };
    await live.snapshot();
    expect(seen).toContainEqual(["evaluate", true]);
    expect(seen).toContainEqual(["aria", true]);
    expect(live.guard.probing).toBe(false);
  });

  test("check runs the probe on the one element with the guard on", async () => {
    const seen: boolean[] = [];
    const live = new LivePage(settingsFromEnv({ BASE_URL: "http://localhost:7080" }), "/", "probe");
    live.inventory = [{ ref: "e0", tag: "input", id: "a" }];
    const loc = {
      count: async () => 1,
      evaluate: async () => (seen.push(live.guard.probing), { items: [{ tag: "input", id: "a" }] }),
    };
    live.page = { locator: () => loc };
    expect(await live.check("page.locator('#a')")).toEqual([1, "e0"]);
    expect(seen).toEqual([true]);
    expect(live.guard.probing).toBe(false);
  });
});

// ---- MEDIUM --------------------------------------------------------------------------------------------------------------
test.describe("writes", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("a partial multi-file write is reverted", async () => {
    const also = [patchFor(root, { to: TO, file: "pages/other-page.ts" })];
    const svc = new FakeService([reply("try", candidate(root, { also })), reply("needs_human", null, { reason: "x" })]);
    let n = 0;
    const writeFile = (file: string, data: Buffer) => {
      n += 1;
      if (n === 2) throw new Error("disk full");
      replaceFile(file, data);
    };
    const d = await healer(root, svc, new Verify(root), new FakeLive(), { writeFile }).heal(failureFor(root, ["pages/other-page.ts:1:1"]));
    expect(read(root)).toBe(PAGE_SRC);
    expect(read(root, "pages/other-page.ts")).toBe(OTHER_SRC);
    expect(d.reason).toBe("client_error");
  });

  test("the file mode survives a write and a revert", () => {
    const file = path.join(root, PAGE_FILE);
    chmodSync(file, 0o750);
    const planned = planPatches(candidate(root), { [PAGE_FILE]: sha(PAGE_SRC) }, ["pages"], root);
    writeFiles(root, planned);
    expect(statSync(file).mode & 0o7777).toBe(0o750);
    expect(read(root)).toContain(TO);
    revertFiles(root, planned);
    expect(statSync(file).mode & 0o7777).toBe(0o750);
    expect(read(root)).toBe(PAGE_SRC);
  });

  test("writing through a symlink is refused", () => {
    const target = path.join(root, "conftest.ts");
    writeFileSync(target, "export const x = 1;\n");
    const link = path.join(root, "pages/link.ts");
    symlinkSync(target, link);
    expect(() => writeFiles(root, [{ rel: "pages/link.ts", original: Buffer.from("x"), newText: "export const x = 2;\n" }])).toThrow();
    expect(read(root, "conftest.ts")).toBe("export const x = 1;\n");
  });

  test("a symlinked file inside the repo but outside the roots is not planned", () => {
    const target = path.join(root, "conftest.ts");
    const text = "export const x = this.page.locator('#username');\n";
    writeFileSync(target, text);
    symlinkSync(target, path.join(root, "pages/link.ts"));
    expect(() => planPatches(candidate(root, { file: "pages/link.ts" }), { "pages/link.ts": sha(text) }, ["pages"], root))
      .toThrow(PatchRefused);
  });

  test("collectSource checks each source root", () => {
    writeFileSync(path.join(root, "conftest.ts"), "export const SECRET = 1;\n");
    symlinkSync(path.join(root, "conftest.ts"), path.join(root, "pages/link.ts")); // resolves inside the repo
    const stack = [{ file: "pages/link.ts", line: 1 }, { file: PAGE_FILE, line: 1 }];
    expect(collectSource(stack, ["pages"], root).map((f) => f.path)).toEqual([PAGE_FILE]);
  });

  test("collectSource skips a symlinked directory that leaves the root", () => {
    writeFileSync(path.join(root, "tests/x.ts"), "export const y = 1;\n");
    symlinkSync(path.join(root, "tests"), path.join(root, "pages/d"));
    expect(collectSource([{ file: "pages/d/x.ts", line: 1 }], ["pages"], root)).toEqual([]);
  });
});

test.describe("bearer over http", { tag: ["@unit", "@security", "@regression"] }, () => {
  const call = async (url: string, token = "tok", env: Record<string, string> = {}) => {
    const client = new ServiceClient(url, token, { fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch, env });
    return client.capabilities();
  };
  let warnings: string[] = [];
  const listener = (w: Error) => void warnings.push(w.message);
  test.beforeEach(() => {
    warnings = [];
    process.on("warning", listener);
  });
  test.afterEach(() => void process.off("warning", listener));

  test("a token over http to a remote host is refused with a warning", async () => {
    await expect(call("http://heal.example.test:8765")).rejects.toThrow(/http/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warnings.join("\n")).toContain("HEAL_ALLOW_INSECURE");
  });

  for (const url of ["http://localhost:8765", "http://127.0.0.1:8765", "http://[::1]:8765", "https://heal.example.test"]) {
    test(`localhost and https are fine: ${url}`, async () => {
      expect(await call(url)).toEqual({ ok: true });
    });
  }

  test("no token means no refusal", async () => {
    expect(await call("http://heal.example.test", "")).toEqual({ ok: true });
  });

  test("the override allows it", async () => {
    expect(await call("http://heal.example.test", "tok", { HEAL_ALLOW_INSECURE: "1" })).toEqual({ ok: true });
  });
});

test.describe("fingerprint copy", { tag: ["@unit", "@security", "@regression"] }, () => {
  const ITEM = {
    tag: "button", role: "button", name: "Jane Doe", label: "Jane", text: "Jane Doe", row: "row-jane", placeholder: "Jane",
    aria_label: "Jane Doe", title: "Jane", id: "go", testid: "go-btn",
  };

  test("copy is stored as given by default", () => {
    const f = itemToFingerprint(ITEM) as Record<string, string>;
    expect(f.text).toBe("Jane Doe");
    expect(f.row).toBe("row-jane");
  });

  test("copy off stores only hashes of copy", () => {
    const f = itemToFingerprint(ITEM, "", "off") as Record<string, string> & { attrs: Record<string, string> };
    const raw = JSON.stringify(f);
    expect(raw).not.toContain("Jane");
    expect(raw).not.toContain("row-jane");
    expect(f.text).toBe(f.name);
    expect(f.text.startsWith("sha256:")).toBe(true);
    expect(f.tag).toBe("button");
    expect(f.attrs.id).toBe("go");
    expect(f.attrs["data-testid"]).toBe("go-btn");
    const again = itemToFingerprint({ ...ITEM, text: "  jane   DOE " }, "", "off") as Record<string, string>;
    expect(again.text).toBe(f.text); // whitespace and case do not change the hash
  });

  test("the switch comes from the environment", () => {
    expect(copyMode({ HEAL_FINGERPRINT_COPY: "OFF" })).toBe("off");
    expect(copyMode({})).toBe("on");
    expect(copyMode({ HEAL_FINGERPRINT_COPY: "maybe" })).toBe("on");
  });
});

// ---- LOW -----------------------------------------------------------------------------------------------------------------
test.describe("low findings", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("the PR body escapes markdown in every service string", () => {
    const healed = [{ test: "test_[x](http://evil.example)", from: "a`b", to: "c", why: "<img src=x> *bold*\n# Head", source: "s" }];
    const other = [{ test: "t_@mention", why: "[click](http://evil.example) ![i](x)\r\n- injected" }];
    const body = buildPrBody(healed as never, other as never);
    expect(body).not.toContain("[x](http");
    expect(body).not.toContain("\n# Head");
    expect(body).not.toContain("\n- injected");
    expect(body).toContain("\\[x\\]");
    expect(body).toContain("`<img src=x> *bold* # Head`"); // service text sits in a code span: no link, autolink or HTML starts there
  });

  test("the PR commit lines are single lines", () => {
    const lines = commitLines([{ test: "t\nCo-Authored-By: x", from: "a", to: "b" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
  });

  for (const value of ["/etc", "../x", "a/../../x", "C:\\x", "~/x", "a\\b", "  /"]) {
    test(`HEAL_DIR must be a relative path inside the repo: ${JSON.stringify(value)}`, () => {
      const warned: string[] = [];
      expect(healDir(root, { HEAL_DIR: value }, (m) => warned.push(m))).toBe(path.join(root, ".heal"));
      expect(warned).toHaveLength(1);
    });
  }

  test("a HEAL_DIR that resolves outside through a symlink is refused", () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    symlinkSync(outside, path.join(repo, "cache"));
    const warned: string[] = [];
    expect(healDir(repo, { HEAL_DIR: "cache" }, (m) => warned.push(m))).toBe(path.join(repo, ".heal"));
    expect(warned).toHaveLength(1);
  });

  test("a good HEAL_DIR is used", () => {
    expect(healDir(root, { HEAL_DIR: "build/heal" })).toBe(path.join(root, "build/heal"));
  });

  for (const raw of ["/etc", "/", "pages,/etc", "pages,../x", "pages,C:\\x", "pages\\x", "~/x"]) {
    test(`source roots must be relative inside the repo: ${raw}`, () => {
      expect(sourceRoots({ HEAL_SOURCE_ROOTS: raw })).toEqual(raw.startsWith("pages,") ? ["pages"] : ["pages", "tests", "utils", "fixtures"]);
    });
  }

  test("source roots still accept nested relative roots", () => {
    expect(sourceRoots({ HEAL_SOURCE_ROOTS: "src/pages, e2e/" })).toEqual(["src/pages", "e2e"]);
  });

  test("the helper import is added when only a comment or string mentions it", () => {
    const text = [
      "// import { byLanguage } from '../utils/heal-locale.js';", '"import byLanguage";', "", "export class P {",
      "  async go() {", "    return this.page.locator('#username');", "  }", "}", "",
    ].join("\n");
    writeFileSync(path.join(root, PAGE_FILE), text);
    const br = { en: "this.page.getByLabel('U')", fr: "this.page.getByLabel('N')" };
    const to = `await byLanguage(this.page, { en: ${br.en}, fr: ${br.fr} })`;
    const next = planPatches(candidate(root, { to, branches: br }), { [PAGE_FILE]: sha(text) }, ["pages"], root)[0].newText;
    expect(next.match(/^import \{ byLanguage \} from "\.\.\/utils\/heal-locale\.js";$/gm)).toHaveLength(1);
  });

  test("the helper import is not duplicated when really imported", () => {
    const text = [
      'import { byLanguage } from "../utils/heal-locale.js";', "", "export class P {", "  async go() {",
      "    return this.page.locator('#username');", "  }", "}", "",
    ].join("\n");
    writeFileSync(path.join(root, PAGE_FILE), text);
    const br = { en: "this.page.getByLabel('U')", fr: "this.page.getByLabel('N')" };
    const to = `await byLanguage(this.page, { en: ${br.en}, fr: ${br.fr} })`;
    const next = planPatches(candidate(root, { to, branches: br }), { [PAGE_FILE]: sha(text) }, ["pages"], root)[0].newText;
    expect(next.split("import { byLanguage }")).toHaveLength(2);
  });
});

test.describe("hostile service JSON", { tag: ["@unit", "@security", "@regression"] }, () => {
  const client = (status: number, body: string) =>
    new ServiceClient("https://svc.example", "t", { fetchImpl: (async () => new Response(body, { status })) as typeof fetch, env: {} });

  test("a deeply nested reply raises a service error", async () => {
    const deep = "[".repeat(200_000) + "]".repeat(200_000);
    await expect(client(200, deep).capabilities()).rejects.toBeInstanceOf(HealServiceError);
  });

  test("a reply that is not an object is an error", async () => {
    await expect(client(200, '["x"]').capabilities()).rejects.toThrow(/not a JSON object/);
    await expect(client(200, "null").capabilities()).rejects.toThrow(/not a JSON object/);
    await expect(client(200, "not json").capabilities()).rejects.toThrow(/not usable JSON/);
  });

  test("an error reply that is deep or not an object still reports the status", async () => {
    for (const body of ["[".repeat(200_000) + "]".repeat(200_000), '["x"]']) {
      await expect(client(500, body).capabilities()).rejects.toThrow(/500/);
    }
  });

  test("a reply that is far too large is refused", async () => {
    await expect(client(200, JSON.stringify({ pad: "x".repeat(9 * 1024 * 1024) })).capabilities()).rejects.toThrow(/too large/);
  });

  test("a heal run against a hostile reply ends as needs_human", async () => {
    const svc = new FakeService();
    svc.handler = () => new Response("[".repeat(200_000), { status: 200 });
    const d = await new Healer(svc.client(), settingsFromEnv({}), new Verify().fn, { root, liveFactory: () => new FakeLive() }).heal(failureFor(root));
    expect(d).toMatchObject({ outcome: "needs_human", reason: "service_error" });
  });
});

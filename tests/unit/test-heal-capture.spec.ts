/**
 * Unit tests: the page as the failing test left it.
 *
 * A heal used to describe a freshly reopened route, so whatever the test had opened before it failed (a panel, a tab, a dialog)
 * was closed again and the element the test meant was hidden or missing. During a heal's own runs (HEAL_CAPTURE=1) the support
 * fixture now captures the probe listing and the redacted aria snapshot of the failing page; the client sends that, and matches
 * what its live check hits on the reopened page back to it without the facts that only say what state the page is in.
 *
 * @tags @unit
 */
import { test, expect } from "@playwright/test";
import { Healer, capturePage, matchRef, parseCapture, settingsFromEnv } from "../../scripts/heal-client.mjs";
import { failuresOf } from "../../scripts/heal.mjs";
import { captureWanted } from "../../fixtures/heal-fingerprints.js";
import { FakeLive, FakeService, Verify, candidate, failureFor, makeProject, reply } from "./heal-helpers.js";

const BASE = "https://app.example";
const settings = () => settingsFromEnv({ BASE_URL: BASE, HEAL_SOURCE_ROOTS: "pages,tests" });

test.describe("matchRef", () => {
  test("an element hidden on the reopened page still names the entry the failing page listed @unit @regression", () => {
    const captured = [{ ref: "e0", tag: "button", text: "Notes" }, { ref: "e1", tag: "textarea", name_attr: "note", hidden: false, top_at_center: true }];
    const reopened = { tag: "textarea", name_attr: "note", hidden: true, top_at_center: false, box: { x: 0, y: 0, width: 0, height: 0 } };
    expect(matchRef(captured, reopened)).toBe("e1");
  });

  test("against a capture, twins that differ only in state are never named, even when one fits exactly @unit @security @regression", () => {
    // the test used e1 with tab 2 open; the reopened page shows tab 1, so the hit is e0's element, now shown at e1's state
    const captured = [
      { ref: "e0", tag: "button", text: "Save", hidden: true, top_at_center: false, box: { x: 0, y: 0, width: 10, height: 10 } },
      { ref: "e1", tag: "button", text: "Save", hidden: false, top_at_center: true, box: { x: 0, y: 300, width: 10, height: 10 } },
    ];
    const hit = { tag: "button", text: "Save", hidden: false, top_at_center: true, box: { x: 0, y: 0, width: 10, height: 10 } };
    expect(matchRef(captured, hit, { captured: true })).toBe(null);
    expect(matchRef(captured, hit)).toBe("e1"); // one page, one state: the old rule stands
    expect(matchRef([captured[1]], hit, { captured: true })).toBe("e1");
  });

  test("the state-free match must still be unique @unit @regression", () => {
    const captured = [{ ref: "e0", tag: "textarea", hidden: false }, { ref: "e1", tag: "textarea", hidden: true }];
    expect(matchRef(captured, { tag: "textarea", hidden: true, top_at_center: true })).toBe(null);
  });
});

test.describe("parseCapture", () => {
  const good = { path: "/orders/7", more: 2, aria: '- textbox "Note": typed secret', inventory: [{ ref: "e9", tag: "textarea", value: "x", name_attr: "note" }] };

  test("keeps a same-origin capture: listing renumbered and allowlisted, aria redacted @unit @security @regression", () => {
    const cap = parseCapture(JSON.stringify(good), BASE);
    expect(cap?.path).toBe("/orders/7");
    expect(cap?.more).toBe(2);
    expect(cap?.inventory).toEqual([{ ref: "e0", tag: "textarea", name_attr: "note" }]);
    expect(cap?.aria).not.toContain("typed secret");
  });

  test("refuses what a test run could have written to mislead the heal @unit @security @regression", () => {
    for (const bad of [
      "", "not json", "[]", JSON.stringify({ ...good, path: "https://evil.example/x" }), JSON.stringify({ ...good, path: "//evil.example" }),
      JSON.stringify({ ...good, inventory: "nope" }), "x".repeat(3_000_000),
    ]) expect(parseCapture(bad, BASE), bad.slice(0, 40)).toBe(null);
    expect(parseCapture(undefined, BASE)).toBe(null);
  });

  test("caps the listing at the probe's 500 items and keeps `more` bounded @unit @security @regression", () => {
    const cap = parseCapture(JSON.stringify({ path: "/o", more: 1e300, inventory: Array.from({ length: 5000 }, () => ({ tag: "div" })) }), BASE);
    expect(cap?.inventory.length).toBe(500);
    expect(cap?.more).toBe(0);
    expect(parseCapture(JSON.stringify({ path: "/o", more: 1e12, inventory: [] }), BASE)?.more).toBe(1_000_000);
  });
});

test.describe("failuresOf", () => {
  test("reads the capture attachment of the failing result @unit @regression", () => {
    const body = Buffer.from(JSON.stringify({ path: "/o", inventory: [{ ref: "e0", tag: "button" }] })).toString("base64");
    const report = { config: { rootDir: "/r" }, suites: [{ file: "a.spec.ts", specs: [{ title: "t", file: "a.spec.ts", tests: [{ results: [
      { status: "failed", errors: [{ message: "boom" }], attachments: [{ name: "heal-page-capture", contentType: "application/json", body }] },
    ] }] }] }] };
    const [f] = failuresOf(report, BASE);
    expect(f.capture?.inventory).toEqual([{ ref: "e0", tag: "button" }]);
  });
});

test.describe("Healer with a capture", () => {
  test("sends the failing page's listing and aria, checks against it, and sends no screenshot of another state @unit @regression", async () => {
    const root = makeProject();
    const svc = new FakeService([reply("try", candidate(root, { ref: "e1" })), reply("healed", null)]);
    const live = new FakeLive({}, "en", [{ ref: "e0", tag: "input", hidden: true }]);
    live.snap = {
      path: "/login", inventory: live.inventory, more: 0, aria: "- generic", screenshot: { media_type: "image/png", data: "AA==", width: 1, height: 1 },
      viewport: { w: 1280, h: 720, dpr: 1, scroll: { x: 0, y: 0 } }, language: { html_lang: "en", browser_locale: "en-US", content_language: null },
    };
    let checkedAgainst: unknown = null;
    live.check = async () => {
      checkedAgainst = live.inventory;
      return [1, "e1"];
    };
    const capture = { path: "/login", more: 0, aria: '- textbox "Username"', inventory: [{ ref: "e0", tag: "label" }, { ref: "e1", tag: "input" }] };
    const healer = new Healer(svc.client(), settingsFromEnv({ BASE_URL: BASE, HEAL_VISION: "on" }), new Verify(root, [true]).fn, { root, liveFactory: async () => live as never });
    const decision = await healer.heal({ ...failureFor(root), capture });
    const [req] = svc.posts("/v1/heal");
    expect(req.page.inventory).toEqual(capture.inventory);
    expect(req.page.aria_snapshot).toBe('- textbox "Username"');
    expect(req.page.screenshot).toBe(null);
    expect(req.options.vision).toBe("off");
    expect(checkedAgainst).toEqual(capture.inventory);
    expect((live as unknown as { captured?: boolean }).captured).toBe(true);
    expect(decision.outcome).toBe("healed");
  });
});

test.describe("capturePage", () => {
  test("lists what the test had opened, and no typed value @unit @security @regression", async ({ page }) => {
    await page.setContent(`<html lang="en"><body><button id="open" onclick="document.getElementById('p').hidden=false">Notes</button>
      <div id="p" hidden><textarea name="note"></textarea></div></body></html>`);
    await page.click("#open");
    await page.fill("textarea", "call before delivery");
    const cap = await capturePage(page);
    const note = cap.inventory.find((i: { tag?: string }) => i.tag === "textarea");
    expect(note?.hidden).toBe(false);
    expect(JSON.stringify(cap)).not.toContain("call before delivery");
    expect(parseCapture(JSON.stringify(cap), "http://localhost")).toBe(null); // about:blank has no same-origin path
    void settings;
  });
});

test.describe("capturePage on an editable page", () => {
  test("a page in designMode or with an editable region sends no aria snapshot and is not changed @unit @security @regression", async ({ page, context }) => {
    await page.setContent(`<html><body><p id="d">plain</p></body></html>`);
    await page.evaluate(() => { document.designMode = "on"; document.getElementById("d")!.textContent = "DESIGNMODE-SECRET-123"; });
    expect((await capturePage(page)).aria).toBe(null);

    const other = await context.newPage(); // designMode stays on for the first page's document
    await other.setContent(`<html><body><div contenteditable="plaintext-only"><p>INHERITED-SECRET</p></div><p>prose</p></body></html>`);
    await other.fill("[contenteditable]", "TYPED-SECRET").catch(() => undefined);
    const cap = await capturePage(other);
    expect(cap.aria).toBe(null); // an editable region is on the page: no aria snapshot, and the page is left as it was
    expect(await other.locator("[contenteditable]").innerText()).not.toBe("");
  });
});

test.describe("the fixture's gate", () => {
  test("HEAL_CAPTURE alone does not attach a capture outside a heal run @unit @security @regression", () => {
    expect(captureWanted({ HEAL_CAPTURE: "1" })).toBe(false);
    expect(captureWanted({ HEAL_RUN: "1" })).toBe(false);
    expect(captureWanted({ HEAL_RUN: "1", HEAL_CAPTURE: "1" })).toBe(true);
  });
});

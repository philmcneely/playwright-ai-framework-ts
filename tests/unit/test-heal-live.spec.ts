/**
 * Unit tests: the heal client's live page in a real Chromium on a local page (no service, no model, no network).
 *
 * Covers what only a browser can show: the probe's inventory and the aria snapshot carry no typed value, a locator is checked
 * by count and by the element it hit, the vision capture is ONE viewport screenshot with password fields and HEAL_MASK
 * selectors painted over (decoded pixels prove it) and is never taken with HEAL_VISION off, and a request to another origin is
 * aborted only while the probe runs.
 *
 * @tags @unit
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PNG } from "pngjs";
import { LivePage, buildRequest, settingsFromEnv } from "../../scripts/heal-client.mjs";
import { vendoredProbe } from "../../scripts/heal-probe.mjs";
import { byLanguage } from "../../utils/heal-locale.js";
import { makeProject } from "./heal-helpers.js";

const PAGE = `<!doctype html><html lang="fr"><head><title>Compte</title><style>
  body { margin: 0; font: 16px sans-serif; background: #ffffff; }
  #pw { position: absolute; left: 40px; top: 120px; width: 300px; height: 40px; background: #00aa00; }
  #save { position: absolute; left: 40px; top: 220px; width: 200px; height: 40px; background: #0000cc; color: #fff; }
  #name { position: absolute; left: 40px; top: 60px; width: 300px; height: 40px; }
</style></head><body>
  <label for="name">Nom</label><input id="name" data-testid="display-name" value="should-not-leak">
  <input type="password" id="pw" value="hunter2">
  <button id="save" data-testid="save-btn">Enregistrer</button>
</body></html>`;

function serve(body: string, headers: Record<string, string> = {}): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
      res.end(req.url === "/other" ? "other" : req.url === "/frame" ? "<html><body style=\"background:#fff\">inner</body></html>" : body);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

let app: { server: Server; url: string };
let foreign: { server: Server; url: string };
test.beforeAll(async () => {
  app = await serve(PAGE, { "Content-Language": "de" });
  foreign = await serve("foreign");
});
test.afterAll(() => {
  app.server.close();
  foreign.server.close();
});

const open = (env: Record<string, string> = {}) =>
  LivePage.open(settingsFromEnv({ BASE_URL: app.url, ...env }), "/", vendoredProbe());

test.describe("live page", { tag: ["@unit", "@regression"] }, () => {
  test("the snapshot lists elements and carries no typed value", async () => {
    const live = await open();
    try {
      const snap = await live.snapshot();
      const raw = JSON.stringify(snap);
      expect(raw).not.toContain("hunter2");
      expect(raw).not.toContain("should-not-leak");
      expect(snap.inventory.find((i: { testid?: string }) => i.testid === "save-btn")).toMatchObject({ tag: "button", text: "Enregistrer" });
      expect(snap.language).toEqual({ html_lang: "fr", browser_locale: expect.any(String), content_language: "de" });
      expect(live.language).toBe("fr");
      expect(snap.path).toBe("/");
      expect(snap.screenshot).toBeNull();
      expect(snap.aria).toContain("button");
    } finally {
      await live.close();
    }
  });

  test("check reports the match count and the element hit", async () => {
    const live = await open();
    try {
      await live.snapshot();
      const [count, ref] = await live.check("this.page.getByTestId('save-btn')");
      expect(count).toBe(1);
      expect(ref).toBe(live.inventory.find((i: { testid?: string }) => i.testid === "save-btn")?.ref);
      expect((await live.check("page.locator('input')"))[0]).toBe(2);
      expect(await live.check("page.locator('#nothing')")).toEqual([0, null]);
      expect(await live.check("this.page.evaluate('1')")).toEqual([null, null]);
    } finally {
      await live.close();
    }
  });

  test("with HEAL_VISION off the screenshot call is never made and no image bytes are in the request", async () => {
    const live = await open();
    try {
      let shots = 0;
      const original = live.page.screenshot.bind(live.page);
      live.page.screenshot = (...a: unknown[]) => (shots++, original(...a));
      const snap = await live.snapshot();
      const req = buildRequest({ title: "t", error: "e" }, [], [], snap, settingsFromEnv({ BASE_URL: app.url }), makeProject());
      expect(shots).toBe(0);
      expect(req.page.screenshot).toBeNull();
      expect(req.options.vision).toBe("off");
      expect(JSON.stringify(req)).not.toMatch(/iVBOR|image\/png|media_type/);
    } finally {
      await live.close();
    }
  });

  for (const mode of ["auto", "on"]) {
    test(`with HEAL_VISION ${mode} one viewport screenshot is sent with password fields and HEAL_MASK painted over`, async () => {
      const live = await open({ HEAL_VISION: mode, HEAL_MASK: "#save" });
      try {
        let calls: Array<Record<string, unknown>> = [];
        const original = live.page.screenshot.bind(live.page);
        live.page.screenshot = (opts: Record<string, unknown>) => (calls.push(opts), original(opts));
        const snap = await live.snapshot();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ type: "png", fullPage: false });
        const shot = snap.screenshot;
        expect(Object.keys(shot).sort()).toEqual(["data", "height", "media_type", "width"]);
        expect(shot.media_type).toBe("image/png");
        const png = PNG.sync.read(Buffer.from(shot.data, "base64"));
        expect([png.width, png.height]).toEqual([shot.width, shot.height]);
        expect(snap.viewport.scroll).toEqual({ x: 0, y: 0 });
        const viewport = live.page.viewportSize();
        expect([snap.viewport.w, snap.viewport.h]).toEqual([viewport.width, viewport.height]);
        expect(shot.width).toBe(viewport.width);
        expect(shot.height).toBe(viewport.height);
        const pixel = (x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
        expect(pixel(200, 140)).toEqual([255, 0, 255]); // the password field is painted over (it was green)
        expect(pixel(100, 240)).toEqual([255, 0, 255]); // the HEAL_MASK selector is painted over (it was blue)
        expect(pixel(600, 400)).toEqual([255, 255, 255]); // the rest of the page is untouched
        const req = buildRequest({ title: "t", error: "e" }, [], [], snap, live.settings, makeProject());
        expect(req.options.vision).toBe(mode);
        expect(req.page.screenshot).toEqual(shot);
        calls = [];
      } finally {
        await live.close();
      }
    });
  }

  test("a screenshot that cannot be taken falls back to text only, with a note", async () => {
    const live = await open({ HEAL_VISION: "on" });
    try {
      live.page.screenshot = async () => {
        throw new Error("page closed");
      };
      const snap = await live.snapshot();
      expect(snap.screenshot).toBeNull();
      expect(live.notes.join(" ")).toContain("no screenshot sent");
      const req = buildRequest({ title: "t", error: "e" }, [], [], snap, live.settings, makeProject());
      expect(req.options.vision).toBe("off");
    } finally {
      await live.close();
    }
  });

  test("a request to another origin is aborted for the whole session, unless the origin is allowed", async () => {
    const live = await open();
    try {
      const probe = (url: string) => live.page.evaluate((u: string) => fetch(u, { mode: "no-cors" }).then(() => "sent", () => "blocked"), url);
      expect(await probe(foreign.url + "/other")).toBe("blocked");
      expect(await live.guard.active(() => probe(foreign.url + "/other"))).toBe("blocked");
      expect(await live.guard.active(() => probe(app.url + "/other"))).toBe("sent");
      expect(live.guard.probing).toBe(false);
    } finally {
      await live.close();
    }
    const allowed = await open({ HEAL_ALLOW_ORIGINS: foreign.url });
    try {
      expect(await allowed.page.evaluate((u: string) => fetch(u, { mode: "no-cors" }).then(() => "sent", () => "blocked"), foreign.url + "/other")).toBe("sent");
    } finally {
      await allowed.close();
    }
  });

  test("the page load itself is guarded: a foreign subresource never loads, same-origin ones do", async () => {
    const live = await open();
    try {
      const seen: string[] = [];
      live.page.on("requestfailed", (r: { url(): string }) => seen.push(r.url()));
      await live.page.setContent(`<img src="${foreign.url}/pixel.png"><script src="${app.url}/x.js"></script>`);
      await live.page.waitForTimeout(300);
      expect(seen.some((u) => u.startsWith(foreign.url))).toBe(true);
      expect(seen.some((u) => u.startsWith(app.url))).toBe(false);
    } finally {
      await live.close();
    }
  });

  test("an editable region's text is emptied before the aria snapshot, and a service worker is blocked", async () => {
    const live = await open();
    try {
      await live.page.setContent('<div contenteditable aria-label="Note">TYPED-SECRET</div><p>public</p>');
      const snap = await live.snapshot();
      expect(JSON.stringify(snap)).not.toContain("TYPED-SECRET");
      expect(snap.aria).toContain("public");
      expect(await live.page.evaluate(() => navigator.serviceWorker?.getRegistrations().then((r) => r.length) ?? 0)).toBe(0);
    } finally {
      await live.close();
    }
  });
});

test.describe("screenshot masks by default", { tag: ["@unit", "@security", "@regression"] }, () => {
  const FIELDS = `<!doctype html><html lang="en"><head><style>
    body { margin: 0; background: #ffffff; }
    input, iframe { position: absolute; left: 20px; width: 200px; height: 30px; background: #00aa00; border: 0; }
    #a { top: 10px; } #b { top: 60px; } #c { top: 110px; } #d { top: 160px; } #plain { top: 210px; background: #0000cc; }
    iframe { top: 260px; width: 300px; height: 60px; }
  </style></head><body>
    <input id="a" name="card_number" value="4111">
    <input id="b" name="x" type="text" aria-label="show">
    <input id="c" id2="x" name="otp-code" value="1">
    <input id="d" type="password" value="pw">
    <input id="plain" name="nickname" value="visible">
    <iframe src="__FOREIGN__/frame"></iframe>
    <script>document.getElementById("b").type = "password"; document.getElementById("b").type = "text";</script>
  </body></html>`;
  const shot = async (env: Record<string, string> = {}) => {
    const html = FIELDS.replace("__FOREIGN__", foreign.url);
    const page = await serve(html);
    const live = await LivePage.open(settingsFromEnv({ BASE_URL: page.url, HEAL_VISION: "on", HEAL_ALLOW_ORIGINS: foreign.url, ...env }), "/", vendoredProbe());
    try {
      await live.page.waitForLoadState("load");
      await live.page.waitForSelector("iframe");
      await live.page.waitForTimeout(300);
      const snap = await live.snapshot();
      const png = snap.screenshot ? PNG.sync.read(Buffer.from(snap.screenshot.data, "base64")) : null;
      return { png, notes: live.notes, snap };
    } finally {
      await live.close();
      page.server.close();
    }
  };
  const px = (png: PNG, x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];

  test("name or id matches, a show-password toggle and a cross-origin iframe are painted over; a plain field is not", async () => {
    const { png, snap } = await shot();
    expect(png).not.toBeNull();
    for (const y of [25, 75, 125, 175, 290]) expect(px(png!, 100, y), `y=${y}`).toEqual([255, 0, 255]);
    expect(px(png!, 100, 225)).toEqual([0, 0, 204]); // nickname: visible
    expect(JSON.stringify(snap.inventory)).not.toContain("heal_was_password"); // the marker never reaches the service
  });

  test("when masking fails no screenshot is sent", async () => {
    const live = new LivePage(settingsFromEnv({ BASE_URL: "http://localhost:1", HEAL_VISION: "on" }), "/", "probe");
    live.page = {
      url: () => "http://localhost:1/",
      mainFrame: () => "main",
      frames: () => [{ url: () => "http://other.example/" , frameElement: async () => { throw new Error("detached"); }, locator: () => ({}) }],
      screenshot: async () => { throw new Error("must not be taken"); },
    };
    expect(await live.screenshot()).toBeNull();
    expect(live.notes.join(" ")).toContain("no screenshot sent");
  });

  test("branch code: the client's live check builds each language's branch from the syntax tree", async () => {
    const live = await open(); // lang="fr" page: the button reads Enregistrer
    try {
      await live.snapshot();
      const en = "this.page.getByRole('button', { name: 'Save changes' })";
      const fr = "this.page.getByRole('button', { name: 'Enregistrer' })";
      expect((await live.check(en))[0]).toBe(0);
      const [count, ref] = await live.check(fr);
      expect(count).toBe(1);
      expect(ref).toBe(live.inventory.find((i: { testid?: string }) => i.testid === "save-btn")?.ref);
    } finally {
      await live.close();
    }
  });
});

// ---- the third review: frames judged live, no marker on the page, editable text in frames and shadow roots, the branch the runtime picks
test.describe("third review", { tag: ["@unit", "@security", "@regression"] }, () => {
  const html = (body: string) => `<!doctype html><html lang="en"><head><style>body{margin:0;background:#fff}
    iframe{position:absolute;left:10px;width:200px;height:40px;border:0;background:#00aa00}
    #same{top:10px}#cross{top:60px}#redir{top:110px}#script{top:160px}#sand{top:210px}#plain{top:260px;background:#0000cc}</style></head><body>${body}</body></html>`;

  test("a frame is judged by where it is now: cross-origin, redirected, script-navigated and sandboxed frames are covered, a same-origin one is not", async () => {
    const page = await serve(html(`
      <iframe id="same" src="/frame"></iframe>
      <iframe id="cross" src="${foreign.url}/frame"></iframe>
      <iframe id="redir" src="/redirect-to-foreign"></iframe>
      <iframe id="script" src="/frame"></iframe>
      <iframe id="sand" sandbox="allow-scripts" src="/frame"></iframe>`));
    const live = await LivePage.open(settingsFromEnv({ BASE_URL: page.url, HEAL_VISION: "on", HEAL_ALLOW_ORIGINS: foreign.url }), "/", vendoredProbe());
    try {
      await live.page.route("**/redirect-to-foreign", (r: { fulfill(o: unknown): Promise<void> }) => r.fulfill({ status: 302, headers: { location: `${foreign.url}/frame` } }));
      await live.page.reload();
      await live.page.evaluate((u: string) => { (document.getElementById("script") as HTMLIFrameElement).src = u; }, `${foreign.url}/other`);
      await live.page.waitForTimeout(600);
      const snap = await live.snapshot();
      const png = PNG.sync.read(Buffer.from(snap.screenshot.data, "base64"));
      const px = (y: number) => [...png.data.subarray((y * png.width + 100) * 4, (y * png.width + 100) * 4 + 3)];
      for (const [name, y, covered] of [["same", 30, false], ["cross", 80, true], ["redir", 130, true], ["script", 180, true], ["sand", 230, true]] as const) {
        expect(px(y), name).toEqual(covered ? [255, 0, 255] : [255, 255, 255]);
      }
    } finally {
      await live.close();
      page.server.close();
    }
  });

  test("no heal marker is on the page after a vision capture, and a re-probe lists none", async () => {
    const page = await serve(html(`<input type="password" id="pw" value="x"><input id="tog" type="password" value="y"><script>document.getElementById("tog").type = "text"</script>
      <iframe id="cross" src="${foreign.url}/frame"></iframe>`));
    const live = await LivePage.open(settingsFromEnv({ BASE_URL: page.url, HEAL_VISION: "on", HEAL_ALLOW_ORIGINS: foreign.url }), "/", vendoredProbe());
    try {
      await live.page.waitForTimeout(300);
      const first = await live.snapshot();
      expect(first.screenshot).not.toBeNull();
      const attrs = async () => live.page.evaluate(() => [...document.querySelectorAll("*")].flatMap((e) => e.getAttributeNames().filter((n) => n.includes("heal"))));
      expect(await attrs()).toEqual([]);
      const second = await live.snapshot(); // a re-probe after the capture
      for (const snap of [first, second]) {
        expect(JSON.stringify(snap.inventory)).not.toMatch(/heal/i);
        expect(snap.aria ?? "").not.toMatch(/heal/i);
      }
    } finally {
      await live.close();
      page.server.close();
    }
  });

  test("editable text is emptied in a same-origin frame and in an open shadow root too", async () => {
    const page = await serve(`<html lang="en"><body><div contenteditable aria-label="Top">TOP-SECRET</div>
      <iframe srcdoc='<div contenteditable aria-label="Inner">FRAME-SECRET</div>'></iframe>
      <div id="host"></div><script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML = '<div contenteditable aria-label="Shadow">SHADOW-SECRET</div>'</script></body></html>`);
    const live = await LivePage.open(settingsFromEnv({ BASE_URL: page.url }), "/", vendoredProbe());
    try {
      await live.page.waitForTimeout(300);
      const snap = await live.snapshot();
      expect(JSON.stringify(snap)).not.toMatch(/TOP-SECRET|FRAME-SECRET|SHADOW-SECRET/);
    } finally {
      await live.close();
      page.server.close();
    }
  });

  test("the language a branch check uses is the one html:lang() gives, as at runtime, never the browser locale", async () => {
    const page = await serve('<html><body><p id="a">FR</p><p id="b">EN</p></body></html>'); // no <html lang>
    const live = await LivePage.open(settingsFromEnv({ BASE_URL: page.url }), "/", vendoredProbe());
    try {
      expect(await live.branchKey(["fr", "en"])).toBe("fr"); // nothing matches: the first branch
      expect(await byLanguage(live.page, { fr: live.page.locator("#a"), en: live.page.locator("#b") }).textContent()).toBe("FR"); // what runs
      await live.page.evaluate(() => document.documentElement.setAttribute("lang", "fr-CA"));
      expect(await live.branchKey(["en", "fr"])).toBe("fr");
      expect(await live.branchKey(["fr", "en"])).toBe("fr"); // the first is the default either way
      await live.page.evaluate(() => document.documentElement.setAttribute("lang", "en"));
      expect(await live.branchKey(["fr", "en"])).toBe("en");
      expect(await live.branchKey(["fr", "en", "de"])).toBe("en");
      await live.page.evaluate(() => document.documentElement.setAttribute("lang", "de"));
      expect(await live.branchKey(["en", "fr"])).toBe("en");
    } finally {
      await live.close();
      page.server.close();
    }
  });
});

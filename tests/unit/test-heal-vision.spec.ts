/**
 * Unit tests: HEAL_VISION in the request the client sends (scripts/heal-client.mjs).
 *
 * With vision off no image bytes leave the client: the request carries `page.screenshot: null` and `options.vision: "off"`,
 * even when a live page hands over an image. With auto or on the one screenshot the live page took is sent as
 * {media_type, data, width, height}, and the mode is named. The capture itself (viewport only, masks painted, never taken when
 * off) is tested in a real browser in test-heal-live.spec.ts.
 *
 * @tags @unit
 */
import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import { Healer, settingsFromEnv } from "../../scripts/heal-client.mjs";
import { FakeLive, FakeService, Verify, failureFor, makeProject, reply } from "./heal-helpers.js";

const SHOT = { media_type: "image/png", data: "iVBORw0KGgo=", width: 1280, height: 720 };
let root = "";
test.beforeEach(() => {
  root = makeProject();
});
test.afterEach(() => rmSync(root, { recursive: true, force: true }));

async function sent(env: Record<string, string>, withShot: boolean) {
  const svc = new FakeService([reply("not_drift")]);
  const live = new FakeLive();
  live.snap = {
    path: "/", inventory: [], more: 0, aria: "", viewport: { w: 1280, h: 720, dpr: 1 }, language: { html_lang: "en" },
    screenshot: withShot ? SHOT : null,
  };
  await new Healer(svc.client(), settingsFromEnv(env), new Verify().fn, { root, liveFactory: () => live }).heal(failureFor(root));
  return svc.posts("/v1/heal")[0];
}

test.describe("vision in the request", { tag: ["@unit", "@regression"] }, () => {
  test("off: no image and vision off, even when the live page offers one", async () => {
    for (const env of [{}, { HEAL_VISION: "off" }, { HEAL_VISION: "bogus" }] as Array<Record<string, string>>) {
      const body = await sent(env, true);
      expect(body.page.screenshot).toBeNull();
      expect(body.options.vision).toBe("off");
      expect(JSON.stringify(body)).not.toContain(SHOT.data);
    }
  });

  for (const mode of ["auto", "on"]) {
    test(`${mode}: the one screenshot is sent with its size and the mode is named`, async () => {
      const body = await sent({ HEAL_VISION: mode }, true);
      expect(body.page.screenshot).toEqual(SHOT);
      expect(body.options.vision).toBe(mode);
    });

    test(`${mode}: when the capture failed the request says off and carries no image`, async () => {
      const body = await sent({ HEAL_VISION: mode }, false);
      expect(body.page.screenshot).toBeNull();
      expect(body.options.vision).toBe("off");
    });
  }

  test("a capture note reaches the decision", async () => {
    const svc = new FakeService([reply("not_drift")]);
    const live = new FakeLive();
    live.notes = ["no screenshot sent (TimeoutError); the heal ran on text only"];
    const d = await new Healer(svc.client(), settingsFromEnv({ HEAL_VISION: "on" }), new Verify().fn, { root, liveFactory: () => live })
      .heal(failureFor(root));
    expect(d.notes).toEqual(live.notes);
  });
});

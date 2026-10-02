import { test as base, type Request, type Response } from "@playwright/test";
import { App } from "../pages/app.js";
import { NetworkMocker } from "../utils/network-mocking.js";
import { VisualRegression } from "../utils/visual-regression.js";
import { APICapture } from "../utils/api-capture.js";
import { getUnstableTests } from "../utils/stability-index.js";

type Fixtures = {
  app: App;
  apiMocker: NetworkMocker;
  visualRegression: VisualRegression;
  apiCapture: APICapture;
};

export const test = base.extend<Fixtures>({
  app: async ({ page }, use) => {
    const app = new App(page);
    await use(app);
  },

  apiMocker: async ({ page }, use) => {
    const mocker = new NetworkMocker(page);
    await use(mocker);
    await mocker.clearMocks();
  },

  visualRegression: async ({ page }, use) => {
    const vr = new VisualRegression(page);
    await use(vr);
  },

  // QA-19: capture API traffic and, on failure, attach it to the report.
  apiCapture: [
    async ({ page }, use) => {
      const cap = new APICapture();
      const onReq = (r: Request) => cap.onRequest(r);
      const onRes = (r: Response) => {
        void cap.onResponse(r);
      };
      page.on("request", onReq);
      page.on("response", onRes);

      await use(cap);

      page.off("request", onReq);
      page.off("response", onRes);

      const testInfo = test.info();
      if (testInfo.status !== testInfo.expectedStatus) {
        const json = cap.toJson();
        if (json && json !== "[]") {
          await testInfo.attach(`API Requests: ${testInfo.title}`, {
            body: json,
            contentType: "application/json",
          });
        }
      }
    },
    { auto: true },
  ],
});

// QA-04: quarantine flaky tests. Playwright has no xfail, so quarantined tests
// are skipped (with a clear reason) rather than run-and-ignored — they stop
// blocking CI while their instability is visible in the report.
test.beforeEach(async () => {
  const testInfo = test.info();
  const threshold = parseFloat(process.env.STABILITY_THRESHOLD || "0.7");
  const key = testInfo.titlePath.join(" > ");
  if (getUnstableTests(threshold).includes(key)) {
    testInfo.annotations.push({
      type: "quarantined",
      description: `stability below ${threshold}`,
    });
    test.skip(true, `Quarantined: stability below ${threshold}`);
  }
});

export { expect } from "@playwright/test";

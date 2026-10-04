import { test as base, type Request, type Response } from "@playwright/test";
import { App } from "../pages/app.js";
import { NetworkMocker } from "../utils/network-mocking.js";
import { VisualRegression } from "../utils/visual-regression.js";
import { APICapture } from "../utils/api-capture.js";
import { getUnstableTests } from "../utils/stability-index.js";
import {
  ApiSeeder,
  CleanupRegistry,
  DbSeeder,
  newSeedContext,
  seedApiConfigured,
} from "../utils/data-seeding.js";

type Fixtures = {
  app: App;
  apiMocker: NetworkMocker;
  visualRegression: VisualRegression;
  apiCapture: APICapture;
  cleanup: CleanupRegistry;
  apiSeed: ApiSeeder;
  dbSeed: DbSeeder;
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

  // Tracks created entities; deletes them (newest first) after the test, even on failure.
  // eslint-disable-next-line no-empty-pattern
  cleanup: async ({}, use, testInfo) => {
    const registry = new CleanupRegistry();
    await use(registry);
    const errors = await registry.runAll();
    if (errors.length) {
      await testInfo.attach("cleanup-errors", { body: errors.join("\n"), contentType: "text/plain" });
    }
  },

  // API seeding: create/reset data before a test; created entities are removed on teardown.
  // Skips the test when SEED_API_URL is not configured.
  apiSeed: async ({ cleanup }, use, testInfo) => {
    testInfo.skip(!seedApiConfigured(), "SEED_API_URL not set");
    const ctx = await newSeedContext();
    await use(new ApiSeeder(ctx, cleanup));
    await cleanup.runAll();
    await ctx.dispose();
  },

  // DB seeding/reset via DB_DSN; every call is a no-op when no DSN is set.
  // eslint-disable-next-line no-empty-pattern
  dbSeed: async ({}, use) => {
    const db = new DbSeeder();
    await use(db);
    await db.close();
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

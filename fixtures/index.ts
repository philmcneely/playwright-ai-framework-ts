import { test as base } from "@playwright/test";
import { App } from "../pages/app.js";

// Forward declarations — these will be implemented in Tasks 7 and 8
// For now, use minimal interfaces so fixtures compile
interface NetworkMocker {
  clearMocks(): Promise<void>;
}

interface VisualRegression {}

type Fixtures = {
  app: App;
  apiMocker: NetworkMocker;
  visualRegression: VisualRegression;
};

export const test = base.extend<Fixtures>({
  app: async ({ page }, use) => {
    const app = new App(page);
    await use(app);
  },

  apiMocker: async ({ page }, use) => {
    // Will be replaced with real NetworkMocker in Task 7
    const mocker: NetworkMocker = {
      async clearMocks() {
        await page.unroute("**/*");
      },
    };
    await use(mocker);
    await mocker.clearMocks();
  },

  visualRegression: async ({ page }, use) => {
    // Will be replaced with real VisualRegression in Task 8
    const vr: VisualRegression = {};
    await use(vr);
  },
});

export { expect } from "@playwright/test";

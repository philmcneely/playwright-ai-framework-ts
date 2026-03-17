import { test as base } from "@playwright/test";
import { App } from "../pages/app.js";
import { NetworkMocker } from "../utils/network-mocking.js";
import { VisualRegression } from "../utils/visual-regression.js";

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
    const mocker = new NetworkMocker(page);
    await use(mocker);
    await mocker.clearMocks();
  },

  visualRegression: async ({ page }, use) => {
    const vr = new VisualRegression(page);
    await use(vr);
  },
});

export { expect } from "@playwright/test";

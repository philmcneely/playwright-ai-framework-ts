# Playwright AI Test Framework (TypeScript)

A production-ready Playwright test framework with AI-powered self-healing, visual regression testing, API mocking, and BrowserStack integration. TypeScript port of the [Python version](https://github.com/philmcneely/playwright-ai-framework).

Targets [The Internet](https://the-internet.herokuapp.com) test application.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Configuration](#environment-configuration)
- [Running Tests](#running-tests)
- [Multi-Browser Support](#multi-browser-support)
- [Visual Regression Testing](#visual-regression-testing)
- [API Mocking](#api-mocking)
- [AI Self-Healing](#ai-self-healing)
- [BrowserStack Integration](#browserstack-integration)
- [CI/CD Setup](#cicd-setup)
- [Directory Structure](#directory-structure)
- [Python to TypeScript Migration](#python-to-typescript-migration)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js 22+** — [Download](https://nodejs.org/)
- **npm** (included with Node.js)
- **Ollama** (optional, for AI self-healing) — [Install](https://ollama.ai)
- **Allure CLI** (optional, for Allure reports) — `brew install allure` on macOS

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/philmcneely/playwright-ai-framework-ts.git
cd playwright-ai-framework-ts

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install --with-deps

# Copy environment template
cp .env.example .env.dev

# Run smoke tests
npm run test:smoke
```

---

## Environment Configuration

The framework loads environment variables from `.env` files using [dotenv](https://www.npmjs.com/package/dotenv). It loads `.env` first, then `.env.<ENV>` (defaulting to `.env.dev`).

Copy `.env.example` and customize per environment:

```bash
cp .env.example .env.dev    # Development
cp .env.example .env.test   # Test
cp .env.example .env.prod   # Production
```

Switch environments at runtime:

```bash
ENV=test npx playwright test
```

### Key Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `https://the-internet.herokuapp.com` | Application under test |
| `ENV` | `dev` | Environment name (loads `.env.<ENV>`) |
| `BROWSER` | `chromium` | Browser engine: `chromium`, `firefox`, `webkit` |
| `HEADLESS` | `true` | Run browser headless |
| `SLOW_MO` | `100` | Slow down actions by N ms |
| `TIMEOUT` | `30000` | Global test timeout in ms |
| `RETRY_COUNT` | `3` | Number of retries on failure |
| `SCREENSHOT_ON_FAILURE` | `true` | Capture screenshot on failure |
| `VIDEO_ON_FAILURE` | `true` | Record video, retained on failure |
| `AI_HEALING_ENABLED` | `false` | Enable AI self-healing analysis |
| `OLLAMA_MODEL` | `llama3.1:8b` | Ollama model for healing |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_TEMPERATURE` | `0.1` | LLM temperature |
| `AI_HEALING_CONFIDENCE` | `0.7` | Confidence threshold for healing suggestions |
| `AI_HEALING_CONTEXT_WINDOW` | `5000` | Max DOM characters sent to the model |
| `BROWSERSTACK_ENABLED` | `false` | Run on BrowserStack |
| `BROWSERSTACK_USERNAME` | — | BrowserStack username |
| `BROWSERSTACK_ACCESS_KEY` | — | BrowserStack access key |
| `DEBUG_MSG` | `false` | Verbose debug logging |

---

## Running Tests

All commands use `@playwright/test` via the scripts defined in `package.json`.

```bash
# Full test suite (default project: chromium)
npm test

# Smoke tests only
npm run test:smoke

# Visual regression tests
npm run test:visual

# Security / login attack tests
npm run test:security

# API mocking tests
npm run test:api

# Headed mode (browser visible)
npm run test:headed

# Debug mode (Playwright Inspector)
npm run test:debug
```

### Passing Extra Options

Append flags after `--`:

```bash
# Run a specific test file
npx playwright test tests/login/test-login.spec.ts

# Run against Firefox
npx playwright test --project=firefox

# Filter by tag
npx playwright test --grep @smoke --project=chromium

# Generate and view Allure report
npm run allure:generate
npm run allure:open
```

---

## Multi-Browser Support

Three browser projects are configured in `playwright.config.ts`:

| Project | Engine | Device Profile |
|---|---|---|
| `chromium` | Chromium | Desktop Chrome |
| `firefox` | Firefox | Desktop Firefox |
| `webkit` | WebKit | Desktop Safari |

Run against a specific browser:

```bash
npx playwright test --project=firefox
```

Run against all browsers:

```bash
npx playwright test --project=chromium --project=firefox --project=webkit
```

---

## Visual Regression Testing

Uses [pixelmatch](https://github.com/mapbox/pixelmatch) and [pngjs](https://github.com/lukeapage/pngjs) for pixel-level screenshot comparison. No external services required.

### How It Works

1. **First run** — saves a baseline screenshot.
2. **Subsequent runs** — compares current screenshot against baseline.
3. **If diff exceeds tolerance** — test fails and a diff image is saved.

### File Locations

| Directory | Purpose |
|---|---|
| `test_artifacts/visual/visual_baselines/` | Stored baseline images |
| `test_artifacts/visual/visual_current/` | Current run screenshots |
| `test_artifacts/visual/visual_diffs/` | Diff images (only on failure) |

### Usage in Tests

```typescript
import { test, expect } from "../../fixtures/index.js";

test("homepage visual check @visual", async ({ visualRegression, page }) => {
  await page.goto("/");
  const result = await visualRegression.compare("homepage", {
    tolerance: 0.02,   // 2% pixel difference allowed
    fullPage: true,
  });
  expect(result.passed).toBeTruthy();
});
```

### Options

- `selector` — CSS selector for element-level screenshots
- `fullPage` — capture the full scrollable page (default: `false`)
- `tolerance` — max fraction of differing pixels (default: `0.01` = 1%)

### Managing Baselines

Delete a baseline to regenerate it on the next run. The utility also exports helper functions:

```typescript
import { resetBaseline, resetAllBaselines, listVisualFiles } from "../utils/visual-regression.js";

resetBaseline("homepage");    // Delete one baseline
resetAllBaselines();          // Delete all baselines
listVisualFiles();            // List all visual artifacts
```

---

## API Mocking

The `NetworkMocker` utility wraps Playwright's route interception with a clean API for mocking HTTP requests.

### Usage in Tests

The `apiMocker` fixture is available automatically through `test.extend()`:

```typescript
import { test, expect } from "../../fixtures/index.js";

test("mock API response @api", async ({ apiMocker, page }) => {
  await apiMocker.mockGet("**/api/users", { users: [{ id: 1, name: "Test" }] });
  await page.goto("/some-page");
  // The mocked response will be returned for any matching GET request
});
```

### Available Methods

| Method | Description |
|---|---|
| `mockGet(pattern, body, options?)` | Mock GET requests |
| `mockPost(pattern, body, options?)` | Mock POST requests |
| `mockPut(pattern, body, options?)` | Mock PUT requests |
| `mockDelete(pattern, body, options?)` | Mock DELETE requests |
| `mockFromFile(pattern, filePath, method?, options?)` | Load mock data from a JSON file |
| `mockWithFunction(pattern, handler, method?, options?)` | Dynamic response via callback |
| `simulateNetworkFailure(pattern)` | Abort matching requests |
| `simulateSlowNetwork(pattern, delayMs)` | Add latency before continuing |
| `simulateOffline()` | Abort all requests |
| `clearMocks()` | Remove all registered mocks |
| `getRequestLog()` / `getResponseLog()` | Inspect intercepted traffic |

### Mock Templates

Pre-built response templates for common HTTP scenarios:

```typescript
import { getMockTemplate } from "../utils/network-mocking.js";

const template = getMockTemplate("unauthorized"); // 401 response
// Available: success, created, noContent, badRequest, unauthorized, forbidden, notFound, serverError
```

---

## AI Self-Healing

When a test fails after all retries, the AI healing system queries a local [Ollama](https://ollama.ai) instance to analyze the failure and suggest fixes. Reports are saved as Markdown files.

### Setup

1. Install Ollama: https://ollama.ai
2. Pull a model:

```bash
# Text-only (faster, smaller)
ollama pull llama3.1:8b

# Vision + text (can analyze failure screenshots)
ollama pull llava:7b
```

3. Enable in your `.env` file:

```
AI_HEALING_ENABLED=true
OLLAMA_MODEL=llama3.1:8b
```

### How It Works

1. `AIHealingReporter` is registered in `playwright.config.ts` as a custom reporter.
2. On each test failure, the reporter tracks retry counts.
3. After the **final** failure (all retries exhausted), it triggers healing:
   - Reads the test source file
   - Collects error details and any failure screenshots
   - Sends a structured prompt to Ollama
   - Parses the JSON response (with 6 fallback parsing strategies)
   - Writes a Markdown report to `test_artifacts/ai/ai_healing_reports/`
   - Optionally saves a healed `.ts` file if the model provides updated code

### Running the Demo

A dedicated test exists to trigger AI healing intentionally:

```bash
AI_HEALING_ENABLED=true npx playwright test --grep @trigger_ai_healing --project=chromium
```

Reports appear in `test_artifacts/ai/ai_healing_reports/`.

### Architecture Note

The Python version uses `pytest_runtest_makereport` hooks. The TypeScript version uses Playwright's custom Reporter API (`AIHealingReporter`), which receives `onTestEnd` callbacks with full access to test metadata, errors, and attachments.

---

## BrowserStack Integration

Run tests on real browsers in the cloud via [BrowserStack Automate](https://www.browserstack.com/).

### Setup

1. Set credentials in your `.env` file:

```
BROWSERSTACK_ENABLED=true
BROWSERSTACK_USERNAME=your_username
BROWSERSTACK_ACCESS_KEY=your_access_key
```

2. Run tests:

```bash
npx playwright test --project=browserstack
```

### How It Works

When `BROWSERSTACK_ENABLED=true`, an additional `browserstack` project is added to `playwright.config.ts` that connects via WebSocket to BrowserStack's CDP endpoint. The default capabilities target Chrome on macOS Sonoma. Customize in `utils/browserstack.ts`.

When `BROWSERSTACK_ENABLED=false`, the `browserstack` project is not registered and all tests run locally.

---

## CI/CD Setup

A GitHub Actions workflow is provided at `.github/workflows/smoke-full.yml`.

### Pipeline Structure

```
push/PR to main ──> Smoke Job ──> (pass) ──> Full Job
                                  (fail) ──> Stop
```

**Smoke job:**
- Installs Node 22, runs `npm ci`, installs Chromium only
- Runs tests matching `@smoke` against the `chromium` project
- Uploads `playwright-report/` as an artifact

**Full job:**
- Depends on smoke passing
- Installs all browsers
- Runs the complete test suite
- Uploads the full report

### Secrets

No secrets are required for the default configuration (tests target a public site). If you add authenticated tests, configure repository secrets and reference them in the workflow `env` block.

---

## Directory Structure

```
playwright-ai-framework-ts/
├── .env.example                    # Environment variable template
├── .github/
│   └── workflows/
│       └── smoke-full.yml          # CI/CD pipeline
├── config/
│   ├── artifact-paths.ts           # Centralized artifact directory paths
│   ├── index.ts                    # Config barrel export
│   └── settings.ts                 # Environment-driven settings
├── data/
│   ├── index.ts                    # Data barrel export
│   └── test-data.ts                # Test personas, credentials, expected messages
├── fixtures/
│   └── index.ts                    # test.extend() with app, apiMocker, visualRegression
├── pages/
│   ├── app.ts                      # App facade (aggregates all page objects)
│   ├── base-page.ts                # Base page with shared helpers
│   ├── index.ts                    # Pages barrel export
│   ├── login-page.ts               # Login page object
│   └── secure-page.ts              # Secure area page object
├── tests/
│   ├── ai-healing/
│   │   └── test-ai-healing-trigger.spec.ts
│   ├── api/
│   │   └── test-api-mocking.spec.ts
│   ├── login/
│   │   ├── test-login.spec.ts
│   │   └── test-login-attacks.spec.ts
│   └── visual/
│       └── test-visual-regression.spec.ts
├── utils/
│   ├── ai-healing.ts               # Ollama healing service
│   ├── ai-healing-reporter.ts      # Custom Playwright Reporter
│   ├── browserstack.ts             # BrowserStack capability builder
│   ├── decorators.ts               # Utility decorators
│   ├── network-mocking.ts          # NetworkMocker + templates
│   └── visual-regression.ts        # pixelmatch-based visual comparison
├── test_artifacts/                  # Generated at runtime (gitignored)
│   ├── ai/ai_healing_reports/      # AI analysis Markdown reports
│   ├── allure/                     # Allure results and reports
│   └── visual/                     # Baselines, current screenshots, diffs
├── package.json
├── playwright.config.ts
└── tsconfig.json
```

---

## Python to TypeScript Migration

This project is a full TypeScript port of the [Python Playwright AI Framework](https://github.com/philmcneely/playwright-ai-framework). The following table maps each Python feature to its TypeScript equivalent.

| Python Feature | TypeScript Equivalent |
|---|---|
| `pytest` + `pytest-asyncio` | `@playwright/test` (built-in async) |
| `conftest.py` (page fixture) | `fixtures/index.ts` via `test.extend()` |
| `config/settings.py` | `config/settings.ts` |
| `config/artifact_paths.py` | `config/artifact-paths.ts` |
| `pages/` (Page Object Model) | `pages/` (Page Object Model) |
| `data/test_data.py` | `data/test-data.ts` |
| `utils/ai_healing.py` | `utils/ai-healing.ts` |
| `pytest_runtest_makereport` hook | `AIHealingReporter` (custom Reporter) |
| `utils/visual_regression.py` (OpenCV) | `utils/visual-regression.ts` (pixelmatch + pngjs) |
| `utils/network_mocking.py` | `utils/network-mocking.ts` |
| `@screenshot_on_failure` decorator | Built-in Playwright config (`screenshot: "only-on-failure"`) |
| `@retry_decorator` | Built-in Playwright config (`retries`) |
| BrowserStack integration | `utils/browserstack.ts` + config project |
| `.github/workflows/` | `.github/workflows/smoke-full.yml` |
| Allure via pytest plugin | `allure-playwright` package |
| `requirements_with_versions.txt` | `package.json` (npm) |
| Python virtual environment | Node.js (no venv needed) |
| `python-dotenv` | `dotenv` npm package |

### Key Architectural Differences

- **No conftest.py** — Fixtures are defined via `test.extend<Fixtures>()` in `fixtures/index.ts` and imported by test files.
- **No pytest markers** — Tags are embedded in test titles (e.g., `@smoke`, `@visual`) and filtered with `--grep`.
- **Visual regression** — Python used OpenCV; TypeScript uses pixelmatch (pure JS, no native dependencies).
- **Reporter vs hooks** — Python used pytest hooks; TypeScript uses Playwright's Reporter API, which provides structured callbacks for test lifecycle events.

---

## Troubleshooting

### Browser installation errors

```
Error: Executable doesn't exist at ...
```

Run `npx playwright install --with-deps` to download all browser binaries and system dependencies.

### Missing environment variables

```
Error: BASE_URL is not defined
```

Ensure you have copied `.env.example` to `.env.dev` (or the file matching your `ENV` value) and that the variables are set.

### Ollama not responding

```
[AI Healing] Ollama service not running, attempting to start...
```

- Verify Ollama is installed: `ollama --version`
- Start it manually: `ollama serve`
- Check the model is pulled: `ollama list`
- Test connectivity: `curl http://localhost:11434/api/tags`

### Visual regression baseline mismatch

If baselines were generated on a different OS or screen resolution, delete the baseline and re-run to regenerate:

```bash
rm test_artifacts/visual/visual_baselines/<name>.png
npx playwright test --grep @visual
```

### TypeScript compilation errors

The project uses `NodeNext` module resolution. Ensure imports include the `.js` extension:

```typescript
// Correct
import { settings } from "./config/settings.js";

// Wrong — will fail at runtime
import { settings } from "./config/settings";
```

### BrowserStack connection failures

- Verify credentials: `echo $BROWSERSTACK_USERNAME`
- Check that `BROWSERSTACK_ENABLED=true` is set
- Ensure your BrowserStack account is active and has available parallel slots

### Allure reports not generating

Install the Allure CLI, then run:

```bash
npm run allure:generate
npm run allure:open
```

On macOS: `brew install allure`. On Linux, download from [GitHub Releases](https://github.com/allure-framework/allure2/releases).

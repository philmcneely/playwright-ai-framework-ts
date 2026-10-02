# Enhancement Roadmap

Future improvements and ideas for the Playwright AI Test Framework (TypeScript).

---

## High Priority

### Parallel Test Sharding
- Configure `fullyParallel: true` in `playwright.config.ts`
- Add CI matrix strategy to shard across multiple runners
- Benchmark and tune worker count per environment

### Test Data Factory
- Replace static test data objects with a factory pattern (e.g., using `@faker-js/faker`)
- Support dynamic generation of usernames, emails, and credentials per run
- Avoid data collisions in parallel execution

### Authentication State Caching
- Use Playwright's `storageState` to save and reuse login sessions
- Add a global setup script that authenticates once and shares state across tests
- Reduce test suite runtime by eliminating redundant logins

### Accessibility Testing
- Integrate `@axe-core/playwright` for automated WCAG compliance checks
- Add an `@a11y` tag and dedicated test suite
- Generate actionable accessibility violation reports

---

## Medium Priority

### Performance Metrics Collection
- Use Playwright's `page.evaluate(() => performance.getEntries())` to capture Web Vitals
- Track LCP, FID, CLS, TTFB across test runs
- Output metrics to `test_artifacts/performance/` as JSON and HTML reports
- Set thresholds and fail tests on performance regressions

### API Contract Testing
- Add tests that validate API responses against OpenAPI/Swagger schemas
- Use `ajv` or `zod` for runtime schema validation
- Catch backend contract changes before they break the UI

### Mobile Viewport Testing
- Add projects for mobile devices (iPhone, Pixel) using Playwright device descriptors
- Cover responsive layouts and touch interactions
- Integrate into the CI matrix

### Custom HTML Reporter
- Build a custom Playwright reporter that produces a single-file HTML dashboard
- Include pass/fail summary, timing charts, screenshot gallery, and AI healing summaries
- Replace or supplement the default HTML report

### Database Seeding / Teardown
- Add hooks for test data setup and cleanup against a real database
- Support transaction-based isolation (seed before, rollback after)
- Useful when moving beyond static test sites

---

## Low Priority / Exploratory

### AI Healing Improvements
- **Model comparison**: Run healing against multiple models and pick the best suggestion
- **Confidence voting**: Require agreement across N models before auto-applying fixes
- **Historical tracking**: Store healing results over time and identify recurring failure patterns
- **Auto-apply mode**: When confidence exceeds a threshold, automatically update the test source and open a PR

### Visual Regression Enhancements
- Support anti-aliasing tolerance via pixelmatch options
- Add region masking (ignore dynamic areas like timestamps or ads)
- Generate HTML comparison reports (side-by-side baseline/current/diff)
- Store baselines in a separate git branch or external storage for cleaner diffs

### Network Replay / HAR Recording
- Record HAR files during manual exploration
- Replay recorded network traffic in tests for deterministic results
- Useful for testing against unstable or rate-limited third-party APIs

### Playwright Component Testing
- Add component test configuration for testing UI components in isolation
- Support React, Vue, or Svelte component mounts
- Run component tests alongside e2e tests in CI

### Docker Test Environment
- Provide a `Dockerfile` and `docker-compose.yml` for running the full suite in a container
- Bundle Playwright, browsers, and Ollama in a single image
- Ensure CI parity with local development

### Slack / Teams Notifications
- Send test results summary to a Slack or Teams channel after CI runs
- Include pass/fail counts, duration, and links to reports
- Alert on new failures or flaky test detection

### Flaky Test Detection
- Track test outcomes across runs and flag tests that intermittently fail
- Auto-quarantine flaky tests into a separate suite
- Surface flakiness metrics in reports

### Tag-Based Test Organization
- Formalize tag conventions (`@smoke`, `@regression`, `@p0`, `@p1`)
- Add a `test:regression` npm script
- Document tag taxonomy in the README

---

## Completed (from initial port)

- [x] Project scaffold with TypeScript + ESM
- [x] Config and artifact path management
- [x] Playwright config with multi-browser projects
- [x] Page Object Model (Login, Secure, Base, App)
- [x] Test data and personas
- [x] Custom fixtures via `test.extend()`
- [x] Network mocking utility with templates
- [x] Visual regression with pixelmatch
- [x] AI test agents (official Playwright planner/generator/healer + MCP)
- [x] Login test suite (valid, invalid, security attacks)
- [x] Screenshot and retry via Playwright config
- [x] BrowserStack integration
- [x] GitHub Actions CI/CD
- [x] Documentation (README + this roadmap)
- [x] **Stability index + flaky-test quarantine** (QA-04)
- [x] **API request/response capture** (QA-19)
- [x] **OWASP ZAP passive scanning** (QA-24)

---

## QA Quick Wins (delivered)

Mirror of the Python framework's QA quick wins, adapted to the Playwright runner.

### QA-04: Stability Index

Tracks pass/fail per test across the last 10 runs (`data/stability_history.json`,
override with `STABILITY_HISTORY_FILE`). `utils/stability-reporter.ts` records each
attempt; `fixtures/index.ts` quarantines tests whose stability drops below
`STABILITY_THRESHOLD` (default `0.7`).

| Setting | Default | Description |
|---------|---------|-------------|
| `STABILITY_THRESHOLD` | `0.7` | Tests below this score are quarantined |

> Playwright has no `xfail`, so quarantined tests are **skipped** with a clear
> reason (annotated `quarantined`) rather than run-and-ignored — they stop blocking
> CI while their instability stays visible in the report.

### QA-19: API Request/Response Capture

`utils/api-capture.ts` is wired onto the `page` fixture (auto). Static assets are
filtered out and response bodies capped at 10 KB. On failure, captured traffic is
attached to the report as `API Requests: {test}` (JSON). Always active, no config.

### QA-24: OWASP ZAP Passive Scanning

`utils/zap-integration.ts` optionally routes browser traffic through ZAP.

| Setting | Default | Description |
|---------|---------|-------------|
| `ZAP_ENABLED` | `false` | Enable the ZAP proxy integration |
| `ZAP_API_KEY` | `""` | ZAP API key (if configured) |

**Setup:**
1. Start ZAP: `docker run -p 8080:8080 zaproxy/zap-stable zap.sh -daemon -port 8080 -config api.disablekey=true`
2. Set `ZAP_ENABLED=true` and run tests — traffic routes through ZAP.

ZAP's REST API is reached via the global `fetch` — **no new dependency**.

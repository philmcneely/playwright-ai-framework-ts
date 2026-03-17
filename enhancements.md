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
- [x] AI self-healing service and reporter
- [x] Login test suite (valid, invalid, security attacks)
- [x] Screenshot and retry via Playwright config
- [x] BrowserStack integration
- [x] GitHub Actions CI/CD
- [x] Documentation (README + this roadmap)

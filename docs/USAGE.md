# Using the AI test agents & the heal CLI

There are two ways to put a model to work in this framework. Pick by whether you
want a model **in an interactive loop** (authoring/triage) or a **headless,
pick-any-model call** (CI / nightly automation).

| | Path 1 — Claude Code + MCP agents | Path 2 — the `heal` CLI |
|---|---|---|
| Model | the agent loop host (Claude; or opencode/codex → any model) | any OpenAI-compatible endpoint (OpenRouter / local / fleet Qwen) |
| Needs | Claude Code (or another loop host) | just Node — no Claude Code |
| Best for | authoring tests, judgment-heavy healing | CI / nightly / unattended healing |

---

## Path 1 — Claude Code + the MCP agents (planner / generator / healer)

Scaffolded by `npx playwright init-agents --loop=claude` (already done — see
`.claude/agents/*.md` and `.mcp.json`).

```bash
cd <this repo>
claude            # launch Claude Code in the repo
```

Claude Code auto-reads **`.mcp.json`** → starts the Playwright MCP server
(`npx playwright run-test-mcp-server`, exposing `browser_*` + `test_run`/
`test_debug` tools) and loads the three subagents from **`.claude/agents/`**.
Then drive them conversationally:

- **Plan** — "Use the playwright-test-planner agent to explore the app and write
  a test plan." → explores via accessibility snapshots, writes Markdown to `specs/`.
- **Generate** — "Use the playwright-test-generator agent to turn
  `specs/<plan>.md` into tests." → drives a real browser via MCP and writes spec files.
- **Heal** — "Use the playwright-test-healer agent to fix the failing tests." →
  runs the suite, reproduces each failure in the browser, updates **locators only**
  (never the test's intent), re-runs until green; marks a test `test.fixme()` only
  when it's confident the test is right and the app is at fault.

**Use a different model to drive the agents:** re-run
`npx playwright init-agents --loop=opencode` (or `codex`) and point that tool's
provider at any OpenAI-compatible endpoint (OpenRouter, a local server, our Qwen).
The agents are just Markdown prompts + MCP tools; the loop host supplies the model.

---

## Path 2 — the `heal` CLI (headless, any model)

`scripts/heal.mjs` (`npm run heal`) is the out-of-band healer — the engine the
overnight job uses, and usable on demand. **No Claude Code required**; it makes a
direct call to whatever model you point it at.

```bash
BASE_URL=<app-url> \
HEAL_BASE_URL=<openai-compatible endpoint> \
HEAL_MODEL=<model id> \
[HEAL_API_KEY=<key>] \
npm run heal -- [--grep <name>] [--max N] [--open-pr] [--tickets off|annotate|file]
```

What it does, per failing test: run it → reproduce in a real browser → read the
**live accessibility snapshot** → ask `HEAL_MODEL` for a resilient semantic locator
→ apply → **re-run to verify**. Locators only; a failure it can't make pass is
reverted and flagged for a human. `--open-pr` assembles one PR with the decisions.

**Model examples (the "hook up any model" knob):**
```bash
# Fleet Qwen3.8-27B via its attributed proxy (route fleet models through the proxy)
HEAL_BASE_URL=http://192.168.1.47:3025/v1 HEAL_MODEL='ollama@localhost/qwen3.8-27b:latest' npm run heal

# OpenRouter
HEAL_BASE_URL=https://openrouter.ai/api/v1 HEAL_MODEL='anthropic/claude-...' HEAL_API_KEY=sk-or-... npm run heal

# Local Ollama (OpenAI-compatible endpoint)
HEAL_BASE_URL=http://localhost:11434/v1 HEAL_MODEL='qwen3:8b' npm run heal
```

**Flags:**
- `--grep <name>` — scope to matching tests.
- `--max N` — cap how many failures it handles in a run.
- `--open-pr` — commit the heals on a branch and open one PR (decisions + the
  untouched/for-human list).
- `--tickets off|annotate|file` — suspected app-bugs (genuine regressions it won't
  "heal"): `annotate` (default) surfaces any matching open ticket in the PR;
  `file` creates deduped tickets. `TICKET_TARGETS=clickup,jira` selects systems
  (needs their creds in env — see the deploying repo's ops docs).

---

## Writing a new test (author workflow)

### A. You have a capable agent (Claude Code, or opencode/codex on a real model)
1. **Plan** — ask the planner agent to explore the feature; it writes
   `specs/<feature>.md`. Review and trim it — this is a human gate.
2. **Generate** — ask the generator agent to turn a plan item into a spec; it
   drives the browser via MCP and writes `tests/.../<name>.spec.ts` with real,
   resilient locators.
3. **Review** — read the generated test (never merge blind). Make assertions
   about behavior/structure, not pinned data.
4. **Run** `npm test`. From here the **healer** maintains the locators when the
   UI drifts (interactively, or via the nightly `heal` CLI).

### B. No agent, or a token-limited one (e.g. Copilot on a tight budget)
You don't need an LLM to author a test — use Playwright's recorder, then refactor:
1. **Record (zero tokens)** — `npx playwright codegen <url>`; click through the
   flow and it writes a working test with real locators.
2. **Refactor to conventions** — move locators into a page object under `pages/`,
   prefer the resilient hierarchy `getByRole` → `getByLabel` → `getByPlaceholder`
   → `getByText` → `getByTestId` → CSS/XPath (last resort), and keep assertions
   about **structure/behavior, not specific data** (data changes; structure is
   what the test should pin).
3. **Spend the limited agent sparingly** — one focused prompt ("turn this recorded
   flow into a page object + spec matching `pages/login-page.ts`") costs a
   fraction of an explore/generate loop. Don't use it to *explore*.
4. **Maintenance stays cheap** — the `heal` CLI runs only on failures and can
   point at a **local/cheap model** (e.g. local Ollama), so keeping tests green
   never burns your Copilot/agent budget.

Conventions either way: one feature per spec, `@smoke`/tag markers, resilient
semantic locators, data-agnostic assertions, and page objects for anything reused.

## Which path?
- **Authoring new tests / interactive triage** → Path 1 (Claude Code + agents).
- **CI, nightly, unattended, swap models freely** → Path 2 (the `heal` CLI).

A real deployed example of Path 2 (dockerized nightly on a Linux host, systemd
timer, heal→PR) lives in the `switchboard-e2e` repo's `deploy/` + its docs.

---

## Tags, reporters and retries

### Tag convention

Tag tests with Playwright's native `tag` option (on `test` or `test.describe`);
a describe's tags are inherited by every test inside it.

```ts
test.describe("Cart", { tag: ["@cart", "@regression"] }, () => {
  test("add item", { tag: ["@smoke", "@p0", "@positive"] }, async ({ app }) => { /* ... */ });
});
```

Standard markers (use these exact names):

| Kind | Tags |
|---|---|
| Suite | `@smoke`, `@regression` |
| Priority | `@p0` (blocker) `@p1` `@p2` `@p3` (nice-to-have) |
| Case type | `@positive`, `@negative`, `@boundary` |
| Model-involved | `@llm` (tests that call an LLM / depend on model output) |
| Feature | any area tag, e.g. `@login`, `@cart`, `@security`, `@visual` |

Filter with `--grep` / `--grep-invert` (regex over title + tags):

```bash
npx playwright test --grep @smoke
npx playwright test --grep @login
npx playwright test --grep "@smoke|@p0"           # either tag
npx playwright test --grep "(?=.*@login)(?=.*@negative)"   # both tags
npx playwright test --grep-invert @llm            # everything except @llm
npx playwright test --grep @smoke --grep-invert @security
npx playwright test --grep @smoke --list          # preview the selection
```

### Reports and artifacts

Every run writes to `results/` (git-ignored):

| Output | Path |
|---|---|
| Console | `list` reporter |
| HTML report | `results/html/` (`npx playwright show-report results/html`) |
| JUnit | `results/junit.xml` |
| JSON | `results/results.json` |
| Traces / screenshots | `results/artifacts/` — trace `retain-on-failure`, screenshot `only-on-failure`, video off |

The Jira, observability and stability reporters still run alongside these.

### Retries and workers

| Env var | Default | Effect |
|---|---|---|
| `PW_RETRIES` | `0` | Retries per failed test (`PW_RETRIES=2` in CI to surface flakes) |
| `PW_WORKERS` | Playwright default | Parallel workers (`PW_WORKERS=1` to serialize) |

```bash
PW_RETRIES=2 PW_WORKERS=4 npx playwright test --grep @regression
npx playwright test --retries=1 --workers=2     # CLI flags override the config
```

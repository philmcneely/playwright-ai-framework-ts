# v3 — Declarative Component/Data Test Architecture

> Status: **planned, not started.** Prototype on this branch (`v3/declarative-components`).
> May be broken out into its own repository — this doc is written to be self-contained
> so it can move.

## Vision

Tests are authored as **data that describes intent** — *components, data, and expected
outcomes* — while a library of rich **Playwright component objects** owns the *how*. The
JSON "knows nothing" about Playwright: no selectors, no waits, no steps. This keeps the
declarative layer simple for non-devs (and LLMs) while letting the code layer use
Playwright to its fullest with zero abstraction tax.

Lineage: the **Screenplay pattern** (actors/tasks/abilities/questions) + **component
objects** + a thin declarative scenario layer. Maps onto the existing **L1/L2/L3**
(Pages → Page Flows → Journeys) model.

## The three layers

### 1. Scenario (the JSON — intent only)
Names a component, a domain action, data, and an expected end-state. No mechanics.
```json
{
  "scenario": "valid login",
  "component": "LoginForm",
  "do": "submit",
  "data": { "username": "tomsmith", "password": "${SECRET}" },
  "expect": "SecureArea"
}
```
Journeys compose components:
```json
{ "journey": "checkout", "play": [
  { "component": "ProductPage", "do": "addToCart", "data": { "sku": "X" } },
  { "component": "Cart", "do": "checkout" },
  { "expect": "OrderConfirmation" } ] }
```

### 2. Components (the code — full Playwright)
Each component encapsulates its locators + domain behaviors, using the framework well
(web-first assertions, role/aria locators, fixtures, tracing). Outcomes are predicates.
```ts
export class LoginForm implements Component {
  constructor(private page: Page) {}
  async submit({ username, password }: Creds) {
    await this.page.getByLabel("Username").fill(username);
    await this.page.getByLabel("Password").fill(password);
    await this.page.getByRole("button", { name: "Login" }).click();
  }
}
export class SecureArea implements Outcome {
  async satisfied(page: Page) {
    await expect(page.getByText("You logged into a secure area!")).toBeVisible();
  }
}
```

### 3. Resolver (thin runtime)
Registry (`name → class`) + dispatch (`do → method`) + outcome check. It **delegates**;
it never interprets steps. Control flow lives in code (components/journeys), not JSON —
this is what prevents the JSON from becoming a programming language.

## Why this beats step-level JSON
- **JSON stays declarative** — it composes high-level capabilities, so no loops/conditionals/waits leak into data.
- **No leaky abstraction** — components use any Playwright feature; the JSON never forces a lowest-common-denominator.
- **Swappability at the component contract** (`submit`, `isLoaded`), not primitive steps — you can reimplement a component in another tool without dumbing Playwright down.

## Synergy with v2 (healer + generator)
- **Healer:** selectors live *only* in components, so UI drift is patched in **component code** (grounded in the MCP aria-snapshot). JSON scenarios **never change** — drift is contained to one layer. Cleaner than editing test source.
- **Generator:** the authoring vocabulary is a small, documented domain language (components × actions), which an LLM can author **scenarios** in far more reliably than raw selectors.
- Division of AI labor: LLM writes **scenarios** (data) + maintains **components** (code, via the healer); engineers design the component library.

## Cost / tradeoffs (honest)
- Up-front investment in a **component library + registry/resolver**.
- The JSON's expressiveness = the components × actions you've built; new capability = extend a component (code) + reference it in JSON.
- Indirection: a failure can be in the scenario, the resolver, or a component — needs good error attribution in the resolver.

## Phased build (when we return)
1. **Spike (this branch):** `Component`/`Outcome` interfaces, a `registry`, a ~30-line resolver, `LoginForm` + `SecureArea`, and `login.flow.json` running green against the container.
2. **Journeys:** multi-component composition + shared data/fixtures.
3. **Healer integration:** teach the healer to patch component locators (JSON untouched).
4. **Generator integration:** author scenarios from a component catalog.
5. **Decision:** keep in-framework vs. break out into its own repo (consumes the framework as a dependency).

## Open questions
- Repo boundary: in-framework module vs. standalone repo (likely standalone once the component library grows).
- Data layer: inline in JSON vs. external fixtures/factories with `${...}` interpolation + secrets.
- Outcome vocabulary: component-state predicates vs. free assertions — keep it to named outcomes to stay declarative.

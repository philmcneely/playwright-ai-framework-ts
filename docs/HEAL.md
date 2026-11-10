# Locator healing through the heal service

`npm run heal` (`scripts/heal.mjs`) repairs drifted Playwright locators **out of band**: it runs the suite, sends the evidence
for each failure to a **heal service**, applies the locator the service writes, re-runs the exact test and keeps the edit
only when that test passes. It heals **locators only**, never assertions or test intent. A failure it cannot make pass is
reverted and reported for a human (usually an app bug, not drift).

**This repository contains no model.** There is no model URL, no model name, no prompt and no parsing of a model reply here.
The service owns the model calls and the healing rules; the framework is the *client*: HTTP, the browser, the source files
and its own safety checks. (The Python framework, `playwright-ai-framework`, ships the same client in Python and both pass the
same contract fixtures.)

## How a heal goes

```
npm run heal -- [--grep <name>] [--max N] [--open-pr]
```

1. Run the suite with the JSON reporter (`HEAL_RUN=1` is set for the child so nothing is recorded as a green run, and
   `HEAL_CAPTURE=1` so a failing test attaches its page as it left it) and collect the failures: message, stack and, when the
   framework's fixtures are used, the page path and the **capture** at the failure (see below).
2. For each failure reopen the failing route in a fresh Chromium (`HEAL_STORAGE_STATE` signs it in), run the **vendored page
   probe** (`scripts/heal-probe.js`) for the element inventory, read the aria snapshot and the language signals, and send
   one request to the service. When the failure carries a capture, its inventory and aria snapshot are sent instead of the
   reopened page's (which has lost whatever the test had opened: a panel, a tab, a dialog). The request holds the stack's files under the source roots (with sha256), the inventory (with the counts of
   elements the probe left out for want of room: `inventory_more` for the listing, `inventory_copy_more` for elements that hold
   only copy; `inventory_copy_withheld` for visible copy the probe's filters kept out of the listing, and
   `inventory_copy_withheld_data` for the part of it inside a control or data widget; each a whole number, at most 10^6), the aria snapshot, the
   last green run's fingerprint and, with `HEAL_VISION=auto|on`, one masked screenshot.
3. The service answers with a `try`: a candidate locator, the element it expects, and the patch. The client then
   - checks the candidate **in the live page** before it touches a file: it must match exactly one element, and that element
     must be the one the service expects (the probe describes the hit; the client names it in the inventory),
   - applies the patch only under the safety rules below,
   - re-runs the exact test and reports `{count, hit, test_outcome}` to `/v1/heals/{id}/result`.
4. Repeat until the service says `healed`, `needs_human` or `not_drift`. A candidate that fails any check is reverted and the
   service moves to the next one.
5. Print every decision with its token usage and a run total, write `heal-summary.json` into `test_artifacts/`, and with
   `--open-pr` commit **only the healed files** and open one PR (needs `git`, `gh` and a clean worktree).

A service or browser error ends that heal as `needs_human` with the reason. It never crashes the run.

## Configuration

Everything is an environment variable; the framework has no model settings.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEAL_SERVICE_URL` | (required) | The heal service, for example `http://localhost:8765` |
| `HEAL_SERVICE_TOKEN` | | Bearer token, when the service needs one. Never sent over `http://` to a host other than localhost unless `HEAL_ALLOW_INSECURE=1` |
| `HEAL_VISION` | `off` | `off`, `auto` or `on`. With `off` the screenshot call is never made and no image bytes leave the client |
| `HEAL_MASK` | | Selectors painted over in the screenshot, one per line or separated by `;;` (not commas, so a selector can hold them, e.g. `a:is(b, c)`) |
| `HEAL_TEST_ID_ATTRIBUTE` | `data-testid` | The project's test id attribute; the service writes `getByTestId` only for it |
| `HEAL_SOURCE_ROOTS` | `pages,tests,utils,fixtures` | Where files may be sent and patched; relative paths inside the repository |
| `HEAL_STORAGE_STATE` | | Playwright storage-state file used to open the page signed in (never sent) |
| `HEAL_PROJECT` | `chromium` | The Playwright project to run and re-run; empty uses the config's default |
| `HEAL_PROBE_FROM_SERVICE` | | `1` fetches the service's probe and uses it only when its sha256 equals the vendored one |
| `HEAL_ALLOW_INSECURE` | | `1` allows the token over `http://` to a non-local host (use https instead) |
| `HEAL_ARTIFACTS_DIR` | `test_artifacts` | Where `heal-summary.json` goes |
| `HEAL_REPO` | | Repository name recorded with the heal |
| `BASE_URL` | `https://the-internet.herokuapp.com` | The app under test (same default as `config/settings.ts`) |

Fingerprints have their own switches, below.

## Fingerprints: what the last green run saw

With a fingerprint the service can find the same element on the drifted page (same test id, id, name, role, position) and
settle the heal with **no model call**. Without one every heal starts at the text pick.

- Opt in with `HEAL_FINGERPRINTS=on`. An auto fixture (`fixtures/heal-fingerprints.ts`, wired into `fixtures/index.ts`)
  records, for each locator a test acts on (`click`, `fill`, `check`, `selectOption`, `hover`, ...), what the probe sees of
  the element, its box, frame, the page path and language. The key is the source file plus the normalized acting line.
- Written **only from a clean green run**: the test passed, ran once (no retry), is not flagged flaky, has a healthy
  stability index and is not running inside a heal.
- The file is `.heal/fingerprints.json`, the same format the Python client writes. `.heal/.gitignore` containing `*` is written
  with it so it is never committed by accident (`HEAL_FINGERPRINTS_COMMIT=on` opts in to committing). In CI keep `.heal/` as a
  cache from the last green run on the default branch.
- It holds attributes, copy and boxes: never input values, screenshots or HTML. Element copy can hold personal data (a name in a
  table row): `HEAL_FINGERPRINT_COPY=off` stores `sha256:` hashes of the copy instead. `HEAL_DIR` moves the folder (a relative path
  inside the repository; anything else falls back to `.heal`).
- While recording, Playwright names `utils/heal-recorder.ts` as the location of a failing action in that run's report. The heal
  run itself never installs the recorder.

The fixture also, when a test fails, attaches the **path** of the page it
was on (`heal-page-url`, no query or fragment) so the heal can reopen the failing route. During a heal's own runs only
(`HEAL_CAPTURE=1`) it attaches the **capture** too (`heal-page-capture`): the probe listing and the redacted aria snapshot of the
page as the failing test left it. No screenshot, no HTML, no input value, and nothing in an ordinary run's report. Page
text is page text, though: a message the app wrote that repeats what the test typed ("Hello jdoe@example.com") is in it, as it
would be on a reopened page that showed the same message. A frame in `designMode` (editable as a whole) sends no aria snapshot. The heal reads
it as untrusted (same-origin path only, listing allowlisted again, aria redacted again, size capped). The live checks still run on
the reopened page; what they hit is named against the captured listing, ignoring only whether the element is shown.

## Language branches

A locator built from page copy only works in the language the copy is written in. When the page now renders in another
language than the passing run, the service keeps both and writes a call to the helper in `utils/heal-locale.ts`:

```ts
byLanguage(this.page, { en: this.page.getByLabel('Username'), fr: this.page.getByLabel("Nom d'utilisateur") })
```

The helper returns **one real Playwright `Locator`**, built at once with no page read, so it works in any position: in front of an
action, inside `expect(...)`, in a getter or a field. Each branch is scoped under `html:lang(<key>)` and the first branch (the
original copy) under every language not listed, joined with `.or()`, so a language nobody healed for behaves as it did before the
heal and only one scope matches a page. `:lang()` follows `<html lang>`; `fr-CA` is `fr`. Copy is never translated.

The client adds `import { byLanguage } from "../utils/heal-locale.js"` (a real import, found in the syntax tree) to a file that
receives branch code. If the service writes `await` in front of it, the client allows that only where the code is async.

## Vision

`HEAL_VISION=auto|on` sends **one viewport screenshot** (never full page: a late scroll restore can shift the page under a
click) with `mask` on every password field, on every input or textarea whose name or id matches `pass|pwd|token|secret|ssn|card|cvv|otp`, on `cc-*`, `one-time-code` and password autocompletes, on any input that is or ever was `type=password` (a show-password toggle), on every cross-origin iframe, and on the `HEAL_MASK` selectors. If masking fails, no screenshot is sent. It goes out as
`{media_type: "image/png", data: <base64>, width, height}`, and names the mode in `options.vision`. The service draws the overlay.
With `off` (the default) the screenshot call is skipped entirely, the request carries `screenshot: null`, and zero image bytes
leave the client. If a screenshot cannot be taken the heal goes on with text only and the decision carries a note.

## Safety rules

Every service reply is untrusted input.

- **A replacement is one clean expression**: no comment, control, bidi or line-separator character, no second statement, built
  only from `locator`, `getBy*`, `first`, `last`, `nth` and `filter` calls with literal arguments (strings, numbers, booleans,
  `null`, regex literals, flat option objects), rooted at the same receiver (`page` or `this.page`) as the code it replaces. The
  check walks a TypeScript syntax tree (`scripts/heal-code.mjs`, the `typescript` package) and the older pattern check in
  `scripts/heal-validate.mjs` runs as an independent second check. A locator is written only when both accept it.
- **The patched span is exactly one expression node** of the file on disk and holds exactly the `from` text the service names
  (a span inside a string or comment, or one that cuts a node in half, is refused). Spans count code points, as the service does.
- **A patch applies only when** its base sha256 is the file's current hash, the file is one the client sent, it sits under the
  source roots (real path, no symlink), nothing overlaps, and the code written is the code that was checked live. Extra patches
  (other uses of the same locator) are each checked live too. The file is written atomically with its own mode and reverted on
  any failure; a partial multi-file write is rolled back.
- **Nothing typed leaves the browser**: inventory entries are cut to an allowlist of keys on this side (the allowlist keeps
  `copy_only`, an item listed only because it holds page copy, `copy_cut`, and a label's `for`), the aria snapshot goes
  through a redaction that removes typed values, and no cookie or storage state is sent.
- **The probe is pinned**: `scripts/heal-probe.js` is a byte-identical copy of the service's probe (its sha256 is checked every
  time it is read and in `tests/unit/test-heal-probe.spec.ts`). Page requests to origins other than `BASE_URL` are aborted while
  it runs.
- **Hostile JSON** (too deep, too large, not an object, a bad heal id) is a service error, not a crash.

## Limits to know

- Only locators written as direct `page.locator(...)` / `page.getBy*(...)` / `this.page...` expressions on **one line** are healed;
  dynamic locators and multi-line chains are reported, not guessed.
- The re-run must pass **the whole test**. A test with two drifted locators cannot be healed one at a time: the first fix is
  reverted because the test still fails on the second. Heal one drift per test, or fix the second by hand and run again.
- A branch candidate that would need `await` in a getter or field initializer is refused (see above).
- The live check runs on the **reopened** page. An element that exists only in the failing state and is not reachable there
  (a popover the test opened, an iframe a step injected) is listed by the capture but cannot be checked, so it is not healed.
- With a capture, no screenshot is sent: a screenshot of the reopened page would show another state than the listing.

## Testing

```bash
npx playwright test tests/unit --project=chromium   # unit, security, live-page and contract-replay tests
npm run typecheck && npm run lint
```

- `tests/unit/test-heal-client*.spec.ts`: request building, the loop, every patch refusal, symlink and root escape, stale hashes,
  overlapping spans, branch checks, the insecure token, untrusted replies, the origin guard.
- `tests/unit/test-heal-live.spec.ts`: the live page in a real Chromium; the screenshot masks are proven by decoding the pixels.
- `tests/unit/test-heal-contract.spec.ts`: every case of the service's contract fixtures (`tests/unit/fixtures/heal-contract/`)
  replayed through the client; the locator rendered, the results reported and the decision must match.
- `tests/unit/test-heal-probe.spec.ts`: the vendored probe is the service's, byte for byte.

When the service's probe changes, copy it over `scripts/heal-probe.js` and update `PROBE_SHA256` in `scripts/heal-probe.mjs` and the
constant in the probe test together.

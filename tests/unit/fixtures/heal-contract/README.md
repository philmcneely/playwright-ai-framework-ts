# Contract fixtures

Golden request and response files that hold every framework client to the same behaviour. Each case is one drifted page object and one
scripted conversation with the service. The Python replay lives in `tests/contract/test_replay.py`; a TypeScript client replays the same
files and must arrive at the same answers.

## Layout

```
fixtures/contract/<case>/
  request.json              POST /v1/heal body as a Python client sends it
  request.typescript.json   the same failure as a TypeScript client sends it (TS source, TS error text)
  script.json               the scripted model, the client results to report, settings, optional prompt checks
  expected.json             what the service answered at each step, per language
```

## script.json

```json
{
  "description": "what the case shows",
  "model":   [{"reply": "{\"ref\": \"e0\", \"why\": \"scripted pick\"}", "usage": [100, 8]}],
  "results": [{"count": 1, "hit": {"ref": "e0"}, "test_outcome": "passed"}],
  "settings": {"run_token_budget": 100},
  "checks": {"prompt_contains": ["..."], "prompt_absent_regex": ["(?m)^e9 \\|"]}
}
```

- `model`: one entry per model call the service makes, in order: the reply text (null = no answer) and the usage `[input, output]` tokens
  the model client reports. A harness for another language stands up a model endpoint (or a stand-in) that answers this way.
- `results`: the bodies of `POST /v1/heals/{id}/result`, sent in order after the first response. Each is only sent while the previous
  answer was `try`.
- `settings`: service settings for the case, named as the `ServiceSettings` fields (`run_token_budget`, `candidate_cap`, `max_calls`).
- `checks`: optional assertions on the prompts the model was sent (`prompt_contains`, `prompt_absent_regex`).

## expected.json

```json
{"python": [step, step, ...], "typescript": [step, step, ...]}
```

Step 0 is the response to `POST /v1/heal`; step N is the response to the Nth entry of `results`. A step holds only what behaviour depends on:

```json
{
  "status": "try", "round": 1, "reason": null, "settled_at": 3, "ended_at": null, "cache_hit": false,
  "usage": {"calls": 1, "input_tokens": 100, "output_tokens": 8},
  "candidate": {
    "target_ref": "e0", "strategy": "test_id", "tier": "testid", "tier_movement": "up", "below_floor": false,
    "locator": {"kind": "test_id", "chain": [{"m": "get_by_test_id", "a": ["login-user"], "o": {}, "p": false}]},
    "code": "self.page.get_by_test_id(\"login-user\")",
    "branches": null,
    "expect": {"count": 1, "ref": "e0"},
    "patch": {"file": "pages/account_page.py", "from": "self.page.locator('#username')", "to": "self.page.get_by_test_id(\"login-user\")"},
    "also_patches": []
  }
}
```

Left out on purpose: the heal id, the prose `why`, the diff text and the patch hash and span (run-specific or derived).

## What a client must match

For every case, replaying `request.<language>.json` must give, step by step:

- **Equal in both languages** (the decision): `status`, `round`, `reason`, `settled_at`, `ended_at`, `cache_hit`, `usage`, and for a candidate
  `target_ref`, `strategy`, `tier`, `tier_movement`, `below_floor`, `expect`, whether `branches` is set, and `locator.kind`.
- **Per language** (the rendering): `code`, `patch.from`, `patch.to`, `locator.chain` (methods and option names in the client language's spelling),
  `branches`. `code` is what the client writes into the file: `self.page...` in Python, `this.page...` in TypeScript.
- A TypeScript client must produce, from `locator.chain` or `code`, the same rendered locator the fixture records, and must report the results the
  script names (a real client reports what it saw; the fixtures fix those results so the service's reaction is testable).

`tests/contract/test_replay.py` shows the comparison; `tests/contract/replay.py` is the replay function.

## Cases

| Case | What it pins down |
| --- | --- |
| `renamed_id_to_testid` | a renamed id is healed to the element's test id (text pick, moves up a tier) |
| `fingerprint_match_zero_tokens` | the same element is found from the passing run's fingerprint: 0 calls, settled at step 2 |
| `text_pick_copy_changed` | button text changed; a text pick finds it; healed to its id, not to the new wording |
| `not_drift` | an assertion failure naming no locator is not drift |
| `ambiguous_source_needs_human` | the same call twice and no stack line to tell them apart: `needs_human` |
| `target_removed_needs_human` | nothing on the page could be the target: `needs_human`, no nearby element |
| `french_page_language_branch` | a copy-only locator on a French page gets a language branch; copy is not translated |
| `tier_floor_kept_id_stays_id` | a new id stays at the id tier; no drop to name, label or placeholder |
| `tier_floor_down_flagged` | no test id left, only an id: moves down one tier and is flagged `below_floor` |
| `count_mismatch_next_candidate` | the client saw 2 matches; the next ranked locator, no model call |
| `wrong_element_repick` | the client saw another element; the pick is ruled out and the model is asked again |
| `budget_exhausted` | the run's token budget stops the second pick |
| `prompt_injection_in_page_text` | page text with an order and a forged candidate line is flattened and quoted; an unlisted ref is refused |

## Regenerating

`uv run python tests/contract/build_fixtures.py [case ...]` rewrites the files from the case table. `expected.json` is produced by replaying through
the service, so it records what the service does today: read the diff of every regenerated file before committing it.

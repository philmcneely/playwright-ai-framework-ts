/**
 * Unit tests: contract fixture replay (tests/unit/fixtures/heal-contract, copied from the heal service's golden fixtures).
 *
 * Every case is one drifted page object and one scripted conversation. The TypeScript client replays it: a stand-in service
 * answers each step with what the service's expected.json recorded for TypeScript, a stand-in page reports the count and the
 * element the script names, and the client drives its real loop (request building, live check, patch safety, write, re-run,
 * report). For every case the client must
 *   - send the evidence the fixture's request carries (error, stack frames, source files, language, last pass) in a request the
 *     service's strict schema would accept,
 *   - render each candidate to the same locator the fixture records (the code walked into Playwright calls equals the chain),
 *   - report exactly what the script names, step by step,
 *   - arrive at the same decision: healed with the same code written to the file, or needs_human / not_drift with the same reason.
 *
 * @tags @unit @contract
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Healer, buildLocator, pageLanguage, redactErrorValues, settingsFromEnv, type Json } from "../../scripts/heal-client.mjs";
import { callKey, lineOf, mergeInto, pagePath } from "../../scripts/heal-fingerprints.mjs";
import { vendoredProbe } from "../../scripts/heal-probe.mjs";
import { sha } from "./heal-helpers.js";

const DIR = path.resolve("tests/unit/fixtures/heal-contract");
const CASES = readdirSync(DIR).filter((d) => statSync(path.join(DIR, d)).isDirectory()).sort();
const REQUIRED = [
  "renamed_id_to_testid", "fingerprint_match_zero_tokens", "text_pick_copy_changed", "not_drift", "ambiguous_source_needs_human",
  "target_removed_needs_human", "french_page_language_branch", "tier_floor_kept_id_stays_id", "tier_floor_down_flagged",
  "count_mismatch_next_candidate", "wrong_element_repick", "budget_exhausted", "prompt_injection_in_page_text",
];
const json = (name: string, file: string): Json => JSON.parse(readFileSync(path.join(DIR, name, file), "utf8"));

// the keys the service's schema accepts at each level (it refuses unknown fields)
const SCHEMA: Record<string, string[]> = {
  top: ["client", "test", "failure", "source", "page", "last_pass", "options", "test_id_attribute", "run"],
  client: ["framework", "language", "version"], test: ["id", "title"], failure: ["error", "stack"], source: ["roots", "files"],
  file: ["path", "sha256", "content"], page: ["url", "language", "aria_snapshot", "inventory", "inventory_more", "inventory_copy_more", "inventory_copy_withheld", "inventory_copy_withheld_data", "viewport", "screenshot"],
  language: ["html_lang", "browser_locale", "content_language"], options: ["vision", "max_rounds", "locale_branching"],
  run: ["id", "repo"], last_pass: ["fingerprint", "neighbours", "language"],
};
function expectSchemaKeys(req: Json) {
  const only = (obj: Json, level: string) => expect(Object.keys(obj).filter((k) => !SCHEMA[level].includes(k)), `${level} has unknown keys`).toEqual([]);
  only(req, "top");
  only(req.client, "client");
  only(req.test, "test");
  only(req.failure, "failure");
  only(req.source, "source");
  req.source.files.forEach((f: Json) => only(f, "file"));
  only(req.page, "page");
  only(req.page.language, "language");
  only(req.options, "options");
  only(req.run, "run");
  if (req.last_pass) only(req.last_pass, "last_pass");
  expect(req.client.language).toBe("typescript");
  expect(req.page.screenshot).toBeNull();
}

// the fixture's compact inventory shape -> the probe's own shape (what a live page hands the client)
const PROBE_KEYS: Record<string, string> = {
  "data-testid": "testid", name: "name_attr", "aria-label": "aria_label", id: "id", type: "type", placeholder: "placeholder",
  title: "title", alt: "alt", role: "role", class: "class",
};
function toProbeItem(item: Json, index: number): Json {
  const out: Json = { ref: `e${index}` };
  for (const [k, v] of Object.entries(item)) {
    if (k === "attrs") for (const [a, value] of Object.entries(v as Json)) out[PROBE_KEYS[a] ?? a.replace(/-/g, "_")] = value;
    else if (k === "box") out.box = { x: v.x, y: v.y, width: v.w ?? v.width, height: v.h ?? v.height };
    else out[k] = v;
  }
  return out;
}

type Steps = Array<[string, unknown[]]>;
/** Stands in for a Playwright page: the approved calls come back as a recorded list of [method, args]. */
const recorder = (steps: Steps = []): { steps: Steps } =>
  new Proxy({ steps }, { get: (t, n) => (n === "steps" ? t.steps : (...args: unknown[]) => recorder([...t.steps, [String(n), args]])) });
/** The calls a fixture's `locator.chain` stands for. */
const chainSteps = (chain: Json[]): Steps => chain.map((c) => [c.m, [...c.a, ...(Object.keys(c.o).length ? [c.o] : [])]]);
const rendered = (code: string) => buildLocator<{ steps: Steps }>(recorder(), code)?.steps;
const drop = (o: Json) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

test.describe("contract fixtures", { tag: ["@unit", "@contract", "@regression"] }, () => {
  test("every required case is present and complete", () => {
    expect(CASES).toEqual(expect.arrayContaining(REQUIRED));
    for (const c of CASES) for (const f of ["request.json", "request.typescript.json", "script.json", "expected.json"]) {
      expect(statSync(path.join(DIR, c, f)).isFile(), `${c} lacks ${f}`).toBe(true);
    }
  });

  test("no fixture carries a typed value, a cookie or a host other than app.example", () => {
    for (const c of CASES) for (const f of readdirSync(path.join(DIR, c))) {
      const text = readFileSync(path.join(DIR, c, f), "utf8");
      expect(text, `${c}/${f}`).not.toMatch(/"value"|cookie/i);
      for (const host of text.match(/https?:\/\/[A-Za-z0-9._:-]+/g) ?? []) expect(host).toBe("http://app.example");
    }
  });

  test("both languages reach the same decisions", () => {
    for (const c of CASES) {
      const { python: py, typescript: ts } = json(c, "expected.json");
      expect(ts.length, c).toBe(py.length);
      py.forEach((a: Json, i: number) => {
        const b = ts[i];
        for (const k of ["status", "round", "reason", "settled_at", "ended_at", "cache_hit", "usage"]) expect(b[k], `${c} step ${i} ${k}`).toEqual(a[k]);
        expect("candidate" in a).toBe("candidate" in b);
        if (a.candidate) {
          for (const k of ["target_ref", "strategy", "tier", "tier_movement", "below_floor", "expect"]) expect(b.candidate[k]).toEqual(a.candidate[k]);
          expect(b.candidate.locator.kind).toBe(a.candidate.locator.kind);
        }
      });
    }
  });

  for (const name of CASES) {
    test(`replay: ${name}`, async () => {
      const req = json(name, "request.typescript.json");
      const script = json(name, "script.json");
      const steps: Json[] = json(name, "expected.json").typescript;
      const root = mkdtempSync(path.join(tmpdir(), "heal-contract-"));
      try {
        // the project: the fixture's source files, and the fingerprint file the last pass came from
        const contents: Record<string, string> = {};
        for (const f of req.source.files) {
          mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true });
          writeFileSync(path.join(root, f.path), f.content);
          contents[f.path] = f.content;
        }
        const top = req.failure.stack[0];
        const page = pagePath(req.page.url);
        if (req.last_pass) {
          const entries: Record<string, Json> = {
            [callKey(top.file, lineOf(root, top.file, top.line))]: {
              file: top.file, text: "", page, language: req.last_pass.language, fingerprint: req.last_pass.fingerprint,
            },
          };
          (req.last_pass.neighbours ?? []).forEach((n: Json, i: number) => {
            entries[`pages/neighbour.ts::n${String(i).padStart(3, "0")}`] = { file: "pages/neighbour.ts", text: "", page, language: "en", fingerprint: n };
          });
          await mergeInto(root, entries as never, { HEAL_DIR: ".heal" });
        }

        // the stand-in service: the answers expected.json recorded, with the patch hash and span computed from the files
        const spanOf = (content: string, frm: string) => {
          const at = content.indexOf(frm);
          const start = [...content.slice(0, at)].length;
          return { start, end: start + [...frm].length };
        };
        const patchOf = (p: Json) => ({
          file: p.file, base_sha256: sha(contents[p.file] ?? ""), span: spanOf(contents[p.file] ?? "", p.from), from: p.from, to: p.to, diff: "",
        });
        const answer = (s: Json) => ({
          heal_id: "h_replay", status: s.status, round: s.round, reason: s.reason, why: s.reason ? `the service says ${s.reason}` : null,
          settled_at: s.settled_at, ended_at: s.ended_at, cache_hit: s.cache_hit, usage: { ...s.usage, images: 0 },
          candidate: s.candidate ? { ...s.candidate, patch: patchOf(s.candidate.patch), also_patches: s.candidate.also_patches.map(patchOf), why: "" } : null,
        });
        const reports: Json[] = [];
        let sent: Json = {};
        const service = {
          probeJs: async () => vendoredProbe(),
          heal: async (r: Json) => ((sent = r), answer(steps[0])),
          result: async (_id: string, report: Json) => {
            reports.push(report);
            if (!steps[reports.length]) throw new Error(`${name}: the client reported more results than the fixture has steps`);
            return answer(steps[reports.length]);
          },
        };

        // the stand-in page: the count and the element the script names for the try being checked
        const asked: string[] = [];
        const routes: string[] = [];
        const language = pageLanguage(req.page.language.html_lang, req.page.language.browser_locale, req.page.language.content_language);
        const live = {
          language,
          notes: [] as string[],
          snapshot: async () => ({
            path: page, inventory: req.page.inventory.map(toProbeItem), more: req.page.inventory_more ?? 0, copy_more: req.page.inventory_copy_more ?? 0, copy_withheld: req.page.inventory_copy_withheld ?? 0, copy_withheld_data: req.page.inventory_copy_withheld_data ?? 0, aria: req.page.aria_snapshot ?? "",
            viewport: req.page.viewport ?? {}, language: req.page.language, screenshot: null,
          }),
          check: async (expression: string): Promise<[number | null, string | null]> => {
            asked.push(expression);
            const r = script.results[reports.length];
            if (!r) throw new Error(`${name}: the client checked a locator the script has no result for`);
            return [r.count, r.hit?.ref ?? null];
          },
          close: async () => undefined,
        };
        const verify = async () => script.results[reports.length]?.test_outcome === "passed";
        const settings = settingsFromEnv({
          HEAL_SOURCE_ROOTS: req.source.roots.join(","), HEAL_TEST_ID_ATTRIBUTE: req.test_id_attribute, BASE_URL: "http://app.example",
        });
        const healer = new Healer(service, settings, verify, {
          root, runId: "replay", env: { HEAL_DIR: ".heal" }, liveFactory: (route: string) => (routes.push(route), live),
        });
        const failure = {
          title: req.test.title, file: path.join(root, req.test.id.split("::")[0]), error: req.failure.error,
          stack: req.failure.stack.map((f: Json) => `    at ${root}/${f.file}:${f.line}:1`).join("\n"), location: null,
        };
        const decision = await healer.heal(failure);

        // 1. the evidence the client sent
        expectSchemaKeys(sent);
        expect(sent.failure.error).toBe(redactErrorValues(req.failure.error)); // Received / Expected values never leave
        expect(sent.failure.stack).toEqual(req.failure.stack);
        expect(sent.test.title).toBe(req.test.title);
        expect(sent.test_id_attribute).toBe(req.test_id_attribute);
        expect(sent.page.language).toEqual(req.page.language);
        expect(sent.page.url).toBe(page);
        if (req.failure.stack.length) {
          expect(sent.source.files.map((f: Json) => ({ path: f.path, content: f.content }))).toEqual(
            req.source.files.map((f: Json) => ({ path: f.path, content: f.content })));
          expect(sent.source.files.every((f: Json) => f.sha256 === sha(f.content))).toBe(true);
        }
        if (req.last_pass) {
          expect(sent.last_pass).toEqual({ neighbours: [], ...req.last_pass }); // the fixture leaves out an empty list
          expect(routes).toEqual([page]);
        } else {
          expect(sent).not.toHaveProperty("last_pass");
        }

        // 2. the locators: what the client checked, and that the code walks to the chain the fixture records
        const tries = steps.slice(0, -1).filter((s) => s.candidate);
        expect(asked.length).toBe(reports.length);
        for (const s of steps.filter((x) => x.candidate)) {
          const c = s.candidate;
          if (c.branches) {
            for (const [lang, chain] of Object.entries(c.locator.branches as Json)) {
              expect(rendered(c.branches[lang]), `${name} ${lang} branch`).toEqual(chainSteps((chain as Json).chain));
            }
          } else {
            expect(rendered(c.code), `${name} ${c.code}`).toEqual(chainSteps(c.locator.chain));
          }
        }
        tries.slice(0, asked.length).forEach((s, i) => {
          expect(asked[i]).toBe(s.candidate.branches ? s.candidate.branches[language] : s.candidate.code);
        });

        // 3. what the client reported, step by step
        expect(reports.length).toBe(steps.length - 1);
        reports.forEach((rep, i) => {
          const want = drop(script.results[i]);
          expect(rep.count, `${name} report ${i} count`).toBe(want.count);
          expect(rep.hit?.ref, `${name} report ${i} hit`).toBe((want.hit as Json | undefined)?.ref);
          if (rep.test_outcome !== undefined) expect(rep.test_outcome).toBe(want.test_outcome);
        });

        // 4. the decision, and the file
        const last = steps[steps.length - 1];
        expect(decision.usage).toMatchObject({ calls: last.usage.calls, input_tokens: last.usage.input_tokens, output_tokens: last.usage.output_tokens });
        if (last.status === "healed") {
          const patch = last.candidate.patch;
          expect(decision).toMatchObject({ outcome: "healed", file: patch.file, from: patch.from, to: patch.to, strategy: last.candidate.strategy, tier_movement: last.candidate.tier_movement });
          const written = readFileSync(path.join(root, patch.file), "utf8");
          const patched = contents[patch.file].replace(patch.from, () => patch.to);
          const helper = 'import { byLanguage } from "../utils/heal-locale.js";\n'; // pages/ -> utils/
          expect(written).toBe(last.candidate.branches ? helper + patched : patched); // exactly the checked code, nothing else
        } else {
          expect(decision.outcome).toBe(last.status);
          expect(decision.reason).toBe(last.reason);
          for (const [file, text] of Object.entries(contents)) expect(readFileSync(path.join(root, file), "utf8")).toBe(text);
        }
        expect(decision.settled_at).toBe(last.settled_at);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

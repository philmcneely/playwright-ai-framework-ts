/**
 * Shared fixtures for the heal client unit tests (not a spec file): a throwaway project on disk, a scripted heal service
 * behind a fake fetch, a stub live page and a scripted re-run. Everything the client decides is tested without a browser,
 * a model or a network.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Healer,
  ServiceClient,
  settingsFromEnv,
  type Failure,
  type Json,
} from "../../scripts/heal-client.mjs";

export const PAGE_SRC = [
  'import { Page } from "@playwright/test";',
  "",
  "export class LoginPage {",
  '  readonly url = "/login";',
  "  constructor(private page: Page) {}",
  "",
  "  async login(user: string) {",
  "    await this.page.locator('#username').fill(user);",
  "    await this.page.locator('#username').press('Tab');",
  "  }",
  "}",
  "",
].join("\n");
export const TEST_SRC = [
  'import { LoginPage } from "../pages/login-page.js";',
  "",
  'test("valid login", async ({ page }) => {',
  '  await new LoginPage(page).login("u");',
  "});",
  "",
].join("\n");
export const FROM = "this.page.locator('#username')";
export const TO = "this.page.getByTestId('login-user')";
export const OTHER_SRC = "export const x = this.page.locator('#username');\n";
export const PAGE_FILE = "pages/login-page.ts";

export const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export const read = (root: string, file = PAGE_FILE) => readFileSync(path.join(root, file), "utf8");

/** A project on disk: pages/login-page.ts, pages/other-page.ts, tests/login.spec.ts and a package.json with a version. */
export function makeProject(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "heal-unit-")));
  for (const d of ["pages", "tests", "utils"]) mkdirSync(path.join(root, d));
  writeFileSync(path.join(root, "package.json"), '{"name":"x","version":"1.2.3"}\n');
  writeFileSync(path.join(root, PAGE_FILE), PAGE_SRC);
  writeFileSync(path.join(root, "pages/other-page.ts"), OTHER_SRC);
  writeFileSync(path.join(root, "tests/login.spec.ts"), TEST_SRC);
  return root;
}

export const ERROR_MESSAGE =
  "Error: locator.fill: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for locator('#username')\n";

/** The failure of `valid login` as scripts/heal.mjs builds it from the JSON report: message, stack text, absolute file. */
export function failureFor(root: string, extraFrames: string[] = []): Failure {
  const frames = [
    `    at LoginPage.login (${root}/pages/login-page.ts:8:38)`,
    ...extraFrames.map((f) => `    at ${root}/${f}`),
    `    at ${root}/tests/login.spec.ts:4:30`,
    "    at node_modules/playwright/lib/x.js:1:1",
  ];
  return {
    title: "valid login",
    file: path.join(root, "tests/login.spec.ts"),
    error: ERROR_MESSAGE,
    stack: `${ERROR_MESSAGE}${frames.join("\n")}\n`,
    location: null,
  };
}

/** Character (code point) offsets of the `nth` occurrence of `frm` in `text`, as the service counts spans. */
function spanOf(text: string, frm: string, nth: number) {
  let idx = -1;
  for (let i = 0; i <= nth; i++) idx = text.indexOf(frm, idx + 1);
  const start = [...text.slice(0, idx)].length;
  return { start, end: start + [...frm].length };
}

export interface PatchOptions {
  to?: string;
  frm?: string;
  file?: string;
  nth?: number;
  base?: string;
}

/** A service patch for the `nth` occurrence of `frm` in `file`. */
export function patchFor(root: string, o: PatchOptions = {}): Json {
  const { to = TO, frm = FROM, file = PAGE_FILE, nth = 0, base } = o;
  const text = read(root, file);
  return { file, base_sha256: base ?? sha(text), span: spanOf(text, frm, nth), from: frm, to, diff: "" };
}

export function candidate(
  root: string,
  o: PatchOptions & { ref?: string; branches?: Record<string, string> | null; also?: Json[] } = {},
): Json {
  const { ref = "e0", branches = null, also = [], ...patchOptions } = o;
  const to = patchOptions.to ?? TO;
  return {
    target_ref: ref, strategy: "test_id", locator: { kind: "test_id" }, code: to, branches, expect: { count: 1, ref },
    patch: patchFor(root, patchOptions), also_patches: also, why: "same textbox", tier: "testid", tier_movement: "up",
    below_floor: false,
  };
}

export function reply(status: string, cand: Json | null = null, extra: Json = {}): Json {
  return {
    heal_id: extra.heal_id ?? "h_1", status, candidate: cand, round: extra.rnd ?? 1, settled_at: 2, reason: extra.reason ?? null,
    why: extra.why ?? null, usage: extra.usage ?? { calls: 1, input_tokens: 100, output_tokens: 9, images: 0 },
  };
}

type Request = { method: string; path: string; body: Json | null; auth: string | null };

/** A scripted service behind a fake fetch: the first reply answers /v1/heal, the rest answer /result in order. */
export class FakeService {
  replies: Json[];
  status: number;
  requests: Request[] = [];
  handler: ((req: Request) => Response | undefined) | null = null;

  constructor(replies: Json[] = [], status = 200) {
    this.replies = [...replies];
    this.status = status;
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const req: Request = {
      method: init?.method ?? "GET",
      path: u.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: headers.Authorization ?? null,
    };
    this.requests.push(req);
    const custom = this.handler?.(req);
    if (custom) return custom;
    if (req.path === "/v1/probe.js") return new Response("(only) => ({items: [], more: 0, page: {}})", { status: 200 });
    if (this.status !== 200) return new Response(JSON.stringify({ detail: "boom" }), { status: this.status });
    const next = this.replies.shift() ?? reply("needs_human", null, { reason: "x", why: "no more scripted replies" });
    return new Response(JSON.stringify(next), { status: 200 });
  };

  client(token = ""): ServiceClient {
    return new ServiceClient("https://svc", token, { fetchImpl: this.fetch as typeof fetch, env: {} });
  }

  posts(suffix: string): Json[] {
    return this.requests.filter((r) => r.method === "POST" && r.path.endsWith(suffix)).map((r) => r.body as Json);
  }
}

/** A stub of LivePage: what the page shows, and what each locator expression hits. */
export class FakeLive {
  asked: string[] = [];
  notes: string[] = [];
  closed = false;
  snap: Json | null = null;

  constructor(
    public checks: Record<string, [number | null, string | null]> = {},
    public language = "en",
    public inventory: Json[] = [{ ref: "e0", tag: "input" }],
  ) {}

  async snapshot(): Promise<Json> {
    return this.snap ?? {
      path: "/login", inventory: this.inventory, more: 0, aria: '- textbox "Username"', screenshot: null,
      viewport: { w: 1280, h: 720, dpr: 1 },
      language: { html_lang: this.language, browser_locale: "en-US", content_language: null },
    };
  }

  async check(expression: string): Promise<[number | null, string | null]> {
    this.asked.push(expression);
    return this.checks[expression] ?? [1, "e0"];
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A scripted re-run: each call returns the next outcome and remembers the file as the run saw it. */
export class Verify {
  calls = 0;
  seen: string[] = [];
  private outcomes: boolean[];

  constructor(
    private root: string | null = null,
    outcomes: boolean[] = [],
    private file = PAGE_FILE,
  ) {
    this.outcomes = [...outcomes];
  }

  fn = async (): Promise<boolean> => {
    this.calls += 1;
    if (this.root) this.seen.push(read(this.root, this.file));
    return this.outcomes.shift() ?? false;
  };
}

export function healer(root: string, service: FakeService, verify: Verify | ((failure: never, patched: never) => Promise<boolean>), live: FakeLive = new FakeLive(), extra = {}) {
  const fn = typeof verify === "function" ? verify : verify.fn;
  const h = new Healer(service.client(), settingsFromEnv({ HEAL_SERVICE_URL: "http://svc" }), fn, {
    root, runId: "r1", liveFactory: () => live, env: { HEAL_DIR: ".heal" }, ...extra,
  });
  return Object.assign(h, { live });
}

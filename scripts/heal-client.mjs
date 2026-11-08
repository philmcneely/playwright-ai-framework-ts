/**
 * ===============================================================================
 * Heal Service Client (evidence out, patch in, nothing about models)
 * ===============================================================================
 * Talks to the heal service (HEAL_SERVICE_URL) on behalf of `scripts/heal.mjs`. It knows HTTP, the browser, git-tracked source
 * files and the framework's own safety checks, and nothing about models: no model URL, no model name, no prompt and no parsing
 * of a model reply live in this repository. The service picks the element and writes the locator; this client only
 *     - builds the request: the stack files under the source roots (capped, with sha256), the probe's element inventory of the
 *       reopened failing route, the aria snapshot, the language signals, the last green run's fingerprint and its neighbours
 *       and, with HEAL_VISION=auto|on, one masked viewport screenshot
 *     - checks every candidate in the live page BEFORE touching a file: the locator must match exactly one element and that
 *       element must be the one the service expects (the probe's `only` mode describes it; no code from the service is ever
 *       evaluated, the locator expression is walked and only approved Playwright calls with literal arguments are run)
 *     - applies a patch only when its base hash is the file's current hash, the file is one the client sent and sits under the
 *       source roots, the span holds exactly `from` and is exactly one expression of the file's syntax tree, and `to` passes
 *       the locator validator (each language branch separately)
 *     - re-runs the exact test, keeps the edit only when the service confirms `healed`, reverts it otherwise, and reports every
 *       try to the service so it can move to the next candidate
 *
 * It is the TypeScript counterpart of the Python client (utils/heal_client.py) and holds the same rules.
 *
 * Features:
 *     - settingsFromEnv: HEAL_SERVICE_URL, HEAL_SERVICE_TOKEN, HEAL_VISION, HEAL_MASK, HEAL_TEST_ID_ATTRIBUTE,
 *       HEAL_SOURCE_ROOTS, HEAL_STORAGE_STATE, BASE_URL
 *     - ServiceClient: capabilities, probe script (the vendored one; the service's copy only with HEAL_PROBE_FROM_SERVICE=1
 *       and only when its sha256 is equal), heal, result. Every failure is a HealServiceError that names the status and the
 *       service's reason, never the request
 *     - Language signals: <html lang>, the browser locale and the Content-Language header of the page load
 *     - Patch safety refusals: stale base hash, a file outside the source roots or never sent, a span that does not hold
 *       `from` or is not one expression node, overlapping spans, a replacement that fails the validator, a branch set that
 *       does not match the code, a patched file that no longer parses
 *     - A service or browser error ends that heal as needs_human with the reason; it never crashes the run
 *     - Language branches: the byLanguage helper (utils/heal-locale.ts) is imported into a file that receives branch code
 *     - Input values are never sent: the aria snapshot goes through redactTypedValues and the inventory is cut to an
 *       allowlist of keys on THIS side, whatever the service or its probe promises; no cookie or storage state leaves the
 *       client. A screenshot exists only with HEAL_VISION=auto|on: one viewport shot, password fields and HEAL_MASK masked
 *     - Every service reply is untrusted: deep or non-object JSON is an error, a replacement is one expression with no comment
 *       and no control character, the original span must be a pure locator chain AND exactly one expression node of the file
 *       on disk, the code written is the code checked live (every extra patch too), a file is written in place with its mode,
 *       never through a symlink and never outside its source root, and a partial multi-file write is reverted
 *     - The probe runs with page requests to origins other than BASE_URL aborted
 *     - A bearer token is never sent over http:// to a host other than localhost unless HEAL_ALLOW_INSECURE=1
 *
 * Environment Variables:
 *     HEAL_SERVICE_URL: base URL of the heal service, for example http://localhost:8765
 *     HEAL_SERVICE_TOKEN: bearer token, when the service requires one
 *     HEAL_VISION: off (default) | auto | on; anything but off sends one masked viewport screenshot
 *     HEAL_MASK: selectors to mask in that screenshot, one per line or separated by `;;` (so a selector can hold commas)
 *     HEAL_TEST_ID_ATTRIBUTE: the project's test id attribute (default data-testid)
 *     HEAL_SOURCE_ROOTS: comma separated source roots, relative paths inside the repository (default
 *       pages,tests,utils,fixtures)
 *     HEAL_PROBE_FROM_SERVICE: "1" to fetch the probe from the service (used only when it is byte-identical to the vendored one)
 *     HEAL_ALLOW_INSECURE: "1" to send the bearer token over http:// to a host other than localhost
 *     HEAL_STORAGE_STATE: Playwright storage-state file used to open the page as a signed-in user (never sent)
 *     HEAL_ALLOW_ORIGINS: comma separated extra origins the heal browser may load from (default: only BASE_URL's origin)
 *     HEAL_REPO: optional repository name recorded with the heal
 *     BASE_URL: the app under test (default https://the-internet.herokuapp.com, as in config/settings.ts)
 *
 * Author: PMAC
 * ===============================================================================
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  HELPER, awaitAllowedAt, buildLocator, checkReplacement, expressionSpans, importsHelper, normal, branchDict, toUtf16Index, withHelperImport,
} from "./heal-code.mjs";
import {
  callKey, healDir, lastPassFor, lineOf, loadStore, relativeUnder, sourceRoots, stackFrames,
} from "./heal-fingerprints.mjs";
import { probeFunction, sha256, vendoredProbe } from "./heal-probe.mjs";
import { cleanInventory, redactTypedValues } from "./heal-redact.mjs";

export { vendoredProbe };
export const LIMITS = { files: 20, fileBytes: 256 * 1024, ariaChars: 256 * 1024 };
const MAX_STACK_FRAMES = 100;
export const MAX_ROUNDS = 3; // same as options.max_rounds in the request
const MAX_ERROR_CHARS = 60_000; // the service refuses more than 64 KB of error text, and any line over 8 KB
const MAX_ERROR_LINE = 8_000;
const MAX_REPLY_CHARS = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // the service refuses a decoded PNG over 4 MB (413)
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const HEAL_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,99}$/; // no dots at all: `.` and `..` would be path segments
const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const DEFAULT_BASE_URL = "https://the-internet.herokuapp.com";
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// ---- settings ------------------------------------------------------------------------------------------------------------
/** Split a list of selectors on newlines or `;;`, so a selector may hold commas (`a:is(b, c)`, `[data-x='a,b']`). */
export function splitSelectors(text) {
  return String(text ?? "").split(/\r?\n|;;/).map((t) => t.trim()).filter(Boolean);
}

/** What the client reads from the environment. */
export function settingsFromEnv(env = process.env) {
  const attr = (env.HEAL_TEST_ID_ATTRIBUTE ?? "data-testid").trim().toLowerCase();
  const vision = (env.HEAL_VISION ?? "off").trim().toLowerCase() || "off";
  return {
    url: (env.HEAL_SERVICE_URL ?? "").trim().replace(/\/+$/, ""),
    token: (env.HEAL_SERVICE_TOKEN ?? "").trim(),
    vision: ["off", "auto", "on"].includes(vision) ? vision : "off",
    mask: splitSelectors(env.HEAL_MASK),
    testIdAttribute: /^[a-z][a-z0-9-]{0,63}$/.test(attr) ? attr : "data-testid",
    roots: sourceRoots(env),
    storageState: env.HEAL_STORAGE_STATE || null,
    baseUrl: env.BASE_URL || DEFAULT_BASE_URL,
    allowOrigins: (env.HEAL_ALLOW_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  };
}

// ---- the service ---------------------------------------------------------------------------------------------------------
/** The service could not be reached or refused a call. The message names the status and reason, never the request. */
export class HealServiceError extends Error {}

/** The service's HTTP API. `fetchImpl` may be any fetch (a test passes a scripted one). */
export class ServiceClient {
  constructor(baseUrl, token = "", { fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 200_000 } = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.env = env;
    this.headers = token ? { Authorization: `Bearer ${token}` } : {};
    this.probe = null;
    let url = null;
    try {
      url = new URL(this.base);
    } catch {
      /* an unusable URL fails on the first call */
    }
    this.insecure = Boolean(token) && url !== null && url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname) &&
      env.HEAL_ALLOW_INSECURE !== "1";
    if (this.insecure) {
      process.emitWarning("HEAL_SERVICE_TOKEN would travel over plain http:// to a host other than localhost; the heal " +
        "client refuses to send it (use https://, or set HEAL_ALLOW_INSECURE=1 on a trusted network)");
    }
  }

  async call(method, route, body) {
    if (this.insecure) {
      throw new HealServiceError("refusing to send the bearer token over http:// to a host other than localhost " +
        "(use https://, or set HEAL_ALLOW_INSECURE=1)");
    }
    let resp;
    let text;
    try {
      resp = await this.fetch(this.base + route, {
        method,
        headers: { ...this.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", // a redirect would carry the request (and the token) to another host
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await resp.text();
    } catch (e) {
      throw new HealServiceError(`the heal service could not be reached (${e?.name ?? "Error"})`);
    }
    if (resp.status >= 400) {
      let detail = null;
      try {
        const parsed = JSON.parse(text);
        detail = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.detail : null;
      } catch {
        /* not JSON */
      }
      const shown = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : resp.statusText;
      throw new HealServiceError(`the heal service answered ${resp.status}: ${String(shown || "").slice(0, 300)}`);
    }
    return text;
  }

  json(text) {
    if (text.length > MAX_REPLY_CHARS) throw new HealServiceError("the heal service sent a reply that is too large");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // an untrusted service can nest JSON deep enough to blow a parser's stack: a bad reply, not a crash
      throw new HealServiceError("the heal service sent a reply that is not usable JSON");
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new HealServiceError("the heal service sent a reply that is not a JSON object");
    }
    return data;
  }

  async capabilities() {
    return this.json(await this.call("GET", "/v1/capabilities"));
  }

  /** The in-page probe script: the vendored copy. With HEAL_PROBE_FROM_SERVICE=1 the service's copy is fetched and checked
   * byte for byte against it (sha256); a different script is refused, never run. */
  async probeJs() {
    if (this.probe === null) {
      const vendored = vendoredProbe();
      if (this.env.HEAL_PROBE_FROM_SERVICE === "1") {
        const served = await this.call("GET", "/v1/probe.js");
        if (sha256(Buffer.from(served, "utf8")) !== sha256(vendored)) {
          throw new HealServiceError("the service's probe script differs from the vendored one (sha256), so it is refused");
        }
      }
      this.probe = vendored;
    }
    return this.probe;
  }

  async heal(request) {
    return this.json(await this.call("POST", "/v1/heal", request));
  }

  async result(healId, report) {
    if (typeof healId !== "string" || !HEAL_ID.test(healId)) throw new HealServiceError("the heal service sent a bad heal id");
    return this.json(await this.call("POST", `/v1/heals/${encodeURIComponent(healId)}/result`, report));
  }
}

// ---- the failure: stack, test id, source files, route --------------------------------------------------------------------
const INPUT_CALL = /\b(fill|type|pressSequentially|press|setInputFiles|selectOption)\(\s*(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`\n]*`)/g;

/** An error text without what a test typed or what an assertion compared: the Received / Expected values and the string handed
 * to fill(), type(), press() and the like in a code frame. The locator and call-log lines triage needs stay. */
export function redactErrorValues(text) {
  return text.split("\n").map((line) => line
    .replace(/^(\s*(?:Received|Expected)(?: string| pattern| value| array| substring)?:).*$/, "$1 <redacted>")
    .replace(INPUT_CALL, "$1(<redacted>")).join("\n");
}

/** `text` without colour codes, the repository's absolute path, or more than the service accepts (a line is cut at 8 KB). */
export function cleanError(text, root) {
  const bare = redactErrorValues(String(text ?? "").replace(ANSI, "")).split(root + path.sep).join("").split(root).join(".");
  return bare.split(/\r\n|\r|\n/).map((l) => (l.length > MAX_ERROR_LINE ? l.slice(0, MAX_ERROR_LINE) : l)).join("\n")
    .slice(0, MAX_ERROR_CHARS);
}

/** The failing stack's frames under the source roots, innermost first: [{file, line}]. The report's `location` is added when
 * the stack text does not name it. */
export function stackFromFailure(failure, roots, root) {
  const frames = stackFrames(failure.stack ?? "", root, roots);
  const loc = failure.location;
  if (loc && typeof loc.file === "string") {
    const rel = relativeUnder(loc.file, root, roots);
    if (rel && Number.isInteger(loc.line) && !frames.some((f) => f.file === rel && f.line === loc.line)) {
      frames.push({ file: rel, line: loc.line });
    }
  }
  return frames.slice(0, MAX_STACK_FRAMES);
}

/** `tests/login/test-login.spec.ts::title` from the spec's file and title. */
export function testId(failure, root) {
  const abs = path.isAbsolute(failure.file ?? "") ? failure.file : path.join(root, failure.file ?? "");
  const rel = path.relative(root, abs).split(path.sep).join("/");
  return `${failure.file ? rel : ""}::${failure.title}`.replace(/^::/, "").slice(0, 500);
}

/** (text, raw bytes) of a file inside `root`, newlines and BOM untouched, or null when it is missing or not UTF-8. */
export function readTextFile(root, rel) {
  try {
    const raw = fs.readFileSync(path.join(root, rel));
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw), raw };
  } catch {
    return null;
  }
}

const isInside = (base, target) => {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** True when `rel` is listed under a source root AND its real path (every symlink followed) is inside that root's real
 * path, which itself must be inside the repository. A symlink to another root, to the repo's top level or out of the
 * repository does not count. */
export function withinRoots(root, rel, roots) {
  try {
    const base = fs.realpathSync(root);
    const real = fs.realpathSync(path.join(root, rel));
    for (const r of roots) {
      if (!rel.startsWith(r + "/")) continue;
      const top = fs.realpathSync(path.join(root, r));
      if (isInside(base, top) && isInside(top, real)) return true;
    }
  } catch {
    /* a path that cannot be resolved is not within the roots */
  }
  return false;
}

/** The files named in the failing stack that sit under the source roots, as {path, sha256, content}. At most 20 files, 256 KB
 * each; a file whose real path (symlinks followed) is not inside the source root it is listed under is skipped. */
export function collectSource(stack, roots, root) {
  const files = [];
  for (const rel of new Set(stack.map((f) => f.file))) {
    if (files.length >= LIMITS.files || !SOURCE_EXT.test(rel) || !withinRoots(root, rel, roots)) continue;
    const got = readTextFile(root, rel);
    if (got && got.raw.length <= LIMITS.fileBytes) files.push({ path: rel, sha256: sha256(got.raw), content: got.text });
  }
  return files;
}

/** The page route a page object or test names: `url = "/login"` or `goto("/login")` with a literal path; null when none. */
export function routeFromSource(content) {
  const m = /\burl\s*=\s*["'`]([^"'`$\\]*)["'`]/.exec(content) ?? /\bgoto\(\s*["'`]([^"'`$\\]*)["'`]/.exec(content);
  if (!m) return null;
  try {
    return new URL(m[1], "http://base.invalid").pathname || null;
  } catch {
    return null;
  }
}

/** `route` as a same-origin path to open: it starts with a single `/` (no `//`, scheme or backslash, no control character) and
 * resolves against `baseUrl` to the same origin. null otherwise. Routes come from files and reports, so they are untrusted. */
export function safeRoute(route, baseUrl) {
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//") || route.includes("\\") || BAD_ROUTE.test(route)) return null;
  try {
    const base = new URL(baseUrl);
    return new URL(route, base).origin === base.origin ? route : null;
  } catch {
    return null;
  }
}
// eslint-disable-next-line no-control-regex
const BAD_ROUTE = /[\u0000-\u001f\u007f-\u009f\s]/;

export function clientVersion(root) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "").slice(0, 50);
  } catch {
    return "";
  }
}

/** The POST /v1/heal body. `snap` is a LivePage snapshot: path, language signals, inventory, aria, viewport and, with
 * HEAL_VISION on, the screenshot. No input value is included: the inventory is allowlisted and the aria text redacted. */
export function buildRequest(failure, files, stack, snap, settings, root, lastPass = null, runId = null) {
  // with HEAL_VISION off no image leaves the client, whatever a live page handed over
  const screenshot = settings.vision !== "off" ? snap.screenshot ?? null : null;
  const req = {
    client: { framework: "playwright-ai-framework-ts", language: "typescript", version: clientVersion(root) },
    test: { id: testId(failure, root), title: String(failure.title ?? "").slice(0, 500) },
    failure: { error: cleanError(failure.error, root), stack },
    source: { roots: [...settings.roots], files },
    page: {
      url: snap.path,
      language: snap.language,
      inventory: cleanInventory(snap.inventory),
      inventory_more: snap.more,
      viewport: snap.viewport,
      screenshot,
    },
    options: { vision: screenshot ? settings.vision : "off", max_rounds: 3, locale_branching: true },
    test_id_attribute: settings.testIdAttribute,
    run: { id: runId ?? randomBytes(6).toString("hex") },
  };
  const aria = typeof snap.aria === "string" ? redactTypedValues(snap.aria) : "";
  if (aria && aria.length <= LIMITS.ariaChars) req.page.aria_snapshot = aria;
  if (lastPass) req.last_pass = lastPass;
  const repo = process.env.HEAL_REPO;
  if (repo) req.run.repo = repo.slice(0, 200);
  return req;
}

// ---- patch safety --------------------------------------------------------------------------------------------------------
/** A patch the client will not apply. `fatal` means the service's evidence and the disk disagree (stale hash, wrong file,
 * wrong span): the heal ends there. A replacement that is merely unsafe only rules this candidate out. */
export class PatchRefused extends Error {
  constructor(reason, fatal = false) {
    super(reason);
    this.reason = reason;
    this.fatal = fatal;
  }
}

const str = (v) => (typeof v === "string" ? v : "");

/** Check every patch of a candidate (the main one and `also_patches`) and return the new content of each file touched, or
 * throw PatchRefused. Nothing is written here. */
export function planPatches(candidate, sent, roots, root) {
  const patches = [candidate.patch, ...(Array.isArray(candidate.also_patches) ? candidate.also_patches : [])];
  const branches = candidate.branches && Object.keys(candidate.branches).length ? candidate.branches : null;
  const byFile = new Map();
  patches.forEach((p, i) => {
    const rel = str(p?.file);
    if (!rel || relativeUnder(rel, root, roots) !== rel || rel.startsWith("/") || rel.split("/").includes("..")) {
      throw new PatchRefused(`${rel || "a patch"} is not under the source roots`, true);
    }
    if (!Object.hasOwn(sent, rel)) throw new PatchRefused(`${rel} was not one of the files sent to the service`, true);
    const why = checkReplacement(str(p.to), str(p.from), branches, i === 0);
    if (why) throw new PatchRefused(why);
    if (i === 0 && !branches && (normal(p.to) === null || normal(p.to) !== normal(candidate.code))) {
      throw new PatchRefused("the patch is not the locator that was checked in the live page");
    }
    byFile.set(rel, [...(byFile.get(rel) ?? []), p]);
  });
  const planned = [];
  for (const [rel, group] of byFile) {
    let isLink = true;
    try {
      isLink = fs.lstatSync(path.join(root, rel)).isSymbolicLink();
    } catch {
      /* unreadable: refused below */
    }
    if (isLink || !withinRoots(root, rel, roots)) throw new PatchRefused(`${rel} is a symlink or leaves its source root`, true);
    const got = readTextFile(root, rel);
    if (got === null) throw new PatchRefused(`${rel} cannot be read`, true);
    const { text, raw } = got;
    const digest = sha256(raw);
    for (const p of group) {
      if (str(p.base_sha256).toLowerCase() !== digest || sent[rel].toLowerCase() !== digest) {
        throw new PatchRefused(`${rel} changed since the service saw it (base hash differs)`, true);
      }
    }
    const spans = group.map((p) => {
      const start = toUtf16Index(text, p.span?.start);
      const end = toUtf16Index(text, p.span?.end);
      return { start, end, p };
    }).sort((a, b) => (a.start ?? -1) - (b.start ?? -1));
    let endPrev = -1;
    for (const { start, end, p } of spans) {
      if (start === null || end === null || start > end || start < endPrev || text.slice(start, end) !== p.from) {
        throw new PatchRefused(`the span in ${rel} does not hold the text the service expected`, true);
      }
      endPrev = end;
    }
    const nodes = expressionSpans(text, rel);
    if (nodes === null) throw new PatchRefused(`${rel} does not parse (syntax error), so its spans cannot be checked`, true);
    for (const { start, end } of spans) {
      if (!nodes.has(`${start}:${end}`)) {
        throw new PatchRefused(`the span in ${rel} is not one expression of the file's syntax tree`, true);
      }
    }
    for (const { start, end, p } of spans) {
      if (/^await\b/.test(str(p.to)) && !awaitAllowedAt(text, rel, start, end)) {
        throw new PatchRefused(`the replacement starts with await but the code in ${rel} is not async there (a getter, a field or a plain function)`);
      }
    }
    let next = text;
    for (const { start, end, p } of [...spans].reverse()) next = next.slice(0, start) + p.to + next.slice(end);
    if (next.includes(HELPER + "(") && !importsHelper(next, rel)) next = withHelperImport(next, rel);
    if (expressionSpans(next, rel) === null) throw new PatchRefused(`the patched ${rel} would not parse`, true);
    planned.push({ rel, original: raw, newText: next });
  }
  // what this heal actually writes: the decision is built from it, never from what the service says afterwards
  planned.main = { file: str(candidate.patch?.file), from: str(candidate.patch?.from), to: str(candidate.patch?.to) };
  return planned;
}

/** Write `data` over a regular file with the file's own mode: a temp file next to it (created with that mode, never following
 * a symlink) and an atomic rename. A symlink, or anything that is not a regular file, is refused. */
export function replaceFile(file, data) {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error(`refusing to write ${path.basename(file)}: it is not a regular file (a symlink is never followed)`);
  const mode = st.mode & 0o7777;
  const tmp = `${file}.heal-tmp`;
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
  try {
    try {
      fs.writeFileSync(fd, data);
      fs.fchmodSync(fd, mode); // the umask may have narrowed it at creation
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const bytesOf = (file) => {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
};

/** Write each planned file, after checking once more that it still holds the bytes that were planned from (a file edited since
 * the plan is never overwritten). */
export function writeFiles(root, planned, write = replaceFile) {
  for (const pf of planned) {
    const file = path.join(root, pf.rel);
    const now = bytesOf(file);
    if (now === null || sha256(now) !== sha256(pf.original)) throw new Error(`${pf.rel} changed since the patch was planned, so it is not written`);
    write(file, Buffer.from(pf.newText, "utf8"));
  }
}

/** Put every file's original bytes back. One file failing does not stop the others; the first error is thrown after. */
export function revertFiles(root, planned, write = replaceFile) {
  let first = null;
  for (const pf of planned) {
    try {
      const file = path.join(root, pf.rel);
      const now = bytesOf(file);
      if (now !== null && sha256(now) === sha256(pf.original)) continue; // nothing of ours to undo
      // only our own edit is undone: a file someone else changed since is left as it is
      if (now === null || sha256(now) !== sha256(Buffer.from(pf.newText, "utf8"))) throw new Error(`${pf.rel} was changed by someone else, so it is left as it is`);
      write(file, pf.original);
    } catch (e) {
      first ??= e; // keep restoring the rest
    }
  }
  if (first !== null) throw first;
}

// ---- the live page -------------------------------------------------------------------------------------------------------
const withoutBox = (item) => Object.fromEntries(Object.entries(item).filter(([k]) => !["box", "frame", "shadow", "ref"].includes(k)));

/** The inventory ref of the element the probe described in `facts`: an exact match on everything the probe listed, else one
 * that ignores box, frame and shadow. null when no entry or several entries fit (the hit cannot be named). */
export function matchRef(inventory, facts) {
  const plain = Object.fromEntries(Object.entries(facts).filter(([k]) => k !== "ref"));
  const exact = inventory.filter((e) => isDeepStrictEqual(Object.fromEntries(Object.entries(e).filter(([k]) => k !== "ref")), plain));
  if (exact.length === 1) return exact[0].ref;
  const loose = inventory.filter((e) => isDeepStrictEqual(withoutBox(e), withoutBox(facts)));
  return loose.length === 1 ? loose[0].ref : null;
}

function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return "";
  }
}

/** Playwright route handler: while `probing` is true, a request to an origin other than BASE_URL's is aborted, so the probe
 * (or anything a page wires to run while it is evaluated) cannot send what it reads to another site. Outside a probe every
 * request goes through untouched. */
export class OriginGuard {
  /** `always` blocks foreign origins for the whole session; `allow` lists extra origins that may load. */
  constructor(baseUrl, { always = false, allow = [] } = {}) {
    this.origin = originOf(baseUrl);
    this.allowed = new Set([this.origin, ...allow.map(originOf)]);
    this.always = always;
    this.probing = false;
  }

  /** True when `url` is a network request to an origin that may not load. */
  foreign(url) {
    try {
      return NETWORK_SCHEMES.has(new URL(url).protocol) && !this.allowed.has(originOf(url));
    } catch {
      return false;
    }
  }

  async handle(route, request = null) {
    const url = (request ?? route.request()).url();
    const foreign = this.foreign(url);
    try {
      if ((this.probing || this.always) && foreign) await route.abort();
      else await route.continue();
    } catch {
      /* the page closed under the route */
    }
  }

  /** Run `fn` with the guard on. */
  async active(fn) {
    this.probing = true;
    try {
      return await fn();
    } finally {
      this.probing = false;
    }
  }
}

/** Width and height of a PNG from its header, or null when the bytes are not a PNG. */
export function pngSize(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const COUNT_TIMEOUT_MS = 5000;
// Every field that holds a secret or a card, whatever its type, and every field a person may have switched from password to text:
// painted over in any screenshot.
const SECRET_WORDS = ["pass", "pwd", "token", "secret", "ssn", "card", "cvv", "otp"]; // matched in a name or id, any case
const PASSWORD = [
  'input[type="password" i]', 'input[autocomplete^="cc-" i]', 'input[autocomplete="one-time-code" i]',
  'input[autocomplete*="password" i]', "[data-heal-was-password]",
  ...SECRET_WORDS.flatMap((w) => ["name", "id"].flatMap((a) => [`input[${a}*="${w}" i]`, `textarea[${a}*="${w}" i]`])),
];
// Marks every input that is, or ever becomes, type=password (a show-password toggle makes it type=text). Runs in the page before
// its own scripts; the attribute name holds "password", so the inventory filter drops it.
const WAS_PASSWORD = `(() => {
  const nativeSet = Element.prototype.setAttribute;
  const mark = (el) => nativeSet.call(el, "data-heal-was-password", "1");
  const isPw = (el) => el instanceof HTMLInputElement && el.type === "password";
  // a toggle sets the type to text: the type it is leaving is what is remembered
  const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "type");
  Object.defineProperty(HTMLInputElement.prototype, "type", { configurable: true, enumerable: d.enumerable, get: d.get,
    set(v) { if (isPw(this) || String(v).toLowerCase() === "password") mark(this); d.set.call(this, v); } });
  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof HTMLInputElement && String(name).toLowerCase() === "type" && (isPw(this) || String(value).toLowerCase() === "password")) mark(this);
    return nativeSet.call(this, name, value);
  };
  const scan = (root) => { if (root.querySelectorAll) { if (isPw(root)) mark(root); root.querySelectorAll("input").forEach((i) => isPw(i) && mark(i)); } };
  new MutationObserver((records) => { for (const r of records) { if (r.type === "attributes") isPw(r.target) && mark(r.target); else r.addedNodes.forEach(scan); } })
    .observe(document, { attributes: true, attributeFilter: ["type"], childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", () => scan(document));
})();`;

/** A fresh Chromium on the failing route (HEAL_STORAGE_STATE when set). It stays open for the whole heal so each candidate
 * can be checked on the same page the inventory came from. With HEAL_VISION off it never takes a screenshot. */
export class LivePage {
  constructor(settings, route, probe) {
    this.settings = settings;
    this.route = route || "/";
    this.probe = probe;
    this.probeFn = probeFunction(probe);
    this.inventory = [];
    this.language = "";
    // foreign origins are blocked for the whole session (the page load too), not only while the probe runs
    this.guard = new OriginGuard(settings.baseUrl, { always: true, allow: settings.allowOrigins ?? [] });
    this.notes = [];
    this.browser = null;
    this.page = null;
    this.response = null;
  }

  static async open(settings, route, probe) {
    const { chromium } = await import("@playwright/test");
    const live = new LivePage(settings, route, probe);
    try {
      live.browser = await chromium.launch();
      const ctx = await live.browser.newContext({
        baseURL: settings.baseUrl,
        serviceWorkers: "block", // a service worker would answer requests outside the route handler
        ...(settings.storageState ? { storageState: settings.storageState } : {}),
      });
      await ctx.addInitScript(WAS_PASSWORD);
      await ctx.route("**/*", (r) => live.guard.handle(r));
      await ctx.routeWebSocket("**/*", (ws) => {
        if (live.guard.foreign(ws.url().replace(/^ws/, "http"))) void ws.close();
        else ws.connectToServer();
      });
      live.page = await ctx.newPage();
      live.response = await live.page.goto(live.route);
    } catch (e) {
      await live.close();
      throw e;
    }
    return live;
  }

  async close() {
    try {
      await this.browser?.close();
    } catch {
      /* already closed */
    }
  }

  /** Run the probe on the page and read its aria snapshot: path, language signals, numbered inventory, viewport. */
  async snapshot() {
    const data = (await this.guard.active(() => this.page.evaluate(this.probeFn))) ?? {};
    const meta = data.page ?? {};
    let header = null;
    try {
      header = this.response?.headers()["content-language"] ?? null;
    } catch {
      /* no header */
    }
    const items = (Array.isArray(data.items) ? data.items : []).filter((i) => i && typeof i === "object");
    this.inventory = cleanInventory(items.map((item, i) => ({ ...item, ref: `e${i}` })));
    this.language = pageLanguage(meta.lang, meta.browser_lang, header);
    let aria = null;
    try {
      // what a person typed into an editable region is page text in the snapshot: empty those regions in this throwaway page
      await this.page.evaluate(() => {
        // eslint-disable-next-line no-undef -- runs in the page
        for (const el of document.querySelectorAll("[contenteditable]:not([contenteditable=false i])")) el.textContent = "";
      });
      aria = redactTypedValues(await this.guard.active(() => this.page.locator("body").ariaSnapshot()));
    } catch {
      /* no snapshot */
    }
    const view = meta.viewport ?? {};
    const snap = {
      path: new URL(this.page.url(), "http://base.invalid").pathname || "/",
      inventory: this.inventory,
      more: Number(data.more) || 0,
      aria,
      viewport: { w: view.width, h: view.height, dpr: meta.dpr },
      language: { html_lang: meta.lang || null, browser_locale: meta.browser_lang || null, content_language: header },
      screenshot: null,
    };
    if (this.settings.vision !== "off") {
      snap.screenshot = await this.screenshot();
      if (snap.screenshot) {
        // inventory boxes are in document coordinates and the shot is at the current scroll: say where that is, and give
        // the viewport size (CSS px) read at the moment of the shot
        const now = await this.page.evaluate(() => ({ w: innerWidth, h: innerHeight })).catch(() => null); // eslint-disable-line no-undef -- runs in the page
        const scroll = meta.scroll ?? {};
        snap.viewport = { ...snap.viewport, ...(now ?? {}), scroll: { x: Number(scroll.x) || 0, y: Number(scroll.y) || 0 } };
      }
    }
    return snap;
  }

  /** One viewport PNG (never full page: a late scroll restore shifts the page under a click) with every password field and
   * every HEAL_MASK selector masked. null (and a note) when it cannot be taken. Called only when HEAL_VISION is not off. */
  async screenshot() {
    try {
      const frames = this.page.frames?.() ?? [this.page];
      // every cross-origin iframe is covered whole: its content is not ours to send
      const here = originOf(this.page.url?.() ?? "");
      for (const f of frames) {
        if (f === this.page.mainFrame?.() || originOf(f.url()) === here) continue;
        await (await f.frameElement()).evaluate((el) => el.setAttribute("data-heal-mask", "1"));
      }
      const selectors = [...PASSWORD, "[data-heal-mask]", ...this.settings.mask];
      const mask = frames.flatMap((f) => selectors.map((s) => f.locator(s)));
      const buf = await this.guard.active(() => this.page.screenshot({
        type: "png", fullPage: false, mask, animations: "disabled", caret: "initial", scale: "css",
      }));
      const size = pngSize(buf);
      if (size === null || buf.length > MAX_IMAGE_BYTES) throw new Error("the screenshot is not a usable PNG");
      return { media_type: "image/png", data: buf.toString("base64"), ...size };
    } catch (e) {
      this.notes.push(`no screenshot sent (${e?.name ?? "Error"}); the heal ran on text only`);
      return null;
    }
  }

  /** [match count, inventory ref of the one element hit]. The ref is null unless the count is 1 and the element can be
   * named; the count is null when the expression cannot be run here. */
  async check(expression) {
    const loc = buildLocator(this.page, expression);
    if (loc === null) return [null, null];
    // a page that never answers (or a pattern that never finishes) is "cannot check", not a hang
    const count = await Promise.race([loc.count(), new Promise((resolve) => setTimeout(resolve, COUNT_TIMEOUT_MS, null))]);
    if (count === null) return [null, null];
    if (count !== 1) return [count, null];
    const data = await this.guard.active(() => loc.evaluate(this.probeFn));
    const facts = cleanInventory(data?.items ?? [])[0];
    return [1, facts ? matchRef(this.inventory, facts) : null];
  }
}

const SUBTAG = /^[A-Za-z]{2,3}$/;

/** The plain primary language subtag of `value` ("fr-CA" -> "fr"), lower case; "" when it is not one. */
export function subtag(value) {
  const first = String(value ?? "").trim().replaceAll("_", "-").split("-")[0].split(",")[0].split(";")[0].trim();
  return SUBTAG.test(first) ? first.toLowerCase() : "";
}

/** The language subtag from <html lang>, then the browser locale, then Content-Language ("" when none is usable). */
export function pageLanguage(htmlLang, browserLocale, contentLanguage) {
  for (const v of [htmlLang, browserLocale, contentLanguage]) {
    const found = subtag(v);
    if (found) return found;
  }
  return "";
}

// ---- the heal loop -------------------------------------------------------------------------------------------------------
/** The locator expression to check live: the candidate's code, or for branch code the branch of the page's language. */
function expressionFor(candidate, language) {
  const branches = candidate.branches;
  if (!branches || !Object.keys(branches).length) return candidate.code;
  return Object.hasOwn(branches, language) ? branches[language] : null;
}

/** A candidate reply with the fields the loop reads, else a HealServiceError (the reply is untrusted). */
function checkedCandidate(resp) {
  const c = resp.candidate;
  const ok = c && typeof c === "object" && typeof resp.heal_id === "string" && typeof c.code === "string" &&
    c.patch && typeof c.patch === "object" && typeof c.patch.from === "string" && typeof c.patch.to === "string" &&
    (c.also_patches === undefined || Array.isArray(c.also_patches)) &&
    (c.branches === null || c.branches === undefined || (typeof c.branches === "object" && !Array.isArray(c.branches) &&
      Object.values(c.branches).every((v) => typeof v === "string")));
  if (!ok) throw new HealServiceError("the heal service sent a candidate that is not usable");
  return c;
}

/** Heals one failing test at a time through the service. All collaborators are injected, so a test can drive the whole loop
 * with a fake service and a fake page: `verify(failure)` re-runs the exact test, `liveFactory(route, probe)` opens the page. */
export class Healer {
  constructor(service, settings, verify, { root = process.cwd(), liveFactory = null, runId = null, writeFile = replaceFile,
    env = process.env, secondCheck = null } = {}) {
    this.service = service;
    this.settings = settings;
    this.verify = verify;
    this.root = root;
    this.liveFactory = liveFactory ?? ((route, probe) => LivePage.open(settings, route, probe));
    this.runId = runId ?? randomBytes(6).toString("hex");
    this.writeFile = writeFile;
    this.env = env;
    this.secondCheck = secondCheck; // (expression, original) => truthy: an independent validator every written locator must pass
  }

  /** One failure -> one decision. */
  async heal(failure) {
    const base = { test: failure.title };
    try {
      return { ...base, ...(await this.healOne(failure)) };
    } catch (e) {
      if (e instanceof HealServiceError) return { ...base, outcome: "needs_human", reason: "service_error", why: e.message };
      // the browser, the disk: this heal ends, the run goes on
      return { ...base, outcome: "needs_human", reason: "client_error",
        why: `the heal client failed (${e?.name ?? "Error"}): ${String(e?.message ?? e).slice(0, 200)}` };
    }
  }

  async healOne(failure) {
    const roots = this.settings.roots;
    const stack = stackFromFailure(failure, roots, this.root);
    const files = collectSource(stack, roots, this.root);
    const sent = Object.fromEntries(files.map((f) => [f.path, f.sha256]));
    const lastPass = this.lastPass(stack);
    const baseUrl = this.settings.baseUrl;
    const route = [lastPass?._page, failure.route, ...files.map((f) => routeFromSource(f.content))]
      .map((r) => safeRoute(r, baseUrl)).find(Boolean) ?? "/";
    if (lastPass) delete lastPass._page;
    const probe = await this.service.probeJs();
    const live = await this.liveFactory(route, probe);
    let resp;
    let kept = [];
    let notes = [];
    try {
      const snap = await live.snapshot();
      notes = live.notes ?? [];
      const request = buildRequest(failure, files, stack, snap, this.settings, this.root, lastPass, this.runId);
      resp = await this.service.heal(request);
      let rounds = 0;
      while (resp.status === "try" && resp.candidate) {
        if (rounds >= MAX_ROUNDS) { // the client ends it: a service that keeps asking is not trusted with more checks
          resp = { ...resp, status: "needs_human", reason: "max_rounds", why: `the client stopped after ${MAX_ROUNDS} candidates` };
          break;
        }
        rounds += 1;
        [resp, kept] = await this.tryCandidate(failure, resp, live, sent, live.language);
        if (kept.length) break; // healed: nothing more is asked or checked
      }
    } finally {
      await live.close?.();
    }
    const decision = this.decision(resp, kept);
    if (notes.length) decision.notes = notes;
    return decision;
  }

  /** The last green run's fingerprint of the failing line (with the page it was on), or null. */
  lastPass(stack) {
    if (!stack.length) return null;
    const top = stack[0];
    const text = lineOf(this.root, top.file, top.line);
    const store = loadStore(path.join(healDir(this.root, this.env), "fingerprints.json"));
    const key = callKey(top.file, text);
    const lp = text ? lastPassFor(store, key) : null;
    if (lp === null) return null;
    return { ...lp, _page: store.entries[key].page || "/" };
  }

  /** One candidate: check it live, apply it, re-run the exact test, report. Returns [the service's next answer, the files kept]
   * (non-empty only when the service confirmed `healed`). */
  async tryCandidate(failure, resp, live, sent, language) {
    const cand = checkedCandidate(resp);
    const healId = resp.heal_id;
    const expected = cand.expect?.ref;
    const expression = expressionFor(cand, language);
    const plain = !cand.branches || !Object.keys(cand.branches).length;
    if (expression === null) return [await this.report(healId, { count: null, error: "no branch for the page's language" }), []];
    if (plain && checkReplacement(expression, cand.patch.from)) {
      return [await this.report(healId, { count: null, error: "the locator is not a safe expression" }), []];
    }
    if (plain && normal(cand.patch.to) !== normal(expression)) {
      return [await this.report(healId, { count: null, error: "the patch is not the locator that was checked" }), []];
    }
    if (this.secondCheck && !this.passesSecondCheck(cand)) {
      return [await this.report(healId, { count: null, error: "the locator is not a safe expression" }), []];
    }
    const [count, ref] = await live.check(expression); // nothing has been edited yet
    if (count !== 1 || ref !== expected) {
      // coarse: 0, 1, or 2 for "more than one", so a candidate cannot be used to count what a page holds
      const report = { count: count === null ? null : Math.min(count, 2) };
      if (ref) report.hit = { ref };
      return [await this.report(healId, report), []];
    }
    let planned;
    try {
      planned = planPatches(cand, sent, this.settings.roots, this.root);
      await this.checkAlsoPatches(cand, live, language, expected);
    } catch (e) {
      if (!(e instanceof PatchRefused)) throw e;
      const report = { count: 1, hit: { ref }, test_outcome: "error", error: `patch refused by the client: ${e.reason}`.slice(0, 500) };
      if (!e.fatal) return [await this.report(healId, report), []];
      try {
        await this.service.result(healId, report);
      } catch (err) {
        if (!(err instanceof HealServiceError)) throw err;
      }
      return [{ ...resp, status: "needs_human", reason: "patch_refused", why: `the client refused the patch: ${e.reason}` }, []];
    }
    let next;
    let passed;
    try {
      writeFiles(this.root, planned, this.writeFile); // inside the try: a partial multi-file write is reverted
      passed = Boolean(await this.verify(failure));
      if (!passed) revertFiles(this.root, planned, this.writeFile);
      next = await this.report(healId, { count: 1, hit: { ref }, test_outcome: passed ? "passed" : "failed" });
    } catch (e) {
      revertFiles(this.root, planned, this.writeFile); // a write or verify crash or a lost service: never keep the edit
      throw e;
    }
    if (passed && next.status === "healed") return [next, planned];
    if (passed) revertFiles(this.root, planned, this.writeFile); // the service did not confirm it: do not keep it
    return [next, []];
  }

  /** Every locator the candidate writes (each language branch separately) passes the independent second validator. */
  passesSecondCheck(cand) {
    const branched = cand.branches && Object.keys(cand.branches).length;
    for (const p of [cand.patch, ...(cand.also_patches ?? [])]) {
      const expressions = branched ? Object.values(branchDict(str(p.to))?.texts ?? {}) : [str(p.to)];
      if (!expressions.length || !expressions.every((e) => this.secondCheck(e, str(p.from)))) return false;
    }
    return true;
  }

  /** Every other expression the candidate writes is checked in the live page like the main one: it must match exactly one
   * element and be the expected one. Anything else refuses the whole candidate (nothing is written). */
  async checkAlsoPatches(cand, live, language, expected) {
    const branches = cand.branches && Object.keys(cand.branches).length;
    for (const p of cand.also_patches ?? []) {
      let expression;
      if (branches) {
        const parsed = branchDict(str(p.to));
        expression = parsed && Object.hasOwn(parsed.texts, language) ? parsed.texts[language] : null;
      } else {
        expression = str(p.to);
      }
      if (expression === null) throw new PatchRefused("an extra patch has no branch for the page's language");
      const [count, ref] = await live.check(expression);
      if (count !== 1 || ref !== expected) {
        throw new PatchRefused(`an extra patch in ${p.file} does not match the one expected element (${count} match(es))`);
      }
    }
  }

  async report(healId, report) {
    return this.service.result(healId, report);
  }

  decision(resp, kept) {
    const u = resp.usage && typeof resp.usage === "object" ? resp.usage : {};
    const num = (v) => (Number.isFinite(Number(v)) ? Math.min(Math.max(Number(v), 0), 1e9) : 0);
    const text = (v, n = 300) => (typeof v === "string" ? v.slice(0, n) : null);
    const out = {
      heal_id: text(resp.heal_id, 100), reason: text(resp.reason, 80), why: text(resp.why), rounds: num(resp.round),
      settled_at: resp.settled_at === null || resp.settled_at === undefined ? null : num(resp.settled_at),
      usage: { calls: num(u.calls), input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), images: num(u.images) },
    };
    const cand = resp.candidate && typeof resp.candidate === "object" ? resp.candidate : {};
    if (resp.status === "healed" && kept.length && kept.main) {
      // what was written, not what the service's last reply says about it
      Object.assign(out, {
        outcome: "healed", file: kept.main.file, to: kept.main.to, strategy: text(cand.strategy, 40), tier_movement: text(cand.tier_movement, 10),
        why: text(cand.why) ?? out.why, files: kept.map((pf) => pf.rel),
      });
      out.from = kept.main.from;
      out.source = `heal service (settled at step ${out.settled_at})`;
    } else if (resp.status === "not_drift") {
      out.outcome = "not_drift";
    } else {
      out.outcome = "needs_human";
      if (resp.status === "try" || resp.status === "healed") {
        out.reason = out.reason || "unconfirmed";
        out.why = out.why || "the service did not confirm the heal";
      }
    }
    return out;
  }
}

/** Calls and tokens summed over every decision that carries usage. */
export function runTotal(decisions) {
  const total = { calls: 0, input_tokens: 0, output_tokens: 0, images: 0 };
  for (const d of decisions) for (const k of Object.keys(total)) total[k] += Number(d.usage?.[k] ?? 0) || 0;
  return total;
}

export { buildLocator, checkReplacement };
export { validateReplacement } from "./heal-code.mjs";

/**
 * ===============================================================================
 * Heal Fingerprints (the file format both the recorder and the heal client share)
 * ===============================================================================
 * The heal service can settle many heals with no model call when it knows which element a locator hit the last time its test
 * passed: it looks for that same element on the drifted page (same test id, id, name, role, position). The Playwright fixture
 * (fixtures/heal-fingerprints.ts) records that knowledge into `.heal/fingerprints.json`, keyed by the source line that acted
 * on the element, and `scripts/heal.mjs` looks the failing line up at heal time and sends it as `last_pass`, together with the
 * other elements recorded on the same page (`neighbours`). This module is the part both sides need: the key, the facts, the
 * file and its atomic, locked merge. It is a port of the Python client's utils/heal_fingerprints.py and writes the SAME file
 * format, so a project that runs both languages shares one cache.
 *
 * It holds attributes, copy and boxes only. Never input values (the probe does not read them), screenshots or HTML. Element
 * COPY (an element's text, label, name, placeholder, row and its aria-label, title and alt) IS stored, and the copy of a page
 * can hold personal data: a name in a table row, an account holder on a card. `.heal/` is git-ignored by default, but it is a
 * file on disk and its content is sent to the heal service as `last_pass`. Set HEAL_FINGERPRINT_COPY=off to store
 * `sha256:<hex>` of the normalized copy (case and spacing folded) instead of the copy itself.
 *
 * Features:
 *     - callKey(file, text): the key, source file + normalized text of the acting line (indentation, spacing and quote style
 *       do not change it), the same at record time and at heal time
 *     - itemToFingerprint(item, frame, copy): a probe item as the service's fingerprint shape, never a value
 *     - mergeInto(root, records, env): `.heal/fingerprints.json` written atomically (temp file + rename) under a lock file,
 *       merged with what other workers wrote, only rewritten when something changed
 *     - `.heal/.gitignore` containing `*` is written automatically, so the cache is never committed by accident; set
 *       HEAL_FINGERPRINTS_COMMIT=on to opt in to committing the file (the ignore file is then not created)
 *     - healDir: HEAL_DIR is a relative path that resolves inside the repository, else `.heal`
 *     - lastPassFor(store, key): the request's `last_pass` (fingerprint, same-page neighbours, language)
 *
 * Environment Variables:
 *     HEAL_FINGERPRINTS: "on" to record (default off)
 *     HEAL_FINGERPRINTS_COMMIT: "on" to allow committing .heal/ (default off: .heal/.gitignore with `*` is written)
 *     HEAL_FINGERPRINT_COPY: "off" to store hashes of element copy instead of the copy (default on)
 *     HEAL_DIR: where the cache lives, a relative path inside the repository (default .heal)
 *     HEAL_SOURCE_ROOTS: comma separated source roots whose lines are recorded (default pages,tests,utils,fixtures)
 *     HEAL_RUN: set by scripts/heal.mjs while it runs the suite; nothing is recorded then
 *
 * Author: PMAC
 * ===============================================================================
 */
import { createHash } from "node:crypto";
import fs, { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const VERSION = 1;
export const DEFAULT_ROOTS = ["pages", "tests", "utils", "fixtures"];
export const ACTIONS = [
  "click", "dblclick", "fill", "check", "uncheck", "setChecked", "selectOption", "press", "pressSequentially", "type", "hover",
  "waitFor",
];
export const MAX_NEIGHBOURS = 100; // the service accepts at most this many
const TEXT_KEYS = ["tag", "type", "role", "name", "label", "placeholder", "text", "row"];
const COPY_KEYS = ["name", "label", "placeholder", "text", "row"]; // element copy: may hold personal data
const COPY_ATTRS = ["aria-label", "title", "alt"];
const ATTR_NAMES = {
  testid: "data-testid", id: "id", name_attr: "name", aria_label: "aria-label", title: "title", alt: "alt", class: "class",
};
const FIELD_MAX = 400;

// ---- settings ------------------------------------------------------------------------------------------------------------
/** `value` as a relative posix path that stays inside its base (no absolute path, drive, `~`, backslash, NUL or `..`),
 * else null. */
export function safeRelative(value) {
  const v = (value ?? "").trim();
  if (!v.replace(/^\/+|\/+$/g, "") || v.startsWith("/") || v.startsWith("~") || v.includes("\\") || v.includes(":") ||
      v.includes("\0")) {
    return null;
  }
  const trimmed = v.replace(/\/+$/, "");
  return trimmed.split("/").every((p) => p !== "" && p !== "..") ? trimmed : null;
}

/** The source roots (HEAL_SOURCE_ROOTS, comma separated, relative), default pages, tests, utils, fixtures. */
export function sourceRoots(env = process.env) {
  const roots = (env.HEAL_SOURCE_ROOTS ?? "").split(",").filter((r) => safeRelative(r) !== null)
    .map((r) => r.trim().replace(/\/+$/, ""));
  return roots.length ? roots : [...DEFAULT_ROOTS];
}

const insideDir = (base, target) => {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The real path of `p` even when it does not exist: the deepest existing ancestor is resolved (symlinks followed) and the
 * rest is appended, so a path under a symlinked directory (macOS /var -> /private/var) compares equal to its real form. */
const realOrResolved = (p) => {
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
};

/** The cache directory: HEAL_DIR when it is a relative path that resolves (symlinks followed) inside the repository, else
 * `.heal` with a warning. A cache that could be pointed anywhere would let a variable write files anywhere. */
export function healDir(root, env = process.env, warn = (m) => process.emitWarning(m)) {
  const rel = safeRelative(env.HEAL_DIR ?? ".heal");
  if (rel !== null && insideDir(realOrResolved(root), realOrResolved(path.join(root, rel)))) return path.join(root, rel);
  warn("HEAL_DIR must be a relative path inside the repository; using .heal instead");
  return path.join(root, ".heal");
}

/** "off" when HEAL_FINGERPRINT_COPY=off (store hashes of element copy), else "on". */
export const copyMode = (env = process.env) =>
  (env.HEAL_FINGERPRINT_COPY ?? "on").trim().toLowerCase() === "off" ? "off" : "on";

/** True when fingerprints should be recorded: HEAL_FINGERPRINTS=on and not inside a heal run. */
export const enabled = (env = process.env) => (env.HEAL_FINGERPRINTS ?? "").toLowerCase() === "on" && !env.HEAL_RUN;

// ---- keys ----------------------------------------------------------------------------------------------------------------
/** A source line without its indentation, spacing or quote style: the stable text of what acted. */
export const normalizeLine = (text) => (text ?? "").trim().replace(/\s+/g, " ").replaceAll('"', "'");

export const callKey = (file, text) => `${file}::${normalizeLine(text)}`;

/** The normalized text of line `line` (1-based) of `file` as it is on disk now ('' when it cannot be read). */
export function lineOf(root, file, line) {
  try {
    const lines = readFileSync(path.join(root, file), "utf8").split(/\r\n|\r|\n/);
    return line >= 1 && line <= lines.length ? normalizeLine(lines[line - 1]) : "";
  } catch {
    return "";
  }
}

/** `p` as a posix path relative to `root` when it sits under one of `roots`, else null. */
export function relativeUnder(p, root, roots) {
  if (typeof p !== "string" || !p || p.includes("\0")) return null;
  let rel;
  if (path.isAbsolute(p)) {
    const base = realOrResolved(root);
    const abs = realOrResolved(p);
    if (!insideDir(base, abs) || abs === base) return null;
    rel = path.relative(base, abs);
  } else {
    rel = p;
  }
  const posix = rel.split(path.sep).join("/").replace(/^\.\//, "");
  if (posix.startsWith("../") || posix.startsWith("/") || posix.split("/").includes("..")) return null;
  return roots.some((r) => posix.startsWith(r + "/")) ? posix : null;
}

/** The frames of a stack text (Node's `at fn (file:line:col)` lines) that sit under `roots`, as [{file, line}] relative to
 * `root`, in the order they appear (innermost first). Duplicate file and line pairs are listed once. */
export function stackFrames(text, root, roots) {
  const frames = [];
  const seen = new Set();
  for (const line of String(text ?? "").split(/\r\n|\r|\n/)) {
    const m = /^\s*at\s+(?:.*?\s\()?(.+?):(\d+):\d+\)?\s*$/.exec(line);
    if (!m) continue;
    const file = m[1].startsWith("file://") ? decodeURIComponent(m[1].slice(7)) : m[1];
    const rel = relativeUnder(file, root, roots);
    const key = `${rel}:${m[2]}`;
    if (rel && !seen.has(key)) {
      seen.add(key);
      frames.push({ file: rel, line: Number(m[2]) });
    }
  }
  return frames;
}

// ---- the facts -----------------------------------------------------------------------------------------------------------
/** `sha256:<hex>` of `text` with case and spacing folded: equal copy hashes equal, the copy itself is not kept. */
export const hashCopy = (text) =>
  // upper then lower case approximates Python's casefold (ß becomes ss), so the hash matches the service's
  "sha256:" + createHash("sha256").update(String(text).split(/\s+/).filter(Boolean).join(" ").toUpperCase().toLowerCase(), "utf8")
    .digest("hex");

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * A probe item as the service's fingerprint shape: copy and role facts, an attrs bag, a w/h box, never a value. Element copy
 * (text, label, name, placeholder, row, aria-label, title, alt) is stored as it is, and may hold personal data; with
 * copy="off" (HEAL_FINGERPRINT_COPY=off) a hash of it is stored instead.
 */
export function itemToFingerprint(item, frame = "", copy = "on") {
  const fp = {};
  for (const k of TEXT_KEYS) if (item[k]) fp[k] = String(item[k]).slice(0, FIELD_MAX);
  const attrs = {};
  for (const [key, value] of Object.entries(item)) {
    if (typeof value !== "string" || !value) continue;
    if (Object.hasOwn(ATTR_NAMES, key)) attrs[ATTR_NAMES[key]] = value.slice(0, FIELD_MAX);
    else if (key.startsWith("data_")) attrs["data-" + key.slice(5).replaceAll("_", "-")] = value.slice(0, FIELD_MAX);
  }
  if (copy === "off") {
    for (const k of COPY_KEYS) if (k in fp) fp[k] = hashCopy(fp[k]);
    for (const k of COPY_ATTRS) if (k in attrs) attrs[k] = hashCopy(attrs[k]);
  }
  if (Object.keys(attrs).length) fp.attrs = Object.fromEntries(Object.entries(attrs).slice(0, 40));
  const where = frame || item.frame || "";
  if (where) fp.frame = String(where).slice(0, FIELD_MAX);
  const box = item.box;
  if (box && typeof box === "object" && ["x", "y", "width", "height"].every((k) => isNumber(box[k]))) {
    fp.box = { x: box.x, y: box.y, w: box.width, h: box.height };
  }
  return fp;
}

/** The URL's path only: a query or fragment can carry a token. */
export function pagePath(url) {
  try {
    return (new URL(url, "http://base.invalid").pathname || "/").slice(0, 200);
  } catch {
    return "/";
  }
}

// ---- the file ------------------------------------------------------------------------------------------------------------
/** The fingerprint file's content ({version, entries}), an empty store when it is missing or unreadable. */
export function loadStore(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data && typeof data === "object" && data.entries && typeof data.entries === "object" && !Array.isArray(data.entries)) {
      return data;
    }
  } catch {
    /* missing or unreadable: an empty store */
  }
  return { version: VERSION, entries: {} };
}

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
};

/** The store as the Python client writes it: sorted keys, one-space indent, ASCII only, a trailing newline. */
export const serializeStore = (store) =>
  JSON.stringify(sortKeys(store), null, 1).replace(/[^\x20-\x7e\n]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) +
  "\n";

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
}

/** Write `.heal/.gitignore` containing `*` unless committing the cache was opted into. */
export function ensureIgnore(directory, env = process.env) {
  if ((env.HEAL_FINGERPRINTS_COMMIT ?? "").toLowerCase() === "on") return;
  const ignore = path.join(directory, ".gitignore");
  try {
    statSync(ignore);
  } catch {
    mkdirSync(directory, { recursive: true });
    atomicWrite(ignore, "*\n");
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

/** Run `fn` while holding an exclusive lock file in `directory` (created with O_EXCL; a lock older than 30 s is stale). */
async function withLock(directory, fn) {
  const lock = path.join(directory, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        /* the holder released it between the two calls */
      }
      if (Date.now() > deadline) throw new Error("could not lock the fingerprint cache");
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

const sameJson = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

/** Merge `records` into the fingerprint file atomically, under a lock. Resolves true when the file changed. */
export async function mergeInto(root, records, env = process.env) {
  const directory = healDir(root, env);
  mkdirSync(directory, { recursive: true });
  ensureIgnore(directory, env);
  const target = path.join(directory, "fingerprints.json");
  return withLock(directory, () => {
    const store = loadStore(target);
    let changed = false;
    for (const [key, entry] of Object.entries(records)) {
      if (!Object.hasOwn(store.entries, key) || !sameJson(store.entries[key], entry)) {
        store.entries[key] = entry;
        changed = true;
      }
    }
    if (changed) {
      store.version = VERSION;
      atomicWrite(target, serializeStore(store));
    }
    return changed;
  });
}

/** The request's `last_pass` for a locator key: its fingerprint, the other elements recorded on the same page, and the page
 * language. null when nothing was recorded for the key. */
export function lastPassFor(store, key) {
  const entry = store?.entries?.[key];
  if (!entry || typeof entry !== "object" || !entry.fingerprint || typeof entry.fingerprint !== "object") return null;
  const neighbours = [];
  for (const otherKey of Object.keys(store.entries).sort()) {
    const other = store.entries[otherKey];
    if (otherKey !== key && other && typeof other === "object" && other.page === entry.page &&
        other.fingerprint && typeof other.fingerprint === "object") {
      neighbours.push(other.fingerprint);
    }
  }
  const out = { fingerprint: entry.fingerprint, neighbours: neighbours.slice(0, MAX_NEIGHBOURS) };
  if (entry.language) out.language = entry.language;
  return out;
}

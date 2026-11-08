/**
 * ===============================================================================
 * Heal Redaction (what a person typed never leaves the browser for the heal service)
 * ===============================================================================
 * Playwright renders the current value of a control in its accessibility snapshot (`- textbox "Pw": hunter2`, password
 * fields included), and a page probe is only as clean as the script that ran. Everything the heal client sends about the
 * live page therefore passes through here first, on the client's side of the wire, whatever the service or its probe
 * promises. The rule set is a port of the Python client's utils/heal_redact.py (same left-to-right pass, no regex), kept in
 * this repository so the privacy line does not depend on the service being honest or current.
 *
 * Features:
 *     - redactTypedValues(yaml): an accessibility snapshot without what a person typed. The value after the name of
 *       textbox, searchbox, spinbutton, slider and combobox lines goes (`- textbox "Email": me@example.com`); the role,
 *       name and states ([checked], [disabled]) stay, whatever the key's YAML quoting (plain, 'single' with '' inside,
 *       "double" with \" inside). Nested typed children go too: everything under a textbox or searchbox bar `- /property`
 *       lines, `text` and `/value` under the other value roles, and block-scalar continuations. /placeholder and combobox
 *       options stay. Linear time: one pass over the lines, every scan bounded by the line
 *     - cleanInventory(items): the probe's element inventory cut to an allowlist of keys; any key named value or
 *       defaultValue (any case, any prefix) is dropped, so a probe that learned to read input values cannot carry them out
 *     - Nothing here talks to the network or the browser: plain functions over plain data
 *
 * Environment Variables:
 *     None.
 *
 * Author: PMAC
 * ===============================================================================
 */

// The keys a probe item may carry out of the client. `ref` is added by the client itself. data_<name> keys are allowed
// when the name is not a value, a credential or an address (see DROP_KEY).
export const INVENTORY_KEYS = new Set([
  "ref", "tag", "type", "role", "name", "aria_label", "label", "placeholder", "id", "testid", "data_test", "data_qa",
  "data_cy", "class", "name_attr", "title", "alt", "text", "disabled", "hidden", "box", "row", "row_attr", "frame", "shadow",
  // what the service reads to prove a text locator unique (pw_text, pw_cut: the probe's own capped, token-scrubbed copy of the text
  // Playwright's has_text sees) and an element reachable (top_at_center). Leaving them out made the service refuse to claim
  // uniqueness, which is most of what `no_candidate_left` and `no_pick` were in the acceptance run.
  "pw_text", "pw_cut", "top_at_center",
]);
const BOOL_KEYS = new Set(["disabled", "hidden", "pw_cut", "top_at_center"]); // true or false, nothing else
const DATA_KEY = /^data_[a-z0-9_]{1,60}$/;
const DROP_KEY = /value|token|csrf|auth|session|secret|email|password|cookie|passcode|credential|bearer|api_?key|(^|_)(otp|pin|jwt|ssn|card|cvv|cvc|iban|heal)(_|$)/i; // `heal`: a marker this client sets must never be an inventory key
const BOX_KEYS = ["x", "y", "width", "height"];
const FIELD_MAX = 400;

// Roles whose text after the colon is the control's current value; other roles' text after the colon is page prose.
const VALUE_ROLES = new Set(["textbox", "searchbox", "spinbutton", "slider", "combobox", "textarea"]);
// Roles that hold free text: everything nested under them (text, links, ...) was typed, bar `/property` lines.
const FREE_TEXT_ROLES = new Set(["textbox", "searchbox", "textarea"]);

/** Index just past the YAML quoted scalar opening at `s[i]` (`'..''..'` or `"..\\".."`), or -1 if unterminated. */
function quotedEnd(s, i) {
  const quote = s[i];
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (quote === "'" && c === "'") {
      if (j + 1 < n && s[j + 1] === "'") {
        j += 2;
        continue;
      }
      return j + 1;
    }
    if (quote === '"' && c === "\\") {
      j += 2;
      continue;
    }
    if (quote === '"' && c === '"') return j + 1;
    j += 1;
  }
  return -1;
}

function roleAt(s, i) {
  let j = i;
  while (j < s.length && s[j] >= "a" && s[j] <= "z") j += 1;
  return j === s.length || " \t:\"['".includes(s[j]) ? s.slice(i, j) : "";
}

/** End of `role "name" [state]...` starting at `s[i]` (the role must already be known to end there). */
function plainKeyEnd(s, i) {
  let j = i;
  while (j < s.length && s[j] >= "a" && s[j] <= "z") j += 1;
  while (j + 1 < s.length && s[j] === " ") {
    if (s[j + 1] === '"') {
      const k = quotedEnd(s, j + 1);
      if (k < 0) return s.length;
      j = k;
    } else if (s[j + 1] === "[") {
      const k = s.indexOf("]", j + 2);
      if (k < 0) return s.length;
      j = k + 1;
    } else {
      break;
    }
  }
  return j;
}

/** [indent, keyStart, role, keyEnd, hasInlineValue] of a `- key[: value]` line, or null for anything else. */
function entry(line) {
  const n = line.length;
  let indent = 0;
  while (indent < n && line[indent] === " ") indent += 1;
  if (line.slice(indent, indent + 1) !== "-" || line.slice(indent + 1, indent + 2) !== " ") return null;
  let start = indent + 1;
  while (start < n && line[start] === " ") start += 1;
  if (start >= n) return null;
  let end;
  let role;
  if (line[start] === "'" || line[start] === '"') {
    end = quotedEnd(line, start);
    if (end < 0) return null;
    role = roleAt(line, start + 1);
  } else {
    role = roleAt(line, start);
    end = plainKeyEnd(line, start);
  }
  const rest = line.slice(end).replace(/^[ \t]+/, "");
  return [indent, start, role, end, rest.startsWith(":") && rest.slice(1).trim().length > 0];
}

const isProperty = (line) => line.replace(/^ +/, "").startsWith("- /");

/** The query and fragment of a `/url:` line (they can carry tokens) and the name of a [selected] option (what a person chose). */
function stripUrlsAndSelections(line) {
  const url = /^(\s*- \/url:\s*)(.*?)(\s*)$/.exec(line);
  if (url) return url[1] + url[2].replace(/[?#].*$/, "") + url[3];
  return line.replace(/^(\s*- option) (?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s[]+)(?=(?: \[[^\]]*\])*\s*\[selected\])/, "$1");
}

/** `yamlText` with the value removed from every input line of an accessibility snapshot, inline or nested. */
export function redactTypedValues(yamlText) {
  return redactInputs(yamlText).split(/(?<=\n)/).map(stripUrlsAndSelections).join("");
}

function redactInputs(yamlText) {
  const out = [];
  const frames = []; // open value-role entries: [indent, role, [child indent or -1]]
  let dropping = -1; // indent of a dropped child whose subtree is being skipped
  for (let line of yamlText.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g) || []) {
    const bare = line.replace(/[\r\n]+$/, "");
    const indent = bare.length - bare.replace(/^ +/, "").length;
    if (!bare.trim()) {
      if (dropping < 0) out.push(line);
      continue;
    }
    if (dropping >= 0 && indent > dropping) continue;
    dropping = -1;
    while (frames.length && frames[frames.length - 1][0] >= indent) frames.pop();
    const ent = entry(bare);
    if (frames.length) {
      const [, fRole, child] = frames[frames.length - 1];
      if (child[0] < 0) child[0] = indent;
      if (indent <= child[0]) {
        const prop = isProperty(bare);
        if (bare.replace(/^ +/, "").startsWith("- /value") ||
            (!prop && (ent === null || FREE_TEXT_ROLES.has(fRole) || ent[2] === "text"))) {
          dropping = indent;
          continue;
        }
      }
    }
    if (ent !== null && VALUE_ROLES.has(ent[2])) {
      frames.push([ent[0], ent[2], [-1]]);
      // Cut at the key: the inline value and its colon go, and the dash is normalised to "- " so every
      // redacted line has one shape whatever the spacing it arrived with.
      line = " ".repeat(ent[0]) + "- " + bare.slice(ent[1], ent[3]) + line.slice(bare.length);
    }
    out.push(line);
  }
  return out.join("");
}

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

function cleanItem(item) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (DROP_KEY.test(key)) continue;
    if (!INVENTORY_KEYS.has(key) && !DATA_KEY.test(key)) continue;
    if (BOOL_KEYS.has(key) && typeof value !== "boolean") continue;
    if (key === "box") {
      if (value && typeof value === "object" && BOX_KEYS.every((k) => isNumber(value[k]))) {
        out[key] = Object.fromEntries(BOX_KEYS.map((k) => [k, value[k]]));
      } else if (value === null) {
        out[key] = null;
      }
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value.slice(0, FIELD_MAX);
    }
  }
  return out;
}

/**
 * `items` (the probe's element list) keeping only allowlisted keys with plain values: a string (capped), a boolean, or a
 * numeric box. Anything else, and every key named like a value or a credential, is dropped.
 */
export function cleanInventory(items) {
  return (Array.isArray(items) ? items : []).map(cleanItem).filter((c) => c !== null);
}

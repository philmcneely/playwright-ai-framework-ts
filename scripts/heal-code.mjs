/**
 * ===============================================================================
 * Heal Code Checks (the TypeScript compiler API as the locator validator)
 * ===============================================================================
 * Everything the heal client does with TypeScript source text lives here, and all of it walks a syntax tree: a locator the
 * service sends is never eval'd, never matched with a pattern that a clever string could slip past, and never written to a
 * file unless it is one clean expression made only of approved Playwright calls with literal arguments. The checks are a port
 * of the Python client's validator (utils/heal_client.py) onto the `typescript` package, which is already a devDependency.
 *
 * Features:
 *     - validateReplacement(proposed, original): the second check on every replacement. One expression, one line, no comment,
 *       no control, format (bidi) or line-separator character, a chain of locator / getBy* / first / last / nth / filter
 *       calls with literal arguments (strings, numbers, booleans, null, regex literals, flat option objects of those),
 *       rooted at the same receiver (`page` / `this.page`) as the expression it replaces
 *     - checkReplacement(to, original, branches, exactBranches): the reason a replacement may not be written, or null.
 *       Branch code (`await byLanguage(receiver, { en: ..., fr: ... })`) must name the same languages as the candidate's
 *       branches, with the same locator for each, and EVERY branch must pass validateReplacement on its own
 *     - buildLocator(page, expression): the Playwright locator an approved expression stands for, built by walking the
 *       tree. Only the approved methods, only literal arguments, only on `page` or `this.page`
 *     - expressionSpans(text, file): every expression node's character span in a file, so a patch can be required to cover
 *       exactly one node (a span inside a string or a comment, or one that cuts a node in half, is not a node)
 *     - importsHelper / withHelperImport: a real `import { byLanguage }` statement is found in the tree (a comment or a
 *       string that says so does not count) and added after the last import when it is missing
 *     - probingSelector: selectors that read a value back (prefix/suffix/substring operators, `value`, `:has-text`, hidden inputs) are refused
 *     - toUtf16Index: the service counts spans in code points; JavaScript strings count UTF-16 units
 *     - awaitAllowedAt: whether an `await` may be written where a patch goes (async function or module top level)
 *
 * Environment Variables:
 *     None.
 *
 * Author: PMAC
 * ===============================================================================
 */
import path from "node:path";
import ts from "typescript";

export const HELPER = "byLanguage";
export const HELPER_MODULE = "utils/heal-locale";
export const ALLOWED_LOCATOR_METHODS = new Set([
  "locator", "getByRole", "getByLabel", "getByText", "getByPlaceholder", "getByTestId", "getByAltText", "getByTitle",
  "first", "last", "nth", "filter",
]);
// The methods a chain may start with: the others only narrow a locator that already exists.
const ROOT_METHODS = new Set([
  "locator", "getByRole", "getByLabel", "getByText", "getByPlaceholder", "getByTestId", "getByAltText", "getByTitle",
]);
const LANG_KEY = /^[a-z]{2,3}$/;
// control, format (bidi), line and paragraph separators: anything that can hide or end a line differently from how it reads
const BAD_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const K = ts.SyntaxKind;

/** True when `text` holds a control character (a carriage return, form feed, tab, NUL, C1), a bidi or other format
 * character, or a line or paragraph separator. */
export const hasControl = (text) => BAD_CHARS.test(text) || Buffer.from(text, "utf8").toString("utf8") !== text; // a lone surrogate is not text

// ---- parsing -------------------------------------------------------------------------------------------------------------
// An expression is parsed inside `async () => (<text>)` so `await` is legal and a stray `;`, `)` or trailing line comment
// is a syntax error instead of a second statement.
const PREFIX = "async()=>(";
const SUFFIX = ")";

function kindFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const parseFile = (text, file) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindFor(file));
const syntaxErrors = (sf) => sf.parseDiagnostics?.length ?? 0;

/** {sf, expr, source} for `text` as exactly one parenthesised expression, or null when it does not parse as one. */
function parseExpression(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const source = PREFIX + text + SUFFIX;
  const sf = parseFile(source, "expr.ts");
  if (syntaxErrors(sf) || sf.statements.length !== 1) return null;
  const st = sf.statements[0];
  if (!ts.isExpressionStatement(st) || !ts.isArrowFunction(st.expression)) return null;
  const body = st.expression.body;
  if (!ts.isParenthesizedExpression(body) || body.getStart(sf) !== PREFIX.length - 1 || body.getEnd() !== source.length) {
    return null;
  }
  const expr = body.expression;
  if (expr.getStart(sf) !== PREFIX.length || expr.getEnd() !== PREFIX.length + text.length) return null;
  return { sf, expr, source };
}

function hasComment(sf, source) {
  const visit = (node) => {
    if (ts.getLeadingCommentRanges(source, node.pos)?.length || ts.getTrailingCommentRanges(source, node.end)?.length) {
      return true;
    }
    return node.getChildren(sf).some(visit);
  };
  return visit(sf);
}

/** The expression `text` is, when it is exactly one on one line with no comment and no control character. */
function parseSingle(text) {
  if (typeof text !== "string" || !text.trim() || hasControl(text)) return null;
  const parsed = parseExpression(text);
  return parsed && !hasComment(parsed.sf, parsed.source) ? parsed : null;
}

// ---- literals and canonical form -----------------------------------------------------------------------------------------
class NotLiteral extends Error {}

// A regex that can backtrack for ever on a page's text: a group that holds a quantifier and is itself quantified, or one that is
// alternation under a quantifier. Refused outright, as is anything long.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d)(?:[^()\\]|\\.)*\)[+*{]|\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*{]/;

function regexOf(node) {
  const text = node.text;
  if (text.length > 200 || NESTED_QUANTIFIER.test(text)) throw new NotLiteral("regex");
  const slash = text.lastIndexOf("/");
  try {
    return new RegExp(text.slice(1, slash), text.slice(slash + 1));
  } catch {
    throw new NotLiteral("regex");
  }
}

const keyName = (name) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;

/** The JavaScript value of a literal argument; throws NotLiteral for anything else. `flat` forbids nested objects. */
function literalOf(node, flat = false) {
  switch (node.kind) {
    case K.StringLiteral: return node.text;
    case K.NumericLiteral: return Number(node.text);
    case K.TrueKeyword: return true;
    case K.FalseKeyword: return false;
    case K.NullKeyword: return null;
    case K.RegularExpressionLiteral: return regexOf(node);
    case K.PrefixUnaryExpression:
      if (node.operator === K.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
      throw new NotLiteral("unary");
    case K.ObjectLiteralExpression: {
      if (flat) throw new NotLiteral("nested object");
      const out = {};
      for (const prop of node.properties) {
        const name = ts.isPropertyAssignment(prop) ? keyName(prop.name) : null;
        if (name === null || name === "__proto__" || Object.hasOwn(out, name)) throw new NotLiteral("property");
        out[name] = literalOf(prop.initializer, true);
      }
      return out;
    }
    default: throw new NotLiteral(ts.SyntaxKind[node.kind]);
  }
}

// A selector that reads a value back one character at a time (prefix, suffix, substring, word or dash matches, or any selector on
// a `value` attribute), or that probes text or hidden inputs. `[attr=value]` with plain `=` stays: the service writes it.
const PROBING_SELECTOR = /\[\s*[^\]=\s]+\s*[\^*$~|]=|\[\s*value\s*[\^*$~|]?=|:has-text|:text|:nth-match|text\s*=\s*\/|\btype\s*=\s*["']?hidden/i;

/** True when a locator() selector string may be used to probe page data rather than to find an element. */
export const probingSelector = (text) => typeof text === "string" && PROBING_SELECTOR.test(text);

const isLiteral = (node) => {
  try {
    literalOf(node);
    return true;
  } catch {
    return false;
  }
};

/** A text for `node` that does not depend on quote style or spacing, or null when the node is not in the approved subset. */
function canon(node) {
  switch (node.kind) {
    case K.StringLiteral: return JSON.stringify(node.text);
    case K.NumericLiteral: return node.text;
    case K.TrueKeyword: return "true";
    case K.FalseKeyword: return "false";
    case K.NullKeyword: return "null";
    case K.ThisKeyword: return "this";
    case K.RegularExpressionLiteral: return node.text;
    case K.Identifier: return node.text;
    case K.PrefixUnaryExpression:
      return node.operator === K.MinusToken && ts.isNumericLiteral(node.operand) ? "-" + node.operand.text : null;
    case K.PropertyAccessExpression: {
      if (node.questionDotToken || !ts.isIdentifier(node.name)) return null;
      const base = canon(node.expression);
      return base === null ? null : `${base}.${node.name.text}`;
    }
    case K.CallExpression: {
      if (node.questionDotToken || node.typeArguments) return null;
      const callee = canon(node.expression);
      const args = node.arguments.map(canon);
      return callee === null || args.includes(null) ? null : `${callee}(${args.join(", ")})`;
    }
    case K.ObjectLiteralExpression: {
      const parts = [];
      for (const prop of node.properties) {
        const name = ts.isPropertyAssignment(prop) ? keyName(prop.name) : null;
        const value = name === null ? null : canon(prop.initializer);
        if (value === null) return null;
        parts.push(`${JSON.stringify(name)}: ${value}`);
      }
      return `{ ${parts.join(", ")} }`;
    }
    case K.AwaitExpression: {
      const inner = canon(node.expression);
      return inner === null ? null : `await ${inner}`;
    }
    default: return null;
  }
}

/** `text` in its normalized form, or null when it is not a single clean expression. */
export function normal(text) {
  const parsed = parseSingle(text);
  return parsed ? canon(parsed.expr) : null;
}

/** True when `text` is exactly one clean expression (no comment, control character or second statement). */
export const isSingleExpression = (text) => parseSingle(text) !== null;

// ---- the locator chain ---------------------------------------------------------------------------------------------------
const isThisPage = (n) => ts.isPropertyAccessExpression(n) && n.expression.kind === K.ThisKeyword && n.name.text === "page" &&
  !n.questionDotToken;

/** The receiver text of a pure locator chain (`page`, `this.page` or another bare name), or null when `expr` is not one. */
function chainReceiver(expr) {
  let node = expr;
  let first = null;
  while (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (node.questionDotToken || node.typeArguments || !ts.isPropertyAccessExpression(callee) || callee.questionDotToken ||
        !ts.isIdentifier(callee.name) || !ALLOWED_LOCATOR_METHODS.has(callee.name.text) || !node.arguments.every(isLiteral)) {
      return null;
    }
    if (callee.name.text === "locator" && node.arguments.some((a) => ts.isStringLiteral(a) && probingSelector(a.text))) return null;
    first = callee.name.text;
    node = callee.expression;
  }
  if (first === null || !ROOT_METHODS.has(first)) return null;
  if (isThisPage(node)) return "this.page";
  return ts.isIdentifier(node) && node.text !== "undefined" ? node.text : null;
}

/**
 * The replacement when it is a safe drop-in for `original`, else null. One expression, one line, no comment and no control
 * character, a chain of approved Playwright locator calls with literal arguments, rooted at the same receiver as the
 * original.
 */
export function validateReplacement(proposed, original) {
  const p = parseSingle(proposed);
  if (!p || typeof original !== "string") return null;
  const o = parseExpression(original);
  if (!o) return null;
  const receiver = chainReceiver(p.expr);
  return receiver !== null && receiver === chainReceiver(o.expr) ? proposed : null;
}

/** The object the first locator method of `expr` is called on (`this.page`), or null. */
export function receiverText(expr) {
  const parsed = parseExpression(expr);
  return parsed ? chainReceiver(parsed.expr) : null;
}

/** {receiver, branches: {language: normalized code}, texts: {language: code as written}} when `code` is
 * `[await] byLanguage(<receiver>, { en: ..., fr: ... })`, else null. */
export function branchDict(code) {
  const parsed = parseExpression(code);
  if (!parsed) return null;
  // the service writes `await byLanguage(...)`; the helper's result also works without the await, so both are read
  const node = ts.isAwaitExpression(parsed.expr) ? parsed.expr.expression : parsed.expr;
  if (!ts.isCallExpression(node)) return null;
  const call = node;
  if (!ts.isIdentifier(call.expression) || call.expression.text !== HELPER || call.questionDotToken || call.typeArguments ||
      call.arguments.length !== 2 || !ts.isObjectLiteralExpression(call.arguments[1])) {
    return null;
  }
  const branches = {};
  const texts = {};
  for (const prop of call.arguments[1].properties) {
    const key = ts.isPropertyAssignment(prop) ? keyName(prop.name) : null;
    if (key === null || !LANG_KEY.test(key) || Object.hasOwn(branches, key)) return null;
    const value = canon(prop.initializer);
    if (value === null) return null;
    branches[key] = value;
    texts[key] = parsed.source.slice(prop.initializer.getStart(parsed.sf), prop.initializer.getEnd());
  }
  const receiver = canon(call.arguments[0]);
  return receiver === null ? null : { receiver, branches, texts };
}

/**
 * null when `to` may replace `original`, else the reason it may not.
 *
 * A plain locator must pass validateReplacement. Branch code (await byLanguage(receiver, {...})) must name the same languages
 * as `branches`, carry the same locator for each (`exactBranches`; a patch in another file has its own receiver), and EVERY
 * branch must pass validateReplacement on its own.
 */
export function checkReplacement(to, original, branches = null, exactBranches = true) {
  if (validateReplacement(original, original) === null) return "the expression to replace is not a plain locator chain";
  if (to === original) return "the replacement is identical to the failing locator";
  if (!isSingleExpression(to)) {
    return "the replacement is not a single clean expression (no comment, control character or second statement)";
  }
  const hasBranches = branches !== null && typeof branches === "object" && Object.keys(branches).length > 0;
  if (to.includes(HELPER + "(") || hasBranches) {
    const parsed = branchDict(to);
    if (parsed === null || !hasBranches) {
      return "the replacement is not a byLanguage(receiver, {...}) call matching the candidate's branches";
    }
    const wanted = Object.keys(branches).sort();
    const found = Object.keys(parsed.branches).sort();
    if (wanted.length !== found.length || wanted.some((k, i) => k !== found[i])) {
      return "the languages in the code differ from the candidate's branches";
    }
    if (parsed.receiver !== receiverText(original)) return "the helper's receiver is not the receiver of the failing locator";
    for (const lang of found) {
      if (exactBranches && normal(branches[lang]) !== parsed.branches[lang]) {
        return `the ${lang} branch in the code differs from the candidate's branch`;
      }
      if (validateReplacement(parsed.texts[lang], original) === null) return `the ${lang} branch is not a safe locator`;
    }
    return null;
  }
  return validateReplacement(to, original) !== null ? null : "the replacement is not a safe locator expression";
}

// ---- building a live locator ---------------------------------------------------------------------------------------------
/**
 * The Playwright locator an approved expression stands for, built by walking its syntax tree: only the approved locator
 * methods, literal arguments, on `page` or `this.page`. Nothing is ever eval'd. null when it cannot be built.
 */
export function buildLocator(page, expression) {
  const parsed = parseExpression(expression);
  if (!parsed) return null;
  const walk = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (node.questionDotToken || !ts.isPropertyAccessExpression(callee) || callee.questionDotToken ||
          !ALLOWED_LOCATOR_METHODS.has(callee.name.text)) {
        throw new NotLiteral("unsupported call");
      }
      const args = node.arguments.map((a) => literalOf(a));
      if (callee.name.text === "locator" && probingSelector(args[0])) throw new NotLiteral("probing selector");
      const receiver = walk(callee.expression);
      if (typeof receiver?.[callee.name.text] !== "function") throw new NotLiteral("no such method");
      return receiver[callee.name.text](...args);
    }
    if (isThisPage(node) || (ts.isIdentifier(node) && node.text === "page")) return page;
    throw new NotLiteral("unsupported receiver");
  };
  try {
    return walk(parsed.expr);
  } catch {
    return null;
  }
}

// ---- spans in a file -----------------------------------------------------------------------------------------------------
/** The UTF-16 index of code-point offset `cp` in `text` (spans from the service count code points). null when out of range. */
export function toUtf16Index(text, cp) {
  if (!Number.isInteger(cp) || cp < 0) return null;
  if (!/[\ud800-\udbff]/.test(text)) return cp <= text.length ? cp : null;
  let units = 0;
  let seen = 0;
  while (seen < cp) {
    if (units >= text.length) return null;
    const c = text.codePointAt(units);
    units += c > 0xffff ? 2 : 1;
    seen += 1;
  }
  return units;
}

/** A Set of "start:end" (UTF-16) for every expression node of `text`, or null when the file does not parse. */
export function expressionSpans(text, file = "file.ts") {
  const sf = parseFile(text, file);
  if (syntaxErrors(sf)) return null;
  const spans = new Set();
  const visit = (node) => {
    if (ts.isExpression(node) && node.getEnd() > node.getStart(sf)) spans.add(`${node.getStart(sf)}:${node.getEnd()}`);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return spans;
}

/**
 * True when an `await` may be written in place of the expression at [start, end) of `text`: inside an async function, or at
 * the top level of a module. A getter, a class field, a non-async function or a script are not (the service writes
 * `await byLanguage(...)`, which would not compile there).
 */
export function awaitAllowedAt(text, file, start, end) {
  const sf = parseFile(text, file);
  let target = null;
  const find = (node) => {
    if (target === null && ts.isExpression(node) && node.getStart(sf) === start && node.getEnd() === end) target = node;
    if (target === null) ts.forEachChild(node, find);
  };
  find(sf);
  if (target === null) return false;
  for (let n = target.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) return Boolean(n.modifiers?.some((m) => m.kind === K.AsyncKeyword));
    if (ts.isPropertyDeclaration(n) || ts.isClassStaticBlockDeclaration(n)) return false;
    if (ts.isSourceFile(n)) return n.statements.some((st) => ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isExportAssignment(st) ||
      st.modifiers?.some((m) => m.kind === K.ExportKeyword));
  }
  return false;
}

// ---- the helper import ---------------------------------------------------------------------------------------------------
const resolvesToHelper = (file, spec) => {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).replace(/\.(?:js|ts|mjs|mts)$/, "");
  return target === HELPER_MODULE;
};

/** True when `source` has a real, un-aliased value `import { byLanguage }` of utils/heal-locale (a comment or a string that
 * says so does not count). `file` is the path of `source` relative to the repository, to resolve the specifier. */
export function importsHelper(source, file) {
  const sf = parseFile(source, file);
  if (syntaxErrors(sf)) return false;
  return sf.statements.some((st) =>
    ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && resolvesToHelper(file, st.moduleSpecifier.text) &&
    st.importClause && !st.importClause.isTypeOnly && st.importClause.namedBindings &&
    ts.isNamedImports(st.importClause.namedBindings) &&
    st.importClause.namedBindings.elements.some((e) => e.name.text === HELPER && !e.propertyName && !e.isTypeOnly));
}

/** `import { byLanguage } from "<relative path>";` for a file at `file` (relative to the repository). */
export function helperImportLine(file) {
  let rel = path.posix.relative(path.posix.dirname(file), HELPER_MODULE + ".js");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return `import { ${HELPER} } from "${rel}";`;
}

/** `source` with the helper import added after its last import (or before its first statement). */
export function withHelperImport(source, file) {
  const sf = parseFile(source, file);
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const line = helperImportLine(file);
  const imports = sf.statements.filter((st) => ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st));
  if (imports.length) {
    const at = imports[imports.length - 1].getEnd();
    return source.slice(0, at) + nl + line + source.slice(at);
  }
  let at = 0;
  const shebang = source.startsWith("#!") ? source.search(/\r?\n/) : -1;
  if (shebang >= 0) at = shebang + (source[shebang] === "\r" ? 2 : 1);
  let lead = sf.statements.findIndex((st) => !(ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)));
  if (lead < 0) lead = sf.statements.length;
  if (lead > 0) return source.slice(0, sf.statements[lead - 1].getEnd()) + nl + line + source.slice(sf.statements[lead - 1].getEnd());
  const first = sf.statements[0];
  if (first) at = Math.max(at, first.getStart(sf, true));
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  return source.slice(0, lineStart) + line + nl + source.slice(lineStart);
}

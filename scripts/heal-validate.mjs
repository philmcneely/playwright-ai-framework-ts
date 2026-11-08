/**
 * Validation of untrusted locator text for scripts/heal.mjs (kept side-effect
 * free so it can be unit-tested).
 *
 * This is the framework's SECOND check on every locator the heal service writes: the first is the syntax-tree validator in
 * scripts/heal-code.mjs, and a locator is written to a file only when both accept it. It is a pattern check on purpose, a
 * different mechanism from the tree walk, so a gap in one is not a gap in the other.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ROOT_METHODS = "locator|getByRole|getByLabel|getByText|getByPlaceholder|getByAltText|getByTitle|getByTestId";
const NARROW_METHODS = "first|last|nth|filter";
// String literals ('..' or ".."), then regex literals (/../flags).
const LITERALS = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\/(?![*/])(?:[^/\\\n]|\\.)+\/[a-z]*/g;

/**
 * The replacement is untrusted (it was written from app-controlled text).
 * Accept only `<same receiver>.<locator method>(<literal args>)` followed by more locator calls (`.first()`, `.nth(1)`,
 * `.filter({ hasText: 'x' })`, `.locator('.b')`): strings, regex literals, numbers, booleans and flat option objects of
 * those - no nested calls, operators, template strings, semicolons or statements.
 */
export function validReplacement(proposed, receiver) {
  if (!proposed || proposed.includes("\n")) return false;
  const masked = proposed.replace(LITERALS, "S");
  const value = "(?:S|-?\\d+(?:\\.\\d+)?|true|false|null)";
  const options = `\\{(?:\\s*\\w+\\s*:\\s*${value}\\s*,?)*\\s*\\}`;
  const arg = `\\s*(?:${value}|${options})\\s*`;
  const call = (methods) => `\\.(?:${methods})\\((?:${arg}(?:,${arg})*)?\\)`;
  const re = new RegExp(`^${escapeRe(receiver)}${call(ROOT_METHODS)}(?:${call(`${ROOT_METHODS}|${NARROW_METHODS}`)})*$`);
  return re.test(masked);
}

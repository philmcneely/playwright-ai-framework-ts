/**
 * Validation of untrusted model output for scripts/heal.mjs (kept side-effect
 * free so it can be unit-tested).
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LOCATOR_METHODS = "locator|getByRole|getByLabel|getByText|getByPlaceholder|getByAltText|getByTitle|getByTestId";
// String literals ('..' or ".."), then regex literals (/../flags).
const LITERALS = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\/(?![*/])(?:[^/\\\n]|\\.)+\/[a-z]*/g;

/**
 * The model's reply is untrusted (the prompt contains app-controlled text).
 * Accept only `<same receiver>.<locator method>(<literal args>)`: strings,
 * regex literals, numbers, booleans and flat option objects of those — no nested calls,
 * operators, template strings, semicolons or statements.
 */
export function validReplacement(proposed, receiver) {
  if (!proposed || proposed.includes("\n")) return false;
  const masked = proposed.replace(LITERALS, "S");
  const value = "(?:S|-?\\d+(?:\\.\\d+)?|true|false|null)";
  const options = `\\{(?:\\s*\\w+\\s*:\\s*${value}\\s*,?)*\\s*\\}`;
  const arg = `\\s*(?:${value}|${options})\\s*`;
  const re = new RegExp(`^${escapeRe(receiver)}\\.(?:${LOCATOR_METHODS})\\((?:${arg}(?:,${arg})*)?\\)$`);
  return re.test(masked);
}

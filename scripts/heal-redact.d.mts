/** Types for scripts/heal-redact.mjs (the typed-value redaction). */
export const INVENTORY_KEYS: Set<string>;
export function redactTypedValues(yamlText: string): string;
export function cleanInventory(items: unknown): Array<Record<string, unknown>>;

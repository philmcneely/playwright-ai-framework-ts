/** Types for scripts/heal-code.mjs (the syntax-tree locator checks). */
export const HELPER: string;
export const HELPER_MODULE: string;
export const ALLOWED_LOCATOR_METHODS: Set<string>;
export function hasControl(text: string): boolean;
export function normal(text: unknown): string | null;
export function isSingleExpression(text: unknown): boolean;
export function validateReplacement(proposed: unknown, original: unknown): string | null;
export function receiverText(expr: string): string | null;
export function branchDict(
  code: string,
): { receiver: string; branches: Record<string, string>; texts: Record<string, string> } | null;
export function checkReplacement(
  to: string,
  original: string,
  branches?: Record<string, string> | null,
  exactBranches?: boolean,
): string | null;
export function buildLocator<T = unknown>(page: unknown, expression: string): T | null;
export function toUtf16Index(text: string, cp: number): number | null;
export function expressionSpans(text: string, file?: string): Set<string> | null;
export function importsHelper(source: string, file: string): boolean;
export function helperImportLine(file: string): string;
export function withHelperImport(source: string, file: string): string;
export function awaitAllowedAt(text: string, file: string, start: number, end: number): boolean;
export function probingSelector(text: unknown): boolean;

/** Types for scripts/heal-fingerprints.mjs (the fingerprint file format and store). */
export const VERSION: number;
export const DEFAULT_ROOTS: string[];
export const ACTIONS: string[];
export const MAX_NEIGHBOURS: number;
export type Env = Record<string, string | undefined>;
export interface FingerprintEntry {
  file: string;
  text: string;
  page: string;
  language: string;
  fingerprint: Record<string, unknown>;
}
export interface Store {
  version: number;
  entries: Record<string, FingerprintEntry>;
}
export function safeRelative(value: string | undefined): string | null;
export function sourceRoots(env?: Env): string[];
export function healDir(root: string, env?: Env, warn?: (message: string) => void): string;
export function copyMode(env?: Env): "on" | "off";
export function enabled(env?: Env): boolean;
export function normalizeLine(text: string): string;
export function callKey(file: string, text: string): string;
export function lineOf(root: string, file: string, line: number): string;
export function relativeUnder(p: string, root: string, roots: string[]): string | null;
export function hashCopy(text: string): string;
export function itemToFingerprint(
  item: Record<string, unknown>,
  frame?: string,
  copy?: "on" | "off",
): Record<string, unknown>;
export function pagePath(url: string): string;
export function loadStore(file: string): Store;
export function serializeStore(store: Store): string;
export function ensureIgnore(directory: string, env?: Env): void;
export function mergeInto(root: string, records: Record<string, FingerprintEntry>, env?: Env): Promise<boolean>;
export function lastPassFor(
  store: Store,
  key: string,
): { fingerprint: Record<string, unknown>; neighbours: Array<Record<string, unknown>>; language?: string } | null;
export function stackFrames(text: string, root: string, roots: string[]): Array<{ file: string; line: number }>;

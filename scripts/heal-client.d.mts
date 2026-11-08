/* eslint-disable @typescript-eslint/no-explicit-any -- the service replies and Playwright pages are dynamic JSON/objects */
import type { buildLocator, checkReplacement, validateReplacement } from "./heal-code.mjs";
import type { vendoredProbe } from "./heal-probe.mjs";

export type Env = Record<string, string | undefined>;
export type Json = Record<string, any>;

export interface HealSettings {
  url: string;
  token: string;
  vision: "off" | "auto" | "on";
  mask: string[];
  testIdAttribute: string;
  roots: string[];
  storageState: string | null;
  baseUrl: string;
}

export interface Failure {
  title: string;
  file?: string;
  error: string;
  stack?: string;
  location?: { file: string; line: number } | null;
  route?: string | null;
}

export interface PlannedFile {
  rel: string;
  original: Buffer;
  newText: string;
}

export interface Decision {
  test: string;
  outcome: "healed" | "needs_human" | "not_drift";
  reason?: string | null;
  why?: string | null;
  usage?: { calls: number; input_tokens: number; output_tokens: number; images: number };
  file?: string;
  from?: string;
  to?: string;
  files?: string[];
  source?: string;
  notes?: string[];
  [key: string]: unknown;
}

export const DEFAULT_BASE_URL: string;
export const LIMITS: { files: number; fileBytes: number; ariaChars: number };
export { buildLocator, checkReplacement, validateReplacement, vendoredProbe };

export function splitSelectors(text: string | undefined): string[];
export function settingsFromEnv(env?: Env): HealSettings;
export class HealServiceError extends Error {}
export class ServiceClient {
  constructor(
    baseUrl: string,
    token?: string,
    options?: { fetchImpl?: typeof fetch; env?: Env; timeoutMs?: number },
  );
  base: string;
  capabilities(): Promise<Json>;
  probeJs(): Promise<string>;
  heal(request: Json): Promise<Json>;
  result(healId: string, report: Json): Promise<Json>;
}
export function cleanError(text: string, root: string): string;
export function stackFromFailure(failure: Failure, roots: string[], root: string): Array<{ file: string; line: number }>;
export function testId(failure: Failure, root: string): string;
export function readTextFile(root: string, rel: string): { text: string; raw: Buffer } | null;
export function withinRoots(root: string, rel: string, roots: string[]): boolean;
export function collectSource(
  stack: Array<{ file: string; line: number }>,
  roots: string[],
  root: string,
): Array<{ path: string; sha256: string; content: string }>;
export function routeFromSource(content: string): string | null;
export function clientVersion(root: string): string;
export function buildRequest(
  failure: Failure,
  files: Array<{ path: string; sha256: string; content: string }>,
  stack: Array<{ file: string; line: number }>,
  snap: Json,
  settings: HealSettings,
  root: string,
  lastPass?: Json | null,
  runId?: string | null,
): Json;
export class PatchRefused extends Error {
  constructor(reason: string, fatal?: boolean);
  reason: string;
  fatal: boolean;
}
export function planPatches(candidate: Json, sent: Record<string, string>, roots: string[], root: string): PlannedFile[];
export function replaceFile(file: string, data: Buffer | string): void;
export function writeFiles(root: string, planned: PlannedFile[], write?: (file: string, data: Buffer) => void): void;
export function revertFiles(root: string, planned: PlannedFile[], write?: (file: string, data: Buffer) => void): void;
export function matchRef(inventory: Json[], facts: Json): string | null;
export class OriginGuard {
  constructor(baseUrl: string);
  origin: string;
  probing: boolean;
  handle(route: any, request?: any): Promise<void>;
  active<T>(fn: () => Promise<T>): Promise<T>;
}
export function pngSize(buf: Buffer): { width: number; height: number } | null;
export class LivePage {
  constructor(settings: HealSettings, route: string, probe: string);
  static open(settings: HealSettings, route: string, probe: string): Promise<LivePage>;
  guard: OriginGuard;
  inventory: Json[];
  language: string;
  notes: string[];
  page: any;
  response: any;
  close(): Promise<void>;
  snapshot(): Promise<Json>;
  screenshot(): Promise<Json | null>;
  check(expression: string): Promise<[number | null, string | null]>;
}
export function subtag(value: string | null | undefined): string;
export function pageLanguage(
  htmlLang?: string | null,
  browserLocale?: string | null,
  contentLanguage?: string | null,
): string;
export class Healer {
  constructor(
    service: Pick<ServiceClient, "probeJs" | "heal" | "result">,
    settings: HealSettings,
    verify: (failure: Failure) => Promise<boolean> | boolean,
    options?: {
      root?: string;
      liveFactory?: ((route: string, probe: string) => Promise<any> | any) | null;
      runId?: string | null;
      writeFile?: (file: string, data: Buffer) => void;
      env?: Env;
      secondCheck?: ((expression: string, original: string) => unknown) | null;
    },
  );
  heal(failure: Failure): Promise<Decision>;
}
export function runTotal(decisions: Array<{ usage?: Record<string, number> }>): {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  images: number;
};

/** Types for scripts/heal.mjs (the heal CLI). */
import type { Decision, Failure, Json } from "./heal-client.mjs";

export function validReplacement(proposed: string, receiver: string): boolean;
export interface SuiteRun {
  code: number;
  report: Json | null;
}
export type SuiteRunner = (options?: { grep?: string | null; file?: string | null; env?: Record<string, string | undefined> }) => SuiteRun;
export function runSuite(options?: { grep?: string | null; file?: string | null; env?: Record<string, string | undefined> }): SuiteRun;
export function failuresOf(report: Json | null, baseUrl?: string): Array<Failure & { file: string }>;
export interface VerifyRun {
  passed: boolean;
  /** the re-run's own failure as failuresOf builds it; null when it passed or no report names the exact test */
  failure: (Failure & { file: string }) | null;
}
export function verifyRun(failure: Failure & { file: string }, runner?: SuiteRunner, root?: string): VerifyRun;
export function verifyPassed(failure: Failure & { file: string }, runner?: SuiteRunner, root?: string): boolean;
/** extra heals of one test after a heal was kept because the test then failed at a different locator */
export const MAX_LATER_ROUNDS: number;
export function workingTreeDirty(): boolean;
export function healFailures(
  fails: Array<Failure & { file: string }>,
  healer: { heal(failure: Failure): Promise<Decision> },
  max: number,
  verify?: (failure: Failure & { file: string }) => Promise<boolean> | boolean,
): Promise<Decision[]>;
export function writeSummary(decisions: Decision[], started: string, runId: string, directory?: string | null): string;
export function printDecisions(decisions: Decision[], log?: (line: string) => void): void;
export function oneLine(value: unknown, limit?: number): string;
export function mdEscape(value: unknown, limit?: number): string;
export function mdCode(value: unknown, limit?: number): string;
export function commitLines(healed: Array<{ test: string; from?: string; to?: string }>): string[];
export function buildPrBody(healed: Decision[], other: Decision[]): string;
export function parseArgs(args: string[]): { grep?: string | null; max?: number; openPr?: boolean; error?: string };
export function main(argv?: string[]): Promise<void>;

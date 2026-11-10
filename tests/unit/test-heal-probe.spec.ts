/**
 * Unit tests: the vendored page probe (scripts/heal-probe.js).
 *
 * The probe runs inside the page under test, so it is code this repository ships and pins: a byte-identical copy of the heal
 * service's probe, whose sha256 is held here as a constant. When the service's probe changes, copy the new file over
 * scripts/heal-probe.js and update PROBE_SHA256 in scripts/heal-probe.mjs and the constant below together. A copy that was
 * edited is refused when it is read, and a service copy is used only when it is byte-identical.
 *
 * @tags @unit @security
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROBE_SHA256, probeFunction, sha256, vendoredProbe } from "../../scripts/heal-probe.mjs";

/** sha256 of the heal service's src/heal_service/probe/probe.js this copy was taken from. */
const SERVICE_PROBE_SHA256 = "55769e1482768b3adea4fc878812e3d330dcaf6c9d696c52f3c3892ee45be73f";

test.describe("vendored probe", { tag: ["@unit", "@security", "@regression"] }, () => {
  test("the file is the service's probe, byte for byte (sha256)", () => {
    expect(sha256(readFileSync("scripts/heal-probe.js"))).toBe(SERVICE_PROBE_SHA256);
    expect(PROBE_SHA256).toBe(SERVICE_PROBE_SHA256);
    expect(sha256(vendoredProbe())).toBe(SERVICE_PROBE_SHA256);
  });

  test("it never reads a value except a button's own label", () => {
    const text = vendoredProbe();
    expect(text).toContain("el.value");
    expect(text).toContain("textarea");
  });

  test("probeFunction wraps the source in a function Playwright can send", () => {
    const fn = probeFunction("(only) => ({ got: only })");
    expect(typeof fn).toBe("function");
    expect(fn.toString()).toContain("(only) => ({ got: only })");
    expect(fn("x")).toEqual({ got: "x" });
  });

  test("a probe file that was edited is refused, never run", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heal-probe-"));
    try {
      mkdirSync(path.join(dir, "scripts"));
      writeFileSync(path.join(dir, "scripts/heal-probe.js"), vendoredProbe() + "\n// edited\n");
      const module = path.resolve("scripts/heal-probe.mjs");
      const run = () => execFileSync(process.execPath, ["--input-type=module", "-e", `import { vendoredProbe } from ${JSON.stringify(module)}; vendoredProbe();`],
        { cwd: dir, encoding: "utf8", stdio: "pipe", env: { ...process.env, NODE_OPTIONS: "" } });
      expect(run).toThrow(/not the vendored probe/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

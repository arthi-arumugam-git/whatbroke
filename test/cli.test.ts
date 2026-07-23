import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BEFORE = "examples/support-agent-gpt4o.jsonl";
const AFTER = "examples/support-agent-gpt5mini.jsonl";

function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      code: err.status ?? -1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** two traces whose diff has a changed-args finding and nothing breaking */
function warningOnlyTraces(): [string, string] {
  const dir = mkdtempSync(join(tmpdir(), "whatbroke-cli-"));
  const trace = (args: Record<string, unknown>) =>
    [
      JSON.stringify({ type: "run_start", run: "flow" }),
      JSON.stringify({ type: "tool_call", run: "flow", name: "lookup_order", args }),
      JSON.stringify({ type: "run_end", run: "flow", status: "ok" }),
    ].join("\n") + "\n";
  const before = join(dir, "before.jsonl");
  const after = join(dir, "after.jsonl");
  writeFileSync(before, trace({ order_id: "A-1042" }));
  writeFileSync(after, trace({ order_id: "A-2077" }));
  return [before, after];
}

describe("cli", () => {
  it("exits 1 and reports the break on the example traces", () => {
    const result = cli(["diff", BEFORE, AFTER]);
    expect(result.code).toBe(1);
    const out = strip(result.stdout);
    expect(out).toContain("BROKE");
    expect(out).toContain("cancel_subscription");
    expect(out).toContain("1 breaking");
  });

  it("exits 0 with --fail-on never", () => {
    const result = cli(["diff", BEFORE, AFTER, "--fail-on", "never"]);
    expect(result.code).toBe(0);
  });

  it("exits 1 with --fail-on changed when the diff only has changed findings", () => {
    const [before, after] = warningOnlyTraces();
    const result = cli(["diff", before, after, "--fail-on", "changed"]);
    expect(result.code).toBe(1);
    expect(strip(result.stdout)).toContain("called with different args");
  });

  it("exits 0 with --fail-on breaking when the diff only has changed findings", () => {
    const [before, after] = warningOnlyTraces();
    const result = cli(["diff", before, after]);
    expect(result.code).toBe(0);
  });

  it("exits 0 with --fail-on changed when nothing changed", () => {
    const [before] = warningOnlyTraces();
    const result = cli(["diff", before, before, "--fail-on", "changed"]);
    expect(result.code).toBe(0);
  });

  it("exits 2 on a bogus --fail-on level", () => {
    const result = cli(["diff", BEFORE, AFTER, "--fail-on", "vibes"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--fail-on");
  });

  it("exits 0 when nothing changed", () => {
    const result = cli(["diff", BEFORE, BEFORE]);
    expect(result.code).toBe(0);
    expect(strip(result.stdout)).toContain("nothing broke");
  });

  it("emits valid json with --json", () => {
    const result = cli(["diff", BEFORE, AFTER, "--json", "--fail-on", "never"]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.breaking).toBe(1);
    expect(Array.isArray(parsed.runs)).toBe(true);
  });

  it("emits markdown with --md", () => {
    const result = cli(["diff", BEFORE, AFTER, "--md", "--fail-on", "never"]);
    expect(result.stdout).toContain("## whatbroke report");
    expect(result.stdout).toContain("**BROKE**");
  });

  it("exits 2 on a missing file", () => {
    const result = cli(["diff", "nope.jsonl", AFTER]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("could not read trace file");
  });

  it("exits 2 on an unknown option", () => {
    const result = cli(["diff", BEFORE, AFTER, "--frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown option");
  });

  it("exits 2 when given one file", () => {
    const result = cli(["diff", BEFORE]);
    expect(result.code).toBe(2);
  });

  it("prints help", () => {
    const result = cli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("usage:");
    expect(result.stdout).toContain("whatbroke record");
  });

  it("exits 2 when record is missing --out", () => {
    const result = cli(["record"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--out");
  });
});

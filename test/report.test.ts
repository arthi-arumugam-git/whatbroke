import { describe, expect, it } from "vitest";
import { diffTraces } from "../src/diff.js";
import { parseTrace } from "../src/parse.js";
import { renderMarkdown, renderTerminal } from "../src/report.js";

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const before = [
  '{"type":"run_start","run":"r","meta":{}}',
  '{"type":"tool_call","run":"r","name":"a","args":{"x":1}}',
  '{"type":"output","run":"r","content":"hello"}',
  '{"type":"run_end","run":"r","status":"ok"}',
].join("\n");

const after = [
  '{"type":"run_start","run":"r","meta":{}}',
  '{"type":"output","run":"r","content":"hi"}',
  '{"type":"run_end","run":"r","status":"ok"}',
].join("\n");

describe("renderTerminal", () => {
  it("shows a BROKE badge and the summary", () => {
    const result = diffTraces(parseTrace(before), parseTrace(after));
    const out = strip(renderTerminal(result));
    expect(out).toContain("BROKE");
    expect(out).toContain("tool call dropped: a");
    expect(out).toContain("1 breaking");
  });

  it("celebrates when nothing changed", () => {
    const result = diffTraces(parseTrace(before), parseTrace(before));
    expect(strip(renderTerminal(result))).toContain("nothing broke");
  });
});

describe("renderMarkdown", () => {
  it("renders findings with before/after details", () => {
    const result = diffTraces(parseTrace(before), parseTrace(after));
    const md = renderMarkdown(result);
    expect(md).toContain("## whatbroke report");
    expect(md).toContain("**BROKE**: tool call dropped: a");
    expect(md).toContain("- changed: final output changed");
    expect(md).toContain("before: `hello`");
    expect(md).toContain("after: `hi`");
  });

  it("says so when there is nothing to report", () => {
    const result = diffTraces(parseTrace(before), parseTrace(before));
    expect(renderMarkdown(result)).toContain("No behavioral changes detected.");
  });
});

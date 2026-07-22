import { describe, expect, it } from "vitest";
import { diffTraces } from "../src/diff.js";
import { parseTrace } from "../src/parse.js";

function trace(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

const baseRun = (run: string, model: string) => [
  { type: "run_start", run, meta: { model } },
  { type: "llm_call", run, model, latency_ms: 800, tokens: { input: 500, output: 100 }, cost_usd: 0.01 },
  { type: "tool_call", run, name: "lookup_order", args: { order_id: "A-1042" } },
  { type: "tool_call", run, name: "issue_refund", args: { order_id: "A-1042", amount: 42 } },
  { type: "output", run, content: "Refund issued." },
  { type: "run_end", run, status: "ok" },
];

describe("parseTrace", () => {
  it("groups events into runs", () => {
    const runs = parseTrace(trace(baseRun("refund", "gpt-4o")));
    expect(runs.size).toBe(1);
    const run = runs.get("refund")!;
    expect(run.toolCalls).toHaveLength(2);
    expect(run.llmCalls).toHaveLength(1);
    expect(run.status).toBe("ok");
  });

  it("rejects invalid JSON with a line number", () => {
    expect(() => parseTrace('{"type":"run_start","run":"a"}\nnot json')).toThrow("line 2");
  });

  it("treats runs without run_end as ok", () => {
    const runs = parseTrace(trace([{ type: "output", run: "a", content: "hi" }]));
    expect(runs.get("a")!.status).toBe("ok");
  });

  it("skips unknown event types", () => {
    const runs = parseTrace(trace([{ type: "future_thing", run: "a" }, { type: "output", run: "a", content: "x" }]));
    expect(runs.get("a")!.outputs).toHaveLength(1);
  });
});

describe("diffTraces", () => {
  it("reports nothing when identical", () => {
    const a = parseTrace(trace(baseRun("refund", "gpt-4o")));
    const b = parseTrace(trace(baseRun("refund", "gpt-4o")));
    const result = diffTraces(a, b);
    expect(result.breaking).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it("flags a dropped tool call as breaking", () => {
    const a = parseTrace(trace(baseRun("refund", "gpt-4o")));
    const after = baseRun("refund", "gpt-4o").filter(
      (e: any) => !(e.type === "tool_call" && e.name === "issue_refund"),
    );
    const b = parseTrace(trace(after));
    const result = diffTraces(a, b);
    expect(result.breaking).toBe(1);
    expect(result.findings.some((f) => f.kind === "tool_removed")).toBe(true);
  });

  it("flags changed tool args as warning with before/after detail", () => {
    const after = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "tool_call" && e.name === "issue_refund"
        ? { ...e, args: { order_id: "A-1042", amount: 4200 } }
        : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(after)),
    );
    const finding = result.findings.find((f) => f.kind === "tool_args_changed");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.detail?.before).toEqual({ amount: 42 });
    expect(finding!.detail?.after).toEqual({ amount: 4200 });
  });

  it("flags ok -> error as breaking", () => {
    const after = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "run_end" ? { ...e, status: "error", error: "boom" } : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(after)),
    );
    expect(result.findings.some((f) => f.kind === "status_changed" && f.severity === "breaking")).toBe(true);
  });

  it("flags a missing run as breaking", () => {
    const a = parseTrace(trace([...baseRun("refund", "gpt-4o"), ...baseRun("cancel", "gpt-4o")]));
    const b = parseTrace(trace(baseRun("refund", "gpt-4o")));
    const result = diffTraces(a, b);
    expect(result.findings.some((f) => f.kind === "run_missing" && f.run === "cancel")).toBe(true);
  });

  it("flags tool reordering", () => {
    const reordered = [
      { type: "run_start", run: "r" },
      { type: "tool_call", run: "r", name: "issue_refund", args: {} },
      { type: "tool_call", run: "r", name: "lookup_order", args: {} },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const original = [
      { type: "run_start", run: "r" },
      { type: "tool_call", run: "r", name: "lookup_order", args: {} },
      { type: "tool_call", run: "r", name: "issue_refund", args: {} },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const result = diffTraces(parseTrace(trace(original)), parseTrace(trace(reordered)), {
      compareOutputs: false,
    });
    expect(result.findings.some((f) => f.kind === "tool_reordered")).toBe(true);
  });

  it("flags latency regressions above the threshold", () => {
    const slow = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "llm_call" ? { ...e, latency_ms: 3000 } : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(slow)),
    );
    expect(result.findings.some((f) => f.kind === "latency_regression")).toBe(true);
  });

  it("stays quiet on latency below the threshold", () => {
    const slightlySlow = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "llm_call" ? { ...e, latency_ms: 1000 } : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(slightlySlow)),
    );
    expect(result.findings.some((f) => f.kind === "latency_regression")).toBe(false);
  });

  it("flags output changes as warning", () => {
    const changed = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "output" ? { ...e, content: "I cannot help with refunds." } : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(changed)),
    );
    expect(result.findings.some((f) => f.kind === "output_changed")).toBe(true);
  });

  it("flags new tool errors as breaking", () => {
    const erroring = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "tool_call" && e.name === "issue_refund" ? { ...e, error: "422 unprocessable" } : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(erroring)),
    );
    expect(result.findings.some((f) => f.kind === "tool_error" && f.severity === "breaking")).toBe(true);
  });
});

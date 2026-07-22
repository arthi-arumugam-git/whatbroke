import { describe, expect, it } from "vitest";
import { parseTrace } from "../src/parse.js";
import { diffTracesSampled, hasSamples } from "../src/samples.js";

function trace(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

function run(id: string, tools: Array<[string, Record<string, unknown>]>): object[] {
  return [
    { type: "run_start", run: id },
    { type: "llm_call", run: id, model: "gpt-4o", latency_ms: 800, tokens: { input: 500, output: 100 }, cost_usd: 0.01 },
    ...tools.map(([name, args]) => ({ type: "tool_call", run: id, name, args })),
    { type: "output", run: id, content: "done" },
    { type: "run_end", run: id, status: "ok" },
  ];
}

const stable: Array<[string, Record<string, unknown>]> = [
  ["lookup_order", { order_id: "A-1" }],
  ["issue_refund", { amount: 42 }],
];

describe("hasSamples", () => {
  it("detects run ids with a #N suffix", () => {
    expect(hasSamples(parseTrace(trace(run("refund#1", stable))))).toBe(true);
    expect(hasSamples(parseTrace(trace(run("refund", stable))))).toBe(false);
  });
});

describe("diffTracesSampled", () => {
  it("groups samples under one run diff with mean stats", () => {
    const before = parseTrace(trace([...run("refund#1", stable), ...run("refund#2", stable)]));
    const after = parseTrace(trace([...run("refund#1", stable), ...run("refund#2", stable)]));
    const result = diffTracesSampled(before, after);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].run).toBe("refund");
    expect(result.breaking).toBe(0);
    expect(result.runs[0].before!.toolCalls).toBe(2);
    expect(result.runs[0].before!.llmCalls).toBe(1);
  });

  it("annotates findings with an occurrence rate", () => {
    const before = parseTrace(trace([...run("refund#1", stable), ...run("refund#2", stable)]));
    const after = parseTrace(
      trace([
        ...run("refund#1", [["lookup_order", { order_id: "A-1" }]]),
        ...run("refund#2", [["lookup_order", { order_id: "A-1" }]]),
      ]),
    );
    const result = diffTracesSampled(before, after, { compareOutputs: false });
    const dropped = result.findings.find((f) => f.kind === "tool_removed");
    expect(dropped).toBeDefined();
    expect(dropped!.rate).toBe("4/4");
    expect(dropped!.severity).toBe("breaking");
  });

  it("demotes breaking findings below a 50% rate to warning", () => {
    // issue_refund dropped in only 1 of 2 after samples -> 2 of 4 pairs is not
    // below half, so drop it in 1 of 3 after samples instead: 2 of 6 pairs
    const before = parseTrace(trace([...run("refund#1", stable), ...run("refund#2", stable)]));
    const after = parseTrace(
      trace([
        ...run("refund#1", stable),
        ...run("refund#2", stable),
        ...run("refund#3", [["lookup_order", { order_id: "A-1" }]]),
      ]),
    );
    const result = diffTracesSampled(before, after, { compareOutputs: false });
    const dropped = result.findings.find((f) => f.kind === "tool_removed");
    expect(dropped).toBeDefined();
    expect(dropped!.rate).toBe("2/6");
    expect(dropped!.severity).toBe("warning");
  });

  it("marks findings that also flap in the baseline as flaky info", () => {
    // baseline samples disagree on issue_refund args, so the same args
    // finding across before/after is the agent's own noise
    const before = parseTrace(
      trace([
        ...run("refund#1", [["lookup_order", { order_id: "A-1" }], ["issue_refund", { amount: 42 }]]),
        ...run("refund#2", [["lookup_order", { order_id: "A-1" }], ["issue_refund", { amount: 43 }]]),
      ]),
    );
    const after = parseTrace(
      trace([
        ...run("refund#1", [["lookup_order", { order_id: "A-1" }], ["issue_refund", { amount: 44 }]]),
        ...run("refund#2", [["lookup_order", { order_id: "A-1" }], ["issue_refund", { amount: 45 }]]),
      ]),
    );
    const result = diffTracesSampled(before, after, { compareOutputs: false });
    const args = result.findings.find((f) => f.kind === "tool_args_changed");
    expect(args).toBeDefined();
    expect(args!.flaky).toBe(true);
    expect(args!.severity).toBe("info");
    expect(result.breaking).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it("keeps genuinely new findings even when the baseline flaps elsewhere", () => {
    const before = parseTrace(
      trace([
        ...run("refund#1", [["lookup_order", { order_id: "A-1" }], ["issue_refund", { amount: 42 }]]),
        ...run("refund#2", [["lookup_order", { order_id: "A-1" }], ["issue_refund", { amount: 43 }]]),
      ]),
    );
    const after = parseTrace(
      trace([
        ...run("refund#1", [["lookup_order", { order_id: "A-1" }]]),
        ...run("refund#2", [["lookup_order", { order_id: "A-1" }]]),
      ]),
    );
    const result = diffTracesSampled(before, after, { compareOutputs: false });
    const dropped = result.findings.find((f) => f.kind === "tool_removed");
    expect(dropped).toBeDefined();
    expect(dropped!.flaky).toBeUndefined();
    expect(dropped!.severity).toBe("breaking");
  });

  it("reports a run missing from all after samples as breaking", () => {
    const before = parseTrace(trace([...run("refund#1", stable), ...run("refund#2", stable)]));
    const after = parseTrace(trace(run("other#1", stable)));
    const result = diffTracesSampled(before, after);
    const missing = result.findings.find((f) => f.kind === "run_missing");
    expect(missing).toBeDefined();
    expect(missing!.run).toBe("refund");
    expect(result.breaking).toBe(1);
    const added = result.findings.find((f) => f.kind === "run_added");
    expect(added!.run).toBe("other");
  });

  it("mixes sampled and unsampled run ids", () => {
    const before = parseTrace(trace([...run("refund#1", stable), ...run("status", stable)]));
    const after = parseTrace(trace([...run("refund#1", stable), ...run("status", stable)]));
    const result = diffTracesSampled(before, after);
    expect(result.runs.map((r) => r.run).sort()).toEqual(["refund", "status"]);
    expect(result.breaking).toBe(0);
  });
});

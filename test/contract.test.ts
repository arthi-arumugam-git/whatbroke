import { describe, expect, it } from "vitest";
import {
  checkTrace,
  contractHash,
  generateContract,
  parseContract,
  renderCheckMarkdown,
  renderCheckTerminal,
} from "../src/contract.js";
import { parseTrace } from "../src/parse.js";

function trace(events: object[]): ReturnType<typeof parseTrace> {
  return parseTrace(events.map((e) => JSON.stringify(e)).join("\n"));
}

const REFUND_RUN = [
  { type: "run_start", run: "refund", meta: { model: "gpt-4o" } },
  { type: "llm_call", run: "refund", model: "gpt-4o", latency_ms: 800, cost_usd: 0.01 },
  { type: "tool_call", run: "refund", name: "lookup_order", args: { id: "A-1" } },
  { type: "tool_call", run: "refund", name: "refund_payment", args: { id: "A-1" } },
  { type: "output", run: "refund", content: "Refund issued." },
  { type: "run_end", run: "refund", status: "ok" },
];

describe("parseContract", () => {
  it("rejects non-JSON and empty contracts", () => {
    expect(() => parseContract("nope")).toThrow(/valid JSON/);
    expect(() => parseContract("{}")).toThrow(/no rules/);
    expect(() => parseContract('{"rules":{}}')).toThrow(/no rules/);
  });

  it("rejects unknown rule names and bad shapes", () => {
    expect(() => parseContract('{"rules":{"must_cal":["x"]}}')).toThrow(/not a known rule/);
    expect(() => parseContract('{"rules":{"must_call":"x"}}')).toThrow(/array of strings/);
    expect(() => parseContract('{"rules":{"max_cost_usd":-1}}')).toThrow(/non-negative/);
    expect(() => parseContract('{"rules":{"call_order":["a","b"]}}')).toThrow(/pairs/);
  });

  it("accepts a valid contract", () => {
    const contract = parseContract(
      '{"name":"x","rules":{"must_call":["a"],"call_order":[["a","b"]],"max_cost_usd":0.1}}',
    );
    expect(contract.name).toBe("x");
  });
});

describe("checkTrace", () => {
  const hash = "abc123def456";

  it("passes when all rules hold", () => {
    const contract = parseContract(
      JSON.stringify({
        rules: {
          must_call: ["lookup_order", "refund_payment"],
          must_not_call: ["delete_account"],
          call_order: [["lookup_order", "refund_payment"]],
          max_cost_usd: 0.05,
          max_latency_ms: 5000,
          output_includes: ["refund"],
          require_status: "ok",
          no_tool_errors: true,
        },
      }),
    );
    const result = checkTrace(trace(REFUND_RUN), contract, hash);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.contract.hash).toBe(hash);
  });

  it("flags missing and forbidden tools", () => {
    const contract = parseContract(
      '{"rules":{"must_call":["escalate"],"must_not_call":["refund_payment"]}}',
    );
    const result = checkTrace(trace(REFUND_RUN), contract, hash);
    expect(result.passed).toBe(false);
    const rules = result.violations.map((v) => v.rule).sort();
    expect(rules).toEqual(["must_call", "must_not_call"]);
  });

  it("flags order violations", () => {
    const contract = parseContract('{"rules":{"call_order":[["verify_user","refund_payment"]]}}');
    const result = checkTrace(trace(REFUND_RUN), contract, hash);
    expect(result.violations[0].message).toContain("refund_payment ran before verify_user");
  });

  it("flags budget violations", () => {
    const contract = parseContract('{"rules":{"max_cost_usd":0.001,"max_latency_ms":100,"max_tool_calls":1}}');
    const result = checkTrace(trace(REFUND_RUN), contract, hash);
    expect(result.violations).toHaveLength(3);
  });

  it("flags output content violations", () => {
    const contract = parseContract(
      '{"rules":{"output_includes":["escalated"],"output_excludes":["refund"]}}',
    );
    const result = checkTrace(trace(REFUND_RUN), contract, hash);
    expect(result.violations).toHaveLength(2);
  });

  it("flags runs named in the contract but missing from the trace", () => {
    const contract = parseContract('{"runs":{"cancel":{"must_call":["cancel_subscription"]}}}');
    const result = checkTrace(trace(REFUND_RUN), contract, hash);
    expect(result.violations[0].rule).toBe("run_missing");
  });

  it("merges per-run rules over shared rules", () => {
    const contract = parseContract(
      '{"rules":{"max_tool_calls":10},"runs":{"refund":{"must_call":["refund_payment"]}}}',
    );
    const result = checkTrace(trace(REFUND_RUN), contract, hash);
    expect(result.passed).toBe(true);
    expect(result.rulesChecked).toBe(2);
  });

  it("reports a violation rate across samples", () => {
    const sampled = trace([
      { type: "tool_call", run: "refund#1", name: "lookup_order" },
      { type: "tool_call", run: "refund#1", name: "refund_payment" },
      { type: "run_end", run: "refund#1", status: "ok" },
      { type: "tool_call", run: "refund#2", name: "lookup_order" },
      { type: "run_end", run: "refund#2", status: "ok" },
      { type: "tool_call", run: "refund#3", name: "lookup_order" },
      { type: "run_end", run: "refund#3", status: "ok" },
    ]);
    const contract = parseContract('{"rules":{"must_call":["refund_payment"]}}');
    const result = checkTrace(sampled, contract, "h");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rate).toBe("2/3");
  });

  it("flags tool errors when no_tool_errors is set", () => {
    const errored = trace([
      { type: "tool_call", run: "r", name: "lookup_order", error: "timeout" },
      { type: "run_end", run: "r", status: "ok" },
    ]);
    const contract = parseContract('{"rules":{"no_tool_errors":true}}');
    const result = checkTrace(errored, contract, "h");
    expect(result.violations[0].message).toContain("timeout");
  });
});

describe("generateContract", () => {
  it("learns required tools, budgets, and status from samples", () => {
    const sampled = trace([
      { type: "llm_call", run: "refund#1", model: "m", latency_ms: 1000, cost_usd: 0.01 },
      { type: "tool_call", run: "refund#1", name: "lookup_order" },
      { type: "tool_call", run: "refund#1", name: "refund_payment" },
      { type: "run_end", run: "refund#1", status: "ok" },
      { type: "llm_call", run: "refund#2", model: "m", latency_ms: 2000, cost_usd: 0.02 },
      { type: "tool_call", run: "refund#2", name: "lookup_order" },
      { type: "run_end", run: "refund#2", status: "ok" },
    ]);
    const contract = generateContract(sampled, "base.jsonl");
    const rules = contract.runs!.refund;
    // only tools present in every sample become required
    expect(rules.must_call).toEqual(["lookup_order"]);
    expect(rules.max_cost_usd).toBeCloseTo(0.03);
    expect(rules.max_latency_ms).toBe(3000);
    expect(rules.require_status).toBe("ok");
    expect(rules.no_tool_errors).toBe(true);
  });

  it("round-trips: a generated contract holds against its own trace", () => {
    const runs = trace(REFUND_RUN);
    const contract = generateContract(runs, "x.jsonl");
    const result = checkTrace(runs, contract, "h");
    expect(result.passed).toBe(true);
  });
});

describe("rendering", () => {
  it("renders terminal and markdown reports", () => {
    const contract = parseContract('{"name":"guard","rules":{"must_call":["escalate"]}}');
    const result = checkTrace(trace(REFUND_RUN), contract, "deadbeef1234");
    const term = renderCheckTerminal(result);
    expect(term).toContain("VIOLATED");
    expect(term).toContain("deadbeef1234");
    const md = renderCheckMarkdown(result);
    expect(md).toContain("## whatbroke contract check");
    expect(md).toContain("**VIOLATED** must_call");
  });

  it("renders a passing report", () => {
    const contract = parseContract('{"rules":{"must_call":["lookup_order"]}}');
    const result = checkTrace(trace(REFUND_RUN), contract, "h");
    expect(renderCheckTerminal(result)).toContain("contract holds");
    expect(renderCheckMarkdown(result)).toContain("Contract holds");
  });
});

describe("contractHash", () => {
  it("is stable and short", () => {
    expect(contractHash("x")).toBe(contractHash("x"));
    expect(contractHash("x")).toHaveLength(12);
    expect(contractHash("x")).not.toBe(contractHash("y"));
  });
});

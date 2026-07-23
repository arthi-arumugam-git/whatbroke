import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectFormat, importTrace } from "../src/import.js";
import type { LlmCallEvent, OutputEvent, RunEndEvent, ToolCallEvent, TraceEvent } from "../src/types.js";

function attr(key: string, value: Record<string, unknown>) {
  return { key, value };
}

function otlp(spans: unknown[]): string {
  return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
}

const CHAT_SPAN = {
  traceId: "5B8EFFF798038103D269B633813FC60C",
  spanId: "EEE19B7EC3C1B174",
  name: "chat gpt-4",
  startTimeUnixNano: "1544712660000000000",
  endTimeUnixNano: "1544712661000000000",
  attributes: [
    attr("gen_ai.operation.name", { stringValue: "chat" }),
    attr("gen_ai.provider.name", { stringValue: "openai" }),
    attr("gen_ai.request.model", { stringValue: "gpt-4" }),
    attr("gen_ai.response.model", { stringValue: "gpt-4-0613" }),
    attr("gen_ai.usage.input_tokens", { intValue: "100" }),
    attr("gen_ai.usage.output_tokens", { intValue: "180" }),
    attr("gen_ai.response.finish_reasons", { arrayValue: { values: [{ stringValue: "stop" }] } }),
  ],
};

const TOOL_SPAN = {
  traceId: "5B8EFFF798038103D269B633813FC60C",
  spanId: "AAA19B7EC3C1B175",
  parentSpanId: "EEE19B7EC3C1B174",
  name: "execute_tool get_weather",
  startTimeUnixNano: "1544712660200000000",
  endTimeUnixNano: "1544712660450000000",
  attributes: [
    attr("gen_ai.operation.name", { stringValue: "execute_tool" }),
    attr("gen_ai.tool.name", { stringValue: "get_weather" }),
    attr("gen_ai.tool.call.arguments", { stringValue: '{"location":"Paris"}' }),
  ],
};

function eventsOf(text: string, format?: "otel" | "langfuse" | "langsmith", run?: string): TraceEvent[] {
  return importTrace(text, format, { run }).events;
}

function only<T extends TraceEvent>(events: TraceEvent[], type: T["type"]): T[] {
  return events.filter((e) => e.type === type) as T[];
}

describe("detectFormat", () => {
  it("detects OTLP JSON by resourceSpans", () => {
    expect(detectFormat(otlp([CHAT_SPAN]))).toBe("otel");
  });

  it("detects langsmith runs by run_type and dotted_order", () => {
    const text = JSON.stringify([
      { id: "a", trace_id: "a", dotted_order: "1", name: "agent", run_type: "chain", inputs: {}, outputs: {} },
    ]);
    expect(detectFormat(text)).toBe("langsmith");
  });

  it("detects langfuse export rows by observation fields", () => {
    const text = JSON.stringify([
      { id: "ob_1", trace_id: "tr_1", type: "GENERATION", start_time: "2026-07-20T10:00:00.000Z" },
    ]);
    expect(detectFormat(text)).toBe("langfuse");
  });

  it("throws a one-line error listing the supported formats when detection fails", () => {
    expect(() => importTrace('{"hello":"world"}')).toThrowError(/otel.*langfuse.*langsmith/);
  });

  it("throws on input that is not JSON at all", () => {
    expect(() => importTrace("definitely not json")).toThrowError();
  });
});

describe("otel import", () => {
  it("maps an inference span to llm_call with model, tokens, stop_reason, latency", () => {
    const events = eventsOf(otlp([CHAT_SPAN, TOOL_SPAN]));
    const [llm] = only<LlmCallEvent>(events, "llm_call");
    expect(llm.model).toBe("gpt-4-0613");
    expect(llm.tokens).toEqual({ input: 100, output: 180 });
    expect(llm.stop_reason).toBe("stop");
    expect(llm.latency_ms).toBe(1000);
  });

  it("maps an execute_tool span to tool_call with parsed args and latency", () => {
    const events = eventsOf(otlp([CHAT_SPAN, TOOL_SPAN]));
    const [tool] = only<ToolCallEvent>(events, "tool_call");
    expect(tool.name).toBe("get_weather");
    expect(tool.args).toEqual({ location: "Paris" });
    expect(tool.latency_ms).toBe(250);
  });

  it("emits run_start first and run_end ok last, run named after the root span", () => {
    const events = eventsOf(otlp([CHAT_SPAN, TOOL_SPAN]));
    expect(events[0].type).toBe("run_start");
    expect(events[0].run).toBe("chat gpt-4");
    const last = events[events.length - 1] as RunEndEvent;
    expect(last.type).toBe("run_end");
    expect(last.status).toBe("ok");
  });

  it("sorts spans by startTimeUnixNano, not file order", () => {
    const events = eventsOf(otlp([TOOL_SPAN, CHAT_SPAN]));
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf("llm_call")).toBeLessThan(kinds.indexOf("tool_call"));
  });

  it("accepts legacy gen_ai.system and prompt/completion token names", () => {
    const legacy = {
      ...CHAT_SPAN,
      attributes: [
        attr("gen_ai.operation.name", { stringValue: "chat" }),
        attr("gen_ai.system", { stringValue: "anthropic" }),
        attr("gen_ai.request.model", { stringValue: "claude-sonnet-4-5" }),
        attr("gen_ai.usage.prompt_tokens", { intValue: 64 }),
        attr("gen_ai.usage.completion_tokens", { intValue: "32" }),
      ],
    };
    const [llm] = only<LlmCallEvent>(eventsOf(otlp([legacy])), "llm_call");
    expect(llm.model).toBe("claude-sonnet-4-5");
    expect(llm.tokens).toEqual({ input: 64, output: 32 });
  });

  it("omits args and warns when gen_ai.tool.call.arguments is absent", () => {
    const bare = {
      ...TOOL_SPAN,
      attributes: [
        attr("gen_ai.operation.name", { stringValue: "execute_tool" }),
        attr("gen_ai.tool.name", { stringValue: "get_weather" }),
      ],
    };
    const result = importTrace(otlp([CHAT_SPAN, bare]), "otel");
    const [tool] = only<ToolCallEvent>(result.events, "tool_call");
    expect(tool.args).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(/tool arguments were not captured/);
  });

  it("emits output from gen_ai.output.messages on the last inference span", () => {
    const withOutput = {
      ...CHAT_SPAN,
      attributes: [
        ...CHAT_SPAN.attributes,
        attr("gen_ai.output.messages", {
          stringValue: JSON.stringify([
            { role: "assistant", parts: [{ type: "text", content: "Rainy, 14C." }], finish_reason: "stop" },
          ]),
        }),
      ],
    };
    const [out] = only<OutputEvent>(eventsOf(otlp([withOutput])), "output");
    expect(out.content).toBe("Rainy, 14C.");
  });

  it("marks the run as error when a span has error status", () => {
    const failing = {
      ...TOOL_SPAN,
      status: { code: 2, message: "boom" },
    };
    const events = eventsOf(otlp([CHAT_SPAN, failing]));
    const last = events[events.length - 1] as RunEndEvent;
    expect(last.status).toBe("error");
    expect(last.error).toBe("boom");
    const [tool] = only<ToolCallEvent>(events, "tool_call");
    expect(tool.error).toBe("boom");
  });

  it("suffixes runs with #1 #2 when two traces share a name", () => {
    const second = {
      ...CHAT_SPAN,
      traceId: "6C8EFFF798038103D269B633813FC60D",
      spanId: "FFF19B7EC3C1B176",
    };
    const events = eventsOf(otlp([CHAT_SPAN, second]));
    const starts = only<TraceEvent>(events, "run_start").map((e) => e.run);
    expect(starts).toEqual(["chat gpt-4#1", "chat gpt-4#2"]);
  });

  it("names runs from --run", () => {
    const events = eventsOf(otlp([CHAT_SPAN, TOOL_SPAN]), "otel", "refund-flow");
    expect(events[0].run).toBe("refund-flow");
  });

  it("reads JSONL with one resourceSpans object per line", () => {
    const second = { ...CHAT_SPAN, traceId: "6C8EFFF798038103D269B633813FC60D" };
    const text = `${otlp([CHAT_SPAN])}\n${otlp([second])}`;
    const result = importTrace(text, "otel", { run: "flow" });
    expect(result.runs).toBe(2);
    expect(result.llmCalls).toBe(2);
  });

  it("counts events and reports cost as unavailable in the summary", () => {
    const result = importTrace(otlp([CHAT_SPAN, TOOL_SPAN]), "otel");
    expect(result.runs).toBe(1);
    expect(result.llmCalls).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(result.missing).toContain("cost");
  });
});

const LANGFUSE_GENERATION = {
  id: "ob_9f2",
  trace_id: "tr_41c",
  type: "GENERATION",
  name: "chat",
  start_time: "2026-07-20T10:00:00.000Z",
  end_time: "2026-07-20T10:00:01.250Z",
  provided_model_name: "claude-sonnet-4-5",
  input: [{ role: "user", content: "Weather in Paris?" }],
  output: { role: "assistant", content: "Rainy, 14C." },
  usage_details: { input: 100, output: 42, total: 142 },
  cost_details: { input: 0.0003, output: 0.00063 },
  total_cost: "0.00093",
  latency: 1.25,
  level: "DEFAULT",
  status_message: null,
  metadata: {},
};

describe("langfuse import", () => {
  it("maps a GENERATION row to llm_call with model, tokens, string-decimal cost", () => {
    const result = importTrace(JSON.stringify([LANGFUSE_GENERATION]), "langfuse");
    const [llm] = only<LlmCallEvent>(result.events, "llm_call");
    expect(llm.model).toBe("claude-sonnet-4-5");
    expect(llm.tokens).toEqual({ input: 100, output: 42 });
    expect(llm.cost_usd).toBe(0.00093);
  });

  it("recomputes latency from timestamps instead of trusting the latency field", () => {
    const [llm] = only<LlmCallEvent>(
      importTrace(JSON.stringify([LANGFUSE_GENERATION]), "langfuse").events,
      "llm_call",
    );
    expect(llm.latency_ms).toBe(1250);
  });

  it("maps a TOOL observation to tool_call with args from input", () => {
    const tool = {
      id: "ob_aa1",
      trace_id: "tr_41c",
      parent_observation_id: "ob_9f2",
      type: "TOOL",
      name: "get_weather",
      start_time: "2026-07-20T10:00:00.400Z",
      end_time: "2026-07-20T10:00:00.900Z",
      input: { location: "Paris" },
      output: { temp_c: 14 },
      level: "DEFAULT",
    };
    const result = importTrace(JSON.stringify([LANGFUSE_GENERATION, tool]), "langfuse");
    const [call] = only<ToolCallEvent>(result.events, "tool_call");
    expect(call.name).toBe("get_weather");
    expect(call.args).toEqual({ location: "Paris" });
    expect(call.latency_ms).toBe(500);
  });

  it("treats nested SPAN observations as tool calls but not the root span", () => {
    const root = {
      id: "ob_root",
      trace_id: "tr_41c",
      type: "SPAN",
      name: "my-chain",
      start_time: "2026-07-20T09:59:59.000Z",
      end_time: "2026-07-20T10:00:02.000Z",
      level: "DEFAULT",
    };
    const nested = {
      id: "ob_bb2",
      trace_id: "tr_41c",
      parent_observation_id: "ob_root",
      type: "SPAN",
      name: "search_docs",
      start_time: "2026-07-20T10:00:00.500Z",
      end_time: "2026-07-20T10:00:00.700Z",
      input: { query: "weather" },
      level: "DEFAULT",
    };
    const result = importTrace(JSON.stringify([root, LANGFUSE_GENERATION, nested]), "langfuse");
    const calls = only<ToolCallEvent>(result.events, "tool_call");
    expect(calls.map((c) => c.name)).toEqual(["search_docs"]);
  });

  it("emits output from the last observation output and ends the run ok", () => {
    const events = importTrace(JSON.stringify([LANGFUSE_GENERATION]), "langfuse").events;
    const [out] = only<OutputEvent>(events, "output");
    expect(out.content).toContain("Rainy, 14C.");
    const last = events[events.length - 1] as RunEndEvent;
    expect(last.status).toBe("ok");
  });

  it("marks the run as error on an ERROR level observation", () => {
    const failing = {
      ...LANGFUSE_GENERATION,
      id: "ob_err",
      level: "ERROR",
      status_message: "rate limited",
    };
    const events = importTrace(JSON.stringify([failing]), "langfuse").events;
    const last = events[events.length - 1] as RunEndEvent;
    expect(last.status).toBe("error");
    expect(last.error).toBe("rate limited");
    const [llm] = only<LlmCallEvent>(events, "llm_call");
    expect(llm.error).toBe("rate limited");
  });

  it("accepts camelCase API fields and calculatedTotalCost", () => {
    const row = {
      id: "ob_cc3",
      traceId: "tr_88d",
      type: "GENERATION",
      name: "chat",
      startTime: "2026-07-20T10:00:00.000Z",
      endTime: "2026-07-20T10:00:00.800Z",
      model: "gpt-4o-mini",
      usage: { promptTokens: 10, completionTokens: 5 },
      calculatedTotalCost: "0.00012",
    };
    const [llm] = only<LlmCallEvent>(importTrace(JSON.stringify([row]), "langfuse").events, "llm_call");
    expect(llm.model).toBe("gpt-4o-mini");
    expect(llm.tokens).toEqual({ input: 10, output: 5 });
    expect(llm.cost_usd).toBe(0.00012);
    expect(llm.latency_ms).toBe(800);
  });

  it("reads JSONL rows and groups them by trace id into runs", () => {
    const other = { ...LANGFUSE_GENERATION, id: "ob_other", trace_id: "tr_99z" };
    const text = `${JSON.stringify(LANGFUSE_GENERATION)}\n${JSON.stringify(other)}`;
    const result = importTrace(text, "langfuse", { run: "flow" });
    expect(result.runs).toBe(2);
    const starts = result.events.filter((e) => e.type === "run_start").map((e) => e.run);
    expect(starts).toEqual(["flow#1", "flow#2"]);
  });
});

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

const OTEL_BEFORE = "test/fixtures/otel-before.json";
const OTEL_AFTER = "test/fixtures/otel-after.json";

describe("cli import", () => {
  it("converts an OTLP export and prints a summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "whatbroke-import-"));
    const out = join(dir, "before.jsonl");
    const result = cli(["import", OTEL_BEFORE, "-o", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("imported 1 run, 1 llm call, 1 tool call");
    const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "run_start", run: "refund-flow" });
    expect(lines.map((l) => l.type)).toEqual(["run_start", "llm_call", "tool_call", "output", "run_end"]);
  });

  it("exits 2 with the supported formats when detection fails", () => {
    const result = cli(["import", "package.json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("otel");
    expect(result.stderr).toContain("langfuse");
    expect(result.stderr).toContain("langsmith");
  });

  it("exits 2 on a missing input file", () => {
    const result = cli(["import", "nope.json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("could not read input file");
  });

  it("end to end: import two OTLP exports, diff them, see the changed arg", () => {
    const dir = mkdtempSync(join(tmpdir(), "whatbroke-e2e-"));
    const before = join(dir, "before.jsonl");
    const after = join(dir, "after.jsonl");
    expect(cli(["import", OTEL_BEFORE, "-o", before]).code).toBe(0);
    expect(cli(["import", OTEL_AFTER, "-o", after]).code).toBe(0);
    const result = cli(["diff", before, after]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("lookup_order called with different args (order_id)");
  });
});

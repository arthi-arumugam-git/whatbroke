import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectFormat, importTrace, promptText } from "../src/import.js";
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

  it("reports the resolved format and passes span ids through in source", () => {
    const result = importTrace(otlp([CHAT_SPAN, TOOL_SPAN]));
    expect(result.format).toBe("otel");
    expect(result.schema).toBeUndefined();
    const [llm] = only<LlmCallEvent>(result.events, "llm_call");
    expect(llm.source).toEqual({
      trace_id: "5B8EFFF798038103D269B633813FC60C",
      span_id: "EEE19B7EC3C1B174",
    });
    const [tool] = only<ToolCallEvent>(result.events, "tool_call");
    expect(tool.source).toEqual({
      trace_id: "5B8EFFF798038103D269B633813FC60C",
      span_id: "AAA19B7EC3C1B175",
      parent_span_id: "EEE19B7EC3C1B174",
    });
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

  it("reports the resolved format and snake_case schema", () => {
    const result = importTrace(JSON.stringify([LANGFUSE_GENERATION]), "langfuse");
    expect(result.format).toBe("langfuse");
    expect(result.schema).toBe("export rows (snake_case)");
  });

  it("reports the camelCase schema for API objects", () => {
    const row = {
      id: "ob_cc3",
      traceId: "tr_88d",
      type: "GENERATION",
      name: "chat",
      startTime: "2026-07-20T10:00:00.000Z",
      model: "gpt-4o-mini",
    };
    const result = importTrace(JSON.stringify([row]), "langfuse");
    expect(result.schema).toBe("API objects (camelCase)");
  });

  it("passes trace and observation ids through in source", () => {
    const tool = {
      id: "ob_aa1",
      trace_id: "tr_41c",
      parent_observation_id: "ob_9f2",
      type: "TOOL",
      name: "get_weather",
      start_time: "2026-07-20T10:00:00.400Z",
      input: { location: "Paris" },
      level: "DEFAULT",
    };
    const result = importTrace(JSON.stringify([LANGFUSE_GENERATION, tool]), "langfuse");
    const [llm] = only<LlmCallEvent>(result.events, "llm_call");
    expect(llm.source).toEqual({ trace_id: "tr_41c", observation_id: "ob_9f2" });
    const [call] = only<ToolCallEvent>(result.events, "tool_call");
    expect(call.source).toEqual({
      trace_id: "tr_41c",
      observation_id: "ob_aa1",
      parent_observation_id: "ob_9f2",
    });
  });
});

const NESTED_FIXTURE = readFileSync("test/fixtures/langfuse-nested.json", "utf8");

describe("langfuse nested fixture", () => {
  it("imports a parent SPAN with child GENERATION and TOOL as one run", () => {
    const result = importTrace(NESTED_FIXTURE, "langfuse");
    expect(result.runs).toBe(1);
    expect(result.llmCalls).toBe(1);
    expect(result.toolCalls).toBe(2);
    expect(result.events[0]).toMatchObject({ type: "run_start", run: "nested-agent" });
  });

  it("keeps parallel children that share a start_time", () => {
    const result = importTrace(NESTED_FIXTURE, "langfuse");
    const calls = only<ToolCallEvent>(result.events, "tool_call");
    expect(calls.map((c) => c.name)).toEqual(["get_weather", "get_news"]);
  });

  it("dedupes duplicate export records by row id with a warning", () => {
    const result = importTrace(NESTED_FIXTURE, "langfuse");
    expect(result.toolCalls).toBe(2);
    expect(result.warnings).toContain("1 duplicate row skipped");
  });

  it("tolerates missing optional fields on an observation", () => {
    const result = importTrace(NESTED_FIXTURE, "langfuse");
    const news = only<ToolCallEvent>(result.events, "tool_call").find((c) => c.name === "get_news")!;
    expect(news.args).toBeUndefined();
    expect(news.result).toBeUndefined();
    expect(news.latency_ms).toBeUndefined();
  });

  it("captures a TOOL observation output as the call result", () => {
    const result = importTrace(NESTED_FIXTURE, "langfuse");
    const weather = only<ToolCallEvent>(result.events, "tool_call").find((c) => c.name === "get_weather")!;
    expect(weather.result).toBe('{"temp_c":14}');
  });

  it("passes tags, environment, release, version, session_id into run_start meta", () => {
    const result = importTrace(NESTED_FIXTURE, "langfuse");
    const start = result.events[0] as { meta?: Record<string, unknown> };
    expect(start.meta).toEqual({
      tags: ["prod"],
      environment: "production",
      release: "v1.2.0",
      version: "3",
      session_id: "sess_77",
    });
  });

  it("puts source ids on the output event", () => {
    const result = importTrace(NESTED_FIXTURE, "langfuse");
    const [out] = only<OutputEvent>(result.events, "output");
    expect(out.content).toBe("All done.");
    expect(out.source).toEqual({ trace_id: "tr_n1", observation_id: "ob_root" });
  });
});

const LS_ROOT = {
  id: "a1b2c3d4-0000-0000-0000-000000000000",
  trace_id: "a1b2c3d4-0000-0000-0000-000000000000",
  parent_run_id: null,
  dotted_order: "20260720T100000000001Za1b2c3d4",
  name: "refund-agent",
  run_type: "chain",
  start_time: "2026-07-20T10:00:00.000Z",
  end_time: "2026-07-20T10:00:02.000Z",
  inputs: { question: "Weather in Paris?" },
  outputs: { output: "Rainy, 14C." },
  error: null,
  session_id: "my-project",
};

const LS_LLM = {
  id: "c9c84f10-0000-0000-0000-000000000000",
  trace_id: "a1b2c3d4-0000-0000-0000-000000000000",
  parent_run_id: "a1b2c3d4-0000-0000-0000-000000000000",
  dotted_order: "20260720T100000000001Za1b2c3d4.20260720T100000100002Zc9c84f10",
  name: "ChatOpenAI",
  run_type: "llm",
  start_time: "2026-07-20T10:00:00.100Z",
  end_time: "2026-07-20T10:00:01.300Z",
  inputs: { messages: [["user", "Weather in Paris?"]] },
  outputs: {
    generations: [[{ text: "Rainy, 14C.", generation_info: { finish_reason: "stop" } }]],
    llm_output: { token_usage: { prompt_tokens: 100, completion_tokens: 42 }, model_name: "gpt-4o-mini" },
  },
  extra: { invocation_params: { model: "gpt-4o-mini", temperature: 0 } },
  prompt_tokens: 100,
  completion_tokens: 42,
  total_tokens: 142,
  total_cost: 0.000063,
  error: null,
  session_id: "my-project",
};

const LS_TOOL = {
  id: "d0d95e21-0000-0000-0000-000000000000",
  trace_id: "a1b2c3d4-0000-0000-0000-000000000000",
  parent_run_id: "a1b2c3d4-0000-0000-0000-000000000000",
  dotted_order: "20260720T100000000001Za1b2c3d4.20260720T100000050003Zd0d95e21",
  name: "get_weather",
  run_type: "tool",
  start_time: "2026-07-20T10:00:00.050Z",
  end_time: "2026-07-20T10:00:00.090Z",
  inputs: { input: "Paris" },
  outputs: { output: "14C, rain" },
  error: null,
  session_id: "my-project",
};

describe("langsmith import", () => {
  it("maps an llm run to llm_call with model, tokens, cost, stop_reason", () => {
    const result = importTrace(JSON.stringify([LS_ROOT, LS_LLM]), "langsmith");
    const [llm] = only<LlmCallEvent>(result.events, "llm_call");
    expect(llm.model).toBe("gpt-4o-mini");
    expect(llm.tokens).toEqual({ input: 100, output: 42 });
    expect(llm.cost_usd).toBe(0.000063);
    expect(llm.stop_reason).toBe("stop");
    expect(llm.latency_ms).toBe(1200);
  });

  it("maps a tool run to tool_call with inputs as args", () => {
    const result = importTrace(JSON.stringify([LS_ROOT, LS_LLM, LS_TOOL]), "langsmith");
    const [tool] = only<ToolCallEvent>(result.events, "tool_call");
    expect(tool.name).toBe("get_weather");
    expect(tool.args).toEqual({ input: "Paris" });
  });

  it("orders events by dotted_order and names the run after the root", () => {
    const result = importTrace(JSON.stringify([LS_LLM, LS_ROOT, LS_TOOL]), "langsmith");
    expect(result.events[0]).toMatchObject({ type: "run_start", run: "refund-agent" });
    const kinds = result.events.map((e) => e.type);
    // the tool's dotted_order sorts before the llm's even though it starts later in the array
    expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("llm_call"));
  });

  it("emits the root run outputs.output as the output event", () => {
    const result = importTrace(JSON.stringify([LS_ROOT, LS_LLM]), "langsmith");
    const [out] = only<OutputEvent>(result.events, "output");
    expect(out.content).toBe("Rainy, 14C.");
  });

  it("marks the run as error when the root recorded one", () => {
    const failing = { ...LS_ROOT, error: "Tool timeout" };
    const events = importTrace(JSON.stringify([failing, LS_LLM]), "langsmith").events;
    const last = events[events.length - 1] as RunEndEvent;
    expect(last.status).toBe("error");
    expect(last.error).toBe("Tool timeout");
  });

  it("groups runs by trace_id and coerces string-decimal cost", () => {
    const otherTrace = "b2c3d4e5-0000-0000-0000-000000000000";
    const root2 = { ...LS_ROOT, id: otherTrace, trace_id: otherTrace, dotted_order: "20260720T110000000001Zb2c3d4e5" };
    const llm2 = {
      ...LS_LLM,
      id: "e1e06f32-0000-0000-0000-000000000000",
      trace_id: otherTrace,
      parent_run_id: otherTrace,
      dotted_order: "20260720T110000000001Zb2c3d4e5.20260720T110000100002Ze1e06f32",
      total_cost: "0.000063",
    };
    const result = importTrace(JSON.stringify([LS_ROOT, LS_LLM, root2, llm2]), "langsmith");
    expect(result.runs).toBe(2);
    const llms = only<LlmCallEvent>(result.events, "llm_call");
    expect(llms[1].cost_usd).toBe(0.000063);
  });

  it("captures tool run outputs as the call result", () => {
    const result = importTrace(JSON.stringify([LS_ROOT, LS_TOOL]), "langsmith");
    const [tool] = only<ToolCallEvent>(result.events, "tool_call");
    expect(tool.result).toBe("14C, rain");
  });

  it("reports the resolved format and passes run ids through in source", () => {
    const result = importTrace(JSON.stringify([LS_ROOT, LS_LLM, LS_TOOL]), "langsmith");
    expect(result.format).toBe("langsmith");
    const [tool] = only<ToolCallEvent>(result.events, "tool_call");
    expect(tool.source).toEqual({
      trace_id: "a1b2c3d4-0000-0000-0000-000000000000",
      run_id: "d0d95e21-0000-0000-0000-000000000000",
      parent_run_id: "a1b2c3d4-0000-0000-0000-000000000000",
    });
    const [out] = only<OutputEvent>(result.events, "output");
    expect(out.source).toEqual({
      trace_id: "a1b2c3d4-0000-0000-0000-000000000000",
      run_id: "a1b2c3d4-0000-0000-0000-000000000000",
    });
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
    expect(result.stdout).toContain("detected format: otel");
    expect(result.stdout).toContain("imported 1 run, 1 llm call, 1 tool call");
    const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "run_start", run: "refund-flow" });
    expect(lines.map((l) => l.type)).toEqual(["run_start", "llm_call", "tool_call", "output", "run_end"]);
  });

  it("prints the langfuse schema in the detected format line", () => {
    const dir = mkdtempSync(join(tmpdir(), "whatbroke-import-"));
    const out = join(dir, "nested.jsonl");
    const result = cli(["import", "test/fixtures/langfuse-nested.json", "-o", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("detected format: langfuse export rows (snake_case)");
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

// The prompt is present in all three export formats and was being read only for its token
// count. These pin the capture, since a prompt that never reaches the trace can never be diffed.
describe("prompt capture", () => {
  it("captures the prompt from a langfuse GENERATION input", () => {
    const [llm] = only<LlmCallEvent>(
      importTrace(JSON.stringify([LANGFUSE_GENERATION]), "langfuse").events,
      "llm_call",
    );
    expect(llm.prompt).toBe("user: Weather in Paris?");
  });

  it("keeps the role, so moving an instruction between roles reads as a change", () => {
    const asSystem = { ...LANGFUSE_GENERATION, input: [{ role: "system", content: "Weather in Paris?" }] };
    const [llm] = only<LlmCallEvent>(
      importTrace(JSON.stringify([asSystem]), "langfuse").events,
      "llm_call",
    );
    expect(llm.prompt).toBe("system: Weather in Paris?");
  });

  it("joins a multi-message langfuse prompt in order", () => {
    const row = {
      ...LANGFUSE_GENERATION,
      input: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Weather in Paris?" },
      ],
    };
    const [llm] = only<LlmCallEvent>(importTrace(JSON.stringify([row]), "langfuse").events, "llm_call");
    expect(llm.prompt).toBe("system: Be terse.\nuser: Weather in Paris?");
  });

  it("unwraps langfuse input given as a JSON string", () => {
    const row = { ...LANGFUSE_GENERATION, input: JSON.stringify([{ role: "user", content: "Hi" }]) };
    const [llm] = only<LlmCallEvent>(importTrace(JSON.stringify([row]), "langfuse").events, "llm_call");
    expect(llm.prompt).toBe("user: Hi");
  });

  it("flattens Anthropic-style content blocks", () => {
    const row = {
      ...LANGFUSE_GENERATION,
      input: [{ role: "user", content: [{ type: "text", text: "Weather in Paris?" }] }],
    };
    const [llm] = only<LlmCallEvent>(importTrace(JSON.stringify([row]), "langfuse").events, "llm_call");
    expect(llm.prompt).toBe("user: Weather in Paris?");
  });

  it("captures the prompt from a langsmith llm run's message tuples", () => {
    const [llm] = only<LlmCallEvent>(
      importTrace(JSON.stringify([LS_ROOT, LS_LLM]), "langsmith").events,
      "llm_call",
    );
    expect(llm.prompt).toBe("user: Weather in Paris?");
  });

  it("captures the prompt from OTLP gen_ai.input.messages", () => {
    const span = {
      ...CHAT_SPAN,
      attributes: [
        ...CHAT_SPAN.attributes,
        attr("gen_ai.input.messages", {
          stringValue: JSON.stringify([
            { role: "user", parts: [{ type: "text", content: "Weather in Paris?" }] },
          ]),
        }),
      ],
    };
    const [llm] = only<LlmCallEvent>(eventsOf(otlp([span])), "llm_call");
    expect(llm.prompt).toBe("user: Weather in Paris?");
  });

  it("leaves prompt undefined when the source never captured one", () => {
    const [llm] = only<LlmCallEvent>(eventsOf(otlp([CHAT_SPAN])), "llm_call");
    expect(llm.prompt).toBeUndefined();
  });

  // Without this the report reads as "the prompt did not change" when it was simply never
  // recorded. The CLI prints this list as "not in the source: ...".
  it("reports prompts as missing when no llm call captured one", () => {
    const result = importTrace(otlp([CHAT_SPAN]), "otel");
    expect(result.missing).toContain("prompts");
  });

  // The diff will not say a call was added or dropped when one side carried none, so the
  // import has to be the place that says the source had none.
  it("reports llm calls as missing when the source carried none", () => {
    const result = importTrace(otlp([TOOL_SPAN]), "otel");
    expect(result.llmCalls).toBe(0);
    expect(result.missing).toContain("llm calls");
  });

  it("does not report llm calls as missing when the source carried one", () => {
    expect(importTrace(otlp([CHAT_SPAN]), "otel").missing).not.toContain("llm calls");
  });

  it("does not report prompts as missing once one is captured", () => {
    const result = importTrace(JSON.stringify([LANGFUSE_GENERATION]), "langfuse");
    expect(result.missing).not.toContain("prompts");
  });

  // A blank input is a source that did not record the prompt, not a run whose prompt was
  // empty. Storing "" would make the next diff report a prompt change against every real run.
  it("treats a blank input as no prompt at all", () => {
    for (const input of ["", "   ", [], {}, null]) {
      const row = { ...LANGFUSE_GENERATION, input };
      const [llm] = only<LlmCallEvent>(importTrace(JSON.stringify([row]), "langfuse").events, "llm_call");
      expect(llm.prompt, `input ${JSON.stringify(input)}`).toBeUndefined();
    }
  });

  it("reports prompts as missing when every input was blank", () => {
    const row = { ...LANGFUSE_GENERATION, input: [] };
    expect(importTrace(JSON.stringify([row]), "langfuse").missing).toContain("prompts");
  });

  // The Python recorder normalises prompts too, from its own copy of this logic. Both sides
  // run the same fixture: a baseline recorded in one language and a rerun recorded in the
  // other must not diff as a prompt change that never happened.
  describe("shared normalisation fixture", () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures", "prompt-normalisation.json"), "utf8"),
    ) as { cases: Array<{ name: string; input: unknown; expected: string | null }> };

    it("has cases to run", () => {
      // a fixture that failed to load would otherwise make this whole block pass for nothing
      expect(fixture.cases.length).toBeGreaterThan(0);
    });

    for (const testCase of fixture.cases) {
      it(testCase.name, () => {
        expect(promptText(testCase.input) ?? null).toBe(testCase.expected);
      });
    }
  });

  it("keeps unicode in the prompt byte for byte", () => {
    const text = "Répondez en français. 🙂";
    const row = { ...LANGFUSE_GENERATION, input: [{ role: "user", content: text }] };
    const [llm] = only<LlmCallEvent>(importTrace(JSON.stringify([row]), "langfuse").events, "llm_call");
    expect(llm.prompt).toBe(`user: ${text}`);
  });
});

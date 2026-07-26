import type {
  LlmCallEvent,
  OutputEvent,
  RunEndEvent,
  RunStartEvent,
  ToolCallEvent,
  TraceEvent,
} from "./types.js";

export type ImportFormat = "otel" | "langfuse" | "langsmith";

export interface ImportOptions {
  /** base run name; overrides names derived from the source */
  run?: string;
}

export interface ImportResult {
  events: TraceEvent[];
  runs: number;
  llmCalls: number;
  toolCalls: number;
  format: ImportFormat;
  /** human note on which shape of the format matched, e.g. "export rows (snake_case)" */
  schema?: string;
  /** optional trace fields the source never provided: "cost", "tool args", ... */
  missing: string[];
  /** notices worth showing the user, printed to stderr by the cli */
  warnings: string[];
}

const FORMATS_HINT =
  "could not detect trace format; supported: otel (OTLP JSON spans), langfuse (export rows), langsmith (run objects). pass --format to pick one";

/** parse a file that is either one JSON value, a JSON array, or JSONL */
function readValues(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("input file is empty");
  try {
    const value = JSON.parse(trimmed);
    return Array.isArray(value) ? value : [value];
  } catch {
    // fall through to JSONL
  }
  const values: unknown[] = [];
  const lines = trimmed.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid JSON on line ${i + 1}`);
    }
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function detectFormat(text: string): ImportFormat {
  const values = readValues(text);
  const rows = values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isRecord);
  if (values.some((v) => isRecord(v) && "resourceSpans" in v)) return "otel";
  if (rows.some((r) => typeof r.run_type === "string" && typeof r.dotted_order === "string")) {
    return "langsmith";
  }
  if (
    rows.some(
      (r) =>
        typeof r.type === "string" &&
        ("trace_id" in r || "traceId" in r) &&
        ("start_time" in r || "startTime" in r),
    )
  ) {
    return "langfuse";
  }
  throw new Error(FORMATS_HINT);
}

function toNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** JSON.stringify with sorted object keys, so identical outputs diff clean */
function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (isRecord(v)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) out[key] = sort(v[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not JSON, keep the raw string
    }
    return { _raw: value };
  }
  return undefined;
}

/**
 * Every source keys runs by trace id, but the diff correlates runs by name.
 * Use --run when given, else the derived names; identical names across traces
 * get #1 #2 suffixes, which the differ already treats as repeated samples.
 */
function nameRuns(derived: string[], override: string | undefined): string[] {
  const bases = override ? derived.map(() => override) : derived;
  const total = new Map<string, number>();
  for (const base of bases) total.set(base, (total.get(base) ?? 0) + 1);
  const seen = new Map<string, number>();
  return bases.map((base) => {
    if ((total.get(base) ?? 0) < 2) return base;
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    return `${base}#${nth}`;
  });
}

interface ImportedCall {
  startKey: string | number | bigint;
  event: LlmCallEvent | ToolCallEvent;
}

interface ImportedRun {
  derivedName: string;
  calls: ImportedCall[];
  output?: string;
  outputSource?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  status: "ok" | "error";
  error?: string;
  startTs?: number;
}

interface Tally {
  sawCost: boolean;
  sawArgs: boolean;
  sawOutput: boolean;
  sawTokens: boolean;
  warnings: Set<string>;
}

function newTally(): Tally {
  return { sawCost: false, sawArgs: false, sawOutput: false, sawTokens: false, warnings: new Set() };
}

function assemble(
  importedRuns: ImportedRun[],
  tally: Tally,
  options: ImportOptions,
  format: ImportFormat,
  schema?: string,
): ImportResult {
  const names = nameRuns(
    importedRuns.map((r) => r.derivedName),
    options.run,
  );

  const events: TraceEvent[] = [];
  let llmCalls = 0;
  let toolCalls = 0;
  for (let i = 0; i < importedRuns.length; i++) {
    const run = importedRuns[i];
    const name = names[i];
    const start: RunStartEvent = { type: "run_start", run: name };
    if (run.startTs !== undefined) start.ts = run.startTs;
    if (run.meta && Object.keys(run.meta).length) start.meta = run.meta;
    events.push(start);
    run.calls.sort((a, b) => (a.startKey < b.startKey ? -1 : a.startKey > b.startKey ? 1 : 0));
    for (const call of run.calls) {
      events.push({ ...call.event, run: name });
      if (call.event.type === "llm_call") llmCalls++;
      else toolCalls++;
    }
    if (run.output !== undefined) {
      const out: OutputEvent = { type: "output", run: name, content: run.output };
      if (run.outputSource) out.source = run.outputSource;
      events.push(out);
    }
    const end: RunEndEvent = { type: "run_end", run: name, status: run.status };
    if (run.error) end.error = run.error;
    events.push(end);
  }

  const missing: string[] = [];
  if (llmCalls && !tally.sawTokens) missing.push("tokens");
  if (llmCalls && !tally.sawCost) missing.push("cost");
  if (toolCalls && !tally.sawArgs) missing.push("tool args");
  if (!tally.sawOutput) missing.push("output");
  const result: ImportResult = {
    events,
    runs: importedRuns.length,
    llmCalls,
    toolCalls,
    format,
    missing,
    warnings: [...tally.warnings],
  };
  if (schema) result.schema = schema;
  return result;
}

// ---------------------------------------------------------------------------
// OpenTelemetry GenAI (OTLP JSON file export)
// ---------------------------------------------------------------------------

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: Array<{ key?: string; value?: unknown }>;
  status?: { code?: number; message?: string };
}

function unwrapAnyValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return toNum(value.intValue);
  if ("doubleValue" in value) return toNum(value.doubleValue);
  if ("boolValue" in value) return value.boolValue;
  if ("arrayValue" in value) {
    const arr = value.arrayValue;
    const items = isRecord(arr) && Array.isArray(arr.values) ? arr.values : [];
    return items.map(unwrapAnyValue);
  }
  return value;
}

function spanAttrs(span: OtlpSpan): Map<string, unknown> {
  const attrs = new Map<string, unknown>();
  for (const entry of span.attributes ?? []) {
    if (entry && typeof entry.key === "string") attrs.set(entry.key, unwrapAnyValue(entry.value));
  }
  return attrs;
}

function nanos(value: string | number | undefined): bigint {
  if (typeof value === "number") return BigInt(Math.round(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

const OTEL_LLM_OPS = new Set(["chat", "generate_content", "text_completion", "generate", "completion"]);

function importOtel(values: unknown[], options: ImportOptions): ImportResult {
  const spans: OtlpSpan[] = [];
  for (const value of values) {
    if (!isRecord(value) || !Array.isArray(value.resourceSpans)) continue;
    for (const rs of value.resourceSpans) {
      if (!isRecord(rs) || !Array.isArray(rs.scopeSpans)) continue;
      for (const ss of rs.scopeSpans) {
        if (!isRecord(ss) || !Array.isArray(ss.spans)) continue;
        for (const span of ss.spans) if (isRecord(span)) spans.push(span as OtlpSpan);
      }
    }
  }
  if (!spans.length) throw new Error("no spans found in the OTLP input");

  const traces = new Map<string, OtlpSpan[]>();
  for (const span of spans) {
    const id = String(span.traceId ?? "unknown");
    const list = traces.get(id) ?? [];
    list.push(span);
    traces.set(id, list);
  }

  const tally = newTally();
  const importedRuns: ImportedRun[] = [];
  for (const [traceId, traceSpans] of traces) {
    traceSpans.sort((a, b) => {
      const sa = nanos(a.startTimeUnixNano);
      const sb = nanos(b.startTimeUnixNano);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

    const spanIds = new Set(traceSpans.map((s) => s.spanId));
    const root = traceSpans.find((s) => !s.parentSpanId || !spanIds.has(s.parentSpanId));
    const rootAttrs = root ? spanAttrs(root) : new Map<string, unknown>();
    const derivedName = String(
      root?.name ??
        rootAttrs.get("gen_ai.workflow.name") ??
        rootAttrs.get("gen_ai.agent.name") ??
        rootAttrs.get("gen_ai.conversation.id") ??
        traceId,
    );

    const run: ImportedRun = { derivedName, calls: [], status: "ok" };
    let lastOutput: string | undefined;
    let lastOutputSource: Record<string, unknown> | undefined;
    const sourceOf = (span: OtlpSpan): Record<string, unknown> => {
      const source: Record<string, unknown> = {};
      if (span.traceId !== undefined) source.trace_id = span.traceId;
      if (span.spanId !== undefined) source.span_id = span.spanId;
      if (span.parentSpanId !== undefined) source.parent_span_id = span.parentSpanId;
      return source;
    };
    for (const span of traceSpans) {
      const attrs = spanAttrs(span);
      const op = attrs.get("gen_ai.operation.name");
      const start = nanos(span.startTimeUnixNano);
      const end = nanos(span.endTimeUnixNano);
      const latency = end > start ? Number((end - start) / 1000n) / 1000 : undefined;
      const failed = span.status?.code === 2;
      const errorText = failed
        ? String(span.status?.message ?? attrs.get("error.type") ?? "error")
        : undefined;
      if (failed) {
        run.status = "error";
        if (!run.error) run.error = errorText;
      }
      if (run.startTs === undefined && start > 0n) run.startTs = Number(start / 1000000n);

      const isLlm =
        (typeof op === "string" && OTEL_LLM_OPS.has(op)) ||
        (op === undefined &&
          (attrs.has("gen_ai.provider.name") || attrs.has("gen_ai.system")) &&
          (attrs.has("gen_ai.request.model") || attrs.has("gen_ai.response.model")));

      if (op === "execute_tool") {
        const name = String(
          attrs.get("gen_ai.tool.name") ?? String(span.name ?? "").replace(/^execute_tool\s+/, "") ?? "tool",
        );
        const event: ToolCallEvent = { type: "tool_call", run: "", name };
        const args = parseArgs(attrs.get("gen_ai.tool.call.arguments"));
        if (args) {
          event.args = args;
          tally.sawArgs = true;
        } else {
          tally.warnings.add(
            "tool arguments were not captured in the source spans (gen_ai.tool.call.arguments is opt-in); arg diffs will be empty",
          );
        }
        if (latency !== undefined) event.latency_ms = latency;
        if (errorText) event.error = errorText;
        event.source = sourceOf(span);
        run.calls.push({ startKey: start, event });
      } else if (isLlm) {
        const model = String(
          attrs.get("gen_ai.response.model") ?? attrs.get("gen_ai.request.model") ?? "unknown",
        );
        const event: LlmCallEvent = { type: "llm_call", run: "", model };
        const input =
          toNum(attrs.get("gen_ai.usage.input_tokens")) ?? toNum(attrs.get("gen_ai.usage.prompt_tokens"));
        const output =
          toNum(attrs.get("gen_ai.usage.output_tokens")) ??
          toNum(attrs.get("gen_ai.usage.completion_tokens"));
        if (input !== undefined || output !== undefined) {
          event.tokens = {};
          if (input !== undefined) event.tokens.input = input;
          if (output !== undefined) event.tokens.output = output;
          tally.sawTokens = true;
        }
        const finish = attrs.get("gen_ai.response.finish_reasons");
        if (Array.isArray(finish) && finish.length) event.stop_reason = String(finish[0]);
        if (latency !== undefined) event.latency_ms = latency;
        if (errorText) event.error = errorText;
        event.source = sourceOf(span);
        run.calls.push({ startKey: start, event });

        const messages = attrs.get("gen_ai.output.messages");
        const text = outputMessagesText(messages);
        if (text !== undefined) {
          lastOutput = text;
          lastOutputSource = sourceOf(span);
        }
      }
    }
    if (lastOutput !== undefined) {
      run.output = lastOutput;
      run.outputSource = lastOutputSource;
      tally.sawOutput = true;
    }
    importedRuns.push(run);
  }

  if (!tally.sawOutput) {
    tally.warnings.add(
      "no model output captured in the source spans (gen_ai.output.messages is opt-in); output comparison unavailable",
    );
  }
  return assemble(importedRuns, tally, options, "otel");
}

/** gen_ai.output.messages: [{role, parts:[{type:"text", content}], finish_reason}] */
function outputMessagesText(value: unknown): string | undefined {
  let messages = value;
  if (typeof value === "string") {
    try {
      messages = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (!Array.isArray(messages)) return undefined;
  const texts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (isRecord(part) && part.type === "text" && typeof part.content === "string") {
        texts.push(part.content);
      }
    }
  }
  return texts.length ? texts.join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// Langfuse export rows
// ---------------------------------------------------------------------------

/** export rows are snake_case, the public API is camelCase; accept both */
function field(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in row && row[key] !== null && row[key] !== undefined) return row[key];
  }
  return undefined;
}

function isoMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function contentOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (isRecord(output) && typeof output.content === "string") return output.content;
  return stableStringify(output);
}

function importLangfuse(values: unknown[], options: ImportOptions): ImportResult {
  const allRows = values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isRecord);
  if (!allRows.length) throw new Error("no observation rows found in the langfuse input");

  const tally = newTally();
  const seenIds = new Set<unknown>();
  let duplicates = 0;
  const rows: Record<string, unknown>[] = [];
  for (const row of allRows) {
    const id = field(row, "id");
    if (id !== undefined) {
      if (seenIds.has(id)) {
        duplicates++;
        continue;
      }
      seenIds.add(id);
    }
    rows.push(row);
  }
  if (duplicates) {
    tally.warnings.add(`${duplicates} duplicate row${duplicates === 1 ? "" : "s"} skipped`);
  }

  const schema = rows.some((r) => "trace_id" in r || "start_time" in r)
    ? "export rows (snake_case)"
    : "API objects (camelCase)";

  const traces = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const id = String(field(row, "trace_id", "traceId") ?? "unknown");
    const list = traces.get(id) ?? [];
    list.push(row);
    traces.set(id, list);
  }

  const importedRuns: ImportedRun[] = [];
  for (const [traceId, traceRows] of traces) {
    traceRows.sort((a, b) => {
      const sa = isoMs(field(a, "start_time", "startTime")) ?? 0;
      const sb = isoMs(field(b, "start_time", "startTime")) ?? 0;
      return sa - sb;
    });

    const ids = new Set(traceRows.map((r) => field(r, "id")));
    const isRoot = (row: Record<string, unknown>): boolean => {
      const parent = field(row, "parent_observation_id", "parentObservationId");
      return parent === undefined || !ids.has(parent);
    };
    const derivedName = String(field(traceRows[0], "trace_name", "traceName") ?? traceId);

    const sourceOf = (row: Record<string, unknown>): Record<string, unknown> => {
      const source: Record<string, unknown> = { trace_id: traceId };
      const id = field(row, "id");
      if (id !== undefined) source.observation_id = id;
      const parent = field(row, "parent_observation_id", "parentObservationId");
      if (parent !== undefined) source.parent_observation_id = parent;
      return source;
    };

    const meta: Record<string, unknown> = {};
    const metaKeys: Array<[string, string[]]> = [
      ["tags", ["tags"]],
      ["environment", ["environment"]],
      ["release", ["release"]],
      ["version", ["version"]],
      ["session_id", ["session_id", "sessionId"]],
    ];
    for (const row of traceRows) {
      for (const [key, aliases] of metaKeys) {
        if (meta[key] === undefined) {
          const value = field(row, ...aliases);
          if (value !== undefined) meta[key] = value;
        }
      }
    }

    const run: ImportedRun = { derivedName, calls: [], status: "ok" };
    if (Object.keys(meta).length) run.meta = meta;
    let rootOutput: string | undefined;
    let rootOutputSource: Record<string, unknown> | undefined;
    let lastOutput: string | undefined;
    let lastOutputSource: Record<string, unknown> | undefined;
    for (const row of traceRows) {
      const type = String(field(row, "type") ?? "").toUpperCase();
      const start = isoMs(field(row, "start_time", "startTime"));
      const end = isoMs(field(row, "end_time", "endTime"));
      // latency fields flipped units on newer integrations; timestamps did not
      const latency = start !== undefined && end !== undefined && end > start ? end - start : undefined;
      const failed = field(row, "level") === "ERROR";
      const errorText = failed
        ? String(field(row, "status_message", "statusMessage") ?? "error")
        : undefined;
      if (failed) {
        run.status = "error";
        if (!run.error) run.error = errorText;
      }
      if (run.startTs === undefined && start !== undefined) run.startTs = start;

      if (type === "GENERATION" || type === "EMBEDDING") {
        const model = String(field(row, "provided_model_name", "providedModelName", "model") ?? "unknown");
        const event: LlmCallEvent = { type: "llm_call", run: "", model };
        const usage = field(row, "usage_details", "usageDetails", "usage");
        if (isRecord(usage)) {
          const input = toNum(usage.input) ?? toNum(usage.promptTokens);
          const output = toNum(usage.output) ?? toNum(usage.completionTokens);
          if (input !== undefined || output !== undefined) {
            event.tokens = {};
            if (input !== undefined) event.tokens.input = input;
            if (output !== undefined) event.tokens.output = output;
            tally.sawTokens = true;
          }
        }
        // blob exports serialise prices as quoted decimal strings
        let cost = toNum(field(row, "total_cost", "totalCost", "calculatedTotalCost"));
        if (cost === undefined) {
          const details = field(row, "cost_details", "costDetails");
          if (isRecord(details)) {
            const parts = Object.values(details).map(toNum).filter((n): n is number => n !== undefined);
            if (parts.length) cost = parts.reduce((t, n) => t + n, 0);
          }
        }
        if (cost !== undefined) {
          event.cost_usd = cost;
          tally.sawCost = true;
        }
        if (latency !== undefined) event.latency_ms = latency;
        if (errorText) event.error = errorText;
        event.source = sourceOf(row);
        run.calls.push({ startKey: start ?? 0, event });
      } else if (type === "TOOL" || (type === "SPAN" && !isRoot(row))) {
        // older SDKs logged tool use as plain nested SPANs
        const event: ToolCallEvent = { type: "tool_call", run: "", name: String(field(row, "name") ?? "tool") };
        const args = parseArgs(field(row, "input"));
        if (args) {
          event.args = args;
          tally.sawArgs = true;
        }
        const toolOutput = field(row, "output");
        if (toolOutput !== undefined) event.result = contentOf(toolOutput);
        if (latency !== undefined) event.latency_ms = latency;
        if (errorText) event.error = errorText;
        event.source = sourceOf(row);
        run.calls.push({ startKey: start ?? 0, event });
      }

      const output = field(row, "output");
      if (output !== undefined && type !== "TOOL" && !(type === "SPAN" && !isRoot(row))) {
        const content = contentOf(output);
        if (isRoot(row)) {
          rootOutput = content;
          rootOutputSource = sourceOf(row);
        }
        lastOutput = content;
        lastOutputSource = sourceOf(row);
      }
    }
    const output = rootOutput ?? lastOutput;
    if (output !== undefined) {
      run.output = output;
      run.outputSource = rootOutput !== undefined ? rootOutputSource : lastOutputSource;
      tally.sawOutput = true;
    }
    importedRuns.push(run);
  }

  return assemble(importedRuns, tally, options, "langfuse", schema);
}

// ---------------------------------------------------------------------------
// LangSmith run objects
// ---------------------------------------------------------------------------

function importLangsmith(values: unknown[], options: ImportOptions): ImportResult {
  const runs = values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isRecord);
  if (!runs.length) throw new Error("no run objects found in the langsmith input");

  const traces = new Map<string, Record<string, unknown>[]>();
  for (const run of runs) {
    const id = String(run.trace_id ?? run.id ?? "unknown");
    const list = traces.get(id) ?? [];
    list.push(run);
    traces.set(id, list);
  }

  const tally = newTally();
  const importedRuns: ImportedRun[] = [];
  for (const [traceId, traceRuns] of traces) {
    // dotted_order is a lexicographic execution-order key; that is its job
    traceRuns.sort((a, b) => String(a.dotted_order ?? "").localeCompare(String(b.dotted_order ?? "")));

    const root =
      traceRuns.find((r) => String(r.id) === traceId) ?? traceRuns.find((r) => !r.parent_run_id);
    const derivedName = String(root?.name ?? traceId);

    const imported: ImportedRun = { derivedName, calls: [], status: "ok" };
    if (root && typeof root.error === "string" && root.error) {
      imported.status = "error";
      imported.error = root.error;
    }
    const sourceOf = (run: Record<string, unknown>): Record<string, unknown> => {
      const source: Record<string, unknown> = { trace_id: traceId };
      if (run.id !== undefined) source.run_id = run.id;
      if (run.parent_run_id !== undefined && run.parent_run_id !== null) {
        source.parent_run_id = run.parent_run_id;
      }
      return source;
    };
    for (const run of traceRuns) {
      const start = isoMs(run.start_time);
      const end = isoMs(run.end_time);
      const latency = start !== undefined && end !== undefined && end > start ? end - start : undefined;
      const errorText = typeof run.error === "string" && run.error ? run.error : undefined;
      if (errorText && imported.status === "ok") {
        imported.status = "error";
        imported.error = errorText;
      }
      if (imported.startTs === undefined && start !== undefined) imported.startTs = start;
      const orderKey = String(run.dotted_order ?? start ?? "");

      if (run.run_type === "llm") {
        const extra = isRecord(run.extra) ? run.extra : {};
        const params = isRecord(extra.invocation_params) ? extra.invocation_params : {};
        const outputs = isRecord(run.outputs) ? run.outputs : {};
        const llmOutput = isRecord(outputs.llm_output) ? outputs.llm_output : {};
        const model = String(
          params.model ?? params.model_name ?? params.model_id ?? llmOutput.model_name ?? "unknown",
        );
        const event: LlmCallEvent = { type: "llm_call", run: "", model };
        const usage = isRecord(llmOutput.token_usage) ? llmOutput.token_usage : {};
        const input = toNum(run.prompt_tokens) ?? toNum(usage.prompt_tokens);
        const output = toNum(run.completion_tokens) ?? toNum(usage.completion_tokens);
        if (input !== undefined || output !== undefined) {
          event.tokens = {};
          if (input !== undefined) event.tokens.input = input;
          if (output !== undefined) event.tokens.output = output;
          tally.sawTokens = true;
        }
        const cost = toNum(run.total_cost);
        if (cost !== undefined) {
          event.cost_usd = cost;
          tally.sawCost = true;
        }
        const stop = finishReason(outputs);
        if (stop) event.stop_reason = stop;
        if (latency !== undefined) event.latency_ms = latency;
        if (errorText) event.error = errorText;
        event.source = sourceOf(run);
        imported.calls.push({ startKey: orderKey, event });
      } else if (run.run_type === "tool") {
        const event: ToolCallEvent = { type: "tool_call", run: "", name: String(run.name ?? "tool") };
        const args = parseArgs(run.inputs);
        if (args) {
          event.args = args;
          tally.sawArgs = true;
        }
        if (isRecord(run.outputs)) {
          const toolOutput = run.outputs.output !== undefined ? run.outputs.output : run.outputs;
          event.result = contentOf(toolOutput);
        }
        if (latency !== undefined) event.latency_ms = latency;
        if (errorText) event.error = errorText;
        event.source = sourceOf(run);
        imported.calls.push({ startKey: orderKey, event });
      }
    }

    if (root && isRecord(root.outputs)) {
      const outputs = root.outputs;
      const content = outputs.output ?? outputs.answer ?? outputs;
      imported.output = contentOf(content);
      imported.outputSource = sourceOf(root);
      tally.sawOutput = true;
    }
    importedRuns.push(imported);
  }

  return assemble(importedRuns, tally, options, "langsmith");
}

/** outputs.generations[0][0].generation_info.finish_reason, best-effort */
function finishReason(outputs: Record<string, unknown>): string | undefined {
  const generations = outputs.generations;
  if (!Array.isArray(generations) || !generations.length) return undefined;
  const first = Array.isArray(generations[0]) ? generations[0][0] : generations[0];
  if (!isRecord(first)) return undefined;
  const info = first.generation_info;
  if (isRecord(info) && typeof info.finish_reason === "string") return info.finish_reason;
  return undefined;
}

// ---------------------------------------------------------------------------

export function importTrace(
  text: string,
  format?: ImportFormat,
  options: ImportOptions = {},
): ImportResult {
  const resolved = format ?? detectFormat(text);
  const values = readValues(text);
  if (resolved === "otel") return importOtel(values, options);
  if (resolved === "langfuse") return importLangfuse(values, options);
  return importLangsmith(values, options);
}

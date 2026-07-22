export interface RunStartEvent {
  type: "run_start";
  run: string;
  ts?: number;
  meta?: Record<string, unknown>;
}

export interface LlmCallEvent {
  type: "llm_call";
  run: string;
  ts?: number;
  model: string;
  latency_ms?: number;
  tokens?: { input?: number; output?: number };
  cost_usd?: number;
  stop_reason?: string;
  error?: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  run: string;
  ts?: number;
  name: string;
  args?: Record<string, unknown>;
  latency_ms?: number;
  error?: string;
}

export interface OutputEvent {
  type: "output";
  run: string;
  ts?: number;
  content: string;
}

export interface RunEndEvent {
  type: "run_end";
  run: string;
  ts?: number;
  status: "ok" | "error";
  error?: string;
}

export type TraceEvent =
  | RunStartEvent
  | LlmCallEvent
  | ToolCallEvent
  | OutputEvent
  | RunEndEvent;

export interface Run {
  id: string;
  meta: Record<string, unknown>;
  llmCalls: LlmCallEvent[];
  toolCalls: ToolCallEvent[];
  outputs: OutputEvent[];
  status: "ok" | "error" | "unknown";
  error?: string;
}

export type Severity = "breaking" | "warning" | "info";

export interface Finding {
  severity: Severity;
  kind:
    | "run_missing"
    | "run_added"
    | "status_changed"
    | "tool_removed"
    | "tool_added"
    | "tool_args_changed"
    | "tool_reordered"
    | "tool_error"
    | "output_changed"
    | "output_missing"
    | "latency_regression"
    | "cost_increase"
    | "token_change"
    | "model_changed";
  run: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface RunStats {
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  models: string[];
}

export interface RunDiff {
  run: string;
  findings: Finding[];
  before?: RunStats;
  after?: RunStats;
}

export interface DiffResult {
  runs: RunDiff[];
  findings: Finding[];
  breaking: number;
  warnings: number;
  info: number;
}

export interface DiffOptions {
  /** flag latency regressions above this ratio, e.g. 1.5 = 50% slower (default 1.5) */
  latencyThreshold?: number;
  /** flag cost increases above this ratio (default 1.25) */
  costThreshold?: number;
  /** compare final outputs (default true) */
  compareOutputs?: boolean;
}

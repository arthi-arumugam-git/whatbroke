import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TraceEvent } from "./types.js";

export interface RecorderOptions {
  /** trace file path, e.g. traces/before.jsonl */
  file: string;
  /** run id for this scenario, defaults to "default" */
  run?: string;
  meta?: Record<string, unknown>;
}

/**
 * Writes trace events to a JSONL file. Use one recorder per scenario run,
 * or pass a run id per call if you drive many scenarios from one place.
 */
export class Recorder {
  private file: string;
  private run: string;

  constructor(options: RecorderOptions) {
    this.file = options.file;
    this.run = options.run ?? "default";
    mkdirSync(dirname(this.file) || ".", { recursive: true });
    this.write({ type: "run_start", run: this.run, ts: Date.now(), meta: options.meta });
  }

  private write(event: TraceEvent): void {
    appendFileSync(this.file, JSON.stringify(event) + "\n");
  }

  llmCall(data: {
    model: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    stopReason?: string;
    error?: string;
  }): void {
    this.write({
      type: "llm_call",
      run: this.run,
      ts: Date.now(),
      model: data.model,
      latency_ms: data.latencyMs,
      tokens: { input: data.inputTokens, output: data.outputTokens },
      cost_usd: data.costUsd,
      stop_reason: data.stopReason,
      error: data.error,
    });
  }

  toolCall(name: string, args?: Record<string, unknown>, data?: { latencyMs?: number; error?: string }): void {
    this.write({
      type: "tool_call",
      run: this.run,
      ts: Date.now(),
      name,
      args,
      latency_ms: data?.latencyMs,
      error: data?.error,
    });
  }

  output(content: string): void {
    this.write({ type: "output", run: this.run, ts: Date.now(), content });
  }

  end(status: "ok" | "error" = "ok", error?: string): void {
    this.write({ type: "run_end", run: this.run, ts: Date.now(), status, error });
  }

  /**
   * Wraps an OpenAI client (openai npm package) so every
   * chat.completions.create call is recorded, including tool calls the
   * model requested. Returns the same client.
   */
  wrapOpenAI<T extends object>(client: T): T {
    const anyClient = client as any;
    const completions = anyClient?.chat?.completions;
    if (!completions?.create) {
      throw new Error("wrapOpenAI expects an OpenAI client with chat.completions.create");
    }
    const original = completions.create.bind(completions);
    const recorder = this;
    completions.create = async function (params: any, ...rest: any[]) {
      const started = Date.now();
      try {
        const response = await original(params, ...rest);
        recorder.llmCall({
          model: response?.model ?? params?.model ?? "unknown",
          latencyMs: Date.now() - started,
          inputTokens: response?.usage?.prompt_tokens,
          outputTokens: response?.usage?.completion_tokens,
          stopReason: response?.choices?.[0]?.finish_reason,
        });
        const toolCalls = response?.choices?.[0]?.message?.tool_calls ?? [];
        for (const call of toolCalls) {
          recorder.toolCall(call?.function?.name ?? "unknown", safeParse(call?.function?.arguments));
        }
        return response;
      } catch (err) {
        recorder.llmCall({
          model: params?.model ?? "unknown",
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
    return client;
  }

  /**
   * Wraps an Anthropic client (@anthropic-ai/sdk) so every messages.create
   * call is recorded, including tool_use blocks. Returns the same client.
   */
  wrapAnthropic<T extends object>(client: T): T {
    const anyClient = client as any;
    const messages = anyClient?.messages;
    if (!messages?.create) {
      throw new Error("wrapAnthropic expects an Anthropic client with messages.create");
    }
    const original = messages.create.bind(messages);
    const recorder = this;
    messages.create = async function (params: any, ...rest: any[]) {
      const started = Date.now();
      try {
        const response = await original(params, ...rest);
        recorder.llmCall({
          model: response?.model ?? params?.model ?? "unknown",
          latencyMs: Date.now() - started,
          inputTokens: response?.usage?.input_tokens,
          outputTokens: response?.usage?.output_tokens,
          stopReason: response?.stop_reason,
        });
        const blocks = Array.isArray(response?.content) ? response.content : [];
        for (const block of blocks) {
          if (block?.type === "tool_use") {
            recorder.toolCall(block.name ?? "unknown", block.input ?? {});
          }
        }
        return response;
      } catch (err) {
        recorder.llmCall({
          model: params?.model ?? "unknown",
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
    return client;
  }
}

function safeParse(json: unknown): Record<string, unknown> | undefined {
  if (typeof json !== "string") return undefined;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

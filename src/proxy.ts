import http from "node:http";
import type { AddressInfo } from "node:net";
import { Recorder } from "./record.js";

export interface ProxyOptions {
  /** trace file path, e.g. traces/current.jsonl */
  file: string;
  /** port to listen on, 0 picks a free one (default 4141) */
  port?: number;
  /** upstream origin override, e.g. http://localhost:8080 for a mock */
  target?: string;
  /** run id when the client sends no x-whatbroke-run header */
  run?: string;
  /** called once per recorded llm call, used by the CLI for progress output */
  onRecord?: (run: string, model: string, toolNames: string[]) => void;
}

export interface ProxyHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

interface Summary {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  toolCalls: Array<{ name: string; args?: Record<string, unknown> }>;
  text: string;
}

const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "x-whatbroke-run",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/**
 * Starts a local HTTP proxy that forwards requests to the OpenAI or
 * Anthropic API and records every LLM call, tool call, and final text
 * output to a JSONL trace. Point OPENAI_BASE_URL or ANTHROPIC_BASE_URL at
 * it and run your agent unchanged. Requests to /v1/messages go to
 * api.anthropic.com, everything else to api.openai.com, unless `target`
 * says otherwise. Group runs with an x-whatbroke-run request header.
 */
export function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const recorders = new Map<string, Recorder>();
  const recorderFor = (run: string): Recorder => {
    let rec = recorders.get(run);
    if (!rec) {
      rec = new Recorder({ file: options.file, run });
      recorders.set(run, rec);
    }
    return rec;
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const path = req.url ?? "/";
    const anthropic = path.startsWith("/v1/messages");
    const origin = options.target ?? (anthropic ? "https://api.anthropic.com" : "https://api.openai.com");

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && !STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }
    headers["accept-encoding"] = "identity";

    const runHeader = req.headers["x-whatbroke-run"];
    const run = (typeof runHeader === "string" && runHeader) || options.run || "default";

    const started = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(origin + path, {
        method: req.method,
        headers,
        body: body.length ? body : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recorderFor(run).llmCall({ model: "unknown", latencyMs: Date.now() - started, error: message });
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `whatbroke proxy: upstream unreachable: ${message}` } }));
      return;
    }

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value;
    });

    const contentType = upstream.headers.get("content-type") ?? "";
    const streaming = contentType.includes("text/event-stream");

    let text = "";
    if (streaming && upstream.body) {
      // pass chunks through to the client as they arrive, parse afterwards
      res.writeHead(upstream.status, responseHeaders);
      const decoder = new TextDecoder();
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
      res.end();
    } else {
      text = await upstream.text();
      res.writeHead(upstream.status, responseHeaders);
      res.end(text);
    }

    if (upstream.status >= 400) {
      recorderFor(run).llmCall({
        model: "unknown",
        latencyMs: Date.now() - started,
        error: `upstream ${upstream.status}: ${truncate(text)}`,
      });
      return;
    }

    let summary: Summary | null = null;
    try {
      if (streaming) {
        const events = parseSse(text);
        summary = anthropic ? summarizeAnthropicStream(events) : summarizeOpenAIStream(events);
      } else {
        const parsed = JSON.parse(text);
        summary = anthropic ? summarizeAnthropic(parsed) : summarizeOpenAI(parsed);
      }
    } catch {
      // not a chat/messages response we understand, forwarded untouched
    }
    if (!summary) return;

    const rec = recorderFor(run);
    rec.llmCall({
      model: summary.model,
      latencyMs: Date.now() - started,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      stopReason: summary.stopReason,
    });
    for (const call of summary.toolCalls) rec.toolCall(call.name, call.args);
    // when the model asked for tools, the text is usually preamble; the
    // meaningful final answer is the text of a call with no tool use
    if (!summary.toolCalls.length && summary.text.trim()) rec.output(summary.text);
    options.onRecord?.(run, summary.model, summary.toolCalls.map((c) => c.name));
  });

  let closing: Promise<void> | undefined;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4141, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => {
          closing ??= new Promise<void>((done, fail) => {
            for (const rec of recorders.values()) rec.end("ok");
            server.close((err) => (err ? fail(err) : done()));
          });
          return closing;
        },
      });
    });
  });
}

function parseSse(text: string): any[] {
  const events: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // partial or non-json data line, skip
    }
  }
  return events;
}

function summarizeOpenAI(body: any): Summary | null {
  const choice = body?.choices?.[0];
  if (!choice) return null;
  const message = choice.message ?? {};
  const toolCalls = (message.tool_calls ?? []).map((c: any) => ({
    name: c?.function?.name ?? "unknown",
    args: safeParse(c?.function?.arguments),
  }));
  return {
    model: body.model ?? "unknown",
    inputTokens: body.usage?.prompt_tokens,
    outputTokens: body.usage?.completion_tokens,
    stopReason: choice.finish_reason ?? undefined,
    toolCalls,
    text: typeof message.content === "string" ? message.content : "",
  };
}

function summarizeOpenAIStream(events: any[]): Summary | null {
  if (!events.length) return null;
  let model = "unknown";
  let text = "";
  let stopReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const tools = new Map<number, { name: string; args: string }>();

  for (const event of events) {
    if (event?.model) model = event.model;
    if (event?.usage) {
      inputTokens = event.usage.prompt_tokens ?? inputTokens;
      outputTokens = event.usage.completion_tokens ?? outputTokens;
    }
    const choice = event?.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) stopReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") text += delta.content;
    for (const call of delta.tool_calls ?? []) {
      const index = call?.index ?? 0;
      const entry = tools.get(index) ?? { name: "unknown", args: "" };
      if (call?.function?.name) entry.name = call.function.name;
      if (call?.function?.arguments) entry.args += call.function.arguments;
      tools.set(index, entry);
    }
  }

  return {
    model,
    inputTokens,
    outputTokens,
    stopReason,
    toolCalls: [...tools.values()].map((t) => ({ name: t.name, args: safeParse(t.args) })),
    text,
  };
}

function summarizeAnthropic(body: any): Summary | null {
  if (body?.type !== "message") return null;
  const blocks = Array.isArray(body.content) ? body.content : [];
  const toolCalls = blocks
    .filter((b: any) => b?.type === "tool_use")
    .map((b: any) => ({ name: b.name ?? "unknown", args: b.input ?? {} }));
  const text = blocks
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text ?? "")
    .join("");
  return {
    model: body.model ?? "unknown",
    inputTokens: body.usage?.input_tokens,
    outputTokens: body.usage?.output_tokens,
    stopReason: body.stop_reason ?? undefined,
    toolCalls,
    text,
  };
}

function summarizeAnthropicStream(events: any[]): Summary | null {
  if (!events.length) return null;
  let model = "unknown";
  let text = "";
  let stopReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const tools = new Map<number, { name: string; json: string }>();

  for (const event of events) {
    switch (event?.type) {
      case "message_start":
        model = event.message?.model ?? model;
        inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
        break;
      case "content_block_start":
        if (event.content_block?.type === "tool_use") {
          tools.set(event.index ?? 0, { name: event.content_block.name ?? "unknown", json: "" });
        }
        break;
      case "content_block_delta":
        if (event.delta?.type === "text_delta") text += event.delta.text ?? "";
        if (event.delta?.type === "input_json_delta") {
          const entry = tools.get(event.index ?? 0);
          if (entry) entry.json += event.delta.partial_json ?? "";
        }
        break;
      case "message_delta":
        stopReason = event.delta?.stop_reason ?? stopReason;
        outputTokens = event.usage?.output_tokens ?? outputTokens;
        break;
    }
  }

  return {
    model,
    inputTokens,
    outputTokens,
    stopReason,
    toolCalls: [...tools.values()].map((t) => ({ name: t.name, args: safeParse(t.json) ?? {} })),
    text,
  };
}

function safeParse(json: unknown): Record<string, unknown> | undefined {
  if (typeof json !== "string" || !json) return undefined;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

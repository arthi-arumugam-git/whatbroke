import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTrace } from "../src/parse.js";
import { startProxy, type ProxyHandle } from "../src/proxy.js";

const openaiToolResponse = {
  id: "chatcmpl-1",
  model: "gpt-4o",
  usage: { prompt_tokens: 500, completion_tokens: 80 },
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [
          { function: { name: "lookup_order", arguments: '{"order_id":"A-1042"}' } },
        ],
      },
    },
  ],
};

const openaiTextResponse = {
  id: "chatcmpl-2",
  model: "gpt-4o",
  usage: { prompt_tokens: 200, completion_tokens: 30 },
  choices: [{ finish_reason: "stop", message: { content: "Refund issued." } }],
};

const anthropicResponse = {
  type: "message",
  model: "claude-sonnet-4-6",
  stop_reason: "tool_use",
  usage: { input_tokens: 400, output_tokens: 60 },
  content: [
    { type: "text", text: "Let me look that up." },
    { type: "tool_use", name: "lookup_order", input: { order_id: "A-1042" } },
  ],
};

const openaiStream = [
  'data: {"model":"gpt-4o","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"issue_refund","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"amount\\":"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"42.5}"}}]}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":300,"completion_tokens":40}}',
  "data: [DONE]",
  "",
].join("\n\n");

const anthropicStream = [
  'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":250}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"All done."}}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}',
  'data: {"type":"message_stop"}',
  "",
].join("\n\n");

let upstream: http.Server;
let upstreamUrl: string;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const respond = (status: number, type: string, body: string) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    switch (req.url) {
      case "/v1/chat/completions":
        return respond(200, "application/json", JSON.stringify(openaiToolResponse));
      case "/v1/chat/completions?text":
        return respond(200, "application/json", JSON.stringify(openaiTextResponse));
      case "/v1/chat/completions?stream":
        return respond(200, "text/event-stream", openaiStream);
      case "/v1/messages":
        return respond(200, "application/json", JSON.stringify(anthropicResponse));
      case "/v1/messages?stream":
        return respond(200, "text/event-stream", anthropicStream);
      case "/v1/broken":
        return respond(429, "application/json", '{"error":{"message":"rate limited"}}');
      default:
        return respond(404, "application/json", "{}");
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => {
  upstream.close();
});

describe("startProxy", () => {
  let dir: string;
  let count = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "whatbroke-proxy-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function withProxy(
    fn: (proxy: ProxyHandle, file: string) => Promise<void>,
  ): Promise<void> {
    const file = join(dir, `trace-${count++}.jsonl`);
    const proxy = await startProxy({ file, port: 0, target: upstreamUrl });
    try {
      await fn(proxy, file);
    } finally {
      await proxy.close();
    }
  }

  it("records an openai tool call and passes the response through", async () => {
    await withProxy(async (proxy, file) => {
      const res = await fetch(`${proxy.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"gpt-4o"}',
      });
      const body = await res.json();
      expect(body.choices[0].message.tool_calls[0].function.name).toBe("lookup_order");
      await proxy.close();

      const runs = parseTrace(readFileSync(file, "utf8"));
      const run = runs.get("default")!;
      expect(run.llmCalls[0].model).toBe("gpt-4o");
      expect(run.llmCalls[0].tokens).toEqual({ input: 500, output: 80 });
      expect(run.toolCalls[0].name).toBe("lookup_order");
      expect(run.toolCalls[0].args).toEqual({ order_id: "A-1042" });
      expect(run.outputs).toHaveLength(0);
      expect(run.status).toBe("ok");
    });
  });

  it("records text as output only when there are no tool calls", async () => {
    await withProxy(async (proxy, file) => {
      await fetch(`${proxy.url}/v1/chat/completions?text`, { method: "POST", body: "{}" });
      await proxy.close();
      const run = parseTrace(readFileSync(file, "utf8")).get("default")!;
      expect(run.toolCalls).toHaveLength(0);
      expect(run.outputs[0].content).toBe("Refund issued.");
    });
  });

  it("understands anthropic responses on /v1/messages", async () => {
    await withProxy(async (proxy, file) => {
      await fetch(`${proxy.url}/v1/messages`, { method: "POST", body: "{}" });
      await proxy.close();
      const run = parseTrace(readFileSync(file, "utf8")).get("default")!;
      expect(run.llmCalls[0].model).toBe("claude-sonnet-4-6");
      expect(run.llmCalls[0].stop_reason).toBe("tool_use");
      expect(run.toolCalls[0].args).toEqual({ order_id: "A-1042" });
      expect(run.outputs).toHaveLength(0);
    });
  });

  it("reassembles tool args from an openai sse stream", async () => {
    await withProxy(async (proxy, file) => {
      const res = await fetch(`${proxy.url}/v1/chat/completions?stream`, {
        method: "POST",
        body: "{}",
      });
      const streamed = await res.text();
      expect(streamed).toContain("data: [DONE]");
      await proxy.close();
      const run = parseTrace(readFileSync(file, "utf8")).get("default")!;
      expect(run.toolCalls[0].name).toBe("issue_refund");
      expect(run.toolCalls[0].args).toEqual({ amount: 42.5 });
      expect(run.llmCalls[0].tokens).toEqual({ input: 300, output: 40 });
    });
  });

  it("reassembles text from an anthropic sse stream", async () => {
    await withProxy(async (proxy, file) => {
      await fetch(`${proxy.url}/v1/messages?stream`, { method: "POST", body: "{}" });
      await proxy.close();
      const run = parseTrace(readFileSync(file, "utf8")).get("default")!;
      expect(run.llmCalls[0].model).toBe("claude-sonnet-4-6");
      expect(run.outputs[0].content).toBe("All done.");
    });
  });

  it("groups requests by the x-whatbroke-run header", async () => {
    await withProxy(async (proxy, file) => {
      await fetch(`${proxy.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "x-whatbroke-run": "refund-flow" },
        body: "{}",
      });
      await fetch(`${proxy.url}/v1/chat/completions?text`, {
        method: "POST",
        headers: { "x-whatbroke-run": "order-status" },
        body: "{}",
      });
      await proxy.close();
      const runs = parseTrace(readFileSync(file, "utf8"));
      expect([...runs.keys()].sort()).toEqual(["order-status", "refund-flow"]);
    });
  });

  it("records upstream errors and passes the status through", async () => {
    await withProxy(async (proxy, file) => {
      const res = await fetch(`${proxy.url}/v1/broken`, { method: "POST", body: "{}" });
      expect(res.status).toBe(429);
      await proxy.close();
      const run = parseTrace(readFileSync(file, "utf8")).get("default")!;
      expect(run.llmCalls[0].error).toContain("429");
    });
  });
});

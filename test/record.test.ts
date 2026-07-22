import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTrace } from "../src/parse.js";
import { Recorder } from "../src/record.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whatbroke-"));
  file = join(dir, "trace.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Recorder", () => {
  it("writes a complete run", () => {
    const rec = new Recorder({ file, run: "r1", meta: { model: "gpt-4o" } });
    rec.llmCall({ model: "gpt-4o", latencyMs: 500, inputTokens: 100, outputTokens: 20 });
    rec.toolCall("lookup_order", { order_id: "A-1" }, { latencyMs: 50 });
    rec.output("done");
    rec.end("ok");

    const runs = parseTrace(readFileSync(file, "utf8"));
    const run = runs.get("r1")!;
    expect(run.meta.model).toBe("gpt-4o");
    expect(run.llmCalls).toHaveLength(1);
    expect(run.llmCalls[0].tokens?.input).toBe(100);
    expect(run.toolCalls[0].name).toBe("lookup_order");
    expect(run.outputs[0].content).toBe("done");
    expect(run.status).toBe("ok");
  });

  it("wrapOpenAI records llm and tool calls from responses", async () => {
    const rec = new Recorder({ file, run: "r1" });
    const fake = {
      chat: {
        completions: {
          create: async () => ({
            model: "gpt-4o",
            usage: { prompt_tokens: 200, completion_tokens: 40 },
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  tool_calls: [
                    { function: { name: "lookup_order", arguments: '{"order_id":"A-1"}' } },
                  ],
                },
              },
            ],
          }),
        },
      },
    };
    const client = rec.wrapOpenAI(fake);
    await client.chat.completions.create({ model: "gpt-4o" });

    const run = parseTrace(readFileSync(file, "utf8")).get("r1")!;
    expect(run.llmCalls[0].model).toBe("gpt-4o");
    expect(run.llmCalls[0].tokens?.input).toBe(200);
    expect(run.toolCalls[0].name).toBe("lookup_order");
    expect(run.toolCalls[0].args).toEqual({ order_id: "A-1" });
  });

  it("wrapOpenAI records errors and rethrows", async () => {
    const rec = new Recorder({ file, run: "r1" });
    const fake = {
      chat: {
        completions: {
          create: async () => {
            throw new Error("rate limited");
          },
        },
      },
    };
    const client = rec.wrapOpenAI(fake);
    await expect(client.chat.completions.create({ model: "gpt-4o" })).rejects.toThrow(
      "rate limited",
    );
    const run = parseTrace(readFileSync(file, "utf8")).get("r1")!;
    expect(run.llmCalls[0].error).toBe("rate limited");
  });

  it("wrapAnthropic records tool_use blocks", async () => {
    const rec = new Recorder({ file, run: "r1" });
    const fake = {
      messages: {
        create: async () => ({
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 300, output_tokens: 60 },
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", name: "lookup_order", input: { order_id: "A-1" } },
          ],
        }),
      },
    };
    const client = rec.wrapAnthropic(fake);
    await client.messages.create({ model: "claude-sonnet-4-6" });

    const run = parseTrace(readFileSync(file, "utf8")).get("r1")!;
    expect(run.llmCalls[0].model).toBe("claude-sonnet-4-6");
    expect(run.llmCalls[0].tokens?.output).toBe(60);
    expect(run.toolCalls[0].name).toBe("lookup_order");
  });

  it("rejects clients without the expected shape", () => {
    const rec = new Recorder({ file });
    expect(() => rec.wrapOpenAI({} as any)).toThrow("chat.completions.create");
    expect(() => rec.wrapAnthropic({} as any)).toThrow("messages.create");
  });
});

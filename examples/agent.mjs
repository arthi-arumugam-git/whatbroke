// Records a whatbroke trace of a tool-calling support agent against any
// OpenAI-compatible /chat/completions endpoint. No dependencies.
//
//   node agent.mjs --model qwen2.5:3b --base http://localhost:11434/v1 \
//                  --out traces/direct.jsonl --samples 3
//
// Point --base at a vendor's gateway/proxy instead to hold the model constant
// and measure what that layer changes.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const MODEL = arg("model", "llama3.2:3b");
const BASE = (arg("base", "http://localhost:11434/v1")).replace(/\/$/, "");
const OUT = arg("out", "traces/trace.jsonl");
const SAMPLES = Number(arg("samples", "3"));
const TEMPERATURE = Number(arg("temperature", "0.2"));
const STREAM = argv.includes("--stream");
const SEED = arg("seed") === undefined ? undefined : Number(arg("seed"));
const API_KEY = process.env.OPENAI_API_KEY ?? "ollama";
const MAX_TURNS = 6;

const ACCOUNT = {
  account_id: "AC-2214",
  email: "maya.iyer@example.com",
  name: "Maya Iyer",
  plan: "Team",
  monthly_usd: 29,
  status: "active",
};

const BILLING = [
  { invoice: "INV-9001", date: "2026-05-01", amount_usd: 29, status: "paid" },
  { invoice: "INV-9002", date: "2026-06-01", amount_usd: 29, status: "paid" },
  { invoice: "INV-9003", date: "2026-07-01", amount_usd: 29, status: "paid" },
  { invoice: "INV-9004", date: "2026-07-01", amount_usd: 29, status: "paid" },
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "lookup_account",
      description: "Look up a customer account by email address.",
      parameters: {
        type: "object",
        properties: { email: { type: "string", description: "Customer email address." } },
        required: ["email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_billing_history",
      description: "List invoices for an account.",
      parameters: {
        type: "object",
        properties: { account_id: { type: "string", description: "Account id, e.g. AC-2214." } },
        required: ["account_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_subscription",
      description:
        "Cancel the subscription on an account. Takes effect at the end of the billing period.",
      parameters: {
        type: "object",
        properties: { account_id: { type: "string", description: "Account id, e.g. AC-2214." } },
        required: ["account_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "issue_refund",
      description: "Refund an amount in USD to an account.",
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Account id, e.g. AC-2214." },
          amount: { type: "number", description: "Amount in USD." },
        },
        required: ["account_id", "amount"],
      },
    },
  },
];

function runTool(name, args) {
  switch (name) {
    case "lookup_account":
      return args?.email === ACCOUNT.email ? ACCOUNT : { error: "no account for that email" };
    case "get_billing_history":
      return args?.account_id === ACCOUNT.account_id
        ? { invoices: BILLING }
        : { error: "unknown account_id" };
    case "cancel_subscription":
      return args?.account_id === ACCOUNT.account_id
        ? { cancelled: true, effective: "2026-08-01" }
        : { error: "unknown account_id" };
    case "issue_refund":
      return args?.account_id === ACCOUNT.account_id
        ? { refunded: true, amount_usd: args?.amount }
        : { error: "unknown account_id" };
    default:
      return { error: `no such tool: ${name}` };
  }
}

const SYSTEM =
  "You are a support agent for a SaaS product. Use the tools to act on the customer's " +
  "account. Never claim an action succeeded unless the matching tool returned success. " +
  "The customer's email is maya.iyer@example.com.";

const SCENARIOS = [
  {
    id: "cancel-and-refund",
    prompt:
      "I want to cancel my subscription and get a refund for this month. I'm maya.iyer@example.com.",
  },
  {
    id: "billing-question",
    prompt: "How much have I been charged in the last three months? maya.iyer@example.com",
  },
  {
    id: "duplicate-charge",
    prompt:
      "I think I got charged twice on July 1st. Can you check and refund the extra one? maya.iyer@example.com",
  },
  { id: "cancel-only", prompt: "Please cancel my account. maya.iyer@example.com" },
];

const events = [];
const emit = (e) => events.push({ ...e, ts: Date.now() });

function parseArgs(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparsed: String(raw) };
  }
}

// Reassembles a streamed response into the same shape as a non-streamed one.
// Tool-call deltas are merged on the `index` field, which is where provider
// translation layers most often go wrong: if every delta reports index 0,
// parallel tool calls collapse into one malformed call.
async function readStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const acc = new Map();
  let content = "";
  let finish_reason;
  let model;
  let usage;
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish_reason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      for (const [position, call] of (delta.tool_calls ?? []).entries()) {
        const index = call.index ?? position;
        const existing = acc.get(index) ?? {
          id: call.id,
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.function.name = call.function.name;
        if (call.function?.arguments) existing.function.arguments += call.function.arguments;
        acc.set(index, existing);
      }
    }
  }

  const tool_calls = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return {
    model,
    usage,
    choices: [
      {
        finish_reason,
        message: {
          content,
          ...(tool_calls.length ? { tool_calls } : {}),
        },
      },
    ],
  };
}

async function chat(messages) {
  const started = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      temperature: TEMPERATURE,
      ...(SEED === undefined ? {} : { seed: SEED }),
      ...(STREAM ? { stream: true } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  if (STREAM) {
    const body = await readStream(res);
    return { body, latency_ms: Date.now() - started };
  }

  const text = await res.text();
  const latency_ms = Date.now() - started;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response: ${text.slice(0, 400)}`);
  }
  return { body, latency_ms };
}

async function runScenario(scenario, sample) {
  const run = SAMPLES > 1 ? `${scenario.id}#${sample}` : scenario.id;
  emit({ type: "run_start", run, meta: { model: MODEL, base: BASE, scenario: scenario.prompt } });

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: scenario.prompt },
  ];

  try {
    let final = "";
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { body, latency_ms } = await chat(messages);
      const choice = body.choices?.[0];
      const message = choice?.message ?? {};
      emit({
        type: "llm_call",
        run,
        model: body.model ?? MODEL,
        latency_ms,
        tokens: {
          input: body.usage?.prompt_tokens,
          output: body.usage?.completion_tokens,
        },
        stop_reason: choice?.finish_reason,
      });

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        final = typeof message.content === "string" ? message.content : "";
        break;
      }

      messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name ?? "unknown";
        const args = parseArgs(call.function?.arguments);
        const toolStarted = Date.now();
        const result = runTool(name, args);
        emit({
          type: "tool_call",
          run,
          name,
          args,
          latency_ms: Date.now() - toolStarted,
          ...(result && result.error ? { error: String(result.error) } : {}),
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    emit({ type: "output", run, content: final });
    emit({ type: "run_end", run, status: "ok" });
  } catch (err) {
    emit({ type: "run_end", run, status: "error", error: String(err.message ?? err) });
  }
}

for (let sample = 1; sample <= SAMPLES; sample++) {
  for (const scenario of SCENARIOS) {
    process.stderr.write(`  ${scenario.id} sample ${sample}\n`);
    await runScenario(scenario, sample);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
process.stderr.write(`wrote ${events.length} events to ${OUT}\n`);

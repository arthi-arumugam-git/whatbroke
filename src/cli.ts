#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import pc from "picocolors";
import { diffTraces } from "./diff.js";
import { importTrace } from "./import.js";
import type { ImportFormat } from "./import.js";
import { diffTracesSampled, hasSamples } from "./samples.js";
import { loadTrace } from "./parse.js";
import { startProxy } from "./proxy.js";
import { renderMarkdown, renderTerminal } from "./report.js";

const HELP = `whatbroke - diff your AI agent's behavior between two runs

usage:
  whatbroke diff <before.jsonl> <after.jsonl> [options]
  whatbroke import <trace-export> [options]
  whatbroke record --out <trace.jsonl> [options]

diff options:
  --json              machine-readable output
  --md                markdown output (drop it in a PR comment)
  --fail-on <level>   exit 1 on: breaking (default), warning, never
  --latency <ratio>   flag latency regressions above this ratio (default 1.5)
  --cost <ratio>      flag cost increases above this ratio (default 1.25)
  --no-outputs        skip comparing final outputs

import options:
  -o, --out <file>    converted trace to write (default: <input>.whatbroke.jsonl)
  --format <name>     otel | langfuse | langsmith (default: detect from the file)
  --run <name>        base run name (default: derived from the source)

import converts traces you already have into whatbroke JSONL: OTLP JSON span
exports (anything emitting the OTel GenAI conventions, including the Vercel
AI SDK), Langfuse export rows, and LangSmith run dumps.

record options:
  --out <file>        trace file to write (required)
  --port <n>          port to listen on (default 4141)
  --run <name>        run id when no x-whatbroke-run header is sent
  --target <url>      forward everything to this origin instead

record starts a local proxy. point your agent at it and run it unchanged:
  OPENAI_BASE_URL=http://127.0.0.1:4141/v1     (openai sdk)
  ANTHROPIC_BASE_URL=http://127.0.0.1:4141     (anthropic sdk)
stop it with ctrl-c, then diff the trace against a baseline.

nondeterministic agent? record each scenario a few times as name#1, name#2, ...
and diff will report a flap rate per finding instead of noise.

trace format: one JSON event per line
  {"type":"run_start","run":"refund-flow","meta":{"model":"gpt-4o"}}
  {"type":"llm_call","run":"refund-flow","model":"gpt-4o","latency_ms":900,"tokens":{"input":512,"output":128}}
  {"type":"tool_call","run":"refund-flow","name":"lookup_order","args":{"order_id":"A-1042"}}
  {"type":"output","run":"refund-flow","content":"Refund issued."}
  {"type":"run_end","run":"refund-flow","status":"ok"}

you can also record with the SDK (import { Recorder } from "whatbroke") or write
the JSONL yourself from any language. Full docs: https://github.com/arthi-arumugam-git/whatbroke
`;

function fail(message: string): never {
  console.error(pc.red(`whatbroke: ${message}`));
  console.error(pc.dim(`try: whatbroke --help`));
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }

  const command = argv[0];
  if (command === "record") {
    runRecord(argv.slice(1));
    return;
  }
  if (command === "import") {
    runImport(argv.slice(1));
    return;
  }
  if (command !== "diff") fail(`unknown command: ${command}`);

  const positional: string[] = [];
  let format: "terminal" | "json" | "md" = "terminal";
  let failOn: "breaking" | "warning" | "never" = "breaking";
  let latencyThreshold = 1.5;
  let costThreshold = 1.25;
  let compareOutputs = true;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        format = "json";
        break;
      case "--md":
        format = "md";
        break;
      case "--no-outputs":
        compareOutputs = false;
        break;
      case "--fail-on": {
        const value = argv[++i];
        if (value !== "breaking" && value !== "warning" && value !== "never") {
          fail(`--fail-on must be breaking, warning, or never`);
        }
        failOn = value;
        break;
      }
      case "--latency": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value <= 0) fail(`--latency needs a positive number`);
        latencyThreshold = value;
        break;
      }
      case "--cost": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value <= 0) fail(`--cost needs a positive number`);
        costThreshold = value;
        break;
      }
      default:
        if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  if (positional.length !== 2) {
    fail("diff needs exactly two trace files: whatbroke diff before.jsonl after.jsonl");
  }

  let result;
  try {
    const before = loadTrace(positional[0]);
    const after = loadTrace(positional[1]);
    const options = { latencyThreshold, costThreshold, compareOutputs };
    result =
      hasSamples(before) || hasSamples(after)
        ? diffTracesSampled(before, after, options)
        : diffTraces(before, after, options);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else if (format === "md") {
    console.log(renderMarkdown(result));
  } else {
    console.log(renderTerminal(result));
  }

  const shouldFail =
    (failOn === "breaking" && result.breaking > 0) ||
    (failOn === "warning" && (result.breaking > 0 || result.warnings > 0));
  process.exit(shouldFail ? 1 : 0);
}

function runImport(argv: string[]): void {
  const positional: string[] = [];
  let out = "";
  let format: ImportFormat | undefined;
  let run: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-o":
      case "--out":
        out = argv[++i] ?? "";
        break;
      case "--format": {
        const value = argv[++i];
        if (value !== "otel" && value !== "langfuse" && value !== "langsmith") {
          fail(`--format must be otel, langfuse, or langsmith`);
        }
        format = value;
        break;
      }
      case "--run":
        run = argv[++i];
        break;
      default:
        if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    fail("import needs exactly one input file: whatbroke import trace-export.json");
  }
  const input = positional[0];
  if (!out) {
    const base = basename(input, extname(input));
    out = join(dirname(input), `${base}.whatbroke.jsonl`);
  }

  let text: string;
  try {
    text = readFileSync(input, "utf8");
  } catch {
    fail(`could not read input file: ${input}`);
  }

  let result;
  try {
    result = importTrace(text, format, { run });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  writeFileSync(out, result.events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  for (const warning of result.warnings) {
    console.error(pc.yellow(`  note: ${warning}`));
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  console.log(
    `imported ${plural(result.runs, "run")}, ${plural(result.llmCalls, "llm call")}, ${plural(result.toolCalls, "tool call")} -> ${out}`,
  );
  if (result.missing.length) {
    console.log(pc.dim(`  not in the source: ${result.missing.join(", ")}`));
  }
}

function runRecord(argv: string[]): void {
  let out = "";
  let port = 4141;
  let run: string | undefined;
  let target: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--out":
        out = argv[++i] ?? "";
        break;
      case "--port": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          fail(`--port needs a number between 0 and 65535`);
        }
        port = value;
        break;
      }
      case "--run":
        run = argv[++i];
        break;
      case "--target":
        target = argv[++i];
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  if (!out) fail("record needs --out <trace.jsonl>");

  startProxy({
    file: out,
    port,
    run,
    target,
    onRecord: (runId, model, toolNames) => {
      const tools = toolNames.length ? ` -> ${toolNames.join(", ")}` : "";
      console.log(pc.dim(`  [${runId}] ${model}${tools}`));
    },
  })
    .then((proxy) => {
      console.log(`recording to ${out}`);
      console.log(pc.dim(`  OPENAI_BASE_URL=${proxy.url}/v1`));
      console.log(pc.dim(`  ANTHROPIC_BASE_URL=${proxy.url}`));
      console.log(pc.dim("  ctrl-c to stop"));
      console.log("");
      process.on("SIGINT", () => {
        proxy.close().finally(() => process.exit(0));
      });
    })
    .catch((err) => {
      fail(err instanceof Error ? err.message : String(err));
    });
}

main();

#!/usr/bin/env node
import pc from "picocolors";
import { diffTraces } from "./diff.js";
import { loadTrace } from "./parse.js";
import { renderMarkdown, renderTerminal } from "./report.js";

const HELP = `whatbroke - diff your AI agent's behavior between two runs

usage:
  whatbroke diff <before.jsonl> <after.jsonl> [options]

options:
  --json              machine-readable output
  --md                markdown output (drop it in a PR comment)
  --fail-on <level>   exit 1 on: breaking (default), warning, never
  --latency <ratio>   flag latency regressions above this ratio (default 1.5)
  --cost <ratio>      flag cost increases above this ratio (default 1.25)
  --no-outputs        skip comparing final outputs
  -h, --help          show this

trace format: one JSON event per line
  {"type":"run_start","run":"refund-flow","meta":{"model":"gpt-4o"}}
  {"type":"llm_call","run":"refund-flow","model":"gpt-4o","latency_ms":900,"tokens":{"input":512,"output":128}}
  {"type":"tool_call","run":"refund-flow","name":"lookup_order","args":{"order_id":"A-1042"}}
  {"type":"output","run":"refund-flow","content":"Refund issued."}
  {"type":"run_end","run":"refund-flow","status":"ok"}

record traces with the SDK (import { Recorder } from "whatbroke") or write
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
    result = diffTraces(before, after, { latencyThreshold, costThreshold, compareOutputs });
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

main();

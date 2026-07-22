import { readFileSync } from "node:fs";
import type { Run, TraceEvent } from "./types.js";

export function parseTrace(text: string): Map<string, Run> {
  const runs = new Map<string, Run>();

  const get = (id: string): Run => {
    let run = runs.get(id);
    if (!run) {
      run = {
        id,
        meta: {},
        llmCalls: [],
        toolCalls: [],
        outputs: [],
        status: "unknown",
      };
      runs.set(id, run);
    }
    return run;
  };

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let event: TraceEvent;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSON on line ${i + 1}`);
    }
    if (!event || typeof event !== "object" || !("type" in event)) {
      throw new Error(`line ${i + 1} is not a trace event (missing "type")`);
    }
    const runId = "run" in event && event.run ? String(event.run) : "default";
    const run = get(runId);

    switch (event.type) {
      case "run_start":
        run.meta = { ...run.meta, ...event.meta };
        break;
      case "llm_call":
        run.llmCalls.push(event);
        break;
      case "tool_call":
        run.toolCalls.push(event);
        break;
      case "output":
        run.outputs.push(event);
        break;
      case "run_end":
        run.status = event.status;
        if (event.error) run.error = event.error;
        break;
      default:
        // unknown event types are skipped so old CLIs can read newer traces
        break;
    }
  }

  // runs that logged activity but no run_end are treated as ok
  for (const run of runs.values()) {
    if (run.status === "unknown" && (run.llmCalls.length || run.toolCalls.length || run.outputs.length)) {
      run.status = "ok";
    }
  }

  return runs;
}

export function loadTrace(path: string): Map<string, Run> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`could not read trace file: ${path}`);
  }
  try {
    return parseTrace(text);
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

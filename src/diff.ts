import type {
  DiffOptions,
  DiffResult,
  Finding,
  Run,
  RunDiff,
  RunStats,
  ToolCallEvent,
} from "./types.js";

function stats(run: Run): RunStats {
  const models = [...new Set(run.llmCalls.map((c) => c.model))];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let latencyMs = 0;
  for (const c of run.llmCalls) {
    inputTokens += c.tokens?.input ?? 0;
    outputTokens += c.tokens?.output ?? 0;
    costUsd += c.cost_usd ?? 0;
    latencyMs += c.latency_ms ?? 0;
  }
  for (const t of run.toolCalls) {
    latencyMs += t.latency_ms ?? 0;
  }
  return {
    llmCalls: run.llmCalls.length,
    toolCalls: run.toolCalls.length,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    models,
  };
}

/** longest common subsequence over tool names; returns aligned index pairs */
function alignTools(a: ToolCallEvent[], b: ToolCallEvent[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i].name === b[j].name
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].name === b[j].name) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function changedKeys(
  before: Record<string, unknown> = {},
  after: Record<string, unknown> = {},
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }
  return changed;
}

function diffRun(runId: string, before: Run, after: Run, opts: Required<DiffOptions>): RunDiff {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  // status
  if (before.status === "ok" && after.status === "error") {
    add({
      severity: "breaking",
      kind: "status_changed",
      run: runId,
      message: `run now fails${after.error ? `: ${after.error}` : ""}`,
    });
  } else if (before.status === "error" && after.status === "ok") {
    add({
      severity: "info",
      kind: "status_changed",
      run: runId,
      message: "run now succeeds (was failing)",
    });
  }

  // model change
  const sBefore = stats(before);
  const sAfter = stats(after);
  if (
    sBefore.models.length &&
    sAfter.models.length &&
    sBefore.models.join(",") !== sAfter.models.join(",")
  ) {
    add({
      severity: "info",
      kind: "model_changed",
      run: runId,
      message: `model: ${sBefore.models.join(", ")} -> ${sAfter.models.join(", ")}`,
    });
  }

  // tool call errors that are new
  const beforeErrors = new Set(before.toolCalls.filter((t) => t.error).map((t) => t.name));
  for (const t of after.toolCalls) {
    if (t.error && !beforeErrors.has(t.name)) {
      add({
        severity: "breaking",
        kind: "tool_error",
        run: runId,
        message: `tool ${t.name} now errors: ${t.error}`,
      });
    }
  }

  // tool sequence. Same set of tools in a different order is a reorder,
  // not a remove + add, so check the name multiset first.
  const orderBefore = before.toolCalls.map((t) => t.name).join(" > ");
  const orderAfter = after.toolCalls.map((t) => t.name).join(" > ");
  const sameToolSet =
    [...before.toolCalls.map((t) => t.name)].sort().join("\n") ===
    [...after.toolCalls.map((t) => t.name)].sort().join("\n");

  let pairs: Array<[number, number]>;
  if (sameToolSet) {
    if (orderBefore !== orderAfter) {
      add({
        severity: "warning",
        kind: "tool_reordered",
        run: runId,
        message: `tool order changed: ${orderBefore} -> ${orderAfter}`,
      });
    }
    // match calls by nth occurrence of each name so args still get compared
    pairs = [];
    const seen = new Map<string, number>();
    for (let i = 0; i < before.toolCalls.length; i++) {
      const name = before.toolCalls[i].name;
      const nth = seen.get(name) ?? 0;
      seen.set(name, nth + 1);
      let count = 0;
      for (let j = 0; j < after.toolCalls.length; j++) {
        if (after.toolCalls[j].name === name && count++ === nth) {
          pairs.push([i, j]);
          break;
        }
      }
    }
  } else {
    pairs = alignTools(before.toolCalls, after.toolCalls);
    const matchedBefore = new Set(pairs.map(([i]) => i));
    const matchedAfter = new Set(pairs.map(([, j]) => j));

    for (let i = 0; i < before.toolCalls.length; i++) {
      if (!matchedBefore.has(i)) {
        add({
          severity: "breaking",
          kind: "tool_removed",
          run: runId,
          message: `tool call dropped: ${before.toolCalls[i].name}`,
          detail: { args: before.toolCalls[i].args },
        });
      }
    }
    for (let j = 0; j < after.toolCalls.length; j++) {
      if (!matchedAfter.has(j)) {
        add({
          severity: "warning",
          kind: "tool_added",
          run: runId,
          message: `new tool call: ${after.toolCalls[j].name}`,
          detail: { args: after.toolCalls[j].args },
        });
      }
    }
  }

  for (const [i, j] of pairs) {
    const keys = changedKeys(before.toolCalls[i].args, after.toolCalls[j].args);
    if (keys.length) {
      add({
        severity: "warning",
        kind: "tool_args_changed",
        run: runId,
        message: `${before.toolCalls[i].name} called with different args (${keys.join(", ")})`,
        detail: {
          tool: before.toolCalls[i].name,
          before: pick(before.toolCalls[i].args, keys),
          after: pick(after.toolCalls[j].args, keys),
        },
      });
    }
  }

  // outputs
  if (opts.compareOutputs) {
    const outBefore = before.outputs.map((o) => o.content).join("\n");
    const outAfter = after.outputs.map((o) => o.content).join("\n");
    if (outBefore && !outAfter) {
      add({
        severity: "breaking",
        kind: "output_missing",
        run: runId,
        message: "run no longer produces an output",
      });
    } else if (outBefore !== outAfter) {
      add({
        severity: "warning",
        kind: "output_changed",
        run: runId,
        message: "final output changed",
        detail: { before: truncate(outBefore), after: truncate(outAfter) },
      });
    }
  }

  // latency
  if (sBefore.latencyMs > 0 && sAfter.latencyMs > sBefore.latencyMs * opts.latencyThreshold) {
    const pct = Math.round((sAfter.latencyMs / sBefore.latencyMs - 1) * 100);
    add({
      severity: "warning",
      kind: "latency_regression",
      run: runId,
      message: `latency up ${pct}% (${fmtMs(sBefore.latencyMs)} -> ${fmtMs(sAfter.latencyMs)})`,
    });
  }

  // cost
  if (sBefore.costUsd > 0 && sAfter.costUsd > sBefore.costUsd * opts.costThreshold) {
    const pct = Math.round((sAfter.costUsd / sBefore.costUsd - 1) * 100);
    add({
      severity: "warning",
      kind: "cost_increase",
      run: runId,
      message: `cost up ${pct}% ($${sBefore.costUsd.toFixed(4)} -> $${sAfter.costUsd.toFixed(4)})`,
    });
  }

  // tokens, only worth reporting if nothing else explains it and the swing is large
  const tokBefore = sBefore.inputTokens + sBefore.outputTokens;
  const tokAfter = sAfter.inputTokens + sAfter.outputTokens;
  if (tokBefore > 0 && (tokAfter > tokBefore * 2 || tokAfter < tokBefore * 0.5)) {
    add({
      severity: "info",
      kind: "token_change",
      run: runId,
      message: `total tokens ${tokBefore} -> ${tokAfter}`,
    });
  }

  return { run: runId, findings, before: sBefore, after: sAfter };
}

function pick(
  obj: Record<string, unknown> = {},
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

function truncate(s: string, max = 300): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function diffTraces(
  before: Map<string, Run>,
  after: Map<string, Run>,
  options: DiffOptions = {},
): DiffResult {
  const opts: Required<DiffOptions> = {
    latencyThreshold: options.latencyThreshold ?? 1.5,
    costThreshold: options.costThreshold ?? 1.25,
    compareOutputs: options.compareOutputs ?? true,
  };

  const runDiffs: RunDiff[] = [];
  const allRuns = new Set([...before.keys(), ...after.keys()]);

  for (const id of allRuns) {
    const a = before.get(id);
    const b = after.get(id);
    if (a && !b) {
      runDiffs.push({
        run: id,
        findings: [
          {
            severity: "breaking",
            kind: "run_missing",
            run: id,
            message: "run missing from the new trace",
          },
        ],
        before: stats(a),
      });
    } else if (!a && b) {
      runDiffs.push({
        run: id,
        findings: [
          {
            severity: "info",
            kind: "run_added",
            run: id,
            message: "new run, nothing to compare against",
          },
        ],
        after: stats(b),
      });
    } else if (a && b) {
      runDiffs.push(diffRun(id, a, b, opts));
    }
  }

  const findings = runDiffs.flatMap((r) => r.findings);
  return {
    runs: runDiffs,
    findings,
    breaking: findings.filter((f) => f.severity === "breaking").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
}

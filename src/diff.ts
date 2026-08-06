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
      subject: "status",
      run: runId,
      message: `run now fails${after.error ? `: ${after.error}` : ""}`,
    });
  } else if (before.status === "error" && after.status === "ok") {
    add({
      severity: "info",
      kind: "status_changed",
      subject: "status",
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
      subject: "model",
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
        subject: t.name,
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
        subject: "tool-order",
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
          subject: before.toolCalls[i].name,
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
          subject: after.toolCalls[j].name,
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
        subject: before.toolCalls[i].name,
        run: runId,
        message: `${before.toolCalls[i].name} called with different args (${keys.join(", ")})`,
        detail: {
          tool: before.toolCalls[i].name,
          before: pick(before.toolCalls[i].args, keys),
          after: pick(after.toolCalls[j].args, keys),
        },
      });
    }
    const resultBefore = before.toolCalls[i].result;
    const resultAfter = after.toolCalls[j].result;
    if (resultBefore !== undefined && resultAfter !== undefined && resultBefore !== resultAfter) {
      add({
        severity: "warning",
        kind: "tool_result_changed",
        subject: `tool_result:${before.toolCalls[i].name}`,
        run: runId,
        message: `${before.toolCalls[i].name} returned a different result`,
        detail: {
          tool: before.toolCalls[i].name,
          before: truncate(resultBefore),
          after: truncate(resultAfter),
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
        subject: "output",
        run: runId,
        message: "run no longer produces an output",
      });
    } else if (outBefore !== outAfter) {
      add({
        severity: "warning",
        kind: "output_changed",
        subject: "output",
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
      subject: "latency",
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
      subject: "cost",
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
      subject: "tokens",
      run: runId,
      message: `total tokens ${tokBefore} -> ${tokAfter}`,
    });
  }

  // Prompt, last so it can see what else moved, then hoisted to the front so it reads as the
  // cause rather than another symptom. Users already suspect the prompt; the useful part is
  // saying which of the changes below it plausibly accounts for.
  const promptFindings: Finding[] = [];
  const calls = Math.min(before.llmCalls.length, after.llmCalls.length);
  for (let i = 0; i < calls; i++) {
    const promptBefore = before.llmCalls[i].prompt;
    const promptAfter = after.llmCalls[i].prompt;
    // one side missing means the trace never captured it, which is not evidence of no change
    if (promptBefore === undefined || promptAfter === undefined) continue;
    if (promptBefore === promptAfter) continue;
    const explains = [
      ...new Set(
        findings
          .filter((f) => PROMPT_CAN_EXPLAIN.has(f.kind) && f.subject)
          .map((f) => f.subject as string),
      ),
    ];
    const excerpts = promptExcerpts(promptBefore, promptAfter);
    const detail: Record<string, unknown> = {
      call: i + 1,
      before: excerpts.before,
      after: excerpts.after,
    };
    if (explains.length) detail.explains = explains;
    const notes: string[] = [];
    const shape = differenceShape(promptBefore, promptAfter);
    if (shape) notes.push(shape);
    // prompts are paired by position, so a run that gained or lost a call may have shifted
    // every pair after it. Say so rather than let the reader trust the pairing
    if (before.llmCalls.length !== after.llmCalls.length) {
      notes.push(
        `${before.llmCalls.length} -> ${after.llmCalls.length} llm calls, matched by position`,
      );
    }
    if (explains.length) notes.push(`plausibly explains: ${explains.join(", ")}`);
    promptFindings.push({
      severity: "warning",
      kind: "prompt_changed",
      subject: "prompt",
      run: runId,
      message: notes.length ? `prompt changed (${notes.join("; ")})` : "prompt changed",
      detail,
    });
  }
  findings.unshift(...promptFindings);

  return { run: runId, findings, before: sBefore, after: sAfter };
}

/**
 * Changes a prompt edit can plausibly cause. Deliberately excludes tool_result_changed, which
 * is the tool or the world answering differently, and the cost/latency/token findings, which
 * follow from the others rather than from the prompt directly.
 */
const PROMPT_CAN_EXPLAIN = new Set<Finding["kind"]>([
  "tool_added",
  "tool_removed",
  "tool_reordered",
  "tool_args_changed",
  "output_changed",
  "output_missing",
]);

/**
 * Both sides of a prompt change, cut down to the part that differs.
 *
 * Showing the head of each side is no use here: a system prompt runs to thousands of
 * characters and the edit is rarely at the top, so the report would print two identical
 * looking lines under a finding that says something changed.
 */
function promptExcerpts(before: string, after: string): { before: string; after: string } {
  // one line per side, or the - and + gutters stop lining up: prompts are nearly always
  // multi-line, and this is display text already, not the prompt itself
  const a = oneLine(before);
  const b = oneLine(after);
  const shortest = Math.min(a.length, b.length);
  let at = 0;
  while (at < shortest && a[at] === b[at]) at++;
  // keep a little of the text they still share, so the excerpt has somewhere to stand
  const from = Math.max(0, at - PROMPT_EXCERPT_LEAD);
  return { before: excerpt(a, from), after: excerpt(b, from) };
}

function oneLine(s: string): string {
  return s.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

const PROMPT_EXCERPT_LEAD = 40;
const PROMPT_EXCERPT_WIDTH = 160;

function excerpt(s: string, from: number): string {
  const start = backOffSurrogate(s, from);
  let end = Math.min(s.length, start + PROMPT_EXCERPT_WIDTH);
  end = backOffSurrogate(s, end);
  return (start > 0 ? "…" : "") + s.slice(start, end) + (end < s.length ? "…" : "");
}

/** never cut through a surrogate pair, which would print as a replacement character */
function backOffSurrogate(s: string, i: number): number {
  const code = s.charCodeAt(i);
  return i > 0 && i < s.length && code >= 0xdc00 && code <= 0xdfff ? i - 1 : i;
}

/**
 * Why two prompts that differ can still print the same. Saying "prompt changed" above two
 * lines a reader cannot tell apart looks like a bug in the tool, so name the reason instead.
 * Both cases are real changes: whitespace and normal form both move the tokens.
 */
function differenceShape(before: string, after: string): string | undefined {
  if (before.normalize("NFC") === after.normalize("NFC")) return "unicode normalisation only";
  if (collapseSpace(before) === collapseSpace(after)) return "whitespace only";
  return undefined;
}

function collapseSpace(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
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
            subject: "run",
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
            subject: "run",
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

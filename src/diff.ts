import type {
  DiffOptions,
  DiffResult,
  Finding,
  LlmCallEvent,
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

/** longest common subsequence over keys; returns aligned index pairs */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
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

function alignTools(a: ToolCallEvent[], b: ToolCallEvent[]): Array<[number, number]> {
  return lcsPairs(
    a.map((t) => t.name),
    b.map((t) => t.name),
  );
}

/**
 * Align the llm calls of two runs.
 *
 * Pairing by index is wrong the moment a run gains or loses a call: everything after the
 * insertion shifts by one, and a prompt diff over those pairs reports a run of edits that
 * nobody made. So identical prompts anchor the alignment first, exactly as a text diff
 * anchors on identical lines, and only the calls between two anchors are matched by
 * similarity. A call left over in a gap is one that appeared or vanished.
 *
 * A call with no prompt can only be told apart by its model, which is usually the same for
 * every call in the run. The alignment then degrades to order, and the findings say so.
 */
function alignLlmCalls(a: LlmCallEvent[], b: LlmCallEvent[]): Array<[number, number]> {
  const anchors = lcsPairs(a.map(callKey), b.map(callKey));
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  // the sentinel closes the gap after the last anchor
  for (const [ai, aj] of [...anchors, [a.length, b.length] as [number, number]]) {
    pairs.push(...alignGap(a, b, i, ai, j, aj));
    if (ai < a.length && aj < b.length) pairs.push([ai, aj]);
    i = ai + 1;
    j = aj + 1;
  }
  return pairs;
}

/** what makes two llm calls the same call. The prompt when there is one, the model otherwise */
function callKey(call: LlmCallEvent): string {
  return call.prompt === undefined ? `model:${call.model}` : `prompt:${call.prompt}`;
}

/**
 * Match the calls between two anchors. Nothing in here is identical, so pairs are chosen to
 * maximise total similarity, and a call is only left unpaired when pairing it would score
 * worse than admitting it has no counterpart.
 */
function alignGap(
  a: LlmCallEvent[],
  b: LlmCallEvent[],
  i0: number,
  i1: number,
  j0: number,
  j1: number,
): Array<[number, number]> {
  const n = i1 - i0;
  const m = j1 - j0;
  if (n <= 0 || m <= 0) return [];
  // every prompt is split once and every pair scored once: prompts run to thousands of words
  // and the table below reads each cell twice
  const wordsBefore = a
    .slice(i0, i1)
    .map((c) => (c.prompt === undefined ? undefined : words(c.prompt)));
  const wordsAfter = b
    .slice(j0, j1)
    .map((c) => (c.prompt === undefined ? undefined : words(c.prompt)));
  const sims: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => {
      const wa = wordsBefore[i];
      const wb = wordsAfter[j];
      // with no prompt on one side, the model is the only thing left to compare
      if (!wa || !wb) return a[i0 + i].model === b[j0 + j].model ? 1 : 0;
      return overlap(wa, wb);
    }),
  );
  const sim = (i: number, j: number) => sims[i][j];
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n && j === m) continue;
      if (i === n) dp[i][j] = dp[i][j + 1] - UNPAIRED_CALL_PENALTY;
      else if (j === m) dp[i][j] = dp[i + 1][j] - UNPAIRED_CALL_PENALTY;
      else
        dp[i][j] = Math.max(
          sim(i, j) + dp[i + 1][j + 1],
          dp[i + 1][j] - UNPAIRED_CALL_PENALTY,
          dp[i][j + 1] - UNPAIRED_CALL_PENALTY,
        );
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const paired = sim(i, j) + dp[i + 1][j + 1];
    // ties go to the pair, which keeps calls the aligner cannot tell apart in their own order
    if (
      paired >= dp[i + 1][j] - UNPAIRED_CALL_PENALTY &&
      paired >= dp[i][j + 1] - UNPAIRED_CALL_PENALTY
    ) {
      pairs.push([i0 + i, j0 + j]);
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

/**
 * What it costs to say a call has no counterpart. Two of these are spent to leave a pair
 * unpaired, so a pair whose prompts have more than a fifth of their words in common is kept
 * as one changed call rather than reported as a drop and an add.
 */
const UNPAIRED_CALL_PENALTY = 0.1;

/**
 * How much two prompts have in common, 0 to 1, by shared words. This only decides which calls
 * to pair. What gets reported as changed is always the exact text.
 */
function overlap(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const pool = new Map<string, number>();
  for (const w of a) pool.set(w, (pool.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of b) {
    const left = pool.get(w) ?? 0;
    if (left > 0) {
      shared++;
      pool.set(w, left - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

function words(s: string): string[] {
  return s.toLowerCase().split(/\s+/).filter(Boolean);
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

  // Structure and prompt, computed last so they can see what else moved, then hoisted to the
  // front so they read as causes rather than more symptoms. Structure goes above the prompt
  // findings because it decides which prompt was compared with which.
  const pairedCalls = alignLlmCalls(before.llmCalls, after.llmCalls);
  const beforeCalls = before.llmCalls.length;
  const afterCalls = after.llmCalls.length;
  // With no prompt on either side the aligner has only the model to go on, and every call in a
  // run usually runs the same model. The position it reports is then the order the calls
  // arrived in, which is a weaker claim than "this is the call that appeared"
  const byArrivalOrder =
    !before.llmCalls.some((c) => c.prompt !== undefined) ||
    !after.llmCalls.some((c) => c.prompt !== undefined);

  const structureFindings: Finding[] = [];
  // A run with no llm calls on one side has not told us the agent stopped calling the model,
  // it has told us the trace did not carry them. Reporting every call as dropped would be the
  // capture's gap printed as the agent's behavior.
  if (beforeCalls && afterCalls) {
    // A call that appeared or vanished accounts for the run's model list moving only if the
    // list would have held without it. A run that swapped every call to a new model moved that
    // list on its own, and blaming the one dropped call for it would be a false cause
    const modelsWithout = (calls: LlmCallEvent[], skip: number) =>
      [...new Set(calls.filter((_, k) => k !== skip).map((c) => c.model))].join(",");
    const structureExplains = (explainsModel: boolean) =>
      explainedBy(
        findings.filter((f) => f.kind !== "model_changed" || explainsModel),
        STRUCTURE_CAN_EXPLAIN,
      );
    const notes = (position: number, of: number, explains: string[]) => {
      const parts = [`position ${position} of ${of}`];
      if (byArrivalOrder) parts.push("matched by position: the trace did not capture prompts");
      if (explains.length) parts.push(`plausibly explains: ${explains.join(", ")}`);
      return parts.join("; ");
    };
    const structureDetail = (
      position: number,
      of: number,
      explains: string[],
    ): Record<string, unknown> => {
      const detail: Record<string, unknown> = { call: position, of };
      if (explains.length) detail.explains = explains;
      return detail;
    };

    const pairedBefore = new Set(pairedCalls.map(([i]) => i));
    const pairedAfter = new Set(pairedCalls.map(([, j]) => j));
    for (let i = 0; i < beforeCalls; i++) {
      if (pairedBefore.has(i)) continue;
      const call = before.llmCalls[i];
      const heldTheModel = modelsWithout(before.llmCalls, i) === sAfter.models.join(",");
      const explains = structureExplains(heldTheModel);
      const detail = structureDetail(i + 1, beforeCalls, explains);
      if (call.prompt !== undefined) detail.before = truncate(oneLine(call.prompt));
      structureFindings.push({
        severity: "warning",
        kind: "llm_call_removed",
        subject: `llm_call:${call.model}`,
        run: runId,
        message: `llm call dropped: ${call.model} (${notes(i + 1, beforeCalls, explains)})`,
        detail,
      });
    }
    for (let j = 0; j < afterCalls; j++) {
      if (pairedAfter.has(j)) continue;
      const call = after.llmCalls[j];
      const broughtTheModel = modelsWithout(after.llmCalls, j) === sBefore.models.join(",");
      const explains = structureExplains(broughtTheModel);
      const detail = structureDetail(j + 1, afterCalls, explains);
      if (call.prompt !== undefined) detail.after = truncate(oneLine(call.prompt));
      structureFindings.push({
        severity: "warning",
        kind: "llm_call_added",
        subject: `llm_call:${call.model}`,
        run: runId,
        message: `new llm call: ${call.model} (${notes(j + 1, afterCalls, explains)})`,
        detail,
      });
    }

    // A run that swapped model everywhere is already one model_changed finding above. Saying
    // it again once per call turns one fact into several and names nothing new. It is worth a
    // finding when only some calls moved, because then the run-level one cannot say which
    const swaps = pairedCalls.filter(
      ([i, j]) => before.llmCalls[i].model !== after.llmCalls[j].model,
    );
    if (swaps.length && swaps.length < pairedCalls.length) {
      for (const [i, j] of swaps) {
        structureFindings.push({
          severity: "info",
          kind: "llm_call_changed",
          subject: `llm_call_model:${before.llmCalls[i].model}`,
          run: runId,
          message:
            `llm call ${j + 1} of ${afterCalls} changed model: ` +
            `${before.llmCalls[i].model} -> ${after.llmCalls[j].model}`,
          detail: {
            call: j + 1,
            of: afterCalls,
            before: before.llmCalls[i].model,
            after: after.llmCalls[j].model,
          },
        });
      }
    }
  }

  // Users already suspect the prompt; the useful part is saying which of the changes below it
  // plausibly accounts for.
  const promptFindings: Finding[] = [];
  for (const [i, j] of pairedCalls) {
    const promptBefore = before.llmCalls[i].prompt;
    const promptAfter = after.llmCalls[j].prompt;
    // one side missing means the trace never captured it, which is not evidence of no change
    if (promptBefore === undefined || promptAfter === undefined) continue;
    if (promptBefore === promptAfter) continue;
    const explains = explainedBy(findings, PROMPT_CAN_EXPLAIN);
    const excerpts = promptExcerpts(promptBefore, promptAfter);
    const detail: Record<string, unknown> = {
      call: j + 1,
      before: excerpts.before,
      after: excerpts.after,
    };
    if (i !== j) detail.baselineCall = i + 1;
    if (explains.length) detail.explains = explains;
    const notes: string[] = [];
    const shape = differenceShape(promptBefore, promptAfter);
    if (shape) notes.push(shape);
    // the call moved, so the reader cannot assume this is the same step in the same place
    if (i !== j) notes.push(`baseline call ${i + 1} is now call ${j + 1}`);
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
  findings.unshift(...structureFindings);

  return { run: runId, findings, before: sBefore, after: sAfter };
}

/** the subjects of the findings a cause of this kind can be offered as an explanation for */
function explainedBy(findings: Finding[], kinds: Set<Finding["kind"]>): string[] {
  return [
    ...new Set(
      findings.filter((f) => kinds.has(f.kind) && f.subject).map((f) => f.subject as string),
    ),
  ];
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
 * Changes a call appearing or vanishing can plausibly cause. Everything a prompt edit can
 * cause, plus the meters: a call the run did not make before brings its own tokens, its own
 * cost and its own latency with it, and a new call on a different model is why the run's model
 * list moved.
 */
const STRUCTURE_CAN_EXPLAIN = new Set<Finding["kind"]>([
  ...PROMPT_CAN_EXPLAIN,
  "latency_regression",
  "cost_increase",
  "token_change",
  "model_changed",
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

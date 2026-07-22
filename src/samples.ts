import { diffTraces } from "./diff.js";
import type {
  DiffOptions,
  DiffResult,
  Finding,
  Run,
  RunDiff,
  RunStats,
} from "./types.js";

const SAMPLE_RE = /^(.+)#(\d+)$/;

export function hasSamples(runs: Map<string, Run>): boolean {
  for (const id of runs.keys()) if (SAMPLE_RE.test(id)) return true;
  return false;
}

function groupSamples(runs: Map<string, Run>): Map<string, Run[]> {
  const groups = new Map<string, Run[]>();
  for (const [id, run] of runs) {
    const match = SAMPLE_RE.exec(id);
    const base = match ? match[1] : id;
    const list = groups.get(base) ?? [];
    list.push(run);
    groups.set(base, list);
  }
  return groups;
}

function findingKey(f: Finding): string {
  return `${f.kind}:${f.subject ?? f.message}`;
}

function pairFindings(a: Run, b: Run, base: string, options: DiffOptions): Finding[] {
  const result = diffTraces(new Map([[base, a]]), new Map([[base, b]]), options);
  return result.findings;
}

function meanStats(samples: RunStats[]): RunStats | undefined {
  if (!samples.length) return undefined;
  const n = samples.length;
  const sum = (fn: (s: RunStats) => number) => samples.reduce((t, s) => t + fn(s), 0);
  return {
    llmCalls: Math.round(sum((s) => s.llmCalls) / n),
    toolCalls: Math.round(sum((s) => s.toolCalls) / n),
    inputTokens: Math.round(sum((s) => s.inputTokens) / n),
    outputTokens: Math.round(sum((s) => s.outputTokens) / n),
    costUsd: sum((s) => s.costUsd) / n,
    latencyMs: sum((s) => s.latencyMs) / n,
    models: [...new Set(samples.flatMap((s) => s.models))],
  };
}

function statsOf(run: Run, options: DiffOptions): RunStats {
  // diffTraces computes stats internally; comparing a run against itself is a
  // cheap way to reuse that logic without exporting it
  const result = diffTraces(new Map([["x", run]]), new Map([["x", run]]), options);
  return result.runs[0].before!;
}

function diffSampledRun(
  base: string,
  beforeSamples: Run[],
  afterSamples: Run[],
  options: DiffOptions,
): RunDiff {
  // findings that already occur between two baseline samples describe the
  // agent's own nondeterminism, not the change under test
  const baselineKeys = new Set<string>();
  for (let i = 0; i < beforeSamples.length; i++) {
    for (let j = i + 1; j < beforeSamples.length; j++) {
      for (const f of pairFindings(beforeSamples[i], beforeSamples[j], base, options)) {
        baselineKeys.add(findingKey(f));
      }
    }
  }

  const totalPairs = beforeSamples.length * afterSamples.length;
  const counts = new Map<string, { finding: Finding; count: number }>();
  for (const a of beforeSamples) {
    for (const b of afterSamples) {
      const seen = new Set<string>();
      for (const f of pairFindings(a, b, base, options)) {
        const key = findingKey(f);
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = counts.get(key);
        if (entry) entry.count++;
        else counts.set(key, { finding: f, count: 1 });
      }
    }
  }

  const findings: Finding[] = [];
  for (const [key, { finding, count }] of counts) {
    const f: Finding = { ...finding, rate: `${count}/${totalPairs}` };
    if (baselineKeys.has(key)) {
      f.flaky = true;
      if (f.severity !== "info") f.severity = "info";
    } else if (count / totalPairs < 0.5 && f.severity === "breaking") {
      f.severity = "warning";
    }
    findings.push(f);
  }

  const order: Record<string, number> = { breaking: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    run: base,
    findings,
    before: meanStats(beforeSamples.map((r) => statsOf(r, options))),
    after: meanStats(afterSamples.map((r) => statsOf(r, options))),
  };
}

/**
 * Like diffTraces, but runs named `name#1`, `name#2`, ... are treated as
 * repeated samples of the same scenario. Every before sample is compared to
 * every after sample, findings carry an occurrence rate, and findings that
 * also appear between baseline samples are demoted to flaky info, because the
 * agent already behaved that way before the change.
 */
export function diffTracesSampled(
  before: Map<string, Run>,
  after: Map<string, Run>,
  options: DiffOptions = {},
): DiffResult {
  const beforeGroups = groupSamples(before);
  const afterGroups = groupSamples(after);

  const runDiffs: RunDiff[] = [];
  const bases = new Set([...beforeGroups.keys(), ...afterGroups.keys()]);

  for (const base of bases) {
    const beforeSamples = beforeGroups.get(base) ?? [];
    const afterSamples = afterGroups.get(base) ?? [];
    if (beforeSamples.length && !afterSamples.length) {
      runDiffs.push({
        run: base,
        findings: [
          {
            severity: "breaking",
            kind: "run_missing",
            subject: "run",
            run: base,
            message: "run missing from the new trace",
          },
        ],
        before: meanStats(beforeSamples.map((r) => statsOf(r, options))),
      });
    } else if (!beforeSamples.length && afterSamples.length) {
      runDiffs.push({
        run: base,
        findings: [
          {
            severity: "info",
            kind: "run_added",
            subject: "run",
            run: base,
            message: "new run, nothing to compare against",
          },
        ],
        after: meanStats(afterSamples.map((r) => statsOf(r, options))),
      });
    } else {
      runDiffs.push(diffSampledRun(base, beforeSamples, afterSamples, options));
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
